/**
 * Type definitions for Deno Sandbox Executor
 *
 * This module provides TypeScript interfaces for secure code execution
 * in an isolated Deno subprocess environment.
 */

import type { JsonValue } from "../capabilities/types.ts";

/**
 * Configuration options for the sandbox executor
 */
export interface SandboxConfig {
  /**
   * Maximum execution time in milliseconds
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Maximum heap memory in megabytes
   * @default 512
   */
  memoryLimit?: number;

  /**
   * Additional read paths to allow (beyond temp file)
   * Use with caution - each path increases attack surface
   * @default []
   */
  allowedReadPaths?: string[];

  /**
   * PII protection configuration
   * @default { enabled: true, types: all, detokenizeOutput: false }
   */
  piiProtection?: {
    /** Whether PII protection is enabled */
    enabled: boolean;
    /** Which PII types to detect */
    types?: Array<"email" | "phone" | "credit_card" | "ssn" | "api_key">;
    /** Whether to detokenize output (default: false - safer) */
    detokenizeOutput?: boolean;
  };

  /**
   * Code execution cache configuration
   * @default { enabled: true, maxEntries: 100, ttlSeconds: 300, persistence: false }
   */
  cacheConfig?: {
    /** Whether caching is enabled */
    enabled: boolean;
    /** Maximum number of cache entries (LRU eviction) */
    maxEntries?: number;
    /** Time-to-live for cache entries in seconds */
    ttlSeconds?: number;
    /** Whether to persist cache to PGlite */
    persistence?: boolean;
  };

  /**
   * Optional CapabilityStore for eager learning (Story 7.2a)
   * When provided, enables capability learning from execution traces.
   */
  capabilityStore?: import("../capabilities/capability-store.ts").CapabilityStore;

  /**
   * Optional GraphRAGEngine for trace learning (Story 7.3b - AC#5)
   * When provided, enables graph updates from execution traces.
   */
  graphRAG?: import("../graphrag/graph-engine.ts").GraphRAGEngine;

  /**
   * Use Worker for execute() instead of subprocess (Story 10.5 AC13)
   *
   * When true, execute() uses WorkerBridge internally instead of spawning
   * a Deno subprocess. This provides:
   * - Faster execution (~5ms vs ~50ms for subprocess spawn)
   * - 100% traceability (all execution through RPC bridge)
   * - Unified execution path (same as executeWithTools)
   *
   * @default true (Worker is the default path)
   */
  useWorkerForExecute?: boolean;
}

/**
 * Structured error types that can occur during code execution
 */
export type ErrorType =
  | "SyntaxError"
  | "RuntimeError"
  | "TimeoutError"
  | "MemoryError"
  | "PermissionError"
  | "SecurityError"
  | "ResourceLimitError";

/**
 * Structured error information
 */
export interface StructuredError {
  /**
   * Type of error that occurred
   */
  type: ErrorType;

  /**
   * Human-readable error message (sanitized)
   */
  message: string;

  /**
   * Stack trace (optional, sanitized to remove host paths)
   */
  stack?: string;
}

/**
 * Result of code execution in the sandbox
 */
export interface ExecutionResult {
  /**
   * Whether the code executed successfully
   */
  success: boolean;

  /**
   * The return value of the executed code (if successful)
   * Must be JSON-serializable
   */
  result?: JsonValue;

  /**
   * Error information (if execution failed)
   */
  error?: StructuredError;

  /**
   * Execution time in milliseconds
   */
  executionTimeMs: number;

  /**
   * Memory used in megabytes (if available)
   */
  memoryUsedMb?: number;
}

/**
 * Internal command execution output
 * @internal
 */
export interface CommandOutput {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

// =============================================================================
// Worker RPC Bridge Types (Story 7.1b / ADR-032)
// =============================================================================

/**
 * Tool definition for Worker sandbox (serializable - no functions!)
 * Passed to Worker during initialization to generate tool proxies.
 *
 * Story 14.x: Extended with isCapability/capabilityFqdn for capabilities
 * discovered during static analysis when no MCP server exists.
 */
export interface ToolDefinition {
  /** MCP server identifier (e.g., "filesystem", "memory") or capability namespace (e.g., "fs") */
  server: string;
  /** Tool name (e.g., "read_file") or capability action (e.g., "ls") */
  name: string;
  /** Human-readable tool description */
  description: string;
  /** JSON Schema for tool input parameters */
  inputSchema: Record<string, unknown>;

