/**
 * SHGAT (SuperHyperGraph Attention Networks) v2
 *
 * Implementation based on "SuperHyperGraph Attention Networks" research paper.
 * Key architecture:
 * - Two-phase message passing: Vertex→Hyperedge, Hyperedge→Vertex
 * - Incidence matrix A where A[v][e] = 1 if vertex v is in hyperedge e
 * - K-head attention (K=4-16, adaptive) learning patterns on TraceFeatures:
 *   - All heads receive the SAME rich features (not specialized)
 *   - Each head learns different patterns via W_Q, W_K, W_V matrices
 *   - Fusion MLP combines head outputs → final score
 *
 * Training:
 * - Online: trainOnExample() after each execution (via updateSHGAT in execute-handler)
 * - Batch: trainBatch() with PER sampling from execution_trace (Story 11.6)
 * - TD Learning with Prioritized Experience Replay
 *
 * v2 Changes (Story 11.7 - Tech Spec SHGAT Multi-Head Traces):
 * - REMOVED: 3 specialized heads (semantic/structure/temporal)
 * - ADDED: K generic heads learning on TraceFeatures
 * - ADDED: TraceFeatures interface with rich execution trace stats
 * - ADDED: Fusion MLP layer for combining head outputs
 * - ADDED: Adaptive head scaling based on trace volume
 *
 * @module graphrag/algorithms/shgat
 */

import { getLogger } from "../../telemetry/logger.ts";

// Re-export all types from shgat-types.ts for backward compatibility
export {
  // Trace Features (v2)
  type TraceStats,
  DEFAULT_TRACE_STATS,
  NUM_TRACE_STATS,
  type TraceFeatures,
  createDefaultTraceFeatures,
  // Legacy Types
  type FusionWeights,
  DEFAULT_FUSION_WEIGHTS,
  type FeatureWeights,
  DEFAULT_FEATURE_WEIGHTS,
  // Configuration
  type SHGATConfig,
  DEFAULT_SHGAT_CONFIG,
  getAdaptiveConfig,
  // Training Types
  type TrainingExample,
  // Graph Feature Types
  type HypergraphFeatures,
  DEFAULT_HYPERGRAPH_FEATURES,
  type ToolGraphFeatures,
  DEFAULT_TOOL_GRAPH_FEATURES,
  // Node Types
  type ToolNode,
  type CapabilityNode,
  type AttentionResult,
  type ForwardCache,
} from "./shgat-types.ts";

// Import types for internal use
import {
  type TraceStats,
  DEFAULT_TRACE_STATS,
  NUM_TRACE_STATS,
  type TraceFeatures,
  type SHGATConfig,
  DEFAULT_SHGAT_CONFIG,
  type TrainingExample,
  type HypergraphFeatures,
  DEFAULT_HYPERGRAPH_FEATURES,
  type ToolGraphFeatures,
  DEFAULT_TOOL_GRAPH_FEATURES,
  type ToolNode,
  type CapabilityNode,
  type AttentionResult,
  type ForwardCache,
  // Legacy types (still used internally)
  type FusionWeights,
  DEFAULT_FUSION_WEIGHTS,
  type FeatureWeights,
  DEFAULT_FEATURE_WEIGHTS,
} from "./shgat-types.ts";

const log = getLogger("default");

// ============================================================================
// SHGAT Implementation
// ============================================================================

/**
 * SuperHyperGraph Attention Networks
 *
 * Implements proper two-phase message passing:
 * 1. Vertex → Hyperedge: Aggregate tool features to capabilities
 * 2. Hyperedge → Vertex: Propagate capability features back to tools
 */
export class SHGAT {
  private config: SHGATConfig;

  // Vertices (tools) and Hyperedges (capabilities)
  private toolNodes: Map<string, ToolNode> = new Map();
  private capabilityNodes: Map<string, CapabilityNode> = new Map();
  private toolIndex: Map<string, number> = new Map();
  private capabilityIndex: Map<string, number> = new Map();

  // Incidence matrix: A[tool][capability] = 1 if tool is in capability
  private incidenceMatrix: number[][] = [];

  // Learnable parameters per layer per head (initialized in initializeParameters)
  private layerParams!: Array<{
    // Vertex→Edge phase
    W_v: number[][][]; // [head][hiddenDim][inputDim]
    W_e: number[][][]; // [head][hiddenDim][inputDim]
    a_ve: number[][]; // [head][2*hiddenDim]

    // Edge→Vertex phase
    W_e2: number[][][]; // [head][hiddenDim][hiddenDim]
    W_v2: number[][][]; // [head][hiddenDim][hiddenDim]
    a_ev: number[][]; // [head][2*hiddenDim]
  }>;

  // Legacy per-head parameters for backward compatibility (initialized in initializeParameters)
  private headParams!: Array<{
    W_q: number[][];
    W_k: number[][];
    W_v: number[][];
    a: number[];
  }>;

  // =========================================================================
  // v2 Parameters: Fusion MLP and Feature Projection
  // =========================================================================

  /**
   * Feature projection layer: projects combined features to hiddenDim
   * Input: [intent(1024) + candidate(1024) + context(1024) + traceStats(11)]
   * Output: hiddenDim
   */
  private W_proj!: number[][];
  private b_proj!: number[];

  /**
   * Fusion MLP: combines K head outputs into final score
   * Layer 1: numHeads → mlpHiddenDim
   * Layer 2: mlpHiddenDim → 1
   */
  private fusionMLP!: {
    W1: number[][];
    b1: number[];
    W2: number[];
    b2: number;
  };

  /**
   * Trace stats projection: projects trace stats to embedding space for attention
   * Input: 11 (number of trace stats)
   * Output: hiddenDim
   */
  private W_stats!: number[][];
  private b_stats!: number[];

  // =========================================================================
  // Legacy Parameters (kept for backward compatibility)
  // =========================================================================

  /** @deprecated v1 fusion weights - replaced by fusionMLP in v2 */
  private fusionWeights!: FusionWeights;

  /** @deprecated v1 feature weights - replaced by learned projection in v2 */
  private featureWeights!: FeatureWeights;

  // Training state
  private trainingMode = false;
  private lastCache: ForwardCache | null = null;

  // Gradient accumulators
  private fusionGradients: FusionWeights = { semantic: 0, structure: 0, temporal: 0 };
  private featureGradients: FeatureWeights = { semantic: 0, structure: 0, temporal: 0 };
  private W_intent_gradients: number[][] = [];

  // v2 gradient accumulators (used in Phase 3 training - Story 11.9)
  private v2GradAccum!: {
    W_proj: number[][];
    b_proj: number[];
    fusionMLP: {
      W1: number[][];
      b1: number[];
      W2: number[];
      b2: number;
    };
  };

  /** Intent projection matrix: projects intent (1024) to propagated embedding space */
  private W_intent!: number[][];

  constructor(config: Partial<SHGATConfig> = {}) {
    this.config = { ...DEFAULT_SHGAT_CONFIG, ...config };
    this.initializeParameters();
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  private initializeParameters(): void {
    const { numLayers, numHeads, hiddenDim, embeddingDim } = this.config;
    this.layerParams = [];

    for (let l = 0; l < numLayers; l++) {
      const layerInputDim = l === 0 ? embeddingDim : hiddenDim * numHeads;

      this.layerParams.push({
        W_v: this.initTensor3D(numHeads, hiddenDim, layerInputDim),
        W_e: this.initTensor3D(numHeads, hiddenDim, layerInputDim),
        a_ve: this.initMatrix(numHeads, 2 * hiddenDim),

        W_e2: this.initTensor3D(numHeads, hiddenDim, hiddenDim),
        W_v2: this.initTensor3D(numHeads, hiddenDim, hiddenDim),
        a_ev: this.initMatrix(numHeads, 2 * hiddenDim),
      });
    }

    // Legacy head params for backward compatibility
    this.headParams = [];
    for (let h = 0; h < numHeads; h++) {
      this.headParams.push({
        W_q: this.initMatrix(hiddenDim, embeddingDim),
        W_k: this.initMatrix(hiddenDim, embeddingDim),
        W_v: this.initMatrix(hiddenDim, embeddingDim),
        a: this.initVector(2 * hiddenDim),
      });
    }

    // Legacy: Initialize fusion weights (kept for backward compatibility)
    this.fusionWeights = { ...DEFAULT_FUSION_WEIGHTS };
    this.featureWeights = { ...DEFAULT_FEATURE_WEIGHTS };

    // Initialize intent projection matrix: maps intent (1024) → propagated space (numHeads * hiddenDim)
    const propagatedDim = numHeads * hiddenDim;
    this.W_intent = this.initMatrix(propagatedDim, embeddingDim);

    // =========================================================================
    // v2 Parameters Initialization
    // =========================================================================

    // Number of trace stats features (derived from DEFAULT_TRACE_STATS)
    const numTraceStats = NUM_TRACE_STATS;

    // Feature projection: combines [intent + candidate + context + stats] → hiddenDim
    // Input dim: 3 * embeddingDim (intent, candidate, context) + numTraceStats
    const projInputDim = 3 * embeddingDim + numTraceStats;
    this.W_proj = this.initMatrix(hiddenDim, projInputDim);
    this.b_proj = this.initVector(hiddenDim);

    // Trace stats projection: stats(11) → hiddenDim (for richer representation)
    this.W_stats = this.initMatrix(hiddenDim, numTraceStats);
    this.b_stats = this.initVector(hiddenDim);

    // Fusion MLP: combines K head outputs → final score
    // Layer 1: numHeads → mlpHiddenDim
    // Layer 2: mlpHiddenDim → 1
    const { mlpHiddenDim } = this.config;
    this.fusionMLP = {
      W1: this.initMatrix(mlpHiddenDim, numHeads),
      b1: this.initVector(mlpHiddenDim),
      W2: this.initVector(mlpHiddenDim), // Output is scalar, so W2 is a vector
      b2: 0,
    };

    // Initialize v2 gradient accumulators (used in Phase 3 training - Story 11.9)
    this.v2GradAccum = {
      W_proj: this.zerosLike2D(this.W_proj),
      b_proj: new Array(hiddenDim).fill(0),
      fusionMLP: {
        W1: this.zerosLike2D(this.fusionMLP.W1),
        b1: new Array(mlpHiddenDim).fill(0),
        W2: new Array(mlpHiddenDim).fill(0),
        b2: 0,
      },
    };
  }

  /**
   * Create zeros matrix with same shape as input
   */
  private zerosLike2D(matrix: number[][]): number[][] {
    return matrix.map((row) => row.map(() => 0));
  }

  /**
   * Reset v2 gradient accumulators (called before each batch)
   *
   * Will be used in Phase 3 training (Story 11.9).
   */
  resetV2Gradients(): void {
    const { hiddenDim, mlpHiddenDim } = this.config;
    this.v2GradAccum.W_proj = this.zerosLike2D(this.W_proj);
    this.v2GradAccum.b_proj = new Array(hiddenDim).fill(0);
    this.v2GradAccum.fusionMLP = {
      W1: this.zerosLike2D(this.fusionMLP.W1),
      b1: new Array(mlpHiddenDim).fill(0),
      W2: new Array(mlpHiddenDim).fill(0),
      b2: 0,
    };
  }

  private initTensor3D(d1: number, d2: number, d3: number): number[][][] {
    const scale = Math.sqrt(2.0 / (d2 + d3));
    return Array.from(
      { length: d1 },
      () =>
        Array.from(
          { length: d2 },
          () => Array.from({ length: d3 }, () => (Math.random() - 0.5) * 2 * scale),
        ),
    );
  }

  private initMatrix(rows: number, cols: number): number[][] {
    const scale = Math.sqrt(2.0 / (rows + cols));
    return Array.from(
      { length: rows },
      () => Array.from({ length: cols }, () => (Math.random() - 0.5) * 2 * scale),
    );
  }

  private initVector(size: number): number[] {
    const scale = Math.sqrt(1.0 / size);
    return Array.from({ length: size }, () => (Math.random() - 0.5) * 2 * scale);
  }

  /**
   * Project intent embedding to propagated embedding space
   *
   * Maps the 1024-dim intent (BGE-M3) to the numHeads*hiddenDim space
   * so it can be compared with message-passed capability embeddings.
   *
   * @param intentEmbedding - Original intent embedding (1024-dim)
   * @returns Projected intent in propagated space (numHeads*hiddenDim dim)
   */
  private projectIntent(intentEmbedding: number[]): number[] {
    // W_intent: [propagatedDim][embeddingDim]
    // result = W_intent @ intentEmbedding
    const propagatedDim = this.W_intent.length;
    const result = new Array(propagatedDim).fill(0);

    for (let i = 0; i < propagatedDim; i++) {
      for (let j = 0; j < intentEmbedding.length; j++) {
        result[i] += this.W_intent[i][j] * intentEmbedding[j];
      }
    }

    return result;
  }

  // ==========================================================================
  // v2 Multi-Head Attention Methods
  // ==========================================================================

  /**
   * Convert TraceStats to a flat vector for neural network input
   * Returns 17 features: 11 scalar stats + 6 errorTypeAffinity values
   */
  private traceStatsToVector(stats: TraceStats): number[] {
    return [
      stats.historicalSuccessRate,
      stats.contextualSuccessRate,
      stats.intentSimilarSuccessRate,
      stats.cooccurrenceWithContext,
      stats.sequencePosition,
      stats.recencyScore,
      stats.usageFrequency,
      stats.avgExecutionTime,
      stats.errorRecoveryRate,
      stats.avgPathLengthToSuccess / 10, // Normalize (assuming max ~10 steps)
      stats.pathVariance / 5, // Normalize variance
      ...stats.errorTypeAffinity, // 6 values: TIMEOUT, PERMISSION, NOT_FOUND, VALIDATION, NETWORK, UNKNOWN
    ];
  }

  /**
   * Project TraceFeatures to hidden dimension
   *
   * Combines intent, candidate, context embeddings and trace stats
   * into a single hidden-dim vector for multi-head attention.
   *
   * @param features Rich features from execution traces
   * @returns Projected features in hiddenDim space
   */
  private projectFeaturesV2(features: TraceFeatures): number[] {
    const { hiddenDim } = this.config;

    // Convert trace stats to vector
    const statsVec = this.traceStatsToVector(features.traceStats);

    // Concatenate all inputs: [intent; candidate; context_agg; stats]
    const combined = [
      ...features.intentEmbedding,
      ...features.candidateEmbedding,
      ...features.contextAggregated,
      ...statsVec,
    ];

    // Project to hidden dimension: result = ReLU(W_proj @ combined + b_proj)
    const result = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      let sum = this.b_proj[i];
      for (let j = 0; j < combined.length; j++) {
        sum += this.W_proj[i][j] * combined[j];
      }
      result[i] = Math.max(0, sum); // ReLU activation
    }

    return result;
  }

