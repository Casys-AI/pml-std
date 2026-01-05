# Story 6.5: EventBus with BroadcastChannel

> **Epic:** 6 - Real-time Graph Monitoring & Observability **ADRs:** ADR-036 (BroadcastChannel for
> Event Distribution) **Prerequisites:** Story 7.3b (Capability Injection with BroadcastChannel
> tracing - DONE) **Status:** Done ✅

## User Story

As a dashboard user, I want all system events (tools, DAG, graph, capabilities) streamed in
real-time via a unified EventBus, So that I can monitor execution live without polling.

## Problem Context

### Current State (After Story 7.3b)

Story 7.3b introduced BroadcastChannel for capability traces:

- `capability_start` / `capability_end` → BroadcastChannel `"agentcards-traces"`
- Pattern validated for cross-worker communication
- WorkerBridge already receives traces via BroadcastChannel (`src/sandbox/worker-bridge.ts:99-119`)

**BUT:** Other event sources still use different mechanisms:

- Tool traces (`tool_start/end`) → batched in WorkerBridge internal array
- Graph events → EventTarget in GraphRAGEngine (`src/graphrag/events.ts`)
- SSE events → EventsStreamManager subscribes to GraphRAGEngine only (`src/server/events-stream.ts`)
- DAG events → SSE streaming via StreamingExecutor (`src/dag/streaming.ts`)

### Problems

1. **Inconsistent patterns:** Each component has its own event emission mechanism
2. **Tight coupling:** EventsStreamManager must know about GraphRAGEngine directly
3. **No centralization:** Difficult to add new consumers (metrics, webhooks, etc.)
4. **Partial real-time:** Only capability traces are real-time via BroadcastChannel

### Solution: Unified EventBus

Migrate all event sources to a single BroadcastChannel-based EventBus per ADR-036.

---

## Architecture

### Target Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    BroadcastChannel: "agentcards-events"                      │
└──────────────────────────────────────────────────────────────────────────────┘
                                    ▲
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
   ┌────┴────────┐           ┌──────┴──────┐            ┌───────┴───────┐
   │ SandboxWorker│           │ WorkerBridge │            │  DAG Executor │
   │              │           │              │            │               │
   │ capability_* │           │ tool.*       │            │ dag.*         │
   │ (from 7.3b)  │           │ (MIGRATE)    │            │ (MIGRATE)     │
   └──────────────┘           └──────────────┘            └───────────────┘
        │                           │                           │
   ┌────┴────────┐           ┌──────┴──────┐            ┌───────┴───────┐
   │GraphRAGEngine│           │CapabilityStore│           │ Health/System │
   │              │           │              │            │               │
   │ graph.*      │           │ capability.* │            │ health.*      │
   │ (MIGRATE)    │           │ (NEW)        │            │ metrics.*     │
   └──────────────┘           └──────────────┘            └───────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                    BroadcastChannel: "agentcards-events"                      │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
   ┌────┴────────┐           ┌──────┴──────┐            ┌───────┴───────┐
   │ SSE Handler  │           │   Metrics   │            │    Future     │
   │ → Dashboard  │           │  Collector  │            │   Webhooks    │
   └──────────────┘           └──────────────┘            └───────────────┘
