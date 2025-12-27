/**
 * SHGAT Feature Integration Module
 *
 * Integrates AdamicAdar and HeatDiffusion algorithms with SHGAT multi-head attention.
 * Provides functions to populate HypergraphFeatures and ToolGraphFeatures.
 *
 * @module graphrag/algorithms/shgat-features
 */

import { adamicAdarBetween, type AdamicAdarGraph, computeAdamicAdar } from "./adamic-adar.ts";
import type { HypergraphFeatures, ToolGraphFeatures } from "./shgat.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Graph interface for feature computation
 */
export interface FeatureGraph extends AdamicAdarGraph {
  nodes(): IterableIterator<string>;
  inNeighbors?(nodeId: string): string[];
  outNeighbors?(nodeId: string): string[];
}

/**
 * Hypergraph structure for capability features
 */
export interface Hypergraph {
  /** Map of capability ID → tool IDs in that capability */
  capabilities: Map<string, string[]>;
  /** Map of tool ID → capability IDs containing that tool */
  toolToCapabilities: Map<string, string[]>;
}

/**
 * Configuration for heat diffusion computation
 */
export interface HeatDiffusionConfig {
  /** Weight for intrinsic heat (node degree) */
  intrinsicWeight: number;
  /** Weight for neighbor propagation */
  neighborWeight: number;
  /** Decay factor for hierarchy propagation */
  hierarchyDecay: number;
}

const DEFAULT_HEAT_CONFIG: HeatDiffusionConfig = {
  intrinsicWeight: 0.6,
  neighborWeight: 0.4,
  hierarchyDecay: 0.8,
};

// ============================================================================
// AdamicAdar Integration
// ============================================================================

/**
 * Compute AdamicAdar scores for all tools in a graph
 *
 * Returns average AA score for each tool based on similarity to all other tools.
 * Used for Head 3 (Structure - AdamicAdar) in SHGAT.
 *
 * @param graph - Tool graph (Graphology-compatible)
 * @returns Map of toolId → normalized AA score (0-1)
 */
export function computeToolAdamicAdarScores(graph: FeatureGraph): Map<string, number> {
  const scores = new Map<string, number>();
  const nodeIds: string[] = [];

  for (const nodeId of graph.nodes()) {
    nodeIds.push(nodeId);
  }

  if (nodeIds.length === 0) return scores;

  // Compute AA for each node
  for (const nodeId of nodeIds) {
    const aaResults = computeAdamicAdar(graph, nodeId, nodeIds.length);
    // Average score across all similar nodes
    const avgScore = aaResults.length > 0
      ? aaResults.reduce((sum, r) => sum + r.score, 0) / aaResults.length
      : 0;
    scores.set(nodeId, avgScore);
  }

  // Normalize to 0-1 range
  const maxScore = Math.max(...scores.values(), 0.001);
  for (const [nodeId, score] of scores) {
    scores.set(nodeId, score / maxScore);
  }

  return scores;
}

/**
 * Compute AdamicAdar scores for capabilities based on shared tools
 *
 * Two capabilities are similar if they share tools (hyperedge intersection).
 * Score is weighted by tool rarity (inverse of how many capabilities use that tool).
 *
 * @param hypergraph - Hypergraph structure
 * @returns Map of capabilityId → normalized AA score (0-1)
 */
export function computeCapabilityAdamicAdarScores(hypergraph: Hypergraph): Map<string, number> {
  const scores = new Map<string, number>();
  const capIds = Array.from(hypergraph.capabilities.keys());

  if (capIds.length === 0) return scores;

  for (const capId of capIds) {
    const tools = hypergraph.capabilities.get(capId) || [];
    let totalScore = 0;

    // For each other capability, compute similarity via shared tools
    for (const otherCapId of capIds) {
      if (capId === otherCapId) continue;

      const otherTools = hypergraph.capabilities.get(otherCapId) || [];
      const sharedTools = tools.filter((t) => otherTools.includes(t));

      // Weighted by tool rarity (inverse of degree in bipartite graph)
      for (const tool of sharedTools) {
        const toolDegree = hypergraph.toolToCapabilities.get(tool)?.length || 1;
        if (toolDegree > 1) {
          totalScore += 1 / Math.log(toolDegree);
        }
      }
    }

    scores.set(capId, totalScore);
  }

  // Normalize to 0-1 range
  const maxScore = Math.max(...scores.values(), 0.001);
  for (const [capId, score] of scores) {
    scores.set(capId, score / maxScore);
  }

  return scores;
}

