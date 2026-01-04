/**
 * MCP Gateway Server Types
 *
 * Types specific to gateway server internals (not exported via public API).
 *
 * @module mcp/server/types
 */

import type { ControlledExecutor } from "../../dag/controlled-executor.ts";
import type { ExecutionEvent, TaskResult } from "../../dag/types.ts";
import type { DAGStructure } from "../../graphrag/types.ts";
import type { WorkflowState } from "../../dag/state.ts";

/**
 * MCP Gateway Server Configuration
 */
export interface GatewayServerConfig {
  name?: string;
  version?: string;
  enableSpeculative?: boolean;
  defaultToolLimit?: number;
  piiProtection?: {
    enabled: boolean;
    types?: Array<"email" | "phone" | "credit_card" | "ssn" | "api_key">;
    detokenizeOutput?: boolean;
  };
  cacheConfig?: {
    enabled: boolean;
    maxEntries?: number;
    ttlSeconds?: number;
    persistence?: boolean;
  };
}

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedGatewayConfig {
  name: string;
  version: string;
  enableSpeculative: boolean;
  defaultToolLimit: number;
  piiProtection: {
    enabled: boolean;
    types: Array<"email" | "phone" | "credit_card" | "ssn" | "api_key">;
    detokenizeOutput: boolean;
  };
  cacheConfig: {
    enabled: boolean;
    maxEntries: number;
    ttlSeconds: number;
    persistence: boolean;
  };
}

/**
 * Active workflow state for per-layer validation (Story 2.5-4)
 */
export interface ActiveWorkflow {
  workflowId: string;
  executor: ControlledExecutor;
  generator: AsyncGenerator<ExecutionEvent, WorkflowState, void>;
  dag: DAGStructure;
  currentLayer: number;
  totalLayers: number;
  layerResults: TaskResult[];
  status: "running" | "paused" | "complete" | "aborted" | "awaiting_approval";
  createdAt: Date;
  lastActivityAt: Date;
  latestCheckpointId: string | null;
}

/**
 * MCP tool call response (success)
 */
export interface MCPToolResponse {
  content: Array<{ type: string; text: string }>;
}

/**
 * MCP error response
 */
export interface MCPErrorResponse {
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Union type for MCP handler responses
 */
export type MCPHandlerResponse = MCPToolResponse | MCPErrorResponse;

/**
 * JSON-RPC request structure
 */
export interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Learning context for capability saving after HIL approval
 * Contains all data needed to call saveCapability when workflow completes.
 */
export interface LearningContext {
  /** Original TypeScript code */
  code: string;
  /** Original intent text */
  intent: string;
  /** Static structure from SWC analysis */
  staticStructure: import("../../capabilities/types.ts").StaticStructure;
  /** Pre-computed intent embedding for similarity search */
  intentEmbedding?: number[];
}

/**
 * Workflow execution arguments
 */
export interface WorkflowExecutionArgs {
  intent?: string;
  workflow?: DAGStructure;
  config?: {
    per_layer_validation?: boolean;
  };
  /** Learning context for capability saving (passed from pml:execute to HIL path) */
  learningContext?: LearningContext;
}

/**
 * Continue command arguments
 */
export interface ContinueArgs {
  workflow_id?: string;
  reason?: string;
}

/**
 * Abort command arguments
 */
export interface AbortArgs {
  workflow_id?: string;
  reason?: string;
}

/**
 * Replan command arguments
 */
export interface ReplanArgs {
  workflow_id?: string;
  new_requirement?: string;
  available_context?: Record<string, unknown>;
}

/**
 * Approval response arguments
 */
export interface ApprovalResponseArgs {
  workflow_id?: string;
  checkpoint_id?: string;
  approved?: boolean;
  feedback?: string;
}

/**
 * Search tools arguments
 */
export interface SearchToolsArgs {
  query?: string;
  limit?: number;
  include_related?: boolean;
  context_tools?: string[];
}

/**
 * Search capabilities arguments
 */
export interface SearchCapabilitiesArgs {
  intent?: string;
  include_suggestions?: boolean;
}

// =============================================================================
// MCP Sampling Types (for agent tools relay)
// =============================================================================

/**
 * MCP Sampling message content
 */
export interface SamplingMessageContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * MCP Sampling message
 */
export interface SamplingMessage {
  role: "user" | "assistant";
  content: SamplingMessageContent | string;
}

/**
 * MCP Sampling request (from child server to Gateway)
 */
export interface SamplingRequest {
  messages: SamplingMessage[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  systemPrompt?: string;
  /** Hint for agentic loop iterations */
  _maxIterations?: number;
  /** Tool patterns allowed for agent */
  _allowedToolPatterns?: string[];
}

/**
 * MCP Sampling response content
 */
export interface SamplingResponseContent {
  type: "text" | "tool_use";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * MCP Sampling response (from Claude Code to Gateway to child server)
 */
export interface SamplingResponse {
  content: SamplingResponseContent[];
  model?: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

/**
 * JSON-RPC response structure
 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