```

### Key Design Decisions

1. **Single BroadcastChannel:** `"agentcards-events"` for all event types (recommended over multiple
   channels)
2. **Singleton pattern:** One EventBus instance per process
3. **Local dispatch:** Events emitted locally AND via BroadcastChannel for immediate local handlers
4. **Backward compatibility:** Keep existing APIs where possible (`getTraces()`, `on()/off()`)
5. **Type safety:** Comprehensive EventType union for strong typing
6. **Payload types:** Prepare algorithm event payloads for Story 7.6 integration

---

## Acceptance Criteria

### AC1: EventBus Singleton Created ✅

- [x] File `src/events/event-bus.ts` created
- [x] Class `EventBus` with singleton pattern
- [x] Uses BroadcastChannel `"pml-events"` (renamed from agentcards-events)
- [x] Methods:
  - `emit(event: CaiEvent): void`
  - `on(type: EventType | "*", handler): () => void` (returns unsubscribe)
  - `close(): void`
- [x] Local dispatch + BroadcastChannel dispatch (same-process + cross-process)

### AC2: Event Types Defined ✅

- [x] File `src/events/types.ts` created
- [x] `CaiEvent` interface (renamed from Casys PMLEvent):
  ```typescript
  interface CaiEvent {
    type: EventType;
    timestamp: number;
    source: string;
    payload: unknown;
  }
  ```
- [x] `EventType` union covers all event types (see Dev Notes for complete list)

### AC3: WorkerBridge Migration ✅

- [x] `tool.start` / `tool.end` emitted via EventBus (not just internal array)
- [x] Existing `getTraces()` still works (backward compatibility)
- [x] Real-time emission during RPC handling
- [x] Bridge `pml-traces` channel to unified EventBus

### AC4: DAG Executor Migration ✅

- [x] `dag.started` emitted when DAG execution begins
- [x] `dag.task.started` / `dag.task.completed` / `dag.task.failed` for each task
- [x] `dag.completed` emitted when DAG finishes
- [x] Kept backward compat (no direct SSE emission was present)

### AC5: GraphRAGEngine Migration ✅

- [x] EventTarget events bridged to EventBus via `emitToEventBus()` method
- [x] `graph.synced` on `syncFromDatabase()`
- [x] `graph.edge.created` / `graph.edge.updated` on edge changes
- [x] Backward compatibility: existing `on()` / `off()` still work in parallel

### AC6: CapabilityStore Events ✅

- [x] `capability.learned` when new capability saved
- [x] `capability.matched` when capability matched to intent (in matcher.ts)

### AC7: SSE Handler Refactored ✅

- [x] Subscribe to EventBus instead of managing sources directly
- [x] `eventBus.on("*", ...)` for all events
- [x] Filter events server-side based on query params
- [x] Simplified code (no more direct coupling to GraphRAGEngine)

### AC8: Metrics Collector Created ✅

- [x] File `src/telemetry/metrics-collector.ts` created
- [x] Subscribes to EventBus for metrics aggregation
- [x] Counts: tool calls, capabilities learned, dag tasks, graph events
- [x] Histograms: tool call duration, dag task duration, dag execution duration

### AC9: Capability Traces Migration (from 7.3b) ✅

- [x] `capability.start` / `capability.end` forwarded to EventBus
- [x] Separate channel `"pml-traces"` bridged into main EventBus (in WorkerBridge)
- [x] Consistent event format with other events

### AC10: Tests ✅

- [x] Unit tests for EventBus (21 tests: emit, subscribe, unsubscribe, wildcard)
- [x] Unit tests for MetricsCollector (10 tests)
- [x] Unit tests for SSE Handler (9 tests)
- [x] Performance: <1ms overhead per event emission (benchmark included)

### AC11: Algorithm Event Payloads (Preparation for Story 7.6) ✅

- [x] Define typed payloads for algorithm events (AlgorithmScoredPayload, etc.)
- [x] Export payload types from `src/events/types.ts`
- [x] Story 7.6 will use these types for AlgorithmTracer

### AC12: Dashboard Event Filtering ✅

- [x] SSE endpoint supports `?filter=` query param
- [x] Filter syntax: `?filter=algorithm.*,dag.*` (comma-separated prefixes)
- [x] Unfiltered returns all events (default)
- [x] Dashboard can subscribe to specific event categories

---

## Tasks / Subtasks

- [x] **Task 1: Create EventBus Core** (AC: #1, #2, #11)
  - [x] 1.1 Create `src/events/types.ts` with all event types (~582 LOC)
  - [x] 1.2 Create `src/events/event-bus.ts` with EventBus singleton class (~200 LOC)
  - [x] 1.3 Implement BroadcastChannel + local dispatch pattern
  - [x] 1.4 Create `src/events/mod.ts` exports
  - [x] 1.5 Define algorithm event payloads for Story 7.6

- [x] **Task 2: Migrate WorkerBridge** (AC: #3, #9)
  - [x] 2.1 Import EventBus in `src/sandbox/worker-bridge.ts`
  - [x] 2.2 Emit `tool.start` / `tool.end` during RPC handling
  - [x] 2.3 Bridge `pml-traces` channel events to unified EventBus
  - [x] 2.4 Keep `getTraces()` working (backward compat)
  - [x] 2.5 Tests maintained (existing tests still pass)

- [x] **Task 3: Migrate DAG Executor** (AC: #4)
  - [x] 3.1 Import EventBus in `src/dag/executor.ts`
  - [x] 3.2 Emit `dag.*` events at appropriate points
  - [x] 3.3 EventBus emission in ParallelExecutor
  - [x] 3.4 Kept backward compat with existing result structure
  - [x] 3.5 Tests pass

- [x] **Task 4: Migrate GraphRAGEngine** (AC: #5)
  - [x] 4.1 Import EventBus in `src/graphrag/graph-engine.ts`
  - [x] 4.2 Added `emitToEventBus()` method bridging legacy GraphEvent to CaiEvent
  - [x] 4.3 Emit `graph.synced`, `graph.edge.created`, `graph.edge.updated`
  - [x] 4.4 Kept legacy `on()` / `off()` for backward compat, EventBus added in parallel

- [x] **Task 5: Add CapabilityStore Events** (AC: #6)
  - [x] 5.1 Import EventBus in `src/capabilities/capability-store.ts`
  - [x] 5.2 Emit `capability.learned` in `saveCapability()`
  - [x] 5.3 Emit `capability.matched` in `src/capabilities/matcher.ts`

- [x] **Task 6: Refactor SSE Handler** (AC: #7, #12)
  - [x] 6.1 Refactor `src/server/events-stream.ts` (EventsStreamManager)
  - [x] 6.2 Remove direct GraphRAGEngine subscription
  - [x] 6.3 Subscribe to EventBus `"*"` for all events
  - [x] 6.4 Add optional `?filter=` query param support
  - [x] 6.5 Stream events to connected clients

- [x] **Task 7: Create Metrics Collector** (AC: #8)
  - [x] 7.1 Create `src/telemetry/metrics-collector.ts` (~320 LOC)
  - [x] 7.2 Subscribe to relevant events (tool._, capability._, dag._, graph._)
  - [x] 7.3 Aggregate counts and histograms
  - [x] 7.4 Expose via `getMetrics()` and `toPrometheusFormat()` methods

- [x] **Task 8: Tests** (AC: #10)
  - [x] 8.1 Create `tests/unit/events/event_bus_test.ts` (21 tests)
  - [x] 8.2 Create `tests/unit/telemetry/metrics_collector_test.ts` (10 tests)
  - [x] 8.3 Update `tests/unit/server/events_stream_test.ts` (9 tests)
  - [x] 8.4 Performance benchmark included (<1ms per emit verified)

---

## Dev Notes

### Critical Implementation Details

#### 1. EventBus Singleton Implementation

```typescript
// src/events/event-bus.ts
const CHANNEL_NAME = "agentcards-events";

