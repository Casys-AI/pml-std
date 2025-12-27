/**
 * DAG Scoring Config Loader
 *
 * Loads and validates DAG scoring configuration from YAML file.
 * Follows camelCase internal / snake_case external convention.
 *
 * @module graphrag/dag-scoring-config
 */

import { getLogger } from "../telemetry/logger.ts";
import { parse as parseYaml } from "@std/yaml";

const log = getLogger("default");

// =============================================================================
// Internal Config Types (camelCase)
// =============================================================================

export interface DagScoringLimits {
  hybridSearchCandidates: number;
  rankedCandidates: number;
  communityMembers: number;
  alternatives: number;
  replanCandidates: number;
  replanTop: number;
  episodeRetrieval: number;
  capabilityMatches: number;
  contextSearch: number;
  maxPathLength: number;
}

export interface DagScoringWeights {
  candidateRanking: {
    hybridScore: number;
    pagerank: number;
  };
  confidenceBase: {
    hybrid: number;
    pagerank: number;
    path: number;
  };
  confidenceScaling: {
    hybridDelta: number;
    pagerankDelta: number;
    pathDelta: number;
  };
  pagerankRationaleThreshold: number;
}

export interface DagScoringThresholds {
  suggestionReject: number;
  suggestionFloor: number;
  dependencyThreshold: number;
  replanThreshold: number;
  toolSearch: number;
  contextSearch: number;
  intentSearch: number;
  alternativeSuccessRate: number;
}

export interface DagScoringCaps {
  maxConfidence: number;
  edgeConfidenceFloor: number;
  edgeWeightMax: number;
  defaultNodeConfidence: number;
  finalScoreMinimum: number;
}

export interface DagScoringHopConfidence {
  hop1: number;
  hop2: number;
  hop3: number;
  hop4Plus: number;
}

export interface DagScoringCommunity {
  baseConfidence: number;
  pagerankMultiplier: number;
  pagerankBoostCap: number;
  edgeWeightMultiplier: number;
  edgeWeightBoostCap: number;
  adamicAdarMultiplier: number;
  adamicAdarBoostCap: number;
}

/**
 * Reliability factor configuration for capability matching (ADR-038 §3.1)
 */
export interface DagScoringReliability {
  /** Success rate below this triggers penalty (default: 0.5) */
  penaltyThreshold: number;
  /** Penalty factor applied when below threshold (default: 0.1) */
  penaltyFactor: number;
  /** Success rate above this triggers boost (default: 0.9) */
  boostThreshold: number;
  /** Boost factor applied when above threshold (default: 1.2) */
  boostFactor: number;
  /** Reliability below this marks as filtered_by_reliability (default: 0.2) */
  filterThreshold: number;
}

export interface DagScoringCooccurrence {
  countBoostFactor: number;
  countBoostCap: number;
  recencyBoost: number;
  recencyBoostCap: number;
}

export interface DagScoringEpisodic {
  successBoostFactor: number;
  successBoostCap: number;
  failurePenaltyFactor: number;
  failurePenaltyCap: number;
  failureExclusionRate: number;
  adjustmentLogThreshold: number;
}

export interface DagScoringAlternatives {
  scoreMultiplier: number;
  penaltyFactor: number;
}

export interface DagScoringCapability {
  confidenceFloor: number;
  confidenceCeiling: number;
  scoreScaling: number;
}

export interface DagScoringDefaults {
  alpha: number;
  pathConfidence: number;
  pagerankWeight: number;
}

export interface DagScoringConfig {
  limits: DagScoringLimits;
  weights: DagScoringWeights;
  thresholds: DagScoringThresholds;
  caps: DagScoringCaps;
  hopConfidence: DagScoringHopConfidence;
  community: DagScoringCommunity;
  cooccurrence: DagScoringCooccurrence;
  episodic: DagScoringEpisodic;
  alternatives: DagScoringAlternatives;
  capability: DagScoringCapability;
  reliability: DagScoringReliability;
  defaults: DagScoringDefaults;
}

