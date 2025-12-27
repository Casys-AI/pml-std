/**
 * Graph Algorithms Module
 *
 * Exports all graph algorithms for centrality, community detection,
 * path finding, and similarity computation.
 *
 * @module graphrag/algorithms
 */

// PageRank centrality
export {
  computePageRank,
  getAveragePageRank,
  getPageRankScore,
  getTopPageRankNodes,
  type PageRankOptions,
  type PageRankResult,
} from "./pagerank.ts";

// Louvain community detection
export {
  areInSameCommunity,
  detectCommunities,
  findCommunityMembers,
  getCommunityCount,
  getCommunityDistribution,
  getNodeCommunity,
  type LouvainOptions,
  type LouvainResult,
} from "./louvain.ts";

// Path finding (Dijkstra)
export {
  calculateAveragePathWeight,
  calculatePathWeight,
  findAllPaths,
  findShortestPath,
  getPathLength,
  hasPathWithinHops,
} from "./pathfinding.ts";

// Adamic-Adar similarity
export {
  adamicAdarBetween,
  type AdamicAdarResult,
  computeAdamicAdar,
  computeGraphRelatedness,
  findSimilarNodes,
  getNeighbors,
} from "./adamic-adar.ts";

// Edge weights (ADR-041)
export {
  calculateInitialWeight,
  determineEdgeSource,
  EDGE_SOURCE_MODIFIERS,
  EDGE_TYPE_WEIGHTS,
  type EdgeSource,
  type EdgeType,
  getEdgeWeight,
  OBSERVED_THRESHOLD,
} from "./edge-weights.ts";

// DR-DSP (Hypergraph shortest path)
export {
  buildDRDSPFromCapabilities,
  capabilityToHyperedge,
  DRDSP,
  type DynamicUpdate,
  type Hyperedge,
  type HyperpathResult,
} from "./dr-dsp.ts";

// SHGAT (SuperHyperGraph Attention Networks)
// Based on research paper with two-phase message passing
export {
  type AttentionResult,
  type CapabilityNode,
  createSHGATFromCapabilities,
  DEFAULT_HYPERGRAPH_FEATURES,
  DEFAULT_SHGAT_CONFIG,
  type HypergraphFeatures,
  SHGAT,
  type SHGATConfig,
  type ToolNode,
  type TrainingExample,
  trainSHGATOnEpisodes,
} from "./shgat.ts";

// Thompson Sampling (ADR-049 Intelligent Adaptive Thresholds)
export {
  classifyToolRisk,
  createThompsonForMode,
  createThompsonFromHistory,
  DEFAULT_THOMPSON_CONFIG,
  makeBatchDecision,
  makeDecision,
  type RiskCategory,
  type ThompsonConfig,
  ThompsonSampler,
  type ThresholdBreakdown,
  type ThresholdMode,
  type ThresholdResult,
  type ToolThompsonState,
} from "./thompson.ts";

// Unified Search (POC - unifies tool and capability search)
export {
  calculateAdaptiveAlpha,
  calculateReliabilityFactor,
  computeUnifiedScore,
  createMockGraph,
  createMockVectorSearch,
  DEFAULT_RELIABILITY_CONFIG,
  type ReliabilityConfig,
  type ScoreBreakdown,
  type SearchableNode,
  type UnifiedNodeType,
  unifiedSearch,
  type UnifiedSearchGraph,
  type UnifiedSearchOptions,
  type UnifiedSearchResult,
  type UnifiedVectorSearch,
} from "./unified-search.ts";

// Trace Feature Extractor (Story 11.8 - SHGAT v2 Multi-Head Traces)
export {
  DEFAULT_EXTRACTOR_CONFIG,
  TraceFeatureExtractor,
  type TraceFeatureExtractorConfig,
} from "./trace-feature-extractor.ts";
