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
import type { SpectralClusteringManager } from "./spectral-clustering.ts";
import type Graph from "graphology";

const log = getLogger("default");

// ============================================================================
// Types
// ============================================================================

export type AlphaMode = "active" | "passive";
export type NodeType = "tool" | "capability" | "meta";

export interface LocalAlphaResult {
  alpha: number;
  algorithm: "embeddings_hybrides" | "heat_diffusion" | "heat_hierarchical" | "bayesian";
  coldStart: boolean;
  inputs: Record<string, number>;
}

export interface HeatWeights {
  intrinsic: number;
  neighbor: number;
  hierarchy: number;
}

interface AlphaCalculatorDeps {
  graph: Graph;
  spectralClustering: SpectralClusteringManager | null;
  getSemanticEmbedding: (nodeId: string) => number[] | null;
  getObservationCount: (nodeId: string) => number;
  getParent: (nodeId: string, parentType: NodeType) => string | null;
  getChildren: (nodeId: string, childType: NodeType) => string[];
}

// ============================================================================
// Constants
// ============================================================================

const COLD_START_THRESHOLD = 5; // Minimum observations before trusting graph
const ALPHA_MIN = 0.5; // Maximum graph influence
const ALPHA_MAX = 1.0; // Pure semantic (no graph)

// ============================================================================
// LocalAlphaCalculator
// ============================================================================

/**
 * Calculates local adaptive alpha based on mode and node type.
 *
 * Usage:
 * ```typescript
 * const calculator = new LocalAlphaCalculator(deps);
 * const alpha = calculator.getLocalAlpha('active', 'tool:fs:read', 'tool');
 * ```
 */
export class LocalAlphaCalculator {
  private deps: AlphaCalculatorDeps;
  private heatCache: Map<string, number> = new Map();
  private cacheTTL = 60_000; // 1 minute
  private cacheTimestamp = 0;

