/**
 * Discover Capabilities Use Case
 *
 * Searches for capabilities using SHGAT K-head scoring with legacy matcher fallback.
 * Extracts business logic from discover-handler for Clean Architecture.
 *
 * @module application/use-cases/discover/discover-capabilities
 */

import * as log from "@std/log";
import type { UseCaseResult } from "../shared/types.ts";
import type { DiscoverRequest, DiscoveredCapability, DiscoverCapabilitiesResult } from "./types.ts";
import type { SHGAT } from "../../../graphrag/algorithms/shgat.ts";
import type { EmbeddingModel } from "../../../embeddings/types.ts";
import type { IDecisionLogger } from "../../../telemetry/decision-logger.ts";
import type { CapabilityRegistry } from "../../../capabilities/capability-registry.ts";

/**
 * Capability store interface (matches DAGSuggester.getCapabilityStore())
 */
export interface ICapabilityStore {
  findById(id: string): Promise<CapabilityData | undefined>;
}

/**
 * Capability data from store
 */
export interface CapabilityData {
  id: string;
  name?: string;
  description?: string;
  codeSnippet?: string;
  successRate: number;
  usageCount: number;
  fqdn?: string;
  parametersSchema?: unknown;
}

/**
 * Legacy matcher interface (DAGSuggester.searchCapabilities)
 */
export interface ICapabilityMatcher {
  searchCapabilities(intent: string, correlationId?: string): Promise<CapabilityMatch | null>;
  getCapabilityStore(): ICapabilityStore | undefined;
}

/**
 * Legacy capability match result
 */
export interface CapabilityMatch {
  capability: CapabilityData;
  parametersSchema: unknown;
  score: number;
  semanticScore: number;
}

/**
 * Dependencies for DiscoverCapabilitiesUseCase
 */
export interface DiscoverCapabilitiesDeps {
  capabilityMatcher: ICapabilityMatcher;
  capabilityRegistry?: CapabilityRegistry;
  shgat?: SHGAT;
  embeddingModel?: EmbeddingModel;
  decisionLogger?: IDecisionLogger;
}

/**
 * Discover Capabilities Use Case
 *
 * Uses SHGAT K-head for capability scoring when available, falls back to legacy matcher.
 */
export class DiscoverCapabilitiesUseCase {
  constructor(private readonly deps: DiscoverCapabilitiesDeps) {}

  /**
   * Execute capability discovery
   */
  async execute(request: DiscoverRequest): Promise<UseCaseResult<DiscoverCapabilitiesResult>> {
    const { intent, limit = 5, minScore = 0, correlationId } = request;

    if (!intent || intent.trim().length === 0) {
      return {
        success: false,
        error: { code: "MISSING_INTENT", message: "Intent is required for capability discovery" },
      };
    }

    try {
      // Try SHGAT first (unified scoring)
      if (this.deps.shgat && this.deps.embeddingModel) {
        const result = await this.discoverWithSHGAT(intent, limit, minScore, correlationId);
        if (result) return { success: true, data: result };
      }

      // Fallback to legacy matcher
      const result = await this.discoverWithLegacyMatcher(intent, minScore, correlationId);
      return { success: true, data: result };
    } catch (error) {
      log.error(`[DiscoverCapabilities] Failed: ${error}`);
      return {
        success: false,
        error: { code: "DISCOVERY_FAILED", message: (error as Error).message },
      };
    }
  }

  /**
   * Discover capabilities using SHGAT K-head scoring
   */
  private async discoverWithSHGAT(
    intent: string,
    limit: number,
    minScore: number,
    correlationId?: string,
  ): Promise<DiscoverCapabilitiesResult | null> {
    const { shgat, embeddingModel, capabilityMatcher, capabilityRegistry, decisionLogger } = this.deps;
    if (!shgat || !embeddingModel) return null;

    const intentEmbedding = await embeddingModel.encode(intent);
    if (!intentEmbedding || intentEmbedding.length === 0) {
      log.warn("[DiscoverCapabilities] Failed to generate intent embedding");
      return null;
    }

    // Score capabilities with SHGAT K-head
    const shgatResults = shgat.scoreAllCapabilities(intentEmbedding);
    const capStore = capabilityMatcher.getCapabilityStore();

    log.debug("[DiscoverCapabilities] SHGAT scored", {
      count: shgatResults.length,
      top3: shgatResults.slice(0, 3).map((r) => ({ id: r.capabilityId, score: r.score.toFixed(3) })),
    });

    // Build results
    const capabilities: DiscoveredCapability[] = [];
    for (const shgatResult of shgatResults.slice(0, limit)) {
      // Log decision
      decisionLogger?.logDecision({
        algorithm: "SHGAT",
        mode: "active_search",
        targetType: "capability",
        intent,
        finalScore: shgatResult.score,
        threshold: minScore,
        decision: shgatResult.score >= minScore ? "accepted" : "rejected",
        targetId: shgatResult.capabilityId,
        correlationId,
        signals: {
          numHeads: shgatResult.headScores?.length ?? 0,
          avgHeadScore: shgatResult.headScores
            ? shgatResult.headScores.reduce((a, b) => a + b, 0) / shgatResult.headScores.length
            : 0,
        },
      });

      // Get capability details
      const capability = await capStore?.findById(shgatResult.capabilityId);
      if (!capability) continue;

      // Resolve call name
      const callName = await this.resolveCallName(shgatResult.capabilityId, capability.fqdn);

      // Parse called capabilities for meta-capabilities
      const calledCapabilities = await this.parseCalledCapabilities(capability.codeSnippet, capStore);

      capabilities.push({
        type: "capability",
        record_type: "capability",
        id: shgatResult.capabilityId,
        name: capability.name ?? shgatResult.capabilityId.substring(0, 8),
        description: capability.description ?? "Learned capability",
        score: shgatResult.score,
        code_snippet: capability.codeSnippet,
        success_rate: capability.successRate,
        usage_count: capability.usageCount,
        semantic_score: shgatResult.featureContributions?.semantic ?? shgatResult.score,
        call_name: callName,
        input_schema: capability.parametersSchema as Record<string, unknown> | undefined,
        called_capabilities: calledCapabilities.length > 0 ? calledCapabilities : undefined,
      });
    }

    return { capabilities, totalFound: shgatResults.length };
  }

