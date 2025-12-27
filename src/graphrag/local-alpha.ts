/**
 * Local Adaptive Alpha Calculator (ADR-048)
 *
 * Calculates adaptive alpha values locally per node instead of globally per graph.
 * Uses different algorithms based on mode (Active Search vs Passive Suggestion)
 * and node type (Tool vs Capability).
 *
 * Alpha controls the balance between semantic and graph scores:
 * - alpha=1.0: Pure semantic search (no graph influence)
 * - alpha=0.5: Equal weight (maximum graph influence)
 *
 * Algorithms by mode:
 * - Active Search: Embeddings Hybrides (semantic vs structural coherence)
 * - Passive Suggestion Tools: Heat Diffusion (context propagation)
 * - Passive Suggestion Capabilities: Heat Diffusion Hierarchical
 * - Cold Start fallback: Bayesian (explicit uncertainty)
 *
 * @module graphrag/local-alpha
 */

import { getLogger } from "../telemetry/logger.ts";
import { parse as parseYaml } from "@std/yaml";
import type { SpectralClusteringManager } from "./spectral-clustering.ts";

const log = getLogger("default");

/**
 * Minimal graph interface for LocalAlphaCalculator
 *
 * Matches the subset of Graphology API we actually use.
 * This avoids importing the full graphology types which don't work well with Deno.
 */
interface GraphLike {
  hasNode(nodeId: string): boolean;
  degree(nodeId: string): number;
  neighbors(nodeId: string): string[];
  hasEdge(source: string, target: string): boolean;
  getEdgeAttribute(source: string, target: string, name: string): number | undefined;
  forEachNode(callback: (node: string) => void): void;
}

// ============================================================================
// Config Types (ADR-048)
// ============================================================================

/**
 * Hierarchy weights for a node type (internal camelCase)
 */
export interface HierarchyWeights {
  intrinsic: number;
  neighbor: number;
  hierarchy: number;
}

/**
 * Local Alpha Configuration - Internal TypeScript (camelCase)
 */
export interface LocalAlphaConfig {
  alphaMin: number;
  alphaMax: number;
  alphaScalingFactor: number;
  coldStart: {
    threshold: number;
    priorAlpha: number;
    targetAlpha: number;
  };
  heatDiffusion: {
    intrinsicWeight: number;
    neighborWeight: number;
    commonNeighborFactor: number;
  };
  hierarchy: {
    tool: HierarchyWeights;
    capability: HierarchyWeights;
    meta: HierarchyWeights;
  };
  hierarchyInheritance: {
    metaToCapability: number;
    capabilityToTool: number;
  };
  structuralConfidence: {
    targetHeat: number;
    contextHeat: number;
    pathHeat: number;
  };
}

/**
 * Local Alpha File Configuration - YAML format (snake_case)
 */
interface LocalAlphaFileConfig {
  alpha_min?: number;
  alpha_max?: number;
  alpha_scaling_factor?: number;
  cold_start?: {
    threshold?: number;
    prior_alpha?: number;
    target_alpha?: number;
  };
  heat_diffusion?: {
    intrinsic_weight?: number;
    neighbor_weight?: number;
    common_neighbor_factor?: number;
  };
  hierarchy?: {
    tool?: HierarchyWeights;
    capability?: HierarchyWeights;
    meta?: HierarchyWeights;
  };
  hierarchy_inheritance?: {
    meta_to_capability?: number;
    capability_to_tool?: number;
  };
  structural_confidence?: {
    target_heat?: number;
    context_heat?: number;
    path_heat?: number;
  };
}

/**
 * Default configuration values (camelCase)
 */
export const DEFAULT_LOCAL_ALPHA_CONFIG: LocalAlphaConfig = {
  alphaMin: 0.5,
  alphaMax: 1.0,
  alphaScalingFactor: 0.5,
  coldStart: {
    threshold: 5,
    priorAlpha: 1.0,
    targetAlpha: 0.7,
  },
  heatDiffusion: {
    intrinsicWeight: 0.6,
    neighborWeight: 0.4,
    commonNeighborFactor: 0.2,
  },
  hierarchy: {
    tool: { intrinsic: 0.5, neighbor: 0.3, hierarchy: 0.2 },
    capability: { intrinsic: 0.3, neighbor: 0.4, hierarchy: 0.3 },
    meta: { intrinsic: 0.2, neighbor: 0.2, hierarchy: 0.6 },
  },
  hierarchyInheritance: {
    metaToCapability: 0.7,
    capabilityToTool: 0.5,
  },
  structuralConfidence: {
    targetHeat: 0.4,
    contextHeat: 0.3,
    pathHeat: 0.3,
  },
};

