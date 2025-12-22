/**
 * Capabilities Module (Epic 7 - Emergent Capabilities & Learning)
 *
 * Provides capability storage, hashing, and retrieval for learned code patterns.
 *
 * @module capabilities
 */

export { CapabilityStore } from "./capability-store.ts";
export { ExecutionTraceStore } from "./execution-trace-store.ts";
export type { SaveTraceInput } from "./execution-trace-store.ts";
export { CapabilityMatcher } from "./matcher.ts";
export { SchemaInferrer } from "./schema-inferrer.ts";
export { StaticStructureBuilder } from "./static-structure-builder.ts";
export { PermissionInferrer, getToolPermissionConfig } from "./permission-inferrer.ts";
export type { InferredPermissions, DetectedPattern, PatternCategory } from "./permission-inferrer.ts";
export { CapabilityCodeGenerator } from "./code-generator.ts";
export { CapabilityExecutor } from "./executor.ts";
export { CapabilityDataService } from "./data-service.ts";
export { HypergraphBuilder } from "./hypergraph-builder.ts";
export type { HypergraphResult } from "./hypergraph-builder.ts";
// Story 7.7c: Permission escalation
export {
  suggestEscalation,
  isValidEscalation,
  getValidEscalationTargets,
  isSecurityCritical,
} from "./permission-escalation.ts";
export { PermissionAuditStore } from "./permission-audit-store.ts";
export type { LogEscalationInput, AuditLogFilters } from "./permission-audit-store.ts";
export {
  PermissionEscalationHandler,
  formatEscalationRequest,
} from "./permission-escalation-handler.ts";
export type { EscalationResult, HILApprovalCallback } from "./permission-escalation-handler.ts";
// Note: hashCodeSync is intentionally not exported - it uses djb2 (32-bit)
// which has higher collision probability. Use hashCode (SHA-256) for production.
export { hashCode, normalizeCode } from "./hash.ts";
// Story 11.2: Default priority constant for cold start traces
export { DEFAULT_TRACE_PRIORITY } from "./types.ts";
export type {
  ArgumentsStructure, // Story 10.2 - Argument extraction for speculative execution
  ArgumentValue, // Story 10.2 - Single argument resolution strategy
  CacheConfig,
  Capability,
  CapabilityFilters,
  CapabilityListResponseInternal,
  CapabilityMatch,
  CapabilityResponseInternal,
  CapabilitySearchResult,
  CapabilityZone, // Story 8.2 - Hull zone metadata
  CytoscapeEdge, // @deprecated - use GraphEdge
  CytoscapeNode, // @deprecated - use GraphNode
  GraphEdge,
  GraphNode,
  HypergraphOptions,
  HypergraphResponseInternal,
  JSONSchema,
  PermissionAuditLogEntry, // Story 7.7c - Permission escalation audit
  PermissionConfig, // Story 10.1 - For getToolPermissionConfig return type
  PermissionEscalationRequest, // Story 7.7c - HIL permission escalation
  PermissionSet, // Story 7.7a - Permission set profiles
  ProvidesCoverage, // Story 10.1 - Static structure coverage
  SaveCapabilityInput,
  StaticStructure, // Story 10.1 - Static code analysis
  StaticStructureEdge, // Story 10.1 - Static structure edges
  StaticStructureNode, // Story 10.1 - Static structure nodes
  // Story 11.2 - Execution traces
  ExecutionTrace,
  BranchDecision,
  TraceTaskResult,
} from "./types.ts";
