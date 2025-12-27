/**
 * Thompson Sampling for Intelligent Adaptive Thresholds
 *
 * POC implementation based on ADR-049.
 * Bayesian approach to per-tool threshold learning with exploration/exploitation.
 *
 * Key concepts:
 * - Beta distribution per tool: Beta(α, β) where α=successes+1, β=failures+1
 * - Sampling-based threshold: random sample from Beta for exploration
 * - UCB bonus: exploration bonus for under-observed tools
 * - Decay factor: handle non-stationary environments
 * - Risk categories: safe/moderate/dangerous base thresholds
 *
 * References:
 * - https://en.wikipedia.org/wiki/Thompson_sampling
 * - ADR-049: Intelligent Adaptive Thresholds
 *
 * @module graphrag/algorithms/thompson
 */

import { getLogger } from "../../telemetry/logger.ts";

const log = getLogger("default");

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for Thompson Sampling
 */
export interface ThompsonConfig {
  /** Prior alpha (successes + 1) for new tools */
  priorAlpha: number;
  /** Prior beta (failures + 1) for new tools */
  priorBeta: number;
  /** Decay factor for non-stationary environments (0.95-0.99) */
  decayFactor: number;
  /** UCB exploration coefficient */
  ucbCoefficient: number;
  /** Risk-based thresholds */
  riskThresholds: {
    safe: number;
    moderate: number;
    dangerous: number;
  };
  /** Bounds for final threshold */
  bounds: {
    min: number;
    max: number;
  };
}

/**
 * Default configuration based on ADR-049
 */
export const DEFAULT_THOMPSON_CONFIG: ThompsonConfig = {
  priorAlpha: 1,
  priorBeta: 1,
  decayFactor: 0.99,
  ucbCoefficient: 2,
  riskThresholds: {
    safe: 0.55,
    moderate: 0.70,
    dangerous: 0.85,
  },
  bounds: {
    min: 0.40,
    max: 0.95,
  },
};

/**
 * Beta distribution state for a tool
 */
export interface ToolThompsonState {
  toolId: string;
  /** Successes + prior */
  alpha: number;
  /** Failures + prior */
  beta: number;
  /** Total observations */
  totalObservations: number;
  /** Last update timestamp */
  lastUpdated: Date;
}

/**
 * Risk category for a tool
 */
export type RiskCategory = "safe" | "moderate" | "dangerous";

/**
 * Mode for threshold calculation (ADR-038 pattern)
 */
export type ThresholdMode = "active_search" | "passive_suggestion" | "speculation";

/**
 * Threshold calculation result with breakdown
 */
export interface ThresholdResult {
  /** Final threshold value */
  threshold: number;
  /** Breakdown of calculation */
  breakdown: ThresholdBreakdown;
}

/**
 * Detailed breakdown of threshold calculation
 */
export interface ThresholdBreakdown {
  /** Base threshold from risk category */
  baseThreshold: number;
  /** Thompson sampling adjustment */
  thompsonAdjustment: number;
  /** Sampled success rate */
  sampledRate: number;
  /** UCB exploration bonus (active search only) */
  ucbBonus: number;
  /** Mode-specific adjustment */
  modeAdjustment: number;
  /** Local alpha adjustment (if provided) */
  alphaAdjustment: number;
  /** Final clamped threshold */
  finalThreshold: number;
}

// ============================================================================
// Thompson Sampler Class
// ============================================================================

/**
 * Thompson Sampling-based threshold manager
 *
 * Per-tool Bayesian learning with exploration/exploitation balance.
 *
 * @example
 * ```typescript
 * const sampler = new ThompsonSampler();
 *
 * // Get threshold for a tool
 * const result = sampler.getThreshold("read_file", "safe", "passive_suggestion");
 * console.log(result.threshold); // 0.53
 *
 * // Update after execution
 * sampler.recordOutcome("read_file", true); // success
 * sampler.recordOutcome("delete_file", false); // failure
 * ```
 */
export class ThompsonSampler {
  private states: Map<string, ToolThompsonState> = new Map();
  private totalExecutions: number = 0;
  private config: ThompsonConfig;

  constructor(config: Partial<ThompsonConfig> = {}) {
    this.config = { ...DEFAULT_THOMPSON_CONFIG, ...config };
  }

  // ==========================================================================
  // Core API
  // ==========================================================================

