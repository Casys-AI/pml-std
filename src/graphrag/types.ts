/**
 * GraphRAG Types and Interfaces
 *
 * @module graphrag/types
 */

import type { JsonValue, PermissionSet, ProvidesCoverage } from "../capabilities/types.ts";

// Re-export ProvidesCoverage for consumers of graphrag module
export type { ProvidesCoverage } from "../capabilities/types.ts";

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
  staticArguments?: import("../capabilities/types.ts").ArgumentsStructure;

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

/**
 * Graph statistics
 */
export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  communities: number;
  avgPageRank: number;
}

/**
 * Execution record for adaptive learning
 *
 * Story 10.7c: Added toolId for Thompson Sampling per-tool learning.
 */
export interface ExecutionRecord {
  confidence: number;
  mode: "explicit" | "suggestion" | "speculative";
  success: boolean;
  userAccepted?: boolean;
  executionTime?: number;
  timestamp: number;
  /** Story 10.7c: Tool ID for per-tool Thompson Sampling updates */
  toolId?: string;
}

/**
 * Speculative execution metrics
 */
export interface SpeculativeMetrics {
  totalSpeculativeAttempts: number;
  successfulExecutions: number;
  failedExecutions: number;
  avgExecutionTime: number;
  avgConfidence: number;
  wastedComputeCost: number;
  savedLatency: number;
}

// =============================================================================
// Story 3.5-1: DAG Suggester & Speculative Execution
// =============================================================================

/**
 * Predicted next node for speculative execution (Story 3.5-1, Story 7.4)
 *
 * Represents a tool or capability that is likely to be requested next based on:
 * - Historical co-occurrence patterns
 * - Community membership (Louvain)
 * - Learned capabilities (Story 7.4)
 * - Agent hints and learned patterns
 *
 * Note: "adamic-adar" source removed per ADR-038 (dilutes signal for passive suggestion).
 */
export interface PredictedNode {
  toolId: string;
  confidence: number;
  reasoning: string;
  /**
   * Prediction source (Story 7.4 - ADR-038)
   *
   * - community: Same Louvain community as completed task
   * - co-occurrence: Historical edge weight (observed co-usage)
   * - capability: Learned capability matching context tools (Story 7.4)
   * - hint: Agent-provided hint for bootstrap
   * - learned: Pattern learned from execution history
   */
  source: "community" | "co-occurrence" | "capability" | "hint" | "learned";
  wasCorrect?: boolean; // Set after validation
  /**
   * Capability ID if source is "capability" (Story 7.4)
   */
  capabilityId?: string;
  /**
   * Inferred arguments for speculative execution
   *
   * Populated from previous task results using ProvidesEdge field mappings.
   * When set, enables real speculative execution instead of placeholder preparation.
   */
  arguments?: Record<string, unknown>;
}

/**
 * Configuration for speculative execution (Story 3.5-1)
 */
export interface SpeculationConfig {
  enabled: boolean;
  confidenceThreshold: number; // Default: 0.70
  maxConcurrent: number; // Default: 3
}

/**
 * Cached result from speculative execution (Story 3.5-1)
 */
export interface SpeculationCache {
  predictionId: string;
  toolId: string;
  result: JsonValue;
  confidence: number;
  timestamp: number;
  executionTimeMs: number;
}

/**
 * Speculation metrics for monitoring (Story 3.5-1)
 */
export interface SpeculationMetrics {
  hitRate: number;
  netBenefitMs: number;
  falsePositiveRate: number;
  totalSpeculations: number;
  totalHits: number;
  totalMisses: number;
}

/**
 * Learned pattern from execution history (Story 3.5-1)
 */
export interface LearnedPattern {
  fromTool: string;
  toTool: string;
  successRate: number;
  observationCount: number;
  avgConfidence: number;
  source: "user" | "learned";
}

/**
 * Workflow state for prediction (Story 3.5-1)
 */
export interface WorkflowPredictionState {
  workflowId: string;
  currentLayer: number;
  completedTasks: CompletedTask[];
  context?: Record<string, unknown>;
}

/**
 * Completed task for prediction context (Story 3.5-1)
 */
export interface CompletedTask {
  taskId: string;
  tool: string;
  status: "success" | "error" | "failed_safe";
  executionTimeMs?: number;
}

