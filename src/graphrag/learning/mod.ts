/**
 * Learning Module Exports
 *
 * Provides episodic memory integration and pattern import/export
 * for learning-enhanced predictions.
 *
 * @module graphrag/learning
 */

export {
  type EpisodicEvent,
  getContextHash,
  loadEpisodeStatistics,
  parseEpisodeStatistics,
  retrieveRelevantEpisodes,
} from "./episodic-adapter.ts";

export {
  exportLearnedPatterns,
  importLearnedPatterns,
  type LearnedPatternData,
  type PatternImport,
  registerAgentHint,
} from "./pattern-io.ts";

export {
  extractPathLevelFeatures,
  getFeaturesForTrace,
  getPathKey,
  type PathLevelFeatures,
} from "./path-level-features.ts";

export {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_TRACES,
  DEFAULT_MIN_PRIORITY,
  DEFAULT_MIN_TRACES,
  DEFAULT_PER_ALPHA,
  flattenExecutedPath,
  getExecutionCount,
  type PERTrainingOptions,
  type PERTrainingResult,
  resetExecutionCounter,
  shouldRunBatchTraining,
  type SubprocessPEROptions,
  traceToTrainingExamples,
  trainSHGATOnPathTraces,
  trainSHGATOnPathTracesSubprocess,
} from "./per-training.ts";

export {
  type OnlineLearningConfig,
  OnlineLearningController,
  startOnlineLearning,
} from "./online-learning.ts";
