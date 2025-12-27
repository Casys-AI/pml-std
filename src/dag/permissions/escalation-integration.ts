/**
 * Permission Escalation Integration Module
 *
 * Integrates permission escalation with HIL approval flow.
 * Handles PermissionDenied errors and routes to human approval.
 *
 * @module dag/permissions/escalation-integration
 */

import type { PermissionSet } from "../../capabilities/types.ts";
import { formatEscalationRequest } from "../../capabilities/permission-escalation-handler.ts";
import { suggestEscalation } from "../../capabilities/permission-escalation.ts";

/**
 * Result of handling a permission error
 */
export interface PermissionErrorResult {
  /** Whether the error was handled (escalation attempted) */
  handled: boolean;
  /** Whether escalation was approved (if handled) */
  approved?: boolean;
  /** New permission set (if approved) */
  newPermissionSet?: PermissionSet;
  /** Error message (if not handled or rejected) */
  error?: string;
  /** User feedback (if rejected) */
  feedback?: string;
}

/**
 * Check if an error message indicates a permission error
 *
 * @param errorMessage - Error message to check
 * @returns true if this is a permission-related error
 */
export function isPermissionError(errorMessage: string): boolean {
  return (
    errorMessage.includes("PermissionError") ||
    errorMessage.includes("PermissionDenied") ||
    errorMessage.includes("NotCapable")
  );
}

// Re-export for convenience
export { formatEscalationRequest, suggestEscalation };
