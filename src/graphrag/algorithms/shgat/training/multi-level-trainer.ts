/**
 * SHGAT Multi-Level Training Module
 *
 * Training logic for n-SuperHyperGraph multi-level message passing:
 * - Forward cache with per-level intermediate embeddings
 * - Backward pass through upward and downward phases
 * - Gradient accumulation per hierarchy level
 * - Backpropagation through softmax attention
 *
 * @module graphrag/algorithms/shgat/training/multi-level-trainer
 * @since v1 refactor
 * @see 07-training.md
 */

import type { LevelParams, MultiLevelForwardCache, SHGATConfig } from "../types.ts";
import { zerosLike3D } from "../initialization/parameters.ts";
import * as math from "../utils/math.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Gradient accumulators for multi-level parameters
 *
 * Stores gradients for each hierarchy level's learnable parameters.
 */
export interface MultiLevelGradientAccumulators {
  /** Gradients per level: level → LevelGradients */
  levelGradients: Map<number, LevelGradients>;
}

/**
 * Gradients for a single hierarchy level
 */
export interface LevelGradients {
  /** Gradient for W_child: [numHeads][headDim][inputDim] */
  dW_child: number[][][];
  /** Gradient for W_parent: [numHeads][headDim][inputDim] */
  dW_parent: number[][][];
  /** Gradient for a_upward: [numHeads][2*headDim] */
  da_upward: number[][];
  /** Gradient for a_downward: [numHeads][2*headDim] */
  da_downward: number[][];
}

/**
 * Intermediate activations for gradient computation (per level)
 */
export interface LevelIntermediates {
  /** Child projections per head: [head][numChildren][headDim] */
  childProj: number[][][];
  /** Parent projections per head: [head][numParents][headDim] */
  parentProj: number[][][];
  /** Pre-softmax attention scores: [head][numChildren][numParents] */
  scores: number[][][];
  /** Post-softmax attention weights: [head][numChildren][numParents] */
  attention: number[][][];
}

/**
 * Extended forward cache for multi-level backpropagation
 */
export interface ExtendedMultiLevelForwardCache extends MultiLevelForwardCache {
  /** Intermediate activations for upward pass: level → LevelIntermediates */
  intermediateUpwardActivations: Map<number, LevelIntermediates>;
  /** Intermediate activations for downward pass: level → LevelIntermediates */
  intermediateDownwardActivations: Map<number, LevelIntermediates>;
}

/**
 * Training result for multi-level
 */
export interface MultiLevelTrainingResult {
  loss: number;
  accuracy: number;
  gradientNorm: number;
}

// ============================================================================
// Gradient Initialization
// ============================================================================

/**
 * Initialize gradient accumulators for multi-level training
 *
 * @param levelParams Map of level → LevelParams
 * @returns Initialized gradient accumulators (all zeros)
 */
export function initMultiLevelGradients(
  levelParams: Map<number, LevelParams>,
): MultiLevelGradientAccumulators {
  const grads = new Map<number, LevelGradients>();

  for (const [level, params] of levelParams) {
    grads.set(level, {
      dW_child: zerosLike3D(params.W_child),
      dW_parent: zerosLike3D(params.W_parent),
      da_upward: params.a_upward.map((row) => row.map(() => 0)),
      da_downward: params.a_downward.map((row) => row.map(() => 0)),
    });
  }

  return { levelGradients: grads };
}

/**
 * Reset gradient accumulators to zero
 */
export function resetMultiLevelGradients(
  accum: MultiLevelGradientAccumulators,
  levelParams: Map<number, LevelParams>,
): void {
  for (const [level, params] of levelParams) {
    const grads = accum.levelGradients.get(level);
    if (grads) {
      grads.dW_child = zerosLike3D(params.W_child);
      grads.dW_parent = zerosLike3D(params.W_parent);
      grads.da_upward = params.a_upward.map((row) => row.map(() => 0));
      grads.da_downward = params.a_downward.map((row) => row.map(() => 0));
    }
  }
}

