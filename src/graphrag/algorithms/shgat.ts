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
} from "./shgat/graph/index.ts";
import {
  countParameters,
  exportParams as exportParamsHelper,
  importParams as importParamsHelper,
  initializeLevelParameters,
  initializeParameters,
  initializeV2GradientAccumulators,
  resetV2GradientAccumulators,
  type SHGATParams,
  type V2GradientAccumulators,
} from "./shgat/initialization/index.ts";
import { MultiLevelOrchestrator } from "./shgat/message-passing/index.ts";
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
  backpropWIntent,
  computeKHeadGradientNorm,
  computeMultiHeadKHeadScoresWithCache,
  initMultiLevelKHeadGradients,
} from "./shgat/training/multi-level-trainer-khead.ts";
import { applyLevelGradients, computeGradientNorm } from "./shgat/training/multi-level-trainer.ts";

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

  constructor(config: Partial<SHGATConfig> = {}) {
    this.config = { ...DEFAULT_SHGAT_CONFIG, ...config };
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
    const E_flat = this.flattenEmbeddingsByCapabilityOrder(result.E);

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
          row.map((v, j) => v * (1 - alpha) + (result.H[i]?.[j] ?? v) * alpha)
        ),
      );
      E_layers.push(
        E_init.map((row, i) => row.map((v, j) => v * (1 - alpha) + (E_flat[i]?.[j] ?? v) * alpha)),
      );
    }
    H_layers.push(result.H);
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
    return { H: result.H, E: E_flat, cache };
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

  private computeMultiHeadScoresV2(features: TraceFeatures): number[] {
    const projected = this.projectFeaturesV2(features);
    return Array.from(
      { length: this.config.numHeads },
      (_, h) => this.computeHeadScoreV2(projected, h),
    );
  }

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

    return math.sigmoid(output);
  }

  scoreWithTraceFeaturesV2(features: TraceFeatures): { score: number; headScores: number[] } {
    const headScores = this.computeMultiHeadScoresV2(features);
    return { score: this.fusionMLPForward(headScores), headScores };
  }

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
   * Compute attention score for a single head (v1)
   *
   * Uses Query-Key attention:
   * - Q = W_q @ intentProjected
   * - K = W_k @ capEmbedding
   * - score = sigmoid(Q·K / √dim)
   */
  private computeHeadScoreV1(
    intentProjected: number[],
    capEmbedding: number[],
    headIdx: number,
  ): number {
    const hp = this.params.headParams[headIdx];
    const { hiddenDim } = this.config;

    // Handle dimension mismatch: W_q/W_k are [hiddenDim][hiddenDim]
    // but capEmbedding might have different dim after message passing
    const inputDim = Math.min(intentProjected.length, capEmbedding.length, hiddenDim);

    const Q = new Array(hiddenDim).fill(0);
    const K = new Array(hiddenDim).fill(0);

    for (let i = 0; i < hiddenDim; i++) {
      for (let j = 0; j < inputDim; j++) {
        Q[i] += hp.W_q[i][j] * intentProjected[j];
        K[i] += hp.W_k[i][j] * capEmbedding[j];
      }
    }

    const scale = Math.sqrt(hiddenDim);
    return math.sigmoid(math.dot(Q, K) / scale);
  }

  /**
   * Compute multi-head scores for v1
   *
   * Returns K scores, one per attention head.
   */
  private computeMultiHeadScoresV1(intentProjected: number[], capEmbedding: number[]): number[] {
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
   * 2. K-head scoring: Q = W_q @ intent, K = W_k @ E_propagated, score_h = sigmoid(Q·K/√d)
   * 3. Fusion: average of head scores (simple, no MLP)
   *
   * No TraceFeatures - pure structural similarity learned via message passing + attention.
   *
   * @param intentEmbedding - User intent embedding (1024 dim)
   * @param _contextToolIds - Unused in v1 (kept for API compatibility)
   */
  scoreAllCapabilities(intentEmbedding: number[], _contextToolIds?: string[]): AttentionResult[] {
    const { E } = this.forward();
    const results: AttentionResult[] = [];
    const { numHeads } = this.config;
    const capabilityNodes = this.graphBuilder.getCapabilityNodes();

    // Project intent to match propagated embedding dimension (1024 → hiddenDim)
    const intentProjected = this.projectIntent(intentEmbedding);

    for (const [capId, cap] of capabilityNodes) {
      const cIdx = this.graphBuilder.getCapabilityIndex(capId)!;

      // K-head attention scoring
      const headScores = this.computeMultiHeadScoresV1(intentProjected, E[cIdx]);

      // Fusion: simple average of head scores (already in [0,1] from sigmoid)
      const avgScore = headScores.reduce((a, b) => a + b, 0) / numHeads;

      // Reliability multiplier based on success rate
      const reliabilityMult = cap.successRate < 0.5 ? 0.5 : (cap.successRate > 0.9 ? 1.2 : 1.0);
      const finalScore = Math.min(0.95, Math.max(0, avgScore * reliabilityMult));

      results.push({
        capabilityId: capId,
        score: finalScore,
        headWeights: new Array(numHeads).fill(1 / numHeads),
        headScores, // K scores, one per attention head
        recursiveContribution: 0,
        // featureContributions deprecated - heads learn patterns implicitly
        toolAttention: this.getCapabilityToolAttention(cIdx),
      });
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

    // Project intent to match propagated embedding dimension (1024 → hiddenDim)
    const intentProjected = this.projectIntent(intentEmbedding);

    for (const [toolId] of toolNodes) {
      const tIdx = this.graphBuilder.getToolIndex(toolId)!;

      // K-head attention scoring (reuse same method as capabilities)
      const headScores = this.computeMultiHeadScoresV1(intentProjected, H[tIdx]);
      const avgScore = headScores.reduce((a, b) => a + b, 0) / numHeads;
      const finalScore = Math.min(0.95, Math.max(0, avgScore));

      results.push({
        toolId,
        score: finalScore,
        headScores,
      });
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
   * Train v1 with K-head scoring (trains headParams W_q, W_k)
   *
   * Unlike trainBatch() which uses cosine + fusion weights,
   * this trains the K-head attention mechanism used in scoreAllCapabilities().
   */
  trainBatchV1KHead(
    examples: TrainingExample[],
  ): { loss: number; accuracy: number; tdErrors: number[]; gradNorm: number } {
    this.trainingMode = true;
    const tdErrors: number[] = [];

    // Initialize gradients
    const grads = initMultiLevelKHeadGradients(
      this.levelParams,
      this.params.headParams,
      this.config,
    );

    let totalLoss = 0;
    let correct = 0;

    for (const example of examples) {
      // Forward pass
      const { E } = this.forward();
      const intentProjected = this.projectIntent(example.intentEmbedding);

      // Get capability index
      const capIdx = this.graphBuilder.getCapabilityIndex(example.candidateId);
      if (capIdx === undefined) {
        tdErrors.push(0);
        continue;
      }

      const capEmbedding = E[capIdx];

      // Compute K-head scores with cache for backprop
      const { scores: headScores, caches: headCaches } = computeMultiHeadKHeadScoresWithCache(
        intentProjected,
        capEmbedding,
        this.params.headParams,
        this.config,
      );

      // Average fusion
      const avgScore = headScores.reduce((a, b) => a + b, 0) / this.config.numHeads;
      const predScore = Math.min(0.95, Math.max(0.05, avgScore));

      // Loss
      const loss = math.binaryCrossEntropy(predScore, example.outcome);
      totalLoss += loss;

      // TD error
      const tdError = example.outcome - predScore;
      tdErrors.push(tdError);

      // Accuracy
      if ((predScore > 0.5 ? 1 : 0) === example.outcome) {
        correct++;
      }

      // Backward pass through K-head scoring
      // dLoss/dScore = -(y/p) + (1-y)/(1-p) for BCE
      const dLoss = example.outcome === 1 ? -1 / (predScore + 1e-7) : 1 / (1 - predScore + 1e-7);

      const { dIntentProjected } = backpropMultiHeadKHead(
        dLoss,
        headScores,
        headCaches,
        intentProjected,
        capEmbedding,
        this.params.headParams,
        grads.khead,
        this.config,
      );

      // Backprop through W_intent
      backpropWIntent(dIntentProjected, example.intentEmbedding, grads, this.config);
    }

    // Compute gradient norm before applying (for monitoring)
    const levelGradNorm = computeGradientNorm(grads);
    const kheadGradNorm = computeKHeadGradientNorm(grads.khead);
    const gradNorm = Math.sqrt(levelGradNorm ** 2 + kheadGradNorm ** 2);

    // Apply gradients
    applyLevelGradients(grads, this.levelParams, this.config, examples.length);
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

  // ==========================================================================
  // Serialization
  // ==========================================================================

  exportParams(): Record<string, unknown> {
    return exportParamsHelper(this.config, this.params);
  }

  importParams(params: Record<string, unknown>): void {
    const result = importParamsHelper(params, this.params);
    if (result.config) this.config = result.config;
    this.params = result.params;
  }

  getFusionWeights(): { semantic: number; structure: number; temporal: number } {
    return computeFusionWeights(this.params.fusionWeights, this.config.headFusionWeights);
  }

  setFusionWeights(weights: Partial<FusionWeights>): void {
    if (weights.semantic !== undefined) this.params.fusionWeights.semantic = weights.semantic;
    if (weights.structure !== undefined) this.params.fusionWeights.structure = weights.structure;
    if (weights.temporal !== undefined) this.params.fusionWeights.temporal = weights.temporal;
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

  const shgat = new SHGAT(actualConfig);
  const allTools = new Set<string>();
  for (const cap of capabilities) for (const toolId of cap.toolsUsed) allTools.add(toolId);

  const embeddingDim = capabilities[0]?.embedding.length || 1024;
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
 */
export async function trainSHGATOnEpisodesKHead(
  shgat: SHGAT,
  episodes: TrainingExample[],
  _getEmbedding: (id: string) => number[] | null,
  options: {
    epochs?: number;
    batchSize?: number;
    onEpoch?: (epoch: number, loss: number, accuracy: number) => void;
  } = {},
): Promise<{ finalLoss: number; finalAccuracy: number }> {
  return trainOnEpisodes((batch) => shgat.trainBatchV1KHead(batch), episodes, options);
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
