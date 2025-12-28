/**
 * Type definitions for Capability Storage
 *
 * Epic 7 - Story 7.2a: Capability storage for learned code patterns
 * Epic 13 - Story 13.1: FQDN registry with naming and aliases
 *
 * Capabilities are learned code patterns that can be matched and reused.
 * Eager learning: store on 1st successful execution, no wait for patterns.
 *
 * @module capabilities/types
 */

/**
 * JSON primitive types for JSON-serializable values
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON-serializable value type
 *
 * Used for data that needs to be stored in JSONB columns (PostgreSQL)
 * or serialized for caching/transmission.
 *
 * @example
 * const literal: JsonValue = "hello";
 * const object: JsonValue = { key: [1, 2, 3] };
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * JSON Schema type (simplified for capability parameters)
 *
 * Note: 'type' is optional to support unconstrained schemas ({})
 * which accept any value when no type can be inferred.
 */
export interface JSONSchema {
  $schema?: string;
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
  default?: JsonValue;
}

/**
 * Cache configuration for a capability
 */
export interface CacheConfig {
  /** Time-to-live in milliseconds (default: 3600000 = 1 hour) */
  ttl_ms: number;
  /** Whether this capability can be cached (default: true) */
  cacheable: boolean;
}

/**
 * Permission scope profiles defining resource access levels
 * (Refactored from PermissionSet - now represents only the scope axis)
 *
 * Note: 'trusted' is deprecated - use explicit PermissionConfig with approvalMode: 'auto'
 */
export type PermissionScope =
  | "minimal"
  | "readonly"
  | "filesystem"
  | "network-api"
  | "mcp-standard";

/**
 * Approval mode for permission escalation
 * - auto: Automatically approve (default - OAuth-like model)
 * - hil: Human-in-the-loop approval required (explicit opt-in)
 */
export type ApprovalMode = "hil" | "auto";

/**
 * Permission configuration for MCP tools
 *
 * This is METADATA only - not enforced in sandbox.
 * Worker sandbox always runs with permissions: "none".
 * MCP servers run as separate processes with their own permissions.
 *
 * @example
 * ```yaml
 * github:
 *   scope: network-api    # Metadata for audit
 *   approvalMode: auto    # Controls per-layer validation
 * ```
 */
export interface PermissionConfig {
  /** Resource scope level (metadata for audit/documentation) */
  scope: PermissionScope;
  /** Approval mode: auto = works freely, hil = requires human approval */
  approvalMode: ApprovalMode;
}

/**
 * Permission set profiles as defined in ADR-035 (Story 7.7a)
 * @deprecated Use PermissionConfig for new code. This type is kept for backward compatibility.
 */
export type PermissionSet =
  | "minimal"
  | "readonly"
  | "filesystem"
  | "network-api"
  | "mcp-standard"
  | "trusted";

/**
 * Convert legacy PermissionSet to PermissionConfig
 * @param set - Legacy permission set string
 * @returns PermissionConfig with defaults (approvalMode=auto)
 */
export function permissionSetToConfig(set: PermissionSet): PermissionConfig {
  // 'trusted' maps to mcp-standard with auto approval
  const scope: PermissionScope = set === "trusted" ? "mcp-standard" : set;
  return {
    scope,
    approvalMode: "auto",
  };
}

/**
 * A learned capability - executable code pattern with metadata
 *
 * Capabilities are stored on first successful execution (eager learning).
 * Subsequent executions update usage statistics via ON CONFLICT upsert.
 */
export interface Capability {
  /** Unique identifier (UUID) */
  id: string;
  /**
   * Fully Qualified Domain Name (immutable) - Story 13.2
   * Format: <org>.<project>.<namespace>.<action>.<hash>
   * Used for cross-capability references in code (after transformation)
   */
  fqdn?: string;
  /** The TypeScript code snippet */
  codeSnippet: string;
  /** SHA-256 hash of normalized code for deduplication */
  codeHash: string;
  /** 1024-dim embedding of intent for semantic search */
  intentEmbedding: Float32Array;
  /** JSON Schema for parameters (populated by Story 7.2b) */
  parametersSchema?: JSONSchema;
  /** Cache configuration */
  cacheConfig: CacheConfig;
  /**
   * @deprecated Use capability_records.display_name instead (Story 13.2)
   * Kept for backward compatibility, always undefined after migration 022
   */
  name?: string;
  /** Description of what this capability does */
  description?: string;
  /** Total number of times this capability was used */
  usageCount: number;
  /** Number of successful executions */
  successCount: number;
  /** Success rate (0-1, calculated as successCount/usageCount) */
  successRate: number;
  /** Average execution duration in milliseconds */
  avgDurationMs: number;
  /** When this capability was first learned */
  createdAt: Date;
  /** When this capability was last used */
  lastUsed: Date;
  /** Source: 'emergent' (auto-learned) or 'manual' (user-defined) */
  source: "emergent" | "manual";
  /** Tools used by this capability (extracted from dag_structure) - Story 7.4 */
  toolsUsed?: string[];
  /** Detailed tool invocations with timestamps for sequence visualization */
  toolInvocations?: CapabilityToolInvocation[];
  /** Permission set for sandbox execution (Story 7.7a, ADR-035) */
  permissionSet?: PermissionSet;
  /** Confidence score of the permission inference (0-1) */
  permissionConfidence?: number;
  /** Static structure for DAG execution (Story 10.7) */
  staticStructure?: StaticStructure;
  /**
   * Risk category for Thompson Sampling thresholds (Story 10.7c)
   *
   * Derived from max(toolsUsed.riskCategory) via getRiskFromScope().
   * - "safe": All tools are minimal/readonly (threshold ~0.55)
   * - "moderate": Some tools have filesystem/network-api scope (threshold ~0.70)
   * - "dangerous": Any tool has mcp-standard scope (threshold ~0.85)
   */
  riskCategory?: "safe" | "moderate" | "dangerous";
}

