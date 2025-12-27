/**
 * Cluster Boost Calculator Module
 *
 * Extracted from dag-suggester.ts for spectral clustering boost calculation.
 * Handles cluster identification, boost computation, and PageRank integration.
 *
 * @module graphrag/clustering/boost-calculator
 */

import * as log from "@std/log";
import type { DagScoringConfig } from "../dag-scoring-config.ts";
import type { Capability } from "../../capabilities/types.ts";
import { type ClusterableCapability, SpectralClusteringManager } from "../spectral-clustering.ts";
import type { LocalAlphaCalculator } from "../local-alpha.ts";

/**
 * Dependencies for cluster boost calculation
 */
export interface ClusterBoostDeps {
  spectralClustering: SpectralClusteringManager | null;
  localAlphaCalculator: LocalAlphaCalculator | null;
  config: DagScoringConfig;
}

/**
 * Extract tools_used from capability
 *
 * @param capability - Capability to extract from
 * @returns Array of tool IDs used by the capability
 */
function getCapabilityToolsUsed(capability: Capability): string[] {
  return capability.toolsUsed ?? [];
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
 * @param deps - Calculation dependencies
 * @returns Object with boosts map and potentially updated spectral clustering instance
 */
export function computeClusterBoosts(
  capabilities: Capability[],
  contextTools: string[],
  deps: ClusterBoostDeps,
): { boosts: Map<string, number>; spectralClustering: SpectralClusteringManager | null } {
  const boosts = new Map<string, number>();
  let spectralClustering = deps.spectralClustering;

  if (capabilities.length < 2 || contextTools.length < 2) {
    // Not enough data for meaningful clustering
    return { boosts, spectralClustering };
  }

  try {
    // Initialize spectral clustering if not already done
    if (!spectralClustering) {
      spectralClustering = new SpectralClusteringManager();
      // ADR-048: Sync to LocalAlphaCalculator on first init
      if (deps.localAlphaCalculator) {
        deps.localAlphaCalculator.setSpectralClustering(spectralClustering);
      }
    }

    // Collect all tools used by capabilities
    const allToolsUsed = new Set<string>(contextTools);
    for (const cap of capabilities) {
      const capTools = getCapabilityToolsUsed(cap);
      capTools.forEach((t) => allToolsUsed.add(t));
    }

    // Build clusterable capabilities
    const clusterableCapabilities: ClusterableCapability[] = capabilities.map((cap) => ({
      id: cap.id,
      toolsUsed: getCapabilityToolsUsed(cap),
    }));

    const toolsArray = Array.from(allToolsUsed);

    // Try to restore from cache first to avoid expensive O(n³) recomputation
    const cacheHit = spectralClustering.restoreFromCacheIfValid(
      toolsArray,
      clusterableCapabilities,
    );

    if (!cacheHit) {
      // Build bipartite matrix and compute clusters (expensive)
      spectralClustering.buildBipartiteMatrix(toolsArray, clusterableCapabilities);
      spectralClustering.computeClusters();

      // Compute PageRank and save to cache
      spectralClustering.computeHypergraphPageRank(clusterableCapabilities);
      spectralClustering.saveToCache(toolsArray, clusterableCapabilities);

      // ADR-048: Sync spectral clustering to LocalAlphaCalculator for Embeddings Hybrides
      if (deps.localAlphaCalculator) {
        deps.localAlphaCalculator.setSpectralClustering(spectralClustering);
      }
    }

    // Identify active cluster
    const activeCluster = spectralClustering.identifyActiveCluster(contextTools);

    if (activeCluster < 0) {
      log.debug("[boost-calculator] No active cluster identified for boost");
      return { boosts, spectralClustering };
    }

    // Compute cluster boost for each capability
    for (const capData of clusterableCapabilities) {
      const clusterBoost = spectralClustering.getClusterBoost(capData, activeCluster);
      if (clusterBoost > 0) {
        boosts.set(capData.id, clusterBoost);
      }
    }

    // Story 7.4 AC#8: Apply HypergraphPageRank scoring for centrality boost
    const pagerankWeight = deps.config.defaults.pagerankWeight;
    for (const capData of clusterableCapabilities) {
      const prScore = spectralClustering.getPageRank(capData.id);
      if (prScore > 0) {
        const existingBoost = boosts.get(capData.id) ?? 0;
        // Weight PageRank (prScore * weight gives max ~0.15 additional boost)
        boosts.set(capData.id, existingBoost + prScore * pagerankWeight);
      }
    }

    log.debug(
      `[boost-calculator] Computed cluster + PageRank boosts for ${boosts.size} capabilities (active cluster: ${activeCluster}, cacheHit: ${cacheHit})`,
    );
  } catch (error) {
    log.error(`[boost-calculator] Cluster boost computation failed: ${error}`);
  }

  return { boosts, spectralClustering };
}

/**
 * Get capability PageRanks from SpectralClusteringManager (Story 8.2)
 *
 * Used by HypergraphBuilder to size capability nodes by importance.
 * Returns empty map if spectral clustering not initialized.
 *
 * @param spectralClustering - Spectral clustering manager (may be null)
 * @returns Map of capability ID to PageRank score (0-1)
 */
export function getCapabilityPageranks(
  spectralClustering: SpectralClusteringManager | null,
): Map<string, number> {
  if (!spectralClustering) {
    return new Map();
  }
  return spectralClustering.getAllPageRanks();
}
