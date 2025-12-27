/**
 * Permission Escalation Handler (Story 7.7c - HIL Permission Escalation)
 *
 * Handles the full escalation flow when a capability fails with PermissionDenied:
 * 1. Detect permission error and suggest escalation
 * 2. Check approvalMode - if 'auto', skip HIL and auto-approve
 * 3. Request human approval via HIL mechanism (if approvalMode === 'hil')
 * 4. Update capability's permission_set in DB if approved
 * 5. Support retry execution with new permissions
 *
 * Refactored for 3-axis permission model:
 * - ApprovalMode determines if HIL is needed or auto-approve
 * - FFI/run are now allowed via PermissionConfig (no longer hardcoded blocked)
 *
 * @module capabilities/permission-escalation-handler
 */

import type {
  ApprovalMode,
  PermissionConfig,
  PermissionEscalationRequest,
  PermissionSet,
} from "./types.ts";
import type { CapabilityStore } from "./capability-store.ts";
import type { PermissionAuditStore } from "./permission-audit-store.ts";
import { suggestEscalation } from "./permission-escalation.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Result of handling a permission escalation
 */
export interface EscalationResult {
  /** Whether escalation was handled (request was created and processed) */
  handled: boolean;
  /** Whether the escalation was approved */
  approved: boolean;
  /** New permission set if approved */
  newPermissionSet?: PermissionSet;
  /** Error message if escalation failed or was rejected */
  error?: string;
  /** Human feedback (if provided) */
  feedback?: string;
}

/**
 * Callback for requesting HIL approval
 *
 * This is implemented by ControlledExecutor to emit decision_required event
 * and wait for approval_response command.
 */
export type HILApprovalCallback = (
  request: PermissionEscalationRequest,
) => Promise<{ approved: boolean; feedback?: string }>;

/**
 * PermissionEscalationHandler - Orchestrates the permission escalation flow
 *
 * This class coordinates between:
 * - suggestEscalation(): Parses errors and suggests escalations
 * - HIL mechanism: Gets human approval
 * - CapabilityStore: Updates permission_set in DB
 * - PermissionAuditStore: Logs all decisions
 *
 * @example
 * ```typescript
 * const handler = new PermissionEscalationHandler(
 *   capabilityStore,
 *   auditStore,
 *   async (request) => {
 *     // Emit HIL event and wait for response
 *     return { approved: true };
 *   }
 * );
 *
 * // Handle a permission denied error
 * const result = await handler.handlePermissionError(
 *   "cap-uuid",
 *   "minimal",
 *   "PermissionDenied: Requires net access to api.example.com"
 * );
 *
 * if (result.approved) {
 *   // Retry execution with result.newPermissionSet
 * }
 * ```
 */
export class PermissionEscalationHandler {
  /** Track escalation attempts per execution to prevent infinite loops */
  private escalationAttempts: Map<string, number> = new Map();

  /** Maximum escalation retries per execution (Story 7.7c AC5) */
  private readonly MAX_ESCALATION_RETRIES = 1;

  /** User ID for audit logging (defaults to "user" for backward compatibility) */
  private userId: string = "user";

  constructor(
    private capabilityStore: CapabilityStore,
    private auditStore: PermissionAuditStore,
    private hilCallback: HILApprovalCallback,
    userId?: string,
  ) {
    this.userId = userId ?? "user";
    logger.debug("PermissionEscalationHandler initialized", { userId: this.userId });
  }

  /**
   * Update the user ID for audit logging
   *
   * @param userId - User ID to use in audit logs
   */
  setUserId(userId: string): void {
    this.userId = userId;
  }

