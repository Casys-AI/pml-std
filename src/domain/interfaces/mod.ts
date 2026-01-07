/**
 * Domain Interfaces Module
 *
 * Re-exports all domain service interfaces for DI.
 * These interfaces define contracts that implementations must follow.
 *
 * Phase 2.1: Foundation for DI with diod
 *
 * @example
 * ```typescript
 * import type { ICapabilityRepository, IDAGExecutor } from "@/domain/interfaces/mod.ts";
 *
 * class MyService {
 *   constructor(
 *     private capabilityRepo: ICapabilityRepository,
 *     private executor: IDAGExecutor,
 *   ) {}
 * }
 * ```
 *
 * @module domain/interfaces
 */

export * from "./capability-repository.ts";
export * from "./code-analyzer.ts";
export * from "./code-executor.ts";
export * from "./dag-executor.ts";
export * from "./dag-suggester.ts";
export * from "./event-bus.ts";
export * from "./graph-engine.ts";
export * from "./mcp-client-registry.ts";
export * from "./shgat-trainer.ts";
export * from "./stream-orchestrator.ts";
export * from "./tool-repository.ts";
export * from "./trace-collector.ts";
export * from "./workflow-repository.ts";

// Re-export from infrastructure patterns (canonical location)
export type {
  IDecisionStrategy,
  DecisionPreparation,
  AILResponseResult,
} from "../../infrastructure/patterns/strategy/mod.ts";
