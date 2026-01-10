/**
 * SHGAT (SuperHyperGraph Attention Networks) v2
 *
 * Implementation based on "SuperHyperGraph Attention Networks" research paper.
 * Key architecture:
 * - Two-phase message passing: Vertex→Hyperedge, Hyperedge→Vertex
 * - Incidence matrix A where A[v][e] = 1 if vertex v is in hyperedge e
 * - K-head attention (K=4-16, adaptive) learning patterns on TraceFeatures
 *
 * This file is the main orchestrator that delegates to specialized modules:
 * - graph/: Node registration and incidence matrix
 * - initialization/: Parameter initialization
 * - message-passing/: Two-phase message passing
 * - scoring/: V1 and V2 scoring
 * - training/: V1 and V2 training logic
 *
 * @module graphrag/algorithms/shgat
 */

import { getLogger } from "../../telemetry/logger.ts";

// Module imports
import {
  buildMultiLevelIncidence,
  computeHierarchyLevels,
  generateDefaultToolEmbedding,
  GraphBuilder,
  type HierarchyResult,
  type MultiLevelIncidence,
} from "./shgat/graph/mod.ts";
import {
  countParameters,
  exportParams as exportParamsHelper,
  getAdaptiveHeadsByGraphSize,
  importParams as importParamsHelper,
  initializeLevelParameters,
  initializeParameters,
  initializeV2GradientAccumulators,
  resetV2GradientAccumulators,
  type SHGATParams,
  type V2GradientAccumulators,
} from "./shgat/initialization/index.ts";
import {
  DEFAULT_V2V_PARAMS,
  MultiLevelOrchestrator,
  type CooccurrenceEntry,
  type MultiLevelBackwardCache,
  type MultiLevelGradients,
  type V2VParams,
} from "./shgat/message-passing/index.ts";
import * as math from "./shgat/utils/math.ts";
import {
  accumulateW_intentGradients,
  applyFeatureGradients,
  applyFusionGradients,
  applyLayerGradients,
  applyW_intentGradients,
  backward as backwardV1,
  computeFusionWeights,
  initV1Gradients,
  trainOnEpisodes,
} from "./shgat/training/v1-trainer.ts";
import {
  applyV2Gradients,
  backwardV2,
  buildTraceFeatures,
  createDefaultTraceStatsFromFeatures,
  forwardV2WithCache,
  traceStatsToVector,
} from "./shgat/training/v2-trainer.ts";
import {
  applyKHeadGradients,
  applyWIntentGradients,
  backpropMultiHeadKHead,
  backpropMultiHeadKHeadLogit,
  backpropWIntent,
  computeKHeadGradientNorm,
  computeMultiHeadKHeadScoresWithCache,
  initMultiLevelKHeadGradients,
} from "./shgat/training/multi-level-trainer-khead.ts";
import {
  batchedKHeadForward,
  batchedBackpropKHeadLogit,
  batchedBackpropWIntent,
  batchProjectIntents,
} from "./shgat/training/batched-khead.ts";
import {
  applyLevelGradients,
  computeGradientNorm,
  type LevelGradients,
  type MultiLevelGradientAccumulators,
} from "./shgat/training/multi-level-trainer.ts";

// Re-export all types from ./shgat/types.ts for backward compatibility
export {
  type AttentionResult,
  type CapabilityNode,
  createDefaultTraceFeatures,
  DEFAULT_FEATURE_WEIGHTS,
  DEFAULT_FUSION_WEIGHTS,
  DEFAULT_HYPERGRAPH_FEATURES,
  DEFAULT_SHGAT_CONFIG,
  DEFAULT_TOOL_GRAPH_FEATURES,
  DEFAULT_TRACE_STATS,
  type FeatureWeights,
  type ForwardCache,
  type FusionWeights,
  getAdaptiveConfig,
  type HypergraphFeatures,
  NUM_TRACE_STATS,
  type SHGATConfig,
  type ToolGraphFeatures,
  type ToolNode,
  type TraceFeatures,
  type TraceStats,
  type TrainingExample,
} from "./shgat/types.ts";

// Export seeded RNG for reproducibility
export { seedRng } from "./shgat/initialization/parameters.ts";

import {
  type AttentionResult,
  type CapabilityNode,
  createMembersFromLegacy,
  DEFAULT_HYPERGRAPH_FEATURES,
  DEFAULT_SHGAT_CONFIG,
  DEFAULT_TOOL_GRAPH_FEATURES,
  DEFAULT_TRACE_STATS,
  type ForwardCache,
  type FusionWeights,
  type HypergraphFeatures,
  type LevelParams,
  type SHGATConfig,
  type ToolGraphFeatures,
  type ToolNode,
  type TraceFeatures,
  type TraceStats,
  type TrainingExample,
} from "./shgat/types.ts";

const log = getLogger("default");

// ============================================================================
// SHGAT Implementation
// ============================================================================

/**
 * SuperHyperGraph Attention Networks
 *
 * Implements proper two-phase message passing:
 * 1. Vertex → Hyperedge: Aggregate tool features to capabilities
 * 2. Hyperedge → Vertex: Propagate capability features back to tools
 */
export class SHGAT {
  private config: SHGATConfig;
  private graphBuilder: GraphBuilder;
  private params: SHGATParams;
  private orchestrator: MultiLevelOrchestrator;
  private trainingMode = false;
  private lastCache: ForwardCache | null = null;
  private v2GradAccum: V2GradientAccumulators;

  // Multi-level n-SuperHyperGraph structures
  private hierarchy: HierarchyResult | null = null;
  private multiLevelIncidence: MultiLevelIncidence | null = null;
  private levelParams: Map<number, LevelParams> = new Map();
  private hierarchyDirty = true; // Flag to rebuild hierarchy when graph changes

  // V→V trainable parameters (co-occurrence enrichment)
  private v2vParams: V2VParams = { ...DEFAULT_V2V_PARAMS };

  constructor(config: Partial<SHGATConfig> = {}) {
    this.config = { ...DEFAULT_SHGAT_CONFIG, ...config };

    // Note: preserveDim affects levelParams (message passing keeps 1024-dim)
    // hiddenDim = numHeads * 16 for K-head scoring (adaptive: 64, 128, etc.)
    // Each head gets 16 dims for consistent expressiveness

    this.graphBuilder = new GraphBuilder();
    this.orchestrator = new MultiLevelOrchestrator(this.trainingMode);
    this.params = initializeParameters(this.config);
    this.v2GradAccum = initializeV2GradientAccumulators(this.config);
  }

  // ==========================================================================
  // Graph Management (delegated to GraphBuilder)
  // ==========================================================================

  registerTool(node: ToolNode): void {
    this.graphBuilder.registerTool(node);
    this.hierarchyDirty = true;
  }

  registerCapability(node: CapabilityNode): void {
    this.graphBuilder.registerCapability(node);
    this.hierarchyDirty = true;
  }

  /**
   * Set co-occurrence data for V→V enrichment
   *
   * Enables tool embedding enrichment based on scraped n8n workflow patterns.
   * Tools that frequently co-occur in workflows become more similar.
   *
   * @param data - Sparse co-occurrence entries from PatternStore
   *
   * @example
   * ```typescript
   * const coocData = await loadCooccurrenceData(shgat.getToolIndex());
   * shgat.setCooccurrenceData(coocData.entries);
   * ```
   */
  setCooccurrenceData(data: CooccurrenceEntry[]): void {
    this.orchestrator.setCooccurrenceData(data);
    log.info(`[SHGAT] V→V co-occurrence enabled with ${data.length} edges`);
  }

  /**
   * Get tool ID to index mapping for co-occurrence loader
   */
  getToolIndexMap(): Map<string, number> {
    return this.graphBuilder.getToolIndexMap();
  }

  /**
   * Rebuild multi-level hierarchy and incidence structures
   *
   * Called lazily before forward() when hierarchyDirty is true.
   */
  private rebuildHierarchy(): void {
    if (!this.hierarchyDirty) return;

    const capabilityNodes = this.graphBuilder.getCapabilityNodes();

    if (capabilityNodes.size === 0) {
      this.hierarchy = {
        hierarchyLevels: new Map(),
        maxHierarchyLevel: 0,
        capabilities: new Map(),
      };
      this.multiLevelIncidence = {
        toolToCapIncidence: new Map(),
        capToCapIncidence: new Map(),
        parentToChildIncidence: new Map(),
        capToToolIncidence: new Map(),
      };
      this.levelParams = new Map();
      this.hierarchyDirty = false;
      return;
    }

    // 1. Compute hierarchy levels
    this.hierarchy = computeHierarchyLevels(capabilityNodes);

    // 2. Update hierarchyLevel on each capability
    for (const [level, capIds] of this.hierarchy.hierarchyLevels) {
      for (const capId of capIds) {
        const cap = capabilityNodes.get(capId);
        if (cap) cap.hierarchyLevel = level;
      }
    }

    // 3. Build multi-level incidence structure
    this.multiLevelIncidence = buildMultiLevelIncidence(capabilityNodes, this.hierarchy);

    // 4. Initialize level parameters if needed
    if (this.levelParams.size === 0 || this.levelParams.size <= this.hierarchy.maxHierarchyLevel) {
      this.levelParams = initializeLevelParameters(this.config, this.hierarchy.maxHierarchyLevel);
    }

    this.hierarchyDirty = false;
    log.debug("[SHGAT] Rebuilt hierarchy", {
      maxLevel: this.hierarchy.maxHierarchyLevel,
      levels: Array.from(this.hierarchy.hierarchyLevels.keys()),
    });
  }

  /**
   * Legacy API: accepts old format, converts internally
   *
   * This method provides backward compatibility for code that uses the
   * pre-v1-refactor API with separate toolsUsed and children arrays.
   *
   * @deprecated Use registerCapability() with new format (members array)
   * @see 08-migration.md for migration guide
   */
  addCapabilityLegacy(
    id: string,
    embedding: number[],
    toolsUsed: string[],
    children: string[] = [],
    successRate: number = 0.5,
  ): void {
    const members = createMembersFromLegacy(toolsUsed, children);

    this.registerCapability({
      id,
      embedding,
      members,
      hierarchyLevel: 0, // Will be recomputed during rebuild
      toolsUsed, // Keep for backward compat
      children,
      successRate,
    });
  }

  hasToolNode(toolId: string): boolean {
    return this.graphBuilder.hasToolNode(toolId);
  }

  hasCapabilityNode(capabilityId: string): boolean {
    return this.graphBuilder.hasCapabilityNode(capabilityId);
  }

  getToolCount(): number {
    return this.graphBuilder.getToolCount();
  }

  getCapabilityCount(): number {
    return this.graphBuilder.getCapabilityCount();
  }

  getToolIds(): string[] {
    return this.graphBuilder.getToolIds();
  }

  getCapabilityIds(): string[] {
    return this.graphBuilder.getCapabilityIds();
  }

  buildFromData(
    tools: Array<{ id: string; embedding: number[] }>,
    capabilities: Array<{
      id: string;
      embedding: number[];
      toolsUsed: string[];
      successRate: number;
      parents?: string[];
      children?: string[];
    }>,
  ): void {
    this.graphBuilder.buildFromData({ tools, capabilities });
  }

  updateHypergraphFeatures(capabilityId: string, features: Partial<HypergraphFeatures>): void {
    this.graphBuilder.updateHypergraphFeatures(capabilityId, features);
  }

  updateToolFeatures(toolId: string, features: Partial<ToolGraphFeatures>): void {
    this.graphBuilder.updateToolFeatures(toolId, features);
  }

