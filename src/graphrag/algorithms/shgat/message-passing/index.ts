/**
 * Message Passing Module Index
 *
 * Exports all message passing phases and orchestrator for SHGAT.
 *
 * @module graphrag/algorithms/shgat/message-passing
 */

export type { MessagePassingPhase, PhaseParameters, PhaseResult } from "./phase-interface.ts";
export { VertexToEdgePhase } from "./vertex-to-edge-phase.ts";
export { EdgeToVertexPhase } from "./edge-to-vertex-phase.ts";
export { EdgeToEdgePhase } from "./edge-to-edge-phase.ts";
export {
  MultiLevelOrchestrator,
  type LayerParameters,
  type ForwardCache,
  type OrchestratorConfig,
} from "./multi-level-orchestrator.ts";
