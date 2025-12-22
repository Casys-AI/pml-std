/**
 * SHGAT with Transformer Semantic Heads (POC)
 *
 * Variant of SHGAT that replaces cosine similarity with learned
 * transformer attention for the semantic heads (0-1).
 *
 * Key difference from shgat.ts:
 * - Line 707: cosineSimilarity → transformerAttention
 * - New learnable parameters: W_q, W_k for semantic projection
 * - Training backprops through the new parameters
 *
 * @module graphrag/algorithms/shgat-transformer
 */

import {
  SHGAT,
  type SHGATConfig,
  DEFAULT_SHGAT_CONFIG,
  type TrainingExample,
  type AttentionResult,
  DEFAULT_HYPERGRAPH_FEATURES,
} from "./shgat.ts";

/**
 * Extended config with semantic attention options
 */
export interface SHGATTransformerConfig extends SHGATConfig {
  /** Use learned transformer attention instead of cosine for semantic heads */
  useTransformerSemantic: boolean;
  /** Dimension for semantic projection (default: 128) */
  semanticProjectionDim: number;
}

export const DEFAULT_TRANSFORMER_CONFIG: SHGATTransformerConfig = {
  ...DEFAULT_SHGAT_CONFIG,
  useTransformerSemantic: true,
  semanticProjectionDim: 128,
};

/**
 * SHGAT with Transformer Semantic Attention
 *
 * Extends SHGAT to use learned attention for semantic heads instead of cosine.
 */
export class SHGATTransformer extends SHGAT {
  private transformerConfig: SHGATTransformerConfig;

  // Learnable parameters for semantic attention
  private W_q: number[][] = [];
  private W_k: number[][] = [];

  // Gradients for training
  private dW_q: number[][] = [];
  private dW_k: number[][] = [];

  // Track if we're in training mode for gradient accumulation
  // @ts-ignore Used by training logic
  private _isTraining = false;

  constructor(config: Partial<SHGATTransformerConfig> = {}) {
    super(config);
    this.transformerConfig = { ...DEFAULT_TRANSFORMER_CONFIG, ...config };
    this.initSemanticParams();
  }

  /**
   * Initialize W_q and W_k with Xavier initialization
   */
  private initSemanticParams(): void {
    const { embeddingDim, semanticProjectionDim } = this.transformerConfig;
    const scale = Math.sqrt(2.0 / (embeddingDim + semanticProjectionDim));

    this.W_q = this.initTransformerMatrix(semanticProjectionDim, embeddingDim, scale);
    this.W_k = this.initTransformerMatrix(semanticProjectionDim, embeddingDim, scale);

    // Initialize gradient accumulators
    this.dW_q = this.initTransformerMatrix(semanticProjectionDim, embeddingDim, 0);
    this.dW_k = this.initTransformerMatrix(semanticProjectionDim, embeddingDim, 0);
  }