/**
 * Config validation error with field context
 */
export class LocalAlphaConfigError extends Error {
  constructor(
    public field: string,
    public value: unknown,
    public constraint: string,
  ) {
    super(`Invalid config: ${field}=${JSON.stringify(value)} - ${constraint}`);
    this.name = "LocalAlphaConfigError";
  }
}

/**
 * Validate config values and constraints
 * @throws LocalAlphaConfigError if validation fails
 */
function validateLocalAlphaConfig(config: LocalAlphaConfig): void {
  const errors: string[] = [];

  // Helper to check range [0, 1]
  const checkRange01 = (field: string, value: number) => {
    if (value < 0 || value > 1) {
      errors.push(`${field}=${value} must be in [0, 1]`);
    }
  };

  // Helper to check sum equals 1.0 (with tolerance)
  const checkSum1 = (field: string, values: number[]) => {
    const sum = values.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1.0) > 0.001) {
      errors.push(`${field} weights must sum to 1.0, got ${sum.toFixed(3)}`);
    }
  };

  // Alpha bounds
  checkRange01("alphaMin", config.alphaMin);
  checkRange01("alphaMax", config.alphaMax);
  checkRange01("alphaScalingFactor", config.alphaScalingFactor);

  if (config.alphaMin >= config.alphaMax) {
    errors.push(`alphaMin (${config.alphaMin}) must be < alphaMax (${config.alphaMax})`);
  }

  // Cold start
  if (config.coldStart.threshold < 1) {
    errors.push(`coldStart.threshold must be >= 1, got ${config.coldStart.threshold}`);
  }
  checkRange01("coldStart.priorAlpha", config.coldStart.priorAlpha);
  checkRange01("coldStart.targetAlpha", config.coldStart.targetAlpha);

  // Heat diffusion
  checkRange01("heatDiffusion.intrinsicWeight", config.heatDiffusion.intrinsicWeight);
  checkRange01("heatDiffusion.neighborWeight", config.heatDiffusion.neighborWeight);
  checkRange01("heatDiffusion.commonNeighborFactor", config.heatDiffusion.commonNeighborFactor);

  // Hierarchy weights - each must sum to 1.0
  for (const nodeType of ["tool", "capability", "meta"] as const) {
    const w = config.hierarchy[nodeType];
    checkRange01(`hierarchy.${nodeType}.intrinsic`, w.intrinsic);
    checkRange01(`hierarchy.${nodeType}.neighbor`, w.neighbor);
    checkRange01(`hierarchy.${nodeType}.hierarchy`, w.hierarchy);
    checkSum1(`hierarchy.${nodeType}`, [w.intrinsic, w.neighbor, w.hierarchy]);
  }

  // Hierarchy inheritance
  checkRange01(
    "hierarchyInheritance.metaToCapability",
    config.hierarchyInheritance.metaToCapability,
  );
  checkRange01(
    "hierarchyInheritance.capabilityToTool",
    config.hierarchyInheritance.capabilityToTool,
  );

  // Structural confidence - must sum to 1.0
  const sc = config.structuralConfidence;
  checkRange01("structuralConfidence.targetHeat", sc.targetHeat);
  checkRange01("structuralConfidence.contextHeat", sc.contextHeat);
  checkRange01("structuralConfidence.pathHeat", sc.pathHeat);
  checkSum1("structuralConfidence", [sc.targetHeat, sc.contextHeat, sc.pathHeat]);

  // Throw aggregated errors
  if (errors.length > 0) {
    throw new LocalAlphaConfigError(
      "multiple",
      null,
      errors.join("; "),
    );
  }
}

/**
 * Convert YAML file config (snake_case) to internal config (camelCase)
 */
