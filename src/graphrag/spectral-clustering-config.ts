/**
 * Spectral Clustering Configuration Loader
 *
 * Loads and validates configuration for bipartite graph clustering.
 * Supports YAML config with JSON Schema validation.
 *
 * Convention: snake_case in YAML → camelCase in TypeScript
 *
 * @module graphrag/spectral-clustering-config
 */

import { parse as parseYaml } from "@std/yaml";
import { getLogger } from "../telemetry/logger.ts";

const log = getLogger("default");

// =============================================================================
// Internal Types (camelCase)
// =============================================================================

/**
 * Edge type weights for capability relationships
 * Story 10.3: Added "provides" for data flow relationships
 */
export interface SpectralEdgeWeights {
  dependency: number;
  contains: number;
  alternative: number;
  provides: number;
  sequence: number;
}

/**
 * Cache configuration
 */
export interface SpectralCacheConfig {
  ttlMinutes: number;
}

/**
 * Edge filtering configuration
 */
export interface SpectralEdgesConfig {
  minConfidence: number;
}

/**
 * Cluster detection parameters
 */
export interface SpectralClusterDetection {
  maxEigenvalues: number;
  minClusters: number;
  maxClusters: number;
}

/**
 * K-means configuration
 */
export interface SpectralKmeansConfig {
  maxIterations: number;
}

/**
 * Cluster boost configuration
 */
export interface SpectralClusterBoost {
  sameCluster: number;
  partialMultiplier: number;
}

/**
 * PageRank configuration
 */
export interface SpectralPagerankConfig {
  dampingFactor: number;
  maxIterations: number;
  convergenceThreshold: number;
}

/**
 * Complete spectral clustering configuration (internal camelCase)
 */
export interface SpectralClusteringConfig {
  edgeWeights: SpectralEdgeWeights;
  cache: SpectralCacheConfig;
  edges: SpectralEdgesConfig;
  clusterDetection: SpectralClusterDetection;
  kmeans: SpectralKmeansConfig;
  clusterBoost: SpectralClusterBoost;
  pagerank: SpectralPagerankConfig;
}

// =============================================================================
// File Types (snake_case - matches YAML)
// =============================================================================

interface SpectralEdgeWeightsFile {
  dependency?: number;
  contains?: number;
  alternative?: number;
  provides?: number;
  sequence?: number;
}

interface SpectralCacheFile {
  ttl_minutes?: number;
}

interface SpectralEdgesFile {
  min_confidence?: number;
}

interface SpectralClusterDetectionFile {
  max_eigenvalues?: number;
  min_clusters?: number;
  max_clusters?: number;
}

interface SpectralKmeansFile {
  max_iterations?: number;
}

interface SpectralClusterBoostFile {
  same_cluster?: number;
  partial_multiplier?: number;
}

interface SpectralPagerankFile {
  damping_factor?: number;
  max_iterations?: number;
  convergence_threshold?: number;
}

interface SpectralClusteringFileConfig {
  edge_weights?: SpectralEdgeWeightsFile;
  cache?: SpectralCacheFile;
  edges?: SpectralEdgesFile;
  cluster_detection?: SpectralClusterDetectionFile;
  kmeans?: SpectralKmeansFile;
  cluster_boost?: SpectralClusterBoostFile;
  pagerank?: SpectralPagerankFile;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_SPECTRAL_CLUSTERING_CONFIG: SpectralClusteringConfig = {
  edgeWeights: {
    dependency: 1.0,
    contains: 0.8,
    alternative: 0.6,
    provides: 0.7, // Story 10.3: Data flow (between contains and sequence)
    sequence: 0.5,
  },
  cache: {
    ttlMinutes: 5,
  },
  edges: {
    minConfidence: 0.3,
  },
  clusterDetection: {
    maxEigenvalues: 10,
    minClusters: 2,
    maxClusters: 5,
  },
  kmeans: {
    maxIterations: 100,
  },
  clusterBoost: {
    sameCluster: 0.5,
    partialMultiplier: 0.25,
  },
  pagerank: {
    dampingFactor: 0.85,
    maxIterations: 100,
    convergenceThreshold: 1e-6,
  },
};

// =============================================================================
// Error Class
// =============================================================================

export class SpectralClusteringConfigError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    message: string,
  ) {
    super(`Invalid spectral clustering config: ${field}=${value} - ${message}`);
    this.name = "SpectralClusteringConfigError";
  }
}

// =============================================================================
// Validation
// =============================================================================

