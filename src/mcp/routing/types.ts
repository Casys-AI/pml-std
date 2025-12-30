/**
 * Routing Types
 *
 * Types for the routing system.
 *
 * @module mcp/routing/types
 */

import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import type { VectorSearch } from "../../vector/search.ts";
import type { DAGSuggester } from "../../graphrag/dag-suggester.ts";
import type { CapabilityStore } from "../../capabilities/capability-store.ts";
import type { CapabilityDataService } from "../../capabilities/mod.ts";
import type { EventsStreamManager } from "../../server/events-stream.ts";
import type { HealthChecker } from "../../health/health-checker.ts";
import type { MCPClientBase } from "../types.ts";
import type { DbClient } from "../../db/types.ts";

/**
 * Context passed to all route handlers
 */
export interface RouteContext {
  graphEngine: GraphRAGEngine;
  vectorSearch: VectorSearch;
  dagSuggester: DAGSuggester;
  capabilityStore?: CapabilityStore;
  capabilityDataService?: CapabilityDataService;
  eventsStream: EventsStreamManager | null;
  healthChecker?: HealthChecker;
  mcpClients: Map<string, MCPClientBase>;
  userId?: string;
  /** Path parameters extracted from URL */
  params?: Record<string, string>;
  /** Database client for scope filtering (Story 9.8) */
  db?: DbClient;
}

/**
 * Route handler function signature
 */
export type RouteHandler = (
  req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
) => Response | Promise<Response | null>;

/**
 * JSON response helper
 */
export function jsonResponse(
  data: unknown,
  status: number = 200,
  corsHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

/**
 * Error response helper
 */
export function errorResponse(
  message: string,
  status: number = 500,
  corsHeaders: Record<string, string> = {},
): Response {
  return jsonResponse({ error: message }, status, corsHeaders);
}
