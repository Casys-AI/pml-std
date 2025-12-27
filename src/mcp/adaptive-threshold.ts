/**
 * Adaptive Threshold Learning Manager
 *
 * Learns optimal confidence thresholds based on execution feedback.
 * Adjusts thresholds dynamically to minimize false positives and false negatives.
 *
 * Extended in Epic 4 Phase 1 (Story 4.1c) with PGlite persistence:
 * - Thresholds survive server restarts
 * - Context-based threshold lookup (per ADR-008)
 *
 * Extended in Story 10.7c with Thompson Sampling integration (ADR-049):
 * - Per-tool Bayesian thresholds via ThompsonSampler
 * - Risk-based thresholds from mcp-permissions.yaml scope
 * - Mode-specific thresholds (active_search, passive_suggestion)
 *
 * @module mcp/adaptive-threshold
 */

import * as log from "@std/log";
import type { ExecutionRecord, SpeculativeMetrics } from "../graphrag/types.ts";
import type { DbClient } from "../db/types.ts";
import type { StoredThreshold, ThresholdContext } from "../learning/types.ts";
import {
  type RiskCategory,
  type ThompsonConfig,
  ThompsonSampler,
  type ThresholdMode,
  type ThresholdResult,
} from "../graphrag/algorithms/thompson.ts";
import {
  getToolPermissionConfig,
  type PermissionConfig,
} from "../capabilities/permission-inferrer.ts";

/**
 * Adaptive threshold configuration
 */
export interface AdaptiveConfig {
  initialExplicitThreshold: number;
  initialSuggestionThreshold: number;
  learningRate: number;
  minThreshold: number;
  maxThreshold: number;
  windowSize: number; // Number of recent executions to consider
  /** Thompson Sampling configuration (Story 10.7c) */
  thompsonConfig?: Partial<ThompsonConfig>;
}

// Re-export Thompson types for external consumers
export type {
  RiskCategory,
  ThresholdMode,
  ThresholdResult,
} from "../graphrag/algorithms/thompson.ts";

/**
 * Threshold adjustment result
 */
interface ThresholdAdjustment {
  explicitThreshold?: number;
  suggestionThreshold?: number;
  reason: string;
}

/**
 * Adaptive Threshold Manager
 *
 * Uses sliding window of recent executions to adjust thresholds dynamically.
 * Increases thresholds if too many false positives (failed speculative executions).
 * Decreases thresholds if too many false negatives (successful manual confirmations).
 *
 * Epic 4 Phase 1: Added PGlite persistence for thresholds.
 * Story 10.7c: Added Thompson Sampling for per-tool Bayesian thresholds.
 */
export class AdaptiveThresholdManager {
  private config: AdaptiveConfig;
  private executionHistory: ExecutionRecord[] = [];
  private currentThresholds: {
    explicitThreshold?: number;
    suggestionThreshold?: number;
  } = {};

  // Epic 4 Phase 1: Persistence layer
  private db: DbClient | null = null;
  private thresholdCache: Map<string, StoredThreshold> = new Map();
  private currentContextHash: string = "default";

  // Story 10.7c: Thompson Sampling integration
  private thompsonSampler: ThompsonSampler;

  constructor(config?: Partial<AdaptiveConfig>, db?: DbClient) {
    this.config = {
      initialExplicitThreshold: 0.50,
      initialSuggestionThreshold: 0.70,
      learningRate: 0.05,
      minThreshold: 0.40,
      maxThreshold: 0.90,
      windowSize: 50,
      ...config,
    };
    this.db = db ?? null;

    // Story 10.7c: Initialize Thompson Sampler
    this.thompsonSampler = new ThompsonSampler(config?.thompsonConfig);
  }

  /**
   * Set database client for persistence (can be set after construction)
   */
  setDatabase(db: DbClient): void {
    this.db = db;
  }

