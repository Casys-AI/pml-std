/**
 * Algorithm Initializer Service
 *
 * Handles complex initialization of SHGAT and DR-DSP algorithms at startup.
 * Encapsulates:
 * - Loading capabilities from database
 * - Building hierarchy from contains edges
 * - Creating SHGAT/DR-DSP via AlgorithmFactory
 * - Loading co-occurrence patterns
 * - Caching hyperedges
 * - Starting GraphSyncController
 * - Loading/saving SHGAT params
 * - Populating tool features
 * - Background training on traces
 *
 * @module mcp/algorithm-initializer
 */

import * as log from "@std/log";
import type { DbClient } from "../../db/types.ts";
import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import type { CapabilityStore } from "../../capabilities/capability-store.ts";
import type { EmbeddingModelInterface } from "../../vector/embeddings.ts";
import {
  type SHGAT,
  type TrainingExample,
  type ToolGraphFeatures,
} from "../../graphrag/algorithms/shgat.ts";
import { spawnSHGATTraining } from "../../graphrag/algorithms/shgat/spawn-training.ts";
import type { DRDSP } from "../../graphrag/algorithms/dr-dsp.ts";
import { GraphSyncController } from "../graph-sync/mod.ts";
import { trainingLock } from "../../graphrag/learning/mod.ts";
import {
  AlgorithmFactory,
  type AlgorithmCapabilityInput,
} from "../../infrastructure/patterns/factory/algorithm-factory.ts";

// ==========================================================================
// Types
// ==========================================================================

interface CapRow {
  id: string;
  embedding: number[] | null;
  tools_used: string[] | null;
  success_rate: number;
}

interface ContainsEdge {
  from_capability_id: string;
  to_capability_id: string;
}

// Re-use AlgorithmCapabilityInput from factory
type CapabilityWithEmbedding = AlgorithmCapabilityInput;

interface TraceRow {
  capability_id: string;
  intent_text: string | null;
  intent_embedding: string | null;
  success: boolean;
  executed_path: string[] | null;
}

interface TraceToolRow {
  task_results: string | Array<{ tool?: string }>;
  executed_at: string;
}

interface SHGATParamsRow {
  params: Record<string, unknown>;
  updated_at: string;
}

/**
 * Dependencies for AlgorithmInitializer
 */
export interface AlgorithmInitializerDeps {
  db: DbClient;
  graphEngine: GraphRAGEngine;
  capabilityStore?: CapabilityStore;
  embeddingModel?: EmbeddingModelInterface;
}

/**
 * Result of algorithm initialization
 */
export interface AlgorithmInitResult {
  shgat: SHGAT | null;
  drdsp: DRDSP | null;
  graphSyncController: GraphSyncController | null;
  capabilitiesLoaded: number;
}

// ==========================================================================
// AlgorithmInitializer
// ==========================================================================

/**
 * Service for initializing ML algorithms at server startup
 */
export class AlgorithmInitializer {
  private shgat: SHGAT | null = null;
  private drdsp: DRDSP | null = null;
  private graphSyncController: GraphSyncController | null = null;
  private capabilities: CapabilityWithEmbedding[] = [];

  constructor(private deps: AlgorithmInitializerDeps) {}

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Initialize all algorithms
   */
  async initialize(): Promise<AlgorithmInitResult> {
    if (!this.deps.capabilityStore) {
      log.warn("[AlgorithmInitializer] No capability store - SHGAT/DR-DSP disabled");
      return {
        shgat: null,
        drdsp: null,
        graphSyncController: null,
        capabilitiesLoaded: 0,
      };
    }

    try {
      // 1. Load and parse capabilities from database
      const rows = await this.loadCapabilities();
      const containsEdges = await this.loadContainsEdges();
      this.capabilities = this.parseCapabilities(rows, containsEdges);

      // 2. Create SHGAT and DR-DSP via AlgorithmFactory (centralized creation)
      // Factory handles: algorithm creation, co-occurrence loading
      const { shgat: shgatResult, drdsp } = await AlgorithmFactory.createBoth(
        this.capabilities,
        { withCooccurrence: true },
      );

      this.shgat = shgatResult.shgat;
      this.drdsp = drdsp;
      log.info(
        `[AlgorithmInitializer] Algorithms initialized: ${shgatResult.capabilitiesLoaded} caps, ` +
        `${shgatResult.cooccurrenceEdges ?? 0} co-occurrence edges`,
      );

      // 3. Start GraphSyncController for incremental updates
      this.graphSyncController = new GraphSyncController(
        this.deps.graphEngine,
        this.deps.db,
        () => this.shgat,
      );
      this.graphSyncController.start();

      // 4. Load persisted SHGAT params
      const { loaded: paramsLoaded } = await this.loadSHGATParams();

      // 5. Populate tool features from graph
      await this.populateToolFeatures();

      // 6. Background training if needed
      if (this.capabilities.length > 0 && !paramsLoaded) {
        log.info(`[AlgorithmInitializer] Starting background SHGAT training`);
        this.trainOnTraces().catch((err) =>
          log.warn(`[AlgorithmInitializer] Background training failed: ${err}`)
        );
      } else if (paramsLoaded) {
        log.info(`[AlgorithmInitializer] SHGAT params loaded - skipping batch training`);
      }

      return {
        shgat: this.shgat,
        drdsp: this.drdsp,
        graphSyncController: this.graphSyncController,
        capabilitiesLoaded: this.capabilities.length,
      };
    } catch (error) {
      log.error(`[AlgorithmInitializer] Failed to initialize: ${error}`);
      return {
        shgat: null,
        drdsp: null,
        graphSyncController: null,
        capabilitiesLoaded: 0,
      };
    }
  }

