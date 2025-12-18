/**
 * GraphRAG Module
 *
 * Provides graph-based retrieval augmented generation with:
 * - Tool relationship graph management
 * - Workflow intent analysis
 * - DAG suggestion from natural language
 * - Spectral clustering for tool grouping
 *
 * @module graphrag
 */

// Core engine
export { GraphRAGEngine } from "./graph-engine.ts";

// DAG suggestion
export { DAGSuggester } from "./dag-suggester.ts";

// Workflow loading and sync
export { WorkflowLoader } from "./workflow-loader.ts";
export type {
  ValidationResult,
  WorkflowEdge,
  WorkflowTemplate,
  WorkflowTemplatesFile,
} from "./workflow-loader.ts";
export { WorkflowSyncService } from "./workflow-sync.ts";
export type { EmbeddingModelFactory, IEmbeddingModel, SyncResult } from "./workflow-sync.ts";

// Spectral clustering
export { SpectralClusteringManager } from "./spectral-clustering.ts";
export type { ClusterableCapability, ClusterAssignment } from "./spectral-clustering.ts";

// Local adaptive alpha (ADR-048)
export { LocalAlphaCalculator } from "./local-alpha.ts";
export type { AlphaMode, NodeType, LocalAlphaResult, HeatWeights } from "./local-alpha.ts";

// Provides edge calculator (Story 10.3)
export {
  areTypesCompatible,
  computeCoverage,
  createFieldMapping,
  createProvidesEdges,
  findDirectProvidesEdge,
  getToolProvidesEdges,
  getToolProvidesEdgesFull,
  persistProvidesEdges,
  syncAllProvidesEdges,
  syncProvidesEdgesForTool,
  type ConsumerInputs,
} from "./provides-edge-calculator.ts";

// Core types
export type {
  DAGStructure,
  DependencyPath,
  ExecutionMode,
  ExecutionRecord,
  ExecutionResult,
  FieldMapping,
  GraphStats,
  JSONSchema,
  ProvidesCoverage,
  ProvidesEdge,
  SpeculativeMetrics,
  SuggestedDAG,
  Task,
  WorkflowExecution,
  WorkflowIntent,
} from "./types.ts";

// Event types
export type {
  EdgeCreatedEvent,
  EdgeUpdatedEvent,
  GraphEvent,
  GraphSyncedEvent,
  HeartbeatEvent,
  MetricsUpdatedEvent,
  WorkflowExecutedEvent,
} from "./events.ts";