/**
 * Tool invocation stored with capability (mirrors sandbox ToolInvocation)
 * Enables sequence visualization and parallelism detection in graphs.
 */
export interface CapabilityToolInvocation {
  /** Unique ID for this invocation (e.g., "filesystem:read_file#0") */
  id: string;
  /** Tool identifier (e.g., "filesystem:read_file") */
  tool: string;
  /** Timestamp when tool was called (ms since epoch) */
  ts: number;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Sequence index within the capability execution (0-based) */
  sequenceIndex: number;
}

/**
 * Input for saving a capability after execution
 */
export interface SaveCapabilityInput {
  /** The TypeScript code that was executed */
  code: string;
  /** The natural language intent (used for embedding) */
  intent: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Whether execution was successful */
  success?: boolean;
  /** Optional description */
  description?: string;
  /** Tool IDs used during execution (from traces) - deduplicated list */
  toolsUsed?: string[];
  /** Detailed tool invocations with timestamps for sequence visualization */
  toolInvocations?: CapabilityToolInvocation[];
  /**
   * Story 11.2: Optional trace data for concurrent trace storage
   * If provided, an ExecutionTrace will be created linked to the capability
   */
  traceData?: {
    /** Input context for this execution */
    initialContext?: Record<string, JsonValue>;
    /** Path of executed nodes */
    executedPath?: string[];
    /** Branch decisions made during execution */
    decisions?: BranchDecision[];
    /** Task results with sanitized args */
    taskResults?: TraceTaskResult[];
    /** Error message if execution failed */
    errorMessage?: string;
    /** User ID for multi-tenancy */
    userId?: string;
    /** Parent trace ID for hierarchical traces */
    parentTraceId?: string;
    /**
     * BGE-M3 1024D embedding of intent (Story 11.x - SHGAT v2)
     * Used for semantic similarity search in intentSimilarSuccessRate
     */
    intentEmbedding?: number[];
  };
  /**
   * Story 10.1: Static structure for nested capability detection
   * Used to create "contains" edges for meta-capabilities
   */
  staticStructure?: StaticStructure;
}

/**
 * Result of capability search
 */
export interface CapabilitySearchResult {
  /** The matched capability */
  capability: Capability;
  /** Semantic similarity score (0-1) - harmonized with HybridSearchResult */
  semanticScore: number;
}

/**
 * Result of intelligent capability matching (Story 7.3a)
 * Includes final score calculation and threshold comparison data.
 */
export interface CapabilityMatch {
  /** The matched capability */
  capability: Capability;
  /** Final calculated score (Semantic * Reliability) */
  score: number;
  /** Raw semantic similarity score (0-1) */
  semanticScore: number;
  /** The adaptive threshold used for the decision */
  thresholdUsed: number;
  /** The inferred parameters schema for calling this capability */
  parametersSchema: JSONSchema | null;
}

// Note: Database row types are inferred from PGlite query results.
// See rowToCapability() in capability-store.ts for the mapping logic.

/**
 * Permission escalation request (Story 7.7c - HIL Permission Escalation)
 *
 * When a capability fails with PermissionDenied, the system creates this request
 * to ask for human approval before upgrading the capability's permission set.
 *
 * Flow:
 * 1. Execution fails with PermissionDenied
 * 2. suggestEscalation() parses error and creates PermissionEscalationRequest
 * 3. ControlledExecutor emits decision_required event
 * 4. Human approves/rejects via CommandQueue
 * 5. If approved: update capability's permission_set in DB, retry execution
 */
