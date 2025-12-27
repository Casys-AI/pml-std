/**
 * SHGAT Multi-Level K-Head Training Module
 *
 * Training logic for K-head attention scoring with multi-level message passing:
 * - Extends multi-level-trainer with headParams (W_q, W_k) gradients
 * - Backprop through K-head scoring: score = sigmoid(Q·K / √dim)
 * - Compatible with multi-level forward pass (n-SuperHyperGraph)
 *
 * Use this trainer when using K-head scoring in scoreAllCapabilities().
 * Use multi-level-trainer.ts for cosine-based scoring.
 *
 * @module graphrag/algorithms/shgat/training/multi-level-trainer-khead
 * @since v1 refactor
 */

import type { LevelParams, SHGATConfig } from "../types.ts";
import type { HeadParams } from "../initialization/parameters.ts";
import { zerosLike2D } from "../initialization/parameters.ts";
import * as math from "../utils/math.ts";
import {
  applyLevelGradients,
  computeGradientNorm,
  type ExtendedMultiLevelForwardCache,
  initMultiLevelGradients,
  type MultiLevelGradientAccumulators,
  resetMultiLevelGradients,
} from "./multi-level-trainer.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Gradient accumulators for K-head parameters
 */
export interface KHeadGradientAccumulators {
  /** Gradients for W_q per head: [numHeads][hiddenDim][inputDim] */
  dW_q: number[][][];
  /** Gradients for W_k per head: [numHeads][hiddenDim][inputDim] */
  dW_k: number[][][];
}

/**
 * Combined gradient accumulators for multi-level + K-head
 */
export interface MultiLevelKHeadGradientAccumulators extends MultiLevelGradientAccumulators {
  /** K-head gradients */
  khead: KHeadGradientAccumulators;
  /** W_intent gradients: [hiddenDim][embeddingDim] */
  dW_intent: number[][];
}

/**
 * Training result for multi-level K-head
 */
export interface MultiLevelKHeadTrainingResult {
  loss: number;
  accuracy: number;
  gradientNorm: number;
  kheadGradientNorm: number;
}

// ============================================================================
// Gradient Initialization
// ============================================================================

/**
 * Initialize gradient accumulators for multi-level K-head training
 *
 * @param levelParams Map of level → LevelParams
 * @param headParams Array of HeadParams (one per head)
 * @param config SHGAT config
 * @returns Initialized gradient accumulators (all zeros)
 */
export function initMultiLevelKHeadGradients(
  levelParams: Map<number, LevelParams>,
  headParams: HeadParams[],
  config: SHGATConfig,
): MultiLevelKHeadGradientAccumulators {
  const base = initMultiLevelGradients(levelParams);
  const { numHeads, hiddenDim, embeddingDim } = config;

  // Initialize K-head gradients
  const dW_q: number[][][] = [];
  const dW_k: number[][][] = [];

  for (let h = 0; h < numHeads; h++) {
    const hp = headParams[h];
    dW_q.push(zerosLike2D(hp.W_q));
    dW_k.push(zerosLike2D(hp.W_k));
  }

  return {
    ...base,
    khead: { dW_q, dW_k },
    dW_intent: Array.from({ length: hiddenDim }, () => Array(embeddingDim).fill(0)),
  };
}

/**
 * Reset gradient accumulators to zero
 */
export function resetMultiLevelKHeadGradients(
  accum: MultiLevelKHeadGradientAccumulators,
  levelParams: Map<number, LevelParams>,
  headParams: HeadParams[],
  config: SHGATConfig,
): void {
  resetMultiLevelGradients(accum, levelParams);

  // Reset K-head gradients
  for (let h = 0; h < config.numHeads; h++) {
    accum.khead.dW_q[h] = zerosLike2D(headParams[h].W_q);
    accum.khead.dW_k[h] = zerosLike2D(headParams[h].W_k);
  }

  // Reset W_intent gradients
  accum.dW_intent = Array.from(
    { length: config.hiddenDim },
    () => Array(config.embeddingDim).fill(0),
  );
}