  /**
   * Get SHGAT instance
   */
  getSHGAT(): SHGAT | null {
    return this.shgat;
  }

  /**
   * Get DR-DSP instance
   */
  getDRDSP(): DRDSP | null {
    return this.drdsp;
  }

  /**
   * Stop services
   */
  stop(): void {
    if (this.graphSyncController) {
      this.graphSyncController.stop();
      this.graphSyncController = null;
    }
  }

  /**
   * Save SHGAT params to database
   */
  async saveSHGATParams(): Promise<void> {
    if (!this.shgat) return;

    try {
      const params = this.shgat.exportParams();
      await this.deps.db.query(
        `INSERT INTO shgat_params (user_id, params, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           params = EXCLUDED.params,
           updated_at = NOW()`,
        ["local", params],
      );
      log.info("[AlgorithmInitializer] SHGAT params saved to DB");
    } catch (error) {
      log.warn(`[AlgorithmInitializer] Could not save SHGAT params: ${error}`);
    }
  }

  /**
   * Load persisted SHGAT params from database
   */
  async loadSHGATParams(): Promise<{ loaded: boolean; updatedAt?: Date }> {
    if (!this.shgat) return { loaded: false };

    try {
      const rows = (await this.deps.db.query(
        `SELECT params, updated_at FROM shgat_params WHERE user_id = $1 LIMIT 1`,
        ["local"],
      )) as unknown as SHGATParamsRow[];

      if (rows.length > 0 && rows[0].params) {
        this.shgat.importParams(rows[0].params);
        const updatedAt = new Date(rows[0].updated_at);
        log.info(
          `[AlgorithmInitializer] SHGAT params loaded (saved: ${rows[0].updated_at})`,
        );
        return { loaded: true, updatedAt };
      } else {
        log.info("[AlgorithmInitializer] No persisted SHGAT params found");
        return { loaded: false };
      }
    } catch (error) {
      log.debug(`[AlgorithmInitializer] Could not load SHGAT params: ${error}`);
      return { loaded: false };
    }
  }

  // ==========================================================================
  // Private: Data Loading
  // ==========================================================================

  private async loadCapabilities(): Promise<CapRow[]> {
    return (await this.deps.db.query(
      `SELECT
        pattern_id as id,
        intent_embedding as embedding,
        dag_structure->'tools_used' as tools_used,
        success_rate
      FROM workflow_pattern
      WHERE code_snippet IS NOT NULL
      LIMIT 1000`,
    )) as unknown as CapRow[];
  }

  private async loadContainsEdges(): Promise<ContainsEdge[]> {
    return (await this.deps.db.query(
      `SELECT from_capability_id, to_capability_id
       FROM capability_dependency
       WHERE edge_type = 'contains'`,
    )) as unknown as ContainsEdge[];
  }

