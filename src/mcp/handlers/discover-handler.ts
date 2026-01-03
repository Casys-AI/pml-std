/**
 * Discover Handler (Story 10.6)
 *
 * Thin handler that delegates to DiscoverToolsUseCase and DiscoverCapabilitiesUseCase.
 * Implements Active Search mode from ADR-038.
 *
 * @module mcp/handlers/discover-handler
 */

import * as log from "@std/log";
import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import type { VectorSearch } from "../../vector/search.ts";
import type { DAGSuggester } from "../../graphrag/dag-suggester.ts";
import type { MCPErrorResponse, MCPToolResponse } from "../server/types.ts";
import { formatMCPSuccess } from "../server/responses.ts";
import { addBreadcrumb, captureError, startTransaction } from "../../telemetry/sentry.ts";
import type { CapabilityRegistry } from "../../capabilities/capability-registry.ts";
import type { IDecisionLogger } from "../../telemetry/decision-logger.ts";
import type { SHGAT } from "../../graphrag/algorithms/shgat.ts";
import type { EmbeddingModel } from "../../embeddings/types.ts";
import type { IToolStore } from "../../tools/types.ts";
import {
  DiscoverToolsUseCase,
  DiscoverCapabilitiesUseCase,
  type DiscoveredTool,
  type DiscoveredCapability,
} from "../../application/use-cases/discover/mod.ts";

/**
 * Discover request arguments
 */
export interface DiscoverArgs {
  intent?: string;
  filter?: {
    type?: "tool" | "capability" | "all";
    minScore?: number;
  };
  limit?: number;
  include_related?: boolean;
}

/**
 * Unified discover result item (tool or capability)
 */
type DiscoverResultItem = DiscoveredTool | DiscoveredCapability;

/**
 * Discover response format
 */
interface DiscoverResponse {
  results: DiscoverResultItem[];
  meta: {
    query: string;
    filter_type: string;
    total_found: number;
    returned_count: number;
    tools_count: number;
    capabilities_count: number;
  };
}

/**
 * Dependencies for handleDiscover
 */
export interface DiscoverHandlerDeps {
  vectorSearch: VectorSearch;
  graphEngine: GraphRAGEngine;
  dagSuggester: DAGSuggester;
  toolStore: IToolStore;
  capabilityRegistry?: CapabilityRegistry;
  decisionLogger?: IDecisionLogger;
  shgat?: SHGAT;
  embeddingModel?: EmbeddingModel;
}

/**
 * Handle pml:discover request (Story 10.6)
 *
 * Thin handler that delegates to use cases for tool and capability discovery.
 *
 * @param args - Discover arguments (intent, filter, limit, include_related)
 * @param deps - Handler dependencies
 * @returns Unified discover results
 */
export async function handleDiscover(
  args: unknown,
  deps: DiscoverHandlerDeps,
): Promise<MCPToolResponse | MCPErrorResponse> {
  const transaction = startTransaction("mcp.discover", "mcp");
  const startTime = performance.now();
  const correlationId = crypto.randomUUID();

  try {
    const params = args as DiscoverArgs;

    // Validate required intent parameter
    if (!params.intent || typeof params.intent !== "string" || !params.intent.trim()) {
      transaction.finish();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ error: "Missing or empty required parameter: 'intent'" }),
        }],
      };
    }

    const intent = params.intent;
    const filterType = params.filter?.type ?? "all";
    const minScore = params.filter?.minScore ?? 0.0;
    const limit = Math.min(params.limit ?? 1, 50);

    transaction.setData("intent", intent);
    transaction.setData("filter_type", filterType);
    transaction.setData("limit", limit);
    addBreadcrumb("mcp", "Processing discover request", { intent, filterType });

    log.info(`discover: intent="${intent}", filter=${filterType}, limit=${limit}`);

    const results: DiscoverResultItem[] = [];
    let toolsCount = 0;
    let capabilitiesCount = 0;

    // Search tools if filter allows
    if (filterType === "all" || filterType === "tool") {
      const toolsUseCase = new DiscoverToolsUseCase({
        toolStore: deps.toolStore,
        shgat: deps.shgat,
        embeddingModel: deps.embeddingModel,
        graphEngine: deps.graphEngine,
        vectorSearch: deps.vectorSearch,
        decisionLogger: deps.decisionLogger,
      });

      const toolsResult = await toolsUseCase.execute({
        intent,
        limit,
        minScore,
        correlationId,
      });

      if (toolsResult.success && toolsResult.data) {
        for (const tool of toolsResult.data.tools) {
          if (tool.score >= minScore) {
            results.push(tool);
            toolsCount++;
          }
        }
      }
    }

    // Search capabilities if filter allows
    if (filterType === "all" || filterType === "capability") {
      const capsUseCase = new DiscoverCapabilitiesUseCase({
        capabilityMatcher: deps.dagSuggester,
        capabilityRegistry: deps.capabilityRegistry,
        shgat: deps.shgat,
        embeddingModel: deps.embeddingModel,
        decisionLogger: deps.decisionLogger,
      });

      const capsResult = await capsUseCase.execute({
        intent,
        limit,
        minScore,
        correlationId,
      });

      if (capsResult.success && capsResult.data) {
        for (const cap of capsResult.data.capabilities) {
          if (cap.score >= minScore) {
            results.push(cap);
            capabilitiesCount++;
          }
        }
      }
    }

    // Sort by score descending and apply limit
    results.sort((a, b) => b.score - a.score);
    const limitedResults = results.slice(0, limit);

    const response: DiscoverResponse = {
      results: limitedResults,
      meta: {
        query: intent,
        filter_type: filterType,
        total_found: results.length,
        returned_count: limitedResults.length,
        tools_count: toolsCount,
        capabilities_count: capabilitiesCount,
      },
    };

    const elapsedMs = performance.now() - startTime;
    log.info(
      `discover: found ${limitedResults.length} results (${toolsCount} tools, ${capabilitiesCount} caps) in ${elapsedMs.toFixed(1)}ms`,
    );

    transaction.finish();
    return formatMCPSuccess(response);
  } catch (error) {
    log.error(`discover error: ${error}`);
    captureError(error as Error, { operation: "discover", handler: "handleDiscover" });
    transaction.finish();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ error: `Discover failed: ${(error as Error).message}` }),
      }],
    };
  }
}

/**
 * Legacy signature adapter for backward compatibility
 *
 * Wraps the new deps-based handleDiscover for code that still uses positional args.
 * @deprecated Use handleDiscover(args, deps) instead
 */
export async function handleDiscoverLegacy(
  args: unknown,
  vectorSearch: VectorSearch,
  graphEngine: GraphRAGEngine,
  dagSuggester: DAGSuggester,
  capabilityRegistry?: CapabilityRegistry,
  decisionLogger?: IDecisionLogger,
  shgat?: SHGAT,
  embeddingModel?: EmbeddingModel,
  toolStore?: IToolStore,
): Promise<MCPToolResponse | MCPErrorResponse> {
  // If no toolStore provided, create a minimal stub that returns empty
  const store: IToolStore = toolStore ?? {
    findById: async () => undefined,
    findByIds: async () => new Map(),
  };

  return handleDiscover(args, {
    vectorSearch,
    graphEngine,
    dagSuggester,
    toolStore: store,
    capabilityRegistry,
    decisionLogger,
    shgat,
    embeddingModel,
  });
}
