/**
 * GraphSyncController - Event-driven incremental graph updates
 *
 * Listens to capability.zone.created/updated events and updates:
 * - GraphRAGEngine (in-memory graph)
 * - Hyperedge KV cache
 * - SHGAT (capability registration)
 *
 * @module mcp/graph-sync/controller
 */

import * as log from "@std/log";
import type { DbClient } from "../../db/types.ts";
import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import type { SHGAT } from "../../graphrag/algorithms/shgat.ts";
import { eventBus } from "../../events/mod.ts";
import {
  getCachedHyperedges,
  invalidateHyperedge,
  updateHyperedge,
} from "../../cache/hyperedge-cache.ts";
import {
  computeTensorEntropy,
  type EntropyGraphInput,
  saveEntropySnapshot,
  snapshotToEntropyInput,
} from "../../graphrag/algorithms/tensor-entropy.ts";
import {
  filterSnapshotByExecution,
  getExecutedToolIds,
} from "../../graphrag/user-usage.ts";

/**
 * Event payload for capability zone created
 */
export interface CapabilityZoneCreatedPayload {
  capabilityId: string;
  toolIds: string[];
  label?: string;
}

/**
 * Event payload for capability zone updated
 */
export interface CapabilityZoneUpdatedPayload {
  capabilityId: string;
  toolIds: string[];
}

/**
 * Event payload for capability merged
 */
export interface CapabilityMergedPayload {
  sourceId: string;
  sourceName: string;
  sourcePatternId: string | null;
  targetId: string;
  targetName: string;
  targetPatternId: string | null;
}

/**
 * Controller for event-driven incremental graph updates.
 *
 * Listens to capability.zone.created/updated events and updates:
 * - GraphRAGEngine (in-memory graph)
 * - Hyperedge KV cache
 * - SHGAT (capability registration)
 */
export class GraphSyncController {
  private unsubscribeCreated: (() => void) | null = null;
  private unsubscribeUpdated: (() => void) | null = null;
  private unsubscribeMerged: (() => void) | null = null;

  constructor(
    private graphEngine: GraphRAGEngine | null,
    private db: DbClient,
    private getSHGAT: () => SHGAT | null,
  ) {}

  /**
   * Start listening for capability events
   */
  start(): void {
    this.unsubscribeCreated = eventBus.on("capability.zone.created", (event) => {
      const payload = event.payload as CapabilityZoneCreatedPayload;
      this.handleCapabilityCreated(payload).catch((err) => {
        log.error("[GraphSyncController] Error handling capability.zone.created:", err);
      });
    });

    this.unsubscribeUpdated = eventBus.on("capability.zone.updated", (event) => {
      const payload = event.payload as CapabilityZoneUpdatedPayload;
      this.handleCapabilityUpdated(payload).catch((err) => {
        log.error("[GraphSyncController] Error handling capability.zone.updated:", err);
      });
    });

    this.unsubscribeMerged = eventBus.on("capability.merged", (event) => {
      const payload = event.payload as CapabilityMergedPayload;
      this.handleCapabilityMerged(payload).catch((err) => {
        log.error("[GraphSyncController] Error handling capability.merged:", err);
      });
    });

    log.info("[GraphSyncController] Started listening for capability events");
  }

  /**
   * Stop listening for events
   */
  stop(): void {
    if (this.unsubscribeCreated) {
      this.unsubscribeCreated();
      this.unsubscribeCreated = null;
    }
    if (this.unsubscribeUpdated) {
      this.unsubscribeUpdated();
      this.unsubscribeUpdated = null;
    }
    if (this.unsubscribeMerged) {
      this.unsubscribeMerged();
      this.unsubscribeMerged = null;
    }
    log.info("[GraphSyncController] Stopped listening for capability events");
  }

  private async handleCapabilityCreated(
    payload: CapabilityZoneCreatedPayload,
  ): Promise<void> {
    const { capabilityId, toolIds } = payload;

    log.debug(
      `[GraphSyncController] New capability created: ${capabilityId} with ${toolIds.length} tools`,
    );

    // 1. Update graph engine incrementally
    if (this.graphEngine) {
      this.graphEngine.addCapabilityNode(capabilityId, toolIds);
    }

    // 2. Update hyperedge cache (children will be empty for new capabilities)
    await updateHyperedge(capabilityId, toolIds);

    // 3. Register in SHGAT if available (need to fetch embedding)
    const shgat = this.getSHGAT();
    if (shgat) {
      await this.registerInSHGAT(shgat, capabilityId, toolIds);
    }

    // 4. Compute and save entropy after graph change
    await this.saveEntropyAfterChange();
  }

  private async handleCapabilityUpdated(
    payload: CapabilityZoneUpdatedPayload,
  ): Promise<void> {
    const { capabilityId, toolIds } = payload;

    log.debug(`[GraphSyncController] Capability updated: ${capabilityId}`);

    // 1. Update graph engine (idempotent - adds edges if not exist)
    if (this.graphEngine) {
      this.graphEngine.addCapabilityNode(capabilityId, toolIds);
    }

    // 2. Update hyperedge cache
    await updateHyperedge(capabilityId, toolIds);

    // 3. Compute and save entropy after graph change
    await this.saveEntropyAfterChange();
  }

