/**
 * Tests for DAG Scoring Configuration (dag-scoring-config.ts)
 *
 * Tests the configuration loading, validation, and default values
 * for DAG suggestion scoring.
 *
 * @module tests/unit/graphrag/dag_scoring_config_test
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DagScoringConfigError,
  DEFAULT_DAG_SCORING_CONFIG,
  loadDagScoringConfig,
} from "../../../src/graphrag/dag-scoring-config.ts";

Deno.test("loadDagScoringConfig - returns defaults when file not found", async () => {
  const config = await loadDagScoringConfig("/nonexistent/path/config.yaml");
  assertEquals(config, DEFAULT_DAG_SCORING_CONFIG);
});

Deno.test("loadDagScoringConfig - loads from YAML file", async () => {
  // Create a temporary config file
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "test-dag-scoring.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
limits:
  hybrid_search_candidates: 15
  ranked_candidates: 8
  community_members: 6
  alternatives: 4
  replan_candidates: 6
  replan_top: 4
  episode_retrieval: 15
  capability_matches: 4
  context_search: 6
  max_path_length: 5

weights:
  candidate_ranking:
    hybrid_score: 0.7
    pagerank: 0.3
  confidence_base:
    hybrid: 0.50
    pagerank: 0.35
    path: 0.15
  confidence_scaling:
    hybrid_delta: 0.25
    pagerank_delta: 0.20
    path_delta: 0.05
  pagerank_rationale_threshold: 0.02

thresholds:
  suggestion_floor: 0.55
  dependency_threshold: 0.55
  replan_threshold: 0.55
  context_search: 0.35
  alternative_success_rate: 0.75

caps:
  max_confidence: 0.90
  edge_confidence_floor: 0.35
  edge_weight_max: 0.55
  default_node_confidence: 0.65
  final_score_minimum: 0.45

hop_confidence:
  hop_1: 0.90
  hop_2: 0.75
  hop_3: 0.60
  hop_4_plus: 0.45

community:
  base_confidence: 0.45
  pagerank_boost_cap: 0.25
  edge_weight_boost_cap: 0.30
  adamic_adar_boost_cap: 0.15

cooccurrence:
  count_boost_factor: 0.06
  count_boost_cap: 0.25
  recency_boost: 0.12
  recency_boost_cap: 0.12

episodic:
  success_boost_factor: 0.25
  success_boost_cap: 0.20
  failure_penalty_factor: 0.30
  failure_penalty_cap: 0.20
  failure_exclusion_rate: 0.55
  adjustment_log_threshold: 0.02

alternatives:
  score_multiplier: 0.85
  penalty_factor: 0.85

capability:
  confidence_floor: 0.45
  confidence_ceiling: 0.90
  score_scaling: 0.35

defaults:
  alpha: 0.80
  path_confidence: 0.55
  pagerank_weight: 0.35
`,
  );

  try {
    const config = await loadDagScoringConfig(tempFile);

    // Verify limits (snake_case -> camelCase mapping)
    assertEquals(config.limits.hybridSearchCandidates, 15);
    assertEquals(config.limits.rankedCandidates, 8);
    assertEquals(config.limits.communityMembers, 6);
    assertEquals(config.limits.alternatives, 4);
    assertEquals(config.limits.maxPathLength, 5);

    // Verify weights
    assertEquals(config.weights.candidateRanking.hybridScore, 0.7);
    assertEquals(config.weights.candidateRanking.pagerank, 0.3);
    assertEquals(config.weights.confidenceBase.hybrid, 0.50);
    assertEquals(config.weights.pagerankRationaleThreshold, 0.02);

    // Verify thresholds
    assertEquals(config.thresholds.suggestionFloor, 0.55);
    assertEquals(config.thresholds.alternativeSuccessRate, 0.75);

    // Verify caps
    assertEquals(config.caps.maxConfidence, 0.90);
    assertEquals(config.caps.finalScoreMinimum, 0.45);

    // Verify hop confidence
    assertEquals(config.hopConfidence.hop1, 0.90);
    assertEquals(config.hopConfidence.hop4Plus, 0.45);

    // Verify community
    assertEquals(config.community.baseConfidence, 0.45);

    // Verify episodic
    assertEquals(config.episodic.failureExclusionRate, 0.55);

    // Verify alternatives
    assertEquals(config.alternatives.scoreMultiplier, 0.85);

    // Verify capability
    assertEquals(config.capability.confidenceCeiling, 0.90);

    // Verify defaults
    assertEquals(config.defaults.alpha, 0.80);
    assertEquals(config.defaults.pagerankWeight, 0.35);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("DEFAULT_DAG_SCORING_CONFIG - has valid default values", () => {
  const config = DEFAULT_DAG_SCORING_CONFIG;

  // Verify limits are positive integers
  assertEquals(config.limits.hybridSearchCandidates, 10);
  assertEquals(config.limits.rankedCandidates, 5);
  assertEquals(config.limits.communityMembers, 5);
  assertEquals(config.limits.alternatives, 3);
  assertEquals(config.limits.maxPathLength, 4);

  // Verify weights sum to 1.0 for candidate ranking
  const rankingSum = config.weights.candidateRanking.hybridScore +
    config.weights.candidateRanking.pagerank;
  assertEquals(rankingSum, 1.0);

  // Verify confidence base weights sum to 1.0
  const baseSum = config.weights.confidenceBase.hybrid +
    config.weights.confidenceBase.pagerank +
    config.weights.confidenceBase.path;
  assertEquals(baseSum, 1.0);

  // Verify thresholds in [0, 1]
  assertEquals(config.thresholds.suggestionFloor >= 0, true);
  assertEquals(config.thresholds.suggestionFloor <= 1, true);

  // Verify caps in [0, 1]
  assertEquals(config.caps.maxConfidence >= 0.5, true);
  assertEquals(config.caps.maxConfidence <= 1, true);

  // Verify hop confidence decreases with distance
  assertEquals(config.hopConfidence.hop1 > config.hopConfidence.hop2, true);
  assertEquals(config.hopConfidence.hop2 > config.hopConfidence.hop3, true);
  assertEquals(config.hopConfidence.hop3 > config.hopConfidence.hop4Plus, true);

  // Verify defaults
  assertEquals(config.defaults.alpha, 0.75);
  assertEquals(config.defaults.pathConfidence, 0.50);
});

Deno.test("loadDagScoringConfig - rejects limits outside valid range", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-limits.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
limits:
  hybrid_search_candidates: 0
  ranked_candidates: 5
  community_members: 5
  alternatives: 3
`,
  );

  try {
    await assertRejects(
      async () => await loadDagScoringConfig(tempFile),
      DagScoringConfigError,
      "hybridSearchCandidates",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadDagScoringConfig - rejects weights outside [0, 1]", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-weights.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
limits:
  hybrid_search_candidates: 10
  ranked_candidates: 5
  community_members: 5
  alternatives: 3

weights:
  candidate_ranking:
    hybrid_score: 1.5
    pagerank: 0.2
`,
  );

  try {
    await assertRejects(
      async () => await loadDagScoringConfig(tempFile),
      DagScoringConfigError,
      "candidateRanking.hybridScore",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadDagScoringConfig - rejects thresholds outside [0, 1]", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-thresholds.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
limits:
  hybrid_search_candidates: 10
  ranked_candidates: 5
  community_members: 5
  alternatives: 3

thresholds:
  suggestion_floor: -0.1
  dependency_threshold: 0.5
`,
  );

  try {
    await assertRejects(
      async () => await loadDagScoringConfig(tempFile),
      DagScoringConfigError,
      "suggestionFloor",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadDagScoringConfig - rejects max_confidence < 0.5", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-caps.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
limits:
  hybrid_search_candidates: 10
  ranked_candidates: 5
  community_members: 5
  alternatives: 3

caps:
  max_confidence: 0.3
`,
  );

  try {
    await assertRejects(
      async () => await loadDagScoringConfig(tempFile),
      DagScoringConfigError,
      "maxConfidence",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadDagScoringConfig - partial config merges with defaults", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "partial-config.yaml");

  // Only provide limits, rest should be from defaults
  await Deno.writeTextFile(
    tempFile,
    `
limits:
  hybrid_search_candidates: 20
  ranked_candidates: 10
  community_members: 8
  alternatives: 5
`,
  );

  try {
    const config = await loadDagScoringConfig(tempFile);

    // Verify provided values
    assertEquals(config.limits.hybridSearchCandidates, 20);
    assertEquals(config.limits.rankedCandidates, 10);

    // Verify defaults are preserved for missing values
    assertEquals(
      config.limits.replanCandidates,
      DEFAULT_DAG_SCORING_CONFIG.limits.replanCandidates,
    );
    assertEquals(config.weights, DEFAULT_DAG_SCORING_CONFIG.weights);
    assertEquals(config.thresholds, DEFAULT_DAG_SCORING_CONFIG.thresholds);
    assertEquals(config.caps, DEFAULT_DAG_SCORING_CONFIG.caps);
    assertEquals(config.hopConfidence, DEFAULT_DAG_SCORING_CONFIG.hopConfidence);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadDagScoringConfig - validates hop confidence values", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-hop.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
limits:
  hybrid_search_candidates: 10
  ranked_candidates: 5
  community_members: 5
  alternatives: 3

hop_confidence:
  hop_1: 1.5
  hop_2: 0.8
  hop_3: 0.65
  hop_4_plus: 0.5
`,
  );

  try {
    await assertRejects(
      async () => await loadDagScoringConfig(tempFile),
      DagScoringConfigError,
      "hop1",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadDagScoringConfig - validates episodic learning values", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-episodic.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
limits:
  hybrid_search_candidates: 10
  ranked_candidates: 5
  community_members: 5
  alternatives: 3

episodic:
  success_boost_factor: 0.2
  success_boost_cap: 0.15
  failure_penalty_factor: 0.25
  failure_penalty_cap: 0.15
  failure_exclusion_rate: 1.5
`,
  );

  try {
    await assertRejects(
      async () => await loadDagScoringConfig(tempFile),
      DagScoringConfigError,
      "failureExclusionRate",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
