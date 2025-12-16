/**
 * Spectral Clustering Manager (Story 7.4 - AC#3, AC#3b)
 *
 * Implements spectral clustering for bipartite hypergraphs (tools ↔ capabilities).
 * Used for Strategic Discovery Mode (ADR-038) to boost capabilities
 * that belong to the same cluster as active context tools.
 *
 * Key concepts:
 * - Bipartite graph: Tools on one side, Capabilities on the other
 * - Edges: Capability uses Tool (from dag_structure.tools_used)
 * - Clusters: Groups of tools + capabilities that work together
 * - Boost: If current tools are in cluster A, boost capabilities in cluster A
 *
 * @module graphrag/spectral-clustering
 */

import { EigenvalueDecomposition, Matrix } from "ml-matrix";
import { getLogger } from "../telemetry/logger.ts";
import type { CapabilityDependency, CapabilityEdgeType } from "../capabilities/types.ts";

const logger = getLogger("default");

/**
 * Edge type weights for capability-to-capability edges (ADR-042)
 */
const EDGE_TYPE_WEIGHTS: Record<CapabilityEdgeType, number> = {
  dependency: 1.0,
  contains: 0.8,
  alternative: 0.6,
  sequence: 0.5,
};

/**
 * Capability data for clustering (minimal interface)
 */
export interface ClusterableCapability {
  id: string;
  toolsUsed: string[];
}

/**
 * Cluster assignment result
 */
export interface ClusterAssignment {
  toolClusters: Map<string, number>;
  capabilityClusters: Map<string, number>;
  clusterCount: number;
}

/**
 * Cache entry for cluster assignments
 */
interface ClusterCache {
  key: string;
  assignments: ClusterAssignment;
  pageRankScores: Map<string, number>;
  spectralEmbedding: number[][] | null; // ADR-048: For local alpha calculation
  toolIndex: Map<string, number>; // ADR-048: Node ID to index mapping
  capabilityIndex: Map<string, number>; // ADR-048: Node ID to index mapping
  createdAt: number;
}

/**
 * SpectralClusteringManager
 *
 * Manages spectral clustering for tool-capability bipartite graphs.
 * Used to identify clusters of related tools and capabilities
 * for context-aware capability boosting in DAG suggestions.
 *
 * Issue #7 fix: Includes TTL-based caching to avoid recomputing
 * clusters on every DAG suggestion (O(n³) operation).
 */
export class SpectralClusteringManager {
  private toolIndex: Map<string, number> = new Map();
  private capabilityIndex: Map<string, number> = new Map();
  private adjacencyMatrix: Matrix | null = null;
  private clusterAssignments: ClusterAssignment | null = null;
  private pageRankScores: Map<string, number> = new Map();
  private spectralEmbedding: number[][] | null = null; // ADR-048: For local alpha calculation

