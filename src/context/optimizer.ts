/**
 * Context Optimizer Module
 *
 * Provides on-demand schema loading using semantic vector search to minimize
 * context window usage. Integrates VectorSearch for tool discovery and SchemaCache
 * for performance optimization.
 *
 * @module context/optimizer
 */

import * as log from "@std/log";
import type { DbClient } from "../db/types.ts";
import type { VectorSearch } from "../vector/search.ts";
import type { MCPTool } from "../mcp/types.ts";
import { SchemaCache } from "./cache.ts";
import {
  compareContextUsage,
  displayContextComparison,
  logCacheHitRate,
  logContextUsage,
  logQueryLatency,
  measureContextUsage,
} from "./metrics.ts";

/**
 * Result from getRelevantSchemas()
 */
export interface RelevantSchemasResult {
  schemas: MCPTool[];
  cacheHits: number;
  cacheMisses: number;
  latencyMs: number;
  contextUsagePercent: number;
}

/**
 * Context Optimizer
 *
 * Main class for on-demand schema loading and context optimization.
 * Workflow: user query → vector search → cache lookup → load schemas → measure usage
 *
 * **Acceptance Criteria Coverage:**
 * - AC1: Integration semantic search avec schema loading ✓
 * - AC2: Workflow: query → vector search → retrieve top-k tools → load schemas ✓
 * - AC3: Schemas retournés uniquement pour matched tools (pas all-at-once) ✓
 * - AC4: Context usage measurement et logging (<5% target) ✓
 * - AC5: Comparison metric affiché: before (30-50%) vs after (<5%) ✓ (via showComparison)
 * - AC6: Cache hit pour frequently used tools (évite reloading) ✓
 * - AC7: Performance: Total query-to-schema latency <200ms P95 ✓
 */
export class ContextOptimizer {
  private schemaCache: SchemaCache;

  /**
   * Create a new context optimizer
   *
   * @param vectorSearch Vector search engine for semantic tool discovery
   * @param db Database client for metrics logging and schema queries
   * @param cacheSize Maximum number of schemas to cache (default: 50)
   */
  constructor(
    private vectorSearch: VectorSearch,
    private db: DbClient,
    cacheSize: number = 50,
  ) {
    this.schemaCache = new SchemaCache(cacheSize);
  }

  /**
   * Get relevant tool schemas for a user query
   *
   * **Core workflow (AC1, AC2, AC3):**
   * 1. Semantic search for relevant tools using VectorSearch
   * 2. Check cache for frequently used tools (AC6)
   * 3. Load only matched schemas (not all-at-once)
   * 4. Measure and log context usage (AC4)
   * 5. Track query latency (AC7)
   *
   * @param userQuery Natural language query describing desired functionality
   * @param topK Number of top tools to retrieve (default: 5)
   * @param minScore Minimum similarity score threshold (default: 0.7)
   * @returns Relevant schemas with performance metrics
   *
   * @example
   * ```typescript
   * const result = await optimizer.getRelevantSchemas("read a file", 5);
   * // Returns top 5 file-related tool schemas with <5% context usage
   * ```
   */
  async getRelevantSchemas(
    userQuery: string,
    topK: number = 5,
    minScore: number = 0.7,
  ): Promise<RelevantSchemasResult> {
    const startTime = performance.now();

    log.info(`🔍 Finding relevant schemas for: "${userQuery}" (topK=${topK})`);

    try {
      // AC2: Step 1 - Semantic search for relevant tools
      const searchStart = performance.now();
      const searchResults = await this.vectorSearch.searchTools(
        userQuery,
        topK,
        minScore,
      );
      const searchTime = performance.now() - searchStart;

      log.debug(
        `Vector search completed in ${
          searchTime.toFixed(2)
        }ms, found ${searchResults.length} results`,
      );

      // AC2: Step 2 - Load only matched schemas (AC3: not all-at-once)
      const schemas: MCPTool[] = [];
      let cacheHits = 0;
      let cacheMisses = 0;

      for (const result of searchResults) {
        // AC6: Check cache first
        const cached = this.schemaCache.get(result.toolId);

        if (cached) {
          cacheHits++;
          schemas.push(cached);
          log.debug(`Cache HIT: ${result.toolName} (${result.toolId})`);
        } else {
          cacheMisses++;
          // Use schema from search result (already loaded from DB by VectorSearch)
          schemas.push(result.schema);
          // Add to cache for future queries
          this.schemaCache.set(result.toolId, result.schema);
          log.debug(`Cache MISS: ${result.toolName} (${result.toolId})`);
        }
      }

      // AC4: Measure context usage
      const usage = measureContextUsage(schemas);

      // AC7: Calculate total latency
      const totalLatency = performance.now() - startTime;

      // Log metrics to database
      await this.logMetrics(usage, totalLatency, cacheHits, cacheMisses, userQuery);

      // Display summary
      log.info(
        `✓ Loaded ${schemas.length} schemas in ${
          totalLatency.toFixed(2)
        }ms (cache: ${cacheHits} hits, ${cacheMisses} misses)`,
      );
      log.info(
        `  Context usage: ${usage.usagePercent.toFixed(2)}% (${usage.estimatedTokens} tokens)`,
      );

      // AC4: Warn if usage exceeds target
      if (usage.usagePercent >= 5) {
        log.warn(
          `⚠ Context usage above target: ${usage.usagePercent.toFixed(2)}% (target: <5%)`,
        );
      }

      return {
        schemas,
        cacheHits,
        cacheMisses,
        latencyMs: totalLatency,
        contextUsagePercent: usage.usagePercent,
      };
    } catch (error) {
      log.error(`Failed to get relevant schemas: ${error}`);
      throw new Error(`Context optimization failed: ${error}`);
    }
  }

