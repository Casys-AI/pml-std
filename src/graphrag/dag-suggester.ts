/**
 * DAG Suggester
 *
 * Combines vector search and graph algorithms to suggest optimal DAG structures
 * for workflow execution.
 *
 * @module graphrag/dag-suggester
 */

import * as log from "@std/log";
import type { VectorSearch } from "../vector/search.ts";
import type { GraphRAGEngine } from "./graph-engine.ts";
import type { EpisodicMemoryStore } from "../learning/episodic-memory-store.ts";
import type { CapabilityMatcher } from "../capabilities/matcher.ts";
import type { Capability, CapabilityMatch } from "../capabilities/types.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import { type ClusterableCapability, SpectralClusteringManager } from "./spectral-clustering.ts";
import { LocalAlphaCalculator, type AlphaMode, type NodeType } from "./local-alpha.ts";
import type {
  CompletedTask,
  DAGStructure,
  DependencyPath,
  PredictedNode,
  SuggestedDAG,
  WorkflowIntent,
  WorkflowPredictionState,
} from "./types.ts";
// Story 7.6: Algorithm tracing (ADR-039)
import type { AlgorithmTracer } from "../telemetry/algorithm-tracer.ts";
// Story 7.6: EventBus for real-time tracing UI
import { eventBus } from "../events/mod.ts";

/**
 * DAG Suggester
 *
 * Orchestrates vector search for semantic candidate selection and graph algorithms
 * for dependency inference and DAG construction.
 */
export class DAGSuggester {
  private episodicMemory: EpisodicMemoryStore | null = null; // Story 4.1e - Episodic memory integration
  private capabilityMatcher: CapabilityMatcher | null = null; // Story 7.3a - Capability matching
  private capabilityStore: CapabilityStore | null = null; // Story 7.4 - Strategic discovery
  private spectralClustering: SpectralClusteringManager | null = null; // Story 7.4 - Cluster boost
  private algorithmTracer: AlgorithmTracer | null = null; // Story 7.6 - Algorithm tracing
  private localAlphaCalculator: LocalAlphaCalculator | null = null; // ADR-048 - Local adaptive alpha

  constructor(
    private graphEngine: GraphRAGEngine,
    private vectorSearch: VectorSearch,
    capabilityMatcher?: CapabilityMatcher,
    capabilityStore?: CapabilityStore,
  ) {
    this.capabilityMatcher = capabilityMatcher || null;
    this.capabilityStore = capabilityStore || null;
  }

  /**
   * Set capability store for strategic discovery (Story 7.4)
   *
   * Enables context-based capability search in DAG suggestions.
   *
   * @param store - CapabilityStore instance
   */
  setCapabilityStore(store: CapabilityStore): void {
    this.capabilityStore = store;
    log.debug("[DAGSuggester] Capability store configured for strategic discovery");
  }

  /**
   * Get GraphRAGEngine instance for feedback loop (Story 2.5-3 Task 4)
   *
   * Exposes GraphRAGEngine to allow ControlledExecutor to call
   * updateFromExecution() after workflow completion.
   *
   * @returns GraphRAGEngine instance
   */
  getGraphEngine(): GraphRAGEngine {
    return this.graphEngine;
  }

  /**
   * Set episodic memory store for learning-enhanced predictions (Story 4.1e)
   *
   * Enables DAGSuggester to query historical episodes and adjust confidence
   * based on past success/failure patterns. Optional dependency with graceful
   * degradation when not set.
   *
   * @param store - EpisodicMemoryStore instance
   */
  setEpisodicMemoryStore(store: EpisodicMemoryStore): void {
    this.episodicMemory = store;
    log.debug("[DAGSuggester] Episodic memory enabled for learning-enhanced predictions");
  }

  /**
   * Set capability matcher (Story 7.3a)
   *
   * Allows injecting matcher after construction if needed.
   *
   * @param matcher - CapabilityMatcher instance
   */
  setCapabilityMatcher(matcher: CapabilityMatcher): void {
    this.capabilityMatcher = matcher;
    log.debug("[DAGSuggester] Capability matching enabled");
  }

  /**
   * Set algorithm tracer (Story 7.6 - ADR-039)
   *
   * Enables tracing of predictNextNodes() and suggestDAG() decisions.
   *
   * @param tracer - AlgorithmTracer instance
   */
  setAlgorithmTracer(tracer: AlgorithmTracer): void {
    this.algorithmTracer = tracer;
    log.debug("[DAGSuggester] Algorithm tracing enabled");
  }

  /**
   * Set local alpha calculator (ADR-048)
   *
   * Enables local adaptive alpha for passive suggestions.
   * The calculator uses different algorithms based on mode and node type.
   *
   * @param calculator - LocalAlphaCalculator instance
   */
  setLocalAlphaCalculator(calculator: LocalAlphaCalculator): void {
    this.localAlphaCalculator = calculator;
    log.debug("[DAGSuggester] Local adaptive alpha enabled");
  }

  /**
   * Get local alpha calculator (for GraphRAGEngine integration)
   */
  getLocalAlphaCalculator(): LocalAlphaCalculator | null {
    return this.localAlphaCalculator;
  }

  /**
   * Get capability PageRanks from SpectralClusteringManager (Story 8.2)
   *
   * Used by HypergraphBuilder to size capability nodes by importance.
   * Returns empty map if spectral clustering not initialized.
   *
   * @returns Map of capability ID to PageRank score (0-1)
   */
  getCapabilityPageranks(): Map<string, number> {
    if (!this.spectralClustering) {
      return new Map();
    }
    return this.spectralClustering.getAllPageRanks();
  }

  /**
   * Search for capabilities matching an intent (Active Search - Story 7.3a)
   *
   * Delegates to CapabilityMatcher helper for logic (Semantic * Reliability).
   *
   * @param intent - User intent
   * @returns Best capability match or null
   */
  async searchCapabilities(intent: string): Promise<CapabilityMatch | null> {
    if (!this.capabilityMatcher) {
      log.debug("[DAGSuggester] searchCapabilities called but CapabilityMatcher not configured");
      return null;
    }
    return await this.capabilityMatcher.findMatch(intent);
  }

