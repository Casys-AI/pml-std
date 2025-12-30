/**
 * Tensor Entropy for Hypergraphs
 *
 * Spike implementation based on Chen & Rajapakse (2020) - IEEE TNSE
 * "Tensor Entropy for Uniform Hypergraphs"
 *
 * This module provides entropy measures that are meaningful for large graphs
 * and hypergraphs, replacing the naive Shannon entropy on edge weights.
 *
 * Key insight: Instead of treating edges independently, we use the spectral
 * properties of the graph Laplacian to capture structural information.
 *
 * For superhypergraphs (like our tool→capability→workflow structure), we
 * compute entropy at multiple orders:
 * - Order 2: Standard edges (tool→tool dependencies)
 * - Order 3+: Hyperedges (capability containing multiple tools)
 *
 * @module graphrag/algorithms/tensor-entropy
 * @see https://ieeexplore.ieee.org/document/9119161/
 */

import * as log from "@std/log";

/**
 * Result of tensor entropy computation
 */
export interface TensorEntropyResult {
  /** Von Neumann entropy from Laplacian spectrum (main metric) */
  vonNeumannEntropy: number;

  /** Structural entropy (Li Angsheng approximation) - faster */
  structuralEntropy: number;

  /** Entropy per hyperedge order (k=2 for edges, k=3+ for hyperedges) */
  entropyByOrder: Map<number, number>;

  /** Theoretical bounds for interpretation */
  bounds: {
    lower: number; // 0 = perfectly regular/star
    upper: number; // log(n) = complete disorder
  };

  /** Normalized entropy [0,1] with clear semantics */
  normalized: number;

  /** Health interpretation (uses size-adjusted thresholds) */
  health: "rigid" | "healthy" | "chaotic";

  /** Size-adjusted thresholds used for health classification */
  adjustedThresholds: {
    low: number;   // Below this = "rigid"
    high: number;  // Above this = "chaotic"
  };

  /** Computation metadata */
  meta: {
    nodeCount: number;
    edgeCount: number;
    hyperedgeCount: number;
    computeTimeMs: number;
  };
}

/**
 * Graph-like interface for entropy computation
 */
export interface EntropyGraphInput {
  nodes: Array<{ id: string; type?: string }>;
  edges: Array<{
    source: string;
    target: string;
    weight?: number;
    edge_type?: string;
  }>;
  /** Hyperedges: sets of nodes connected together (e.g., capability → [tool1, tool2, tool3]) */
  hyperedges?: Array<{
    id: string;
    members: string[];
    weight?: number;
  }>;
}

/**
 * Build adjacency matrix from graph edges
 * Returns a Map<string, Map<string, number>> for sparse representation
 *
 * Note: Automatically includes nodes referenced by edges even if not in nodes list
 */
function buildAdjacencyMatrix(
  nodes: string[],
  edges: Array<{ source: string; target: string; weight?: number }>,
): Map<string, Map<string, number>> {
  const adj = new Map<string, Map<string, number>>();

  // Initialize empty rows for provided nodes
  for (const node of nodes) {
    adj.set(node, new Map());
  }

  // Fill in edge weights (symmetric for undirected interpretation)
  // Also add nodes referenced by edges if not already present
  for (const edge of edges) {
    const w = edge.weight ?? 1;

    // Ensure source node exists
    if (!adj.has(edge.source)) {
      adj.set(edge.source, new Map());
    }
    // Ensure target node exists
    if (!adj.has(edge.target)) {
      adj.set(edge.target, new Map());
    }

    const srcRow = adj.get(edge.source)!;
    const tgtRow = adj.get(edge.target)!;

    srcRow.set(edge.target, w);
    tgtRow.set(edge.source, w);
  }

  return adj;
}

/**
 * Compute degree vector from adjacency matrix
 */
function computeDegrees(
  adj: Map<string, Map<string, number>>,
): Map<string, number> {
  const degrees = new Map<string, number>();

  for (const [node, neighbors] of adj) {
    let deg = 0;
    for (const w of neighbors.values()) {
      deg += w;
    }
    degrees.set(node, deg);
  }

  return degrees;
}

