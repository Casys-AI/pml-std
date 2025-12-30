/**
 * Core capability types
 *
 * Types for learned capabilities - executable code patterns with metadata.
 * Epic 7 - Story 7.2a: Capability storage for learned code patterns.
 *
 * @module capabilities/types/capability
 */

import type { CacheConfig, JSONSchema, JsonValue } from "./schema.ts";
import type { PermissionSet } from "./permission.ts";
import type { StaticStructure } from "./static-analysis.ts";
import type { BranchDecision, TraceTaskResult } from "./execution.ts";

/**
 * Tool invocation stored with capability (mirrors sandbox ToolInvocation)
 * Enables sequence visualization and parallelism detection in graphs.
 */
export interface CapabilityToolInvocation {
  /** Unique ID for this invocation (e.g., "filesystem:read_file#0") */
  id: string;
  /** Tool identifier (e.g., "filesystem:read_file") */
  tool: string;
  /** Timestamp when tool was called (ms since epoch) */
  ts: number;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Sequence index within the capability execution (0-based) */
  sequenceIndex: number;
}

/**
 * A learned capability - executable code pattern with metadata
 *
 * Capabilities are stored on first successful execution (eager learning).
 * Subsequent executions update usage statistics via ON CONFLICT upsert.
 */
export interface Capability {
  /** Unique identifier (UUID) */
  id: string;
  /**
   * Fully Qualified Domain Name (immutable) - Story 13.2
   * Format: <org>.<project>.<namespace>.<action>.<hash>
   * Used for cross-capability references in code (after transformation)
   */
  fqdn?: string;
  /** The TypeScript code snippet */
  codeSnippet: string;
  /** SHA-256 hash of normalized code for deduplication */
  codeHash: string;
  /** 1024-dim embedding of intent for semantic search */
  intentEmbedding: Float32Array;
  /** JSON Schema for parameters (populated by Story 7.2b) */
  parametersSchema?: JSONSchema;
  /** Cache configuration */
  cacheConfig: CacheConfig;
  /**
   * @deprecated Use capability_records.display_name instead (Story 13.2)
   * Kept for backward compatibility, always undefined after migration 022
   */
  name?: string;
  /** Description of what this capability does */
  description?: string;
  /** Total number of times this capability was used */
  usageCount: number;
  /** Number of successful executions */
  successCount: number;
  /** Success rate (0-1, calculated as successCount/usageCount) */
  successRate: number;
  /** Average execution duration in milliseconds */
  avgDurationMs: number;
  /** When this capability was first learned */
  createdAt: Date;
  /** When this capability was last used */
  lastUsed: Date;
  /** Source: 'emergent' (auto-learned) or 'manual' (user-defined) */
  source: "emergent" | "manual";
  /** Tools used by this capability (extracted from dag_structure) - Story 7.4 */
  toolsUsed?: string[];
  /** Detailed tool invocations with timestamps for sequence visualization */
  toolInvocations?: CapabilityToolInvocation[];
  /** Permission set for sandbox execution (Story 7.7a, ADR-035) */
  permissionSet?: PermissionSet;
  /** Confidence score of the permission inference (0-1) */
  permissionConfidence?: number;
  /** Static structure for DAG execution (Story 10.7) */
  staticStructure?: StaticStructure;
  /**
   * Risk category for Thompson Sampling thresholds (Story 10.7c)
   *
   * Derived from max(toolsUsed.riskCategory) via getRiskFromScope().
   * - "safe": All tools are minimal/readonly (threshold ~0.55)
   * - "moderate": Some tools have filesystem/network-api scope (threshold ~0.70)
   * - "dangerous": Any tool has mcp-standard scope (threshold ~0.85)
   */
  riskCategory?: "safe" | "moderate" | "dangerous";
  /**
   * Hierarchy level for nested compound nodes (Story 10.1)
   * - 0: Leaf capability (uses only tools, no nested capabilities)
   * - 1+: Meta-capability (contains other capabilities)
   */
  hierarchyLevel?: number;
  /**
   * Child capability IDs (via "contains" edges) - Story 10.1
   * Populated when this capability calls other capabilities.
   */
  children?: string[];
  /**
   * Parent capability IDs (via "contains" edges) - Story 10.1
   * Populated when this capability is called by other capabilities.
   */
  parents?: string[];
}

/**
 * Input for saving a capability after execution
 */