class EventBus {
  private channel: BroadcastChannel;
  private handlers: Map<string, Set<(event: Casys PMLEvent) => void>> = new Map();

  constructor() {
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (e) => this.dispatch(e.data);
  }

  emit(event: Omit<Casys PMLEvent, "timestamp">): void {
    const fullEvent: Casys PMLEvent = {
      ...event,
      timestamp: Date.now(),
    };
    // Broadcast to other contexts (workers, tabs)
    this.channel.postMessage(fullEvent);
    // Also dispatch locally for same-process handlers
    this.dispatch(fullEvent);
  }

  on(type: EventType | "*", handler: (event: Casys PMLEvent) => void): () => void {
    const handlers = this.handlers.get(type) ?? new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    // Return unsubscribe function
    return () => handlers.delete(handler);
  }

  private dispatch(event: Casys PMLEvent): void {
    // Specific handlers
    this.handlers.get(event.type)?.forEach((h) => h(event));
    // Wildcard handlers
    this.handlers.get("*")?.forEach((h) => h(event));
  }

  close(): void {
    this.channel.close();
    this.handlers.clear();
  }
}

// Singleton export
export const eventBus = new EventBus();
```

#### 2. Complete Event Type Definitions

```typescript
// src/events/types.ts

export type EventType =
  // ══════════════════════════════════════════════════════════
  // EXECUTION EVENTS (real-time tracing)
  // ══════════════════════════════════════════════════════════
  | "tool.start"
  | "tool.end"
  | "capability.start"
  | "capability.end"
  | "dag.started"
  | "dag.task.started"
  | "dag.task.completed"
  | "dag.task.failed"
  | "dag.completed"
  | "dag.replanned"              // AIL/HIL replan event

  // ══════════════════════════════════════════════════════════
  // SPECULATION EVENTS (Epic 3.5)
  // ══════════════════════════════════════════════════════════
  | "speculation.started"
  | "speculation.committed"
  | "speculation.rolledback"

  // ══════════════════════════════════════════════════════════
  // ALGORITHM EVENTS (ADR-039 - Story 7.6)
  // ══════════════════════════════════════════════════════════
  | "algorithm.scored"
  | "algorithm.suggested"
  | "algorithm.filtered"
  | "algorithm.feedback.selected"
  | "algorithm.feedback.ignored"
  | "algorithm.feedback.rejected"
  | "algorithm.threshold.adjusted"
  | "algorithm.anomaly.detected"

  // ══════════════════════════════════════════════════════════
  // LEARNING EVENTS (Epic 7)
  // ══════════════════════════════════════════════════════════
  | "capability.learned"
  | "capability.matched"
  | "capability.executed"
  | "capability.pruned"
  | "learning.pattern.detected"
  | "learning.edge.strengthened"
  | "cache.hit"
  | "cache.miss"
  | "cache.invalidated"

  // ══════════════════════════════════════════════════════════
  // GRAPH EVENTS (GraphRAG)
  // ══════════════════════════════════════════════════════════
  | "graph.synced"
  | "graph.edge.created"
  | "graph.edge.updated"
  | "graph.metrics.computed"
  | "graph.community.detected"

  // ══════════════════════════════════════════════════════════
  // SEARCH EVENTS
  // ══════════════════════════════════════════════════════════
  | "search.started"
  | "search.completed"
  | "search.hybrid.reranked"

  // ══════════════════════════════════════════════════════════
  // SYSTEM EVENTS
  // ══════════════════════════════════════════════════════════
  | "health.check"
  | "metrics.snapshot"
  | "system.startup"
  | "system.shutdown";

