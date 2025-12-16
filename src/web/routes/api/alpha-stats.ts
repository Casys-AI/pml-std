/**
 * Alpha Statistics Route Handler (ADR-048)
 *
 * GET /api/alpha-stats
 *
 * Returns statistics about local adaptive alpha usage for observability
 * and algorithm tuning. Part of the algorithm tracing system (Story 7.6).
 *
 * @module web/routes/api/alpha-stats
 */

import type { Context } from "fresh";
import { getDb } from "../../../db/client.ts";
import { AlgorithmTracer } from "../../../telemetry/algorithm-tracer.ts";
import type { AuthState } from "../_middleware.ts";

export const handler = {
  /**
   * Get alpha statistics
   *
   * Query params:
   * - windowHours: number (default: 24, max: 168)
   *
   * Response (200):
   * ```json
   * {
   *   "success": true,
   *   "windowHours": 24,
   *   "stats": {
   *     "avgAlphaByMode": {
   *       "activeSearch": 0.75,
   *       "passiveSuggestion": 0.82
   *     },
   *     "alphaDistribution": {
   *       "bucket05_06": 15,
   *       "bucket06_07": 25,
   *       "bucket07_08": 30,
   *       "bucket08_09": 20,
   *       "bucket09_10": 10
   *     },
   *     "algorithmDistribution": {
   *       "embeddingsHybrides": 40,
   *       "heatDiffusion": 35,
   *       "heatHierarchical": 10,
   *       "bayesian": 15,
   *       "none": 0
   *     },
   *     "coldStartStats": {
   *       "total": 15,
   *       "percentage": 15.0
   *     },
   *     "alphaImpact": {
   *       "lowAlphaAvgScore": 0.72,
   *       "highAlphaAvgScore": 0.58
   *     }
   *   }
   * }
   * ```
   *
   * Protection: In cloud mode, requires authenticated user
   */
  async GET(ctx: Context<AuthState>) {
    const { user, isCloudMode } = ctx.state;

    // Protected in cloud mode (metrics are sensitive data)
    if (isCloudMode && (!user || user.id === "local")) {
      return new Response(
        JSON.stringify({ error: "Authentication required in cloud mode" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    try {
      const url = new URL(ctx.req.url);
      const windowHoursParam = url.searchParams.get("windowHours");

      const windowHours = windowHoursParam ? parseInt(windowHoursParam, 10) : 24;

      // Validate windowHours
      if (isNaN(windowHours) || windowHours < 1 || windowHours > 168) {
        return new Response(
          JSON.stringify({ error: "windowHours must be between 1 and 168" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const db = await getDb();
      const tracer = new AlgorithmTracer(db);

      const stats = await tracer.getAlphaStats(windowHours);

      return new Response(
        JSON.stringify({
          success: true,
          windowHours,
          stats,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error getting alpha stats:", error);
      return new Response(
        JSON.stringify({ error: "Failed to get alpha statistics" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};