/**
 * Compute Structural Entropy (Li Angsheng approximation)
 *
 * This is the Shannon entropy of the normalized degree sequence.
 * Proven to be within [0, log(2e)] of Von Neumann entropy.
 * Much faster than full spectral computation: O(n) vs O(n³)
 *
 * Formula: H_struct = -Σ (d_i / 2m) * log2(d_i / 2m)
 * where d_i is degree of node i, m is total edge weight
 *
 * @see https://arxiv.org/abs/2102.09766
 */
function computeStructuralEntropy(degrees: Map<string, number>): number {
  const degreeValues = Array.from(degrees.values()).filter((d) => d > 0);

  if (degreeValues.length === 0) return 0;

  const totalDegree = degreeValues.reduce((sum, d) => sum + d, 0);
  if (totalDegree === 0) return 0;

  let entropy = 0;
  for (const d of degreeValues) {
    const p = d / totalDegree;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}

/**
 * Compute Von Neumann entropy via Laplacian eigenvalues
 *
 * For large graphs, we use the quadratic approximation:
 * H_VN ≈ 1 - (1/n) - Σ(d_i² / 4m²)
 *
 * This avoids O(n³) eigenvalue computation while maintaining accuracy.
 *
 * @see https://www.semanticscholar.org/paper/Fast-Computing-von-Neumann-Entropy-for-Large-scale-Choi-He
 */
function computeVonNeumannEntropyApprox(
  degrees: Map<string, number>,
  totalEdgeWeight: number,
): number {
  const n = degrees.size;
  if (n <= 1 || totalEdgeWeight === 0) return 0;

  // Quadratic approximation: H ≈ 1 - 1/n - Σ(d_i² / 4m²)
  let sumDegSquared = 0;
  for (const d of degrees.values()) {
    sumDegSquared += d * d;
  }

  const m = totalEdgeWeight;
  const entropy = 1 - (1 / n) - sumDegSquared / (4 * m * m);

  // Clamp to valid range [0, 1]
  return Math.max(0, Math.min(1, entropy));
}

/**
 * Extract hyperedges from capability→tool relationships
 *
 * In our graph structure:
 * - Nodes with type="capability" that have "contains" or "provides" edges to tools
 *   form hyperedges of order k (where k = number of connected tools)
 * - Also groups tools that share common sources (co-occurrence patterns)
 */
function extractHyperedges(
  graph: EntropyGraphInput,
): Array<{ id: string; members: string[]; order: number }> {
  // If explicit hyperedges provided, use them
  if (graph.hyperedges && graph.hyperedges.length > 0) {
    return graph.hyperedges.map((he) => ({
      id: he.id,
      members: he.members,
      order: he.members.length,
    }));
  }

  const hyperedges: Array<{ id: string; members: string[]; order: number }> = [];

  // Method 1: Capability nodes with outgoing edges (contains, provides)
  const capabilities = graph.nodes.filter((n) => n.type === "capability");
  const groupingEdgeTypes = new Set(["contains", "provides"]);

  for (const cap of capabilities) {
    const connectedTools = graph.edges
      .filter((e) => e.source === cap.id && groupingEdgeTypes.has(e.edge_type || ""))
      .map((e) => e.target);

    if (connectedTools.length >= 2) {
      hyperedges.push({
        id: cap.id,
        members: connectedTools,
        order: connectedTools.length,
      });
    }
  }

  // Method 2: Group by source node (any node with multiple outgoing "provides" edges)
  // This catches tool groupings even without explicit capability nodes
  if (hyperedges.length === 0) {
    const sourceToTargets = new Map<string, string[]>();

    for (const edge of graph.edges) {
      if (edge.edge_type === "provides" || edge.edge_type === "contains") {
        const targets = sourceToTargets.get(edge.source) || [];
        targets.push(edge.target);
        sourceToTargets.set(edge.source, targets);
      }
    }

    for (const [source, targets] of sourceToTargets) {
      if (targets.length >= 2) {
        hyperedges.push({
          id: source,
          members: targets,
          order: targets.length,
        });
      }
    }
  }

  return hyperedges;
}

/**
 * Compute entropy for hyperedges of a specific order k
 *
 * Uses the incidence matrix approach from ERH (Exponential Random Hypergraphs)
 * For order-k hyperedges, the entropy measures regularity of the k-uniform structure.
 */
function computeHyperedgeEntropy(
  hyperedges: Array<{ members: string[]; order: number }>,
  order: number,
): number {
  // Filter to hyperedges of this order
  const kHyperedges = hyperedges.filter((he) => he.order === order);

  if (kHyperedges.length === 0) return 0;

  // Count participation of each node in k-hyperedges
  const participation = new Map<string, number>();

  for (const he of kHyperedges) {
    for (const member of he.members) {
      participation.set(member, (participation.get(member) || 0) + 1);
    }
  }

  // Compute entropy of participation distribution
  const counts = Array.from(participation.values());
  const total = counts.reduce((sum, c) => sum + c, 0);

  if (total === 0) return 0;

  let entropy = 0;
  for (const c of counts) {
    const p = c / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  // Normalize by max possible entropy
  const maxEntropy = Math.log2(participation.size);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/**
 * Compute size-adjusted entropy thresholds
 *
 * For small graphs (n < 50), use strict thresholds [0.3, 0.7]
 * For larger graphs, entropy naturally trends higher due to sparsity.
 * We adjust thresholds based on expected entropy for random graphs.
 *
 * Expected entropy for Erdős–Rényi random graph with density p:
 * E[H] ≈ 1 - 1/n - p(1-p)/2
 *
 * For sparse graphs (p << 1), E[H] ≈ 1 - 1/n ≈ 1
 *
 * We use a log-based adjustment:
 * - threshold_low = 0.3 + 0.1 * log10(n/50) for n > 50
 * - threshold_high = 0.7 + 0.05 * log10(n/50) for n > 50
 */
function computeSizeAdjustedThresholds(
  nodeCount: number,
  edgeCount: number,
): { low: number; high: number } {
  const BASE_LOW = 0.3;
  const BASE_HIGH = 0.7;

  if (nodeCount <= 50) {
    return { low: BASE_LOW, high: BASE_HIGH };
  }

  // Compute graph density
  const maxEdges = nodeCount * (nodeCount - 1) / 2;
  const density = maxEdges > 0 ? edgeCount / maxEdges : 0;

  // For sparse graphs, raise thresholds
  // The sparser the graph, the higher the natural entropy
  const sizeAdjustment = Math.log10(nodeCount / 50);
  const sparsityAdjustment = density < 0.1 ? 0.1 * (1 - density * 10) : 0;

  const low = Math.min(0.8, BASE_LOW + 0.1 * sizeAdjustment + sparsityAdjustment);
  const high = Math.min(0.95, BASE_HIGH + 0.05 * sizeAdjustment + sparsityAdjustment);

  return { low, high };
}

/**
 * Determine health status based on entropy value with size adjustment
 *
 * Uses size-adjusted thresholds to account for natural entropy
 * increase in large sparse graphs.
 */
function determineHealth(
  normalizedEntropy: number,
  nodeCount: number = 50,
  edgeCount: number = 100,
): "rigid" | "healthy" | "chaotic" {
  const thresholds = computeSizeAdjustedThresholds(nodeCount, edgeCount);

  if (normalizedEntropy < thresholds.low) return "rigid";
  if (normalizedEntropy > thresholds.high) return "chaotic";
  return "healthy";
}

/**
 * Compute tensor entropy for a graph/hypergraph
 *
 * Main entry point for entropy computation. Computes multiple entropy
 * measures and returns a comprehensive result with interpretation.
 *
 * @param graph - Graph with nodes, edges, and optional hyperedges
 * @returns TensorEntropyResult with all entropy measures
 */
export function computeTensorEntropy(
  graph: EntropyGraphInput,
): TensorEntropyResult {
  const startTime = performance.now();

  const nodeIds = graph.nodes.map((n) => n.id);
  const n = nodeIds.length;

  if (n === 0) {
    return {
      vonNeumannEntropy: 0,
      structuralEntropy: 0,
      entropyByOrder: new Map(),
      bounds: { lower: 0, upper: 0 },
      normalized: 0,
      health: "rigid",
      adjustedThresholds: { low: 0.3, high: 0.7 },
      meta: {
        nodeCount: 0,
        edgeCount: 0,
        hyperedgeCount: 0,
        computeTimeMs: performance.now() - startTime,
      },
    };
  }

  // Build adjacency and compute degrees
  const adj = buildAdjacencyMatrix(nodeIds, graph.edges);
  const degrees = computeDegrees(adj);

  // Total edge weight (sum of all edge weights, counted once)
  let totalEdgeWeight = 0;
  for (const edge of graph.edges) {
    totalEdgeWeight += edge.weight ?? 1;
  }

  // Compute structural entropy (fast, O(n)) - Li Angsheng approximation
  const structuralEntropyRaw = computeStructuralEntropy(degrees);

  // Normalize structural entropy to [0, 1] by dividing by max entropy log2(n)
  // This is the PRIMARY metric for sparse graphs (Story 6.6)
  const maxStructuralEntropy = n > 1 ? Math.log2(n) : 1;
  const structuralEntropy = structuralEntropyRaw / maxStructuralEntropy;

  // Compute Von Neumann entropy approximation (fast, O(n))
  // Note: VN entropy is less meaningful for sparse graphs
  const vonNeumannEntropy = computeVonNeumannEntropyApprox(degrees, totalEdgeWeight);

  // Extract and analyze hyperedges
  const hyperedges = extractHyperedges(graph);
  const entropyByOrder = new Map<number, number>();

  // Always compute order-2 (standard edges)
  entropyByOrder.set(2, vonNeumannEntropy);

  // Compute entropy for each hyperedge order
  const orders = new Set(hyperedges.map((he) => he.order));
  for (const order of orders) {
    if (order > 2) {
      const heEntropy = computeHyperedgeEntropy(hyperedges, order);
      entropyByOrder.set(order, heEntropy);
    }
  }

  // Theoretical bounds
  const maxEntropy = n > 1 ? Math.log2(n) : 0;
  const bounds = { lower: 0, upper: maxEntropy };

  // Normalized entropy: use structural entropy as primary metric (Story 6.6)
  // Structural entropy is more meaningful for sparse graphs than Von Neumann
  // For hyperedge-aware normalization, we average with hyperedge entropy if available
  let normalized = structuralEntropy;

  // If we have higher-order hyperedges, blend with their entropy
  const higherOrderEntropies = Array.from(entropyByOrder.entries())
    .filter(([order]) => order > 2);

  if (higherOrderEntropies.length > 0) {
    const hyperedgeAvg = higherOrderEntropies.reduce((sum, [, e]) => sum + e, 0) / higherOrderEntropies.length;
    // Blend: 70% structural, 30% hyperedge
    normalized = 0.7 * structuralEntropy + 0.3 * hyperedgeAvg;
  }

  // Compute size-adjusted thresholds
  const adjustedThresholds = computeSizeAdjustedThresholds(adj.size, graph.edges.length);

  const computeTimeMs = performance.now() - startTime;

  log.debug(
    `[TensorEntropy] n=${n}, edges=${graph.edges.length}, hyperedges=${hyperedges.length}, ` +
      `H_struct=${structuralEntropy.toFixed(3)} (raw=${structuralEntropyRaw.toFixed(2)}bits), ` +
      `H_VN=${vonNeumannEntropy.toFixed(3)}, normalized=${normalized.toFixed(3)}, time=${computeTimeMs.toFixed(1)}ms`,
  );

  return {
    vonNeumannEntropy,
    structuralEntropy,
    entropyByOrder,
    bounds,
    normalized,
    health: determineHealth(normalized, adj.size, graph.edges.length),
    // Include adjusted thresholds for UI display
    adjustedThresholds: adjustedThresholds,
    meta: {
      nodeCount: adj.size, // Use actual node count including edge-referenced nodes
      edgeCount: graph.edges.length,
      hyperedgeCount: hyperedges.length,
      computeTimeMs,
    },
  };
}

/**
 * Convert GraphSnapshot to EntropyGraphInput
 *
 * Helper to use tensor entropy with existing graph snapshots.
 */
export function snapshotToEntropyInput(
  snapshot: {
    nodes: Array<{ id: string; communityId?: string }>;
    edges: Array<{
      source: string;
      target: string;
      confidence?: number;
      edge_type?: string;
    }>;
  },
): EntropyGraphInput {
  return {
    nodes: snapshot.nodes.map((n) => ({
      id: n.id,
      type: n.id.startsWith("capability:") ? "capability" : undefined,
    })),
    edges: snapshot.edges.map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.confidence,
      edge_type: e.edge_type,
    })),
  };
}

