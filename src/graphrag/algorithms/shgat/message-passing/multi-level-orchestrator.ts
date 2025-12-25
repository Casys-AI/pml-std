/**
 * Multi-Level Message Passing Orchestrator
 *
 * Coordinates message passing across multiple hierarchy levels for
 * n-SuperHyperGraph structures.
 *
 * Current implementation (v2):
 *   V → E → V (2-level)
 *
 * Future implementation (multi-level):
 *   V → E^0 → E^1 → ... → E^n → ... → E^0 → V
 *
 * @module graphrag/algorithms/shgat/message-passing/multi-level-orchestrator
 */

import * as math from "../utils/math.ts";
import type { MessagePassingPhase, PhaseParameters } from "./phase-interface.ts";
import { VertexToEdgePhase } from "./vertex-to-edge-phase.ts";
import { EdgeToVertexPhase } from "./edge-to-vertex-phase.ts";
import { EdgeToEdgePhase } from "./edge-to-edge-phase.ts";

/**
 * Layer parameters for all phases
 *
 * Each layer has parameters for all heads.
 */
export interface LayerParameters {
  /** Vertex projection matrices per head [numHeads][headDim][embeddingDim] */
  W_v: number[][][];
  /** Edge projection matrices per head [numHeads][headDim][embeddingDim] */
  W_e: number[][][];
  /** Attention vectors V→E per head [numHeads][2*headDim] */
  a_ve: number[][];
  /** Edge projection matrices (phase 2) per head [numHeads][headDim][embeddingDim] */
  W_e2: number[][][];
  /** Vertex projection matrices (phase 2) per head [numHeads][headDim][embeddingDim] */
  W_v2: number[][][];
  /** Attention vectors E→V per head [numHeads][2*headDim] */
  a_ev: number[][];
}

/**
 * Forward pass cache for backpropagation
 */
export interface ForwardCache {
  /** Tool embeddings per layer [numLayers+1][numTools][dim] */
  H: number[][][];
  /** Capability embeddings per layer [numLayers+1][numCaps][dim] */
  E: number[][][];
  /** Attention weights V→E [layer][head][numTools][numCaps] */
  attentionVE: number[][][][];
  /** Attention weights E→V [layer][head][numCaps][numTools] */
  attentionEV: number[][][][];
}

/**
 * Configuration for orchestrator
 */
export interface OrchestratorConfig {
  numHeads: number;
  numLayers: number;
  dropout: number;
  leakyReluSlope: number;
}

/**
 * Multi-level message passing orchestrator
 *
 * Handles both current 2-level (V→E→V) and future multi-level (V→E^0→E^1→...→V)
 * message passing architectures.
 */
export class MultiLevelOrchestrator {
  private readonly vertexToEdgePhase: VertexToEdgePhase;
  private readonly edgeToVertexPhase: EdgeToVertexPhase;
  private readonly trainingMode: boolean;

  constructor(trainingMode: boolean = false) {
    this.vertexToEdgePhase = new VertexToEdgePhase();
    this.edgeToVertexPhase = new EdgeToVertexPhase();
    this.trainingMode = trainingMode;
  }

