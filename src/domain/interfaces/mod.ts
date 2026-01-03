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
export * from "./dag-executor.ts";
export * from "./event-bus.ts";
export * from "./graph-engine.ts";
export * from "./mcp-client-registry.ts";
export * from "./tool-repository.ts";
