/**
 * Benchmark Utilities Module
 *
 * @module tests/benchmarks/utils
 */

export {
  type AggregatedMetrics,
  type BenchmarkRun,
  compareAlgorithms,
  type ComparisonResult,
  formatComparison,
  generateReport,
  mean,
  median,
  MetricsCollector,
  percentile,
  stdDev,
  welchTTest,
} from "./metrics.ts";
