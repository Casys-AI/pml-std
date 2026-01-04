/**
 * DAG (Directed Acyclic Graph) Types
 *
 * Core types for workflow execution and task representation.
 *
 * @module graphrag/types/dag
 */

import type { JsonValue, PermissionSet, ArgumentsStructure } from "../../capabilities/types.ts";

/**
 * DAG task representation
 *
 * Supports three task types (Story 3.4, Story 7.4):
 * - mcp_tool (default): Execute MCP tool
 * - code_execution: Execute code in sandbox
 * - capability: Execute learned capability (Story 7.4)
 */
export interface Task {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  dependsOn: string[];

  /**
   * Task type (Story 3.4, Story 7.4)
   *
   * - mcp_tool: Execute MCP tool (default)
   * - code_execution: Execute code in sandbox
   * - capability: Execute learned capability (Story 7.4)
   *
   * @default "mcp_tool"
   */
  type?: "mcp_tool" | "code_execution" | "capability";

  /**
   * Capability ID for type="capability" tasks (Story 7.4)
   *
   * References a learned capability from CapabilityStore.
   * When set, the executor will retrieve the capability's code
   * and execute it with injected context.
   */
  capabilityId?: string;

  /**
   * TypeScript code to execute (only for type="code_execution")
   */
  code?: string;

  /**
   * Intent for tool discovery (only for type="code_execution")
   */
  intent?: string;

  /**
   * Sandbox configuration (only for type="code_execution")
   *
   * Story 7.7c: permissionSet enables network/filesystem access with HIL escalation
   */
  sandboxConfig?: {
    timeout?: number;
    memoryLimit?: number;
    allowedReadPaths?: string[];
    /** Permission set for sandbox execution (Story 7.7c). Default: "minimal" */
    permissionSet?: PermissionSet;
  };

  // NOTE: sideEffects field removed - now inferred from mcp-permissions.yaml
  // See requiresValidation() in workflow-execution-handler.ts
  // See isSafeToFail() in task-router.ts

  /**
   * Static arguments structure from code analysis (Story 10.5)
   *
   * Contains resolution strategies for each argument:
   * - literal: value known at static analysis time
   * - reference: value from previous task result (resolved at runtime)
   * - parameter: value from execution context
   *
   * Used by ParallelExecutor.resolveArguments() for runtime resolution.
   */
  staticArguments?: ArgumentsStructure;

  /**
   * Variable bindings for code task context injection (Phase 1 Modular Execution)
   *
   * Maps variable names used in the code to the node IDs that produce their values.
   * At runtime, the executor injects these variables from previous task results.
   *
   * @example
   * ```typescript
   * // Code: const users = await mcp.db.query(...); users.filter(...)
   * // variableBindings: { "users": "n1" }
   * // At runtime: injects `const users = previousResults["task_n1"].output;`
   * ```
   */
  variableBindings?: Record<string, string>;

  /**
   * Literal bindings for code task context injection
   *
   * Contains literal values from static analysis (e.g., array literals, numbers).
   * At runtime, these are injected into the execution context.
   *
   * @example
   * ```typescript
   * // Code: const numbers = [1, 2, 3]; numbers.filter(...)
   * // literalBindings: { "numbers": [1, 2, 3] }
   * // At runtime: injects `const numbers = [1, 2, 3];`
   * ```
   */
  literalBindings?: Record<string, unknown>;

  /**
   * Task metadata for execution hints (Phase 1 Modular Execution)
   *
   * Contains execution hints like:
   * - pure: Whether this is a pure operation (no side effects)
   * - executable: Whether this task can be executed standalone (Option B)
   */
  metadata?: {
    /** Whether this task is a pure operation (safe to retry, no side effects) */
    pure?: boolean;
    /** IDs of logical tasks that were fused into this physical task (Phase 2a) */
    fusedFrom?: string[];
    /** Logical tool names that were fused into this task (Phase 2a) */
    logicalTools?: string[];
    /**
     * Whether this task is executable standalone (Option B - Phase 2a)
     *
     * Tasks nested inside callbacks (e.g., multiply inside map callback)
     * have executable=false because their code fragments aren't valid alone.
     * SHGAT still learns from them, but they're skipped during execution.
     *
     * @default true for top-level operations
     */
    executable?: boolean;
    /**
     * Nesting level in callback hierarchy (Option B - Phase 2a)
     *
     * 0 = top-level (executable)
     * 1+ = inside callback (not executable standalone)
     */
    nestingLevel?: number;
    /**
     * Parent operation that contains this nested operation (Option B - Phase 2a)
     *
     * E.g., "code:map" if this multiply is inside a map callback
     */
    parentOperation?: string;
    /**
     * Loop ID if this task is inside a loop (Loop Abstraction)
     *
     * References the loop node ID from static structure (e.g., "l1")
     */
    loopId?: string;
    /**
     * Loop type for UI display (Loop Abstraction)
     */
    loopType?: "for" | "while" | "forOf" | "forIn" | "doWhile";
    /**
     * Loop condition for UI display (Loop Abstraction)
     */
    loopCondition?: string;
    /**
     * Unique tools inside this loop for executedPath deduplication (SHGAT learning)
     * Only present on loop tasks, contains the tools that are called inside the loop body.
     */
    bodyTools?: string[];
  };
}

/**
 * DAG structure for workflow execution
 */
export interface DAGStructure {
  tasks: Task[];
}

/**
 * Workflow intent for pattern matching
 */
export interface WorkflowIntent {
  text: string;
  toolsConsidered?: string[];
}

/**
 * Workflow execution record
 */
export interface WorkflowExecution {
  executionId: string;
  executedAt: Date;
  intentText: string;
  dagStructure: DAGStructure;
  success: boolean;
  executionTimeMs: number;
  errorMessage?: string;
  userId?: string; // Story 9.5: Multi-tenant data isolation
}

/**
 * Execution result for a single task
 */
export interface ExecutionResult {
  taskId: string;
  tool: string;
  success: boolean;
  result?: JsonValue;
  error?: string;
  executionTime: number;
}

/**
 * Dependency path between two tools
 */
export interface DependencyPath {
  from: string;
  to: string;
  path: string[];
  hops: number;
  explanation: string;
  confidence?: number;
}

/**
 * Suggested DAG with metadata
 */
export interface SuggestedDAG {
  dagStructure: DAGStructure;
  confidence: number;
  rationale: string;
  dependencyPaths?: DependencyPath[];
  alternatives?: string[];
  /** Warning message for low confidence suggestions (ADR-026) */
  warning?: string;
}

/**
 * Execution mode for gateway handler
 */
export interface ExecutionMode {
  mode: "explicit_required" | "suggestion" | "speculative_execution";
  confidence: number;
  dagStructure?: DAGStructure;
  results?: ExecutionResult[];
  explanation?: string;
  warning?: string;
  error?: string;
  note?: string;
  executionTimeMs?: number;
  dagUsed?: DAGStructure;
  dependencyPaths?: DependencyPath[];
}