// ============================================================================
// Semantic Entropy (arxiv:2503.18852)
// ============================================================================

/**
 * Semantic Entropy Result
 *
 * Measures diversity in embedding space. Based on arxiv:2503.18852 which shows
 * that structural + semantic dual entropy provides more meaningful health metrics.
 */
export interface SemanticEntropyResult {
  /** Entropy of cosine similarity distribution (0=identical, high=diverse) */
  semanticEntropy: number;

  /** Average pairwise cosine similarity (1=identical, 0=orthogonal) */
  avgCosineSimilarity: number;

  /** Standard deviation of similarities */
  similarityStdDev: number;

  /** Normalized semantic diversity [0,1] (inverse of avg similarity) */
  semanticDiversity: number;

  /** Embedding space statistics */
  stats: {
    nodeCount: number;
    embeddingDim: number;
    computeTimeMs: number;
  };
}

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dotProduct / denominator : 0;
}

/**
 * Compute semantic entropy from embeddings
 *
 * Based on arxiv:2503.18852 "Structural and Semantic Entropy" framework.
 * Measures the diversity of node representations in embedding space.
 *
 * Algorithm:
 * 1. Compute all pairwise cosine similarities
 * 2. Transform similarities to a probability distribution
 * 3. Compute Shannon entropy of this distribution
 *
 * Interpretation:
 * - High entropy = embeddings are diverse (tools cover different semantic areas)
 * - Low entropy = embeddings are similar (tools are semantically redundant)
 *
 * @param embeddings - Map of node ID to embedding vector
 * @returns SemanticEntropyResult with diversity metrics
 */
