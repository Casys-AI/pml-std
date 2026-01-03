/**
 * Capability Store (Epic 7 - Story 7.2a)
 *
 * Persists learned capabilities with eager learning strategy:
 * - Store on 1st successful execution (no waiting for patterns)
 * - ON CONFLICT: update usage_count++, recalculate success_rate
 * - Storage is cheap (~2KB/capability), filter at suggestion time
 *
 * @module capabilities/capability-store
 */

import type { DbClient } from "../db/types.ts";
import type { EmbeddingModel } from "../vector/embeddings.ts";
import type { Row } from "../db/client.ts";
import {
  type CacheConfig,
  type Capability,
  type CapabilityDependency,
  type CapabilityEdgeSource,
  type CapabilityEdgeType,
  type CapabilityWithSchema,
  type CreateCapabilityDependencyInput,
  DEFAULT_TRACE_PRIORITY,
  type ExecutionTrace,
  type ListWithSchemasOptions,
  type PermissionSet,
  type SaveCapabilityInput,
  type StaticStructure,
} from "./types.ts";
import { ExecutionTraceStore } from "./execution-trace-store.ts";
import { hashCode, hashSemanticStructure } from "./hash.ts";
import { getLogger } from "../telemetry/logger.ts";
import type { SchemaInferrer } from "./schema-inferrer.ts";
import type { StaticStructureBuilder } from "./static-structure-builder.ts";
import type { CapabilityRegistry } from "./capability-registry.ts";
import { normalizeVariableNames, transformCapabilityRefs, transformLiteralsToArgs } from "./code-transformer.ts";
// Story 6.5: EventBus integration (ADR-036)
import { eventBus } from "../events/mod.ts";
// Story 10.7c: Thompson Sampling risk classification
import { calculateCapabilityRisk } from "../mcp/adaptive-threshold.ts";

const logger = getLogger("default");

/**
 * Default cache configuration for new capabilities
 */
const DEFAULT_CACHE_CONFIG: CacheConfig = {
  ttl_ms: 3600000, // 1 hour
  cacheable: true,
};

/**
 * CapabilityStore - Persistence layer for learned capabilities
 *
 * Implements eager learning: capabilities are stored on first successful
 * execution rather than waiting for repeated patterns.
 *
 * @example
 * ```typescript
 * const store = new CapabilityStore(db, embeddingModel);
 *
 * // Save after successful execution
 * const capability = await store.saveCapability({
 *   code: "const result = await tools.search({query: 'test'});",
 *   intent: "Search for test data",
 *   durationMs: 150,
 * });
 *
 * // Second execution updates stats
 * await store.updateUsage(capability.codeHash, true, 120);
 * ```
 */
export class CapabilityStore {
  private traceStore?: ExecutionTraceStore;
  private capabilityRegistry?: CapabilityRegistry;

  constructor(
    private db: DbClient,
    private embeddingModel: EmbeddingModel,
    private schemaInferrer?: SchemaInferrer,
    private staticStructureBuilder?: StaticStructureBuilder,
  ) {
    // Story 11.2: Initialize trace store for optional trace storage
    this.traceStore = new ExecutionTraceStore(db);
    logger.debug("CapabilityStore initialized", {
      schemaInferrerEnabled: !!schemaInferrer,
      staticStructureBuilderEnabled: !!staticStructureBuilder,
      traceStoreEnabled: true,
    });
  }

  /**
   * Set the CapabilityRegistry for code transformation
   * (Converts capability display_names to FQDNs when saving)
   */
  setCapabilityRegistry(registry: CapabilityRegistry): void {
    this.capabilityRegistry = registry;
    logger.debug("CapabilityRegistry set for code transformation");
  }

  /**
   * Get the ExecutionTraceStore for PER training
   */
  getTraceStore(): ExecutionTraceStore | undefined {
    return this.traceStore;
  }