  batchUpdateFeatures(updates: Map<string, Partial<HypergraphFeatures>>): void {
    this.graphBuilder.batchUpdateCapabilityFeatures(updates);
    log.debug("[SHGAT] Updated hypergraph features", { updatedCount: updates.size });
  }

  batchUpdateToolFeatures(updates: Map<string, Partial<ToolGraphFeatures>>): void {
    this.graphBuilder.batchUpdateToolFeatures(updates);
    log.debug("[SHGAT] Updated tool features", { updatedCount: updates.size });
  }

  // ==========================================================================
  // Multi-Level Message Passing (n-SuperHyperGraph)
  // ==========================================================================

  /**
   * Execute multi-level message passing
   *
   * n-SHG Architecture:
   * - Upward: V → E^0 → E^1 → ... → E^L_max
   * - Downward: E^L_max → ... → E^1 → E^0 → V
   *
   * Each level uses direct membership only (no transitive closure).
   *
   * @returns H (tool embeddings), E (flattened cap embeddings), cache
   */
  forward(): { H: number[][]; E: number[][]; cache: ForwardCache } {
    // Return cached result if graph hasn't changed (perf optimization)
    if (!this.hierarchyDirty && this.lastCache) {
      const H = this.lastCache.H[this.lastCache.H.length - 1] ?? [];
      const E = this.lastCache.E[this.lastCache.E.length - 1] ?? [];
      return { H, E, cache: this.lastCache };
    }

    // Rebuild hierarchy if graph changed
    this.rebuildHierarchy();

    const H_init = this.graphBuilder.getToolEmbeddings();
    const capabilityNodes = this.graphBuilder.getCapabilityNodes();

    // Handle empty graph
    if (capabilityNodes.size === 0 || !this.hierarchy || !this.multiLevelIncidence) {
      return {
        H: H_init,
        E: [],
        cache: { H: [H_init], E: [[]], attentionVE: [], attentionEV: [] },
      };
    }

    // Build E_levels_init: initial embeddings grouped by level
    const E_levels_init = new Map<number, number[][]>();
    for (let level = 0; level <= this.hierarchy.maxHierarchyLevel; level++) {
      const capsAtLevel = this.hierarchy.hierarchyLevels.get(level) ?? new Set<string>();
      const embeddings: number[][] = [];
      for (const capId of capsAtLevel) {
        const cap = capabilityNodes.get(capId);
        if (cap) embeddings.push([...cap.embedding]);
      }
      if (embeddings.length > 0) {
        E_levels_init.set(level, embeddings);
      }
    }

    // Build incidence matrices from MultiLevelIncidence
    const toolToCapMatrix = this.buildToolToCapMatrix();
    const capToCapMatrices = this.buildCapToCapMatrices();

    // Execute multi-level forward pass
    const { result, cache: _multiCache } = this.orchestrator.forwardMultiLevel(
      H_init,
      E_levels_init,
      toolToCapMatrix,
      capToCapMatrices,
      this.levelParams,
      {
        numHeads: this.config.numHeads,
        numLayers: this.config.numLayers,
        dropout: this.config.dropout,
        leakyReluSlope: this.config.leakyReluSlope,
      },
    );

    // Flatten E for backward compatibility with scoring
    // Order: level 0, then level 1, etc. (matches capabilityIndex order from graphBuilder)
    let E_flat = this.flattenEmbeddingsByCapabilityOrder(result.E);
    let H_final = result.H;

    // PreserveDim: add residual connection to ORIGINAL embeddings
    // This preserves semantic similarity structure while injecting graph info
    // Benchmark showed residual≥0.2 gives MRR=1.000
    if (this.config.preserveDim) {
      const E_original = this.graphBuilder.getCapabilityEmbeddings();
      const H_original = this.graphBuilder.getToolEmbeddings();
      const residual = this.config.preserveDimResidual ?? 0.3;

      // Apply residual to capabilities (E)
      E_flat = E_flat.map((e, idx) => {
        const orig = E_original[idx];
        if (!orig || orig.length !== e.length) return e;

        // Mix: E_final = (1-r)*E_propagated + r*E_original
        const mixed = e.map((v, i) => (1 - residual) * v + residual * orig[i]);

        // Normalize to unit vector
        const norm = Math.sqrt(mixed.reduce((s, x) => s + x * x, 0));
        return norm > 0 ? mixed.map(x => x / norm) : mixed;
      });

      // Apply residual to tools (H) - same treatment for consistent scoring
      H_final = H_final.map((h, idx) => {
        const orig = H_original[idx];
        if (!orig || orig.length !== h.length) return h;

        // Mix: H_final = (1-r)*H_propagated + r*H_original
        const mixed = h.map((v, i) => (1 - residual) * v + residual * orig[i]);

        // Normalize to unit vector
        const norm = Math.sqrt(mixed.reduce((s, x) => s + x * x, 0));
        return norm > 0 ? mixed.map(x => x / norm) : mixed;
      });
    }

    // Convert cache format for backward compatibility with training
    // Training backward pass expects cache.E[numLayers] and cache.attentionVE[l]
    const E_init = this.graphBuilder.getCapabilityEmbeddings();
    const numLayers = this.config.numLayers;

    // Pad H and E arrays to have numLayers + 1 entries
    // Interpolate intermediate layers for gradient flow
    const H_layers: number[][][] = [H_init];
    const E_layers: number[][][] = [E_init];

    for (let l = 1; l < numLayers; l++) {
      // Interpolate: lerp between init and final
      const alpha = l / numLayers;
      H_layers.push(
        H_init.map((row, i) =>
          row.map((v, j) => v * (1 - alpha) + (H_final[i]?.[j] ?? v) * alpha)
        ),
      );
      E_layers.push(
        E_init.map((row, i) => row.map((v, j) => v * (1 - alpha) + (E_flat[i]?.[j] ?? v) * alpha)),
      );
    }
    H_layers.push(H_final);
    E_layers.push(E_flat);

    // Convert attention from multi-level format to layer format
    // attentionVE[layer][head][tool][cap]
    const attentionVE = this.convertAttentionToLayerFormat(
      _multiCache.attentionUpward,
      this.graphBuilder.getToolCount(),
      this.graphBuilder.getCapabilityCount(),
    );
    const attentionEV = this.convertAttentionToLayerFormat(
      _multiCache.attentionDownward,
      this.graphBuilder.getCapabilityCount(),
      this.graphBuilder.getToolCount(),
    );

    const cache: ForwardCache = {
      H: H_layers,
      E: E_layers,
      attentionVE,
      attentionEV,
    };

    this.lastCache = cache;
    return { H: H_final, E: E_flat, cache };
  }

  /**
   * Build tool → capability incidence matrix from MultiLevelIncidence
   *
   * Returns matrix A[tool_idx][cap_idx] = 1 if tool is directly in capability
   * Only for level-0 mappings (no transitive closure)
   */
  private buildToolToCapMatrix(): number[][] {
    const numTools = this.graphBuilder.getToolCount();
    const capsAtLevel0 = this.hierarchy?.hierarchyLevels.get(0) ?? new Set<string>();
    const numCapsLevel0 = capsAtLevel0.size;

    if (numTools === 0 || numCapsLevel0 === 0) return [];

    // Build cap index for level 0
    const capIndex = new Map<string, number>();
    let idx = 0;
    for (const capId of capsAtLevel0) {
      capIndex.set(capId, idx++);
    }

    const matrix: number[][] = Array.from({ length: numTools }, () => Array(numCapsLevel0).fill(0));

    for (const [toolId, caps] of this.multiLevelIncidence!.toolToCapIncidence) {
      const tIdx = this.graphBuilder.getToolIndex(toolId);
      if (tIdx === undefined) continue;

      for (const capId of caps) {
        const cIdx = capIndex.get(capId);
        if (cIdx !== undefined) {
          matrix[tIdx][cIdx] = 1;
        }
      }
    }

    return matrix;
  }

  /**
   * Build capability → capability incidence matrices for each level
   *
   * For level k: matrix A[child_idx][parent_idx] = 1 if child is directly in parent
   */
  private buildCapToCapMatrices(): Map<number, number[][]> {
    const matrices = new Map<number, number[][]>();
    if (!this.hierarchy || !this.multiLevelIncidence) return matrices;

    for (let level = 1; level <= this.hierarchy.maxHierarchyLevel; level++) {
      const childLevel = level - 1;
      const capsAtChildLevel = this.hierarchy.hierarchyLevels.get(childLevel) ?? new Set<string>();
      const capsAtParentLevel = this.hierarchy.hierarchyLevels.get(level) ?? new Set<string>();

      if (capsAtChildLevel.size === 0 || capsAtParentLevel.size === 0) continue;

      // Build indices
      const childIndex = new Map<string, number>();
      let idx = 0;
      for (const capId of capsAtChildLevel) childIndex.set(capId, idx++);

      const parentIndex = new Map<string, number>();
      idx = 0;
      for (const capId of capsAtParentLevel) parentIndex.set(capId, idx++);

      // Build matrix [numChildren][numParents]
      const matrix: number[][] = Array.from(
        { length: capsAtChildLevel.size },
        () => Array(capsAtParentLevel.size).fill(0),
      );

      const levelMap = this.multiLevelIncidence.capToCapIncidence.get(level);
      if (levelMap) {
        for (const [childId, parents] of levelMap) {
          const cIdx = childIndex.get(childId);
          if (cIdx === undefined) continue;

          for (const parentId of parents) {
            const pIdx = parentIndex.get(parentId);
            if (pIdx !== undefined) {
              matrix[cIdx][pIdx] = 1;
            }
          }
        }
      }

      matrices.set(level, matrix);
    }

    return matrices;
  }

  /**
   * Flatten multi-level embeddings to match graphBuilder capability order
   */
  private flattenEmbeddingsByCapabilityOrder(E_levels: Map<number, number[][]>): number[][] {
    const capabilityNodes = this.graphBuilder.getCapabilityNodes();
    const result: number[][] = [];

    // Create a map from capId to embedding
    const embeddingMap = new Map<string, number[]>();

    for (let level = 0; level <= (this.hierarchy?.maxHierarchyLevel ?? 0); level++) {
      const capsAtLevel = this.hierarchy?.hierarchyLevels.get(level) ?? new Set<string>();
      const embeddings = E_levels.get(level) ?? [];

      let idx = 0;
      for (const capId of capsAtLevel) {
        if (idx < embeddings.length) {
          embeddingMap.set(capId, embeddings[idx]);
        }
        idx++;
      }
    }

    // Return in graphBuilder order
    for (const [capId] of capabilityNodes) {
      const emb = embeddingMap.get(capId);
      if (emb) {
        result.push(emb);
      } else {
        // Fallback: use zero embedding with correct dimension
        const dim = E_levels.get(0)?.[0]?.length ?? this.config.hiddenDim;
        result.push(new Array(dim).fill(0));
      }
    }

    return result;
  }

  /**
   * Build mapping from flat capability index to (level, withinLevelIndex)
   *
   * Used by training to route dCapEmbedding gradients to correct level.
   */
  private buildCapIndexToLevelMap(): Map<number, { level: number; withinLevelIdx: number }> {
    const mapping = new Map<number, { level: number; withinLevelIdx: number }>();
    const capabilityNodes = this.graphBuilder.getCapabilityNodes();

    if (!this.hierarchy) return mapping;

    // Build capId → (level, withinLevelIdx)
    const capIdToLevel = new Map<string, { level: number; withinLevelIdx: number }>();
    for (let level = 0; level <= this.hierarchy.maxHierarchyLevel; level++) {
      const capsAtLevel = this.hierarchy.hierarchyLevels.get(level) ?? new Set<string>();
      let withinLevelIdx = 0;
      for (const capId of capsAtLevel) {
        capIdToLevel.set(capId, { level, withinLevelIdx });
        withinLevelIdx++;
      }
    }

    // Map flat index to (level, withinLevelIdx)
    let flatIdx = 0;
    for (const [capId] of capabilityNodes) {
      const levelInfo = capIdToLevel.get(capId);
      if (levelInfo) {
        mapping.set(flatIdx, levelInfo);
      }
      flatIdx++;
    }

    return mapping;
  }

