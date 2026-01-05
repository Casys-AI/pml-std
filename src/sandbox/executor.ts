/**
 * Deno Sandbox Executor - Production Implementation
 *
 * Provides secure code execution via Worker (default) or subprocess.
 *
 * ## Architecture Decision (Story 10.5 AC13)
 *
 * **Worker Mode (default, recommended for MCP):**
 * - Uses `WorkerBridge` with `permissions: "none"`
 * - 100% traçabilité: all I/O goes through MCP RPC bridge
 * - Faster execution (~33ms vs ~54ms subprocess)
 * - No direct filesystem/network access (security by design)
 *
 * **Subprocess Mode (legacy, opt-in via `useWorkerForExecute: false`):**
 * - Spawns Deno subprocess with explicit permission flags
 * - Required for: allowedReadPaths, memoryLimit, elevated permission sets
 * - Slower due to process spawn overhead
 *
 * @module sandbox/executor
 */

import type { JsonValue } from "../capabilities/types.ts";
import type {
  ExecutionMode,
  ExecutionResult,
  SandboxConfig,
  ToolDefinition,
  TraceEvent,
} from "./types.ts";
import type { MCPClientBase } from "../mcp/types.ts";
import type { PermissionSet } from "../capabilities/types.ts";
import { getLogger } from "../telemetry/logger.ts";
import { type CacheStats, CodeExecutionCache, generateCacheKey } from "./cache.ts";
import { SecurityValidationError, SecurityValidator } from "./security-validator.ts";
import {
  type ExecutionToken,
  ResourceLimiter,
  ResourceLimitError,
  type ResourceStats,
} from "./resource-limiter.ts";
import { WorkerBridge } from "./worker-bridge.ts";

// Extracted modules (Phase 2.4)
import { PermissionMapper } from "./security/permission-mapper.ts";
import { resultParser } from "./execution/result-parser.ts";
import { TimeoutHandler } from "./execution/timeout-handler.ts";
import { codeWrapper } from "./tools/code-wrapper.ts";

const logger = getLogger("default");

/**
 * Default configuration values
 */
const DEFAULTS = {
  TIMEOUT_MS: 30000,
  MEMORY_LIMIT_MB: 512,
  ALLOWED_READ_PATHS: [] as string[],
} as const;

/**
 * Extended configuration for Worker mode execution (Story 7.1b)
 */
export interface WorkerExecutionConfig {
  toolDefinitions: ToolDefinition[];
  mcpClients: Map<string, MCPClientBase>;
}

/**
 * Extended execution result with trace events (Story 7.1b)
 */
export interface ExecutionResultWithTraces extends ExecutionResult {
  traces?: TraceEvent[];
  toolsCalled?: string[];
}

/**
 * Deno Sandbox Executor
 *
 * Executes user-provided TypeScript code in an isolated environment.
 * Uses extracted modules for permission mapping, result parsing, etc.
 */
export class DenoSandboxExecutor {
  private config: Required<
    Omit<SandboxConfig, "capabilityStore" | "graphRAG" | "capabilityRegistry" | "useWorkerForExecute">
  >;
  private cache: CodeExecutionCache | null = null;
  private toolVersions: Record<string, string> = {};
  private securityValidator: SecurityValidator;
  private resourceLimiter: ResourceLimiter;
  private executionMode: ExecutionMode = "worker";
  private lastBridge: WorkerBridge | null = null;
  private capabilityStore?: import("../capabilities/capability-store.ts").CapabilityStore;
  private graphRAG?: import("../graphrag/graph-engine.ts").GraphRAGEngine;
  private capabilityRegistry?: import("../capabilities/capability-registry.ts").CapabilityRegistry;
  private useWorkerForExecute: boolean;

  // Extracted module instances
  private permissionMapper: PermissionMapper;
  private timeoutHandler: TimeoutHandler;