export interface Casys PMLEvent {
  type: EventType;
  timestamp: number;
  source: string;
  payload: unknown;
}

// Algorithm Event Payloads (for Story 7.6)
export interface AlgorithmScoredPayload {
  item_id: string;
  item_type: "tool" | "capability";
  intent?: string;
  signals: {
    semantic_score?: number;
    graph_score?: number;
    success_rate?: number;
    pagerank?: number;
  };
  final_score: number;
  threshold: number;
  decision: "accepted" | "filtered";
}

export interface AlgorithmFeedbackPayload {
  suggestion_id: string;
  action: "selected" | "ignored" | "rejected";
  time_to_action_ms?: number;
}

export interface ThresholdAdjustedPayload {
  context_hash: string;
  old_value: number;
  new_value: number;
  reason: "success_feedback" | "failure_feedback" | "decay";
}
```

#### 3. BroadcastChannel Trace Bridge (from Story 7.3b)

```typescript
// In WorkerBridge - bridge existing capability traces to unified EventBus
// Pattern already in src/sandbox/worker-bridge.ts:99-119

// Existing code (from 7.3b):
this.traceChannel = new BroadcastChannel("agentcards-traces");
this.traceChannel.onmessage = (e: MessageEvent<CapabilityTraceEvent>) => {
  this.traces.push(e.data);
};