  /**
   * Suggest DAG structure for a given workflow intent (ADR-022: Hybrid Search)
   *
   * Process:
   * 1. Hybrid search for candidates (semantic + graph relatedness)
   * 2. Rank by finalScore (already combines semantic + graph)
   * 3. Boost by PageRank for importance
   * 4. Build DAG using graph topology
   * 5. Calculate confidence score
   * 6. Find alternative tools from same community
   *
   * @param intent - Workflow intent with natural language description
   * @returns Suggested DAG with confidence, rationale, and alternatives, or null if confidence too low
   */
  async suggestDAG(intent: WorkflowIntent): Promise<SuggestedDAG | null> {
    try {
      // ADR-022: Use hybrid search (semantic + graph) instead of pure vector search
      // This helps discover intermediate tools that are logically necessary but not
      // explicitly mentioned in the intent (e.g., finding npm_install between git_clone and deploy)
      const contextTools = intent.toolsConsidered || [];
      const hybridCandidates = await this.graphEngine.searchToolsHybrid(
        this.vectorSearch,
        intent.text,
        10, // top-10 candidates
        contextTools,
        false, // no related tools needed here
      );

      if (hybridCandidates.length === 0) {
        log.info(`No candidates found for intent: "${intent.text}"`);
        return null;
      }

      // 2. Rank by hybrid finalScore + PageRank boost
      const rankedCandidates = hybridCandidates
        .map((c) => {
          // Compute max Adamic-Adar score vs context tools
          let maxAdamicAdar = 0;
          for (const ctxTool of contextTools) {
            const aa = this.graphEngine.adamicAdarBetween(c.toolId, ctxTool);
            if (aa > maxAdamicAdar) maxAdamicAdar = aa;
          }
          return {
            toolId: c.toolId,
            serverId: c.serverId,
            toolName: c.toolName,
            score: c.finalScore, // Use hybrid finalScore as base
            semanticScore: c.semanticScore,
            graphScore: c.graphScore,
            pageRank: this.graphEngine.getPageRank(c.toolId),
            adamicAdar: Math.min(maxAdamicAdar / 2, 1.0), // Normalize to 0-1
            schema: c.schema,
          };
        })
        // Combine finalScore with PageRank: 80% finalScore + 20% PageRank
        .map((c) => ({
          ...c,
          combinedScore: c.score * 0.8 + c.pageRank * 0.2,
        }))
        .sort((a, b) => b.combinedScore - a.combinedScore)
        .slice(0, 5);

      log.debug(
        `Ranked candidates (hybrid+PageRank): ${
          rankedCandidates.map((c) =>
            `${c.toolId} (final=${c.score.toFixed(2)}, PR=${c.pageRank.toFixed(3)})`
          ).join(", ")
        }`,
      );

      // ADR-048: Calculate local alpha for each candidate
      const graphDensity = this.graphEngine.getGraphDensity();
      const candidateAlphas: Array<{ toolId: string; alpha: number; algorithm: string; coldStart: boolean }> = [];

      for (const candidate of rankedCandidates) {
        if (this.localAlphaCalculator) {
          const alphaResult = this.localAlphaCalculator.getLocalAlphaWithBreakdown(
            "active",
            candidate.toolId,
            "tool",
            contextTools,
          );
          candidateAlphas.push({
            toolId: candidate.toolId,
            alpha: alphaResult.alpha,
            algorithm: alphaResult.algorithm,
            coldStart: alphaResult.coldStart,
          });
        } else {
          // Fallback to default alpha if no calculator
          candidateAlphas.push({
            toolId: candidate.toolId,
            alpha: 0.75,
            algorithm: "none",
            coldStart: false,
          });
        }
      }

      // Calculate average alpha for confidence calculation
      const avgAlpha = candidateAlphas.length > 0
        ? candidateAlphas.reduce((sum, c) => sum + c.alpha, 0) / candidateAlphas.length
        : 0.75;

      log.debug(`[suggestDAG] Average local alpha: ${avgAlpha.toFixed(2)} across ${candidateAlphas.length} candidates`);

      // Story 7.6: Log trace for each candidate in suggestDAG (fire-and-forget)
      for (let i = 0; i < rankedCandidates.length; i++) {
        const candidate = rankedCandidates[i];
        const alphaInfo = candidateAlphas[i];

        this.algorithmTracer?.logTrace({
          algorithmMode: "active_search",
          targetType: "tool",
          intent: intent.text.substring(0, 200),
          signals: {
            semanticScore: candidate.semanticScore,
            pagerank: candidate.pageRank,
            graphDensity,
            spectralClusterMatch: false, // N/A for tool selection
            // ADR-048: Local alpha signals
            localAlpha: alphaInfo.alpha,
            alphaAlgorithm: alphaInfo.algorithm as "embeddings_hybrides" | "heat_diffusion" | "heat_hierarchical" | "bayesian" | "none",
            coldStart: alphaInfo.coldStart,
          },
          params: {
            alpha: alphaInfo.alpha, // ADR-048: Use local alpha
            reliabilityFactor: 1.0, // No reliability filter for tools
            structuralBoost: 0.2, // PageRank contribution
          },
          finalScore: candidate.combinedScore,
          thresholdUsed: 0.5, // ADR-026 threshold
          decision: "accepted", // All top-5 candidates are accepted
        });

        // Story 7.6: Emit algorithm.scored event for real-time tracing UI
        // Extract tool name from toolId (format: server__tool_name)
        const toolName = candidate.toolId.split("__").pop() ?? candidate.toolId;
        eventBus.emit({
          type: "algorithm.scored",
          source: "dag-suggester",
          payload: {
            itemId: candidate.toolId,
            itemName: toolName,
            itemType: "tool",
            intent: intent.text.substring(0, 100),
            signals: {
              semanticScore: candidate.semanticScore,
              graphScore: candidate.graphScore,
              pagerank: candidate.pageRank,
              adamicAdar: candidate.adamicAdar,
              localAlpha: alphaInfo.alpha,
            },
            finalScore: candidate.combinedScore,
            threshold: 0.5,
            decision: "accepted",
          },
        });
      }

      // 3. Build DAG using graph topology (Graphology)
      const dagStructure = this.graphEngine.buildDAG(
        rankedCandidates.map((c) => c.toolId),
      );

      // Story 7.4: Strategic Discovery - Inject matching capabilities
      await this.injectMatchingCapabilities(dagStructure, rankedCandidates.map((c) => c.toolId));

      // 4. Extract dependency paths for explainability
      const dependencyPaths = this.extractDependencyPaths(rankedCandidates.map((c) => c.toolId));

      // 5. Calculate confidence (adjusted for hybrid search with local alpha - ADR-048)
      const { confidence, semanticScore, pageRankScore, pathStrength } = this
        .calculateConfidenceHybrid(
          rankedCandidates,
          dependencyPaths,
          avgAlpha,
        );

      log.info(
        `Confidence: ${confidence.toFixed(2)} (semantic: ${semanticScore.toFixed(2)}, pageRank: ${
          pageRankScore.toFixed(2)
        }, pathStrength: ${pathStrength.toFixed(2)}, avgAlpha: ${avgAlpha.toFixed(2)}) for intent: "${intent.text}"`,
      );

      // 6. Find alternatives from same community (Graphology)
      const alternatives = this.graphEngine
        .findCommunityMembers(rankedCandidates[0].toolId)
        .slice(0, 3);

      // 7. Generate rationale (updated for hybrid)
      const rationale = this.generateRationaleHybrid(rankedCandidates, dependencyPaths);

      // ADR-026: Never return null if we have valid candidates
      // Instead, return suggestion with warning for low confidence
      if (confidence < 0.50) {
        log.info(
          `Confidence below threshold (${
            confidence.toFixed(2)
          }), returning suggestion with warning`,
        );
        return {
          dagStructure,
          confidence,
          rationale,
          dependencyPaths,
          alternatives,
          warning:
            "Low confidence suggestion - graph is in cold start mode. Confidence may improve with usage.",
        };
      }

      return {
        dagStructure,
        confidence,
        rationale,
        dependencyPaths,
        alternatives,
      };
    } catch (error) {
      log.error(`DAG suggestion failed: ${error}`);
      return null;
    }
  }

  /**
   * Extract dependency paths for explainability
   *
   * Finds paths between tools and generates explanations for dependencies.
   *
   * @param toolIds - Array of tool IDs in the DAG
   * @returns Array of dependency paths with explanations
   */
  private extractDependencyPaths(toolIds: string[]): DependencyPath[] {
    const paths: DependencyPath[] = [];

    for (let i = 0; i < toolIds.length; i++) {
      for (let j = 0; j < i; j++) {
        const fromTool = toolIds[j];
        const toTool = toolIds[i];

        const path = this.graphEngine.findShortestPath(fromTool, toTool);

        if (path && path.length <= 4) {
          paths.push({
            from: fromTool,
            to: toTool,
            path: path,
            hops: path.length - 1,
            explanation: this.explainPath(path),
            confidence: this.calculatePathConfidence(path.length),
          });
        }
      }
    }

    return paths;
  }

  /**
   * Explain a dependency path
   *
   * @param path - Array of tool IDs representing the path
   * @returns Human-readable explanation
   */
  private explainPath(path: string[]): string {
    if (path.length === 2) {
      return `Direct dependency: ${path[0]} → ${path[1]}`;
    } else {
      const intermediate = path.slice(1, -1).join(" → ");
      return `Transitive: ${path[0]} → ${intermediate} → ${path[path.length - 1]}`;
    }
  }

  /**
   * Calculate path confidence based on hop count
   *
   * Direct paths (1 hop) have highest confidence, decreasing with distance.
   *
   * @param hops - Number of hops in the path
   * @returns Confidence score between 0 and 1
   */
  private calculatePathConfidence(hops: number): number {
    if (hops === 1) return 0.95;
    if (hops === 2) return 0.80;
    if (hops === 3) return 0.65;
    return 0.50;
  }

  // =============================================================================
  // Story 5.2 / ADR-022: Hybrid Search Support Methods
  // =============================================================================
  // NOTE: Legacy calculateConfidence() and generateRationale() removed (ADR-022)
  // Use calculateConfidenceHybrid() and generateRationaleHybrid() instead

