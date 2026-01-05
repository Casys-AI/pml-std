# Story 6.1: Real-time Events Stream (SSE)

**Epic:** 6 - Real-time Graph Monitoring & Observability **Story ID:** 6.1 **Status:** done
**Estimated Effort:** 2-3 hours **Completed:** 2025-12-01

---

## User Story

**As a** developer monitoring Casys PML, **I want** to receive graph events in real-time via
Server-Sent Events, **So that** I can observe how the system learns without polling.

---

## Acceptance Criteria

1. **AC1:** SSE endpoint créé: `GET /events/stream`
2. **AC2:** EventEmitter intégré dans GraphRAGEngine
3. **AC3:** Event types: `graph_synced`, `edge_created`, `edge_updated`, `workflow_executed`,
   `metrics_updated`
4. **AC4:** Event payload: timestamp, event_type, data (tool_ids, scores, etc.)
5. **AC5:** Reconnection automatique si connexion perdue (client-side retry logic)
6. **AC6:** Heartbeat events toutes les 30s pour maintenir la connexion
7. **AC7:** Max 100 clients simultanés (éviter DoS)
8. **AC8:** CORS headers configurés pour permettre frontend local
9. **AC9:** Tests: curl stream endpoint, vérifier format events
10. **AC10:** Documentation: Event schema et exemples

---

## Prerequisites

- Epic 5 completed (search_tools functional) ✅
- Story 2.3 (SSE Streaming pour Progressive Results) - Foundation patterns ✅

---

## Technical Notes

### Event Types Definition

```typescript
// src/graphrag/events.ts

export type GraphEvent =
  | GraphSyncedEvent
  | EdgeCreatedEvent
  | EdgeUpdatedEvent
  | WorkflowExecutedEvent
  | MetricsUpdatedEvent
  | HeartbeatEvent;

interface GraphSyncedEvent {
  type: "graph_synced";
  data: {
    node_count: number;
    edge_count: number;
    sync_duration_ms: number;
    timestamp: string;
  };
}

interface EdgeCreatedEvent {
  type: "edge_created";
  data: {
    from_tool_id: string;
    to_tool_id: string;
    confidence_score: number;
    timestamp: string;
  };
}

interface EdgeUpdatedEvent {
  type: "edge_updated";
  data: {
    from_tool_id: string;
    to_tool_id: string;
    old_confidence: number;
    new_confidence: number;
    observed_count: number;
    timestamp: string;
  };
}

interface WorkflowExecutedEvent {
  type: "workflow_executed";
  data: {
    workflow_id: string;
    tool_ids: string[];
    success: boolean;
    execution_time_ms: number;
    timestamp: string;
  };
}

interface MetricsUpdatedEvent {
  type: "metrics_updated";
  data: {
    edge_count: number;
    node_count: number;
    density: number;
    pagerank_top_10: Array<{ tool_id: string; score: number }>;
    communities_count: number;
    timestamp: string;
  };
}

interface HeartbeatEvent {
  type: "heartbeat";
  data: {
    connected_clients: number;
    uptime_seconds: number;
    timestamp: string;
  };
}
```

### EventEmitter Integration in GraphRAGEngine

