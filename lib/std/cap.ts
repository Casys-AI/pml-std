/**
 * Cap Module - Capability Management Tools
 *
 * Story 13.5: cap:list, cap:rename, cap:lookup, cap:whois
 *
 * Provides tools for managing capabilities in the registry:
 * - cap:list: List capabilities with filtering and pagination
 * - cap:rename: Rename capability (updates display_name, creates alias)
 * - cap:lookup: Resolve name to capability details
 * - cap:whois: Get full metadata for a FQDN
 *
 * Architecture: Follows lib/std/ pattern (one file per module).
 *
 * @module lib/std/cap
 */

import {
  type CapabilityRegistry,
  getCapabilityDisplayName,
  getCapabilityFqdn,
  type Scope,
} from "../../src/capabilities/capability-registry.ts";
import type { DbClient } from "../../src/db/mod.ts";
import type { EmbeddingModelInterface } from "../../src/vector/embeddings.ts";
import { parseFQDN } from "../../src/capabilities/fqdn.ts";
import * as log from "@std/log";
import { z } from "zod";

// =============================================================================
// Embedding Text Builder
// =============================================================================

/**
 * Build text for embedding generation
 *
 * Combines name and description for better semantic search.
 * Format: "name: description" or just "name" if no description.
 *
 * @param name - Capability display name
 * @param description - Optional description
 * @returns Text for embedding generation
 */
