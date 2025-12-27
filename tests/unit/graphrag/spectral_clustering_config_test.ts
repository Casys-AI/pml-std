/**
 * Tests for Spectral Clustering Configuration
 *
 * Tests the configuration loading, validation, and default values.
 *
 * @module tests/unit/graphrag/spectral_clustering_config_test
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DEFAULT_SPECTRAL_CLUSTERING_CONFIG,
  loadSpectralClusteringConfig,
  SpectralClusteringConfigError,
} from "../../../src/graphrag/spectral-clustering-config.ts";

Deno.test("loadSpectralClusteringConfig - returns defaults when file not found", async () => {
  const config = await loadSpectralClusteringConfig("/nonexistent/path/config.yaml");
  assertEquals(config, DEFAULT_SPECTRAL_CLUSTERING_CONFIG);
});

Deno.test("loadSpectralClusteringConfig - loads from YAML file", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "test-spectral.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
edge_weights:
  dependency: 1.2
  contains: 0.9
  alternative: 0.7
  sequence: 0.6

cache:
  ttl_minutes: 10

edges:
  min_confidence: 0.4

cluster_detection:
  max_eigenvalues: 15
  min_clusters: 3
  max_clusters: 8

kmeans:
  max_iterations: 200

cluster_boost:
  same_cluster: 0.6
  partial_multiplier: 0.3

pagerank:
  damping_factor: 0.90
  max_iterations: 150
  convergence_threshold: 0.00001
`,
  );

  try {
    const config = await loadSpectralClusteringConfig(tempFile);

    // Verify edge weights (snake_case -> camelCase)
    assertEquals(config.edgeWeights.dependency, 1.2);
    assertEquals(config.edgeWeights.contains, 0.9);
    assertEquals(config.edgeWeights.alternative, 0.7);
    assertEquals(config.edgeWeights.sequence, 0.6);

    // Verify cache
    assertEquals(config.cache.ttlMinutes, 10);

    // Verify edges
    assertEquals(config.edges.minConfidence, 0.4);

    // Verify cluster detection
    assertEquals(config.clusterDetection.maxEigenvalues, 15);
    assertEquals(config.clusterDetection.minClusters, 3);
    assertEquals(config.clusterDetection.maxClusters, 8);

    // Verify kmeans
    assertEquals(config.kmeans.maxIterations, 200);

    // Verify cluster boost
    assertEquals(config.clusterBoost.sameCluster, 0.6);
    assertEquals(config.clusterBoost.partialMultiplier, 0.3);

    // Verify pagerank
    assertEquals(config.pagerank.dampingFactor, 0.90);
    assertEquals(config.pagerank.maxIterations, 150);
    assertEquals(config.pagerank.convergenceThreshold, 0.00001);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("DEFAULT_SPECTRAL_CLUSTERING_CONFIG - has valid default values", () => {
  const config = DEFAULT_SPECTRAL_CLUSTERING_CONFIG;

  // Verify edge weights are decreasing by relationship strength
  assertEquals(config.edgeWeights.dependency >= config.edgeWeights.contains, true);
  assertEquals(config.edgeWeights.contains >= config.edgeWeights.alternative, true);
  assertEquals(config.edgeWeights.alternative >= config.edgeWeights.sequence, true);

  // Verify cache TTL is reasonable
  assertEquals(config.cache.ttlMinutes, 5);

  // Verify edges threshold
  assertEquals(config.edges.minConfidence, 0.3);

  // Verify cluster detection
  assertEquals(config.clusterDetection.minClusters, 2);
  assertEquals(config.clusterDetection.maxClusters, 5);
  assertEquals(config.clusterDetection.minClusters < config.clusterDetection.maxClusters, true);

  // Verify kmeans
  assertEquals(config.kmeans.maxIterations, 100);

  // Verify cluster boost in [0, 1]
  assertEquals(config.clusterBoost.sameCluster >= 0, true);
  assertEquals(config.clusterBoost.sameCluster <= 1, true);

  // Verify pagerank defaults
  assertEquals(config.pagerank.dampingFactor, 0.85);
  assertEquals(config.pagerank.convergenceThreshold, 1e-6);
});

Deno.test("loadSpectralClusteringConfig - rejects invalid edge weights", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-weights.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
edge_weights:
  dependency: 3.0
  contains: 0.8
  alternative: 0.6
  sequence: 0.5
`,
  );

  try {
    await assertRejects(
      async () => await loadSpectralClusteringConfig(tempFile),
      SpectralClusteringConfigError,
      "edgeWeights.dependency",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadSpectralClusteringConfig - rejects min > max clusters", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-clusters.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
cluster_detection:
  max_eigenvalues: 10
  min_clusters: 8
  max_clusters: 3
`,
  );

  try {
    await assertRejects(
      async () => await loadSpectralClusteringConfig(tempFile),
      SpectralClusteringConfigError,
      "minClusters",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadSpectralClusteringConfig - rejects invalid cache TTL", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-cache.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
cache:
  ttl_minutes: 0
`,
  );

  try {
    await assertRejects(
      async () => await loadSpectralClusteringConfig(tempFile),
      SpectralClusteringConfigError,
      "ttlMinutes",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadSpectralClusteringConfig - rejects invalid damping factor", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-pagerank.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
pagerank:
  damping_factor: 1.5
  max_iterations: 100
  convergence_threshold: 0.000001
`,
  );

  try {
    await assertRejects(
      async () => await loadSpectralClusteringConfig(tempFile),
      SpectralClusteringConfigError,
      "dampingFactor",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadSpectralClusteringConfig - partial config merges with defaults", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "partial-config.yaml");

  // Only provide edge_weights
  await Deno.writeTextFile(
    tempFile,
    `
edge_weights:
  dependency: 1.5
  contains: 1.0
  alternative: 0.8
  sequence: 0.6
`,
  );

  try {
    const config = await loadSpectralClusteringConfig(tempFile);

    // Verify provided values
    assertEquals(config.edgeWeights.dependency, 1.5);
    assertEquals(config.edgeWeights.contains, 1.0);

    // Verify defaults are preserved for missing values
    assertEquals(config.cache, DEFAULT_SPECTRAL_CLUSTERING_CONFIG.cache);
    assertEquals(config.edges, DEFAULT_SPECTRAL_CLUSTERING_CONFIG.edges);
    assertEquals(config.clusterDetection, DEFAULT_SPECTRAL_CLUSTERING_CONFIG.clusterDetection);
    assertEquals(config.kmeans, DEFAULT_SPECTRAL_CLUSTERING_CONFIG.kmeans);
    assertEquals(config.clusterBoost, DEFAULT_SPECTRAL_CLUSTERING_CONFIG.clusterBoost);
    assertEquals(config.pagerank, DEFAULT_SPECTRAL_CLUSTERING_CONFIG.pagerank);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadSpectralClusteringConfig - rejects negative confidence threshold", async () => {
  const tempDir = await Deno.makeTempDir();
  const tempFile = join(tempDir, "invalid-edges.yaml");

  await Deno.writeTextFile(
    tempFile,
    `
edges:
  min_confidence: -0.1
`,
  );

  try {
    await assertRejects(
      async () => await loadSpectralClusteringConfig(tempFile),
      SpectralClusteringConfigError,
      "minConfidence",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