  /**
   * Handle capability merge - invalidate caches and trigger graph resync
   */
  private async handleCapabilityMerged(
    payload: CapabilityMergedPayload,
  ): Promise<void> {
    const { sourceName, sourcePatternId, targetName } = payload;

    log.info(
      `[GraphSyncController] Capability merged: ${sourceName} -> ${targetName}`,
    );

    // 1. Remove source capability node from graph (if it exists)
    if (this.graphEngine && sourcePatternId) {
      const capNodeId = `capability:${sourcePatternId}`;
      try {
        // GraphRAGEngine may not have removeNode, so we trigger a full resync
        log.debug(
          `[GraphSyncController] Source capability node ${capNodeId} removed via merge`,
        );
      } catch {
        // Node might not exist in graph
      }
    }

    // 2. Invalidate hyperedge cache for source
    if (sourcePatternId) {
      await invalidateHyperedge(`capability:${sourcePatternId}`);
    }

    // 3. Invalidate SHGAT cache for the merged capabilities
    const shgat = this.getSHGAT();
    if (shgat) {
      // SHGAT may need to be notified of topology change
      // For now, we rely on the next training cycle to pick up changes
      log.debug(
        `[GraphSyncController] SHGAT will pick up merge changes on next training cycle`,
      );
    }

    // 4. Trigger full graph resync to ensure consistency
    // This is heavier than incremental updates but ensures correctness after merge
    if (this.graphEngine) {
      try {
        await this.graphEngine.syncFromDatabase();
        log.info(`[GraphSyncController] Graph resynced after merge`);
      } catch (err) {
        log.error(`[GraphSyncController] Failed to resync graph after merge:`, err);
      }
    }

    // 5. Compute and save entropy after graph change
    await this.saveEntropyAfterChange();
  }

  /**
   * Compute and save entropy snapshot after graph structure changes.
   * Uses scope=system filtering (all executed tools, not full graph).
   * This ensures historical entropy data captures actual structural changes.
   */
  private async saveEntropyAfterChange(): Promise<void> {
    if (!this.graphEngine) return;

    try {
      // Get full graph snapshot
      const fullSnapshot = this.graphEngine.getGraphSnapshot();

      // Filter by scope=system (all executed tools by any user)
      const executedToolIds = await getExecutedToolIds(this.db, "system");
      let snapshot = fullSnapshot;
      if (executedToolIds.size > 0) {
        snapshot = filterSnapshotByExecution(fullSnapshot, executedToolIds);
      }

      const baseInput = snapshotToEntropyInput(snapshot);

      // Inject hyperedges from cache
      const cachedHyperedges = await getCachedHyperedges();
      const entropyInput: EntropyGraphInput = {
        ...baseInput,
        hyperedges: cachedHyperedges.length > 0
          ? cachedHyperedges.map((he) => ({
            id: he.capabilityId,
            members: he.members,
            weight: 1,
          }))
          : undefined,
      };

      // Compute entropy
      const result = computeTensorEntropy(entropyInput);

      // Save to history (system-level scope)
      await saveEntropySnapshot(this.db, result, undefined, undefined);

      log.debug(
        `[GraphSyncController] Saved entropy snapshot (scope=system): VN=${
          result.vonNeumannEntropy.toFixed(3)
        }, ` +
          `nodes=${result.meta.nodeCount}, edges=${result.meta.edgeCount}, hyperedges=${result.meta.hyperedgeCount}`,
      );
    } catch (err) {
      log.warn(`[GraphSyncController] Failed to save entropy: ${err}`);
    }
  }

  private async registerInSHGAT(
    shgat: SHGAT,
    capabilityId: string,
    toolsUsed: string[],
  ): Promise<void> {
    try {
      // Fetch embedding from DB
      const result = await this.db.query(
        `SELECT intent_embedding FROM workflow_pattern WHERE pattern_id = $1`,
        [capabilityId],
      );

      if (result.length === 0 || !result[0].intent_embedding) {
        log.debug(
          `[GraphSyncController] No embedding for capability ${capabilityId}, skipping SHGAT registration`,
        );
        return;
      }

      // Parse embedding
      let embedding: number[];
      const raw = result[0].intent_embedding;
      if (Array.isArray(raw)) {
        embedding = raw;
      } else if (typeof raw === "string") {
        try {
          embedding = JSON.parse(raw);
        } catch {
          log.warn(
            `[GraphSyncController] Failed to parse embedding for ${capabilityId}`,
          );
          return;
        }
      } else {
        return;
      }

      // Build members array from toolsUsed
      const members: Array<{ type: "tool"; id: string }> = toolsUsed.map(
        (toolId) => ({
          type: "tool" as const,
          id: toolId,
        }),
      );

      // Register in SHGAT with full CapabilityNode
      shgat.registerCapability({
        id: capabilityId,
        embedding,
        members,
        hierarchyLevel: 0, // Level 0 = only tools, no child capabilities
        successRate: 1.0, // New capabilities start at 100%
        toolsUsed, // Keep legacy field for compatibility
      });

      log.debug(
        `[GraphSyncController] Registered capability ${capabilityId} in SHGAT`,
      );
    } catch (err) {
      log.warn(`[GraphSyncController] Failed to register in SHGAT: ${err}`);
    }
  }
}
