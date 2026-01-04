/**
 * Pattern Store
 *
 * Persists scraped workflow patterns to JSON file.
 * Handles loading, saving, and merging patterns.
 *
 * @module graphrag/workflow-patterns/pattern-store
 */

import * as log from "@std/log";
import type { PriorPattern, ScrapedPattern, WorkflowPatternsFile } from "./types.ts";

const CURRENT_VERSION = "1.0";

/**
 * Default path for workflow patterns file
 */
export const DEFAULT_PATTERNS_PATH = "config/workflow-patterns.json";

/**
 * Pattern Store
 *
 * Handles persistence of workflow patterns to JSON files.
 */
export class PatternStore {
  private filePath: string;

  constructor(filePath: string = DEFAULT_PATTERNS_PATH) {
    this.filePath = filePath;
  }

  /**
   * Load patterns from file
   */
  async load(): Promise<WorkflowPatternsFile | null> {
    try {
      const content = await Deno.readTextFile(this.filePath);
      const data = JSON.parse(content) as WorkflowPatternsFile;

      // Version check
      if (data.version !== CURRENT_VERSION) {
        log.warn(
          `[PatternStore] File version ${data.version} differs from current ${CURRENT_VERSION}`,
        );
      }

      log.info(
        `[PatternStore] Loaded ${data.priorPatterns.length} patterns from ${this.filePath}`,
      );
      return data;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        log.info(`[PatternStore] File not found: ${this.filePath}`);
        return null;
      }
      log.error(`[PatternStore] Error loading patterns: ${error}`);
      throw error;
    }
  }

  /**
   * Save patterns to file
   */
  async save(data: WorkflowPatternsFile): Promise<void> {
    // Ensure config directory exists
    const dir = this.filePath.split("/").slice(0, -1).join("/");
    if (dir) {
      try {
        await Deno.mkdir(dir, { recursive: true });
      } catch {
        // Directory might already exist
      }
    }

    const content = JSON.stringify(data, null, 2);
    await Deno.writeTextFile(this.filePath, content);

    log.info(
      `[PatternStore] Saved ${data.priorPatterns.length} patterns to ${this.filePath}`,
    );
  }

  /**
   * Create a new patterns file from scraping results
   */
  createFile(
    rawPatterns: ScrapedPattern[],
    priorPatterns: PriorPattern[],
    stats: {
      workflowsProcessed: number;
      edgesExtracted: number;
      mapped: number;
      unmapped: number;
    },
  ): WorkflowPatternsFile {
    return {
      version: CURRENT_VERSION,
      scrapedAt: new Date().toISOString(),
      source: "n8n",
      workflowsProcessed: stats.workflowsProcessed,
      rawPatterns,
      priorPatterns,
      stats: {
        totalEdgesExtracted: stats.edgesExtracted,
        uniquePatterns: rawPatterns.length,
        mappedPatterns: stats.mapped,
        unmappedPatterns: stats.unmapped,
      },
    };
  }

  /**
   * Merge new patterns with existing ones
   *
   * Strategy:
   * - New patterns override existing ones with same from/to
   * - Frequencies are summed
   * - Weights are recalculated
   */
  async merge(newPatterns: PriorPattern[]): Promise<WorkflowPatternsFile> {
    const existing = await this.load();

    if (!existing) {
      // No existing file, create new
      return {
        version: CURRENT_VERSION,
        scrapedAt: new Date().toISOString(),
        source: "n8n",
        workflowsProcessed: 0,
        rawPatterns: [],
        priorPatterns: newPatterns,
        stats: {
          totalEdgesExtracted: 0,
          uniquePatterns: 0,
          mappedPatterns: newPatterns.length,
          unmappedPatterns: 0,
        },
      };
    }

    // Build index of existing patterns
    const patternMap = new Map<string, PriorPattern>();
    for (const pattern of existing.priorPatterns) {
      const key = `${pattern.from}|${pattern.to}`;
      patternMap.set(key, pattern);
    }

    // Merge new patterns
    for (const newPattern of newPatterns) {
      const key = `${newPattern.from}|${newPattern.to}`;
      const existingPattern = patternMap.get(key);

      if (existingPattern) {
        // Merge: sum frequencies, recalculate weight
        const totalFreq = existingPattern.frequency + newPattern.frequency;
        const freqBoost = Math.log10(totalFreq + 1);
        const avgConfidence = (existingPattern.mappingConfidence + newPattern.mappingConfidence) /
          2;
        const weight = 2.0 / (freqBoost * avgConfidence);

        patternMap.set(key, {
          ...existingPattern,
          frequency: totalFreq,
          weight: Math.round(weight * 100) / 100,
          mappingConfidence: avgConfidence,
        });
      } else {
        patternMap.set(key, newPattern);
      }
    }

    // Convert back to array and sort by weight
    const mergedPatterns = Array.from(patternMap.values());
    mergedPatterns.sort((a, b) => a.weight - b.weight);

    return {
      ...existing,
      scrapedAt: new Date().toISOString(),
      priorPatterns: mergedPatterns,
      stats: {
        ...existing.stats,
        mappedPatterns: mergedPatterns.length,
      },
    };
  }

  /**
   * Get top patterns by weight (lower weight = better)
   */
  async getTopPatterns(limit: number = 100): Promise<PriorPattern[]> {
    const data = await this.load();
    if (!data) return [];

    return data.priorPatterns.slice(0, limit);
  }

  /**
   * Get patterns for a specific source tool
   */
  async getPatternsFrom(mcpToolId: string): Promise<PriorPattern[]> {
    const data = await this.load();
    if (!data) return [];

    return data.priorPatterns.filter((p) => p.from === mcpToolId);
  }

  /**
   * Get patterns for a specific target tool
   */
  async getPatternsTo(mcpToolId: string): Promise<PriorPattern[]> {
    const data = await this.load();
    if (!data) return [];

    return data.priorPatterns.filter((p) => p.to === mcpToolId);
  }

  /**
   * Check if patterns file exists
   */
  async exists(): Promise<boolean> {
    try {
      await Deno.stat(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file path
   */
  getFilePath(): string {
    return this.filePath;
  }
}

/**
 * Convenience function to load patterns from default location
 */
export async function loadPatterns(): Promise<PriorPattern[]> {
  const store = new PatternStore();
  const data = await store.load();
  return data?.priorPatterns ?? [];
}

/**
 * Convenience function to save patterns to default location
 */
export async function savePatterns(
  rawPatterns: ScrapedPattern[],
  priorPatterns: PriorPattern[],
  stats: {
    workflowsProcessed: number;
    edgesExtracted: number;
    mapped: number;
    unmapped: number;
  },
): Promise<void> {
  const store = new PatternStore();
  const file = store.createFile(rawPatterns, priorPatterns, stats);
  await store.save(file);
}
