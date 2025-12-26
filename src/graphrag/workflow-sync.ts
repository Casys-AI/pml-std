/**
 * Workflow Templates Sync Service (Story 5.2)
 *
 * Synchronizes workflow templates from YAML to the tool_dependency table.
 * Supports checksums for change detection and auto-bootstrap on empty graph.
 *
 * @module graphrag/workflow-sync
 */

import * as log from "@std/log";
import type { DbClient } from "../db/types.ts";
import { type WorkflowEdge, WorkflowLoader } from "./workflow-loader.ts";
import { EmbeddingModel, schemaToText } from "../vector/embeddings.ts";

/**
 * Config key for storing workflow file checksum in adaptive_config table
 */
const CHECKSUM_CONFIG_KEY = "workflow_templates_checksum";

/**
 * Sync result with statistics
 */
export interface SyncResult {
  success: boolean;
  edgesCreated: number;
  edgesUpdated: number;
  workflowsProcessed: number;
  warnings: string[];
  error?: string;
}

/**
 * Interface for embedding model (allows mocking in tests)
 */
export interface IEmbeddingModel {
  load(): Promise<void>;
  encode(text: string): Promise<number[]>;
  dispose(): Promise<void>;
}

/**
 * Factory function type for creating embedding models
 */
export type EmbeddingModelFactory = () => IEmbeddingModel;

/**
 * Default factory that creates real EmbeddingModel
 */
const defaultEmbeddingFactory: EmbeddingModelFactory = () => new EmbeddingModel();

/**
 * Workflow Templates Sync Service
 *
 * Handles synchronization of YAML workflow templates to the database.
 */
export class WorkflowSyncService {
  private loader: WorkflowLoader;
  private embeddingFactory: EmbeddingModelFactory;

  constructor(private db: DbClient, embeddingFactory?: EmbeddingModelFactory) {
    this.loader = new WorkflowLoader();
    this.embeddingFactory = embeddingFactory ?? defaultEmbeddingFactory;
  }

  /**
   * Load known tool IDs from tool_schema table
   * Used for strict validation of workflow templates
   */
  private async loadKnownTools(): Promise<string[]> {
    try {
      const result = await this.db.query(
        `SELECT tool_id FROM tool_schema ORDER BY tool_id`,
      );
      return result.map((row) => row.tool_id as string);
    } catch {
      return [];
    }
  }