function toLocalAlphaConfig(file: LocalAlphaFileConfig): LocalAlphaConfig {
  const d = DEFAULT_LOCAL_ALPHA_CONFIG;
  return {
    alphaMin: file.alpha_min ?? d.alphaMin,
    alphaMax: file.alpha_max ?? d.alphaMax,
    alphaScalingFactor: file.alpha_scaling_factor ?? d.alphaScalingFactor,
    coldStart: {
      threshold: file.cold_start?.threshold ?? d.coldStart.threshold,
      priorAlpha: file.cold_start?.prior_alpha ?? d.coldStart.priorAlpha,
      targetAlpha: file.cold_start?.target_alpha ?? d.coldStart.targetAlpha,
    },
    heatDiffusion: {
      intrinsicWeight: file.heat_diffusion?.intrinsic_weight ?? d.heatDiffusion.intrinsicWeight,
      neighborWeight: file.heat_diffusion?.neighbor_weight ?? d.heatDiffusion.neighborWeight,
      commonNeighborFactor: file.heat_diffusion?.common_neighbor_factor ??
        d.heatDiffusion.commonNeighborFactor,
    },
    hierarchy: {
      tool: file.hierarchy?.tool ?? d.hierarchy.tool,
      capability: file.hierarchy?.capability ?? d.hierarchy.capability,
      meta: file.hierarchy?.meta ?? d.hierarchy.meta,
    },
    hierarchyInheritance: {
      metaToCapability: file.hierarchy_inheritance?.meta_to_capability ??
        d.hierarchyInheritance.metaToCapability,
      capabilityToTool: file.hierarchy_inheritance?.capability_to_tool ??
        d.hierarchyInheritance.capabilityToTool,
    },
    structuralConfidence: {
      targetHeat: file.structural_confidence?.target_heat ?? d.structuralConfidence.targetHeat,
      contextHeat: file.structural_confidence?.context_heat ?? d.structuralConfidence.contextHeat,
      pathHeat: file.structural_confidence?.path_heat ?? d.structuralConfidence.pathHeat,
    },
  };
}

/**
 * Load local alpha config from YAML file
 * @throws LocalAlphaConfigError if validation fails
 */
export async function loadLocalAlphaConfig(
  configPath = "./config/local-alpha.yaml",
): Promise<LocalAlphaConfig> {
  try {
    const content = await Deno.readTextFile(configPath);
    const parsed = parseYaml(content) as LocalAlphaFileConfig;
    const config = toLocalAlphaConfig(parsed);

    // Validate config
    validateLocalAlphaConfig(config);

    log.debug(`[LocalAlpha] Loaded and validated config from ${configPath}`);
    return config;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      log.debug(`[LocalAlpha] Config not found at ${configPath}, using defaults`);
      return DEFAULT_LOCAL_ALPHA_CONFIG;
    }
    if (error instanceof LocalAlphaConfigError) {
      log.error(`[LocalAlpha] Config validation failed: ${error.message}`);
      throw error; // Re-throw validation errors - don't silently use defaults
    }
    log.error(`[LocalAlpha] Failed to load config: ${error}`);
    return DEFAULT_LOCAL_ALPHA_CONFIG;
  }
}

// ============================================================================
// Types
// ============================================================================

export type AlphaMode = "active" | "passive";
export type NodeType = "tool" | "capability" | "meta";

export interface LocalAlphaResult {
  alpha: number;
  algorithm: "embeddings_hybrides" | "heat_diffusion" | "heat_hierarchical" | "bayesian";
  coldStart: boolean;
  /** Algorithm-specific inputs for debugging/observability. Values can be numbers or strings. */
  inputs: Record<string, number | string>;
}

// Alias for backwards compatibility
export type HeatWeights = HierarchyWeights;

interface AlphaCalculatorDeps {
  graph: GraphLike;
  spectralClustering: SpectralClusteringManager | null;
  getSemanticEmbedding: (nodeId: string) => number[] | null;
  getObservationCount: (nodeId: string) => number;
  getParent: (nodeId: string, parentType: NodeType) => string | null;
  getChildren: (nodeId: string, childType: NodeType) => string[];
}

// ============================================================================
// LocalAlphaCalculator
// ============================================================================

/**
 * Calculates local adaptive alpha based on mode and node type.
 *
 * Usage:
 * ```typescript
 * const calculator = new LocalAlphaCalculator(deps);
 * // Or with custom config:
 * const calculator = new LocalAlphaCalculator(deps, customConfig);
 * const alpha = calculator.getLocalAlpha('active', 'tool:fs:read', 'tool');
 * ```
 */
