/**
 * Code Execution Use Case Types
 *
 * Shared types for code execution use cases.
 * These types define the canonical interface for code execution.
 *
 * @module application/use-cases/code/types
 */

// Re-export shared types
export type { UseCaseError, UseCaseResult } from "../shared/types.ts";

// ============================================================================
// Execute Code
// ============================================================================

/**
 * Request to execute code in sandbox
 */
export interface ExecuteCodeRequest {
  /** TypeScript code to execute */
  code: string;
  /** Natural language intent (for tool discovery and capability matching) */
  intent?: string;
  /** Custom context to inject into execution */
  context?: Record<string, unknown>;
  /** Sandbox configuration */
  sandboxConfig?: SandboxConfig;
}

/**
 * Sandbox configuration options
 */
export interface SandboxConfig {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Memory limit in MB (default: 512) */
  memoryLimit?: number;
  /** Allowed read paths for file access */
  allowedReadPaths?: string[];
}

/**
 * Tool definition for sandbox injection
 */
export interface ToolDefinition {
  /** Tool identifier (e.g., "filesystem:read_file") */
  id: string;
  /** Server ID */
  serverId: string;
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for input parameters */
  inputSchema: Record<string, unknown>;
}

/**
 * Matched capability from intent search
 */
export interface MatchedCapability {
  id: string;
  name: string | null;
  codeSnippet: string;
  semanticScore: number;
  successRate: number;
  usageCount: number;
}

/**
 * Tool failure during execution
 */
export interface ToolFailure {
  tool: string;
  error: string;
}

/**
 * Execution metrics
 */
export interface ExecutionMetrics {
  /** Total execution time in milliseconds */
  executionTimeMs: number;
  /** Input code size in bytes */
  inputSizeBytes: number;
  /** Output size in bytes */
  outputSizeBytes: number;
  /** Number of tools called */
  toolsCalledCount: number;
}

/**
 * Result of code execution
 */
export interface ExecuteCodeResult {
  /** Execution output */
  output: unknown;
  /** Whether execution succeeded */
  success: boolean;
  /** Execution metrics */
  metrics: ExecutionMetrics;
  /** Error message if failed */
  error?: string;
  /** Tools that were called during execution */
  toolsCalled?: string[];
  /** Matched capabilities that were injected */
  matchedCapabilities?: MatchedCapability[];
  /** Tool failures during execution */
  toolFailures?: ToolFailure[];
  /** Execution mode */
  mode: "sandbox" | "dag";
}

// ============================================================================
// Validate Code (future use)
// ============================================================================

/**
 * Request to validate code without executing
 */
export interface ValidateCodeRequest {
  /** TypeScript code to validate */
  code: string;
  /** Whether to check for security issues */
  securityCheck?: boolean;
}

/**
 * Result of code validation
 */
export interface ValidateCodeResult {
  /** Whether code is valid */
  isValid: boolean;
  /** Syntax errors if any */
  syntaxErrors?: CodeSyntaxError[];
  /** Security issues if any */
  securityIssues?: SecurityIssue[];
  /** Detected patterns */
  patterns?: string[];
}

/**
 * Syntax error info
 */
export interface CodeSyntaxError {
  line: number;
  column: number;
  message: string;
}

/**
 * Security issue info
 */
export interface SecurityIssue {
  severity: "low" | "medium" | "high" | "critical";
  type: string;
  message: string;
  line?: number;
}