  /**
   * Save a capability after execution (eager learning)
   *
   * Uses UPSERT: INSERT ... ON CONFLICT to handle deduplication.
   * - First execution: creates capability with usage_count=1, success_rate=1.0
   * - Subsequent: increments usage_count, updates success_rate average
   *
   * @param input Capability data from execution
   * @returns The saved/updated capability, and optionally the execution trace
   */
  async saveCapability(input: SaveCapabilityInput): Promise<{
    capability: Capability;
    trace?: ExecutionTrace;
  }> {
    const {
      code: originalCode,
      intent,
      durationMs,
      success = true,
      description,
      toolsUsed,
      toolInvocations,
      traceData,
      staticStructure,
    } = input;

    // Transform capability references: display_name → FQDN (makes code robust to renames)
    let code = originalCode;
    if (this.capabilityRegistry) {
      try {
        const transformResult = await transformCapabilityRefs(code, this.capabilityRegistry);
        if (transformResult.replacedCount > 0) {
          code = transformResult.code;
          logger.info("Transformed capability refs to FQDNs", {
            replacedCount: transformResult.replacedCount,
            replacements: transformResult.replacements,
          });
        }
      } catch (error) {
        // Code transformation failure is a bug that needs fixing
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error("Code transformation failed", {
          error: errorMsg,
          codeLength: originalCode.length,
        });
        throw new Error(`Code transformation failed: ${errorMsg}`);
      }
    }

    // Transform literals to args.xxx for reusable capabilities
    // Always parameterize - never store hardcoded values (tokens, paths, secrets, etc.)
    let literalTransformSchema: Capability["parametersSchema"] | undefined;
    if (staticStructure?.literalBindings) {
      const literalBindings = staticStructure.literalBindings;
      if (Object.keys(literalBindings).length > 0) {
        try {
          const literalResult = await transformLiteralsToArgs(code, literalBindings);
          if (literalResult.replacedCount > 0) {
            code = literalResult.code;
            literalTransformSchema = literalResult.parametersSchema;
            logger.info("Transformed literals to args for reusable capability", {
              replacedCount: literalResult.replacedCount,
              parameters: Object.keys(literalBindings),
            });
          }
        } catch (error) {
          // Non-critical: log warning and continue with original code
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.warn("Literal transformation failed, continuing with original code", {
            error: errorMsg,
          });
        }
      }
    }

    // Build static structure from TRANSFORMED code (after literal extraction)
    // This ensures semantic hash is based on parameterized code (args.xxx)
    // not the original literals (actual query strings, paths, etc.)
    let finalStaticStructure: StaticStructure | undefined;
    if (this.staticStructureBuilder) {
      try {
        // Always rebuild from current code (which may have literals transformed)
        finalStaticStructure = await this.staticStructureBuilder.buildStaticStructure(code);
        logger.debug("Static structure built for capability", {
          nodeCount: finalStaticStructure.nodes.length,
          edgeCount: finalStaticStructure.edges.length,
        });
      } catch (error) {
        logger.warn("Static structure analysis failed, continuing without", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Story 7.2c: Normalize variable names in code for consistent storage
    // Uses variableBindings from static structure to rename variables to node IDs
    let normalizedCode = code;
    if (finalStaticStructure?.variableBindings) {
      const normalizeResult = normalizeVariableNames(code, finalStaticStructure.variableBindings);
      normalizedCode = normalizeResult.code;
      if (Object.keys(normalizeResult.renames).length > 0) {
        logger.debug("Normalized variable names in code", {
          renames: normalizeResult.renames,
        });
      }
    }

    // Generate code hash for deduplication (Story 7.2c: semantic hashing)
    // Use semantic hash if static structure available (normalizes variable names)
    // Fallback to code hash if no static structure
    let codeHash: string;
    if (finalStaticStructure && finalStaticStructure.nodes.length > 0) {
      codeHash = await hashSemanticStructure(finalStaticStructure);
      logger.debug("Using semantic hash for deduplication", {
        nodeCount: finalStaticStructure.nodes.length,
      });
    } else {
      codeHash = await hashCode(normalizedCode);
      logger.debug("Using code hash for deduplication (no static structure)");
    }

    // Use normalized code for storage
    code = normalizedCode;

    // Generate intent embedding for semantic search
    let embedding: number[];
    try {
      embedding = await this.embeddingModel.encode(intent);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to generate embedding for capability", {
        intent: intent.substring(0, 50),
        error: errorMsg,
      });
      throw new Error(`Embedding generation failed: ${errorMsg}`);
    }
    const embeddingStr = `[${embedding.join(",")}]`;

    // Infer parameters schema from code (Story 7.2b)
    // Start with schema from literal transformation (if any), then merge with inferred
    let parametersSchema: Capability["parametersSchema"] | undefined = literalTransformSchema;
    if (this.schemaInferrer) {
      try {
        const inferredSchema = await this.schemaInferrer.inferSchema(code);
        if (parametersSchema) {
          // Merge: literal schema takes precedence, but add any additional inferred properties
          parametersSchema = {
            ...inferredSchema,
            ...parametersSchema,
            properties: {
              ...inferredSchema.properties,
              ...parametersSchema.properties,
            },
            required: [
              ...new Set([
                ...(inferredSchema.required || []),
                ...(parametersSchema.required || []),
              ]),
            ],
          };
        } else {
          parametersSchema = inferredSchema;
        }
        logger.debug("Schema inferred for capability", {
          codeHash,
          properties: Object.keys(parametersSchema.properties || {}),
        });
      } catch (error) {
        logger.warn("Schema inference failed, continuing without schema", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Permissions: sandbox always runs with "none", HIL is controlled by allow/ask/deny config
    const permissionSet: PermissionSet = "minimal";
    const permissionConfidence = 1.0; // No inference, static config

    // Build dag_structure with tools used, invocations, and static structure (for graph analysis)
    const dagStructure: Record<string, unknown> = {
      type: "code_execution",
      tools_used: toolsUsed || [],
      tool_invocations: toolInvocations || [], // Detailed invocations with timestamps
      intent_text: intent,
    };

    // Story 10.1: Add static_structure to dag_structure if available
    if (
      finalStaticStructure &&
      (finalStaticStructure.nodes.length > 0 || finalStaticStructure.edges.length > 0)
    ) {
      dagStructure.static_structure = finalStaticStructure;
    }

    // Generate pattern_hash (required by existing schema, distinct from code_hash)
    // Use code_hash as pattern_hash to ensure uniqueness per code snippet
    const patternHash = codeHash;

    logger.debug("Saving capability", {
      codeHash,
      intent: intent.substring(0, 50),
      durationMs,
      success,
    });

    // UPSERT: Insert or update on conflict
    // Note: 'name' column removed in migration 022 - naming via capability_records.display_name
    const result = await this.db.query(
      `INSERT INTO workflow_pattern (
        pattern_hash,
        dag_structure,
        intent_embedding,
        usage_count,
        success_count,
        last_used,
        code_snippet,
        code_hash,
        cache_config,
        description,
        success_rate,
        avg_duration_ms,
        parameters_schema,
        permission_set,
        permission_confidence,
        created_at,
        source
      ) VALUES (
        $1, $2::jsonb, $3, 1, $4, NOW(), $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12, $13, NOW(), 'emergent'
      )
      ON CONFLICT (code_hash) WHERE code_hash IS NOT NULL DO UPDATE SET
        usage_count = workflow_pattern.usage_count + 1,
        success_count = workflow_pattern.success_count + CASE WHEN $4 = 1 THEN 1 ELSE 0 END,
        last_used = NOW(),
        success_rate = (workflow_pattern.success_count + CASE WHEN $4 = 1 THEN 1 ELSE 0 END)::real
          / (workflow_pattern.usage_count + 1)::real,
        avg_duration_ms = (
          (workflow_pattern.avg_duration_ms * workflow_pattern.usage_count) + $10
        ) / (workflow_pattern.usage_count + 1),
        parameters_schema = $11::jsonb,
        permission_set = $12,
        permission_confidence = $13,
        dag_structure = $2::jsonb
      RETURNING *`,
      [
        patternHash,
        dagStructure, // postgres.js auto-serializes objects to JSONB
        embeddingStr,
        success ? 1 : 0,
        code,
        codeHash,
        DEFAULT_CACHE_CONFIG, // postgres.js auto-serializes
        description || intent,
        success ? 1.0 : 0.0,
        durationMs,
        parametersSchema ?? null, // postgres.js auto-serializes
        permissionSet,
        permissionConfidence,
      ],
    );

    if (result.length === 0) {
      throw new Error("Failed to save capability - no result returned");
    }

    const row = result[0];
    const capability = this.rowToCapability(row as Row);

    logger.info("Capability saved", {
      id: capability.id,
      codeHash: capability.codeHash,
      usageCount: capability.usageCount,
      successRate: capability.successRate,
    });

    // Story 6.5: Emit capability.learned event (ADR-036)
    const isNew = capability.usageCount === 1;
    // Note: workflow_pattern.name removed in migration 022, use generateName for events
    const capabilityName = this.generateName(intent);
    const capabilityTools = toolsUsed ?? [];

    eventBus.emit({
      type: "capability.learned",
      source: "capability-store",
      payload: {
        capability_id: capability.id,
        name: capabilityName,
        intent: intent.substring(0, 100), // Truncate for event payload
        tools_used: capabilityTools,
        is_new: isNew,
        usage_count: capability.usageCount,
        success_rate: capability.successRate,
      },
    });

    // Story 8.3: Emit zone events for hypergraph incremental updates
    if (isNew) {
      // New capability = new zone
      const zonePayload = {
        capabilityId: capability.id,
        label: capabilityName,
        toolIds: capabilityTools,
        successRate: capability.successRate,
        usageCount: capability.usageCount,
      };
      logger.info("[SSE-DEBUG] Emitting capability.zone.created", {
        capabilityId: zonePayload.capabilityId,
        label: zonePayload.label,
        toolCount: zonePayload.toolIds.length,
      });
      eventBus.emit({
        type: "capability.zone.created",
        source: "capability-store",
        payload: zonePayload,
      });
    } else {
      // Existing capability updated = zone metadata update
      eventBus.emit({
        type: "capability.zone.updated",
        source: "capability-store",
        payload: {
          capabilityId: capability.id,
          label: capabilityName,
          toolIds: capabilityTools,
          successRate: capability.successRate,
          usageCount: capability.usageCount,
        },
      });
    }

    // Story 10.1: Create CapabilityDependency records for nested capability calls
    // Capabilities are called via mcp.namespace.action, detected as "task" nodes
    // We check if each task's tool matches an existing capability in DB
    // Also calculate hierarchy_level = max(child_levels) + 1
    let maxChildLevel = -1; // -1 means no children found, final level will be 0
    const childCapabilityIds: string[] = []; // Track children for SHGAT

    if (finalStaticStructure) {
      const taskNodes = finalStaticStructure.nodes.filter(
        (node): node is { id: string; type: "task"; tool: string } => node.type === "task",
      );

      for (const taskNode of taskNodes) {
        // Tool format is "namespace:action" (e.g., "cap:math_array_sum")
        // Check if this tool matches an existing capability in DB
        const toolId = taskNode.tool;
        const [namespace, action] = toolId.includes(":") ? toolId.split(":", 2) : ["", toolId];

        try {
          // Query DB to check if this tool is an existing capability
          // Also get its hierarchy_level for recursive level calculation
          const calledCapabilities = await this.db.query(
            `SELECT wp.pattern_id, COALESCE(wp.hierarchy_level, 0) as hierarchy_level
             FROM workflow_pattern wp
             INNER JOIN capability_records cr ON cr.workflow_pattern_id = wp.pattern_id
             WHERE (cr.namespace = $1 AND cr.action = $2)
                OR (cr.namespace || ':' || cr.action) = $3
             LIMIT 1`,
            [namespace, action, toolId],
          );

          if (calledCapabilities.length > 0) {
            const calledCapabilityId = calledCapabilities[0].pattern_id as string;
            const childLevel = Number(calledCapabilities[0].hierarchy_level) || 0;

            // Track max child level for hierarchy calculation
            maxChildLevel = Math.max(maxChildLevel, childLevel);
            // Track child IDs for SHGAT registration
            childCapabilityIds.push(calledCapabilityId);

            // Create "contains" edge
            await this.addDependency({
              fromCapabilityId: capability.id,
              toCapabilityId: calledCapabilityId,
              edgeType: "contains",
              edgeSource: "inferred",
            });
            logger.info("Created CapabilityDependency (contains edge)", {
              fromCapabilityId: capability.id,
              toCapabilityId: calledCapabilityId,
              calledTool: toolId,
              childLevel,
            });
          }
        } catch (error) {
          logger.warn("Failed to create CapabilityDependency", {
            capabilityId: capability.id,
            calledTool: toolId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Update hierarchy_level: parent level = max(child levels) + 1
    // If no children (maxChildLevel = -1), level stays 0
    const finalHierarchyLevel = maxChildLevel >= 0 ? maxChildLevel + 1 : 0;
    if (maxChildLevel >= 0) {
      try {
        await this.db.query(
          `UPDATE workflow_pattern SET hierarchy_level = $1 WHERE pattern_id = $2`,
          [finalHierarchyLevel, capability.id],
        );
        logger.info("Updated capability hierarchy_level", {
          capabilityId: capability.id,
          hierarchyLevel: finalHierarchyLevel,
          maxChildLevel,
        });
      } catch (error) {
        logger.warn("Failed to update hierarchy_level", {
          capabilityId: capability.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Update capability object with hierarchy info for SHGAT registration
    capability.hierarchyLevel = finalHierarchyLevel;
    capability.children = childCapabilityIds.length > 0 ? childCapabilityIds : undefined;

    // Story 11.2: Optionally save execution trace if traceData provided
    let trace: ExecutionTrace | undefined;
    if (traceData && this.traceStore) {
      try {
        // Prepend capability ID to executed_path for consistent flattening
        // This ensures sequencePosition works for capabilities (not just tools)
        // Path structure: [capability_id, tool1, tool2, ...] or [cap_id, sub_cap_id, tool1, ...]
        const executedPathWithCapability = capability.id
          ? [capability.id, ...(traceData.executedPath ?? [])]
          : traceData.executedPath;

        trace = await this.traceStore.saveTrace({
          capabilityId: capability.id,
          intentText: intent,
          intentEmbedding: traceData.intentEmbedding,
          initialContext: traceData.initialContext ?? {},
          executedAt: new Date(),
          success,
          durationMs,
          errorMessage: traceData.errorMessage,
          executedPath: executedPathWithCapability,
          decisions: traceData.decisions ?? [],
          taskResults: traceData.taskResults ?? [],
          priority: DEFAULT_TRACE_PRIORITY,
          parentTraceId: traceData.parentTraceId,
          userId: traceData.userId,
          createdBy: traceData.userId ?? "local",
        });
        logger.debug("Execution trace saved with capability", {
          capabilityId: capability.id,
          traceId: trace.id,
        });
      } catch (error) {
        logger.warn("Failed to save execution trace", {
          capabilityId: capability.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue even if trace save fails
      }
    }

    return { capability, trace };
  }

  /**
   * Find a capability by its code hash
   *
   * @param codeHash SHA-256 hash of normalized code
   * @returns Capability if found, null otherwise
   */
  async findByCodeHash(codeHash: string): Promise<Capability | null> {
    const result = await this.db.query(
      `SELECT * FROM workflow_pattern WHERE code_hash = $1`,
      [codeHash],
    );

    if (result.length === 0) {
      return null;
    }

    return this.rowToCapability(result[0] as Row);
  }

  /**
   * Update usage statistics after execution
   *
   * Called when a capability is reused (matched and executed again).
   * Updates: usage_count++, success_rate, avg_duration_ms
   *
   * @param codeHash SHA-256 hash of the executed code
   * @param success Whether execution succeeded
   * @param durationMs Execution time in milliseconds
   */
  async updateUsage(
    codeHash: string,
    success: boolean,
    durationMs: number,
  ): Promise<void> {
    // Use parameterized query to prevent SQL injection
    // Round durationMs to integer for INTEGER column type
    const durationMsInt = Math.round(durationMs);
    await this.db.query(
      `UPDATE workflow_pattern SET
        usage_count = usage_count + 1,
        success_count = success_count + $1,
        last_used = NOW(),
        success_rate = (success_count + $1)::real / (usage_count + 1)::real,
        avg_duration_ms = ((avg_duration_ms * usage_count) + $2) / (usage_count + 1)
      WHERE code_hash = $3`,
      [success ? 1 : 0, durationMsInt, codeHash],
    );

    logger.debug("Capability usage updated", { codeHash, success, durationMs });
  }

  /**
   * Search capabilities by semantic similarity to intent
   *
   * Uses HNSW index on intent_embedding for fast vector search.
   *
   * @param intent Natural language query
   * @param limit Maximum results (default: 5)
   * @param minSemanticScore Minimum semantic score threshold (default: 0.5)
   * @returns Capabilities sorted by semanticScore (harmonized with HybridSearchResult)
   */
  async searchByIntent(
    intent: string,
    limit = 5,
    minSemanticScore = 0.5,
  ): Promise<Array<{ capability: Capability; semanticScore: number }>> {
    const embedding = await this.embeddingModel.encode(intent);
    const embeddingStr = `[${embedding.join(",")}]`;

    // LEFT JOIN with capability_records to get FQDN (Story 13.2)
    // cr.id is the FQDN in capability_records table
    const result = await this.db.query(
      `SELECT wp.*, cr.id as fqdn,
        1 - (wp.intent_embedding <=> $1::vector) as semantic_score
      FROM workflow_pattern wp
      LEFT JOIN capability_records cr ON cr.workflow_pattern_id = wp.pattern_id
      WHERE wp.code_hash IS NOT NULL
        AND 1 - (wp.intent_embedding <=> $1::vector) >= $2
      ORDER BY wp.intent_embedding <=> $1::vector
      LIMIT $3`,
      [embeddingStr, minSemanticScore, limit],
    );

    const matches = result.map((row) => ({
      capability: this.rowToCapability(row as Row),
      semanticScore: row.semantic_score as number,
    }));

    return matches;
  }

  /**
   * Get total count of stored capabilities
   */
  async getCapabilityCount(): Promise<number> {
    const result = await this.db.queryOne(
      `SELECT COUNT(*) as count FROM workflow_pattern WHERE code_hash IS NOT NULL`,
    );
    return Number(result?.count ?? 0);
  }

  /**
   * Get capabilities statistics
   */
  async getStats(): Promise<{
    totalCapabilities: number;
    totalExecutions: number;
    avgSuccessRate: number;
    avgDurationMs: number;
  }> {
    const result = await this.db.queryOne(
      `SELECT
        COUNT(*) as total,
        COALESCE(SUM(usage_count), 0) as executions,
        COALESCE(AVG(success_rate), 0) as avg_success,
        COALESCE(AVG(avg_duration_ms), 0) as avg_duration
      FROM workflow_pattern
      WHERE code_hash IS NOT NULL`,
    );

    return {
      totalCapabilities: Number(result?.total ?? 0),
      totalExecutions: Number(result?.executions ?? 0),
      avgSuccessRate: Number(result?.avg_success ?? 0),
      avgDurationMs: Number(result?.avg_duration ?? 0),
    };
  }

  /**
   * Search capabilities by context tools overlap (Story 7.4 - AC#2)
   *
   * Finds capabilities whose `tools_used` overlap with the provided context tools.
   * Used for Strategic Discovery Mode (ADR-038) to suggest capabilities
   * that match the current tool context in a DAG workflow.
   *
   * Overlap score: `|intersection| / |capability.tools_used|`
   * Only returns capabilities with overlap >= minOverlap (default 0.3)
   *
   * @param contextTools - Tools currently in use (from DAG context)
   * @param limit - Maximum results (default: 5)
   * @param minOverlap - Minimum overlap threshold (default: 0.3 = 30%)
   * @returns Capabilities sorted by overlapScore descending
   */
  async searchByContext(
    contextTools: string[],
    limit = 5,
    minOverlap = 0.3,
  ): Promise<Array<{ capability: Capability; overlapScore: number }>> {
    if (contextTools.length === 0) {
      logger.debug("searchByContext called with empty contextTools");
      return [];
    }

    // Issue #5 fix: Input validation for security (prevent injection via malformed strings)
    const MAX_TOOL_LENGTH = 256;
    const MAX_TOOLS = 100;
    const validatedTools = contextTools
      .filter((t): t is string =>
        typeof t === "string" && t.length > 0 && t.length <= MAX_TOOL_LENGTH
      )
      .slice(0, MAX_TOOLS);

    if (validatedTools.length === 0) {
      logger.warn("searchByContext: All contextTools filtered out during validation");
      return [];
    }

    if (validatedTools.length !== contextTools.length) {
      logger.debug("searchByContext: Some tools filtered", {
        original: contextTools.length,
        validated: validatedTools.length,
      });
    }

    // Query capabilities with tools_used in dag_structure JSONB
    // Calculate overlap: count matching tools / total tools in capability
    const result = await this.db.query(
      `WITH capability_tools AS (
        SELECT
          pattern_id,
          dag_structure,
          code_snippet,
          code_hash,
          intent_embedding,
          -- Note: 'name' column removed in migration 022, naming via capability_records.display_name
          description,
          usage_count,
          success_count,
          success_rate,
          avg_duration_ms,
          created_at,
          last_used,
          source,
          cache_config,
          parameters_schema,
          -- Extract tools_used array from JSONB
          COALESCE(
            (dag_structure->>'tools_used')::jsonb,
            '[]'::jsonb
          ) as tools_used_arr
        FROM workflow_pattern
        WHERE code_hash IS NOT NULL
          AND dag_structure IS NOT NULL
          AND dag_structure->>'tools_used' IS NOT NULL
      ),
      overlap_calc AS (
        SELECT
          ct.*,
          -- Count how many context tools are in this capability's tools_used
          (
            SELECT COUNT(*)
            FROM jsonb_array_elements_text(ct.tools_used_arr) as tool
            WHERE tool = ANY($1::text[])
          ) as matching_count,
          -- Total tools in capability
          jsonb_array_length(ct.tools_used_arr) as total_tools
        FROM capability_tools ct
      )
      SELECT
        *,
        CASE
          WHEN total_tools > 0
          THEN matching_count::real / total_tools::real
          ELSE 0
        END as overlap_score
      FROM overlap_calc
      WHERE total_tools > 0
        AND matching_count::real / total_tools::real >= $2
      ORDER BY overlap_score DESC, usage_count DESC
      LIMIT $3`,
      [validatedTools, minOverlap, limit],
    );

    const matches = result.map((row) => ({
      capability: this.rowToCapability(row as Row),
      overlapScore: row.overlap_score as number,
    }));

    logger.debug("searchByContext results", {
      contextTools: validatedTools.slice(0, 3),
      matchCount: matches.length,
      topScore: matches[0]?.overlapScore ?? 0,
    });

    return matches;
  }

  /**
   * Find a capability by its ID (Story 7.4)
   *
   * @param id - Capability pattern_id
   * @returns Capability if found, null otherwise
   */
  async findById(id: string): Promise<Capability | null> {
    // JOIN with capability_records to get display name (namespace:action)
    const result = await this.db.query(
      `SELECT wp.*,
              COALESCE(cr.namespace || ':' || cr.action, cr.id::text) as display_name,
              cr.id as fqdn
       FROM workflow_pattern wp
       LEFT JOIN capability_records cr ON cr.workflow_pattern_id = wp.pattern_id
       WHERE wp.pattern_id = $1`,
      [id],
    );

    if (result.length === 0) {
      return null;
    }

    return this.rowToCapability(result[0] as Row);
  }

  /**
   * Convert database row to Capability object
   */
  private rowToCapability(row: Row): Capability {
    // Parse embedding string to Float32Array
    const embeddingStr = row.intent_embedding as string;
    const embeddingArr = embeddingStr
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(Number);
    const intentEmbedding = new Float32Array(embeddingArr);

    // Parse cache_config - may be object or string
    let cacheConfig: CacheConfig = DEFAULT_CACHE_CONFIG;
    if (row.cache_config) {
      cacheConfig = typeof row.cache_config === "string"
        ? JSON.parse(row.cache_config)
        : row.cache_config as CacheConfig;
    }

    // Parse parameters_schema - may be object or string
    let parametersSchema: Capability["parametersSchema"] = undefined;
    if (row.parameters_schema) {
      const schema = typeof row.parameters_schema === "string"
        ? JSON.parse(row.parameters_schema)
        : row.parameters_schema;
      if (schema && typeof schema.type === "string") {
        parametersSchema = schema as Capability["parametersSchema"];
      }
    }

    // Story 7.4: Extract tools_used, tool_invocations, and static_structure from dag_structure JSONB
    let toolsUsed: string[] | undefined;
    let toolInvocations: Capability["toolInvocations"];
    let staticStructure: Capability["staticStructure"];
    if (row.dag_structure) {
      try {
        const dagStruct = typeof row.dag_structure === "string"
          ? JSON.parse(row.dag_structure)
          : row.dag_structure;
        if (Array.isArray(dagStruct?.tools_used)) {
          toolsUsed = dagStruct.tools_used;
        }
        // Extract tool invocations for sequence visualization
        if (Array.isArray(dagStruct?.tool_invocations)) {
          toolInvocations = dagStruct.tool_invocations;
        }
        // Story 10.7: Extract static_structure for DAG execution
        if (dagStruct?.static_structure) {
          staticStructure = dagStruct.static_structure as Capability["staticStructure"];
        }
      } catch {
        // Ignore parse errors, toolsUsed/toolInvocations/staticStructure remain undefined
      }
    }

    return {
      id: row.pattern_id as string,
      // Story 13.2: FQDN from capability_records (via JOIN)
      fqdn: (row.fqdn as string) || undefined,
      codeSnippet: (row.code_snippet as string) || "",
      codeHash: (row.code_hash as string) || "",
      intentEmbedding,
      parametersSchema,
      cacheConfig,
      // Story 7.6: name from capability_records via JOIN (namespace:action)
      name: (row.display_name as string) || undefined,
      description: (row.description as string) || undefined,
      usageCount: row.usage_count as number,
      successCount: row.success_count as number,
      successRate: (row.success_rate as number) ?? 1.0,
      avgDurationMs: (row.avg_duration_ms as number) ?? 0,
      createdAt: new Date((row.created_at as string) || Date.now()),
      lastUsed: new Date(row.last_used as string),
      source: ((row.source as string) as "emergent" | "manual") || "emergent",
      toolsUsed,
      toolInvocations,
      // Story 7.7a: Permission inference fields
      permissionSet: (row.permission_set as PermissionSet) || "minimal",
      permissionConfidence: (row.permission_confidence as number) ?? 0.0,
      // Story 10.7: Static structure for DAG execution
      staticStructure,
      // Story 10.7c: Risk category derived from max(toolsUsed.risk)
      riskCategory: toolsUsed ? calculateCapabilityRisk(toolsUsed) : "safe",
      // Story 10.1: Hierarchy level from DB (0=leaf, 1+=meta-capability)
      hierarchyLevel: (row.hierarchy_level as number) ?? 0,
    };
  }

  /**
   * Generate a short name from intent
   */
  private generateName(intent: string): string {
    // Take first 3-5 words, capitalize first letter
    const words = intent.split(/\s+/).slice(0, 5);
    const name = words.join(" ");
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  // ============================================
  // Capability Dependency Methods (Tech-spec)
  // ============================================

  /**
   * Threshold for edge_source upgrade from 'inferred' to 'observed'
   */
  private static readonly OBSERVED_THRESHOLD = 3;

  /**
   * Edge type weights for confidence score calculation
   * Story 10.3: Added "provides" for data flow relationships
   */
  private static readonly EDGE_TYPE_WEIGHTS: Record<CapabilityEdgeType, number> = {
    dependency: 1.0,
    contains: 0.8,
    provides: 0.7, // Data flow (A's output feeds B's input)
    alternative: 0.6,
    sequence: 0.5,
  };

  /**
   * Edge source modifiers for confidence score calculation
   */
  private static readonly EDGE_SOURCE_MODIFIERS: Record<CapabilityEdgeSource, number> = {
    observed: 1.0,
    inferred: 0.7,
    template: 0.5,
  };

  /**
   * Add a dependency relationship between two capabilities
   *
   * @param input - Dependency creation input
   * @returns The created or updated dependency
   */
  async addDependency(input: CreateCapabilityDependencyInput): Promise<CapabilityDependency> {
    const { fromCapabilityId, toCapabilityId, edgeType, edgeSource = "inferred" } = input;

    // Calculate initial confidence score
    const typeWeight = CapabilityStore.EDGE_TYPE_WEIGHTS[edgeType];
    const sourceModifier = CapabilityStore.EDGE_SOURCE_MODIFIERS[edgeSource];
    const confidenceScore = typeWeight * sourceModifier;

    logger.debug("Adding capability dependency", {
      fromCapabilityId,
      toCapabilityId,
      edgeType,
      edgeSource,
      confidenceScore,
    });

    const result = await this.db.query(
      `INSERT INTO capability_dependency (
        from_capability_id, to_capability_id, observed_count, confidence_score,
        edge_type, edge_source, created_at, last_observed
      ) VALUES ($1, $2, 1, $3::real, $4, $5, NOW(), NOW())
      ON CONFLICT (from_capability_id, to_capability_id) DO UPDATE SET
        observed_count = capability_dependency.observed_count + 1,
        last_observed = NOW(),
        edge_source = CASE
          WHEN capability_dependency.observed_count + 1 >= $6::integer
            AND capability_dependency.edge_source = 'inferred'
          THEN 'observed'
          ELSE capability_dependency.edge_source
        END,
        confidence_score = $7::real * CASE
          WHEN capability_dependency.observed_count + 1 >= $6::integer
            AND capability_dependency.edge_source = 'inferred'
          THEN $8::real
          ELSE $9::real
        END
      RETURNING *`,
      [
        fromCapabilityId,
        toCapabilityId,
        confidenceScore,
        edgeType,
        edgeSource,
        CapabilityStore.OBSERVED_THRESHOLD,
        typeWeight,
        CapabilityStore.EDGE_SOURCE_MODIFIERS["observed"],
        sourceModifier,
      ],
    );

    if (result.length === 0) {
      throw new Error("Failed to add capability dependency - no result returned");
    }

    const dep = this.rowToDependency(result[0]);

    logger.info("Capability dependency added", {
      fromCapabilityId: dep.fromCapabilityId,
      toCapabilityId: dep.toCapabilityId,
      observedCount: dep.observedCount,
      edgeSource: dep.edgeSource,
    });

    // Warn if contains cycle detected (potential paradox)
    if (edgeType === "contains") {
      const reverseExists = await this.db.queryOne(
        `SELECT 1 FROM capability_dependency
         WHERE from_capability_id = $1 AND to_capability_id = $2 AND edge_type = 'contains'`,
        [toCapabilityId, fromCapabilityId],
      );
      if (reverseExists) {
        logger.warn(
          `Potential paradox: contains cycle detected between capabilities ${fromCapabilityId} ↔ ${toCapabilityId}`,
        );
      }
    }

    // Emit event for graph sync
    eventBus.emit({
      type: "capability.dependency.created",
      source: "capability-store",
      payload: {
        from_capability_id: dep.fromCapabilityId,
        to_capability_id: dep.toCapabilityId,
        edge_type: dep.edgeType,
        edge_source: dep.edgeSource,
        observed_count: dep.observedCount,
      },
    });

    return dep;
  }

  /**
   * Update a dependency's observation count
   *
   * @param fromId - Source capability ID
   * @param toId - Target capability ID
   * @param incrementBy - Amount to increment observed_count (default: 1)
   */
  async updateDependency(fromId: string, toId: string, incrementBy = 1): Promise<void> {
    await this.db.query(
      `UPDATE capability_dependency SET
        observed_count = observed_count + $1,
        last_observed = NOW(),
        edge_source = CASE
          WHEN observed_count + $1 >= $2 AND edge_source = 'inferred'
          THEN 'observed'
          ELSE edge_source
        END,
        confidence_score = (
          CASE edge_type
            WHEN 'dependency' THEN 1.0
            WHEN 'contains' THEN 0.8
            WHEN 'alternative' THEN 0.6
            ELSE 0.5
          END
        ) * (
          CASE
            WHEN observed_count + $1 >= $2 AND edge_source = 'inferred' THEN 1.0
            WHEN edge_source = 'observed' THEN 1.0
            WHEN edge_source = 'inferred' THEN 0.7
            ELSE 0.5
          END
        )
      WHERE from_capability_id = $3 AND to_capability_id = $4`,
      [incrementBy, CapabilityStore.OBSERVED_THRESHOLD, fromId, toId],
    );

    logger.debug("Capability dependency updated", { fromId, toId, incrementBy });
  }

  /**
   * Get dependencies for a capability
   *
   * @param capabilityId - Capability ID
   * @param direction - 'from' (outgoing), 'to' (incoming), or 'both'
   * @returns List of dependency relationships
   */
  async getDependencies(
    capabilityId: string,
    direction: "from" | "to" | "both" = "both",
  ): Promise<CapabilityDependency[]> {
    let query: string;
    let params: string[];

    switch (direction) {
      case "from":
        query =
          `SELECT * FROM capability_dependency WHERE from_capability_id = $1 ORDER BY confidence_score DESC`;
        params = [capabilityId];
        break;
      case "to":
        query =
          `SELECT * FROM capability_dependency WHERE to_capability_id = $1 ORDER BY confidence_score DESC`;
        params = [capabilityId];
        break;
      case "both":
        query = `SELECT * FROM capability_dependency
          WHERE from_capability_id = $1 OR to_capability_id = $1
          ORDER BY confidence_score DESC`;
        params = [capabilityId];
        break;
    }

    const result = await this.db.query(query, params);
    return result.map((row) => this.rowToDependency(row));
  }

  /**
   * Get count of dependencies for a capability
   *
   * @param capabilityId - Capability ID
   * @returns Number of dependencies (both directions)
   */
  async getDependenciesCount(capabilityId: string): Promise<number> {
    const result = await this.db.queryOne(
      `SELECT COUNT(*) as count FROM capability_dependency
       WHERE from_capability_id = $1 OR to_capability_id = $1`,
      [capabilityId],
    );
    return Number(result?.count ?? 0);
  }

  /**
   * Remove a dependency relationship
   *
   * @param fromId - Source capability ID
   * @param toId - Target capability ID
   */
  async removeDependency(fromId: string, toId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM capability_dependency WHERE from_capability_id = $1 AND to_capability_id = $2`,
      [fromId, toId],
    );

    logger.info("Capability dependency removed", { fromId, toId });

    eventBus.emit({
      type: "capability.dependency.removed",
      source: "capability-store",
      payload: {
        from_capability_id: fromId,
        to_capability_id: toId,
      },
    });
  }

  /**
   * Get all capability dependencies (for graph sync)
   *
   * @param minConfidence - Minimum confidence score (default: 0.3)
   * @returns All dependencies above threshold
   */
  async getAllDependencies(minConfidence = 0.3): Promise<CapabilityDependency[]> {
    const result = await this.db.query(
      `SELECT * FROM capability_dependency WHERE confidence_score > $1`,
      [minConfidence],
    );
    return result.map((row) => this.rowToDependency(row));
  }

  /**
   * Search capabilities by intent and include their dependencies
   * Tech-spec Task 6: Enhanced search that returns dependencies with results
   *
   * @param intent - Natural language query
   * @param limit - Maximum results (default: 5)
   * @param minSemanticScore - Minimum semantic score (default: 0.5)
   * @returns Capabilities with their dependencies
   */
  async searchByIntentWithDeps(
    intent: string,
    limit = 5,
    minSemanticScore = 0.5,
  ): Promise<
    Array<{
      capability: Capability;
      semanticScore: number;
      dependencies: Capability[];
    }>
  > {
    // First, get the base search results
    const results = await this.searchByIntent(intent, limit, minSemanticScore);

    // For each result, fetch its dependencies (edge_type = 'dependency')
    const enhancedResults = await Promise.all(
      results.map(async ({ capability, semanticScore }) => {
        // Get outgoing dependencies only
        const depRows = await this.db.query(
          `SELECT to_capability_id FROM capability_dependency
           WHERE from_capability_id = $1 AND edge_type = 'dependency'
           ORDER BY confidence_score DESC
           LIMIT 10`,
          [capability.id],
        );

        // Fetch the dependent capabilities
        const dependencies: Capability[] = [];
        for (const row of depRows) {
          const depCap = await this.findById(row.to_capability_id as string);
          if (depCap) {
            dependencies.push(depCap);
          }
        }

        return {
          capability,
          semanticScore,
          dependencies,
        };
      }),
    );

    return enhancedResults;
  }

  /**
   * Convert database row to CapabilityDependency object
   */
  private rowToDependency(row: Row): CapabilityDependency {
    return {
      fromCapabilityId: row.from_capability_id as string,
      toCapabilityId: row.to_capability_id as string,
      observedCount: row.observed_count as number,
      confidenceScore: row.confidence_score as number,
      edgeType: row.edge_type as CapabilityEdgeType,
      edgeSource: row.edge_source as CapabilityEdgeSource,
      createdAt: new Date(row.created_at as string),
      lastObserved: new Date(row.last_observed as string),
    };
  }

  // ============================================
  // Permission Escalation Methods (Story 7.7c)
  // ============================================

  /**
   * Valid permission set transitions for escalation
   *
   * Used to validate that escalation requests follow allowed paths.
   * "trusted" is not allowed via escalation (manual override only).
   */
  private static readonly VALID_ESCALATIONS: Record<PermissionSet, PermissionSet[]> = {
    minimal: ["readonly", "filesystem", "network-api", "mcp-standard"],
    readonly: ["filesystem", "mcp-standard"],
    filesystem: ["mcp-standard"],
    "network-api": ["mcp-standard"],
    "mcp-standard": [],
    trusted: [],
  };

  /**
   * Update a capability's permission set after HIL approval (Story 7.7c - AC4)
   *
   * This method is called when a permission escalation request is approved.
   * It validates the transition and updates the capability's permission_set in the database.
   *
   * @param capabilityId - UUID of the capability to update
   * @param newPermissionSet - New permission set to apply
   * @throws Error if capability not found or transition is invalid
   *
   * @example
   * ```typescript
   * // After HIL approval for escalation from "minimal" to "network-api"
   * await capabilityStore.updatePermissionSet("cap-uuid", "network-api");
   * ```
   */
  async updatePermissionSet(
    capabilityId: string,
    newPermissionSet: PermissionSet,
  ): Promise<void> {
    // First, get current capability to validate transition
    const capability = await this.findById(capabilityId);
    if (!capability) {
      throw new Error(`Capability ${capabilityId} not found`);
    }

    const currentSet = capability.permissionSet ?? "minimal";

    // Validate that the transition is allowed
    const allowedTargets = CapabilityStore.VALID_ESCALATIONS[currentSet];
    if (!allowedTargets.includes(newPermissionSet)) {
      throw new Error(
        `Invalid permission escalation: ${currentSet} -> ${newPermissionSet}. ` +
          `Allowed targets: ${allowedTargets.join(", ") || "none"}`,
      );
    }

    // Update the permission set in the database
    await this.db.query(
      `UPDATE workflow_pattern
       SET permission_set = $1,
           permission_confidence = 1.0
       WHERE pattern_id = $2`,
      [newPermissionSet, capabilityId],
    );

    logger.info("Capability permission set updated", {
      capabilityId,
      fromSet: currentSet,
      toSet: newPermissionSet,
    });

    // Emit event for observability
    eventBus.emit({
      type: "capability.permission.updated",
      source: "capability-store",
      payload: {
        capability_id: capabilityId,
        from_set: currentSet,
        to_set: newPermissionSet,
        via: "hil_escalation",
      },
    });
  }

  /**
   * Check if a permission escalation is valid
   *
   * @param fromSet - Current permission set
   * @param toSet - Target permission set
   * @returns true if escalation is allowed
   */
  isValidEscalation(fromSet: PermissionSet, toSet: PermissionSet): boolean {
    return CapabilityStore.VALID_ESCALATIONS[fromSet]?.includes(toSet) ?? false;
  }

  // ============================================
  // Static Structure Methods (Story 10.2)
  // ============================================

  /**
   * Get static_structure for a capability (Story 10.2)
   *
   * Used by DAGSuggester to extract arguments for speculative execution.
   * Returns the static structure containing nodes with their arguments.
   *
   * @param capabilityId - Capability pattern_id
   * @returns StaticStructure if available, null otherwise
   */
  async getStaticStructure(capabilityId: string): Promise<StaticStructure | null> {
    try {
      const result = await this.db.query(
        `SELECT dag_structure->'static_structure' as static_structure
         FROM workflow_pattern
         WHERE pattern_id = $1`,
        [capabilityId],
      );

      if (result.length === 0 || !result[0].static_structure) {
        return null;
      }

      const staticStructure = result[0].static_structure as StaticStructure;

      // Validate structure has expected shape
      if (!staticStructure.nodes || !staticStructure.edges) {
        return null;
      }

      return staticStructure;
    } catch (error) {
      logger.debug("Failed to get static structure", {
        capabilityId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // ============================================
  // MCP Tool Listing Methods (Story 13.3)
  // ============================================

  /**
   * List capabilities with their schemas for MCP tool listing (Story 13.3)
   *
   * JOINs workflow_pattern with capability_records to get:
   * - namespace, action, displayName from capability_records
   * - parametersSchema, description from workflow_pattern
   *
   * Used by CapabilityListerService to generate MCP tool list.
   *
   * @param options - Query options (ListWithSchemasOptions from types.ts)
   * @returns Capabilities with schema info (CapabilityWithSchema from types.ts)
   */
  async listWithSchemas(
    options: ListWithSchemasOptions = {},
  ): Promise<CapabilityWithSchema[]> {
    const {
      visibility = ["public", "org", "project", "private"],
      createdBy,
      limit = 100,
      orderBy = "usageCount",
    } = options;

    // Build ORDER BY clause
    // Migration 028: display_name removed, use namespace || ':' || action
    let orderClause: string;
    switch (orderBy) {
      case "displayName":
        orderClause = "(cr.namespace || ':' || cr.action) ASC";
        break;
      case "createdAt":
        orderClause = "wp.created_at DESC";
        break;
      case "usageCount":
      default:
        orderClause = "wp.usage_count DESC";
    }

    // Build query with JOIN
    // Migration 028: display_name removed, computed as namespace:action
    const query = `
      SELECT
        wp.pattern_id as id,
        cr.namespace,
        cr.action,
        wp.description,
        wp.parameters_schema,
        wp.usage_count
      FROM capability_records cr
      INNER JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
      WHERE cr.visibility = ANY($1::text[])
        ${createdBy ? "AND cr.created_by = $2" : ""}
      ORDER BY ${orderClause}
      LIMIT ${createdBy ? "$3" : "$2"}
    `;

    const params = createdBy ? [visibility, createdBy, limit] : [visibility, limit];

    const result = await this.db.query(query, params);

    return result.map((row) => {
      // Parse parameters_schema if it's a string
      let parametersSchema: Record<string, unknown> | null = null;
      if (row.parameters_schema) {
        parametersSchema = typeof row.parameters_schema === "string"
          ? JSON.parse(row.parameters_schema)
          : row.parameters_schema as Record<string, unknown>;
      }

      // Migration 028: displayName computed as namespace:action
      const namespace = row.namespace as string;
      const action = row.action as string;
      return {
        id: row.id as string,
        namespace,
        action,
        displayName: `${namespace}:${action}`,
        description: row.description as string | null,
        parametersSchema,
        usageCount: row.usage_count as number,
      };
    });
  }
}
