/**
 * Execute Handler Facade
 *
 * Thin facade that routes requests to appropriate use cases.
 * This replaces the monolithic execute-handler.ts (1,803 lines)
 * with a focused routing layer (~150 lines).
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module mcp/handlers/execute-handler-facade
 */

import * as log from "@std/log";
import {
  ExecuteDirectUseCase,
  ExecuteSuggestionUseCase,
  ContinueWorkflowUseCase,
  TrainSHGATUseCase,
  type ExecuteResponse,
} from "../../application/use-cases/execute/mod.ts";
import type { JsonValue } from "../../capabilities/types/mod.ts";

// ============================================================================
// Request/Response Types
// ============================================================================

/**
 * Execute request from MCP client
 */
export interface ExecuteRequest {
  /** TypeScript code to execute (direct mode) */
  code?: string;
  /** Natural language intent */
  intent?: string;
  /** Workflow continuation */
  continue_workflow?: {
    workflow_id: string;
    approved: boolean;
    checkpoint_id?: string;
  };
  /** Execution options */
  options?: {
    timeout?: number;
    per_layer_validation?: boolean;
  };
}

// ============================================================================
// Facade Implementation
// ============================================================================

/**
 * Dependencies for ExecuteHandlerFacade
 */
export interface ExecuteHandlerFacadeDeps {
  executeDirectUC?: ExecuteDirectUseCase;
  executeSuggestionUC?: ExecuteSuggestionUseCase;
  continueWorkflowUC?: ContinueWorkflowUseCase;
  trainSHGATUC?: TrainSHGATUseCase;
}

/**
 * Execute Handler Facade
 *
 * Routes requests to appropriate use cases and formats responses.
 */
export class ExecuteHandlerFacade {
  constructor(private readonly deps: ExecuteHandlerFacadeDeps) {}

  /**
   * Handle execute request
   */
  async handle(request: ExecuteRequest): Promise<ExecuteResponse> {
    log.debug("[ExecuteHandlerFacade] Handling request", {
      hasCode: !!request.code,
      hasIntent: !!request.intent,
      hasContinuation: !!request.continue_workflow,
    });

    // Route to appropriate use case
    if (request.continue_workflow) {
      return await this.handleContinuation(request);
    }

    if (request.code) {
      return await this.handleDirect(request);
    }

    if (request.intent) {
      return await this.handleSuggestion(request);
    }

    // No valid request type
    return {
      status: "success",
      result: null,
      mode: "direct",
      executionTimeMs: 0,
    };
  }

  // ==========================================================================
  // Private Route Handlers
  // ==========================================================================

  private async handleDirect(request: ExecuteRequest): Promise<ExecuteResponse> {
    if (!this.deps.executeDirectUC) {
      return this.notConfiguredError("ExecuteDirectUseCase not configured");
    }

    const result = await this.deps.executeDirectUC.execute({
      code: request.code!,
      intent: request.intent || "execute code",
      options: {
        timeout: request.options?.timeout,
        perLayerValidation: request.options?.per_layer_validation,
      },
    });

    // Trigger SHGAT training in background (fire and forget)
    if (result.success && result.data?.traces && this.deps.trainSHGATUC) {
      this.triggerTraining(result.data.traces, result.data.success, result.data.executionTimeMs).catch(
        (err) => log.warn(`[ExecuteHandlerFacade] Training trigger failed: ${err}`),
      );
    }

    if (!result.success) {
      return {
        status: "success", // MCP status
        result: null,
        mode: "direct",
        executionTimeMs: 0,
        toolFailures: result.data?.toolFailures,
      };
    }

    return {
      status: "success",
      result: result.data?.result as JsonValue ?? null,
      capabilityId: result.data?.capabilityId,
      capabilityName: result.data?.capabilityName,
      capabilityFqdn: result.data?.capabilityFqdn,
      mode: "direct",
      executionTimeMs: result.data?.executionTimeMs ?? 0,
      dag: result.data?.dag,
      toolFailures: result.data?.toolFailures,
    };
  }

  private async handleSuggestion(request: ExecuteRequest): Promise<ExecuteResponse> {
    if (!this.deps.executeSuggestionUC) {
      return this.notConfiguredError("ExecuteSuggestionUseCase not configured");
    }

    const result = await this.deps.executeSuggestionUC.execute({
      intent: request.intent!,
      options: {
        timeout: request.options?.timeout,
      },
    });

    if (!result.success || !result.data) {
      return {
        status: "suggestions",
        suggestions: {
          confidence: 0,
        },
        executionTimeMs: 0,
      };
    }

    return {
      status: "suggestions",
      suggestions: {
        suggestedDag: result.data.suggestedDag,
        confidence: result.data.confidence,
      },
      executionTimeMs: result.data.executionTimeMs,
    };
  }

  private async handleContinuation(request: ExecuteRequest): Promise<ExecuteResponse> {
    if (!this.deps.continueWorkflowUC) {
      return this.notConfiguredError("ContinueWorkflowUseCase not configured");
    }

    const continuation = request.continue_workflow!;
    const result = await this.deps.continueWorkflowUC.execute({
      workflowId: continuation.workflow_id,
      approved: continuation.approved,
      checkpointId: continuation.checkpoint_id,
    });

    if (!result.success || !result.data) {
      return {
        status: "success",
        result: null,
        mode: "direct",
        executionTimeMs: 0,
      };
    }

    // Map status to response
    if (result.data.status === "paused") {
      return {
        status: "approval_required",
        workflowId: continuation.workflow_id,
        checkpointId: result.data.checkpointId,
        pendingLayer: result.data.pendingLayer,
        layerResults: result.data.layerResults,
        executionTimeMs: result.data.executionTimeMs,
      };
    }

    return {
      status: "success",
      result: result.data.result as JsonValue ?? null,
      capabilityId: result.data.capabilityId,
      capabilityName: result.data.capabilityName,
      capabilityFqdn: result.data.capabilityFqdn,
      mode: "direct",
      executionTimeMs: result.data.executionTimeMs,
    };
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private notConfiguredError(message: string): ExecuteResponse {
    log.error(`[ExecuteHandlerFacade] ${message}`);
    return {
      status: "success",
      result: null,
      mode: "direct",
      executionTimeMs: 0,
    };
  }

  private async triggerTraining(
    traces: unknown[],
    success: boolean,
    executionTimeMs: number,
  ): Promise<void> {
    if (!this.deps.trainSHGATUC) return;

    await this.deps.trainSHGATUC.execute({
      taskResults: traces as Array<{
        taskId: string;
        tool: string;
        args: Record<string, JsonValue>;
        result: JsonValue | null;
        success: boolean;
        durationMs: number;
      }>,
      success,
      executionTimeMs,
    });
  }
}
