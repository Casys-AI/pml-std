/**
 * FQDN and registry types for capability naming
 *
 * Types for Fully Qualified Domain Names and capability registry.
 * Epic 13 - Story 13.1: FQDN registry with naming and aliases.
 *
 * @module capabilities/types/fqdn
 */

import type { ExecutionTrace } from "./execution.ts";

/**
 * Visibility levels for capability records (Epic 13)
 *
 * Controls access to capabilities:
 * - private: Only visible to creator
 * - project: Visible within same project
 * - org: Visible within same organization
 * - public: Visible to everyone
 */
export type CapabilityVisibility = "private" | "project" | "org" | "public";

/**
 * Routing mode for capability execution (Epic 13)
 *
 * New terminology (preferred):
 * - client: Execute on user's machine (Claude Code, local MCP)
 * - server: Execute via PML server (pml.casys.ai)
 *
 * Legacy aliases (for backwards compatibility):
 * - local: Alias for "client"
 * - cloud: Alias for "server"
 */
export type CapabilityRouting = "client" | "server" | "local" | "cloud";

/**
 * Components of a Fully Qualified Domain Name for capabilities (Story 13.1)
 *
 * FQDN format: `<org>.<project>.<namespace>.<action>.<hash>`
 *
 * @example
 * - `local.default.fs.read_json.a7f3` - Local dev capability
 * - `acme.webapp.api.fetch_user.b8e2` - Organization capability
 * - `marketplace.public.util.format_date.c9d1` - Public marketplace capability
 */
export interface FQDNComponents {
  /** Organization identifier (e.g., "local", "acme", "marketplace") */
  org: string;
  /** Project identifier (e.g., "default", "webapp", "public") */
  project: string;
  /** Namespace grouping (e.g., "fs", "api", "util") - user-chosen, not enforced */
  namespace: string;
  /** Action name (e.g., "read_json", "fetch_user") */
  action: string;
  /** 4-char hex hash of code content for uniqueness */
  hash: string;
}

/**
 * Scope for capability name resolution (Story 13.1)
 *
 * Used to resolve short names within a specific org/project context.
 *
 * @example
 * ```typescript
 * const scope: Scope = { org: "acme", project: "webapp" };
 * const resolved = await registry.resolveByName("my-reader", scope);
 * // Returns: "acme.webapp.fs.read_json.a7f3"
 * ```
 */
export interface Scope {
  /** Organization identifier ("local" for self-hosted, org slug for cloud) */
  org: string;
  /** Project identifier */
  project: string;
}

/**
 * A named capability in the registry (Story 13.1)
 *
 * This is the registry record type stored in `capability_records` table.
 * Different from `Capability` which is the workflow_pattern-based type.
 *
 * Architecture: Dual-table strategy (migration 023, 028)
 * - capability_records: UUID PK, FQDN components, visibility, provenance
 * - workflow_pattern: Code, embeddings, execution stats (via workflowPatternId FK)
 *
 * FQDN is computed from: `${org}.${project}.${namespace}.${action}.${hash}`
 * Display name is derived from: `${namespace}:${action}`
 */
export interface CapabilityRecord {
  // Identity
  /** UUID primary key (immutable) - used in code as mcp["$cap:<uuid>"] */
  id: string;
  /** Organization */
  org: string;
  /** Project */
  project: string;
  /** Namespace grouping */
  namespace: string;
  /** Action name */
  action: string;
  /** 4-char hex hash of code_snippet */
  hash: string;

  // Link to workflow_pattern (migration 023)
  /** FK to workflow_pattern.pattern_id for code, embedding, stats */
  workflowPatternId?: string;

  // Provenance
  /** Who created this record */
  createdBy: string;
  /** When created */
  createdAt: Date;
  /** Who last updated (null if never updated) */
  updatedBy?: string;
  /** When last updated (null if never updated) */
  updatedAt?: Date;

  // Versioning
  /** Version number (increments on updates) */
  version: number;
  /** Optional semantic version tag (e.g., "1.0.0") */
  versionTag?: string;

  // Trust
  /** Whether this capability is verified */
  verified: boolean;
  /** Optional cryptographic signature */
  signature?: string;

  // Metrics (sourced from workflow_pattern via JOIN)
  /** Total number of times used */
  usageCount: number;
  /** Number of successful executions */
  successCount: number;
  /**
   * @deprecated Removed in migration 034. Use workflow_pattern.avg_duration_ms instead.
   * Kept for backward compatibility until all code is updated.
   */
  totalLatencyMs?: number;

