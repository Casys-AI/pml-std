/**
 * Provides Edge Calculator (Story 10.3)
 *
 * Calculates "provides" edges between tools based on schema compatibility.
 * A "provides" edge exists when one tool's output can serve as input to another.
 *
 * Key concepts:
 * - Provider: Tool that produces output data
 * - Consumer: Tool that expects input data
 * - Coverage: How well provider outputs match consumer inputs (strict/partial/optional)
 * - Field Mapping: Specific field-to-field correspondences with type compatibility
 *
 * @module graphrag/provides-edge-calculator
 */

import type { PGliteClient } from "../db/client.ts";
import type {
  FieldMapping,
  JSONSchema,
  ProvidesEdge,
  ProvidesCoverage,
} from "./types.ts";
import { EDGE_TYPE_WEIGHTS } from "./algorithms/edge-weights.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

// =============================================================================
// Type Compatibility
// =============================================================================

/**
 * Check if two JSON Schema types are compatible for data flow
 *
 * Compatibility rules (configurable strictness):
 * - Same type = always compatible
 * - any accepts all types
 * - string can receive: number (via stringify), boolean (via stringify)
 * - object can receive: array (in some contexts)
 *
 * @param fromType - Provider's field type
 * @param toType - Consumer's expected type
 * @param strict - If true, only exact matches are compatible
 * @returns Whether types are compatible for data flow
 */
export function areTypesCompatible(
  fromType: string | undefined,
  toType: string | undefined,
  strict = false,
): boolean {
  // Undefined types are treated as "any"
  const from = fromType?.toLowerCase() || "any";
  const to = toType?.toLowerCase() || "any";

  // Exact match
  if (from === to) return true;

  // "any" accepts everything
  if (to === "any" || from === "any") return true;

  // Strict mode only allows exact matches (already handled above)
  if (strict) return false;

  // Relaxed compatibility rules
  // String can stringify most things
  if (to === "string") {
    return ["number", "boolean", "integer"].includes(from);
  }

  // Number can accept integer
  if (to === "number" && from === "integer") return true;

  // Object can accept array in some contexts
  if (to === "object" && from === "array") return true;

  return false;
}

// =============================================================================
// Coverage Calculation
// =============================================================================

/**
 * Consumer input schema breakdown for provides edge calculation
 *
 * Used by computeCoverage() to determine how well a provider's
 * output fields match a consumer's input requirements.
 *
 * @example
 * ```typescript
 * const consumerInputs: ConsumerInputs = {
 *   required: new Set(["url", "body"]),  // Must be provided
 *   optional: new Set(["headers"]),       // Nice to have
 * };
 * ```
 */
export interface ConsumerInputs {
  /** Fields that MUST be provided for the consumer to work */
  required: Set<string>;
  /** Fields that CAN be provided but are not mandatory */
  optional: Set<string>;
}

/**
 * Compute coverage level based on field intersection
 *
 * Algorithm (from Story 10.1 static-structure-builder.ts:841-881):
 * 1. Calculate intersection of provider outputs and consumer inputs
 * 2. Separate required vs optional field intersections
 * 3. Determine coverage level based on what's covered
 *
 * @param providerOutputs - Set of field names the provider outputs
 * @param consumerInputs - Consumer's required and optional input fields
 * @returns Coverage level or null if no intersection
 */
export function computeCoverage(
  providerOutputs: Set<string>,
  consumerInputs: ConsumerInputs,
): ProvidesCoverage | null {
  const { required, optional } = consumerInputs;

  // All consumer inputs (required + optional)
  const allInputs = new Set([...required, ...optional]);

  // Calculate intersections
  const allIntersection = new Set(
    [...providerOutputs].filter((p) => allInputs.has(p)),
  );
  const requiredIntersection = new Set(
    [...providerOutputs].filter((p) => required.has(p)),
  );
  const optionalIntersection = new Set(
    [...allIntersection].filter((p) => !required.has(p)),
  );

  // No intersection = no edge
  if (allIntersection.size === 0) return null;

  // All required covered = strict
  if (required.size > 0 && requiredIntersection.size === required.size) {
    return "strict";
  }

  // Some required covered = partial
  if (requiredIntersection.size > 0) return "partial";

  // Only optional covered
  if (optionalIntersection.size > 0) return "optional";

  return null;
}

