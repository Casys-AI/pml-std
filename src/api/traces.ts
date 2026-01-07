/**
 * Traces API Handler
 *
 * Story 14.5b: REST endpoint for receiving execution traces from packages/pml clients.
 *
 * Receives batch traces from TraceSyncer and stores them via ExecutionTraceStore.
 * Learning happens automatically via existing TD-Error + PER infrastructure (Story 11.3).
 *
 * @module api/traces
 */

import type { RouteContext } from "../mcp/routing/types.ts";
import { errorResponse, jsonResponse } from "../mcp/routing/types.ts";
import { ExecutionTraceStore } from "../capabilities/execution-trace-store.ts";
import type { SaveTraceInput } from "../capabilities/execution-trace-store.ts";
import type { BranchDecision, JsonValue, TraceTaskResult } from "../capabilities/types.ts";
import { CapabilityRegistry } from "../capabilities/capability-registry.ts";
import { isValidFQDN, parseFQDN } from "../capabilities/fqdn.ts";
import type { DbClient } from "../db/types.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * UUID v4 regex pattern for validation.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Check if a string is a valid UUID.
 */
function isUUID(str: string): boolean {
  return UUID_REGEX.test(str);
}

/**
 * Resolve a capability identifier (FQDN or UUID) to workflowPatternId.
 *
 * The client sends capabilityId as FQDN (e.g., "local.default.fs.read_file.a7f3").
 * We need to resolve this to the workflow_pattern.pattern_id (UUID) for FK storage.
 *
 * Resolution order:
 * 1. If already a UUID → return as-is
 * 2. If valid FQDN (5 parts) → lookup by components
 * 3. Otherwise → return null (standalone trace)
 *
 * @param capabilityId - FQDN or UUID from client
 * @param db - Database client
 * @returns workflowPatternId (UUID) or null if not found
 */
