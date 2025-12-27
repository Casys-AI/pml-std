/**
 * SHGAT v2 Scorer - Multi-Head with TraceFeatures
 *
 * Multi-Head Attention Architecture:
 * - K adaptive heads (4-16 based on trace volume)
 * - All heads receive same TraceFeatures (each learns different patterns)
 * - Fusion MLP combines head outputs
 *
 * TraceFeatures (17 dimensions):
 * - intentEmbedding: User intent (1024-dim BGE-M3)
 * - candidateEmbedding: Tool/capability (1024-dim)
 * - contextAggregated: Mean pooling of recent tools (1024-dim)
 * - traceStats: 17 scalar execution statistics
 *
 * @module graphrag/algorithms/shgat/scoring/v2-scorer
 */

import * as math from "../utils/math.ts";
import type {
  AttentionResult,
  CapabilityNode,
  SHGATConfig,
  ToolNode,
  TraceFeatures,
  TraceStats,
} from "../types.ts";
import { DEFAULT_HYPERGRAPH_FEATURES, DEFAULT_TOOL_GRAPH_FEATURES } from "../types.ts";
import type { ForwardResult } from "./v1-scorer.ts";

/**
 * Head parameters for multi-head attention
 */
export interface HeadParams {
  /** Query projection weights [hiddenDim][hiddenDim] */
  W_q: number[][];
  /** Key projection weights [hiddenDim][hiddenDim] */
  W_k: number[][];
  /** Value projection weights [hiddenDim][hiddenDim] */
  W_v: number[][];
  /** Attention vector (legacy, kept for compat) */
  a: number[];
}

/**
 * Fusion MLP parameters
 */
export interface FusionMLPParams {
  /** Layer 1 weights [mlpHiddenDim][numHeads] */
  W1: number[][];
  /** Layer 1 bias [mlpHiddenDim] */
  b1: number[];
  /** Layer 2 weights [mlpHiddenDim] */
  W2: number[];
  /** Layer 2 bias (scalar) */
  b2: number;
}

/**
 * Dependencies required by V2Scorer
 */
export interface V2ScorerDependencies {
  /** SHGAT configuration */
  config: SHGATConfig;
  /** Tool nodes map */
  toolNodes: Map<string, ToolNode>;
  /** Capability nodes map */
  capabilityNodes: Map<string, CapabilityNode>;
  /** Capability ID → index mapping */
  capabilityIndex: Map<string, number>;
  /** Head parameters (per head) */
  headParams: HeadParams[];
  /** Feature projection weights [hiddenDim][3*embeddingDim + numTraceStats] */
  W_proj: number[][];
  /** Feature projection bias [hiddenDim] */
  b_proj: number[];
  /** Fusion MLP parameters */
  fusionMLP: FusionMLPParams;
  /** Forward pass function (message passing) - optional for v3 hybrid */
  forward?: () => ForwardResult;
  /** Get tool attention for a capability (for interpretability) */
  getCapabilityToolAttention: (capIdx: number) => number[];
}

/**
 * V2 Scorer - Multi-head with TraceFeatures
 *
 * Uses K adaptive heads where all heads receive the same TraceFeatures.
 * Each head learns different patterns. Fusion MLP combines outputs.
 */
export class V2Scorer {
  constructor(private deps: V2ScorerDependencies) {}

  /**
   * Convert TraceStats to a flat vector
   *
   * @param stats TraceStats object
   * @returns Flat vector of 17 features
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
      stats.avgPathLengthToSuccess / 10, // Normalize to ~[0,1]
      stats.pathVariance / 10, // Normalize to ~[0,1]
      ...stats.errorTypeAffinity,
    ];
  }

  /**
   * Project features to hidden space
   *
   * Combines intent, candidate, context embeddings and trace stats
   * into a single hidden-dim vector for multi-head attention.
   *
   * @param features Rich features from execution traces
   * @returns Projected features in hiddenDim space
   */
  private projectFeaturesV2(features: TraceFeatures): number[] {
    const { config, W_proj, b_proj } = this.deps;
    const { hiddenDim } = config;

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
      let sum = b_proj[i];
      for (let j = 0; j < combined.length; j++) {
        sum += W_proj[i][j] * combined[j];
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
    const { headParams, config } = this.deps;
    const hp = headParams[headIdx];
    const { hiddenDim } = config;

    // Q = W_q @ projected
    const Q = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projected.length; j++) {
        Q[i] += hp.W_q[i][j] * projected[j];
      }
    }

