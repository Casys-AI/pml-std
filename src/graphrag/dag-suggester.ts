/**
 * DAG Suggester - Facade
 *
 * Combines vector search and graph algorithms to suggest optimal DAG structures
 * for workflow execution. Delegates to extracted modules for specific functionality.
 *
 * Phase 4 Refactoring: Reduced from 2,023 lines to ~400 lines (facade pattern)
 *
 * @module graphrag/dag-suggester
 */

import * as log from "@std/log";
import type { VectorSearch } from "../vector/search.ts";
import type { GraphRAGEngine } from "./graph-engine.ts";
import type { EpisodicMemoryStore } from "../learning/episodic-memory-store.ts";
import type { CapabilityMatcher } from "../capabilities/matcher.ts";
import type { CapabilityMatch } from "../capabilities/types.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import { SpectralClusteringManager } from "./spectral-clustering.ts";
import { LocalAlphaCalculator } from "./local-alpha.ts";
import {
  type DagScoringConfig,
  DEFAULT_DAG_SCORING_CONFIG,
  loadDagScoringConfig,
} from "./dag-scoring-config.ts";
import type {
  CompletedTask,
  DAGStructure,
  PredictedNode,
  SuggestedDAG,
  WorkflowIntent,
  WorkflowPredictionState,
} from "./types.ts";
import type { AlgorithmTracer } from "../telemetry/algorithm-tracer.ts";
import { eventBus } from "../events/mod.ts";

// Extracted modules
import {
  calculateAverageAlpha,
  calculateConfidenceHybrid,
  type CandidateAlpha,
  extractDependencyPaths,
  generateRationaleHybrid,
  rankCandidates,
} from "./suggestion/mod.ts";
import {
  adjustConfidenceFromEpisodes,
  applyLocalAlpha,
  type CapabilityPredictionDeps,
  type EpisodeStatsMap,
  injectMatchingCapabilities,
  isDangerousOperation,
  predictCapabilities,
} from "./prediction/mod.ts";
import { suggestAlternatives } from "./prediction/alternatives.ts";
import {
  calculateCommunityConfidence,
  calculateCooccurrenceConfidence,
} from "./suggestion/confidence.ts";
import { loadEpisodeStatistics } from "./learning/episodic-adapter.ts";
import {
  exportLearnedPatterns,
  importLearnedPatterns,
  type LearnedPatternData,
  type PatternImport,
  registerAgentHint,
} from "./learning/pattern-io.ts";
import { computeClusterBoosts, getCapabilityPageranks } from "./clustering/boost-calculator.ts";

/**
 * DAG Suggester - Facade Class
 *
 * Orchestrates vector search for semantic candidate selection and graph algorithms
 * for dependency inference and DAG construction.
 */
export class DAGSuggester {
  private episodicMemory: EpisodicMemoryStore | null = null;
  private capabilityMatcher: CapabilityMatcher | null = null;
  private capabilityStore: CapabilityStore | null = null;
  private spectralClustering: SpectralClusteringManager | null = null;
  private algorithmTracer: AlgorithmTracer | null = null;
  private localAlphaCalculator: LocalAlphaCalculator | null = null;
  private scoringConfig: DagScoringConfig = DEFAULT_DAG_SCORING_CONFIG;

  constructor(
    private graphEngine: GraphRAGEngine,
    private vectorSearch: VectorSearch,
    capabilityMatcher?: CapabilityMatcher,
    capabilityStore?: CapabilityStore,
  ) {
    this.capabilityMatcher = capabilityMatcher || null;
    this.capabilityStore = capabilityStore || null;
  }

  // ===========================================================================
  // Configuration & Setters
  // ===========================================================================

  async initScoringConfig(configPath?: string): Promise<void> {
    this.scoringConfig = await loadDagScoringConfig(configPath);
    log.debug("[DAGSuggester] Scoring config initialized");
  }