export interface PermissionEscalationRequest {
  /** UUID of the capability requesting escalation */
  capabilityId: string;
  /** Current permission set (e.g., "minimal") */
  currentSet: PermissionSet;
  /** Requested permission set after escalation (e.g., "network-api") */
  requestedSet: PermissionSet;
  /** Reason for escalation (e.g., "PermissionDenied: net access to api.example.com") */
  reason: string;
  /** Detected operation that requires elevated permissions (e.g., "fetch", "read", "write") */
  detectedOperation: string;
  /** Confidence score (0-1) for the escalation suggestion */
  confidence: number;
}

/**
 * Audit log entry for permission escalation decisions (Story 7.7c)
 *
 * Every escalation request (approved or rejected) is logged for audit purposes.
 * Stored in permission_audit_log table (migration 018).
 */
export interface PermissionAuditLogEntry {
  /** Unique ID for the audit entry */
  id: string;
  /** Timestamp when the escalation was requested */
  timestamp: Date;
  /** UUID of the capability requesting escalation */
  capabilityId: string;
  /** Permission set before escalation */
  fromSet: PermissionSet;
  /** Permission set requested/granted */
  toSet: PermissionSet;
  /** Whether the escalation was approved */
  approved: boolean;
  /** Who approved (user_id or "system") */
  approvedBy?: string;
  /** Original error message that triggered escalation */
  reason?: string;
  /** Detected operation (e.g., "fetch", "read", "write") */
  detectedOperation?: string;
}

/**
 * Edge types for capability dependencies
 * Same vocabulary as tool_dependency for consistency
 *
 * Story 10.3: Added "provides" for data flow relationships.
 * Note: "alternative" kept for backward compatibility with existing data.
 */
export type CapabilityEdgeType =
  | "contains" // Composition: capability A includes capability B
  | "sequence" // Temporal order: A then B
  | "dependency" // Explicit DAG dependency
  | "alternative" // Same intent, different implementation (deprecated)
  | "provides"; // Data flow: A's output feeds B's input (Story 10.3)

/**
 * Edge sources for capability dependencies
 */
export type CapabilityEdgeSource =
  | "template" // Bootstrap, not yet confirmed
  | "inferred" // 1-2 observations
  | "observed"; // 3+ observations (promoted from inferred)

/**
 * A capability-to-capability dependency relationship
 * Stored in capability_dependency table with FKs to workflow_pattern
 */
export interface CapabilityDependency {
  fromCapabilityId: string;
  toCapabilityId: string;
  observedCount: number;
  confidenceScore: number;
  edgeType: CapabilityEdgeType;
  edgeSource: CapabilityEdgeSource;
  createdAt: Date;
  lastObserved: Date;
}

/**
 * Input for creating a capability dependency
 */
export interface CreateCapabilityDependencyInput {
  fromCapabilityId: string;
  toCapabilityId: string;
  edgeType: CapabilityEdgeType;
  edgeSource?: CapabilityEdgeSource;
}

// ============================================
// Execution Trace Types (Story 11.2)
// ============================================

/**
 * Branch decision recorded during execution
 *
 * Story 11.2: Captures control flow decisions for learning.
 * Each decision point (if/else, switch) records which branch was taken.
 */
export interface BranchDecision {
  /** ID of the decision node in static structure */
  nodeId: string;
  /** The outcome taken (e.g., "true", "false", "case:value") */
  outcome: string;
  /** The condition expression (optional, for debugging) */
  condition?: string;
}

/**
 * Logical operation within a fused task (Phase 2a)
 *
 * Represents an atomic operation that was part of a fused physical task.
 * Used for displaying detailed execution traces in the UI.
 */
export interface LogicalOperation {
  /** Tool ID of the logical operation (e.g., "code:filter") */
  toolId: string;

  /** Estimated duration in milliseconds (physical duration / num operations) */
  durationMs?: number;
}

/**
 * Task result recorded during execution
 *
 * Story 11.2: Captures individual tool invocation results.
 * Used for learning from execution patterns and TD error calculation.
 */
export interface TraceTaskResult {
  /** ID of the task node (matches StaticStructureNode.id) */
  taskId: string;
  /** Tool identifier (e.g., "filesystem:read_file") */
  tool: string;
  /** Arguments passed to the tool (sanitized, AC #10) */
  args: Record<string, JsonValue>;
  /** Result returned by the tool (sanitized) */
  result: JsonValue;
  /** Whether the tool call succeeded */
  success: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
  /**
   * DAG layer index for fan-in/fan-out edge reconstruction
   * Story 11.4: Tasks with same layerIndex execute in parallel
   * - Layer 0: root tasks (no dependencies)
   * - Layer N: tasks that depend on layer N-1
   */
  layerIndex?: number;

  /**
   * Phase 2a: Whether this is a fused physical task containing multiple logical operations
   * When true, logicalOperations contains the atomic operations that were fused together.
   */
  isFused?: boolean;