// ============================================================================
// Backward Pass Through Attention
// ============================================================================

/**
 * Backprop through softmax attention
 *
 * Given: dL/d(output), attention weights α, values V
 * Compute: dL/d(scores), dL/d(V)
 *
 * The Jacobian of softmax: d(softmax)/d(scores) = diag(α) - α ⊗ α^T
 *
 * @param dOutput Gradient of loss w.r.t. attention output [dim]
 * @param attention Softmax attention weights [numChildren]
 * @param values Value vectors [numChildren][dim]
 * @param _scores Pre-softmax scores [numChildren] (unused but kept for API)
 * @returns Gradients for scores and values
 */
export function backpropAttention(
  dOutput: number[],
  attention: number[],
  values: number[][],
  _scores: number[],
): { dScores: number[]; dValues: number[][] } {
  const numChildren = attention.length;
  const dim = dOutput.length;

  // dL/dV[i] = α[i] * dOutput
  const dValues: number[][] = [];
  for (let i = 0; i < numChildren; i++) {
    dValues.push(dOutput.map((g) => attention[i] * g));
  }

  // dL/d(scores) via softmax Jacobian
  // d(softmax)/d(scores)[i][j] = α[i](δ[i,j] - α[j])
  // dL/d(scores)[i] = sum_j (dL/d(α)[j] * d(α)[j]/d(scores)[i])
  const dScores: number[] = [];

  // First compute dL/d(α) = sum_d (dOutput[d] * V[·][d])
  const dAlpha: number[] = [];
  for (let i = 0; i < numChildren; i++) {
    let grad = 0;
    for (let d = 0; d < dim; d++) {
      grad += dOutput[d] * (values[i]?.[d] ?? 0);
    }
    dAlpha.push(grad);
  }

  // Now apply softmax Jacobian
  for (let i = 0; i < numChildren; i++) {
    let grad = 0;
    for (let j = 0; j < numChildren; j++) {
      const jacobian = i === j ? attention[i] * (1 - attention[i]) : -attention[i] * attention[j];
      grad += jacobian * dAlpha[j];
    }
    dScores.push(grad);
  }

  return { dScores, dValues };
}

/**
 * Backprop through LeakyReLU
 *
 * @param x Input value
 * @param dOutput Gradient from upstream
 * @param slope Negative slope (default 0.2)
 * @returns Gradient w.r.t. input
 */
export function backpropLeakyRelu(
  x: number,
  dOutput: number,
  slope: number = 0.2,
): number {
  return x > 0 ? dOutput : slope * dOutput;
}

// ============================================================================
// Backward Pass Through Phases
// ============================================================================

/**
 * Backward pass through a single upward phase (child → parent)
 *
 * Computes gradients for:
 * - W_child, W_parent (projection matrices)
 * - a_upward (attention vector)
 * - Propagates gradient to child embeddings
 *
 * @param dE_parent Gradient w.r.t. parent embeddings [numParents][dim]
 * @param childEmbs Child embeddings (tools or lower-level caps)
 * @param parentEmbs Parent embeddings (current level caps)
 * @param params Level parameters
 * @param intermediates Cached activations from forward pass
 * @param grads Gradient accumulators to update
 * @param config SHGAT config
 * @returns Gradient w.r.t. child embeddings
 */
