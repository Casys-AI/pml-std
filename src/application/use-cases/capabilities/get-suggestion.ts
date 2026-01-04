/**
 * Get Suggestion Use Case
 *
 * Generates workflow suggestions using SHGAT + DR-DSP backward pathfinding.
 * Returns suggested DAGs with call names and input schemas for agent execution.
 *
 * @module application/use-cases/capabilities/get-suggestion
 */

import * as log from "@std/log";
import type { UseCaseResult } from "../shared/types.ts";
import type {
  GetSuggestionRequest,
  GetSuggestionResult,
  SuggestedTask,
} from "./types.ts";

// ============================================================================
// Interfaces (Clean Architecture - no concrete imports)
// ============================================================================

/**
 * DR-DSP algorithm interface
 */
export interface IDRDSP {
  findShortestHyperpath(source: string, target: string): {
    path: string[];
    hyperedges: Array<{ id: string }>;
    totalWeight: number;
    nodeSequence: string[];
    found: boolean;
  };
}

/**
 * Capability store interface
 */
export interface ICapabilityStore {
  findById(id: string): Promise<{
    id: string;
    toolsUsed?: string[];
    parametersSchema?: unknown;
  } | null>;
}

/**
 * Graph engine interface (for tool schema lookups)
 */
export interface IGraphEngine {
  getToolNode(toolId: string): {
    name: string;
    schema?: { inputSchema?: unknown };
  } | null;
}

/**
 * Capability registry interface (for call names)
 */
export interface ICapabilityRegistry {
  getByWorkflowPatternId(patternId: string): Promise<{
    namespace: string;
    action: string;
  } | null>;
}

/**
 * Decision logger interface (for observability)
 * Re-exported from telemetry module for convenience
 */
export type { IDecisionLogger } from "../../../telemetry/decision-logger.ts";

// ============================================================================
// Use Case
// ============================================================================

/**
 * Use case for getting workflow suggestions via DR-DSP
 *
 * Flow:
 * 1. Look up the best capability from SHGAT
 * 2. Use DR-DSP to find hyperpath through capability's tools
 * 3. Enrich each node with call name and input schema
 */
export class GetSuggestionUseCase {
  constructor(
    private readonly capabilityStore: ICapabilityStore,
    private readonly graphEngine: IGraphEngine,
    private readonly drdsp?: IDRDSP,
    private readonly capabilityRegistry?: ICapabilityRegistry,
    private readonly decisionLogger?: import("../../../telemetry/decision-logger.ts").IDecisionLogger,
  ) {}

