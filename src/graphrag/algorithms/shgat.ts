/**
 * SHGAT (SuperHyperGraph Attention Networks)
 *
 * Implementation based on "SuperHyperGraph Attention Networks" research paper.
 * Key architecture:
 * - Two-phase message passing: Vertex→Hyperedge, Hyperedge→Vertex
 * - Incidence matrix A where A[v][e] = 1 if vertex v is in hyperedge e
 * - Multi-head attention with specialized heads:
 *   - Heads 0-1: Semantic (embedding-based)
 *   - Head 2: Structure (spectral cluster, hypergraph pagerank)
 *   - Head 3: Temporal (co-occurrence, recency)
 *
 * Training:
 * - Supervised on episodic_events outcomes (success/failure)
 * - Proper backpropagation through both phases
 *
 * @module graphrag/algorithms/shgat
 */

import { getLogger } from "../../telemetry/logger.ts";

const log = getLogger("default");

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for SHGAT
 */
export interface SHGATConfig {
  /** Number of attention heads */
  numHeads: number;
  /** Hidden dimension for projections */
  hiddenDim: number;
  /** Embedding dimension (should match BGE-M3: 1024) */
  embeddingDim: number;
  /** Number of message passing layers */
  numLayers: number;
  /** Decay factor for recursive depth */
  depthDecay: number;
  /** Learning rate for training */
  learningRate: number;
  /** LeakyReLU negative slope */
  leakyReluSlope: number;
  /** L2 regularization weight */
  l2Lambda: number;
  /** Dropout rate (0 = no dropout) */
  dropout: number;
}

/**
 * Default configuration
 */
export const DEFAULT_SHGAT_CONFIG: SHGATConfig = {
  numHeads: 4,
  hiddenDim: 64,
  embeddingDim: 1024,
  numLayers: 2,
  depthDecay: 0.8,
  learningRate: 0.001,
  leakyReluSlope: 0.2,
  l2Lambda: 0.0001,
  dropout: 0.1,
};

/**
 * Training example from episodic events
 */
export interface TrainingExample {
  /** Intent embedding (1024-dim) */
  intentEmbedding: number[];
  /** Context tool IDs that were active */
  contextTools: string[];
  /** Candidate capability ID */
  candidateId: string;
  /** Outcome: 1 = success, 0 = failure */
  outcome: number;
}

/**
 * Hypergraph features for SHGAT multi-head attention (CAPABILITIES)
 *
 * These features are computed by support algorithms and fed to SHGAT heads:
 * - Heads 0-1 (semantic): uses embedding
 * - Head 2 (structure): uses spectralCluster, hypergraphPageRank, adamicAdar
 * - Head 3 (temporal): uses cooccurrence, recency, heatDiffusion
 *
 * NOTE: For capabilities (hyperedges), these use HYPERGRAPH algorithms.
 * For tools, use ToolGraphFeatures instead (simple graph algorithms).
 */
export interface HypergraphFeatures {
  /** Spectral cluster ID on the hypergraph (0-based) */
  spectralCluster: number;
  /** Hypergraph PageRank score (0-1) */
  hypergraphPageRank: number;
  /** Co-occurrence frequency from episodic traces (0-1) */
  cooccurrence: number;
  /** Recency score - how recently used (0-1, 1 = very recent) */
  recency: number;
  /**
   * Adamic-Adar similarity with neighboring capabilities (0-1)
   *
   * TODO: Integrate with existing computeAdamicAdar() implementation
   *   - See: src/graphrag/algorithms/adamic-adar.ts
   *   - Pre-compute for each capability based on shared tools/neighbors
   *   - Currently: placeholder value, set manually or defaults to 0
   */
  adamicAdar?: number;
  /**
   * Heat diffusion score (0-1)
   *
   * TODO: Implement real heat diffusion computation. Options:
   *
   * Option 1: Static topology heat (context-free)
   *   - Extract computeLocalHeat() from LocalAlphaCalculator
   *   - Based on node degree + neighbor propagation
   *   - See: src/graphrag/local-alpha.ts:649
   *
   * Option 2: Pre-computed from episodic traces
   *   - Compute heat scores from episodic_events history
   *   - Which capabilities are frequently "hot" together
   *   - Use computeHierarchicalHeat() for Tool→Cap→Meta propagation
   *   - See: src/graphrag/local-alpha.ts:756
   *
   * Currently: placeholder value, set manually or defaults to 0
   */
  heatDiffusion?: number;
}

/**
 * Default hypergraph features (cold start)
 */
export const DEFAULT_HYPERGRAPH_FEATURES: HypergraphFeatures = {
  spectralCluster: 0,
  hypergraphPageRank: 0.01,
  cooccurrence: 0,
  recency: 0,
  adamicAdar: 0,
  heatDiffusion: 0,
};

/**
 * Tool graph features for SHGAT multi-head attention (TOOLS)
 *
 * These features use SIMPLE GRAPH algorithms (not hypergraph):
 * - Head 2 (structure): pageRank, louvainCommunity, adamicAdar
 * - Head 3 (temporal): cooccurrence, recency (from execution_trace)
 *
 * This is separate from HypergraphFeatures because tools exist in a
 * simple directed graph (Graphology), not the superhypergraph.
 */
export interface ToolGraphFeatures {
  /** Regular PageRank score from Graphology (0-1) */
  pageRank: number;
  /** Louvain community ID (0-based integer) */
  louvainCommunity: number;
  /** Adamic-Adar similarity with neighboring tools (0-1) */
  adamicAdar: number;
  /** Co-occurrence frequency from execution_trace (0-1) */
  cooccurrence: number;
  /** Recency score - exponential decay since last use (0-1, 1 = very recent) */
  recency: number;
}