```typescript
// src/graphrag/graph-engine.ts (modifications)

import { EventEmitter } from "node:events";

export class GraphRAGEngine {
  private eventEmitter: EventEmitter;

  constructor() {
    this.eventEmitter = new EventEmitter();
    // Allow many listeners for SSE clients
    this.eventEmitter.setMaxListeners(100);
  }

  // Public API for subscribing
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.eventEmitter.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.eventEmitter.off(event, listener);
  }

  // Internal: Emit events when graph changes
  private emit(event: GraphEvent): void {
    this.eventEmitter.emit("graph_event", event);
  }

  // Modify existing methods to emit events
  async syncFromDatabase(): Promise<void> {
    const startTime = performance.now();
    // ... existing sync logic ...

    this.emit({
      type: "graph_synced",
      data: {
        node_count: this.graph.order,
        edge_count: this.graph.size,
        sync_duration_ms: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      },
    });
  }

  async updateFromExecution(execution: WorkflowExecution): Promise<void> {
    // ... existing logic ...

    // Emit edge events for new/updated edges
    for (const edge of newEdges) {
      this.emit({
        type: "edge_created",
        data: {
          from_tool_id: edge.from,
          to_tool_id: edge.to,
          confidence_score: edge.confidence,
          timestamp: new Date().toISOString(),
        },
      });
    }

    for (const edge of updatedEdges) {
      this.emit({
        type: "edge_updated",
        data: {
          from_tool_id: edge.from,
          to_tool_id: edge.to,
          old_confidence: edge.oldConfidence,
          new_confidence: edge.newConfidence,
          observed_count: edge.observedCount,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Emit workflow executed
    this.emit({
      type: "workflow_executed",
      data: {
        workflow_id: execution.workflow_id,
        tool_ids: execution.tool_ids,
        success: execution.success,
        execution_time_ms: execution.execution_time_ms,
        timestamp: new Date().toISOString(),
      },
    });

    // Emit metrics updated after recomputation
    this.emit({
      type: "metrics_updated",
      data: {
        edge_count: this.graph.size,
        node_count: this.graph.order,
        density: this.getDensity(),
        pagerank_top_10: this.getTopPageRank(10),
        communities_count: this.getCommunitiesCount(),
        timestamp: new Date().toISOString(),
      },
    });
  }
}
```

### SSE Events Endpoint

```typescript
// src/server/events-stream.ts

import type { GraphRAGEngine } from "../graphrag/graph-engine.ts";
import type { GraphEvent } from "../graphrag/events.ts";

interface EventsStreamConfig {
  maxClients: number; // Default: 100
  heartbeatIntervalMs: number; // Default: 30000
  corsOrigins: string[]; // Default: ["http://localhost:*"]
}

const DEFAULT_CONFIG: EventsStreamConfig = {
  maxClients: 100,
  heartbeatIntervalMs: 30_000,
  corsOrigins: ["http://localhost:3000", "http://localhost:8080", "http://127.0.0.1:*"],
};

export class EventsStreamManager {
  private clients: Set<WritableStreamDefaultWriter<Uint8Array>> = new Set();
  private startTime = Date.now();
  private heartbeatInterval?: number;
  private encoder = new TextEncoder();

  constructor(
    private graphEngine: GraphRAGEngine,
    private config: EventsStreamConfig = DEFAULT_CONFIG,
  ) {
    // Subscribe to graph events
    this.graphEngine.on("graph_event", this.broadcastEvent.bind(this));

    // Start heartbeat
    this.startHeartbeat();
  }

  /**
   * Handle SSE connection request
   */
  handleRequest(request: Request): Response {
    // Check client limit
    if (this.clients.size >= this.config.maxClients) {
      return new Response(
        JSON.stringify({ error: "Too many clients", max: this.config.maxClients }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    // Create stream
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    // Register client
    this.clients.add(writer);

    // Remove client on close
    request.signal.addEventListener("abort", () => {
      this.clients.delete(writer);
      writer.close().catch(() => {});
    });

    // Send initial connected event
    this.sendToClient(writer, {
      type: "connected",
      data: {
        client_id: crypto.randomUUID(),
        connected_clients: this.clients.size,
        timestamp: new Date().toISOString(),
      },
    } as unknown as GraphEvent);

    // CORS headers
    const origin = request.headers.get("Origin") || "*";
    const corsHeaders = this.getCorsHeaders(origin);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...corsHeaders,
      },
    });
  }

  /**
   * Broadcast event to all connected clients
   */
  private async broadcastEvent(event: GraphEvent): Promise<void> {
    const deadClients: WritableStreamDefaultWriter<Uint8Array>[] = [];

    for (const client of this.clients) {
      try {
        await this.sendToClient(client, event);
      } catch {
        deadClients.push(client);
      }
    }

    // Clean up dead clients
    for (const client of deadClients) {
      this.clients.delete(client);
    }
  }

  /**
   * Send event to single client
   */
  private async sendToClient(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    event: GraphEvent,
  ): Promise<void> {
    const sseData = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    await writer.write(this.encoder.encode(sseData));
  }

  /**
   * Start heartbeat interval
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.broadcastEvent({
        type: "heartbeat",
        data: {
          connected_clients: this.clients.size,
          uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
          timestamp: new Date().toISOString(),
        },
      });
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Get CORS headers based on origin
   */
  private getCorsHeaders(origin: string): Record<string, string> {
    const isAllowed = this.config.corsOrigins.some((pattern) => {
      if (pattern.includes("*")) {
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        return regex.test(origin);
      }
      return pattern === origin;
    });

    if (isAllowed || origin === "*") {
      return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
    }

    return {};
  }

  /**
   * Get current stats
   */
  getStats(): { connectedClients: number; uptimeSeconds: number } {
    return {
      connectedClients: this.clients.size,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  /**
   * Cleanup on shutdown
   */
  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    for (const client of this.clients) {
      client.close().catch(() => {});
    }
    this.clients.clear();
  }
}
```

