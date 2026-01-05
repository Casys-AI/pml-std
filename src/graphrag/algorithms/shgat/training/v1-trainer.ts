/**
 * SHGAT V1 Training Module
 *
 * Training logic for the legacy 3-head architecture:
 * - Head 0: Semantic (intent similarity)
 * - Head 1: Structure (PageRank + AdamicAdar)
 * - Head 2: Temporal (recency + heatDiffusion)
 *
 * Implements:
 * - Online learning (trainOnExample)
 * - Batch learning (trainBatch)
 * - TD Learning with Prioritized Experience Replay
 * - Backpropagation through message passing layers
 *
 * @module graphrag/algorithms/shgat/training/v1-trainer
 */

import type {
  FeatureWeights,
  ForwardCache,
  FusionWeights,
  SHGATConfig,
  TrainingExample,
} from "../types.ts";
import type { HeadParams, LayerParams } from "../initialization/parameters.ts";
import { random, zerosLike3D } from "../initialization/parameters.ts";
import * as math from "../utils/math.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Gradient accumulators for V1 training
 */
export interface V1GradientAccumulators {
  fusionGradients: FusionWeights;
  featureGradients: FeatureWeights;
  W_intent_gradients: number[][];
  layerGradients: Map<string, number[][][]>;
}

/**
 * Training result
 */
export interface TrainingResult {
  loss: number;
  accuracy: number;
  tdErrors: number[];
}

/**
 * Training context for V1
 */
export interface V1TrainingContext {
  config: SHGATConfig;
  layerParams: LayerParams[];
  headParams: HeadParams[];
  fusionWeights: FusionWeights;
  featureWeights: FeatureWeights;
  W_intent: number[][];
  getCapabilityIndex: (id: string) => number | undefined;
  getCapabilityNode: (
    id: string,
  ) => {
    successRate: number;
    hypergraphFeatures?: {
      hypergraphPageRank: number;
      adamicAdar?: number;
      recency: number;
      heatDiffusion?: number;
    };
  } | undefined;
  forward: () => { E: number[][]; cache: ForwardCache };
  projectIntent: (intent: number[]) => number[];
}

// ============================================================================
// Gradient Initialization
// ============================================================================

/**
 * Initialize gradient accumulators for V1 training
 */
export function initV1Gradients(
  config: SHGATConfig,
  layerParams: LayerParams[],
): V1GradientAccumulators {
  const grads = new Map<string, number[][][]>();

  for (let l = 0; l < config.numLayers; l++) {
    const params = layerParams[l];
    grads.set(`W_v_${l}`, zerosLike3D(params.W_v));
    grads.set(`W_e_${l}`, zerosLike3D(params.W_e));
  }

  // propagatedDim = hiddenDim (matches message passing output after concatHeads)
  const propagatedDim = config.hiddenDim;

  return {
    fusionGradients: { semantic: 0, structure: 0, temporal: 0 },
    featureGradients: { semantic: 0, structure: 0, temporal: 0 },
    W_intent_gradients: Array.from(
      { length: propagatedDim },
      () => Array(config.embeddingDim).fill(0),
    ),
    layerGradients: grads,
  };
}

/**
 * Reset gradient accumulators to zero
 */
export function resetV1Gradients(
  grads: V1GradientAccumulators,
  config: SHGATConfig,
  layerParams: LayerParams[],
): void {
  grads.fusionGradients = { semantic: 0, structure: 0, temporal: 0 };
  grads.featureGradients = { semantic: 0, structure: 0, temporal: 0 };

  // propagatedDim = hiddenDim (matches message passing output after concatHeads)
  const propagatedDim = config.hiddenDim;
  grads.W_intent_gradients = Array.from(
    { length: propagatedDim },
    () => Array(config.embeddingDim).fill(0),
  );

  for (let l = 0; l < config.numLayers; l++) {
    const params = layerParams[l];
    grads.layerGradients.set(`W_v_${l}`, zerosLike3D(params.W_v));
    grads.layerGradients.set(`W_e_${l}`, zerosLike3D(params.W_e));
  }
}

// ============================================================================
// Fusion Weights
// ============================================================================

/**
 * Compute normalized fusion weights via softmax
 */
export function computeFusionWeights(
  fusionWeights: FusionWeights,
  configWeights?: number[],
): FusionWeights {
  if (configWeights) {
    const [s, st, t] = configWeights;
    return { semantic: s, structure: st, temporal: t };
  }

  const raw = [fusionWeights.semantic, fusionWeights.structure, fusionWeights.temporal];
  const softmaxed = math.softmax(raw);
  return {
    semantic: softmaxed[0],
    structure: softmaxed[1],
    temporal: softmaxed[2],
  };
}

// ============================================================================
// Backward Pass
// ============================================================================

/**
 * Compute backward pass through layers
 */