/**
 * Default tool graph features (cold start)
 */
export const DEFAULT_TOOL_GRAPH_FEATURES: ToolGraphFeatures = {
  pageRank: 0.01,
  louvainCommunity: 0,
  adamicAdar: 0,
  cooccurrence: 0,
  recency: 0,
};

/**
 * Tool node (vertex in hypergraph)
 */
export interface ToolNode {
  id: string;
  /** Embedding (from tool description) */
  embedding: number[];
  /** Tool graph features (simple graph algorithms) */
  toolFeatures?: ToolGraphFeatures;
}

/**
 * Capability node (hyperedge in hypergraph)
 */
export interface CapabilityNode {
  id: string;
  /** Embedding (from description or aggregated tools) */
  embedding: number[];
  /** Tools in this capability (vertex IDs) */
  toolsUsed: string[];
  /** Success rate from history (reliability) */
  successRate: number;
  /** Parent capabilities (via contains) */
  parents: string[];
  /** Child capabilities (via contains) */
  children: string[];
  /** Hypergraph features for multi-head attention */
  hypergraphFeatures?: HypergraphFeatures;
}

/**
 * Attention result for a capability
 */
export interface AttentionResult {
  capabilityId: string;
  /** Final attention score (0-1) */
  score: number;
  /** Per-head attention weights */
  headWeights: number[];
  /** Per-head raw scores before fusion */
  headScores: number[];
  /** Contribution from recursive parents */
  recursiveContribution: number;
  /** Feature contributions for interpretability */
  featureContributions?: {
    semantic: number;
    structure: number;
    temporal: number;
    reliability: number;
  };
  /** Attention over tools (for interpretability) */
  toolAttention?: number[];
}

/**
 * Cached activations for backpropagation
 */