export function computeSemanticEntropy(
  embeddings: Map<string, number[]>,
): SemanticEntropyResult {
  const startTime = performance.now();

  const nodeIds = Array.from(embeddings.keys());
  const n = nodeIds.length;

  // Handle edge cases
  if (n < 2) {
    return {
      semanticEntropy: 0,
      avgCosineSimilarity: 1,
      similarityStdDev: 0,
      semanticDiversity: 0,
      stats: {
        nodeCount: n,
        embeddingDim: n > 0 ? (embeddings.get(nodeIds[0])?.length || 0) : 0,
        computeTimeMs: performance.now() - startTime,
      },
    };
  }

  // Compute all pairwise similarities (upper triangle)
  const similarities: number[] = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const embA = embeddings.get(nodeIds[i])!;
      const embB = embeddings.get(nodeIds[j])!;
      const sim = cosineSimilarity(embA, embB);
      similarities.push(sim);
    }
  }

  // Compute mean and std of similarities
  const avgSim = similarities.reduce((sum, s) => sum + s, 0) / similarities.length;

  let variance = 0;
  for (const s of similarities) {
    variance += (s - avgSim) * (s - avgSim);
  }
  variance /= similarities.length;
  const stdDev = Math.sqrt(variance);

  // Transform similarities to probability distribution
  // Use softmax-like transformation: shift to positive and normalize
  // This ensures we capture the distribution shape, not just values
  const minSim = Math.min(...similarities);
  const shifted = similarities.map((s) => s - minSim + 0.01); // Add small constant
  const total = shifted.reduce((sum, s) => sum + s, 0);
  const probs = shifted.map((s) => s / total);

  // Compute Shannon entropy of similarity distribution
  let entropy = 0;
  for (const p of probs) {
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  // Normalize by maximum possible entropy
  const maxEntropy = Math.log2(similarities.length);
  const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

  // Semantic diversity = 1 - avg_similarity (scaled to [0,1])
  // avgSim typically in [-1,1], but for embedding space usually [0,1]
  const semanticDiversity = Math.max(0, Math.min(1, 1 - avgSim));

  const embeddingDim = embeddings.get(nodeIds[0])?.length || 0;

  log.debug(
    `[SemanticEntropy] n=${n}, dim=${embeddingDim}, avgSim=${avgSim.toFixed(3)}, ` +
      `entropy=${normalizedEntropy.toFixed(3)}, diversity=${semanticDiversity.toFixed(3)}`,
  );

  return {
    semanticEntropy: normalizedEntropy,
    avgCosineSimilarity: avgSim,
    similarityStdDev: stdDev,
    semanticDiversity,
    stats: {
      nodeCount: n,
      embeddingDim,
      computeTimeMs: performance.now() - startTime,
    },
  };
}

