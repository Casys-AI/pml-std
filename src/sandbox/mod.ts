/**
 * Sandbox Execution Module
 *
 * Provides secure code execution in isolated Deno workers with:
 * - Resource limiting (CPU, memory, time)
 * - PII detection and tokenization
 * - Execution caching
 * - MCP tool context injection
 *
 * @module sandbox
 */

// Core executor
export {
  DenoSandboxExecutor,
  determinePermissionSet,
  PERMISSION_CONFIDENCE_THRESHOLD,
} from "./executor.ts";
export type { ErrorType, ExecutionResult, SandboxConfig, StructuredError } from "./types.ts";

// PII Detection & Tokenization
export { detectAndTokenize, PIIDetector, TokenizationManager } from "./pii-detector.ts";
export type { PIIConfig, PIIMatch, PIIType } from "./pii-detector.ts";

// Execution caching
export { CodeExecutionCache, generateCacheKey } from "./cache.ts";
export type { CacheConfig, CacheEntry, CacheStats } from "./cache.ts";

// Tool context builder for MCP tool injection
export {
  ContextBuilder,
  InvalidToolNameError,
  MCPToolError,
  wrapMCPClient,
} from "./context-builder.ts";
export type { ToolContext, ToolFunction } from "./context-builder.ts";

// Resource limiting (internal but useful for advanced usage)
export { ResourceLimiter } from "./resource-limiter.ts";

// Security validation (internal but useful for advanced usage)
export { SecurityValidator } from "./security-validator.ts";

// Execution modules (Phase 2.4)
export { DenoSubprocessRunner } from "./execution/deno-runner.ts";
export { WorkerRunner } from "./execution/worker-runner.ts";
export { resultParser, RESULT_MARKER } from "./execution/result-parser.ts";
export { TimeoutHandler } from "./execution/timeout-handler.ts";

// Security modules (Phase 2.4)
export { PermissionMapper } from "./security/permission-mapper.ts";
export { pathSanitizer } from "./security/path-sanitizer.ts";
