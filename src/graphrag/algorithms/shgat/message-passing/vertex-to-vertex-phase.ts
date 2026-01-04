/**
 * Vertex → Vertex Message Passing Phase (V→V)
 *
 * Pre-phase for SHGAT: Tools send messages to other tools based on
 * co-occurrence patterns from scraped n8n workflows.
 *
 * This phase enriches tool embeddings with structural information
 * from real-world workflow usage patterns BEFORE the V→E phase.
 *
 * Algorithm (simplified, no projection - keeps 1024d):
 *   1. Compute attention scores: score(i,j) = H_i · H_j (cosine similarity)
 *      (masked by co-occurrence matrix: only compute for co-occurring tools)
 *   2. Weight by co-occurrence frequency: score'(i,j) = score(i,j) * A_cooc[i][j]
 *   3. Normalize per tool: α_i = softmax({score'(i,j) | j co-occurs with i})
 *   4. Aggregate: H'_i = H_i + β · Σ_j α_ij · H_j  (residual connection)
 *
 * @module graphrag/algorithms/shgat/message-passing/vertex-to-vertex-phase
 */

import * as math from "../utils/math.ts";

/**
 * Co-occurrence matrix entry
 * Sparse representation for efficiency
 */
export interface CooccurrenceEntry {
  /** Source tool index */
  from: number;
  /** Target tool index */
  to: number;
  /** Co-occurrence weight (frequency-based, normalized) */
  weight: number;
}

/**
 * V→V phase configuration
 */
export interface VertexToVertexConfig {
  /** Residual connection weight (0 = no enrichment, 1 = full) */
  residualWeight: number;
  /** Use attention-weighted aggregation vs simple weighted sum */
  useAttention: boolean;
  /** Temperature for attention softmax (lower = sharper) */
  temperature: number;
}

/**
 * Default V→V configuration
 */
export const DEFAULT_V2V_CONFIG: VertexToVertexConfig = {
  residualWeight: 0.3, // Conservative: 30% co-occurrence, 70% original
  useAttention: true,
  temperature: 1.0,
};

/**
 * V→V phase result
 */
export interface VertexToVertexResult {
  /** Enriched embeddings [numTools][embeddingDim] */
  embeddings: number[][];
  /** Attention weights (sparse) for debugging */
  attentionWeights: CooccurrenceEntry[];
}

/**
 * Vertex → Vertex message passing implementation
 *
 * Enriches tool embeddings with co-occurrence information from
 * scraped workflow patterns. Operates on full 1024d embeddings
 * without projection.
 */
export class VertexToVertexPhase {
  private config: VertexToVertexConfig;

  constructor(config: Partial<VertexToVertexConfig> = {}) {
    this.config = { ...DEFAULT_V2V_CONFIG, ...config };
  }

  getName(): string {
    return "Vertex→Vertex";
  }