  private parseCapabilities(
    rows: CapRow[],
    containsEdges: ContainsEdge[],
  ): CapabilityWithEmbedding[] {
    // Build hierarchy maps
    const childrenMap = new Map<string, string[]>();
    const parentsMap = new Map<string, string[]>();

    for (const edge of containsEdges) {
      const children = childrenMap.get(edge.from_capability_id) || [];
      children.push(edge.to_capability_id);
      childrenMap.set(edge.from_capability_id, children);

      const parents = parentsMap.get(edge.to_capability_id) || [];
      parents.push(edge.from_capability_id);
      parentsMap.set(edge.to_capability_id, parents);
    }

    const toolEdgesCount = rows.reduce(
      (acc, c) => acc + (c.tools_used?.length ?? 0),
      0,
    );
    log.debug(
      `[AlgorithmInitializer] Hierarchy: ${containsEdges.length} cap→cap, ${toolEdgesCount} cap→tool`,
    );

    // Parse capabilities with embeddings
    return rows
      .filter((c) => c.embedding !== null)
      .map((c) => {
        let embedding: number[];
        if (Array.isArray(c.embedding)) {
          embedding = c.embedding;
        } else if (typeof c.embedding === "string") {
          try {
            embedding = JSON.parse(c.embedding);
          } catch {
            return null;
          }
        } else {
          return null;
        }
        if (!Array.isArray(embedding) || embedding.length === 0) return null;
        return { ...c, embedding };
      })
      .filter((c): c is CapRow & { embedding: number[] } => c !== null)
      .map((c) => ({
        id: c.id,
        embedding: c.embedding,
        toolsUsed: c.tools_used ?? [],
        successRate: c.success_rate,
        children: childrenMap.get(c.id),
        parents: parentsMap.get(c.id),
      }));
  }

  // ==========================================================================
  // Private: Tool Features (co-occurrence & hyperedges handled by AlgorithmFactory)
  // ==========================================================================

  private async populateToolFeatures(): Promise<void> {
    if (!this.shgat || !this.deps.graphEngine) return;

    try {
      // Register/update all tools from graphEngine with real embeddings
      // NOTE: Tools from capabilities may have been registered with default embeddings
      // during createSHGATFromCapabilities. We MUST update them with real embeddings.
      const graphToolIds = this.deps.graphEngine.getGraph().nodes();
      let registeredCount = 0;
      let updatedCount = 0;

      for (const toolId of graphToolIds) {
        const toolNode = this.deps.graphEngine.getToolNode(toolId);

        let embedding: number[];
        if (toolNode?.embedding && toolNode.embedding.length > 0) {
          embedding = toolNode.embedding;
        } else {
          const description = toolNode?.description ?? toolId.replace(":", " ");
          embedding = this.deps.embeddingModel
            ? await this.deps.embeddingModel.encode(description)
            : new Array(1024).fill(0).map(() => Math.random() - 0.5);
        }

        const wasExisting = this.shgat.hasToolNode(toolId);
        this.shgat.registerTool({ id: toolId, embedding });

        if (wasExisting) {
          updatedCount++;
        } else {
          registeredCount++;
        }
      }

      if (registeredCount > 0 || updatedCount > 0) {
        log.info(`[AlgorithmInitializer] Tools: ${registeredCount} new, ${updatedCount} updated with real embeddings`);
      }

      // Compute features
      const toolIds = this.shgat.getRegisteredToolIds();
      if (toolIds.length === 0) return;

      const { toolRecency, toolCooccurrence } =
        await this.computeTemporalFeatures(toolIds);

      const updates = new Map<string, ToolGraphFeatures>();

      for (const toolId of toolIds) {
        const pageRank = this.deps.graphEngine.getPageRank(toolId);
        const community = this.deps.graphEngine.getCommunity(toolId);
        const louvainCommunity = community ? parseInt(community, 10) || 0 : 0;

        const adamicResults = this.deps.graphEngine.computeAdamicAdar(toolId, 1);
        const adamicAdar =
          adamicResults.length > 0
            ? Math.min(adamicResults[0].score / 2, 1.0)
            : 0;

        updates.set(toolId, {
          pageRank,
          louvainCommunity,
          adamicAdar,
          cooccurrence: toolCooccurrence.get(toolId) ?? 0,
          recency: toolRecency.get(toolId) ?? 0,
          heatDiffusion: 0,
        });
      }

      this.shgat.batchUpdateToolFeatures(updates);
      log.info(`[AlgorithmInitializer] Tool features for ${updates.size} tools`);
    } catch (error) {
      log.warn(`[AlgorithmInitializer] Failed to populate features: ${error}`);
    }
  }

