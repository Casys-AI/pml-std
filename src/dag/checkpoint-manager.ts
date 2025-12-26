/**
 * CheckpointManager for WorkflowState Persistence
 *
 * Manages checkpoint lifecycle:
 * - Save: Create checkpoint after each layer execution
 * - Load: Retrieve checkpoint for resume
 * - Prune: Keep N most recent checkpoints per workflow
 *
 * Performance target: <50ms P95 for saves (async, non-blocking)
 * Retention policy: 5 most recent checkpoints per workflow
 *
 * @module dag/checkpoint-manager
 */

import type { DbClient } from "../db/types.ts";
import type { Checkpoint } from "./types.ts";
import type { WorkflowState } from "./state.ts";
import * as log from "@std/log";

/**
 * Checkpoint persistence manager with PGlite backend
 *
 * Example usage:
 * ```typescript
 * const manager = new CheckpointManager(db);
 * const checkpoint = await manager.saveCheckpoint(workflow_id, layer, state);
 * const loaded = await manager.loadCheckpoint(checkpoint.id);
 * const latest = await manager.getLatestCheckpoint(workflow_id);
 * await manager.pruneCheckpoints(workflow_id);
 * ```
 */
export class CheckpointManager {
  private db: DbClient;
  private autoPrune: boolean;

  /**
   * Create checkpoint manager
   *
   * @param db - PGlite client instance (must be connected)
   * @param autoPrune - Enable automatic pruning after each save (default: false)
   */
  constructor(db: DbClient, autoPrune: boolean = false) {
    this.db = db;
    this.autoPrune = autoPrune;
  }