  /**
   * Execute the get suggestion use case
   */
  async execute(
    request: GetSuggestionRequest,
  ): Promise<UseCaseResult<GetSuggestionResult>> {
    const { intent, bestCapability, correlationId } = request;

    // No capability = no suggestion
    if (!bestCapability) {
      return {
        success: true,
        data: { confidence: 0 },
      };
    }

    try {
      // Look up capability
      const cap = await this.capabilityStore.findById(bestCapability.id);
      if (!cap) {
        log.warn(`GetSuggestionUseCase: capability not found: ${bestCapability.id}`);
        return {
          success: true,
          data: { confidence: bestCapability.score },
        };
      }

      // No tools = return capability itself
      if (!cap.toolsUsed || cap.toolsUsed.length === 0) {
        return await this.buildSingleCapabilitySuggestion(bestCapability);
      }

      // Single tool = return it directly
      if (cap.toolsUsed.length === 1) {
        const task = await this.buildTaskFromTool(cap.toolsUsed[0], "task_0", []);
        return {
          success: true,
          data: {
            suggestedDag: task ? { tasks: [task] } : undefined,
            confidence: bestCapability.score,
          },
        };
      }

      // No DR-DSP = fall back to simple sequence
      if (!this.drdsp) {
        return await this.buildSequenceFromTools(cap.toolsUsed, bestCapability.score);
      }

      // Multiple tools - use DR-DSP backward pathfinding
      const startTool = cap.toolsUsed[0];
      const endTool = cap.toolsUsed[cap.toolsUsed.length - 1];
      const pathResult = this.drdsp.findShortestHyperpath(startTool, endTool);

      if (!pathResult.found || pathResult.nodeSequence.length === 0) {
        // DR-DSP failed - fall back to simple sequence
        return await this.buildSequenceFromTools(cap.toolsUsed, bestCapability.score);
      }

      // Build tasks from hyperpath
      const tasks: SuggestedTask[] = [];

      for (let i = 0; i < pathResult.nodeSequence.length; i++) {
        const nodeId = pathResult.nodeSequence[i];
        const taskId = `task_${i}`;
        const dependsOn = i > 0 ? [`task_${i - 1}`] : [];

        // Check if node is a capability (hyperedge) or tool
        const hyperedge = pathResult.hyperedges[i];

        if (hyperedge) {
          // This is a capability
          const task = await this.buildTaskFromCapability(hyperedge.id, taskId, dependsOn);
          if (task) tasks.push(task);
        } else {
          // This is a tool
          const task = await this.buildTaskFromTool(nodeId, taskId, dependsOn);
          if (task) tasks.push(task);
        }
      }

      log.debug(`GetSuggestionUseCase: built suggestedDag`, {
        capabilityId: bestCapability.id,
        pathLength: pathResult.nodeSequence.length,
        tasksCount: tasks.length,
      });

      // Trace DR-DSP decision
      this.decisionLogger?.logDecision({
        algorithm: "DRDSP",
        mode: "passive_suggestion",
        targetType: "capability",
        intent,
        finalScore: 1.0 / (1 + pathResult.totalWeight),
        threshold: 0,
        decision: "accepted",
        targetId: bestCapability.id,
        targetName: bestCapability.id.split(":").pop() ?? bestCapability.id.substring(0, 12),
        correlationId,
        signals: {
          pathFound: true,
          pathLength: pathResult.nodeSequence.length,
          pathWeight: pathResult.totalWeight,
        },
        params: {
          reliabilityFactor: 1.0,
        },
      });

      return {
        success: true,
        data: {
          suggestedDag: { tasks },
          confidence: bestCapability.score,
        },
      };
    } catch (error) {
      log.error(`GetSuggestionUseCase failed: ${error}`);
      return {
        success: false,
        error: {
          code: "SUGGESTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Build a single task from a tool ID
   */
  private async buildTaskFromTool(
    toolId: string,
    taskId: string,
    dependsOn: string[],
  ): Promise<SuggestedTask | null> {
    const toolNode = this.graphEngine.getToolNode(toolId);
    if (!toolNode) {
      log.warn(`GetSuggestionUseCase: tool not found: ${toolId}`);
      return null;
    }

    return {
      id: taskId,
      callName: toolId,
      type: "tool",
      inputSchema: toolNode.schema?.inputSchema,
      dependsOn,
    };
  }

  /**
   * Build a single task from a capability ID
   */
  private async buildTaskFromCapability(
    capabilityId: string,
    taskId: string,
    dependsOn: string[],
  ): Promise<SuggestedTask | null> {
    const cap = await this.capabilityStore.findById(capabilityId);
    if (!cap) {
      log.warn(`GetSuggestionUseCase: capability not found: ${capabilityId}`);
      return null;
    }

    // Get call name from registry
    let callName = capabilityId.substring(0, 8); // Fallback to short ID
    if (this.capabilityRegistry) {
      const record = await this.capabilityRegistry.getByWorkflowPatternId(capabilityId);
      if (record) {
        callName = `${record.namespace}:${record.action}`;
      }
    }

    return {
      id: taskId,
      callName,
      type: "capability",
      inputSchema: cap.parametersSchema,
      dependsOn,
    };
  }

  /**
   * Build suggestion for single capability (no DR-DSP)
   */
  private async buildSingleCapabilitySuggestion(
    bestCapability: { id: string; score: number },
  ): Promise<UseCaseResult<GetSuggestionResult>> {
    const task = await this.buildTaskFromCapability(bestCapability.id, "task_0", []);

    return {
      success: true,
      data: {
        suggestedDag: task ? { tasks: [task] } : undefined,
        confidence: bestCapability.score,
      },
    };
  }

  /**
   * Build simple sequence from tools (fallback when DR-DSP fails)
   */
  private async buildSequenceFromTools(
    toolsUsed: string[],
    confidence: number,
  ): Promise<UseCaseResult<GetSuggestionResult>> {
    const tasks: SuggestedTask[] = [];

    for (let i = 0; i < toolsUsed.length; i++) {
      const task = await this.buildTaskFromTool(
        toolsUsed[i],
        `task_${i}`,
        i > 0 ? [`task_${i - 1}`] : [],
      );
      if (task) tasks.push(task);
    }

    return {
      success: true,
      data: {
        suggestedDag: { tasks },
        confidence,
      },
    };
  }
}