  private async computeTemporalFeatures(
    toolIds: string[],
  ): Promise<{
    toolRecency: Map<string, number>;
    toolCooccurrence: Map<string, number>;
  }> {
    const toolRecency = new Map<string, number>();
    const toolCooccurrence = new Map<string, number>();

    for (const toolId of toolIds) {
      toolRecency.set(toolId, 0);
      toolCooccurrence.set(toolId, 0);
    }

    try {
      const traces = (await this.deps.db.query(`
        SELECT task_results, executed_at
        FROM execution_trace
        WHERE task_results IS NOT NULL
          AND jsonb_typeof(task_results) = 'array'
          AND jsonb_array_length(task_results) > 0
        ORDER BY executed_at DESC
        LIMIT 500
      `)) as unknown as TraceToolRow[];

      if (traces.length === 0) {
        return { toolRecency, toolCooccurrence };
      }

      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      const toolLastUsed = new Map<string, number>();
      const toolPairCount = new Map<string, number>();

      for (const trace of traces) {
        let taskResults: Array<{ tool?: string }> = [];
        try {
          taskResults =
            typeof trace.task_results === "string"
              ? JSON.parse(trace.task_results)
              : trace.task_results;
        } catch {
          continue;
        }

        const traceTime = new Date(trace.executed_at).getTime();
        const toolsInTrace = new Set<string>();

        for (const task of taskResults) {
          if (task.tool && toolIds.includes(task.tool)) {
            toolsInTrace.add(task.tool);
            const existing = toolLastUsed.get(task.tool) ?? 0;
            if (traceTime > existing) {
              toolLastUsed.set(task.tool, traceTime);
            }
          }
        }

        for (const tool of toolsInTrace) {
          toolPairCount.set(tool, (toolPairCount.get(tool) ?? 0) + 1);
        }
      }

      for (const [toolId, lastUsedTime] of toolLastUsed) {
        const timeSinceUse = now - lastUsedTime;
        const recency = Math.exp(-timeSinceUse / oneDayMs);
        toolRecency.set(toolId, Math.min(recency, 1.0));
      }

      const maxCount = Math.max(1, ...toolPairCount.values());
      for (const [toolId, count] of toolPairCount) {
        toolCooccurrence.set(toolId, count / maxCount);
      }

      log.debug(`[AlgorithmInitializer] Temporal features from ${traces.length} traces`);
    } catch (error) {
      log.warn(`[AlgorithmInitializer] Failed temporal features: ${error}`);
    }

    return { toolRecency, toolCooccurrence };
  }

  // ==========================================================================
  // Private: Training
  // ==========================================================================