  // Issue #7: Cache for cluster assignments
  private static cache: ClusterCache | null = null;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Generate cache key from tools and capabilities (Issue #7)
   * Uses sorted IDs to ensure consistent key regardless of input order.
   */
  private static generateCacheKey(tools: string[], capabilities: ClusterableCapability[]): string {
    const toolsKey = [...tools].sort().join(",");
    const capsKey = capabilities.map((c) => c.id).sort().join(",");
    return `${toolsKey}|${capsKey}`;
  }

  /**
   * Check if cached clusters are still valid (Issue #7)
   */
  private static isCacheValid(key: string): boolean {
    if (!SpectralClusteringManager.cache) return false;
    if (SpectralClusteringManager.cache.key !== key) return false;
    const age = Date.now() - SpectralClusteringManager.cache.createdAt;
    return age < SpectralClusteringManager.CACHE_TTL_MS;
  }

  /**
   * Restore from cache if valid (Issue #7)
   */
  restoreFromCacheIfValid(tools: string[], capabilities: ClusterableCapability[]): boolean {
    const key = SpectralClusteringManager.generateCacheKey(tools, capabilities);

    if (SpectralClusteringManager.isCacheValid(key)) {
      this.clusterAssignments = SpectralClusteringManager.cache!.assignments;
      this.pageRankScores = new Map(SpectralClusteringManager.cache!.pageRankScores);
      // ADR-048: Restore spectral embedding and indices for local alpha
      this.spectralEmbedding = SpectralClusteringManager.cache!.spectralEmbedding;
      this.toolIndex = new Map(SpectralClusteringManager.cache!.toolIndex);
      this.capabilityIndex = new Map(SpectralClusteringManager.cache!.capabilityIndex);

      logger.debug("Restored cluster assignments from cache", {
        tools: tools.length,
        capabilities: capabilities.length,
        cacheAge: Date.now() - SpectralClusteringManager.cache!.createdAt,
      });

      return true;
    }

    return false;
  }

  /**
   * Invalidate the cluster cache (call when new capabilities are added)
   */
  static invalidateCache(): void {
    SpectralClusteringManager.cache = null;
    logger.debug("Cluster cache invalidated");
  }

  /**
   * Build bipartite adjacency matrix from tools and capabilities (AC#3)
   *
   * Matrix structure:
   * - Rows: All nodes (tools first, then capabilities)
   * - Columns: Same as rows
   * - Values: 1 if tool-capability connection, 0 otherwise
   *
   * ADR-042: Also includes capability→capability edges from dependencies.
   *
   * @param tools - List of tool IDs
   * @param capabilities - List of capabilities with their tools_used
   * @param capabilityDependencies - Optional: capability→capability edges (ADR-042)
   * @returns The adjacency matrix
   */
  buildBipartiteMatrix(
    tools: string[],
    capabilities: ClusterableCapability[],
    capabilityDependencies?: CapabilityDependency[],
  ): Matrix {
    const startTime = performance.now();

    // Build index maps
    this.toolIndex.clear();
    this.capabilityIndex.clear();

    tools.forEach((tool, idx) => this.toolIndex.set(tool, idx));
    capabilities.forEach((cap, idx) => this.capabilityIndex.set(cap.id, tools.length + idx));

    const n = tools.length + capabilities.length;

    // Initialize zero matrix
    const data: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

    // Fill edges (symmetric: tool-cap and cap-tool)
    for (const cap of capabilities) {
      const capIdx = this.capabilityIndex.get(cap.id)!;

      for (const toolId of cap.toolsUsed) {
        const toolIdx = this.toolIndex.get(toolId);
        if (toolIdx !== undefined) {
          // Undirected edge: set both directions
          data[toolIdx][capIdx] = 1;
          data[capIdx][toolIdx] = 1;
        }
      }
    }

    // ADR-042 §1: Add capability→capability edges from dependencies
    // These are symmetric for clustering (undirected graph)
    if (capabilityDependencies && capabilityDependencies.length > 0) {
      let capCapEdgesAdded = 0;

      for (const dep of capabilityDependencies) {
        // Only include edges with confidence > 0.3 (as per ADR-042)
        if (dep.confidenceScore <= 0.3) continue;

        const fromIdx = this.capabilityIndex.get(dep.fromCapabilityId);
        const toIdx = this.capabilityIndex.get(dep.toCapabilityId);

        if (fromIdx !== undefined && toIdx !== undefined) {
          // Weight based on edge_type and confidence (ADR-042)
          const typeWeight = EDGE_TYPE_WEIGHTS[dep.edgeType];
          const weight = typeWeight * dep.confidenceScore;

          // Symmetric for clustering (undirected graph)
          data[fromIdx][toIdx] = Math.max(data[fromIdx][toIdx], weight);
          data[toIdx][fromIdx] = Math.max(data[toIdx][fromIdx], weight);
          capCapEdgesAdded++;
        }
      }

      logger.debug("Added capability→capability edges to matrix (ADR-042)", {
        edgesProvided: capabilityDependencies.length,
        edgesAdded: capCapEdgesAdded,
      });
    }

    this.adjacencyMatrix = new Matrix(data);

    const elapsedMs = performance.now() - startTime;
    logger.debug("Bipartite matrix built", {
      tools: tools.length,
      capabilities: capabilities.length,
      matrixSize: n,
      hasCapDependencies: !!capabilityDependencies?.length,
      elapsedMs: elapsedMs.toFixed(1),
    });

    return this.adjacencyMatrix;
  }

  /**
   * Compute normalized Laplacian matrix (AC#3)
   *
   * Formula: L = I - D^(-1/2) × A × D^(-1/2)
   *
   * Where:
   * - I: Identity matrix
   * - D: Degree matrix (diagonal)
   * - A: Adjacency matrix
   *
   * @param adjacencyMatrix - The bipartite adjacency matrix
   * @returns Normalized Laplacian matrix
   */
  computeNormalizedLaplacian(adjacencyMatrix: Matrix): Matrix {
    const n = adjacencyMatrix.rows;

    // Compute degree matrix D (diagonal with row sums)
    const degrees: number[] = [];
    for (let i = 0; i < n; i++) {
      const rowSum = adjacencyMatrix.getRow(i).reduce((a, b) => a + b, 0);
      degrees.push(rowSum);
    }

    // Compute D^(-1/2)
    const dInvSqrt: number[] = degrees.map((d) => (d > 0 ? 1 / Math.sqrt(d) : 0));

    // Compute D^(-1/2) × A × D^(-1/2)
    const normalizedAdj = new Matrix(n, n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        normalizedAdj.set(i, j, adjacencyMatrix.get(i, j) * dInvSqrt[i] * dInvSqrt[j]);
      }
    }

    // L = I - normalized adjacency
    const laplacian = Matrix.eye(n).sub(normalizedAdj);

    return laplacian;
  }