// Story 6.5 addition: Forward to unified EventBus
import { eventBus } from "../events/event-bus.ts";

this.traceChannel.onmessage = (e: MessageEvent<CapabilityTraceEvent>) => {
  this.traces.push(e.data); // Keep backward compat

  // Forward to unified EventBus
  eventBus.emit({
    type: e.data.type === "capability_start" ? "capability.start" : "capability.end",
    source: "sandbox-worker",
    payload: e.data,
  });
};
```

#### 4. SSE Handler with EventBus

```typescript
// src/server/events-stream.ts - Updated
import { eventBus } from "../events/event-bus.ts";

export class EventsStreamManager {
  private unsubscribe: (() => void) | null = null;

  constructor(config: EventsStreamConfig = DEFAULT_CONFIG) {
    // Subscribe to EventBus instead of GraphRAGEngine
    this.unsubscribe = eventBus.on("*", (event) => {
      this.broadcastEvent({
        type: event.type,
        data: event.payload,
      });
    });

    this.startHeartbeat();
  }

  handleRequest(request: Request): Response {
    // Parse optional filter param
    const url = new URL(request.url);
    const filterParam = url.searchParams.get("filter");
    const filters = filterParam?.split(",").map((f) => f.trim()) ?? [];

    // ... rest of handler with optional filtering
  }

  close(): void {
    this.unsubscribe?.();
    // ... rest of cleanup
  }
}
```

### Migration Strategy

1. **Add EventBus emissions first** (don't remove old code)
2. **Verify events flow** to SSE/Dashboard
3. **Then remove old code** once validated
4. **Keep backward compat** where needed (getTraces, on/off, etc.)

### Channel Strategy

**Recommended (Option A):** Single channel `"agentcards-events"`

- All events go through same channel
- Simpler architecture
- Filter by `event.type` in consumers

**Alternative (Option B):** Multiple channels

- `"agentcards-traces"` for tool/capability traces (already exists from 7.3b)
- `"agentcards-events"` for other events
- More complex, requires bridging

### Project Structure Notes

**Files to Create:**

```
src/events/
├── types.ts          # NEW: Event type definitions (~200 LOC)
├── event-bus.ts      # NEW: EventBus singleton (~100 LOC)
└── mod.ts            # NEW: Module exports

src/telemetry/
└── metrics-collector.ts  # NEW: Metrics aggregation (~150 LOC)

tests/
├── unit/events/
│   └── event_bus_test.ts     # NEW: Unit tests
└── integration/
    └── event_flow_test.ts    # NEW: Integration tests
```

**Files to Modify:**

```
src/sandbox/
└── worker-bridge.ts     # MODIFY: Emit tool.* via EventBus, bridge traces

src/dag/
├── executor.ts          # MODIFY: Emit dag.* events
├── controlled-executor.ts  # MODIFY: Emit dag.* events
└── streaming.ts         # MODIFY: Emit via EventBus

src/graphrag/
└── graph-engine.ts      # MODIFY: Emit graph.* via EventBus

src/capabilities/
├── capability-store.ts  # MODIFY: Emit capability.learned
└── matcher.ts           # MODIFY: Emit capability.matched