  /**
   * Sync workflow templates from YAML to database (AC #2, #3)
   *
   * Converts workflow steps to edges and upserts to tool_dependency table
   * with source='user' marker.
   *
   * @param yamlPath - Path to workflow templates YAML file
   * @param force - Force sync even if checksum unchanged
   * @returns Sync result with statistics
   */
  async sync(yamlPath: string, force: boolean = false): Promise<SyncResult> {
    log.info(`[WorkflowSync] Starting sync from: ${yamlPath} (force=${force})`);

    try {
      // 1. Check if sync is needed (checksum comparison)
      if (!force) {
        const needsSync = await this.needsSync(yamlPath);
        if (!needsSync) {
          log.info("[WorkflowSync] File unchanged, skipping sync");
          return {
            success: true,
            edgesCreated: 0,
            edgesUpdated: 0,
            workflowsProcessed: 0,
            warnings: [],
          };
        }
      }

      // 2. Load known tools from tool_schema for strict validation
      const knownTools = await this.loadKnownTools();
      if (knownTools.length === 0) {
        log.warn(
          "[WorkflowSync] No tools found in tool_schema. Run 'pml serve' first to discover tools.",
        );
        return {
          success: false,
          edgesCreated: 0,
          edgesUpdated: 0,
          workflowsProcessed: 0,
          warnings: [],
          error: "No tools in tool_schema. Start the gateway to discover MCP tools first.",
        };
      }
      log.info(`[WorkflowSync] Found ${knownTools.length} known tools in tool_schema`);
      this.loader.setKnownTools(knownTools);

      // 3. Load and validate workflows (now with strict tool validation)
      const { validWorkflows, validationResults, edges } = await this.loader.loadAndProcess(
        yamlPath,
      );

      // Collect warnings and errors
      const warnings: string[] = [];
      for (const result of validationResults) {
        for (const warning of result.warnings) {
          warnings.push(warning);
        }
        for (const error of result.errors) {
          warnings.push(`[Error] ${error}`);
        }
      }

      if (validWorkflows.length === 0) {
        log.warn("[WorkflowSync] No valid workflows found");
        return {
          success: false,
          edgesCreated: 0,
          edgesUpdated: 0,
          workflowsProcessed: 0,
          warnings,
          error: "No valid workflows. Check that tool IDs match tools in tool_schema.",
        };
      }

      // 4. Ensure embeddings exist for referenced tools (ADR-021 fix)
      const embeddingsCreated = await this.ensureEmbeddingsExist(edges);
      if (embeddingsCreated > 0) {
        log.info(`[WorkflowSync] Generated ${embeddingsCreated} embeddings for tool_embedding`);
      }

      // 5. Upsert edges to database
      const { created, updated } = await this.upsertEdges(edges);

      // 6. Store new checksum
      const newChecksum = await this.loader.calculateChecksum(yamlPath);
      await this.storeChecksum(newChecksum);

      log.info(
        `[WorkflowSync] Sync complete: ${created} created, ${updated} updated, ${validWorkflows.length} workflows`,
      );

      return {
        success: true,
        edgesCreated: created,
        edgesUpdated: updated,
        workflowsProcessed: validWorkflows.length,
        warnings,
      };
    } catch (error) {
      log.error(`[WorkflowSync] Sync failed: ${error}`);
      return {
        success: false,
        edgesCreated: 0,
        edgesUpdated: 0,
        workflowsProcessed: 0,
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Upsert edges to tool_dependency table (AC #2, #3)
   *
   * - Sets source='user' for all edges (AC #3)
   * - Sets initial confidence=0.90 for user-defined patterns
   * - Preserves existing observed_count on upsert (AC: 2.4)
   */
  private async upsertEdges(edges: WorkflowEdge[]): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;

    for (const edge of edges) {
      try {
        // Check if edge exists
        const existing = await this.db.queryOne(
          `SELECT observed_count FROM tool_dependency
           WHERE from_tool_id = $1 AND to_tool_id = $2`,
          [edge.from, edge.to],
        );

        if (existing) {
          // Update existing edge - preserve observed_count, update edge_source and confidence
          await this.db.query(
            `UPDATE tool_dependency
             SET edge_source = 'user',
                 confidence_score = GREATEST(confidence_score, 0.90),
                 last_observed = NOW()
             WHERE from_tool_id = $1 AND to_tool_id = $2`,
            [edge.from, edge.to],
          );
          updated++;
        } else {
          // Create new edge with edge_source='user' and confidence=0.90
          await this.db.query(
            `INSERT INTO tool_dependency (from_tool_id, to_tool_id, observed_count, confidence_score, edge_source)
             VALUES ($1, $2, 1, 0.90, 'user')`,
            [edge.from, edge.to],
          );
          created++;
        }
      } catch (error) {
        log.warn(`[WorkflowSync] Failed to upsert edge ${edge.from} → ${edge.to}: ${error}`);
      }
    }

    return { created, updated };
  }

  /**
   * Ensure embeddings exist in tool_embedding for all referenced tools (ADR-021 fix)
   *
   * GraphRAGEngine.syncFromDatabase() requires nodes in tool_embedding
   * to load edges. This method generates real embeddings from tool_schema.
   *
   * @param edges - Workflow edges containing tool IDs
   * @returns Number of embeddings created
   */
  private async ensureEmbeddingsExist(edges: WorkflowEdge[]): Promise<number> {
    // Collect unique tool IDs
    const toolIds = new Set<string>();
    for (const edge of edges) {
      toolIds.add(edge.from);
      toolIds.add(edge.to);
    }

    // Check which tools are missing from tool_embedding
    const missingToolIds: string[] = [];
    for (const toolId of toolIds) {
      const existing = await this.db.queryOne(
        `SELECT tool_id FROM tool_embedding WHERE tool_id = $1`,
        [toolId],
      );
      if (!existing) {
        missingToolIds.push(toolId);
      }
    }

    if (missingToolIds.length === 0) {
      log.debug("[WorkflowSync] All tools already have embeddings");
      return 0;
    }

    log.info(`[WorkflowSync] Generating embeddings for ${missingToolIds.length} tools...`);

    // Create and load embedding model using factory (allows mocking in tests)
    const model = this.embeddingFactory();
    await model.load();

    let created = 0;
    try {
      for (const toolId of missingToolIds) {
        try {
          // Fetch schema from tool_schema
          const schema = await this.db.queryOne(
            `SELECT tool_id, server_id, name, description, input_schema
             FROM tool_schema WHERE tool_id = $1`,
            [toolId],
          );

          if (!schema) {
            log.warn(`[WorkflowSync] Tool ${toolId} not found in tool_schema`);
            continue;
          }

          // Generate embedding from schema text
          const schemaObj = {
            tool_id: schema.tool_id as string,
            server_id: schema.server_id as string,
            name: schema.name as string,
            description: (schema.description as string) || "",
            input_schema: (typeof schema.input_schema === "string"
              ? JSON.parse(schema.input_schema)
              : schema.input_schema) as Record<string, unknown>,
          };
          const text = schemaToText(schemaObj);
          const embedding = await model.encode(text);

          // Insert into tool_embedding
          await this.db.query(
            `INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
             ON CONFLICT (tool_id) DO UPDATE
             SET embedding = EXCLUDED.embedding,
                 metadata = EXCLUDED.metadata,
                 created_at = NOW()`,
            [
              schemaObj.tool_id,
              schemaObj.server_id,
              schemaObj.name,
              `[${embedding.join(",")}]`,
              { // postgres.js/pglite auto-serializes to JSONB
                source: "workflow_sync",
                generated_at: new Date().toISOString(),
              },
            ],
          );

          // Track metric for getPeriodStats().newNodesAdded
          await this.db.query(
            `INSERT INTO metrics (metric_name, value, metadata, timestamp)
             VALUES ('tool_embedded', 1, $1::jsonb, NOW())`,
            [{ tool_id: toolId }], // postgres.js/pglite auto-serializes to JSONB
          );

          created++;
          log.debug(`[WorkflowSync] Generated embedding for: ${toolId}`);
        } catch (error) {
          log.warn(`[WorkflowSync] Failed to generate embedding for ${toolId}: ${error}`);
        }
      }
    } finally {
      // Always clean up embedding model resources
      await model.dispose();
      log.debug("[WorkflowSync] Embedding model disposed");
    }

    return created;
  }

  /**
   * Check if sync is needed by comparing checksums (AC #4)
   */
  async needsSync(yamlPath: string): Promise<boolean> {
    try {
      const currentChecksum = await this.loader.calculateChecksum(yamlPath);
      if (!currentChecksum) {
        return false; // File doesn't exist
      }

      const storedChecksum = await this.getStoredChecksum();
      return currentChecksum !== storedChecksum;
    } catch {
      return true; // Error = assume sync needed
    }
  }

  /**
   * Get stored checksum from config table
   */
  private async getStoredChecksum(): Promise<string | null> {
    try {
      const result = await this.db.queryOne(
        `SELECT value as checksum FROM config WHERE key = $1`,
        [CHECKSUM_CONFIG_KEY],
      );
      return result?.checksum as string || null;
    } catch {
      return null;
    }
  }

  /**
   * Store checksum in adaptive_config table
   */
  private async storeChecksum(checksum: string): Promise<void> {
    // Use config_value as text (adaptive_config.config_value is REAL, so we use a workaround)
    // Actually, let's use the config table instead
    await this.db.query(
      `INSERT INTO config (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [CHECKSUM_CONFIG_KEY, checksum],
    );
  }

  /**
   * Check if graph is empty - for bootstrap detection (AC #6)
   *
   * Checks tool_embedding (nodes) rather than tool_dependency (edges)
   * because GraphRAGEngine.syncFromDatabase() requires nodes to load edges.
   */
  async isGraphEmpty(): Promise<boolean> {
    try {
      const result = await this.db.queryOne(
        `SELECT COUNT(*) as count FROM tool_embedding`,
      );
      return (result?.count as number) === 0;
    } catch {
      return true; // Error = assume empty
    }
  }

  /**
   * Auto-bootstrap if graph is empty and file exists (AC #6)
   *
   * @param yamlPath - Path to workflow templates YAML file
   * @returns true if bootstrap was performed
   */
  async bootstrapIfEmpty(yamlPath: string): Promise<boolean> {
    const isEmpty = await this.isGraphEmpty();
    if (!isEmpty) {
      log.debug("[WorkflowSync] Graph not empty, skipping bootstrap");
      return false;
    }

    // Check if file exists
    try {
      await Deno.stat(yamlPath);
    } catch {
      log.debug("[WorkflowSync] Workflow templates file not found, skipping bootstrap");
      return false;
    }

    log.info("[WorkflowSync] Bootstrapping graph from workflow-templates.yaml");
    const result = await this.sync(yamlPath, true);

    if (result.success && result.edgesCreated > 0) {
      log.info(`[WorkflowSync] Bootstrap complete: ${result.edgesCreated} edges created`);
      return true;
    }

    return false;
  }

  /**
   * Get statistics about user-defined vs learned edges
   */
  async getEdgeStats(): Promise<{ user: number; learned: number; total: number }> {
    try {
      const result = await this.db.query(
        `SELECT edge_source, COUNT(*) as count FROM tool_dependency GROUP BY edge_source`,
      );

      let user = 0;
      let learned = 0;

      for (const row of result) {
        if (row.edge_source === "user") {
          user = row.count as number;
        } else {
          learned += row.count as number;
        }
      }

      return { user, learned, total: user + learned };
    } catch {
      return { user: 0, learned: 0, total: 0 };
    }
  }
}