  /**
   * Handle a permission denied error for a capability
   *
   * Full flow:
   * 1. Parse error and create escalation suggestion
   * 2. Check if escalation is allowed (valid path)
   * 3. Check approvalMode - if 'auto', skip HIL and auto-approve
   * 4. Request human approval via HIL callback (if approvalMode === 'hil')
   * 5. If approved: update capability's permission_set in DB
   * 6. Log decision to audit store
   * 7. Return result for retry decision
   *
   * @param capabilityId - UUID of the capability that failed
   * @param currentPermissionSet - Current permission set of the capability
   * @param error - Error message from sandbox execution
   * @param executionId - Optional execution ID for tracking attempts
   * @param toolConfig - Optional PermissionConfig for the tool (enables auto-approve and ffi/run)
   * @returns Escalation result with approval status and new permission set
   */
  async handlePermissionError(
    capabilityId: string,
    currentPermissionSet: PermissionSet,
    error: string,
    executionId?: string,
    toolConfig?: PermissionConfig,
  ): Promise<EscalationResult> {
    const trackingKey = executionId ?? capabilityId;

    // Check escalation attempt limit (AC5: max 1 retry per execution)
    const attempts = this.escalationAttempts.get(trackingKey) ?? 0;
    if (attempts >= this.MAX_ESCALATION_RETRIES) {
      logger.warn("Escalation retry limit reached", {
        capabilityId,
        executionId,
        attempts,
      });
      return {
        handled: false,
        approved: false,
        error:
          `Maximum escalation retries (${this.MAX_ESCALATION_RETRIES}) reached for this execution`,
      };
    }

    // Track this attempt
    this.escalationAttempts.set(trackingKey, attempts + 1);

    // Step 1: Suggest escalation based on error (pass toolConfig for ffi/run handling)
    const suggestion = suggestEscalation(error, capabilityId, currentPermissionSet, toolConfig);

    if (!suggestion) {
      logger.debug("No escalation suggestion for error", {
        capabilityId,
        error: error.substring(0, 100),
      });
      return {
        handled: false,
        approved: false,
        error: "Cannot suggest escalation for this error (unsupported permission type)",
      };
    }

    logger.info("Permission escalation suggested", {
      capabilityId,
      currentSet: currentPermissionSet,
      requestedSet: suggestion.requestedSet,
      detectedOperation: suggestion.detectedOperation,
      confidence: suggestion.confidence,
      hasToolConfig: !!toolConfig,
    });

    // Determine approval mode
    const approvalMode: ApprovalMode = toolConfig?.approvalMode ?? "hil";

    // Step 2: Check approvalMode - if 'auto', skip HIL and auto-approve
    if (approvalMode === "auto") {
      logger.info("Auto-approving permission escalation (approvalMode: auto)", {
        capabilityId,
        currentSet: currentPermissionSet,
        requestedSet: suggestion.requestedSet,
        detectedOperation: suggestion.detectedOperation,
      });

      // Log the auto-approval decision
      await this.auditStore.logEscalation({
        capabilityId,
        fromSet: currentPermissionSet,
        toSet: suggestion.requestedSet,
        approved: true,
        approvedBy: "system:auto",
        reason: error,
        detectedOperation: suggestion.detectedOperation,
      });

      // Update capability's permission_set in DB (if scope changed)
      if (suggestion.requestedSet !== currentPermissionSet) {
        try {
          await this.capabilityStore.updatePermissionSet(
            capabilityId,
            suggestion.requestedSet,
          );
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error("Failed to update permission set in DB", {
            capabilityId,
            error: errorMsg,
          });
          // Continue anyway - auto-approve should succeed
        }
      }

      return {
        handled: true,
        approved: true,
        newPermissionSet: suggestion.requestedSet,
        feedback: "auto-approved via PermissionConfig.approvalMode",
      };
    }

    // Step 3: Request human approval via HIL callback (approvalMode === 'hil')
    let hilResult: { approved: boolean; feedback?: string };
    try {
      hilResult = await this.hilCallback(suggestion);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("HIL approval request failed", {
        capabilityId,
        error: errorMsg,
      });

      // Log the failed request
      await this.auditStore.logEscalation({
        capabilityId,
        fromSet: currentPermissionSet,
        toSet: suggestion.requestedSet,
        approved: false,
        approvedBy: this.userId,
        reason: `HIL request failed: ${errorMsg}`,
        detectedOperation: suggestion.detectedOperation,
      });

      return {
        handled: true,
        approved: false,
        error: `HIL approval request failed: ${errorMsg}`,
      };
    }

    // Step 4: Log decision to audit store (always, for both approved and rejected)
    await this.auditStore.logEscalation({
      capabilityId,
      fromSet: currentPermissionSet,
      toSet: suggestion.requestedSet,
      approved: hilResult.approved,
      approvedBy: this.userId,
      reason: error,
      detectedOperation: suggestion.detectedOperation,
    });

    // Step 5: If approved, update capability's permission_set in DB
    if (hilResult.approved) {
      try {
        await this.capabilityStore.updatePermissionSet(
          capabilityId,
          suggestion.requestedSet,
        );

        logger.info("Permission escalation approved and applied", {
          capabilityId,
          fromSet: currentPermissionSet,
          toSet: suggestion.requestedSet,
        });

        return {
          handled: true,
          approved: true,
          newPermissionSet: suggestion.requestedSet,
          feedback: hilResult.feedback,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("Failed to update permission set in DB", {
          capabilityId,
          error: errorMsg,
        });

        return {
          handled: true,
          approved: false,
          error: `Failed to update permission set: ${errorMsg}`,
        };
      }
    }

    // Step 6: Escalation was rejected
    logger.info("Permission escalation rejected", {
      capabilityId,
      requestedSet: suggestion.requestedSet,
      feedback: hilResult.feedback,
    });

    return {
      handled: true,
      approved: false,
      error: hilResult.feedback ?? "Permission escalation rejected by user",
      feedback: hilResult.feedback,
    };
  }

  /**
   * Reset escalation attempt tracking for an execution
   *
   * Call this when starting a new execution to reset the retry counter.
   *
   * @param executionId - Execution ID to reset
   */
  resetAttempts(executionId: string): void {
    this.escalationAttempts.delete(executionId);
  }

  /**
   * Clear all escalation attempt tracking
   *
   * Useful for testing or when cleaning up resources.
   */
  clearAllAttempts(): void {
    this.escalationAttempts.clear();
  }

  /**
   * Get current escalation attempt count for an execution
   *
   * @param executionId - Execution ID to check
   * @returns Number of escalation attempts
   */
  getAttemptCount(executionId: string): number {
    return this.escalationAttempts.get(executionId) ?? 0;
  }
}

/**
 * Format a permission escalation request for HIL display
 *
 * Creates a human-readable summary for the decision_required event.
 * The formatted output includes all relevant information for the user
 * to make an informed decision about the escalation request.
 *
 * @param request - Permission escalation request containing:
 *   - capabilityId: UUID of the capability requesting escalation
 *   - currentSet: Current permission level (e.g., "minimal")
 *   - requestedSet: Requested permission level (e.g., "network-api")
 *   - reason: Original error message that triggered the request
 *   - detectedOperation: The Deno permission type detected (net, read, write, env)
 *   - confidence: Escalation confidence score (0-1)
 * @returns Formatted multi-line string suitable for terminal/console display
 *
 * @example
 * ```typescript
 * const request: PermissionEscalationRequest = {
 *   capabilityId: "cap-123",
 *   currentSet: "minimal",
 *   requestedSet: "network-api",
 *   reason: "PermissionDenied: Requires net access to api.example.com",
 *   detectedOperation: "net",
 *   confidence: 0.92,
 * };
 *
 * const formatted = formatEscalationRequest(request);
 * console.log(formatted);
 * // Output:
 * // === Permission Escalation Request ===
 * // Capability: cap-123
 * // Current Permission Set: minimal
 * // Requested Permission Set: network-api
 * // ...
 * ```
 */
export function formatEscalationRequest(request: PermissionEscalationRequest): string {
  return `
=== Permission Escalation Request ===

Capability: ${request.capabilityId}
Current Permission Set: ${request.currentSet}
Requested Permission Set: ${request.requestedSet}

Reason: ${request.reason}
Detected Operation: ${request.detectedOperation}
Confidence: ${(request.confidence * 100).toFixed(0)}%

This capability attempted an operation that requires additional permissions.
Approving will permanently upgrade the capability's permission set.

[A]pprove permission escalation
[R]eject and abort execution
`.trim();
}