  /**
   * Load thresholds from database for a specific context
   *
   * @param context - Context for threshold lookup
   * @returns Loaded thresholds or null if not found
   */
  async loadThresholds(context?: ThresholdContext): Promise<StoredThreshold | null> {
    if (!this.db) return null;

    const contextHash = this.hashContext(context || {});
    this.currentContextHash = contextHash;

    // Check cache first
    if (this.thresholdCache.has(contextHash)) {
      const cached = this.thresholdCache.get(contextHash)!;
      this.currentThresholds = {
        suggestionThreshold: cached.suggestionThreshold,
        explicitThreshold: cached.explicitThreshold,
      };
      return cached;
    }

    try {
      const rows = await this.db.query(
        `SELECT context_hash, context_keys, suggestion_threshold, explicit_threshold,
                success_rate, sample_count, created_at, updated_at
         FROM adaptive_thresholds
         WHERE context_hash = $1`,
        [contextHash],
      );

      if (rows.length > 0) {
        const stored = this.deserializeThreshold(rows[0]);
        this.thresholdCache.set(contextHash, stored);
        this.currentThresholds = {
          suggestionThreshold: stored.suggestionThreshold,
          explicitThreshold: stored.explicitThreshold,
        };
        log.info(
          `[AdaptiveThreshold] Loaded thresholds for context ${contextHash}: suggestion=${
            stored.suggestionThreshold.toFixed(2)
          }, explicit=${stored.explicitThreshold.toFixed(2)}`,
        );
        return stored;
      }
    } catch (error) {
      log.error(`[AdaptiveThreshold] Failed to load thresholds: ${error}`);
    }

    return null;
  }

