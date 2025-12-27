/**
 * Events Module - Unified Event Distribution for Casys PML
 * Story 6.5: EventBus with BroadcastChannel (ADR-036)
 *
 * @module events
 */

// Core EventBus
export { EventBus, eventBus, PML_EVENTS_CHANNEL, PML_TRACES_CHANNEL } from "./event-bus.ts";

// All event types and payloads
export type {
  // Algorithm event payloads (Story 7.6 preparation)
  AlgorithmAnomalyPayload,
  AlgorithmFeedbackPayload,
  // Typed events
  AlgorithmScoredEvent,
  AlgorithmScoredPayload,
  AlgorithmSuggestedPayload,
  CapabilityEndEvent,
  // Capability event payloads
  CapabilityEndPayload,
  CapabilityLearnedEvent,
  CapabilityLearnedPayload,
  CapabilityMatchedEvent,
  CapabilityMatchedPayload,
  CapabilityStartEvent,
  CapabilityStartPayload,
  DagCompletedEvent,
  // DAG event payloads
  DagCompletedPayload,
  DagReplannedPayload,
  DagStartedEvent,
  DagStartedPayload,
  DagTaskCompletedPayload,
  DagTaskFailedPayload,
  DagTaskStartedPayload,
  EventHandler,
  EventType,
  // Graph event payloads
  GraphEdgeCreatedPayload,
  GraphEdgeUpdatedPayload,
  GraphSyncedEvent,
  GraphSyncedPayload,
  // System event payloads
  HealthCheckPayload,
  HeartbeatPayload,
  MetricsSnapshotPayload,
  PmlEvent,
  ThresholdAdjustedPayload,
  ToolEndEvent,
  // Tool event payloads
  ToolEndPayload,
  ToolStartEvent,
  ToolStartPayload,
  WildcardEventHandler,
} from "./types.ts";