// ============================================================================
// K-Head Scoring Forward (for training)
// ============================================================================

/**
 * Compute K-head score for a single head
 *
 * score = sigmoid(Q · K / √dim)
 * where Q = W_q @ intentProjected, K = W_k @ capEmbedding
 *
 * @returns score and intermediates for backprop
 */
export function computeKHeadScoreWithCache(
  intentProjected: number[],
  capEmbedding: number[],
  headParams: HeadParams,
  hiddenDim: number,
): { score: number; Q: number[]; K: number[]; dotQK: number } {
  const inputDim = Math.min(intentProjected.length, capEmbedding.length, hiddenDim);

  // Q = W_q @ intentProjected
  const Q = new Array(hiddenDim).fill(0);
  for (let i = 0; i < hiddenDim; i++) {
    for (let j = 0; j < inputDim; j++) {
      Q[i] += (headParams.W_q[i]?.[j] ?? 0) * (intentProjected[j] ?? 0);
    }
  }

  // K = W_k @ capEmbedding
  const K = new Array(hiddenDim).fill(0);
  for (let i = 0; i < hiddenDim; i++) {
    for (let j = 0; j < inputDim; j++) {
      K[i] += (headParams.W_k[i]?.[j] ?? 0) * (capEmbedding[j] ?? 0);
    }
  }

  // dot(Q, K) / sqrt(dim)
  const dotQK = math.dot(Q, K);
  const scale = Math.sqrt(hiddenDim);
  const score = math.sigmoid(dotQK / scale);

  return { score, Q, K, dotQK };
}

/**
 * Compute multi-head K-head scores with cache
 */
export function computeMultiHeadKHeadScoresWithCache(
  intentProjected: number[],
  capEmbedding: number[],
  headParams: HeadParams[],
  config: SHGATConfig,
): { scores: number[]; caches: Array<{ Q: number[]; K: number[]; dotQK: number }> } {
  const scores: number[] = [];
  const caches: Array<{ Q: number[]; K: number[]; dotQK: number }> = [];

  for (let h = 0; h < config.numHeads; h++) {
    const { score, Q, K, dotQK } = computeKHeadScoreWithCache(
      intentProjected,
      capEmbedding,
      headParams[h],
      config.hiddenDim,
    );
    scores.push(score);
    caches.push({ Q, K, dotQK });
  }

  return { scores, caches };
}

// ============================================================================
// K-Head Backward Pass
// ============================================================================

/**
 * Backprop through K-head scoring
 *
 * Given: dLoss/dScore
 * Compute: dLoss/dW_q, dLoss/dW_k, dLoss/dIntentProjected, dLoss/dCapEmbedding
 *
 * Chain rule:
 *   score = sigmoid(Q·K / √d)
 *   dScore/d(Q·K) = score * (1 - score) / √d
 *
 *   Q·K = Σ Q[i] * K[i]
 *   d(Q·K)/dQ[i] = K[i]
 *   d(Q·K)/dK[i] = Q[i]
 *
 *   Q[i] = Σ W_q[i][j] * intent[j]
 *   dQ[i]/dW_q[i][j] = intent[j]
 *
 *   K[i] = Σ W_k[i][j] * cap[j]
 *   dK[i]/dW_k[i][j] = cap[j]
 */