  /**
   * Get execution threshold for a tool
   *
   * @param toolId - Tool identifier
   * @param riskCategory - Risk level (safe/moderate/dangerous)
   * @param mode - Threshold mode (active_search/passive_suggestion/speculation)
   * @param localAlpha - Optional local alpha from ADR-048 (0.5-1.0)
   * @returns Threshold result with breakdown
   */
  getThreshold(
    toolId: string,
    riskCategory: RiskCategory,
    mode: ThresholdMode,
    localAlpha: number = 0.75,
  ): ThresholdResult {
    const state = this.getOrCreateState(toolId);
    const baseThreshold = this.config.riskThresholds[riskCategory];

    // Sample from Beta distribution
    const sampledRate = this.sampleBeta(state.alpha, state.beta);

    // Thompson adjustment: high success rate → lower threshold
    const thompsonAdjustment = (0.75 - sampledRate) * 0.15;

    // UCB bonus for exploration (active search only)
    let ucbBonus = 0;
    if (mode === "active_search") {
      ucbBonus = this.getUCBBonus(state);
    }

    // Mode-specific adjustment
    const modeAdjustment = this.getModeAdjustment(mode);

    // Local alpha adjustment: high alpha → graph unreliable → higher threshold
    const alphaAdjustment = (localAlpha - 0.75) * 0.10;

    // Combine all factors
    let threshold: number;
    if (mode === "active_search") {
      // UCB bonus LOWERS threshold (more exploration)
      threshold = baseThreshold + modeAdjustment + thompsonAdjustment + alphaAdjustment -
        ucbBonus * 0.05;
    } else if (mode === "speculation") {
      // Use mean instead of sample for stability
      const mean = state.alpha / (state.alpha + state.beta);
      const meanAdjustment = (0.75 - mean) * 0.15;
      threshold = baseThreshold + modeAdjustment + meanAdjustment + alphaAdjustment;
    } else {
      // Passive suggestion: standard Thompson sampling
      threshold = baseThreshold + modeAdjustment + thompsonAdjustment + alphaAdjustment;
    }

    // Clamp to bounds
    const finalThreshold = Math.max(
      this.config.bounds.min,
      Math.min(this.config.bounds.max, threshold),
    );

    return {
      threshold: finalThreshold,
      breakdown: {
        baseThreshold,
        thompsonAdjustment,
        sampledRate,
        ucbBonus,
        modeAdjustment,
        alphaAdjustment,
        finalThreshold,
      },
    };
  }

  /**
   * Sample threshold for a tool (simplified API)
   */
  sampleThreshold(toolId: string): number {
    const state = this.getOrCreateState(toolId);
    const sample = this.sampleBeta(state.alpha, state.beta);
    // Convert sample to threshold: higher success rate = lower threshold
    return 0.5 + (1 - sample) * 0.4; // Range: 0.5 to 0.9
  }

  /**
   * Record execution outcome for learning
   *
   * @param toolId - Tool identifier
   * @param success - Whether execution succeeded
   */
  recordOutcome(toolId: string, success: boolean): void {
    const state = this.getOrCreateState(toolId);

    if (success) {
      state.alpha += 1;
    } else {
      state.beta += 1;
    }
    state.totalObservations += 1;
    state.lastUpdated = new Date();
    this.totalExecutions += 1;

    // Apply decay for non-stationary environments
    this.applyDecay(state);

    this.states.set(toolId, state);
  }

  /**
   * Batch sample thresholds for multiple tools
   */
  sampleBatch(toolIds: string[]): Map<string, number> {
    const thresholds = new Map<string, number>();
    for (const toolId of toolIds) {
      thresholds.set(toolId, this.sampleThreshold(toolId));
    }
    return thresholds;
  }

  /**
   * Get UCB exploration bonus for a tool
   *
   * High bonus for under-explored tools encourages exploration.
   */
  getUCBBonus(stateOrToolId: ToolThompsonState | string): number {
    const state = typeof stateOrToolId === "string"
      ? this.getOrCreateState(stateOrToolId)
      : stateOrToolId;

    if (state.totalObservations === 0) {
      return 1.0; // Maximum exploration for new tools
    }

    // UCB formula: sqrt(2 * ln(total) / n_i)
    const c = this.config.ucbCoefficient;
    const bonus = Math.sqrt(
      (c * Math.log(this.totalExecutions + 1)) / state.totalObservations,
    );
    return Math.min(bonus, 1.0);
  }

  // ==========================================================================
  // Statistics API
  // ==========================================================================

  /**
   * Get mean success rate for a tool
   */
  getMean(toolId: string): number {
    const state = this.getOrCreateState(toolId);
    return state.alpha / (state.alpha + state.beta);
  }

