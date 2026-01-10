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
  /** Whether client is a registered PML package (hybrid routing) */
  isPackageClient?: boolean;
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
   * Set user ID for multi-tenant trace isolation (Story 9.8)
   * Called per-request before handle()
   */
  setUserId(userId: string | null): void {
    this.deps.executeSuggestionUC?.setUserId(userId);
    this.deps.executeDirectUC?.setUserId(userId);
  }

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

    // Check if code was explicitly provided (even if empty string)
    if (typeof request.code === "string") {
      // Empty code is an error
      if (request.code.trim() === "") {
        return {
          status: "success",
          result: null,
          mode: "direct",
          executionTimeMs: 0,
          error_code: "EMPTY_CODE",
          error: "Code cannot be empty",
        };
      }
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
        isPackageClient: request.isPackageClient,
      },
    });

    // Phase 3.2: Training is now event-driven via capability.learned events
    // See TrainingSubscriber in telemetry/subscribers/training-subscriber.ts

    if (!result.success) {
      // Check for CLIENT_TOOLS_REQUIRE_PACKAGE error
      if (result.error?.code === "CLIENT_TOOLS_REQUIRE_PACKAGE") {
        return {
          status: "success", // MCP status (error is in result)
          result: null,
          mode: "direct",
          executionTimeMs: 0,
          error_code: "CLIENT_TOOLS_REQUIRE_PACKAGE",
          client_tools: result.error?.details?.clientTools as string[] ?? [],
          tools_used: result.error?.details?.toolsUsed as string[] ?? [],
        };
      }

      // Include error information in response for debugging
      return {
        status: "success", // MCP status (call succeeded, but execution failed)
        result: null,
        mode: "direct",
        executionTimeMs: 0,
        error_code: result.error?.code,
        error: result.error?.message,
        toolFailures: result.data?.toolFailures,
      };
    }

    // Handle execute_locally mode (hybrid routing)
    if (result.data?.mode === "execute_locally") {
      return {
        status: "execute_locally",
        code: result.data.code,
        tools_used: result.data.toolsUsed,
        client_tools: result.data.clientTools,
        mode: "execute_locally",
        executionTimeMs: result.data.executionTimeMs ?? 0,
        dag: result.data.dag,
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
      log.warn("[ExecuteHandlerFacade] ExecuteSuggestionUseCase not configured");
      return {
        status: "suggestions",
        suggestions: { confidence: 0 },
        executionTimeMs: 0,
      };
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

    // Fail-fast: if we have confidence but no suggestedDag, that's an error state
    if (result.data.confidence > 0 && !result.data.suggestedDag) {
      log.error("[ExecuteHandlerFacade] Suggestion found capability but failed to build DAG", {
        confidence: result.data.confidence,
        bestCapability: result.data.bestCapability,
      });
      return {
        status: "suggestions",
        suggestions: {
          confidence: 0,
          error: "Found matching capability but failed to construct suggested DAG",
        },
        executionTimeMs: result.data.executionTimeMs,
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

  // Phase 3.2: triggerTraining removed - training is now event-driven
  // See TrainingSubscriber in telemetry/subscribers/training-subscriber.ts
}