  constructor(config?: SandboxConfig) {
    this.config = {
      timeout: config?.timeout ?? DEFAULTS.TIMEOUT_MS,
      memoryLimit: config?.memoryLimit ?? DEFAULTS.MEMORY_LIMIT_MB,
      allowedReadPaths: config?.allowedReadPaths ?? DEFAULTS.ALLOWED_READ_PATHS,
      piiProtection: config?.piiProtection ?? {
        enabled: true,
        types: ["email", "phone", "credit_card", "ssn", "api_key"],
        detokenizeOutput: false,
      },
      cacheConfig: config?.cacheConfig ?? {
        enabled: true,
        maxEntries: 100,
        ttlSeconds: 300,
        persistence: false,
      },
    };

    // Initialize cache if enabled
    if (this.config.cacheConfig.enabled) {
      this.cache = new CodeExecutionCache({
        enabled: true,
        maxEntries: this.config.cacheConfig.maxEntries ?? 100,
        ttlSeconds: this.config.cacheConfig.ttlSeconds ?? 300,
        persistence: this.config.cacheConfig.persistence ?? false,
      });
    }

    // Initialize security validator
    this.securityValidator = new SecurityValidator({
      enableCodeValidation: true,
      enableContextSanitization: true,
      maxCodeLength: 100000,
    });

    // Initialize resource limiter
    this.resourceLimiter = ResourceLimiter.getInstance({
      maxConcurrentExecutions: 10,
      maxTotalMemoryMb: 3072,
      enableMemoryPressureDetection: false,
      memoryPressureThresholdPercent: 80,
    });

    // Initialize extracted modules
    this.permissionMapper = new PermissionMapper();
    this.timeoutHandler = new TimeoutHandler(this.config.timeout);

    // Store optional dependencies
    this.capabilityStore = config?.capabilityStore;
    this.graphRAG = config?.graphRAG;
    this.capabilityRegistry = config?.capabilityRegistry;
    this.useWorkerForExecute = config?.useWorkerForExecute ?? true;

    logger.debug("Sandbox executor initialized", {
      timeout: this.config.timeout,
      memoryLimit: this.config.memoryLimit,
      allowedPathsCount: this.config.allowedReadPaths.length,
      cacheEnabled: this.config.cacheConfig.enabled,
      useWorkerForExecute: this.useWorkerForExecute,
    });
  }