// =============================================================================
// Field Mapping
// =============================================================================

/**
 * Common field name aliases for semantic matching
 *
 * These patterns help match fields that are semantically similar
 * even if they have different names.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  content: ["text", "data", "body", "payload", "json", "input"],
  text: ["content", "data", "body", "message"],
  path: ["file", "file_path", "filepath", "location"],
  url: ["uri", "href", "link", "endpoint"],
  result: ["output", "response", "data", "value"],
  input: ["data", "content", "body", "payload"],
  json: ["content", "data", "body", "text"],
};

/**
 * Check if two field names are semantically similar
 */
function areFieldsSemanticallySimilar(from: string, to: string): boolean {
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();

  // Exact match
  if (fromLower === toLower) return true;

  // Check aliases
  const fromAliases = FIELD_ALIASES[fromLower] || [];
  const toAliases = FIELD_ALIASES[toLower] || [];

  return fromAliases.includes(toLower) || toAliases.includes(fromLower);
}

/**
 * Extract type from JSON Schema property
 */
function extractType(schema: JSONSchema | undefined): string | undefined {
  if (!schema) return undefined;
  return schema.type;
}

/**
 * Create field-level mappings between provider and consumer schemas
 *
 * For each field in the consumer's input, find the best matching field
 * from the provider's output based on:
 * 1. Exact name match
 * 2. Semantic similarity (aliases)
 * 3. Type compatibility
 *
 * @param providerOutput - Provider's output schema
 * @param consumerInput - Consumer's input schema
 * @returns Array of field mappings
 */
export function createFieldMapping(
  providerOutput: JSONSchema,
  consumerInput: JSONSchema,
): FieldMapping[] {
  const mappings: FieldMapping[] = [];

  const outputProps = providerOutput.properties || {};
  const inputProps = consumerInput.properties || {};

  // For each consumer input field, try to find a matching provider output
  for (const [inputField, inputSchema] of Object.entries(inputProps)) {
    const inputType = extractType(inputSchema as JSONSchema);

    // Try exact match first
    if (inputField in outputProps) {
      const outputType = extractType(outputProps[inputField] as JSONSchema);
      mappings.push({
        fromField: inputField,
        toField: inputField,
        typeCompatible: areTypesCompatible(outputType, inputType),
        fromType: outputType,
        toType: inputType,
      });
      continue;
    }

    // Try semantic matching
    for (const [outputField, outputSchema] of Object.entries(outputProps)) {
      if (areFieldsSemanticallySimilar(outputField, inputField)) {
        const outputType = extractType(outputSchema as JSONSchema);
        mappings.push({
          fromField: outputField,
          toField: inputField,
          typeCompatible: areTypesCompatible(outputType, inputType),
          fromType: outputType,
          toType: inputType,
        });
        break; // Take first semantic match
      }
    }
  }

  return mappings;
}

// =============================================================================
// Main Function: Create Provides Edges
// =============================================================================

/**
 * Tool schema data from database
 * Note: Column is 'name' not 'tool_name' per migration 001_initial.sql
 */
interface ToolSchema {
  tool_id: string;
  server_id: string;
  name: string;
  input_schema: JSONSchema | null;
  output_schema: JSONSchema | null;
}

/**
 * Calculate provides edges from MCP tool schemas
 *
 * For each pair of tools (A, B), determines if A's output can serve as B's input.
 * Creates a ProvidesEdge if there is any schema overlap.
 *
 * Complexity: O(n²) where n = number of tools with schemas
 *
 * @param db - PGlite database client
 * @param toolIds - Optional filter for specific tools (all if not provided)
 * @returns Array of ProvidesEdge objects
 */