// ============================================================================
// Heat Diffusion Integration
// ============================================================================

/**
 * Compute heat diffusion scores for tools in a graph
 *
 * Heat is based on:
 * 1. Intrinsic heat: node degree / max degree
 * 2. Neighbor heat: average heat of neighbors
 *
 * Used for Head 5 (Temporal - HeatDiffusion) in SHGAT.
 *
 * @param graph - Tool graph (Graphology-compatible)
 * @param config - Heat diffusion configuration
 * @returns Map of toolId → heat score (0-1)
 */
export function computeToolHeatDiffusion(
  graph: FeatureGraph,
  config: HeatDiffusionConfig = DEFAULT_HEAT_CONFIG,
): Map<string, number> {
  const heatScores = new Map<string, number>();
  const nodeIds: string[] = [];

  for (const nodeId of graph.nodes()) {
    nodeIds.push(nodeId);
  }

  if (nodeIds.length === 0) return heatScores;

  // Find max degree for normalization
  let maxDegree = 1;
  for (const nodeId of nodeIds) {
    maxDegree = Math.max(maxDegree, graph.degree(nodeId));
  }

  // First pass: compute intrinsic heat
  const intrinsicHeat = new Map<string, number>();
  for (const nodeId of nodeIds) {
    const degree = graph.degree(nodeId);
    intrinsicHeat.set(nodeId, degree / maxDegree);
  }

  // Second pass: propagate heat from neighbors
  for (const nodeId of nodeIds) {
    const neighbors = graph.neighbors(nodeId);
    const neighborHeat = neighbors.length > 0
      ? neighbors.reduce((sum, n) => sum + (intrinsicHeat.get(n) || 0), 0) / neighbors.length
      : 0;

    const heat = config.intrinsicWeight * (intrinsicHeat.get(nodeId) || 0) +
      config.neighborWeight * neighborHeat;

    heatScores.set(nodeId, Math.min(1, heat));
  }

  return heatScores;
}

/**
 * Compute heat diffusion scores for capabilities based on tool heat
 *
 * Capability heat is aggregated from its constituent tools' heat,
 * weighted by tool importance in the capability.
 *
 * @param hypergraph - Hypergraph structure
 * @param toolHeat - Pre-computed tool heat scores
 * @param config - Heat diffusion configuration
 * @returns Map of capabilityId → heat score (0-1)
 */
export function computeCapabilityHeatDiffusion(
  hypergraph: Hypergraph,
  toolHeat: Map<string, number>,
  config: HeatDiffusionConfig = DEFAULT_HEAT_CONFIG,
): Map<string, number> {
  const heatScores = new Map<string, number>();

  for (const [capId, tools] of hypergraph.capabilities) {
    if (tools.length === 0) {
      heatScores.set(capId, 0);
      continue;
    }

    // Aggregate tool heat with position weighting (later tools are more important)
    let weightedSum = 0;
    let weightTotal = 0;

    for (let i = 0; i < tools.length; i++) {
      const weight = 1 + i * 0.5; // Position weight: 1.0, 1.5, 2.0, ...
      const heat = toolHeat.get(tools[i]) || 0;
      weightedSum += heat * weight;
      weightTotal += weight;
    }

    const capHeat = weightTotal > 0 ? weightedSum / weightTotal : 0;
    heatScores.set(capId, capHeat);
  }

  // Propagate between neighboring capabilities (shared tools)
  const propagatedHeat = new Map<string, number>();
  for (const [capId, baseHeat] of heatScores) {
    const tools = hypergraph.capabilities.get(capId) || [];
    const neighborCaps = new Set<string>();

    // Find neighbor capabilities (share at least one tool)
    for (const tool of tools) {
      const capsWithTool = hypergraph.toolToCapabilities.get(tool) || [];
      for (const neighborCap of capsWithTool) {
        if (neighborCap !== capId) {
          neighborCaps.add(neighborCap);
        }
      }
    }

    // Propagate heat from neighbors
    const neighborHeat = neighborCaps.size > 0
      ? Array.from(neighborCaps).reduce((sum, n) => sum + (heatScores.get(n) || 0), 0) /
        neighborCaps.size
      : 0;

    const propagated = config.intrinsicWeight * baseHeat +
      config.neighborWeight * neighborHeat * config.hierarchyDecay;

    propagatedHeat.set(capId, Math.min(1, propagated));
  }

  return propagatedHeat;
}