function validateSpectralClusteringConfig(config: SpectralClusteringConfig): void {
  const errors: string[] = [];

  // Helper for range checks
  const checkRange = (name: string, value: number, min: number, max: number) => {
    if (value < min || value > max) {
      errors.push(`${name}=${value} must be in [${min}, ${max}]`);
    }
  };

  const checkPositiveInt = (name: string, value: number, min: number, max: number) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${name}=${value} must be integer in [${min}, ${max}]`);
    }
  };

  // Edge weights (0-2 range for flexibility)
  checkRange("edgeWeights.dependency", config.edgeWeights.dependency, 0, 2);
  checkRange("edgeWeights.contains", config.edgeWeights.contains, 0, 2);
  checkRange("edgeWeights.alternative", config.edgeWeights.alternative, 0, 2);
  checkRange("edgeWeights.provides", config.edgeWeights.provides, 0, 2);
  checkRange("edgeWeights.sequence", config.edgeWeights.sequence, 0, 2);

  // Cache
  checkPositiveInt("cache.ttlMinutes", config.cache.ttlMinutes, 1, 60);

  // Edges
  checkRange("edges.minConfidence", config.edges.minConfidence, 0, 1);

  // Cluster detection
  checkPositiveInt("clusterDetection.maxEigenvalues", config.clusterDetection.maxEigenvalues, 2, 50);
  checkPositiveInt("clusterDetection.minClusters", config.clusterDetection.minClusters, 1, 10);
  checkPositiveInt("clusterDetection.maxClusters", config.clusterDetection.maxClusters, 2, 20);

  if (config.clusterDetection.minClusters > config.clusterDetection.maxClusters) {
    errors.push(
      `clusterDetection.minClusters (${config.clusterDetection.minClusters}) must be <= maxClusters (${config.clusterDetection.maxClusters})`,
    );
  }

  // K-means
  checkPositiveInt("kmeans.maxIterations", config.kmeans.maxIterations, 10, 1000);

  // Cluster boost
  checkRange("clusterBoost.sameCluster", config.clusterBoost.sameCluster, 0, 1);
  checkRange("clusterBoost.partialMultiplier", config.clusterBoost.partialMultiplier, 0, 1);

  // PageRank
  checkRange("pagerank.dampingFactor", config.pagerank.dampingFactor, 0, 1);
  checkPositiveInt("pagerank.maxIterations", config.pagerank.maxIterations, 10, 1000);
  checkRange("pagerank.convergenceThreshold", config.pagerank.convergenceThreshold, 0, 0.01);

  if (errors.length > 0) {
    throw new SpectralClusteringConfigError("multiple", null, errors.join("; "));
  }
}

// =============================================================================
// Mapping Function
// =============================================================================

function toSpectralClusteringConfig(file: SpectralClusteringFileConfig): SpectralClusteringConfig {
  const d = DEFAULT_SPECTRAL_CLUSTERING_CONFIG;

  return {
    edgeWeights: {
      dependency: file.edge_weights?.dependency ?? d.edgeWeights.dependency,
      contains: file.edge_weights?.contains ?? d.edgeWeights.contains,
      alternative: file.edge_weights?.alternative ?? d.edgeWeights.alternative,
      provides: file.edge_weights?.provides ?? d.edgeWeights.provides,
      sequence: file.edge_weights?.sequence ?? d.edgeWeights.sequence,
    },
    cache: {
      ttlMinutes: file.cache?.ttl_minutes ?? d.cache.ttlMinutes,
    },
    edges: {
      minConfidence: file.edges?.min_confidence ?? d.edges.minConfidence,
    },
    clusterDetection: {
      maxEigenvalues: file.cluster_detection?.max_eigenvalues ?? d.clusterDetection.maxEigenvalues,
      minClusters: file.cluster_detection?.min_clusters ?? d.clusterDetection.minClusters,
      maxClusters: file.cluster_detection?.max_clusters ?? d.clusterDetection.maxClusters,
    },
    kmeans: {
      maxIterations: file.kmeans?.max_iterations ?? d.kmeans.maxIterations,
    },
    clusterBoost: {
      sameCluster: file.cluster_boost?.same_cluster ?? d.clusterBoost.sameCluster,
      partialMultiplier: file.cluster_boost?.partial_multiplier ?? d.clusterBoost.partialMultiplier,
    },
    pagerank: {
      dampingFactor: file.pagerank?.damping_factor ?? d.pagerank.dampingFactor,
      maxIterations: file.pagerank?.max_iterations ?? d.pagerank.maxIterations,
      convergenceThreshold: file.pagerank?.convergence_threshold ?? d.pagerank.convergenceThreshold,
    },
  };
}

// =============================================================================
// Loader Function
// =============================================================================

/**
 * Load spectral clustering configuration from YAML file
 *
 * @param configPath - Path to YAML config file
 * @returns Validated configuration (camelCase)
 */
export async function loadSpectralClusteringConfig(
  configPath = "./config/spectral-clustering.yaml",
): Promise<SpectralClusteringConfig> {
  try {
    const content = await Deno.readTextFile(configPath);
    const fileConfig = parseYaml(content) as SpectralClusteringFileConfig;
    const config = toSpectralClusteringConfig(fileConfig);

    validateSpectralClusteringConfig(config);

    log.info(`[SpectralClustering] Config loaded from ${configPath}`);
    return config;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      log.info(`[SpectralClustering] Config not found at ${configPath}, using defaults`);
      return DEFAULT_SPECTRAL_CLUSTERING_CONFIG;
    }

    if (error instanceof SpectralClusteringConfigError) {
      log.error(`[SpectralClustering] Validation failed: ${error.message}`);
      throw error;
    }

    log.error(`[SpectralClustering] Failed to load config: ${error}`);
    return DEFAULT_SPECTRAL_CLUSTERING_CONFIG;
  }
}
