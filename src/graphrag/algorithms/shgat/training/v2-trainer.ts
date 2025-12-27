/**
 * SHGAT V2 Training Module
 *
 * Training logic for the multi-head architecture with TraceFeatures:
 * - K adaptive attention heads (4-16)
 * - TraceFeatures with 17 input signals
 * - Fusion MLP for combining head outputs
 *
 * Implements:
 * - Forward pass with cached intermediates
 * - Backward pass through fusionMLP, W_proj, and head params
 * - Gradient accumulation and application
 *
 * @module graphrag/algorithms/shgat/training/v2-trainer
 */

import type { SHGATConfig, TraceFeatures, TraceStats } from "../types.ts";
import type {
  FusionMLPParams,
  HeadParams,
  V2GradientAccumulators,
} from "../initialization/parameters.ts";
import * as math from "../utils/math.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Cached values from forward pass for backpropagation
 */
export interface V2ForwardCache {
  score: number;
  headScores: number[];
  // Intermediates for backprop
  combined: number[]; // Input to W_proj
  projected: number[]; // Output of W_proj (before ReLU)
  projectedRelu: number[]; // Output after ReLU
  perHeadCache: Array<{ Q: number[]; K: number[]; V: number[]; attention: number }>;
  mlpHidden: number[]; // Hidden layer of fusionMLP (before ReLU)
  mlpHiddenRelu: number[]; // After ReLU
  mlpOutput: number; // Before sigmoid
}

// ============================================================================
// TraceStats to Vector
// ============================================================================

/**
 * Convert TraceStats to a flat vector for neural network input
 * Returns 17 features: 11 scalar stats + 6 errorTypeAffinity values
 */
export function traceStatsToVector(stats: TraceStats): number[] {
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

// ============================================================================
// Forward Pass with Cache
// ============================================================================

/**
 * Forward pass with cached intermediates for backpropagation
 */
export function forwardV2WithCache(
  features: TraceFeatures,
  config: SHGATConfig,
  headParams: HeadParams[],
  W_proj: number[][],
  b_proj: number[],
  fusionMLP: FusionMLPParams,
): V2ForwardCache {
  const { hiddenDim, numHeads, mlpHiddenDim } = config;

  // === Step 1: Build combined input ===
  const statsVec = traceStatsToVector(features.traceStats);
  const combined = [
    ...features.intentEmbedding,
    ...features.candidateEmbedding,
    ...features.contextAggregated,
    ...statsVec,
  ];

  // === Step 2: Project features (W_proj) ===
  const projected = new Array(hiddenDim).fill(0);
  for (let i = 0; i < hiddenDim; i++) {
    projected[i] = b_proj[i];
    for (let j = 0; j < combined.length; j++) {
      projected[i] += W_proj[i][j] * combined[j];
    }
  }
  const projectedRelu = projected.map((x) => Math.max(0, x));

  // === Step 3: Compute head scores ===
  const headScores: number[] = [];
  const perHeadCache: Array<{ Q: number[]; K: number[]; V: number[]; attention: number }> = [];

  for (let h = 0; h < numHeads; h++) {
    const hp = headParams[h];

    // Q = W_q @ projectedRelu
    const Q = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projectedRelu.length; j++) {
        Q[i] += hp.W_q[i][j] * projectedRelu[j];
      }
    }

    // K = W_k @ projectedRelu
    const K = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projectedRelu.length; j++) {
        K[i] += hp.W_k[i][j] * projectedRelu[j];
      }
    }

    // V = W_v @ projectedRelu
    const V = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projectedRelu.length; j++) {
        V[i] += hp.W_v[i][j] * projectedRelu[j];
      }
    }

    // Attention = sigmoid(Q·K / √d)
    const scale = Math.sqrt(hiddenDim);
    const attention = math.sigmoid(math.dot(Q, K) / scale);

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
    mlpHidden[i] = fusionMLP.b1[i];
    for (let j = 0; j < numHeads; j++) {
      mlpHidden[i] += fusionMLP.W1[i][j] * headScores[j];
    }
  }
  const mlpHiddenRelu = mlpHidden.map((x) => Math.max(0, x));

  // Layer 2: output = W2 @ mlpHiddenRelu + b2
  let mlpOutput = fusionMLP.b2;
  for (let i = 0; i < mlpHiddenDim; i++) {
    mlpOutput += fusionMLP.W2[i] * mlpHiddenRelu[i];
  }

  const score = math.sigmoid(mlpOutput);

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