  /**
   * Get adaptive weights for confidence calculation based on local alpha (ADR-048)
   *
   * Replaces global density-based approach (ADR-026) with local adaptive alpha.
   * Alpha indicates trust in graph signals:
   * - alpha = 0.5 → high trust in graph → use more graph weight
   * - alpha = 1.0 → low trust in graph → rely on semantic
   *
   * Weight formula (linear interpolation based on alpha):
   * - hybrid: 0.55 + (alpha - 0.5) * 0.60 → [0.55, 0.85]
   * - pageRank: 0.30 - (alpha - 0.5) * 0.50 → [0.05, 0.30]
   * - path: 0.15 - (alpha - 0.5) * 0.10 → [0.10, 0.15]
   *
   * @param avgAlpha - Average local alpha across candidates (0.5-1.0)
   * @returns Weight configuration for confidence calculation
   */
  private getAdaptiveWeightsFromAlpha(avgAlpha: number): { hybrid: number; pageRank: number; path: number } {
    // Clamp alpha to valid range
    const alpha = Math.max(0.5, Math.min(1.0, avgAlpha));
    const factor = (alpha - 0.5) * 2; // Normalize to 0-1 range

    // Linear interpolation: high alpha → trust semantic, low alpha → trust graph
    const hybrid = 0.55 + factor * 0.30;     // [0.55, 0.85]
    const pageRank = 0.30 - factor * 0.25;   // [0.05, 0.30]
    const path = 0.15 - factor * 0.05;       // [0.10, 0.15]

    log.debug(`[DAGSuggester] Adaptive weights from alpha=${alpha.toFixed(2)}: hybrid=${hybrid.toFixed(2)}, pageRank=${pageRank.toFixed(2)}, path=${path.toFixed(2)}`);

    return { hybrid, pageRank, path };
  }

  /**
   * Calculate confidence for hybrid search candidates (ADR-022, ADR-048)
   *
   * Uses the already-computed hybrid finalScore which includes both semantic and graph scores.
   * This provides a more accurate confidence since graph context is already factored in.
   *
   * ADR-048: Uses adaptive weights based on local alpha (replaces ADR-026 global density).
   *
   * @param candidates - Ranked candidates with hybrid scores
   * @param dependencyPaths - Extracted dependency paths
   * @param avgAlpha - Average local alpha across candidates (0.5-1.0)
   * @returns Confidence breakdown
   */
  private calculateConfidenceHybrid(
    candidates: Array<{
      score: number;
      semanticScore: number;
      graphScore: number;
      pageRank: number;
      combinedScore: number;
    }>,
    dependencyPaths: DependencyPath[],
    avgAlpha: number = 0.75,
  ): { confidence: number; semanticScore: number; pageRankScore: number; pathStrength: number } {
    if (candidates.length === 0) {
      return { confidence: 0, semanticScore: 0, pageRankScore: 0, pathStrength: 0 };
    }

    // Use the hybrid finalScore as base (already includes semantic + graph)
    const hybridScore = candidates[0].score;
    const semanticScore = candidates[0].semanticScore;

    // PageRank score (average of top 3)
    const pageRankScore = candidates.slice(0, 3).reduce((sum, c) => sum + c.pageRank, 0) /
      Math.min(3, candidates.length);

    // Path strength (average confidence of all paths)
    const pathStrength = dependencyPaths.length > 0
      ? dependencyPaths.reduce((sum, p) => sum + (p.confidence || 0.5), 0) / dependencyPaths.length
      : 0.5;

    // ADR-048: Use adaptive weights based on local alpha
    const weights = this.getAdaptiveWeightsFromAlpha(avgAlpha);
    const confidence = hybridScore * weights.hybrid + pageRankScore * weights.pageRank +
      pathStrength * weights.path;

    return { confidence, semanticScore, pageRankScore, pathStrength };
  }

  /**
   * Generate rationale for hybrid search candidates (ADR-022)
   *
   * Includes both semantic and graph contributions in the explanation.
   *
   * @param candidates - Ranked candidates with hybrid scores
   * @param dependencyPaths - Extracted dependency paths
   * @returns Rationale text
   */
  private generateRationaleHybrid(
    candidates: Array<{
      toolId: string;
      score: number;
      semanticScore: number;
      graphScore: number;
      pageRank: number;
    }>,
    dependencyPaths: DependencyPath[],
  ): string {
    const topTool = candidates[0];
    const parts: string[] = [];

    // Hybrid match (main score)
    parts.push(`Based on hybrid search (${(topTool.score * 100).toFixed(0)}%)`);

    // Semantic contribution
    if (topTool.semanticScore > 0) {
      parts.push(`semantic: ${(topTool.semanticScore * 100).toFixed(0)}%`);
    }

    // Graph contribution
    if (topTool.graphScore > 0) {
      parts.push(`graph: ${(topTool.graphScore * 100).toFixed(0)}%`);
    }

    // PageRank importance
    if (topTool.pageRank > 0.01) {
      parts.push(`PageRank: ${(topTool.pageRank * 100).toFixed(1)}%`);
    }

    // Dependency paths
    if (dependencyPaths.length > 0) {
      const directDeps = dependencyPaths.filter((p) => p.hops === 1).length;
      parts.push(`${dependencyPaths.length} deps (${directDeps} direct)`);
    }

    return parts.join(", ") + ".";
  }

  /**
   * Replan DAG by incorporating new tools from GraphRAG (Story 2.5-3 Task 3)
   *
   * Called during runtime when agent discovers new requirements.
   * Queries GraphRAG for relevant tools and merges them into existing DAG.
   *
   * Flow:
   * 1. Query GraphRAG vector search for new requirement
   * 2. Rank tools by PageRank importance
   * 3. Build new DAG nodes from top-k tools
   * 4. Merge with existing DAG (preserve completed layers)
   * 5. Validate no cycles introduced
   *
   * Performance target: <200ms P95
   *
   * @param currentDAG - Current DAG structure
   * @param context - Replanning context (completed tasks, new requirement, etc.)
   * @returns Augmented DAG structure with new nodes
   */
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
      log.info(
        `Replanning DAG with new requirement: "${context.newRequirement}"`,
      );

      // 1. Query GraphRAG vector search for relevant tools
      const candidates = await this.vectorSearch.searchTools(
        context.newRequirement,
        5, // Top-5 candidates
        0.5, // Lower threshold for replanning (more permissive)
      );

      if (candidates.length === 0) {
        log.warn("No relevant tools found for replanning requirement");
        // Return current DAG unchanged
        return currentDAG;
      }

      // 2. Rank by PageRank importance
      const rankedCandidates = candidates
        .map((c) => ({
          ...c,
          pageRank: this.graphEngine.getPageRank(c.toolId),
        }))
        .sort((a, b) => b.pageRank - a.pageRank)
        .slice(0, 3); // Top-3 for replanning

      log.debug(
        `Ranked replan candidates: ${
          rankedCandidates.map((c) => `${c.toolId} (PR: ${c.pageRank.toFixed(3)})`).join(", ")
        }`,
      );

      // 3. Build new tasks from candidates
      const existingTaskIds = currentDAG.tasks.map((t) => t.id);
      const newTasks = rankedCandidates.map((candidate, idx) => {
        const newTaskId = `replan_task_${existingTaskIds.length + idx}`;

        // Infer dependencies from context (completed tasks provide outputs)
        const dependsOn: string[] = [];

        // Simple heuristic: new tasks depend on last successful task
        const lastSuccessfulTask = context.completedTasks
          .filter((t) => t.status === "success")
          .slice(-1)[0];

        if (lastSuccessfulTask) {
          dependsOn.push(lastSuccessfulTask.taskId);
        }

        return {
          id: newTaskId,
          tool: candidate.toolId,
          arguments: context.availableContext || {},
          dependsOn: dependsOn,
        };
      });

      // 4. Merge new tasks with existing DAG
      const augmentedDAG: DAGStructure = {
        tasks: [...currentDAG.tasks, ...newTasks],
      };

      // 5. Validate no cycles introduced
      // Simple cycle detection: topological sort should succeed
      try {
        this.validateDAGNoCycles(augmentedDAG);
      } catch (error) {
        log.error(`Cycle detected in replanned DAG: ${error}`);
        // Reject replan, return original DAG
        return currentDAG;
      }

      const replanTime = performance.now() - startTime;
      log.info(
        `✓ DAG replanned: added ${newTasks.length} new tasks (${replanTime.toFixed(1)}ms)`,
      );