export class LocalAlphaCalculator {
  private deps: AlphaCalculatorDeps;
  private config: LocalAlphaConfig;
  private heatCache: Map<string, number> = new Map();
  private cacheTTL = 60_000; // 1 minute
  private cacheTimestamp = 0;

  constructor(deps: AlphaCalculatorDeps, config?: LocalAlphaConfig) {
    this.deps = deps;
    this.config = config ?? DEFAULT_LOCAL_ALPHA_CONFIG;
  }

  /**
   * Update spectral clustering reference (ADR-048)
   *
   * Called when DAGSuggester initializes or updates its SpectralClusteringManager.
   * This enables Embeddings Hybrides algorithm for Active Search mode.
   *
   * @param spectralClustering - SpectralClusteringManager instance or null
   */
  setSpectralClustering(spectralClustering: SpectralClusteringManager | null): void {
    this.deps.spectralClustering = spectralClustering;
    // Invalidate embedding cache since spectral data changed
    this.heatCache.clear();
    this.cacheTimestamp = 0;
    log.debug("[LocalAlpha] Spectral clustering updated");
  }

  /**
   * Check if spectral clustering is available
   */
  hasSpectralClustering(): boolean {
    return this.deps.spectralClustering !== null;
  }

  /**
   * Main entry point: get local alpha for a node
   */
  getLocalAlpha(
    mode: AlphaMode,
    nodeId: string,
    nodeType: NodeType,
    contextNodes: string[] = [],
  ): number {
    const result = this.getLocalAlphaWithBreakdown(mode, nodeId, nodeType, contextNodes);
    return result.alpha;
  }

  /**
   * Get alpha with full breakdown for debugging/observability
   */
  getLocalAlphaWithBreakdown(
    mode: AlphaMode,
    nodeId: string,
    nodeType: NodeType,
    contextNodes: string[] = [],
  ): LocalAlphaResult {
    // Check cold start first
    const observations = this.deps.getObservationCount(nodeId);
    if (observations < this.config.coldStart.threshold) {
      return this.computeAlphaBayesian(nodeId, observations);
    }

    // Select algorithm based on mode
    if (mode === "active") {
      return this.computeAlphaEmbeddingsHybrides(nodeId);
    } else {
      if (nodeType === "tool") {
        return this.computeAlphaHeatDiffusion(nodeId, contextNodes);
      } else {
        return this.computeAlphaHeatDiffusionHierarchical(nodeId, nodeType, contextNodes);
      }
    }
  }

  /**
   * Invalidate heat cache (call when graph changes)
   */
  invalidateCache(): void {
    this.heatCache.clear();
    this.cacheTimestamp = 0;
  }

  // ==========================================================================
  // Algorithm 1: Embeddings Hybrides (Active Search)
  // ==========================================================================

