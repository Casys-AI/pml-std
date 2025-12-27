/**
 * Capability Registry (Story 13.1)
 *
 * Registry for named capabilities with FQDN structure, scope resolution,
 * and alias support for backward-compatible renames.
 *
 * Architecture: Works with `capability_records` and `capability_aliases` tables
 * created by migration 021.
 *
 * @module capabilities/capability-registry
 */

import type { DbClient } from "../db/types.ts";
import type {
  AliasResolutionResult,
  CapabilityAlias,
  CapabilityRecord,
  CapabilityRouting,
  CapabilityVisibility,
  Scope,
} from "./types.ts";
import { generateFQDN, isValidMCPName } from "./fqdn.ts";
import * as log from "@std/log";

// Re-export for convenience
export type { AliasResolutionResult, CapabilityAlias, CapabilityRecord, Scope };

/**
 * Input for creating a new capability record
 *
 * Note: code_snippet, description, parameters_schema, tools_used are stored in
 * workflow_pattern table, linked via workflowPatternId FK (migration 023).
 */
export interface CreateCapabilityRecordInput {
  /** Free-format display name (user-chosen) */
  displayName: string;
  /** Organization */
  org: string;
  /** Project */
  project: string;
  /** Namespace grouping */
  namespace: string;
  /** Action name */
  action: string;
  /** FK to workflow_pattern.pattern_id (required - code lives there) */
  workflowPatternId: string;
  /** Hash for FQDN generation (4 lowercase hex chars) */
  hash: string;
  /** Who is creating this record */
  createdBy?: string;
  /** Optional tags */
  tags?: string[];
  /** Visibility level (default: private) */
  visibility?: CapabilityVisibility;
  /** Execution routing (default: local) */
  routing?: CapabilityRouting;
}

/**
 * Capability Registry class
 *
 * Provides methods for:
 * - Creating and registering capabilities with FQDN
 * - Resolving names by scope (AC7)
 * - Resolving aliases with deprecation warnings (AC8)
 * - Managing alias chains (AC9)
 */
export class CapabilityRegistry {
  private db: DbClient;

  constructor(db: DbClient) {
    this.db = db;
  }

  /**
   * Create a new capability record with generated FQDN (AC4)
   *
   * Note: Code, description, params, tools are in workflow_pattern via FK.
   *
   * @param input - The capability record data
   * @returns The created record with FQDN
   */
  async create(input: CreateCapabilityRecordInput): Promise<CapabilityRecord> {
    // Validate display name for MCP compatibility
    if (!isValidMCPName(input.displayName)) {
      throw new Error(
        `Invalid display name: "${input.displayName}". Must be alphanumeric with underscores, hyphens, and colons only.`,
      );
    }

    // Generate FQDN using provided hash
    const fqdn = generateFQDN({
      org: input.org,
      project: input.project,
      namespace: input.namespace,
      action: input.action,
      hash: input.hash,
    });

    const now = new Date();
    const createdBy = input.createdBy || "local";

    // Insert into database - code/description/params/tools are in workflow_pattern via FK
    await this.db.query(
      `
      INSERT INTO capability_records (
        id, display_name, org, project, namespace, action, hash,
        workflow_pattern_id, created_by, created_at, visibility, routing, tags
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13
      )
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        updated_by = EXCLUDED.created_by,
        updated_at = NOW(),
        version = capability_records.version + 1,
        tags = EXCLUDED.tags
    `,
      [
        fqdn,
        input.displayName,
        input.org,
        input.project,
        input.namespace,
        input.action,
        input.hash,
        input.workflowPatternId,
        createdBy,
        now.toISOString(),
        input.visibility || "private",
        input.routing || "local",
        input.tags || [],
      ],
    );

    // Fetch and return the created record
    const record = await this.getByFqdn(fqdn);
    if (!record) {
      throw new Error(`Failed to create capability record: ${fqdn}`);
    }

    log.info(`Created capability record: ${fqdn}`);
    return record;
  }

  /**
   * Get a capability record by FQDN
   *
   * @param fqdn - The fully qualified domain name
   * @returns The record or null if not found
   */
  async getByFqdn(fqdn: string): Promise<CapabilityRecord | null> {
    const rows = await this.db.query(
      `SELECT * FROM capability_records WHERE id = $1`,
      [fqdn],
    );

    if (rows.length === 0) {
      return null;
    }

    return this.rowToRecord(rows[0]);
  }

