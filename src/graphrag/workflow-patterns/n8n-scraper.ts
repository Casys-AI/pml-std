/**
 * n8n Workflow Scraper
 *
 * Fetches workflow templates from n8n public API and extracts
 * tool co-occurrence edges for DR-DSP prior patterns.
 *
 * @module graphrag/workflow-patterns/n8n-scraper
 */

import * as log from "@std/log";
import {
  DEFAULT_SCRAPER_OPTIONS,
  type N8nConnectionTarget,
  type N8nNode,
  type N8nScraperOptions,
  type N8nSearchResponse,
  type N8nWorkflow,
  type ScrapedEdge,
  type ScrapedPattern,
} from "./types.ts";

const N8N_API_BASE = "https://api.n8n.io/templates";

/**
 * Utility nodes to skip (don't represent real tool operations)
 */
const UTILITY_NODE_TYPES = new Set([
  "n8n-nodes-base.stickyNote",
  "n8n-nodes-base.noOp",
  "n8n-nodes-base.start",
  "n8n-nodes-base.manualTrigger",
  "n8n-nodes-base.scheduleTrigger",
  "n8n-nodes-base.webhookTrigger",
  "n8n-nodes-base.errorTrigger",
  "n8n-nodes-base.executeWorkflowTrigger",
]);

/**
 * n8n Workflow Scraper
 *
 * Fetches public workflow templates and extracts tool edges.
 */
export class N8nScraper {
  private options: N8nScraperOptions;

  constructor(options: Partial<N8nScraperOptions> = {}) {
    this.options = { ...DEFAULT_SCRAPER_OPTIONS, ...options };
  }

  /**
   * Fetch workflow IDs from search API
   */
  async *fetchWorkflowIds(): AsyncGenerator<{ id: number; totalViews: number }> {
    let page = 1;
    let fetched = 0;

    while (fetched < this.options.maxWorkflows) {
      const url = new URL(`${N8N_API_BASE}/search`);
      url.searchParams.set("rows", String(this.options.pageSize));
      url.searchParams.set("page", String(page));

      if (this.options.categories.length > 0) {
        url.searchParams.set("category", this.options.categories.join(","));
      }

      log.info(`[N8nScraper] Fetching page ${page}...`);

      try {
        const response = await fetch(url.toString());
        if (!response.ok) {
          log.error(`[N8nScraper] API error: ${response.status}`);
          break;
        }

        const data: N8nSearchResponse = await response.json();

        if (data.workflows.length === 0) {
          log.info("[N8nScraper] No more workflows");
          break;
        }

        for (const workflow of data.workflows) {
          if (workflow.totalViews >= this.options.minViews) {
            yield { id: workflow.id, totalViews: workflow.totalViews };
            fetched++;
            if (fetched >= this.options.maxWorkflows) break;
          }
        }

        page++;

        // Rate limiting
        await this.delay(this.options.requestDelay);
      } catch (error) {
        log.error(`[N8nScraper] Fetch error: ${error}`);
        break;
      }
    }

    log.info(`[N8nScraper] Fetched ${fetched} workflow IDs`);
  }