  /**
   * Execute V→V message passing
   *
   * @param H - Tool embeddings [numTools][embeddingDim] (1024d)
   * @param cooccurrence - Sparse co-occurrence matrix entries
   * @param toolIds - Tool ID to index mapping for debugging
   * @returns Enriched embeddings and attention weights
   */
  forward(
    H: number[][],
    cooccurrence: CooccurrenceEntry[],
    _toolIds?: string[],
  ): VertexToVertexResult {
    const numTools = H.length;
    if (numTools === 0) {
      return { embeddings: [], attentionWeights: [] };
    }

    const embeddingDim = H[0].length;

    // Build adjacency list from sparse co-occurrence
    const neighbors: Map<number, { idx: number; weight: number }[]> = new Map();
    for (const entry of cooccurrence) {
      if (entry.from >= numTools || entry.to >= numTools) continue;

      if (!neighbors.has(entry.from)) {
        neighbors.set(entry.from, []);
      }
      neighbors.get(entry.from)!.push({ idx: entry.to, weight: entry.weight });
    }

    // Compute enriched embeddings
    const H_enriched: number[][] = [];
    const attentionWeights: CooccurrenceEntry[] = [];

    for (let i = 0; i < numTools; i++) {
      const neighborList = neighbors.get(i);

      if (!neighborList || neighborList.length === 0) {
        // No co-occurring tools, keep original embedding
        H_enriched.push([...H[i]]);
        continue;
      }

      let aggregated: number[];

      if (this.config.useAttention) {
        // Attention-weighted aggregation
        const scores: number[] = [];

        for (const neighbor of neighborList) {
          // Cosine similarity * co-occurrence weight
          const sim = math.cosineSimilarity(H[i], H[neighbor.idx]);
          scores.push((sim * neighbor.weight) / this.config.temperature);
        }

        // Softmax normalization
        const attention = math.softmax(scores);

        // Weighted sum of neighbor embeddings
        aggregated = Array(embeddingDim).fill(0);
        for (let n = 0; n < neighborList.length; n++) {
          const neighbor = neighborList[n];
          for (let d = 0; d < embeddingDim; d++) {
            aggregated[d] += attention[n] * H[neighbor.idx][d];
          }

          // Store attention weights for debugging
          attentionWeights.push({
            from: i,
            to: neighbor.idx,
            weight: attention[n],
          });
        }
      } else {
        // Simple weighted sum (normalized by total weight)
        aggregated = Array(embeddingDim).fill(0);
        let totalWeight = 0;

        for (const neighbor of neighborList) {
          totalWeight += neighbor.weight;
          for (let d = 0; d < embeddingDim; d++) {
            aggregated[d] += neighbor.weight * H[neighbor.idx][d];
          }
        }

        if (totalWeight > 0) {
          for (let d = 0; d < embeddingDim; d++) {
            aggregated[d] /= totalWeight;
          }
        }
      }

      // Residual connection: H' = H + β * aggregated
      const enriched = Array(embeddingDim);
      for (let d = 0; d < embeddingDim; d++) {
        enriched[d] = H[i][d] + this.config.residualWeight * aggregated[d];
      }

      // Optional: L2 normalize to keep embeddings on unit sphere
      const norm = Math.sqrt(enriched.reduce((sum, x) => sum + x * x, 0));
      if (norm > 0) {
        for (let d = 0; d < embeddingDim; d++) {
          enriched[d] /= norm;
        }
      }

      H_enriched.push(enriched);
    }

    return {
      embeddings: H_enriched,
      attentionWeights,
    };
  }

  /**
   * Get configuration
   */
  getConfig(): VertexToVertexConfig {
    return { ...this.config };
  }
}

/**
 * Build co-occurrence matrix from prior patterns
 *
 * Converts PriorPattern[] to sparse CooccurrenceEntry[] for V→V phase
 *
 * @param patterns - Prior patterns from n8n scraping
 * @param toolIndex - Map from tool ID to index
 * @returns Sparse co-occurrence entries
 */
export function buildCooccurrenceMatrix(
  patterns: { from: string; to: string; weight: number; frequency: number }[],
  toolIndex: Map<string, number>,
): CooccurrenceEntry[] {
  const entries: CooccurrenceEntry[] = [];
  const seen = new Set<string>(); // Deduplicate edges

  for (const pattern of patterns) {
    const fromIdx = toolIndex.get(pattern.from);
    const toIdx = toolIndex.get(pattern.to);

    if (fromIdx === undefined || toIdx === undefined) continue;
    if (fromIdx === toIdx) continue; // Skip self-loops

    // Convert weight to similarity (lower weight = higher co-occurrence)
    // PriorPattern.weight is inverse frequency, so invert it
    const coocWeight = 1.0 / (1.0 + pattern.weight);

    // Add forward edge if not already seen
    const keyFwd = `${fromIdx}:${toIdx}`;
    if (!seen.has(keyFwd)) {
      entries.push({ from: fromIdx, to: toIdx, weight: coocWeight });
      seen.add(keyFwd);
    }

    // Add backward edge if not already seen (co-occurrence is symmetric)
    const keyBwd = `${toIdx}:${fromIdx}`;
    if (!seen.has(keyBwd)) {
      entries.push({ from: toIdx, to: fromIdx, weight: coocWeight });
      seen.add(keyBwd);
    }
  }

  return entries;
}