export function backwardUpwardPhase(
  dE_parent: number[][],
  childEmbs: number[][],
  parentEmbs: number[][],
  params: LevelParams,
  intermediates: LevelIntermediates,
  grads: LevelGradients,
  config: SHGATConfig,
): number[][] {
  const { numHeads } = config;
  const headDim = Math.floor(config.hiddenDim / numHeads);
  const numChildren = childEmbs.length;
  const numParents = parentEmbs.length;

  // Initialize gradient for children
  const dE_child: number[][] = childEmbs.map((row) => row.map(() => 0));

  for (let head = 0; head < numHeads; head++) {
    const headStart = head * headDim;
    const headEnd = headStart + headDim;

    // Get cached activations for this head
    const childProj = intermediates.childProj[head] ?? [];
    const parentProj = intermediates.parentProj[head] ?? [];
    const attention = intermediates.attention[head] ?? [];
    const scores = intermediates.scores[head] ?? [];

    for (let p = 0; p < numParents; p++) {
      // Extract head-specific gradient for this parent
      const dE_head = dE_parent[p]?.slice(headStart, headEnd) ?? [];

      // Get children contributing to this parent
      const childrenContributing: number[] = [];
      for (let c = 0; c < numChildren; c++) {
        if ((attention[c]?.[p] ?? 0) > 0) {
          childrenContributing.push(c);
        }
      }

      if (childrenContributing.length === 0) continue;

      // Backprop through attention aggregation
      const childAttentions = childrenContributing.map((c) => attention[c]?.[p] ?? 0);
      const childValues = childrenContributing.map((c) => childProj[c] ?? []);
      const childScores = childrenContributing.map((c) => scores[c]?.[p] ?? 0);

      const { dScores, dValues } = backpropAttention(
        dE_head,
        childAttentions,
        childValues,
        childScores,
      );

      // Backprop through attention score computation
      for (let ci = 0; ci < childrenContributing.length; ci++) {
        const c = childrenContributing[ci];
        const dScore = dScores[ci] ?? 0;

        // Score = a^T · LeakyReLU([W_child · e_child || W_parent · e_parent])
        const a = params.a_upward[head];
        const concatenated: number[] = [
          ...(childProj[c] ?? []),
          ...(parentProj[p] ?? []),
        ];

        // Backprop through LeakyReLU
        for (let d = 0; d < concatenated.length; d++) {
          const leakyGrad = backpropLeakyRelu(concatenated[d], dScore * (a[d] ?? 0));

          // Accumulate gradient for attention vector
          grads.da_upward[head][d] += dScore * math.leakyRelu(concatenated[d]);

          // Backprop to projections
          if (d < headDim) {
            // Child projection gradient
            for (let j = 0; j < childEmbs[c].length; j++) {
              grads.dW_child[head][d][j] += leakyGrad * (childEmbs[c][j] ?? 0);
            }
          } else {
            // Parent projection gradient
            const pd = d - headDim;
            for (let j = 0; j < parentEmbs[p].length; j++) {
              grads.dW_parent[head][pd][j] += leakyGrad * (parentEmbs[p][j] ?? 0);
            }
          }
        }

        // Backprop gradient to child embeddings through value projection
        const dValue = dValues[ci] ?? [];
        for (let d = 0; d < headDim; d++) {
          for (let j = 0; j < childEmbs[c].length; j++) {
            dE_child[c][j] += (dValue[d] ?? 0) * (params.W_child[head][d]?.[j] ?? 0);
          }
        }
      }
    }
  }

  return dE_child;
}

/**
 * Backward pass through a single downward phase (parent → child)
 *
 * Similar to upward but in reverse direction.
 *
 * @param dE_child Gradient w.r.t. child embeddings (after residual)
 * @param childEmbs Child embeddings
 * @param parentEmbs Parent embeddings
 * @param params Level parameters
 * @param intermediates Cached activations
 * @param grads Gradient accumulators
 * @param config SHGAT config
 * @returns Gradient w.r.t. parent embeddings
 */
