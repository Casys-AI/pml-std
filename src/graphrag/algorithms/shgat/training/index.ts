/**
 * SHGAT Training Module
 *
 * Training logic for SHGAT networks.
 *
 * @module graphrag/algorithms/shgat/training
 */

// V1 Training (3-head architecture)
export {
  accumulateW_intentGradients,
  applyFeatureGradients,
  applyFusionGradients,
  applyLayerGradients,
  applyW_intentGradients,
  backward,
  computeFusionWeights,
  initV1Gradients,
  resetV1Gradients,
  type TrainingResult,
  trainOnEpisodes,
  type V1GradientAccumulators,
} from "./v1-trainer.ts";

// V2 Training (multi-head with TraceFeatures)
export {
  applyV2Gradients,
  backwardV2,
  buildTraceFeatures,
  computeHeadScores,
  createDefaultTraceStatsFromFeatures,
  forwardV2WithCache,
  fusionMLPForward,
  traceStatsToVector,
  type V2ForwardCache,
} from "./v2-trainer.ts";

// Multi-Level Training (n-SuperHyperGraph v1 refactor)
export {
  applyLevelGradients,
  backpropAttention,
  backpropLeakyRelu,
  backwardDownwardPhase,
  backwardMultiLevel,
  backwardUpwardPhase,
  computeGradientNorm,
  createExtendedCache,
  type ExtendedMultiLevelForwardCache,
  initMultiLevelGradients,
  type LevelGradients,
  type LevelIntermediates,
  type MultiLevelGradientAccumulators,
  type MultiLevelTrainingResult,
  resetMultiLevelGradients,
  trainMultiLevelBatch,
  trainOnSingleExample, // Online learning for production
} from "./multi-level-trainer.ts";

// Multi-Level K-Head Training (K-head attention scoring)
export {
  applyKHeadGradients,
  applyWIntentGradients,
  backpropKHeadScore,
  backpropMultiHeadKHead,
  backpropWIntent,
  computeKHeadGradientNorm,
  computeKHeadScoreWithCache,
  computeMultiHeadKHeadScoresWithCache,
  initMultiLevelKHeadGradients,
  type KHeadForwardContext,
  type KHeadGradientAccumulators,
  type MultiLevelKHeadGradientAccumulators,
  type MultiLevelKHeadTrainingResult,
  resetMultiLevelKHeadGradients,
  trainMultiLevelKHeadBatch,
  trainOnSingleKHeadExample, // Online learning for K-head scoring
} from "./multi-level-trainer-khead.ts";