  /**
   * Compute clusters using spectral clustering (AC#3)
   *
   * Algorithm:
   * 1. Compute normalized Laplacian
   * 2. Find k smallest eigenvectors
   * 3. K-means clustering on eigenvector rows
   *
   * @param k - Number of clusters (auto-detect if not specified)
   * @returns Cluster assignments for tools and capabilities
   */
  computeClusters(k?: number): ClusterAssignment {
    if (!this.adjacencyMatrix) {
      throw new Error("Adjacency matrix not built. Call buildBipartiteMatrix first.");
    }

    const startTime = performance.now();
    const n = this.adjacencyMatrix.rows;

    // Handle small graphs
    if (n <= 2) {
      const assignment: ClusterAssignment = {
        toolClusters: new Map(),
        capabilityClusters: new Map(),
        clusterCount: 1,
      };
      this.toolIndex.forEach((_, tool) => assignment.toolClusters.set(tool, 0));
      this.capabilityIndex.forEach((_, cap) => assignment.capabilityClusters.set(cap, 0));
      this.clusterAssignments = assignment;
      return assignment;
    }

    // Compute normalized Laplacian
    const laplacian = this.computeNormalizedLaplacian(this.adjacencyMatrix);

    // Eigendecomposition
    const eig = new EigenvalueDecomposition(laplacian);
    const eigenvalues = eig.realEigenvalues;
    const eigenvectors = eig.eigenvectorMatrix;

    // Sort eigenvalues and get indices of k smallest
    const indexed = eigenvalues.map((val, idx) => ({ val, idx }));
    indexed.sort((a, b) => a.val - b.val);

    // Auto-detect k using eigengap heuristic if not specified
    const numClusters = k ?? this.detectOptimalK(eigenvalues);
    const kEffective = Math.min(numClusters, n - 1); // Ensure we don't exceed matrix size

    // Get k smallest eigenvectors (columns)
    const embedding: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < kEffective; j++) {
        row.push(eigenvectors.get(i, indexed[j].idx));
      }
      embedding.push(row);
    }

    // ADR-048: Store spectral embedding for local alpha calculation
    this.spectralEmbedding = embedding;

    // Simple K-means clustering on the embedding
    const labels = this.kMeans(embedding, kEffective);

    // Build cluster assignments
    const assignment: ClusterAssignment = {
      toolClusters: new Map(),
      capabilityClusters: new Map(),
      clusterCount: kEffective,
    };

    this.toolIndex.forEach((idx, tool) => {
      assignment.toolClusters.set(tool, labels[idx]);
    });

    this.capabilityIndex.forEach((idx, cap) => {
      assignment.capabilityClusters.set(cap, labels[idx]);
    });

    this.clusterAssignments = assignment;

    const elapsedMs = performance.now() - startTime;
    logger.info("Spectral clustering computed", {
      nodes: n,
      clusters: kEffective,
      elapsedMs: elapsedMs.toFixed(1),
    });

    return assignment;
  }

  /**
   * Save current state to cache (Issue #7)
   *
   * Should be called after computeClusters() and computeHypergraphPageRank()
   * to cache the expensive computation results.
   *
   * @param tools - Tools used in clustering
   * @param capabilities - Capabilities used in clustering
   */
  saveToCache(tools: string[], capabilities: ClusterableCapability[]): void {
    if (!this.clusterAssignments) {
      logger.warn("Cannot save to cache: no cluster assignments");
      return;
    }

    const key = SpectralClusteringManager.generateCacheKey(tools, capabilities);

    SpectralClusteringManager.cache = {
      key,
      assignments: this.clusterAssignments,
      pageRankScores: new Map(this.pageRankScores),
      // ADR-048: Cache spectral embedding and indices for local alpha
      spectralEmbedding: this.spectralEmbedding,
      toolIndex: new Map(this.toolIndex),
      capabilityIndex: new Map(this.capabilityIndex),
      createdAt: Date.now(),
    };

    logger.debug("Cluster assignments saved to cache", {
      tools: tools.length,
      capabilities: capabilities.length,
    });
  }

  /**
   * Detect optimal number of clusters using eigengap heuristic
   *
   * Looks for the largest gap in sorted eigenvalues.
   *
   * @param eigenvalues - Sorted eigenvalues
   * @returns Optimal k
   */
  private detectOptimalK(eigenvalues: number[]): number {
    const sorted = [...eigenvalues].sort((a, b) => a - b);
    let maxGap = 0;
    let optimalK = 2;

    // Look for largest gap (skip first eigenvalue which is ~0)
    for (let i = 1; i < Math.min(sorted.length - 1, 10); i++) {
      const gap = sorted[i + 1] - sorted[i];
      if (gap > maxGap) {
        maxGap = gap;
        optimalK = i + 1;
      }
    }

    return Math.max(2, Math.min(optimalK, 5)); // Clamp between 2 and 5
  }

  /**
   * Simple K-means clustering implementation
   *
   * @param data - Points to cluster (rows = points, cols = dimensions)
   * @param k - Number of clusters
   * @param maxIter - Maximum iterations (default: 100)
   * @returns Cluster labels for each point
   */
  private kMeans(data: number[][], k: number, maxIter = 100): number[] {
    const n = data.length;
    const dims = data[0]?.length || 0;

    if (n === 0 || dims === 0) {
      return [];
    }

    // Initialize centroids using k-means++ style
    const centroids: number[][] = [];
    const usedIndices = new Set<number>();

    // First centroid: random
    const firstIdx = Math.floor(Math.random() * n);
    centroids.push([...data[firstIdx]]);
    usedIndices.add(firstIdx);

    // Remaining centroids: furthest point heuristic
    while (centroids.length < k && centroids.length < n) {
      let maxDist = -1;
      let bestIdx = 0;

      for (let i = 0; i < n; i++) {
        if (usedIndices.has(i)) continue;

        const minDistToCentroid = Math.min(
          ...centroids.map((c) => this.euclideanDistance(data[i], c)),
        );

        if (minDistToCentroid > maxDist) {
          maxDist = minDistToCentroid;
          bestIdx = i;
        }
      }

      centroids.push([...data[bestIdx]]);
      usedIndices.add(bestIdx);
    }

    // Iterative refinement
    let labels = new Array(n).fill(0);

    for (let iter = 0; iter < maxIter; iter++) {
      // Assign points to nearest centroid
      const newLabels: number[] = [];
      for (let i = 0; i < n; i++) {
        let minDist = Infinity;
        let bestCluster = 0;

        for (let c = 0; c < centroids.length; c++) {
          const dist = this.euclideanDistance(data[i], centroids[c]);
          if (dist < minDist) {
            minDist = dist;
            bestCluster = c;
          }
        }
        newLabels.push(bestCluster);
      }

      // Check convergence
      const changed = labels.some((l, i) => l !== newLabels[i]);
      labels = newLabels;

      if (!changed) break;

      // Update centroids
      for (let c = 0; c < centroids.length; c++) {
        const clusterPoints = data.filter((_, i) => labels[i] === c);
        if (clusterPoints.length > 0) {
          for (let d = 0; d < dims; d++) {
            centroids[c][d] = clusterPoints.reduce((sum, p) => sum + p[d], 0) /
              clusterPoints.length;
          }
        }
      }
    }

    return labels;
  }

  /**
   * Euclidean distance between two points
   */
  private euclideanDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += (a[i] - b[i]) ** 2;
    }
    return Math.sqrt(sum);
  }

  /**
   * Identify the active cluster based on context tools (AC#3)
   *
   * Returns the cluster ID that contains the majority of context tools.
   *
   * @param contextTools - Tools currently in use
   * @returns Active cluster ID, or -1 if no cluster found
   */
  identifyActiveCluster(contextTools: string[]): number {
    if (!this.clusterAssignments) {
      logger.debug("No cluster assignments available");
      return -1;
    }

    // Count tools per cluster
    const clusterCounts = new Map<number, number>();

    for (const tool of contextTools) {
      const cluster = this.clusterAssignments.toolClusters.get(tool);
      if (cluster !== undefined) {
        clusterCounts.set(cluster, (clusterCounts.get(cluster) || 0) + 1);
      }
    }

    if (clusterCounts.size === 0) {
      return -1;
    }

    // Find cluster with most tools
    let maxCount = 0;
    let activeCluster = -1;

    clusterCounts.forEach((count, cluster) => {
      if (count > maxCount) {
        maxCount = count;
        activeCluster = cluster;
      }
    });

    logger.debug("Active cluster identified", {
      contextTools: contextTools.slice(0, 3),
      activeCluster,
      toolsInCluster: maxCount,
    });

    return activeCluster;
  }

  /**
   * Get cluster boost for a capability (AC#3)
   *
   * Returns a boost factor (0 to 0.5) if the capability
   * is in the same cluster as the active tools.
   *
   * @param capability - Capability to check
   * @param activeCluster - The active cluster ID
   * @returns Boost factor (0 to 0.5)
   */
  getClusterBoost(capability: ClusterableCapability, activeCluster: number): number {
    if (activeCluster < 0 || !this.clusterAssignments) {
      return 0;
    }

    const capCluster = this.clusterAssignments.capabilityClusters.get(capability.id);

    if (capCluster === activeCluster) {
      // Full boost for same cluster
      return 0.5;
    }

    // Partial boost if capability's tools overlap with active cluster tools
    const capToolsInActiveCluster = capability.toolsUsed.filter((tool) => {
      const toolCluster = this.clusterAssignments?.toolClusters.get(tool);
      return toolCluster === activeCluster;
    }).length;

    if (capToolsInActiveCluster > 0) {
      // Partial boost: 0.25 * (tools in cluster / total tools)
      const ratio = capToolsInActiveCluster / capability.toolsUsed.length;
      return 0.25 * ratio;
    }

    return 0;
  }

  /**
   * Compute Hypergraph PageRank for capabilities (AC#3b)
   *
   * Treats the bipartite graph as a hypergraph where capabilities
   * are hyperedges connecting multiple tools. Computes importance
   * score via power iteration.
   *
   * ADR-042 §2: Considers directed Cap→Cap edges for PageRank.
   * A capability with many 'dependency' edges incoming = more important.
   * A capability that 'contains' others = "meta-capability" = more important.
   *
   * @param capabilities - Capabilities to rank
   * @param dampingFactor - PageRank damping factor (default: 0.85)
   * @param maxIter - Maximum iterations (default: 100)
   * @param capabilityDependencies - Optional: Cap→Cap edges for directed PageRank (ADR-042)
   * @returns Map of capability_id to PageRank score (0-1)
   */
  computeHypergraphPageRank(
    capabilities: ClusterableCapability[],
    dampingFactor = 0.85,
    maxIter = 100,
    capabilityDependencies?: CapabilityDependency[],
  ): Map<string, number> {
    const startTime = performance.now();

    if (!this.adjacencyMatrix) {
      logger.warn("Adjacency matrix not built, returning empty PageRank");
      return new Map();
    }

    const n = this.adjacencyMatrix.rows;

    // Copy adjacency matrix for modification with directed edges
    const pageRankMatrix: number[][] = [];
    for (let i = 0; i < n; i++) {
      pageRankMatrix.push([...this.adjacencyMatrix.getRow(i)]);
    }

    // ADR-042 §2: Add directed Cap→Cap edges for PageRank
    // 'dependency' and 'contains' edges contribute to target's importance
    if (capabilityDependencies && capabilityDependencies.length > 0) {
      let directedEdgesAdded = 0;

      for (const dep of capabilityDependencies) {
        // Only 'dependency' and 'contains' types contribute to PageRank (ADR-042)
        if (dep.edgeType !== "dependency" && dep.edgeType !== "contains") continue;

        const fromIdx = this.capabilityIndex.get(dep.fromCapabilityId);
        const toIdx = this.capabilityIndex.get(dep.toCapabilityId);

        if (fromIdx !== undefined && toIdx !== undefined) {
          // Directed edge: from → to (to receives PageRank)
          // Weight by confidence score
          pageRankMatrix[fromIdx][toIdx] += dep.confidenceScore;
          directedEdgesAdded++;
        }
      }

      logger.debug("Added directed Cap→Cap edges for PageRank (ADR-042)", {
        directedEdgesAdded,
      });
    }

    // Initialize scores uniformly
    let scores = new Array(n).fill(1 / n);

    // Power iteration
    for (let iter = 0; iter < maxIter; iter++) {
      const newScores = new Array(n).fill((1 - dampingFactor) / n);

      for (let i = 0; i < n; i++) {
        // Get outgoing edges (degree) from modified matrix
        const outDegree = pageRankMatrix[i].reduce((a, b) => a + b, 0);

        if (outDegree > 0) {
          for (let j = 0; j < n; j++) {
            if (pageRankMatrix[i][j] > 0) {
              newScores[j] += dampingFactor * scores[i] * pageRankMatrix[i][j] / outDegree;
            }
          }
        } else {
          // Dangling node: distribute equally
          for (let j = 0; j < n; j++) {
            newScores[j] += dampingFactor * scores[i] / n;
          }
        }
      }

      // Check convergence
      const diff = scores.reduce((sum, s, i) => sum + Math.abs(s - newScores[i]), 0);
      scores = newScores;

      if (diff < 1e-6) {
        logger.debug(`PageRank converged at iteration ${iter}`);
        break;
      }
    }

    // Extract capability scores (indices after tools)
    this.pageRankScores.clear();
    this.capabilityIndex.forEach((idx, capId) => {
      this.pageRankScores.set(capId, scores[idx]);
    });

    const elapsedMs = performance.now() - startTime;
    logger.debug("Hypergraph PageRank computed", {
      capabilities: capabilities.length,
      hasCapDependencies: !!capabilityDependencies?.length,
      elapsedMs: elapsedMs.toFixed(1),
    });

    return this.pageRankScores;
  }

  /**
   * Get PageRank score for a capability
   *
   * @param capabilityId - Capability ID
   * @returns PageRank score (0-1) or 0 if not computed
   */
  getPageRank(capabilityId: string): number {
    return this.pageRankScores.get(capabilityId) ?? 0;
  }

  /**
   * Get all PageRank scores (Story 8.2)
   *
   * Used by HypergraphBuilder for capability node sizing.
   *
   * @returns Map of capability ID to PageRank score
   */
  getAllPageRanks(): Map<string, number> {
    return new Map(this.pageRankScores);
  }

  /**
   * Get cluster assignment for a capability
   *
   * @param capabilityId - Capability ID
   * @returns Cluster ID or -1 if not assigned
   */
  getCapabilityCluster(capabilityId: string): number {
    return this.clusterAssignments?.capabilityClusters.get(capabilityId) ?? -1;
  }

  /**
   * Get cluster assignment for a tool
   *
   * @param toolId - Tool ID
   * @returns Cluster ID or -1 if not assigned
   */
  getToolCluster(toolId: string): number {
    return this.clusterAssignments?.toolClusters.get(toolId) ?? -1;
  }

  /**
   * Check if clustering has been computed
   */
  hasClusters(): boolean {
    return this.clusterAssignments !== null;
  }

  /**
   * Get the number of clusters
   */
  getClusterCount(): number {
    return this.clusterAssignments?.clusterCount ?? 0;
  }

  // ===========================================================================
  // ADR-048: Methods for Local Alpha Calculation
  // ===========================================================================

  /**
   * Get spectral embedding row for a node (ADR-048)
   *
   * Returns the eigenvector-based embedding for a tool or capability,
   * used by LocalAlphaCalculator for Embeddings Hybrides algorithm.
   *
   * @param nodeId - Tool or capability ID
   * @returns Embedding vector or null if not found
   */
  getEmbeddingRow(nodeId: string): number[] | null {
    if (!this.spectralEmbedding) return null;

    // Check tool index first
    const toolIdx = this.toolIndex.get(nodeId);
    if (toolIdx !== undefined && toolIdx < this.spectralEmbedding.length) {
      return [...this.spectralEmbedding[toolIdx]];
    }

    // Then capability index
    const capIdx = this.capabilityIndex.get(nodeId);
    if (capIdx !== undefined && capIdx < this.spectralEmbedding.length) {
      return [...this.spectralEmbedding[capIdx]];
    }

    return null;
  }

  /**
   * Get node index in the adjacency matrix (ADR-048)
   *
   * @param nodeId - Tool or capability ID
   * @returns Index or -1 if not found
   */
  getNodeIndex(nodeId: string): number {
    const toolIdx = this.toolIndex.get(nodeId);
    if (toolIdx !== undefined) return toolIdx;

    const capIdx = this.capabilityIndex.get(nodeId);
    if (capIdx !== undefined) return capIdx;

    return -1;
  }

  /**
   * Check if spectral embedding has been computed (ADR-048)
   */
  hasEmbedding(): boolean {
    return this.spectralEmbedding !== null && this.spectralEmbedding.length > 0;
  }
}