// ============================================================================
// Feature Population Functions
// ============================================================================

/**
 * Populate all HypergraphFeatures for capabilities
 *
 * Computes AdamicAdar and HeatDiffusion scores and merges with existing features.
 *
 * @param hypergraph - Hypergraph structure
 * @param existingFeatures - Existing features to merge with
 * @param toolHeat - Optional pre-computed tool heat (for efficiency)
 * @returns Map of capabilityId → complete HypergraphFeatures
 */
export function populateCapabilityFeatures(
  hypergraph: Hypergraph,
  existingFeatures: Map<string, Partial<HypergraphFeatures>>,
  toolHeat?: Map<string, number>,
): Map<string, HypergraphFeatures> {
  // Compute AdamicAdar scores
  const aaScores = computeCapabilityAdamicAdarScores(hypergraph);

  // Compute heat diffusion (use provided tool heat or create empty)
  const heat = toolHeat || new Map<string, number>();
  const heatScores = computeCapabilityHeatDiffusion(hypergraph, heat);

  // Merge with existing features
  const result = new Map<string, HypergraphFeatures>();

  for (const capId of hypergraph.capabilities.keys()) {
    const existing = existingFeatures.get(capId) || {};
    result.set(capId, {
      spectralCluster: existing.spectralCluster ?? 0,
      hypergraphPageRank: existing.hypergraphPageRank ?? 0.01,
      cooccurrence: existing.cooccurrence ?? 0,
      recency: existing.recency ?? 0,
      adamicAdar: aaScores.get(capId) ?? 0,
      heatDiffusion: heatScores.get(capId) ?? 0,
    });
  }

  return result;
}

/**
 * Populate all ToolGraphFeatures for tools
 *
 * Computes AdamicAdar and HeatDiffusion scores and merges with existing features.
 *
 * @param graph - Tool graph (Graphology-compatible)
 * @param existingFeatures - Existing features to merge with
 * @returns Map of toolId → complete ToolGraphFeatures
 */
export function populateToolFeatures(
  graph: FeatureGraph,
  existingFeatures: Map<string, Partial<ToolGraphFeatures>>,
): Map<string, ToolGraphFeatures> {
  // Compute AdamicAdar scores
  const aaScores = computeToolAdamicAdarScores(graph);

  // Compute heat diffusion
  const heatScores = computeToolHeatDiffusion(graph);

  // Merge with existing features
  const result = new Map<string, ToolGraphFeatures>();

  for (const nodeId of graph.nodes()) {
    const existing = existingFeatures.get(nodeId) || {};
    result.set(nodeId, {
      pageRank: existing.pageRank ?? 0.01,
      louvainCommunity: existing.louvainCommunity ?? 0,
      adamicAdar: aaScores.get(nodeId) ?? 0,
      cooccurrence: existing.cooccurrence ?? 0,
      recency: existing.recency ?? 0,
      heatDiffusion: heatScores.get(nodeId) ?? 0,
    });
  }

  return result;
}

/**
 * Build Hypergraph structure from capabilities
 *
 * @param capabilities - Array of capabilities with toolsUsed
 * @returns Hypergraph structure for feature computation
 */
export function buildHypergraph(
  capabilities: Array<{ id: string; toolsUsed: string[] }>,
): Hypergraph {
  const hypergraph: Hypergraph = {
    capabilities: new Map(),
    toolToCapabilities: new Map(),
  };

  for (const cap of capabilities) {
    hypergraph.capabilities.set(cap.id, cap.toolsUsed);

    for (const tool of cap.toolsUsed) {
      const caps = hypergraph.toolToCapabilities.get(tool) || [];
      caps.push(cap.id);
      hypergraph.toolToCapabilities.set(tool, caps);
    }
  }

  return hypergraph;
}