export function backpropKHeadScore(
  dScore: number,
  score: number,
  Q: number[],
  K: number[],
  intentProjected: number[],
  capEmbedding: number[],
  headParams: HeadParams,
  grads: KHeadGradientAccumulators,
  headIdx: number,
  config: SHGATConfig,
): { dIntentProjected: number[]; dCapEmbedding: number[] } {
  const { hiddenDim } = config;
  const scale = Math.sqrt(hiddenDim);
  const inputDim = Math.min(intentProjected.length, capEmbedding.length, hiddenDim);

  // d(score)/d(Q·K) = sigmoid'(x) = score * (1 - score)
  // And we have (Q·K) / √d, so extra 1/√d factor
  const dDotQK = dScore * score * (1 - score) / scale;

  // d(Q·K)/dQ[i] = K[i]
  // d(Q·K)/dK[i] = Q[i]
  const dQ = K.map((k) => dDotQK * k);
  const dK = Q.map((q) => dDotQK * q);

  // Accumulate gradients for W_q: dQ[i]/dW_q[i][j] = intent[j]
  for (let i = 0; i < hiddenDim; i++) {
    for (let j = 0; j < inputDim; j++) {
      grads.dW_q[headIdx][i][j] += (dQ[i] ?? 0) * (intentProjected[j] ?? 0);
    }
  }

  // Accumulate gradients for W_k: dK[i]/dW_k[i][j] = cap[j]
  for (let i = 0; i < hiddenDim; i++) {
    for (let j = 0; j < inputDim; j++) {
      grads.dW_k[headIdx][i][j] += (dK[i] ?? 0) * (capEmbedding[j] ?? 0);
    }
  }

  // Gradient w.r.t. inputs (for further backprop if needed)
  // dQ/dIntent[j] = W_q[:][j]
  const dIntentProjected = new Array(inputDim).fill(0);
  for (let j = 0; j < inputDim; j++) {
    for (let i = 0; i < hiddenDim; i++) {
      dIntentProjected[j] += (dQ[i] ?? 0) * (headParams.W_q[i]?.[j] ?? 0);
    }
  }

  // dK/dCap[j] = W_k[:][j]
  const dCapEmbedding = new Array(inputDim).fill(0);
  for (let j = 0; j < inputDim; j++) {
    for (let i = 0; i < hiddenDim; i++) {
      dCapEmbedding[j] += (dK[i] ?? 0) * (headParams.W_k[i]?.[j] ?? 0);
    }
  }

  return { dIntentProjected, dCapEmbedding };
}

/**
 * Backprop through multi-head K-head scoring (average fusion)
 *
 * avgScore = (1/numHeads) * Σ headScores[h]
 * dLoss/dHeadScore[h] = dLoss/dAvgScore * (1/numHeads)
 */
export function backpropMultiHeadKHead(
  dLoss: number,
  headScores: number[],
  headCaches: Array<{ Q: number[]; K: number[]; dotQK: number }>,
  intentProjected: number[],
  capEmbedding: number[],
  headParams: HeadParams[],
  grads: KHeadGradientAccumulators,
  config: SHGATConfig,
): { dIntentProjected: number[]; dCapEmbedding: number[] } {
  const { numHeads, hiddenDim } = config;
  const inputDim = Math.min(intentProjected.length, capEmbedding.length, hiddenDim);

  // dLoss/dHeadScore[h] = dLoss * (1/numHeads)  (average fusion)
  const dHeadScore = dLoss / numHeads;

  const dIntentProjected = new Array(inputDim).fill(0);
  const dCapEmbedding = new Array(inputDim).fill(0);

  for (let h = 0; h < numHeads; h++) {
    const { Q, K } = headCaches[h];
    const score = headScores[h];

    const { dIntentProjected: dI, dCapEmbedding: dC } = backpropKHeadScore(
      dHeadScore,
      score,
      Q,
      K,
      intentProjected,
      capEmbedding,
      headParams[h],
      grads,
      h,
      config,
    );

    // Accumulate gradients
    for (let j = 0; j < inputDim; j++) {
      dIntentProjected[j] += dI[j] ?? 0;
      dCapEmbedding[j] += dC[j] ?? 0;
    }
  }

  return { dIntentProjected, dCapEmbedding };
}

/**
 * Backprop through W_intent projection
 *
 * intentProjected = W_intent @ intentOriginal
 */
