/**
 * Algorithm Factory Pattern
 *
 * Factory for creating algorithm instances (SHGAT, DR-DSP) from
 * capabilities data. Abstracts initialization complexity and provides
 * consistent algorithm creation across the application.
 *
 * @example
 * ```typescript
 * // Create SHGAT from capabilities
 * const shgat = AlgorithmFactory.createSHGAT(capabilities, {
 *   withCooccurrence: true,
 *   withHyperedgeCache: true,
 * });
 *
 * // Create DR-DSP from capabilities
 * const drdsp = AlgorithmFactory.createDRDSP(capabilities);
 * ```
 *
 * @module infrastructure/patterns/factory/algorithm-factory
 */

import * as log from "@std/log";
import {
  createSHGATFromCapabilities,
  type SHGAT,
} from "../../../graphrag/algorithms/shgat.ts";
import {
  buildDRDSPFromCapabilities,
  type DRDSP,
} from "../../../graphrag/algorithms/dr-dsp.ts";
import { loadCooccurrenceData } from "../../../graphrag/algorithms/shgat/message-passing/index.ts";
import {
  buildHyperedgesFromSHGAT,
  cacheHyperedges,
} from "../../../cache/hyperedge-cache.ts";

/**
 * Capability data for algorithm initialization
 */
export interface AlgorithmCapabilityInput {
  id: string;
  embedding: number[];
  toolsUsed: string[];
  successRate: number;
  children?: string[];
  parents?: string[];
}

/**
 * Simplified capability for DR-DSP (no embedding needed)
 */
export interface DRDSPCapabilityInput {
  id: string;
  toolsUsed: string[];
  successRate: number;
}

/**
 * Options for SHGAT creation
 */
export interface SHGATFactoryOptions {
  /** Load V→V co-occurrence data from scraped workflows */
  withCooccurrence?: boolean;
  /** Cache hyperedges in KV for tensor-entropy */
  withHyperedgeCache?: boolean;
}

/**
 * Result of SHGAT creation
 */
export interface SHGATFactoryResult {
  shgat: SHGAT;
  capabilitiesLoaded: number;
  cooccurrenceEdges?: number;
  hyperedgesCached?: number;
}

/**
 * Factory for creating algorithm instances
 *
 * Provides centralized creation of ML algorithms used for
 * capability matching and DAG suggestion.
 */
export class AlgorithmFactory {
  /**
   * Create SHGAT instance from capabilities
   *
   * @param capabilities Array of capabilities with embeddings
   * @param options Creation options
   * @returns SHGAT instance and metadata
   */
  static async createSHGAT(
    capabilities: AlgorithmCapabilityInput[],
    options: SHGATFactoryOptions = {},
  ): Promise<SHGATFactoryResult> {
    // Create SHGAT with capabilities
    const shgat = createSHGATFromCapabilities(capabilities);
    log.info(
      `[AlgorithmFactory] SHGAT initialized with ${capabilities.length} capabilities`,
    );

    const result: SHGATFactoryResult = {
      shgat,
      capabilitiesLoaded: capabilities.length,
    };

    // Load co-occurrence data if requested
    if (options.withCooccurrence) {
      try {
        const toolIndex = shgat.getToolIndexMap();
        const coocData = await loadCooccurrenceData(toolIndex);
        if (coocData.entries.length > 0) {
          shgat.setCooccurrenceData(coocData.entries);
          result.cooccurrenceEdges = coocData.stats.edges;
          log.info(
            `[AlgorithmFactory] V→V co-occurrence loaded: ${coocData.stats.edges} edges`,
          );
        }
      } catch (e) {
        log.debug(`[AlgorithmFactory] No V→V co-occurrence data: ${e}`);
      }
    }

    // Cache hyperedges if requested
    if (options.withHyperedgeCache) {
      const hyperedges = buildHyperedgesFromSHGAT(capabilities);
      if (hyperedges.length > 0) {
        await cacheHyperedges(hyperedges);
        result.hyperedgesCached = hyperedges.length;
        log.info(
          `[AlgorithmFactory] Cached ${hyperedges.length} hyperedges in KV`,
        );
      }
    }

    return result;
  }

  /**
   * Create empty SHGAT (for cases with no initial capabilities)
   *
   * Capabilities can be added dynamically via shgat.registerCapability()
   */
  static createEmptySHGAT(): SHGAT {
    const shgat = createSHGATFromCapabilities([]);
    log.info(`[AlgorithmFactory] Empty SHGAT initialized`);
    return shgat;
  }

  /**
   * Create DR-DSP instance from capabilities
   *
   * @param capabilities Array of capabilities (embeddings not required)
   * @returns DR-DSP instance
   */
  static createDRDSP(capabilities: DRDSPCapabilityInput[]): DRDSP {
    const drdsp = buildDRDSPFromCapabilities(capabilities);
    log.info(
      `[AlgorithmFactory] DR-DSP initialized with ${capabilities.length} capabilities`,
    );
    return drdsp;
  }

  /**
   * Create both SHGAT and DR-DSP from the same capabilities
   *
   * Convenience method for initializing both algorithms together.
   *
   * @param capabilities Capabilities with embeddings
   * @param options SHGAT options
   * @returns Both algorithm instances
   */
  static async createBoth(
    capabilities: AlgorithmCapabilityInput[],
    options: SHGATFactoryOptions = {},
  ): Promise<{
    shgat: SHGATFactoryResult;
    drdsp: DRDSP;
  }> {
    const [shgatResult, drdsp] = await Promise.all([
      this.createSHGAT(capabilities, options),
      Promise.resolve(this.createDRDSP(capabilities)),
    ]);

    return {
      shgat: shgatResult,
      drdsp,
    };
  }
}