  /**
   * Compute attention score for a single head
   *
   * Uses scaled dot-product attention: score = softmax(Q·K^T / √d_k) · V
   * Simplified for scoring: returns scalar attention-weighted value
   *
   * @param projected Projected features in hiddenDim
   * @param headIdx Head index (0 to numHeads-1)
   * @returns Scalar attention score from this head
   */
  private computeHeadScoreV2(projected: number[], headIdx: number): number {
    const headParams = this.headParams[headIdx];
    const { hiddenDim } = this.config;

    // Q = W_q @ projected
    const Q = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projected.length; j++) {
        Q[i] += headParams.W_q[i][j] * projected[j];
      }
    }

    // K = W_k @ projected
    const K = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projected.length; j++) {
        K[i] += headParams.W_k[i][j] * projected[j];
      }
    }

    // V = W_v @ projected
    const V = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projected.length; j++) {
        V[i] += headParams.W_v[i][j] * projected[j];
      }
    }

    // Attention = softmax(Q·K^T / √d_k)
    // For single-query self-attention, this simplifies to a scalar
    const scale = Math.sqrt(hiddenDim);
    const attention = this.dot(Q, K) / scale;
    const attentionWeight = this.sigmoid(attention); // Use sigmoid for [0,1] range

    // Output = attention_weight * sum(V)
    const vSum = V.reduce((a, b) => a + b, 0);
    return attentionWeight * vSum / hiddenDim; // Normalize by dim
  }

  /**
   * Compute scores from all attention heads
   *
   * Each head learns different patterns on the same TraceFeatures.
   *
   * @param features Rich features from execution traces
   * @returns Array of K head scores
   */
  private computeMultiHeadScoresV2(features: TraceFeatures): number[] {
    const { numHeads } = this.config;
    const projected = this.projectFeaturesV2(features);

    const headScores: number[] = [];
    for (let h = 0; h < numHeads; h++) {
      headScores.push(this.computeHeadScoreV2(projected, h));
    }

    return headScores;
  }

  /**
   * Fusion MLP forward pass
   *
   * Combines K head scores into final prediction.
   * Architecture: Linear → ReLU → Linear → Sigmoid
   *
   * @param headScores Scores from K attention heads
   * @returns Final score in [0, 1]
   */
  private fusionMLPForward(headScores: number[]): number {
    const { mlpHiddenDim } = this.config;

    // Layer 1: Linear + ReLU
    const hidden = new Array(mlpHiddenDim).fill(0);
    for (let i = 0; i < mlpHiddenDim; i++) {
      let sum = this.fusionMLP.b1[i];
      for (let j = 0; j < headScores.length; j++) {
        sum += this.fusionMLP.W1[i][j] * headScores[j];
      }
      hidden[i] = Math.max(0, sum); // ReLU
    }

    // Layer 2: Linear + Sigmoid
    let output = this.fusionMLP.b2;
    for (let i = 0; i < mlpHiddenDim; i++) {
      output += this.fusionMLP.W2[i] * hidden[i];
    }

    return this.sigmoid(output);
  }

  /**
   * Score a candidate using v2 multi-head architecture
   *
   * Full v2 pipeline:
   * 1. Build TraceFeatures from inputs
   * 2. Project features to hidden space
   * 3. Compute K attention head scores
   * 4. Fuse via MLP to get final score
   *
   * @param features Rich features from execution traces
   * @returns Final score in [0, 1]
   */
  scoreWithTraceFeaturesV2(features: TraceFeatures): {
    score: number;
    headScores: number[];
  } {
    const headScores = this.computeMultiHeadScoresV2(features);
    const score = this.fusionMLPForward(headScores);

    return { score, headScores };
  }

  /**
   * Score all capabilities using v2 multi-head architecture
   *
   * Uses TraceFeatures for each capability instead of legacy 3-head fusion.
   * Each head learns different patterns on the same rich feature set.
   *
   * @param intentEmbedding User intent embedding (1024-dim BGE-M3)
   * @param traceFeaturesMap Map of capability ID → TraceFeatures
   * @param contextToolIds Recent tool IDs for context aggregation (optional)
   * @returns Array of capability scores sorted descending
   */
  scoreAllCapabilitiesV2(
    intentEmbedding: number[],
    traceFeaturesMap: Map<string, TraceFeatures>,
    contextToolIds: string[] = [],
  ): AttentionResult[] {
    const results: AttentionResult[] = [];
    const { numHeads } = this.config;

    // Get context embeddings for capabilities without pre-built TraceFeatures
    const contextEmbeddings: number[][] = [];
    for (const toolId of contextToolIds.slice(-this.config.maxContextLength)) {
      const tool = this.toolNodes.get(toolId);
      if (tool) {
        contextEmbeddings.push(tool.embedding);
      }
    }
    const contextAggregated = this.meanPool(contextEmbeddings, intentEmbedding.length);

    for (const [capId, cap] of this.capabilityNodes) {
      // Always use embeddings from nodes, merge traceStats from map if provided
      const providedFeatures = traceFeaturesMap.get(capId);
      const hgFeatures = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;

      // Build TraceFeatures with node embeddings + provided or default traceStats
      const features: TraceFeatures = {
        intentEmbedding,
        candidateEmbedding: cap.embedding,
        contextEmbeddings,
        contextAggregated,
        traceStats: providedFeatures?.traceStats ?? {
          historicalSuccessRate: cap.successRate,
          contextualSuccessRate: cap.successRate,
          intentSimilarSuccessRate: 0.5,
          cooccurrenceWithContext: hgFeatures.cooccurrence,
          sequencePosition: 0.5,
          recencyScore: hgFeatures.recency,
          usageFrequency: hgFeatures.hypergraphPageRank,
          avgExecutionTime: 0.5,
          errorRecoveryRate: 0.5,
          avgPathLengthToSuccess: 3,
          pathVariance: 0,
          errorTypeAffinity: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        },
      };

      // Score using v2 multi-head attention
      const { score, headScores } = this.scoreWithTraceFeaturesV2(features);

      // Apply reliability multiplier
      const reliability = cap.successRate;
      const reliabilityMult = reliability < 0.5 ? 0.5 : (reliability > 0.9 ? 1.2 : 1.0);
      const finalScore = Math.min(0.95, Math.max(0, score * reliabilityMult));

      // Compute normalized head weights (uniform in v2 - MLP learns the weighting)
      const headWeights = new Array(numHeads).fill(1 / numHeads);

      results.push({
        capabilityId: capId,
        score: finalScore,
        headWeights,
        headScores,
        recursiveContribution: 0,
        featureContributions: {
          semantic: headScores[0] ?? 0,
          structure: headScores[1] ?? 0,
          temporal: headScores[2] ?? 0,
          reliability: reliabilityMult,
        },
        toolAttention: this.getCapabilityToolAttention(this.capabilityIndex.get(capId)!),
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Score all tools using v2 multi-head architecture
   *
   * Uses TraceFeatures for each tool instead of legacy 3-head fusion.
   *
   * @param intentEmbedding User intent embedding (1024-dim BGE-M3)
   * @param traceFeaturesMap Map of tool ID → TraceFeatures
   * @param contextToolIds Recent tool IDs for context aggregation (optional)
   * @returns Array of tool scores sorted descending
   */
  scoreAllToolsV2(
    intentEmbedding: number[],
    traceFeaturesMap: Map<string, TraceFeatures>,
    contextToolIds: string[] = [],
  ): Array<{ toolId: string; score: number; headScores: number[] }> {
    const results: Array<{ toolId: string; score: number; headScores: number[] }> = [];

    // Get context embeddings
    const contextEmbeddings: number[][] = [];
    for (const toolId of contextToolIds.slice(-this.config.maxContextLength)) {
      const tool = this.toolNodes.get(toolId);
      if (tool) {
        contextEmbeddings.push(tool.embedding);
      }
    }
    const contextAggregated = this.meanPool(contextEmbeddings, intentEmbedding.length);

    for (const [toolId, tool] of this.toolNodes) {
      // Always use embeddings from nodes, merge traceStats from map if provided
      const providedFeatures = traceFeaturesMap.get(toolId);
      const toolFeatures = tool.toolFeatures || DEFAULT_TOOL_GRAPH_FEATURES;

      // Build TraceFeatures with node embeddings + provided or default traceStats
      const features: TraceFeatures = {
        intentEmbedding,
        candidateEmbedding: tool.embedding,
        contextEmbeddings,
        contextAggregated,
        traceStats: providedFeatures?.traceStats ?? {
          historicalSuccessRate: 0.5,
          contextualSuccessRate: 0.5,
          intentSimilarSuccessRate: 0.5,
          cooccurrenceWithContext: toolFeatures.cooccurrence,
          sequencePosition: 0.5,
          recencyScore: toolFeatures.recency,
          usageFrequency: toolFeatures.pageRank,
          avgExecutionTime: 0.5,
          errorRecoveryRate: 0.5,
          avgPathLengthToSuccess: 3,
          pathVariance: 0,
          errorTypeAffinity: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        },
      };

      // Score using v2 multi-head attention
      const { score, headScores } = this.scoreWithTraceFeaturesV2(features);
      const finalScore = Math.min(0.95, Math.max(0, score));

      results.push({
        toolId,
        score: finalScore,
        headScores,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Score all capabilities using v3 hybrid architecture (EXPERIMENTAL)
   *
   * Combines the best of v1 and v2:
   * - v1: Message passing (V→E→V) for propagated embeddings (faithful to SHGAT paper)
   * - v2: Rich TraceFeatures (17 features) + Multi-head attention + Fusion MLP
   *
   * This is the theoretically optimal approach: use graph structure propagation
   * AND historical execution patterns.
   *
   * @param intentEmbedding User intent embedding (1024-dim BGE-M3)
   * @param traceFeaturesMap Map of capability ID → TraceFeatures
   * @param contextToolIds Recent tool IDs for context aggregation (optional)
   * @returns Array of capability scores sorted descending
   */
  scoreAllCapabilitiesV3(
    intentEmbedding: number[],
    traceFeaturesMap: Map<string, TraceFeatures>,
    contextToolIds: string[] = [],
  ): AttentionResult[] {
    const results: AttentionResult[] = [];
    const { numHeads } = this.config;

    // ========================================================================
    // v1 Component: Message passing to get propagated embeddings
    // ========================================================================
    const { E } = this.forward();

    // Get context embeddings for capabilities without pre-built TraceFeatures
    const contextEmbeddings: number[][] = [];
    for (const toolId of contextToolIds.slice(-this.config.maxContextLength)) {
      const tool = this.toolNodes.get(toolId);
      if (tool) {
        contextEmbeddings.push(tool.embedding);
      }
    }
    const contextAggregated = this.meanPool(contextEmbeddings, intentEmbedding.length);

    for (const [capId, cap] of this.capabilityNodes) {
      const cIdx = this.capabilityIndex.get(capId)!;

      // Get trace features if provided
      const providedFeatures = traceFeaturesMap.get(capId);
      const hgFeatures = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;

      // ========================================================================
      // v3 Hybrid: Use PROPAGATED embedding from message passing + TraceStats
      // ========================================================================
      const features: TraceFeatures = {
        intentEmbedding,
        candidateEmbedding: E[cIdx], // ← KEY DIFFERENCE: Propagated, not raw!
        contextEmbeddings,
        contextAggregated,
        traceStats: providedFeatures?.traceStats ?? {
          historicalSuccessRate: cap.successRate,
          contextualSuccessRate: cap.successRate,
          intentSimilarSuccessRate: 0.5,
          cooccurrenceWithContext: hgFeatures.cooccurrence,
          sequencePosition: 0.5,
          recencyScore: hgFeatures.recency,
          usageFrequency: hgFeatures.hypergraphPageRank,
          avgExecutionTime: 0.5,
          errorRecoveryRate: 0.5,
          avgPathLengthToSuccess: 3,
          pathVariance: 0,
          errorTypeAffinity: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        },
      };

      // ========================================================================
      // v2 Component: Multi-head attention + Fusion MLP
      // ========================================================================
      const { score, headScores } = this.scoreWithTraceFeaturesV2(features);

      // Apply reliability multiplier
      const reliability = cap.successRate;
      const reliabilityMult = reliability < 0.5 ? 0.5 : (reliability > 0.9 ? 1.2 : 1.0);
      const finalScore = Math.min(0.95, Math.max(0, score * reliabilityMult));

      // Compute normalized head weights (uniform in v2 - MLP learns the weighting)
      const headWeights = new Array(numHeads).fill(1 / numHeads);

      results.push({
        capabilityId: capId,
        score: finalScore,
        headWeights,
        headScores,
        recursiveContribution: 0,
        featureContributions: {
          semantic: headScores[0] ?? 0,
          structure: headScores[1] ?? 0,
          temporal: headScores[2] ?? 0,
          reliability: reliabilityMult,
        },
        toolAttention: this.getCapabilityToolAttention(cIdx),
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Mean pooling for context embeddings
   */
  private meanPool(embeddings: number[][], dim: number): number[] {
    if (embeddings.length === 0) {
      return new Array(dim).fill(0);
    }

    const result = new Array(dim).fill(0);
    for (const emb of embeddings) {
      for (let i = 0; i < Math.min(dim, emb.length); i++) {
        result[i] += emb[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      result[i] /= embeddings.length;
    }

    return result;
  }

  // ==========================================================================
  // Graph Construction
  // ==========================================================================

  /**
   * Register a tool (vertex)
   */
  registerTool(node: ToolNode): void {
    this.toolNodes.set(node.id, node);
    this.rebuildIndices();
  }

  /**
   * Register a capability (hyperedge)
   */
  registerCapability(node: CapabilityNode): void {
    this.capabilityNodes.set(node.id, node);
    this.rebuildIndices();
  }

  /**
   * Check if a tool node exists
   */
  hasToolNode(toolId: string): boolean {
    return this.toolNodes.has(toolId);
  }

  /**
   * Check if a capability node exists
   */
  hasCapabilityNode(capabilityId: string): boolean {
    return this.capabilityNodes.has(capabilityId);
  }

  /**
   * Get the number of registered tools (Story 11.3 - cold start detection)
   */
  getToolCount(): number {
    return this.toolNodes.size;
  }

  /**
   * Get the number of registered capabilities (Story 11.3 - cold start detection)
   */
  getCapabilityCount(): number {
    return this.capabilityNodes.size;
  }

  /**
   * Get all registered tool IDs (Story 11.10 - batch trace extraction)
   */
  getToolIds(): string[] {
    return Array.from(this.toolNodes.keys());
  }

  /**
   * Get all registered capability IDs (Story 11.10 - batch trace extraction)
   */
  getCapabilityIds(): string[] {
    return Array.from(this.capabilityNodes.keys());
  }

  /**
   * Build hypergraph from tools and capabilities
   */
  buildFromData(
    tools: Array<{ id: string; embedding: number[] }>,
    capabilities: Array<{
      id: string;
      embedding: number[];
      toolsUsed: string[];
      successRate: number;
      parents?: string[];
      children?: string[];
    }>,
  ): void {
    this.toolNodes.clear();
    this.capabilityNodes.clear();

    for (const tool of tools) {
      this.toolNodes.set(tool.id, {
        id: tool.id,
        embedding: tool.embedding,
      });
    }

    for (const cap of capabilities) {
      this.capabilityNodes.set(cap.id, {
        id: cap.id,
        embedding: cap.embedding,
        toolsUsed: cap.toolsUsed,
        successRate: cap.successRate,
        parents: cap.parents || [],
        children: cap.children || [],
      });
    }

    this.rebuildIndices();
  }

  /**
   * Recursively collect all tools from a capability and its children (transitive closure)
   *
   * This enables hierarchical capabilities (meta-meta-capabilities → meta-capabilities → capabilities)
   * to inherit all tools from their descendants in the incidence matrix.
   *
   * Example:
   *   release-cycle (meta-meta) contains [deploy-full, rollback-plan]
   *   deploy-full (meta) contains [build, test]
   *   build (capability) has tools [compiler, linker]
   *   test (capability) has tools [pytest]
   *
   *   collectTransitiveTools("release-cycle") returns [compiler, linker, pytest, ...]
   *
   * @param capId - The capability ID to collect tools from
   * @param visited - Set of already visited capability IDs (cycle detection)
   * @returns Set of all tool IDs transitively reachable from this capability
   */
  private collectTransitiveTools(capId: string, visited: Set<string> = new Set()): Set<string> {
    // Cycle detection - prevent infinite recursion
    if (visited.has(capId)) {
      return new Set();
    }
    visited.add(capId);

    const cap = this.capabilityNodes.get(capId);
    if (!cap) {
      return new Set();
    }

    // Start with direct tools
    const tools = new Set<string>(cap.toolsUsed);

    // Recursively collect from children (contained capabilities)
    for (const childId of cap.children) {
      const childTools = this.collectTransitiveTools(childId, visited);
      for (const tool of childTools) {
        tools.add(tool);
      }
    }

    return tools;
  }

  /**
   * Rebuild indices and incidence matrix
   */
  private rebuildIndices(): void {
    this.toolIndex.clear();
    this.capabilityIndex.clear();

    let tIdx = 0;
    for (const tId of this.toolNodes.keys()) {
      this.toolIndex.set(tId, tIdx++);
    }

    let cIdx = 0;
    for (const cId of this.capabilityNodes.keys()) {
      this.capabilityIndex.set(cId, cIdx++);
    }

    // Build incidence matrix A[tool][capability] with transitive closure
    // Meta-capabilities inherit all tools from their child capabilities
    // This enables infinite hierarchical nesting (meta-meta-meta... → meta → capability)
    const numTools = this.toolNodes.size;
    const numCaps = this.capabilityNodes.size;

    this.incidenceMatrix = Array.from({ length: numTools }, () => Array(numCaps).fill(0));

    for (const [capId] of this.capabilityNodes) {
      const cIdx = this.capabilityIndex.get(capId)!;
      // Use transitive collection to get all tools from this capability
      // and all its descendants (children, grandchildren, etc.)
      const transitiveTools = this.collectTransitiveTools(capId);
      for (const toolId of transitiveTools) {
        const tIdx = this.toolIndex.get(toolId);
        if (tIdx !== undefined) {
          this.incidenceMatrix[tIdx][cIdx] = 1;
        }
      }
    }
  }

  // ==========================================================================
  // Two-Phase Message Passing
  // ==========================================================================

  /**
   * Forward pass through all layers with two-phase message passing
   *
   * Phase 1 (Vertex→Hyperedge):
   *   A' = A ⊙ softmax(LeakyReLU(H·W · (E·W)^T))
   *   E^(l+1) = σ(A'^T · H^(l))
   *
   * Phase 2 (Hyperedge→Vertex):
   *   B = A^T ⊙ softmax(LeakyReLU(E·W_1 · (H·W_1)^T))
   *   H^(l+1) = σ(B^T · E^(l))
   */
  forward(): { H: number[][]; E: number[][]; cache: ForwardCache } {
    const cache: ForwardCache = {
      H: [],
      E: [],
      attentionVE: [],
      attentionEV: [],
    };

    // Initialize embeddings
    let H = this.getToolEmbeddings();
    let E = this.getCapabilityEmbeddings();

    cache.H.push(H);
    cache.E.push(E);

    // Process each layer
    for (let l = 0; l < this.config.numLayers; l++) {
      const params = this.layerParams[l];
      const layerAttentionVE: number[][][] = [];
      const layerAttentionEV: number[][][] = [];

      const headsH: number[][][] = [];
      const headsE: number[][][] = [];

      for (let head = 0; head < this.config.numHeads; head++) {
        // Phase 1: Vertex → Hyperedge
        const { E_new, attentionVE } = this.vertexToEdgePhase(
          H,
          E,
          params.W_v[head],
          params.W_e[head],
          params.a_ve[head],
          head,
        );
        layerAttentionVE.push(attentionVE);

        // Phase 2: Hyperedge → Vertex
        const { H_new, attentionEV } = this.edgeToVertexPhase(
          H,
          E_new,
          params.W_e2[head],
          params.W_v2[head],
          params.a_ev[head],
          head,
        );
        layerAttentionEV.push(attentionEV);

        headsH.push(H_new);
        headsE.push(E_new);
      }

      // Concatenate heads
      H = this.concatHeads(headsH);
      E = this.concatHeads(headsE);

      // Apply dropout during training
      if (this.trainingMode && this.config.dropout > 0) {
        H = this.applyDropout(H);
        E = this.applyDropout(E);
      }

      cache.H.push(H);
      cache.E.push(E);
      cache.attentionVE.push(layerAttentionVE);
      cache.attentionEV.push(layerAttentionEV);
    }

    this.lastCache = cache;
    return { H, E, cache };
  }

  /**
   * Phase 1: Vertex → Hyperedge message passing
   */
  private vertexToEdgePhase(
    H: number[][],
    E: number[][],
    W_v: number[][],
    W_e: number[][],
    a_ve: number[],
    headIdx: number,
  ): { E_new: number[][]; attentionVE: number[][] } {
    const numTools = H.length;
    const numCaps = E.length;

    // Project
    const H_proj = this.matmulTranspose(H, W_v);
    const E_proj = this.matmulTranspose(E, W_e);

    // Compute attention scores (masked by incidence matrix)
    const attentionScores: number[][] = Array.from(
      { length: numTools },
      () => Array(numCaps).fill(-Infinity),
    );

    for (let t = 0; t < numTools; t++) {
      for (let c = 0; c < numCaps; c++) {
        if (this.incidenceMatrix[t][c] === 1) {
          const concat = [...H_proj[t], ...E_proj[c]];
          const activated = concat.map((x) => this.leakyRelu(x));
          attentionScores[t][c] = this.dot(a_ve, activated);
        }
      }
    }

    // Apply head-specific feature modulation
    this.applyHeadFeatures(attentionScores, headIdx, "vertex");

    // Softmax per capability (column-wise)
    const attentionVE: number[][] = Array.from({ length: numTools }, () => Array(numCaps).fill(0));

    for (let c = 0; c < numCaps; c++) {
      const toolsInCap: number[] = [];
      for (let t = 0; t < numTools; t++) {
        if (this.incidenceMatrix[t][c] === 1) {
          toolsInCap.push(t);
        }
      }

      if (toolsInCap.length === 0) continue;

      const scores = toolsInCap.map((t) => attentionScores[t][c]);
      const softmaxed = this.softmax(scores);

      for (let i = 0; i < toolsInCap.length; i++) {
        attentionVE[toolsInCap[i]][c] = softmaxed[i];
      }
    }

    // Aggregate: E_new = σ(A'^T · H_proj)
    const E_new: number[][] = [];
    const hiddenDim = H_proj[0].length;

    for (let c = 0; c < numCaps; c++) {
      const aggregated = Array(hiddenDim).fill(0);

      for (let t = 0; t < numTools; t++) {
        if (attentionVE[t][c] > 0) {
          for (let d = 0; d < hiddenDim; d++) {
            aggregated[d] += attentionVE[t][c] * H_proj[t][d];
          }
        }
      }

      E_new.push(aggregated.map((x) => this.elu(x)));
    }

    return { E_new, attentionVE };
  }

  /**
   * Phase 2: Hyperedge → Vertex message passing
   */
  private edgeToVertexPhase(
    H: number[][],
    E: number[][],
    W_e: number[][],
    W_v: number[][],
    a_ev: number[],
    headIdx: number,
  ): { H_new: number[][]; attentionEV: number[][] } {
    const numTools = H.length;
    const numCaps = E.length;

    const E_proj = this.matmulTranspose(E, W_e);
    const H_proj = this.matmulTranspose(H, W_v);

    // Compute attention scores
    const attentionScores: number[][] = Array.from(
      { length: numCaps },
      () => Array(numTools).fill(-Infinity),
    );

    for (let c = 0; c < numCaps; c++) {
      for (let t = 0; t < numTools; t++) {
        if (this.incidenceMatrix[t][c] === 1) {
          const concat = [...E_proj[c], ...H_proj[t]];
          const activated = concat.map((x) => this.leakyRelu(x));
          attentionScores[c][t] = this.dot(a_ev, activated);
        }
      }
    }

    // Apply head-specific feature modulation
    this.applyHeadFeatures(attentionScores, headIdx, "edge");

    // Softmax per tool (column-wise in transposed view)
    const attentionEV: number[][] = Array.from({ length: numCaps }, () => Array(numTools).fill(0));

    for (let t = 0; t < numTools; t++) {
      const capsForTool: number[] = [];
      for (let c = 0; c < numCaps; c++) {
        if (this.incidenceMatrix[t][c] === 1) {
          capsForTool.push(c);
        }
      }

      if (capsForTool.length === 0) continue;

      const scores = capsForTool.map((c) => attentionScores[c][t]);
      const softmaxed = this.softmax(scores);

      for (let i = 0; i < capsForTool.length; i++) {
        attentionEV[capsForTool[i]][t] = softmaxed[i];
      }
    }

    // Aggregate: H_new = σ(B^T · E_proj)
    const H_new: number[][] = [];
    const hiddenDim = E_proj[0].length;

    for (let t = 0; t < numTools; t++) {
      const aggregated = Array(hiddenDim).fill(0);

      for (let c = 0; c < numCaps; c++) {
        if (attentionEV[c][t] > 0) {
          for (let d = 0; d < hiddenDim; d++) {
            aggregated[d] += attentionEV[c][t] * E_proj[c][d];
          }
        }
      }

      H_new.push(aggregated.map((x) => this.elu(x)));
    }

    return { H_new, attentionEV };
  }

  /**
   * Apply head-specific feature modulation based on HypergraphFeatures
   *
   * @deprecated v2 uses learned multi-head attention instead of manual feature modulation.
   * This method is only used by the legacy forward() message passing, not by v2 scoring.
   * In v2, all features (including structure/temporal) are fed to ALL heads via TraceFeatures,
   * and each head learns its own patterns through W_Q, W_K, W_V matrices.
   */
  private applyHeadFeatures(
    scores: number[][],
    headIdx: number,
    phase: "vertex" | "edge",
  ): void {
    if (headIdx === 2) {
      // Head 2: Structure (spectral cluster, pagerank)
      for (const [capId, cap] of this.capabilityNodes) {
        const cIdx = this.capabilityIndex.get(capId)!;
        const features = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;
        const boost = features.hypergraphPageRank * 2; // PageRank boost

        if (phase === "vertex") {
          for (let t = 0; t < scores.length; t++) {
            if (scores[t][cIdx] > -Infinity) {
              scores[t][cIdx] += boost;
            }
          }
        } else {
          for (let t = 0; t < scores[cIdx].length; t++) {
            if (scores[cIdx][t] > -Infinity) {
              scores[cIdx][t] += boost;
            }
          }
        }
      }
    } else if (headIdx === 3) {
      // Head 3: Temporal (co-occurrence, recency)
      for (const [capId, cap] of this.capabilityNodes) {
        const cIdx = this.capabilityIndex.get(capId)!;
        const features = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;
        const boost = 0.6 * features.cooccurrence + 0.4 * features.recency;

        if (phase === "vertex") {
          for (let t = 0; t < scores.length; t++) {
            if (scores[t][cIdx] > -Infinity) {
              scores[t][cIdx] += boost;
            }
          }
        } else {
          for (let t = 0; t < scores[cIdx].length; t++) {
            if (scores[cIdx][t] > -Infinity) {
              scores[cIdx][t] += boost;
            }
          }
        }
      }
    }
    // Heads 0-1: Semantic (no modification, pure embedding attention)
  }

  // ==========================================================================
  // Scoring API
  // ==========================================================================

  /**
   * Score all capabilities given intent embedding
   *
   * SHGAT scoring is context-free per the original paper.
   * Context (current position) is handled by DR-DSP pathfinding, not here.
   *
   * 3-Head Architecture (simplified from 6):
   * - Head 0: Semantic (intent similarity with propagated embeddings)
   * - Head 1: Structure (PageRank + AdamicAdar)
   * - Head 2: Temporal (recency + heatDiffusion)
   *
   * All weights are learnable:
   * - fusionWeights: how to combine heads (via softmax)
   * - featureWeights: scale factor for each head's features
   */
  scoreAllCapabilities(
    intentEmbedding: number[],
    _contextToolEmbeddings?: number[][], // DEPRECATED - kept for API compat, ignored
    _contextCapabilityIds?: string[], // DEPRECATED - kept for API compat, ignored
  ): AttentionResult[] {
    // Run forward pass to get propagated embeddings via V→E→V message passing
    const { E } = this.forward();

    const results: AttentionResult[] = [];

    // Compute normalized fusion weights from learnable params
    const groupWeights = this.computeFusionWeights();

    // Project intent to propagated space for semantic comparison
    const intentProjected = this.projectIntent(intentEmbedding);

    // Active heads for ablation (default: all 3)
    const activeHeads = this.config.activeHeads ?? [0, 1, 2];

    for (const [capId, cap] of this.capabilityNodes) {
      const cIdx = this.capabilityIndex.get(capId)!;

      // Use PROPAGATED embedding from message passing for semantic similarity
      const capPropagatedEmb = E[cIdx];
      const intentSim = this.cosineSimilarity(intentProjected, capPropagatedEmb);

      // Reliability multiplier
      const reliability = cap.successRate;
      const reliabilityMult = reliability < 0.5 ? 0.5 : (reliability > 0.9 ? 1.2 : 1.0);

      // Get hypergraph features
      const features = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;

      // === 3-HEAD ARCHITECTURE (all weights learnable) ===
      // Head 0: Semantic - intent similarity scaled by learned weight
      const semanticScore = intentSim * this.featureWeights.semantic;

      // Head 1: Structure - graph topology features scaled by learned weight
      const structureScore = (features.hypergraphPageRank + (features.adamicAdar ?? 0)) *
        this.featureWeights.structure;

      // Head 2: Temporal - usage patterns scaled by learned weight
      const temporalScore = (features.recency + (features.heatDiffusion ?? 0)) *
        this.featureWeights.temporal;

      // Store all head scores
      const allHeadScores = [semanticScore, structureScore, temporalScore];

      // === ABLATION-AWARE FUSION ===
      // Only include active heads
      const activeWeights = [
        activeHeads.includes(0) ? groupWeights.semantic : 0,
        activeHeads.includes(1) ? groupWeights.structure : 0,
        activeHeads.includes(2) ? groupWeights.temporal : 0,
      ];
      const totalActiveWeight = activeWeights.reduce((a, b) => a + b, 0) || 1;

      // Weighted combination of active heads
      const baseScore = (
        activeWeights[0] * semanticScore +
        activeWeights[1] * structureScore +
        activeWeights[2] * temporalScore
      ) / totalActiveWeight;

      // Final score with reliability
      const rawScore = baseScore * reliabilityMult;
      const score = Number.isFinite(rawScore) ? this.sigmoid(rawScore) : 0.5;

      // Compute normalized head weights for interpretability
      const headWeights = [
        activeWeights[0] / totalActiveWeight,
        activeWeights[1] / totalActiveWeight,
        activeWeights[2] / totalActiveWeight,
      ];

      // Get tool attention for interpretability
      const toolAttention = this.getCapabilityToolAttention(cIdx);

      results.push({
        capabilityId: capId,
        score,
        headWeights,
        headScores: allHeadScores,
        recursiveContribution: 0,
        featureContributions: {
          semantic: semanticScore,
          structure: structureScore,
          temporal: temporalScore,
          reliability: reliabilityMult,
        },
        toolAttention,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Compute normalized fusion weights
   * If headFusionWeights is provided in config, use those (for ablation)
   * Otherwise, use softmax of learnable parameters
   */
  private computeFusionWeights(): { semantic: number; structure: number; temporal: number } {
    // If fixed weights are provided in config, use them directly
    if (this.config.headFusionWeights) {
      const [s, st, t] = this.config.headFusionWeights;
      return { semantic: s, structure: st, temporal: t };
    }
    // Otherwise, use learnable weights with softmax normalization
    const raw = [this.fusionWeights.semantic, this.fusionWeights.structure, this.fusionWeights.temporal];
    const softmaxed = this.softmax(raw);
    return {
      semantic: softmaxed[0],
      structure: softmaxed[1],
      temporal: softmaxed[2],
    };
  }

  /**
   * Score all tools given intent embedding
   *
   * 3-Head architecture for tools:
   * - Head 0 (Semantic): Intent similarity with propagated embeddings
   * - Head 1 (Structure): PageRank + AdamicAdar
   * - Head 2 (Temporal): Recency + HeatDiffusion
   *
   * @param intentEmbedding - The intent embedding (1024-dim BGE-M3)
   * @returns Array of tool scores sorted by score descending
   */
  scoreAllTools(
    intentEmbedding: number[],
  ): Array<{ toolId: string; score: number; headWeights?: number[] }> {
    // Run forward pass to get propagated embeddings via V→E→V message passing
    const { H } = this.forward();

    const results: Array<{ toolId: string; score: number; headWeights?: number[] }> = [];

    // Compute normalized fusion weights from learnable params
    const groupWeights = this.computeFusionWeights();

    // Project intent to propagated space for semantic comparison
    const intentProjected = this.projectIntent(intentEmbedding);

    // Active heads for ablation (default: all 3)
    const activeHeads = this.config.activeHeads ?? [0, 1, 2];

    for (const [toolId, tool] of this.toolNodes) {
      const tIdx = this.toolIndex.get(toolId)!;

      // Use PROPAGATED embedding from message passing
      const toolPropagatedEmb = H[tIdx];
      const intentSim = this.cosineSimilarity(intentProjected, toolPropagatedEmb);

      // Get tool features (may be undefined for tools without features)
      const features = tool.toolFeatures;

      if (!features) {
        // Fallback: pure semantic similarity if no features
        results.push({
          toolId,
          score: Math.max(0, Math.min(intentSim, 0.95)),
        });
        continue;
      }

      // === 3-HEAD ARCHITECTURE (all weights learnable) ===
      // Head 0: Semantic - intent similarity scaled by learned weight
      const semanticScore = intentSim * this.featureWeights.semantic;

      // Head 1: Structure - graph topology features scaled by learned weight
      const structureScore = (features.pageRank + features.adamicAdar) *
        this.featureWeights.structure;

      // Head 2: Temporal - usage patterns scaled by learned weight
      const temporalScore = (features.recency + features.heatDiffusion) *
        this.featureWeights.temporal;

      // === ABLATION-AWARE FUSION ===
      const activeWeights = [
        activeHeads.includes(0) ? groupWeights.semantic : 0,
        activeHeads.includes(1) ? groupWeights.structure : 0,
        activeHeads.includes(2) ? groupWeights.temporal : 0,
      ];
      const totalActiveWeight = activeWeights.reduce((a, b) => a + b, 0) || 1;

      // Weighted combination of active heads
      const baseScore = (
        activeWeights[0] * semanticScore +
        activeWeights[1] * structureScore +
        activeWeights[2] * temporalScore
      ) / totalActiveWeight;

      // Final score
      const score = Number.isFinite(baseScore) ? this.sigmoid(baseScore) : 0.5;

      // Compute normalized head weights for interpretability
      const headWeights = [
        activeWeights[0] / totalActiveWeight,
        activeWeights[1] / totalActiveWeight,
        activeWeights[2] / totalActiveWeight,
      ];

      results.push({
        toolId,
        score: Math.max(0, Math.min(score, 0.95)), // Clamp to [0, 0.95]
        headWeights,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Predict the success probability of an executed path (Story 11.3 - TD Learning)
   *
   * Uses the same multi-head architecture as scoreAllTools/scoreAllCapabilities
   * to predict whether a path of tools/capabilities will succeed.
   *
   * Used for TD Error calculation: tdError = actual - predicted
   * Where priority = |tdError| for PER sampling.
   *
   * @param intentEmbedding - The intent embedding (1024-dim BGE-M3)
   * @param path - Array of tool/capability IDs that were executed
   * @returns Probability of success [0, 1]
   */
  predictPathSuccess(intentEmbedding: number[], path: string[]): number {
    // Cold start: no nodes registered yet
    if (this.capabilityNodes.size === 0 && this.toolNodes.size === 0) {
      return 0.5;
    }

    // Empty path: neutral prediction
    if (!path || path.length === 0) {
      return 0.5;
    }

    // Collect scores for each node in the path
    const nodeScores: number[] = [];

    // Cache the full scoring results (avoid recomputing for each node)
    const toolScoresMap = new Map<string, number>();
    const capScoresMap = new Map<string, number>();

    // Only compute if we have nodes of that type in the path
    const hasTools = path.some((id) => this.toolNodes.has(id));
    const hasCaps = path.some((id) => this.capabilityNodes.has(id));

    if (hasTools) {
      const toolResults = this.scoreAllTools(intentEmbedding);
      for (const r of toolResults) {
        toolScoresMap.set(r.toolId, r.score);
      }
    }

    if (hasCaps) {
      const capResults = this.scoreAllCapabilities(intentEmbedding);
      for (const r of capResults) {
        capScoresMap.set(r.capabilityId, r.score);
      }
    }

    // Get score for each node in path
    for (const nodeId of path) {
      if (toolScoresMap.has(nodeId)) {
        nodeScores.push(toolScoresMap.get(nodeId)!);
      } else if (capScoresMap.has(nodeId)) {
        nodeScores.push(capScoresMap.get(nodeId)!);
      } else {
        // Unknown node: neutral score
        nodeScores.push(0.5);
      }
    }

    // Weighted average: later nodes in path are more critical for success
    // Weight increases linearly: 1.0, 1.5, 2.0, 2.5, ...
    let weightedSum = 0;
    let weightTotal = 0;

    for (let i = 0; i < nodeScores.length; i++) {
      const weight = 1 + i * 0.5;
      weightedSum += nodeScores[i] * weight;
      weightTotal += weight;
    }

    const pathScore = weightedSum / weightTotal;

    log.debug("[SHGAT] predictPathSuccess", {
      pathLength: path.length,
      nodeScores,
      pathScore,
    });

    return pathScore;
  }

  /**
   * Compute attention for a single capability
   */
  computeAttention(
    intentEmbedding: number[],
    _contextToolEmbeddings: number[][], // DEPRECATED - ignored
    capabilityId: string,
    _contextCapabilityIds?: string[], // DEPRECATED - ignored
  ): AttentionResult {
    const results = this.scoreAllCapabilities(intentEmbedding);

    return results.find((r) => r.capabilityId === capabilityId) || {
      capabilityId,
      score: 0,
      headWeights: new Array(this.config.numHeads).fill(0),
      headScores: new Array(this.config.numHeads).fill(0),
      recursiveContribution: 0,
    };
  }

  /**
   * Get tool attention weights for a capability
   */
  private getCapabilityToolAttention(capIdx: number): number[] {
    if (!this.lastCache || this.lastCache.attentionVE.length === 0) {
      return [];
    }

    const lastLayerVE = this.lastCache.attentionVE[this.config.numLayers - 1];
    const attention: number[] = [];

    for (let t = 0; t < this.toolNodes.size; t++) {
      let avgAttention = 0;
      for (let h = 0; h < this.config.numHeads; h++) {
        avgAttention += lastLayerVE[h][t][capIdx];
      }
      attention.push(avgAttention / this.config.numHeads);
    }

    return attention;
  }

  // ==========================================================================
  // Feature Updates
  // ==========================================================================

  /**
   * Update hypergraph features for a capability
   */
  updateHypergraphFeatures(capabilityId: string, features: Partial<HypergraphFeatures>): void {
    const node = this.capabilityNodes.get(capabilityId);
    if (node) {
      node.hypergraphFeatures = {
        ...(node.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES),
        ...features,
      };
    }
  }

  /**
   * Update hypergraph features for a tool (multi-head attention)
   */
  updateToolFeatures(toolId: string, features: Partial<ToolGraphFeatures>): void {
    const node = this.toolNodes.get(toolId);
    if (node) {
      node.toolFeatures = {
        ...(node.toolFeatures || DEFAULT_TOOL_GRAPH_FEATURES),
        ...features,
      };
    }
  }

  /**
   * Batch update hypergraph features for capabilities
   */
  batchUpdateFeatures(updates: Map<string, Partial<HypergraphFeatures>>): void {
    for (const [capId, features] of updates) {
      this.updateHypergraphFeatures(capId, features);
    }

    log.debug("[SHGAT] Updated hypergraph features", {
      updatedCount: updates.size,
    });
  }

  /**
   * Batch update hypergraph features for tools (multi-head attention)
   */
  batchUpdateToolFeatures(updates: Map<string, Partial<ToolGraphFeatures>>): void {
    for (const [toolId, features] of updates) {
      this.updateToolFeatures(toolId, features);
    }

    log.debug("[SHGAT] Updated tool features for multi-head attention", {
      updatedCount: updates.size,
    });
  }

  // ==========================================================================
  // Training with Backpropagation
  // ==========================================================================

  /**
   * Train on a single example (online learning)
   *
   * Used for incremental learning after each execution trace.
   * Less efficient than batch training but enables real-time learning.
   */
  trainOnExample(example: TrainingExample): { loss: number; accuracy: number; tdErrors: number[] } {
    return this.trainBatch([example]);
  }

  /**
   * Train on a batch of examples
   *
   * Uses 3-head architecture and learns both fusion weights and feature weights.
   *
   * @param examples - Training examples
   * @param isWeights - Importance Sampling weights from PER (optional, defaults to uniform)
   * @param gamma - Discount factor for TD learning (optional, defaults to 0.99)
   */
  trainBatch(
    examples: TrainingExample[],
    isWeights?: number[],
    gamma: number = 0.99,
  ): { loss: number; accuracy: number; tdErrors: number[] } {
    // Default IS weights to uniform if not provided
    const weights = isWeights ?? new Array(examples.length).fill(1);
    const tdErrors: number[] = [];
    this.trainingMode = true;

    let totalLoss = 0;
    let correct = 0;

    const gradients = this.initGradients();

    // Reset gradients for this batch
    this.fusionGradients = { semantic: 0, structure: 0, temporal: 0 };
    this.featureGradients = { semantic: 0, structure: 0, temporal: 0 };

    // Reset W_intent gradients for this batch
    const propagatedDim = this.config.numHeads * this.config.hiddenDim;
    this.W_intent_gradients = Array.from({ length: propagatedDim }, () =>
      Array(this.config.embeddingDim).fill(0)
    );

    for (let i = 0; i < examples.length; i++) {
      const example = examples[i];
      const isWeight = weights[i];

      // Forward pass to get propagated embeddings via V→E→V message passing
      const { E, cache } = this.forward();

      const capIdx = this.capabilityIndex.get(example.candidateId);
      if (capIdx === undefined) {
        tdErrors.push(0);
        continue;
      }

      // Get capability node and propagated embedding
      const capNode = this.capabilityNodes.get(example.candidateId)!;
      const capPropagatedEmb = E[capIdx];
      const features = capNode.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;

      // Project intent to propagated space for semantic comparison
      const intentProjected = this.projectIntent(example.intentEmbedding);

      // === 3-HEAD ARCHITECTURE (all weights learnable) ===
      const intentSim = this.cosineSimilarity(intentProjected, capPropagatedEmb);

      // Raw feature values (before scaling by featureWeights)
      const rawSemantic = intentSim;
      const rawStructure = features.hypergraphPageRank + (features.adamicAdar ?? 0);
      const rawTemporal = features.recency + (features.heatDiffusion ?? 0);

      // Scaled head scores
      const semanticScore = rawSemantic * this.featureWeights.semantic;
      const structureScore = rawStructure * this.featureWeights.structure;
      const temporalScore = rawTemporal * this.featureWeights.temporal;

      // Compute fusion weights
      const groupWeights = this.computeFusionWeights();

      // Reliability
      const reliability = capNode.successRate;
      const reliabilityMult = reliability < 0.5 ? 0.5 : (reliability > 0.9 ? 1.2 : 1.0);

      // Final score
      const baseScore = groupWeights.semantic * semanticScore +
        groupWeights.structure * structureScore +
        groupWeights.temporal * temporalScore;

      const score = this.sigmoid(baseScore * reliabilityMult);

      // TD Error computation (Phase 3): target = outcome * gamma^pathLength
      const pathLength = example.contextTools?.length ?? 0;
      const discountedTarget = example.outcome * Math.pow(gamma, pathLength);
      const tdError = discountedTarget - score;
      tdErrors.push(tdError);

      // Weighted loss (IS weight from PER)
      const loss = this.binaryCrossEntropy(score, example.outcome) * isWeight;
      totalLoss += loss;

      // Accuracy
      if ((score > 0.5 ? 1 : 0) === example.outcome) correct++;

      // === BACKWARD PASS (weighted by IS weight) ===
      const dLoss = (score - example.outcome) * isWeight;
      const sigmoidGrad = score * (1 - score) * reliabilityMult;

      const ws = groupWeights.semantic;
      const wst = groupWeights.structure;
      const wt = groupWeights.temporal;

      // Gradient for fusion weights (through softmax) - weighted by IS
      this.fusionGradients.semantic += dLoss * sigmoidGrad * (
        ws * (1 - ws) * semanticScore -
        ws * wst * structureScore -
        ws * wt * temporalScore
      );

      this.fusionGradients.structure += dLoss * sigmoidGrad * (
        wst * (1 - wst) * structureScore -
        wst * ws * semanticScore -
        wst * wt * temporalScore
      );

      this.fusionGradients.temporal += dLoss * sigmoidGrad * (
        wt * (1 - wt) * temporalScore -
        wt * ws * semanticScore -
        wt * wst * structureScore
      );

      // Gradient for feature weights (direct scaling) - weighted by IS
      this.featureGradients.semantic += dLoss * sigmoidGrad * ws * rawSemantic;
      this.featureGradients.structure += dLoss * sigmoidGrad * wst * rawStructure;
      this.featureGradients.temporal += dLoss * sigmoidGrad * wt * rawTemporal;

      // Backward for layer params and W_intent - weighted by IS
      this.backward(gradients, cache, capIdx, intentProjected, dLoss);

      // Accumulate W_intent gradients - already uses dLoss which is weighted
      this.accumulateW_intentGradients(
        example.intentEmbedding,
        intentProjected,
        capPropagatedEmb,
        dLoss
      );
    }

    // Apply all gradients
    this.applyGradients(gradients, examples.length);
    this.applyFusionGradients(examples.length);
    this.applyFeatureGradients(examples.length);
    this.applyW_intentGradients(examples.length);
    this.trainingMode = false;

    return {
      loss: totalLoss / examples.length,
      accuracy: correct / examples.length,
      tdErrors,
    };
  }

  /**
   * Apply accumulated fusion weight gradients
   */
  private applyFusionGradients(batchSize: number): void {
    const lr = this.config.learningRate / batchSize;
    const l2 = this.config.l2Lambda;

    // Update fusion weights with L2 regularization
    this.fusionWeights.semantic -= lr * (this.fusionGradients.semantic + l2 * this.fusionWeights.semantic);
    this.fusionWeights.structure -= lr * (this.fusionGradients.structure + l2 * this.fusionWeights.structure);
    this.fusionWeights.temporal -= lr * (this.fusionGradients.temporal + l2 * this.fusionWeights.temporal);

    log.debug("[SHGAT] Updated fusion weights", {
      semantic: this.fusionWeights.semantic.toFixed(4),
      structure: this.fusionWeights.structure.toFixed(4),
      temporal: this.fusionWeights.temporal.toFixed(4),
    });
  }

  /**
   * Apply accumulated feature weight gradients
   */
  private applyFeatureGradients(batchSize: number): void {
    const lr = this.config.learningRate / batchSize;
    const l2 = this.config.l2Lambda;

    // Update feature weights with L2 regularization
    this.featureWeights.semantic -= lr * (this.featureGradients.semantic + l2 * this.featureWeights.semantic);
    this.featureWeights.structure -= lr * (this.featureGradients.structure + l2 * this.featureWeights.structure);
    this.featureWeights.temporal -= lr * (this.featureGradients.temporal + l2 * this.featureWeights.temporal);

    log.debug("[SHGAT] Updated feature weights", {
      semantic: this.featureWeights.semantic.toFixed(4),
      structure: this.featureWeights.structure.toFixed(4),
      temporal: this.featureWeights.temporal.toFixed(4),
    });
  }

  /**
   * Accumulate gradients for W_intent from cosine similarity
   *
   * Chain rule: d(loss)/d(W_intent[i][j]) = d(loss)/d(intentProj[i]) * intent[j]
   */
  private accumulateW_intentGradients(
    intentOriginal: number[],
    intentProjected: number[],
    capEmb: number[],
    dLoss: number
  ): void {
    const propagatedDim = intentProjected.length;

    // Compute gradient of cosine similarity w.r.t. intentProjected
    const normIntent = Math.sqrt(intentProjected.reduce((s, x) => s + x * x, 0)) + 1e-8;
    const normCap = Math.sqrt(capEmb.reduce((s, x) => s + x * x, 0)) + 1e-8;
    const dot = this.dot(intentProjected, capEmb);

    // d(cos)/d(intentProj[i]) = capEmb[i]/(normIntent*normCap) - dot*intentProj[i]/(normIntent^3*normCap)
    const dIntentProj: number[] = new Array(propagatedDim);
    for (let i = 0; i < propagatedDim; i++) {
      const term1 = capEmb[i] / (normIntent * normCap);
      const term2 = (dot * intentProjected[i]) / (normIntent * normIntent * normIntent * normCap);
      dIntentProj[i] = dLoss * (term1 - term2);
    }

    // Accumulate gradients for W_intent
    // W_intent[i][j] affects intentProj[i] via: intentProj[i] = sum_j(W_intent[i][j] * intent[j])
    // So d(loss)/d(W_intent[i][j]) = dIntentProj[i] * intent[j]
    for (let i = 0; i < propagatedDim; i++) {
      for (let j = 0; j < intentOriginal.length; j++) {
        this.W_intent_gradients[i][j] += dIntentProj[i] * intentOriginal[j];
      }
    }
  }

  /**
   * Apply accumulated W_intent gradients with L2 regularization
   */
  private applyW_intentGradients(batchSize: number): void {
    const lr = this.config.learningRate / batchSize;
    const l2 = this.config.l2Lambda;

    for (let i = 0; i < this.W_intent.length; i++) {
      for (let j = 0; j < this.W_intent[i].length; j++) {
        const grad = this.W_intent_gradients[i][j] + l2 * this.W_intent[i][j];
        this.W_intent[i][j] -= lr * grad;
      }
    }

    log.debug("[SHGAT] Updated W_intent (sample weights)", {
      w00: this.W_intent[0]?.[0]?.toFixed(6) ?? "N/A",
      w01: this.W_intent[0]?.[1]?.toFixed(6) ?? "N/A",
    });
  }

  private initGradients(): Map<string, number[][][]> {
    const grads = new Map<string, number[][][]>();

    for (let l = 0; l < this.config.numLayers; l++) {
      const params = this.layerParams[l];
      grads.set(`W_v_${l}`, this.zerosLike3D(params.W_v));
      grads.set(`W_e_${l}`, this.zerosLike3D(params.W_e));
    }

    return grads;
  }

  private zerosLike3D(tensor: number[][][]): number[][][] {
    return tensor.map((m) => m.map((r) => r.map(() => 0)));
  }

  private backward(
    gradients: Map<string, number[][][]>,
    cache: ForwardCache,
    targetCapIdx: number,
    intentEmb: number[],
    dLoss: number,
  ): void {
    const { numLayers, numHeads, hiddenDim } = this.config;

    const E_final = cache.E[numLayers];
    const capEmb = E_final[targetCapIdx];

    // Gradient of cosine similarity
    const normIntent = Math.sqrt(intentEmb.reduce((s, x) => s + x * x, 0));
    const normCap = Math.sqrt(capEmb.reduce((s, x) => s + x * x, 0));
    const dot = this.dot(intentEmb, capEmb);

    const dCapEmb = intentEmb.map((xi, i) => {
      const term1 = xi / (normIntent * normCap);
      const term2 = (dot * capEmb[i]) / (normIntent * normCap * normCap * normCap);
      return dLoss * (term1 - term2);
    });

    // Backprop through layers
    for (let l = numLayers - 1; l >= 0; l--) {
      const H_in = cache.H[l];
      const attentionVE = cache.attentionVE[l];

      for (let h = 0; h < numHeads; h++) {
        const dW_v = gradients.get(`W_v_${l}`)!;

        for (let t = 0; t < H_in.length; t++) {
          const alpha = attentionVE[h][t][targetCapIdx];
          if (alpha > 0) {
            const headDim = hiddenDim;
            const headStart = h * headDim;
            const headEnd = headStart + headDim;
            const dE_head = dCapEmb.slice(headStart, headEnd);

            for (let d = 0; d < headDim; d++) {
              for (let j = 0; j < H_in[t].length; j++) {
                dW_v[h][d][j] += dE_head[d] * alpha * H_in[t][j];
              }
            }
          }
        }
      }
    }
  }

  private applyGradients(gradients: Map<string, number[][][]>, batchSize: number): void {
    const lr = this.config.learningRate / batchSize;
    const l2 = this.config.l2Lambda;

    for (let l = 0; l < this.config.numLayers; l++) {
      const params = this.layerParams[l];
      const dW_v = gradients.get(`W_v_${l}`)!;

      for (let h = 0; h < this.config.numHeads; h++) {
        for (let i = 0; i < params.W_v[h].length; i++) {
          for (let j = 0; j < params.W_v[h][i].length; j++) {
            const grad = dW_v[h][i][j] + l2 * params.W_v[h][i][j];
            params.W_v[h][i][j] -= lr * grad;
          }
        }
      }
    }
  }

  // ==========================================================================
  // V2 Backward Pass (W_proj + fusionMLP)
  // ==========================================================================

  /**
   * Forward pass with cached intermediates for backprop
   *
   * Returns all intermediate values needed for gradient computation.
   */
  private forwardV2WithCache(features: TraceFeatures): {
    score: number;
    headScores: number[];
    // Intermediates for backprop
    combined: number[];        // Input to W_proj
    projected: number[];       // Output of W_proj (before ReLU)
    projectedRelu: number[];   // Output after ReLU
    perHeadCache: Array<{ Q: number[]; K: number[]; V: number[]; attention: number }>;
    mlpHidden: number[];       // Hidden layer of fusionMLP (before ReLU)
    mlpHiddenRelu: number[];   // After ReLU
    mlpOutput: number;         // Before sigmoid
  } {
    const { hiddenDim, numHeads, mlpHiddenDim } = this.config;

    // === Step 1: Build combined input ===
    const statsVec = this.traceStatsToVector(features.traceStats);
    const combined = [
      ...features.intentEmbedding,
      ...features.candidateEmbedding,
      ...features.contextAggregated,
      ...statsVec,
    ];

    // === Step 2: Project features (W_proj) ===
    const projected = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      projected[i] = this.b_proj[i];
      for (let j = 0; j < combined.length; j++) {
        projected[i] += this.W_proj[i][j] * combined[j];
      }
    }
    const projectedRelu = projected.map(x => Math.max(0, x));

    // === Step 3: Compute head scores ===
    const headScores: number[] = [];
    const perHeadCache: Array<{ Q: number[]; K: number[]; V: number[]; attention: number }> = [];

    for (let h = 0; h < numHeads; h++) {
      const headParams = this.headParams[h];

      // Q = W_q @ projectedRelu
      const Q = new Array(hiddenDim).fill(0);
      for (let i = 0; i < hiddenDim; i++) {
        for (let j = 0; j < projectedRelu.length; j++) {
          Q[i] += headParams.W_q[i][j] * projectedRelu[j];
        }
      }

      // K = W_k @ projectedRelu
      const K = new Array(hiddenDim).fill(0);
      for (let i = 0; i < hiddenDim; i++) {
        for (let j = 0; j < projectedRelu.length; j++) {
          K[i] += headParams.W_k[i][j] * projectedRelu[j];
        }
      }

      // V = W_v @ projectedRelu
      const V = new Array(hiddenDim).fill(0);
      for (let i = 0; i < hiddenDim; i++) {
        for (let j = 0; j < projectedRelu.length; j++) {
          V[i] += headParams.W_v[i][j] * projectedRelu[j];
        }
      }

      // Attention = sigmoid(Q·K / √d)
      const scale = Math.sqrt(hiddenDim);
      const attention = this.sigmoid(this.dot(Q, K) / scale);

      // Head score = attention * mean(V)
      const vSum = V.reduce((a, b) => a + b, 0);
      const headScore = attention * vSum / hiddenDim;

      headScores.push(headScore);
      perHeadCache.push({ Q, K, V, attention });
    }

    // === Step 4: Fusion MLP ===
    // Layer 1: hidden = ReLU(W1 @ headScores + b1)
    const mlpHidden = new Array(mlpHiddenDim).fill(0);
    for (let i = 0; i < mlpHiddenDim; i++) {
      mlpHidden[i] = this.fusionMLP.b1[i];
      for (let j = 0; j < numHeads; j++) {
        mlpHidden[i] += this.fusionMLP.W1[i][j] * headScores[j];
      }
    }
    const mlpHiddenRelu = mlpHidden.map(x => Math.max(0, x));

    // Layer 2: output = W2 @ mlpHiddenRelu + b2
    let mlpOutput = this.fusionMLP.b2;
    for (let i = 0; i < mlpHiddenDim; i++) {
      mlpOutput += this.fusionMLP.W2[i] * mlpHiddenRelu[i];
    }

    const score = this.sigmoid(mlpOutput);

    return {
      score,
      headScores,
      combined,
      projected,
      projectedRelu,
      perHeadCache,
      mlpHidden,
      mlpHiddenRelu,
      mlpOutput,
    };
  }

  /**
   * Backward pass for V2 architecture
   *
   * Computes gradients for W_proj, b_proj, fusionMLP, and head params.
   * Accumulates into v2GradAccum.
   *
   * @param cache - Cached intermediates from forwardV2WithCache
   * @param dLoss - Gradient of loss w.r.t. score (weighted by IS if using PER)
   */
  private backwardV2(
    cache: ReturnType<typeof this.forwardV2WithCache>,
    dLoss: number,
  ): void {
    const { hiddenDim, numHeads, mlpHiddenDim } = this.config;

    // === Backprop through sigmoid ===
    // d(sigmoid)/dx = sigmoid(x) * (1 - sigmoid(x))
    const sigmoidGrad = cache.score * (1 - cache.score);
    const dMlpOutput = dLoss * sigmoidGrad;

    // === Backprop through fusionMLP Layer 2 ===
    // output = W2 @ mlpHiddenRelu + b2
    // dW2[i] = dOutput * mlpHiddenRelu[i]
    // db2 = dOutput
    // dMlpHiddenRelu[i] = dOutput * W2[i]
    this.v2GradAccum.fusionMLP.b2 += dMlpOutput;
    const dMlpHiddenRelu = new Array(mlpHiddenDim).fill(0);
    for (let i = 0; i < mlpHiddenDim; i++) {
      this.v2GradAccum.fusionMLP.W2[i] += dMlpOutput * cache.mlpHiddenRelu[i];
      dMlpHiddenRelu[i] = dMlpOutput * this.fusionMLP.W2[i];
    }

    // === Backprop through ReLU ===
    const dMlpHidden = dMlpHiddenRelu.map((d, i) => cache.mlpHidden[i] > 0 ? d : 0);

    // === Backprop through fusionMLP Layer 1 ===
    // hidden = W1 @ headScores + b1
    // dW1[i][j] = dHidden[i] * headScores[j]
    // db1[i] = dHidden[i]
    // dHeadScores[j] = sum_i(dHidden[i] * W1[i][j])
    const dHeadScores = new Array(numHeads).fill(0);
    for (let i = 0; i < mlpHiddenDim; i++) {
      this.v2GradAccum.fusionMLP.b1[i] += dMlpHidden[i];
      for (let j = 0; j < numHeads; j++) {
        this.v2GradAccum.fusionMLP.W1[i][j] += dMlpHidden[i] * cache.headScores[j];
        dHeadScores[j] += dMlpHidden[i] * this.fusionMLP.W1[i][j];
      }
    }

    // === Backprop through each head ===
    const dProjectedRelu = new Array(hiddenDim).fill(0);

    for (let h = 0; h < numHeads; h++) {
      const headParams = this.headParams[h];
      const { Q, K, V, attention } = cache.perHeadCache[h];
      const dHeadScore = dHeadScores[h];

      // headScore = attention * mean(V) = attention * sum(V) / hiddenDim
      const vSum = V.reduce((a, b) => a + b, 0);

      // d(headScore)/d(attention) = vSum / hiddenDim
      const dAttention = dHeadScore * vSum / hiddenDim;

      // d(headScore)/d(V[i]) = attention / hiddenDim
      const dV = V.map(() => dHeadScore * attention / hiddenDim);

      // attention = sigmoid(Q·K / scale)
      // d(attention)/d(Q·K) = attention * (1 - attention) / scale
      const scale = Math.sqrt(hiddenDim);
      const dQK = dAttention * attention * (1 - attention) / scale;

      // d(Q·K)/dQ[i] = K[i], d(Q·K)/dK[i] = Q[i]
      const dQ = K.map(k => dQK * k);
      const dK = Q.map(q => dQK * q);

      // Backprop through W_q, W_k, W_v (accumulate into projectedRelu gradient)
      // Q = W_q @ projectedRelu => dW_q[i][j] = dQ[i] * projectedRelu[j]
      // dProjectedRelu[j] += sum_i(dQ[i] * W_q[i][j])
      for (let i = 0; i < hiddenDim; i++) {
        for (let j = 0; j < hiddenDim; j++) {
          // Note: headParams gradients not accumulated here (would need separate accumulators)
          // For now, we focus on W_proj and fusionMLP gradients
          dProjectedRelu[j] += dQ[i] * headParams.W_q[i][j];
          dProjectedRelu[j] += dK[i] * headParams.W_k[i][j];
          dProjectedRelu[j] += dV[i] * headParams.W_v[i][j];
        }
      }
    }

    // === Backprop through ReLU (projection) ===
    const dProjected = dProjectedRelu.map((d, i) => cache.projected[i] > 0 ? d : 0);

    // === Backprop through W_proj ===
    // projected = W_proj @ combined + b_proj
    // dW_proj[i][j] = dProjected[i] * combined[j]
    // db_proj[i] = dProjected[i]
    for (let i = 0; i < hiddenDim; i++) {
      this.v2GradAccum.b_proj[i] += dProjected[i];
      for (let j = 0; j < cache.combined.length; j++) {
        this.v2GradAccum.W_proj[i][j] += dProjected[i] * cache.combined[j];
      }
    }
  }

  /**
   * Apply accumulated V2 gradients with learning rate and L2 regularization
   */
  applyV2Gradients(batchSize: number): void {
    const lr = this.config.learningRate / batchSize;
    const l2 = this.config.l2Lambda;
    const { hiddenDim, mlpHiddenDim } = this.config;

    // Apply W_proj gradients
    for (let i = 0; i < hiddenDim; i++) {
      this.b_proj[i] -= lr * (this.v2GradAccum.b_proj[i] + l2 * this.b_proj[i]);
      for (let j = 0; j < this.W_proj[i].length; j++) {
        const grad = this.v2GradAccum.W_proj[i][j] + l2 * this.W_proj[i][j];
        this.W_proj[i][j] -= lr * grad;
      }
    }

    // Apply fusionMLP gradients
    this.fusionMLP.b2 -= lr * (this.v2GradAccum.fusionMLP.b2 + l2 * this.fusionMLP.b2);
    for (let i = 0; i < mlpHiddenDim; i++) {
      this.fusionMLP.b1[i] -= lr * (this.v2GradAccum.fusionMLP.b1[i] + l2 * this.fusionMLP.b1[i]);
      const gradW2 = this.v2GradAccum.fusionMLP.W2[i] + l2 * this.fusionMLP.W2[i];
      this.fusionMLP.W2[i] -= lr * gradW2;

      for (let j = 0; j < this.config.numHeads; j++) {
        const gradW1 = this.v2GradAccum.fusionMLP.W1[i][j] + l2 * this.fusionMLP.W1[i][j];
        this.fusionMLP.W1[i][j] -= lr * gradW1;
      }
    }

    log.debug("[SHGAT] Applied V2 gradients", {
      W_proj_norm: Math.sqrt(this.W_proj.flat().reduce((s, x) => s + x * x, 0)),
      fusionMLP_W1_norm: Math.sqrt(this.fusionMLP.W1.flat().reduce((s, x) => s + x * x, 0)),
    });
  }

  /**
   * Train on batch using V2 architecture (multi-head + fusionMLP)
   *
   * Uses TraceFeatures for rich input signal and trains W_proj + fusionMLP.
   *
   * @param examples - Training examples with candidateId and outcome
   * @param traceStatsMap - Pre-computed TraceStats per candidate
   * @param isWeights - Importance Sampling weights from PER (optional)
   * @param gamma - Discount factor for TD learning
   */
  trainBatchV2(
    examples: TrainingExample[],
    traceStatsMap: Map<string, TraceStats>,
    isWeights?: number[],
    gamma: number = 0.99,
  ): { loss: number; accuracy: number; tdErrors: number[] } {
    const weights = isWeights ?? new Array(examples.length).fill(1);
    const tdErrors: number[] = [];
    this.trainingMode = true;

    let totalLoss = 0;
    let correct = 0;

    // Reset V2 gradients for this batch
    this.resetV2Gradients();

    for (let i = 0; i < examples.length; i++) {
      const example = examples[i];
      const isWeight = weights[i];

      // Get candidate node
      const capNode = this.capabilityNodes.get(example.candidateId);
      if (!capNode) {
        tdErrors.push(0);
        continue;
      }

      // Build TraceFeatures
      const traceStats = traceStatsMap.get(example.candidateId) ?? { ...DEFAULT_TRACE_STATS };

      // Aggregate context embeddings
      const contextEmbeddings: number[][] = [];
      for (const toolId of example.contextTools.slice(0, 5)) {
        const toolNode = this.toolNodes.get(toolId);
        if (toolNode) {
          contextEmbeddings.push(toolNode.embedding);
        }
      }

      const contextAggregated = contextEmbeddings.length > 0
        ? this.meanPool(contextEmbeddings, this.config.embeddingDim)
        : new Array(this.config.embeddingDim).fill(0);

      const features: TraceFeatures = {
        intentEmbedding: example.intentEmbedding,
        candidateEmbedding: capNode.embedding,
        contextEmbeddings,
        contextAggregated,
        traceStats,
      };

      // Forward pass with cache
      const cache = this.forwardV2WithCache(features);

      // TD Error computation
      const pathLength = example.contextTools.length;
      const discountedTarget = example.outcome * Math.pow(gamma, pathLength);
      const tdError = discountedTarget - cache.score;
      tdErrors.push(tdError);

      // Weighted loss (IS weight from PER)
      const loss = this.binaryCrossEntropy(cache.score, example.outcome) * isWeight;
      totalLoss += loss;

      // Accuracy
      if ((cache.score > 0.5 ? 1 : 0) === example.outcome) correct++;

      // Backward pass (weighted by IS weight)
      const dLoss = (cache.score - example.outcome) * isWeight;
      this.backwardV2(cache, dLoss);
    }

    // Apply accumulated gradients
    this.applyV2Gradients(examples.length);
    this.trainingMode = false;

    return {
      loss: totalLoss / examples.length,
      accuracy: correct / examples.length,
      tdErrors,
    };
  }

  // ==========================================================================
  // Utility Functions
  // ==========================================================================

  private getToolEmbeddings(): number[][] {
    const embeddings: number[][] = [];
    for (const [_, tool] of this.toolNodes) {
      embeddings.push([...tool.embedding]);
    }
    return embeddings;
  }

  private getCapabilityEmbeddings(): number[][] {
    const embeddings: number[][] = [];
    for (const [_, cap] of this.capabilityNodes) {
      embeddings.push([...cap.embedding]);
    }
    return embeddings;
  }

  private matmulTranspose(A: number[][], B: number[][]): number[][] {
    return A.map((row) =>
      B.map((bRow) => row.reduce((sum, val, i) => sum + val * (bRow[i] || 0), 0))
    );
  }

  private concatHeads(heads: number[][][]): number[][] {
    const numNodes = heads[0].length;
    return Array.from({ length: numNodes }, (_, i) => heads.flatMap((head) => head[i]));
  }

  private applyDropout(matrix: number[][]): number[][] {
    const keepProb = 1 - this.config.dropout;
    return matrix.map((row) => row.map((x) => (Math.random() < keepProb ? x / keepProb : 0)));
  }

  private leakyRelu(x: number): number {
    return x > 0 ? x : this.config.leakyReluSlope * x;
  }

  private elu(x: number, alpha = 1.0): number {
    return x >= 0 ? x : alpha * (Math.exp(x) - 1);
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
  }

  private softmax(values: number[]): number[] {
    const maxVal = Math.max(...values);
    const exps = values.map((v) => Math.exp(v - maxVal));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  }

  private dot(a: number[], b: number[]): number {
    return a.reduce((sum, val, i) => sum + val * (b[i] || 0), 0);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const dot = this.dot(a, b);
    const normA = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    const normB = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
    return normA * normB > 0 ? dot / (normA * normB) : 0;
  }

  private binaryCrossEntropy(pred: number, label: number): number {
    const eps = 1e-7;
    const p = Math.max(eps, Math.min(1 - eps, pred));
    return -label * Math.log(p) - (1 - label) * Math.log(1 - p);
  }

  // ==========================================================================
  // Serialization
  // ==========================================================================

  exportParams(): Record<string, unknown> {
    return {
      // Config
      config: this.config,
      // Legacy params (v1)
      layerParams: this.layerParams,
      headParams: this.headParams,
      fusionWeights: this.fusionWeights,
      featureWeights: this.featureWeights,
      W_intent: this.W_intent,
      // v2 params
      W_proj: this.W_proj,
      b_proj: this.b_proj,
      fusionMLP: this.fusionMLP,
      W_stats: this.W_stats,
      b_stats: this.b_stats,
    };
  }

  importParams(params: Record<string, unknown>): void {
    if (params.config) {
      this.config = params.config as SHGATConfig;
    }
    if (params.layerParams) {
      this.layerParams = params.layerParams as typeof this.layerParams;
    }
    if (params.headParams) {
      this.headParams = params.headParams as typeof this.headParams;
    }
    if (params.fusionWeights) {
      this.fusionWeights = params.fusionWeights as FusionWeights;
    }
    if (params.featureWeights) {
      this.featureWeights = params.featureWeights as FeatureWeights;
    }
    if (params.W_intent) {
      this.W_intent = params.W_intent as number[][];
    }
    // v2 params
    if (params.W_proj) {
      this.W_proj = params.W_proj as number[][];
    }
    if (params.b_proj) {
      this.b_proj = params.b_proj as number[];
    }
    if (params.fusionMLP) {
      this.fusionMLP = params.fusionMLP as typeof this.fusionMLP;
    }
    if (params.W_stats) {
      this.W_stats = params.W_stats as number[][];
    }
    if (params.b_stats) {
      this.b_stats = params.b_stats as number[];
    }
  }

  /**
   * Get current fusion weights (normalized via softmax)
   */
  getFusionWeights(): { semantic: number; structure: number; temporal: number } {
    return this.computeFusionWeights();
  }

  /**
   * Set raw fusion weights (before softmax normalization)
   */
  setFusionWeights(weights: Partial<FusionWeights>): void {
    if (weights.semantic !== undefined) this.fusionWeights.semantic = weights.semantic;
    if (weights.structure !== undefined) this.fusionWeights.structure = weights.structure;
    if (weights.temporal !== undefined) this.fusionWeights.temporal = weights.temporal;
  }

  /**
   * Get all registered tool IDs (for feature population)
   */
  getRegisteredToolIds(): string[] {
    return Array.from(this.toolNodes.keys());
  }

  /**
   * Get all registered capability IDs
   */
  getRegisteredCapabilityIds(): string[] {
    return Array.from(this.capabilityNodes.keys());
  }

  getStats(): {
    numHeads: number;
    hiddenDim: number;
    numLayers: number;
    paramCount: number;
    v2ParamCount: number;
    registeredCapabilities: number;
    registeredTools: number;
    incidenceNonZeros: number;
    fusionWeights: { semantic: number; structure: number; temporal: number };
    mlpHiddenDim: number;
    maxContextLength: number;
  } {
    const { numHeads, hiddenDim, embeddingDim, numLayers, mlpHiddenDim } = this.config;

    // Legacy v1 param count
    let paramCount = 0;
    for (let l = 0; l < numLayers; l++) {
      const layerInputDim = l === 0 ? embeddingDim : hiddenDim * numHeads;
      paramCount += numHeads * hiddenDim * layerInputDim * 2; // W_v, W_e
      paramCount += numHeads * 2 * hiddenDim; // a_ve
      paramCount += numHeads * hiddenDim * hiddenDim * 2; // W_e2, W_v2
      paramCount += numHeads * 2 * hiddenDim; // a_ev
    }
    // Add fusion weight params (3 values)
    paramCount += 3;

    // v2 param count (derived from DEFAULT_TRACE_STATS)
    const numTraceStats = NUM_TRACE_STATS;
    const projInputDim = 3 * embeddingDim + numTraceStats;
    let v2ParamCount = 0;
    // W_proj, b_proj
    v2ParamCount += hiddenDim * projInputDim + hiddenDim;
    // W_stats, b_stats
    v2ParamCount += hiddenDim * numTraceStats + hiddenDim;
    // headParams (W_q, W_k, W_v per head)
    v2ParamCount += numHeads * 3 * hiddenDim * hiddenDim;
    // fusionMLP
    v2ParamCount += mlpHiddenDim * numHeads + mlpHiddenDim; // W1, b1
    v2ParamCount += mlpHiddenDim + 1; // W2, b2

    let incidenceNonZeros = 0;
    for (const row of this.incidenceMatrix) {
      incidenceNonZeros += row.filter((x) => x > 0).length;
    }

    return {
      numHeads,
      hiddenDim,
      numLayers,
      paramCount,
      v2ParamCount,
      registeredCapabilities: this.capabilityNodes.size,
      registeredTools: this.toolNodes.size,
      incidenceNonZeros,
      fusionWeights: this.computeFusionWeights(),
      mlpHiddenDim,
      maxContextLength: this.config.maxContextLength,
    };
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create SHGAT from capability store
 */
export function createSHGATFromCapabilities(
  capabilities: Array<{
    id: string;
    embedding: number[];
    toolsUsed: string[];
    successRate: number;
    parents?: string[];
    children?: string[];
    hypergraphFeatures?: HypergraphFeatures;
  }>,
  configOrToolEmbeddings?: Partial<SHGATConfig> | Map<string, number[]>,
  config?: Partial<SHGATConfig>,
): SHGAT {
  // Handle overloaded parameters
  let toolEmbeddings: Map<string, number[]> | undefined;
  let actualConfig: Partial<SHGATConfig> | undefined;

  if (configOrToolEmbeddings instanceof Map) {
    toolEmbeddings = configOrToolEmbeddings;
    actualConfig = config;
  } else {
    actualConfig = configOrToolEmbeddings;
  }

  const shgat = new SHGAT(actualConfig);

  // Extract all unique tools from capabilities
  const allTools = new Set<string>();
  for (const cap of capabilities) {
    for (const toolId of cap.toolsUsed) {
      allTools.add(toolId);
    }
  }

  // Determine embedding dimension from first capability
  const embeddingDim = capabilities[0]?.embedding.length || 1024;

  // Register tools with embeddings (provided or generated)
  for (const toolId of allTools) {
    const embedding = toolEmbeddings?.get(toolId) ||
      generateDefaultToolEmbedding(toolId, embeddingDim);
    shgat.registerTool({ id: toolId, embedding });
  }

  // Register capabilities
  for (const cap of capabilities) {
    shgat.registerCapability({
      id: cap.id,
      embedding: cap.embedding,
      toolsUsed: cap.toolsUsed,
      successRate: cap.successRate,
      parents: cap.parents || [],
      children: cap.children || [],
    });

    // Update hypergraph features if provided
    if (cap.hypergraphFeatures) {
      shgat.updateHypergraphFeatures(cap.id, cap.hypergraphFeatures);
    }
  }

  return shgat;
}

/**
 * Generate a deterministic default embedding for a tool based on its ID
 */
function generateDefaultToolEmbedding(toolId: string, dim: number): number[] {
  const embedding: number[] = [];
  // Use hash-like seed from tool ID for deterministic pseudo-random values
  let seed = 0;
  for (let i = 0; i < toolId.length; i++) {
    seed = ((seed << 5) - seed + toolId.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dim; i++) {
    // Deterministic pseudo-random based on seed and index
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    embedding.push((seed / 0x7fffffff - 0.5) * 0.1);
  }
  return embedding;
}

/**
 * Train SHGAT on episodic events
 */
export async function trainSHGATOnEpisodes(
  shgat: SHGAT,
  episodes: TrainingExample[],
  _getEmbedding: (id: string) => number[] | null, // Deprecated, kept for API compat
  options: {
    epochs?: number;
    batchSize?: number;
    onEpoch?: (epoch: number, loss: number, accuracy: number) => void;
  } = {},
): Promise<{ finalLoss: number; finalAccuracy: number }> {
  // Yield to event loop for UI responsiveness during long training
  await Promise.resolve();

  const epochs = options.epochs || 10;
  const batchSize = options.batchSize || 32;

  let finalLoss = 0;
  let finalAccuracy = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const shuffled = [...episodes].sort(() => Math.random() - 0.5);

    let epochLoss = 0;
    let epochAccuracy = 0;
    let batchCount = 0;

    for (let i = 0; i < shuffled.length; i += batchSize) {
      const batch = shuffled.slice(i, i + batchSize);
      // Note: getEmbedding is no longer used - embeddings should be in the examples
      const result = shgat.trainBatch(batch);

      epochLoss += result.loss;
      epochAccuracy += result.accuracy;
      batchCount++;
    }

    epochLoss /= batchCount;
    epochAccuracy /= batchCount;

    finalLoss = epochLoss;
    finalAccuracy = epochAccuracy;

    if (options.onEpoch) {
      options.onEpoch(epoch, epochLoss, epochAccuracy);
    }
  }

  return { finalLoss, finalAccuracy };
}