  /**
   * Execute TypeScript code in the sandbox
   */
  async execute(
    code: string,
    context?: Record<string, unknown>,
    permissionSet: PermissionSet = "minimal",
  ): Promise<ExecutionResult> {
    const startTime = performance.now();
    let tempFile: string | null = null;
    let resourceToken: ExecutionToken | null = null;

    try {
      // Security validation
      try {
        this.securityValidator.validate(code, context);
      } catch (securityError) {
        if (securityError instanceof SecurityValidationError) {
          return {
            success: false,
            error: { type: "SecurityError", message: securityError.message },
            executionTimeMs: performance.now() - startTime,
          };
        }
        throw securityError;
      }

      // Resource limits
      try {
        resourceToken = await this.resourceLimiter.acquire(this.config.memoryLimit);
      } catch (resourceError) {
        if (resourceError instanceof ResourceLimitError) {
          return {
            success: false,
            error: { type: "ResourceLimitError", message: resourceError.message },
            executionTimeMs: performance.now() - startTime,
          };
        }
        throw resourceError;
      }

      // Worker path (default)
      if (this.useWorkerForExecute) {
        const bridge = new WorkerBridge(new Map(), {
          timeout: this.config.timeout,
          capabilityStore: this.capabilityStore,
          graphRAG: this.graphRAG,
          capabilityRegistry: this.capabilityRegistry,
        });
        this.lastBridge = bridge;

        const result = await bridge.execute(code, [], context);
        const executionTimeMs = performance.now() - startTime;

        if (resourceToken) {
          this.resourceLimiter.release(resourceToken);
          resourceToken = null;
        }

        let error = result.error;
        if (error) {
          error = resultParser.classifyWorkerError(error);
        }

        return {
          success: result.success,
          result: result.result === undefined ? null : result.result,
          error,
          executionTimeMs,
        };
      }

      // Subprocess path (legacy)
      if (this.cache) {
        const cacheKey = generateCacheKey(code, context ?? {}, this.toolVersions);
        const cached = this.cache.get(cacheKey);
        if (cached) return cached.result;
      }

      const wrappedCode = codeWrapper.wrapCode(code, context);
      const { command, tempFilePath } = this.buildCommand(wrappedCode, permissionSet);
      tempFile = tempFilePath;

      const output = await this.timeoutHandler.executeWithTimeout(command);

      if (!output.success || output.stderr.length > 0) {
        throw new Error(`SUBPROCESS_ERROR: ${output.stderr || "Non-zero exit code"}`);
      }

      const parsed = resultParser.parseOutput(output.stdout);
      const executionTimeMs = performance.now() - startTime;

      const result: ExecutionResult = {
        success: true,
        result: parsed.result as JsonValue,
        executionTimeMs,
        memoryUsedMb: parsed.memoryUsedMb,
      };

      // Eager learning
      const intent = context?.intent as string | undefined;
      if (this.capabilityStore && intent) {
        try {
          await this.capabilityStore.saveCapability({
            code,
            intent,
            durationMs: Math.round(executionTimeMs),
            success: true,
            toolsUsed: [],
            traceData: {
              initialContext: (context ?? {}) as Record<string, import("../capabilities/types.ts").JsonValue>,
              executedPath: [],
              decisions: [],
              taskResults: [],
              userId: (context?.userId as string) ?? "local",
            },
          });
        } catch {
          // Don't fail execution if capability storage fails
        }
      }

      // Cache result
      if (this.cache) {
        const cacheKey = generateCacheKey(code, context ?? {}, this.toolVersions);
        const now = Date.now();
        const ttlMs = this.config.cacheConfig.ttlSeconds! * 1000;
        this.cache.set(cacheKey, {
          code,
          context: context ?? {},
          result,
          toolVersions: this.toolVersions,
          timestamp: now,
          expiresAt: now + ttlMs,
          hitCount: 0,
        });
      }

      return result;
    } catch (error) {
      const executionTimeMs = performance.now() - startTime;
      const structuredError = resultParser.parseError(error, {
        timeout: this.config.timeout,
        memoryLimit: this.config.memoryLimit,
      });
      return { success: false, error: structuredError, executionTimeMs };
    } finally {
      if (resourceToken) this.resourceLimiter.release(resourceToken);
      if (tempFile) {
        try {
          Deno.removeSync(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Build Deno command with permission set support
   */
  private buildCommand(
    code: string,
    permissionSet: PermissionSet = "minimal",
  ): { command: Deno.Command; tempFilePath: string } {
    const tempFile = Deno.makeTempFileSync({ prefix: "sandbox-", suffix: ".ts" });
    Deno.writeTextFileSync(tempFile, code);

    const args: string[] = ["run"];
    args.push(`--v8-flags=--max-old-space-size=${this.config.memoryLimit}`);
    args.push("--no-prompt");
    args.push("--deny-run");
    args.push("--deny-ffi");

    let permissionFlags = this.permissionMapper.toDenoFlags(permissionSet);

    // Ensure temp file is readable
    if (!this.permissionMapper.hasReadPermission(permissionFlags)) {
      args.push(`--allow-read=${tempFile}`);
    } else {
      permissionFlags = this.permissionMapper.addReadPath(permissionFlags, tempFile);
    }

    // Add user-configured paths
    if (this.config.allowedReadPaths.length > 0) {
      for (const path of this.config.allowedReadPaths) {
        permissionFlags = this.permissionMapper.addReadPath(permissionFlags, path);
      }
    }

    args.push(...permissionFlags);

    if (permissionSet === "minimal") {
      args.push("--deny-write", "--deny-net", "--deny-env");
    }

    args.push(tempFile);

    return {
      command: new Deno.Command("deno", { args, stdout: "piped", stderr: "piped" }),
      tempFilePath: tempFile,
    };
  }

  /**
   * Execute code with MCP tools via Worker RPC bridge (Story 7.1b)
   */
  async executeWithTools(
    code: string,
    workerConfig: WorkerExecutionConfig,
    context?: Record<string, unknown>,
    capabilityContext?: string,
    permissionSet: PermissionSet = "minimal",
  ): Promise<ExecutionResultWithTraces> {
    const startTime = performance.now();
    let resourceToken: ExecutionToken | null = null;

    if (permissionSet && permissionSet !== "minimal") {
      logger.info("Worker execution with elevated permissions", { permissionSet });
    }

    try {
      // Security validation
      try {
        this.securityValidator.validate(code, context);
      } catch (securityError) {
        if (securityError instanceof SecurityValidationError) {
          return {
            success: false,
            error: { type: "SecurityError", message: securityError.message },
            executionTimeMs: performance.now() - startTime,
          };
        }
        throw securityError;
      }

      // Resource limits
      try {
        resourceToken = await this.resourceLimiter.acquire(this.config.memoryLimit);
      } catch (resourceError) {
        if (resourceError instanceof ResourceLimitError) {
          return {
            success: false,
            error: { type: "ResourceLimitError", message: resourceError.message },
            executionTimeMs: performance.now() - startTime,
          };
        }
        throw resourceError;
      }

      const bridge = new WorkerBridge(workerConfig.mcpClients, {
        timeout: this.config.timeout,
        capabilityStore: this.capabilityStore,
        graphRAG: this.graphRAG,
        capabilityRegistry: this.capabilityRegistry,
      });
      this.lastBridge = bridge;

      const result = await bridge.execute(
        code,
        workerConfig.toolDefinitions,
        context,
        capabilityContext,
      );

      return {
        ...result,
        traces: bridge.getTraces(),
        toolsCalled: bridge.getToolsCalled(),
      };
    } catch (error) {
      return {
        success: false,
        error: { type: "RuntimeError", message: error instanceof Error ? error.message : String(error) },
        executionTimeMs: performance.now() - startTime,
      };
    } finally {
      if (resourceToken) this.resourceLimiter.release(resourceToken);
    }
  }

  // === Delegation methods ===

  supportsPermissionSets(): boolean {
    return this.permissionMapper.supportsPermissionSets();
  }

  permissionSetToFlags(set: PermissionSet): string[] {
    return this.permissionMapper.toDenoFlags(set);
  }

  setExecutionMode(mode: ExecutionMode): void {
    this.executionMode = mode;
  }

  getExecutionMode(): ExecutionMode {
    return this.executionMode;
  }

  getLastTraces(): TraceEvent[] {
    return this.lastBridge?.getTraces() ?? [];
  }

  getLastToolsCalled(): string[] {
    return this.lastBridge?.getToolsCalled() ?? [];
  }

  setToolVersions(toolVersions: Record<string, string>): void {
    this.toolVersions = toolVersions;
  }

  invalidateToolCache(toolName: string): number {
    return this.cache?.invalidate(toolName) ?? 0;
  }

  getCacheStats(): CacheStats | null {
    return this.cache?.getStats() ?? null;
  }

  clearCache(): void {
    this.cache?.clear();
  }

  getResourceStats(): ResourceStats {
    return this.resourceLimiter.getStats();
  }
}

// Re-export for backward compatibility
export { RESULT_MARKER } from "./execution/result-parser.ts";

/**
 * Confidence threshold for permission inference (Story 7.7b AC#8)
 */
export const PERMISSION_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Determine the effective permission set for a capability
 */
export function determinePermissionSet(capability: {
  source: "emergent" | "manual";
  permissionSet?: PermissionSet;
  permissionConfidence?: number;
  id?: string;
}): PermissionSet {
  if (capability.source === "manual") {
    return capability.permissionSet ?? "mcp-standard";
  }

  const confidence = capability.permissionConfidence ?? 0;
  if (confidence < PERMISSION_CONFIDENCE_THRESHOLD) {
    logger.info("Low confidence permission inference, using minimal", {
      capabilityId: capability.id,
      confidence,
      threshold: PERMISSION_CONFIDENCE_THRESHOLD,
    });
    return "minimal";
  }

  return capability.permissionSet ?? "minimal";
}
