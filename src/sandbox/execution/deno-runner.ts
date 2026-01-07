/**
 * Deno Subprocess Runner
 *
 * Handles Deno subprocess execution for legacy sandbox mode.
 * Most executions now use Worker mode via WorkerBridge.
 *
 * @module sandbox/execution/deno-runner
 */

import type { PermissionSet } from "../../capabilities/types.ts";
import { PermissionMapper } from "../security/permission-mapper.ts";
import { TimeoutHandler } from "./timeout-handler.ts";
import { resultParser, RESULT_MARKER } from "./result-parser.ts";
import { codeWrapper } from "../tools/code-wrapper.ts";
import { getLogger } from "../../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Configuration for DenoSubprocessRunner
 */
export interface DenoRunnerConfig {
  /** Maximum execution time in milliseconds */
  timeout: number;
  /** Memory limit in MB */
  memoryLimit: number;
  /** Paths allowed for reading */
  allowedReadPaths: string[];
}

/**
 * Result from subprocess execution
 */
export interface SubprocessResult {
  success: boolean;
  result?: import("../../capabilities/types.ts").JsonValue;
  error?: import("../types.ts").StructuredError;
  executionTimeMs: number;
  memoryUsedMb?: number;
}

/**
 * Deno Subprocess Runner
 *
 * Executes code in a Deno subprocess with explicit permission flags.
 * Used for legacy execution mode requiring:
 * - allowedReadPaths (file system access)
 * - memoryLimit enforcement
 * - Elevated permission sets beyond Worker mode
 *
 * @example
 * ```typescript
 * const runner = new DenoSubprocessRunner({
 *   timeout: 30000,
 *   memoryLimit: 512,
 *   allowedReadPaths: ["/tmp"],
 * });
 * const result = await runner.execute(code, context, "minimal");
 * ```
 */
export class DenoSubprocessRunner {
  private config: DenoRunnerConfig;
  private permissionMapper: PermissionMapper;
  private timeoutHandler: TimeoutHandler;

  constructor(config: DenoRunnerConfig) {
    this.config = config;
    this.permissionMapper = new PermissionMapper();
    this.timeoutHandler = new TimeoutHandler(config.timeout);

    logger.debug("DenoSubprocessRunner initialized", {
      timeout: config.timeout,
      memoryLimit: config.memoryLimit,
      allowedPathsCount: config.allowedReadPaths.length,
    });
  }

  /**
   * Execute code in Deno subprocess
   *
   * @param code - TypeScript code to execute
   * @param context - Optional context variables to inject
   * @param permissionSet - Permission level for execution
   * @returns Execution result
   */
  async execute(
    code: string,
    context?: Record<string, unknown>,
    permissionSet: PermissionSet = "minimal",
  ): Promise<SubprocessResult> {
    const startTime = performance.now();
    let tempFile: string | null = null;

    try {
      // Wrap code with context injection
      const wrappedCode = codeWrapper.wrapCode(code, context);

      // Build and execute command
      const { command, tempFilePath } = this.buildCommand(wrappedCode, permissionSet);
      tempFile = tempFilePath;

      const output = await this.timeoutHandler.executeWithTimeout(command);

      if (!output.success || output.stderr.length > 0) {
        throw new Error(`SUBPROCESS_ERROR: ${output.stderr || "Non-zero exit code"}`);
      }

      // Parse result
      const parsed = resultParser.parseOutput(output.stdout);
      const executionTimeMs = performance.now() - startTime;

      return {
        success: true,
        result: parsed.result as import("../../capabilities/types.ts").JsonValue,
        executionTimeMs,
        memoryUsedMb: parsed.memoryUsedMb,
      };
    } catch (error) {
      const executionTimeMs = performance.now() - startTime;
      const structuredError = resultParser.parseError(error, {
        timeout: this.config.timeout,
        memoryLimit: this.config.memoryLimit,
      });

      return {
        success: false,
        error: structuredError,
        executionTimeMs,
      };
    } finally {
      // Cleanup temp file
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
   * Build Deno command with permission flags
   *
   * @param code - Wrapped code to execute
   * @param permissionSet - Permission level
   * @returns Command and temp file path
   */
  private buildCommand(
    code: string,
    permissionSet: PermissionSet,
  ): { command: Deno.Command; tempFilePath: string } {
    const tempFile = Deno.makeTempFileSync({ prefix: "sandbox-", suffix: ".ts" });
    Deno.writeTextFileSync(tempFile, code);

    const args: string[] = ["run"];

    // V8 memory limit flag
    args.push(`--v8-flags=--max-old-space-size=${this.config.memoryLimit}`);

    // Security flags (always applied)
    args.push("--no-prompt");
    args.push("--deny-run");
    args.push("--deny-ffi");

    // Map permission set to flags
    let permissionFlags = this.permissionMapper.toDenoFlags(permissionSet);

    // Ensure temp file is readable
    if (!this.permissionMapper.hasReadPermission(permissionFlags)) {
      args.push(`--allow-read=${tempFile}`);
    } else {
      permissionFlags = this.permissionMapper.addReadPath(permissionFlags, tempFile);
    }

    // Add user-configured allowed paths
    if (this.config.allowedReadPaths.length > 0) {
      for (const path of this.config.allowedReadPaths) {
        permissionFlags = this.permissionMapper.addReadPath(permissionFlags, path);
      }
    }

    args.push(...permissionFlags);

    // Additional denies for minimal permission set
    if (permissionSet === "minimal") {
      args.push("--deny-write", "--deny-net", "--deny-env");
    }

    args.push(tempFile);

    logger.debug("Built subprocess command", {
      permissionSet,
      flagCount: args.length,
    });

    return {
      command: new Deno.Command("deno", { args, stdout: "piped", stderr: "piped" }),
      tempFilePath: tempFile,
    };
  }
}

// Re-export RESULT_MARKER for backward compatibility
export { RESULT_MARKER };
