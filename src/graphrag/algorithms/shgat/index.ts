/**
 * SHGAT Module Index
 *
 * SuperHyperGraph Attention Networks - modular architecture.
 *
 * Modules:
 * - graph: Graph construction and management
 * - initialization: Parameter initialization
 * - message-passing: Two-phase message passing
 * - scoring: V1 and V2 scoring implementations
 * - training: V1 and V2 training logic
 * - utils: Mathematical utilities
 *
 * @module graphrag/algorithms/shgat
 */

// Graph construction
export * from "./graph/index.ts";

// Parameter initialization
export * from "./initialization/index.ts";

// Message passing
export * from "./message-passing/index.ts";

// Scoring
export * from "./scoring/index.ts";

// Training
export * from "./training/index.ts";

// Math utilities
export * as math from "./utils/math.ts";

// Re-export types from ./types.ts
export type {
  AttentionResult,
  CapabilityMember,
  CapabilityNode,
  FeatureWeights,
  ForwardCache,
  // Legacy Types
  FusionWeights,
  // Graph Feature Types
  HypergraphFeatures,
  LegacyCapabilityNode,
  LevelParams,
  // Node Types
  Member,
  // Multi-level message passing types (v1 refactor)
  MultiLevelEmbeddings,
  MultiLevelForwardCache,
  // Configuration
  SHGATConfig,
  ToolGraphFeatures,
  ToolMember,
  ToolNode,
  TraceFeatures,
  // Trace Features (v2)
  TraceStats,
  // Training Types
  TrainingExample,
} from "./types.ts";

export {
  // Functions
  createDefaultTraceFeatures,
  createMembersFromLegacy,
  DEFAULT_FEATURE_WEIGHTS,
  DEFAULT_FUSION_WEIGHTS,
  DEFAULT_HYPERGRAPH_FEATURES,
  DEFAULT_SHGAT_CONFIG,
  DEFAULT_TOOL_GRAPH_FEATURES,
  // Constants
  DEFAULT_TRACE_STATS,
  getAdaptiveConfig,
  getDirectCapabilities,
  // n-SuperHyperGraph helpers (v1 refactor)
  getDirectTools,
  migrateCapabilityNode,
  NUM_TRACE_STATS,
} from "./types.ts";

// Re-export HierarchyCycleError from graph module for easy access
export { HierarchyCycleError } from "./graph/index.ts";