  /**
   * Compute alpha via semantic/structural pattern coherence.
   *
   * This algorithm measures whether the graph structure aligns with semantic
   * meaning by comparing PATTERNS of similarities rather than embeddings directly.
   *
   * Rationale (ADR-048 fix):
   * - Semantic embeddings (BGE-M3) are 1024-dimensional
   * - Structural embeddings (spectral eigenvectors) are k-dimensional (typically 4-5)
   * - Direct cosine similarity between different dimensions is mathematically invalid
   *
   * Solution: Pattern Correlation Approach
   * 1. For each neighbor of the target node:
   *    - Compute semantic similarity (cosine between BGE-M3 embeddings)
   *    - Get structural similarity (normalized edge weight)
   * 2. Compute Pearson correlation between these two similarity patterns
   * 3. High correlation = graph reflects semantics = reliable = low alpha
   *    Low correlation = mismatch = unreliable = high alpha
   *
   * @param nodeId - Target node to compute alpha for
   * @returns LocalAlphaResult with alpha value and breakdown
   */
  private computeAlphaEmbeddingsHybrides(nodeId: string): LocalAlphaResult {
    const { alphaMin, alphaMax, alphaScalingFactor } = this.config;
    const graph = this.deps.graph;

    // Check if node exists in graph
    if (!graph.hasNode(nodeId)) {
      log.debug(`[LocalAlpha] Node ${nodeId} not in graph, fallback to semantic-only`);
      return {
        alpha: alphaMax,
        algorithm: "embeddings_hybrides",
        coldStart: false,
        inputs: { reason: "node_not_in_graph" },
      };
    }

    // Get neighbors of the target node
    const neighbors = graph.neighbors(nodeId);
    if (neighbors.length < 2) {
      log.debug(
        `[LocalAlpha] Node ${nodeId} has <2 neighbors (${neighbors.length}), fallback to semantic-only`,
      );
      return {
        alpha: alphaMax,
        algorithm: "embeddings_hybrides",
        coldStart: false,
        inputs: { reason: "insufficient_neighbors", neighborCount: neighbors.length },
      };
    }

    // Get semantic embedding for target node
    const targetEmb = this.deps.getSemanticEmbedding(nodeId);
    if (!targetEmb) {
      log.debug(`[LocalAlpha] No semantic embedding for ${nodeId}, fallback to semantic-only`);
      return {
        alpha: alphaMax,
        algorithm: "embeddings_hybrides",
        coldStart: false,
        inputs: { reason: "no_target_embedding" },
      };
    }

    // Compute similarity patterns
    const semanticSims: number[] = [];
    const structuralSims: number[] = [];
    let maxEdgeWeight = 1;

    // First pass: find max edge weight for normalization
    for (const neighbor of neighbors) {
      const weight = this.getEdgeWeight(nodeId, neighbor);
      if (weight > maxEdgeWeight) maxEdgeWeight = weight;
    }

    // Second pass: compute similarities
    for (const neighbor of neighbors) {
      const neighborEmb = this.deps.getSemanticEmbedding(neighbor);
      if (!neighborEmb) continue; // Skip neighbors without embeddings

      // Semantic similarity: cosine between BGE-M3 embeddings (same dimension)
      const semanticSim = this.cosineSimilarity(targetEmb, neighborEmb);

      // Structural similarity: normalized edge weight
      const edgeWeight = this.getEdgeWeight(nodeId, neighbor);
      const structuralSim = edgeWeight / maxEdgeWeight;

      semanticSims.push(semanticSim);
      structuralSims.push(structuralSim);
    }

    // Need at least 2 data points for correlation
    if (semanticSims.length < 2) {
      log.debug(
        `[LocalAlpha] Only ${semanticSims.length} neighbors with embeddings for ${nodeId}, fallback`,
      );
      return {
        alpha: alphaMax,
        algorithm: "embeddings_hybrides",
        coldStart: false,
        inputs: { reason: "insufficient_neighbor_embeddings", count: semanticSims.length },
      };
    }

    // Compute Pearson correlation between the two similarity patterns
    const coherence = this.pearsonCorrelation(semanticSims, structuralSims);

    // Normalize coherence from [-1, 1] to [0, 1] for alpha calculation
    // -1 (anti-correlated) → 0 (no trust in graph)
    //  0 (uncorrelated)    → 0.5
    // +1 (correlated)      → 1 (full trust in graph)
    const normalizedCoherence = (coherence + 1) / 2;

    // High coherence → low alpha (graph is useful)
    // Low coherence → high alpha (trust semantic only)
    const alpha = Math.max(alphaMin, alphaMax - normalizedCoherence * alphaScalingFactor);

    log.debug(
      `[LocalAlpha] Embeddings Hybrides: ${nodeId} ` +
        `neighbors=${semanticSims.length} correlation=${coherence.toFixed(3)} ` +
        `normalized=${normalizedCoherence.toFixed(3)} → alpha=${alpha.toFixed(2)}`,
    );

    return {
      alpha,
      algorithm: "embeddings_hybrides",
      coldStart: false,
      inputs: {
        neighborCount: semanticSims.length,
        pearsonCorrelation: coherence,
        normalizedCoherence,
      },
    };
  }

  /**
   * Get edge weight between two nodes (checks both directions)
   */
  private getEdgeWeight(nodeA: string, nodeB: string): number {
    const graph = this.deps.graph;
    if (graph.hasEdge(nodeA, nodeB)) {
      return graph.getEdgeAttribute(nodeA, nodeB, "weight") ?? 1.0;
    }
    if (graph.hasEdge(nodeB, nodeA)) {
      return graph.getEdgeAttribute(nodeB, nodeA, "weight") ?? 1.0;
    }
    return 0;
  }