  setScoringConfig(config: DagScoringConfig): void {
    this.scoringConfig = config;
  }

  getScoringConfig(): DagScoringConfig {
    return this.scoringConfig;
  }

  setCapabilityStore(store: CapabilityStore): void {
    this.capabilityStore = store;
    log.debug("[DAGSuggester] Capability store configured for strategic discovery");
  }

  getGraphEngine(): GraphRAGEngine {
    return this.graphEngine;
  }

  setEpisodicMemoryStore(store: EpisodicMemoryStore): void {
    this.episodicMemory = store;
    log.debug("[DAGSuggester] Episodic memory enabled for learning-enhanced predictions");
  }

  setCapabilityMatcher(matcher: CapabilityMatcher): void {
    this.capabilityMatcher = matcher;
    // Pass scoring config to matcher for intentSearch threshold
    matcher.setScoringConfig(this.scoringConfig);
    log.debug("[DAGSuggester] Capability matching enabled", {
      intentSearchThreshold: this.scoringConfig.thresholds.intentSearch,
    });
  }

  setAlgorithmTracer(tracer: AlgorithmTracer): void {
    this.algorithmTracer = tracer;
    log.debug("[DAGSuggester] Algorithm tracing enabled");
  }

  setLocalAlphaCalculator(calculator: LocalAlphaCalculator): void {
    this.localAlphaCalculator = calculator;
    log.debug("[DAGSuggester] Local adaptive alpha enabled");
  }

  getLocalAlphaCalculator(): LocalAlphaCalculator | null {
    return this.localAlphaCalculator;
  }

  getCapabilityPageranks(): Map<string, number> {
    return getCapabilityPageranks(this.spectralClustering);
  }

  async searchCapabilities(intent: string, correlationId?: string): Promise<CapabilityMatch | null> {
    if (!this.capabilityMatcher) {
      log.debug("[DAGSuggester] searchCapabilities called but CapabilityMatcher not configured");
      return null;
    }
    return await this.capabilityMatcher.findMatch(intent, correlationId);
  }

  // ===========================================================================
  // Core DAG Suggestion (ADR-022: Hybrid Search)
  // ===========================================================================