export function buildEmbeddingText(name: string, description?: string | null): string {
  if (description) {
    return `${name}: ${description}`;
  }
  return name;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Options for cap:list tool
 */
export interface CapListOptions {
  /** Glob pattern to filter capabilities (e.g., "fs:*", "read_?") */
  pattern?: string;
  /** Only return unnamed_* capabilities */
  unnamedOnly?: boolean;
  /** Maximum number of results (default: 50) */
  limit?: number;
  /** Pagination offset (default: 0) */
  offset?: number;
}

/**
 * Single capability item in list response
 */
export interface CapListItem {
  /** UUID (immutable primary key) */
  id: string;
  /** FQDN (computed: org.project.namespace.action.hash) */
  fqdn: string;
  /** Display name (namespace:action) */
  name: string;
  /** Capability description (from workflow_pattern) */
  description: string | null;
  /** Namespace grouping */
  namespace: string;
  /** Action name */
  action: string;
  /** Total usage count */
  usageCount: number;
  /** Success rate (0-1) */
  successRate: number;
}

/**
 * Response from cap:list tool
 */
export interface CapListResponse {
  /** List of capabilities matching the query */
  items: CapListItem[];
  /** Total count (for pagination UI) */
  total: number;
  /** Limit used in query */
  limit: number;
  /** Offset used in query */
  offset: number;
}

/**
 * Options for cap:rename tool
 *
 * Allows updating namespace, action, description, tags, and visibility.
 * The UUID (id) remains immutable. FQDN is recomputed from namespace/action.
 */
export interface CapRenameOptions {
  /** Current name (namespace:action) or UUID to update */
  name: string;
  /** New namespace (e.g., "fs", "api", "data") */
  namespace?: string;
  /** New action name (e.g., "read_json", "fetch_user") */
  action?: string;
  /** Optional description update */
  description?: string;
  /** Optional tags update */
  tags?: string[];
  /** Optional visibility update */
  visibility?: "private" | "project" | "org" | "public";
}

/**
 * Response from cap:rename tool
 */
export interface CapRenameResponse {
  /** Whether rename succeeded */
  success: boolean;
  /** UUID (immutable) */
  id: string;
  /** New FQDN (recomputed if namespace/action changed) */
  fqdn: string;
  /** New display name (namespace:action) */
  displayName: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Options for cap:lookup tool
 */
export interface CapLookupOptions {
  /** Name to look up (display_name or alias) */
  name: string;
}

/**
 * Response from cap:lookup tool
 */
export interface CapLookupResponse {
  /** UUID of the capability */
  id: string;
  /** FQDN of the capability (computed) */
  fqdn: string;
  /** Display name (namespace:action) */
  displayName: string;
  /** Namespace */
  namespace: string;
  /** Action */
  action: string;
  /** Description from workflow_pattern */
  description: string | null;
  /** Total usage count */
  usageCount: number;
  /** Success rate (0-1) */
  successRate: number;
}

/**
 * Options for cap:whois tool
 */
export interface CapWhoisOptions {
  /** UUID or FQDN to look up */
  id: string;
}

/**
 * Full capability metadata from cap:whois
 */
export interface CapWhoisResponse {
  /** UUID primary key */
  id: string;
  /** FQDN (computed) */
  fqdn: string;
  /** Display name (namespace:action) */
  displayName: string;
  /** Organization */
  org: string;
  /** Project */
  project: string;
  /** Namespace */
  namespace: string;
  /** Action */
  action: string;
  /** Code hash (4 chars) */
  hash: string;
  /** FK to workflow_pattern */
  workflowPatternId: string | null;
  /** Creator */
  createdBy: string;
  /** Creation date (ISO string) */
  createdAt: string;
  /** Last updater */
  updatedBy: string | null;
  /** Last update date (ISO string) */
  updatedAt: string | null;
  /** Version number */
  version: number;
  /** Semantic version tag */
  versionTag: string | null;
  /** Whether verified */
  verified: boolean;
  /** Cryptographic signature */
  signature: string | null;
  /** Usage count */
  usageCount: number;
  /** Success count */
  successCount: number;
  /** Total latency in ms */
  totalLatencyMs: number;
  /** Tags */
  tags: string[];
  /** Visibility level */
  visibility: "private" | "project" | "org" | "public";
  /** Execution routing */
  routing: "local" | "cloud";
  /** Description from workflow_pattern */
  description?: string | null;
  /** Input parameters schema (JSON Schema) */
  parametersSchema?: Record<string, unknown> | null;
}

/**
 * Options for cap:merge tool
 *
 * Merges duplicate capabilities into a canonical one.
 * Requires identical tools_used arrays.
 */
export interface CapMergeOptions {
  /** Source capability to merge FROM (name, UUID, or FQDN) - will be deleted */
  source: string;
  /** Target capability to merge INTO (name, UUID, or FQDN) - will be updated */
  target: string;
  /** If true, use source's code_snippet even if older. Default: use newest. */
  preferSourceCode?: boolean;
}

/**
 * Zod schema for cap:merge validation
 */
export const CapMergeOptionsSchema = z.object({
  source: z.string().min(1, "source is required"),
  target: z.string().min(1, "target is required"),
  preferSourceCode: z.boolean().optional(),
});

/**
 * Response from cap:merge tool
 */
export interface CapMergeResponse {
  /** Whether merge succeeded */
  success: boolean;
  /** UUID of target capability */
  targetId: string;
  /** FQDN of target capability */
  targetFqdn: string;
  /** Display name of target */
  targetDisplayName: string;
  /** UUID of deleted source */
  deletedSourceId: string;
  /** Merged statistics summary */
  mergedStats: {
    usageCount: number;
    successCount: number;
    totalLatencyMs: number;
  };
  /** Which code_snippet was kept */
  codeSource: "source" | "target";
}

/**
 * MCP Tool definition for cap:* tools
 */
export interface CapTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Tool result format for MCP protocol
 */
export interface CapToolResult {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default scope for capability operations
 *
 * MVP LIMITATION: All cap:* tools operate on this hardcoded scope.
 * Multi-tenant support (org/project parameters) deferred to future story.
 * See: Epic 14 (JSR Package Local/Cloud MCP Routing) for multi-scope design.
 */
const DEFAULT_SCOPE: Scope = { org: "local", project: "default" };

/** Default pagination limit */
const DEFAULT_LIMIT = 50;

/** Maximum pagination limit */
const MAX_LIMIT = 500;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert glob pattern to SQL LIKE pattern
 *
 * @example
 * globToSqlLike("fs:*") // "fs:%"
 * globToSqlLike("read_?") // "read\__"
 */
export function globToSqlLike(pattern: string): string {
  return pattern
    .replace(/%/g, "\\%") // Escape existing %
    .replace(/_/g, "\\_") // Escape existing _
    .replace(/\*/g, "%") // Glob * → SQL %
    .replace(/\?/g, "_"); // Glob ? → SQL _
}

// =============================================================================
// CapModule Class
// =============================================================================

/**
 * CapModule - handles cap:* tool calls
 *
 * Implements the management tools for capabilities:
 * - Listing with filtering and pagination
 * - Renaming with alias creation
 * - Looking up by name or alias
 * - Getting full metadata (whois)
 */
export class CapModule {
  constructor(
    private registry: CapabilityRegistry,
    private db: DbClient,
    private embeddingModel?: EmbeddingModelInterface,
  ) {}

  /**
   * List available cap:* tools
   */
  listTools(): CapTool[] {
    return [
      {
        name: "cap:list",
        description:
          "List capabilities with optional filtering by pattern, unnamed-only flag, and pagination. Returns id, name, description, namespace, action, usageCount, successRate.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Glob pattern to filter capabilities (e.g., 'fs:*', 'read_?')",
            },
            unnamedOnly: {
              type: "boolean",
              description: "Only return unnamed_* capabilities",
            },
            limit: {
              type: "number",
              description: "Maximum results (default: 50, max: 500)",
            },
            offset: {
              type: "number",
              description: "Pagination offset (default: 0)",
            },
          },
        },
      },
      {
        name: "cap:rename",
        description:
          "Update a capability's namespace, action, description, tags, or visibility. UUID stays immutable. FQDN is recomputed if namespace/action changes.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Current name (namespace:action) or UUID to update",
            },
            namespace: {
              type: "string",
              description: "New namespace (e.g., 'fs', 'api', 'data')",
            },
            action: {
              type: "string",
              description: "New action name (e.g., 'read_json', 'fetch_user')",
            },
            description: {
              type: "string",
              description: "New description",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "New tags array",
            },
            visibility: {
              type: "string",
              enum: ["private", "project", "org", "public"],
              description: "New visibility level",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "cap:lookup",
        description:
          "Lookup a capability by name. Returns fqdn, displayName, description, usageCount, successRate. Warns if resolved via deprecated alias.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Name to look up (display_name or alias)",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "cap:whois",
        description:
          "Get complete metadata for a capability by UUID or FQDN. Returns full CapabilityRecord with all fields.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "UUID or FQDN to look up",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "cap:merge",
        description:
          "Merge duplicate capabilities into a canonical one. Combines usage stats, keeps newest code. Requires identical tools_used.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "Source capability to merge FROM (name, UUID, or FQDN) - will be deleted",
            },
            target: {
              type: "string",
              description: "Target capability to merge INTO (name, UUID, or FQDN) - will be updated",
            },
            preferSourceCode: {
              type: "boolean",
              description: "If true, use source's code_snippet even if older. Default: use newest.",
            },
          },
          required: ["source", "target"],
        },
      },
    ];
  }

  /**
   * Route call to appropriate handler
   */
  async call(name: string, args: unknown): Promise<CapToolResult> {
    try {
      switch (name) {
        case "cap:list":
          return await this.handleList(args as CapListOptions);
        case "cap:rename":
          return await this.handleRename(args as CapRenameOptions);
        case "cap:lookup":
          return await this.handleLookup(args as CapLookupOptions);
        case "cap:whois":
          return await this.handleWhois(args as CapWhoisOptions);
        case "cap:merge":
          return await this.handleMerge(args);
        default:
          return this.errorResult(`Unknown cap tool: ${name}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`[CapModule] Error in ${name}: ${msg}`);
      return this.errorResult(msg);
    }
  }

  /**
   * Handle cap:list - list capabilities with filtering and pagination
   *
   * AC1: Returns all with id, name, description, usageCount, namespace, action
   * AC2: Filter by pattern (glob to SQL LIKE)
   * AC3: Filter unnamed only
   * AC4: Pagination with total count
   */
  private async handleList(options: CapListOptions): Promise<CapToolResult> {
    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = options.offset ?? 0;

    // Build WHERE clauses
    const conditions: string[] = [
      "cr.org = $1",
      "cr.project = $2",
    ];
    const params: (string | number | boolean)[] = [DEFAULT_SCOPE.org, DEFAULT_SCOPE.project];

    // AC2: Pattern filter (now matches namespace:action)
    if (options.pattern) {
      const sqlPattern = globToSqlLike(options.pattern);
      params.push(sqlPattern);
      conditions.push(`(cr.namespace || ':' || cr.action) LIKE $${params.length} ESCAPE '\\'`);
    }

    // AC3: Unnamed only filter (now matches action starting with unnamed_)
    if (options.unnamedOnly) {
      conditions.push(`cr.action LIKE 'unnamed\\_%' ESCAPE '\\'`);
    }

    const whereClause = conditions.join(" AND ");

    // Query with total count using window function
    const query = `
      SELECT
        cr.id,
        cr.org,
        cr.project,
        cr.namespace,
        cr.action,
        cr.hash,
        cr.usage_count,
        cr.success_count,
        wp.description,
        COUNT(*) OVER() as total
      FROM capability_records cr
      LEFT JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
      WHERE ${whereClause}
      ORDER BY cr.usage_count DESC, cr.namespace ASC, cr.action ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);

    interface ListRow {
      id: string;
      org: string;
      project: string;
      namespace: string;
      action: string;
      hash: string;
      usage_count: number;
      success_count: number;
      description: string | null;
      total: string; // PostgreSQL returns bigint as string
    }

    const rows = (await this.db.query(query, params)) as unknown as ListRow[];

    // Extract total from first row (or 0 if empty)
    const total = rows.length > 0 ? parseInt(rows[0].total, 10) : 0;

    // Map to response format
    const items: CapListItem[] = rows.map((row) => ({
      id: row.id,
      fqdn: `${row.org}.${row.project}.${row.namespace}.${row.action}.${row.hash}`,
      name: `${row.namespace}:${row.action}`,
      description: row.description,
      namespace: row.namespace,
      action: row.action,
      usageCount: row.usage_count,
      successRate: row.usage_count > 0 ? row.success_count / row.usage_count : 0,
    }));

    const response: CapListResponse = {
      items,
      total,
      limit,
      offset,
    };

    log.info(`[CapModule] cap:list returned ${items.length} items (total: ${total})`);
    return this.successResult(response);
  }

  /**
   * Handle cap:rename - Update capability namespace, action, description, tags, visibility
   *
   * AC5: cap:rename({ name, namespace?, action?, description?, tags?, visibility? })
   * - UUID (id) stays immutable
   * - If namespace/action changes, FQDN is recomputed
   * - Note: capability_aliases table was removed in migration 028
   */
  private async handleRename(options: CapRenameOptions): Promise<CapToolResult> {
    const { name, namespace, action, description, tags, visibility } = options;

    // Resolve the capability by name (namespace:action) or UUID
    let record = await this.registry.resolveByName(name, DEFAULT_SCOPE);
    if (!record) {
      // Try by UUID
      record = await this.registry.getById(name);
    }
    if (!record) {
      return this.errorResult(`Capability not found: ${name}`);
    }

    const oldDisplayName = getCapabilityDisplayName(record);

    // Build dynamic UPDATE for capability_records
    const updates: string[] = [];
    const params: (string | string[] | number)[] = [];
    let paramIndex = 1;

    if (namespace !== undefined) {
      updates.push(`namespace = $${paramIndex++}`);
      params.push(namespace);
    }
    if (action !== undefined) {
      updates.push(`action = $${paramIndex++}`);
      params.push(action);
    }
    if (tags !== undefined) {
      updates.push(`tags = $${paramIndex++}`);
      params.push(tags);
    }
    if (visibility !== undefined) {
      updates.push(`visibility = $${paramIndex++}`);
      params.push(visibility);
    }

    // Always update updated_at
    updates.push(`updated_at = NOW()`);
    updates.push(`updated_by = $${paramIndex++}`);
    params.push("system"); // TODO: get actual user from context

    // Execute capability_records update if we have fields to update
    if (updates.length > 2) {
      // More than just updated_at and updated_by
      params.push(record.id);
      await this.db.query(
        `UPDATE capability_records
         SET ${updates.join(", ")}
         WHERE id = $${paramIndex}`,
        params,
      );
      log.info(`[CapModule] Updated capability_records for ${record.id}`);
    }

    // Update description in workflow_pattern if provided
    if (description !== undefined && record.workflowPatternId) {
      await this.db.query(
        `UPDATE workflow_pattern
         SET description = $2
         WHERE pattern_id = $1`,
        [record.workflowPatternId, description],
      );

      // Recalculate embedding with updated description
      const newNamespace = namespace ?? record.namespace;
      const newAction = action ?? record.action;
      const newDisplayName = `${newNamespace}:${newAction}`;

      if (this.embeddingModel) {
        try {
          const embeddingText = buildEmbeddingText(newDisplayName, description);
          const newEmbedding = await this.embeddingModel.encode(embeddingText);
          const embeddingStr = `[${newEmbedding.join(",")}]`;

          await this.db.query(
            `UPDATE workflow_pattern
             SET intent_embedding = $1::vector
             WHERE pattern_id = $2`,
            [embeddingStr, record.workflowPatternId],
          );
          log.info(`[CapModule] Embedding updated for ${newDisplayName}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log.warn(`[CapModule] Failed to update embedding: ${msg}`);
        }
      }
    }

    // Compute final values
    const finalNamespace = namespace ?? record.namespace;
    const finalAction = action ?? record.action;
    const newFqdn =
      `${record.org}.${record.project}.${finalNamespace}.${finalAction}.${record.hash}`;
    const newDisplayName = `${finalNamespace}:${finalAction}`;

    const response: CapRenameResponse = {
      success: true,
      id: record.id,
      fqdn: newFqdn,
      displayName: newDisplayName,
    };

    log.info(`[CapModule] cap:rename ${oldDisplayName} -> ${newDisplayName}`);
    return this.successResult(response);
  }

  /**
   * Handle cap:lookup - resolve name to capability details
   *
   * Resolves namespace:action to capability record with metadata.
   */
  private async handleLookup(options: CapLookupOptions): Promise<CapToolResult> {
    const { name } = options;

    // Resolve by name (namespace:action format)
    const record = await this.registry.resolveByName(name, DEFAULT_SCOPE);

    if (!record) {
      return this.errorResult(`Capability not found: ${name}`);
    }

    // Get description from workflow_pattern
    interface DescRow {
      description: string | null;
    }
    let description: string | null = null;
    if (record.workflowPatternId) {
      const descRows = (await this.db.query(
        `SELECT description FROM workflow_pattern WHERE pattern_id = $1`,
        [record.workflowPatternId],
      )) as unknown as DescRow[];
      if (descRows.length > 0) {
        description = descRows[0].description;
      }
    }

    const response: CapLookupResponse = {
      id: record.id,
      fqdn: getCapabilityFqdn(record),
      displayName: getCapabilityDisplayName(record),
      namespace: record.namespace,
      action: record.action,
      description,
      usageCount: record.usageCount,
      successRate: record.usageCount > 0 ? record.successCount / record.usageCount : 0,
    };

    log.info(`[CapModule] cap:lookup '${name}' -> ${record.id}`);
    return this.successResult(response);
  }

  /**
   * Handle cap:whois - get full metadata for a capability
   *
   * Accepts UUID or FQDN and returns complete metadata.
   */
  private async handleWhois(options: CapWhoisOptions): Promise<CapToolResult> {
    const { id } = options;

    // Validate id is provided
    if (!id) {
      return this.errorResult("id parameter is required");
    }

    // Try to find by UUID first, then parse as FQDN
    let record = await this.registry.getById(id);

    if (!record) {
      // Try to parse as FQDN and look up by components
      try {
        const components = parseFQDN(id);
        record = await this.registry.getByFqdnComponents(
          components.org,
          components.project,
          components.namespace,
          components.action,
          components.hash,
        );
      } catch {
        // Not a valid FQDN, that's OK - record stays null
      }
    }

    if (!record) {
      return this.errorResult(`Capability not found: ${id}`);
    }

    // Get description and parameters_schema from workflow_pattern
    interface PatternRow {
      description: string | null;
      parameters_schema: Record<string, unknown> | null;
    }
    let description: string | null = null;
    let parametersSchema: Record<string, unknown> | null = null;
    if (record.workflowPatternId) {
      const patternRows = (await this.db.query(
        `SELECT description, parameters_schema FROM workflow_pattern WHERE pattern_id = $1`,
        [record.workflowPatternId],
      )) as unknown as PatternRow[];
      if (patternRows.length > 0) {
        description = patternRows[0].description;
        parametersSchema = patternRows[0].parameters_schema;
      }
    }

    const response: CapWhoisResponse = {
      id: record.id,
      fqdn: getCapabilityFqdn(record),
      displayName: getCapabilityDisplayName(record),
      org: record.org,
      project: record.project,
      namespace: record.namespace,
      action: record.action,
      hash: record.hash,
      workflowPatternId: record.workflowPatternId ?? null,
      createdBy: record.createdBy,
      createdAt: record.createdAt.toISOString(),
      updatedBy: record.updatedBy ?? null,
      updatedAt: record.updatedAt?.toISOString() ?? null,
      version: record.version,
      versionTag: record.versionTag ?? null,
      verified: record.verified,
      signature: record.signature ?? null,
      usageCount: record.usageCount,
      successCount: record.successCount,
      totalLatencyMs: record.totalLatencyMs,
      tags: record.tags,
      visibility: record.visibility,
      routing: record.routing,
      description,
      parametersSchema,
    };

    log.info(`[CapModule] cap:whois ${id} -> ${record.id}`);
    return this.successResult(response);
  }

  /**
   * Handle cap:merge - merge duplicate capabilities
   *
   * AC1: usage_count = source + target
   * AC2: created_at = MIN(source, target)
   * AC3: Reject if tools_used differ
   * AC4: Use newest code_snippet by default
   * AC5: preferSourceCode overrides code selection
   * AC6: Delete source after merge
   */
  private async handleMerge(args: unknown): Promise<CapToolResult> {
    // Validate with Zod
    const parsed = CapMergeOptionsSchema.safeParse(args);
    if (!parsed.success) {
      return this.errorResult(`Invalid arguments: ${parsed.error.message}`);
    }
    const { source, target, preferSourceCode } = parsed.data;

    // Prevent self-merge
    if (source === target) {
      return this.errorResult("Cannot merge capability into itself");
    }

    // Resolve source capability
    let sourceRecord = await this.registry.resolveByName(source, DEFAULT_SCOPE);
    if (!sourceRecord) {
      sourceRecord = await this.registry.getById(source);
    }
    if (!sourceRecord) {
      return this.errorResult(`Source capability not found: ${source}`);
    }

    // Resolve target capability
    let targetRecord = await this.registry.resolveByName(target, DEFAULT_SCOPE);
    if (!targetRecord) {
      targetRecord = await this.registry.getById(target);
    }
    if (!targetRecord) {
      return this.errorResult(`Target capability not found: ${target}`);
    }

    // Get tools_used from workflow_pattern.dag_structure and code_snippet
    // Migration 023 moved these columns from capability_records to workflow_pattern
    interface CapRow {
      tools_used: string[] | null;
      code_snippet: string | null;
      updated_at: Date | null;
    }
    const sourceRows = (await this.db.query(
      `SELECT
         wp.dag_structure->'tools_used' as tools_used,
         wp.code_snippet,
         cr.updated_at
       FROM capability_records cr
       LEFT JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
       WHERE cr.id = $1`,
      [sourceRecord.id],
    )) as unknown as CapRow[];
    const targetRows = (await this.db.query(
      `SELECT
         wp.dag_structure->'tools_used' as tools_used,
         wp.code_snippet,
         cr.updated_at
       FROM capability_records cr
       LEFT JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
       WHERE cr.id = $1`,
      [targetRecord.id],
    )) as unknown as CapRow[];

    if (sourceRows.length === 0 || targetRows.length === 0) {
      return this.errorResult("Failed to fetch capability details");
    }

    const sourceData = sourceRows[0];
    const targetData = targetRows[0];

    // AC3: Validate tools_used match (set comparison)
    const sourceTools = new Set(sourceData.tools_used || []);
    const targetTools = new Set(targetData.tools_used || []);
    const toolsMatch =
      sourceTools.size === targetTools.size &&
      [...sourceTools].every((t) => targetTools.has(t));

    if (!toolsMatch) {
      return this.errorResult(
        `Cannot merge: tools_used mismatch. Source: [${[...sourceTools].join(", ")}], Target: [${[...targetTools].join(", ")}]`,
      );
    }

    // Calculate merged stats
    const mergedUsageCount = sourceRecord.usageCount + targetRecord.usageCount;
    const mergedSuccessCount = sourceRecord.successCount + targetRecord.successCount;
    const mergedLatencyMs = sourceRecord.totalLatencyMs + targetRecord.totalLatencyMs;
    const mergedCreatedAt =
      sourceRecord.createdAt < targetRecord.createdAt
        ? sourceRecord.createdAt
        : targetRecord.createdAt;

    // AC4/AC5: Determine code_snippet winner
    let useSourceCode = preferSourceCode ?? false;
    if (preferSourceCode === undefined) {
      // Default: use newest (by updated_at, fallback to created_at)
      const sourceTime = sourceData.updated_at ?? sourceRecord.createdAt;
      const targetTime = targetData.updated_at ?? targetRecord.createdAt;
      useSourceCode = sourceTime > targetTime;
    }
    const finalCodeSnippet = useSourceCode
      ? sourceData.code_snippet
      : targetData.code_snippet;

    // Execute merge in a real transaction for atomicity
    // If DELETE fails, UPDATE is rolled back
    await this.db.transaction(async (tx) => {
      // Update target capability_records with merged stats
      await tx.exec(
        `UPDATE capability_records SET
          usage_count = $1,
          success_count = $2,
          total_latency_ms = $3,
          created_at = $4,
          updated_at = NOW(),
          updated_by = 'cap:merge'
        WHERE id = $5`,
        [
          mergedUsageCount,
          mergedSuccessCount,
          mergedLatencyMs,
          mergedCreatedAt,
          targetRecord.id,
        ],
      );

      // Update workflow_pattern code_snippet if target has one and we chose source code
      if (targetRecord.workflowPatternId && finalCodeSnippet !== null) {
        await tx.exec(
          `UPDATE workflow_pattern SET
            code_snippet = $1
          WHERE pattern_id = $2`,
          [finalCodeSnippet, targetRecord.workflowPatternId],
        );
      }

      // AC6: Delete source
      await tx.exec(`DELETE FROM capability_records WHERE id = $1`, [
        sourceRecord.id,
      ]);
    });

    const response: CapMergeResponse = {
      success: true,
      targetId: targetRecord.id,
      targetFqdn: getCapabilityFqdn(targetRecord),
      targetDisplayName: getCapabilityDisplayName(targetRecord),
      deletedSourceId: sourceRecord.id,
      mergedStats: {
        usageCount: mergedUsageCount,
        successCount: mergedSuccessCount,
        totalLatencyMs: mergedLatencyMs,
      },
      codeSource: useSourceCode ? "source" : "target",
    };

    log.info(
      `[CapModule] cap:merge ${getCapabilityDisplayName(sourceRecord)} -> ${getCapabilityDisplayName(targetRecord)} (usage: ${mergedUsageCount})`,
    );
    return this.successResult(response);
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  private successResult(data: unknown): CapToolResult {
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  private errorResult(message: string): CapToolResult {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
}

// =============================================================================
// Global CapModule for MiniTools integration (same pattern as agent.ts)
// =============================================================================

let _capModule: CapModule | null = null;

/**
 * Set the CapModule instance for pmlTools handlers
 * Called by mcp-tools-server.ts or gateway at init
 */
export function setCapModule(module: CapModule): void {
  _capModule = module;
  log.info("[cap.ts] CapModule set for pmlTools");
}

/**
 * Get the CapModule, throw if not initialized
 */
export function getCapModule(): CapModule {
  if (!_capModule) {
    throw new Error(
      "CapModule not initialized. Call setCapModule() first or use PmlStdServer.",
    );
  }
  return _capModule;
}

// =============================================================================
// pmlTools - MiniTool array for discovery
// =============================================================================

import type { MiniTool } from "./types.ts";

/**
 * PML capability management tools as MiniTool array
 * These tools require CapModule to be set via setCapModule()
 */
export const pmlTools: MiniTool[] = [
  {
    name: "cap_list",
    description: "List capabilities with optional filtering by pattern and pagination",
    category: "pml",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to filter capabilities (e.g., 'fs:*', 'read_?')",
        },
        unnamedOnly: {
          type: "boolean",
          description: "Only return unnamed_* capabilities",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 50, max: 500)",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default: 0)",
        },
      },
    },
    handler: async (args) => {
      const result = await getCapModule().call("cap:list", args);
      return JSON.parse(result.content[0].text);
    },
  },
  {
    name: "cap_rename",
    description:
      "Update a capability's namespace, action, description, tags, or visibility. UUID stays immutable.",
    category: "pml",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Current name (namespace:action) or UUID to update",
        },
        namespace: {
          type: "string",
          description: "New namespace (e.g., 'fs', 'api', 'data')",
        },
        action: {
          type: "string",
          description: "New action name (e.g., 'read_json', 'fetch_user')",
        },
        description: {
          type: "string",
          description: "New description",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "New tags array",
        },
        visibility: {
          type: "string",
          enum: ["private", "project", "org", "public"],
          description: "New visibility level",
        },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const result = await getCapModule().call("cap:rename", args);
      return JSON.parse(result.content[0].text);
    },
  },
  {
    name: "cap_lookup",
    description: "Resolve a capability name to its details (FQDN, description, usage stats)",
    category: "pml",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name to look up (display_name or alias)",
        },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const result = await getCapModule().call("cap:lookup", args);
      return JSON.parse(result.content[0].text);
    },
  },
  {
    name: "cap_whois",
    description: "Get complete metadata for a capability by UUID, FQDN, or name (namespace:action)",
    category: "pml",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "UUID, FQDN, or display name (namespace:action) to look up",
        },
      },
      required: ["name"],
    },
    handler: async (args) => {
      // Support name (namespace:action), UUID, or FQDN
      const { name } = args as { name: string };
      // Try lookup by name first (namespace:action), fall back to whois (UUID/FQDN)
      const lookupResult = await getCapModule().call("cap:lookup", { name });
      const lookupData = JSON.parse(lookupResult.content[0].text);
      if (!lookupData.error) {
        // Found by name, now get full whois by UUID
        const whoisResult = await getCapModule().call("cap:whois", { id: lookupData.id });
        return JSON.parse(whoisResult.content[0].text);
      }
      // Fall back to whois directly (UUID or FQDN)
      const result = await getCapModule().call("cap:whois", { id: name });
      return JSON.parse(result.content[0].text);
    },
  },
  {
    name: "cap_merge",
    description:
      "Merge duplicate capabilities into one. Combines usage stats, keeps newest code. Requires identical tools_used.",
    category: "pml",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source capability to merge FROM (name, UUID, or FQDN) - will be deleted",
        },
        target: {
          type: "string",
          description: "Target capability to merge INTO (name, UUID, or FQDN) - will be updated",
        },
        preferSourceCode: {
          type: "boolean",
          description: "If true, use source's code_snippet even if older. Default: use newest.",
        },
      },
      required: ["source", "target"],
    },
    handler: async (args) => {
      const result = await getCapModule().call("cap:merge", args);
      return JSON.parse(result.content[0].text);
    },
  },
];

// =============================================================================
// PmlStdServer Class (for Gateway integration)
// =============================================================================

/**
 * PML Standard Library Server
 *
 * Virtual MCP server that exposes capability management tools.
 * Routes cap:* calls to the CapModule.
 */
export class PmlStdServer {
  readonly serverId = "pml-std";
  private cap: CapModule;

  constructor(
    registry: CapabilityRegistry,
    db: DbClient,
    embeddingModel?: EmbeddingModelInterface,
  ) {
    this.cap = new CapModule(registry, db, embeddingModel);
    // Set global CapModule for pmlTools discovery
    setCapModule(this.cap);
    log.info(
      `[PmlStdServer] Initialized with cap:* tools${
        embeddingModel ? " (embedding support enabled)" : ""
      }`,
    );
  }

  /** Get the underlying CapModule */
  getCapModule(): CapModule {
    return this.cap;
  }

  handleListTools(): CapTool[] {
    return this.cap.listTools();
  }

  async handleCallTool(name: string, args: unknown): Promise<CapToolResult> {
    if (!name.startsWith("cap:")) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }
    return await this.cap.call(name, args);
  }

  isCapManagementTool(toolName: string): boolean {
    return toolName.startsWith("cap:");
  }
}
