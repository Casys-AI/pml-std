/**
 * Multi-Level Message Passing Orchestrator
 *
 * Coordinates message passing across multiple hierarchy levels for
 * n-SuperHyperGraph structures.
 *
 * Implements both:
 * - Legacy 2-level: V → E → V
 * - Multi-level: V → E^0 → E^1 → ... → E^n → ... → E^0 → V
 *
 * @module graphrag/algorithms/shgat/message-passing/multi-level-orchestrator
 */

import * as math from "../utils/math.ts";
import type { PhaseParameters } from "./phase-interface.ts";
import type { LevelParams, MultiLevelEmbeddings, MultiLevelForwardCache } from "../types.ts";
import { VertexToEdgePhase } from "./vertex-to-edge-phase.ts";
import { EdgeToVertexPhase } from "./edge-to-vertex-phase.ts";
import { EdgeToEdgePhase } from "./edge-to-edge-phase.ts";
import {
  VertexToVertexPhase,
  type CooccurrenceEntry,
  type VertexToVertexConfig,
} from "./vertex-to-vertex-phase.ts";

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
 *
 * Optionally includes V→V pre-phase for co-occurrence enrichment from scraped patterns.
 */
export class MultiLevelOrchestrator {
  private readonly vertexToEdgePhase: VertexToEdgePhase;
  private readonly edgeToVertexPhase: EdgeToVertexPhase;
  private vertexToVertexPhase: VertexToVertexPhase | null;
  private readonly trainingMode: boolean;
  private cooccurrenceData: CooccurrenceEntry[] | null = null;

  constructor(
    trainingMode: boolean = false,
    v2vConfig?: Partial<VertexToVertexConfig>,
  ) {
    this.vertexToEdgePhase = new VertexToEdgePhase();
    this.edgeToVertexPhase = new EdgeToVertexPhase();
    this.vertexToVertexPhase = v2vConfig ? new VertexToVertexPhase(v2vConfig) : null;
    this.trainingMode = trainingMode;
  }

  /**
   * Set co-occurrence data for V→V enrichment
   *
   * @param data - Sparse co-occurrence entries from scraped patterns
   */
  setCooccurrenceData(data: CooccurrenceEntry[]): void {
    this.cooccurrenceData = data;
    // Initialize V→V phase if not already done
    if (!this.vertexToVertexPhase) {
      this.vertexToVertexPhase = new VertexToVertexPhase();
    }
  }