  async suggestDAG(intent: WorkflowIntent): Promise<SuggestedDAG | null> {
    try {
      const contextTools = intent.toolsConsidered || [];
      const hybridCandidates = await this.graphEngine.searchToolsHybrid(
        this.vectorSearch,
        intent.text,
        this.scoringConfig.limits.hybridSearchCandidates,
        contextTools,
        false,
        this.scoringConfig.thresholds.toolSearch,
      );

      if (hybridCandidates.length === 0) {
        log.info(`No candidates found for intent: "${intent.text}"`);
        return null;
      }

      // Rank candidates
      const rankedCandidates = rankCandidates(
        hybridCandidates,
        contextTools,
        this.graphEngine,
        this.scoringConfig,
      );

      // Calculate local alpha for each candidate
      const candidateAlphas = this.calculateCandidateAlphas(rankedCandidates, contextTools);
      const avgAlpha = calculateAverageAlpha(candidateAlphas, this.scoringConfig.defaults.alpha);

      log.debug(
        `[suggestDAG] Average local alpha: ${
          avgAlpha.toFixed(2)
        } across ${candidateAlphas.length} candidates`,
      );

      // Log traces for each candidate
      this.logCandidateTraces(rankedCandidates, candidateAlphas, intent.text);

      // Build DAG using graph topology
      const dagStructure = this.graphEngine.buildDAG(rankedCandidates.map((c) => c.toolId));

      // Inject matching capabilities
      const clusterBoostsResult = this.computeClusterBoostsForCapabilities(
        rankedCandidates.map((c) => c.toolId),
      );
      this.spectralClustering = clusterBoostsResult.spectralClustering;

      await injectMatchingCapabilities(
        dagStructure,
        rankedCandidates.map((c) => c.toolId),
        clusterBoostsResult.boosts,
        this.getPredictionDeps(),
      );

      // Extract dependency paths
      const dependencyPaths = extractDependencyPaths(
        rankedCandidates.map((c) => c.toolId),
        this.graphEngine,
        this.scoringConfig,
      );

      // Calculate confidence
      const { confidence, semanticScore, pageRankScore, pathStrength } = calculateConfidenceHybrid(
        rankedCandidates,
        dependencyPaths,
        this.scoringConfig,
        avgAlpha,
      );

      log.info(
        `Confidence: ${confidence.toFixed(2)} (semantic: ${semanticScore.toFixed(2)}, pageRank: ${
          pageRankScore.toFixed(2)
        }, pathStrength: ${pathStrength.toFixed(2)}, avgAlpha: ${
          avgAlpha.toFixed(2)
        }) for intent: "${intent.text}"`,
      );

      // Find alternatives
      const alternatives = this.graphEngine
        .findCommunityMembers(rankedCandidates[0].toolId)
        .slice(0, this.scoringConfig.limits.alternatives);

      // Generate rationale
      const rationale = generateRationaleHybrid(
        rankedCandidates,
        dependencyPaths,
        this.scoringConfig,
      );

      // Reject if confidence too low (no matching tools)
      if (confidence < this.scoringConfig.thresholds.suggestionReject) {
        log.info(
          `Confidence ${
            confidence.toFixed(2)
          } below rejection threshold (${this.scoringConfig.thresholds.suggestionReject}), returning null`,
        );
        return null;
      }

      // Return with warning if below suggestion floor but above rejection threshold
      if (confidence < this.scoringConfig.thresholds.suggestionFloor) {
        log.info(
          `Confidence below floor (${confidence.toFixed(2)}), returning suggestion with warning`,
        );
        return {
          dagStructure,
          confidence,
          rationale,
          dependencyPaths,
          alternatives,
          warning:
            "Low confidence suggestion - results may not be relevant. Confidence may improve with usage.",
        };
      }

      return { dagStructure, confidence, rationale, dependencyPaths, alternatives };
    } catch (error) {
      log.error(`DAG suggestion failed: ${error}`);
      return null;
    }
  }

  // ===========================================================================
  // Replan DAG (Story 2.5-3)
  // ===========================================================================

  async replanDAG(
    currentDAG: DAGStructure,
    context: {
      completedTasks: Array<{ taskId: string; status: string }>;
      newRequirement: string;
      availableContext: Record<string, unknown>;
    },
  ): Promise<DAGStructure> {
    const startTime = performance.now();

    try {
      log.info(`Replanning DAG with new requirement: "${context.newRequirement}"`);

      const candidates = await this.vectorSearch.searchTools(
        context.newRequirement,
        this.scoringConfig.limits.replanCandidates,
        this.scoringConfig.thresholds.replanThreshold,
      );

      if (candidates.length === 0) {
        log.warn("No relevant tools found for replanning requirement");
        return currentDAG;
      }

      const rankedCandidates = candidates
        .map((c) => ({ ...c, pageRank: this.graphEngine.getPageRank(c.toolId) }))
        .sort((a, b) => b.pageRank - a.pageRank)
        .slice(0, this.scoringConfig.limits.replanTop);

      const existingTaskIds = currentDAG.tasks.map((t) => t.id);
      const newTasks = rankedCandidates.map((candidate, idx) => {
        const lastSuccessfulTask = context.completedTasks.filter((t) =>
          t.status === "success"
        ).slice(-1)[0];
        return {
          id: `replan_task_${existingTaskIds.length + idx}`,
          tool: candidate.toolId,
          arguments: context.availableContext || {},
          dependsOn: lastSuccessfulTask ? [lastSuccessfulTask.taskId] : [],
        };
      });

      const augmentedDAG: DAGStructure = { tasks: [...currentDAG.tasks, ...newTasks] };

      try {
        this.validateDAGNoCycles(augmentedDAG);
      } catch (error) {
        log.error(`Cycle detected in replanned DAG: ${error}`);
        return currentDAG;
      }

      log.info(
        `✓ DAG replanned: added ${newTasks.length} new tasks (${
          (performance.now() - startTime).toFixed(1)
        }ms)`,
      );
      return augmentedDAG;
    } catch (error) {
      log.error(`DAG replanning failed: ${error}`);
      return currentDAG;
    }
  }

