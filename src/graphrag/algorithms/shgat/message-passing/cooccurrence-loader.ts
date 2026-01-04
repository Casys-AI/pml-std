/**
 * Co-occurrence Loader
 *
 * Loads scraped workflow patterns and builds the co-occurrence matrix
 * for V→V message passing phase.
 *
 * Handles:
 * - Loading patterns from PatternStore
 * - Building sparse co-occurrence matrix
 * - Generating embeddings for tools not in local DB (using descriptions)
 *
 * @module graphrag/algorithms/shgat/message-passing/cooccurrence-loader
 */

import * as log from "@std/log";
import { PatternStore, type PriorPattern } from "../../../workflow-patterns/mod.ts";
import { ToolMapper } from "../../../workflow-patterns/tool-mapper.ts";
import type { CooccurrenceEntry } from "./vertex-to-vertex-phase.ts";

/**
 * Loaded co-occurrence data ready for V→V phase
 */
export interface CooccurrenceData {
  /** Sparse co-occurrence matrix entries */
  entries: CooccurrenceEntry[];
  /** Tool ID to index mapping */
  toolIndex: Map<string, number>;
  /** Index to tool ID mapping (reverse) */
  indexToTool: string[];
  /** Statistics */
  stats: {
    /** Number of patterns loaded */
    patternsLoaded: number;
    /** Number of unique tools */
    uniqueTools: number;
    /** Number of co-occurrence edges */
    edges: number;
    /** Load time in ms */
    loadTimeMs: number;
  };
}

/**
 * Loader options
 */
export interface LoaderOptions {
  /** Path to patterns file (default: config/workflow-patterns.json) */
  patternsPath?: string;
  /** Minimum pattern frequency to include */
  minFrequency?: number;
  /** Maximum patterns to load (for testing) */
  maxPatterns?: number;
  /** Filter to specific tool prefixes */
  toolPrefixes?: string[];
}

const DEFAULT_OPTIONS: Required<LoaderOptions> = {
  patternsPath: "config/workflow-patterns.json",
  minFrequency: 1,
  maxPatterns: Infinity,
  toolPrefixes: [],
};

/**
 * Load co-occurrence data from scraped patterns
 *
 * @param existingToolIndex - Optional existing tool index (from graph engine)
 * @param options - Loader options
 * @returns Co-occurrence data for V→V phase
 */
export async function loadCooccurrenceData(
  existingToolIndex?: Map<string, number>,
  options?: LoaderOptions,
): Promise<CooccurrenceData> {
  const startTime = performance.now();
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Load patterns from store
  const store = new PatternStore(opts.patternsPath);
  const patternsFile = await store.load();

  if (!patternsFile) {
    log.warn("[CooccurrenceLoader] No patterns file found, returning empty data");
    return {
      entries: [],
      toolIndex: existingToolIndex ?? new Map(),
      indexToTool: [],
      stats: {
        patternsLoaded: 0,
        uniqueTools: 0,
        edges: 0,
        loadTimeMs: performance.now() - startTime,
      },
    };
  }

  // Filter patterns
  let patterns = patternsFile.priorPatterns;

  if (opts.minFrequency > 1) {
    patterns = patterns.filter((p) => p.frequency >= opts.minFrequency);
  }

  if (opts.toolPrefixes.length > 0) {
    patterns = patterns.filter(
      (p) =>
        opts.toolPrefixes.some((prefix) => p.from.startsWith(prefix)) ||
        opts.toolPrefixes.some((prefix) => p.to.startsWith(prefix)),
    );
  }

  if (opts.maxPatterns < patterns.length) {
    patterns = patterns.slice(0, opts.maxPatterns);
  }

  // Build tool index
  const toolIndex = new Map<string, number>(existingToolIndex ?? []);
  const indexToTool: string[] = existingToolIndex
    ? Array.from(existingToolIndex.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([id]) => id)
    : [];

  // Add new tools from patterns
  for (const pattern of patterns) {
    if (!toolIndex.has(pattern.from)) {
      const idx = toolIndex.size;
      toolIndex.set(pattern.from, idx);
      indexToTool.push(pattern.from);
    }
    if (!toolIndex.has(pattern.to)) {
      const idx = toolIndex.size;
      toolIndex.set(pattern.to, idx);
      indexToTool.push(pattern.to);
    }
  }

  // Build co-occurrence matrix
  const entries = buildCooccurrenceEntries(patterns, toolIndex);

  const loadTimeMs = performance.now() - startTime;

  log.info(
    `[CooccurrenceLoader] Loaded ${patterns.length} patterns → ${entries.length} edges (${loadTimeMs.toFixed(1)}ms)`,
  );

  return {
    entries,
    toolIndex,
    indexToTool,
    stats: {
      patternsLoaded: patterns.length,
      uniqueTools: toolIndex.size,
      edges: entries.length,
      loadTimeMs,
    },
  };
}