  /**
   * Discover capabilities using legacy matcher (fallback)
   */
  private async discoverWithLegacyMatcher(
    intent: string,
    minScore: number,
    correlationId?: string,
  ): Promise<DiscoverCapabilitiesResult> {
    const { capabilityMatcher, decisionLogger } = this.deps;

    log.debug("[DiscoverCapabilities] Using legacy CapabilityMatcher fallback");

    const match = await capabilityMatcher.searchCapabilities(intent, correlationId);

    if (!match) {
      decisionLogger?.logDecision({
        algorithm: "CapabilityMatcher",
        mode: "active_search",
        targetType: "capability",
        intent,
        finalScore: 0,
        threshold: minScore,
        decision: "rejected",
        correlationId,
      });
      return { capabilities: [], totalFound: 0 };
    }

    decisionLogger?.logDecision({
      algorithm: "CapabilityMatcher",
      mode: "active_search",
      targetType: "capability",
      intent,
      finalScore: match.score,
      threshold: minScore,
      decision: match.score >= minScore ? "accepted" : "rejected",
      targetId: match.capability.id,
      correlationId,
      signals: { semanticScore: match.semanticScore, successRate: match.capability.successRate },
    });

    const callName = await this.resolveCallName(match.capability.id, match.capability.fqdn);

    return {
      capabilities: [{
        type: "capability",
        record_type: "capability",
        id: match.capability.id,
        name: match.capability.name ?? match.capability.id.substring(0, 8),
        description: match.capability.description ?? "Learned capability",
        score: match.score,
        code_snippet: match.capability.codeSnippet,
        success_rate: match.capability.successRate,
        usage_count: match.capability.usageCount,
        semantic_score: match.semanticScore,
        call_name: callName,
        input_schema: match.parametersSchema as Record<string, unknown> | undefined,
      }],
      totalFound: 1,
    };
  }

  /**
   * Resolve namespace:action call name from registry or FQDN
   */
  private async resolveCallName(capabilityId: string, fqdn?: string): Promise<string | undefined> {
    const { capabilityRegistry } = this.deps;

    if (capabilityRegistry) {
      const record = await capabilityRegistry.getByWorkflowPatternId(capabilityId);
      if (record) return `${record.namespace}:${record.action}`;
    }

    // Fallback: parse from FQDN
    if (fqdn) {
      const parts = fqdn.split(".");
      if (parts.length >= 5) return `${parts[2]}:${parts[3]}`;
    }

    return undefined;
  }

  /**
   * Parse $cap:uuid references in code snippet for meta-capabilities
   */
  private async parseCalledCapabilities(
    codeSnippet?: string,
    capStore?: ICapabilityStore,
  ): Promise<Array<{ id: string; call_name?: string; input_schema?: Record<string, unknown> }>> {
    const { capabilityRegistry } = this.deps;
    if (!codeSnippet || !capabilityRegistry) return [];

    const results: Array<{ id: string; call_name?: string; input_schema?: Record<string, unknown> }> = [];
    const capRefPattern = /\$cap:([a-f0-9-]{36})/g;
    const seenIds = new Set<string>();

    let match;
    while ((match = capRefPattern.exec(codeSnippet)) !== null) {
      const capUuid = match[1];
      if (seenIds.has(capUuid)) continue;
      seenIds.add(capUuid);

      const record = await capabilityRegistry.getByWorkflowPatternId(capUuid);
      if (record) {
        const innerCap = await capStore?.findById(capUuid);
        results.push({
          id: capUuid,
          call_name: `${record.namespace}:${record.action}`,
          input_schema: innerCap?.parametersSchema as Record<string, unknown> | undefined,
        });
      }
    }

    return results;
  }
}