/**
 * Combined structural + semantic entropy (dual entropy)
 *
 * Based on arxiv:2503.18852, the combination provides more robust
 * health assessment than either metric alone.
 *
 * Formula: H_combined = α * H_structural + (1-α) * H_semantic
 *
 * @param structural - Von Neumann / structural entropy [0,1]
 * @param semantic - Semantic entropy [0,1]
 * @param alpha - Weight for structural (default 0.6, structural slightly more important)
 * @returns Combined entropy score
 */
export function computeDualEntropy(
  structural: number,
  semantic: number,
  alpha = 0.6,
): number {
  return alpha * structural + (1 - alpha) * semantic;
}

// ============================================================================
// Entropy History Persistence
// ============================================================================

/**
 * Entropy history record for database persistence
 */
export interface EntropyHistoryRecord {
  recordedAt: Date;
  vonNeumannEntropy: number;
  structuralEntropy: number;
  normalizedEntropy: number;
  semanticEntropy?: number;
  semanticDiversity?: number;
  avgCosineSimilarity?: number;
  dualEntropy?: number;
  healthStatus: "rigid" | "healthy" | "chaotic";
  thresholdLow: number;
  thresholdHigh: number;
  nodeCount: number;
  edgeCount: number;
  hyperedgeCount: number;
  entropyByOrder?: Record<number, number>;
  userId?: string;
  computeTimeMs?: number;
}