  /**
   * Get variance of success rate for a tool
   */
  getVariance(toolId: string): number {
    const state = this.getOrCreateState(toolId);
    const a = state.alpha;
    const b = state.beta;
    return (a * b) / ((a + b) ** 2 * (a + b + 1));
  }

  /**
   * Get 95% confidence interval for success rate
   */
  getConfidenceInterval(toolId: string): [number, number] {
    const mean = this.getMean(toolId);
    const variance = this.getVariance(toolId);
    const stdDev = Math.sqrt(variance);
    const z = 1.96; // 95% CI

    return [
      Math.max(0, mean - z * stdDev),
      Math.min(1, mean + z * stdDev),
    ];
  }

  /**
   * Get state for a tool (for inspection/debugging)
   */
  getState(toolId: string): ToolThompsonState | undefined {
    return this.states.get(toolId);
  }

  /**
   * Get all states
   */
  getAllStates(): Map<string, ToolThompsonState> {
    return new Map(this.states);
  }

  /**
   * Get total executions across all tools
   */
  getTotalExecutions(): number {
    return this.totalExecutions;
  }

  // ==========================================================================
  // Beta Distribution Sampling
  // ==========================================================================

  /**
   * Sample from Beta distribution using Joehnk's algorithm
   *
   * @param alpha - Alpha parameter (> 0)
   * @param beta - Beta parameter (> 0)
   * @returns Sample in [0, 1]
   */
  sampleBeta(alpha: number, beta: number): number {
    // Joehnk's algorithm for Beta sampling
    // Efficient for small alpha, beta
    if (alpha <= 1 && beta <= 1) {
      let u1: number, u2: number, x: number, y: number;

      do {
        u1 = Math.random();
        u2 = Math.random();
        x = Math.pow(u1, 1 / alpha);
        y = Math.pow(u2, 1 / beta);
      } while (x + y > 1);

      return x / (x + y);
    }

    // For larger parameters, use Gamma-based method
    const gammaA = this.sampleGamma(alpha);
    const gammaB = this.sampleGamma(beta);
    return gammaA / (gammaA + gammaB);
  }

  /**
   * Sample from Gamma distribution using Marsaglia-Tsang method
   */
  private sampleGamma(shape: number): number {
    if (shape < 1) {
      // Use Ahrens-Dieter method for shape < 1
      return this.sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
    }

    // Marsaglia-Tsang method for shape >= 1
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    while (true) {
      let x: number, v: number;

      do {
        x = this.gaussianRandom();
        v = 1 + c * x;
      } while (v <= 0);

      v = v * v * v;
      const u = Math.random();

      if (u < 1 - 0.0331 * (x * x) * (x * x)) {
        return d * v;
      }

      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v;
      }
    }
  }

  /**
   * Sample from standard normal distribution (Box-Muller)
   */
  private gaussianRandom(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  private getOrCreateState(toolId: string): ToolThompsonState {
    if (!this.states.has(toolId)) {
      this.states.set(toolId, {
        toolId,
        alpha: this.config.priorAlpha,
        beta: this.config.priorBeta,
        totalObservations: 0,
        lastUpdated: new Date(),
      });
    }
    return this.states.get(toolId)!;
  }

  private applyDecay(state: ToolThompsonState): void {
    // Keep minimum prior contribution
    state.alpha = Math.max(
      this.config.priorAlpha,
      state.alpha * this.config.decayFactor,
    );
    state.beta = Math.max(
      this.config.priorBeta,
      state.beta * this.config.decayFactor,
    );
  }

  private getModeAdjustment(mode: ThresholdMode): number {
    // From ADR-049 matrix
    switch (mode) {
      case "active_search":
        return -0.10; // More permissive
      case "passive_suggestion":
        return 0;
      case "speculation":
        return +0.05; // More conservative
    }
  }

  /**
   * Reset all states
   */
  reset(): void {
    this.states.clear();
    this.totalExecutions = 0;
  }

  /**
   * Reset a single tool
   */
  resetTool(toolId: string): void {
    this.states.delete(toolId);
  }
}

// ============================================================================
// Risk Classification (ADR-049 + ADR-035)
// ============================================================================

/**
 * Patterns indicating irreversible/dangerous actions
 */
const IRREVERSIBLE_PATTERNS = [
  "delete",
  "remove",
  "drop",
  "truncate",
  "reset_hard",
  "force_push",
  "format",
  "destroy",
  "wipe",
];

/**
 * Patterns indicating write/modify actions
 */
const WRITE_PATTERNS = [
  "write",
  "create",
  "update",
  "insert",
  "push",
  "commit",
  "set",
  "save",
  "modify",
];

