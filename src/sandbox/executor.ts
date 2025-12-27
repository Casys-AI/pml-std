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
 * ## Features NOT used in Worker mode (by design):
 * - **Cache**: MCP calls are non-deterministic (files change)
 * - **Memory limits**: Workers don't support per-Worker limits
 * - **Permission sets**: Worker uses "none" always (all I/O via RPC)
 * - **allowedReadPaths**: Worker can't read files directly
 *
 * @module sandbox/executor
 */

import type { JsonValue } from "../capabilities/types.ts";
import type {
  ExecutionMode,
  ExecutionResult,
  SandboxConfig,
  StructuredError,
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

const logger = getLogger("default");

/**
 * Default configuration values
 */
const DEFAULTS = {
  TIMEOUT_MS: 30000, // 30 seconds
  MEMORY_LIMIT_MB: 512, // 512MB heap
  ALLOWED_READ_PATHS: [] as string[],
} as const;

/**
 * Marker string used to identify results in subprocess output
 */
const RESULT_MARKER = "__SANDBOX_RESULT__:";

/**
 * Deno Sandbox Executor
 *
 * Executes user-provided TypeScript code in an isolated Deno subprocess
 * with strict security controls and resource limits.
 *
 * @example
 * ```typescript
 * const sandbox = new DenoSandboxExecutor({ timeout: 5000, memoryLimit: 256 });
 * const result = await sandbox.execute("return 1 + 1");
 * console.log(result.result); // 2
 * ```
 */
/**
 * Extended configuration for Worker mode execution (Story 7.1b)
 */
export interface WorkerExecutionConfig {
  /** Tool definitions for RPC bridge */
  toolDefinitions: ToolDefinition[];
  /** MCP clients for tool execution */
  mcpClients: Map<string, MCPClientBase>;
}

/**
 * Extended execution result with trace events (Story 7.1b)
 */
export interface ExecutionResultWithTraces extends ExecutionResult {
  /** Native trace events from Worker RPC bridge */
  traces?: TraceEvent[];
  /** List of successfully called tools */
  toolsCalled?: string[];
}

export class DenoSandboxExecutor {
  private config: Required<
    Omit<SandboxConfig, "capabilityStore" | "graphRAG" | "useWorkerForExecute">
  >;
  private cache: CodeExecutionCache | null = null;
  private toolVersions: Record<string, string> = {};
  private securityValidator: SecurityValidator;
  private resourceLimiter: ResourceLimiter;
  /** Current execution mode (Story 7.1b) */
  private executionMode: ExecutionMode = "worker";
  /** Last WorkerBridge instance for trace access (Story 7.1b) */
  private lastBridge: WorkerBridge | null = null;
  /** Optional CapabilityStore for eager learning (Task 2) */
  private capabilityStore?: import("../capabilities/capability-store.ts").CapabilityStore;
  /** Optional GraphRAGEngine for trace learning (Task 2) */
  private graphRAG?: import("../graphrag/graph-engine.ts").GraphRAGEngine;
  /** Cached result for Deno version permission set support (Story 7.7b) */
  private permissionSetSupportCached?: boolean;
  /** Use Worker for execute() instead of subprocess (Story 10.5 AC13) */
  private useWorkerForExecute: boolean;

  /**
   * Create a new sandbox executor
   *
   * @param config - Optional configuration overrides
   */
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

    // Initialize security validator (Story 3.9 AC #2)
    this.securityValidator = new SecurityValidator({
      enableCodeValidation: true,
      enableContextSanitization: true,
      maxCodeLength: 100000, // 100KB limit
    });

    // Initialize resource limiter (Story 3.9 AC #4)
    // Note: Memory pressure detection disabled by default for stability
    // Enable in production config for additional safety
    this.resourceLimiter = ResourceLimiter.getInstance({
      maxConcurrentExecutions: 10, // Allow up to 10 concurrent sandboxes
      maxTotalMemoryMb: 3072, // 3GB total (supports 5 concurrent 512MB executions)
      enableMemoryPressureDetection: false, // Disable by default (opt-in)
      memoryPressureThresholdPercent: 80,
    });

    // Store optional dependencies for WorkerBridge (Task 2)
    this.capabilityStore = config?.capabilityStore;
    this.graphRAG = config?.graphRAG;

    // Story 10.5 AC13: Use Worker for execute() by default
    this.useWorkerForExecute = config?.useWorkerForExecute ?? true;

    logger.debug("Sandbox executor initialized", {
      timeout: this.config.timeout,
      memoryLimit: this.config.memoryLimit,
      allowedPathsCount: this.config.allowedReadPaths.length,
      cacheEnabled: this.config.cacheConfig.enabled,
      securityValidation: true,
      resourceLimiting: true,
      capabilityStoreEnabled: !!this.capabilityStore,
      graphRAGEnabled: !!this.graphRAG,
      useWorkerForExecute: this.useWorkerForExecute,
    });
  }

  /**
   * Execute TypeScript code in the sandbox
   *
   * The code is wrapped in an async IIFE and executed in a fresh Deno subprocess.
   * All results must be JSON-serializable.
   *
   * @param code - TypeScript code to execute
   * @param context - Optional context object to inject as variables into sandbox scope
   * @param permissionSet - Permission set for sandbox execution (default: "minimal")
   * @returns Execution result with output or structured error
   *
   * @throws Never throws - all errors are captured in ExecutionResult
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
      // SECURITY: Validate code and context BEFORE any execution (Story 3.9 AC #2)
      try {
        this.securityValidator.validate(code, context);
      } catch (securityError) {
        // Security validation failed - return structured error
        if (securityError instanceof SecurityValidationError) {
          logger.warn("Security validation failed", {
            violationType: securityError.violationType,
            pattern: securityError.pattern,
          });

          return {
            success: false,
            error: {
              type: "SecurityError",
              message: securityError.message,
            },
            executionTimeMs: performance.now() - startTime,
          };
        }
        // Re-throw unexpected errors
        throw securityError;
      }

      // RESOURCE LIMITS: Acquire execution slot (Story 3.9 AC #4)
      try {
        resourceToken = await this.resourceLimiter.acquire(this.config.memoryLimit);
      } catch (resourceError) {
        // Resource limit exceeded - return structured error
        if (resourceError instanceof ResourceLimitError) {
          logger.warn("Resource limit exceeded", {
            limitType: resourceError.limitType,
            currentValue: resourceError.currentValue,
            maxValue: resourceError.maxValue,
          });

          return {
            success: false,
            error: {
              type: "ResourceLimitError",
              message: resourceError.message,
            },
            executionTimeMs: performance.now() - startTime,
          };
        }
        // Re-throw unexpected errors
        throw resourceError;
      }

      // Story 10.5 AC13: Use Worker for execute() when enabled
      // Worker path provides 100% traceability (all I/O via MCP RPC)
      if (this.useWorkerForExecute) {
        logger.debug("Using Worker path for execute()", {
          codeLength: code.length,
          contextKeys: context ? Object.keys(context) : [],
        });

        // Create WorkerBridge with empty MCP clients (no tools needed)
        const bridge = new WorkerBridge(new Map(), {
          timeout: this.config.timeout,
          capabilityStore: this.capabilityStore,
          graphRAG: this.graphRAG,
        });
        this.lastBridge = bridge;

        // Execute via Worker with empty tool definitions
        const result = await bridge.execute(code, [], context);

        const executionTimeMs = performance.now() - startTime;

        logger.info("Worker execution succeeded", {
          success: result.success,
          executionTimeMs: executionTimeMs.toFixed(2),
        });

        // Release resource token before returning (set to null to prevent double-release in finally)
        if (resourceToken) {
          this.resourceLimiter.release(resourceToken);
          resourceToken = null;
        }

        // Return ExecutionResult (without traces for backward compat)
        // Convert undefined to null for JSON serialization consistency (matches subprocess behavior)
        // Classify error types to match subprocess behavior
        let error = result.error;
        if (error && error.type === "RuntimeError") {
          const msg = error.message.toLowerCase();
          // Detect permission errors from message patterns
          if (
            msg.includes("permission") ||
            msg.includes("permissiondenied") ||
            msg.includes("notcapable") ||
            msg.includes("requires") && msg.includes("access")
          ) {
            error = { ...error, type: "PermissionError" };
          } // Detect syntax errors from message patterns
          else if (
            msg.includes("unexpected") ||
            msg.includes("parse error") ||
            msg.includes("syntax") ||
            msg.includes("invalid or unexpected token")
          ) {
            error = { ...error, type: "SyntaxError" };
          }
        }

        return {
          success: result.success,
          result: result.result === undefined ? null : result.result,
          error,
          executionTimeMs,
        };
      }

      // === SUBPROCESS PATH (legacy) ===
      // Only reached when useWorkerForExecute = false
      // Required for features not available in Worker mode:
      // - allowedReadPaths (Worker has permissions: "none")
      // - memoryLimit (Workers don't support per-Worker limits)
      // - Permission sets (network-api, filesystem, etc.)
      // - Cache (useful for deterministic code, not MCP)
      // Consider removing in future if these features aren't needed.

      // Check cache before execution
      if (this.cache) {
        const cacheKey = generateCacheKey(
          code,
          context ?? {},
          this.toolVersions,
        );

        const cached = this.cache.get(cacheKey);
        if (cached) {
          const cacheLatency = performance.now() - startTime;
          logger.info("Cache hit - returning cached result", {
            cacheKey: cacheKey.substring(0, 16) + "...",
            cacheLatencyMs: cacheLatency.toFixed(2),
            originalExecutionMs: cached.result.executionTimeMs.toFixed(2),
            speedup: (cached.result.executionTimeMs / cacheLatency).toFixed(1) + "x",
          });

          return cached.result;
        }
      }

      logger.debug("Starting sandbox execution", {
        codeLength: code.length,
        contextKeys: context ? Object.keys(context) : [],
      });

      // 1. Wrap user code in execution wrapper with optional context injection
      const wrappedCode = this.wrapCode(code, context);

      // 2. Build Deno command with permission set (Story 7.7b)
      const { command, tempFilePath } = this.buildCommand(wrappedCode, permissionSet);
      tempFile = tempFilePath;

      // 3. Execute with timeout enforcement
      const output = await this.executeWithTimeout(command);

      const executionTimeMs = performance.now() - startTime;

      // 4. Parse and return result
      const result: ExecutionResult = {
        success: true,
        result: output.result as JsonValue,
        executionTimeMs,
        memoryUsedMb: output.memoryUsedMb,
      };

      logger.info("Sandbox execution succeeded", {
        executionTimeMs: result.executionTimeMs.toFixed(2),
        memoryUsedMb: result.memoryUsedMb,
      });

      // 5. Eager Learning: Save capability after successful execution (Story 7.2a)
      // Mirror of WorkerBridge logic (worker-bridge.ts:263-282)
      const intent = context?.intent as string | undefined;
      if (this.capabilityStore && intent) {
        try {
          const { trace } = await this.capabilityStore.saveCapability({
            code,
            intent,
            durationMs: Math.round(executionTimeMs),
            success: true,
            toolsUsed: [], // No tools in basic execute()
            // Story 11.2: Include traceData for execution trace persistence
            traceData: {
              initialContext: (context ?? {}) as Record<
                string,
                import("../capabilities/types.ts").JsonValue
              >,
              executedPath: [], // No tool traces in basic execute()
              decisions: [],
              taskResults: [], // No tools in basic execute()
              userId: (context?.userId as string) ?? "local",
            },
          });
          logger.debug("Capability saved via eager learning (execute)", {
            intent: intent.substring(0, 50),
            traceId: trace?.id,
          });
        } catch (capError) {
          // Don't fail execution if capability storage fails
          logger.warn("Failed to save capability in execute()", {
            error: capError instanceof Error ? capError.message : String(capError),
          });
        }
      }

      // 6. Store result in cache
      if (this.cache) {
        const cacheKey = generateCacheKey(
          code,
          context ?? {},
          this.toolVersions,
        );

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

        logger.debug("Result cached", {
          cacheKey: cacheKey.substring(0, 16) + "...",
          ttlSeconds: this.config.cacheConfig.ttlSeconds,
        });
      }

      return result;
    } catch (error) {
      const executionTimeMs = performance.now() - startTime;
      const structuredError = this.parseError(error);

      // Log security-relevant errors
      if (structuredError.type === "PermissionError") {
        logger.warn("Sandbox permission violation detected", {
          errorType: structuredError.type,
          message: structuredError.message,
          executionTimeMs,
        });
      } else {
        logger.debug("Sandbox execution failed", {
          errorType: structuredError.type,
          message: structuredError.message,
          executionTimeMs,
        });
      }

      return {
        success: false,
        error: structuredError,
        executionTimeMs,
      };
    } finally {
      // Release resource token (Story 3.9 AC #4)
      if (resourceToken) {
        this.resourceLimiter.release(resourceToken);
      }

      // Cleanup temp file (critical for preventing disk exhaustion)
      if (tempFile) {
        try {
          Deno.removeSync(tempFile);
          logger.debug("Temp file cleaned up", { path: this.sanitizePath(tempFile) });
        } catch (cleanupError) {
          logger.error("Failed to cleanup temp file", {
            path: this.sanitizePath(tempFile),
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
    }
  }

  /**
   * Wrap user code in execution wrapper
   *
   * The wrapper:
   * - Injects context variables into scope (if provided)
   * - Wraps code in async IIFE to support top-level await
   * - Captures the return value
   * - Serializes result to JSON
   * - Captures and serializes errors
   * - Outputs result with marker for parsing
   *
   * @param code - User code to wrap
   * @param context - Optional context object to inject as variables
   * @returns Wrapped code ready for execution
   */
  private wrapCode(code: string, context?: Record<string, unknown>): string {
    // Build context injection code
    const contextInjection = context
      ? Object.entries(context)
        .map(([key, value]) => {
          // Validate variable name is safe (alphanumeric + underscore only)
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
            throw new Error(`Invalid context variable name: ${key}`);
          }
          // Serialize value to JSON and inject as const
          return `const ${key} = ${JSON.stringify(value)};`;
        })
        .join("\n    ")
      : "";

    // ADR-016: REPL-style auto-return with heuristic detection
    // Check if code contains statement keywords (const, let, var, function, return, throw, etc.)
    const hasStatements =
      /(^|\n|\s)(const|let|var|function|class|if|for|while|do|switch|try|return|throw|break|continue)\s/
        .test(code.trim());

    // If code has statements, execute as-is (requires explicit return)
    // If code is pure expression, wrap in return for auto-return
    const wrappedUserCode = hasStatements ? code : `return (${code});`;

    return `
(async () => {
  try {
    // Execute user code in async context with injected context (ADR-016: REPL-style auto-return)
    const __result = await (async () => {
      ${contextInjection ? contextInjection + "\n      " : ""}${wrappedUserCode}
    })();

    // Serialize result (must be JSON-compatible)
    // Convert undefined to null for proper JSON serialization
    const __serialized = JSON.stringify({
      success: true,
      result: __result === undefined ? null : __result,
    });

    console.log("${RESULT_MARKER}" + __serialized);
  } catch (error) {
    // Capture execution error
    const __serialized = JSON.stringify({
      success: false,
      error: {
        type: error?.constructor?.name || "Error",
        message: error?.message || String(error),
        stack: error?.stack,
      },
    });

    console.log("${RESULT_MARKER}" + __serialized);
  }
})();
`;
  }

  // ==========================================================================
  // Story 7.7b: Permission Set Support (ADR-035)
  // ==========================================================================

  /**
   * Check if current Deno version supports permission sets (>= 2.5)
   * Story 7.7b (AC#3): Version detection for permission set support
   *
   * @returns true if Deno version >= 2.5, false otherwise
   */
  supportsPermissionSets(): boolean {
    // Use cached result if available (performance optimization)
    if (this.permissionSetSupportCached !== undefined) {
      return this.permissionSetSupportCached;
    }

    try {
      // Parse version like "2.5.1" → [2, 5]
      const [major, minor] = Deno.version.deno.split(".").map(Number);
      this.permissionSetSupportCached = major > 2 || (major === 2 && minor >= 5);

      logger.debug("Deno version permission set support detected", {
        version: Deno.version.deno,
        supportsPermissionSets: this.permissionSetSupportCached,
      });

      return this.permissionSetSupportCached;
    } catch {
      // If parsing fails, assume not supported (safe fallback)
      this.permissionSetSupportCached = false;
      return false;
    }
  }

  /**
   * Map permission set to explicit Deno flags (fallback for Deno < 2.5)
   * Story 7.7b (AC#4): Permission set to flags mapping
   *
   * @param set - Permission set to map
   * @returns Array of Deno permission flags
   */
  permissionSetToFlags(set: PermissionSet): string[] {
    const profiles: Record<PermissionSet, string[]> = {
      "minimal": [], // Deny all (most restrictive)
      "readonly": ["--allow-read=./data,/tmp"],
      "filesystem": ["--allow-read", "--allow-write=/tmp"],
      "network-api": ["--allow-net"],
      "mcp-standard": [
        "--allow-read",
        "--allow-write=/tmp,./output",
        "--allow-net",
        "--allow-env=HOME,PATH",
      ],
      "trusted": ["--allow-all"],
    };

    const flags = profiles[set];
    if (flags === undefined) {
      // Unknown permission set - fallback to minimal with warning
      logger.warn("Unknown permission set, using minimal", { requestedSet: set });
      return [];
    }

    return flags;
  }

  /**
   * Build Deno command with permission set support
   *
   * Story 7.7b: Updated to use permission sets instead of hardcoded deny flags.
   *
   * Security model:
   * - Creates temp file for code execution (required for full permission control)
   * - Uses permission set to determine allowed operations
   * - Always allows reading the temp file (required for execution)
   * - Memory limit via V8 flags
   * - No prompt mode to prevent hangs
   *
   * @param code - Wrapped code to execute
   * @param permissionSet - Permission set to apply (default: "minimal")
   * @returns Command object and temp file path
   */
  private buildCommand(
    code: string,
    permissionSet: PermissionSet = "minimal",
  ): { command: Deno.Command; tempFilePath: string } {
    // Create secure temp file
    const tempFile = Deno.makeTempFileSync({ prefix: "sandbox-", suffix: ".ts" });
    Deno.writeTextFileSync(tempFile, code);

    logger.debug("Created temp file for sandbox execution", {
      path: this.sanitizePath(tempFile),
      permissionSet,
    });

    // Build permission arguments
    const args: string[] = ["run"];

    // Memory limit (V8 heap size) - always applied regardless of permission set
    args.push(`--v8-flags=--max-old-space-size=${this.config.memoryLimit}`);

    // Story 7.7b (AC#5): Always add --no-prompt to prevent subprocess hangs
    args.push("--no-prompt");

    // Always deny dangerous operations regardless of permission set
    args.push("--deny-run"); // No subprocess spawning (security critical)
    args.push("--deny-ffi"); // No FFI/native code (security critical)

    // Story 7.7b: Apply permission set
    // Note: Deno 2.5+ permission sets (--permission-set) are not yet available
    // Using explicit flags fallback for all versions
    const permissionFlags = this.permissionSetToFlags(permissionSet);

    // Always need to read the temp file
    // If permission set doesn't include read access, add explicit temp file read
    const hasReadPermission = permissionFlags.some((f) =>
      f.startsWith("--allow-read") || f === "--allow-all"
    );

    if (!hasReadPermission) {
      args.push(`--allow-read=${tempFile}`);
    } else if (permissionFlags.some((f) => f.startsWith("--allow-read="))) {
      // Add temp file to existing read paths
      const readFlagIndex = permissionFlags.findIndex((f) => f.startsWith("--allow-read="));
      if (readFlagIndex !== -1) {
        permissionFlags[readFlagIndex] = `${permissionFlags[readFlagIndex]},${tempFile}`;
      }
    } else if (permissionFlags.includes("--allow-read")) {
      // --allow-read (all) already covers temp file
    }

    // Also include user-configured allowed paths if any (from config)
    if (this.config.allowedReadPaths.length > 0) {
      const existingReadFlag = permissionFlags.find((f) => f.startsWith("--allow-read="));
      if (existingReadFlag) {
        const idx = permissionFlags.indexOf(existingReadFlag);
        permissionFlags[idx] = `${existingReadFlag},${this.config.allowedReadPaths.join(",")}`;
      } else if (
        !permissionFlags.includes("--allow-read") && !permissionFlags.includes("--allow-all")
      ) {
        // No existing read flag, add one with config paths
        const readArg = args.find((a) => a.startsWith("--allow-read="));
        if (readArg) {
          const idx = args.indexOf(readArg);
          args[idx] = `${readArg},${this.config.allowedReadPaths.join(",")}`;
        }
      }
    }

    // Add permission set flags
    args.push(...permissionFlags);

    // For minimal permission set, add explicit deny flags for defense in depth
    if (permissionSet === "minimal") {
      args.push("--deny-write");
      args.push("--deny-net");
      args.push("--deny-env");
    }

    // Add temp file path (must be last)
    args.push(tempFile);

    // Create command
    const command = new Deno.Command("deno", {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    logger.debug("Built sandbox command with permission set", {
      permissionSet,
      args: args.slice(0, -1), // Log args without temp file path
    });

    return { command, tempFilePath: tempFile };
  }

  /**
   * Execute command with timeout enforcement
   *
   * Uses AbortController to enforce timeout. Process is killed if timeout
   * is exceeded.
   *
   * @param command - Deno command to execute
   * @returns Parsed execution result
   * @throws Error if execution fails or times out
   */
  private async executeWithTimeout(
    command: Deno.Command,
  ): Promise<{ result: unknown; memoryUsedMb?: number }> {
    // Create abort controller for timeout
    const controller = new AbortController();
    let process: Deno.ChildProcess | null = null;

    // Setup timeout
    const timeoutId = setTimeout(() => {
      logger.warn("Sandbox execution timeout, killing process", {
        timeoutMs: this.config.timeout,
      });
      controller.abort();
      // Forcefully kill the process if it's still running
      if (process) {
        try {
          process.kill("SIGKILL");
        } catch {
          // Process might already be dead
        }
      }
    }, this.config.timeout);

    try {
      // Spawn subprocess
      process = command.spawn();

      // Wait for completion
      const { stdout, stderr, success, code } = await process.output();

      clearTimeout(timeoutId);

      // Check if aborted (timeout)
      if (controller.signal.aborted) {
        throw new Error("TIMEOUT");
      }

      // Decode output
      const stdoutText = new TextDecoder().decode(stdout);
      const stderrText = new TextDecoder().decode(stderr);

      logger.debug("Subprocess completed", {
        success,
        code,
        stdoutLength: stdoutText.length,
        stderrLength: stderrText.length,
      });

      // Check for errors in stderr (permission errors, runtime errors)
      if (!success || stderrText.length > 0) {
        throw new Error(`SUBPROCESS_ERROR: ${stderrText || "Non-zero exit code"}`);
      }

      // Parse result from stdout
      const parsed = this.parseOutput(stdoutText);
      return parsed;
    } catch (error) {
      clearTimeout(timeoutId);

      // Check if timeout occurred
      if (controller.signal.aborted) {
        throw new Error("TIMEOUT");
      }

      throw error;
    }
  }

  /**
   * Parse subprocess output to extract result
   *
   * Looks for the result marker in stdout and parses the JSON payload.
   *
   * @param stdout - Raw stdout from subprocess
   * @returns Parsed result
   * @throws Error if result cannot be parsed or user code failed
   */
  private parseOutput(stdout: string): { result: unknown; memoryUsedMb?: number } {
    // Find result marker
    const resultMatch = stdout.match(new RegExp(`${RESULT_MARKER}(.*)`));

    if (!resultMatch) {
      throw new Error("PARSE_ERROR: No result marker found in output");
    }

    try {
      // Parse JSON result
      const resultJson = JSON.parse(resultMatch[1]);

      // Check if user code threw an error
      if (!resultJson.success) {
        const error = resultJson.error;
        throw new Error(`USER_ERROR: ${JSON.stringify(error)}`);
      }

      return {
        result: resultJson.result,
      };
    } catch (parseError) {
      // JSON parse failed
      if (parseError instanceof Error && parseError.message.startsWith("USER_ERROR")) {
        throw parseError; // Re-throw user errors
      }
      throw new Error(`PARSE_ERROR: Failed to parse result JSON: ${parseError}`);
    }
  }

  /**
   * Parse error into structured format
   *
   * Categorizes errors by type and sanitizes error messages to prevent
   * information leakage (e.g., host file paths).
   *
   * @param error - Raw error from execution
   * @returns Structured error object
   */
  private parseError(error: unknown): StructuredError {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Timeout error
    if (errorMessage.includes("TIMEOUT")) {
      return {
        type: "TimeoutError",
        message: `Execution exceeded timeout of ${this.config.timeout}ms`,
      };
    }

    // Memory error (OOM)
    if (
      errorMessage.toLowerCase().includes("out of memory") ||
      errorMessage.toLowerCase().includes("heap limit") ||
      errorMessage.includes("max-old-space-size")
    ) {
      return {
        type: "MemoryError",
        message: `Memory limit of ${this.config.memoryLimit}MB exceeded`,
      };
    }

    // Permission error (security event)
    if (
      errorMessage.includes("PermissionDenied") ||
      errorMessage.includes("NotCapable") ||
      errorMessage.includes("Requires") ||
      errorMessage.includes("--allow-") ||
      errorMessage.toLowerCase().includes("permission")
    ) {
      return {
        type: "PermissionError",
        message: this.sanitizeErrorMessage(errorMessage),
      };
    }

    // User code error (syntax or runtime)
    if (errorMessage.includes("USER_ERROR")) {
      try {
        const userError = JSON.parse(errorMessage.replace("USER_ERROR: ", ""));
        return {
          type: userError.type === "SyntaxError" ? "SyntaxError" : "RuntimeError",
          message: userError.message,
          stack: this.sanitizeStackTrace(userError.stack),
        };
      } catch {
        // Failed to parse user error
        return {
          type: "RuntimeError",
          message: this.sanitizeErrorMessage(errorMessage),
        };
      }
    }

    // Subprocess error
    if (errorMessage.includes("SUBPROCESS_ERROR")) {
      const cleanMessage = errorMessage.replace("SUBPROCESS_ERROR: ", "");

      // Check if it's actually a syntax error from Deno
      if (
        cleanMessage.includes("SyntaxError") ||
        cleanMessage.includes("Unexpected token") ||
        cleanMessage.includes("Unexpected identifier") ||
        cleanMessage.includes("Unexpected end of input") ||
        cleanMessage.includes("Invalid or unexpected token")
      ) {
        return {
          type: "SyntaxError",
          message: this.sanitizeErrorMessage(cleanMessage),
        };
      }

      return {
        type: "RuntimeError",
        message: this.sanitizeErrorMessage(cleanMessage),
      };
    }

    // Generic runtime error
    return {
      type: "RuntimeError",
      message: this.sanitizeErrorMessage(errorMessage),
      stack: error instanceof Error ? this.sanitizeStackTrace(error.stack) : undefined,
    };
  }

  /**
   * Sanitize error message to remove host file paths
   *
   * Replaces absolute paths with generic markers to prevent information leakage.
   *
   * @param message - Raw error message
   * @returns Sanitized error message
   */
  private sanitizeErrorMessage(message: string): string {
    // Remove absolute paths (Unix and Windows)
    return message
      .replace(/\/[^\s]+\/sandbox-[^\s]+\.ts/g, "<temp-file>")
      .replace(/[A-Z]:\\[^\s]+\\sandbox-[^\s]+\.ts/g, "<temp-file>")
      .replace(/\/home\/[^\/]+/g, "<home>")
      .replace(/[A-Z]:\\Users\\[^\\]+/g, "<home>");
  }

  /**
   * Sanitize stack trace to remove host file paths
   *
   * @param stack - Raw stack trace
   * @returns Sanitized stack trace
   */
  private sanitizeStackTrace(stack?: string): string | undefined {
    if (!stack) return undefined;
    return this.sanitizeErrorMessage(stack);
  }

  /**
   * Sanitize file path for logging (remove sensitive parts)
   *
   * @param path - File path
   * @returns Sanitized path
   */
  private sanitizePath(path: string): string {
    return path.replace(/\/home\/[^\/]+/g, "~").replace(/[A-Z]:\\Users\\[^\\]+/g, "~");
  }

  /**
   * Update tool versions for cache invalidation
   *
   * Should be called when MCP server versions change to ensure cache keys
   * reflect the current tool schema.
   *
   * @param toolVersions - Map of tool name to version string
   */
  setToolVersions(toolVersions: Record<string, string>): void {
    this.toolVersions = toolVersions;
    logger.debug("Tool versions updated", {
      toolCount: Object.keys(toolVersions).length,
    });
  }

  /**
   * Invalidate cache entries for a specific tool
   *
   * Used when a tool's schema changes (e.g., MCP server update).
   *
   * @param toolName - Name of tool to invalidate
   * @returns Number of entries invalidated
   */
  invalidateToolCache(toolName: string): number {
    if (!this.cache) {
      return 0;
    }

    const invalidated = this.cache.invalidate(toolName);
    logger.info("Tool cache invalidated", {
      toolName,
      entriesInvalidated: invalidated,
    });

    return invalidated;
  }

  /**
   * Get cache performance statistics
   *
   * @returns Cache stats or null if caching is disabled
   */
  getCacheStats(): CacheStats | null {
    if (!this.cache) {
      return null;
    }

    return this.cache.getStats();
  }

  /**
   * Clear all cache entries
   */
  clearCache(): void {
    if (this.cache) {
      this.cache.clear();
      logger.info("Cache cleared");
    }
  }

  /**
   * Get resource limiter statistics
   *
   * @returns Resource usage stats
   */
  getResourceStats(): ResourceStats {
    return this.resourceLimiter.getStats();
  }

  // ==========================================================================
  // Story 7.1b: Worker Mode Execution with RPC Bridge
  // ==========================================================================

  /**
   * Set execution mode (Story 7.1b)
   *
   * @param mode - "worker" (default, new) or "subprocess" (deprecated)
   */
  setExecutionMode(mode: ExecutionMode): void {
    this.executionMode = mode;
    logger.info(`Execution mode set to: ${mode}`);
  }

  /**
   * Get current execution mode
   */
  getExecutionMode(): ExecutionMode {
    return this.executionMode;
  }

  /**
   * Execute code with MCP tools via Worker RPC bridge (Story 7.1b)
   *
   * This is the new execution method that provides:
   * - Working MCP tool calls in sandbox (via RPC proxies)
   * - Native tracing (no stdout parsing)
   * - Granular permission control via Deno Worker permissions (Story 10.5)
   *
   * Permission sets map to Deno Worker permissions:
   * - "minimal": permissions: "none" (no access)
   * - "readonly": read: true (file read access)
   * - "filesystem": read: true, write: true (file read/write)
   * - "network-api": net: true (network access)
   * - "mcp-standard": read, write, net, env (full MCP access, no run/ffi)
   *
   * @param code TypeScript code to execute
   * @param workerConfig Tool definitions and MCP clients for RPC bridge
   * @param context Optional context variables to inject
   * @param capabilityContext Optional capability context for injection
   * @param permissionSet Permission set for Worker sandbox (default: "minimal")
   * @returns Execution result with traces and tools called
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

    // Story 10.5: Log permission set being used (no longer ignored!)
    if (permissionSet && permissionSet !== "minimal") {
      logger.info("Worker execution with elevated permissions", {
        permissionSet,
      });
    }

    try {
      // SECURITY: Validate code and context BEFORE any execution
      try {
        this.securityValidator.validate(code, context);
      } catch (securityError) {
        if (securityError instanceof SecurityValidationError) {
          logger.warn("Security validation failed", {
            violationType: securityError.violationType,
            pattern: securityError.pattern,
          });

          return {
            success: false,
            error: {
              type: "SecurityError",
              message: securityError.message,
            },
            executionTimeMs: performance.now() - startTime,
          };
        }
        throw securityError;
      }

      // RESOURCE LIMITS: Acquire execution slot
      try {
        resourceToken = await this.resourceLimiter.acquire(this.config.memoryLimit);
      } catch (resourceError) {
        if (resourceError instanceof ResourceLimitError) {
          logger.warn("Resource limit exceeded", {
            limitType: resourceError.limitType,
            currentValue: resourceError.currentValue,
            maxValue: resourceError.maxValue,
          });

          return {
            success: false,
            error: {
              type: "ResourceLimitError",
              message: resourceError.message,
            },
            executionTimeMs: performance.now() - startTime,
          };
        }
        throw resourceError;
      }

      logger.debug("Starting Worker execution with tools", {
        codeLength: code.length,
        toolCount: workerConfig.toolDefinitions.length,
        contextKeys: context ? Object.keys(context) : [],
        hasCapabilityContext: !!capabilityContext,
        capabilityContextLength: capabilityContext?.length ?? 0,
      });

      // Create WorkerBridge and execute (Task 2: pass optional dependencies)
      // Note: Worker always uses "none" permissions - all I/O goes through MCP RPC
      const bridge = new WorkerBridge(workerConfig.mcpClients, {
        timeout: this.config.timeout,
        capabilityStore: this.capabilityStore,
        graphRAG: this.graphRAG,
      });
      this.lastBridge = bridge;

      const result = await bridge.execute(
        code,
        workerConfig.toolDefinitions,
        context,
        capabilityContext,
      );

      // Get native traces from bridge
      const traces = bridge.getTraces();
      const toolsCalled = bridge.getToolsCalled();

      logger.info("Worker execution with tools completed", {
        success: result.success,
        executionTimeMs: result.executionTimeMs,
        tracesCount: traces.length,
        toolsCalledCount: toolsCalled.length,
      });

      return {
        ...result,
        traces,
        toolsCalled,
      };
    } catch (error) {
      const executionTimeMs = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.debug("Worker execution with tools failed", {
        error: errorMessage,
        executionTimeMs,
      });

      return {
        success: false,
        error: {
          type: "RuntimeError",
          message: errorMessage,
        },
        executionTimeMs,
      };
    } finally {
      if (resourceToken) {
        this.resourceLimiter.release(resourceToken);
      }
    }
  }

  /**
   * Get traces from last Worker execution
   *
   * @returns Trace events from last execution, or empty array if none
   */
  getLastTraces(): TraceEvent[] {
    return this.lastBridge?.getTraces() ?? [];
  }

  /**
   * Get tools called from last Worker execution
   *
   * @returns List of tool IDs called in last execution
   */
  getLastToolsCalled(): string[] {
    return this.lastBridge?.getToolsCalled() ?? [];
  }
}

// ==========================================================================
// Story 7.7b (AC#8): Exported helper function for permission set determination
// ==========================================================================

/**
 * Confidence threshold for permission inference (Story 7.7b AC#8)
 * Below this threshold, emergent capabilities fallback to "minimal" permissions
 */
export const PERMISSION_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Determine the effective permission set for a capability
 *
 * Story 7.7b (AC#8): Implements confidence threshold check:
 * - Manual capabilities: always use stored permission set
 * - Emergent capabilities with low confidence: fallback to "minimal"
 * - Emergent capabilities with high confidence: use inferred permission set
 *
 * @param capability - Capability with permission metadata
 * @returns Effective permission set to use for execution
 */
export function determinePermissionSet(capability: {
  source: "emergent" | "manual";
  permissionSet?: PermissionSet;
  permissionConfidence?: number;
  id?: string;
}): PermissionSet {
  // Manual capabilities: always use stored permission set (user override)
  if (capability.source === "manual") {
    return capability.permissionSet ?? "mcp-standard";
  }

  // Emergent capabilities: check confidence threshold
  const confidence = capability.permissionConfidence ?? 0;

  if (confidence < PERMISSION_CONFIDENCE_THRESHOLD) {
    logger.info("Low confidence permission inference, using minimal", {
      capabilityId: capability.id,
      confidence,
      threshold: PERMISSION_CONFIDENCE_THRESHOLD,
      requestedPermissionSet: capability.permissionSet,
    });
    return "minimal";
  }

  // High confidence emergent: use inferred permission set
  return capability.permissionSet ?? "minimal";
}
