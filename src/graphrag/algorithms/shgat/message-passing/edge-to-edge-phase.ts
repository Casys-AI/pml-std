/**
 * Hyperedge → Hyperedge Message Passing Phase (Multi-Level)
 *
 * Phase for multi-level n-SuperHyperGraph: Capabilities at level k send
 * messages to capabilities at level k+1 that contain them.
 *
 * This is the KEY phase for hierarchical message passing:
 *   V → E^0 → E^1 → E^2 → ... → E^n → ... → V
 *
 * Algorithm (E^k → E^(k+1)):
 *   1. Project child capability embeddings: E^k' = E^k · W_source^T
 *   2. Project parent capability embeddings: E^(k+1)' = E^(k+1) · W_target^T
 *   3. Compute attention scores: score(c_k, c_{k+1}) = a^T · LeakyReLU([E^k'_c || E^(k+1)'_p])
 *      (masked by containment matrix: only compute for c_k ∈ c_{k+1})
 *   4. Normalize per parent: α_p = softmax({score(c, p) | c ∈ p})
 *   5. Aggregate: E^(k+1)^new_p = ELU(Σ_c α_cp · E^k'_c)
 *
 * This is identical to VertexToEdgePhase but operates on E^k instead of V.
 *
 * @module graphrag/algorithms/shgat/message-passing/edge-to-edge-phase
 */

import * as math from "../utils/math.ts";
import type { MessagePassingPhase, PhaseParameters, PhaseResult } from "./phase-interface.ts";

/**
 * Hyperedge → Hyperedge message passing implementation
 *
 * Used for hierarchical capabilities where capabilities can contain
 * other capabilities (n-SuperHyperGraph structure).
 */
export class EdgeToEdgePhase implements MessagePassingPhase {
  private readonly levelK: number;
  private readonly levelKPlus1: number;

  constructor(levelK: number, levelKPlus1: number) {
    this.levelK = levelK;
    this.levelKPlus1 = levelKPlus1;
  }

  getName(): string {
    return `Edge^${this.levelK}→Edge^${this.levelKPlus1}`;
  }

  forward(
    E_k: number[][],
    E_kPlus1: number[][],
    containment: number[][],
    params: PhaseParameters,
    config: { leakyReluSlope: number },
  ): PhaseResult {
    const numChildCaps = E_k.length;
    const numParentCaps = E_kPlus1.length;

    // Project embeddings
    const E_k_proj = math.matmulTranspose(E_k, params.W_source);
    const E_kPlus1_proj = math.matmulTranspose(E_kPlus1, params.W_target);

    // Compute attention scores (masked by containment matrix)
    // containment[c][p] = 1 if child capability c is contained in parent p
    const attentionScores: number[][] = Array.from(
      { length: numChildCaps },
      () => Array(numParentCaps).fill(-Infinity),
    );

    for (let c = 0; c < numChildCaps; c++) {
      for (let p = 0; p < numParentCaps; p++) {
        if (containment[c][p] === 1) {
          // Concatenate projected embeddings
          const concat = [...E_k_proj[c], ...E_kPlus1_proj[p]];
          const activated = concat.map((x) => math.leakyRelu(x, config.leakyReluSlope));
          attentionScores[c][p] = math.dot(params.a_attention, activated);
        }
      }
    }

    // Softmax per parent capability (column-wise)
    const attentionCE: number[][] = Array.from(
      { length: numChildCaps },
      () => Array(numParentCaps).fill(0),
    );

    for (let p = 0; p < numParentCaps; p++) {
      // Find all child capabilities in this parent
      const childrenInParent: number[] = [];
      for (let c = 0; c < numChildCaps; c++) {
        if (containment[c][p] === 1) {
          childrenInParent.push(c);
        }
      }

      if (childrenInParent.length === 0) continue;

      // Normalize attention weights for this parent
      const scores = childrenInParent.map((c) => attentionScores[c][p]);
      const softmaxed = math.softmax(scores);

      for (let i = 0; i < childrenInParent.length; i++) {
        attentionCE[childrenInParent[i]][p] = softmaxed[i];
      }
    }

    // Aggregate: E^(k+1)_new = σ(A'^T · E^k_proj)
    const E_kPlus1_new: number[][] = [];
    const hiddenDim = E_k_proj[0].length;

    for (let p = 0; p < numParentCaps; p++) {
      const aggregated = Array(hiddenDim).fill(0);

      // Weighted sum of child capability embeddings
      for (let c = 0; c < numChildCaps; c++) {
        if (attentionCE[c][p] > 0) {
          for (let d = 0; d < hiddenDim; d++) {
            aggregated[d] += attentionCE[c][p] * E_k_proj[c][d];
          }
        }
      }

      // Apply ELU activation
      E_kPlus1_new.push(aggregated.map((x) => math.elu(x)));
    }

    return { embeddings: E_kPlus1_new, attention: attentionCE };
  }
}