// =============================================================================
// Story 5.2 / ADR-022: Hybrid Search Integration
// =============================================================================

/**
 * Result from hybrid search combining semantic and graph scores (ADR-022)
 *
 * Centralizes the hybrid search logic for use in both:
 * - GatewayServer.handleSearchTools (MCP tool)
 * - DAGSuggester.suggestDAG (internal)
 */
export interface HybridSearchResult {
  toolId: string;
  serverId: string;
  toolName: string;
  description: string;
  /** Semantic similarity score (0-1) */
  semanticScore: number;
  /** Graph relatedness score (0-1) */
  graphScore: number;
  /** Combined final score: α × semantic + (1-α) × graph */
  finalScore: number;
  /** Related tools (in/out neighbors) if requested */
  relatedTools?: Array<{
    toolId: string;
    relation: "often_before" | "often_after";
    score: number;
  }>;
  /** Original schema from tool_schema table */
  schema?: Record<string, unknown>;
}

// =============================================================================
// Story 6.3: Live Metrics & Analytics Panel
// =============================================================================

/**
 * Time range for metrics queries
 */
export type MetricsTimeRange = "1h" | "24h" | "7d";

/**
 * Time series data point
 */
export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
}

/**
 * Graph metrics response for dashboard (Story 6.3 AC4)
 *
 * Contains current snapshot metrics, time series data for charts,
 * and period statistics for the selected time range.
 */
export interface GraphMetricsResponse {
  /** Current snapshot metrics */
  current: {
    nodeCount: number;
    edgeCount: number;
    density: number;
    /** @deprecated Use localAlpha instead (ADR-048) */
    adaptiveAlpha: number;
    communitiesCount: number;
    pagerankTop10: Array<{ toolId: string; score: number }>;
    // Extended metrics
    capabilitiesCount?: number;
    embeddingsCount?: number;
    dependenciesCount?: number;
    /** ADR-048: Local adaptive alpha statistics from recent traces */
    localAlpha?: {
      /** Average alpha across all recent traces */
      avgAlpha: number;
      /** Average alpha by mode */
      byMode: {
        activeSearch: number;
        passiveSuggestion: number;
      };
      /** Algorithm usage distribution */
      algorithmDistribution: {
        embeddingsHybrides: number;
        heatDiffusion: number;
        heatHierarchical: number;
        bayesian: number;
        none: number;
      };
      /** Cold start percentage */
      coldStartPercentage: number;
    };
  };

  /** Time series data for charts */
  timeseries: {
    edgeCount: TimeSeriesPoint[];
    avgConfidence: TimeSeriesPoint[];
    workflowRate: TimeSeriesPoint[];
  };

  /** Period statistics */
  period: {
    range: MetricsTimeRange;
    workflowsExecuted: number;
    workflowsSuccessRate: number;
    newEdgesCreated: number;
    newNodesAdded: number;
  };

  /** Algorithm tracing statistics (Story 7.6, ADR-039) */
  algorithm?: {
    tracesCount: number;
    acceptanceRate: number;
    avgFinalScore: number;
    avgSemanticScore: number;
    avgGraphScore: number;
    byDecision: { accepted: number; filtered: number; rejected: number };
    byTargetType: { tool: number; capability: number };
    timeseries?: {
      acceptanceRate: TimeSeriesPoint[];
      avgScore: TimeSeriesPoint[];
      volume: TimeSeriesPoint[];
    };

    /**
     * ADR-039: Separation of Graph vs Hypergraph algorithm stats
     *
     * - graph: Simple algos (PageRank, Adamic-Adar, co-occurrence)
     * - hypergraph: Advanced algos (Spectral Clustering, capability matching)
     *
     * Classification logic:
     * - hypergraph if target_type = 'capability' OR signals.spectralClusterMatch IS NOT NULL
     * - graph otherwise
     */
    byGraphType?: {
      graph: {
        count: number;
        avgScore: number;
        acceptanceRate: number;
        topSignals: { pagerank: number; adamicAdar: number; cooccurrence: number };
      };
      hypergraph: {
        count: number;
        avgScore: number;
        acceptanceRate: number;
        spectralRelevance: {
          withClusterMatch: { count: number; avgScore: number; selectedRate: number };
          withoutClusterMatch: { count: number; avgScore: number; selectedRate: number };
        };
      };
    };

    /** ADR-039: Threshold efficiency metrics */
    thresholdEfficiency?: {
      rejectedByThreshold: number;
      totalEvaluated: number;
      rejectionRate: number;
    };

    /** ADR-039: Score distribution histograms by graph type */
    scoreDistribution?: {
      graph: Array<{ bucket: string; count: number }>;
      hypergraph: Array<{ bucket: string; count: number }>;
    };

    /** ADR-039: Stats by algorithm mode */
    byMode?: {
      activeSearch: { count: number; avgScore: number; acceptanceRate: number };
      passiveSuggestion: { count: number; avgScore: number; acceptanceRate: number };
    };
  };
}

