/**
 * Permissions Module Exports
 *
 * Re-exports permission escalation functionality.
 *
 * @module dag/permissions
 */

export { isPermissionError } from "./escalation-integration.ts";

// Layer-level escalation handling (extracted from controlled-executor.ts)
export {
  prepareEscalations,
  processEscalationResponses,
  getPermissionSuggestion,
  type EscalationPreparation,
  type EscalationEntry,
} from "./layer-escalation.ts";