export function backward(
  grads: V1GradientAccumulators,
  cache: ForwardCache,
  targetCapIdx: number,
  intentEmb: number[],
  dLoss: number,
  config: SHGATConfig,
): void {
  const { numLayers, numHeads, hiddenDim } = config;

  const E_final = cache.E[numLayers];
  const capEmb = E_final[targetCapIdx];

  // Gradient of cosine similarity
  const normIntent = Math.sqrt(intentEmb.reduce((s, x) => s + x * x, 0));
  const normCap = Math.sqrt(capEmb.reduce((s, x) => s + x * x, 0));
  const dot = math.dot(intentEmb, capEmb);

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
      const dW_v = grads.layerGradients.get(`W_v_${l}`)!;

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

/**
 * Accumulate gradients for W_intent from cosine similarity
 */
export function accumulateW_intentGradients(
  grads: V1GradientAccumulators,
  intentOriginal: number[],
  intentProjected: number[],
  capEmb: number[],
  dLoss: number,
): void {
  const propagatedDim = intentProjected.length;

  // Compute gradient of cosine similarity w.r.t. intentProjected
  const normIntent = Math.sqrt(intentProjected.reduce((s, x) => s + x * x, 0)) + 1e-8;
  const normCap = Math.sqrt(capEmb.reduce((s, x) => s + x * x, 0)) + 1e-8;
  const dot = math.dot(intentProjected, capEmb);

  // d(cos)/d(intentProj[i]) = capEmb[i]/(normIntent*normCap) - dot*intentProj[i]/(normIntent^3*normCap)
  const dIntentProj: number[] = new Array(propagatedDim);
  for (let i = 0; i < propagatedDim; i++) {
    const term1 = capEmb[i] / (normIntent * normCap);
    const term2 = (dot * intentProjected[i]) / (normIntent * normIntent * normIntent * normCap);
    dIntentProj[i] = dLoss * (term1 - term2);
  }

  // Accumulate gradients for W_intent
  for (let i = 0; i < propagatedDim; i++) {
    for (let j = 0; j < intentOriginal.length; j++) {
      grads.W_intent_gradients[i][j] += dIntentProj[i] * intentOriginal[j];
    }
  }
}

// ============================================================================
// Gradient Application
// ============================================================================

/**
 * Apply layer gradients with L2 regularization
 */
export function applyLayerGradients(
  grads: V1GradientAccumulators,
  layerParams: LayerParams[],
  config: SHGATConfig,
  batchSize: number,
): void {
  const lr = config.learningRate / batchSize;
  const l2 = config.l2Lambda;

  for (let l = 0; l < config.numLayers; l++) {
    const params = layerParams[l];
    const dW_v = grads.layerGradients.get(`W_v_${l}`)!;

    for (let h = 0; h < config.numHeads; h++) {
      for (let i = 0; i < params.W_v[h].length; i++) {
        for (let j = 0; j < params.W_v[h][i].length; j++) {
          const grad = dW_v[h][i][j] + l2 * params.W_v[h][i][j];
          params.W_v[h][i][j] -= lr * grad;
        }
      }
    }
  }
}

/**
 * Apply fusion weight gradients with L2 regularization
 */
export function applyFusionGradients(
  grads: V1GradientAccumulators,
  fusionWeights: FusionWeights,
  config: SHGATConfig,
  batchSize: number,
): void {
  const lr = config.learningRate / batchSize;
  const l2 = config.l2Lambda;

  fusionWeights.semantic -= lr * (grads.fusionGradients.semantic + l2 * fusionWeights.semantic);
  fusionWeights.structure -= lr * (grads.fusionGradients.structure + l2 * fusionWeights.structure);
  fusionWeights.temporal -= lr * (grads.fusionGradients.temporal + l2 * fusionWeights.temporal);
}

/**
 * Apply feature weight gradients with L2 regularization
 */
export function applyFeatureGradients(
  grads: V1GradientAccumulators,
  featureWeights: FeatureWeights,
  config: SHGATConfig,
  batchSize: number,
): void {
  const lr = config.learningRate / batchSize;
  const l2 = config.l2Lambda;

  featureWeights.semantic -= lr * (grads.featureGradients.semantic + l2 * featureWeights.semantic);
  featureWeights.structure -= lr *
    (grads.featureGradients.structure + l2 * featureWeights.structure);
  featureWeights.temporal -= lr * (grads.featureGradients.temporal + l2 * featureWeights.temporal);
}

/**
 * Apply W_intent gradients with L2 regularization
 */
export function applyW_intentGradients(
  grads: V1GradientAccumulators,
  W_intent: number[][],
  config: SHGATConfig,
  batchSize: number,
): void {
  const lr = config.learningRate / batchSize;
  const l2 = config.l2Lambda;

  for (let i = 0; i < W_intent.length; i++) {
    for (let j = 0; j < W_intent[i].length; j++) {
      const grad = grads.W_intent_gradients[i][j] + l2 * W_intent[i][j];
      W_intent[i][j] -= lr * grad;
    }
  }
}

// ============================================================================
// Training Utilities
// ============================================================================

/**
 * Train SHGAT on episodic events
 */
export async function trainOnEpisodes(
  trainBatchFn: (examples: TrainingExample[]) => TrainingResult,
  episodes: TrainingExample[],
  options: {
    epochs?: number;
    batchSize?: number;
    onEpoch?: (epoch: number, loss: number, accuracy: number) => void;
  } = {},
): Promise<{ finalLoss: number; finalAccuracy: number }> {
  // Yield to event loop for UI responsiveness during long training
  await Promise.resolve();

  const epochs = options.epochs ?? 1; // Default 1 epoch - more causes overfitting on small datasets
  const batchSize = options.batchSize || 32;

  let finalLoss = 0;
  let finalAccuracy = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const shuffled = [...episodes].sort(() => random() - 0.5);

    let epochLoss = 0;
    let epochAccuracy = 0;
    let batchCount = 0;

    for (let i = 0; i < shuffled.length; i += batchSize) {
      const batch = shuffled.slice(i, i + batchSize);
      const result = trainBatchFn(batch);

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