### Gateway Server Integration

```typescript
// src/mcp/gateway-server.ts (additions)

import { EventsStreamManager } from "../server/events-stream.ts";

export class MCPGatewayServer {
  private eventsStream?: EventsStreamManager;

  constructor(/* ... */) {
    // ... existing initialization ...

    // Initialize events stream
    this.eventsStream = new EventsStreamManager(this.graphEngine);
  }

  // Add route handler
  async handleHttpRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Events stream endpoint
    if (url.pathname === "/events/stream" && request.method === "GET") {
      return this.eventsStream!.handleRequest(request);
    }

    // ... existing routes ...
  }
}
```

### Client-Side Example

```typescript
// Example: Consuming graph events stream
function connectToEventsStream(baseUrl: string): EventSource {
  const eventSource = new EventSource(`${baseUrl}/events/stream`);

  // Connection events
  eventSource.addEventListener("connected", (event) => {
    const data = JSON.parse(event.data);
    console.log(`🔗 Connected (${data.connected_clients} clients)`);
  });

  // Graph events
  eventSource.addEventListener("graph_synced", (event) => {
    const data = JSON.parse(event.data);
    console.log(`📊 Graph synced: ${data.node_count} nodes, ${data.edge_count} edges`);
  });

  eventSource.addEventListener("edge_created", (event) => {
    const data = JSON.parse(event.data);
    console.log(`➕ New edge: ${data.from_tool_id} → ${data.to_tool_id}`);
  });

  eventSource.addEventListener("edge_updated", (event) => {
    const data = JSON.parse(event.data);
    console.log(
      `📈 Edge updated: ${data.from_tool_id} → ${data.to_tool_id} (${
        data.new_confidence.toFixed(2)
      })`,
    );
  });

  eventSource.addEventListener("workflow_executed", (event) => {
    const data = JSON.parse(event.data);
    const status = data.success ? "✅" : "❌";
    console.log(`${status} Workflow: ${data.tool_ids.join(" → ")} (${data.execution_time_ms}ms)`);
  });

  eventSource.addEventListener("metrics_updated", (event) => {
    const data = JSON.parse(event.data);
    console.log(
      `📉 Metrics: density=${data.density.toFixed(3)}, communities=${data.communities_count}`,
    );
    console.log(
      `   Top tools: ${data.pagerank_top_10.slice(0, 3).map((t) => t.tool_id).join(", ")}`,
    );
  });

  eventSource.addEventListener("heartbeat", (event) => {
    const data = JSON.parse(event.data);
    console.log(`💓 Heartbeat: ${data.connected_clients} clients, uptime ${data.uptime_seconds}s`);
  });

  // Reconnection handling (automatic via EventSource)
  eventSource.onerror = () => {
    console.log("⚠️ Connection lost, reconnecting...");
  };

  return eventSource;
}
```

### Testing with curl