// ============================================================================
// Backward Pass
// ============================================================================

/**
 * Backward pass for V2 architecture
 *
 * Computes gradients for W_proj, b_proj, fusionMLP, and head params.
 * Accumulates into v2GradAccum.
 */
export function backwardV2(
  cache: V2ForwardCache,
  dLoss: number,
  config: SHGATConfig,
  headParams: HeadParams[],
  fusionMLP: FusionMLPParams,
  gradAccum: V2GradientAccumulators,
): void {
  const { hiddenDim, numHeads, mlpHiddenDim } = config;

  // === Backprop through sigmoid ===
  const sigmoidGrad = cache.score * (1 - cache.score);
  const dMlpOutput = dLoss * sigmoidGrad;

  // === Backprop through fusionMLP Layer 2 ===
  gradAccum.fusionMLP.b2 += dMlpOutput;
  const dMlpHiddenRelu = new Array(mlpHiddenDim).fill(0);
  for (let i = 0; i < mlpHiddenDim; i++) {
    gradAccum.fusionMLP.W2[i] += dMlpOutput * cache.mlpHiddenRelu[i];
    dMlpHiddenRelu[i] = dMlpOutput * fusionMLP.W2[i];
  }

  // === Backprop through ReLU ===
  const dMlpHidden = dMlpHiddenRelu.map((d, i) => cache.mlpHidden[i] > 0 ? d : 0);

  // === Backprop through fusionMLP Layer 1 ===
  const dHeadScores = new Array(numHeads).fill(0);
  for (let i = 0; i < mlpHiddenDim; i++) {
    gradAccum.fusionMLP.b1[i] += dMlpHidden[i];
    for (let j = 0; j < numHeads; j++) {
      gradAccum.fusionMLP.W1[i][j] += dMlpHidden[i] * cache.headScores[j];
      dHeadScores[j] += dMlpHidden[i] * fusionMLP.W1[i][j];
    }
  }

  // === Backprop through each head ===
  const dProjectedRelu = new Array(hiddenDim).fill(0);

  for (let h = 0; h < numHeads; h++) {
    const hp = headParams[h];
    const { Q, K, V, attention } = cache.perHeadCache[h];
    const dHeadScore = dHeadScores[h];

    const vSum = V.reduce((a, b) => a + b, 0);

    // d(headScore)/d(attention) = vSum / hiddenDim
    const dAttention = dHeadScore * vSum / hiddenDim;

    // d(headScore)/d(V[i]) = attention / hiddenDim
    const dV = V.map(() => dHeadScore * attention / hiddenDim);

    // attention = sigmoid(Q·K / scale)
    const scale = Math.sqrt(hiddenDim);
    const dQK = dAttention * attention * (1 - attention) / scale;

    // d(Q·K)/dQ[i] = K[i], d(Q·K)/dK[i] = Q[i]
    const dQ = K.map((k) => dQK * k);
    const dK = Q.map((q) => dQK * q);

    // Backprop through W_q, W_k, W_v (accumulate into projectedRelu gradient)
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < hiddenDim; j++) {
        dProjectedRelu[j] += dQ[i] * hp.W_q[i][j];
        dProjectedRelu[j] += dK[i] * hp.W_k[i][j];
        dProjectedRelu[j] += dV[i] * hp.W_v[i][j];
      }
    }
  }

  // === Backprop through ReLU (projection) ===
  const dProjected = dProjectedRelu.map((d, i) => cache.projected[i] > 0 ? d : 0);

  // === Backprop through W_proj ===
  for (let i = 0; i < hiddenDim; i++) {
    gradAccum.b_proj[i] += dProjected[i];
    for (let j = 0; j < cache.combined.length; j++) {
      gradAccum.W_proj[i][j] += dProjected[i] * cache.combined[j];
    }
  }
}

// ============================================================================
// Gradient Application
// ============================================================================

/**
 * Apply accumulated V2 gradients with learning rate and L2 regularization
 */
