/**
 * Benchmark Metrics Collection
 *
 * Utilities for collecting, aggregating, and reporting benchmark metrics.
 * Includes statistical functions and comparison tools.
 *
 * @module tests/benchmarks/utils/metrics
 */

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkRun {
  algorithm: string;
  scenario: string;
  iteration: number;
  durationMs: number;
  memoryUsedMb?: number;
  result?: unknown;
  timestamp: Date;
}

export interface AggregatedMetrics {
  algorithm: string;
  scenario: string;
  runs: number;
  meanMs: number;
  medianMs: number;
  stdDevMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  p99Ms: number;
  memoryMeanMb?: number;
}

export interface ComparisonResult {
  baseline: AggregatedMetrics;
  candidate: AggregatedMetrics;
  speedupFactor: number;
  significantDifference: boolean;
  winner: "baseline" | "candidate" | "tie";
  pValue?: number;
}

// ============================================================================
// Metrics Collection
// ============================================================================

export class MetricsCollector {
  private runs: BenchmarkRun[] = [];

  /**
   * Record a benchmark run
   */
  record(run: Omit<BenchmarkRun, "timestamp">): void {
    this.runs.push({
      ...run,
      timestamp: new Date(),
    });
  }

  /**
   * Time a function execution
   */
  async time<T>(
    algorithm: string,
    scenario: string,
    iteration: number,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const memBefore = Deno.memoryUsage?.()?.heapUsed;
    const start = performance.now();

    const result = await fn();

    const durationMs = performance.now() - start;
    const memAfter = Deno.memoryUsage?.()?.heapUsed;
    const memoryUsedMb = memBefore && memAfter
      ? (memAfter - memBefore) / 1024 / 1024
      : undefined;

    this.record({
      algorithm,
      scenario,
      iteration,
      durationMs,
      memoryUsedMb,
      result,
    });

    return result;
  }

  /**
   * Get all runs for an algorithm/scenario combination
   */
  getRuns(algorithm: string, scenario?: string): BenchmarkRun[] {
    return this.runs.filter((r) =>
      r.algorithm === algorithm &&
      (scenario === undefined || r.scenario === scenario)
    );
  }

  /**
   * Aggregate metrics for an algorithm/scenario
   */
  aggregate(algorithm: string, scenario: string): AggregatedMetrics {
    const runs = this.getRuns(algorithm, scenario);
    if (runs.length === 0) {
      throw new Error(`No runs found for ${algorithm}/${scenario}`);
    }

    const durations = runs.map((r) => r.durationMs).sort((a, b) => a - b);
    const memories = runs.map((r) => r.memoryUsedMb).filter((m): m is number => m !== undefined);

    return {
      algorithm,
      scenario,
      runs: runs.length,
      meanMs: mean(durations),
      medianMs: median(durations),
      stdDevMs: stdDev(durations),
      minMs: Math.min(...durations),
      maxMs: Math.max(...durations),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      memoryMeanMb: memories.length > 0 ? mean(memories) : undefined,
    };
  }

  /**
   * Clear all recorded runs
   */
  clear(): void {
    this.runs = [];
  }

  /**
   * Export runs to JSON
   */
  exportJSON(): string {
    return JSON.stringify(this.runs, null, 2);
  }
}

// ============================================================================
// Statistical Functions
// ============================================================================

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0;
  const mid = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 !== 0
    ? sortedValues[mid]
    : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const squaredDiffs = values.map((v) => (v - m) ** 2);
  return Math.sqrt(mean(squaredDiffs));
}

export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)];
}

/**
 * Welch's t-test for comparing two samples
 * Returns p-value for null hypothesis that means are equal
 */
export function welchTTest(sample1: number[], sample2: number[]): number {
  const n1 = sample1.length;
  const n2 = sample2.length;

  if (n1 < 2 || n2 < 2) return 1.0; // Not enough data

  const mean1 = mean(sample1);
  const mean2 = mean(sample2);
  const var1 = stdDev(sample1) ** 2;
  const var2 = stdDev(sample2) ** 2;

  const t = (mean1 - mean2) / Math.sqrt(var1 / n1 + var2 / n2);

  // Approximate degrees of freedom (Welch-Satterthwaite) - kept for reference
  const _df = ((var1 / n1 + var2 / n2) ** 2) /
    ((var1 / n1) ** 2 / (n1 - 1) + (var2 / n2) ** 2 / (n2 - 1));
  void _df; // Unused but kept for t-distribution extension

  // Approximate p-value using normal distribution for large samples
  // For small samples, this is an approximation
  const pValue = 2 * (1 - normalCDF(Math.abs(t)));

  return pValue;
}