export async function createProvidesEdges(
  db: PGliteClient,
  toolIds?: string[],
): Promise<ProvidesEdge[]> {
  const startTime = performance.now();

  // Query tool schemas
  let query = `
    SELECT tool_id, server_id, name, input_schema, output_schema
    FROM tool_schema
    WHERE input_schema IS NOT NULL OR output_schema IS NOT NULL
  `;

  if (toolIds && toolIds.length > 0) {
    const placeholders = toolIds.map((_, i) => `$${i + 1}`).join(", ");
    query += ` AND tool_id IN (${placeholders})`;
  }

  const rows = await db.query(query, toolIds || []);
  const tools = rows as unknown as ToolSchema[];

  logger.debug("Loaded tool schemas for provides edge calculation", {
    toolCount: tools.length,
    filtered: !!toolIds,
  });

  // Separate tools with output schemas (providers) and input schemas (consumers)
  const providers = tools.filter((t: ToolSchema) => t.output_schema !== null);
  const consumers = tools.filter((t: ToolSchema) => t.input_schema !== null);

  logger.debug("Tool classification", {
    providersCount: providers.length,
    consumersCount: consumers.length,
  });

  const edges: ProvidesEdge[] = [];

  // For each provider-consumer pair, calculate provides edge
  for (const provider of providers) {
    for (const consumer of consumers) {
      // Skip self-loops
      if (provider.tool_id === consumer.tool_id) continue;

      // Get schemas
      const outputSchema = provider.output_schema!;
      const inputSchema = consumer.input_schema!;

      // Extract field sets
      const providerOutputs = new Set(
        Object.keys(outputSchema.properties || {}),
      );

      const consumerInputs: ConsumerInputs = {
        required: new Set(inputSchema.required || []),
        optional: new Set(
          Object.keys(inputSchema.properties || {}).filter(
            (k) => !(inputSchema.required || []).includes(k),
          ),
        ),
      };

      // If provider has no output properties, skip
      if (providerOutputs.size === 0) continue;

      // If consumer has no input properties, skip
      if (consumerInputs.required.size === 0 && consumerInputs.optional.size === 0) {
        continue;
      }

      // Compute coverage
      const coverage = computeCoverage(providerOutputs, consumerInputs);
      if (coverage === null) continue; // No intersection

      // Create field mapping
      const fieldMapping = createFieldMapping(outputSchema, inputSchema);

      // Create the edge
      edges.push({
        from: provider.tool_id,
        to: consumer.tool_id,
        type: "provides",
        coverage,
        providerOutputSchema: outputSchema,
        consumerInputSchema: inputSchema,
        fieldMapping,
        weight: EDGE_TYPE_WEIGHTS.provides,
      });
    }
  }

  const elapsedMs = performance.now() - startTime;
  logger.info("Created provides edges from tool schemas", {
    edgesCreated: edges.length,
    providers: providers.length,
    consumers: consumers.length,
    elapsedMs: Math.round(elapsedMs),
  });

  return edges;
}

// =============================================================================
// Coverage <-> Confidence Score Mapping
// =============================================================================

/**
 * Map coverage level to confidence score for DB storage
 */
const COVERAGE_TO_CONFIDENCE: Record<ProvidesCoverage, number> = {
  strict: 1.0,
  partial: 0.7,
  optional: 0.4,
};

/**
 * Map confidence score back to coverage level
 */
function confidenceToCoverage(confidence: number): ProvidesCoverage {
  if (confidence >= 0.9) return "strict";
  if (confidence >= 0.5) return "partial";
  return "optional";
}

// =============================================================================
// DB Persistence (AC10 - Scalability Optimization)
// =============================================================================