  /**
   * Get structural embedding from spectral clustering eigenvectors
   *
   * Returns the k-dimensional eigenvector representation of a node from
   * spectral clustering. Useful for cluster-based analysis.
   *
   * Note: No longer used by EmbeddingsHybrides (which now uses pattern correlation),
   * but kept as public API for other use cases (e.g., cluster visualization).
   *
   * @param nodeId - Node to get embedding for
   * @returns k-dimensional embedding vector, or null if not available
   */
  getStructuralEmbedding(nodeId: string): number[] | null {
    if (!this.deps.spectralClustering) return null;
    return this.deps.spectralClustering.getEmbeddingRow(nodeId);
  }

  // ==========================================================================
  // Algorithm 2: Heat Diffusion (Passive Suggestion - Tools)
  // ==========================================================================

  /**
   * Compute alpha via heat diffusion from context.
   *
   * High heat = well connected to context = low alpha (use graph)
   * Low heat = isolated from context = high alpha (trust semantic)
   */
  private computeAlphaHeatDiffusion(
    targetNodeId: string,
    contextNodes: string[],
  ): LocalAlphaResult {
    this.refreshCacheIfNeeded();
    const { alphaMin, alphaMax, alphaScalingFactor, structuralConfidence: sc } = this.config;

    // Heat of target node
    const targetHeat = this.computeLocalHeat(targetNodeId);

    // Heat of context (where we come from)
    const contextHeat = contextNodes.length > 0
      ? contextNodes.reduce((sum, n) => sum + this.computeLocalHeat(n), 0) / contextNodes.length
      : 0;

    // Path heat (connectivity between context and target)
    const pathHeat = this.computePathHeat(contextNodes, targetNodeId);

    // Structural confidence [0, 1] using config weights
    const structConfidence = sc.targetHeat * targetHeat +
      sc.contextHeat * contextHeat +
      sc.pathHeat * pathHeat;

    const alpha = Math.max(alphaMin, alphaMax - structConfidence * alphaScalingFactor);

    log.debug(
      `[LocalAlpha] Heat Diffusion: ${targetNodeId} target=${targetHeat.toFixed(2)} ctx=${
        contextHeat.toFixed(2)
      } path=${pathHeat.toFixed(2)} → alpha=${alpha.toFixed(2)}`,
    );

    return {
      alpha,
      algorithm: "heat_diffusion",
      coldStart: false,
      inputs: { targetHeat, contextHeat, pathHeat, structuralConfidence: structConfidence },
    };
  }

  /**
   * Compute local heat for a node (degree + neighbor propagation)
   */
  private computeLocalHeat(nodeId: string): number {
    // Check cache
    const cached = this.heatCache.get(nodeId);
    if (cached !== undefined) return cached;

    const graph = this.deps.graph;
    if (!graph.hasNode(nodeId)) {
      this.heatCache.set(nodeId, 0);
      return 0;
    }

    const { intrinsicWeight, neighborWeight } = this.config.heatDiffusion;
    const degree = graph.degree(nodeId);
    const maxDegree = Math.max(1, this.getMaxDegree());

    // Intrinsic heat from degree
    const intrinsicHeat = Math.min(1, degree / maxDegree);

    // Neighbor heat (propagation) - use degree sum, not recursion to avoid cycles
    const neighbors = graph.neighbors(nodeId);
    const neighborHeat = neighbors.length > 0
      ? neighbors.reduce((sum: number, n: string) => sum + graph.degree(n), 0) /
        (neighbors.length * maxDegree)
      : 0;

    const heat = intrinsicWeight * intrinsicHeat + neighborWeight * Math.min(1, neighborHeat);

    this.heatCache.set(nodeId, heat);
    return heat;
  }

