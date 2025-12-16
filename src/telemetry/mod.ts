/**
 * Telemetry Module
 *
 * Exports logging and telemetry functionality.
 *
 * @module telemetry
 */

export { getLogger, logger, setupLogger } from "./logger.ts";
export { TelemetryService } from "./telemetry.ts";
export type { LoggerConfig, LogLevel, TelemetryConfig, TelemetryMetric } from "./types.ts";
// Story 6.5: MetricsCollector for EventBus-based metrics (ADR-036)
export { MetricsCollector } from "./metrics-collector.ts";
// Story 7.6: AlgorithmTracer for algorithm observability (ADR-039)
export { AlgorithmTracer } from "./algorithm-tracer.ts";
export type {
  AlgorithmMetrics,
  AlgorithmMode,
  AlgorithmParams,
  AlgorithmSignals,
  AlgorithmTraceRecord,
  AlphaStats, // ADR-048: Alpha statistics
  DecisionType,
  TargetType,
  TraceInput,
  TraceOutcome,
  UserAction,
} from "./algorithm-tracer.ts";