/**
 * Persist provides edges to tool_dependency table for O(1) queries
 *
 * Uses UPSERT to handle existing edges gracefully.
 * Stores coverage as confidence_score (strict=1.0, partial=0.7, optional=0.4)
 *
 * @param db - PGlite database client
 * @param edges - Calculated provides edges to persist
 * @returns Number of edges persisted
 */
export async function persistProvidesEdges(
  db: PGliteClient,
  edges: ProvidesEdge[],
): Promise<number> {
  if (edges.length === 0) return 0;

  const startTime = performance.now();
  let persisted = 0;

  for (const edge of edges) {
    const confidence = COVERAGE_TO_CONFIDENCE[edge.coverage];

    await db.query(
      `INSERT INTO tool_dependency (from_tool_id, to_tool_id, edge_type, edge_source, confidence_score, observed_count, last_observed)
       VALUES ($1, $2, 'provides', 'inferred', $3, 1, NOW())
       ON CONFLICT (from_tool_id, to_tool_id) DO UPDATE SET
         edge_type = 'provides',
         confidence_score = $3,
         last_observed = NOW()`,
      [edge.from, edge.to, confidence],
    );
    persisted++;
  }

  const elapsedMs = performance.now() - startTime;
  logger.info("Persisted provides edges to tool_dependency", {
    edgesPersisted: persisted,
    elapsedMs: Math.round(elapsedMs),
  });

  return persisted;
}

/**
 * Sync provides edges for a specific tool (incremental update)
 *
 * Call this when a tool's schema is added/updated.
 * Calculates edges involving this tool and persists them.
 *
 * @param db - PGlite database client
 * @param toolId - Tool whose edges should be recalculated
 * @returns Number of edges updated
 */
export async function syncProvidesEdgesForTool(
  db: PGliteClient,
  toolId: string,
): Promise<number> {
  const startTime = performance.now();

  // Get the target tool's schema
  const toolResult = await db.query(
    `SELECT tool_id, server_id, name, input_schema, output_schema
     FROM tool_schema WHERE tool_id = $1`,
    [toolId],
  );

  if ((toolResult as unknown[]).length === 0) {
    logger.debug("Tool not found for provides edge sync", { toolId });
    return 0;
  }

  const targetTool = (toolResult as unknown as ToolSchema[])[0];

  // Delete existing provides edges involving this tool
  await db.query(
    `DELETE FROM tool_dependency
     WHERE edge_type = 'provides' AND (from_tool_id = $1 OR to_tool_id = $1)`,
    [toolId],
  );

  // Get all other tools with schemas
  const otherTools = await db.query(
    `SELECT tool_id, server_id, name, input_schema, output_schema
     FROM tool_schema
     WHERE tool_id != $1 AND (input_schema IS NOT NULL OR output_schema IS NOT NULL)`,
    [toolId],
  ) as unknown as ToolSchema[];

  const edges: ProvidesEdge[] = [];

  // If target tool has output_schema, it can be a provider
  if (targetTool.output_schema) {
    const consumers = otherTools.filter((t) => t.input_schema !== null);
    for (const consumer of consumers) {
      const edge = calculateProvidesEdge(targetTool, consumer);
      if (edge) edges.push(edge);
    }
  }

  // If target tool has input_schema, it can be a consumer
  if (targetTool.input_schema) {
    const providers = otherTools.filter((t) => t.output_schema !== null);
    for (const provider of providers) {
      const edge = calculateProvidesEdge(provider, targetTool);
      if (edge) edges.push(edge);
    }
  }

  // Persist the calculated edges
  const persisted = await persistProvidesEdges(db, edges);

  const elapsedMs = performance.now() - startTime;
  logger.info("Synced provides edges for tool", {
    toolId,
    edgesCreated: persisted,
    elapsedMs: Math.round(elapsedMs),
  });

  return persisted;
}

/**
 * Calculate a single provides edge between two tools
 * @internal
 */