  /**
   * Compute path heat between context and target
   */
  private computePathHeat(contextNodes: string[], targetId: string): number {
    if (contextNodes.length === 0) return 0;

    const graph = this.deps.graph;
    if (!graph.hasNode(targetId)) return 0;

    const { commonNeighborFactor } = this.config.heatDiffusion;
    let totalConnectivity = 0;
    for (const ctx of contextNodes) {
      if (!graph.hasNode(ctx)) continue;

      // Direct edge? Check each direction separately to avoid getEdgeAttribute errors
      if (graph.hasEdge(ctx, targetId)) {
        const weight = graph.getEdgeAttribute(ctx, targetId, "weight") ?? 1.0;
        totalConnectivity += Math.min(1, weight);
      } else if (graph.hasEdge(targetId, ctx)) {
        const weight = graph.getEdgeAttribute(targetId, ctx, "weight") ?? 1.0;
        totalConnectivity += Math.min(1, weight);
      } else {
        // Check for common neighbors (simplified Adamic-Adar)
        const ctxNeighbors = new Set(graph.neighbors(ctx));
        const targetNeighbors = graph.neighbors(targetId);
        const commonNeighbors = targetNeighbors.filter((n: string) => ctxNeighbors.has(n));
        totalConnectivity += Math.min(1, commonNeighbors.length * commonNeighborFactor);
      }
    }

    return Math.min(1, totalConnectivity / contextNodes.length);
  }

  // ==========================================================================
  // Algorithm 3: Heat Diffusion Hierarchical (Passive Suggestion - Capabilities)
  // ==========================================================================

  /**
   * Compute alpha via hierarchical heat diffusion.
   *
   * Same as Heat Diffusion but with bidirectional hierarchy propagation
   * through Tool → Capability → MetaCapability.
   */
  private computeAlphaHeatDiffusionHierarchical(
    targetNodeId: string,
    targetType: NodeType,
    contextNodes: string[],
  ): LocalAlphaResult {
    this.refreshCacheIfNeeded();
    const { alphaMin, alphaMax, alphaScalingFactor, structuralConfidence: sc } = this.config;

    const heat = this.computeHierarchicalHeat(targetNodeId, targetType);
    const contextHeat = this.computeContextHeat(contextNodes);
    const pathHeat = this.computePathHeat(contextNodes, targetNodeId);

    const structConfidence = sc.targetHeat * heat +
      sc.contextHeat * contextHeat +
      sc.pathHeat * pathHeat;

    const alpha = Math.max(alphaMin, alphaMax - structConfidence * alphaScalingFactor);

    log.debug(
      `[LocalAlpha] Heat Hierarchical: ${targetNodeId} (${targetType}) heat=${
        heat.toFixed(2)
      } ctx=${contextHeat.toFixed(2)} → alpha=${alpha.toFixed(2)}`,
    );

    return {
      alpha,
      algorithm: "heat_hierarchical",
      coldStart: false,
      inputs: { heat, contextHeat, pathHeat, structuralConfidence: structConfidence },
    };
  }

  /**
   * Compute hierarchical heat with bidirectional propagation
   */
  private computeHierarchicalHeat(nodeId: string, nodeType: NodeType, depth = 0): number {
    // Prevent infinite recursion
    if (depth > 3) return 0;

    const cacheKey = `hier:${nodeId}:${nodeType}`;
    const cached = this.heatCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const weights = this.getHierarchyWeights(nodeType);

    const intrinsicHeat = this.computeLocalHeat(nodeId);
    const neighborHeat = this.computeNeighborHeat(nodeId);
    const hierarchyHeat = this.computeHierarchyPropagation(nodeId, nodeType, depth);

    const heat = weights.intrinsic * intrinsicHeat +
      weights.neighbor * neighborHeat +
      weights.hierarchy * hierarchyHeat;

    this.heatCache.set(cacheKey, heat);
    return heat;
  }

  /**
   * Get weights based on hierarchy level (from config)
   */
  private getHierarchyWeights(nodeType: NodeType): HierarchyWeights {
    return this.config.hierarchy[nodeType];
  }

  /**
   * Compute hierarchy propagation (bottom-up aggregation + top-down inheritance)
   */
  private computeHierarchyPropagation(nodeId: string, nodeType: NodeType, depth: number): number {
    const { metaToCapability, capabilityToTool } = this.config.hierarchyInheritance;

    switch (nodeType) {
      case "meta": {
        // Bottom-up: aggregate from capability children
        const children = this.deps.getChildren(nodeId, "capability");
        if (children.length === 0) return 0;
        return children.reduce(
          (sum, c) => sum + this.computeHierarchicalHeat(c, "capability", depth + 1),
          0,
        ) / children.length;
      }

      case "capability": {
        // Top-down: inherit from meta-capability parent
        const metaParent = this.deps.getParent(nodeId, "meta");
        if (!metaParent) return 0;
        return this.computeHierarchicalHeat(metaParent, "meta", depth + 1) * metaToCapability;
      }

      case "tool": {
        // Top-down: inherit from capability parent
        const capParent = this.deps.getParent(nodeId, "capability");
        if (!capParent) return 0;
        return this.computeHierarchicalHeat(capParent, "capability", depth + 1) * capabilityToTool;
      }
    }
  }

