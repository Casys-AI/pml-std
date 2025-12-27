/**
 * SHGAT Parameter Initialization Module
 *
 * Functions for initializing all learnable parameters in SHGAT:
 * - Layer parameters (W_v, W_e, attention vectors)
 * - Head parameters (W_q, W_k, W_v for each head)
 * - V2 parameters (W_proj, b_proj, fusionMLP, W_stats, b_stats)
 * - Intent projection (W_intent)
 *
 * Uses Xavier/He initialization for proper gradient flow.
 *
 * @module graphrag/algorithms/shgat/initialization/parameters
 */

import type { LevelParams, SHGATConfig } from "../types.ts";
import { DEFAULT_FEATURE_WEIGHTS, DEFAULT_FUSION_WEIGHTS, NUM_TRACE_STATS } from "../types.ts";
import type { FeatureWeights, FusionWeights } from "../types.ts";

// ============================================================================
// Parameter Types
// ============================================================================

/**
 * Layer parameters for message passing
 */
export interface LayerParams {
  // Vertex→Edge phase
  W_v: number[][][]; // [head][hiddenDim][inputDim]
  W_e: number[][][]; // [head][hiddenDim][inputDim]
  a_ve: number[][]; // [head][2*hiddenDim]

  // Edge→Vertex phase
  W_e2: number[][][]; // [head][hiddenDim][hiddenDim]
  W_v2: number[][][]; // [head][hiddenDim][hiddenDim]
  a_ev: number[][]; // [head][2*hiddenDim]
}

/**
 * Per-head attention parameters
 */
export interface HeadParams {
  W_q: number[][];
  W_k: number[][];
  W_v: number[][];
  a: number[];
}

/**
 * Fusion MLP parameters
 */
export interface FusionMLPParams {
  W1: number[][];
  b1: number[];
  W2: number[];
  b2: number;
}

/**
 * All SHGAT parameters
 */
export interface SHGATParams {
  // Layer parameters (v1)
  layerParams: LayerParams[];
  headParams: HeadParams[];

  // Legacy weights (v1)
  fusionWeights: FusionWeights;
  featureWeights: FeatureWeights;
  W_intent: number[][]; // [hiddenDim][embeddingDim] - projects intent to match E after concatHeads

  // V2 parameters
  W_proj: number[][];
  b_proj: number[];
  fusionMLP: FusionMLPParams;
  W_stats: number[][];
  b_stats: number[];
}

/**
 * V2 gradient accumulators
 */
export interface V2GradientAccumulators {
  W_proj: number[][];
  b_proj: number[];
  fusionMLP: {
    W1: number[][];
    b1: number[];
    W2: number[];
    b2: number;
  };
}

// ============================================================================
// Tensor Initialization
// ============================================================================

/**
 * Initialize 3D tensor with Xavier scaling
 */