function calculateProvidesEdge(
  provider: ToolSchema,
  consumer: ToolSchema,
): ProvidesEdge | null {
  if (!provider.output_schema || !consumer.input_schema) return null;

  const outputSchema = provider.output_schema;
  const inputSchema = consumer.input_schema;

  const providerOutputs = new Set(Object.keys(outputSchema.properties || {}));
  const consumerInputs: ConsumerInputs = {
    required: new Set(inputSchema.required || []),
    optional: new Set(
      Object.keys(inputSchema.properties || {}).filter(
        (k) => !(inputSchema.required || []).includes(k),
      ),
    ),
  };

  if (providerOutputs.size === 0) return null;
  if (consumerInputs.required.size === 0 && consumerInputs.optional.size === 0) {
    return null;
  }

  const coverage = computeCoverage(providerOutputs, consumerInputs);
  if (coverage === null) return null;

  const fieldMapping = createFieldMapping(outputSchema, inputSchema);

  return {
    from: provider.tool_id,
    to: consumer.tool_id,
    type: "provides",
    coverage,
    providerOutputSchema: outputSchema,
    consumerInputSchema: inputSchema,
    fieldMapping,
    weight: EDGE_TYPE_WEIGHTS.provides,
  };
}

/**
 * Full sync: Calculate and persist ALL provides edges
 *
 * Use this for initial population or full refresh.
 * For incremental updates, use syncProvidesEdgesForTool().
 *
 * @param db - PGlite database client
 * @returns Number of edges persisted
 */
export async function syncAllProvidesEdges(db: PGliteClient): Promise<number> {
  const startTime = performance.now();

  // Delete all existing provides edges
  await db.query(`DELETE FROM tool_dependency WHERE edge_type = 'provides'`);

  // Calculate all provides edges
  const edges = await createProvidesEdges(db);

  // Persist them
  const persisted = await persistProvidesEdges(db, edges);

  const elapsedMs = performance.now() - startTime;
  logger.info("Full sync of provides edges complete", {
    edgesPersisted: persisted,
    elapsedMs: Math.round(elapsedMs),
  });

  return persisted;
}

// =============================================================================
// Query Functions (O(1) via DB)
// =============================================================================

/**
 * Stored provides edge from DB (minimal data)
 */
interface StoredProvidesEdge {
  from_tool_id: string;
  to_tool_id: string;
  confidence_score: number;
}

/**
 * Get provides edges for a specific tool from DB (O(1) query)
 *
 * For full ProvidesEdge objects with schemas, use getToolProvidesEdgesFull().
 *
 * @param db - PGlite database client
 * @param toolId - Tool to find edges for
 * @param direction - "from" (as provider), "to" (as consumer), or "both"
 * @returns Array of ProvidesEdge objects (without full schemas)
 */
export async function getToolProvidesEdges(
  db: PGliteClient,
  toolId: string,
  direction: "from" | "to" | "both" = "both",
): Promise<ProvidesEdge[]> {
  let query: string;
  let params: string[];

  if (direction === "from") {
    query = `SELECT from_tool_id, to_tool_id, confidence_score
             FROM tool_dependency WHERE edge_type = 'provides' AND from_tool_id = $1`;
    params = [toolId];
  } else if (direction === "to") {
    query = `SELECT from_tool_id, to_tool_id, confidence_score
             FROM tool_dependency WHERE edge_type = 'provides' AND to_tool_id = $1`;
    params = [toolId];
  } else {
    query = `SELECT from_tool_id, to_tool_id, confidence_score
             FROM tool_dependency WHERE edge_type = 'provides' AND (from_tool_id = $1 OR to_tool_id = $1)`;
    params = [toolId];
  }

  const rows = await db.query(query, params) as unknown as StoredProvidesEdge[];

  // Convert to ProvidesEdge (without full schemas for performance)
  return rows.map((row) => ({
    from: row.from_tool_id,
    to: row.to_tool_id,
    type: "provides" as const,
    coverage: confidenceToCoverage(row.confidence_score),
    providerOutputSchema: {}, // Empty - use getToolProvidesEdgesFull() for full data
    consumerInputSchema: {},
    fieldMapping: [],
    weight: EDGE_TYPE_WEIGHTS.provides,
  }));
}