  // ===========================================================================
  // Predict Next Nodes (Story 3.5-1)
  // ===========================================================================

  async predictNextNodes(
    workflowState: WorkflowPredictionState | null,
    completedTasks?: CompletedTask[],
  ): Promise<PredictedNode[]> {
    const startTime = performance.now();

    try {
      const tasks = workflowState?.completedTasks ?? completedTasks ?? [];
      if (tasks.length === 0) return [];

      const successfulTasks = tasks.filter((t) => t.status === "success");
      if (successfulTasks.length === 0) return [];

      const lastTask = successfulTasks[successfulTasks.length - 1];
      const lastToolId = lastTask.tool;
      const executedTools = new Set(tasks.map((t) => t.tool));
      const contextToolsList = Array.from(executedTools);

      log.debug(`[predictNextNodes] Predicting next tools after: ${lastToolId}`);

      const episodeStats = await loadEpisodeStatistics(
        workflowState,
        this.episodicMemory,
        this.scoringConfig,
      );
      const predictions: PredictedNode[] = [];
      const seenTools = new Set<string>();

      // Community predictions
      this.addCommunityPredictions(
        predictions,
        seenTools,
        lastToolId,
        executedTools,
        contextToolsList,
        episodeStats,
      );

      // Co-occurrence predictions
      this.addCooccurrencePredictions(
        predictions,
        seenTools,
        lastToolId,
        executedTools,
        contextToolsList,
        episodeStats,
      );

      // Capability predictions
      const clusterBoostsResult = this.computeClusterBoostsForCapabilities(contextToolsList);
      this.spectralClustering = clusterBoostsResult.spectralClustering;

      const capabilityPredictions = await predictCapabilities(
        contextToolsList,
        seenTools,
        episodeStats,
        clusterBoostsResult.boosts,
        this.getPredictionDeps(),
        (cap, score, seen, stats) =>
          suggestAlternatives(cap, score, seen, stats, this.getAlternativeDeps()),
      );
      predictions.push(...capabilityPredictions);

      predictions.sort((a, b) => b.confidence - a.confidence);

      log.info(
        `[predictNextNodes] Generated ${predictions.length} predictions for ${lastToolId} (${
          (performance.now() - startTime).toFixed(1)
        }ms)`,
      );
      return predictions;
    } catch (error) {
      log.error(`[predictNextNodes] Failed: ${error}`);
      return [];
    }
  }

  // ===========================================================================
  // Pattern Management (Story 3.5-1)
  // ===========================================================================

  async registerAgentHint(
    toToolId: string,
    fromToolId: string,
    confidence?: number,
  ): Promise<void> {
    await registerAgentHint(toToolId, fromToolId, this.graphEngine, this.scoringConfig, confidence);
  }

  exportLearnedPatterns(): LearnedPatternData[] {
    return exportLearnedPatterns(this.graphEngine);
  }

