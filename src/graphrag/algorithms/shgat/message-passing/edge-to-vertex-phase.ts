/**
 * Hyperedge → Vertex Message Passing Phase
 *
 * Phase 2 of SHGAT message passing: Capabilities (hyperedges) send messages
 * back to the tools (vertices) they contain.
 *
 * Algorithm:
 *   1. Project capability embeddings: E' = E · W_e^T
 *   2. Project tool embeddings: H' = H · W_v^T
 *   3. Compute attention scores: score(c, t) = a^T · LeakyReLU([E'_c || H'_t])
 *      (masked by incidence matrix: only compute for capabilities containing tool)
 *   4. Normalize per tool: α_t = softmax({score(c, t) | t ∈ c})
 *   5. Aggregate: H^new_t = ELU(Σ_c α_ct · E'_c)
 *
 * @module graphrag/algorithms/shgat/message-passing/edge-to-vertex-phase
 */

import * as math from "../utils/math.ts";
import type { MessagePassingPhase, PhaseParameters, PhaseResult } from "./phase-interface.ts";

/**
 * Hyperedge → Vertex message passing implementation
 */
export class EdgeToVertexPhase implements MessagePassingPhase {
  getName(): string {
    return "Edge→Vertex";
  }

  forward(
    E: number[][],
    H: number[][],
    connectivity: number[][],
    params: PhaseParameters,
    config: { leakyReluSlope: number },
  ): PhaseResult {
    const numCaps = E.length;
    const numTools = H.length;

    // Project embeddings
    const E_proj = math.matmulTranspose(E, params.W_source);
    const H_proj = math.matmulTranspose(H, params.W_target);

    // Compute attention scores (masked by incidence matrix)
    const attentionScores: number[][] = Array.from(
      { length: numCaps },
      () => Array(numTools).fill(-Infinity),
    );

    for (let c = 0; c < numCaps; c++) {
      for (let t = 0; t < numTools; t++) {
        // Note: connectivity is still [t][c] from vertex-to-edge perspective
        // We transpose access for edge-to-vertex
        if (connectivity[t][c] === 1) {
          // Concatenate projected embeddings
          const concat = [...E_proj[c], ...H_proj[t]];
          const activated = concat.map((x) => math.leakyRelu(x, config.leakyReluSlope));
          attentionScores[c][t] = math.dot(params.a_attention, activated);
        }
      }
    }

    // Softmax per tool (column-wise in transposed view)
    const attentionEV: number[][] = Array.from({ length: numCaps }, () => Array(numTools).fill(0));

    for (let t = 0; t < numTools; t++) {
      // Find all capabilities containing this tool
      const capsForTool: number[] = [];
      for (let c = 0; c < numCaps; c++) {
        if (connectivity[t][c] === 1) {
          capsForTool.push(c);
        }
      }

      if (capsForTool.length === 0) continue;

      // Normalize attention weights for this tool
      const scores = capsForTool.map((c) => attentionScores[c][t]);
      const softmaxed = math.softmax(scores);

      for (let i = 0; i < capsForTool.length; i++) {
        attentionEV[capsForTool[i]][t] = softmaxed[i];
      }
    }

    // Aggregate: H_new = σ(B^T · E_proj)
    const H_new: number[][] = [];
    const hiddenDim = E_proj[0].length;

    for (let t = 0; t < numTools; t++) {
      const aggregated = Array(hiddenDim).fill(0);

      // Weighted sum of capability embeddings
      for (let c = 0; c < numCaps; c++) {
        if (attentionEV[c][t] > 0) {
          for (let d = 0; d < hiddenDim; d++) {
            aggregated[d] += attentionEV[c][t] * E_proj[c][d];
          }
        }
      }

      // Apply ELU activation
      H_new.push(aggregated.map((x) => math.elu(x)));
    }

    return { embeddings: H_new, attention: attentionEV };
  }
}