  /**
   * Fetch a single workflow by ID
   */
  async fetchWorkflow(id: number): Promise<N8nWorkflow | null> {
    const url = `${N8N_API_BASE}/workflows/${id}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        log.warn(`[N8nScraper] Failed to fetch workflow ${id}: ${response.status}`);
        return null;
      }

      const data = await response.json();

      // The API structure is: data.workflow.workflow contains the actual n8n workflow JSON
      // data.workflow is metadata (id, name, description, etc.)
      // data.workflow.workflow has nodes[] and connections{}
      const templateMeta = data.workflow;
      if (!templateMeta) {
        log.warn(`[N8nScraper] No workflow data for ${id}`);
        return null;
      }

      // The actual workflow JSON is nested inside
      const workflowJson = templateMeta.workflow;
      if (!workflowJson) {
        log.warn(`[N8nScraper] No workflow JSON for ${id}`);
        return null;
      }

      // Combine metadata with workflow JSON
      const workflow: N8nWorkflow = {
        id: templateMeta.id,
        name: templateMeta.name,
        totalViews: templateMeta.totalViews ?? 0,
        description: templateMeta.description,
        createdAt: templateMeta.createdAt,
        nodes: workflowJson.nodes ?? [],
        connections: workflowJson.connections ?? {},
        user: templateMeta.user,
      };

      log.debug(
        `[N8nScraper] Workflow ${id}: ${workflow.nodes.length} nodes, ` +
          `${Object.keys(workflow.connections).length} connection sources`,
      );

      return workflow;
    } catch (error) {
      log.warn(`[N8nScraper] Error fetching workflow ${id}: ${error}`);
      return null;
    }
  }

  /**
   * Extract edges from a workflow
   */
  extractEdges(workflow: N8nWorkflow): ScrapedEdge[] {
    const edges: ScrapedEdge[] = [];

    // Guard against missing data
    if (!workflow.nodes || !workflow.connections) {
      return edges;
    }

    // Build node lookup by name
    const nodeByName = new Map<string, N8nNode>();
    for (const node of workflow.nodes) {
      nodeByName.set(node.name, node);
    }

    // Process connections
    for (const [sourceName, connectionTypes] of Object.entries(workflow.connections)) {
      const sourceNode = nodeByName.get(sourceName);
      if (!sourceNode) continue;

      // Skip utility nodes
      if (this.options.skipUtilityNodes && UTILITY_NODE_TYPES.has(sourceNode.type)) {
        continue;
      }

      for (const [connectionType, targetArrays] of Object.entries(connectionTypes)) {
        // Guard: targetArrays might not be an array
        if (!Array.isArray(targetArrays)) continue;

        for (const targets of targetArrays) {
          // Guard: targets might not be an array
          if (!Array.isArray(targets)) continue;

          for (const target of targets as N8nConnectionTarget[]) {
            if (!target || typeof target.node !== "string") continue;
            const targetNode = nodeByName.get(target.node);
            if (!targetNode) continue;

            // Skip utility nodes
            if (this.options.skipUtilityNodes && UTILITY_NODE_TYPES.has(targetNode.type)) {
              continue;
            }

            edges.push({
              fromNodeType: sourceNode.type,
              fromOperation: this.extractOperation(sourceNode),
              toNodeType: targetNode.type,
              toOperation: this.extractOperation(targetNode),
              connectionType,
            });
          }
        }
      }
    }

    return edges;
  }

  /**
   * Extract operation from node parameters
   *
   * Different nodes use different parameter names:
   * - httpRequest: method (GET, POST, etc.)
   * - code: language (javascript, python)
   * - googleSheets: operation (read, append, update)
   * - slack: operation (post, getHistory)
   * - github: operation, resource
   */
  private extractOperation(node: N8nNode): string | undefined {
    if (!node.parameters) return undefined;

    // Try common operation field names in priority order
    const operation = node.parameters.operation ||
      node.parameters.method || // httpRequest uses 'method'
      node.parameters.resource ||
      node.parameters.action ||
      node.parameters.language; // code node uses 'language'

    return typeof operation === "string" ? operation.toLowerCase() : undefined;
  }

  /**
   * Scrape workflows and aggregate patterns
   */
  async scrape(): Promise<{
    patterns: ScrapedPattern[];
    stats: { workflowsProcessed: number; edgesExtracted: number };
  }> {
    const edgeMap = new Map<string, {
      pattern: Omit<ScrapedPattern, "frequency" | "totalViews" | "sampleWorkflowIds">;
      frequency: number;
      totalViews: number;
      workflowIds: number[];
    }>();

    let workflowsProcessed = 0;
    let edgesExtracted = 0;

    log.info("[N8nScraper] Starting scrape...");

    for await (const { id, totalViews } of this.fetchWorkflowIds()) {
      const workflow = await this.fetchWorkflow(id);
      if (!workflow) continue;

      const edges = this.extractEdges(workflow);
      workflowsProcessed++;

      for (const edge of edges) {
        edgesExtracted++;

        // Create canonical key
        const fromN8n = edge.fromOperation
          ? `${edge.fromNodeType}:${edge.fromOperation}`
          : edge.fromNodeType;
        const toN8n = edge.toOperation
          ? `${edge.toNodeType}:${edge.toOperation}`
          : edge.toNodeType;

        const key = `${fromN8n}|${toN8n}`;

        const existing = edgeMap.get(key);
        if (existing) {
          existing.frequency++;
          existing.totalViews += totalViews;
          if (existing.workflowIds.length < 10) {
            existing.workflowIds.push(id);
          }
        } else {
          edgeMap.set(key, {
            pattern: {
              fromN8n,
              toN8n,
              fromMcp: null, // Will be filled by mapper
              toMcp: null,
            },
            frequency: 1,
            totalViews,
            workflowIds: [id],
          });
        }
      }

      // Progress log every 100 workflows
      if (workflowsProcessed % 100 === 0) {
        log.info(`[N8nScraper] Processed ${workflowsProcessed} workflows, ${edgesExtracted} edges`);
      }

      // Rate limiting
      await this.delay(this.options.requestDelay);
    }

    // Convert map to array
    const patterns: ScrapedPattern[] = Array.from(edgeMap.values()).map((entry) => ({
      ...entry.pattern,
      frequency: entry.frequency,
      totalViews: entry.totalViews,
      sampleWorkflowIds: entry.workflowIds,
    }));

    // Sort by frequency (most common first)
    patterns.sort((a, b) => b.frequency - a.frequency);

    log.info(
      `[N8nScraper] Scrape complete: ${workflowsProcessed} workflows, ${patterns.length} unique patterns`,
    );

    return {
      patterns,
      stats: { workflowsProcessed, edgesExtracted },
    };
  }

  /**
   * Quick scrape for testing (fetches only a few workflows)
   */
  async scrapeQuick(limit: number = 10): Promise<ScrapedPattern[]> {
    const originalMax = this.options.maxWorkflows;
    this.options.maxWorkflows = limit;

    const { patterns } = await this.scrape();

    this.options.maxWorkflows = originalMax;
    return patterns;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Convenience function to scrape n8n workflows
 */
export async function scrapeN8nWorkflows(
  options?: Partial<N8nScraperOptions>,
): Promise<ScrapedPattern[]> {
  const scraper = new N8nScraper(options);
  const { patterns } = await scraper.scrape();
  return patterns;
}