export function backwardDownwardPhase(
  dE_child: number[][],
  childEmbs: number[][],
  parentEmbs: number[][],
  params: LevelParams,
  intermediates: LevelIntermediates,
  grads: LevelGradients,
  config: SHGATConfig,
): number[][] {
  const { numHeads } = config;
  const headDim = Math.floor(config.hiddenDim / numHeads);
  const numChildren = childEmbs.length;
  const numParents = parentEmbs.length;

  // Initialize gradient for parents
  const dE_parent: number[][] = parentEmbs.map((row) => row.map(() => 0));

  for (let head = 0; head < numHeads; head++) {
    const headStart = head * headDim;
    const headEnd = headStart + headDim;

    const parentProj = intermediates.parentProj[head] ?? [];
    const childProj = intermediates.childProj[head] ?? [];
    const attention = intermediates.attention[head] ?? [];
    const scores = intermediates.scores[head] ?? [];

    for (let c = 0; c < numChildren; c++) {
      // Extract head-specific gradient for this child
      const dE_head = dE_child[c]?.slice(headStart, headEnd) ?? [];

      // Get parents contributing to this child
      const parentsContributing: number[] = [];
      for (let p = 0; p < numParents; p++) {
        if ((attention[p]?.[c] ?? 0) > 0) {
          parentsContributing.push(p);
        }
      }

      if (parentsContributing.length === 0) continue;

      // Backprop through attention
      const parentAttentions = parentsContributing.map((p) => attention[p]?.[c] ?? 0);
      const parentValues = parentsContributing.map((p) => parentProj[p] ?? []);
      const parentScores = parentsContributing.map((p) => scores[p]?.[c] ?? 0);

      const { dScores, dValues } = backpropAttention(
        dE_head,
        parentAttentions,
        parentValues,
        parentScores,
      );

      // Backprop through score computation
      for (let pi = 0; pi < parentsContributing.length; pi++) {
        const p = parentsContributing[pi];
        const dScore = dScores[pi] ?? 0;

        const a = params.a_downward[head];
        const concatenated: number[] = [
          ...(parentProj[p] ?? []),
          ...(childProj[c] ?? []),
        ];

        for (let d = 0; d < concatenated.length; d++) {
          const leakyGrad = backpropLeakyRelu(concatenated[d], dScore * (a[d] ?? 0));

          grads.da_downward[head][d] += dScore * math.leakyRelu(concatenated[d]);

          if (d < headDim) {
            // Parent projection gradient
            for (let j = 0; j < parentEmbs[p].length; j++) {
              grads.dW_parent[head][d][j] += leakyGrad * (parentEmbs[p][j] ?? 0);
            }
          } else {
            // Child projection gradient
            const cd = d - headDim;
            for (let j = 0; j < childEmbs[c].length; j++) {
              grads.dW_child[head][cd][j] += leakyGrad * (childEmbs[c][j] ?? 0);
            }
          }
        }

        // Backprop to parent embeddings
        const dValue = dValues[pi] ?? [];
        for (let d = 0; d < headDim; d++) {
          for (let j = 0; j < parentEmbs[p].length; j++) {
            dE_parent[p][j] += (dValue[d] ?? 0) * (params.W_parent[head][d]?.[j] ?? 0);
          }
        }
      }
    }
  }

  return dE_parent;
}

// ============================================================================
// Main Backward Pass
// ============================================================================

/**
 * Full backward pass through multi-level message passing
 *
 * Propagates gradients:
 * 1. Through downward pass (reverse order): E^0 → E^1 → ... → E^L_max
 * 2. Through upward pass (reverse order): E^L_max → ... → E^0 → V
 *
 * @param dLoss Gradient of loss (scalar, typically 1.0 for BCE)
 * @param targetCapId ID of capability that received the loss
 * @param cache Forward cache with intermediate activations
 * @param toolEmbs Tool embeddings
 * @param levelParams Level parameters
 * @param hierarchyLevels Map of level → Set<capId>
 * @param grads Gradient accumulators to update
 * @param config SHGAT config
 */