  private async trainOnTraces(): Promise<void> {
    if (!this.shgat || !this.deps.embeddingModel) return;

    if (!trainingLock.acquire("BATCH")) {
      log.info(`[AlgorithmInitializer] Skipping training - another in progress`);
      return;
    }

    try {
      const traces = (await this.deps.db.query(`
        SELECT
          et.capability_id,
          wp.description AS intent_text,
          wp.intent_embedding,
          et.success,
          et.executed_path
        FROM execution_trace et
        JOIN workflow_pattern wp ON wp.pattern_id = et.capability_id
        WHERE et.capability_id IS NOT NULL
          AND wp.intent_embedding IS NOT NULL
        ORDER BY et.priority DESC
        LIMIT 500
      `)) as unknown as TraceRow[];

      if (traces.length === 0) {
        log.info(`[AlgorithmInitializer] No traces yet - will train when available`);
        return;
      }

      log.info(`[AlgorithmInitializer] Training on ${traces.length} traces...`);

      // Build map of ALL embeddings (capabilities + tools) for negative sampling
      const allEmbeddings = new Map<string, number[]>();
      for (const cap of this.capabilities) {
        allEmbeddings.set(cap.id, cap.embedding);
      }

      // Add tools to negative pool for diversity (80% of nodes are tools)
      // But we'll exclude tools from the anchor capability's toolsUsed when sampling
      const toolNodes = this.shgat.getRegisteredToolIds();
      for (const toolId of toolNodes) {
        const toolEmb = this.deps.graphEngine?.getToolNode(toolId)?.embedding;
        if (toolEmb && toolEmb.length > 0) {
          allEmbeddings.set(toolId, toolEmb);
        }
      }
      log.debug(`[Training] Negative pool: ${this.capabilities.length} caps + ${toolNodes.length} tools`);

      // Build capability → toolsUsed map for exclusion during sampling
      const capToTools = new Map<string, Set<string>>();
      for (const cap of this.capabilities) {
        capToTools.set(cap.id, new Set(cap.toolsUsed));
      }

      // Build tool clusters using cosine similarity (semantic)
      // Exclude tools with similar descriptions from negatives
      const COSINE_THRESHOLD = 0.7;
      const toolClusters = new Map<string, Set<string>>();

      // Get all tool embeddings
      const toolEmbeddings = new Map<string, number[]>();
      for (const [id, emb] of allEmbeddings) {
        if (id.includes(":") && !this.capabilities.find(c => c.id === id)) {
          toolEmbeddings.set(id, emb);
        }
      }

      for (const [toolId, toolEmb] of toolEmbeddings) {
        const cluster = new Set<string>([toolId]);
        for (const [otherId, otherEmb] of toolEmbeddings) {
          if (otherId === toolId) continue;
          let dot = 0, normA = 0, normB = 0;
          for (let i = 0; i < Math.min(toolEmb.length, otherEmb.length); i++) {
            dot += toolEmb[i] * otherEmb[i];
            normA += toolEmb[i] * toolEmb[i];
            normB += otherEmb[i] * otherEmb[i];
          }
          const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-9);
          if (sim > COSINE_THRESHOLD) {
            cluster.add(otherId);
          }
        }
        toolClusters.set(toolId, cluster);
      }
      log.debug(`[Training] Built ${toolClusters.size} tool clusters (cosine > ${COSINE_THRESHOLD})`);

      const examples: TrainingExample[] = [];
      const NUM_NEGATIVES = 8;

      // Helper: cosine similarity
      const cosineSim = (a: number[], b: number[]): number => {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
          dot += a[i] * b[i];
          normA += a[i] * a[i];
          normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom > 0 ? dot / denom : 0;
      };

      // Helper: compute percentile
      const percentile = (arr: number[], p: number): number => {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.floor((p / 100) * (sorted.length - 1));
        return sorted[idx];
      };

      // Compute global similarity distribution for adaptive thresholds
      const allSims: number[] = [];
      for (const trace of traces) {
        if (!trace.intent_embedding) continue;
        let intentEmb: number[];
        try {
          const cleaned = trace.intent_embedding.replace(/^\[|\]$/g, "");
          intentEmb = cleaned.split(",").map(Number);
        } catch { continue; }

        // Get tools to exclude for this anchor capability
        const anchorTools = capToTools.get(trace.capability_id) ?? new Set();

        for (const [itemId, emb] of allEmbeddings) {
          // Skip the anchor capability itself
          if (itemId === trace.capability_id) continue;
          // Skip tools that belong to this anchor capability
          if (anchorTools.has(itemId)) continue;
          allSims.push(cosineSim(intentEmb, emb));
        }
      }

      // Adaptive thresholds: P25-P75 for semi-hard range (classic)
      // PER will handle curriculum learning by prioritizing harder examples
      let SEMI_HARD_MIN = allSims.length > 0 ? percentile(allSims, 25) : 0.15;
      let SEMI_HARD_MAX = allSims.length > 0 ? percentile(allSims, 75) : 0.65;

      // Ensure minimum spread of 0.1 for semi-hard range
      const MIN_SPREAD = 0.1;
      if (SEMI_HARD_MAX - SEMI_HARD_MIN < MIN_SPREAD) {
        SEMI_HARD_MIN = SEMI_HARD_MAX - MIN_SPREAD;
        log.debug(`[Training] Spread too narrow, expanded to: [${SEMI_HARD_MIN.toFixed(2)}, ${SEMI_HARD_MAX.toFixed(2)}]`);
      }

      // Log distribution
      const easyCount = allSims.filter(s => s < SEMI_HARD_MIN).length;
      const semiHardCount = allSims.filter(s => s >= SEMI_HARD_MIN && s <= SEMI_HARD_MAX).length;
      const hardCount = allSims.filter(s => s > SEMI_HARD_MAX).length;
      log.info(`[Training] Similarity distribution: easy=${easyCount} (< ${SEMI_HARD_MIN.toFixed(2)}), ` +
        `semi-hard=${semiHardCount} [${SEMI_HARD_MIN.toFixed(2)}-${SEMI_HARD_MAX.toFixed(2)}], ` +
        `hard=${hardCount} (> ${SEMI_HARD_MAX.toFixed(2)})`);

      for (const trace of traces) {
        // Ensure this is a valid capability (not a tool)
        if (!capToTools.has(trace.capability_id)) continue;

        // Get anchor embedding - required for anchor-based filtering
        const anchorEmb = allEmbeddings.get(trace.capability_id);
        if (!anchorEmb) continue;

        // Parse intent embedding for training examples (model learns intent→capability)
        if (!trace.intent_embedding) continue;
        let intentEmbedding: number[];
        try {
          const cleaned = trace.intent_embedding.replace(/^\[|\]$/g, "");
          intentEmbedding = cleaned.split(",").map(Number);
        } catch {
          continue;
        }

        // Get tools to exclude for this anchor capability
        const anchorTools = capToTools.get(trace.capability_id)!;

        // Build expanded exclusion set: anchor tools + their similar tools (cluster)
        const excludedTools = new Set<string>();
        for (const toolId of anchorTools) {
          excludedTools.add(toolId);
          const cluster = toolClusters.get(toolId);
          if (cluster) {
            for (const similarTool of cluster) {
              excludedTools.add(similarTool);
            }
          }
        }

        // Compute similarity to INTENT for all candidates
        const candidatesWithSim: Array<{ id: string; sim: number }> = [];
        for (const [itemId, emb] of allEmbeddings) {
          // Skip the anchor capability itself
          if (itemId === trace.capability_id) continue;
          // Skip tools in the exclusion cluster (anchor's tools + similar tools)
          if (excludedTools.has(itemId)) continue;
          const sim = cosineSim(intentEmbedding, emb);
          candidatesWithSim.push({ id: itemId, sim });
        }

        // Hard negative mining: filter to P80-P95 similarity range (most similar = hardest)
        const semiHard = candidatesWithSim.filter(
          (c) => c.sim >= SEMI_HARD_MIN && c.sim <= SEMI_HARD_MAX
        );

        let negativeCapIds: string[];
        if (semiHard.length >= NUM_NEGATIVES) {
          // Enough semi-hard negatives: shuffle and take N
          for (let i = semiHard.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [semiHard[i], semiHard[j]] = [semiHard[j], semiHard[i]];
          }
          negativeCapIds = semiHard.slice(0, NUM_NEGATIVES).map((c) => c.id);
        } else {
          // Not enough semi-hard: use semi-hard + random from rest
          const rest = candidatesWithSim.filter(
            (c) => c.sim < SEMI_HARD_MIN || c.sim > SEMI_HARD_MAX
          );
          for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
          }
          const needed = NUM_NEGATIVES - semiHard.length;
          negativeCapIds = [
            ...semiHard.map((c) => c.id),
            ...rest.slice(0, needed).map((c) => c.id),
          ];
        }

        examples.push({
          intentEmbedding,
          contextTools: trace.executed_path ?? [],
          candidateId: trace.capability_id,
          outcome: trace.success ? 1.0 : 0.0,
          negativeCapIds,
        });
      }

