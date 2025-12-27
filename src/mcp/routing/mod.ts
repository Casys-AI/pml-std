/**
 * Routing Module
 *
 * Central routing system for the MCP Gateway HTTP server.
 * Consolidates all routing logic per tech-spec-large-files-refactoring.md Phase 1.
 *
 * @module mcp/routing
 */

// Router
export { logRoutes, routeRequest } from "./router.ts";

// Dispatcher (for custom route registration)
export { RequestDispatcher, type RouteDefinition } from "./dispatcher.ts";

// Middleware utilities
export {
  buildCorsHeaders,
  getAllowedOrigin,
  handleCorsPrelight,
  isPublicRoute,
  rateLimitResponse,
  unauthorizedResponse,
} from "./middleware.ts";

// Types and response helpers
export type { RouteContext, RouteHandler } from "./types.ts";
export { errorResponse, jsonResponse } from "./types.ts";

// Re-export handlers for direct access if needed
export {
  handleCapabilitiesRoutes,
  handleGraphRoutes,
  handleHealthRoutes,
  handleMetricsRoutes,
  handleToolsRoutes,
} from "./handlers/mod.ts";