export function backwardMultiLevel(
  dLoss: number,
  targetCapId: string,
  targetLevel: number,
  cache: ExtendedMultiLevelForwardCache,
  intentEmb: number[],
  levelParams: Map<number, LevelParams>,
  hierarchyLevels: Map<number, Set<string>>,
  grads: MultiLevelGradientAccumulators,
  config: SHGATConfig,
): void {
  const maxLevel = Math.max(...Array.from(hierarchyLevels.keys()));

  // Initialize gradients per level
  const dE = new Map<number, number[][]>();
  for (let l = 0; l <= maxLevel; l++) {
    const capsAtLevel = Array.from(hierarchyLevels.get(l) ?? []);
    const embDim = cache.E_final.get(l)?.[0]?.length ??
      config.numHeads * Math.floor(config.hiddenDim / config.numHeads);
    dE.set(l, capsAtLevel.map(() => new Array(embDim).fill(0)));
  }

  // Initialize gradient at target capability
  const capsAtTargetLevel = Array.from(hierarchyLevels.get(targetLevel) ?? []);
  const targetIdx = capsAtTargetLevel.indexOf(targetCapId);
  if (targetIdx >= 0) {
    const capEmb = cache.E_final.get(targetLevel)?.[targetIdx] ?? [];

    // Gradient of cosine similarity loss
    const dCapEmb = computeCosineSimilarityGradient(intentEmb, capEmb, dLoss);
    dE.get(targetLevel)![targetIdx] = dCapEmb;
  }

  // ========================================================================
  // BACKWARD THROUGH DOWNWARD PASS (reverse order)
  // ========================================================================
  // Original downward: E^L_max → ... → E^0 → V
  // Backward: E^0 → E^1 → ... → E^L_max

  for (let l = 0; l < maxLevel; l++) {
    const params = levelParams.get(l);
    const levelGrads = grads.levelGradients.get(l);
    if (!params || !levelGrads) continue;

    const intermediates = cache.intermediateDownwardActivations?.get(l);
    if (!intermediates) continue;

    const childEmbs = cache.E_final.get(l) ?? [];
    const parentEmbs = cache.E_final.get(l + 1) ?? [];

    const dChild = dE.get(l) ?? [];
    const dParent = backwardDownwardPhase(
      dChild,
      childEmbs,
      parentEmbs,
      params,
      intermediates,
      levelGrads,
      config,
    );

    // Accumulate gradient at parent level
    const currentDParent = dE.get(l + 1) ?? [];
    for (let i = 0; i < dParent.length; i++) {
      for (let j = 0; j < (dParent[i]?.length ?? 0); j++) {
        currentDParent[i][j] = (currentDParent[i]?.[j] ?? 0) + (dParent[i]?.[j] ?? 0);
      }
    }
    dE.set(l + 1, currentDParent);
  }

  // ========================================================================
  // BACKWARD THROUGH UPWARD PASS (reverse order)
  // ========================================================================
  // Original upward: V → E^0 → E^1 → ... → E^L_max
  // Backward: E^L_max → ... → E^0 → V

  for (let l = maxLevel; l >= 0; l--) {
    const params = levelParams.get(l);
    const levelGrads = grads.levelGradients.get(l);
    if (!params || !levelGrads) continue;

    const intermediates = cache.intermediateUpwardActivations?.get(l);
    if (!intermediates) continue;

    const parentEmbs = cache.E_init.get(l) ?? [];
    const childEmbs = l === 0 ? cache.H_init : (cache.E_init.get(l - 1) ?? []);

    const dParent = dE.get(l) ?? [];
    const dChild = backwardUpwardPhase(
      dParent,
      childEmbs,
      parentEmbs,
      params,
      intermediates,
      levelGrads,
      config,
    );

    // Accumulate gradient at child level
    if (l > 0) {
      const currentDChild = dE.get(l - 1) ?? [];
      for (let i = 0; i < dChild.length; i++) {
        for (let j = 0; j < (dChild[i]?.length ?? 0); j++) {
          currentDChild[i][j] = (currentDChild[i]?.[j] ?? 0) + (dChild[i]?.[j] ?? 0);
        }
      }
      dE.set(l - 1, currentDChild);
    }
    // For l === 0, dChild would propagate to tools (H) - can be used for further backprop if needed
  }
}

/**
 * Compute gradient of cosine similarity w.r.t. capability embedding
 *
 * cos(a, b) = (a · b) / (||a|| × ||b||)
 * d(cos)/d(b) = a/(||a||×||b||) - (a·b)×b/(||a||×||b||³)
 */