  constructor(deps: AlphaCalculatorDeps) {
    this.deps = deps;
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
    contextNodes: string[] = []
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
    contextNodes: string[] = []
  ): LocalAlphaResult {
    // Check cold start first
    const observations = this.deps.getObservationCount(nodeId);
    if (observations < COLD_START_THRESHOLD) {
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
   * Compute alpha via semantic/structural embedding coherence.
   *
   * High coherence = graph confirms semantics = low alpha (use graph)
   * Low coherence = divergence = high alpha (trust semantic only)
   */
  private computeAlphaEmbeddingsHybrides(nodeId: string): LocalAlphaResult {
    const semanticEmb = this.deps.getSemanticEmbedding(nodeId);
    const structuralEmb = this.getStructuralEmbedding(nodeId);

    if (!semanticEmb || !structuralEmb) {
      log.debug(`[LocalAlpha] No embeddings for ${nodeId}, fallback to semantic-only`);
      return {
        alpha: ALPHA_MAX,
        algorithm: "embeddings_hybrides",
        coldStart: false,
        inputs: { semanticEmb: semanticEmb ? 1 : 0, structuralEmb: structuralEmb ? 1 : 0 },
      };
    }

    // Compute cosine similarity between embeddings
    const coherence = this.cosineSimilarity(semanticEmb, structuralEmb);

    // High coherence → low alpha (graph is useful)
    const alpha = Math.max(ALPHA_MIN, ALPHA_MAX - coherence * 0.5);

    log.debug(`[LocalAlpha] Embeddings Hybrides: ${nodeId} coherence=${coherence.toFixed(3)} → alpha=${alpha.toFixed(2)}`);

    return {
      alpha,
      algorithm: "embeddings_hybrides",
      coldStart: false,
      inputs: { coherence },
    };
  }

  /**
   * Get structural embedding from spectral clustering eigenvectors
   */
  private getStructuralEmbedding(nodeId: string): number[] | null {
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
    contextNodes: string[]
  ): LocalAlphaResult {
    this.refreshCacheIfNeeded();

    // Heat of target node
    const targetHeat = this.computeLocalHeat(targetNodeId);

    // Heat of context (where we come from)
    const contextHeat = contextNodes.length > 0
      ? contextNodes.reduce((sum, n) => sum + this.computeLocalHeat(n), 0) / contextNodes.length
      : 0;

    // Path heat (connectivity between context and target)
    const pathHeat = this.computePathHeat(contextNodes, targetNodeId);

    // Structural confidence [0, 1]
    const structuralConfidence =
      0.4 * targetHeat +
      0.3 * contextHeat +
      0.3 * pathHeat;

    const alpha = Math.max(ALPHA_MIN, ALPHA_MAX - structuralConfidence * 0.5);

    log.debug(
      `[LocalAlpha] Heat Diffusion: ${targetNodeId} target=${targetHeat.toFixed(2)} ctx=${contextHeat.toFixed(2)} path=${pathHeat.toFixed(2)} → alpha=${alpha.toFixed(2)}`
    );

    return {
      alpha,
      algorithm: "heat_diffusion",
      coldStart: false,
      inputs: { targetHeat, contextHeat, pathHeat, structuralConfidence },
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

    const degree = graph.degree(nodeId);
    const maxDegree = Math.max(1, this.getMaxDegree());

    // Intrinsic heat from degree
    const intrinsicHeat = Math.min(1, degree / maxDegree);

    // Neighbor heat (propagation) - use degree sum, not recursion to avoid cycles
    const neighbors = graph.neighbors(nodeId);
    const neighborHeat = neighbors.length > 0
      ? neighbors.reduce((sum, n) => sum + graph.degree(n), 0) / (neighbors.length * maxDegree)
      : 0;

    const heat = 0.6 * intrinsicHeat + 0.4 * Math.min(1, neighborHeat);

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

    let totalConnectivity = 0;
    for (const ctx of contextNodes) {
      if (!graph.hasNode(ctx)) continue;

      // Direct edge?
      if (graph.hasEdge(ctx, targetId) || graph.hasEdge(targetId, ctx)) {
        const weight = graph.getEdgeAttribute(ctx, targetId, "weight") ||
                       graph.getEdgeAttribute(targetId, ctx, "weight") || 1.0;
        totalConnectivity += Math.min(1, weight);
      } else {
        // Check for common neighbors (simplified Adamic-Adar)
        const ctxNeighbors = new Set(graph.neighbors(ctx));
        const targetNeighbors = graph.neighbors(targetId);
        const commonNeighbors = targetNeighbors.filter(n => ctxNeighbors.has(n));
        totalConnectivity += Math.min(1, commonNeighbors.length * 0.2);
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
    contextNodes: string[]
  ): LocalAlphaResult {
    this.refreshCacheIfNeeded();

    const heat = this.computeHierarchicalHeat(targetNodeId, targetType);
    const contextHeat = this.computeContextHeat(contextNodes);
    const pathHeat = this.computePathHeat(contextNodes, targetNodeId);

    const structuralConfidence =
      0.4 * heat +
      0.3 * contextHeat +
      0.3 * pathHeat;

    const alpha = Math.max(ALPHA_MIN, ALPHA_MAX - structuralConfidence * 0.5);

    log.debug(
      `[LocalAlpha] Heat Hierarchical: ${targetNodeId} (${targetType}) heat=${heat.toFixed(2)} ctx=${contextHeat.toFixed(2)} → alpha=${alpha.toFixed(2)}`
    );

    return {
      alpha,
      algorithm: "heat_hierarchical",
      coldStart: false,
      inputs: { heat, contextHeat, pathHeat, structuralConfidence },
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

    const heat =
      weights.intrinsic * intrinsicHeat +
      weights.neighbor * neighborHeat +
      weights.hierarchy * hierarchyHeat;

    this.heatCache.set(cacheKey, heat);
    return heat;
  }

  /**
   * Get weights based on hierarchy level
   */
  private getHierarchyWeights(nodeType: NodeType): HeatWeights {
    switch (nodeType) {
      case "tool":
        return { intrinsic: 0.5, neighbor: 0.3, hierarchy: 0.2 };
      case "capability":
        return { intrinsic: 0.3, neighbor: 0.4, hierarchy: 0.3 };
      case "meta":
        return { intrinsic: 0.2, neighbor: 0.2, hierarchy: 0.6 };
    }
  }

  /**
   * Compute hierarchy propagation (bottom-up aggregation + top-down inheritance)
   */
  private computeHierarchyPropagation(nodeId: string, nodeType: NodeType, depth: number): number {
    switch (nodeType) {
      case "meta": {
        // Bottom-up: aggregate from capability children
        const children = this.deps.getChildren(nodeId, "capability");
        if (children.length === 0) return 0;
        return children.reduce((sum, c) =>
          sum + this.computeHierarchicalHeat(c, "capability", depth + 1), 0) / children.length;
      }

      case "capability": {
        // Top-down: inherit from meta-capability parent
        const metaParent = this.deps.getParent(nodeId, "meta");
        if (!metaParent) return 0;
        return this.computeHierarchicalHeat(metaParent, "meta", depth + 1) * 0.7;
      }

      case "tool": {
        // Top-down: inherit from capability parent
        const capParent = this.deps.getParent(nodeId, "capability");
        if (!capParent) return 0;
        return this.computeHierarchicalHeat(capParent, "capability", depth + 1) * 0.5;
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

    return neighbors.reduce((sum, n) => sum + this.computeLocalHeat(n), 0) / neighbors.length;
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
    // Prior: don't trust graph
    const priorAlpha = ALPHA_MAX;

    // Target: intermediate value we converge to
    const targetAlpha = 0.7;

    // Confidence grows with observations
    const confidence = observations / COLD_START_THRESHOLD;

    // Linear interpolation from prior to target
    const alpha = priorAlpha * (1 - confidence) + targetAlpha * confidence;

    log.debug(
      `[LocalAlpha] Bayesian: ${nodeId} obs=${observations}/${COLD_START_THRESHOLD} confidence=${confidence.toFixed(2)} → alpha=${alpha.toFixed(2)}`
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
   * Get max degree in graph for normalization
   */
  private getMaxDegree(): number {
    const graph = this.deps.graph;
    let max = 1;
    graph.forEachNode((node) => {
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