  /**
   * Phase 2a: Logical operations within this fused task
   * Only present when isFused is true. Contains the atomic operations that were
   * fused together for execution optimization.
   */
  logicalOperations?: LogicalOperation[];
}

/**
 * Default priority for new traces (cold start)
 *
 * Story 11.2: Used when SHGAT hasn't computed TD error yet.
 * - 0.0 = expected trace (low learning value)
 * - 0.5 = cold start (neutral, SHGAT not trained)
 * - 1.0 = surprising trace (high learning value)
 */
export const DEFAULT_TRACE_PRIORITY = 0.5;

/**
 * Execution trace - a single execution record of a capability
 *
 * Story 11.2: Core type for learning from execution traces.
 *
 * Separation from Capability:
 * - Capability (workflow_pattern): Static structure, immutable after creation
 * - Trace (execution_trace): Runtime data, created per execution
 *
 * Used by:
 * - Story 11.3: TD error calculation (priority)
 * - Story 11.6: SHGAT training with PER sampling
 */
export interface ExecutionTrace {
  /** Unique identifier (UUID) */
  id: string;
  /** FK to workflow_pattern.pattern_id (optional for standalone code) */
  capabilityId?: string;
  /** Natural language intent that triggered this execution */
  intentText?: string;
  /**
   * BGE-M3 1024D embedding of intent_text (Story 11.x - SHGAT v2)
   *
   * Used for semantic similarity search in queryIntentSimilarSuccessRate().
   * Populated at trace save time from the intent embedding used for scoring.
   */
  intentEmbedding?: number[];
  /** Input arguments/context for the execution (AC #9 - Epic 12 dependency) */
  initialContext?: Record<string, JsonValue>;
  /** When the execution occurred */
  executedAt: Date;
  /** Whether the execution completed successfully */
  success: boolean;
  /** Total execution duration in milliseconds */
  durationMs: number;
  /** Error message if execution failed */
  errorMessage?: string;
  /** Array of node IDs in execution order */
  executedPath?: string[];
  /** Branch decisions made during execution */
  decisions: BranchDecision[];
  /** Results from each tool invocation (with sanitized args - AC #10) */
  taskResults: TraceTaskResult[];
  /**
   * Priority for PER (Prioritized Experience Replay)
   * - 0.0 = expected trace (low learning value)
   * - 0.5 = cold start (neutral, SHGAT not trained)
   * - 1.0 = surprising trace (high learning value)
   *
   * Calculated in Story 11.3 as |td_error|
   */
  priority: number;
  /** Parent trace ID for hierarchical traces (ADR-041) */
  parentTraceId?: string;
  /** User who triggered this execution (multi-tenancy) */
  userId?: string;
  /** Who created this record (migration, system, user) */
  createdBy?: string;
}

// ============================================
// Static Structure Types (Story 10.1, 10.2)
// ============================================

// ============================================
// Argument Types (Story 10.2)
// ============================================

/**
 * Describes how to resolve a single argument value in a tool call
 *
 * Story 10.2: Static Argument Extraction for Speculative Execution
 *
 * ArgumentValue stores HOW to resolve each argument, not the resolved value:
 * - literal: Direct value, use immediately
 * - reference: Resolve via ProvidesEdge + previous task result
 * - parameter: Extract from capability input parameters
 *
 * @example
 * ```typescript
 * // Literal: { path: "config.json" }
 * { type: "literal", value: "config.json" }
 *
 * // Reference: { input: file.content }
 * { type: "reference", expression: "file.content" }
 *
 * // Parameter: { path: args.filePath }
 * { type: "parameter", parameterName: "filePath" }
 * ```
 */
export interface ArgumentValue {
  /**
   * How this argument value should be resolved:
   * - "literal": The value is known at static analysis time
   * - "reference": The value comes from a previous task result (MemberExpression)
   * - "parameter": The value comes from capability input parameters (args.X, params.X)
   */
  type: "literal" | "reference" | "parameter";
  /**
   * For literal type: the actual value (string, number, boolean, object, array, null)
   * Must be JSON-serializable for storage in JSONB columns.
   */
  value?: JsonValue;
  /**
   * For reference type: the expression string representing the data source
   * @example "file.content", "result.items[0].value"
   */
  expression?: string;
  /**
   * For parameter type: the parameter name from capability input
   * @example "filePath", "inputData"
   */
  parameterName?: string;
}

/**
 * Map of argument names to their resolution strategies
 *
 * Story 10.2: Static Argument Extraction
 *
 * @example
 * ```typescript
 * // For: mcp.fs.read({ path: "config.json", verbose: args.debug })
 * {
 *   path: { type: "literal", value: "config.json" },
 *   verbose: { type: "parameter", parameterName: "debug" }
 * }
 * ```
 */