  /**
   * Save checkpoint to PGlite
   *
   * Serializes WorkflowState to JSONB and stores in workflow_checkpoint table.
   * Generates UUID v4 for checkpoint ID.
   * Auto-triggers pruning to maintain retention policy.
   *
   * Performance: Target <50ms P95 (async save)
   *
   * @param workflow_id - Workflow instance identifier
   * @param layer - Current DAG layer index (0-indexed)
   * @param state - WorkflowState to persist
   * @returns Checkpoint with generated ID and timestamp
   * @throws Error if database write fails
   */
  async saveCheckpoint(
    workflow_id: string,
    layer: number,
    state: WorkflowState,
  ): Promise<Checkpoint> {
    const startTime = performance.now();

    try {
      // Generate UUID v4 for checkpoint ID
      const id = crypto.randomUUID();
      const timestamp = new Date();

      // Serialize WorkflowState to JSON
      // Note: Excludes filesystem state (documented limitation - AC-2.4)
      const serializedState = JSON.stringify({
        workflow_id: state.workflowId, // Map to DB snake_case
        current_layer: state.currentLayer, // Map to DB snake_case
        messages: state.messages,
        tasks: state.tasks,
        decisions: state.decisions,
        context: state.context,
      });

      // Insert checkpoint with parameterized query (SQL injection safe)
      await this.db.query(
        `INSERT INTO workflow_checkpoint (id, workflow_id, timestamp, layer, state)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, workflow_id, timestamp, layer, serializedState],
      );

      const elapsedMs = performance.now() - startTime;
      log.debug(
        `Checkpoint saved: ${id} (workflow: ${workflow_id}, layer: ${layer}, ${
          elapsedMs.toFixed(2)
        }ms)`,
      );

      // Note: Auto-pruning disabled in constructor by default
      // Call pruneCheckpoints() explicitly when needed or enable via autoPrune flag
      if (this.autoPrune) {
        // Trigger async pruning (fire-and-forget, non-blocking)
        // Errors logged but don't fail checkpoint save
        this.pruneCheckpoints(workflow_id).catch((error) => {
          log.error(`Checkpoint pruning failed for ${workflow_id}: ${error}`);
        });
      }

      return {
        id,
        workflowId: workflow_id, // Map from DB snake_case parameter
        timestamp,
        layer,
        state,
      };
    } catch (error) {
      log.error(`Failed to save checkpoint: ${error}`);
      throw new Error(`Checkpoint save failed: ${error}`);
    }
  }

  /**
   * Load checkpoint by ID
   *
   * Retrieves checkpoint from PGlite and deserializes JSONB state.
   * Validates state structure before returning.
   *
   * @param checkpoint_id - UUID of checkpoint to load
   * @returns Checkpoint object or null if not found
   * @throws Error if state deserialization/validation fails
   */
  async loadCheckpoint(checkpoint_id: string): Promise<Checkpoint | null> {
    try {
      const row = await this.db.queryOne(
        `SELECT id, workflow_id, timestamp, layer, state
         FROM workflow_checkpoint
         WHERE id = $1`,
        [checkpoint_id],
      );

      if (!row) {
        log.debug(`Checkpoint not found: ${checkpoint_id}`);
        return null;
      }

      // Deserialize JSONB state
      const dbState = typeof row.state === "string" ? JSON.parse(row.state as string) : row.state;

      // Validate state structure (validates DB format)
      this.validateStateStructure(dbState);

      // Map DB snake_case to TS camelCase
      const state: WorkflowState = {
        workflowId: dbState.workflow_id,
        currentLayer: dbState.current_layer,
        messages: dbState.messages,
        tasks: dbState.tasks,
        decisions: dbState.decisions,
        context: dbState.context,
      };

      return {
        id: row.id as string,
        workflowId: row.workflow_id as string, // Map from DB snake_case
        timestamp: new Date(row.timestamp as string),
        layer: row.layer as number,
        state: state,
      };
    } catch (error) {
      log.error(`Failed to load checkpoint ${checkpoint_id}: ${error}`);
      throw new Error(`Checkpoint load failed: ${error}`);
    }
  }

  /**
   * Get latest checkpoint for workflow
   *
   * Returns most recent checkpoint ordered by timestamp.
   * Useful for "resume latest" scenarios.
   *
   * @param workflow_id - Workflow instance identifier
   * @returns Most recent checkpoint or null if none exist
   */
  async getLatestCheckpoint(workflow_id: string): Promise<Checkpoint | null> {
    try {
      const row = await this.db.queryOne(
        `SELECT id, workflow_id, timestamp, layer, state
         FROM workflow_checkpoint
         WHERE workflow_id = $1
         ORDER BY timestamp DESC
         LIMIT 1`,
        [workflow_id],
      );

      if (!row) {
        log.debug(`No checkpoints found for workflow: ${workflow_id}`);
        return null;
      }

      // Deserialize JSONB state
      const dbState = typeof row.state === "string" ? JSON.parse(row.state as string) : row.state;

      // Validate state structure (validates DB format)
      this.validateStateStructure(dbState);

      // Map DB snake_case to TS camelCase
      const state: WorkflowState = {
        workflowId: dbState.workflow_id,
        currentLayer: dbState.current_layer,
        messages: dbState.messages,
        tasks: dbState.tasks,
        decisions: dbState.decisions,
        context: dbState.context,
      };

      return {
        id: row.id as string,
        workflowId: row.workflow_id as string, // Map from DB snake_case
        timestamp: new Date(row.timestamp as string),
        layer: row.layer as number,
        state: state,
      };
    } catch (error) {
      log.error(`Failed to get latest checkpoint for ${workflow_id}: ${error}`);
      throw new Error(`Get latest checkpoint failed: ${error}`);
    }
  }

  /**
   * Prune old checkpoints for workflow
   *
   * Keeps N most recent checkpoints, deletes older ones.
   * Retention policy: Default 5 checkpoints per workflow.
   *
   * This is called automatically after each save (async, fire-and-forget).
   * Can also be called manually for cleanup.
   *
   * @param workflow_id - Workflow instance identifier
   * @param keepCount - Number of checkpoints to retain (default: 5)
   * @returns Number of checkpoints deleted
   */
  async pruneCheckpoints(
    workflow_id: string,
    keepCount: number = 5,
  ): Promise<number> {
    try {
      // Count total checkpoints before pruning
      const countResult = await this.db.queryOne(
        `SELECT COUNT(*) as count FROM workflow_checkpoint WHERE workflow_id = $1`,
        [workflow_id],
      );
      const totalCheckpoints = (countResult?.count as number) || 0;

      if (totalCheckpoints <= keepCount) {
        log.debug(
          `No checkpoints to prune for workflow: ${workflow_id} (${totalCheckpoints} <= ${keepCount})`,
        );
        return 0;
      }

      // Delete old checkpoints using parameterized query (SQL injection safe)
      // Keep N most recent, delete the rest
      await this.db.query(
        `DELETE FROM workflow_checkpoint
         WHERE workflow_id = $1
         AND id NOT IN (
           SELECT id FROM workflow_checkpoint
           WHERE workflow_id = $1
           ORDER BY timestamp DESC
           LIMIT $2
         )`,
        [workflow_id, keepCount],
      );

      const deletedCount = totalCheckpoints - keepCount;
      log.debug(
        `Pruned ${deletedCount} checkpoints for workflow: ${workflow_id}`,
      );
      return deletedCount;
    } catch (error) {
      log.error(`Failed to prune checkpoints for ${workflow_id}: ${error}`);
      throw new Error(`Checkpoint pruning failed: ${error}`);
    }
  }

  /**
   * Validate WorkflowState structure
   *
   * Ensures state has required fields before returning to caller.
   * Prevents corrupted state from causing runtime errors.
   *
   * @param state - State object to validate
   * @throws Error if required fields missing or invalid
   */
  private validateStateStructure(state: unknown): void {
    if (typeof state !== "object" || state === null) {
      throw new Error("State must be an object");
    }

    const s = state as Record<string, unknown>;

    // Required fields
    const requiredFields = [
      "workflow_id",
      "current_layer",
      "messages",
      "tasks",
      "decisions",
      "context",
    ];

    for (const field of requiredFields) {
      if (!(field in s)) {
        throw new Error(`State missing required field: ${field}`);
      }
    }

    // Type checks
    if (typeof s.workflow_id !== "string" || s.workflow_id === "") {
      throw new Error("State workflow_id must be non-empty string");
    }

    if (typeof s.current_layer !== "number" || s.current_layer < 0) {
      throw new Error("State current_layer must be non-negative number");
    }

    if (!Array.isArray(s.messages)) {
      throw new Error("State messages must be an array");
    }

    if (!Array.isArray(s.tasks)) {
      throw new Error("State tasks must be an array");
    }

    if (!Array.isArray(s.decisions)) {
      throw new Error("State decisions must be an array");
    }

    if (typeof s.context !== "object" || s.context === null) {
      throw new Error("State context must be an object");
    }
  }
}