  /**
   * Convert multi-level attention format to layer-based format for training
   *
   * Multi-level: Map<level, [head][source][target]>
   * Layer-based: [layer][head][source][target]
   *
   * Training backward pass expects attention matrices per layer.
   * We replicate the multi-level attention to fill all layers.
   */
  private convertAttentionToLayerFormat(
    multiLevelAttention: Map<number, number[][][]>,
    numSources: number,
    numTargets: number,
  ): number[][][][] {
    const numLayers = this.config.numLayers;
    const numHeads = this.config.numHeads;
    const result: number[][][][] = [];

    // Initialize empty attention matrices for each layer
    for (let l = 0; l < numLayers; l++) {
      const layerAttention: number[][][] = [];
      for (let h = 0; h < numHeads; h++) {
        const headMatrix: number[][] = Array.from(
          { length: numSources },
          () => Array(numTargets).fill(0),
        );
        layerAttention.push(headMatrix);
      }
      result.push(layerAttention);
    }

    // Fill with multi-level attention data
    // Strategy: distribute levels across layers
    const levels = Array.from(multiLevelAttention.keys()).sort((a, b) => a - b);
    if (levels.length === 0) return result;

    for (let l = 0; l < numLayers; l++) {
      // Map layer index to level (round-robin if more layers than levels)
      const levelIdx = Math.min(l, levels.length - 1);
      const level = levels[levelIdx];
      const levelAttention = multiLevelAttention.get(level);

      if (!levelAttention) continue;

      // Copy attention weights
      for (let h = 0; h < Math.min(numHeads, levelAttention.length); h++) {
        const srcMatrix = levelAttention[h];
        if (!srcMatrix) continue;

        for (let s = 0; s < Math.min(numSources, srcMatrix.length); s++) {
          const srcRow = srcMatrix[s];
          if (!srcRow) continue;

          for (let t = 0; t < Math.min(numTargets, srcRow.length); t++) {
            result[l][h][s][t] = srcRow[t];
          }
        }
      }
    }

    return result;
  }

  // ==========================================================================
  // Intent Projection
  // ==========================================================================

  private projectIntent(intentEmbedding: number[]): number[] {
    const propagatedDim = this.params.W_intent.length;
    const result = new Array(propagatedDim).fill(0);

    for (let i = 0; i < propagatedDim; i++) {
      for (let j = 0; j < intentEmbedding.length; j++) {
        result[i] += this.params.W_intent[i][j] * intentEmbedding[j];
      }
    }

    return result;
  }

  // ==========================================================================
  // V2 Scoring Methods
  // ==========================================================================

  private projectFeaturesV2(features: TraceFeatures): number[] {
    const { hiddenDim } = this.config;
    const statsVec = traceStatsToVector(features.traceStats);
    const combined = [
      ...features.intentEmbedding,
      ...features.candidateEmbedding,
      ...features.contextAggregated,
      ...statsVec,
    ];

    const result = new Array(hiddenDim).fill(0);
    for (let i = 0; i < hiddenDim; i++) {
      let sum = this.params.b_proj[i];
      for (let j = 0; j < combined.length; j++) {
        sum += this.params.W_proj[i][j] * combined[j];
      }
      result[i] = Math.max(0, sum);
    }

    return result;
  }