export interface SaveCapabilityInput {
  /** The TypeScript code that was executed */
  code: string;
  /** The natural language intent (used for embedding) */
  intent: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Whether execution was successful */
  success?: boolean;
  /** Optional description */
  description?: string;
  /** Tool IDs used during execution (from traces) - deduplicated list */
  toolsUsed?: string[];
  /** Detailed tool invocations with timestamps for sequence visualization */
  toolInvocations?: CapabilityToolInvocation[];
  /**
   * Story 11.2: Optional trace data for concurrent trace storage
   * If provided, an ExecutionTrace will be created linked to the capability
   */
  traceData?: {
    /** Input context for this execution */
    initialContext?: Record<string, JsonValue>;
    /** Path of executed nodes */
    executedPath?: string[];
    /** Branch decisions made during execution */
    decisions?: BranchDecision[];
    /** Task results with sanitized args */
    taskResults?: TraceTaskResult[];
    /** Error message if execution failed */
    errorMessage?: string;
    /** User ID for multi-tenancy */
    userId?: string;
    /** Parent trace ID for hierarchical traces */
    parentTraceId?: string;
    /**
     * BGE-M3 1024D embedding of intent (Story 11.x - SHGAT v2)
     * Used for semantic similarity search in intentSimilarSuccessRate
     */
    intentEmbedding?: number[];
  };
  /**
   * Story 10.1: Static structure for nested capability detection
   * Used to create "contains" edges for meta-capabilities
   */
  staticStructure?: StaticStructure;
}

/**
 * Result of capability search
 */
export interface CapabilitySearchResult {
  /** The matched capability */
  capability: Capability;
  /** Semantic similarity score (0-1) - harmonized with HybridSearchResult */
  semanticScore: number;
}

/**
 * Result of intelligent capability matching (Story 7.3a)
 * Includes final score calculation and threshold comparison data.
 */
export interface CapabilityMatch {
  /** The matched capability */
  capability: Capability;
  /** Final calculated score (Semantic * Reliability) */
  score: number;
  /** Raw semantic similarity score (0-1) */
  semanticScore: number;
  /** The adaptive threshold used for the decision */
  thresholdUsed: number;
  /** The inferred parameters schema for calling this capability */
  parametersSchema: JSONSchema | null;
}

// Note: Database row types are inferred from PGlite query results.
// See rowToCapability() in capability-store.ts for the mapping logic.

/**
 * Edge types for capability dependencies
 * Same vocabulary as tool_dependency for consistency
 *
 * Story 10.3: Added "provides" for data flow relationships.
 * Note: "alternative" kept for backward compatibility with existing data.
 */
export type CapabilityEdgeType =
  | "contains" // Composition: capability A includes capability B
  | "sequence" // Temporal order: A then B
  | "dependency" // Explicit DAG dependency
  | "alternative" // Same intent, different implementation (deprecated)
  | "provides"; // Data flow: A's output feeds B's input (Story 10.3)

/**
 * Edge sources for capability dependencies
 */
export type CapabilityEdgeSource =
  | "template" // Bootstrap, not yet confirmed
  | "inferred" // 1-2 observations
  | "observed"; // 3+ observations (promoted from inferred)

/**
 * A capability-to-capability dependency relationship
 * Stored in capability_dependency table with FKs to workflow_pattern
 */
export interface CapabilityDependency {
  fromCapabilityId: string;
  toCapabilityId: string;
  observedCount: number;
  confidenceScore: number;
  edgeType: CapabilityEdgeType;
  edgeSource: CapabilityEdgeSource;
  createdAt: Date;
  lastObserved: Date;
}

/**
 * Input for creating a capability dependency
 */
export interface CreateCapabilityDependencyInput {
  fromCapabilityId: string;
  toCapabilityId: string;
  edgeType: CapabilityEdgeType;
  edgeSource?: CapabilityEdgeSource;
}

/**
 * Filters for listing capabilities (internal camelCase)
 */
export interface CapabilityFilters {
  /** Filter by Louvain community */
  communityId?: number;
  /** Minimum success rate (0-1) */
  minSuccessRate?: number;
  /** Minimum usage count */
  minUsage?: number;
  /** Maximum results per page */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Sort field */
  sort?: "usageCount" | "successRate" | "lastUsed" | "createdAt";
  /** Sort order */
  order?: "asc" | "desc";
  /**
   * Story 9.8: Filter by user who created or used the capability
   * When set, only returns capabilities where created_by = userId
   * OR the capability has been executed by this user
   */
  userId?: string;
}

/**
 * Single capability in API response (internal camelCase)
 * Maps to snake_case at API boundary in gateway-server.ts
 */
export interface CapabilityResponseInternal {
  id: string; // pattern_id UUID
  name: string | null; // Human-readable name (from capability_records.display_name or FQDN)
  fqdn: string | null; // Full FQDN from capability_records (Story 13.2)
  description: string | null; // Intent description
  codeSnippet: string; // TypeScript code
  toolsUsed: string[]; // ["filesystem:read", "github:create_issue"]
  toolInvocations?: CapabilityToolInvocation[]; // Detailed invocations with timestamps
  successRate: number; // 0-1
  usageCount: number; // Total executions
  avgDurationMs: number; // Average execution time
  communityId: number | null; // Louvain cluster
  intentPreview: string; // First 100 chars of intent
  createdAt: string; // ISO timestamp
  lastUsed: string; // ISO timestamp
  source: "emergent" | "manual"; // Learning source
  hierarchyLevel: number; // 0=leaf, 1+=contains capabilities (Story 10.1)
}

/**
 * Response from listCapabilities (internal camelCase)
 */
export interface CapabilityListResponseInternal {
  capabilities: CapabilityResponseInternal[];
  total: number;
  limit: number;
  offset: number;
}
