/**
 * REST API Routes Module
 *
 * HTTP REST endpoints for the PML platform.
 * These routes are served by the MCP HTTP server.
 *
 * @module api
 */

export { handleGraphRoutes } from "./graph.ts";
export { handleCapabilitiesRoutes } from "./capabilities.ts";
export { handleMetricsRoutes, handlePrometheusMetrics } from "./metrics.ts";
export { handleEmergenceRoutes } from "./emergence.ts";
export { handleToolsRoutes } from "./tools.ts";
export { handleHealthRoutes } from "./health.ts";
export { handleTracesRoutes } from "./traces.ts";

// Algorithm API (core logic, called by Fresh thin wrappers)
export {
  getAlgorithmMetrics,
  getAlphaStats,
  getRecentTraces,
  isValidMode,
  isValidUserAction,
  isValidUUID,
  recordFeedback,
  type AlphaStatsResult,
  type FeedbackRequest,
  type FeedbackResult,
  type MetricsResult,
  type TracesResult,
} from "./algorithm.ts";
