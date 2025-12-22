/**
 * Event Types for Casys PML EventBus
 * Story 6.5: EventBus with BroadcastChannel (ADR-036)
 *
 * Comprehensive event type definitions for unified event distribution.
 * All system events (tools, DAG, graph, capabilities) use these types.
 *
 * @module events/types
 */

// ══════════════════════════════════════════════════════════════════════════════
// EVENT TYPE UNION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * All possible event types in Casys PML
 */
export type EventType =
  // ──────────────────────────────────────────────────────────────────────────
  // EXECUTION EVENTS (real-time tracing)
  // ──────────────────────────────────────────────────────────────────────────
  | "tool.start"
  | "tool.end"
  | "capability.start"
  | "capability.end"
  | "dag.started"
  | "dag.task.started"
  | "dag.task.completed"
  | "dag.task.failed"
  | "dag.completed"
  | "dag.replanned" // AIL/HIL replan event
  // ──────────────────────────────────────────────────────────────────────────
  // SPECULATION EVENTS (Epic 3.5)
  // ──────────────────────────────────────────────────────────────────────────
  | "speculation.started"
  | "speculation.committed"
  | "speculation.rolledback"
  // ──────────────────────────────────────────────────────────────────────────
  // ALGORITHM EVENTS (ADR-039 - Story 7.6)
  // ──────────────────────────────────────────────────────────────────────────
  | "algorithm.scored"
  | "algorithm.suggested"
  | "algorithm.filtered"
  | "algorithm.feedback.selected"
  | "algorithm.feedback.ignored"
  | "algorithm.feedback.rejected"
  | "algorithm.threshold.adjusted"
  | "algorithm.anomaly.detected"
  // ──────────────────────────────────────────────────────────────────────────
  // LEARNING EVENTS (Epic 7)
  // ──────────────────────────────────────────────────────────────────────────
  | "capability.learned"
  | "capability.matched"
  | "capability.executed"
  | "capability.pruned"
  | "capability.dependency.created"
  | "capability.dependency.removed"
  | "capability.zone.created"
  | "capability.zone.updated"
  | "capability.permission.updated" // Story 7.7c: HIL permission escalation
  // ──────────────────────────────────────────────────────────────────────────
  // EXECUTION TRACE EVENTS (Story 11.2 - Epic 11)
  // ──────────────────────────────────────────────────────────────────────────
  | "execution.trace.saved"
  | "execution.trace.priority.updated"
  | "execution.traces.pruned"
  | "learning.pattern.detected"
  | "learning.edge.strengthened"
  | "cache.hit"
  | "cache.miss"
  | "cache.invalidated"
  // ──────────────────────────────────────────────────────────────────────────
  // GRAPH EVENTS (GraphRAG)
  // ──────────────────────────────────────────────────────────────────────────
  | "graph.synced"
  | "graph.edge.created"
  | "graph.edge.updated"
  | "graph.metrics.computed"
  | "graph.community.detected"
  // ──────────────────────────────────────────────────────────────────────────
  // SEARCH EVENTS
  // ──────────────────────────────────────────────────────────────────────────
  | "search.started"
  | "search.completed"
  | "search.hybrid.reranked"
  // ──────────────────────────────────────────────────────────────────────────
  // SYSTEM EVENTS
  // ──────────────────────────────────────────────────────────────────────────
  | "health.check"
  | "metrics.snapshot"
  | "system.startup"
  | "system.shutdown"
  | "heartbeat";

// ══════════════════════════════════════════════════════════════════════════════
// CORE EVENT INTERFACE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Base event interface for all Casys PML events
 */
export interface PmlEvent<T extends EventType = EventType, P = unknown> {
  /** Event type identifier */
  type: T;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Source component (e.g., "worker-bridge", "dag-executor", "graphrag") */
  source: string;
  /** Event-specific payload */
  payload: P;
}

// ══════════════════════════════════════════════════════════════════════════════
// TOOL EVENT PAYLOADS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Payload for tool.start events
 */
export interface ToolStartPayload {
  /** Full tool identifier (server:tool_name) */
  toolId: string;
  /** Unique trace ID for correlating start/end */
  traceId: string;
  /** Tool arguments (may be redacted for sensitive data) */
  args?: Record<string, unknown>;
  /** Parent trace ID for hierarchical tracking (ADR-041) */
  parentTraceId?: string;
}