export function initTensor3D(d1: number, d2: number, d3: number): number[][][] {
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

/**
 * Initialize 2D matrix with Xavier scaling
 */
export function initMatrix(rows: number, cols: number): number[][] {
  const scale = Math.sqrt(2.0 / (rows + cols));
  return Array.from(
    { length: rows },
    () => Array.from({ length: cols }, () => (Math.random() - 0.5) * 2 * scale),
  );
}

/**
 * Initialize 2D matrix with scaled Xavier initialization
 *
 * Used for K-head attention (W_q, W_k) where standard Xavier gives
 * values too small for Q·K to escape sigmoid(0) = 0.5.
 *
 * @param scaleFactor Multiplier for Xavier scale (default 10 for K-head)
 */
export function initMatrixScaled(rows: number, cols: number, scaleFactor: number = 10): number[][] {
  const scale = Math.sqrt(2.0 / (rows + cols)) * scaleFactor;
  return Array.from(
    { length: rows },
    () => Array.from({ length: cols }, () => (Math.random() - 0.5) * 2 * scale),
  );
}

/**
 * Initialize 1D vector
 */
export function initVector(size: number): number[] {
  const scale = Math.sqrt(1.0 / size);
  return Array.from({ length: size }, () => (Math.random() - 0.5) * 2 * scale);
}

/**
 * Create zeros matrix with same shape as input
 */
export function zerosLike2D(matrix: number[][]): number[][] {
  return matrix.map((row) => row.map(() => 0));
}

/**
 * Create zeros tensor with same shape as input
 */
export function zerosLike3D(tensor: number[][][]): number[][][] {
  return tensor.map((m) => m.map((r) => r.map(() => 0)));
}

// ============================================================================
// Parameter Initialization
// ============================================================================

/**
 * Initialize all SHGAT parameters
 */
export function initializeParameters(config: SHGATConfig): SHGATParams {
  const { numLayers, numHeads, hiddenDim, embeddingDim, mlpHiddenDim } = config;

  // Initialize layer parameters
  const layerParams: LayerParams[] = [];
  for (let l = 0; l < numLayers; l++) {
    // Layer 0: input is raw embedding (embeddingDim)
    // Layer k>0: input is previous layer output after concatHeads (hiddenDim)
    const layerInputDim = l === 0 ? embeddingDim : hiddenDim;

    layerParams.push({
      W_v: initTensor3D(numHeads, hiddenDim, layerInputDim),
      W_e: initTensor3D(numHeads, hiddenDim, layerInputDim),
      a_ve: initMatrix(numHeads, 2 * hiddenDim),

      W_e2: initTensor3D(numHeads, hiddenDim, hiddenDim),
      W_v2: initTensor3D(numHeads, hiddenDim, hiddenDim),
      a_ev: initMatrix(numHeads, 2 * hiddenDim),
    });
  }

  // Initialize head parameters
  // W_q, W_k use scaled init (× 10) for K-head attention to escape sigmoid(0) = 0.5
  const headParams: HeadParams[] = [];
  for (let h = 0; h < numHeads; h++) {
    headParams.push({
      W_q: initMatrixScaled(hiddenDim, embeddingDim, 10),
      W_k: initMatrixScaled(hiddenDim, embeddingDim, 10),
      W_v: initMatrix(hiddenDim, embeddingDim),
      a: initVector(2 * hiddenDim),
    });
  }

  // Initialize intent projection matrix
  // propagatedDim = hiddenDim (NOT numHeads * hiddenDim!)
  // This matches the output of message passing after concatHeads: numHeads * headDim = hiddenDim
  const propagatedDim = hiddenDim;
  const W_intent = initMatrix(propagatedDim, embeddingDim);

  // Initialize V2 parameters
  const numTraceStats = NUM_TRACE_STATS;
  const projInputDim = 3 * embeddingDim + numTraceStats;

  const W_proj = initMatrix(hiddenDim, projInputDim);
  const b_proj = initVector(hiddenDim);

  const W_stats = initMatrix(hiddenDim, numTraceStats);
  const b_stats = initVector(hiddenDim);

  const fusionMLP: FusionMLPParams = {
    W1: initMatrix(mlpHiddenDim, numHeads),
    b1: initVector(mlpHiddenDim),
    W2: initVector(mlpHiddenDim),
    b2: 0,
  };

  return {
    layerParams,
    headParams,
    fusionWeights: { ...DEFAULT_FUSION_WEIGHTS },
    featureWeights: { ...DEFAULT_FEATURE_WEIGHTS },
    W_intent,
    W_proj,
    b_proj,
    fusionMLP,
    W_stats,
    b_stats,
  };
}

/**
 * Initialize V2 gradient accumulators (used in training)
 */
export function initializeV2GradientAccumulators(config: SHGATConfig): V2GradientAccumulators {
  const { hiddenDim, mlpHiddenDim, embeddingDim, numHeads } = config;
  const numTraceStats = NUM_TRACE_STATS;
  const projInputDim = 3 * embeddingDim + numTraceStats;

  return {
    W_proj: Array.from({ length: hiddenDim }, () => Array(projInputDim).fill(0)),
    b_proj: new Array(hiddenDim).fill(0),
    fusionMLP: {
      W1: Array.from({ length: mlpHiddenDim }, () => Array(numHeads).fill(0)),
      b1: new Array(mlpHiddenDim).fill(0),
      W2: new Array(mlpHiddenDim).fill(0),
      b2: 0,
    },
  };
}

/**
 * Reset V2 gradient accumulators to zero
 */
export function resetV2GradientAccumulators(
  accum: V2GradientAccumulators,
  config: SHGATConfig,
): void {
  const { hiddenDim, mlpHiddenDim, embeddingDim, numHeads } = config;
  const numTraceStats = NUM_TRACE_STATS;
  const projInputDim = 3 * embeddingDim + numTraceStats;

  accum.W_proj = Array.from({ length: hiddenDim }, () => Array(projInputDim).fill(0));
  accum.b_proj = new Array(hiddenDim).fill(0);
  accum.fusionMLP = {
    W1: Array.from({ length: mlpHiddenDim }, () => Array(numHeads).fill(0)),
    b1: new Array(mlpHiddenDim).fill(0),
    W2: new Array(mlpHiddenDim).fill(0),
    b2: 0,
  };
}

// ============================================================================
// Multi-Level Parameter Initialization (n-SuperHyperGraph v1 refactor)
// ============================================================================

/**
 * Initialize parameters for multi-level message passing
 *
 * Creates LevelParams for each hierarchy level (0 to maxLevel).
 * Uses Xavier initialization for proper gradient flow.
 *
 * Dimension notes:
 * - Level 0: input is embeddingDim (from tools)
 * - Level k > 0: input is numHeads * headDim (after concat from previous level)
 * - All levels: headDim = hiddenDim / numHeads (per-head dimension)
 *
 * @param config SHGAT configuration
 * @param maxLevel Maximum hierarchy level (L_max)
 * @returns Map of level → LevelParams
 *
 * @since v1 refactor
 * @see 05-parameters.md
 */
export function initializeLevelParameters(
  config: SHGATConfig,
  maxLevel: number,
): Map<number, LevelParams> {
  const { numHeads, hiddenDim, embeddingDim } = config;
  const headDim = Math.floor(hiddenDim / numHeads);

  const levelParams = new Map<number, LevelParams>();

  for (let level = 0; level <= maxLevel; level++) {
    // Input dimension depends on level
    // Level 0: tools have embeddingDim
    // Level k > 0: capabilities have numHeads * headDim after concat
    const inputDim = level === 0 ? embeddingDim : numHeads * headDim;

    levelParams.set(level, {
      // Child projection: [numHeads][headDim][inputDim]
      W_child: initTensor3D(numHeads, headDim, inputDim),

      // Parent projection: [numHeads][headDim][inputDim]
      // Parents at level k receive from children, same input dim
      W_parent: initTensor3D(numHeads, headDim, inputDim),

      // Attention vectors for upward pass: [numHeads][2*headDim]
      a_upward: initMatrix(numHeads, 2 * headDim),

      // Attention vectors for downward pass: [numHeads][2*headDim]
      a_downward: initMatrix(numHeads, 2 * headDim),
    });
  }

  return levelParams;
}

/**
 * Count parameters for multi-level message passing
 *
 * @param config SHGAT configuration
 * @param maxLevel Maximum hierarchy level
 * @returns Total parameter count for level params
 */
export function countLevelParameters(
  config: SHGATConfig,
  maxLevel: number,
): number {
  const { numHeads, hiddenDim, embeddingDim } = config;
  const headDim = Math.floor(hiddenDim / numHeads);

  let count = 0;

  for (let level = 0; level <= maxLevel; level++) {
    const inputDim = level === 0 ? embeddingDim : numHeads * headDim;

    // W_child: numHeads * headDim * inputDim
    count += numHeads * headDim * inputDim;
    // W_parent: numHeads * headDim * inputDim
    count += numHeads * headDim * inputDim;
    // a_upward: numHeads * 2 * headDim
    count += numHeads * 2 * headDim;
    // a_downward: numHeads * 2 * headDim
    count += numHeads * 2 * headDim;
  }

  return count;
}

/**
 * Get parameters for a specific hierarchy level
 *
 * @param levelParams Map of all level parameters
 * @param level The hierarchy level to get
 * @returns LevelParams for the specified level
 * @throws Error if level not found
 */
export function getLevelParams(
  levelParams: Map<number, LevelParams>,
  level: number,
): LevelParams {
  const params = levelParams.get(level);
  if (!params) {
    throw new Error(
      `LevelParams not found for level ${level}. ` +
        `Available levels: ${Array.from(levelParams.keys()).join(", ")}`,
    );
  }
  return params;
}

/**
 * Export level parameters to JSON-serializable object
 *
 * Format: { "level_0": {...}, "level_1": {...}, ... }
 *
 * @param levelParams Map of level → LevelParams
 * @returns Serializable object
 */
export function exportLevelParams(
  levelParams: Map<number, LevelParams>,
): Record<string, LevelParams> {
  const result: Record<string, LevelParams> = {};

  for (const [level, params] of levelParams) {
    result[`level_${level}`] = {
      W_child: params.W_child,
      W_parent: params.W_parent,
      a_upward: params.a_upward,
      a_downward: params.a_downward,
    };
  }

  return result;
}

/**
 * Import level parameters from JSON object
 *
 * @param data Serialized level params
 * @returns Map of level → LevelParams
 */
export function importLevelParams(
  data: Record<string, LevelParams>,
): Map<number, LevelParams> {
  const levelParams = new Map<number, LevelParams>();

  for (const key of Object.keys(data)) {
    const level = parseInt(key.replace("level_", ""));
    if (isNaN(level)) continue;

    const params = data[key];
    levelParams.set(level, {
      W_child: params.W_child,
      W_parent: params.W_parent,
      a_upward: params.a_upward,
      a_downward: params.a_downward,
    });
  }

  return levelParams;
}

// ============================================================================
// Adaptive Configuration
// ============================================================================

/**
 * Adaptive heads configuration based on graph complexity
 *
 * More tools/capabilities = more heads can capture diverse patterns.
 * Also considers hierarchy depth for multi-level message passing.
 *
 * @param numTools Number of tools in graph
 * @param numCapabilities Number of capabilities
 * @param maxLevel Maximum hierarchy level (L_max)
 * @returns Recommended numHeads and hiddenDim
 */
export function getAdaptiveHeadsByGraphSize(
  numTools: number,
  numCapabilities: number,
  maxLevel: number = 0,
): { numHeads: number; hiddenDim: number; headDim: number } {
  const graphSize = numTools + numCapabilities;
  const complexityFactor = maxLevel + 1; // More levels = more complex

  // Base heads on graph size
  let numHeads: number;
  if (graphSize < 50) {
    numHeads = 4; // Small graph
  } else if (graphSize < 200) {
    numHeads = 6; // Medium graph
  } else if (graphSize < 500) {
    numHeads = 8; // Large graph
  } else if (graphSize < 1000) {
    numHeads = 12; // Very large graph
  } else {
    numHeads = 16; // Massive graph
  }

  // Increase heads for deep hierarchies (more levels = more patterns)
  if (complexityFactor >= 3) {
    numHeads = Math.min(16, numHeads + 2);
  } else if (complexityFactor >= 2) {
    numHeads = Math.min(16, numHeads + 1);
  }

  // Ensure numHeads is even (for symmetric attention)
  if (numHeads % 2 !== 0) {
    numHeads += 1;
  }

  // hiddenDim = numHeads * headDim (headDim typically 16 or 32)
  const headDim = graphSize < 200 ? 16 : 32;
  const hiddenDim = numHeads * headDim;

  return { numHeads, hiddenDim, headDim };
}

// ============================================================================
// Serialization Helpers
// ============================================================================

/**
 * Export parameters to JSON-serializable object
 */
export function exportParams(
  config: SHGATConfig,
  params: SHGATParams,
): Record<string, unknown> {
  return {
    config,
    layerParams: params.layerParams,
    headParams: params.headParams,
    fusionWeights: params.fusionWeights,
    featureWeights: params.featureWeights,
    W_intent: params.W_intent,
    W_proj: params.W_proj,
    b_proj: params.b_proj,
    fusionMLP: params.fusionMLP,
    W_stats: params.W_stats,
    b_stats: params.b_stats,
  };
}

/**
 * Import parameters from JSON object
 */
export function importParams(
  data: Record<string, unknown>,
  currentParams: SHGATParams,
): { config?: SHGATConfig; params: SHGATParams } {
  const params = { ...currentParams };
  let config: SHGATConfig | undefined;

  if (data.config) {
    config = data.config as SHGATConfig;
  }
  if (data.layerParams) {
    params.layerParams = data.layerParams as LayerParams[];
  }
  if (data.headParams) {
    params.headParams = data.headParams as HeadParams[];
  }
  if (data.fusionWeights) {
    params.fusionWeights = data.fusionWeights as FusionWeights;
  }
  if (data.featureWeights) {
    params.featureWeights = data.featureWeights as FeatureWeights;
  }
  if (data.W_intent) {
    params.W_intent = data.W_intent as number[][];
  }
  if (data.W_proj) {
    params.W_proj = data.W_proj as number[][];
  }
  if (data.b_proj) {
    params.b_proj = data.b_proj as number[];
  }
  if (data.fusionMLP) {
    params.fusionMLP = data.fusionMLP as FusionMLPParams;
  }
  if (data.W_stats) {
    params.W_stats = data.W_stats as number[][];
  }
  if (data.b_stats) {
    params.b_stats = data.b_stats as number[];
  }

  return { config, params };
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Count total parameters in the model
 */
export function countParameters(config: SHGATConfig): {
  v1ParamCount: number;
  v2ParamCount: number;
  total: number;
} {
  const { numHeads, hiddenDim, embeddingDim, numLayers, mlpHiddenDim } = config;
  const numTraceStats = NUM_TRACE_STATS;

  // V1 param count
  let v1ParamCount = 0;
  for (let l = 0; l < numLayers; l++) {
    // Layer 0: input is embeddingDim, Layer k>0: input is hiddenDim (after concatHeads)
    const layerInputDim = l === 0 ? embeddingDim : hiddenDim;
    v1ParamCount += numHeads * hiddenDim * layerInputDim * 2; // W_v, W_e
    v1ParamCount += numHeads * 2 * hiddenDim; // a_ve
    v1ParamCount += numHeads * hiddenDim * hiddenDim * 2; // W_e2, W_v2
    v1ParamCount += numHeads * 2 * hiddenDim; // a_ev
  }
  v1ParamCount += 3; // fusionWeights
  v1ParamCount += 3; // featureWeights
  v1ParamCount += hiddenDim * embeddingDim; // W_intent (hiddenDim = propagatedDim)

  // V2 param count
  const projInputDim = 3 * embeddingDim + numTraceStats;
  let v2ParamCount = 0;
  v2ParamCount += hiddenDim * projInputDim + hiddenDim; // W_proj, b_proj
  v2ParamCount += hiddenDim * numTraceStats + hiddenDim; // W_stats, b_stats
  v2ParamCount += numHeads * 3 * hiddenDim * hiddenDim; // headParams (W_q, W_k, W_v per head)
  v2ParamCount += mlpHiddenDim * numHeads + mlpHiddenDim; // fusionMLP W1, b1
  v2ParamCount += mlpHiddenDim + 1; // fusionMLP W2, b2

  return {
    v1ParamCount,
    v2ParamCount,
    total: v1ParamCount + v2ParamCount,
  };
}