  private initTransformerMatrix(rows: number, cols: number, scale: number): number[][] {
    if (scale === 0) {
      return Array.from({ length: rows }, () => Array(cols).fill(0));
    }
    return Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => (Math.random() - 0.5) * 2 * scale)
    );
  }

  /**
   * Compute semantic similarity using transformer attention
   *
   * Formula: score = sigmoid((W_q·intent) · (W_k·cap) / √d)
   *
   * This replaces cosineSimilarity for semantic heads.
   */
  private transformerSemantic(intent: number[], cap: number[]): number {
    const Q = this.matVec(this.W_q, intent);
    const K = this.matVec(this.W_k, cap);

    const d = this.transformerConfig.semanticProjectionDim;
    const attnScore = this.dotProduct(Q, K) / Math.sqrt(d);

    // Clamp before sigmoid to prevent overflow
    const clampedScore = Math.max(-20, Math.min(20, attnScore));
    return 1 / (1 + Math.exp(-clampedScore));
  }

  /**
   * Compute semantic similarity - uses transformer or cosine based on config
   */
  private getSemanticScore(intent: number[], cap: number[]): number {
    if (this.transformerConfig.useTransformerSemantic) {
      return this.transformerSemantic(intent, cap);
    }
    return this.cosineSim(intent, cap);
  }

  /**
   * Cosine similarity (fallback)
   */
  private cosineSim(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
  }

  private matVec(matrix: number[][], vec: number[]): number[] {
    return matrix.map(row =>
      row.reduce((sum, val, i) => sum + val * (vec[i] || 0), 0)
    );
  }

  private dotProduct(a: number[], b: number[]): number {
    return a.reduce((sum, val, i) => sum + val * (b[i] || 0), 0);
  }

  /**
   * Override scoreAllCapabilities to use transformer semantic
   *
   * SHGAT scoring is context-free per the original paper.
   * Context (current position) is handled by DR-DSP pathfinding, not here.
   */
  override scoreAllCapabilities(
    intentEmbedding: number[],
    _contextToolEmbeddings?: number[][], // DEPRECATED - ignored
    _contextCapabilityIds?: string[], // DEPRECATED - ignored
  ): AttentionResult[] {
    // Run parent's forward pass
    this.forward();

    const results: AttentionResult[] = [];
    const capNodes = this.getCapabilityNodes();

    for (const [capId, cap] of capNodes) {
      const capEmb = cap.embedding;

      // Use transformer or cosine for semantic similarity
      const intentSim = this.getSemanticScore(intentEmbedding, capEmb);

      // Reliability multiplier
      const reliability = cap.successRate;
      const reliabilityMult = reliability < 0.5 ? 0.5 : (reliability > 0.9 ? 1.2 : 1.0);

      // Head scores (NO context boost - per original paper)
      const features = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;

      // Head 2: Structure score (normalized to ~0-1)
      const spectralBonus = 1 / (1 + features.spectralCluster);
      const adamicAdar = features.adamicAdar ?? 0;
      const structureScore = (
        0.4 * features.hypergraphPageRank +
        0.3 * spectralBonus +
        0.3 * adamicAdar
      );

      // Head 3: Temporal score (normalized to ~0-1)
      const heatDiffusion = features.heatDiffusion ?? 0;
      const temporalScore = (
        0.4 * features.cooccurrence +
        0.4 * features.recency +
        0.2 * heatDiffusion
      );

      const headScores = [
        intentSim, // Head 0: semantic (transformer or cosine)
        intentSim, // Head 1: semantic (transformer or cosine)
        structureScore, // Head 2: structure (pageRank + spectral + adamicAdar)
        temporalScore, // Head 3: temporal (cooccurrence + recency + heatDiffusion)
      ];

      const headWeights = this.softmaxArr(headScores);

      let baseScore = 0;
      for (let h = 0; h < headScores.length; h++) {
        baseScore += headWeights[h] * headScores[h];
      }

      const score = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, baseScore * reliabilityMult))));

      results.push({
        capabilityId: capId,
        score,
        headWeights,
        headScores,
        recursiveContribution: 0,
        featureContributions: {
          semantic: (headScores[0] + headScores[1]) / 2,
          structure: headScores[2],
          temporal: headScores[3],
          reliability: reliabilityMult,
        },
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Train with backprop through transformer semantic params
   */
  trainBatchTransformer(
    examples: TrainingExample[],
    _getEmbedding?: (id: string) => number[] | null, // Optional, for future use
  ): { loss: number; accuracy: number } {
    this._isTraining = true;

    // Reset gradients
    const projDim = this.transformerConfig.semanticProjectionDim;
    const embDim = this.transformerConfig.embeddingDim;
    this.dW_q = this.initTransformerMatrix(projDim, embDim, 0);
    this.dW_k = this.initTransformerMatrix(projDim, embDim, 0);

    let totalLoss = 0;
    let correct = 0;

    const capNodes = this.getCapabilityNodes();

    for (const example of examples) {
      const capNode = capNodes.get(example.candidateId);
      if (!capNode) continue;

      const capEmb = capNode.embedding;
      const intentEmb = example.intentEmbedding;

      // Forward pass
      const Q = this.matVec(this.W_q, intentEmb);
      const K = this.matVec(this.W_k, capEmb);
      const d = projDim;
      const attnScore = this.dotProduct(Q, K) / Math.sqrt(d);
      const pred = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, attnScore))));

      // Loss (BCE)
      const eps = 1e-7;
      const p = Math.max(eps, Math.min(1 - eps, pred));
      totalLoss += -example.outcome * Math.log(p) - (1 - example.outcome) * Math.log(1 - p);

      // Accuracy
      if ((pred > 0.5 ? 1 : 0) === example.outcome) correct++;

      // Backward pass
      const dLoss = pred - example.outcome;
      const dAttn = dLoss / Math.sqrt(d);

      // Gradient accumulation
      for (let i = 0; i < projDim; i++) {
        for (let j = 0; j < embDim; j++) {
          this.dW_q[i][j] += dAttn * K[i] * intentEmb[j];
          this.dW_k[i][j] += dAttn * Q[i] * capEmb[j];
        }
      }
    }

    // Apply gradients with L2 regularization
    const lr = this.transformerConfig.learningRate / examples.length;
    const l2 = this.transformerConfig.l2Lambda;

    for (let i = 0; i < projDim; i++) {
      for (let j = 0; j < embDim; j++) {
        this.W_q[i][j] -= lr * (this.dW_q[i][j] + l2 * this.W_q[i][j]);
        this.W_k[i][j] -= lr * (this.dW_k[i][j] + l2 * this.W_k[i][j]);
      }
    }

    this._isTraining = false;

    return {
      loss: totalLoss / examples.length,
      accuracy: correct / examples.length,
    };
  }

  private softmaxArr(values: number[]): number[] {
    const maxVal = Math.max(...values);
    const exps = values.map(v => Math.exp(v - maxVal));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map(e => e / sum);
  }

  /**
   * Get capability nodes (expose for scoring)
   */
  private getCapabilityNodes(): Map<string, {
    id: string;
    embedding: number[];
    successRate: number;
    hypergraphFeatures?: {
      spectralCluster: number;
      hypergraphPageRank: number;
      cooccurrence: number;
      recency: number;
    };
  }> {
    // Access parent's private capabilityNodes via any cast
    // This is a POC - in production, we'd refactor SHGAT to expose this
    return (this as unknown as { capabilityNodes: Map<string, unknown> }).capabilityNodes as Map<string, {
      id: string;
      embedding: number[];
      successRate: number;
      hypergraphFeatures?: {
        spectralCluster: number;
        hypergraphPageRank: number;
        cooccurrence: number;
        recency: number;
      };
    }>;
  }

  /**
   * Export transformer params
   */
  exportTransformerParams(): { W_q: number[][]; W_k: number[][] } {
    return {
      W_q: this.W_q.map(row => [...row]),
      W_k: this.W_k.map(row => [...row]),
    };
  }

  /**
   * Import transformer params
   */
  importTransformerParams(params: { W_q: number[][]; W_k: number[][] }): void {
    this.W_q = params.W_q.map(row => [...row]);
    this.W_k = params.W_k.map(row => [...row]);
  }

  /**
   * Get stats including transformer params
   */
  getTransformerStats(): {
    semanticParamCount: number;
    projectionDim: number;
    useTransformer: boolean;
  } {
    const projDim = this.transformerConfig.semanticProjectionDim;
    const embDim = this.transformerConfig.embeddingDim;
    return {
      semanticParamCount: 2 * projDim * embDim, // W_q + W_k
      projectionDim: projDim,
      useTransformer: this.transformerConfig.useTransformerSemantic,
    };
  }
}

/**
 * Factory function to create SHGAT Transformer from capabilities
 */
export function createSHGATTransformerFromCapabilities(
  capabilities: Array<{
    id: string;
    embedding: number[];
    toolsUsed: string[];
    successRate: number;
    parents?: string[];
    children?: string[];
  }>,
  toolEmbeddings: Map<string, number[]>,
  config?: Partial<SHGATTransformerConfig>,
): SHGATTransformer {
  const shgat = new SHGATTransformer(config);

  // Register tools
  for (const [toolId, embedding] of toolEmbeddings) {
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
  }

  return shgat;
}

/**
 * Train SHGAT Transformer on episodes
 */
export async function trainSHGATTransformerOnEpisodes(
  shgat: SHGATTransformer,
  episodes: TrainingExample[],
  getEmbedding: (id: string) => number[] | null,
  options: {
    epochs?: number;
    batchSize?: number;
    onEpoch?: (epoch: number, loss: number, accuracy: number) => void;
  } = {},
): Promise<{ finalLoss: number; finalAccuracy: number }> {
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
      const result = shgat.trainBatchTransformer(batch, getEmbedding);

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