/**
 * Patterns indicating read-only actions
 */
const READ_PATTERNS = [
  "read",
  "get",
  "list",
  "search",
  "fetch",
  "query",
  "find",
  "show",
  "describe",
];

/**
 * Classify tool risk from tool name using pattern matching
 *
 * @param toolName - Tool name or ID
 * @param serverReadOnly - Whether the server is read-only (from mcp-permissions.yaml)
 * @returns Risk category
 */
export function classifyToolRisk(
  toolName: string,
  serverReadOnly: boolean = false,
): RiskCategory {
  const lowerName = toolName.toLowerCase();

  // Server explicitly read-only → always safe
  if (serverReadOnly) {
    return "safe";
  }

  // Irreversible action pattern → dangerous
  if (IRREVERSIBLE_PATTERNS.some((p) => lowerName.includes(p))) {
    return "dangerous";
  }

  // Read action pattern → safe
  if (READ_PATTERNS.some((p) => lowerName.includes(p))) {
    return "safe";
  }

  // Write action pattern → moderate
  if (WRITE_PATTERNS.some((p) => lowerName.includes(p))) {
    return "moderate";
  }

  // Default to moderate (conservative)
  return "moderate";
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a pre-populated Thompson Sampler from historical observations
 *
 * @param history - Map of toolId to {successes, failures}
 * @param config - Optional configuration
 * @returns Configured ThompsonSampler
 */
export function createThompsonFromHistory(
  history: Map<string, { successes: number; failures: number }>,
  config: Partial<ThompsonConfig> = {},
): ThompsonSampler {
  const sampler = new ThompsonSampler(config);

  for (const [toolId, { successes, failures }] of history) {
    // Simulate recording outcomes
    for (let i = 0; i < successes; i++) {
      sampler.recordOutcome(toolId, true);
    }
    for (let i = 0; i < failures; i++) {
      sampler.recordOutcome(toolId, false);
    }
  }

  log.debug("Thompson sampler created from history", {
    toolCount: history.size,
    totalExecutions: sampler.getTotalExecutions(),
  });

  return sampler;
}

/**
 * Create a Thompson Sampler with mode-specific configuration
 *
 * @param mode - Primary mode for this sampler
 * @returns Configured ThompsonSampler
 */
export function createThompsonForMode(mode: ThresholdMode): ThompsonSampler {
  const config: Partial<ThompsonConfig> = {};

  switch (mode) {
    case "active_search":
      // More exploration, lower bounds
      config.priorAlpha = 1;
      config.priorBeta = 1;
      config.bounds = { min: 0.40, max: 0.85 };
      break;

    case "passive_suggestion":
      // Balanced
      config.priorAlpha = 2;
      config.priorBeta = 2;
      config.bounds = { min: 0.50, max: 0.90 };
      break;

    case "speculation":
      // More conservative, less variance
      config.priorAlpha = 3;
      config.priorBeta = 1;
      config.decayFactor = 0.97;
      config.bounds = { min: 0.60, max: 0.95 };
      break;
  }

  return new ThompsonSampler(config);
}

// ============================================================================
// Decision Functions
// ============================================================================

/**
 * Make execution decision using Thompson Sampling
 *
 * @param sampler - Thompson sampler instance
 * @param toolId - Tool to evaluate
 * @param score - Confidence score for the tool
 * @param riskCategory - Risk level
 * @param mode - Threshold mode
 * @param localAlpha - Optional local alpha
 * @returns Whether to execute (true) or defer to human (false)
 */
export function makeDecision(
  sampler: ThompsonSampler,
  toolId: string,
  score: number,
  riskCategory: RiskCategory,
  mode: ThresholdMode,
  localAlpha: number = 0.75,
): boolean {
  const result = sampler.getThreshold(toolId, riskCategory, mode, localAlpha);
  return score >= result.threshold;
}

/**
 * Batch decision for multiple tools
 *
 * @returns Map of toolId to decision (true = execute, false = defer)
 */
export function makeBatchDecision(
  sampler: ThompsonSampler,
  tools: Array<{
    toolId: string;
    score: number;
    riskCategory: RiskCategory;
  }>,
  mode: ThresholdMode,
  localAlpha: number = 0.75,
): Map<string, boolean> {
  const decisions = new Map<string, boolean>();

  for (const tool of tools) {
    decisions.set(
      tool.toolId,
      makeDecision(
        sampler,
        tool.toolId,
        tool.score,
        tool.riskCategory,
        mode,
        localAlpha,
      ),
    );
  }

  return decisions;
}