export function backpropWIntent(
  dIntentProjected: number[],
  intentOriginal: number[],
  grads: MultiLevelKHeadGradientAccumulators,
  config: SHGATConfig,
): void {
  const { hiddenDim, embeddingDim } = config;
  const inputDim = Math.min(intentOriginal.length, embeddingDim);
  const outputDim = Math.min(dIntentProjected.length, hiddenDim);

  for (let i = 0; i < outputDim; i++) {
    for (let j = 0; j < inputDim; j++) {
      grads.dW_intent[i][j] += (dIntentProjected[i] ?? 0) * (intentOriginal[j] ?? 0);
    }
  }
}

// ============================================================================
// Gradient Application
// ============================================================================

/**
 * Apply K-head gradients with L2 regularization
 */
export function applyKHeadGradients(
  grads: KHeadGradientAccumulators,
  headParams: HeadParams[],
  config: SHGATConfig,
  batchSize: number,
): void {
  const lr = config.learningRate / batchSize;
  const l2 = config.l2Lambda;

  for (let h = 0; h < config.numHeads; h++) {
    const hp = headParams[h];

    // Update W_q
    for (let i = 0; i < hp.W_q.length; i++) {
      for (let j = 0; j < (hp.W_q[i]?.length ?? 0); j++) {
        const grad = (grads.dW_q[h]?.[i]?.[j] ?? 0) + l2 * (hp.W_q[i][j] ?? 0);
        hp.W_q[i][j] -= lr * grad;
      }
    }

    // Update W_k
    for (let i = 0; i < hp.W_k.length; i++) {
      for (let j = 0; j < (hp.W_k[i]?.length ?? 0); j++) {
        const grad = (grads.dW_k[h]?.[i]?.[j] ?? 0) + l2 * (hp.W_k[i][j] ?? 0);
        hp.W_k[i][j] -= lr * grad;
      }
    }
  }
}

/**
 * Apply W_intent gradients with L2 regularization
 */
export function applyWIntentGradients(
  grads: MultiLevelKHeadGradientAccumulators,
  W_intent: number[][],
  config: SHGATConfig,
  batchSize: number,
): void {
  const lr = config.learningRate / batchSize;
  const l2 = config.l2Lambda;

  for (let i = 0; i < W_intent.length; i++) {
    for (let j = 0; j < (W_intent[i]?.length ?? 0); j++) {
      const grad = (grads.dW_intent[i]?.[j] ?? 0) + l2 * (W_intent[i][j] ?? 0);
      W_intent[i][j] -= lr * grad;
    }
  }
}

/**
 * Compute K-head gradient norm
 */
export function computeKHeadGradientNorm(grads: KHeadGradientAccumulators): number {
  let sumSquared = 0;

  for (const headGrad of grads.dW_q) {
    for (const row of headGrad) {
      for (const val of row) {
        sumSquared += val * val;
      }
    }
  }

  for (const headGrad of grads.dW_k) {
    for (const row of headGrad) {
      for (const val of row) {
        sumSquared += val * val;
      }
    }
  }

  return Math.sqrt(sumSquared);
}

// ============================================================================
// Training Utilities
// ============================================================================

/**
 * Forward context for K-head training
 */
export interface KHeadForwardContext {
  /** Multi-level forward cache */
  cache: ExtendedMultiLevelForwardCache;
  /** Propagated capability embeddings */
  E: number[][];
  /** Projected intent */
  intentProjected: number[];
  /** Per-head scoring caches */
  headCaches: Map<
    string,
    { scores: number[]; caches: Array<{ Q: number[]; K: number[]; dotQK: number }> }
  >;
}

/**
 * Train multi-level K-head SHGAT on a batch of examples
 *
 * @param examples Training examples with intent, targetCap, outcome
 * @param forwardFn Function to run forward pass and return context
 * @param levelParams Level parameters
 * @param headParams Head parameters
 * @param W_intent Intent projection matrix
 * @param hierarchyLevels Hierarchy level mapping
 * @param config SHGAT config
 * @returns Training result with loss, accuracy, gradient norms
 */