      return augmentedDAG;
    } catch (error) {
      log.error(`DAG replanning failed: ${error}`);
      // Graceful degradation: return current DAG unchanged
      return currentDAG;
    }
  }

  // =============================================================================
  // Story 3.5-1: Speculative Execution - predictNextNodes()
  // =============================================================================

  /**
   * Dangerous operations blacklist - never speculate on these (ADR-006)
   */
  private static readonly DANGEROUS_OPERATIONS = [
    "delete",
    "remove",
    "deploy",
    "payment",
    "send_email",
    "execute_shell",
    "drop",
    "truncate",
    "transfer",
    "admin",
  ];

  /**
   * Predict next likely tools based on workflow state (Story 3.5-1)
   *
   * Uses GraphRAG community detection, co-occurrence patterns, and PageRank
   * to predict which tools are likely to be requested next.
   *
   * Process:
   * 1. Get last completed tool from workflow state
   * 2. Query community members (Louvain algorithm)
   * 3. Query outgoing edges (co-occurrence patterns)
   * 4. Calculate confidence scores using:
   *    - Edge weight (historical co-occurrence)
   *    - PageRank (tool importance)
   *    - Observation count (pattern frequency)
   * 5. Filter dangerous operations
   * 6. Return sorted predictions
   *
   * Performance target: <50ms (AC #10)
   *
   * @param workflowState - Current workflow state with completed tasks
   * @param completedTasks - Alternative: Array of completed tasks
   * @returns Sorted array of predicted nodes (highest confidence first)
   */
  async predictNextNodes(
    workflowState: WorkflowPredictionState | null,
    completedTasks?: CompletedTask[],
  ): Promise<PredictedNode[]> {
    const startTime = performance.now();

    try {
      // 1. Get completed tasks from either source
      const tasks = workflowState?.completedTasks ?? completedTasks ?? [];

      if (tasks.length === 0) {
        log.debug("[predictNextNodes] No completed tasks, returning empty predictions");
        return [];
      }

      // 2. Get last successful completed tool
      const successfulTasks = tasks.filter((t) => t.status === "success");
      if (successfulTasks.length === 0) {
        log.debug("[predictNextNodes] No successful tasks, returning empty predictions");
        return [];
      }

      const lastTask = successfulTasks[successfulTasks.length - 1];
      const lastToolId = lastTask.tool;

      log.debug(`[predictNextNodes] Predicting next tools after: ${lastToolId}`);

      // Story 4.1e: Retrieve relevant historical episodes for learning-enhanced predictions
      const episodes = await this.retrieveRelevantEpisodes(workflowState);
      const episodeStats = this.parseEpisodeStatistics(episodes);

      if (episodeStats.size > 0) {
        log.debug(
          `[predictNextNodes] Loaded episode statistics for ${episodeStats.size} tools from ${episodes.length} episodes`,
        );
      }

      const predictions: PredictedNode[] = [];
      const seenTools = new Set<string>();

      // Exclude tools already executed in this workflow
      const executedTools = new Set(tasks.map((t) => t.tool));

      // 3. Query community members (Louvain algorithm)
      const graphDensity = this.graphEngine.getGraphDensity();
      const contextToolsList = Array.from(executedTools);
      const communityMembers = this.graphEngine.findCommunityMembers(lastToolId);
      for (const memberId of communityMembers.slice(0, 5)) {
        if (seenTools.has(memberId) || executedTools.has(memberId)) continue;
        if (this.isDangerousOperation(memberId)) continue;

        const pageRank = this.graphEngine.getPageRank(memberId);
        const edgeData = this.graphEngine.getEdgeData(lastToolId, memberId);
        const aaScore = this.graphEngine.adamicAdarBetween(lastToolId, memberId);
        const baseConfidence = this.calculateCommunityConfidence(memberId, lastToolId, pageRank);

        // ADR-048: Apply local alpha adjustment
        const alphaResult = this.applyLocalAlpha(baseConfidence, memberId, "tool", contextToolsList);

        // Story 4.1e: Apply episodic learning adjustments
        const adjusted = this.adjustConfidenceFromEpisodes(alphaResult.confidence, memberId, episodeStats);
        if (!adjusted) continue; // Excluded due to high failure rate

        predictions.push({
          toolId: memberId,
          confidence: adjusted.confidence,
          reasoning: `Same community as ${lastToolId} (PageRank: ${(pageRank * 100).toFixed(1)}%, α=${alphaResult.alpha.toFixed(2)})`,
          source: "community",
        });
        seenTools.add(memberId);

        // Story 7.6: Log trace for community prediction (fire-and-forget)
        this.algorithmTracer?.logTrace({
          algorithmMode: "passive_suggestion",
          targetType: "tool",
          signals: {
            pagerank: pageRank,
            cooccurrence: edgeData?.weight ?? 0,
            adamicAdar: aaScore,
            graphDensity,
            spectralClusterMatch: false, // N/A for tool predictions
            // ADR-048: Local alpha signals
            localAlpha: alphaResult.alpha,
            alphaAlgorithm: alphaResult.algorithm as "heat_diffusion" | "heat_hierarchical" | "bayesian" | "none",
          },
          params: {
            alpha: alphaResult.alpha, // ADR-048: Local adaptive alpha
            reliabilityFactor: 1.0,
            structuralBoost: 0,
          },
          finalScore: adjusted.confidence,
          thresholdUsed: 0, // No threshold for passive suggestions
          decision: "accepted",
        });
      }

      // 4. Query outgoing edges (co-occurrence patterns)
      const neighbors = this.graphEngine.getNeighbors(lastToolId, "out");
      for (const neighborId of neighbors) {
        if (seenTools.has(neighborId) || executedTools.has(neighborId)) continue;
        if (this.isDangerousOperation(neighborId)) continue;

        const edgeData = this.graphEngine.getEdgeData(lastToolId, neighborId);

        // Calculate Recency Boost (Story 7.4 - ADR-038)
        // Check if tool was used in recent tasks of this workflow
        const recencyBoost = executedTools.has(neighborId) ? 0.10 : 0.0;

        const baseConfidence = this.calculateCooccurrenceConfidence(edgeData, recencyBoost);

        // ADR-048: Apply local alpha adjustment
        const alphaResult = this.applyLocalAlpha(baseConfidence, neighborId, "tool", contextToolsList);

        // Story 4.1e: Apply episodic learning adjustments
        const adjusted = this.adjustConfidenceFromEpisodes(
          alphaResult.confidence,
          neighborId,
          episodeStats,
        );
        if (!adjusted) continue; // Excluded due to high failure rate

        predictions.push({
          toolId: neighborId,
          confidence: adjusted.confidence,
          reasoning: `Historical co-occurrence (60%) + Community (30%) + Recency (${
            (recencyBoost * 100).toFixed(0)
          }%) + α=${alphaResult.alpha.toFixed(2)}`,
          source: "co-occurrence",
        });
        seenTools.add(neighborId);

        // Story 7.6: Log trace for co-occurrence prediction (fire-and-forget)
        this.algorithmTracer?.logTrace({
          algorithmMode: "passive_suggestion",
          targetType: "tool",
          signals: {
            cooccurrence: edgeData?.weight ?? 0,
            graphDensity,
            spectralClusterMatch: false, // N/A for tool predictions
            // ADR-048: Local alpha signals
            localAlpha: alphaResult.alpha,
            alphaAlgorithm: alphaResult.algorithm as "heat_diffusion" | "heat_hierarchical" | "bayesian" | "none",
          },
          params: {
            alpha: alphaResult.alpha, // ADR-048: Local adaptive alpha
            reliabilityFactor: 1.0,
            structuralBoost: recencyBoost,
          },
          finalScore: adjusted.confidence,
          thresholdUsed: 0, // No threshold for passive suggestions
          decision: "accepted",
        });
      }

      // NOTE: Adamic-Adar (2-hop) removed for passive suggestion (ADR-038)
      // It is too slow for this scope and dilutes the signal.
      // Kept for Active Hybrid Search only.

      // 5. Story 7.4: Query capabilities matching context tools
      // contextToolsList already defined above (line 751)
      const capabilityPredictions = await this.predictCapabilities(
        contextToolsList,
        seenTools,
        episodeStats,
      );
      predictions.push(...capabilityPredictions);

      // 6. Sort by confidence (descending)
      predictions.sort((a, b) => b.confidence - a.confidence);

      const elapsedMs = performance.now() - startTime;
      log.info(
        `[predictNextNodes] Generated ${predictions.length} predictions for ${lastToolId} (${
          elapsedMs.toFixed(1)
        }ms)`,
      );

      // Log top predictions
      if (predictions.length > 0) {
        const top3 = predictions.slice(0, 3).map((p) => `${p.toolId}:${p.confidence.toFixed(2)}`);
        log.debug(`[predictNextNodes] Top predictions: ${top3.join(", ")}`);
      }

      return predictions;
    } catch (error) {
      log.error(`[predictNextNodes] Failed: ${error}`);
      return [];
    }
  }

  /**
   * Check if a tool is a dangerous operation (never speculate)
   *
   * @param toolId - Tool identifier to check
   * @returns true if tool is dangerous
   */
  private isDangerousOperation(toolId: string): boolean {
    const lowerToolId = toolId.toLowerCase();
    return DAGSuggester.DANGEROUS_OPERATIONS.some((op) => lowerToolId.includes(op));
  }

  /**
   * Generate context hash for episodic memory retrieval (Story 4.1e)
   *
   * Consistent with EpisodicMemoryStore.hashContext() pattern.
   * Hash includes workflow type, domain, and complexity for context matching.
   *
   * @param workflowState - Current workflow state
   * @returns Context hash string
   */
  private getContextHash(workflowState: WorkflowPredictionState | null): string {
    if (!workflowState) return "no-state";

    // Extract from context field or use defaults
    const ctx = workflowState.context || {};
    const workflowType = (ctx.workflowType as string) || "unknown";
    const domain = (ctx.domain as string) || "general";
    const complexity = workflowState.completedTasks?.length.toString() || "0";

    return `workflowType:${workflowType}|domain:${domain}|complexity:${complexity}`;
  }

  /**
   * Retrieve relevant historical episodes for context (Story 4.1e Task 2)
   *
   * Queries episodic memory for similar past workflows based on context hash.
   * Returns empty array if episodic memory not configured (graceful degradation).
   *
   * @param workflowState - Current workflow state
   * @returns Array of relevant episodic events
   */
  private async retrieveRelevantEpisodes(
    workflowState: WorkflowPredictionState | null,
  ): Promise<
    Array<{
      id: string;
      event_type: string;
      data: {
        prediction?: { toolId: string; confidence: number; wasCorrect?: boolean };
        result?: { status: string };
      };
    }>
  > {
    if (!this.episodicMemory || !workflowState) return [];

    const startTime = performance.now();
    const contextHash = this.getContextHash(workflowState);

    try {
      const ctx = workflowState.context || {};
      const context = {
        workflowType: (ctx.workflowType as string) || "unknown",
        domain: (ctx.domain as string) || "general",
        complexity: workflowState.completedTasks?.length.toString() || "0",
      };

      const episodes = await this.episodicMemory.retrieveRelevant(context, {
        limit: 10,
        eventTypes: ["speculation_start", "task_complete"],
      });

      const retrievalTime = performance.now() - startTime;
      log.debug(
        `[DAGSuggester] Retrieved ${episodes.length} episodes for context ${contextHash} (${
          retrievalTime.toFixed(1)
        }ms)`,
      );

      return episodes;
    } catch (error) {
      log.error(`[DAGSuggester] Episode retrieval failed: ${error}`);
      return [];
    }
  }

  /**
   * Parse episodes to extract success/failure statistics per tool (Story 4.1e Task 2.3)
   *
   * Analyzes historical episodes to compute success rates for each tool.
   *
   * @param episodes - Retrieved episodic events
   * @returns Map of toolId to episode statistics
   */
  private parseEpisodeStatistics(
    episodes: Array<{
      id: string;
      event_type: string;
      data: {
        prediction?: { toolId: string; confidence: number; wasCorrect?: boolean };
        result?: { status: string };
      };
    }>,
  ): Map<
    string,
    {
      total: number;
      successes: number;
      failures: number;
      successRate: number;
      failureRate: number;
    }
  > {
    const stats = new Map<
      string,
      {
        total: number;
        successes: number;
        failures: number;
        successRate: number;
        failureRate: number;
      }
    >();

    for (const episode of episodes) {
      let toolId: string | undefined;
      let success = false;

      // Extract toolId and outcome from different event types
      if (episode.event_type === "speculation_start" && episode.data.prediction) {
        toolId = episode.data.prediction.toolId;
        success = episode.data.prediction.wasCorrect === true;
      } else if (episode.event_type === "task_complete" && episode.data.result) {
        // For task_complete events, we'd need task_id mapped to toolId (simplified here)
        // In practice, you might need to correlate with speculation_start events
        continue; // Skip for now, focus on speculation_start
      }

      if (!toolId) continue;

      const current = stats.get(toolId) || {
        total: 0,
        successes: 0,
        failures: 0,
        successRate: 0,
        failureRate: 0,
      };

      current.total++;
      if (success) {
        current.successes++;
      } else {
        current.failures++;
      }

      current.successRate = current.total > 0 ? current.successes / current.total : 0;
      current.failureRate = current.total > 0 ? current.failures / current.total : 0;

      stats.set(toolId, current);
    }

    return stats;
  }

  /**
   * Adjust confidence based on episodic memory patterns (Story 4.1e Tasks 3 & 4)
   *
   * Applies confidence boost for successful patterns and penalty for failures.
   * Returns null if tool should be excluded due to high failure rate.
   *
   * Algorithm (from Dev Notes):
   * - Boost: min(0.15, successRate * 0.20)
   * - Penalty: min(0.15, failureRate * 0.25)
   * - Exclusion: failureRate > 0.50 → exclude entirely
   *
   * @param baseConfidence - Base confidence from graph patterns
   * @param toolId - Tool being predicted
   * @param episodeStats - Episode statistics map
   * @returns Adjusted confidence (0-1) or null if excluded
   */
  private adjustConfidenceFromEpisodes(
    baseConfidence: number,
    toolId: string,
    episodeStats: Map<
      string,
      {
        total: number;
        successes: number;
        failures: number;
        successRate: number;
        failureRate: number;
      }
    >,
  ): { confidence: number; adjustment: number } | null {
    const stats = episodeStats.get(toolId);

    // No historical data: return base confidence unchanged
    if (!stats || stats.total === 0) {
      return { confidence: baseConfidence, adjustment: 0 };
    }

    // Task 4.4: Exclude if failure rate > 50%
    if (stats.failureRate > 0.50) {
      log.debug(
        `[DAGSuggester] Excluding ${toolId} due to high failure rate: ${
          (stats.failureRate * 100).toFixed(0)
        }% (${stats.failures}/${stats.total})`,
      );
      return null; // Exclude entirely
    }

    // Task 3.2: Calculate boost for successful patterns
    const boost = Math.min(0.15, stats.successRate * 0.20);

    // Task 4.2: Calculate penalty for failed patterns
    const penalty = Math.min(0.15, stats.failureRate * 0.25);

    // Net adjustment
    const adjustment = boost - penalty;

    // Task 3.3 & 4.3: Apply adjustment with clamping
    const adjustedConfidence = Math.max(0, Math.min(1.0, baseConfidence + adjustment));

    // Task 3.4: Log adjustments for observability
    if (Math.abs(adjustment) > 0.01) {
      log.debug(
        `[DAGSuggester] Confidence adjusted for ${toolId}: ${baseConfidence.toFixed(2)} → ${
          adjustedConfidence.toFixed(2)
        } (boost: +${boost.toFixed(2)}, penalty: -${
          penalty.toFixed(2)
        }, stats: ${stats.successes}/${stats.total} success)`,
      );
    }

    return { confidence: adjustedConfidence, adjustment };
  }

  /**
   * Apply local alpha to adjust graph-based confidence (ADR-048)
   *
   * For passive suggestions, local alpha modulates how much we trust graph signals:
   * - alpha = 0.5 → full trust in graph → no adjustment
   * - alpha = 1.0 → low trust in graph → reduce confidence by 50%
   *
   * Formula: adjustedConfidence = baseConfidence * (1.5 - alpha)
   *
   * @param baseConfidence - Confidence from graph signals
   * @param targetId - Target node ID
   * @param nodeType - Type of node (tool, capability, meta)
   * @param contextNodes - Context nodes for heat calculation
   * @returns Object with adjusted confidence and alpha used
   */
  private applyLocalAlpha(
    baseConfidence: number,
    targetId: string,
    nodeType: NodeType,
    contextNodes: string[] = [],
  ): { confidence: number; alpha: number; algorithm: string } {
    // If no calculator configured, return unchanged
    if (!this.localAlphaCalculator) {
      return { confidence: baseConfidence, alpha: 0.75, algorithm: "none" };
    }

    const result = this.localAlphaCalculator.getLocalAlphaWithBreakdown(
      "passive",
      targetId,
      nodeType,
      contextNodes,
    );

    // Apply alpha adjustment: higher alpha = less trust in graph
    // graphTrustFactor ranges from 1.0 (alpha=0.5) to 0.5 (alpha=1.0)
    const graphTrustFactor = 1.5 - result.alpha;
    const adjustedConfidence = Math.min(0.95, baseConfidence * graphTrustFactor);

    log.debug(
      `[DAGSuggester] Local alpha applied: ${targetId} base=${baseConfidence.toFixed(2)} alpha=${result.alpha.toFixed(2)} → ${adjustedConfidence.toFixed(2)} (${result.algorithm})`,
    );

    return {
      confidence: adjustedConfidence,
      alpha: result.alpha,
      algorithm: result.algorithm,
    };
  }

  /**
   * Calculate confidence for community-based prediction
   *
   * @param toolId - Target tool
   * @param sourceToolId - Source tool (last executed)
   * @param pageRank - PageRank score of target tool
   * @returns Confidence score (0-1)
   */
  private calculateCommunityConfidence(
    toolId: string,
    sourceToolId: string,
    pageRank: number,
  ): number {
    // Base confidence for community membership: 0.40
    let confidence = 0.40;

    // Boost by PageRank (up to +0.20)
    confidence += Math.min(pageRank * 2, 0.20);

    // Boost if direct edge exists (historical pattern)
    const edgeData = this.graphEngine.getEdgeData(sourceToolId, toolId);
    if (edgeData) {
      confidence += Math.min(edgeData.weight * 0.25, 0.25);
    }

    // Boost by Adamic-Adar similarity (indirect patterns)
    const aaScore = this.graphEngine.adamicAdarBetween(sourceToolId, toolId);
    if (aaScore > 0) {
      confidence += Math.min(aaScore * 0.1, 0.10);
    }

    return Math.min(confidence, 0.95); // Cap at 0.95
  }

  /**
   * Calculate confidence for co-occurrence-based prediction
   *
   * @param edgeData - Edge attributes from GraphRAG
   * @param recencyBoost - Boost if tool was used recently (default: 0)
   * @returns Confidence score (0-1)
   */
  private calculateCooccurrenceConfidence(
    edgeData: { weight: number; count: number } | null,
    recencyBoost: number = 0,
  ): number {
    if (!edgeData) return 0.30;

    // Base: edge weight (confidence_score from DB) - Max 0.60 (ADR-038)
    let confidence = Math.min(edgeData.weight, 0.60);

    // Boost by observation count (diminishing returns) - Max 0.20
    // 1 observation: +0, 5: +0.10, 10: +0.15, 20+: +0.20
    const countBoost = Math.min(Math.log2(edgeData.count + 1) * 0.05, 0.20);
    confidence += countBoost;

    // Boost by recency - Max 0.10
    confidence += Math.min(recencyBoost, 0.10);

    return Math.min(confidence, 0.95); // Cap at 0.95
  }

  /**
   * Predict capabilities based on context tools (Story 7.4 AC#6)
   *
   * Uses CapabilityStore.searchByContext() to find capabilities
   * whose tools_used overlap with the current context.
   *
   * ADR-042 §4: Also suggests alternative capabilities for matched ones.
   *
   * @param contextTools - Tools currently executed in workflow
   * @param seenTools - Tools already in predictions (for deduplication)
   * @param episodeStats - Episode statistics for adjustment
   * @returns Array of PredictedNode with source="capability"
   */
  private async predictCapabilities(
    contextTools: string[],
    seenTools: Set<string>,
    episodeStats: Map<string, {
      total: number;
      successes: number;
      failures: number;
      successRate: number;
      failureRate: number;
    }>,
  ): Promise<PredictedNode[]> {
    if (!this.capabilityStore || contextTools.length === 0) {
      return [];
    }

    const predictions: PredictedNode[] = [];

    try {
      // Search for capabilities matching context tools
      const matches = await this.capabilityStore.searchByContext(contextTools, 5, 0.3);

      if (matches.length === 0) {
        return [];
      }

      // ADR-038: Compute spectral cluster boosts for Strategic Discovery
      const clusterBoosts = await this.computeClusterBoosts(
        matches.map((m) => m.capability),
        contextTools,
      );

      for (const match of matches) {
        const capability = match.capability;
        const capabilityToolId = `capability:${capability.id}`;

        // Skip if already seen (unlikely but safety check)
        if (seenTools.has(capabilityToolId)) continue;

        // ADR-038: Strategic Discovery uses MULTIPLICATIVE formula
        // discoveryScore = overlapScore * (1 + structuralBoost)
        const clusterBoost = clusterBoosts.get(capability.id) ?? 0;
        const discoveryScore = match.overlapScore * (1 + clusterBoost);

        // Scale to 0.4-0.85 confidence range (capabilities need confirmation)
        // discoveryScore is in [0, ~1.5], map to [0.4, 0.85]
        const baseConfidence = Math.min(0.85, 0.4 + (discoveryScore * 0.30));

        // ADR-048: Apply local alpha adjustment for capability
        const alphaResult = this.applyLocalAlpha(baseConfidence, capabilityToolId, "capability", contextTools);

        // Apply episodic learning adjustments
        const adjusted = this.adjustConfidenceFromEpisodes(
          alphaResult.confidence,
          capabilityToolId,
          episodeStats,
        );

        if (!adjusted) continue; // Excluded due to high failure rate

        predictions.push({
          toolId: capabilityToolId,
          confidence: adjusted.confidence,
          reasoning: `Capability matches context (${
            (match.overlapScore * 100).toFixed(0)
          }% overlap${
            clusterBoost > 0 ? `, +${(clusterBoost * 100).toFixed(0)}% cluster boost` : ""
          }, α=${alphaResult.alpha.toFixed(2)})`,
          source: "capability",
          capabilityId: capability.id,
        });

        // Story 7.6: Log trace for capability prediction (fire-and-forget)
        this.algorithmTracer?.logTrace({
          algorithmMode: "passive_suggestion",
          targetType: "capability",
          signals: {
            toolsOverlap: match.overlapScore,
            successRate: capability.successRate,
            graphDensity: this.graphEngine.getGraphDensity(),
            spectralClusterMatch: clusterBoost > 0,
            // ADR-048: Local alpha signals
            localAlpha: alphaResult.alpha,
            alphaAlgorithm: alphaResult.algorithm as "heat_diffusion" | "heat_hierarchical" | "bayesian" | "none",
          },
          params: {
            alpha: alphaResult.alpha, // ADR-048: Local adaptive alpha
            reliabilityFactor: 1.0,
            structuralBoost: clusterBoost,
          },
          finalScore: adjusted.confidence,
          thresholdUsed: 0.3, // Context search threshold
          decision: "accepted",
        });

        seenTools.add(capabilityToolId);

        // ADR-042 §4: Suggest alternative capabilities
        const alternativePredictions = await this.suggestAlternatives(
          capability,
          adjusted.confidence,
          seenTools,
          episodeStats,
        );
        predictions.push(...alternativePredictions);
      }

      if (predictions.length > 0) {
        log.debug(
          `[predictCapabilities] Found ${predictions.length} capability predictions (incl. alternatives)`,
        );
      }
    } catch (error) {
      log.error(`[predictCapabilities] Failed: ${error}`);
    }

    return predictions;
  }

  /**
   * Suggest alternative capabilities for a matched capability (ADR-042 §4)
   *
   * Uses `alternative` edges from capability_dependency table to find
   * interchangeable capabilities that respond to the same intent.
   *
   * @param matchedCapability - The primary matched capability
   * @param matchedScore - Score of the primary match
   * @param seenTools - Tools already in predictions (for deduplication)
   * @param episodeStats - Episode statistics for adjustment
   * @returns Array of PredictedNode with source="alternative"
   */
  private async suggestAlternatives(
    matchedCapability: Capability,
    matchedScore: number,
    seenTools: Set<string>,
    episodeStats: Map<string, {
      total: number;
      successes: number;
      failures: number;
      successRate: number;
      failureRate: number;
    }>,
  ): Promise<PredictedNode[]> {
    if (!this.capabilityStore) {
      return [];
    }

    const alternatives: PredictedNode[] = [];

    try {
      // Get both directions for 'alternative' edges (symmetric relationship)
      const deps = await this.capabilityStore.getDependencies(matchedCapability.id, "both");
      const alternativeEdges = deps.filter((d) => d.edgeType === "alternative");

      if (alternativeEdges.length === 0) {
        return [];
      }

      for (const alt of alternativeEdges) {
        // Determine the alternative capability ID (could be either from or to)
        const altCapId = alt.fromCapabilityId === matchedCapability.id
          ? alt.toCapabilityId
          : alt.fromCapabilityId;

        const altCapToolId = `capability:${altCapId}`;

        // Skip if already suggested
        if (seenTools.has(altCapToolId)) continue;

        // Fetch the alternative capability
        const altCap = await this.capabilityStore.findById(altCapId);
        if (!altCap) continue;

        // ADR-042: Only suggest alternatives with success rate > 0.7
        if (altCap.successRate <= 0.7) {
          log.debug(`[suggestAlternatives] Skipping ${altCapId} due to low success rate: ${altCap.successRate}`);
          continue;
        }

        // ADR-042: Score is 90% of matched capability's score (slight reduction)
        const baseConfidence = matchedScore * 0.9;

        // Apply episodic learning adjustments
        const adjusted = this.adjustConfidenceFromEpisodes(
          baseConfidence,
          altCapToolId,
          episodeStats,
        );

        if (!adjusted) continue; // Excluded due to high failure rate

        alternatives.push({
          toolId: altCapToolId,
          confidence: adjusted.confidence,
          reasoning: `Alternative to ${matchedCapability.name ?? matchedCapability.id.substring(0, 8)} (${
            (altCap.successRate * 100).toFixed(0)
          }% success rate)`,
          source: "capability",
          capabilityId: altCapId,
        });

        // Story 7.6: Log trace for alternative suggestion (fire-and-forget)
        this.algorithmTracer?.logTrace({
          algorithmMode: "passive_suggestion",
          targetType: "capability",
          signals: {
            successRate: altCap.successRate,
            graphDensity: this.graphEngine.getGraphDensity(),
            spectralClusterMatch: false,
          },
          params: {
            alpha: 0.9, // Alternative penalty factor
            reliabilityFactor: 1.0,
            structuralBoost: 0,
          },
          finalScore: adjusted.confidence,
          thresholdUsed: 0.7, // Alternative success rate threshold
          decision: "accepted",
        });

        seenTools.add(altCapToolId);
      }

      if (alternatives.length > 0) {
        log.debug(
          `[suggestAlternatives] Found ${alternatives.length} alternative capabilities for ${matchedCapability.id}`,
        );
      }
    } catch (error) {
      log.error(`[suggestAlternatives] Failed: ${error}`);
    }

    return alternatives;
  }

  // =============================================================================
  // Story 3.5-1: Agent Hints & Pattern Export (AC #12, #13)
  // =============================================================================

  /**
   * Register agent hint for graph bootstrap (Story 3.5-1 AC #12)
   *
   * Allows agents to hint expected tool sequences before patterns are learned.
   * Useful for:
   * - Initial bootstrap of new workflows
   * - Explicit knowledge injection
   * - Testing speculation behavior
   *
   * @param toToolId - Tool that typically follows
   * @param fromToolId - Tool that typically precedes
   * @param confidence - Optional confidence override (default: 0.60)
   */
  async registerAgentHint(
    toToolId: string,
    fromToolId: string,
    confidence: number = 0.60,
  ): Promise<void> {
    try {
      log.info(
        `[DAGSuggester] Registering agent hint: ${fromToolId} -> ${toToolId} (confidence: ${confidence})`,
      );

      // Add or update edge in graph
      await this.graphEngine.addEdge(fromToolId, toToolId, {
        weight: confidence,
        count: 1,
        source: "hint",
      });

      log.debug(`[DAGSuggester] Agent hint registered successfully`);
    } catch (error) {
      log.error(`[DAGSuggester] Failed to register agent hint: ${error}`);
      throw error;
    }
  }

  /**
   * Export learned patterns for portability (Story 3.5-1 AC #13)
   *
   * Returns all learned tool-to-tool patterns from the graph.
   * Useful for:
   * - Sharing patterns between instances
   * - Debugging speculation behavior
   * - Cold-start initialization
   *
   * @returns Array of learned patterns with metadata
   */
  exportLearnedPatterns(): Array<{
    from: string;
    to: string;
    weight: number;
    count: number;
    source: string;
  }> {
    const patterns: Array<{
      from: string;
      to: string;
      weight: number;
      count: number;
      source: string;
    }> = [];

    try {
      // Get all edges from graph
      const edges = this.graphEngine.getEdges();

      for (const { source: from, target: to, attributes } of edges) {
        patterns.push({
          from,
          to,
          weight: (attributes.weight as number) ?? 0.5,
          count: (attributes.count as number) ?? 1,
          source: (attributes.source as string) ?? "learned",
        });
      }

      log.info(`[DAGSuggester] Exported ${patterns.length} learned patterns`);
      return patterns;
    } catch (error) {
      log.error(`[DAGSuggester] Failed to export patterns: ${error}`);
      return [];
    }
  }

  /**
   * Import learned patterns (Story 3.5-1 AC #13)
   *
   * Imports patterns exported from another instance.
   * Useful for cold-start initialization.
   *
   * @param patterns - Patterns to import
   * @param mergeStrategy - How to handle existing patterns ("replace" | "merge")
   */
  async importLearnedPatterns(
    patterns: Array<{
      from: string;
      to: string;
      weight: number;
      count: number;
      source?: string;
    }>,
    mergeStrategy: "replace" | "merge" = "merge",
  ): Promise<number> {
    let imported = 0;

    for (const pattern of patterns) {
      try {
        const existingEdge = this.graphEngine.getEdgeData(pattern.from, pattern.to);

        if (existingEdge && mergeStrategy === "merge") {
          // Merge: Average weights, sum counts
          const newWeight = (existingEdge.weight + pattern.weight) / 2;
          const newCount = existingEdge.count + pattern.count;

          await this.graphEngine.addEdge(pattern.from, pattern.to, {
            weight: newWeight,
            count: newCount,
            source: "merged",
          });
        } else {
          // Replace or new edge
          await this.graphEngine.addEdge(pattern.from, pattern.to, {
            weight: pattern.weight,
            count: pattern.count,
            source: pattern.source ?? "imported",
          });
        }

        imported++;
      } catch (error) {
        log.error(
          `[DAGSuggester] Failed to import pattern ${pattern.from} -> ${pattern.to}: ${error}`,
        );
      }
    }

    log.info(`[DAGSuggester] Imported ${imported}/${patterns.length} patterns`);
    return imported;
  }

  /**
   * Validate DAG has no cycles using topological sort
   *
   * Throws error if cycle detected.
   *
   * @param dag - DAG structure to validate
   */
  private validateDAGNoCycles(dag: DAGStructure): void {
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    // Build adjacency list and in-degree map
    for (const task of dag.tasks) {
      inDegree.set(task.id, task.dependsOn.length);
      for (const dep of task.dependsOn) {
        if (!adjList.has(dep)) adjList.set(dep, []);
        adjList.get(dep)!.push(task.id);
      }
    }

    // Kahn's algorithm (topological sort)
    const queue: string[] = [];
    for (const [taskId, degree] of inDegree.entries()) {
      if (degree === 0) queue.push(taskId);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);

      const neighbors = adjList.get(current) || [];
      for (const neighbor of neighbors) {
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

  // =============================================================================
  // Story 7.4: Strategic Discovery - Mixed DAG (Tools + Capabilities)
  // =============================================================================

  /**
   * Inject matching capabilities into DAG (Story 7.4 AC#4, AC#5, AC#7)
   *
   * Process:
   * 1. Extract context tools from existing DAG tasks
   * 2. Search for capabilities with overlapping tools_used
   * 3. Apply spectral clustering boost if active cluster matches
   * 4. Create capability tasks and insert at appropriate layer
   * 5. Set dependencies based on tool overlap
   *
   * @param dag - DAG structure to augment (modified in place)
   * @param contextTools - Tools already in the DAG
   */
  private async injectMatchingCapabilities(
    dag: DAGStructure,
    contextTools: string[],
  ): Promise<void> {
    if (!this.capabilityStore || contextTools.length === 0) {
      return; // No capability store configured or no context
    }

    const startTime = performance.now();

    try {
      // 1. Search for capabilities matching context tools
      const matches = await this.capabilityStore.searchByContext(contextTools, 3, 0.3);

      if (matches.length === 0) {
        log.debug("[DAGSuggester] No matching capabilities for context tools");
        return;
      }

      log.debug(
        `[DAGSuggester] Found ${matches.length} matching capabilities for context`,
      );

      // 2. Initialize or update spectral clustering for boost calculation
      const clusterBoosts = await this.computeClusterBoosts(
        matches.map((m) => m.capability),
        contextTools,
      );

      // 3. Create capability tasks and insert into DAG
      for (const match of matches) {
        const capability = match.capability;
        const clusterBoost = clusterBoosts.get(capability.id) ?? 0;
        // ADR-038: Strategic Discovery uses MULTIPLICATIVE formula
        // finalScore = overlapScore * (1 + structuralBoost)
        // If overlap = 0, score = 0 (no suggestion) - this is intentional
        const finalScore = match.overlapScore * (1 + clusterBoost);

        // Skip low-scoring capabilities
        if (finalScore < 0.4) {
          log.debug(
            `[DAGSuggester] Skipping capability ${capability.id} (score: ${finalScore.toFixed(2)})`,
          );
          continue;
        }

        // 4. Create capability task
        const capabilityTask = this.createCapabilityTask(capability, dag, contextTools);

        // 5. Add to DAG
        dag.tasks.push(capabilityTask);

        log.info(
          `[DAGSuggester] Injected capability task ${capabilityTask.id} (overlap: ${
            match.overlapScore.toFixed(2)
          }, boost: ${clusterBoost.toFixed(2)})`,
        );
      }

      const elapsedMs = performance.now() - startTime;
      log.debug(
        `[DAGSuggester] Capability injection complete (${elapsedMs.toFixed(1)}ms)`,
      );
    } catch (error) {
      log.error(`[DAGSuggester] Capability injection failed: ${error}`);
      // Graceful degradation: continue without capabilities
    }
  }

  /**
   * Compute cluster boosts for capabilities (Story 7.4 AC#3, AC#8)
   *
   * Uses spectral clustering to identify the active cluster based on
   * context tools, then boosts capabilities in the same cluster.
   * Also applies HypergraphPageRank scoring for centrality-based boost.
   *
   * @param capabilities - Capabilities to evaluate
   * @param contextTools - Tools currently in use
   * @returns Map of capability_id to boost value (0 to ~0.65: cluster 0.5 + PageRank ~0.15)
   */
  private async computeClusterBoosts(
    capabilities: Capability[],
    contextTools: string[],
  ): Promise<Map<string, number>> {
    const boosts = new Map<string, number>();

    if (capabilities.length < 2 || contextTools.length < 2) {
      // Not enough data for meaningful clustering
      return boosts;
    }

    try {
      // Initialize spectral clustering if not already done
      if (!this.spectralClustering) {
        this.spectralClustering = new SpectralClusteringManager();
        // ADR-048: Sync to LocalAlphaCalculator on first init
        if (this.localAlphaCalculator) {
          this.localAlphaCalculator.setSpectralClustering(this.spectralClustering);
        }
      }

      // Collect all tools used by capabilities
      const allToolsUsed = new Set<string>(contextTools);
      for (const cap of capabilities) {
        const capTools = this.getCapabilityToolsUsed(cap);
        capTools.forEach((t) => allToolsUsed.add(t));
      }

      // Build clusterable capabilities
      const clusterableCapabilities: ClusterableCapability[] = capabilities.map((cap) => ({
        id: cap.id,
        toolsUsed: this.getCapabilityToolsUsed(cap),
      }));

      const toolsArray = Array.from(allToolsUsed);

      // Issue #7: Try to restore from cache first to avoid expensive O(n³) recomputation
      const cacheHit = this.spectralClustering.restoreFromCacheIfValid(
        toolsArray,
        clusterableCapabilities,
      );

      if (!cacheHit) {
        // Build bipartite matrix and compute clusters (expensive)
        this.spectralClustering.buildBipartiteMatrix(toolsArray, clusterableCapabilities);
        this.spectralClustering.computeClusters();

        // Compute PageRank and save to cache
        this.spectralClustering.computeHypergraphPageRank(clusterableCapabilities);
        this.spectralClustering.saveToCache(toolsArray, clusterableCapabilities);

        // ADR-048: Sync spectral clustering to LocalAlphaCalculator for Embeddings Hybrides
        if (this.localAlphaCalculator) {
          this.localAlphaCalculator.setSpectralClustering(this.spectralClustering);
        }
      }

      // Identify active cluster
      const activeCluster = this.spectralClustering.identifyActiveCluster(contextTools);

      if (activeCluster < 0) {
        log.debug("[DAGSuggester] No active cluster identified for boost");
        return boosts;
      }

      // Compute cluster boost for each capability
      for (const capData of clusterableCapabilities) {
        const clusterBoost = this.spectralClustering.getClusterBoost(capData, activeCluster);
        if (clusterBoost > 0) {
          boosts.set(capData.id, clusterBoost);
        }
      }

      // Story 7.4 AC#8: Apply HypergraphPageRank scoring for centrality boost
      // (PageRank is already computed, either fresh or from cache)
      for (const capData of clusterableCapabilities) {
        const prScore = this.spectralClustering.getPageRank(capData.id);
        if (prScore > 0) {
          const existingBoost = boosts.get(capData.id) ?? 0;
          // Weight PageRank at 30% (0.3 * prScore gives max ~0.15 additional boost)
          boosts.set(capData.id, existingBoost + prScore * 0.3);
        }
      }

      log.debug(
        `[DAGSuggester] Computed cluster + PageRank boosts for ${boosts.size} capabilities (active cluster: ${activeCluster}, cacheHit: ${cacheHit})`,
      );
    } catch (error) {
      log.error(`[DAGSuggester] Cluster boost computation failed: ${error}`);
    }

    return boosts;
  }

  /**
   * Extract tools_used from capability (Story 7.4)
   *
   * Returns the tools_used array from the capability, which is extracted
   * from dag_structure JSONB by CapabilityStore.rowToCapability().
   *
   * @param capability - Capability to extract from
   * @returns Array of tool IDs used by the capability
   */
  private getCapabilityToolsUsed(capability: Capability): string[] {
    return capability.toolsUsed ?? [];
  }

  /**
   * Create a capability task for DAG insertion (Story 7.4 AC#5)
   *
   * @param capability - Capability to convert to task
   * @param dag - Current DAG structure (for ID generation)
   * @param _contextTools - Context tools for dependency resolution (currently unused)
   * @returns Task with type="capability"
   */
  private createCapabilityTask(
    capability: Capability,
    dag: DAGStructure,
    _contextTools: string[],
  ): DAGStructure["tasks"][0] {
    const taskId = `cap_${capability.id.substring(0, 8)}_${dag.tasks.length}`;

    // Determine dependencies: find tasks that provide the capability's required tools
    const dependsOn: string[] = [];
    const capToolsUsed = this.getCapabilityToolsUsed(capability);

    for (const existingTask of dag.tasks) {
      // If existing task's tool is in capability's tools_used, add dependency
      if (capToolsUsed.includes(existingTask.tool)) {
        dependsOn.push(existingTask.id);
      }
    }

    // If no dependencies found, depend on the last tool task (sequential insertion)
    if (dependsOn.length === 0 && dag.tasks.length > 0) {
      const lastTask = dag.tasks[dag.tasks.length - 1];
      dependsOn.push(lastTask.id);
    }

    return {
      id: taskId,
      tool: capability.name ?? `capability_${capability.id.substring(0, 8)}`,
      type: "capability",
      capabilityId: capability.id,
      code: capability.codeSnippet,
      arguments: {},
      dependsOn,
    };
  }
}