src/server/
└── events-stream.ts     # MODIFY: Subscribe to EventBus
```

### Existing Code Patterns to Follow

**WorkerBridge BroadcastChannel** (`src/sandbox/worker-bridge.ts:99-119`):

```typescript
// Story 7.3b pattern - already using BroadcastChannel
this.traceChannel = new BroadcastChannel("agentcards-traces");
this.traceChannel.onmessage = (e: MessageEvent<CapabilityTraceEvent>) => {
  this.traces.push(e.data);
};
```

**EventsStreamManager** (`src/server/events-stream.ts:47-63`):

```typescript
// Current pattern - subscribes to GraphRAGEngine
constructor(
  private graphEngine: GraphRAGEngine,
  private config: EventsStreamConfig = DEFAULT_CONFIG,
) {
  this.graphEventListener = this.broadcastEvent.bind(this);
  this.graphEngine.on("graph_event", this.graphEventListener);
  this.startHeartbeat();
}
```

**GraphRAG Events** (`src/graphrag/events.ts`):

- Currently uses `EventTarget` pattern
- Will be replaced/augmented with EventBus

### Testing Standards (from Story 6.4)

- **Pattern:** 11+ unit tests per major component
- **Coverage:** Target >80%
- **Performance:** <10ms latency for operations
- **Test file locations:** `tests/unit/events/`, `tests/integration/`

### Performance Requirements

- **Event emission:** <1ms overhead per `emit()` call
- **Multi-subscriber:** Support 10+ concurrent subscribers without degradation
- **Cross-worker latency:** <5ms for BroadcastChannel message delivery
- **Memory:** Cleanup handlers properly on unsubscribe (no memory leaks)

---

## Previous Story Intelligence

### From Story 7.3b (Capability Injection with BroadcastChannel)

- **What worked:** BroadcastChannel pattern validated for cross-worker communication
- **Pattern established:** `new BroadcastChannel("agentcards-traces")` for real-time trace
  collection
- **Key insight:** BroadcastChannel works across Web Workers in Deno natively
- **Files modified:** `worker-bridge.ts:99-119`, `sandbox-worker.ts`
- **Test pattern:** 58 tests across capability injection flow
- **Code review:** 298 tests passing (sandbox + capabilities)

**Reusable code from 7.3b:**

```typescript
// BroadcastChannel setup pattern
this.traceChannel = new BroadcastChannel("agentcards-traces");
this.traceChannel.onmessage = (e: MessageEvent<CapabilityTraceEvent>) => {
  this.traces.push(e.data);
};
```

### From Story 6.4 (Graph Explorer)

- **Pattern:** Fresh Islands + API callbacks for interactive components
- **Performance:** Debounced requests (300ms), client-side filtering
- **Testing:** 11 unit tests, performance benchmarks
- **Bug fix insight:** Check multiple ID formats (server:tool vs mcp__server__tool)

### From Story 6.1-6.3 (Dashboard Foundation)

- **SSE Pattern:** EventsStreamManager with heartbeat, CORS handling
- **Graph Events:** `graph_event` type via EventTarget in GraphRAGEngine
- **Dashboard:** Fresh + Preact islands, Cytoscape visualization
- **File:** `src/server/events-stream.ts` - main reference for SSE implementation

---

## Git Intelligence

### Recent Commits (Story 7.3b completion):

```
f7f2a7d feat(capabilities): Story 7.3b - Capability injection with nested tracing
0a9eb5b docs(adr): ADR-040 Multi-tenant MCP & Secrets Management
5a8d0a7 fix(auth): Story 9.4 code review - security & UX improvements
542cfe5 docs: update ADRs with phased EventBus implementation plan and scoring algorithms reference
```

### Key Patterns from f7f2a7d (Story 7.3b):

- BroadcastChannel instantiation in constructor
- `onmessage` handler for trace collection
- Channel cleanup in `close()` method
- TraceEvent discriminated union type pattern
- `__trace()` function in Worker context

---

## Technical Stack (from Architecture)

- **Runtime:** Deno 2.x with TypeScript 5.7+
- **BroadcastChannel:** Native Web API in Deno (no external deps)
- **SSE:** Standard Server-Sent Events via `text/event-stream`
- **Dashboard:** Fresh 2 + Preact islands
- **Testing:** `deno test` native runner
- **Database:** PGlite 0.3.14 with pgvector

### BroadcastChannel Technical Notes

From [Deno Web Platform APIs](https://docs.deno.com/api/web/~/BroadcastChannel):

- BroadcastChannel is a native Web API available in Deno
- 1-to-many communication (unlike MessageChannel which is 1-to-1)
- All BroadcastChannel instances with same name are linked
- Works across main thread and Web Workers
- No need to transfer channel object - each context creates its own instance
- Same-origin restriction applies (all same Deno process)

---

## Estimation

- **Effort:** 1.5-2 days
- **LOC:** ~450-550 total
  - `event-bus.ts`: ~100 LOC
  - `types.ts`: ~200 LOC
  - `metrics-collector.ts`: ~150 LOC
  - Migrations: ~100 LOC
  - Tests: ~100 LOC
- **Risk:** Low-Medium (migrations may break existing event consumers)

---

## References

- **ADR-036:** `docs/adrs/ADR-036-broadcast-channel-event-distribution.md`
- **Story 7.3b:** `docs/sprint-artifacts/7-3b-capability-injection-nested-tracing.md` (introduces
  BroadcastChannel)
- **Story 7.6:** Algorithm Observability Implementation (uses events from this story)
- **Current SSE:** `src/server/events-stream.ts:1-275`
- **Current GraphRAG events:** `src/graphrag/events.ts`
- **WorkerBridge BroadcastChannel:** `src/sandbox/worker-bridge.ts:99-119`
- **MDN BroadcastChannel:** https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
- **Deno BroadcastChannel:** https://docs.deno.com/api/web/~/BroadcastChannel

---

## Dev Agent Record

### Context Reference

- `src/sandbox/worker-bridge.ts:99-131` - BroadcastChannel pattern from 7.3b
- `src/server/events-stream.ts:1-275` - EventsStreamManager to refactor
- `src/graphrag/graph-engine.ts` - GraphRAGEngine with EventTarget to migrate
- `src/graphrag/events.ts` - Current graph event types
- `src/dag/executor.ts` - ParallelExecutor for DAG events
- `src/dag/streaming.ts` - StreamingExecutor for SSE events
- `src/dag/controlled-executor.ts` - ControlledExecutor for AIL/HIL events

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

(Will be filled during implementation)

### Completion Notes List

(Will be filled during implementation)

### File List

**NEW FILES:**

- [x] `src/events/types.ts` - Event type definitions (CaiEvent, EventType union, typed payloads)
- [x] `src/events/event-bus.ts` - EventBus singleton with BroadcastChannel
- [x] `src/events/mod.ts` - Module exports
- [x] `src/telemetry/metrics-collector.ts` - Prometheus-compatible metrics aggregation
- [x] `tests/unit/events/event_bus_test.ts` - Unit tests (23 tests)
- [x] `tests/unit/telemetry/metrics_collector_test.ts` - Unit tests (12 tests)
- [x] `tests/integration/event_flow_test.ts` - E2E event flow validation

**MODIFIED FILES:**

- [x] `src/sandbox/worker-bridge.ts` - Emit tool.start/end via EventBus, bridge capability traces
- [x] `src/sandbox/types.ts` - Added args field to TraceEvent (ADR-041 hierarchical tracking)
- [x] `src/dag/executor.ts` - Emit dag.* events during execution
- [x] `src/graphrag/graph-engine.ts` - Bridge legacy GraphEvents to EventBus via emitToEventBus()
- [x] `src/capabilities/capability-store.ts` - Emit capability.learned event
- [x] `src/capabilities/matcher.ts` - Emit capability.matched event
- [x] `src/server/events-stream.ts` - Subscribe to EventBus instead of GraphRAGEngine, add ?filter=
      support
- [x] `tests/unit/server/events_stream_test.ts` - Updated tests for EventBus integration

**NOT MODIFIED (removed from original plan):**

- `src/dag/controlled-executor.ts` - Not needed (uses ParallelExecutor internally)
- `src/dag/streaming.ts` - Not needed (SSE handled via EventBus subscription)