      if (examples.length === 0) {
        log.info(`[AlgorithmInitializer] No valid examples - skipping`);
        return;
      }

      // Collect all tools already known from capabilities
      const toolsInCaps = new Set<string>();
      for (const cap of this.capabilities) {
        for (const tool of cap.toolsUsed) {
          toolsInCaps.add(tool);
        }
      }

      // Find additional tools from examples not in any capability
      const additionalTools: string[] = [];
      for (const ex of examples) {
        for (const tool of ex.contextTools) {
          if (!toolsInCaps.has(tool) && !additionalTools.includes(tool)) {
            additionalTools.push(tool);
          }
        }
      }

      // Each capability keeps its own toolsUsed (no hack needed)
      const capsForWorker = this.capabilities.map((c) => ({
        id: c.id,
        embedding: c.embedding,
        toolsUsed: c.toolsUsed,
        successRate: c.successRate,
      }));

      const result = await spawnSHGATTraining({
        capabilities: capsForWorker,
        examples,
        epochs: 20,
        batchSize: 32,
        additionalTools, // Tools from examples not in any capability
      });

      if (result.success && this.shgat) {
        if (result.savedToDb) {
          await this.loadSHGATParams();
          log.info(
            `[AlgorithmInitializer] Training complete: loss=${result.finalLoss?.toFixed(4)}`,
          );
        } else if (result.params) {
          this.shgat.importParams(result.params);
          log.info(
            `[AlgorithmInitializer] Training complete: loss=${result.finalLoss?.toFixed(4)}`,
          );
          await this.saveSHGATParams();
        }
      } else if (!result.success) {
        log.warn(`[AlgorithmInitializer] Training failed: ${result.error}`);
      }
    } catch (error) {
      log.warn(`[AlgorithmInitializer] Training error: ${error}`);
    } finally {
      trainingLock.release("BATCH");
    }
  }
}