/**
 * Database client interface for entropy persistence
 */
interface EntropyDbClient {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  exec(sql: string): Promise<void>;
}

/**
 * Save entropy snapshot to history
 *
 * @param db - Database client
 * @param tensorResult - Result from computeTensorEntropy
 * @param semanticResult - Optional result from computeSemanticEntropy
 * @param userId - Optional user ID for per-user tracking
 */
export async function saveEntropySnapshot(
  db: EntropyDbClient,
  tensorResult: TensorEntropyResult,
  semanticResult?: SemanticEntropyResult,
  userId?: string,
): Promise<void> {
  const dualEntropy = semanticResult
    ? computeDualEntropy(tensorResult.vonNeumannEntropy, semanticResult.semanticEntropy)
    : null;

  // Convert Map to object for JSONB
  const entropyByOrder: Record<string, number> = {};
  for (const [order, entropy] of tensorResult.entropyByOrder) {
    entropyByOrder[order.toString()] = entropy;
  }

  const sql = `
    INSERT INTO entropy_history (
      von_neumann_entropy,
      structural_entropy,
      normalized_entropy,
      semantic_entropy,
      semantic_diversity,
      avg_cosine_similarity,
      dual_entropy,
      health_status,
      threshold_low,
      threshold_high,
      node_count,
      edge_count,
      hyperedge_count,
      entropy_by_order,
      user_id,
      compute_time_ms
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  `;

  await db.query(sql, [
    tensorResult.vonNeumannEntropy,
    tensorResult.structuralEntropy,
    tensorResult.normalized,
    semanticResult?.semanticEntropy ?? null,
    semanticResult?.semanticDiversity ?? null,
    semanticResult?.avgCosineSimilarity ?? null,
    dualEntropy,
    tensorResult.health,
    tensorResult.adjustedThresholds.low,
    tensorResult.adjustedThresholds.high,
    tensorResult.meta.nodeCount,
    tensorResult.meta.edgeCount,
    tensorResult.meta.hyperedgeCount,
    JSON.stringify(entropyByOrder),
    userId ?? null,
    tensorResult.meta.computeTimeMs + (semanticResult?.stats.computeTimeMs ?? 0),
  ]);

  log.debug(
    `[EntropyHistory] Saved snapshot: VN=${tensorResult.vonNeumannEntropy.toFixed(3)}, ` +
      `health=${tensorResult.health}, nodes=${tensorResult.meta.nodeCount}`,
  );
}

