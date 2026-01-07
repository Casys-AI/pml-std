/**
 * Deno Sandbox Executor - Facade
 *
 * Provides secure code execution via Worker (default) or subprocess.
 * Phase 2.4 refactor: Delegates to extracted modules for execution logic.
 *
 * ## Architecture Decision (Story 10.5 AC13)
 *
 * **Worker Mode (default, recommended for MCP):**
 * - Uses `WorkerRunner` with `permissions: "none"`
 * - 100% traçabilité: all I/O goes through MCP RPC bridge
 * - Faster execution (~33ms vs ~54ms subprocess)
 *
 * **Subprocess Mode (legacy, opt-in via `useWorkerForExecute: false`):**
 * - Uses `DenoSubprocessRunner` with explicit permission flags
 * - Required for: allowedReadPaths, memoryLimit, elevated permission sets
 *
 * @module sandbox/executor
 */

import type { PermissionSet } from "../capabilities/types.ts";
import type {
  ExecutionResult,
  SandboxConfig,
  ToolDefinition,
  TraceEvent,
} from "./types.ts";
import type { MCPClientBase } from "../mcp/types.ts";
import { getLogger } from "../telemetry/logger.ts";
import { type CacheStats, CodeExecutionCache, generateCacheKey } from "./cache.ts";
import { SecurityValidationError, SecurityValidator } from "./security-validator.ts";
import {
  type ExecutionToken,
  ResourceLimiter,
  ResourceLimitError,
  type ResourceStats,
} from "./resource-limiter.ts";

// Extracted modules (Phase 2.4)
import { DenoSubprocessRunner } from "./execution/deno-runner.ts";
import { WorkerRunner } from "./execution/worker-runner.ts";
import { resultParser } from "./execution/result-parser.ts";
import { PermissionMapper } from "./security/permission-mapper.ts";

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
 * Acts as a facade delegating to WorkerRunner or DenoSubprocessRunner.
 */
export class DenoSandboxExecutor {
  private cache: CodeExecutionCache | null = null;
  private toolVersions: Record<string, string> = {};
  private securityValidator: SecurityValidator;
  private resourceLimiter: ResourceLimiter;
  private permissionMapper: PermissionMapper;

  // Runners
  private workerRunner: WorkerRunner;
  private subprocessRunner: DenoSubprocessRunner;

  // Config
  private timeout: number;
  private memoryLimit: number;
  private useWorkerForExecute: boolean;
  private cacheConfig: Required<NonNullable<SandboxConfig["cacheConfig"]>>;

  constructor(config?: SandboxConfig) {
    this.timeout = config?.timeout ?? DEFAULTS.TIMEOUT_MS;
    this.memoryLimit = config?.memoryLimit ?? DEFAULTS.MEMORY_LIMIT_MB;
    this.useWorkerForExecute = config?.useWorkerForExecute ?? true;

    this.cacheConfig = {
      enabled: config?.cacheConfig?.enabled ?? true,
      maxEntries: config?.cacheConfig?.maxEntries ?? 100,
      ttlSeconds: config?.cacheConfig?.ttlSeconds ?? 300,
      persistence: config?.cacheConfig?.persistence ?? false,
    };

    // Initialize cache if enabled
    if (this.cacheConfig.enabled) {
      this.cache = new CodeExecutionCache(this.cacheConfig);
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

    // Initialize permission mapper
    this.permissionMapper = new PermissionMapper();

    // Initialize runners
    this.workerRunner = new WorkerRunner({
      timeout: this.timeout,
      capabilityStore: config?.capabilityStore,
      graphRAG: config?.graphRAG,
      capabilityRegistry: config?.capabilityRegistry,
    });

    this.subprocessRunner = new DenoSubprocessRunner({
      timeout: this.timeout,
      memoryLimit: this.memoryLimit,
      allowedReadPaths: config?.allowedReadPaths ?? DEFAULTS.ALLOWED_READ_PATHS,
    });

    logger.debug("Sandbox executor initialized", {
      timeout: this.timeout,
      memoryLimit: this.memoryLimit,
      cacheEnabled: this.cacheConfig.enabled,
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
    let resourceToken: ExecutionToken | null = null;

    try {
      // Security validation
      this.validateSecurity(code, context);

      // Resource limits
      resourceToken = await this.acquireResources();

      // Worker path (default)
      if (this.useWorkerForExecute) {
        const result = await this.workerRunner.executeSimple(code, context);
        const executionTimeMs = performance.now() - startTime;

        // Classify error if present
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

      // Subprocess path (legacy) - with caching
      if (this.cache) {
        const cacheKey = generateCacheKey(code, context ?? {}, this.toolVersions);
        const cached = this.cache.get(cacheKey);
        if (cached) return cached.result;
      }

      const result = await this.subprocessRunner.execute(code, context, permissionSet);

      // Cache successful result
      if (result.success && this.cache) {
        this.cacheResult(code, context, result);
      }

      return result;
    } catch (error) {
      return this.handleExecutionError(error, startTime);
    } finally {
      if (resourceToken) this.resourceLimiter.release(resourceToken);
    }
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
      this.validateSecurity(code, context);

      // Resource limits
      resourceToken = await this.acquireResources();

      // Execute via WorkerRunner
      const result = await this.workerRunner.execute(
        code,
        workerConfig.mcpClients,
        workerConfig.toolDefinitions,
        context,
        capabilityContext,
      );

      return result;
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

  // === Helper methods ===

  private validateSecurity(code: string, context?: Record<string, unknown>): void {
    try {
      this.securityValidator.validate(code, context);
    } catch (error) {
      if (error instanceof SecurityValidationError) {
        throw error;
      }
      throw error;
    }
  }

  private async acquireResources(): Promise<ExecutionToken> {
    try {
      return await this.resourceLimiter.acquire(this.memoryLimit);
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        throw error;
      }
      throw error;
    }
  }

  private handleExecutionError(error: unknown, startTime: number): ExecutionResult {
    const executionTimeMs = performance.now() - startTime;

    if (error instanceof SecurityValidationError) {
      return {
        success: false,
        error: { type: "SecurityError", message: error.message },
        executionTimeMs,
      };
    }

    if (error instanceof ResourceLimitError) {
      return {
        success: false,
        error: { type: "ResourceLimitError", message: error.message },
        executionTimeMs,
      };
    }

    return {
      success: false,
      error: { type: "RuntimeError", message: error instanceof Error ? error.message : String(error) },
      executionTimeMs,
    };
  }

  private cacheResult(
    code: string,
    context: Record<string, unknown> | undefined,
    result: ExecutionResult,
  ): void {
    if (!this.cache) return;

    const cacheKey = generateCacheKey(code, context ?? {}, this.toolVersions);
    const now = Date.now();
    const ttlMs = this.cacheConfig.ttlSeconds * 1000;

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

  // === Delegation methods ===

  supportsPermissionSets(): boolean {
    return this.permissionMapper.supportsPermissionSets();
  }

  permissionSetToFlags(set: PermissionSet): string[] {
    return this.permissionMapper.toDenoFlags(set);
  }

  getLastTraces(): TraceEvent[] {
    return this.workerRunner.getLastTraces();
  }

  getLastToolsCalled(): string[] {
    return this.workerRunner.getLastToolsCalled();
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
