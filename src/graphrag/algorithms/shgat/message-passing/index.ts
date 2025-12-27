/**
 * Message Passing Module Index
 *
 * Exports all message passing phases and orchestrator for SHGAT.
 * Supports both legacy 2-level (V→E→V) and multi-level n-SuperHyperGraph.
 *
 * @module graphrag/algorithms/shgat/message-passing
 */

export type { MessagePassingPhase, PhaseParameters, PhaseResult } from "./phase-interface.ts";
export { VertexToEdgePhase } from "./vertex-to-edge-phase.ts";
export { EdgeToVertexPhase } from "./edge-to-vertex-phase.ts";
export { EdgeToEdgePhase } from "./edge-to-edge-phase.ts";
export {
  type ForwardCache,
  type LayerParameters,
  MultiLevelOrchestrator,
  type OrchestratorConfig,
} from "./multi-level-orchestrator.ts";

// Re-export multi-level types from main types for convenience
export type { LevelParams, MultiLevelEmbeddings, MultiLevelForwardCache } from "../types.ts";