  // Metadata
  /** Tags for categorization */
  tags: string[];
  /** Visibility level */
  visibility: CapabilityVisibility;
  /** Execution routing: local or cloud */
  routing: CapabilityRouting;
}

/**
 * Compute FQDN from CapabilityRecord components
 *
 * @param record - The capability record (or partial with FQDN components)
 * @returns FQDN string: org.project.namespace.action.hash
 */
export function getCapabilityFqdn(
  record: Pick<CapabilityRecord, "org" | "project" | "namespace" | "action" | "hash">,
): string {
  return `${record.org}.${record.project}.${record.namespace}.${record.action}.${record.hash}`;
}

/**
 * Get display name from CapabilityRecord (namespace:action)
 *
 * @param record - The capability record (or partial with namespace/action)
 * @returns Display name string: namespace:action
 */
export function getCapabilityDisplayName(
  record: Pick<CapabilityRecord, "namespace" | "action">,
): string {
  return `${record.namespace}:${record.action}`;
}

/**
 * Hierarchy node for trace reconstruction (Phase 8 - Migration)
 *
 * Used by ExecutionTraceStore.buildHierarchy() to reconstruct
 * the tree structure from flat traces with parentTraceId.
 *
 * @see 08-migration.md for spec details
 */
export interface HierarchyNode {
  /** The trace at this node */
  trace: ExecutionTrace;
  /** Child traces (those with parentTraceId pointing to this trace) */
  children: HierarchyNode[];
}

// CapabilityAlias and AliasResolutionResult removed in migration 028
// Aliases are no longer supported - use UUID for stable references

// ============================================
// MCP Tool Listing Types (Story 13.3)
// ============================================

/**
 * Capability with schema for MCP tool listing (Story 13.3)
 *
 * JOINed data from capability_records + workflow_pattern tables
 * for generating MCP tool definitions.
 */
export interface CapabilityWithSchema {
  /** Capability pattern_id */
  id: string;
  /** Namespace from capability_records */
  namespace: string;
  /** Action from capability_records */
  action: string;
  /** Display name from capability_records */
  displayName: string;
  /** Description from workflow_pattern */
  description: string | null;
  /** JSON Schema for parameters from workflow_pattern */
  parametersSchema: Record<string, unknown> | null;
  /** Usage count for sorting */
  usageCount: number;
}

/**
 * Options for listWithSchemas query (Story 13.3)
 */
export interface ListWithSchemasOptions {
  /** Filter by visibility levels (default: all) */
  visibility?: Array<"public" | "org" | "project" | "private">;
  /** Filter by creator */
  createdBy?: string;
  /** Maximum results (default: 100) */
  limit?: number;
  /** Order by field (default: usageCount) */
  orderBy?: "usageCount" | "displayName" | "createdAt";
}

// ============================================
// PML Registry Types (Story 13.8)
// ============================================

/**
 * Record type in the unified pml_registry VIEW (Story 13.8)
 *
 * - 'mcp-tool': Tool from tool_schema (MCP server tools)
 * - 'capability': Learned capability from capability_records
 */
export type PmlRegistryRecordType = "mcp-tool" | "capability";

/**
 * Unified registry record from pml_registry VIEW (Story 13.8)
 *
 * This VIEW combines tool_schema and capability_records for unified discovery.
 * Each record has a record_type to distinguish between MCP tools and capabilities.
 *
 * @example
 * ```sql
 * SELECT * FROM pml_registry WHERE name ILIKE '%file%';
 * SELECT * FROM pml_registry WHERE record_type = 'mcp-tool';
 * ```
 */
export interface PmlRegistryRecord {
  /** Record type: 'mcp-tool' or 'capability' */
  recordType: PmlRegistryRecordType;
  /** Unique identifier (tool_id for tools, UUID for capabilities) */
  id: string;
  /** Name (tool name or namespace:action for capabilities) */
  name: string;
  /** Description from tool_schema or workflow_pattern */
  description: string | null;
  /** URL for dynamic import (MCP tools only) */
  codeUrl: string | null;
  /** Execution routing: 'local' or 'cloud' */
  routing: CapabilityRouting;
  /** MCP server ID (tools only) */
  serverId: string | null;
  /** Workflow pattern ID (capabilities only) */
  workflowPatternId: string | null;
  /** Organization (capabilities only) */
  org: string | null;
  /** Project (capabilities only) */
  project: string | null;
  /** Namespace (capabilities only) */
  namespace: string | null;
  /** Action (capabilities only) */
  action: string | null;
}