export function applyV2Gradients(
  gradAccum: V2GradientAccumulators,
  config: SHGATConfig,
  W_proj: number[][],
  b_proj: number[],
  fusionMLP: FusionMLPParams,
  batchSize: number,
): void {
  const lr = config.learningRate / batchSize;
  const l2 = config.l2Lambda;
  const { hiddenDim, mlpHiddenDim } = config;

  // Apply W_proj gradients
  for (let i = 0; i < hiddenDim; i++) {
    b_proj[i] -= lr * (gradAccum.b_proj[i] + l2 * b_proj[i]);
    for (let j = 0; j < W_proj[i].length; j++) {
      const grad = gradAccum.W_proj[i][j] + l2 * W_proj[i][j];
      W_proj[i][j] -= lr * grad;
    }
  }

  // Apply fusionMLP gradients
  fusionMLP.b2 -= lr * (gradAccum.fusionMLP.b2 + l2 * fusionMLP.b2);
  for (let i = 0; i < mlpHiddenDim; i++) {
    fusionMLP.b1[i] -= lr * (gradAccum.fusionMLP.b1[i] + l2 * fusionMLP.b1[i]);
    const gradW2 = gradAccum.fusionMLP.W2[i] + l2 * fusionMLP.W2[i];
    fusionMLP.W2[i] -= lr * gradW2;

    for (let j = 0; j < config.numHeads; j++) {
      const gradW1 = gradAccum.fusionMLP.W1[i][j] + l2 * fusionMLP.W1[i][j];
      fusionMLP.W1[i][j] -= lr * gradW1;
    }
  }
}

// ============================================================================
// Feature Building
// ============================================================================

/**
 * Build TraceFeatures for a candidate from context
 */
export function buildTraceFeatures(
  intentEmbedding: number[],
  candidateEmbedding: number[],
  contextEmbeddings: number[][],
  traceStats: TraceStats,
  embeddingDim: number,
): TraceFeatures {
  const contextAggregated = contextEmbeddings.length > 0
    ? math.meanPool(contextEmbeddings, embeddingDim)
    : new Array(embeddingDim).fill(0);

  return {
    intentEmbedding,
    candidateEmbedding,
    contextEmbeddings,
    contextAggregated,
    traceStats,
  };
}

/**
 * Create default TraceStats from hypergraph features
 */
export function createDefaultTraceStatsFromFeatures(
  successRate: number,
  cooccurrence: number,
  recency: number,
  pageRank: number,
): TraceStats {
  return {
    historicalSuccessRate: successRate,
    contextualSuccessRate: successRate,
    intentSimilarSuccessRate: 0.5,
    cooccurrenceWithContext: cooccurrence,
    sequencePosition: 0.5,
    recencyScore: recency,
    usageFrequency: pageRank,
    avgExecutionTime: 0.5,
    errorRecoveryRate: 0.5,
    avgPathLengthToSuccess: 3,
    pathVariance: 0,
    errorTypeAffinity: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  };
}

// ============================================================================
// Scoring (for inference, not training)
// ============================================================================

/**
 * Compute head scores from projected features
 */
export function computeHeadScores(
  projectedRelu: number[],
  config: SHGATConfig,
  headParams: HeadParams[],
): number[] {
  const { hiddenDim, numHeads } = config;
  const headScores: number[] = [];

  for (let h = 0; h < numHeads; h++) {
    const hp = headParams[h];

    // Q = W_q @ projectedRelu
    const Q = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projectedRelu.length; j++) {
        Q[i] += hp.W_q[i][j] * projectedRelu[j];
      }
    }

    // K = W_k @ projectedRelu
    const K = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projectedRelu.length; j++) {
        K[i] += hp.W_k[i][j] * projectedRelu[j];
      }
    }

    // V = W_v @ projectedRelu
    const V = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projectedRelu.length; j++) {
        V[i] += hp.W_v[i][j] * projectedRelu[j];
      }
    }

    // Attention = sigmoid(Q·K / √d)
    const scale = Math.sqrt(hiddenDim);
    const attentionWeight = math.sigmoid(math.dot(Q, K) / scale);

    // Output = attention_weight * mean(V)
    const vSum = V.reduce((a, b) => a + b, 0);
    headScores.push(attentionWeight * vSum / hiddenDim);
  }

  return headScores;
}

/**
 * Fusion MLP forward pass
 */
export function fusionMLPForward(
  headScores: number[],
  config: SHGATConfig,
  fusionMLP: FusionMLPParams,
): number {
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