  /**
   * Execute forward pass through all layers
   *
   * Current implementation: 2-level (V→E→V)
   *
   * For each layer l:
   *   For each head k:
   *     1. V → E: Tools aggregate to capabilities
   *     2. E → V: Capabilities aggregate back to tools
   *   Concatenate all heads
   *   Apply dropout (if training)
   *
   * @param H_init - Initial tool embeddings [numTools][embeddingDim]
   * @param E_init - Initial capability embeddings [numCaps][embeddingDim]
   * @param incidenceMatrix - Connectivity [numTools][numCaps]
   * @param layerParams - Parameters for all layers
   * @param config - Configuration (numHeads, dropout, etc.)
   * @returns Final embeddings and cache for backprop
   */
  forward(
    H_init: number[][],
    E_init: number[][],
    incidenceMatrix: number[][],
    layerParams: LayerParameters[],
    config: OrchestratorConfig,
  ): { H: number[][]; E: number[][]; cache: ForwardCache } {
    const cache: ForwardCache = {
      H: [],
      E: [],
      attentionVE: [],
      attentionEV: [],
    };

    let H = H_init;
    let E = E_init;

    cache.H.push(H);
    cache.E.push(E);

    // Process each layer
    for (let l = 0; l < config.numLayers; l++) {
      const params = layerParams[l];
      const layerAttentionVE: number[][][] = [];
      const layerAttentionEV: number[][][] = [];

      const headsH: number[][][] = [];
      const headsE: number[][][] = [];

      // Process each head in parallel
      for (let head = 0; head < config.numHeads; head++) {
        // Phase 1: Vertex → Hyperedge
        const veParams: PhaseParameters = {
          W_source: params.W_v[head],
          W_target: params.W_e[head],
          a_attention: params.a_ve[head],
        };

        const { embeddings: E_new, attention: attentionVE } = this.vertexToEdgePhase.forward(
          H,
          E,
          incidenceMatrix,
          veParams,
          { leakyReluSlope: config.leakyReluSlope },
        );

        layerAttentionVE.push(attentionVE);

        // Phase 2: Hyperedge → Vertex
        const evParams: PhaseParameters = {
          W_source: params.W_e2[head],
          W_target: params.W_v2[head],
          a_attention: params.a_ev[head],
        };

        const { embeddings: H_new, attention: attentionEV } = this.edgeToVertexPhase.forward(
          E_new,
          H,
          incidenceMatrix,
          evParams,
          { leakyReluSlope: config.leakyReluSlope },
        );

        layerAttentionEV.push(attentionEV);

        headsH.push(H_new);
        headsE.push(E_new);
      }

      // Concatenate heads
      H = math.concatHeads(headsH);
      E = math.concatHeads(headsE);

      // Apply dropout during training
      if (this.trainingMode && config.dropout > 0) {
        H = math.applyDropout(H, config.dropout);
        E = math.applyDropout(E, config.dropout);
      }

      cache.H.push(H);
      cache.E.push(E);
      cache.attentionVE.push(layerAttentionVE);
      cache.attentionEV.push(layerAttentionEV);
    }

    return { H, E, cache };
  }

  /**
   * Future: Multi-level forward pass (V → E^0 → E^1 → ... → E^n → ... → V)
   *
   * This will be implemented when we add multi-level capability hierarchies.
   * For now, this is a placeholder to show the intended architecture.
   *
   * @param H_init - Initial tool embeddings
   * @param E_levels_init - Initial embeddings per hierarchy level [[E^0], [E^1], ...]
   * @param incidenceMatrices - Connectivity per level [I_0, I_1, ...] where:
   *                            I_0: V → E^0
   *                            I_k: E^(k-1) → E^k for k > 0
   * @param layerParams - Parameters for all layers and phases
   * @param config - Configuration
   * @returns Final embeddings for all levels
   */
  forwardMultiLevel(
    H_init: number[][],
    E_levels_init: number[][][],
    incidenceMatrices: number[][][],
    layerParams: any, // TODO: Define proper multi-level parameter structure
    config: OrchestratorConfig,
  ): { H: number[][]; E_levels: number[][][]; cache: any } {
    // TODO: Implement multi-level message passing
    // Algorithm:
    // 1. Upward pass: V → E^0 → E^1 → ... → E^n
    //    - Use VertexToEdgePhase for V → E^0
    //    - Use EdgeToEdgePhase for E^k → E^(k+1)
    // 2. Downward pass: E^n → ... → E^1 → E^0 → V
    //    - Use EdgeToEdgePhase (reverse) for E^(k+1) → E^k
    //    - Use EdgeToVertexPhase for E^0 → V
    // 3. Apply dropout and cache activations for each level
    throw new Error("Multi-level message passing not yet implemented");
  }
}
