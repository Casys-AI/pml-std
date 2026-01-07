/**
 * Application Use Cases
 *
 * Use cases implementing business logic for the application layer.
 * Each use case encapsulates a single business operation.
 *
 * ## Architecture
 *
 * ```
 * Presentation (MCP/HTTP) → Use Cases → Domain Services → Repositories
 * ```
 *
 * Use cases:
 * - Accept typed request objects
 * - Return typed result objects
 * - Are transport-agnostic
 * - Orchestrate domain services
 * - Emit domain events
 *
 * @module application/use-cases
 */

// Shared types (exported first to avoid ambiguity)
export * from "./shared/mod.ts";

// Workflow Use Cases
export { AbortWorkflowUseCase, ReplanWorkflowUseCase } from "./workflows/mod.ts";
export type {
  AbortWorkflowRequest,
  AbortWorkflowResult,
  ApprovalResponseRequest,
  ApprovalResponseResult,
  ExecuteWorkflowRequest,
  ExecuteWorkflowResult,
  IDAGSuggester,
  PendingCheckpoint,
  ReplanWorkflowRequest,
  ReplanWorkflowResult,
  ResumeWorkflowRequest,
  ResumeWorkflowResult,
  WorkflowTaskResult,
} from "./workflows/mod.ts";

// Capability Use Cases
export { SearchCapabilitiesUseCase, GetSuggestionUseCase } from "./capabilities/mod.ts";
export type {
  CapabilityMatch,
  CapabilitySummary,
  ExecuteCapabilityRequest,
  ExecuteCapabilityResult,
  GetSuggestionRequest,
  GetSuggestionResult,
  ICapabilityRegistry,
  ICapabilityStore,
  IDecisionLogger,
  IDRDSP,
  IGraphEngine,
  LearnCapabilityRequest,
  LearnCapabilityResult,
  SearchCapabilitiesRequest,
  SearchCapabilitiesResult,
  SuggestedDag,
  SuggestedTask,
} from "./capabilities/mod.ts";

// Code Execution Use Cases (deprecated)
export { ExecuteCodeUseCase } from "./code/mod.ts";
export type {
  CapabilityDetails,
  CapabilityMatchResult,
  CodeSyntaxError,
  ExecuteCodeDependencies,
  ExecuteCodeRequest,
  ExecuteCodeResult,
  ExecutionData,
  HybridToolResult,
  ICapabilityFeedback,
  ICapabilityMatcher,
  IGraphUpdater,
  ISandboxExecutor,
  IToolDiscovery,
  MatchedCapability,
  SandboxConfig,
  SandboxExecutionResult,
  SecurityIssue,
  ToolDefinition,
  ToolFailure,
  ValidateCodeRequest,
  ValidateCodeResult,
  WorkerExecutionConfig,
} from "./code/mod.ts";

// Execute Use Cases (Phase 3.1)
export {
  ExecuteDirectUseCase,
  ExecuteSuggestionUseCase,
  ContinueWorkflowUseCase,
  TrainSHGATUseCase,
} from "./execute/mod.ts";
export type {
  ExecuteDirectDependencies,
  ExecuteDirectRequest,
  ExecuteDirectResult,
  ExecuteSuggestionDependencies,
  ExecuteSuggestionRequest,
  ExecuteSuggestionResult,
  ContinueWorkflowDependencies,
  ContinueWorkflowRequest,
  ContinueWorkflowResult,
  TrainSHGATDependencies,
  TrainSHGATRequest,
  TrainSHGATResult,
  ExecuteResponse,
  AcceptSuggestionRequest,
  AcceptSuggestionResult,
} from "./execute/mod.ts";

// Discover Use Cases
export * from "./discover/mod.ts";