    // K = W_k @ projected
    const K = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projected.length; j++) {
        K[i] += hp.W_k[i][j] * projected[j];
      }
    }

    // V = W_v @ projected
    const V = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projected.length; j++) {
        V[i] += hp.W_v[i][j] * projected[j];
      }
    }

    // Attention = softmax(Q·K^T / √d_k)
    // For single-query self-attention, this simplifies to a scalar
    const scale = Math.sqrt(hiddenDim);
    const attention = math.dot(Q, K) / scale;
    const attentionWeight = math.sigmoid(attention); // Use sigmoid for [0,1] range

    // Output = attention_weight * sum(V)
    const vSum = V.reduce((a, b) => a + b, 0);
    return (attentionWeight * vSum) / hiddenDim; // Normalize by dim
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
    const { config } = this.deps;
    const { numHeads } = config;
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
    const { fusionMLP, config } = this.deps;
    const { mlpHiddenDim } = config;

    // Layer 1: Linear + ReLU
    const hidden = new Array(mlpHiddenDim).fill(0);
    for (let i = 0; i < mlpHiddenDim; i++) {
      let sum = fusionMLP.b1[i];
      for (let j = 0; j < headScores.length; j++) {
        sum += fusionMLP.W1[i][j] * headScores[j];
      }
      hidden[i] = Math.max(0, sum); // ReLU
    }

    // Layer 2: Linear + Sigmoid
    let output = fusionMLP.b2;
    for (let i = 0; i < mlpHiddenDim; i++) {
      output += fusionMLP.W2[i] * hidden[i];
    }

    return math.sigmoid(output);
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
   * @returns Final score in [0, 1] and per-head scores
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
    const { capabilityNodes, capabilityIndex, toolNodes, config, getCapabilityToolAttention } =
      this.deps;
    const { numHeads } = config;

    const results: AttentionResult[] = [];

    // Get context embeddings for capabilities without pre-built TraceFeatures
    const contextEmbeddings: number[][] = [];
    for (const toolId of contextToolIds.slice(-config.maxContextLength)) {
      const tool = toolNodes.get(toolId);
      if (tool) {
        contextEmbeddings.push(tool.embedding);
      }
    }
    const contextAggregated = math.meanPool(contextEmbeddings, intentEmbedding.length);

    for (const [capId, cap] of capabilityNodes) {
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
      const reliabilityMult = reliability < 0.5 ? 0.5 : reliability > 0.9 ? 1.2 : 1.0;
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
        toolAttention: getCapabilityToolAttention(capabilityIndex.get(capId)!),
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
    const { toolNodes, config } = this.deps;

    const results: Array<{ toolId: string; score: number; headScores: number[] }> = [];

    // Get context embeddings
    const contextEmbeddings: number[][] = [];
    for (const toolId of contextToolIds.slice(-config.maxContextLength)) {
      const tool = toolNodes.get(toolId);
      if (tool) {
        contextEmbeddings.push(tool.embedding);
      }
    }
    const contextAggregated = math.meanPool(contextEmbeddings, intentEmbedding.length);

    for (const [toolId, tool] of toolNodes) {
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
    const {
      capabilityNodes,
      capabilityIndex,
      toolNodes,
      config,
      forward,
      getCapabilityToolAttention,
    } = this.deps;

    if (!forward) {
      throw new Error("V3 hybrid scoring requires forward() function for message passing");
    }

    const { numHeads } = config;
    const results: AttentionResult[] = [];

    // ========================================================================
    // v1 Component: Message passing to get propagated embeddings
    // ========================================================================
    const { E } = forward();

    // Get context embeddings for capabilities without pre-built TraceFeatures
    const contextEmbeddings: number[][] = [];
    for (const toolId of contextToolIds.slice(-config.maxContextLength)) {
      const tool = toolNodes.get(toolId);
      if (tool) {
        contextEmbeddings.push(tool.embedding);
      }
    }
    const contextAggregated = math.meanPool(contextEmbeddings, intentEmbedding.length);

    for (const [capId, cap] of capabilityNodes) {
      const cIdx = capabilityIndex.get(capId)!;

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
      const reliabilityMult = reliability < 0.5 ? 0.5 : reliability > 0.9 ? 1.2 : 1.0;
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
        toolAttention: getCapabilityToolAttention(cIdx),
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }
}