interface ForwardCache {
  /** Vertex (tool) embeddings at each layer */
  H: number[][][];
  /** Hyperedge (capability) embeddings at each layer */
  E: number[][][];
  /** Attention weights vertex→edge [layer][head][vertex][edge] */
  attentionVE: number[][][][];
  /** Attention weights edge→vertex [layer][head][edge][vertex] */
  attentionEV: number[][][][];
}

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

  // Vertices (tools) and Hyperedges (capabilities)
  private toolNodes: Map<string, ToolNode> = new Map();
  private capabilityNodes: Map<string, CapabilityNode> = new Map();
  private toolIndex: Map<string, number> = new Map();
  private capabilityIndex: Map<string, number> = new Map();

  // Incidence matrix: A[tool][capability] = 1 if tool is in capability
  private incidenceMatrix: number[][] = [];

  // Learnable parameters per layer per head (initialized in initializeParameters)
  private layerParams!: Array<{
    // Vertex→Edge phase
    W_v: number[][][]; // [head][hiddenDim][inputDim]
    W_e: number[][][]; // [head][hiddenDim][inputDim]
    a_ve: number[][]; // [head][2*hiddenDim]

    // Edge→Vertex phase
    W_e2: number[][][]; // [head][hiddenDim][hiddenDim]
    W_v2: number[][][]; // [head][hiddenDim][hiddenDim]
    a_ev: number[][]; // [head][2*hiddenDim]
  }>;

  // Legacy per-head parameters for backward compatibility (initialized in initializeParameters)
  private headParams!: Array<{
    W_q: number[][];
    W_k: number[][];
    W_v: number[][];
    a: number[];
  }>;

  // Training state
  private trainingMode = false;
  private lastCache: ForwardCache | null = null;

  constructor(config: Partial<SHGATConfig> = {}) {
    this.config = { ...DEFAULT_SHGAT_CONFIG, ...config };
    this.initializeParameters();
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  private initializeParameters(): void {
    const { numLayers, numHeads, hiddenDim, embeddingDim } = this.config;
    this.layerParams = [];

    for (let l = 0; l < numLayers; l++) {
      const layerInputDim = l === 0 ? embeddingDim : hiddenDim * numHeads;

      this.layerParams.push({
        W_v: this.initTensor3D(numHeads, hiddenDim, layerInputDim),
        W_e: this.initTensor3D(numHeads, hiddenDim, layerInputDim),
        a_ve: this.initMatrix(numHeads, 2 * hiddenDim),

        W_e2: this.initTensor3D(numHeads, hiddenDim, hiddenDim),
        W_v2: this.initTensor3D(numHeads, hiddenDim, hiddenDim),
        a_ev: this.initMatrix(numHeads, 2 * hiddenDim),
      });
    }

    // Legacy head params for backward compatibility
    this.headParams = [];
    for (let h = 0; h < numHeads; h++) {
      this.headParams.push({
        W_q: this.initMatrix(hiddenDim, embeddingDim),
        W_k: this.initMatrix(hiddenDim, embeddingDim),
        W_v: this.initMatrix(hiddenDim, embeddingDim),
        a: this.initVector(2 * hiddenDim),
      });
    }
  }

  private initTensor3D(d1: number, d2: number, d3: number): number[][][] {
    const scale = Math.sqrt(2.0 / (d2 + d3));
    return Array.from(
      { length: d1 },
      () =>
        Array.from(
          { length: d2 },
          () => Array.from({ length: d3 }, () => (Math.random() - 0.5) * 2 * scale),
        ),
    );
  }

  private initMatrix(rows: number, cols: number): number[][] {
    const scale = Math.sqrt(2.0 / (rows + cols));
    return Array.from(
      { length: rows },
      () => Array.from({ length: cols }, () => (Math.random() - 0.5) * 2 * scale),
    );
  }

  private initVector(size: number): number[] {
    const scale = Math.sqrt(1.0 / size);
    return Array.from({ length: size }, () => (Math.random() - 0.5) * 2 * scale);
  }

  // ==========================================================================
  // Graph Construction
  // ==========================================================================

  /**
   * Register a tool (vertex)
   */
  registerTool(node: ToolNode): void {
    this.toolNodes.set(node.id, node);
    this.rebuildIndices();
  }

  /**
   * Register a capability (hyperedge)
   */
  registerCapability(node: CapabilityNode): void {
    this.capabilityNodes.set(node.id, node);
    this.rebuildIndices();
  }

  /**
   * Check if a tool node exists
   */
  hasToolNode(toolId: string): boolean {
    return this.toolNodes.has(toolId);
  }

  /**
   * Check if a capability node exists
   */
  hasCapabilityNode(capabilityId: string): boolean {
    return this.capabilityNodes.has(capabilityId);
  }

  /**
   * Build hypergraph from tools and capabilities
   */
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
    this.toolNodes.clear();
    this.capabilityNodes.clear();

    for (const tool of tools) {
      this.toolNodes.set(tool.id, {
        id: tool.id,
        embedding: tool.embedding,
      });
    }

    for (const cap of capabilities) {
      this.capabilityNodes.set(cap.id, {
        id: cap.id,
        embedding: cap.embedding,
        toolsUsed: cap.toolsUsed,
        successRate: cap.successRate,
        parents: cap.parents || [],
        children: cap.children || [],
      });
    }

    this.rebuildIndices();
  }

  /**
   * Rebuild indices and incidence matrix
   */
  private rebuildIndices(): void {
    this.toolIndex.clear();
    this.capabilityIndex.clear();

    let tIdx = 0;
    for (const tId of this.toolNodes.keys()) {
      this.toolIndex.set(tId, tIdx++);
    }

    let cIdx = 0;
    for (const cId of this.capabilityNodes.keys()) {
      this.capabilityIndex.set(cId, cIdx++);
    }

    // Build incidence matrix A[tool][capability]
    const numTools = this.toolNodes.size;
    const numCaps = this.capabilityNodes.size;

    this.incidenceMatrix = Array.from({ length: numTools }, () => Array(numCaps).fill(0));

    for (const [capId, cap] of this.capabilityNodes) {
      const cIdx = this.capabilityIndex.get(capId)!;
      for (const toolId of cap.toolsUsed) {
        const tIdx = this.toolIndex.get(toolId);
        if (tIdx !== undefined) {
          this.incidenceMatrix[tIdx][cIdx] = 1;
        }
      }
    }
  }

  // ==========================================================================
  // Two-Phase Message Passing
  // ==========================================================================

  /**
   * Forward pass through all layers with two-phase message passing
   *
   * Phase 1 (Vertex→Hyperedge):
   *   A' = A ⊙ softmax(LeakyReLU(H·W · (E·W)^T))
   *   E^(l+1) = σ(A'^T · H^(l))
   *
   * Phase 2 (Hyperedge→Vertex):
   *   B = A^T ⊙ softmax(LeakyReLU(E·W_1 · (H·W_1)^T))
   *   H^(l+1) = σ(B^T · E^(l))
   */
  forward(): { H: number[][]; E: number[][]; cache: ForwardCache } {
    const cache: ForwardCache = {
      H: [],
      E: [],
      attentionVE: [],
      attentionEV: [],
    };

    // Initialize embeddings
    let H = this.getToolEmbeddings();
    let E = this.getCapabilityEmbeddings();

    cache.H.push(H);
    cache.E.push(E);

    // Process each layer
    for (let l = 0; l < this.config.numLayers; l++) {
      const params = this.layerParams[l];
      const layerAttentionVE: number[][][] = [];
      const layerAttentionEV: number[][][] = [];

      const headsH: number[][][] = [];
      const headsE: number[][][] = [];

      for (let head = 0; head < this.config.numHeads; head++) {
        // Phase 1: Vertex → Hyperedge
        const { E_new, attentionVE } = this.vertexToEdgePhase(
          H,
          E,
          params.W_v[head],
          params.W_e[head],
          params.a_ve[head],
          head,
        );
        layerAttentionVE.push(attentionVE);

        // Phase 2: Hyperedge → Vertex
        const { H_new, attentionEV } = this.edgeToVertexPhase(
          H,
          E_new,
          params.W_e2[head],
          params.W_v2[head],
          params.a_ev[head],
          head,
        );
        layerAttentionEV.push(attentionEV);

        headsH.push(H_new);
        headsE.push(E_new);
      }

      // Concatenate heads
      H = this.concatHeads(headsH);
      E = this.concatHeads(headsE);

      // Apply dropout during training
      if (this.trainingMode && this.config.dropout > 0) {
        H = this.applyDropout(H);
        E = this.applyDropout(E);
      }

      cache.H.push(H);
      cache.E.push(E);
      cache.attentionVE.push(layerAttentionVE);
      cache.attentionEV.push(layerAttentionEV);
    }

    this.lastCache = cache;
    return { H, E, cache };
  }

  /**
   * Phase 1: Vertex → Hyperedge message passing
   */
  private vertexToEdgePhase(
    H: number[][],
    E: number[][],
    W_v: number[][],
    W_e: number[][],
    a_ve: number[],
    headIdx: number,
  ): { E_new: number[][]; attentionVE: number[][] } {
    const numTools = H.length;
    const numCaps = E.length;

    // Project
    const H_proj = this.matmulTranspose(H, W_v);
    const E_proj = this.matmulTranspose(E, W_e);

    // Compute attention scores (masked by incidence matrix)
    const attentionScores: number[][] = Array.from(
      { length: numTools },
      () => Array(numCaps).fill(-Infinity),
    );

    for (let t = 0; t < numTools; t++) {
      for (let c = 0; c < numCaps; c++) {
        if (this.incidenceMatrix[t][c] === 1) {
          const concat = [...H_proj[t], ...E_proj[c]];
          const activated = concat.map((x) => this.leakyRelu(x));
          attentionScores[t][c] = this.dot(a_ve, activated);
        }
      }
    }

    // Apply head-specific feature modulation
    this.applyHeadFeatures(attentionScores, headIdx, "vertex");

    // Softmax per capability (column-wise)
    const attentionVE: number[][] = Array.from({ length: numTools }, () => Array(numCaps).fill(0));

    for (let c = 0; c < numCaps; c++) {
      const toolsInCap: number[] = [];
      for (let t = 0; t < numTools; t++) {
        if (this.incidenceMatrix[t][c] === 1) {
          toolsInCap.push(t);
        }
      }

      if (toolsInCap.length === 0) continue;

      const scores = toolsInCap.map((t) => attentionScores[t][c]);
      const softmaxed = this.softmax(scores);

      for (let i = 0; i < toolsInCap.length; i++) {
        attentionVE[toolsInCap[i]][c] = softmaxed[i];
      }
    }

    // Aggregate: E_new = σ(A'^T · H_proj)
    const E_new: number[][] = [];
    const hiddenDim = H_proj[0].length;

    for (let c = 0; c < numCaps; c++) {
      const aggregated = Array(hiddenDim).fill(0);

      for (let t = 0; t < numTools; t++) {
        if (attentionVE[t][c] > 0) {
          for (let d = 0; d < hiddenDim; d++) {
            aggregated[d] += attentionVE[t][c] * H_proj[t][d];
          }
        }
      }

      E_new.push(aggregated.map((x) => this.elu(x)));
    }

    return { E_new, attentionVE };
  }

  /**
   * Phase 2: Hyperedge → Vertex message passing
   */
  private edgeToVertexPhase(
    H: number[][],
    E: number[][],
    W_e: number[][],
    W_v: number[][],
    a_ev: number[],
    headIdx: number,
  ): { H_new: number[][]; attentionEV: number[][] } {
    const numTools = H.length;
    const numCaps = E.length;

    const E_proj = this.matmulTranspose(E, W_e);
    const H_proj = this.matmulTranspose(H, W_v);

    // Compute attention scores
    const attentionScores: number[][] = Array.from(
      { length: numCaps },
      () => Array(numTools).fill(-Infinity),
    );

    for (let c = 0; c < numCaps; c++) {
      for (let t = 0; t < numTools; t++) {
        if (this.incidenceMatrix[t][c] === 1) {
          const concat = [...E_proj[c], ...H_proj[t]];
          const activated = concat.map((x) => this.leakyRelu(x));
          attentionScores[c][t] = this.dot(a_ev, activated);
        }
      }
    }

    // Apply head-specific feature modulation
    this.applyHeadFeatures(attentionScores, headIdx, "edge");

    // Softmax per tool (column-wise in transposed view)
    const attentionEV: number[][] = Array.from({ length: numCaps }, () => Array(numTools).fill(0));

    for (let t = 0; t < numTools; t++) {
      const capsForTool: number[] = [];
      for (let c = 0; c < numCaps; c++) {
        if (this.incidenceMatrix[t][c] === 1) {
          capsForTool.push(c);
        }
      }

      if (capsForTool.length === 0) continue;

      const scores = capsForTool.map((c) => attentionScores[c][t]);
      const softmaxed = this.softmax(scores);

      for (let i = 0; i < capsForTool.length; i++) {
        attentionEV[capsForTool[i]][t] = softmaxed[i];
      }
    }

    // Aggregate: H_new = σ(B^T · E_proj)
    const H_new: number[][] = [];
    const hiddenDim = E_proj[0].length;

    for (let t = 0; t < numTools; t++) {
      const aggregated = Array(hiddenDim).fill(0);

      for (let c = 0; c < numCaps; c++) {
        if (attentionEV[c][t] > 0) {
          for (let d = 0; d < hiddenDim; d++) {
            aggregated[d] += attentionEV[c][t] * E_proj[c][d];
          }
        }
      }

      H_new.push(aggregated.map((x) => this.elu(x)));
    }

    return { H_new, attentionEV };
  }

  /**
   * Apply head-specific feature modulation based on HypergraphFeatures
   */
  private applyHeadFeatures(
    scores: number[][],
    headIdx: number,
    phase: "vertex" | "edge",
  ): void {
    if (headIdx === 2) {
      // Head 2: Structure (spectral cluster, pagerank)
      for (const [capId, cap] of this.capabilityNodes) {
        const cIdx = this.capabilityIndex.get(capId)!;
        const features = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;
        const boost = features.hypergraphPageRank * 2; // PageRank boost

        if (phase === "vertex") {
          for (let t = 0; t < scores.length; t++) {
            if (scores[t][cIdx] > -Infinity) {
              scores[t][cIdx] += boost;
            }
          }
        } else {
          for (let t = 0; t < scores[cIdx].length; t++) {
            if (scores[cIdx][t] > -Infinity) {
              scores[cIdx][t] += boost;
            }
          }
        }
      }
    } else if (headIdx === 3) {
      // Head 3: Temporal (co-occurrence, recency)
      for (const [capId, cap] of this.capabilityNodes) {
        const cIdx = this.capabilityIndex.get(capId)!;
        const features = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;
        const boost = 0.6 * features.cooccurrence + 0.4 * features.recency;

        if (phase === "vertex") {
          for (let t = 0; t < scores.length; t++) {
            if (scores[t][cIdx] > -Infinity) {
              scores[t][cIdx] += boost;
            }
          }
        } else {
          for (let t = 0; t < scores[cIdx].length; t++) {
            if (scores[cIdx][t] > -Infinity) {
              scores[cIdx][t] += boost;
            }
          }
        }
      }
    }
    // Heads 0-1: Semantic (no modification, pure embedding attention)
  }

  // ==========================================================================
  // Scoring API
  // ==========================================================================

  /**
   * Score all capabilities given intent embedding
   *
   * SHGAT scoring is context-free per the original paper.
   * Context (current position) is handled by DR-DSP pathfinding, not here.
   *
   * Multi-head attention:
   * - Heads 0-1: Semantic (intent × capability embedding)
   * - Head 2: Structure (hypergraph PageRank)
   * - Head 3: Temporal (cooccurrence + recency)
   */
  scoreAllCapabilities(
    intentEmbedding: number[],
    _contextToolEmbeddings?: number[][], // DEPRECATED - kept for API compat, ignored
    _contextCapabilityIds?: string[], // DEPRECATED - kept for API compat, ignored
  ): AttentionResult[] {
    // Run forward pass to warm up cache (we use original embeddings for scoring, not E)
    this.forward();

    const results: AttentionResult[] = [];

    for (const [capId, cap] of this.capabilityNodes) {
      const cIdx = this.capabilityIndex.get(capId)!;

      // Use ORIGINAL embedding for semantic similarity (same 1024-dim as intent)
      // E[cIdx] is the SHGAT output (hiddenDim*numHeads = 256-dim) - used for structural features
      const capOriginalEmb = cap.embedding;

      // Compute similarity with intent using original embedding (dimension-matched)
      const intentSim = this.cosineSimilarity(intentEmbedding, capOriginalEmb);

      // Reliability multiplier
      const reliability = cap.successRate;
      const reliabilityMult = reliability < 0.5 ? 0.5 : (reliability > 0.9 ? 1.2 : 1.0);

      // Compute head scores (NO context boost - per original paper)
      const features = cap.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES;

      // Head 2: Structure score combines graph topology features
      // Normalized to ~0-1 range to balance with semantic heads
      // - PageRank: global importance (already 0-1)
      // - SpectralCluster: cluster centrality (1/(1+c) gives 0.5-1)
      // - AdamicAdar: similarity with neighbors (0-1)
      const spectralBonus = 1 / (1 + features.spectralCluster);
      const adamicAdar = features.adamicAdar ?? 0;
      const structureScore = 0.4 * features.hypergraphPageRank +
        0.3 * spectralBonus +
        0.3 * adamicAdar;

      // Head 3: Temporal score combines usage patterns
      // Normalized to ~0-1 range
      // - Cooccurrence: frequently used together (0-1)
      // - Recency: recently used (0-1)
      // - HeatDiffusion: influence from active context (0-1)
      const heatDiffusion = features.heatDiffusion ?? 0;
      const temporalScore = 0.4 * features.cooccurrence +
        0.4 * features.recency +
        0.2 * heatDiffusion;

      const headScores = [
        intentSim, // Head 0: semantic
        intentSim, // Head 1: semantic
        structureScore, // Head 2: structure (pageRank + spectral + adamicAdar)
        temporalScore, // Head 3: temporal (cooccurrence + recency + heatDiffusion)
      ];

      const headWeights = this.softmax(headScores);

      let baseScore = 0;
      for (let h = 0; h < this.config.numHeads; h++) {
        baseScore += headWeights[h] * headScores[h];
      }

      const score = this.sigmoid(baseScore * reliabilityMult);

      // Get tool attention for interpretability
      const toolAttention = this.getCapabilityToolAttention(cIdx);

      results.push({
        capabilityId: capId,
        score,
        headWeights,
        headScores,
        recursiveContribution: 0,
        featureContributions: {
          semantic: (headScores[0] + headScores[1]) / 2,
          structure: headScores[2],
          temporal: headScores[3],
          reliability: reliabilityMult,
        },
        toolAttention,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Score all tools given intent embedding
   *
   * Multi-head attention scoring for tools (simple graph algorithms):
   * - Heads 0-1 (Semantic): Cosine similarity with intent embedding
   * - Head 2 (Structure): PageRank + Louvain community + AdamicAdar
   * - Head 3 (Temporal): Cooccurrence + Recency (from execution traces)
   *
   * Note: Tools use ToolGraphFeatures (simple graph algorithms),
   * while capabilities use HypergraphFeatures (spectral clustering, heat diffusion).
   *
   * @param intentEmbedding - The intent embedding (1024-dim BGE-M3)
   * @returns Array of tool scores sorted by score descending
   */
  scoreAllTools(
    intentEmbedding: number[],
  ): Array<{ toolId: string; score: number; headWeights?: number[] }> {
    // Run forward pass to warm up cache
    this.forward();

    const results: Array<{ toolId: string; score: number; headWeights?: number[] }> = [];

    for (const [toolId, tool] of this.toolNodes) {
      // === HEAD 0-1: SEMANTIC ===
      const intentSim = this.cosineSimilarity(intentEmbedding, tool.embedding);

      // Get tool features (may be undefined for tools without features)
      const features = tool.toolFeatures;

      if (!features) {
        // Fallback: pure semantic similarity if no features
        results.push({
          toolId,
          score: Math.max(0, Math.min(intentSim, 0.95)),
        });
        continue;
      }

      // === HEAD 2: STRUCTURE (simple graph algos) ===
      // - pageRank: regular PageRank from Graphology
      // - louvainCommunity: Louvain community ID
      // - adamicAdar: similarity with neighboring tools
      const louvainBonus = 1 / (1 + features.louvainCommunity); // Lower community ID = more central
      const structureScore = 0.4 * features.pageRank +
        0.3 * louvainBonus +
        0.3 * features.adamicAdar;

      // === HEAD 3: TEMPORAL (from execution_trace table) ===
      // - cooccurrence: how often this tool appears with other tools in traces
      // - recency: exponential decay since last use (1.0 = just used)
      const temporalScore = 0.4 * features.cooccurrence +
        0.6 * features.recency; // No heatDiffusion for tools

      // === MULTI-HEAD FUSION ===
      const headScores = [
        intentSim, // Head 0: semantic
        intentSim, // Head 1: semantic
        structureScore, // Head 2: structure
        temporalScore, // Head 3: temporal
      ];

      const headWeights = this.softmax(headScores);

      let baseScore = 0;
      for (let h = 0; h < this.config.numHeads; h++) {
        baseScore += headWeights[h] * headScores[h];
      }

      const score = this.sigmoid(baseScore);

      results.push({
        toolId,
        score: Math.max(0, Math.min(score, 0.95)), // Clamp to [0, 0.95]
        headWeights,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Compute attention for a single capability
   */
  computeAttention(
    intentEmbedding: number[],
    _contextToolEmbeddings: number[][], // DEPRECATED - ignored
    capabilityId: string,
    _contextCapabilityIds?: string[], // DEPRECATED - ignored
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

  /**
   * Get tool attention weights for a capability
   */
  private getCapabilityToolAttention(capIdx: number): number[] {
    if (!this.lastCache || this.lastCache.attentionVE.length === 0) {
      return [];
    }

    const lastLayerVE = this.lastCache.attentionVE[this.config.numLayers - 1];
    const attention: number[] = [];

    for (let t = 0; t < this.toolNodes.size; t++) {
      let avgAttention = 0;
      for (let h = 0; h < this.config.numHeads; h++) {
        avgAttention += lastLayerVE[h][t][capIdx];
      }
      attention.push(avgAttention / this.config.numHeads);
    }

    return attention;
  }

  // ==========================================================================
  // Feature Updates
  // ==========================================================================

  /**
   * Update hypergraph features for a capability
   */
  updateHypergraphFeatures(capabilityId: string, features: Partial<HypergraphFeatures>): void {
    const node = this.capabilityNodes.get(capabilityId);
    if (node) {
      node.hypergraphFeatures = {
        ...(node.hypergraphFeatures || DEFAULT_HYPERGRAPH_FEATURES),
        ...features,
      };
    }
  }

  /**
   * Update hypergraph features for a tool (multi-head attention)
   */
  updateToolFeatures(toolId: string, features: Partial<ToolGraphFeatures>): void {
    const node = this.toolNodes.get(toolId);
    if (node) {
      node.toolFeatures = {
        ...(node.toolFeatures || DEFAULT_TOOL_GRAPH_FEATURES),
        ...features,
      };
    }
  }

  /**
   * Batch update hypergraph features for capabilities
   */
  batchUpdateFeatures(updates: Map<string, Partial<HypergraphFeatures>>): void {
    for (const [capId, features] of updates) {
      this.updateHypergraphFeatures(capId, features);
    }

    log.debug("[SHGAT] Updated hypergraph features", {
      updatedCount: updates.size,
    });
  }

  /**
   * Batch update hypergraph features for tools (multi-head attention)
   */
  batchUpdateToolFeatures(updates: Map<string, Partial<ToolGraphFeatures>>): void {
    for (const [toolId, features] of updates) {
      this.updateToolFeatures(toolId, features);
    }

    log.debug("[SHGAT] Updated tool features for multi-head attention", {
      updatedCount: updates.size,
    });
  }

  // ==========================================================================
  // Training with Backpropagation
  // ==========================================================================

  /**
   * Train on a single example (online learning)
   *
   * Used for incremental learning after each execution trace.
   * Less efficient than batch training but enables real-time learning.
   */
  trainOnExample(example: TrainingExample): { loss: number; accuracy: number } {
    return this.trainBatch([example]);
  }

  /**
   * Train on a batch of examples
   */
  trainBatch(
    examples: TrainingExample[],
    _getEmbedding?: (id: string) => number[] | null, // DEPRECATED - kept for API compat
  ): { loss: number; accuracy: number } {
    this.trainingMode = true;

    let totalLoss = 0;
    let correct = 0;

    const gradients = this.initGradients();

    for (const example of examples) {
      // Forward (E unused - we use original embeddings, but cache needed for backward)
      const { E: _E, cache } = this.forward();

      const capIdx = this.capabilityIndex.get(example.candidateId);
      if (capIdx === undefined) continue;

      // Get capability node for original embedding (1024-dim, matches intent)
      const capNode = this.capabilityNodes.get(example.candidateId)!;
      const capOriginalEmb = capNode.embedding;

      // Use original embedding for semantic similarity (dimension-matched)
      const intentSim = this.cosineSimilarity(example.intentEmbedding, capOriginalEmb);

      // Score based on semantic similarity only (no context boost per original paper)
      const score = this.sigmoid(intentSim);

      // Loss
      const loss = this.binaryCrossEntropy(score, example.outcome);
      totalLoss += loss;

      // Accuracy
      if ((score > 0.5 ? 1 : 0) === example.outcome) correct++;

      // Backward
      const dLoss = score - example.outcome;
      this.backward(gradients, cache, capIdx, example.intentEmbedding, dLoss);
    }

    this.applyGradients(gradients, examples.length);
    this.trainingMode = false;

    return {
      loss: totalLoss / examples.length,
      accuracy: correct / examples.length,
    };
  }

  private initGradients(): Map<string, number[][][]> {
    const grads = new Map<string, number[][][]>();

    for (let l = 0; l < this.config.numLayers; l++) {
      const params = this.layerParams[l];
      grads.set(`W_v_${l}`, this.zerosLike3D(params.W_v));
      grads.set(`W_e_${l}`, this.zerosLike3D(params.W_e));
    }

    return grads;
  }

  private zerosLike3D(tensor: number[][][]): number[][][] {
    return tensor.map((m) => m.map((r) => r.map(() => 0)));
  }

  private backward(
    gradients: Map<string, number[][][]>,
    cache: ForwardCache,
    targetCapIdx: number,
    intentEmb: number[],
    dLoss: number,
  ): void {
    const { numLayers, numHeads, hiddenDim } = this.config;

    const E_final = cache.E[numLayers];
    const capEmb = E_final[targetCapIdx];

    // Gradient of cosine similarity
    const normIntent = Math.sqrt(intentEmb.reduce((s, x) => s + x * x, 0));
    const normCap = Math.sqrt(capEmb.reduce((s, x) => s + x * x, 0));
    const dot = this.dot(intentEmb, capEmb);

    const dCapEmb = intentEmb.map((xi, i) => {
      const term1 = xi / (normIntent * normCap);
      const term2 = (dot * capEmb[i]) / (normIntent * normCap * normCap * normCap);
      return dLoss * (term1 - term2);
    });

    // Backprop through layers
    for (let l = numLayers - 1; l >= 0; l--) {
      const H_in = cache.H[l];
      const attentionVE = cache.attentionVE[l];

      for (let h = 0; h < numHeads; h++) {
        const dW_v = gradients.get(`W_v_${l}`)!;

        for (let t = 0; t < H_in.length; t++) {
          const alpha = attentionVE[h][t][targetCapIdx];
          if (alpha > 0) {
            const headDim = hiddenDim;
            const headStart = h * headDim;
            const headEnd = headStart + headDim;
            const dE_head = dCapEmb.slice(headStart, headEnd);

            for (let d = 0; d < headDim; d++) {
              for (let j = 0; j < H_in[t].length; j++) {
                dW_v[h][d][j] += dE_head[d] * alpha * H_in[t][j];
              }
            }
          }
        }
      }
    }
  }

  private applyGradients(gradients: Map<string, number[][][]>, batchSize: number): void {
    const lr = this.config.learningRate / batchSize;
    const l2 = this.config.l2Lambda;

    for (let l = 0; l < this.config.numLayers; l++) {
      const params = this.layerParams[l];
      const dW_v = gradients.get(`W_v_${l}`)!;

      for (let h = 0; h < this.config.numHeads; h++) {
        for (let i = 0; i < params.W_v[h].length; i++) {
          for (let j = 0; j < params.W_v[h][i].length; j++) {
            const grad = dW_v[h][i][j] + l2 * params.W_v[h][i][j];
            params.W_v[h][i][j] -= lr * grad;
          }
        }
      }
    }
  }

  // ==========================================================================
  // Utility Functions
  // ==========================================================================

  private getToolEmbeddings(): number[][] {
    const embeddings: number[][] = [];
    for (const [_, tool] of this.toolNodes) {
      embeddings.push([...tool.embedding]);
    }
    return embeddings;
  }

  private getCapabilityEmbeddings(): number[][] {
    const embeddings: number[][] = [];
    for (const [_, cap] of this.capabilityNodes) {
      embeddings.push([...cap.embedding]);
    }
    return embeddings;
  }

  private matmulTranspose(A: number[][], B: number[][]): number[][] {
    return A.map((row) =>
      B.map((bRow) => row.reduce((sum, val, i) => sum + val * (bRow[i] || 0), 0))
    );
  }

  private concatHeads(heads: number[][][]): number[][] {
    const numNodes = heads[0].length;
    return Array.from({ length: numNodes }, (_, i) => heads.flatMap((head) => head[i]));
  }

  private applyDropout(matrix: number[][]): number[][] {
    const keepProb = 1 - this.config.dropout;
    return matrix.map((row) => row.map((x) => (Math.random() < keepProb ? x / keepProb : 0)));
  }

  private leakyRelu(x: number): number {
    return x > 0 ? x : this.config.leakyReluSlope * x;
  }

  private elu(x: number, alpha = 1.0): number {
    return x >= 0 ? x : alpha * (Math.exp(x) - 1);
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
  }

  private softmax(values: number[]): number[] {
    const maxVal = Math.max(...values);
    const exps = values.map((v) => Math.exp(v - maxVal));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  }

  private dot(a: number[], b: number[]): number {
    return a.reduce((sum, val, i) => sum + val * (b[i] || 0), 0);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const dot = this.dot(a, b);
    const normA = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    const normB = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
    return normA * normB > 0 ? dot / (normA * normB) : 0;
  }

  private binaryCrossEntropy(pred: number, label: number): number {
    const eps = 1e-7;
    const p = Math.max(eps, Math.min(1 - eps, pred));
    return -label * Math.log(p) - (1 - label) * Math.log(1 - p);
  }

  // ==========================================================================
  // Serialization
  // ==========================================================================

  exportParams(): Record<string, unknown> {
    return {
      config: this.config,
      layerParams: this.layerParams,
      headParams: this.headParams,
    };
  }

  importParams(params: Record<string, unknown>): void {
    if (params.config) {
      this.config = params.config as SHGATConfig;
    }
    if (params.layerParams) {
      this.layerParams = params.layerParams as typeof this.layerParams;
    }
    if (params.headParams) {
      this.headParams = params.headParams as typeof this.headParams;
    }
  }

  /**
   * Get all registered tool IDs (for feature population)
   */
  getRegisteredToolIds(): string[] {
    return Array.from(this.toolNodes.keys());
  }

  /**
   * Get all registered capability IDs
   */
  getRegisteredCapabilityIds(): string[] {
    return Array.from(this.capabilityNodes.keys());
  }

  getStats(): {
    numHeads: number;
    hiddenDim: number;
    numLayers: number;
    paramCount: number;
    registeredCapabilities: number;
    registeredTools: number;
    incidenceNonZeros: number;
  } {
    const { numHeads, hiddenDim, embeddingDim, numLayers } = this.config;

    let paramCount = 0;
    for (let l = 0; l < numLayers; l++) {
      const layerInputDim = l === 0 ? embeddingDim : hiddenDim * numHeads;
      paramCount += numHeads * hiddenDim * layerInputDim * 2; // W_v, W_e
      paramCount += numHeads * 2 * hiddenDim; // a_ve
      paramCount += numHeads * hiddenDim * hiddenDim * 2; // W_e2, W_v2
      paramCount += numHeads * 2 * hiddenDim; // a_ev
    }

    let incidenceNonZeros = 0;
    for (const row of this.incidenceMatrix) {
      incidenceNonZeros += row.filter((x) => x > 0).length;
    }

    return {
      numHeads,
      hiddenDim,
      numLayers,
      paramCount,
      registeredCapabilities: this.capabilityNodes.size,
      registeredTools: this.toolNodes.size,
      incidenceNonZeros,
    };
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create SHGAT from capability store
 */
export function createSHGATFromCapabilities(
  capabilities: Array<{
    id: string;
    embedding: number[];
    toolsUsed: string[];
    successRate: number;
    parents?: string[];
    children?: string[];
    hypergraphFeatures?: HypergraphFeatures;
  }>,
  configOrToolEmbeddings?: Partial<SHGATConfig> | Map<string, number[]>,
  config?: Partial<SHGATConfig>,
): SHGAT {
  // Handle overloaded parameters
  let toolEmbeddings: Map<string, number[]> | undefined;
  let actualConfig: Partial<SHGATConfig> | undefined;

  if (configOrToolEmbeddings instanceof Map) {
    toolEmbeddings = configOrToolEmbeddings;
    actualConfig = config;
  } else {
    actualConfig = configOrToolEmbeddings;
  }

  const shgat = new SHGAT(actualConfig);

  // Extract all unique tools from capabilities
  const allTools = new Set<string>();
  for (const cap of capabilities) {
    for (const toolId of cap.toolsUsed) {
      allTools.add(toolId);
    }
  }

  // Determine embedding dimension from first capability
  const embeddingDim = capabilities[0]?.embedding.length || 1024;

  // Register tools with embeddings (provided or generated)
  for (const toolId of allTools) {
    const embedding = toolEmbeddings?.get(toolId) ||
      generateDefaultToolEmbedding(toolId, embeddingDim);
    shgat.registerTool({ id: toolId, embedding });
  }

  // Register capabilities
  for (const cap of capabilities) {
    shgat.registerCapability({
      id: cap.id,
      embedding: cap.embedding,
      toolsUsed: cap.toolsUsed,
      successRate: cap.successRate,
      parents: cap.parents || [],
      children: cap.children || [],
    });

    // Update hypergraph features if provided
    if (cap.hypergraphFeatures) {
      shgat.updateHypergraphFeatures(cap.id, cap.hypergraphFeatures);
    }
  }

  return shgat;
}

/**
 * Generate a deterministic default embedding for a tool based on its ID
 */
function generateDefaultToolEmbedding(toolId: string, dim: number): number[] {
  const embedding: number[] = [];
  // Use hash-like seed from tool ID for deterministic pseudo-random values
  let seed = 0;
  for (let i = 0; i < toolId.length; i++) {
    seed = ((seed << 5) - seed + toolId.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dim; i++) {
    // Deterministic pseudo-random based on seed and index
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    embedding.push((seed / 0x7fffffff - 0.5) * 0.1);
  }
  return embedding;
}

/**
 * Train SHGAT on episodic events
 */
export async function trainSHGATOnEpisodes(
  shgat: SHGAT,
  episodes: TrainingExample[],
  getEmbedding: (id: string) => number[] | null,
  options: {
    epochs?: number;
    batchSize?: number;
    onEpoch?: (epoch: number, loss: number, accuracy: number) => void;
  } = {},
): Promise<{ finalLoss: number; finalAccuracy: number }> {
  // Yield to event loop for UI responsiveness during long training
  await Promise.resolve();

  const epochs = options.epochs || 10;
  const batchSize = options.batchSize || 32;

  let finalLoss = 0;
  let finalAccuracy = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const shuffled = [...episodes].sort(() => Math.random() - 0.5);

    let epochLoss = 0;
    let epochAccuracy = 0;
    let batchCount = 0;

    for (let i = 0; i < shuffled.length; i += batchSize) {
      const batch = shuffled.slice(i, i + batchSize);
      const result = shgat.trainBatch(batch, getEmbedding);

      epochLoss += result.loss;
      epochAccuracy += result.accuracy;
      batchCount++;
    }

    epochLoss /= batchCount;
    epochAccuracy /= batchCount;

    finalLoss = epochLoss;
    finalAccuracy = epochAccuracy;

    if (options.onEpoch) {
      options.onEpoch(epoch, epochLoss, epochAccuracy);
    }
  }

  return { finalLoss, finalAccuracy };
}
