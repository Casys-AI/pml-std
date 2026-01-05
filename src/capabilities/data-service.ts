/**
 * Capability Data Service (Epic 8 - Story 8.1)
 *
 * Provides API data layer for capabilities and hypergraph visualization.
 * Queries workflow_pattern table and builds graph-ready data for D3.js visualization.
 *
 * Note: Migration from Cytoscape.js to D3.js completed in cb15d9e.
 * Type aliases CytoscapeNode/CytoscapeEdge kept for backward compatibility.
 *
 * @module capabilities/data-service
 */

import type { DbClient } from "../db/types.ts";
import type { GraphRAGEngine } from "../graphrag/graph-engine.ts";
import type { DAGSuggester } from "../graphrag/dag-suggester.ts";
import type {
  CapabilityFilters,
  CapabilityListResponseInternal,
  CapabilityNode,
  CapabilityResponseInternal,
  HypergraphOptions,
  HypergraphResponseInternal,
} from "./types.ts";
import { HypergraphBuilder } from "./hypergraph-builder.ts";
import { ExecutionTraceStore } from "./execution-trace-store.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * CapabilityDataService - API data layer for capabilities
 *
 * Provides structured access to capability data for REST API endpoints.
 * Handles filtering, pagination, and Cytoscape graph formatting.
 *
 * @example
 * ```typescript
 * const service = new CapabilityDataService(db, graphEngine);
 *
 * // List capabilities with filters
 * const list = await service.listCapabilities({
 *   minSuccessRate: 0.7,
 *   limit: 50,
 * });
 *
 * // Build hypergraph data
 * const hypergraph = await service.buildHypergraphData({
 *   includeTools: true,
 * });
 * ```
 */
export class CapabilityDataService {
  private dagSuggester: DAGSuggester | null = null;

  constructor(
    private db: DbClient,
    private graphEngine: GraphRAGEngine,
  ) {
    logger.debug("CapabilityDataService initialized");
  }

  /**
   * Set DAGSuggester for capability PageRank access (Story 8.2)
   *
   * @param dagSuggester - DAGSuggester instance with SpectralClusteringManager
   */
  setDAGSuggester(dagSuggester: DAGSuggester): void {
    this.dagSuggester = dagSuggester;
    logger.debug("CapabilityDataService: DAGSuggester configured for PageRank access");
  }