/**
 * Get entropy history for trend analysis
 *
 * @param db - Database client
 * @param options - Query options
 * @returns Array of historical entropy records
 */
export async function getEntropyHistory(
  db: EntropyDbClient,
  options: {
    limit?: number;
    userId?: string;
    since?: Date;
    healthStatus?: "rigid" | "healthy" | "chaotic";
  } = {},
): Promise<EntropyHistoryRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.userId) {
    conditions.push(`user_id = $${paramIndex++}`);
    params.push(options.userId);
  }

  if (options.since) {
    conditions.push(`recorded_at >= $${paramIndex++}`);
    params.push(options.since.toISOString());
  }

  if (options.healthStatus) {
    conditions.push(`health_status = $${paramIndex++}`);
    params.push(options.healthStatus);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const limitClause = options.limit ? `LIMIT ${options.limit}` : "LIMIT 100";

  const sql = `
    SELECT
      recorded_at,
      von_neumann_entropy,
      structural_entropy,
      normalized_entropy,
      semantic_entropy,
      semantic_diversity,
      avg_cosine_similarity,
      dual_entropy,
      health_status,
      threshold_low,
      threshold_high,
      node_count,
      edge_count,
      hyperedge_count,
      entropy_by_order,
      user_id,
      compute_time_ms
    FROM entropy_history
    ${whereClause}
    ORDER BY recorded_at DESC
    ${limitClause}
  `;

  const rows = await db.query(sql, params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    recordedAt: new Date(row.recorded_at as string),
    vonNeumannEntropy: row.von_neumann_entropy as number,
    structuralEntropy: row.structural_entropy as number,
    normalizedEntropy: row.normalized_entropy as number,
    semanticEntropy: row.semantic_entropy as number | undefined,
    semanticDiversity: row.semantic_diversity as number | undefined,
    avgCosineSimilarity: row.avg_cosine_similarity as number | undefined,
    dualEntropy: row.dual_entropy as number | undefined,
    healthStatus: row.health_status as "rigid" | "healthy" | "chaotic",
    thresholdLow: row.threshold_low as number,
    thresholdHigh: row.threshold_high as number,
    nodeCount: row.node_count as number,
    edgeCount: row.edge_count as number,
    hyperedgeCount: row.hyperedge_count as number,
    entropyByOrder: row.entropy_by_order as Record<number, number> | undefined,
    userId: row.user_id as string | undefined,
    computeTimeMs: row.compute_time_ms as number | undefined,
  }));
}

