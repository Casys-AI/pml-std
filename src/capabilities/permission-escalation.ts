/**
 * Permission Escalation Module (Story 7.7c - HIL Permission Escalation)
 *
 * Parses Deno PermissionDenied errors and suggests appropriate permission
 * escalations for human approval.
 *
 * Note: This module detects Deno permission errors (read, write, net, env, run, ffi)
 * from error messages. The ffi/run patterns are for error DETECTION only - they're
 * not used for configuration. Worker sandbox always runs with permissions: "none".
 *
 * @module capabilities/permission-escalation
 */

import type {
  PermissionConfig,
  PermissionEscalationRequest,
  PermissionScope,
  PermissionSet,
} from "./types.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Regex patterns for parsing Deno PermissionDenied error messages
 *
 * Deno error format:
 * "PermissionDenied: Requires {permission} access to {resource}, run again with --allow-{permission}"
 */
const PERMISSION_PATTERNS = {
  read: /Requires read access to ([^\s,]+)/i,
  write: /Requires write access to ([^\s,]+)/i,
  net: /Requires net access to ([^\s,]+)/i,
  env: /Requires env access to "?([^"\s,]+)"?/i,
  run: /Requires run access to ([^\s,]+)/i,
  ffi: /Requires ffi access/i,
};

/**
 * Sandbox-escape permissions (ffi, run)
 * These are NOT hardcoded blocked anymore - they can be allowed via PermissionConfig.
 * This set is kept for detection purposes only.
 *
 * @deprecated No longer used for blocking. FFI/run now controlled via PermissionConfig.
 */
const SANDBOX_ESCAPE_PERMISSIONS = new Set(["run", "ffi"]);

/**
 * Valid escalation paths between permission scopes
 *
 * Key: current scope -> Value: allowed escalation targets
 * Note: mcp-standard is the highest auto-escalatable scope
 */
const ESCALATION_PATHS: Record<PermissionScope, PermissionScope[]> = {
  minimal: ["readonly", "filesystem", "network-api", "mcp-standard"],
  readonly: ["filesystem", "mcp-standard"],
  filesystem: ["mcp-standard"],
  "network-api": ["mcp-standard"],
  "mcp-standard": [], // Cannot escalate from mcp-standard (already highest)
};

// Legacy escalation paths including 'trusted' - kept as comment for documentation
// const ESCALATION_PATHS_LEGACY: Record<PermissionSet, PermissionSet[]> = {
//   ...ESCALATION_PATHS,
//   trusted: [], // trusted is deprecated, use PermissionConfig with approvalMode: auto
// };

/**
 * Maps detected operations to suggested permission scopes
 */
const OPERATION_TO_SCOPE: Record<string, PermissionScope> = {
  read: "readonly",
  write: "filesystem",
  net: "network-api",
  env: "mcp-standard",
};

// Maps detected operations to suggested permission sets (legacy) - kept as comment
// const OPERATION_TO_PERMISSION: Record<string, PermissionSet> = OPERATION_TO_SCOPE;

/**
 * Suggests an appropriate permission escalation for a Deno PermissionDenied error
 *
 * Refactored to support 3-axis permission model:
 * - Scope escalation (minimal → readonly → filesystem → mcp-standard)
 * - FFI/run are now independent flags, handled separately
 *
 * @param error - Error message from Deno sandbox (e.g., "PermissionDenied: Requires read access to /etc/passwd")
 * @param capabilityId - UUID of the capability that failed
 * @param currentSet - Current permission set of the capability (legacy) or scope
 * @param toolConfig - Optional PermissionConfig for the tool (allows ffi/run if declared)
 * @returns PermissionEscalationRequest if escalation is possible, null otherwise
 *
 * @example
 * ```typescript
 * // Scope escalation
 * const suggestion = suggestEscalation(
 *   "PermissionDenied: Requires net access to api.example.com:443",
 *   "cap-uuid",
 *   "minimal"
 * );
 * // Returns: { requestedSet: "network-api", detectedOperation: "net", ... }
 *
 * // FFI escalation (now allowed if tool declares it)
 * const ffiSuggestion = suggestEscalation(
 *   "PermissionDenied: Requires ffi access",
 *   "cap-uuid",
 *   "minimal",
 *   { scope: "minimal", ffi: true, run: false, approvalMode: "auto" }
 * );
 * // Returns: escalation request (not blocked anymore!)
 * ```
 */