/**
 * Payload for tool.end events
 */
export interface ToolEndPayload {
  /** Full tool identifier (server:tool_name) */
  toolId: string;
  /** Unique trace ID for correlating start/end */
  traceId: string;
  /** Whether tool execution succeeded */
  success: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Result summary (truncated for large outputs) */
  resultSummary?: string;
  /** Execution result (Story 11.1 - for learning/tracing) */
  result?: unknown;
  /** Parent trace ID for hierarchical tracking (ADR-041) */
  parentTraceId?: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// CAPABILITY EVENT PAYLOADS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Payload for capability.start events
 */
export interface CapabilityStartPayload {
  /** Capability identifier (code hash) */
  capabilityId: string;
  /** Capability name */
  capability: string;
  /** Trace ID for correlation */
  traceId: string;
  /** Parent trace ID if nested */
  parentTraceId?: string;
  /** Arguments passed to capability */
  args?: Record<string, unknown>;
}

/**
 * Payload for capability.end events
 */
export interface CapabilityEndPayload {
  /** Capability identifier (code hash) */
  capabilityId: string;
  /** Capability name */
  capability: string;
  /** Trace ID for correlation */
  traceId: string;
  /** Whether capability execution succeeded */
  success: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Execution result (Story 11.1 - for learning/tracing) */
  result?: unknown;
}

/**
 * Payload for capability.learned events
 */
export interface CapabilityLearnedPayload {
  /** Capability identifier (code hash) */
  capabilityId: string;
  /** Capability name */
  name: string;
  /** Intent that triggered learning */
  intent: string;
  /** Tools used by capability */
  toolsUsed: string[];
  /** Whether this is a new capability or update */
  isNew: boolean;
  /** Usage count after save */
  usageCount: number;
  /** Success rate */
  successRate: number;
}

/**
 * Payload for capability.matched events
 */
export interface CapabilityMatchedPayload {
  /** Capability identifier (code hash) */
  capabilityId: string;
  /** Capability name */
  name: string;
  /** Intent that was matched */
  intent: string;
  /** Final calculated score (semantic * reliability factor, capped at 0.95) */
  score: number;
  /** Raw semantic similarity score (0-1) before adjustments */
  semanticScore: number;
  /** Threshold used for matching */
  thresholdUsed: number;
  /** Whether capability was selected for execution */
  selected: boolean;
}

/**
 * Payload for capability.zone.created events
 * Emitted when a new capability zone is created for hypergraph visualization
 */
export interface CapabilityZoneCreatedPayload {
  /** Capability identifier (cap-{uuid}) */
  capabilityId: string;
  /** Display label for the zone */
  label: string;
  /** Tool IDs contained in this zone */
  toolIds: string[];
  /** Zone color (hex) - assigned by frontend if not provided */
  color?: string;
  /** Success rate for display */
  successRate: number;
  /** Usage count */
  usageCount: number;
}

/**
 * Payload for capability.zone.updated events
 * Emitted when a capability zone's metadata or tools change
 */
export interface CapabilityZoneUpdatedPayload {
  /** Capability identifier (cap-{uuid}) */
  capabilityId: string;
  /** Updated display label (optional) */
  label?: string;
  /** Updated tool IDs (optional - if tools changed) */
  toolIds?: string[];
  /** Updated success rate */
  successRate: number;
  /** Updated usage count */
  usageCount: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// DAG EVENT PAYLOADS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Payload for dag.started events
 */
export interface DagStartedPayload {
  /** Execution ID */
  executionId: string;
  /** Intent text (if available) */
  intent?: string;
  /** Total number of tasks */
  taskCount: number;
  /** Number of parallel layers */
  layerCount: number;
  /** Task IDs */
  taskIds: string[];
}

/**
 * Payload for dag.task.started events
 */
export interface DagTaskStartedPayload {
  /** Execution ID */
  executionId: string;
  /** Task ID */
  taskId: string;
  /** Tool being executed */
  tool: string;
  /** Layer number (for parallel execution) */
  layer: number;
  /** Task arguments */
  args?: Record<string, unknown>;
}

/**
 * Payload for dag.task.completed events
 */
export interface DagTaskCompletedPayload {
  /** Execution ID */
  executionId: string;
  /** Task ID */
  taskId: string;
  /** Tool that was executed */
  tool: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Result summary */
  resultSummary?: string;
}

/**
 * Payload for dag.task.failed events
 */
export interface DagTaskFailedPayload {
  /** Execution ID */
  executionId: string;
  /** Task ID */
  taskId: string;
  /** Tool that failed */
  tool: string;
  /** Error message */
  error: string;
  /** Whether failure is recoverable */
  recoverable: boolean;
}

/**
 * Payload for dag.completed events
 */
export interface DagCompletedPayload {
  /** Execution ID */
  executionId: string;
  /** Total execution time in milliseconds */
  totalDurationMs: number;
  /** Number of successful tasks */
  successfulTasks: number;
  /** Number of failed tasks */
  failedTasks: number;
  /** Overall success (all tasks completed) */
  success: boolean;
  /** Parallelization speedup factor */
  speedup?: number;
}

/**
 * Payload for dag.replanned events (AIL/HIL)
 */
export interface DagReplannedPayload {
  /** Execution ID */
  executionId: string;
  /** Reason for replan */
  reason: "ail_decision" | "hil_decision" | "error_recovery";
  /** Tasks added */
  tasksAdded: string[];
  /** Tasks removed */
  tasksRemoved: string[];
  /** New layer count */
  newLayerCount: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// GRAPH EVENT PAYLOADS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Payload for graph.synced events
 */
export interface GraphSyncedPayload {
  /** Number of nodes in graph */
  nodeCount: number;
  /** Number of edges in graph */
  edgeCount: number;
  /** Sync duration in milliseconds */
  syncDurationMs: number;
}

/**
 * Payload for graph.edge.created events
 */
export interface GraphEdgeCreatedPayload {
  /** Source tool ID */
  fromToolId: string;
  /** Target tool ID */
  toToolId: string;
  /** Initial confidence score */
  confidenceScore: number;
  /** Source of edge (execution, template, manual) */
  source?: string;
}

/**
 * Payload for graph.edge.updated events
 */
export interface GraphEdgeUpdatedPayload {
  /** Source tool ID */
  fromToolId: string;
  /** Target tool ID */
  toToolId: string;
  /** Previous confidence score */
  oldConfidence: number;
  /** New confidence score */
  newConfidence: number;
  /** Total observation count */
  observedCount: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// ALGORITHM EVENT PAYLOADS (Preparation for Story 7.6)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Payload for algorithm.scored events
 */
export interface AlgorithmScoredPayload {
  /** Item identifier (toolId or capabilityId) */
  itemId: string;
  /** Human-readable item name for display */
  itemName?: string;
  /** Type of item being scored */
  itemType: "tool" | "capability";
  /** Intent text (if applicable) */
  intent?: string;
  /** Individual scoring signals */
  signals: {
    /** Semantic similarity score (0-1) */
    semanticScore?: number;
    /** Graph-based relatedness score (0-1) */
    graphScore?: number;
    /** Historical success rate (0-1) */
    successRate?: number;
    /** PageRank centrality score */
    pagerank?: number;
    /** Adamic-Adar similarity */
    adamicAdar?: number;
  };
  /** Combined final score */
  finalScore: number;
  /** Current threshold for acceptance */
  threshold: number;
  /** Whether item was accepted or filtered */
  decision: "accepted" | "filtered";
}

/**
 * Payload for algorithm.suggested events
 */
export interface AlgorithmSuggestedPayload {
  /** Unique suggestion ID */
  suggestionId: string;
  /** Type of suggestion */
  suggestionType: "tool" | "capability" | "workflow";
  /** Item being suggested */
  itemId: string;
  /** Confidence in suggestion (0-1) */
  confidence: number;
  /** Reason for suggestion */
  reason: string;
  /** Context tools that influenced suggestion */
  contextTools?: string[];
}

/**
 * Payload for algorithm.feedback.* events
 */
export interface AlgorithmFeedbackPayload {
  /** Suggestion ID being responded to */
  suggestionId: string;
  /** Feedback action */
  action: "selected" | "ignored" | "rejected";
  /** Time from suggestion to action in milliseconds */
  timeToActionMs?: number;
  /** Optional feedback text */
  feedbackText?: string;
}

/**
 * Payload for algorithm.threshold.adjusted events
 */
export interface ThresholdAdjustedPayload {
  /** Context hash (for context-specific thresholds) */
  contextHash: string;
  /** Previous threshold value */
  oldValue: number;
  /** New threshold value */
  newValue: number;
  /** Reason for adjustment */
  reason: "success_feedback" | "failure_feedback" | "decay" | "manual";
  /** Number of samples used for adjustment */
  sampleCount?: number;
}

/**
 * Payload for algorithm.anomaly.detected events
 */
export interface AlgorithmAnomalyPayload {
  /** Type of anomaly */
  anomalyType: "score_drift" | "success_drop" | "latency_spike" | "usage_anomaly";
  /** Metric that triggered detection */
  metric: string;
  /** Expected value */
  expected: number;
  /** Actual value */
  actual: number;
  /** Standard deviations from mean */
  zScore: number;
  /** Severity level */
  severity: "low" | "medium" | "high";
}

// ══════════════════════════════════════════════════════════════════════════════
// SYSTEM EVENT PAYLOADS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Payload for heartbeat events
 */
export interface HeartbeatPayload {
  /** Number of connected SSE clients */
  connectedClients: number;
  /** Uptime in seconds */
  uptimeSeconds: number;
}

/**
 * Payload for health.check events
 */
export interface HealthCheckPayload {
  /** Component being checked */
  component: string;
  /** Health status */
  status: "healthy" | "degraded" | "unhealthy";
  /** Response time in milliseconds */
  latencyMs: number;
  /** Additional details */
  details?: Record<string, unknown>;
}

/**
 * Payload for metrics.snapshot events
 */
export interface MetricsSnapshotPayload {
  /** Node count */
  nodeCount: number;
  /** Edge count */
  edgeCount: number;
  /** Graph density */
  density: number;
  /** Active DAG executions */
  activeExecutions: number;
  /** Capabilities count */
  capabilitiesCount: number;
  /** Memory usage in bytes */
  memoryUsageBytes?: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// TYPED EVENT HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Typed event for tool.start
 */
export type ToolStartEvent = PmlEvent<"tool.start", ToolStartPayload>;

/**
 * Typed event for tool.end
 */
export type ToolEndEvent = PmlEvent<"tool.end", ToolEndPayload>;

/**
 * Typed event for capability.start
 */
export type CapabilityStartEvent = PmlEvent<"capability.start", CapabilityStartPayload>;

/**
 * Typed event for capability.end
 */
export type CapabilityEndEvent = PmlEvent<"capability.end", CapabilityEndPayload>;

/**
 * Typed event for capability.learned
 */
export type CapabilityLearnedEvent = PmlEvent<"capability.learned", CapabilityLearnedPayload>;

/**
 * Typed event for capability.matched
 */
export type CapabilityMatchedEvent = PmlEvent<"capability.matched", CapabilityMatchedPayload>;

/**
 * Typed event for capability.zone.created
 */
export type CapabilityZoneCreatedEvent = PmlEvent<
  "capability.zone.created",
  CapabilityZoneCreatedPayload
>;

/**
 * Typed event for capability.zone.updated
 */
export type CapabilityZoneUpdatedEvent = PmlEvent<
  "capability.zone.updated",
  CapabilityZoneUpdatedPayload
>;

/**
 * Typed event for dag.started
 */
export type DagStartedEvent = PmlEvent<"dag.started", DagStartedPayload>;

/**
 * Typed event for dag.completed
 */
export type DagCompletedEvent = PmlEvent<"dag.completed", DagCompletedPayload>;

/**
 * Typed event for graph.synced
 */
export type GraphSyncedEvent = PmlEvent<"graph.synced", GraphSyncedPayload>;

/**
 * Typed event for algorithm.scored
 */
export type AlgorithmScoredEvent = PmlEvent<"algorithm.scored", AlgorithmScoredPayload>;

/**
 * Event handler function type
 */
export type EventHandler<T extends EventType = EventType> = (
  event: PmlEvent<T>,
) => void | Promise<void>;

/**
 * Wildcard event handler that receives all events
 */
export type WildcardEventHandler = (event: PmlEvent) => void | Promise<void>;