// =============================================================================
// File Config Types (snake_case for YAML)
// =============================================================================

interface DagScoringFileConfig {
  limits?: {
    hybrid_search_candidates?: number;
    ranked_candidates?: number;
    community_members?: number;
    alternatives?: number;
    replan_candidates?: number;
    replan_top?: number;
    episode_retrieval?: number;
    capability_matches?: number;
    context_search?: number;
    max_path_length?: number;
  };
  weights?: {
    candidate_ranking?: {
      hybrid_score?: number;
      pagerank?: number;
    };
    confidence_base?: {
      hybrid?: number;
      pagerank?: number;
      path?: number;
    };
    confidence_scaling?: {
      hybrid_delta?: number;
      pagerank_delta?: number;
      path_delta?: number;
    };
    pagerank_rationale_threshold?: number;
  };
  thresholds?: {
    suggestion_reject?: number;
    suggestion_floor?: number;
    dependency_threshold?: number;
    replan_threshold?: number;
    tool_search?: number;
    context_search?: number;
    intent_search?: number;
    alternative_success_rate?: number;
  };
  caps?: {
    max_confidence?: number;
    edge_confidence_floor?: number;
    edge_weight_max?: number;
    default_node_confidence?: number;
    final_score_minimum?: number;
  };
  hop_confidence?: {
    hop_1?: number;
    hop_2?: number;
    hop_3?: number;
    hop_4_plus?: number;
  };
  community?: {
    base_confidence?: number;
    pagerank_multiplier?: number;
    pagerank_boost_cap?: number;
    edge_weight_multiplier?: number;
    edge_weight_boost_cap?: number;
    adamic_adar_multiplier?: number;
    adamic_adar_boost_cap?: number;
  };
  reliability?: {
    penalty_threshold?: number;
    penalty_factor?: number;
    boost_threshold?: number;
    boost_factor?: number;
    filter_threshold?: number;
  };
  cooccurrence?: {
    count_boost_factor?: number;
    count_boost_cap?: number;
    recency_boost?: number;
    recency_boost_cap?: number;
  };
  episodic?: {
    success_boost_factor?: number;
    success_boost_cap?: number;
    failure_penalty_factor?: number;
    failure_penalty_cap?: number;
    failure_exclusion_rate?: number;
    adjustment_log_threshold?: number;
  };
  alternatives?: {
    score_multiplier?: number;
    penalty_factor?: number;
  };
  capability?: {
    confidence_floor?: number;
    confidence_ceiling?: number;
    score_scaling?: number;
  };
  defaults?: {
    alpha?: number;
    path_confidence?: number;
    pagerank_weight?: number;
  };
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_DAG_SCORING_CONFIG: DagScoringConfig = {
  limits: {
    hybridSearchCandidates: 10,
    rankedCandidates: 5,
    communityMembers: 5,
    alternatives: 3,
    replanCandidates: 5,
    replanTop: 3,
    episodeRetrieval: 10,
    capabilityMatches: 3,
    contextSearch: 5,
    maxPathLength: 4,
  },
  weights: {
    candidateRanking: {
      hybridScore: 0.8,
      pagerank: 0.2,
    },
    confidenceBase: {
      hybrid: 0.55,
      pagerank: 0.30,
      path: 0.15,
    },
    confidenceScaling: {
      hybridDelta: 0.30,
      pagerankDelta: 0.25,
      pathDelta: 0.05,
    },
    pagerankRationaleThreshold: 0.01,
  },
  thresholds: {
    suggestionReject: 0.60,
    suggestionFloor: 0.65,
    dependencyThreshold: 0.50,
    replanThreshold: 0.50,
    toolSearch: 0.50,
    contextSearch: 0.30,
    intentSearch: 0.65,
    alternativeSuccessRate: 0.70,
  },
  caps: {
    maxConfidence: 0.95,
    edgeConfidenceFloor: 0.30,
    edgeWeightMax: 0.60,
    defaultNodeConfidence: 0.60,
    finalScoreMinimum: 0.40,
  },
  hopConfidence: {
    hop1: 0.95,
    hop2: 0.80,
    hop3: 0.65,
    hop4Plus: 0.50,
  },
  community: {
    baseConfidence: 0.40,
    pagerankMultiplier: 2.0,
    pagerankBoostCap: 0.20,
    edgeWeightMultiplier: 0.25,
    edgeWeightBoostCap: 0.25,
    adamicAdarMultiplier: 0.10,
    adamicAdarBoostCap: 0.10,
  },
  reliability: {
    penaltyThreshold: 0.50,
    penaltyFactor: 0.10,
    boostThreshold: 0.90,
    boostFactor: 1.20,
    filterThreshold: 0.20,
  },
  cooccurrence: {
    countBoostFactor: 0.05,
    countBoostCap: 0.20,
    recencyBoost: 0.10,
    recencyBoostCap: 0.10,
  },
  episodic: {
    successBoostFactor: 0.20,
    successBoostCap: 0.15,
    failurePenaltyFactor: 0.25,
    failurePenaltyCap: 0.15,
    failureExclusionRate: 0.50,
    adjustmentLogThreshold: 0.01,
  },
  alternatives: {
    scoreMultiplier: 0.90,
    penaltyFactor: 0.90,
  },
  capability: {
    confidenceFloor: 0.40,
    confidenceCeiling: 0.85,
    scoreScaling: 0.30,
  },
  defaults: {
    alpha: 0.75,
    pathConfidence: 0.50,
    pagerankWeight: 0.30,
  },
};

// =============================================================================
// Config Validation Error
// =============================================================================

export class DagScoringConfigError extends Error {
  constructor(
    public field: string,
    public value: unknown,
    public constraint: string,
  ) {
    super(`Invalid DAG scoring config: ${field}=${JSON.stringify(value)} - ${constraint}`);
    this.name = "DagScoringConfigError";
  }
}

// =============================================================================
// Validation
// =============================================================================

function validateDagScoringConfig(config: DagScoringConfig): void {
  const errors: string[] = [];

  const checkRange01 = (field: string, value: number) => {
    if (value < 0 || value > 1) {
      errors.push(`${field}=${value} must be in [0, 1]`);
    }
  };

  const checkPositiveInt = (field: string, value: number, max = 100) => {
    if (!Number.isInteger(value) || value < 1 || value > max) {
      errors.push(`${field}=${value} must be integer in [1, ${max}]`);
    }
  };

  // Limits
  checkPositiveInt("limits.hybridSearchCandidates", config.limits.hybridSearchCandidates, 50);
  checkPositiveInt("limits.rankedCandidates", config.limits.rankedCandidates, 20);
  checkPositiveInt("limits.communityMembers", config.limits.communityMembers, 20);
  checkPositiveInt("limits.alternatives", config.limits.alternatives, 10);
  checkPositiveInt("limits.maxPathLength", config.limits.maxPathLength, 10);

  // Weights
  checkRange01("weights.candidateRanking.hybridScore", config.weights.candidateRanking.hybridScore);
  checkRange01("weights.candidateRanking.pagerank", config.weights.candidateRanking.pagerank);
  checkRange01("weights.confidenceBase.hybrid", config.weights.confidenceBase.hybrid);
  checkRange01("weights.confidenceBase.pagerank", config.weights.confidenceBase.pagerank);
  checkRange01("weights.confidenceBase.path", config.weights.confidenceBase.path);

  // Thresholds
  checkRange01("thresholds.suggestionFloor", config.thresholds.suggestionFloor);
  checkRange01("thresholds.dependencyThreshold", config.thresholds.dependencyThreshold);
  checkRange01("thresholds.toolSearch", config.thresholds.toolSearch);
  checkRange01("thresholds.contextSearch", config.thresholds.contextSearch);
  checkRange01("thresholds.intentSearch", config.thresholds.intentSearch);
  checkRange01("thresholds.alternativeSuccessRate", config.thresholds.alternativeSuccessRate);

  // Caps
  checkRange01("caps.maxConfidence", config.caps.maxConfidence);
  if (config.caps.maxConfidence < 0.5) {
    errors.push(`caps.maxConfidence=${config.caps.maxConfidence} must be >= 0.5`);
  }
  checkRange01("caps.edgeConfidenceFloor", config.caps.edgeConfidenceFloor);
  checkRange01("caps.edgeWeightMax", config.caps.edgeWeightMax);

  // Hop confidence values must be in [0, 1] and decreasing
  const { hop1, hop2, hop3, hop4Plus } = config.hopConfidence;
  checkRange01("hopConfidence.hop1", hop1);
  checkRange01("hopConfidence.hop2", hop2);
  checkRange01("hopConfidence.hop3", hop3);
  checkRange01("hopConfidence.hop4Plus", hop4Plus);
  if (!(hop1 >= hop2 && hop2 >= hop3 && hop3 >= hop4Plus)) {
    errors.push(
      `hopConfidence should be decreasing: hop1=${hop1} >= hop2=${hop2} >= hop3=${hop3} >= hop4Plus=${hop4Plus}`,
    );
  }

  // Episodic
  checkRange01("episodic.failureExclusionRate", config.episodic.failureExclusionRate);

  // Capability ceiling > floor
  if (config.capability.confidenceFloor >= config.capability.confidenceCeiling) {
    errors.push(
      `capability.confidenceFloor (${config.capability.confidenceFloor}) must be < confidenceCeiling (${config.capability.confidenceCeiling})`,
    );
  }

  // Reliability (ADR-038 §3.1)
  checkRange01("reliability.penaltyThreshold", config.reliability.penaltyThreshold);
  checkRange01("reliability.boostThreshold", config.reliability.boostThreshold);
  checkRange01("reliability.filterThreshold", config.reliability.filterThreshold);
  if (config.reliability.penaltyFactor < 0 || config.reliability.penaltyFactor > 1) {
    errors.push(`reliability.penaltyFactor=${config.reliability.penaltyFactor} must be in [0, 1]`);
  }
  if (config.reliability.boostFactor < 1 || config.reliability.boostFactor > 2) {
    errors.push(`reliability.boostFactor=${config.reliability.boostFactor} must be in [1, 2]`);
  }
  if (config.reliability.penaltyThreshold >= config.reliability.boostThreshold) {
    errors.push(
      `reliability.penaltyThreshold (${config.reliability.penaltyThreshold}) must be < boostThreshold (${config.reliability.boostThreshold})`,
    );
  }

  // Defaults
  checkRange01("defaults.alpha", config.defaults.alpha);
  checkRange01("defaults.pathConfidence", config.defaults.pathConfidence);

  if (errors.length > 0) {
    throw new DagScoringConfigError("multiple", null, errors.join("; "));
  }
}

// =============================================================================
// Mapping Function
// =============================================================================

function toDagScoringConfig(file: DagScoringFileConfig): DagScoringConfig {
  const d = DEFAULT_DAG_SCORING_CONFIG;

  return {
    limits: {
      hybridSearchCandidates: file.limits?.hybrid_search_candidates ??
        d.limits.hybridSearchCandidates,
      rankedCandidates: file.limits?.ranked_candidates ?? d.limits.rankedCandidates,
      communityMembers: file.limits?.community_members ?? d.limits.communityMembers,
      alternatives: file.limits?.alternatives ?? d.limits.alternatives,
      replanCandidates: file.limits?.replan_candidates ?? d.limits.replanCandidates,
      replanTop: file.limits?.replan_top ?? d.limits.replanTop,
      episodeRetrieval: file.limits?.episode_retrieval ?? d.limits.episodeRetrieval,
      capabilityMatches: file.limits?.capability_matches ?? d.limits.capabilityMatches,
      contextSearch: file.limits?.context_search ?? d.limits.contextSearch,
      maxPathLength: file.limits?.max_path_length ?? d.limits.maxPathLength,
    },
    weights: {
      candidateRanking: {
        hybridScore: file.weights?.candidate_ranking?.hybrid_score ??
          d.weights.candidateRanking.hybridScore,
        pagerank: file.weights?.candidate_ranking?.pagerank ?? d.weights.candidateRanking.pagerank,
      },
      confidenceBase: {
        hybrid: file.weights?.confidence_base?.hybrid ?? d.weights.confidenceBase.hybrid,
        pagerank: file.weights?.confidence_base?.pagerank ?? d.weights.confidenceBase.pagerank,
        path: file.weights?.confidence_base?.path ?? d.weights.confidenceBase.path,
      },
      confidenceScaling: {
        hybridDelta: file.weights?.confidence_scaling?.hybrid_delta ??
          d.weights.confidenceScaling.hybridDelta,
        pagerankDelta: file.weights?.confidence_scaling?.pagerank_delta ??
          d.weights.confidenceScaling.pagerankDelta,
        pathDelta: file.weights?.confidence_scaling?.path_delta ??
          d.weights.confidenceScaling.pathDelta,
      },
      pagerankRationaleThreshold: file.weights?.pagerank_rationale_threshold ??
        d.weights.pagerankRationaleThreshold,
    },
    thresholds: {
      suggestionReject: file.thresholds?.suggestion_reject ?? d.thresholds.suggestionReject,
      suggestionFloor: file.thresholds?.suggestion_floor ?? d.thresholds.suggestionFloor,
      dependencyThreshold: file.thresholds?.dependency_threshold ??
        d.thresholds.dependencyThreshold,
      replanThreshold: file.thresholds?.replan_threshold ?? d.thresholds.replanThreshold,
      toolSearch: file.thresholds?.tool_search ?? d.thresholds.toolSearch,
      contextSearch: file.thresholds?.context_search ?? d.thresholds.contextSearch,
      intentSearch: file.thresholds?.intent_search ?? d.thresholds.intentSearch,
      alternativeSuccessRate: file.thresholds?.alternative_success_rate ??
        d.thresholds.alternativeSuccessRate,
    },
    caps: {
      maxConfidence: file.caps?.max_confidence ?? d.caps.maxConfidence,
      edgeConfidenceFloor: file.caps?.edge_confidence_floor ?? d.caps.edgeConfidenceFloor,
      edgeWeightMax: file.caps?.edge_weight_max ?? d.caps.edgeWeightMax,
      defaultNodeConfidence: file.caps?.default_node_confidence ?? d.caps.defaultNodeConfidence,
      finalScoreMinimum: file.caps?.final_score_minimum ?? d.caps.finalScoreMinimum,
    },
    hopConfidence: {
      hop1: file.hop_confidence?.hop_1 ?? d.hopConfidence.hop1,
      hop2: file.hop_confidence?.hop_2 ?? d.hopConfidence.hop2,
      hop3: file.hop_confidence?.hop_3 ?? d.hopConfidence.hop3,
      hop4Plus: file.hop_confidence?.hop_4_plus ?? d.hopConfidence.hop4Plus,
    },
    community: {
      baseConfidence: file.community?.base_confidence ?? d.community.baseConfidence,
      pagerankMultiplier: file.community?.pagerank_multiplier ?? d.community.pagerankMultiplier,
      pagerankBoostCap: file.community?.pagerank_boost_cap ?? d.community.pagerankBoostCap,
      edgeWeightMultiplier: file.community?.edge_weight_multiplier ??
        d.community.edgeWeightMultiplier,
      edgeWeightBoostCap: file.community?.edge_weight_boost_cap ?? d.community.edgeWeightBoostCap,
      adamicAdarMultiplier: file.community?.adamic_adar_multiplier ??
        d.community.adamicAdarMultiplier,
      adamicAdarBoostCap: file.community?.adamic_adar_boost_cap ?? d.community.adamicAdarBoostCap,
    },
    reliability: {
      penaltyThreshold: file.reliability?.penalty_threshold ?? d.reliability.penaltyThreshold,
      penaltyFactor: file.reliability?.penalty_factor ?? d.reliability.penaltyFactor,
      boostThreshold: file.reliability?.boost_threshold ?? d.reliability.boostThreshold,
      boostFactor: file.reliability?.boost_factor ?? d.reliability.boostFactor,
      filterThreshold: file.reliability?.filter_threshold ?? d.reliability.filterThreshold,
    },
    cooccurrence: {
      countBoostFactor: file.cooccurrence?.count_boost_factor ?? d.cooccurrence.countBoostFactor,
      countBoostCap: file.cooccurrence?.count_boost_cap ?? d.cooccurrence.countBoostCap,
      recencyBoost: file.cooccurrence?.recency_boost ?? d.cooccurrence.recencyBoost,
      recencyBoostCap: file.cooccurrence?.recency_boost_cap ?? d.cooccurrence.recencyBoostCap,
    },
    episodic: {
      successBoostFactor: file.episodic?.success_boost_factor ?? d.episodic.successBoostFactor,
      successBoostCap: file.episodic?.success_boost_cap ?? d.episodic.successBoostCap,
      failurePenaltyFactor: file.episodic?.failure_penalty_factor ??
        d.episodic.failurePenaltyFactor,
      failurePenaltyCap: file.episodic?.failure_penalty_cap ?? d.episodic.failurePenaltyCap,
      failureExclusionRate: file.episodic?.failure_exclusion_rate ??
        d.episodic.failureExclusionRate,
      adjustmentLogThreshold: file.episodic?.adjustment_log_threshold ??
        d.episodic.adjustmentLogThreshold,
    },
    alternatives: {
      scoreMultiplier: file.alternatives?.score_multiplier ?? d.alternatives.scoreMultiplier,
      penaltyFactor: file.alternatives?.penalty_factor ?? d.alternatives.penaltyFactor,
    },
    capability: {
      confidenceFloor: file.capability?.confidence_floor ?? d.capability.confidenceFloor,
      confidenceCeiling: file.capability?.confidence_ceiling ?? d.capability.confidenceCeiling,
      scoreScaling: file.capability?.score_scaling ?? d.capability.scoreScaling,
    },
    defaults: {
      alpha: file.defaults?.alpha ?? d.defaults.alpha,
      pathConfidence: file.defaults?.path_confidence ?? d.defaults.pathConfidence,
      pagerankWeight: file.defaults?.pagerank_weight ?? d.defaults.pagerankWeight,
    },
  };
}

// =============================================================================
// Loader
// =============================================================================

/**
 * Load DAG scoring config from YAML file
 * @throws DagScoringConfigError if validation fails
 */
export async function loadDagScoringConfig(
  configPath = "./config/dag-scoring.yaml",
): Promise<DagScoringConfig> {
  try {
    const content = await Deno.readTextFile(configPath);
    const parsed = parseYaml(content) as DagScoringFileConfig;
    const config = toDagScoringConfig(parsed);

    validateDagScoringConfig(config);

    log.debug(`[DagScoringConfig] Loaded and validated config from ${configPath}`);
    return config;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      log.debug(`[DagScoringConfig] Config not found at ${configPath}, using defaults`);
      return DEFAULT_DAG_SCORING_CONFIG;
    }
    if (error instanceof DagScoringConfigError) {
      log.error(`[DagScoringConfig] Validation failed: ${error.message}`);
      throw error;
    }
    log.error(`[DagScoringConfig] Failed to load config: ${error}`);
    return DEFAULT_DAG_SCORING_CONFIG;
  }
}