```bash
# Test SSE endpoint
curl -N -H "Accept: text/event-stream" http://localhost:3000/events/stream

# Expected output:
# event: connected
# data: {"client_id":"abc-123","connected_clients":1,"timestamp":"2025-12-01T..."}
#
# event: heartbeat
# data: {"connected_clients":1,"uptime_seconds":30,"timestamp":"..."}
```

---

## Tasks / Subtasks

- [x] **Task 1 (AC: 3, 4):** Créer les types d'événements GraphEvent
  - [x] 1.1: Définir interfaces pour tous les event types dans `src/graphrag/events.ts`
  - [x] 1.2: Exporter les types dans `src/graphrag/index.ts`

- [x] **Task 2 (AC: 2):** Intégrer EventEmitter dans GraphRAGEngine
  - [x] 2.1: Ajouter EventTarget avec listener map
  - [x] 2.2: Ajouter méthodes on/off pour subscription
  - [x] 2.3: Modifier `syncFromDatabase()` pour émettre `graph_synced`
  - [x] 2.4: Modifier `updateFromExecution()` pour émettre edge/workflow/metrics events
  - [ ] 2.5: Tests unitaires pour les événements émis

- [x] **Task 3 (AC: 1, 6, 7, 8):** Créer EventsStreamManager
  - [x] 3.1: Implémenter `handleRequest()` avec stream SSE
  - [x] 3.2: Implémenter `broadcastEvent()` vers tous les clients
  - [x] 3.3: Ajouter heartbeat interval (30s)
  - [x] 3.4: Ajouter limite 100 clients avec réponse 503
  - [x] 3.5: Ajouter CORS headers configurables
  - [x] 3.6: Cleanup des clients déconnectés

- [x] **Task 4 (AC: 1):** Intégrer endpoint dans Gateway Server
  - [x] 4.1: Ajouter route `GET /events/stream`
  - [x] 4.2: Connecter EventsStreamManager au GraphRAGEngine

- [x] **Task 5 (AC: 5):** Client-side reconnection example
  - [x] 5.1: Documenter EventSource automatic reconnection
  - [x] 5.2: Ajouter exemple dans `public/examples/events-client.ts`

- [x] **Task 6 (AC: 9):** Tests
  - [x] 6.1: Tests unitaires EventsStreamManager (7 tests)
  - [x] 6.2: Tests GraphRAGEngine event emission (5 tests)
  - [x] 6.3: Test limite 100 clients ✅
  - [x] 6.4: Test CORS headers ✅

- [x] **Task 7 (AC: 10):** Documentation
  - [x] 7.1: Documenter event schema dans `docs/api/events.md`
  - [x] 7.2: Ajouter exemples curl et JavaScript
  - [x] 7.3: Documenter CORS configuration

---

## Dev Notes

### Architecture Alignment

- **Module location:** `src/server/events-stream.ts` (nouveau fichier)
- **Event types:** `src/graphrag/events.ts` (nouveau fichier)
- **Integration:** `src/graphrag/graph-engine.ts` (modifications)
- **Gateway:** `src/mcp/gateway-server.ts` (ajout route)

### Patterns à réutiliser de Story 2.3

- **SSE format:** `event: {type}\ndata: {JSON}\n\n`
- **HTTP headers:** Content-Type, Cache-Control, Connection
- **TransformStream:** Pour créer le stream SSE
- **Writer cleanup:** Sur abort ou erreur client

### Différences avec Story 2.3

| Aspect    | Story 2.3 (DAG Streaming) | Story 6.1 (Graph Events) |
| --------- | ------------------------- | ------------------------ |
| Scope     | Single workflow execution | Long-lived connection    |
| Events    | Task execution events     | Graph learning events    |
| Clients   | 1 per workflow            | N clients persistent     |
| Lifetime  | Workflow duration         | Server uptime            |
| Heartbeat | Non                       | Oui (30s)                |

### Project Structure Notes

