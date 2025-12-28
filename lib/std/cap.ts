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
  type Scope,
  getCapabilityDisplayName,
  getCapabilityFqdn,
} from "../../src/capabilities/capability-registry.ts";
import type { DbClient } from "../../src/db/mod.ts";
import type { EmbeddingModelInterface } from "../../src/vector/embeddings.ts";
import { isValidMCPName, parseFQDN } from "../../src/capabilities/fqdn.ts";
import * as log from "@std/log";

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
 */
export interface CapRenameOptions {
  /** Current name or FQDN to rename */
  name: string;
  /** New display_name (FQDN stays immutable) */
  newName: string;
  /** Optional description update */
  description?: string;
}

/**
 * Response from cap:rename tool
 */
export interface CapRenameResponse {
  /** Whether rename succeeded */
  success: boolean;
  /** FQDN (unchanged - immutable) */
  fqdn: string;
  /** Whether an alias was created for the old name (always false - aliases removed) */
  aliasCreated: boolean;
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
          "Rename a capability by updating its display_name. Old name is overwritten (no alias). FQDN remains immutable.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Current name or FQDN to rename",
            },
            newName: {
              type: "string",
              description: "New display name",
            },
            description: {
              type: "string",
              description: "Optional new description",
            },
          },
          required: ["name", "newName"],
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
          "Get complete metadata for a capability by FQDN. Returns full CapabilityRecord with all fields.",
        inputSchema: {
          type: "object",
          properties: {
            fqdn: {
              type: "string",
              description: "FQDN to look up (e.g., 'local.default.fs.read_json.a7f3')",
            },
          },
          required: ["fqdn"],
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
   * Handle cap:rename - DEPRECATED: Names are now immutable (namespace:action)
   *
   * This function now only updates the description.
   * The 'newName' parameter is ignored since names are derived from namespace:action.
   */
  private async handleRename(options: CapRenameOptions): Promise<CapToolResult> {
    const { name, description } = options;

    // Resolve the capability by name (namespace:action format)
    const record = await this.registry.resolveByName(name, DEFAULT_SCOPE);
    if (!record) {
      return this.errorResult(`Capability not found: ${name}`);
    }

    const fqdn = getCapabilityFqdn(record);
    const displayName = getCapabilityDisplayName(record);

    // Only update description if provided
    if (description !== undefined && record.workflowPatternId) {
      await this.db.query(
        `UPDATE workflow_pattern
         SET description = $2
         WHERE pattern_id = $1`,
        [record.workflowPatternId, description],
      );

      // Recalculate embedding with updated description
      if (this.embeddingModel) {
        try {
          const embeddingText = buildEmbeddingText(displayName, description);
          const newEmbedding = await this.embeddingModel.encode(embeddingText);
          const embeddingStr = `[${newEmbedding.join(",")}]`;

          await this.db.query(
            `UPDATE workflow_pattern
             SET intent_embedding = $1::vector
             WHERE pattern_id = $2`,
            [embeddingStr, record.workflowPatternId],
          );
          log.info(`[CapModule] Embedding updated for ${displayName}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log.warn(`[CapModule] Failed to update embedding: ${msg}`);
        }
      }
    }

    const response: CapRenameResponse = {
      success: true,
      fqdn,
      aliasCreated: false,
    };

    log.info(`[CapModule] Updated description for ${displayName} (FQDN: ${fqdn})`);
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
    };

    log.info(`[CapModule] cap:whois ${id} -> ${record.id}`);
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
    description: "Rename a capability (updates display_name, old name overwritten)",
    category: "pml",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Current name or FQDN to rename",
        },
        newName: {
          type: "string",
          description: "New display name",
        },
        description: {
          type: "string",
          description: "Optional new description",
        },
      },
      required: ["name", "newName"],
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
    description: "Get complete metadata for a capability by FQDN",
    category: "pml",
    inputSchema: {
      type: "object",
      properties: {
        fqdn: {
          type: "string",
          description: "FQDN to look up (e.g., 'local.default.fs.read_json.a7f3')",
        },
      },
      required: ["fqdn"],
    },
    handler: async (args) => {
      const result = await getCapModule().call("cap:whois", args);
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

  constructor(registry: CapabilityRegistry, db: DbClient, embeddingModel?: EmbeddingModelInterface) {
    this.cap = new CapModule(registry, db, embeddingModel);
    // Set global CapModule for pmlTools discovery
    setCapModule(this.cap);
    log.info(`[PmlStdServer] Initialized with cap:* tools${embeddingModel ? " (embedding support enabled)" : ""}`);
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
