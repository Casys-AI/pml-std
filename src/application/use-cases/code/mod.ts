/**
 * Code Execution Use Cases
 *
 * Application layer use cases for code execution.
 *
 * @deprecated The pml:execute_code handler is deprecated.
 *             Use pml:execute instead. This module remains for
 *             internal use and gradual migration.
 *
 * @module application/use-cases/code
 */

// Types
export * from "./types.ts";

// Use Cases
export { ExecuteCodeUseCase } from "./execute-code.ts";

// Interfaces for dependency injection
export type {
  CapabilityDetails,
  CapabilityMatchResult,
  ExecuteCodeDependencies,
  ExecutionData,
  HybridToolResult,
  ICapabilityFeedback,
  ICapabilityMatcher,
  IGraphUpdater,
  ISandboxExecutor,
  IToolDiscovery,
  SandboxExecutionResult,
  WorkerExecutionConfig,
} from "./execute-code.ts";