/**
 * Get provides edges with full schema data (joins tool_schema)
 *
 * Use this when you need fieldMapping and full schemas.
 * Slower than getToolProvidesEdges() but provides complete data.
 *
 * @param db - PGlite database client
 * @param toolId - Tool to find edges for
 * @param direction - "from" (as provider), "to" (as consumer), or "both"
 * @returns Array of complete ProvidesEdge objects
 */
export async function getToolProvidesEdgesFull(
  db: PGliteClient,
  toolId: string,
  direction: "from" | "to" | "both" = "both",
): Promise<ProvidesEdge[]> {
  // Get edge IDs from DB
  const edges = await getToolProvidesEdges(db, toolId, direction);
  if (edges.length === 0) return [];

  // Collect all tool IDs we need schemas for
  const toolIds = new Set<string>();
  for (const edge of edges) {
    toolIds.add(edge.from);
    toolIds.add(edge.to);
  }

  // Fetch schemas
  const placeholders = Array.from(toolIds).map((_, i) => `$${i + 1}`).join(", ");
  const schemas = await db.query(
    `SELECT tool_id, input_schema, output_schema FROM tool_schema WHERE tool_id IN (${placeholders})`,
    Array.from(toolIds),
  ) as unknown as ToolSchema[];

  const schemaMap = new Map(schemas.map((s) => [s.tool_id, s]));

  // Enrich edges with full data
  return edges.map((edge) => {
    const provider = schemaMap.get(edge.from);
    const consumer = schemaMap.get(edge.to);

    const providerOutput = provider?.output_schema || {};
    const consumerInput = consumer?.input_schema || {};

    return {
      ...edge,
      providerOutputSchema: providerOutput,
      consumerInputSchema: consumerInput,
      fieldMapping: createFieldMapping(providerOutput, consumerInput),
    };
  });
}

/**
 * Find direct provides edge between two tools (O(1) query)
 *
 * @param db - PGlite database client
 * @param sourceToolId - Starting tool
 * @param targetToolId - Ending tool
 * @returns Direct provides edge if exists, or null
 */
export async function findDirectProvidesEdge(
  db: PGliteClient,
  sourceToolId: string,
  targetToolId: string,
): Promise<ProvidesEdge | null> {
  const rows = await db.query(
    `SELECT from_tool_id, to_tool_id, confidence_score
     FROM tool_dependency
     WHERE edge_type = 'provides' AND from_tool_id = $1 AND to_tool_id = $2`,
    [sourceToolId, targetToolId],
  ) as unknown as StoredProvidesEdge[];

  if (rows.length === 0) return null;

  const row = rows[0];

  // Fetch schemas for full edge data
  const schemas = await db.query(
    `SELECT tool_id, input_schema, output_schema FROM tool_schema WHERE tool_id IN ($1, $2)`,
    [sourceToolId, targetToolId],
  ) as unknown as ToolSchema[];

  const schemaMap = new Map(schemas.map((s) => [s.tool_id, s]));
  const provider = schemaMap.get(sourceToolId);
  const consumer = schemaMap.get(targetToolId);

  const providerOutput = provider?.output_schema || {};
  const consumerInput = consumer?.input_schema || {};

  return {
    from: row.from_tool_id,
    to: row.to_tool_id,
    type: "provides",
    coverage: confidenceToCoverage(row.confidence_score),
    providerOutputSchema: providerOutput,
    consumerInputSchema: consumerInput,
    fieldMapping: createFieldMapping(providerOutput, consumerInput),
    weight: EDGE_TYPE_WEIGHTS.provides,
  };
}