export async function trainMultiLevelKHeadBatch(
  examples: Array<{
    intentEmbedding: number[];
    targetCapId: string;
    targetLevel: number;
    outcome: number; // 1 = success, 0 = failure
  }>,
  forwardFn: (intentEmb: number[]) => KHeadForwardContext,
  levelParams: Map<number, LevelParams>,
  headParams: HeadParams[],
  W_intent: number[][],
  hierarchyLevels: Map<number, Set<string>>,
  config: SHGATConfig,
): Promise<MultiLevelKHeadTrainingResult> {
  // Yield to event loop
  await Promise.resolve();

  const grads = initMultiLevelKHeadGradients(levelParams, headParams, config);
  let totalLoss = 0;
  let correct = 0;

  for (const example of examples) {
    // Forward pass
    const ctx = forwardFn(example.intentEmbedding);

    // Get target capability embedding
    const targetIdx = getCapabilityIndex(example.targetCapId, hierarchyLevels, example.targetLevel);
    if (targetIdx < 0) continue;

    const capEmbedding = ctx.E[targetIdx] ?? [];

    // Get head scores and caches for this capability
    const headData = ctx.headCaches.get(example.targetCapId);
    if (!headData) continue;

    const { scores: headScores, caches: headCaches } = headData;

    // Predicted score = average of head scores
    const predScore = headScores.reduce((a, b) => a + b, 0) / config.numHeads;

    // Compute binary cross-entropy loss
    const loss = math.binaryCrossEntropy(predScore, example.outcome);
    totalLoss += loss;

    // Accuracy
    const predicted = predScore > 0.5 ? 1 : 0;
    if (predicted === example.outcome) {
      correct++;
    }

    // Backward pass through K-head scoring
    // dLoss/dScore = -(y/p) + (1-y)/(1-p)
    const dLoss = example.outcome === 1 ? -1 / (predScore + 1e-7) : 1 / (1 - predScore + 1e-7);

    const { dIntentProjected, dCapEmbedding: _dCapEmbedding } = backpropMultiHeadKHead(
      dLoss,
      headScores,
      headCaches,
      ctx.intentProjected,
      capEmbedding,
      headParams,
      grads.khead,
      config,
    );

    // Backprop through W_intent
    backpropWIntent(dIntentProjected, example.intentEmbedding, grads, config);

    // TODO: Backprop through multi-level message passing using dCapEmbedding
    // This would update levelParams via backwardUpwardPhase/backwardDownwardPhase
    // For now, we only train K-head params (W_q, W_k) and W_intent
  }

  // Apply gradients
  applyLevelGradients(grads, levelParams, config, examples.length);
  applyKHeadGradients(grads.khead, headParams, config, examples.length);
  applyWIntentGradients(grads, W_intent, config, examples.length);

  const levelGradNorm = computeGradientNorm(grads);
  const kheadGradNorm = computeKHeadGradientNorm(grads.khead);

  return {
    loss: totalLoss / examples.length,
    accuracy: correct / examples.length,
    gradientNorm: levelGradNorm,
    kheadGradientNorm: kheadGradNorm,
  };
}

/**
 * Train on single example (online learning)
 */
export async function trainOnSingleKHeadExample(
  example: {
    intentEmbedding: number[];
    targetCapId: string;
    targetLevel: number;
    outcome: number;
  },
  forwardFn: (intentEmb: number[]) => KHeadForwardContext,
  levelParams: Map<number, LevelParams>,
  headParams: HeadParams[],
  W_intent: number[][],
  hierarchyLevels: Map<number, Set<string>>,
  config: SHGATConfig,
): Promise<MultiLevelKHeadTrainingResult> {
  return trainMultiLevelKHeadBatch(
    [example],
    forwardFn,
    levelParams,
    headParams,
    W_intent,
    hierarchyLevels,
    config,
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get capability index within its hierarchy level
 */
function getCapabilityIndex(
  capId: string,
  hierarchyLevels: Map<number, Set<string>>,
  level: number,
): number {
  const capsAtLevel = Array.from(hierarchyLevels.get(level) ?? []);
  return capsAtLevel.indexOf(capId);
}
