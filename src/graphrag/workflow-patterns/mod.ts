/**
 * Workflow Patterns Module
 *
 * Scrapes n8n workflow templates to extract tool co-occurrence patterns
 * for DR-DSP pathfinding and SHGAT learning.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { scrapeAndSave } from "./mod.ts";
 *
 * // Scrape n8n and save patterns
 * await scrapeAndSave({ maxWorkflows: 500 });
 * ```
 *
 * ## CLI Usage
 *
 * ```bash
 * pml workflows scrape              # Scrape n8n → workflow-patterns.json
 * pml workflows scrape --limit 100  # Limit to 100 workflows
 * ```
 *
 * @module graphrag/workflow-patterns
 */

// Types
export type {
  N8nConnections,
  N8nConnectionTarget,
  N8nNode,
  N8nScraperOptions,
  N8nSearchResponse,
  N8nWorkflow,
  PriorPattern,
  ScrapedEdge,
  ScrapedPattern,
  ToolMapping,
  ToolMapperConfig,
  WorkflowPatternsFile,
} from "./types.ts";

export { DEFAULT_SCRAPER_OPTIONS } from "./types.ts";

// Scraper
export { N8nScraper, scrapeN8nWorkflows } from "./n8n-scraper.ts";

// Mapper
export { getDefaultToolMapper, ToolMapper } from "./tool-mapper.ts";

// Store
export {
  DEFAULT_PATTERNS_PATH,
  loadPatterns,
  PatternStore,
  savePatterns,
} from "./pattern-store.ts";

import * as log from "@std/log";
import { N8nScraper } from "./n8n-scraper.ts";
import { PatternStore } from "./pattern-store.ts";
import { ToolMapper } from "./tool-mapper.ts";
import type { N8nScraperOptions, PriorPattern, WorkflowPatternsFile } from "./types.ts";

/**
 * Scrape n8n workflows and save patterns to file
 *
 * This is the main entry point for the scraping workflow.
 * It combines scraping, mapping, and storage into one operation.
 *
 * @param options - Scraper options
 * @param outputPath - Path to save patterns (default: config/workflow-patterns.json)
 * @returns Scraping results
 */
export async function scrapeAndSave(
  options?: Partial<N8nScraperOptions>,
  outputPath?: string,
): Promise<{
  file: WorkflowPatternsFile;
  stats: {
    workflowsProcessed: number;
    edgesExtracted: number;
    uniquePatterns: number;
    mappedPatterns: number;
    unmappedPatterns: number;
  };
}> {
  log.info("[WorkflowPatterns] Starting scrape and save...");

  // 1. Scrape n8n workflows
  const scraper = new N8nScraper(options);
  const { patterns: rawPatterns, stats: scrapeStats } = await scraper.scrape();

  log.info(`[WorkflowPatterns] Scraped ${rawPatterns.length} unique patterns`);

  // 2. Map to MCP tool IDs
  const mapper = new ToolMapper();
  const { priorPatterns, stats: mapStats } = mapper.mapPatterns(rawPatterns);

  log.info(`[WorkflowPatterns] Mapped ${priorPatterns.length} patterns to MCP tools`);

  // 3. Save to file
  const store = new PatternStore(outputPath);
  const file = store.createFile(rawPatterns, priorPatterns, {
    workflowsProcessed: scrapeStats.workflowsProcessed,
    edgesExtracted: scrapeStats.edgesExtracted,
    mapped: mapStats.mapped,
    unmapped: mapStats.unmapped,
  });

  await store.save(file);

  const stats = {
    workflowsProcessed: scrapeStats.workflowsProcessed,
    edgesExtracted: scrapeStats.edgesExtracted,
    uniquePatterns: rawPatterns.length,
    mappedPatterns: mapStats.mapped,
    unmappedPatterns: mapStats.unmapped,
  };

  log.info(`[WorkflowPatterns] Complete! Stats: ${JSON.stringify(stats)}`);

  return { file, stats };
}

/**
 * Quick scrape for testing (small number of workflows)
 */
export async function scrapeQuick(limit: number = 10): Promise<PriorPattern[]> {
  const scraper = new N8nScraper({ maxWorkflows: limit, minViews: 0 });
  const { patterns } = await scraper.scrape();

  const mapper = new ToolMapper();
  const { priorPatterns } = mapper.mapPatterns(patterns);

  return priorPatterns;
}

/**
 * Get mapping coverage statistics
 *
 * Useful for understanding how many n8n node types
 * are covered by our manual mappings.
 */
export function getMappingStats(): {
  totalMappings: number;
  byService: Record<string, number>;
} {
  const mapper = new ToolMapper();
  return mapper.getStats();
}