  private computeHeadScoreV2(projected: number[], headIdx: number): number {
    const hp = this.params.headParams[headIdx];
    const { hiddenDim } = this.config;

    const Q = new Array(hiddenDim).fill(0);
    const K = new Array(hiddenDim).fill(0);
    const V = new Array(hiddenDim).fill(0);

    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < projected.length; j++) {
        Q[i] += hp.W_q[i][j] * projected[j];
        K[i] += hp.W_k[i][j] * projected[j];
        V[i] += hp.W_v[i][j] * projected[j];
      }
    }

    const scale = Math.sqrt(hiddenDim);
    const attentionWeight = math.sigmoid(math.dot(Q, K) / scale);
    return attentionWeight * V.reduce((a, b) => a + b, 0) / hiddenDim;
  }

  /** @deprecated V2 scoring path is legacy */
  private computeMultiHeadScoresV2(features: TraceFeatures): number[] {
    const projected = this.projectFeaturesV2(features);
    return Array.from(
      { length: this.config.numHeads },
      (_, h) => this.computeHeadScoreV2(projected, h),
    );
  }

  /** @deprecated V2 scoring path is legacy */
  private fusionMLPForward(headScores: number[]): number {
    const { mlpHiddenDim } = this.config;
    const hidden = new Array(mlpHiddenDim).fill(0);

    for (let i = 0; i < mlpHiddenDim; i++) {
      let sum = this.params.fusionMLP.b1[i];
      for (let j = 0; j < headScores.length; j++) {
        sum += this.params.fusionMLP.W1[i][j] * headScores[j];
      }
      hidden[i] = Math.max(0, sum);
    }

    let output = this.params.fusionMLP.b2;
    for (let i = 0; i < mlpHiddenDim; i++) {
      output += this.params.fusionMLP.W2[i] * hidden[i];
    }

    return output; // Raw logit, no sigmoid
  }

  /**
   * @deprecated Use scoreAllCapabilities() instead - V2 TraceFeatures path is legacy
   */
  scoreWithTraceFeaturesV2(features: TraceFeatures): { score: number; headScores: number[] } {
    const headScores = this.computeMultiHeadScoresV2(features);
    return { score: this.fusionMLPForward(headScores), headScores };
  }

  /**
   * @deprecated Use scoreAllCapabilities() instead - V2 is slower and not optimized
   */
  scoreAllCapabilitiesV2(
    intentEmbedding: number[],
    traceFeaturesMap: Map<string, TraceFeatures>,
    contextToolIds: string[] = [],
  ): AttentionResult[] {
    const results: AttentionResult[] = [];
    const { numHeads } = this.config;
    const capabilityNodes = this.graphBuilder.getCapabilityNodes();
    const toolNodes = this.graphBuilder.getToolNodes();

    const contextEmbeddings: number[][] = [];
    for (const toolId of contextToolIds.slice(-this.config.maxContextLength)) {
      const tool = toolNodes.get(toolId);
      if (tool) contextEmbeddings.push(tool.embedding);
    }
    const contextAggregated = math.meanPool(contextEmbeddings, intentEmbedding.length);

    for (const [capId, cap] of capabilityNodes) {
      const providedFeatures = traceFeaturesMap.get(capId);
      const hgFeatures = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;

      const features: TraceFeatures = {
        intentEmbedding,
        candidateEmbedding: cap.embedding,
        contextEmbeddings,
        contextAggregated,
        traceStats: providedFeatures?.traceStats ?? createDefaultTraceStatsFromFeatures(
          cap.successRate,
          hgFeatures.cooccurrence,
          hgFeatures.recency,
          hgFeatures.hypergraphPageRank,
        ),
      };

      const { score, headScores } = this.scoreWithTraceFeaturesV2(features);
      const reliabilityMult = cap.successRate < 0.5 ? 0.5 : (cap.successRate > 0.9 ? 1.2 : 1.0);

      results.push({
        capabilityId: capId,
        score: Math.min(0.95, Math.max(0, score * reliabilityMult)),
        headWeights: new Array(numHeads).fill(1 / numHeads),
        headScores,
        recursiveContribution: 0,
        featureContributions: {
          semantic: headScores[0] ?? 0,
          structure: headScores[1] ?? 0,
          temporal: headScores[2] ?? 0,
          reliability: reliabilityMult,
        },
        toolAttention: this.getCapabilityToolAttention(
          this.graphBuilder.getCapabilityIndex(capId)!,
        ),
      });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * @deprecated Use scoreAllTools() instead - V2 is slower and not optimized
   */
  scoreAllToolsV2(
    intentEmbedding: number[],
    traceFeaturesMap: Map<string, TraceFeatures>,
    contextToolIds: string[] = [],
  ): Array<{ toolId: string; score: number; headScores: number[] }> {
    const results: Array<{ toolId: string; score: number; headScores: number[] }> = [];
    const toolNodes = this.graphBuilder.getToolNodes();

    const contextEmbeddings: number[][] = [];
    for (const toolId of contextToolIds.slice(-this.config.maxContextLength)) {
      const tool = toolNodes.get(toolId);
      if (tool) contextEmbeddings.push(tool.embedding);
    }
    const contextAggregated = math.meanPool(contextEmbeddings, intentEmbedding.length);

    for (const [toolId, tool] of toolNodes) {
      const providedFeatures = traceFeaturesMap.get(toolId);
      const toolFeatures = tool.toolFeatures || DEFAULT_TOOL_GRAPH_FEATURES;

      const features: TraceFeatures = {
        intentEmbedding,
        candidateEmbedding: tool.embedding,
        contextEmbeddings,
        contextAggregated,
        traceStats: providedFeatures?.traceStats ??
          createDefaultTraceStatsFromFeatures(
            0.5,
            toolFeatures.cooccurrence,
            toolFeatures.recency,
            toolFeatures.pageRank,
          ),
      };

      const { score, headScores } = this.scoreWithTraceFeaturesV2(features);
      results.push({ toolId, score: Math.min(0.95, Math.max(0, score)), headScores });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * @deprecated Use scoreAllCapabilities() instead - V3 hybrid path is legacy
   */
  scoreAllCapabilitiesV3(
    intentEmbedding: number[],
    traceFeaturesMap: Map<string, TraceFeatures>,
    contextToolIds: string[] = [],
  ): AttentionResult[] {
    const results: AttentionResult[] = [];
    const { numHeads } = this.config;
    const capabilityNodes = this.graphBuilder.getCapabilityNodes();
    const toolNodes = this.graphBuilder.getToolNodes();

    const { E } = this.forward();

    const contextEmbeddings: number[][] = [];
    for (const toolId of contextToolIds.slice(-this.config.maxContextLength)) {
      const tool = toolNodes.get(toolId);
      if (tool) contextEmbeddings.push(tool.embedding);
    }
    const contextAggregated = math.meanPool(contextEmbeddings, intentEmbedding.length);

    for (const [capId, cap] of capabilityNodes) {
      const cIdx = this.graphBuilder.getCapabilityIndex(capId)!;
      const providedFeatures = traceFeaturesMap.get(capId);
      const hgFeatures = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;

      const features: TraceFeatures = {
        intentEmbedding,
        candidateEmbedding: E[cIdx],
        contextEmbeddings,
        contextAggregated,
        traceStats: providedFeatures?.traceStats ?? createDefaultTraceStatsFromFeatures(
          cap.successRate,
          hgFeatures.cooccurrence,
          hgFeatures.recency,
          hgFeatures.hypergraphPageRank,
        ),
      };

      const { score, headScores } = this.scoreWithTraceFeaturesV2(features);
      const reliabilityMult = cap.successRate < 0.5 ? 0.5 : (cap.successRate > 0.9 ? 1.2 : 1.0);

      results.push({
        capabilityId: capId,
        score: Math.min(0.95, Math.max(0, score * reliabilityMult)),
        headWeights: new Array(numHeads).fill(1 / numHeads),
        headScores,
        recursiveContribution: 0,
        featureContributions: {
          semantic: headScores[0] ?? 0,
          structure: headScores[1] ?? 0,
          temporal: headScores[2] ?? 0,
          reliability: reliabilityMult,
        },
        toolAttention: this.getCapabilityToolAttention(cIdx),
      });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  // ==========================================================================
  // V1 Scoring Methods (Multi-Head n-SuperHyperGraph)
  // ==========================================================================

  /**
   * Pre-compute Q = W_q @ intent for all heads
   *
   * OPTIMIZATION: Q only depends on intent (same for all capabilities)
   * Pre-computing saves numCaps-1 redundant matrix multiplications per head
   *
   * @returns Array of Q vectors, one per head
   */
  private precomputeQForAllHeads(intentProjected: number[]): number[][] {
    const { numHeads, hiddenDim } = this.config;
    const precomputedQ: number[][] = [];

    for (let h = 0; h < numHeads; h++) {
      const hp = this.params.headParams[h];
      const outputDim = hp.W_q.length;
      const wqCols = hp.W_q[0]?.length || hiddenDim;
      const inputDim = Math.min(intentProjected.length, wqCols);

      const Q = new Array(outputDim).fill(0);
      for (let i = 0; i < outputDim; i++) {
        for (let j = 0; j < inputDim; j++) {
          Q[i] += hp.W_q[i][j] * intentProjected[j];
        }
      }
      precomputedQ.push(Q);
    }

    return precomputedQ;
  }

  /**
   * Compute multi-head scores using pre-computed Q vectors (per-item, legacy)
   *
   * Only computes K = W_k @ capEmbedding (Q already computed)
   *
   * @deprecated Use batchComputeKForAllHeads + batchComputeScores for ~30% speedup
   */
  // @ts-ignore TS6133 - kept as fallback method
  computeMultiHeadScoresWithPrecomputedQLegacy(
    precomputedQ: number[][],
    capEmbedding: number[],
  ): number[] {
    const { numHeads, hiddenDim } = this.config;
    const scores: number[] = [];

    for (let h = 0; h < numHeads; h++) {
      const hp = this.params.headParams[h];
      const Q = precomputedQ[h];
      const outputDim = hp.W_k.length;
      const wkCols = hp.W_k[0]?.length || hiddenDim;
      const inputDim = Math.min(capEmbedding.length, wkCols);

      // Only compute K (Q is pre-computed)
      const K = new Array(outputDim).fill(0);
      for (let i = 0; i < outputDim; i++) {
        for (let j = 0; j < inputDim; j++) {
          K[i] += hp.W_k[i][j] * capEmbedding[j];
        }
      }

      const scale = Math.sqrt(outputDim);
      scores.push(math.dot(Q, K) / scale);
    }

    return scores;
  }

  // ==========================================================================
  // Batch K-head Scoring (optimized - single matmul per head)
  // ==========================================================================

  /**
   * Batch compute K vectors for all embeddings in one matmul per head
   *
   * Instead of: 105× (W_k @ cap)  → 105 small matmuls
   * We do:      E @ W_k.T         → 1 large matmul [numCaps×embDim] @ [embDim×hiddenDim]
   *
   * @param E - Capability embeddings matrix [numCaps][embDim]
   * @returns K_all[numHeads][numCaps][hiddenDim] - K vectors for all caps, all heads
   */
  private batchComputeKForAllHeads(E: number[][]): number[][][] {
    const { numHeads } = this.config;
    const K_all: number[][][] = [];

    for (let h = 0; h < numHeads; h++) {
      const hp = this.params.headParams[h];
      // W_k is [hiddenDim][embDim], we need W_k.T which is [embDim][hiddenDim]
      const W_k_T = math.transpose(hp.W_k);
      // E @ W_k.T: [numCaps×embDim] @ [embDim×hiddenDim] = [numCaps×hiddenDim]
      K_all.push(math.matmul(E, W_k_T));
    }

    return K_all;
  }

  /**
   * Batch compute scores for all capabilities using precomputed Q and K
   *
   * @param precomputedQ - Q vectors [numHeads][hiddenDim]
   * @param K_all - K vectors [numHeads][numCaps][hiddenDim]
   * @returns scores[numCaps][numHeads]
   */
  private batchComputeScores(
    precomputedQ: number[][],
    K_all: number[][][],
  ): number[][] {
    const { numHeads } = this.config;
    const numCaps = K_all[0]?.length || 0;
    const scores: number[][] = new Array(numCaps);

    for (let c = 0; c < numCaps; c++) {
      scores[c] = new Array(numHeads);
      for (let h = 0; h < numHeads; h++) {
        const Q = precomputedQ[h];
        const K = K_all[h][c];
        const scale = Math.sqrt(Q.length);
        scores[c][h] = math.dot(Q, K) / scale;
      }
    }

    return scores;
  }

  /**
   * Compute attention score for a single head (v1)
   *
   * Uses Query-Key attention:
   * - Q = W_q @ intentProjected
   * - K = W_k @ capEmbedding
   * - logit = Q·K / √dim (raw, no sigmoid - softmax at discover level)
   *
   * NOTE: Kept for backward compatibility. For inference, prefer
   * precomputeQForAllHeads + computeMultiHeadScoresWithPrecomputedQ
   */
  private computeHeadScoreV1(
    intentProjected: number[],
    capEmbedding: number[],
    headIdx: number,
  ): number {
    const hp = this.params.headParams[headIdx];
    const { hiddenDim } = this.config;

    // W_q/W_k are [hiddenDim][embeddingDim] where hiddenDim = numHeads * 16
    // Projects intent and cap embeddings to Q, K vectors for attention
    const outputDim = hp.W_q.length; // = hiddenDim (adaptive)
    const wqCols = hp.W_q[0]?.length || hiddenDim;
    const inputDim = Math.min(intentProjected.length, capEmbedding.length, wqCols);

    const Q = new Array(outputDim).fill(0);
    const K = new Array(outputDim).fill(0);

    for (let i = 0; i < outputDim; i++) {
      for (let j = 0; j < inputDim; j++) {
        Q[i] += hp.W_q[i][j] * intentProjected[j];
        K[i] += hp.W_k[i][j] * capEmbedding[j];
      }
    }

    const scale = Math.sqrt(outputDim);
    return math.dot(Q, K) / scale; // Raw logit, no sigmoid
  }

  /**
   * Compute multi-head scores for v1 (legacy - kept for reference/fallback)
   *
   * Returns K scores, one per attention head.
   *
   * @deprecated Use computeMultiHeadScoresWithPrecomputedQ() instead for ~40% speedup
   */
  // @ts-ignore TS6133 - kept as fallback method
  computeMultiHeadScoresV1Legacy(intentProjected: number[], capEmbedding: number[]): number[] {
    return Array.from(
      { length: this.config.numHeads },
      (_, h) => this.computeHeadScoreV1(intentProjected, capEmbedding, h),
    );
  }

  /**
   * Score all capabilities using multi-head n-SuperHyperGraph attention
   *
   * v1 Architecture:
   * 1. Forward pass: V → E^0 → E^1 → ... → E^L_max (multi-level message passing)
   * 2. K-head scoring: Q = W_q @ intent, K = W_k @ E_propagated, logit_h = Q·K/√d
   * 3. Fusion: average of head logits (softmax applied at discover level)
   *
   * No TraceFeatures - pure structural similarity learned via message passing + attention.
   *
   * TODO(episodic-memory): This method uses cap.successRate from capability_records (aggregated),
   * but does NOT use episodic memory for context-aware success rates.
   * Episodic memory is only used in DAGSuggester.predictNextNodes() for speculation.
   * Consider: Add optional EpisodicMemoryStore parameter for contextual reliability adjustment.
   *
   * @param intentEmbedding - User intent embedding (1024 dim)
   * @param _contextToolIds - Unused in v1 (kept for API compatibility)
   */
  scoreAllCapabilities(intentEmbedding: number[], _contextToolIds?: string[]): AttentionResult[] {
    const { E } = this.forward();
    const results: AttentionResult[] = [];
    const { numHeads } = this.config;
    const capabilityNodes = this.graphBuilder.getCapabilityNodes();

    // PreserveDim mode: use raw intent (1024-dim) directly with W_q
    // Standard mode: project intent via W_intent (1024 → hiddenDim)
    const intentForScoring = this.config.preserveDim
      ? intentEmbedding
      : this.projectIntent(intentEmbedding);

    // OPTIMIZATION v2: Batch K computation
    // Before: 105× (W_k @ cap) → 105 small matmuls per head
    // After:  E @ W_k.T        → 1 large matmul per head [105×1024] @ [1024×64]
    // Combined with Q precompute, reduces total ops significantly

    // 1. Pre-compute Q for all heads (8 small matmuls)
    const precomputedQ = this.precomputeQForAllHeads(intentForScoring);

    // 2. Batch compute K for all capabilities, all heads (8 large matmuls instead of 840 small)
    const K_all = this.batchComputeKForAllHeads(E);

    // 3. Batch compute scores (just dot products, very fast)
    const allScores = this.batchComputeScores(precomputedQ, K_all);

    // 4. Build results with capability metadata
    let capIdx = 0;
    for (const [capId, cap] of capabilityNodes) {
      const headScores = allScores[capIdx];

      // Fusion: simple average of head logits
      const avgScore = headScores.reduce((a, b) => a + b, 0) / numHeads;

      // Reliability multiplier based on success rate
      const reliabilityMult = cap.successRate < 0.5 ? 0.5 : (cap.successRate > 0.9 ? 1.2 : 1.0);
      const finalScore = avgScore * reliabilityMult;

      results.push({
        capabilityId: capId,
        score: finalScore,
        headWeights: new Array(numHeads).fill(1 / numHeads),
        headScores,
        recursiveContribution: 0,
        toolAttention: this.getCapabilityToolAttention(capIdx),
      });

      capIdx++;
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Score all tools using multi-head n-SuperHyperGraph attention
   *
   * v1 Architecture: K-head attention on propagated tool embeddings
   *
   * @param intentEmbedding - User intent embedding (1024 dim)
   * @param _contextToolIds - Unused in v1 (kept for API compatibility)
   */
  scoreAllTools(
    intentEmbedding: number[],
    _contextToolIds?: string[],
  ): Array<{ toolId: string; score: number; headScores: number[] }> {
    const { H } = this.forward();
    const results: Array<{ toolId: string; score: number; headScores: number[] }> = [];
    const toolNodes = this.graphBuilder.getToolNodes();
    const { numHeads } = this.config;

    // PreserveDim mode: use raw intent (1024-dim) directly with W_q
    // Standard mode: project intent via W_intent (1024 → hiddenDim)
    const intentForScoring = this.config.preserveDim
      ? intentEmbedding
      : this.projectIntent(intentEmbedding);

    // OPTIMIZATION v2: Batch K computation (same as scoreAllCapabilities)
    // 1. Pre-compute Q for all heads
    const precomputedQ = this.precomputeQForAllHeads(intentForScoring);

    // 2. Batch compute K for all tools, all heads
    const K_all = this.batchComputeKForAllHeads(H);

    // 3. Batch compute scores
    const allScores = this.batchComputeScores(precomputedQ, K_all);

    // 4. Build results
    let toolIdx = 0;
    for (const [toolId] of toolNodes) {
      const headScores = allScores[toolIdx];
      const avgScore = headScores.reduce((a, b) => a + b, 0) / numHeads;
      const finalScore = Math.min(0.95, Math.max(0, avgScore));

      results.push({
        toolId,
        score: finalScore,
        headScores,
      });

      toolIdx++;
    }

    return results.sort((a, b) => b.score - a.score);
  }

  predictPathSuccess(intentEmbedding: number[], path: string[]): number {
    const capabilityNodes = this.graphBuilder.getCapabilityNodes();
    const toolNodes = this.graphBuilder.getToolNodes();

    if (capabilityNodes.size === 0 && toolNodes.size === 0) return 0.5;
    if (!path || path.length === 0) return 0.5;

    const toolScoresMap = new Map<string, number>();
    const capScoresMap = new Map<string, number>();

    if (path.some((id) => toolNodes.has(id))) {
      for (const r of this.scoreAllTools(intentEmbedding)) toolScoresMap.set(r.toolId, r.score);
    }
    if (path.some((id) => capabilityNodes.has(id))) {
      for (const r of this.scoreAllCapabilities(intentEmbedding)) {
        capScoresMap.set(r.capabilityId, r.score);
      }
    }

    let weightedSum = 0, weightTotal = 0;
    for (let i = 0; i < path.length; i++) {
      const weight = 1 + i * 0.5;
      const score = toolScoresMap.get(path[i]) ?? capScoresMap.get(path[i]) ?? 0.5;
      weightedSum += score * weight;
      weightTotal += weight;
    }

    return weightedSum / weightTotal;
  }

  computeAttention(
    intentEmbedding: number[],
    _contextToolEmbeddings: number[][],
    capabilityId: string,
    _contextCapabilityIds?: string[],
  ): AttentionResult {
    const results = this.scoreAllCapabilities(intentEmbedding);
    return results.find((r) => r.capabilityId === capabilityId) || {
      capabilityId,
      score: 0,
      headWeights: new Array(this.config.numHeads).fill(0),
      headScores: new Array(this.config.numHeads).fill(0),
      recursiveContribution: 0,
    };
  }

  private getCapabilityToolAttention(capIdx: number): number[] {
    if (!this.lastCache || this.lastCache.attentionVE.length === 0) return [];

    const lastLayerVE = this.lastCache.attentionVE[this.config.numLayers - 1];
    const toolCount = this.graphBuilder.getToolCount();

    return Array.from({ length: toolCount }, (_, t) => {
      let avg = 0;
      for (let h = 0; h < this.config.numHeads; h++) avg += lastLayerVE[h][t][capIdx];
      return avg / this.config.numHeads;
    });
  }

  // ==========================================================================
  // Training
  // ==========================================================================

  trainOnExample(example: TrainingExample): { loss: number; accuracy: number; tdErrors: number[] } {
    return this.trainBatch([example]);
  }

  trainBatch(
    examples: TrainingExample[],
    isWeights?: number[],
    gamma: number = 0.99,
  ): { loss: number; accuracy: number; tdErrors: number[] } {
    const weights = isWeights ?? new Array(examples.length).fill(1);
    const tdErrors: number[] = [];
    this.trainingMode = true;

    let totalLoss = 0, correct = 0;
    const grads = initV1Gradients(this.config, this.params.layerParams);

    for (let i = 0; i < examples.length; i++) {
      const example = examples[i];
      const isWeight = weights[i];

      const { E, cache } = this.forward();
      const capIdx = this.graphBuilder.getCapabilityIndex(example.candidateId);
      if (capIdx === undefined) {
        tdErrors.push(0);
        continue;
      }

      const capNode = this.graphBuilder.getCapabilityNode(example.candidateId)!;
      const features = capNode.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;
      const intentProjected = this.projectIntent(example.intentEmbedding);

      const intentSim = math.cosineSimilarity(intentProjected, E[capIdx]);
      const rawSemantic = intentSim;
      const rawStructure = features.hypergraphPageRank + (features.adamicAdar ?? 0);
      const rawTemporal = features.recency + (features.heatDiffusion ?? 0);

      const semanticScore = rawSemantic * this.params.featureWeights.semantic;
      const structureScore = rawStructure * this.params.featureWeights.structure;
      const temporalScore = rawTemporal * this.params.featureWeights.temporal;

      const groupWeights = computeFusionWeights(this.params.fusionWeights);
      const reliabilityMult = capNode.successRate < 0.5
        ? 0.5
        : (capNode.successRate > 0.9 ? 1.2 : 1.0);
      const baseScore = groupWeights.semantic * semanticScore +
        groupWeights.structure * structureScore + groupWeights.temporal * temporalScore;
      const score = math.sigmoid(baseScore * reliabilityMult);

      const tdError = example.outcome * Math.pow(gamma, example.contextTools?.length ?? 0) - score;
      tdErrors.push(tdError);

      totalLoss += math.binaryCrossEntropy(score, example.outcome) * isWeight;
      if ((score > 0.5 ? 1 : 0) === example.outcome) correct++;

      const dLoss = (score - example.outcome) * isWeight;
      const sigmoidGrad = score * (1 - score) * reliabilityMult;
      const { semantic: ws, structure: wst, temporal: wt } = groupWeights;

      grads.fusionGradients.semantic += dLoss * sigmoidGrad *
        (ws * (1 - ws) * semanticScore - ws * wst * structureScore - ws * wt * temporalScore);
      grads.fusionGradients.structure += dLoss * sigmoidGrad *
        (wst * (1 - wst) * structureScore - wst * ws * semanticScore - wst * wt * temporalScore);
      grads.fusionGradients.temporal += dLoss * sigmoidGrad *
        (wt * (1 - wt) * temporalScore - wt * ws * semanticScore - wt * wst * structureScore);
      grads.featureGradients.semantic += dLoss * sigmoidGrad * ws * rawSemantic;
      grads.featureGradients.structure += dLoss * sigmoidGrad * wst * rawStructure;
      grads.featureGradients.temporal += dLoss * sigmoidGrad * wt * rawTemporal;

      backwardV1(grads, cache, capIdx, intentProjected, dLoss, this.config);
      accumulateW_intentGradients(
        grads,
        example.intentEmbedding,
        intentProjected,
        E[capIdx],
        dLoss,
      );
    }

    applyLayerGradients(grads, this.params.layerParams, this.config, examples.length);
    applyFusionGradients(grads, this.params.fusionWeights, this.config, examples.length);
    applyFeatureGradients(grads, this.params.featureWeights, this.config, examples.length);
    applyW_intentGradients(grads, this.params.W_intent, this.config, examples.length);

    this.trainingMode = false;
    return { loss: totalLoss / examples.length, accuracy: correct / examples.length, tdErrors };
  }

  resetV2Gradients(): void {
    resetV2GradientAccumulators(this.v2GradAccum, this.config);
  }

  trainBatchV2(
    examples: TrainingExample[],
    traceStatsMap: Map<string, TraceStats>,
    isWeights?: number[],
    gamma: number = 0.99,
  ): { loss: number; accuracy: number; tdErrors: number[] } {
    const weights = isWeights ?? new Array(examples.length).fill(1);
    const tdErrors: number[] = [];
    this.trainingMode = true;

    let totalLoss = 0, correct = 0;
    this.resetV2Gradients();

    for (let i = 0; i < examples.length; i++) {
      const example = examples[i];
      const isWeight = weights[i];

      const capNode = this.graphBuilder.getCapabilityNode(example.candidateId);
      if (!capNode) {
        tdErrors.push(0);
        continue;
      }

      const traceStats = traceStatsMap.get(example.candidateId) ?? { ...DEFAULT_TRACE_STATS };
      const contextEmbeddings: number[][] = [];
      for (const toolId of example.contextTools.slice(0, 5)) {
        const toolNode = this.graphBuilder.getToolNode(toolId);
        if (toolNode) contextEmbeddings.push(toolNode.embedding);
      }

      const features = buildTraceFeatures(
        example.intentEmbedding,
        capNode.embedding,
        contextEmbeddings,
        traceStats,
        this.config.embeddingDim,
      );
      const cache = forwardV2WithCache(
        features,
        this.config,
        this.params.headParams,
        this.params.W_proj,
        this.params.b_proj,
        this.params.fusionMLP,
      );

      const tdError = example.outcome * Math.pow(gamma, example.contextTools.length) - cache.score;
      tdErrors.push(tdError);

      totalLoss += math.binaryCrossEntropy(cache.score, example.outcome) * isWeight;
      if ((cache.score > 0.5 ? 1 : 0) === example.outcome) correct++;

      backwardV2(
        cache,
        (cache.score - example.outcome) * isWeight,
        this.config,
        this.params.headParams,
        this.params.fusionMLP,
        this.v2GradAccum,
      );
    }

    applyV2Gradients(
      this.v2GradAccum,
      this.config,
      this.params.W_proj,
      this.params.b_proj,
      this.params.fusionMLP,
      examples.length,
    );
    this.trainingMode = false;
    return { loss: totalLoss / examples.length, accuracy: correct / examples.length, tdErrors };
  }

  applyV2Gradients(batchSize: number): void {
    applyV2Gradients(
      this.v2GradAccum,
      this.config,
      this.params.W_proj,
      this.params.b_proj,
      this.params.fusionMLP,
      batchSize,
    );
  }

  /**
   * Train v1 with K-head scoring (trains headParams W_q, W_k AND levelParams)
   *
   * Unlike trainBatch() which uses cosine + fusion weights,
   * this trains the K-head attention mechanism AND message passing params.
   *
   * Architecture:
   * 1. Multi-level message passing: V → E^0 → ... → E^L → ... → V
   * 2. K-head attention scoring: score = sigmoid(Q·K/√d)
   * 3. InfoNCE contrastive loss (or BCE fallback)
   *
   * Trains: W_q, W_k (K-head), W_intent, AND levelParams (message passing)
   */
  trainBatchV1KHead(
    examples: TrainingExample[],
    isWeights?: number[], // Importance sampling weights for PER (default: uniform)
  ): { loss: number; accuracy: number; tdErrors: number[]; gradNorm: number } {
    this.trainingMode = true;
    this.orchestrator = new MultiLevelOrchestrator(true); // Enable training mode
    const tdErrors: number[] = [];
    // Default to uniform weights if not provided
    const weights = isWeights ?? new Array(examples.length).fill(1.0);

    // Rebuild hierarchy to ensure structures are up-to-date
    this.rebuildHierarchy();

    // Initialize K-head and W_intent gradients
    const grads = initMultiLevelKHeadGradients(
      this.levelParams,
      this.params.headParams,
      this.config,
    );

    // Build cap index → level mapping for routing gradients
    const capIndexToLevel = this.buildCapIndexToLevelMap();
    const maxLevel = this.hierarchy?.maxHierarchyLevel ?? 0;

    // Accumulate dCapEmbedding gradients per level across batch
    const dE_accum = new Map<number, Map<number, number[]>>();
    for (let level = 0; level <= maxLevel; level++) {
      dE_accum.set(level, new Map());
    }

    let totalLoss = 0;
    let correct = 0;
    let mpCache: MultiLevelBackwardCache | null = null;

    // Temperature for InfoNCE
    const TEMPERATURE = 0.1;

    for (let exIdx = 0; exIdx < examples.length; exIdx++) {
      const example = examples[exIdx];
      const isWeight = weights[exIdx]; // IS weight for this example

      // === FORWARD: Multi-level message passing with cache ===
      const H_init = this.graphBuilder.getToolEmbeddings();
      const capabilityNodes = this.graphBuilder.getCapabilityNodes();

      if (capabilityNodes.size === 0 || !this.hierarchy || !this.multiLevelIncidence) {
        tdErrors.push(0);
        continue;
      }

      // Build E_levels_init
      const E_levels_init = new Map<number, number[][]>();
      for (let level = 0; level <= maxLevel; level++) {
        const capsAtLevel = this.hierarchy.hierarchyLevels.get(level) ?? new Set<string>();
        const embeddings: number[][] = [];
        for (const capId of capsAtLevel) {
          const cap = capabilityNodes.get(capId);
          if (cap) embeddings.push([...cap.embedding]);
        }
        if (embeddings.length > 0) {
          E_levels_init.set(level, embeddings);
        }
      }

      // Build matrices
      const toolToCapMatrix = this.buildToolToCapMatrix();
      const capToCapMatrices = this.buildCapToCapMatrices();

      // Forward with cache (pass v2vParams for trainable V→V)
      const { result, cache } = this.orchestrator.forwardMultiLevelWithCache(
        H_init,
        E_levels_init,
        toolToCapMatrix,
        capToCapMatrices,
        this.levelParams,
        {
          numHeads: this.config.numHeads,
          numLayers: this.config.numLayers,
          dropout: this.config.dropout,
          leakyReluSlope: this.config.leakyReluSlope,
        },
        this.v2vParams, // Trainable V→V parameters
      );

      mpCache = cache; // Store for backward (use last example's cache)

      // Flatten E for K-head scoring
      const E_flat = this.flattenEmbeddingsByCapabilityOrder(result.E);

      // Project intent
      const intentProjected = this.projectIntent(example.intentEmbedding);

      // Get positive capability
      const posCapIdx = this.graphBuilder.getCapabilityIndex(example.candidateId);
      if (posCapIdx === undefined) {
        tdErrors.push(0);
        continue;
      }

      const posCapEmbedding = E_flat[posCapIdx];

      // K-head scoring with cache
      const { scores: posHeadScores, logits: posHeadLogits, caches: posHeadCaches } =
        computeMultiHeadKHeadScoresWithCache(
          intentProjected,
          posCapEmbedding,
          this.params.headParams,
          this.config,
        );
      const posScore = posHeadScores.reduce((a, b) => a + b, 0) / this.config.numHeads;
      const posLogit = posHeadLogits.reduce((a, b) => a + b, 0) / this.config.numHeads;

      if (example.negativeCapIds && example.negativeCapIds.length > 0) {
        // === CONTRASTIVE TRAINING (InfoNCE) ===
        const negLogits: number[] = [];
        const negCaches: Array<{ Q: number[]; K: number[]; dotQK: number }[]> = [];
        const negCapIndices: number[] = [];
        const negEmbeddings: number[][] = [];

        for (const negCapId of example.negativeCapIds) {
          const negCapIdx = this.graphBuilder.getCapabilityIndex(negCapId);
          if (negCapIdx === undefined) continue;

          const negCapEmbedding = E_flat[negCapIdx];
          const { logits, caches } = computeMultiHeadKHeadScoresWithCache(
            intentProjected,
            negCapEmbedding,
            this.params.headParams,
            this.config,
          );

          negLogits.push(logits.reduce((a, b) => a + b, 0) / this.config.numHeads);
          negCaches.push(caches);
          negCapIndices.push(negCapIdx);
          negEmbeddings.push(negCapEmbedding);
        }

        // InfoNCE loss (weighted by IS weight for PER)
        const allLogits = [posLogit, ...negLogits];
        const scaledScores = allLogits.map((s) => s / TEMPERATURE);
        const maxScore = Math.max(...scaledScores);
        const expScores = scaledScores.map((s) => Math.exp(s - maxScore));
        const sumExp = expScores.reduce((a, b) => a + b, 0);
        const softmax = expScores.map((e) => e / sumExp);

        totalLoss += -Math.log(softmax[0] + 1e-7) * isWeight; // Weighted loss
        tdErrors.push(1 - softmax[0]); // TD error not weighted (used for priority update)

        if (negLogits.length === 0 || posLogit > Math.max(...negLogits)) correct++;

        // === BACKWARD: K-head + collect dCapEmbedding (weighted gradients) ===
        const dLossPos = (softmax[0] - 1) / TEMPERATURE * isWeight; // Weighted gradient
        const { dIntentProjected: dIntentPos, dCapEmbedding: dCapPos } = backpropMultiHeadKHeadLogit(
          dLossPos,
          posHeadCaches,
          intentProjected,
          posCapEmbedding,
          this.params.headParams,
          grads.khead,
          this.config,
        );

        // Accumulate dCapEmbedding for positive
        this.accumulateDCapGradient(dE_accum, posCapIdx, dCapPos, capIndexToLevel);

        // Backprop through negatives (weighted gradients)
        let dIntentAccum = [...dIntentPos];
        for (let i = 0; i < negLogits.length; i++) {
          const dLossNeg = softmax[i + 1] / TEMPERATURE * isWeight; // Weighted gradient
          const { dIntentProjected: dIntentNeg, dCapEmbedding: dCapNeg } = backpropMultiHeadKHeadLogit(
            dLossNeg,
            negCaches[i],
            intentProjected,
            negEmbeddings[i],
            this.params.headParams,
            grads.khead,
            this.config,
          );

          for (let j = 0; j < dIntentAccum.length; j++) {
            dIntentAccum[j] += dIntentNeg[j] ?? 0;
          }

          // Accumulate dCapEmbedding for negative
          this.accumulateDCapGradient(dE_accum, negCapIndices[i], dCapNeg, capIndexToLevel);
        }

        backpropWIntent(dIntentAccum, example.intentEmbedding, grads, this.config);
      } else {
        // === LEGACY BCE TRAINING (weighted by IS weight for PER) ===
        const predScore = Math.min(0.95, Math.max(0.05, posScore));
        totalLoss += math.binaryCrossEntropy(predScore, example.outcome) * isWeight; // Weighted loss
        tdErrors.push(example.outcome - predScore); // TD error not weighted

        if ((predScore > 0.5 ? 1 : 0) === example.outcome) correct++;

        const dLossRaw = example.outcome === 1 ? -1 / (predScore + 1e-7) : 1 / (1 - predScore + 1e-7);
        const dLoss = dLossRaw * isWeight; // Weighted gradient
        const { dIntentProjected, dCapEmbedding } = backpropMultiHeadKHead(
          dLoss,
          posHeadScores,
          posHeadCaches,
          intentProjected,
          posCapEmbedding,
          this.params.headParams,
          grads.khead,
          this.config,
        );

        // Accumulate dCapEmbedding
        this.accumulateDCapGradient(dE_accum, posCapIdx, dCapEmbedding, capIndexToLevel);

        backpropWIntent(dIntentProjected, example.intentEmbedding, grads, this.config);
      }
    }

    // === BACKWARD: Multi-level message passing + V→V ===
    let mpGradNorm = 0;
    let v2vGradNorm = 0;
    if (mpCache && dE_accum.size > 0) {
      // Convert accumulated gradients to per-level format
      const dE_final = this.buildDEFinalFromAccum(dE_accum, mpCache);

      // Backward through message passing (includes V→V if enabled)
      const mpGrads = this.orchestrator.backwardMultiLevel(
        dE_final,
        null, // No gradient on H
        mpCache,
        this.levelParams,
        this.v2vParams, // Pass V2V params for backward
      );

      // Convert and apply MP gradients
      const mpGradsConverted = this.convertMPGradsToAccumFormat(mpGrads);
      applyLevelGradients(mpGradsConverted, this.levelParams, this.config, examples.length);

      // Compute MP gradient norm
      mpGradNorm = this.computeMPGradNorm(mpGrads);

      // Apply V→V gradients if present
      if (mpGrads.v2vGrads) {
        const lr = this.config.learningRate;
        const batchSize = examples.length;

        // SGD update for V2V params
        this.v2vParams.residualLogit -= lr * mpGrads.v2vGrads.dResidualLogit / batchSize;
        this.v2vParams.temperatureLogit -= lr * mpGrads.v2vGrads.dTemperatureLogit / batchSize;

        // Compute V2V gradient norm
        v2vGradNorm = Math.sqrt(
          mpGrads.v2vGrads.dResidualLogit ** 2 +
          mpGrads.v2vGrads.dTemperatureLogit ** 2
        );
      }
    }

    // Compute gradient norms (includes V2V)
    const levelGradNorm = computeGradientNorm(grads);
    const kheadGradNorm = computeKHeadGradientNorm(grads.khead);
    const gradNorm = Math.sqrt(
      levelGradNorm ** 2 + kheadGradNorm ** 2 + mpGradNorm ** 2 + v2vGradNorm ** 2
    );

    // Apply K-head and W_intent gradients
    applyKHeadGradients(grads.khead, this.params.headParams, this.config, examples.length);
    applyWIntentGradients(grads, this.params.W_intent, this.config, examples.length);

    this.trainingMode = false;
    return {
      loss: totalLoss / examples.length,
      accuracy: correct / examples.length,
      tdErrors,
      gradNorm,
    };
  }

  /**
   * BATCHED Training - V1 K-head with single forward pass
   *
   * ~10x faster than per-example training by:
   * 1. Running message passing ONCE (same graph for all examples)
   * 2. Batching all intent projections
   * 3. Using BLAS matrix ops for K-head scoring
   *
   * @param examples Training examples
   * @param isWeights Importance sampling weights for PER (default: uniform)
   * @returns Training result with loss, accuracy, tdErrors, gradNorm
   */
  trainBatchV1KHeadBatched(
    examples: TrainingExample[],
    isWeights?: number[],
  ): { loss: number; accuracy: number; tdErrors: number[]; gradNorm: number } {
    if (examples.length === 0) {
      return { loss: 0, accuracy: 0, tdErrors: [], gradNorm: 0 };
    }

    this.trainingMode = true;
    this.orchestrator = new MultiLevelOrchestrator(true);

    // Default to uniform weights
    const weights = isWeights ?? new Array(examples.length).fill(1.0);

    // Rebuild hierarchy
    this.rebuildHierarchy();

    // Initialize gradients
    const grads = initMultiLevelKHeadGradients(
      this.levelParams,
      this.params.headParams,
      this.config,
    );

    // Build cap index → level mapping
    const capIndexToLevel = this.buildCapIndexToLevelMap();
    const maxLevel = this.hierarchy?.maxHierarchyLevel ?? 0;

    // === SINGLE FORWARD PASS (message passing) ===
    const H_init = this.graphBuilder.getToolEmbeddings();
    const capabilityNodes = this.graphBuilder.getCapabilityNodes();

    if (capabilityNodes.size === 0 || !this.hierarchy || !this.multiLevelIncidence) {
      this.trainingMode = false;
      return { loss: 0, accuracy: 0, tdErrors: [], gradNorm: 0 };
    }

    // Build E_levels_init
    const E_levels_init = new Map<number, number[][]>();
    for (let level = 0; level <= maxLevel; level++) {
      const capsAtLevel = this.hierarchy.hierarchyLevels.get(level) ?? new Set<string>();
      const embeddings: number[][] = [];
      for (const capId of capsAtLevel) {
        const cap = capabilityNodes.get(capId);
        if (cap) embeddings.push([...cap.embedding]);
      }
      if (embeddings.length > 0) {
        E_levels_init.set(level, embeddings);
      }
    }

    // Build matrices
    const toolToCapMatrix = this.buildToolToCapMatrix();
    const capToCapMatrices = this.buildCapToCapMatrices();

    // Forward with cache (pass v2vParams for trainable V→V)
    const { result, cache: mpCache } = this.orchestrator.forwardMultiLevelWithCache(
      H_init,
      E_levels_init,
      toolToCapMatrix,
      capToCapMatrices,
      this.levelParams,
      {
        numHeads: this.config.numHeads,
        numLayers: this.config.numLayers,
        dropout: this.config.dropout,
        leakyReluSlope: this.config.leakyReluSlope,
      },
      this.v2vParams,
    );

    // Flatten E for K-head scoring
    const E_flat = this.flattenEmbeddingsByCapabilityOrder(result.E);

    // Build capId → embedding map for batched scoring
    const capEmbeddings = new Map<string, number[]>();
    const capIds = Array.from(capabilityNodes.keys());
    for (let i = 0; i < capIds.length; i++) {
      capEmbeddings.set(capIds[i], E_flat[i]);
    }

    // === BATCHED INTENT PROJECTION ===
    const intents = examples.map((ex) => ex.intentEmbedding);
    const intentsBatched = batchProjectIntents(intents, this.params.W_intent);

    // === BATCHED K-HEAD FORWARD ===
    const { scores: allScores, logits: allLogits, cache: kheadCache } = batchedKHeadForward(
      intents,
      this.params.W_intent,
      capEmbeddings,
      this.params.headParams,
      this.config,
    );

    // === COMPUTE LOSS AND BACKWARD ===
    const TEMPERATURE = 0.1;
    const tdErrors: number[] = [];
    let totalLoss = 0;
    let correct = 0;

    // Accumulate dCapEmbedding gradients per level
    const dE_accum = new Map<number, Map<number, number[]>>();
    for (let level = 0; level <= maxLevel; level++) {
      dE_accum.set(level, new Map());
    }

    // Accumulate dIntentsBatched for W_intent backprop
    const dIntentsBatched: number[][] = [];

    for (let exIdx = 0; exIdx < examples.length; exIdx++) {
      const example = examples[exIdx];
      const isWeight = weights[exIdx];

      // Get positive cap scores
      const posCapIdx = this.graphBuilder.getCapabilityIndex(example.candidateId);
      if (posCapIdx === undefined) {
        tdErrors.push(0);
        dIntentsBatched.push(new Array(this.config.hiddenDim).fill(0));
        continue;
      }

      const posLogit = allLogits.get(example.candidateId)?.[exIdx] ?? 0;

      if (example.negativeCapIds && example.negativeCapIds.length > 0) {
        // === CONTRASTIVE (InfoNCE) ===
        const negLogits: number[] = [];
        const negCapIndices: number[] = [];

        for (const negCapId of example.negativeCapIds) {
          const negCapIdx = this.graphBuilder.getCapabilityIndex(negCapId);
          if (negCapIdx === undefined) continue;
          negLogits.push(allLogits.get(negCapId)?.[exIdx] ?? 0);
          negCapIndices.push(negCapIdx);
        }

        // InfoNCE loss
        const allLogitsEx = [posLogit, ...negLogits];
        const scaledScores = allLogitsEx.map((s) => s / TEMPERATURE);
        const maxScore = Math.max(...scaledScores);
        const expScores = scaledScores.map((s) => Math.exp(s - maxScore));
        const sumExp = expScores.reduce((a, b) => a + b, 0);
        const softmax = expScores.map((e) => e / sumExp);

        totalLoss += -Math.log(softmax[0] + 1e-7) * isWeight;
        tdErrors.push(1 - softmax[0]);

        if (negLogits.length === 0 || posLogit > Math.max(...negLogits)) correct++;

        // === BACKWARD ===
        let dIntentAccum = new Array(this.config.hiddenDim).fill(0);

        // Positive cap gradient
        const dLossPos = (softmax[0] - 1) / TEMPERATURE * isWeight;
        for (let h = 0; h < this.config.numHeads; h++) {
          const Q = kheadCache.Q_batches[h][exIdx];
          const K = kheadCache.K_caps.get(example.candidateId)![h];
          const { dIntentsBatched: dI, dCapEmbedding: dCap } = batchedBackpropKHeadLogit(
            [dLossPos / this.config.numHeads],
            [Q],
            K,
            [intentsBatched[exIdx]],
            capEmbeddings.get(example.candidateId)!,
            this.params.headParams[h],
            grads.khead,
            h,
          );
          for (let j = 0; j < dIntentAccum.length; j++) {
            dIntentAccum[j] += dI[0]?.[j] ?? 0;
          }
          this.accumulateDCapGradient(dE_accum, posCapIdx, dCap, capIndexToLevel);
        }

        // Negative caps gradients
        for (let i = 0; i < negLogits.length; i++) {
          const dLossNeg = softmax[i + 1] / TEMPERATURE * isWeight;
          const negCapId = example.negativeCapIds![i];
          const negCapIdx = negCapIndices[i];

          for (let h = 0; h < this.config.numHeads; h++) {
            const Q = kheadCache.Q_batches[h][exIdx];
            const K = kheadCache.K_caps.get(negCapId)![h];
            const { dIntentsBatched: dI, dCapEmbedding: dCap } = batchedBackpropKHeadLogit(
              [dLossNeg / this.config.numHeads],
              [Q],
              K,
              [intentsBatched[exIdx]],
              capEmbeddings.get(negCapId)!,
              this.params.headParams[h],
              grads.khead,
              h,
            );
            for (let j = 0; j < dIntentAccum.length; j++) {
              dIntentAccum[j] += dI[0]?.[j] ?? 0;
            }
            this.accumulateDCapGradient(dE_accum, negCapIdx, dCap, capIndexToLevel);
          }
        }

        dIntentsBatched.push(dIntentAccum);
      } else {
        // === LEGACY BCE ===
        const posScore = allScores.get(example.candidateId)?.[exIdx] ?? 0.5;
        const predScore = Math.min(0.95, Math.max(0.05, posScore));
        totalLoss += math.binaryCrossEntropy(predScore, example.outcome) * isWeight;
        tdErrors.push(example.outcome - predScore);

        if ((predScore > 0.5 ? 1 : 0) === example.outcome) correct++;

        // BCE backward (simplified - just track dIntent)
        const dLossRaw = example.outcome === 1 ? -1 / (predScore + 1e-7) : 1 / (1 - predScore + 1e-7);
        const dLoss = dLossRaw * isWeight;
        let dIntentAccum = new Array(this.config.hiddenDim).fill(0);

        for (let h = 0; h < this.config.numHeads; h++) {
          const Q = kheadCache.Q_batches[h][exIdx];
          const K = kheadCache.K_caps.get(example.candidateId)![h];
          const score = allScores.get(example.candidateId)?.[exIdx] ?? 0.5;
          const scoringDim = K.length;
          const scale = Math.sqrt(scoringDim);
          const dDotQK = dLoss * score * (1 - score) / scale / this.config.numHeads;

          const dQ = K.map((k) => dDotQK * k);
          const dK = Q.map((q) => dDotQK * q);

          math.outerProductAdd(grads.khead.dW_q[h], dQ, intentsBatched[exIdx]);
          math.outerProductAdd(grads.khead.dW_k[h], dK, capEmbeddings.get(example.candidateId)!);

          const dIntent = math.matVecTransposeBlas(this.params.headParams[h].W_q, dQ);
          for (let j = 0; j < dIntentAccum.length; j++) {
            dIntentAccum[j] += dIntent[j] ?? 0;
          }

          const dCap = math.matVecTransposeBlas(this.params.headParams[h].W_k, dK);
          this.accumulateDCapGradient(dE_accum, posCapIdx, dCap, capIndexToLevel);
        }

        dIntentsBatched.push(dIntentAccum);
      }
    }

    // === BACKWARD: W_intent ===
    batchedBackpropWIntent(dIntentsBatched, intents, grads.dW_intent);

    // === BACKWARD: Multi-level message passing ===
    let mpGradNorm = 0;
    let v2vGradNorm = 0;
    if (mpCache && dE_accum.size > 0) {
      const dE_final = this.buildDEFinalFromAccum(dE_accum, mpCache);
      const mpGrads = this.orchestrator.backwardMultiLevel(
        dE_final,
        null,
        mpCache,
        this.levelParams,
        this.v2vParams,
      );

      const mpGradsConverted = this.convertMPGradsToAccumFormat(mpGrads);
      applyLevelGradients(mpGradsConverted, this.levelParams, this.config, examples.length);
      mpGradNorm = this.computeMPGradNorm(mpGrads);

      if (mpGrads.v2vGrads) {
        const lr = this.config.learningRate;
        const batchSize = examples.length;
        this.v2vParams.residualLogit -= lr * mpGrads.v2vGrads.dResidualLogit / batchSize;
        this.v2vParams.temperatureLogit -= lr * mpGrads.v2vGrads.dTemperatureLogit / batchSize;
        v2vGradNorm = Math.sqrt(
          mpGrads.v2vGrads.dResidualLogit ** 2 + mpGrads.v2vGrads.dTemperatureLogit ** 2
        );
      }
    }

    // Compute gradient norms
    const levelGradNorm = computeGradientNorm(grads);
    const kheadGradNorm = computeKHeadGradientNorm(grads.khead);
    const gradNorm = Math.sqrt(
      levelGradNorm ** 2 + kheadGradNorm ** 2 + mpGradNorm ** 2 + v2vGradNorm ** 2
    );

    // Apply gradients
    applyKHeadGradients(grads.khead, this.params.headParams, this.config, examples.length);
    applyWIntentGradients(grads, this.params.W_intent, this.config, examples.length);

    this.trainingMode = false;
    return {
      loss: totalLoss / examples.length,
      accuracy: correct / examples.length,
      tdErrors,
      gradNorm,
    };
  }

  /**
   * Accumulate dCapEmbedding gradient into per-level structure
   */
  private accumulateDCapGradient(
    dE_accum: Map<number, Map<number, number[]>>,
    capIdx: number,
    dCap: number[],
    capIndexToLevel: Map<number, { level: number; withinLevelIdx: number }>,
  ): void {
    const levelInfo = capIndexToLevel.get(capIdx);
    if (!levelInfo) return;

    const { level, withinLevelIdx } = levelInfo;
    const levelMap = dE_accum.get(level);
    if (!levelMap) return;

    const existing = levelMap.get(withinLevelIdx);
    if (existing) {
      for (let i = 0; i < dCap.length; i++) {
        existing[i] += dCap[i] ?? 0;
      }
    } else {
      levelMap.set(withinLevelIdx, [...dCap]);
    }
  }

  /**
   * Build dE_final Map from accumulated gradients
   */
  private buildDEFinalFromAccum(
    dE_accum: Map<number, Map<number, number[]>>,
    cache: MultiLevelBackwardCache,
  ): Map<number, number[][]> {
    const dE_final = new Map<number, number[][]>();

    for (const [level, withinLevelMap] of dE_accum) {
      const levelEmbs = cache.E_final.get(level);
      if (!levelEmbs) continue;

      const numCaps = levelEmbs.length;
      const embDim = levelEmbs[0]?.length ?? 0;

      // Initialize with zeros
      const dE_level: number[][] = Array.from(
        { length: numCaps },
        () => Array(embDim).fill(0),
      );

      // Fill in accumulated gradients
      for (const [withinLevelIdx, dCap] of withinLevelMap) {
        if (withinLevelIdx < numCaps) {
          for (let i = 0; i < Math.min(embDim, dCap.length); i++) {
            dE_level[withinLevelIdx][i] = dCap[i];
          }
        }
      }

      dE_final.set(level, dE_level);
    }

    return dE_final;
  }

  /**
   * Convert MultiLevelGradients to MultiLevelGradientAccumulators format
   */
  private convertMPGradsToAccumFormat(
    mpGrads: MultiLevelGradients,
  ): MultiLevelGradientAccumulators {
    const levelGradients = new Map<number, LevelGradients>();

    for (const [level, grads] of mpGrads.levelGrads) {
      levelGradients.set(level, {
        dW_child: grads.dW_child,
        dW_parent: grads.dW_parent,
        da_upward: grads.da_upward,
        da_downward: grads.da_downward,
      });
    }

    return { levelGradients };
  }

  /**
   * Compute gradient norm from MultiLevelGradients
   */
  private computeMPGradNorm(mpGrads: MultiLevelGradients): number {
    let sumSq = 0;

    for (const [_, grads] of mpGrads.levelGrads) {
      // dW_child and dW_parent
      for (const dW of [grads.dW_child, grads.dW_parent]) {
        for (const head of dW) {
          for (const row of head) {
            for (const val of row) {
              sumSq += val * val;
            }
          }
        }
      }

      // da_upward and da_downward
      for (const da of [grads.da_upward, grads.da_downward]) {
        for (const head of da) {
          for (const val of head) {
            sumSq += val * val;
          }
        }
      }
    }

    return Math.sqrt(sumSq);
  }

  // ==========================================================================
  // Serialization
  // ==========================================================================

  exportParams(): Record<string, unknown> {
    const base = exportParamsHelper(this.config, this.params);

    // PreserveDim mode: skip layerParams (deprecated V1, ~512MB unused)
    // Only levelParams + headParams are used by trainBatchV1KHead()
    if (this.config.preserveDim) {
      delete (base as Record<string, unknown>).layerParams;
    }

    // ADR-055: Also export levelParams for multi-level message passing
    const levelParamsObj: Record<string, LevelParams> = {};
    for (const [level, params] of this.levelParams) {
      levelParamsObj[level.toString()] = params;
    }

    // ADR-057: Export V2V trainable params
    return {
      ...base,
      levelParams: levelParamsObj,
      v2vParams: { ...this.v2vParams },
    };
  }

  importParams(params: Record<string, unknown>): void {
    const result = importParamsHelper(params, this.params);
    if (result.config) this.config = result.config;
    this.params = result.params;

    // ADR-055: Import levelParams for multi-level message passing
    if (params.levelParams && typeof params.levelParams === 'object') {
      const levelParamsObj = params.levelParams as Record<string, LevelParams>;
      this.levelParams = new Map();
      for (const [levelStr, lp] of Object.entries(levelParamsObj)) {
        this.levelParams.set(parseInt(levelStr), lp);
      }
    }

    // ADR-057: Import V2V trainable params
    if (params.v2vParams && typeof params.v2vParams === 'object') {
      const v2v = params.v2vParams as V2VParams;
      if (typeof v2v.residualLogit === 'number') {
        this.v2vParams.residualLogit = v2v.residualLogit;
      }
      if (typeof v2v.temperatureLogit === 'number') {
        this.v2vParams.temperatureLogit = v2v.temperatureLogit;
      }
    }
  }

  getFusionWeights(): { semantic: number; structure: number; temporal: number } {
    return computeFusionWeights(this.params.fusionWeights, this.config.headFusionWeights);
  }

  setFusionWeights(weights: Partial<FusionWeights>): void {
    if (weights.semantic !== undefined) this.params.fusionWeights.semantic = weights.semantic;
    if (weights.structure !== undefined) this.params.fusionWeights.structure = weights.structure;
    if (weights.temporal !== undefined) this.params.fusionWeights.temporal = weights.temporal;
  }

  getLearningRate(): number {
    return this.config.learningRate;
  }

  setLearningRate(lr: number): void {
    this.config.learningRate = lr;
  }

  getRegisteredToolIds(): string[] {
    return this.graphBuilder.getToolIds();
  }

  getRegisteredCapabilityIds(): string[] {
    return this.graphBuilder.getCapabilityIds();
  }

  getStats(): {
    numHeads: number;
    hiddenDim: number;
    numLayers: number;
    paramCount: number;
    v2ParamCount: number;
    registeredCapabilities: number;
    registeredTools: number;
    incidenceNonZeros: number;
    fusionWeights: { semantic: number; structure: number; temporal: number };
    mlpHiddenDim: number;
    maxContextLength: number;
  } {
    const { v1ParamCount, v2ParamCount } = countParameters(this.config);
    const incidenceStats = this.graphBuilder.getIncidenceStats();

    return {
      numHeads: this.config.numHeads,
      hiddenDim: this.config.hiddenDim,
      numLayers: this.config.numLayers,
      paramCount: v1ParamCount,
      v2ParamCount,
      registeredCapabilities: incidenceStats.numCapabilities,
      registeredTools: incidenceStats.numTools,
      incidenceNonZeros: incidenceStats.nonZeros,
      fusionWeights: this.getFusionWeights(),
      mlpHiddenDim: this.config.mlpHiddenDim,
      maxContextLength: this.config.maxContextLength,
    };
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createSHGATFromCapabilities(
  capabilities: Array<
    {
      id: string;
      embedding: number[];
      toolsUsed: string[];
      successRate: number;
      parents?: string[];
      children?: string[];
      hypergraphFeatures?: HypergraphFeatures;
    }
  >,
  configOrToolEmbeddings?: Partial<SHGATConfig> | Map<string, number[]>,
  config?: Partial<SHGATConfig>,
): SHGAT {
  let toolEmbeddings: Map<string, number[]> | undefined;
  let actualConfig: Partial<SHGATConfig> | undefined;

  if (configOrToolEmbeddings instanceof Map) {
    toolEmbeddings = configOrToolEmbeddings;
    actualConfig = config;
  } else {
    actualConfig = configOrToolEmbeddings;
  }

  // Collect all unique tools
  const allTools = new Set<string>();
  for (const cap of capabilities) for (const toolId of cap.toolsUsed) allTools.add(toolId);

  // Compute max hierarchy level from children relationships
  const hasChildren = capabilities.some((c) => c.children && c.children.length > 0);
  const maxLevel = hasChildren ? 1 : 0; // Simple heuristic, actual level computed in rebuildHierarchy

  // Get embeddingDim and preserveDim from config
  // ADR-055: preserveDim=true keeps d=1024 throughout message passing for discriminability
  const embeddingDim = capabilities[0]?.embedding.length || 1024;
  const preserveDim = actualConfig?.preserveDim ?? true;

  // Adaptive K based on graph size (ADR-053)
  // hiddenDim = numHeads * 16 (headDim fixed at 16 for consistent expressiveness)
  const adaptiveConfig = getAdaptiveHeadsByGraphSize(
    allTools.size,
    capabilities.length,
    maxLevel,
    preserveDim,
    embeddingDim,
  );

  // Merge: user config overrides adaptive, adaptive overrides defaults
  const mergedConfig: Partial<SHGATConfig> = {
    numHeads: adaptiveConfig.numHeads,
    hiddenDim: adaptiveConfig.hiddenDim,
    headDim: adaptiveConfig.headDim,
    ...actualConfig, // User config takes precedence
  };

  // Validate config consistency
  // hiddenDim = numHeads * headDim (adaptive: 4 heads→64, 8 heads→128, etc.)
  const finalHiddenDim = mergedConfig.hiddenDim ?? adaptiveConfig.hiddenDim;
  const finalNumHeads = mergedConfig.numHeads ?? adaptiveConfig.numHeads;
  const expectedHiddenDim = finalNumHeads * 16;
  if (finalHiddenDim !== expectedHiddenDim) {
    log.warn(
      `[SHGAT] hiddenDim should be numHeads * 16 = ${expectedHiddenDim}, got ${finalHiddenDim}. ` +
      `Each head needs 16 dims for full expressiveness.`
    );
  }

  const shgat = new SHGAT(mergedConfig);

  for (const toolId of allTools) {
    shgat.registerTool({
      id: toolId,
      embedding: toolEmbeddings?.get(toolId) || generateDefaultToolEmbedding(toolId, embeddingDim),
    });
  }

  for (const cap of capabilities) {
    shgat.registerCapability({
      id: cap.id,
      embedding: cap.embedding,
      members: createMembersFromLegacy(cap.toolsUsed, cap.children),
      hierarchyLevel: 0,
      toolsUsed: cap.toolsUsed,
      successRate: cap.successRate,
      parents: cap.parents,
      children: cap.children,
    });
    if (cap.hypergraphFeatures) shgat.updateHypergraphFeatures(cap.id, cap.hypergraphFeatures);
  }

  return shgat;
}

export async function trainSHGATOnEpisodes(
  shgat: SHGAT,
  episodes: TrainingExample[],
  _getEmbedding: (id: string) => number[] | null,
  options: {
    epochs?: number;
    batchSize?: number;
    onEpoch?: (epoch: number, loss: number, accuracy: number) => void;
  } = {},
): Promise<{ finalLoss: number; finalAccuracy: number }> {
  return trainOnEpisodes((batch) => shgat.trainBatch(batch), episodes, options);
}

/**
 * Train SHGAT using K-head attention scoring (trains W_q, W_k)
 *
 * Unlike trainSHGATOnEpisodes which trains the fusion weights,
 * this trains the K-head attention mechanism used in scoreAllCapabilities().
 *
 * @param shgat SHGAT instance
 * @param episodes Training examples
 * @param _getEmbedding Embedding lookup (unused, for API compatibility)
 * @param options Training options
 * @param options.epochs Number of training epochs (default: 1)
 * @param options.learningRate Learning rate (default: 0.001)
 * @param options.batchSize Batch size (default: 32)
 */
export async function trainSHGATOnEpisodesKHead(
  shgat: SHGAT,
  episodes: TrainingExample[],
  _getEmbedding: (id: string) => number[] | null,
  options: {
    epochs?: number;
    learningRate?: number;
    batchSize?: number;
    onEpoch?: (epoch: number, loss: number, accuracy: number) => void;
  } = {},
): Promise<{ finalLoss: number; finalAccuracy: number }> {
  // Apply learning rate if provided
  const originalLr = shgat.getLearningRate();
  if (options.learningRate !== undefined) {
    shgat.setLearningRate(options.learningRate);
  }

  try {
    return await trainOnEpisodes((batch) => shgat.trainBatchV1KHead(batch), episodes, options);
  } finally {
    // Restore original learning rate
    shgat.setLearningRate(originalLr);
  }
}

/**
 * Online learning: Train SHGAT V1 on a single execution result
 *
 * Uses V1 K-head architecture (message passing + K adaptive heads).
 * Trains W_q, W_k (K-head attention), levelParams, and W_intent.
 *
 * Use this in production after each capability execution.
 * No epochs to manage - just call after each execution.
 *
 * @example
 * ```typescript
 * // After successful capability execution:
 * const { loss, gradNorm } = await trainSHGATOnExecution(shgat, {
 *   intentEmbedding: userIntent,
 *   targetCapId: "executed-capability",
 *   outcome: 1, // success
 * });
 * console.log(`Trained: loss=${loss.toFixed(4)}, gradNorm=${gradNorm.toFixed(4)}`);
 *
 * // After failed capability execution:
 * await trainSHGATOnExecution(shgat, {
 *   intentEmbedding: userIntent,
 *   targetCapId: "failed-capability",
 *   outcome: 0, // failure
 * });
 * ```
 *
 * @param shgat SHGAT instance
 * @param execution Single execution result
 * @returns Training metrics (loss, accuracy, gradNorm for this single example)
 */
export async function trainSHGATOnExecution(
  shgat: SHGAT,
  execution: {
    intentEmbedding: number[];
    targetCapId: string;
    outcome: number; // 1 = success, 0 = failure
  },
): Promise<{ loss: number; accuracy: number; gradNorm: number }> {
  // Convert to TrainingExample format
  const example: TrainingExample = {
    intentEmbedding: execution.intentEmbedding,
    contextTools: [], // Will be computed from capability
    candidateId: execution.targetCapId,
    outcome: execution.outcome,
  };

  // Train on single example using V1 K-head architecture
  // This trains W_q, W_k (K-head attention) + levelParams + W_intent
  const result = shgat.trainBatchV1KHead([example]);

  return {
    loss: result.loss,
    accuracy: result.accuracy,
    gradNorm: result.gradNorm,
  };
}