/**
 * Build sparse co-occurrence entries from patterns
 */
function buildCooccurrenceEntries(
  patterns: PriorPattern[],
  toolIndex: Map<string, number>,
): CooccurrenceEntry[] {
  const entries: CooccurrenceEntry[] = [];
  const seen = new Set<string>(); // Deduplicate bidirectional edges

  for (const pattern of patterns) {
    const fromIdx = toolIndex.get(pattern.from);
    const toIdx = toolIndex.get(pattern.to);

    if (fromIdx === undefined || toIdx === undefined) continue;
    if (fromIdx === toIdx) continue; // Skip self-loops

    // Convert weight to similarity (lower weight in PriorPattern = higher co-occurrence)
    // PriorPattern.weight formula: 2.0 / (log10(freq+1) * confidence)
    // So higher frequency → lower weight → higher cooccurrence
    const coocWeight = 1.0 / (1.0 + pattern.weight);

    // Add forward edge
    const keyFwd = `${fromIdx}:${toIdx}`;
    if (!seen.has(keyFwd)) {
      entries.push({ from: fromIdx, to: toIdx, weight: coocWeight });
      seen.add(keyFwd);
    }

    // Add backward edge (co-occurrence is symmetric)
    const keyBwd = `${toIdx}:${fromIdx}`;
    if (!seen.has(keyBwd)) {
      entries.push({ from: toIdx, to: fromIdx, weight: coocWeight });
      seen.add(keyBwd);
    }
  }

  return entries;
}

/**
 * Get embeddings for tools from patterns that might not be in local DB
 *
 * Uses tool descriptions from mappings to generate embeddings on-demand.
 *
 * @param toolIds - Tool IDs that need embeddings
 * @param generateEmbedding - Function to generate embedding from text
 * @returns Map of tool ID to embedding
 */
export async function getToolEmbeddings(
  toolIds: string[],
  generateEmbedding: (text: string) => Promise<number[]>,
): Promise<Map<string, number[]>> {
  const mapper = new ToolMapper();
  const mappings = mapper.getMappings();

  // Build description index
  const descriptionIndex = new Map<string, string>();
  for (const mapping of mappings) {
    if (mapping.description) {
      descriptionIndex.set(mapping.mcpToolId, mapping.description);
    }
  }

  const result = new Map<string, number[]>();

  for (const toolId of toolIds) {
    const description = descriptionIndex.get(toolId);

    if (description) {
      // Generate embedding from description
      const embedding = await generateEmbedding(`${toolId}: ${description}`);
      result.set(toolId, embedding);
    } else {
      // Fallback: use tool ID as text
      const embedding = await generateEmbedding(toolId);
      result.set(toolId, embedding);
    }
  }

  return result;
}

/**
 * Merge co-occurrence embeddings with existing graph embeddings
 *
 * For tools in patterns but not in local graph, we need to add them.
 *
 * @param graphEmbeddings - Existing embeddings from graph [numTools][dim]
 * @param graphToolIndex - Existing tool index from graph
 * @param coocData - Co-occurrence data with potentially new tools
 * @param generateEmbedding - Function to generate embedding from text
 * @returns Merged embeddings and updated tool index
 */
export async function mergeEmbeddings(
  graphEmbeddings: number[][],
  graphToolIndex: Map<string, number>,
  coocData: CooccurrenceData,
  generateEmbedding: (text: string) => Promise<number[]>,
): Promise<{
  embeddings: number[][];
  toolIndex: Map<string, number>;
  indexToTool: string[];
}> {
  // Find tools in co-occurrence that aren't in graph
  const missingTools: string[] = [];
  for (const toolId of coocData.indexToTool) {
    if (!graphToolIndex.has(toolId)) {
      missingTools.push(toolId);
    }
  }

  if (missingTools.length === 0) {
    // All tools already in graph
    return {
      embeddings: graphEmbeddings,
      toolIndex: graphToolIndex,
      indexToTool: Array.from(graphToolIndex.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([id]) => id),
    };
  }

  log.info(`[CooccurrenceLoader] Generating embeddings for ${missingTools.length} new tools`);

  // Generate embeddings for missing tools
  const newEmbeddings = await getToolEmbeddings(missingTools, generateEmbedding);

  // Merge into existing
  const mergedEmbeddings = [...graphEmbeddings];
  const mergedToolIndex = new Map(graphToolIndex);
  const mergedIndexToTool = Array.from(graphToolIndex.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);

  for (const toolId of missingTools) {
    const embedding = newEmbeddings.get(toolId);
    if (embedding) {
      const idx = mergedEmbeddings.length;
      mergedEmbeddings.push(embedding);
      mergedToolIndex.set(toolId, idx);
      mergedIndexToTool.push(toolId);
    }
  }

  return {
    embeddings: mergedEmbeddings,
    toolIndex: mergedToolIndex,
    indexToTool: mergedIndexToTool,
  };
}