  /**
   * Whether this is a capability rather than an MCP tool.
   * When true, WorkerBridge routes to CapabilityExecutorService.
   */
  isCapability?: boolean;
  /**
   * FQDN of the capability (e.g., "local.default.fs.ls.a7f3").
   * Only present when isCapability=true.
   */
  capabilityFqdn?: string;
}

/**
 * RPC call request from Worker to Bridge
 * Sent when sandbox code calls an MCP tool.
 * ADR-041: Added parentTraceId for hierarchical trace tracking.
 */
export interface RPCCallMessage {
  type: "rpc_call";
  /** UUID for correlating request/response */
  id: string;
  /** MCP server identifier (e.g., "filesystem") */
  server: string;
  /** Tool name (e.g., "read_file") */
  tool: string;
  /** Tool arguments */
  args: Record<string, unknown>;
  /** ADR-041: Parent trace ID for hierarchical tracking (capability → tool) */
  parentTraceId?: string;
}

/**
 * RPC result response from Bridge to Worker
 * Sent after Bridge executes tool call via MCPClient.
 */
export interface RPCResultMessage {
  type: "rpc_result";
  /** Matching request ID */
  id: string;
  /** Whether tool call succeeded */
  success: boolean;
  /** Tool result (if success) */
  result?: JsonValue;
  /** Error message (if failure) */
  error?: string;
}

/**
 * Initialization message from Bridge to Worker
 * Sent when Worker is created to setup sandbox environment.
 * ADR-041: Added parentTraceId for hierarchical trace tracking.
 */
export interface InitMessage {
  type: "init";
  /** TypeScript code to execute */
  code: string;
  /** Tool definitions for proxy generation */
  toolDefinitions: ToolDefinition[];
  /** Optional context variables to inject */
  context?: Record<string, unknown>;
  /** Optional capability context code (Story 7.3b - inline functions) */
  capabilityContext?: string;
  /** ADR-041: Parent trace ID from workflow/task context for hierarchical tracking */
  parentTraceId?: string;
}

/**
 * Execution complete message from Worker to Bridge
 * Sent when sandbox code execution finishes.
 */
export interface ExecutionCompleteMessage {
  type: "execution_complete";
  /** Whether execution succeeded */
  success: boolean;
  /** Execution result (if success) */
  result?: JsonValue;
  /** Error message (if failure) */
  error?: string;
}

/**
 * Union type for all Worker → Bridge messages
 */
export type WorkerToBridgeMessage = RPCCallMessage | ExecutionCompleteMessage;

/**
 * Union type for all Bridge → Worker messages
 */
export type BridgeToWorkerMessage = InitMessage | RPCResultMessage;

/**
 * Base interface for trace events (common fields)
 * Story 7.3b: Discriminated union for tool + capability traces
 * ADR-041: Added parentTraceId and args for hierarchical tracking
 */
interface BaseTraceEvent {
  /** UUID for correlating start/end events */
  traceId: string;
  /** Timestamp in milliseconds */
  ts: number;
  /** Whether call succeeded (for *_end only) */
  success?: boolean;
  /** Execution duration in milliseconds (for *_end only) */
  durationMs?: number;
  /** Error message (for failed *_end only) */
  error?: string;
  /** Execution result (for *_end only) - Story 11.1 */
  result?: unknown;

  // ADR-041: Hierarchical trace tracking
  /** Parent trace ID for hierarchical call tracking (capability → tool, capability → capability) */
  parentTraceId?: string;
  /** Arguments passed to the call (for debugging and learning) */
  args?: Record<string, unknown>;
}

/**
 * Tool trace events (existing behavior)
 * Captured in WorkerBridge during RPC handling.
 */
export interface ToolTraceEvent extends BaseTraceEvent {
  /** Event type */
  type: "tool_start" | "tool_end";
  /** Tool identifier (e.g., "filesystem:read_file") */
  tool: string;
}

/**
 * Capability trace events (Story 7.3b)
 * Captured in Worker via __trace() and BroadcastChannel (ADR-036).
 */
export interface CapabilityTraceEvent extends BaseTraceEvent {
  /** Event type */
  type: "capability_start" | "capability_end";
  /** Capability name */
  capability: string;
  /** Capability UUID */
  capabilityId: string;
}

/**
 * Discriminated union for all trace events (type-safe!)
 * Use type narrowing: if (event.type === "tool_start") { event.tool }
 */
export type TraceEvent = ToolTraceEvent | CapabilityTraceEvent;

/**
 * Execution mode for sandbox
 * - subprocess: Original Deno subprocess (deprecated)
 * - worker: Web Worker with RPC bridge (default)
 */
export type ExecutionMode = "subprocess" | "worker";

/**
 * Individual tool invocation record
 * Captures each call to a tool (not deduplicated like toolsUsed).
 * Enables sequence visualization and parallelism detection in graphs.
 */
export interface ToolInvocation {
  /** Unique ID for this invocation (e.g., "filesystem:read_file#0") */
  id: string;
  /** Tool identifier (e.g., "filesystem:read_file") */
  tool: string;
  /** Trace ID for correlation */
  traceId: string;
  /** Timestamp when tool was called (ms since epoch) */
  ts: number;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Whether the invocation succeeded */
  success: boolean;
  /** Sequence index within the capability execution (0-based) */
  sequenceIndex: number;
  /** Error message if failed */
  error?: string;
}
