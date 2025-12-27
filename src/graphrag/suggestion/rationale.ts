/**
 * Rationale Generation Module
 *
 * Extracted from dag-suggester.ts for generating human-readable explanations
 * of DAG suggestions and dependency paths.
 *
 * @module graphrag/suggestion/rationale
 */

import type { DagScoringConfig } from "../dag-scoring-config.ts";
import type { DependencyPath } from "../types.ts";

/**
 * Candidate with scoring information for rationale generation
 */
export interface RationaleCandidate {
  toolId: string;
  score: number;
  semanticScore: number;
  graphScore: number;
  pageRank: number;
}

/**
 * Explain a dependency path
 *
 * @param path - Array of tool IDs representing the path
 * @returns Human-readable explanation
 */
export function explainPath(path: string[]): string {
  if (path.length === 2) {
    return `Direct dependency: ${path[0]} → ${path[1]}`;
  } else {
    const intermediate = path.slice(1, -1).join(" → ");
    return `Transitive: ${path[0]} → ${intermediate} → ${path[path.length - 1]}`;
  }
}

/**
 * Generate rationale for hybrid search candidates (ADR-022)
 *
 * Includes both semantic and graph contributions in the explanation.
 *
 * @param candidates - Ranked candidates with hybrid scores
 * @param dependencyPaths - Extracted dependency paths
 * @param config - Scoring configuration
 * @returns Rationale text
 */
export function generateRationaleHybrid(
  candidates: RationaleCandidate[],
  dependencyPaths: DependencyPath[],
  config: DagScoringConfig,
): string {
  if (candidates.length === 0) {
    return "No candidates found.";
  }

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
  if (topTool.pageRank > config.weights.pagerankRationaleThreshold) {
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
 * Generate prediction reasoning string
 *
 * @param source - Prediction source type
 * @param details - Additional details for the reasoning
 * @returns Human-readable reasoning string
 */
export function generatePredictionReasoning(
  source: "community" | "co-occurrence" | "capability" | "alternative",
  details: {
    lastToolId?: string;
    pageRank?: number;
    alpha?: number;
    overlapScore?: number;
    clusterBoost?: number;
    successRate?: number;
    recencyBoost?: number;
    matchedCapabilityName?: string;
  },
): string {
  switch (source) {
    case "community":
      return `Same community as ${details.lastToolId} (PageRank: ${
        ((details.pageRank ?? 0) * 100).toFixed(1)
      }%, α=${(details.alpha ?? 0.75).toFixed(2)})`;

    case "co-occurrence":
      return `Historical co-occurrence (60%) + Community (30%) + Recency (${
        ((details.recencyBoost ?? 0) * 100).toFixed(0)
      }%) + α=${(details.alpha ?? 0.75).toFixed(2)}`;

    case "capability":
      return `Capability matches context (${
        ((details.overlapScore ?? 0) * 100).toFixed(0)
      }% overlap${
        (details.clusterBoost ?? 0) > 0
          ? `, +${((details.clusterBoost ?? 0) * 100).toFixed(0)}% cluster boost`
          : ""
      }, α=${(details.alpha ?? 0.75).toFixed(2)})`;

    case "alternative":
      return `Alternative to ${details.matchedCapabilityName ?? "capability"} (${
        ((details.successRate ?? 0) * 100).toFixed(0)
      }% success rate)`;

    default:
      return "Unknown prediction source";
  }
}