  /**
   * Compute neighbor heat (average heat of neighbors)
   */
  private computeNeighborHeat(nodeId: string): number {
    const graph = this.deps.graph;
    if (!graph.hasNode(nodeId)) return 0;

    const neighbors = graph.neighbors(nodeId);
    if (neighbors.length === 0) return 0;

    return neighbors.reduce((sum: number, n: string) => sum + this.computeLocalHeat(n), 0) /
      neighbors.length;
  }

  /**
   * Compute context heat (average heat of context nodes)
   */
  private computeContextHeat(contextNodes: string[]): number {
    if (contextNodes.length === 0) return 0;
    return contextNodes.reduce((sum, n) => sum + this.computeLocalHeat(n), 0) / contextNodes.length;
  }

  // ==========================================================================
  // Algorithm 4: Bayesian (Cold Start)
  // ==========================================================================

  /**
   * Compute alpha using Bayesian uncertainty for cold start.
   *
   * Prior: alpha = 1.0 (don't trust graph)
   * Posterior: converges to target as observations increase
   */
  private computeAlphaBayesian(nodeId: string, observations: number): LocalAlphaResult {
    const { threshold, priorAlpha, targetAlpha } = this.config.coldStart;

    // Confidence grows with observations
    const confidence = observations / threshold;

    // Linear interpolation from prior to target
    const alpha = priorAlpha * (1 - confidence) + targetAlpha * confidence;

    log.debug(
      `[LocalAlpha] Bayesian: ${nodeId} obs=${observations}/${threshold} confidence=${
        confidence.toFixed(2)
      } → alpha=${alpha.toFixed(2)}`,
    );

    return {
      alpha,
      algorithm: "bayesian",
      coldStart: true,
      inputs: { observations, confidence, priorAlpha, targetAlpha },
    };
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Pearson correlation coefficient between two arrays
   *
   * Measures linear correlation between two variables.
   * Returns value in [-1, 1]:
   * - +1: Perfect positive correlation
   * -  0: No linear correlation
   * - -1: Perfect negative correlation
   *
   * Used by EmbeddingsHybrides to compare semantic vs structural similarity patterns.
   *
   * @param a - First array of values
   * @param b - Second array of values (must be same length as a)
   * @returns Pearson correlation coefficient, or 0 if invalid input
   */
  private pearsonCorrelation(a: number[], b: number[]): number {
    const n = a.length;
    if (n !== b.length || n < 2) return 0;

    // Calculate means
    let sumA = 0, sumB = 0;
    for (let i = 0; i < n; i++) {
      sumA += a[i];
      sumB += b[i];
    }
    const meanA = sumA / n;
    const meanB = sumB / n;

    // Calculate correlation components
    let numerator = 0;
    let denomA = 0;
    let denomB = 0;

    for (let i = 0; i < n; i++) {
      const devA = a[i] - meanA;
      const devB = b[i] - meanB;
      numerator += devA * devB;
      denomA += devA * devA;
      denomB += devB * devB;
    }

    // Handle edge cases (zero variance)
    if (denomA === 0 || denomB === 0) return 0;

    return numerator / (Math.sqrt(denomA) * Math.sqrt(denomB));
  }

  /**
   * Get max degree in graph for normalization
   */
  private getMaxDegree(): number {
    const graph = this.deps.graph;
    let max = 1;
    graph.forEachNode((node: string) => {
      const d = graph.degree(node);
      if (d > max) max = d;
    });
    return max;
  }

  /**
   * Refresh cache if TTL expired
   */
  private refreshCacheIfNeeded(): void {
    const now = Date.now();
    if (now - this.cacheTimestamp > this.cacheTTL) {
      this.heatCache.clear();
      this.cacheTimestamp = now;
    }
  }
}