  /**
   * Apply V→V enrichment if configured
   *
   * @param H - Tool embeddings [numTools][embeddingDim]
   * @returns Enriched embeddings (or original if no co-occurrence data)
   */
  private applyV2VEnrichment(H: number[][]): number[][] {
    if (!this.vertexToVertexPhase || !this.cooccurrenceData || this.cooccurrenceData.length === 0) {
      return H;
    }

    const { embeddings } = this.vertexToVertexPhase.forward(H, this.cooccurrenceData);
    return embeddings;
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

    // Apply V→V co-occurrence enrichment (if configured)
    let H = this.applyV2VEnrichment(H_init);
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
   * Multi-level forward pass: V → E^0 → E^1 → ... → E^L_max → ... → E^0 → V
   *
   * Implements n-SuperHyperGraph message passing with:
   * 1. Upward aggregation: Tools → Level-0 Caps → ... → Level-L_max Caps
   * 2. Downward propagation: Level-L_max → ... → Level-0 → Tools
   *
   * @param H_init - Initial tool embeddings [numTools][embDim]
   * @param E_levels_init - Initial embeddings per level: level → [numCapsAtLevel][embDim]
   * @param toolToCapMatrix - I₀: Tool-to-level-0 connectivity [numTools][numCaps0]
   * @param capToCapMatrices - I_k: Level-(k-1) to level-k connectivity, keyed by parent level
   * @param levelParams - Parameters per hierarchy level
   * @param config - Configuration (numHeads, dropout, etc.)
   * @returns MultiLevelEmbeddings with final embeddings and attention weights
   */
  forwardMultiLevel(
    H_init: number[][],
    E_levels_init: Map<number, number[][]>,
    toolToCapMatrix: number[][],
    capToCapMatrices: Map<number, number[][]>,
    levelParams: Map<number, LevelParams>,
    config: OrchestratorConfig,
  ): { result: MultiLevelEmbeddings; cache: MultiLevelForwardCache } {
    // Validate inputs
    if (E_levels_init.size === 0) {
      throw new Error("forwardMultiLevel requires at least one level of capability embeddings");
    }

    const maxLevel = Math.max(...Array.from(E_levels_init.keys()));

    // Pre-create EdgeToEdgePhase instances to avoid repeated allocation
    const edgeToEdgePhases = new Map<string, EdgeToEdgePhase>();
    for (let level = 1; level <= maxLevel; level++) {
      edgeToEdgePhases.set(`up-${level}`, new EdgeToEdgePhase(level - 1, level));
      edgeToEdgePhases.set(`down-${level}`, new EdgeToEdgePhase(level, level - 1));
    }

    // Initialize result structures
    const E = new Map<number, number[][]>();
    const attentionUpward = new Map<number, number[][][]>();
    const attentionDownward = new Map<number, number[][][]>();

    // Initialize cache
    const cache: MultiLevelForwardCache = {
      H_init: H_init.map((row) => [...row]),
      H_final: [],
      E_init: new Map(),
      E_final: new Map(),
      intermediateUpward: new Map(),
      intermediateDownward: new Map(),
      attentionUpward: new Map(),
      attentionDownward: new Map(),
    };

    // Copy initial embeddings to cache
    for (const [level, embs] of E_levels_init) {
      cache.E_init.set(level, embs.map((row) => [...row]));
      E.set(level, embs.map((row) => [...row]));
    }

    // Apply V→V co-occurrence enrichment (if configured)
    const H_enriched = this.applyV2VEnrichment(H_init);

    // Track current tool embeddings
    let H = H_enriched.map((row) => [...row]);

    // ========================================================================
    // UPWARD PASS: V → E^0 → E^1 → ... → E^L_max
    // ========================================================================

    for (let level = 0; level <= maxLevel; level++) {
      const params = levelParams.get(level);
      if (!params) {
        throw new Error(`Missing LevelParams for level ${level}`);
      }

      const capsAtLevel = E.get(level);
      if (!capsAtLevel || capsAtLevel.length === 0) continue;

      const headsE: number[][][] = [];
      const levelAttention: number[][][] = [];

      for (let head = 0; head < config.numHeads; head++) {
        if (level === 0) {
          // Phase: Tools (V) → Level-0 Capabilities (E^0)
          const phaseParams: PhaseParameters = {
            W_source: params.W_child[head],
            W_target: params.W_parent[head],
            a_attention: params.a_upward[head],
          };

          const { embeddings, attention } = this.vertexToEdgePhase.forward(
            H,
            capsAtLevel,
            toolToCapMatrix,
            phaseParams,
            { leakyReluSlope: config.leakyReluSlope },
          );

          headsE.push(embeddings);
          levelAttention.push(attention);
        } else {
          // Phase: Level-(k-1) → Level-k Capabilities
          const E_prev = E.get(level - 1);
          if (!E_prev) continue;

          const connectivity = capToCapMatrices.get(level);
          if (!connectivity) continue;

          const phase = edgeToEdgePhases.get(`up-${level}`)!;
          const phaseParams: PhaseParameters = {
            W_source: params.W_child[head],
            W_target: params.W_parent[head],
            a_attention: params.a_upward[head],
          };

          const { embeddings, attention } = phase.forward(
            E_prev,
            capsAtLevel,
            connectivity,
            phaseParams,
            { leakyReluSlope: config.leakyReluSlope },
          );

          headsE.push(embeddings);
          levelAttention.push(attention);
        }
      }

      // Concatenate heads
      if (headsE.length > 0) {
        const E_new = math.concatHeads(headsE);
        E.set(level, E_new);
        cache.intermediateUpward.set(level, E_new.map((row) => [...row]));
      }

      attentionUpward.set(level, levelAttention);
      cache.attentionUpward.set(level, levelAttention);
    }

    // ========================================================================
    // DOWNWARD PASS: E^L_max → ... → E^1 → E^0 → V
    // ========================================================================

    // Downward: Higher levels → Lower levels
    for (let level = maxLevel - 1; level >= 0; level--) {
      const params = levelParams.get(level);
      if (!params) continue;

      const capsAtLevel = E.get(level);
      const capsAtParentLevel = E.get(level + 1);

      if (!capsAtLevel || capsAtLevel.length === 0) continue;
      if (!capsAtParentLevel || capsAtParentLevel.length === 0) continue;

      // Save pre-downward embeddings for residual connection
      const capsAtLevelPreDownward = capsAtLevel.map((row) => [...row]);

      const headsE: number[][][] = [];
      const levelAttention: number[][][] = [];

      // Get reverse connectivity (parent → child)
      const forwardConnectivity = capToCapMatrices.get(level + 1);
      if (!forwardConnectivity) continue;

      // Transpose the connectivity matrix for downward pass
      const reverseConnectivity = this.transposeMatrix(forwardConnectivity);

      const phase = edgeToEdgePhases.get(`down-${level + 1}`)!;

      for (let head = 0; head < config.numHeads; head++) {
        // Downward phase: Level-(k+1) → Level-k
        const phaseParams: PhaseParameters = {
          W_source: params.W_parent[head], // Parents are source in downward
          W_target: params.W_child[head], // Children are target in downward
          a_attention: params.a_downward[head],
        };

        const { embeddings: propagated, attention } = phase.forward(
          capsAtParentLevel,
          capsAtLevel,
          reverseConnectivity,
          phaseParams,
          { leakyReluSlope: config.leakyReluSlope },
        );

        headsE.push(propagated);
        levelAttention.push(attention);
      }

      // Concatenate heads first
      if (headsE.length > 0) {
        const E_concat = math.concatHeads(headsE);

        // THEN apply residual connection: E^k ← E^k_pre + E_concat
        // Both have same dimension [numCaps][numHeads * headDim]
        const E_new = capsAtLevelPreDownward.map((row, i) =>
          row.map((val, j) => val + (E_concat[i]?.[j] ?? 0))
        );

        E.set(level, E_new);
        cache.intermediateDownward.set(level, E_new.map((row) => [...row]));
      }

      attentionDownward.set(level, levelAttention);
      cache.attentionDownward.set(level, levelAttention);
    }

    // Final phase: Level-0 → Tools (downward)
    const E_level0 = E.get(0);
    if (E_level0 && E_level0.length > 0) {
      const params = levelParams.get(0);
      if (params) {
        // Save pre-downward tool embeddings for residual connection
        const H_preDownward = H.map((row) => [...row]);

        // EdgeToVertexPhase expects [tool][cap] format (same as upward pass)
        // It internally handles the reverse aggregation direction

        const headsH: number[][][] = [];
        const levelAttention: number[][][] = [];

        for (let head = 0; head < config.numHeads; head++) {
          const phaseParams: PhaseParameters = {
            W_source: params.W_parent[head],
            W_target: params.W_child[head],
            a_attention: params.a_downward[head],
          };

          const { embeddings: propagated, attention } = this.edgeToVertexPhase.forward(
            E_level0,
            H,
            toolToCapMatrix,
            phaseParams,
            { leakyReluSlope: config.leakyReluSlope },
          );

          headsH.push(propagated);
          levelAttention.push(attention);
        }

        // Concatenate heads first
        if (headsH.length > 0) {
          const H_concat = math.concatHeads(headsH);

          // THEN apply residual connection: H ← H_pre + H_concat
          // Both have same dimension [numTools][numHeads * headDim]
          H = H_preDownward.map((row, i) => row.map((val, j) => val + (H_concat[i]?.[j] ?? 0)));
        }

        attentionDownward.set(-1, levelAttention);
        cache.attentionDownward.set(-1, levelAttention);
      }
    }

    // Apply dropout during training
    if (this.trainingMode && config.dropout > 0) {
      H = math.applyDropout(H, config.dropout);
      for (const [level, embs] of E) {
        E.set(level, math.applyDropout(embs, config.dropout));
      }
    }

    // Store final embeddings in cache
    cache.H_final = H.map((row) => [...row]);
    for (const [level, embs] of E) {
      cache.E_final.set(level, embs.map((row) => [...row]));
    }

    const result: MultiLevelEmbeddings = {
      H,
      E,
      attentionUpward,
      attentionDownward,
    };

    return { result, cache };
  }

  /**
   * Transpose a matrix
   * @param matrix Input matrix [rows][cols]
   * @returns Transposed matrix [cols][rows]
   */
  private transposeMatrix(matrix: number[][]): number[][] {
    if (matrix.length === 0) return [];
    const rows = matrix.length;
    const cols = matrix[0].length;

    return Array.from(
      { length: cols },
      (_, j) => Array.from({ length: rows }, (_, i) => matrix[i][j]),
    );
  }

}