// =============================================================================
// Story 10.3: Provides Edge Types (Data Flow Relationships)
// =============================================================================

/**
 * JSON Schema representation for tool inputs/outputs
 */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
  [key: string]: unknown;
}

/**
 * Field-level mapping between provider output and consumer input
 *
 * Describes how a specific field from the provider's output
 * maps to a field in the consumer's input.
 */
export interface FieldMapping {
  /** Field name in provider's output schema */
  fromField: string;
  /** Field name in consumer's input schema */
  toField: string;
  /** Whether types are compatible (string->string, number->string, etc.) */
  typeCompatible: boolean;
  /** Source field type */
  fromType?: string;
  /** Target field type */
  toType?: string;
}

/**
 * Provides edge representing data flow between tools/capabilities
 *
 * Story 10.3: Captures the relationship where one tool's output
 * can serve as input to another tool. Used to improve DAG suggestions
 * by understanding natural data flow chains.
 *
 * Example: fs:read_file (outputs: content) -> json:parse (inputs: json)
 * This creates a "provides" edge because content can feed json input.
 */
export interface ProvidesEdge {
  /** Tool/capability that provides the data */
  from: string;
  /** Tool/capability that consumes the data */
  to: string;
  /** Edge type (always "provides" for this interface) */
  type: "provides";
  /** Coverage level: strict (all required), partial (some required), optional (only optional) */
  coverage: ProvidesCoverage;
  /** JSON Schema of what the provider outputs */
  providerOutputSchema: JSONSchema;
  /** JSON Schema of what the consumer expects as input */
  consumerInputSchema: JSONSchema;
  /** Field-by-field mapping showing how data flows */
  fieldMapping: FieldMapping[];
  /** Weight for graph algorithms (default: 0.7) */
  weight?: number;
}

// =============================================================================
// Phase 2a: Graph Node Types (Operation vs Tool Distinction)
// =============================================================================

/**
 * Graph node type for distinguishing between operations and tools
 *
 * Phase 2a: Separate representation for pure code operations vs MCP tools
 * to enable semantic learning and better SHGAT pattern recognition.
 */
export type GraphNodeType = "intent" | "tool" | "operation" | "capability" | "result";

/**
 * Operation category for pure code operations
 */
export type OperationCategory =
  | "array"
  | "string"
  | "object"
  | "math"
  | "json"
  | "binary"
  | "logical"
  | "bitwise";

/**
 * Base attributes for graph nodes
 */
export interface BaseNodeAttributes {
  name: string;
  serverId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * MCP tool node attributes
 *
 * Represents external tools with side effects (filesystem, network, database, etc.)
 */
export interface ToolNodeAttributes extends BaseNodeAttributes {
  type: "tool";
  /** Server providing this tool (e.g., "github", "filesystem") */
  serverId: string;
}

/**
 * Pure operation node attributes
 *
 * Represents pure JavaScript operations with no side effects (filter, map, reduce, etc.)
 * These operations can be safely fused and learned semantically by SHGAT.
 */
export interface OperationNodeAttributes extends BaseNodeAttributes {
  type: "operation";
  /** Server is always "code" for operations */
  serverId: "code";
  /** Operation category for semantic grouping */
  category: OperationCategory;
  /** All operations are pure (no side effects) */
  pure: true;
}

/**
 * Capability node attributes
 */
export interface CapabilityNodeAttributes extends BaseNodeAttributes {
  type: "capability";
}

/**
 * Union type for all graph node attributes
 */
export type GraphNodeAttributes =
  | ToolNodeAttributes
  | OperationNodeAttributes
  | CapabilityNodeAttributes
  | BaseNodeAttributes; // Fallback for legacy nodes