/**
 * Approximate normal CDF using error function approximation
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

// ============================================================================
// Comparison & Reporting
// ============================================================================

/**
 * Compare two algorithms
 */
export function compareAlgorithms(
  baseline: AggregatedMetrics,
  candidate: AggregatedMetrics,
  significanceLevel: number = 0.05,
): ComparisonResult {
  const speedupFactor = baseline.meanMs / candidate.meanMs;

  // We'd need raw runs for proper t-test, using approximation here
  const stdErr1 = baseline.stdDevMs / Math.sqrt(baseline.runs);
  const stdErr2 = candidate.stdDevMs / Math.sqrt(candidate.runs);
  const combinedStdErr = Math.sqrt(stdErr1 ** 2 + stdErr2 ** 2);
  const zScore = (baseline.meanMs - candidate.meanMs) / combinedStdErr;
  const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));

  const significantDifference = pValue < significanceLevel;

  let winner: "baseline" | "candidate" | "tie" = "tie";
  if (significantDifference) {
    winner = candidate.meanMs < baseline.meanMs ? "candidate" : "baseline";
  }

  return {
    baseline,
    candidate,
    speedupFactor,
    significantDifference,
    winner,
    pValue,
  };
}

/**
 * Format comparison result as string
 */
export function formatComparison(result: ComparisonResult): string {
  const lines: string[] = [];

  lines.push(`Comparison: ${result.baseline.algorithm} vs ${result.candidate.algorithm}`);
  lines.push(`Scenario: ${result.baseline.scenario}`);
  lines.push("");
  lines.push("| Metric | Baseline | Candidate |");
  lines.push("|--------|----------|-----------|");
  lines.push(`| Mean | ${result.baseline.meanMs.toFixed(2)}ms | ${result.candidate.meanMs.toFixed(2)}ms |`);
  lines.push(`| Median | ${result.baseline.medianMs.toFixed(2)}ms | ${result.candidate.medianMs.toFixed(2)}ms |`);
  lines.push(`| Std Dev | ${result.baseline.stdDevMs.toFixed(2)}ms | ${result.candidate.stdDevMs.toFixed(2)}ms |`);
  lines.push(`| P95 | ${result.baseline.p95Ms.toFixed(2)}ms | ${result.candidate.p95Ms.toFixed(2)}ms |`);
  lines.push("");
  lines.push(`Speedup: ${result.speedupFactor.toFixed(2)}x`);
  lines.push(`P-value: ${result.pValue?.toFixed(4) ?? "N/A"}`);
  lines.push(`Winner: ${result.winner} (${result.significantDifference ? "significant" : "not significant"})`);

  return lines.join("\n");
}

/**
 * Generate markdown report for multiple comparisons
 */
export function generateReport(comparisons: ComparisonResult[]): string {
  const lines: string[] = [];

  lines.push("# Algorithm Benchmark Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| Baseline | Candidate | Scenario | Speedup | Winner |");
  lines.push("|----------|-----------|----------|---------|--------|");

  for (const c of comparisons) {
    const speedup = c.speedupFactor.toFixed(2);
    const winnerIcon = c.winner === "candidate" ? "+" : c.winner === "baseline" ? "-" : "=";
    lines.push(
      `| ${c.baseline.algorithm} | ${c.candidate.algorithm} | ${c.baseline.scenario} | ${speedup}x | ${winnerIcon} ${c.winner} |`,
    );
  }

  lines.push("");
  lines.push("## Detailed Results");
  lines.push("");

  for (const c of comparisons) {
    lines.push(`### ${c.baseline.algorithm} vs ${c.candidate.algorithm}`);
    lines.push("");
    lines.push(formatComparison(c));
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