function computeCosineSimilarityGradient(
  intentEmb: number[],
  capEmb: number[],
  dLoss: number,
): number[] {
  const normIntent = Math.sqrt(intentEmb.reduce((s, x) => s + x * x, 0)) + 1e-8;
  const normCap = Math.sqrt(capEmb.reduce((s, x) => s + x * x, 0)) + 1e-8;
  const dotProduct = math.dot(intentEmb, capEmb);

  return capEmb.map((_, i) => {
    const term1 = (intentEmb[i] ?? 0) / (normIntent * normCap);
    const term2 = (dotProduct * (capEmb[i] ?? 0)) / (normIntent * normCap * normCap * normCap);
    return dLoss * (term1 - term2);
  });
}

// ============================================================================
// Gradient Application
// ============================================================================

/**
 * Apply accumulated gradients to level parameters
 *
 * Uses SGD with L2 regularization.
 *
 * @param grads Accumulated gradients
 * @param levelParams Level parameters to update
 * @param config SHGAT config
 * @param batchSize Batch size for averaging
 */
export function applyLevelGradients(
  grads: MultiLevelGradientAccumulators,
  levelParams: Map<number, LevelParams>,
  config: SHGATConfig,
  batchSize: number,
): void {
  const lr = config.learningRate / batchSize;
  const l2 = config.l2Lambda;

  for (const [level, params] of levelParams) {
    const levelGrads = grads.levelGradients.get(level);
    if (!levelGrads) continue;

    // Update W_child
    for (let h = 0; h < config.numHeads; h++) {
      for (let i = 0; i < (params.W_child[h]?.length ?? 0); i++) {
        for (let j = 0; j < (params.W_child[h]?.[i]?.length ?? 0); j++) {
          const grad = (levelGrads.dW_child[h]?.[i]?.[j] ?? 0) +
            l2 * (params.W_child[h][i][j] ?? 0);
          params.W_child[h][i][j] -= lr * grad;
        }
      }

      // Update W_parent
      for (let i = 0; i < (params.W_parent[h]?.length ?? 0); i++) {
        for (let j = 0; j < (params.W_parent[h]?.[i]?.length ?? 0); j++) {
          const grad = (levelGrads.dW_parent[h]?.[i]?.[j] ?? 0) +
            l2 * (params.W_parent[h][i][j] ?? 0);
          params.W_parent[h][i][j] -= lr * grad;
        }
      }

      // Update a_upward
      for (let d = 0; d < (params.a_upward[h]?.length ?? 0); d++) {
        const grad = (levelGrads.da_upward[h]?.[d] ?? 0) + l2 * (params.a_upward[h][d] ?? 0);
        params.a_upward[h][d] -= lr * grad;
      }

      // Update a_downward
      for (let d = 0; d < (params.a_downward[h]?.length ?? 0); d++) {
        const grad = (levelGrads.da_downward[h]?.[d] ?? 0) + l2 * (params.a_downward[h][d] ?? 0);
        params.a_downward[h][d] -= lr * grad;
      }
    }
  }
}

/**
 * Compute gradient norm for debugging/monitoring
 */