export function suggestEscalation(
  error: string,
  capabilityId: string,
  currentSet: PermissionSet,
  toolConfig?: PermissionConfig,
): PermissionEscalationRequest | null {
  // Check if this is a permission error at all
  if (!error.includes("PermissionDenied") && !error.includes("Requires")) {
    logger.debug("Not a permission error, skipping escalation suggestion", {
      error: error.substring(0, 100),
    });
    return null;
  }

  // Try to match each permission pattern
  let detectedOperation: string | null = null;
  let resource: string | null = null;

  for (const [permission, pattern] of Object.entries(PERMISSION_PATTERNS)) {
    const match = error.match(pattern);
    if (match) {
      detectedOperation = permission;
      resource = match[1] || null;
      break;
    }
  }

  if (!detectedOperation) {
    logger.debug("Could not parse permission type from error", {
      error: error.substring(0, 100),
    });
    return null;
  }

  // Handle sandbox-escape permissions (ffi, run)
  // Note: With WorkerBridge architecture, MCP tools execute in main process,
  // so sandbox-escape permissions are typically not needed. This code path
  // exists for legacy compatibility and edge cases.
  if (SANDBOX_ESCAPE_PERMISSIONS.has(detectedOperation)) {
    // Sandbox-escape permission needs explicit approval via HIL
    logger.warn("Sandbox-escape permission needs explicit approval", {
      capabilityId,
      detectedOperation,
      error: error.substring(0, 100),
      hasToolConfig: !!toolConfig,
    });

    // Return escalation request for HIL to handle
    const request: PermissionEscalationRequest = {
      capabilityId,
      currentSet,
      requestedSet: currentSet, // Keep same scope
      reason: error,
      detectedOperation,
      confidence: 0.5, // Lower confidence - not explicitly declared
    };
    return request;
  }

  // Determine suggested permission scope
  const suggestedScope = OPERATION_TO_SCOPE[detectedOperation];
  if (!suggestedScope) {
    logger.debug("No permission scope mapping for operation", {
      detectedOperation,
    });
    return null;
  }

  // Get current scope (handle legacy 'trusted' value)
  const currentScope: PermissionScope = currentSet === "trusted" ? "mcp-standard" : currentSet;

  // Check if escalation path is valid
  const allowedTargets = ESCALATION_PATHS[currentScope];
  if (!allowedTargets?.includes(suggestedScope)) {
    // Try to find the minimal valid escalation that includes this capability
    const validEscalation = findValidEscalation(currentScope, detectedOperation);
    if (!validEscalation) {
      logger.debug("No valid escalation path found", {
        currentSet,
        currentScope,
        suggestedScope,
        detectedOperation,
      });
      return null;
    }

    // Use the valid escalation target
    const request: PermissionEscalationRequest = {
      capabilityId,
      currentSet,
      requestedSet: validEscalation,
      reason: error,
      detectedOperation,
      confidence: calculateConfidence(detectedOperation, resource),
    };

    logger.info("Permission escalation suggested (via valid path)", {
      capabilityId,
      currentSet,
      requestedSet: validEscalation,
      detectedOperation,
      confidence: request.confidence,
    });

    return request;
  }

  // Build escalation request
  const request: PermissionEscalationRequest = {
    capabilityId,
    currentSet,
    requestedSet: suggestedScope,
    reason: error,
    detectedOperation,
    confidence: calculateConfidence(detectedOperation, resource),
  };

  logger.info("Permission escalation suggested", {
    capabilityId,
    currentSet,
    requestedSet: suggestedScope,
    detectedOperation,
    confidence: request.confidence,
  });

  return request;
}

/**
 * Finds a valid escalation target given current scope and required operation
 *
 * Example: if current="readonly" and we need "net", we escalate to "mcp-standard"
 * which includes both filesystem (from readonly) and network capabilities.
 */
function findValidEscalation(
  currentScope: PermissionScope,
  detectedOperation: string,
): PermissionScope | null {
  const requiredScope = OPERATION_TO_SCOPE[detectedOperation];
  if (!requiredScope) return null;

  const allowedTargets = ESCALATION_PATHS[currentScope];
  if (!allowedTargets) return null;

  // First try direct escalation
  if (allowedTargets.includes(requiredScope)) {
    return requiredScope;
  }

  // If direct escalation not available, find a scope that includes the capability
  // Priority: prefer minimal escalation that includes the required capability
  const escalationOrder: PermissionScope[] = [
    "readonly",
    "filesystem",
    "network-api",
    "mcp-standard",
  ];

  for (const target of escalationOrder) {
    if (!allowedTargets.includes(target)) continue;

    // Check if this target provides the required capability
    if (targetProvidesCapability(target, detectedOperation)) {
      return target;
    }
  }

  return null;
}