  async importLearnedPatterns(
    patterns: PatternImport[],
    mergeStrategy: "replace" | "merge" = "merge",
  ): Promise<number> {
    return importLearnedPatterns(patterns, this.graphEngine, mergeStrategy);
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private getPredictionDeps(): CapabilityPredictionDeps {
    return {
      capabilityStore: this.capabilityStore,
      graphEngine: this.graphEngine,
      algorithmTracer: this.algorithmTracer,
      localAlphaCalculator: this.localAlphaCalculator,
      config: this.scoringConfig,
    };
  }

  private getAlternativeDeps() {
    return {
      capabilityStore: this.capabilityStore,
      graphEngine: this.graphEngine,
      algorithmTracer: this.algorithmTracer,
      config: this.scoringConfig,
    };
  }

  private calculateCandidateAlphas(
    candidates: Array<{ toolId: string }>,
    contextTools: string[],
  ): CandidateAlpha[] {
    return candidates.map((candidate) => {
      if (this.localAlphaCalculator) {
        const result = this.localAlphaCalculator.getLocalAlphaWithBreakdown(
          "active",
          candidate.toolId,
          "tool",
          contextTools,
        );
        return {
          toolId: candidate.toolId,
          alpha: result.alpha,
          algorithm: result.algorithm,
          coldStart: result.coldStart,
        };
      }
      return {
        toolId: candidate.toolId,
        alpha: this.scoringConfig.defaults.alpha,
        algorithm: "none",
        coldStart: false,
      };
    });
  }

  private logCandidateTraces(
    candidates: Array<
      {
        toolId: string;
        semanticScore: number;
        graphScore: number;
        pageRank: number;
        adamicAdar: number;
        combinedScore: number;
      }
    >,
    alphas: CandidateAlpha[],
    intentText: string,
  ): void {
    const graphDensity = this.graphEngine.getGraphDensity();
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const a = alphas[i];
      this.algorithmTracer?.logTrace({
        algorithmName: "DAGSuggester",
        algorithmMode: "active_search",
        targetType: "tool",
        intent: intentText.substring(0, 200),
        signals: {
          semanticScore: c.semanticScore,
          pagerank: c.pageRank,
          graphDensity,
          spectralClusterMatch: false,
          localAlpha: a.alpha,
          alphaAlgorithm: a.algorithm as
            | "embeddings_hybrides"
            | "heat_diffusion"
            | "heat_hierarchical"
            | "bayesian"
            | "none",
          coldStart: a.coldStart,
        },
        params: {
          alpha: a.alpha,
          reliabilityFactor: 1.0,
          structuralBoost: this.scoringConfig.weights.candidateRanking.pagerank,
        },
        finalScore: c.combinedScore,
        thresholdUsed: this.scoringConfig.thresholds.dependencyThreshold,
        decision: "accepted",
      });

      const toolName = c.toolId.split("__").pop() ?? c.toolId;
      eventBus.emit({
        type: "algorithm.scored",
        source: "dag-suggester",
        payload: {
          itemId: c.toolId,
          itemName: toolName,
          itemType: "tool",
          intent: intentText.substring(0, 100),
          signals: {
            semanticScore: c.semanticScore,
            graphScore: c.graphScore,
            pagerank: c.pageRank,
            adamicAdar: c.adamicAdar,
            localAlpha: a.alpha,
          },
          finalScore: c.combinedScore,
          threshold: this.scoringConfig.thresholds.dependencyThreshold,
          decision: "accepted",
        },
      });
    }
  }

  private computeClusterBoostsForCapabilities(
    contextTools: string[],
  ): { boosts: Map<string, number>; spectralClustering: SpectralClusteringManager | null } {
    if (!this.capabilityStore) {
      return { boosts: new Map(), spectralClustering: this.spectralClustering };
    }

    // This is a simplified version - in practice, you'd fetch capabilities first
    return computeClusterBoosts([], contextTools, {
      spectralClustering: this.spectralClustering,
      localAlphaCalculator: this.localAlphaCalculator,
      config: this.scoringConfig,
    });
  }