  /**
   * List capabilities with filtering and pagination
   *
   * @param filters Query filters and pagination options
   * @returns List of capabilities with pagination metadata
   */
  async listCapabilities(
    filters: CapabilityFilters = {},
  ): Promise<CapabilityListResponseInternal> {
    const {
      communityId,
      minSuccessRate = 0,
      minUsage = 0,
      limit = 50,
      offset = 0,
      sort = "lastUsed",
      order = "desc",
      userId, // Story 9.8
    } = filters;

    // Validate and cap limit
    const cappedLimit = Math.min(limit, 100);

    // Map internal sort field to DB column
    const sortFieldMap: Record<string, string> = {
      usageCount: "usage_count",
      successRate: "success_rate",
      lastUsed: "last_used",
      createdAt: "created_at",
    };
    const dbSortField = sortFieldMap[sort] || "usage_count";

    logger.debug("Listing capabilities", {
      filters: {
        communityId,
        minSuccessRate,
        minUsage,
        limit: cappedLimit,
        offset,
        sort,
        order,
      },
    });

    try {
      // Build WHERE clause dynamically (use wp. prefix for workflow_pattern columns)
      const conditions: string[] = ["wp.code_hash IS NOT NULL"];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (communityId !== undefined) {
        conditions.push(`wp.community_id = $${paramIndex++}`);
        params.push(communityId);
      }

      conditions.push(`wp.success_rate >= $${paramIndex++}`);
      params.push(minSuccessRate);

      conditions.push(`wp.usage_count >= $${paramIndex++}`);
      params.push(minUsage);

      // Story 9.8 AC #5: Filter by userId (created_by OR executed by user)
      if (userId) {
        const createdByParam = paramIndex++;
        const userIdParam = paramIndex++;
        conditions.push(`(
          wp.created_by = $${createdByParam}::text
          OR wp.pattern_id IN (
            SELECT DISTINCT capability_id FROM execution_trace
            WHERE user_id = $${userIdParam}::text AND capability_id IS NOT NULL
          )
        )`);
        params.push(userId, userId);
      }

      const whereClause = conditions.join(" AND ");

      // Query capabilities with JOIN to capability_records for name
      // Migration 028: display_name removed, use namespace:action
      // Migration 029: hierarchy_level for nested compound nodes
      const query = `
        SELECT
          wp.pattern_id as id,
          COALESCE(cr.namespace || ':' || cr.action, cr.id::text) as name,
          COALESCE(cr.org || '.' || cr.project || '.' || cr.namespace || '.' || cr.action, cr.id::text) as fqdn,
          wp.description,
          wp.code_snippet,
          wp.dag_structure->'tools_used' as tools_used,
          wp.dag_structure->'tool_invocations' as tool_invocations,
          wp.dag_structure->'static_structure' as static_structure,
          wp.success_rate,
          wp.usage_count,
          wp.avg_duration_ms,
          wp.community_id,
          wp.created_at,
          wp.last_used,
          wp.source,
          COALESCE(wp.hierarchy_level, 0) as hierarchy_level,
          CASE
            WHEN wp.description IS NOT NULL AND LENGTH(wp.description) > 100
            THEN SUBSTRING(wp.description, 1, 97) || '...'
            ELSE wp.description
          END as intent_preview
        FROM workflow_pattern wp
        LEFT JOIN capability_records cr ON cr.workflow_pattern_id = wp.pattern_id
        WHERE ${whereClause}
        ORDER BY ${dbSortField} ${order.toUpperCase()}
        LIMIT $${paramIndex++} OFFSET $${paramIndex}
      `;
      params.push(cappedLimit, offset);

      const result = await this.db.query(query, params);

      // Count total matching records
      const countQuery = `
        SELECT COUNT(*) as total
        FROM workflow_pattern wp
        WHERE ${whereClause}
      `;
      const countResult = await this.db.query(
        countQuery,
        params.slice(0, params.length - 2),
      ); // Exclude limit/offset
      const total = Number(countResult[0]?.total || 0);

      // Story 10.1: Build lookup map for resolving $cap:uuid in code_snippet
      // Maps capability_records.id → namespace:action for display
      const capUuidLookup = new Map<string, string>();
      try {
        const capRecords = await this.db.query(
          "SELECT id, namespace, action FROM capability_records",
        ) as Array<{ id: string; namespace: string; action: string }>;
        for (const rec of capRecords) {
          capUuidLookup.set(rec.id, `${rec.namespace}:${rec.action}`);
        }
        logger.debug("Built $cap:uuid lookup for code_snippet", { count: capUuidLookup.size });
      } catch (err) {
        logger.warn("Failed to build $cap:uuid lookup", { error: err });
      }

      // Helper to resolve mcp["$cap:uuid"] references in code_snippet to mcp.namespace.action
      const resolveCapReferences = (codeSnippet: string): string => {
        // Match full mcp["$cap:uuid"] pattern and transform to mcp.namespace.action (dot notation)
        return codeSnippet.replace(
          /mcp\["\$cap:([0-9a-f-]{36})"\]/gi,
          (_match, uuid) => {
            const resolved = capUuidLookup.get(uuid);
            if (resolved) {
              // Transform "fake:person" → "mcp.fake.person"
              const [namespace, action] = resolved.split(":");
              return `mcp.${namespace}.${action}`;
            }
            return `mcp["$cap:${uuid}"]`; // Keep original if not found
          },
        );
      };

      // Map rows to response objects
      const capabilities: CapabilityResponseInternal[] = result.map(
        (row: Record<string, unknown>) => {
          // Parse tools_used from JSONB
          let toolsUsed: string[] = [];
          if (row.tools_used) {
            try {
              // Handle both string and array formats
              if (typeof row.tools_used === "string") {
                toolsUsed = JSON.parse(row.tools_used);
              } else if (Array.isArray(row.tools_used)) {
                toolsUsed = row.tools_used;
              }
            } catch (error) {
              logger.warn("Failed to parse tools_used", { error, row: row.id });
            }
          }

          // Parse tool_invocations from JSONB (for sequence visualization)
          let toolInvocations: CapabilityResponseInternal["toolInvocations"];
          if (row.tool_invocations) {
            try {
              if (typeof row.tool_invocations === "string") {
                toolInvocations = JSON.parse(row.tool_invocations);
              } else if (Array.isArray(row.tool_invocations)) {
                toolInvocations = row.tool_invocations;
              }
            } catch (error) {
              logger.warn("Failed to parse tool_invocations", { error, row: row.id });
            }
          }

          // Parse static_structure from JSONB (for DAG visualization with loop abstraction)
          let staticStructure: CapabilityResponseInternal["staticStructure"];
          if (row.static_structure) {
            try {
              if (typeof row.static_structure === "string") {
                staticStructure = JSON.parse(row.static_structure);
              } else if (
                typeof row.static_structure === "object" &&
                row.static_structure !== null
              ) {
                staticStructure = row.static_structure as typeof staticStructure;
              }
            } catch (error) {
              logger.warn("Failed to parse static_structure", { error, row: row.id });
            }
          }

          return {
            id: String(row.id),
            name: row.name ? String(row.name) : null,
            fqdn: row.fqdn ? String(row.fqdn) : null,
            description: row.description ? String(row.description) : null,
            codeSnippet: resolveCapReferences(String(row.code_snippet || "")),
            toolsUsed,
            toolInvocations,
            successRate: Number(row.success_rate || 0),
            usageCount: Number(row.usage_count || 0),
            avgDurationMs: Number(row.avg_duration_ms || 0),
            communityId: row.community_id !== null && row.community_id !== undefined
              ? Number(row.community_id)
              : null,
            intentPreview: String(row.intent_preview || row.description || ""),
            createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : "",
            lastUsed: row.last_used ? new Date(String(row.last_used)).toISOString() : "",
            source: (row.source as "emergent" | "manual") || "emergent",
            hierarchyLevel: Number(row.hierarchy_level || 0),
            staticStructure,
          };
        },
      );

      logger.info("Capabilities listed", {
        count: capabilities.length,
        total,
        limit: cappedLimit,
        offset,
      });

      return {
        capabilities,
        total,
        limit: cappedLimit,
        offset,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to list capabilities", { error: errorMsg });
      throw new Error(`Failed to list capabilities: ${errorMsg}`);
    }
  }

  /**
   * Find capabilities that co-occur with the given capability in execution traces.
   * Co-occurrence = same user session (within 1 hour window) or same parent trace.
   *
   * @param capabilityId - Source capability ID
   * @param limit - Max results
   * @returns Array of co-occurring capabilities with count and recency
   */
  async findCoOccurringCapabilities(
    capabilityId: string,
    limit: number = 10,
  ): Promise<
    Array<
      { capabilityId: string; name: string | null; cooccurrenceCount: number; lastSeen: string }
    >
  > {
    try {
      // Find capabilities that appear in traces within 1 hour of source capability's traces
      // or share the same parent_trace_id
      const query = `
        WITH source_traces AS (
          SELECT id, user_id, executed_at, parent_trace_id
          FROM execution_trace
          WHERE capability_id = $1
        ),
        cooccurring AS (
          SELECT
            et.capability_id,
            COUNT(DISTINCT et.id) as cooccurrence_count,
            MAX(et.executed_at) as last_seen
          FROM execution_trace et
          JOIN source_traces st ON (
            -- Same parent trace (hierarchical execution)
            (et.parent_trace_id IS NOT NULL AND et.parent_trace_id = st.parent_trace_id)
            OR
            -- Same user within 1 hour window
            (et.user_id = st.user_id AND ABS(EXTRACT(EPOCH FROM (et.executed_at - st.executed_at))) < 3600)
          )
          WHERE et.capability_id IS NOT NULL
            AND et.capability_id != $1
          GROUP BY et.capability_id
        )
        SELECT
          c.capability_id,
          COALESCE(cr.namespace || ':' || cr.action, cr.id::text) as name,
          c.cooccurrence_count,
          c.last_seen
        FROM cooccurring c
        LEFT JOIN workflow_pattern wp ON wp.pattern_id = c.capability_id
        LEFT JOIN capability_records cr ON cr.workflow_pattern_id = wp.pattern_id
        ORDER BY c.cooccurrence_count DESC, c.last_seen DESC
        LIMIT $2
      `;

      const results = await this.db.query(query, [capabilityId, limit]);

      return results.map((row: Record<string, unknown>) => ({
        capabilityId: String(row.capability_id),
        name: row.name ? String(row.name) : null,
        cooccurrenceCount: Number(row.cooccurrence_count),
        lastSeen: row.last_seen ? new Date(String(row.last_seen)).toISOString() : "",
      }));
    } catch (error) {
      logger.warn("Failed to find co-occurring capabilities", { error, capabilityId });
      return [];
    }
  }

  /**
   * Build hypergraph data for D3.js visualization
   *
   * Creates a compound graph with:
   * - Capability nodes (parents)
   * - Tool nodes (children or standalone) with `parents[]` array for multi-parent support
   * - Hierarchical edges (capability → tool)
   * - Capability links (shared tools)
   * - Capability dependency edges
   * - Hull zone metadata for D3.js hull rendering
   *
   * Note: Migrated from Cytoscape.js to D3.js for hyperedge support.
   * Story 8.2: Refactored to use HypergraphBuilder for graph construction.
   *
   * @param options Hypergraph build options
   * @returns Graph-ready hypergraph data for D3.js force-directed layout
   */
  async buildHypergraphData(
    options: HypergraphOptions = {},
  ): Promise<HypergraphResponseInternal> {
    const {
      includeTools = true,
      includeOrphans = true, // Default true for backward compat
      minSuccessRate = 0,
      minUsage = 0,
      includeTraces = false, // Story 11.4
    } = options;

    logger.debug("Building hypergraph data", { options, includeTraces });

    try {
      // 1. Fetch capabilities
      const capabilityList = await this.listCapabilities({
        minSuccessRate,
        minUsage,
        limit: 100, // Reasonable max for visualization
      });

      const capabilities = capabilityList.capabilities;

      // 2. Get graph snapshot ONCE (Fix #24: Performance N+1)
      let graphSnapshot = null;
      try {
        graphSnapshot = this.graphEngine.getGraphSnapshot();
      } catch (error) {
        logger.warn("Failed to get graph snapshot, tool metrics unavailable", { error });
      }

      // 2b. Get capability PageRanks from DAGSuggester (Story 8.2)
      // Ensure pageranks are computed on-demand if not already done
      let capabilityPageranks: Map<string, number> | undefined;
      if (this.dagSuggester) {
        // Trigger computation if not already computed
        this.dagSuggester.ensurePageranksComputed(
          capabilities.map((c) => ({ id: c.id, toolsUsed: c.toolsUsed })),
        );
        capabilityPageranks = this.dagSuggester.getCapabilityPageranks();
        logger.debug("Got capability pageranks for hypergraph", {
          count: capabilityPageranks.size,
        });
      }

      // 3. Use HypergraphBuilder for graph construction (Story 8.2)
      const builder = new HypergraphBuilder();
      const hypergraphResult = builder.buildCompoundGraph(
        capabilities,
        graphSnapshot ?? undefined,
        capabilityPageranks,
      );

      // Note: tool_invocation nodes are now generated client-side from toolsUsed
      // This preserves order and repetitions without needing stored toolInvocations

      // Track existing tool IDs for standalone tools
      const existingToolIds = new Set(
        hypergraphResult.nodes
          .filter((n) => n.data.type === "tool")
          .map((n) => n.data.id),
      );

      // Track existing capability IDs for dependency edges
      const existingCapIds = new Set(
        hypergraphResult.nodes
          .filter((n) => n.data.type === "capability")
          .map((n) => n.data.id),
      );

      // 4. Add capability-to-capability dependency edges from DB
      try {
        const capDeps = await this.db.query(`
          SELECT from_capability_id, to_capability_id, observed_count, confidence_score, edge_type, edge_source
          FROM capability_dependency
          WHERE confidence_score > 0.3
        `);

        // Story 10.1: Pass nodes to set parent on child capabilities for "contains" edges
        builder.addCapabilityDependencyEdges(
          hypergraphResult.edges,
          capDeps as Array<{
            from_capability_id: string;
            to_capability_id: string;
            observed_count: number;
            edge_type: string;
            edge_source: string;
          }>,
          existingCapIds,
          hypergraphResult.nodes,
        );
        logger.debug("Added capability dependency edges", { count: capDeps.length });
      } catch (error) {
        logger.warn("Failed to load capability dependencies for hypergraph", { error });
      }

      // 5. Optionally include standalone tools (only if includeOrphans is true)
      // Performance fix: orphan tools (450+) bloat response without adding visualization value
      if (includeTools && graphSnapshot && includeOrphans) {
        builder.addStandaloneTools(
          hypergraphResult.nodes,
          graphSnapshot,
          existingToolIds,
        );
      }

      // 5b. Include tool-to-tool edges from graph snapshot
      if (graphSnapshot && graphSnapshot.edges) {
        for (const edge of graphSnapshot.edges) {
          // Only add edges between tools that exist in our nodes
          const sourceExists = hypergraphResult.nodes.some((n) => n.data.id === edge.source);
          const targetExists = hypergraphResult.nodes.some((n) => n.data.id === edge.target);

          if (sourceExists && targetExists) {
            hypergraphResult.edges.push({
              data: {
                id: `tool-edge-${edge.source}-${edge.target}`,
                source: edge.source,
                target: edge.target,
                edgeType: (edge.edge_type || "sequence") as "contains" | "sequence" | "dependency",
                edgeSource: (edge.edge_source || "inferred") as
                  | "template"
                  | "inferred"
                  | "observed",
                observedCount: edge.observed_count || 1,
              },
            });
          }
        }
        logger.debug("Added tool-to-tool edges from snapshot", {
          snapshotEdges: graphSnapshot.edges.length,
          addedEdges: hypergraphResult.edges.filter((e) =>
            e.data.id.startsWith("tool-edge-")
          ).length,
        });
      }

      // 6. Story 11.4: Fetch traces for each capability if requested
      if (includeTraces) {
        const traceStore = new ExecutionTraceStore(this.db);
        const capabilityNodes = hypergraphResult.nodes.filter(
          (n): n is CapabilityNode => n.data.type === "capability",
        );

        // Fetch traces in parallel (limit 10 per capability for performance)
        const tracePromises = capabilityNodes.map(async (capNode) => {
          const capId = capNode.data.id;
          try {
            const traces = await traceStore.getTraces(capId, 10);
            capNode.data.traces = traces;
          } catch (err) {
            logger.warn(`Failed to fetch traces for capability ${capId}`, { error: err });
          }
        });

        await Promise.all(tracePromises);
        logger.debug("Fetched traces for capabilities", {
          capabilitiesWithTraces: capabilityNodes.filter((n) => n.data.traces?.length).length,
        });

        // Story 10.1: Mark capability calls in task results and add nested tools
        // Build Map from capabilities we already fetched (no extra DB query)
        // Maps capability name -> toolsUsed (for nested display in CapabilityTaskCard)
        const capabilityToolsMap = new Map<string, string[]>();
        for (const capNode of capabilityNodes) {
          const name = capNode.data.label; // capability name like "fake:person"
          const toolsUsed = capNode.data.toolsUsed;
          if (name && toolsUsed && toolsUsed.length > 0) {
            capabilityToolsMap.set(name, toolsUsed);
          }
        }

        // Mark capability calls in task results and add nested tools
        for (const capNode of capabilityNodes) {
          if (capNode.data.traces) {
            for (const trace of capNode.data.traces) {
              for (const taskResult of trace.taskResults) {
                const nestedTools = capabilityToolsMap.get(taskResult.tool);
                if (nestedTools) {
                  taskResult.isCapabilityCall = true;
                  taskResult.nestedTools = nestedTools;
                }
              }
            }
          }
        }
        logger.debug("Marked capability calls in traces", { knownCount: capabilityToolsMap.size });
      }

      // 7. Build final response with backward compatibility
      // Note: Tools with `parents[]` array also have `parent` set to first parent for legacy support
      const result: HypergraphResponseInternal = {
        nodes: hypergraphResult.nodes,
        edges: hypergraphResult.edges,
        capabilityZones: hypergraphResult.capabilityZones,
        capabilitiesCount: hypergraphResult.capabilitiesCount,
        toolsCount: hypergraphResult.nodes.filter((n) => n.data.type === "tool").length,
        metadata: {
          generatedAt: new Date().toISOString(),
          version: "1.0.0",
        },
      };

      logger.info("Hypergraph data built", {
        capabilitiesCount: result.capabilitiesCount,
        toolsCount: result.toolsCount,
        nodesCount: result.nodes.length,
        edgesCount: result.edges.length,
        zonesCount: result.capabilityZones?.length || 0,
      });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to build hypergraph data", { error: errorMsg });
      throw new Error(`Failed to build hypergraph data: ${errorMsg}`);
    }
  }
}