export type ArgumentsStructure = Record<string, ArgumentValue>;

/**
 * Static structure node types for capability analysis
 *
 * Nodes represent elements discovered during static code analysis:
 * - task: MCP tool call (e.g., mcp.filesystem.read_file)
 * - decision: Control flow (if/else, switch, ternary)
 * - capability: Nested capability call
 * - fork: Parallel execution start (Promise.all/allSettled)
 * - join: Parallel execution end
 *
 * Story 10.2: Added optional `arguments` field to task nodes for
 * speculative execution argument resolution.
 */
export type StaticStructureNode =
  | {
    id: string;
    type: "task";
    tool: string;
    /**
     * Extracted arguments for this tool call (Story 10.2)
     *
     * Contains resolution strategies for each argument:
     * - Literals are stored with their actual values
     * - References point to previous task results
     * - Parameters reference capability input
     */
    arguments?: ArgumentsStructure;
    /**
     * Original source code extracted via SWC span (Phase 1)
     *
     * For code operations (tool: "code:*"), this contains the actual
     * JavaScript code to execute, preserving callbacks and variable references.
     */
    code?: string;
  }
  | { id: string; type: "decision"; condition: string }
  | { id: string; type: "capability"; capabilityId: string }
  | { id: string; type: "fork" }
  | { id: string; type: "join" };

/**
 * Coverage level for "provides" edges (data flow)
 *
 * Based on intersection of provider outputs and consumer inputs:
 * - strict: Provider outputs cover ALL required inputs of consumer
 * - partial: Provider outputs cover SOME required inputs
 * - optional: Provider outputs only cover optional inputs
 */
export type ProvidesCoverage = "strict" | "partial" | "optional";

/**
 * Static structure edge types
 *
 * Edges represent relationships between nodes:
 * - sequence: Temporal order (A awaited before B)
 * - provides: Data flow (A's output feeds B's input)
 * - conditional: Branch from decision node
 * - contains: Hierarchy (capability contains tools)
 */
export interface StaticStructureEdge {
  from: string;
  to: string;
  type: "sequence" | "provides" | "conditional" | "contains";
  /** For conditional edges: branch outcome ("true", "false", "case:value") */
  outcome?: string;
  /** For provides edges: coverage level */
  coverage?: ProvidesCoverage;
}

/**
 * Complete static structure of a capability
 *
 * Represents the control flow and data flow graph extracted
 * from static code analysis (before execution).
 */
export interface StaticStructure {
  nodes: StaticStructureNode[];
  edges: StaticStructureEdge[];
  /**
   * Variable to node ID bindings for code task context injection.
   *
   * Maps variable names to the node IDs that produce their values.
   * Used to inject variables into code task execution context.
   *
   * @example
   * ```typescript
   * // Code: const users = await mcp.db.query(...);
   * //       const active = users.filter(u => u.active);
   * // Produces: { "users": "n1" }
   * // At runtime: inject `const users = deps.task_n1.output;`
   * ```
   */
  variableBindings?: Record<string, string>;
  /**
   * Variable to literal value bindings for argument resolution (Story 10.2b).
   *
   * Maps local variable names to their literal values when the variable
   * is assigned a static literal (number, string, boolean, array, object).
   * Used to resolve shorthand arguments like `{ numbers }` where `numbers`
   * is a local variable with a literal value.
   *
   * @example
   * ```typescript
   * // Code: const numbers = [10, 20, 30];
   * //       mcp.math.sum({ numbers })
   * // Produces: { "numbers": [10, 20, 30] }
   * // At resolution: { numbers } → { numbers: [10, 20, 30] }
   * ```
   */
  literalBindings?: Record<string, JsonValue>;
}

/**
 * API Types (Story 8.1)
 * INTERNAL types use camelCase. Mapping to snake_case happens in gateway-server.ts
 */

/**
 * Filters for listing capabilities (internal camelCase)
 */
export interface CapabilityFilters {
  /** Filter by Louvain community */
  communityId?: number;
  /** Minimum success rate (0-1) */
  minSuccessRate?: number;
  /** Minimum usage count */
  minUsage?: number;
  /** Maximum results per page */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Sort field */
  sort?: "usageCount" | "successRate" | "lastUsed" | "createdAt";
  /** Sort order */
  order?: "asc" | "desc";
}

/**
 * Single capability in API response (internal camelCase)
 * Maps to snake_case at API boundary in gateway-server.ts
 */