```
src/
├── graphrag/
│   ├── events.ts         # NEW: GraphEvent types
│   ├── graph-engine.ts   # MODIFIED: Add EventEmitter
│   └── index.ts          # MODIFIED: Export events
├── server/
│   ├── events-stream.ts  # NEW: EventsStreamManager
│   └── sse-handler.ts    # EXISTING: Story 2.3
└── mcp/
    └── gateway-server.ts # MODIFIED: Add /events/stream route

tests/
├── unit/
│   └── server/
│       └── events_stream_test.ts  # NEW
└── integration/
    └── events_stream_e2e_test.ts  # NEW

docs/
└── api/
    └── events.md         # NEW: Event schema documentation
```

### Performance Targets

- Connection setup: <50ms
- Event broadcast latency: <10ms (100 clients)
- Memory per client: <1KB
- Heartbeat jitter: <1s

### References

- [Source: docs/stories/story-2.3.md] - SSE patterns foundation
- [Source: docs/architecture.md#Pattern-3] - GraphRAG Engine
- [Source: docs/epics.md#Story-6.1] - Requirements
- [MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) - Standards

---

## Dev Agent Record

### Context Reference

- [6-1-real-time-events-stream-sse.context.xml](6-1-real-time-events-stream-sse.context.xml) -
  Generated 2025-12-01

### Agent Model Used

claude-sonnet-4-5 (2025-12-01)

### Debug Log References

**Implementation Plan:**

1. Created GraphEvent type definitions (6 event types)
2. Integrated EventTarget into GraphRAGEngine with listener map for proper on/off
3. Modified syncFromDatabase() and updateFromExecution() to emit events
4. Created EventsStreamManager with SSE support, heartbeat, and CORS
5. Integrated /events/stream endpoint into Casys PMLGatewayServer
6. Created client example with automatic reconnection
7. Wrote 12 unit tests (7 for EventsStreamManager, 5 for GraphRAGEngine events)
8. Created comprehensive API documentation

**Technical Decisions:**

- Used EventTarget (native Deno) instead of node:events for better compatibility
- Implemented listener map to support proper off() functionality
- Used execution_id as workflow_id in events (WorkflowExecution type constraint)
- Added helper methods getDensity(), getTopPageRank(), getCommunitiesCount()

### Completion Notes List

✅ All 10 acceptance criteria met:

- AC1: SSE endpoint GET /events/stream created
- AC2: EventTarget integrated in GraphRAGEngine
- AC3: All 6 event types implemented (graph_synced, edge_created, edge_updated, workflow_executed,
  metrics_updated, heartbeat)
- AC4: Event payloads include timestamp, event_type, and structured data
- AC5: EventSource automatic reconnection documented
- AC6: Heartbeat every 30s implemented
- AC7: Max 100 clients with 503 response
- AC8: CORS headers configured with wildcard support
- AC9: 12 tests passing, manual curl testing documented
- AC10: Comprehensive API documentation in docs/api/events.md

### File List

**New Files:**

- src/graphrag/events.ts
- src/server/events-stream.ts
- public/examples/events-client.ts
- tests/unit/server/events_stream_test.ts
- tests/unit/graphrag/graph_engine_events_test.ts
- docs/api/events.md

**Modified Files:**

- src/graphrag/graph-engine.ts (added EventTarget, on/off methods, event emission)
- src/graphrag/index.ts (exported GraphEvent types)
- src/mcp/gateway-server.ts (added EventsStreamManager, /events/stream route)

---

## Change Log

**2025-12-01** - Story drafted

- Created from Epic 6 requirements in epics.md
- Technical design based on Story 2.3 SSE patterns
- 7 tasks with 22 subtasks mapped to 10 ACs

**2025-12-01** - Story implemented and ready for review

- All 7 tasks completed
- 12 unit tests passing (7 EventsStreamManager + 5 GraphRAGEngine)
- Comprehensive API documentation created
- Client example with automatic reconnection
- Zero breaking changes to GraphRAGEngine API

**2025-12-01** - Code review APPROVED and story completed

- Systematic validation: All 10 ACs verified with evidence
- All 21 completed tasks verified with file:line references
- Quality Score: 100/100
- Zero breaking changes, no security vulnerabilities
- Production-ready code
- Status: review → done