  /**
   * Resolve a name to a capability record within a scope (AC7)
   *
   * Resolution order:
   * 1. Exact match on (org, project, display_name)
   * 2. Match by namespace:action format (for MCP tool calls)
   * 3. Alias match in capability_aliases
   * 4. Public capability match (visibility = 'public')
   *
   * @param name - The display name or namespace:action to resolve
   * @param scope - The org/project scope
   * @returns The resolved record or null
   */
  async resolveByName(
    name: string,
    scope: Scope,
  ): Promise<CapabilityRecord | null> {
    // 1. Try exact match in current scope by display_name
    const exactMatch = await this.db.query(
      `SELECT * FROM capability_records
       WHERE org = $1 AND project = $2 AND display_name = $3`,
      [scope.org, scope.project, name],
    );

    if (exactMatch.length > 0) {
      return this.rowToRecord(exactMatch[0]);
    }

    // 2. Try namespace:action format (used by CapabilityMCPServer)
    const colonIndex = name.indexOf(":");
    if (colonIndex > 0) {
      const namespace = name.substring(0, colonIndex);
      const action = name.substring(colonIndex + 1);

      const namespaceMatch = await this.db.query(
        `SELECT * FROM capability_records
         WHERE org = $1 AND project = $2 AND namespace = $3 AND action = $4`,
        [scope.org, scope.project, namespace, action],
      );

      if (namespaceMatch.length > 0) {
        return this.rowToRecord(namespaceMatch[0]);
      }
    }

    // 3. Try alias resolution
    const aliasResult = await this.resolveByAlias(name, scope);
    if (aliasResult) {
      return aliasResult.record;
    }

    // 4. Try public capability match by display_name
    const publicMatch = await this.db.query(
      `SELECT * FROM capability_records
       WHERE display_name = $1 AND visibility = 'public'
       LIMIT 1`,
      [name],
    );

    if (publicMatch.length > 0) {
      return this.rowToRecord(publicMatch[0]);
    }

    return null;
  }

  /**
   * Resolve a name via alias table with deprecation warning (AC8)
   *
   * When resolving via alias, logs a warning about deprecated name.
   *
   * @param alias - The old/alternative name
   * @param scope - The org/project scope
   * @returns Resolution result with isAlias flag, or null if not found
   */
  async resolveByAlias(
    alias: string,
    scope: Scope,
  ): Promise<AliasResolutionResult | null> {
    // Look up in alias table
    const aliasRows = await this.db.query(
      `SELECT target_fqdn FROM capability_aliases
       WHERE org = $1 AND project = $2 AND alias = $3`,
      [scope.org, scope.project, alias],
    );

    if (aliasRows.length === 0) {
      return null;
    }

    const targetFqdn = aliasRows[0].target_fqdn as string;
    const record = await this.getByFqdn(targetFqdn);

    if (!record) {
      log.warn(`Alias "${alias}" points to non-existent FQDN: ${targetFqdn}`);
      return null;
    }

    // Log deprecation warning (AC8)
    log.warn(
      `Deprecated: Using alias "${alias}" for capability "${record.displayName}" (${targetFqdn}). ` +
        `Update your code to use the new name.`,
    );

    return {
      record,
      isAlias: true,
      usedAlias: alias,
    };
  }

  /**
   * Create an alias for a capability (AC8)
   *
   * @param org - Organization scope
   * @param project - Project scope
   * @param alias - The old/alternative name
   * @param targetFqdn - The current FQDN to point to
   */
  async createAlias(
    org: string,
    project: string,
    alias: string,
    targetFqdn: string,
  ): Promise<void> {
    // Validate target exists
    const target = await this.getByFqdn(targetFqdn);
    if (!target) {
      throw new Error(`Target FQDN not found: ${targetFqdn}`);
    }

    // Validate alias name for MCP compatibility
    if (!isValidMCPName(alias)) {
      throw new Error(
        `Invalid alias: "${alias}". Must be alphanumeric with underscores, hyphens, and colons only.`,
      );
    }

    // Insert alias using query (PGlite requires query for parameterized SQL)
    await this.db.query(
      `INSERT INTO capability_aliases (alias, org, project, target_fqdn, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (org, project, alias) DO UPDATE SET
         target_fqdn = EXCLUDED.target_fqdn,
         created_at = NOW()`,
      [alias, org, project, targetFqdn],
    );

    log.info(`Created alias: ${alias} -> ${targetFqdn} (scope: ${org}.${project})`);
  }

  /**
   * Update all aliases pointing to oldFqdn to point to newFqdn (AC9)
   *
   * Prevents alias chains by directly updating all aliases that pointed
   * to the old FQDN.
   *
   * @param oldFqdn - The old FQDN being renamed
   * @param newFqdn - The new FQDN to point to
   * @returns Number of aliases updated
   */
  async updateAliasChains(oldFqdn: string, newFqdn: string): Promise<number> {
    // Validate new target exists
    const target = await this.getByFqdn(newFqdn);
    if (!target) {
      throw new Error(`New target FQDN not found: ${newFqdn}`);
    }

    // Update all aliases pointing to old FQDN
    const result = await this.db.query(
      `UPDATE capability_aliases
       SET target_fqdn = $1
       WHERE target_fqdn = $2
       RETURNING alias`,
      [newFqdn, oldFqdn],
    );

    const count = result.length;
    if (count > 0) {
      log.info(
        `Updated ${count} alias(es) from ${oldFqdn} to ${newFqdn}: ` +
          result.map((r) => r.alias as string).join(", "),
      );
    }

    return count;
  }