async function resolveCapabilityId(
  capabilityId: string,
  db: DbClient,
): Promise<string | null> {
  // 1. If it's already a UUID, return as-is
  if (isUUID(capabilityId)) {
    return capabilityId;
  }

  // 2. If it's a valid FQDN (5 parts), lookup by components
  if (isValidFQDN(capabilityId)) {
    try {
      const { org, project, namespace, action, hash } = parseFQDN(capabilityId);
      const registry = new CapabilityRegistry(db);
      const record = await registry.getByFqdnComponents(org, project, namespace, action, hash);

      if (record?.workflowPatternId) {
        logger.debug("Resolved FQDN to workflowPatternId", {
          fqdn: capabilityId,
          workflowPatternId: record.workflowPatternId,
        });
        return record.workflowPatternId;
      }
    } catch (error) {
      logger.warn("Failed to resolve FQDN", {
        fqdn: capabilityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 3. Not found or invalid format → standalone trace
  logger.debug("Capability not resolved, storing as standalone trace", {
    capabilityId,
  });
  return null;
}

/**
 * Trace received from packages/pml client (LocalExecutionTrace format).
 *
 * Field names match packages/pml/src/tracing/types.ts for JSON compatibility.
 */
interface IncomingTrace {
  capabilityId: string;
  success: boolean;
  error?: string;
  durationMs: number;
  taskResults: Array<{
    taskId: string;
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
    success: boolean;
    durationMs: number;
    timestamp: string;
  }>;
  decisions: Array<{
    nodeId: string;
    outcome: string;
    condition?: string;
  }>;
  timestamp: string;
  userId?: string;
}

/**
 * Request body for POST /api/traces
 */
interface TracesRequest {
  traces: IncomingTrace[];
}

/**
 * Response from POST /api/traces
 */
interface TracesResponse {
  received: number;
  stored: number;
  errors?: string[];
}

/**
 * Map incoming trace to SaveTraceInput format.
 *
 * Handles the field name mapping from packages/pml format to server format.
 *
 * @param incoming - Trace from client
 * @param resolvedCapabilityId - Resolved workflowPatternId (UUID) or null for standalone
 * @param userId - User ID from context
 */
function mapIncomingToSaveInput(
  incoming: IncomingTrace,
  resolvedCapabilityId: string | null,
  userId?: string,
): SaveTraceInput {
  // Map task results (align field names)
  const taskResults: TraceTaskResult[] = incoming.taskResults.map((tr) => ({
    taskId: tr.taskId,
    tool: tr.tool,
    args: tr.args as Record<string, JsonValue>,
    result: tr.result as JsonValue,
    success: tr.success,
    durationMs: tr.durationMs,
  }));

  // Map decisions (already aligned)
  const decisions: BranchDecision[] = incoming.decisions.map((d) => ({
    nodeId: d.nodeId,
    outcome: d.outcome,
    condition: d.condition,
  }));

  // Parse timestamp to Date, fallback to now
  let executedAt: Date;
  try {
    executedAt = incoming.timestamp ? new Date(incoming.timestamp) : new Date();
  } catch {
    executedAt = new Date();
  }

  return {
    // Use resolved UUID, or undefined for standalone traces
    capabilityId: resolvedCapabilityId ?? undefined,
    success: incoming.success,
    errorMessage: incoming.error,
    durationMs: incoming.durationMs,
    taskResults,
    decisions,
    priority: 0.5, // Default priority - TD-Error will update later
    userId: userId ?? incoming.userId ?? "pml-client",
    createdBy: "pml-client",
    executedAt,
  };
}

/**
 * POST /api/traces
 *
 * Receives batch of execution traces from packages/pml clients.
 *
 * Request body:
 * ```json
 * {
 *   "traces": [
 *     {
 *       "capabilityId": "casys.tools.example:run",
 *       "success": true,
 *       "durationMs": 500,
 *       "taskResults": [...],
 *       "decisions": [],
 *       "timestamp": "2024-01-01T00:00:00Z"
 *     }
 *   ]
 * }
 * ```
 *
 * Response:
 * ```json
 * {
 *   "received": 5,
 *   "stored": 5,
 *   "errors": []
 * }
 * ```
 */
export async function handleTracesPost(
  req: Request,
  _url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  // Require database access
  if (!ctx.db) {
    logger.error("Database client not available in route context");
    return errorResponse("Database unavailable", 503, corsHeaders);
  }

  // Parse request body
  let body: TracesRequest;
  try {
    body = await req.json() as TracesRequest;
  } catch (error) {
    logger.warn("Invalid JSON in traces request", { error });
    return errorResponse("Invalid JSON body", 400, corsHeaders);
  }

  // Validate request
  if (!body.traces || !Array.isArray(body.traces)) {
    return errorResponse("Missing or invalid 'traces' array", 400, corsHeaders);
  }

  if (body.traces.length === 0) {
    return jsonResponse({
      received: 0,
      stored: 0,
    } as TracesResponse, 200, corsHeaders);
  }

  // Rate limit: max 100 traces per request
  if (body.traces.length > 100) {
    return errorResponse("Too many traces (max 100 per request)", 400, corsHeaders);
  }

  // Create trace store
  const traceStore = new ExecutionTraceStore(ctx.db);

  // Process traces
  let stored = 0;
  const errors: string[] = [];

  for (const incoming of body.traces) {
    try {
      // Validate required fields
      if (!incoming.capabilityId || typeof incoming.success !== "boolean") {
        errors.push(`Invalid trace: missing capabilityId or success`);
        continue;
      }

      // Resolve FQDN → workflowPatternId (UUID)
      // Client sends FQDN like "local.default.fs.read_file.a7f3"
      // Server stores trace with FK to workflow_pattern.pattern_id
      const resolvedCapabilityId = await resolveCapabilityId(incoming.capabilityId, ctx.db);

      // Map to server format with resolved UUID
      const saveInput = mapIncomingToSaveInput(incoming, resolvedCapabilityId, ctx.userId);

      // Save trace (triggers existing TD-Error + PER via eventBus)
      await traceStore.saveTrace(saveInput);
      stored++;

      if (resolvedCapabilityId) {
        logger.debug("Trace saved with capability link", {
          fqdn: incoming.capabilityId,
          workflowPatternId: resolvedCapabilityId,
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to save trace", { capabilityId: incoming.capabilityId, error: msg });
      errors.push(`Failed to save trace ${incoming.capabilityId}: ${msg}`);
    }
  }

  logger.info("Traces batch processed", {
    received: body.traces.length,
    stored,
    errors: errors.length,
  });

  const response: TracesResponse = {
    received: body.traces.length,
    stored,
  };

  if (errors.length > 0) {
    response.errors = errors;
  }

  return jsonResponse(response, 200, corsHeaders);
}

/**
 * Route traces-related requests.
 */
export function handleTracesRoutes(
  req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response> | null {
  if (url.pathname === "/api/traces" && req.method === "POST") {
    return handleTracesPost(req, url, ctx, corsHeaders);
  }

  return null;
}
