/**
 * Vertex → Hyperedge Message Passing Phase
 *
 * Phase 1 of SHGAT message passing: Tools (vertices) send messages to
 * capabilities (hyperedges) they participate in.
 *
 * Algorithm:
 *   1. Project tool embeddings: H' = H · W_v^T
 *   2. Project capability embeddings: E' = E · W_e^T
 *   3. Compute attention scores: score(t, c) = a^T · LeakyReLU([H'_t || E'_c])
 *      (masked by incidence matrix: only compute for tools in capability)
 *   4. Normalize per capability: α_c = softmax({score(t, c) | t ∈ c})
 *   5. Aggregate: E^new_c = ELU(Σ_t α_tc · H'_t)
 *
 * @module graphrag/algorithms/shgat/message-passing/vertex-to-edge-phase
 */

import * as math from "../utils/math.ts";
import type { MessagePassingPhase, PhaseParameters, PhaseResult } from "./phase-interface.ts";

/**
 * Vertex → Hyperedge message passing implementation
 */
export class VertexToEdgePhase implements MessagePassingPhase {
  getName(): string {
    return "Vertex→Edge";
  }

  forward(
    H: number[][],
    E: number[][],
    connectivity: number[][],
    params: PhaseParameters,
    config: { leakyReluSlope: number },
  ): PhaseResult {
    const numTools = H.length;
    const numCaps = E.length;

    // Project embeddings
    const H_proj = math.matmulTranspose(H, params.W_source);
    const E_proj = math.matmulTranspose(E, params.W_target);

    // Compute attention scores (masked by incidence matrix)
    const attentionScores: number[][] = Array.from(
      { length: numTools },
      () => Array(numCaps).fill(-Infinity),
    );

    for (let t = 0; t < numTools; t++) {
      for (let c = 0; c < numCaps; c++) {
        if (connectivity[t][c] === 1) {
          // Concatenate projected embeddings
          const concat = [...H_proj[t], ...E_proj[c]];
          const activated = concat.map((x) => math.leakyRelu(x, config.leakyReluSlope));
          attentionScores[t][c] = math.dot(params.a_attention, activated);
        }
      }
    }

    // Softmax per capability (column-wise)
    const attentionVE: number[][] = Array.from({ length: numTools }, () => Array(numCaps).fill(0));

    for (let c = 0; c < numCaps; c++) {
      // Find all tools in this capability
      const toolsInCap: number[] = [];
      for (let t = 0; t < numTools; t++) {
        if (connectivity[t][c] === 1) {
          toolsInCap.push(t);
        }
      }

      if (toolsInCap.length === 0) continue;

      // Normalize attention weights for this capability
      const scores = toolsInCap.map((t) => attentionScores[t][c]);
      const softmaxed = math.softmax(scores);

      for (let i = 0; i < toolsInCap.length; i++) {
        attentionVE[toolsInCap[i]][c] = softmaxed[i];
      }
    }

    // Aggregate: E_new = σ(A'^T · H_proj)
    const E_new: number[][] = [];
    const hiddenDim = H_proj[0].length;

    for (let c = 0; c < numCaps; c++) {
      const aggregated = Array(hiddenDim).fill(0);

      // Weighted sum of tool embeddings
      for (let t = 0; t < numTools; t++) {
        if (attentionVE[t][c] > 0) {
          for (let d = 0; d < hiddenDim; d++) {
            aggregated[d] += attentionVE[t][c] * H_proj[t][d];
          }
        }
      }

      // Apply ELU activation
      E_new.push(aggregated.map((x) => math.elu(x)));
    }

    return { embeddings: E_new, attention: attentionVE };
  }
}