/**
 * Get entropy trend summary
 *
 * @param db - Database client
 * @param days - Number of days to analyze (default 7)
 * @returns Trend summary with averages and direction
 */
export async function getEntropyTrend(
  db: EntropyDbClient,
  days = 7,
): Promise<{
  avgVonNeumann: number;
  avgStructural: number;
  avgSemantic: number | null;
  avgDual: number | null;
  healthDistribution: Record<string, number>;
  trend: "improving" | "stable" | "degrading";
  dataPoints: number;
}> {
  const sql = `
    WITH recent AS (
      SELECT *
      FROM entropy_history
      WHERE recorded_at >= NOW() - INTERVAL '${days} days'
    ),
    first_half AS (
      SELECT AVG(von_neumann_entropy) as avg_vn
      FROM recent
      WHERE recorded_at < NOW() - INTERVAL '${days / 2} days'
    ),
    second_half AS (
      SELECT AVG(von_neumann_entropy) as avg_vn
      FROM recent
      WHERE recorded_at >= NOW() - INTERVAL '${days / 2} days'
    )
    SELECT
      (SELECT COUNT(*) FROM recent) as data_points,
      (SELECT AVG(von_neumann_entropy) FROM recent) as avg_vn,
      (SELECT AVG(structural_entropy) FROM recent) as avg_struct,
      (SELECT AVG(semantic_entropy) FROM recent WHERE semantic_entropy IS NOT NULL) as avg_sem,
      (SELECT AVG(dual_entropy) FROM recent WHERE dual_entropy IS NOT NULL) as avg_dual,
      (SELECT COUNT(*) FROM recent WHERE health_status = 'rigid') as rigid_count,
      (SELECT COUNT(*) FROM recent WHERE health_status = 'healthy') as healthy_count,
      (SELECT COUNT(*) FROM recent WHERE health_status = 'chaotic') as chaotic_count,
      first_half.avg_vn as first_avg,
      second_half.avg_vn as second_avg
    FROM first_half, second_half
  `;

  const rows = await db.query(sql, []) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return {
      avgVonNeumann: 0,
      avgStructural: 0,
      avgSemantic: null,
      avgDual: null,
      healthDistribution: { rigid: 0, healthy: 0, chaotic: 0 },
      trend: "stable",
      dataPoints: 0,
    };
  }

  const row = rows[0];
  const firstAvg = row.first_avg as number | null;
  const secondAvg = row.second_avg as number | null;

  // Determine trend: entropy moving toward healthy range is "improving"
  let trend: "improving" | "stable" | "degrading" = "stable";
  if (firstAvg !== null && secondAvg !== null) {
    // Improvement = moving toward 0.5 (center of healthy range)
    const firstDistFromOptimal = Math.abs(firstAvg - 0.5);
    const secondDistFromOptimal = Math.abs(secondAvg - 0.5);

    if (secondDistFromOptimal < firstDistFromOptimal - 0.05) {
      trend = "improving";
    } else if (secondDistFromOptimal > firstDistFromOptimal + 0.05) {
      trend = "degrading";
    }
  }

  return {
    avgVonNeumann: (row.avg_vn as number) ?? 0,
    avgStructural: (row.avg_struct as number) ?? 0,
    avgSemantic: row.avg_sem as number | null,
    avgDual: row.avg_dual as number | null,
    healthDistribution: {
      rigid: (row.rigid_count as number) ?? 0,
      healthy: (row.healthy_count as number) ?? 0,
      chaotic: (row.chaotic_count as number) ?? 0,
    },
    trend,
    dataPoints: (row.data_points as number) ?? 0,
  };
}

// Export internals for testing
export const _internals = {
  buildAdjacencyMatrix,
  computeDegrees,
  computeStructuralEntropy,
  computeVonNeumannEntropyApprox,
  extractHyperedges,
  computeHyperedgeEntropy,
  determineHealth,
  computeSizeAdjustedThresholds,
  cosineSimilarity,
  computeSemanticEntropy,
  computeDualEntropy,
};
