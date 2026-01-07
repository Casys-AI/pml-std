/**
 * DI Adapters Module
 *
 * Adapters that wrap existing implementations to work with DI tokens.
 *
 * @module infrastructure/di/adapters
 */

// Phase 2.1: Core adapters
export { GraphEngineAdapter } from "./graph-engine-adapter.ts";
export { CapabilityRepositoryAdapter } from "./capability-repository-adapter.ts";
export { MCPClientRegistryAdapter } from "./mcp-client-registry-adapter.ts";
export { DecisionStrategyAdapter } from "./decision-strategy-adapter.ts";
export { StreamOrchestratorAdapter } from "./stream-orchestrator-adapter.ts";

// Phase 3.2: New adapters
export { CodeAnalyzerAdapter } from "./code-analyzer-adapter.ts";
export { DAGSuggesterAdapter } from "./dag-suggester-adapter.ts";
export { SHGATTrainerAdapter } from "./shgat-trainer-adapter.ts";
export { WorkflowRepositoryImpl } from "./workflow-repository-impl.ts";

// Execute adapters (Phase 3.1)
export * from "./execute/mod.ts";