  private addCommunityPredictions(
    predictions: PredictedNode[],
    seenTools: Set<string>,
    lastToolId: string,
    executedTools: Set<string>,
    contextTools: string[],
    episodeStats: EpisodeStatsMap,
  ): void {
    const communityMembers = this.graphEngine.findCommunityMembers(lastToolId);
    for (const memberId of communityMembers.slice(0, this.scoringConfig.limits.communityMembers)) {
      if (
        seenTools.has(memberId) || executedTools.has(memberId) || isDangerousOperation(memberId)
      ) continue;

      const pageRank = this.graphEngine.getPageRank(memberId);
      const edgeData = this.graphEngine.getEdgeData(lastToolId, memberId);
      const aaScore = this.graphEngine.adamicAdarBetween(lastToolId, memberId);
      const baseConfidence = calculateCommunityConfidence(
        pageRank,
        edgeData?.weight ?? null,
        aaScore,
        this.scoringConfig,
      );

      const alphaResult = applyLocalAlpha(
        baseConfidence,
        memberId,
        "tool",
        contextTools,
        this.localAlphaCalculator,
        this.scoringConfig,
      );
      const adjusted = adjustConfidenceFromEpisodes(
        alphaResult.confidence,
        memberId,
        episodeStats,
        this.scoringConfig,
      );
      if (!adjusted) continue;

      predictions.push({
        toolId: memberId,
        confidence: adjusted.confidence,
        reasoning: `Same community as ${lastToolId} (PageRank: ${(pageRank * 100).toFixed(1)}%, α=${
          alphaResult.alpha.toFixed(2)
        })`,
        source: "community",
      });
      seenTools.add(memberId);
    }
  }

  private addCooccurrencePredictions(
    predictions: PredictedNode[],
    seenTools: Set<string>,
    lastToolId: string,
    executedTools: Set<string>,
    contextTools: string[],
    episodeStats: EpisodeStatsMap,
  ): void {
    const neighbors = this.graphEngine.getNeighbors(lastToolId, "out");
    for (const neighborId of neighbors) {
      if (
        seenTools.has(neighborId) || executedTools.has(neighborId) ||
        isDangerousOperation(neighborId)
      ) continue;

      const edgeData = this.graphEngine.getEdgeData(lastToolId, neighborId);
      const recencyBoost = executedTools.has(neighborId)
        ? this.scoringConfig.cooccurrence.recencyBoost
        : 0.0;
      const baseConfidence = calculateCooccurrenceConfidence(
        edgeData?.weight ?? null,
        edgeData?.count ?? 0,
        recencyBoost,
        this.scoringConfig,
      );

      const alphaResult = applyLocalAlpha(
        baseConfidence,
        neighborId,
        "tool",
        contextTools,
        this.localAlphaCalculator,
        this.scoringConfig,
      );
      const adjusted = adjustConfidenceFromEpisodes(
        alphaResult.confidence,
        neighborId,
        episodeStats,
        this.scoringConfig,
      );
      if (!adjusted) continue;

      predictions.push({
        toolId: neighborId,
        confidence: adjusted.confidence,
        reasoning: `Historical co-occurrence (60%) + Community (30%) + Recency (${
          (recencyBoost * 100).toFixed(0)
        }%) + α=${alphaResult.alpha.toFixed(2)}`,
        source: "co-occurrence",
      });
      seenTools.add(neighborId);
    }
  }

  private validateDAGNoCycles(dag: DAGStructure): void {
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const task of dag.tasks) {
      inDegree.set(task.id, task.dependsOn.length);
      for (const dep of task.dependsOn) {
        if (!adjList.has(dep)) adjList.set(dep, []);
        adjList.get(dep)!.push(task.id);
      }
    }

    const queue: string[] = [];
    for (const [taskId, degree] of inDegree.entries()) {
      if (degree === 0) queue.push(taskId);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);
      for (const neighbor of adjList.get(current) || []) {
        const newDegree = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    if (sorted.length !== dag.tasks.length) {
      throw new Error(
        `Cycle detected: topological sort produced ${sorted.length} tasks, expected ${dag.tasks.length}`,
      );
    }
  }
}