export function computeGradientNorm(grads: MultiLevelGradientAccumulators): number {
  let sumSquared = 0;

  for (const levelGrads of grads.levelGradients.values()) {
    // dW_child
    for (const headMat of levelGrads.dW_child) {
      for (const row of headMat) {
        for (const val of row) {
          sumSquared += val * val;
        }
      }
    }
    // dW_parent
    for (const headMat of levelGrads.dW_parent) {
      for (const row of headMat) {
        for (const val of row) {
          sumSquared += val * val;
        }
      }
    }
    // da_upward
    for (const row of levelGrads.da_upward) {
      for (const val of row) {
        sumSquared += val * val;
      }
    }
    // da_downward
    for (const row of levelGrads.da_downward) {
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
 * Create extended forward cache from basic cache
 *
 * Adds empty intermediate activation maps that will be populated during forward pass.
 */
export function createExtendedCache(
  basicCache: MultiLevelForwardCache,
): ExtendedMultiLevelForwardCache {
  return {
    ...basicCache,
    intermediateUpwardActivations: new Map(),
    intermediateDownwardActivations: new Map(),
  };
}

/**
 * Train multi-level SHGAT on a batch of examples
 *
 * @param examples Training examples with intent, targetCap, outcome
 * @param forwardFn Function to run forward pass
 * @param levelParams Level parameters
 * @param hierarchyLevels Hierarchy level mapping
 * @param config SHGAT config
 * @returns Training result with loss, accuracy, gradient norm
 */
export async function trainMultiLevelBatch(
  examples: Array<{
    intentEmbedding: number[];
    targetCapId: string;
    targetLevel: number;
    outcome: number; // 1 = success, 0 = failure
  }>,
  forwardFn: (intentEmb: number[]) => {
    cache: ExtendedMultiLevelForwardCache;
    scores: Map<string, number>;
  },
  levelParams: Map<number, LevelParams>,
  hierarchyLevels: Map<number, Set<string>>,
  config: SHGATConfig,
): Promise<MultiLevelTrainingResult> {
  // Yield to event loop
  await Promise.resolve();

  const grads = initMultiLevelGradients(levelParams);
  let totalLoss = 0;
  let correct = 0;

  for (const example of examples) {
    // Forward pass
    const { cache, scores } = forwardFn(example.intentEmbedding);

    // Get predicted score for target capability
    const predScore = scores.get(example.targetCapId) ?? 0.5;

    // Compute binary cross-entropy loss
    const loss = math.binaryCrossEntropy(predScore, example.outcome);
    totalLoss += loss;

    // Accuracy: prediction matches outcome
    const predicted = predScore > 0.5 ? 1 : 0;
    if (predicted === example.outcome) {
      correct++;
    }

    // Backward pass
    const dLoss = example.outcome === 1 ? -1 / (predScore + 1e-7) : 1 / (1 - predScore + 1e-7);

    backwardMultiLevel(
      dLoss,
      example.targetCapId,
      example.targetLevel,
      cache,
      example.intentEmbedding,
      levelParams,
      hierarchyLevels,
      grads,
      config,
    );
  }

  // Apply gradients
  applyLevelGradients(grads, levelParams, config, examples.length);

  const gradientNorm = computeGradientNorm(grads);

  return {
    loss: totalLoss / examples.length,
    accuracy: correct / examples.length,
    gradientNorm,
  };
}

// ============================================================================
// Online Learning (Production)
// ============================================================================

/**
 * Train SHGAT on a single example (online learning)
 *
 * Use this in production after each capability execution.
 * No epochs to manage - just call after each execution.
 *
 * @example
 * ```typescript
 * // After successful capability execution:
 * await trainOnSingleExample(
 *   { intentEmbedding, targetCapId, targetLevel, outcome: 1 },
 *   forwardFn, levelParams, hierarchyLevels, config
 * );
 * ```
 *
 * @param example Single training example
 * @param forwardFn Function to run forward pass
 * @param levelParams Level parameters
 * @param hierarchyLevels Hierarchy level mapping
 * @param config SHGAT config (learningRate applied directly, no batch averaging)
 * @returns Training result
 */
export async function trainOnSingleExample(
  example: {
    intentEmbedding: number[];
    targetCapId: string;
    targetLevel: number;
    outcome: number; // 1 = success, 0 = failure
  },
  forwardFn: (intentEmb: number[]) => {
    cache: ExtendedMultiLevelForwardCache;
    scores: Map<string, number>;
  },
  levelParams: Map<number, LevelParams>,
  hierarchyLevels: Map<number, Set<string>>,
  config: SHGATConfig,
): Promise<MultiLevelTrainingResult> {
  // Use batchSize=1 for single example (no averaging)
  return trainMultiLevelBatch(
    [example],
    forwardFn,
    levelParams,
    hierarchyLevels,
    config,
  );
}