  /**
   * Rename a capability (creates alias for old name, updates alias chains)
   *
   * This is a convenience method that:
   * 1. Creates a new record with the new name
   * 2. Creates an alias from old display name to new FQDN
   * 3. Updates all existing aliases to point to new FQDN
   *
   * @param oldFqdn - The current FQDN
   * @param newDisplayName - The new display name
   * @returns The new capability record
   */
  async rename(oldFqdn: string, newDisplayName: string): Promise<CapabilityRecord> {
    const oldRecord = await this.getByFqdn(oldFqdn);
    if (!oldRecord) {
      throw new Error(`Capability not found: ${oldFqdn}`);
    }

    if (!oldRecord.workflowPatternId) {
      throw new Error(`Cannot rename capability without workflowPatternId: ${oldFqdn}`);
    }

    // Create new record with new display name, keeping same FK
    const newRecord = await this.create({
      displayName: newDisplayName,
      org: oldRecord.org,
      project: oldRecord.project,
      namespace: oldRecord.namespace,
      action: oldRecord.action,
      workflowPatternId: oldRecord.workflowPatternId,
      hash: oldRecord.hash,
      createdBy: oldRecord.createdBy,
      tags: oldRecord.tags,
      visibility: oldRecord.visibility,
      routing: oldRecord.routing,
    });

    // Create alias from old display name to new FQDN
    await this.createAlias(
      oldRecord.org,
      oldRecord.project,
      oldRecord.displayName,
      newRecord.id,
    );

    // Update all existing aliases to point to new FQDN (AC9)
    await this.updateAliasChains(oldFqdn, newRecord.id);

    // Delete old record using query (PGlite requires query for parameterized SQL)
    await this.db.query(
      `DELETE FROM capability_records WHERE id = $1`,
      [oldFqdn],
    );

    log.info(`Renamed capability: ${oldFqdn} -> ${newRecord.id}`);
    return newRecord;
  }

  /**
   * List all capabilities in a scope
   *
   * @param scope - The org/project scope
   * @param limit - Maximum results (default: 100)
   * @param offset - Pagination offset (default: 0)
   * @returns List of capability records
   */
  async listByScope(
    scope: Scope,
    limit = 100,
    offset = 0,
  ): Promise<CapabilityRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM capability_records
       WHERE org = $1 AND project = $2
       ORDER BY display_name ASC
       LIMIT $3 OFFSET $4`,
      [scope.org, scope.project, limit, offset],
    );

    return rows.map((row) => this.rowToRecord(row));
  }

  /**
   * List all aliases for a capability
   *
   * @param fqdn - The FQDN to find aliases for
   * @returns List of aliases
   */
  async getAliases(fqdn: string): Promise<CapabilityAlias[]> {
    const rows = await this.db.query(
      `SELECT * FROM capability_aliases WHERE target_fqdn = $1`,
      [fqdn],
    );

    return rows.map((row) => ({
      alias: row.alias as string,
      org: row.org as string,
      project: row.project as string,
      targetFqdn: row.target_fqdn as string,
      createdAt: new Date(row.created_at as string),
    }));
  }

  /**
   * Increment usage metrics for a capability
   *
   * @param fqdn - The FQDN of the capability
   * @param success - Whether execution was successful
   * @param latencyMs - Execution latency in milliseconds
   */
  async recordUsage(
    fqdn: string,
    success: boolean,
    latencyMs: number,
  ): Promise<void> {
    // Use query (PGlite requires query for parameterized SQL)
    await this.db.query(
      `UPDATE capability_records
       SET
         usage_count = usage_count + 1,
         success_count = success_count + CASE WHEN $2 THEN 1 ELSE 0 END,
         total_latency_ms = total_latency_ms + $3,
         updated_at = NOW()
       WHERE id = $1`,
      [fqdn, success, latencyMs],
    );
  }

  /**
   * Convert database row to CapabilityRecord
   *
   * Note: code_snippet, description, parameters_schema, tools_used are now
   * in workflow_pattern, accessed via workflowPatternId FK.
   */
  private rowToRecord(row: Record<string, unknown>): CapabilityRecord {
    return {
      id: row.id as string,
      displayName: row.display_name as string,
      org: row.org as string,
      project: row.project as string,
      namespace: row.namespace as string,
      action: row.action as string,
      hash: row.hash as string,
      workflowPatternId: row.workflow_pattern_id as string | undefined,
      createdBy: row.created_by as string,
      createdAt: new Date(row.created_at as string),
      updatedBy: row.updated_by as string | undefined,
      updatedAt: row.updated_at ? new Date(row.updated_at as string) : undefined,
      version: row.version as number,
      versionTag: row.version_tag as string | undefined,
      verified: row.verified as boolean,
      signature: row.signature as string | undefined,
      usageCount: row.usage_count as number,
      successCount: row.success_count as number,
      totalLatencyMs: row.total_latency_ms as number,
      tags: (row.tags as string[]) || [],
      visibility: row.visibility as CapabilityVisibility,
      routing: row.routing as CapabilityRouting,
    };
  }
}
