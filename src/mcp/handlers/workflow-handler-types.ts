/**
 * Workflow Handler Types
 *
 * Shared types for workflow execution handlers.
 *
 * @module mcp/handlers/workflow-handler-types
 */

import type { DbClient } from "../../db/types.ts";
import type { GraphRAGEngine } from "../../graphrag/graph-engine.ts";
import type { DAGSuggester } from "../../graphrag/dag-suggester.ts";
import type { CapabilityStore } from "../../capabilities/capability-store.ts";
import type { CapabilityRegistry } from "../../capabilities/capability-registry.ts";
import type { MCPClientBase } from "../types.ts";
import type { ActiveWorkflow } from "../server/types.ts";
import type { GatewayHandler } from "../gateway-handler.ts";
import type { CheckpointManager } from "../../dag/checkpoint-manager.ts";
import type { AdaptiveThresholdManager } from "../adaptive-threshold.ts";
import type { AlgorithmTracer } from "../../telemetry/algorithm-tracer.ts";

/**
 * Dependencies required for workflow handler
 */
export interface WorkflowHandlerDependencies {
  db: DbClient;
  graphEngine: GraphRAGEngine;
  dagSuggester: DAGSuggester;
  capabilityStore?: CapabilityStore;
  /** Capability registry for routing to learned capabilities (meta-capabilities) */
  capabilityRegistry?: CapabilityRegistry;
  mcpClients: Map<string, MCPClientBase>;
  gatewayHandler: GatewayHandler;
  checkpointManager: CheckpointManager | null;
  activeWorkflows: Map<string, ActiveWorkflow>;
  /** Story 10.7c: Thompson Sampling threshold manager (optional) */
  adaptiveThresholdManager?: AdaptiveThresholdManager;
  /** Story 7.6: Algorithm tracer for observability */
  algorithmTracer?: AlgorithmTracer;
}