  /**
   * Show before/after context usage comparison
   *
   * **AC5:** Displays comparison metric: before (30-50%) vs after (<5%)
   *
   * Demonstrates the benefit of on-demand schema loading vs. loading all schemas.
   *
   * @param totalSchemas Total number of schemas in database (for "before" calculation)
   * @param relevantSchemas Schemas returned from getRelevantSchemas() (for "after" calculation)
   */
  async showContextComparison(
    totalSchemas: number,
    relevantSchemas: MCPTool[],
  ): Promise<void> {
    log.info("📊 Generating context usage comparison...");

    try {
      // Simulate "before" scenario: all schemas loaded
      // Create mock schemas for estimation (we only need count for token estimation)
      const allSchemasMock: MCPTool[] = Array.from(
        { length: totalSchemas },
        () => ({
          name: "mock",
          description: "mock",
          inputSchema: {},
        }),
      );

      // Compare: all-at-once (before) vs on-demand (after)
      const comparison = compareContextUsage(allSchemasMock, relevantSchemas);

      // AC5: Display comparison
      displayContextComparison(comparison);

      // Log to metrics table for historical tracking
      await this.db.query(
        `INSERT INTO metrics (metric_name, value, metadata, timestamp)
         VALUES ($1, $2, $3::jsonb, NOW())`,
        [
          "context_savings_pct",
          comparison.savingsPercent,
          { // postgres.js/pglite auto-serializes to JSONB
            before_count: comparison.before.schemaCount,
            after_count: comparison.after.schemaCount,
            before_usage: comparison.before.usagePercent,
            after_usage: comparison.after.usagePercent,
          },
        ],
      );
    } catch (error) {
      log.error(`Failed to show context comparison: ${error}`);
      // Don't throw - this is a display/logging function
    }
  }

  /**
   * Get cache statistics
   *
   * Useful for monitoring cache performance and tuning
   *
   * @returns Cache stats including hit rate
   */
  getCacheStats(): ReturnType<SchemaCache["getStats"]> {
    return this.schemaCache.getStats();
  }

  /**
   * Clear schema cache
   *
   * Useful for testing or forcing fresh schema loads
   */
  clearCache(): void {
    this.schemaCache.clear();
    log.info("Schema cache cleared");
  }

  /**
   * Log performance and usage metrics to database
   *
   * @private
   */
  private async logMetrics(
    usage: ReturnType<typeof measureContextUsage>,
    latencyMs: number,
    cacheHits: number,
    cacheMisses: number,
    query: string,
  ): Promise<void> {
    try {
      // Log context usage (AC4)
      await logContextUsage(this.db, usage, {
        query: query.substring(0, 100), // Truncate long queries
        cache_hits: cacheHits,
        cache_misses: cacheMisses,
      });

      // Log query latency (AC7)
      await logQueryLatency(this.db, latencyMs, {
        query: query.substring(0, 100),
        schema_count: usage.schemaCount,
        cache_hits: cacheHits,
      });

      // Log cache hit rate (AC6)
      const totalAccesses = cacheHits + cacheMisses;
      if (totalAccesses > 0) {
        const hitRate = cacheHits / totalAccesses;
        await logCacheHitRate(this.db, hitRate, {
          hits: cacheHits,
          misses: cacheMisses,
        });
      }
    } catch (error) {
      // Don't fail the operation if metric logging fails
      log.error(`Metric logging failed: ${error}`);
    }
  }
}