  /**
   * Save current thresholds to database
   *
   * @param context - Context for threshold storage
   */
  async saveThresholds(context?: ThresholdContext): Promise<void> {
    if (!this.db) return;

    const contextHash = context ? this.hashContext(context) : this.currentContextHash;
    const contextKeys = context || {};
    const thresholds = this.getThresholds();

    // Calculate success rate from recent history
    const speculativeExecs = this.executionHistory.filter((e) => e.mode === "speculative");
    const successRate = speculativeExecs.length > 0
      ? speculativeExecs.filter((e) => e.success).length / speculativeExecs.length
      : null;

    try {
      // Use query instead of exec for parameterized inserts (PGlite limitation)
      await this.db.query(
        `INSERT INTO adaptive_thresholds
           (context_hash, context_keys, suggestion_threshold, explicit_threshold, success_rate, sample_count, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6, NOW())
         ON CONFLICT (context_hash) DO UPDATE SET
           suggestion_threshold = $3,
           explicit_threshold = $4,
           success_rate = $5,
           sample_count = adaptive_thresholds.sample_count + $6,
           updated_at = NOW()`,
        [
          contextHash,
          contextKeys, // postgres.js/pglite auto-serializes to JSONB
          thresholds.suggestionThreshold,
          thresholds.explicitThreshold,
          successRate,
          this.executionHistory.length,
        ],
      );

      // Update cache
      const stored: StoredThreshold = {
        contextHash,
        contextKeys,
        suggestionThreshold: thresholds.suggestionThreshold!,
        explicitThreshold: thresholds.explicitThreshold!,
        successRate,
        sampleCount: this.executionHistory.length,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.thresholdCache.set(contextHash, stored);

      log.debug(`[AdaptiveThreshold] Saved thresholds for context ${contextHash}`);
    } catch (error) {
      log.error(`[AdaptiveThreshold] Failed to save thresholds: ${error}`);
    }
  }

  /**
   * Get all stored thresholds (for monitoring/debugging)
   */
  async getAllStoredThresholds(): Promise<StoredThreshold[]> {
    if (!this.db) return [];

    try {
      const rows = await this.db.query(
        `SELECT context_hash, context_keys, suggestion_threshold, explicit_threshold,
                success_rate, sample_count, created_at, updated_at
         FROM adaptive_thresholds
         ORDER BY updated_at DESC`,
      );

      return rows.map((row) => this.deserializeThreshold(row));
    } catch (error) {
      log.error(`[AdaptiveThreshold] Failed to get all thresholds: ${error}`);
      return [];
    }
  }

  /**
   * Hash context for database lookup (matches EpisodicMemoryStore format)
   */
  private hashContext(context: ThresholdContext): string {
    const keys = ["workflowType", "domain", "complexity"];
    return keys
      .map((k) => `${k}:${context[k] ?? "default"}`)
      .join("|");
  }

  /**
   * Deserialize database row to StoredThreshold
   */
  private deserializeThreshold(row: Record<string, unknown>): StoredThreshold {
    return {
      contextHash: row.context_hash as string,
      contextKeys: typeof row.context_keys === "string"
        ? JSON.parse(row.context_keys)
        : row.context_keys as Record<string, unknown>,
      suggestionThreshold: Number(row.suggestion_threshold),
      explicitThreshold: Number(row.explicit_threshold),
      successRate: row.success_rate !== null ? Number(row.success_rate) : null,
      sampleCount: Number(row.sample_count),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /**
   * Record execution result for adaptive learning
   *
   * Story 10.7c: Also updates Thompson Sampler if toolId is provided.
   *
   * @param record - Execution record with confidence, mode, and outcome
   */
  recordExecution(record: ExecutionRecord): void {
    this.executionHistory.push(record);

    // Story 10.7c: Update Thompson Sampler if toolId provided
    if (record.toolId) {
      this.thompsonSampler.recordOutcome(record.toolId, record.success);
    }

    // Keep only recent executions (sliding window)
    if (this.executionHistory.length > this.config.windowSize) {
      this.executionHistory.shift();
    }

    // Adjust thresholds every 10 executions
    if (this.executionHistory.length % 10 === 0 && this.executionHistory.length >= 20) {
      this.adjustThresholds();
    }
  }

  /**
   * Adjust thresholds based on execution history
   *
   * Strategy:
   * - False positive (FP): Speculative execution failed → Increase threshold
   * - False negative (FN): Manual confirmation succeeded with high confidence → Decrease threshold
   * - True positive (TP): Speculative execution succeeded → Maintain threshold
   * - True negative (TN): Low confidence correctly required manual input → Maintain threshold
   */
  private adjustThresholds(): void {
    const recentExecutions = this.executionHistory.slice(-20);
    if (recentExecutions.length < 20) return;

    // Calculate metrics
    const speculativeExecs = recentExecutions.filter((e) => e.mode === "speculative");
    const suggestionExecs = recentExecutions.filter((e) => e.mode === "suggestion");

    // False positives: Speculative executions that failed
    const falsePositives = speculativeExecs.filter((e) => !e.success).length;
    const falsePositiveRate = speculativeExecs.length > 0
      ? falsePositives / speculativeExecs.length
      : 0;

    // False negatives: Suggestions with high confidence that user accepted
    const falseNegatives = suggestionExecs.filter(
      (e) => e.userAccepted && e.confidence >= (this.config.initialSuggestionThreshold - 0.1),
    ).length;
    const falseNegativeRate = suggestionExecs.length > 0
      ? falseNegatives / suggestionExecs.length
      : 0;

    // Adjustment logic
    const adjustment: ThresholdAdjustment = { reason: "" };

    if (falsePositiveRate > 0.2) {
      // Too many failed speculative executions → Increase threshold
      const increase = this.config.learningRate * falsePositiveRate;
      const newThreshold = Math.min(
        (this.currentThresholds.suggestionThreshold ?? this.config.initialSuggestionThreshold) +
          increase,
        this.config.maxThreshold,
      );

      adjustment.suggestionThreshold = newThreshold;
      adjustment.reason = `High false positive rate (${
        (falsePositiveRate * 100).toFixed(0)
      }%) → Increased threshold to ${newThreshold.toFixed(2)}`;
    } else if (falseNegativeRate > 0.3) {
      // Too many unnecessary manual confirmations → Decrease threshold
      const decrease = this.config.learningRate * falseNegativeRate;
      const newThreshold = Math.max(
        (this.currentThresholds.suggestionThreshold ?? this.config.initialSuggestionThreshold) -
          decrease,
        this.config.minThreshold,
      );

      adjustment.suggestionThreshold = newThreshold;
      adjustment.reason = `High false negative rate (${
        (falseNegativeRate * 100).toFixed(0)
      }%) → Decreased threshold to ${newThreshold.toFixed(2)}`;
    }

    // Apply adjustment
    if (adjustment.suggestionThreshold) {
      this.currentThresholds.suggestionThreshold = adjustment.suggestionThreshold;
      log.info(`Adaptive threshold adjustment: ${adjustment.reason}`);

      // Epic 4 Phase 1: Persist adjustment to database
      this.saveThresholds().catch((err) =>
        log.error(`[AdaptiveThreshold] Failed to persist adjustment: ${err}`)
      );
    }
  }

  /**
   * Get current thresholds (adaptive or default)
   *
   * @returns Current thresholds
   */
  getThresholds(): { explicitThreshold?: number; suggestionThreshold?: number } {
    return {
      explicitThreshold: this.currentThresholds.explicitThreshold ??
        this.config.initialExplicitThreshold,
      suggestionThreshold: this.currentThresholds.suggestionThreshold ??
        this.config.initialSuggestionThreshold,
    };
  }

  /**
   * Get speculative execution metrics
   *
   * @returns Metrics for monitoring and debugging
   */
  getMetrics(): SpeculativeMetrics {
    const speculativeExecs = this.executionHistory.filter((e) => e.mode === "speculative");

    const successfulExecutions = speculativeExecs.filter((e) => e.success).length;
    const failedExecutions = speculativeExecs.filter((e) => !e.success).length;

    const avgExecutionTime = speculativeExecs.length > 0
      ? speculativeExecs.reduce((sum, e) => sum + (e.executionTime || 0), 0) /
        speculativeExecs.length
      : 0;

    const avgConfidence = speculativeExecs.length > 0
      ? speculativeExecs.reduce((sum, e) => sum + e.confidence, 0) / speculativeExecs.length
      : 0;

    // Wasted compute: Failed executions
    const wastedComputeCost = failedExecutions * avgExecutionTime;

    // Saved latency: Successful speculative executions (no user wait time)
    const savedLatency = successfulExecutions * 2000; // Assume 2s saved per speculative execution

    return {
      totalSpeculativeAttempts: speculativeExecs.length,
      successfulExecutions,
      failedExecutions,
      avgExecutionTime,
      avgConfidence,
      wastedComputeCost,
      savedLatency,
    };
  }

  /**
   * Reset adaptive learning (for testing)
   */
  reset(): void {
    this.executionHistory = [];
    this.currentThresholds = {};
    this.thompsonSampler.reset();
  }

  // ===========================================================================
  // Story 10.7c: Thompson Sampling Integration (AC #1, #3, #4)
  // ===========================================================================

  /**
   * Get per-tool threshold using Thompson Sampling (Story 10.7c AC1)
   *
   * Delegates to ThompsonSampler for Bayesian per-tool thresholds.
   * Falls back to risk-based base threshold if tool is unknown.
   *
   * @param toolId - Full tool ID (e.g., "github:create_issue" or "filesystem:read_file")
   * @param mode - Threshold mode (active_search, passive_suggestion, speculation)
   * @param localAlpha - Optional local alpha from ADR-048 (0.5-1.0)
   * @returns Threshold result with breakdown
   */
  getThresholdForTool(
    toolId: string,
    mode: ThresholdMode = "passive_suggestion",
    localAlpha: number = 0.75,
  ): ThresholdResult {
    const riskCategory = this.getToolRiskCategory(toolId);
    return this.thompsonSampler.getThreshold(toolId, riskCategory, mode, localAlpha);
  }

  /**
   * Get risk category for a tool based on mcp-permissions.yaml scope (Story 10.7c AC2)
   *
   * Maps scope → RiskCategory:
   * - minimal, readonly → safe (threshold 0.55)
   * - filesystem, network-api → moderate (threshold 0.70)
   * - mcp-standard → dangerous (threshold 0.85)
   *
   * Tools with approvalMode: hil bypass Thompson entirely.
   *
   * @param toolId - Full tool ID (e.g., "github:create_issue")
   * @returns Risk category for threshold calculation
   */
  getToolRiskCategory(toolId: string): RiskCategory {
    // Extract server prefix (e.g., "github" from "github:create_issue")
    const serverPrefix = toolId.split(":")[0];
    const permConfig = getToolPermissionConfig(serverPrefix);

    if (!permConfig) {
      // Unknown tool → conservative moderate (requires context for decision)
      log.debug(`[Thompson] Unknown tool ${toolId} - using moderate risk`);
      return "moderate";
    }

    // Map scope → risk category
    return getRiskFromScope(permConfig);
  }

  /**
   * Check if a tool requires HIL (bypasses Thompson)
   *
   * Tools with approvalMode: hil or unknown tools bypass Thompson
   * and go directly to human-in-the-loop approval.
   *
   * @param toolId - Full tool ID
   * @returns true if tool should bypass Thompson for HIL
   */
  requiresHIL(toolId: string): boolean {
    const serverPrefix = toolId.split(":")[0];
    const permConfig = getToolPermissionConfig(serverPrefix);

    // Unknown tool → HIL required
    if (!permConfig) {
      log.debug(`[Thompson] Unknown tool ${toolId} - HIL required`);
      return true;
    }

    // Explicit HIL mode → HIL required
    if (permConfig.approvalMode === "hil") {
      log.debug(`[Thompson] Tool ${toolId} has approvalMode:hil - HIL required`);
      return true;
    }

    return false;
  }

  /**
   * Record execution outcome for Thompson learning (Story 10.7c AC1)
   *
   * Updates Beta(α, β) distribution for the tool based on success/failure.
   * Called after each tool execution completes.
   *
   * @param toolId - Full tool ID
   * @param success - Whether the execution succeeded
   */
  recordToolOutcome(toolId: string, success: boolean): void {
    this.thompsonSampler.recordOutcome(toolId, success);
    log.debug(`[Thompson] Recorded outcome for ${toolId}: ${success ? "success" : "failure"}`);
  }

  /**
   * Get Thompson Sampler instance (for advanced usage/testing)
   */
  getThompsonSampler(): ThompsonSampler {
    return this.thompsonSampler;
  }

  /**
   * Get Thompson statistics for a tool
   *
   * @param toolId - Full tool ID
   * @returns Mean success rate, variance, confidence interval
   */
  getToolStats(toolId: string): {
    mean: number;
    variance: number;
    confidenceInterval: [number, number];
    ucbBonus: number;
  } {
    return {
      mean: this.thompsonSampler.getMean(toolId),
      variance: this.thompsonSampler.getVariance(toolId),
      confidenceInterval: this.thompsonSampler.getConfidenceInterval(toolId),
      ucbBonus: this.thompsonSampler.getUCBBonus(toolId),
    };
  }
}

// ===========================================================================
// Story 10.7c: Risk Classification from Scope (AC #2)
// ===========================================================================

/**
 * Map scope → RiskCategory (Story 10.7c AC2)
 *
 * Scope is defined in mcp-permissions.yaml:
 * - minimal: Pure computation, no I/O
 * - readonly: Read files only
 * - filesystem: Read + write files
 * - network-api: Network access
 * - mcp-standard: Full MCP capabilities
 *
 * Legacy format uses permissionSet + isReadOnly.
 *
 * @param config - Tool permission config from mcp-permissions.yaml
 * @returns Risk category for Thompson threshold
 */
export function getRiskFromScope(config: PermissionConfig): RiskCategory {
  const scope = config.scope;

  switch (scope) {
    case "minimal":
    case "readonly":
      return "safe"; // threshold ~0.55

    case "filesystem":
    case "network-api":
      return "moderate"; // threshold ~0.70

    case "mcp-standard":
      return "dangerous"; // threshold ~0.85

    default:
      // Unknown scope → conservative moderate
      return "moderate";
  }
}

// Risk priority for max() calculation
const RISK_PRIORITY: Record<RiskCategory, number> = {
  safe: 0,
  moderate: 1,
  dangerous: 2,
};

/**
 * Calculate the aggregate risk category for a capability (Story 10.7c AC6b)
 *
 * Capabilities inherit the MAX risk of all their tools.
 * This ensures that a capability using any dangerous tool
 * is treated as dangerous for Thompson threshold calculation.
 *
 * @param toolsUsed - Array of tool IDs used by the capability
 * @returns Max risk category, or "safe" if no tools
 */
export function calculateCapabilityRisk(toolsUsed: string[]): RiskCategory {
  if (!toolsUsed || toolsUsed.length === 0) {
    return "safe";
  }

  let maxRisk: RiskCategory = "safe";
  let maxPriority = 0;

  for (const toolId of toolsUsed) {
    const serverPrefix = toolId.split(":")[0];
    const permConfig = getToolPermissionConfig(serverPrefix);

    // Unknown tool → treat as moderate (conservative but not blocking)
    const risk = permConfig ? getRiskFromScope(permConfig) : "moderate";
    const priority = RISK_PRIORITY[risk];

    if (priority > maxPriority) {
      maxPriority = priority;
      maxRisk = risk;

      // Short-circuit: dangerous is max, no need to continue
      if (maxRisk === "dangerous") break;
    }
  }

  log.debug(`[Thompson] Capability risk calculated: ${maxRisk}`, {
    toolsUsed,
    maxRisk,
  });

  return maxRisk;
}