/**
 * Checks if a permission scope provides a specific capability
 *
 * Note: 'trusted' is deprecated but still handled for backward compatibility.
 * In the new model, 'trusted' maps to 'mcp-standard' + approvalMode: 'auto'.
 */
function targetProvidesCapability(
  target: PermissionScope | PermissionSet,
  operation: string,
): boolean {
  switch (operation) {
    case "read":
      return ["readonly", "filesystem", "mcp-standard", "trusted"].includes(target);
    case "write":
      return ["filesystem", "mcp-standard", "trusted"].includes(target);
    case "net":
      return ["network-api", "mcp-standard", "trusted"].includes(target);
    case "env":
      return ["mcp-standard", "trusted"].includes(target);
    // FFI and run are now independent flags - not tied to scope
    case "ffi":
    case "run":
      // These depend on PermissionConfig.ffi/run, not scope
      // Always return false here - handled separately in suggestEscalation
      return false;
    default:
      return false;
  }
}

/**
 * Calculates confidence score for an escalation suggestion
 *
 * Higher confidence when:
 * - Specific resource path is provided (vs general)
 * - Common operation patterns are detected
 *
 * @param operation - Detected operation type
 * @param resource - Resource path/URL (if available)
 * @returns Confidence score (0-1)
 */
function calculateConfidence(
  operation: string,
  resource: string | null,
): number {
  let confidence = 0.7; // Base confidence

  // Boost confidence for specific resource paths
  if (resource) {
    confidence += 0.15;

    // Further boost for well-known patterns
    if (operation === "net") {
      // Common API patterns
      if (resource.includes("api.") || resource.includes(":443") || resource.includes("https")) {
        confidence += 0.1;
      }
    } else if (operation === "read" || operation === "write") {
      // Specific file paths are more trustworthy
      if (resource.startsWith("/") || resource.includes(".")) {
        confidence += 0.05;
      }
    }
  }

  // Cap at 0.95 (never 100% confident)
  return Math.min(confidence, 0.95);
}

/**
 * Checks if an escalation from one permission scope to another is valid
 *
 * @param from - Current permission scope
 * @param to - Target permission scope
 * @returns true if escalation is allowed
 */
export function isValidEscalation(
  from: PermissionScope | PermissionSet,
  to: PermissionScope | PermissionSet,
): boolean {
  // 'trusted' cannot be escalated TO (it's manual-only / deprecated)
  if (to === "trusted") {
    return false;
  }
  // Handle legacy 'trusted' value for 'from'
  const fromScope: PermissionScope = from === "trusted" ? "mcp-standard" : from as PermissionScope;
  const toScope: PermissionScope = to as PermissionScope;
  return ESCALATION_PATHS[fromScope]?.includes(toScope) ?? false;
}

/**
 * Gets all valid escalation targets for a permission scope
 *
 * @param currentSet - Current permission scope
 * @returns Array of valid target permission scopes
 */
export function getValidEscalationTargets(
  currentSet: PermissionScope | PermissionSet,
): PermissionScope[] {
  // Handle legacy 'trusted' value
  const scope: PermissionScope = currentSet === "trusted"
    ? "mcp-standard"
    : currentSet as PermissionScope;
  return [...(ESCALATION_PATHS[scope] || [])];
}

/**
 * Checks if an operation type is a sandbox-escape permission (ffi, run)
 *
 * Note: This no longer means "cannot be escalated". These operations CAN be
 * allowed if the tool's PermissionConfig declares them. This function is
 * for detection purposes only.
 *
 * @param operation - Operation type (e.g., "run", "ffi")
 * @returns true if operation is a sandbox-escape permission
 *
 * @deprecated Use `isSandboxEscapePermission` for clarity
 */
export function isSecurityCritical(operation: string): boolean {
  return SANDBOX_ESCAPE_PERMISSIONS.has(operation);
}

/**
 * Checks if an operation type is a sandbox-escape permission (ffi, run)
 *
 * These operations CAN be allowed if the tool's PermissionConfig declares them.
 * This function is for detection purposes only.
 *
 * @param operation - Operation type (e.g., "run", "ffi")
 * @returns true if operation is a sandbox-escape permission
 */
export function isSandboxEscapePermission(operation: string): boolean {
  return SANDBOX_ESCAPE_PERMISSIONS.has(operation);
}