export interface CapabilityResponseInternal {
  id: string; // pattern_id UUID
  name: string | null; // Human-readable name (from capability_records.display_name or FQDN)
  fqdn: string | null; // Full FQDN from capability_records (Story 13.2)
  description: string | null; // Intent description
  codeSnippet: string; // TypeScript code
  toolsUsed: string[]; // ["filesystem:read", "github:create_issue"]
  toolInvocations?: CapabilityToolInvocation[]; // Detailed invocations with timestamps
  successRate: number; // 0-1
  usageCount: number; // Total executions
  avgDurationMs: number; // Average execution time
  communityId: number | null; // Louvain cluster
  intentPreview: string; // First 100 chars of intent
  createdAt: string; // ISO timestamp
  lastUsed: string; // ISO timestamp
  source: "emergent" | "manual"; // Learning source
}

/**
 * Response from listCapabilities (internal camelCase)
 */
export interface CapabilityListResponseInternal {
  capabilities: CapabilityResponseInternal[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Options for building hypergraph data (internal camelCase)
 */
export interface HypergraphOptions {
  /** Include standalone tools not in capabilities */
  includeTools?: boolean;
  /** Include orphan tools (no parent capabilities). Default: true for backward compat */
  includeOrphans?: boolean;
  /** Filter capabilities by minimum success rate */
  minSuccessRate?: number;
  /** Filter capabilities by minimum usage */
  minUsage?: number;
  /**
   * Include execution traces for each capability (Story 11.4)
   * When true, each capability node includes up to 10 recent traces
   */
  includeTraces?: boolean;
}

/**
 * Graph node for capability (parent node in compound graph)
 * Internal camelCase - maps to snake_case at API boundary
 * Note: Previously named CytoscapeNode, renamed after D3.js migration
 */
export interface CapabilityNode {
  data: {
    id: string; // "cap-{uuid}"
    type: "capability";
    label: string; // Name or intent preview
    codeSnippet: string;
    successRate: number;
    usageCount: number;
    toolsCount: number; // Number of child tools
    pagerank: number; // Hypergraph PageRank score (0-1)
    toolsUsed?: string[]; // Unique tools (deduplicated)
    toolInvocations?: CapabilityToolInvocation[]; // Full sequence with timestamps (for invocation mode)
    /** Execution traces (Story 11.4) - included when includeTraces=true */
    traces?: ExecutionTrace[];
    /** Last used timestamp (ISO format) for timeline sorting */
    lastUsed?: string;
  };
}

/**
 * Graph node for tool (child of capability or standalone)
 * Internal camelCase - maps to snake_case at API boundary
 * Note: Previously named CytoscapeNode, renamed after D3.js migration
 *
 * Story 8.2: Changed from `parent?: string` to `parents: string[]`
 * to support hyperedges (tool belonging to multiple capabilities).
 */
export interface ToolNode {
  data: {
    id: string; // "filesystem:read"
    /** @deprecated Use `parents` instead. Kept for backward compatibility. */
    parent?: string; // Single parent (legacy)
    /** Parent capability IDs - supports hyperedges (multi-parent). Empty array for standalone tools. */
    parents: string[]; // ["cap-uuid-1", "cap-uuid-2"] or [] for standalone
    type: "tool";
    server: string; // "filesystem"
    label: string; // "read"
    pagerank: number; // From GraphSnapshot
    degree: number; // From GraphSnapshot
    /** Louvain community ID for clustering visualization */
    communityId?: string;
  };
}

/**
 * Graph node for tool invocation (individual call within a capability)
 * Unlike ToolNode which is deduplicated, this represents each call to a tool.
 * Enables sequence visualization and parallelism detection.
 */
export interface ToolInvocationNode {
  data: {
    id: string; // "filesystem:read_file#0"
    /** Parent capability ID */
    parent: string; // "cap-uuid"
    type: "tool_invocation";
    /** The underlying tool ID */
    tool: string; // "filesystem:read_file"
    server: string; // "filesystem"
    label: string; // "read_file #1"
    /** Timestamp when invocation started (ms since epoch) */
    ts: number;
    /** Execution duration in milliseconds */
    durationMs: number;
    /** Sequence index within capability (0-based) */
    sequenceIndex: number;
  };
}

/**
 * Edge connecting sequential tool invocations within a capability
 * Shows execution order between invocations.
 */
export interface SequenceEdge {
  data: {
    id: string;
    source: string; // "filesystem:read_file#0"
    target: string; // "filesystem:read_file#1"
    edgeType: "sequence";
    /** Time delta between invocations in ms (negative = parallel) */
    timeDeltaMs: number;
    /** Whether invocations overlap in time (parallel execution) */
    isParallel: boolean;
  };
}

/**
 * Graph edge between capabilities that share tools
 * Internal camelCase - maps to snake_case at API boundary
 * Note: Previously named CytoscapeEdge, renamed after D3.js migration
 */
export interface CapabilityEdge {
  data: {
    id: string;
    source: string; // "cap-{uuid1}"
    target: string; // "cap-{uuid2}"
    sharedTools: number; // Count of shared tools
    edgeType: "capability_link";
    edgeSource: "inferred";
  };
}

/**
 * Hierarchical edge (capability → tool via parentTraceId, ADR-041)
 * Internal camelCase - maps to snake_case at API boundary
 */
export interface HierarchicalEdge {
  data: {
    id: string;
    source: string; // "cap-{uuid}" (parent)
    target: string; // "filesystem:read" (child tool)
    edgeType: "hierarchy";
    edgeSource: "observed"; // From trace data
    observedCount: number; // Number of times this call was traced
  };
}

/**
 * Tech-spec: Capability-to-capability dependency edge (hyperedge)
 * Represents relationships between capabilities in the hypergraph
 * Story 10.3: Added "provides" for data flow relationships
 */
export interface CapabilityDependencyEdge {
  data: {
    id: string;
    source: string; // "cap-{uuid1}"
    target: string; // "cap-{uuid2}"
    edgeType: "contains" | "sequence" | "dependency" | "alternative" | "provides";
    edgeSource: "template" | "inferred" | "observed";
    observedCount: number;
  };
}

/**
 * Union type for all graph nodes
 * @deprecated Use GraphNode instead. Kept for backward compatibility.
 */
export type CytoscapeNode = CapabilityNode | ToolNode | ToolInvocationNode;

/**
 * Union type for all graph edges
 * @deprecated Use GraphEdge instead. Kept for backward compatibility.
 */
export type CytoscapeEdge =
  | CapabilityEdge
  | HierarchicalEdge
  | CapabilityDependencyEdge
  | SequenceEdge;

/**
 * Union type for all graph nodes (D3.js visualization)
 */
export type GraphNode = CapabilityNode | ToolNode | ToolInvocationNode;

/**
 * Union type for all graph edges (D3.js visualization)
 */
export type GraphEdge = CapabilityEdge | HierarchicalEdge | CapabilityDependencyEdge | SequenceEdge;

/**
 * Hull zone metadata for capability visualization (Story 8.2)
 * Each capability is rendered as a convex hull around its tools
 */
export interface CapabilityZone {
  /** Capability ID (cap-{uuid}) */
  id: string;
  /** Display label */
  label: string;
  /** Zone color (hex) */
  color: string;
  /** Opacity (0-1) for overlapping zones */
  opacity: number;
  /** Tool IDs contained in this zone */
  toolIds: string[];
  /** Padding around tools in px */
  padding: number;
  /** Minimum hull radius */
  minRadius: number;
}

/**
 * Response from buildHypergraphData (internal camelCase)
 * Maps to snake_case at API boundary in gateway-server.ts
 */
export interface HypergraphResponseInternal {
  nodes: CytoscapeNode[];
  edges: CytoscapeEdge[];
  /** Hull zone metadata for D3.js hull rendering (Story 8.2) */
  capabilityZones?: CapabilityZone[];
  capabilitiesCount: number;
  toolsCount: number;
  metadata: {
    generatedAt: string;
    version: string;
  };
}

// ============================================
// FQDN Types (Story 13.1)
// ============================================

/**
 * Visibility levels for capability records (Epic 13)
 *
 * Controls access to capabilities:
 * - private: Only visible to creator
 * - project: Visible within same project
 * - org: Visible within same organization
 * - public: Visible to everyone
 */
export type CapabilityVisibility = "private" | "project" | "org" | "public";

/**
 * Routing mode for capability execution (Epic 13)
 *
 * - local: Execute in local sandbox (default)
 * - cloud: Execute via cloud RPC
 */
export type CapabilityRouting = "local" | "cloud";

/**
 * Components of a Fully Qualified Domain Name for capabilities (Story 13.1)
 *
 * FQDN format: `<org>.<project>.<namespace>.<action>.<hash>`
 *
 * @example
 * - `local.default.fs.read_json.a7f3` - Local dev capability
 * - `acme.webapp.api.fetch_user.b8e2` - Organization capability
 * - `marketplace.public.util.format_date.c9d1` - Public marketplace capability
 */
export interface FQDNComponents {
  /** Organization identifier (e.g., "local", "acme", "marketplace") */
  org: string;
  /** Project identifier (e.g., "default", "webapp", "public") */
  project: string;
  /** Namespace grouping (e.g., "fs", "api", "util") - user-chosen, not enforced */
  namespace: string;
  /** Action name (e.g., "read_json", "fetch_user") */
  action: string;
  /** 4-char hex hash of code content for uniqueness */
  hash: string;
}

/**
 * Scope for capability name resolution (Story 13.1)
 *
 * Used to resolve short names within a specific org/project context.
 *
 * @example
 * ```typescript
 * const scope: Scope = { org: "acme", project: "webapp" };
 * const resolved = await registry.resolveByName("my-reader", scope);
 * // Returns: "acme.webapp.fs.read_json.a7f3"
 * ```
 */
export interface Scope {
  /** Organization identifier ("local" for self-hosted, org slug for cloud) */
  org: string;
  /** Project identifier */
  project: string;
}

/**
 * A named capability in the registry (Story 13.1)
 *
 * This is the registry record type stored in `capability_records` table.
 * Different from `Capability` which is the workflow_pattern-based type.
 *
 * Architecture: Dual-table strategy (migration 023, 028)
 * - capability_records: UUID PK, FQDN components, visibility, provenance
 * - workflow_pattern: Code, embeddings, execution stats (via workflowPatternId FK)
 *
 * FQDN is computed from: `${org}.${project}.${namespace}.${action}.${hash}`
 * Display name is derived from: `${namespace}:${action}`
 */
export interface CapabilityRecord {
  // Identity
  /** UUID primary key (immutable) - used in code as mcp["$cap:<uuid>"] */
  id: string;
  /** Organization */
  org: string;
  /** Project */
  project: string;
  /** Namespace grouping */
  namespace: string;
  /** Action name */
  action: string;
  /** 4-char hex hash of code_snippet */
  hash: string;

  // Link to workflow_pattern (migration 023)
  /** FK to workflow_pattern.pattern_id for code, embedding, stats */
  workflowPatternId?: string;

  // Provenance
  /** Who created this record */
  createdBy: string;
  /** When created */
  createdAt: Date;
  /** Who last updated (null if never updated) */
  updatedBy?: string;
  /** When last updated (null if never updated) */
  updatedAt?: Date;

  // Versioning
  /** Version number (increments on updates) */
  version: number;
  /** Optional semantic version tag (e.g., "1.0.0") */
  versionTag?: string;

  // Trust
  /** Whether this capability is verified */
  verified: boolean;
  /** Optional cryptographic signature */
  signature?: string;

  // Metrics
  /** Total number of times used */
  usageCount: number;
  /** Number of successful executions */
  successCount: number;
  /** Cumulative execution time in milliseconds */
  totalLatencyMs: number;

  // Metadata
  /** Tags for categorization */
  tags: string[];
  /** Visibility level */
  visibility: CapabilityVisibility;
  /** Execution routing: local or cloud */
  routing: CapabilityRouting;
}

/**
 * Compute FQDN from CapabilityRecord components
 *
 * @param record - The capability record (or partial with FQDN components)
 * @returns FQDN string: org.project.namespace.action.hash
 */
export function getCapabilityFqdn(
  record: Pick<CapabilityRecord, "org" | "project" | "namespace" | "action" | "hash">,
): string {
  return `${record.org}.${record.project}.${record.namespace}.${record.action}.${record.hash}`;
}

/**
 * Get display name from CapabilityRecord (namespace:action)
 *
 * @param record - The capability record (or partial with namespace/action)
 * @returns Display name string: namespace:action
 */
export function getCapabilityDisplayName(
  record: Pick<CapabilityRecord, "namespace" | "action">,
): string {
  return `${record.namespace}:${record.action}`;
}

/**
 * Hierarchy node for trace reconstruction (Phase 8 - Migration)
 *
 * Used by ExecutionTraceStore.buildHierarchy() to reconstruct
 * the tree structure from flat traces with parentTraceId.
 *
 * @see 08-migration.md for spec details
 */
export interface HierarchyNode {
  /** The trace at this node */
  trace: ExecutionTrace;
  /** Child traces (those with parentTraceId pointing to this trace) */
  children: HierarchyNode[];
}

// CapabilityAlias and AliasResolutionResult removed in migration 028
// Aliases are no longer supported - use UUID for stable references

// ============================================
// MCP Tool Listing Types (Story 13.3)
// ============================================

/**
 * Capability with schema for MCP tool listing (Story 13.3)
 *
 * JOINed data from capability_records + workflow_pattern tables
 * for generating MCP tool definitions.
 */
export interface CapabilityWithSchema {
  /** Capability pattern_id */
  id: string;
  /** Namespace from capability_records */
  namespace: string;
  /** Action from capability_records */
  action: string;
  /** Display name from capability_records */
  displayName: string;
  /** Description from workflow_pattern */
  description: string | null;
  /** JSON Schema for parameters from workflow_pattern */
  parametersSchema: Record<string, unknown> | null;
  /** Usage count for sorting */
  usageCount: number;
}

/**
 * Options for listWithSchemas query (Story 13.3)
 */
export interface ListWithSchemasOptions {
  /** Filter by visibility levels (default: all) */
  visibility?: Array<"public" | "org" | "project" | "private">;
  /** Filter by creator */
  createdBy?: string;
  /** Maximum results (default: 100) */
  limit?: number;
  /** Order by field (default: usageCount) */
  orderBy?: "usageCount" | "displayName" | "createdAt";
}
