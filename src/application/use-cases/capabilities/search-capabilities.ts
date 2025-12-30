/**
 * Search Capabilities Use Case
 *
 * Searches for capabilities using DAGSuggester's semantic matching.
 * Thin wrapper that adds validation and consistent error handling.
 *
 * @example
 * ```typescript
 * const useCase = new SearchCapabilitiesUseCase(dagSuggester);
 * const result = await useCase.execute({ intent: "parse JSON data" });
 * ```
 *
 * @module application/use-cases/capabilities/search-capabilities
 */

import * as log from "@std/log";
import type { UseCaseResult } from "../shared/types.ts";
import type {
  SearchCapabilitiesRequest,
  SearchCapabilitiesResult,
} from "./types.ts";

/**
 * DAG Suggester interface (matches actual DAGSuggester)
 */
export interface IDAGSuggester {
  searchCapabilities(intent: string): Promise<CapabilityMatch | null>;
}

/**
 * Capability match result (matches actual CapabilityMatch from capabilities/types)
 *
 * Uses looser types to accept the actual DAGSuggester implementation
 * without importing concrete types (Clean Architecture).
 */
export interface CapabilityMatch {
  capability: {
    id: string;
    name?: string;
    description?: string;
    codeSnippet?: string;
    successRate: number;
    usageCount: number;
  };
  /** JSONSchema | null from actual type - use unknown for structural compatibility */
  parametersSchema: unknown;
  score: number;
  semanticScore: number;
  thresholdUsed: number;
}

/**
 * Use case for searching capabilities
 *
 * Wraps DAGSuggester.searchCapabilities with:
 * - Input validation
 * - Consistent error handling
 * - Structured result format
 */
export class SearchCapabilitiesUseCase {
  constructor(
    private readonly dagSuggester: IDAGSuggester,
  ) {}

  /**
   * Execute the search capabilities use case
   */
  async execute(
    request: SearchCapabilitiesRequest,
  ): Promise<UseCaseResult<SearchCapabilitiesResult>> {
    const { query } = request;

    // Validate request
    if (!query || query.trim().length === 0) {
      return {
        success: false,
        error: {
          code: "MISSING_QUERY",
          message: "Missing required parameter: query (intent)",
        },
      };
    }

    log.debug(`SearchCapabilitiesUseCase: intent="${query}"`);

    try {
      // Search via DAGSuggester
      const match = await this.dagSuggester.searchCapabilities(query);

      if (!match) {
        return {
          success: true,
          data: {
            capabilities: [],
            query,
            totalFound: 0,
          },
        };
      }

      // Map to use case result format (all fields needed by handlers)
      const capabilities = [{
        id: match.capability.id,
        name: match.capability.name ?? match.capability.id,
        displayName: match.capability.name ?? match.capability.id,
        description: match.capability.description ?? "",
        score: match.score,
        semanticScore: match.semanticScore,
        usageCount: match.capability.usageCount,
        successRate: match.capability.successRate,
        codeSnippet: match.capability.codeSnippet,
        parametersSchema: match.parametersSchema ?? undefined,
      }];

      log.debug(`Found capability match: ${match.capability.id} (score: ${match.score})`);

      return {
        success: true,
        data: {
          capabilities,
          query,
          totalFound: 1,
          thresholdUsed: match.thresholdUsed,
        },
      };
    } catch (error) {
      log.error(`Search capabilities failed: ${error}`);
      return {
        success: false,
        error: {
          code: "SEARCH_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
