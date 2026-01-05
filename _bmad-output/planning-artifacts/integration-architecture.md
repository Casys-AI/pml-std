# Integration Architecture - Casys PML

_Generated: 2025-12-31_

## Overview

Casys PML est un système distribué avec plusieurs points d'intégration :

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code / LLM                         │
└────────────────────────────┬────────────────────────────────────┘
                             │ MCP Protocol (JSON-RPC)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PML MCP Gateway (:3003)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ pml_discover│  │ pml_execute │  │ pml_search  │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│  ┌──────▼────────────────▼────────────────▼──────┐              │
│  │              Internal Services                 │              │
│  │  GraphRAG │ DAG Engine │ Sandbox │ Capabilities│              │
│  └──────────────────────┬────────────────────────┘              │
└─────────────────────────┼───────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │ MCP      │   │PostgreSQL│   │ External │
    │ Servers  │   │/ PGlite  │   │ APIs     │
    └──────────┘   └──────────┘   └──────────┘
```

---

## MCP Server Connections

### Connection Management

| Component | Path | Purpose |
|-----------|------|---------|
| `ConnectionManager` | `src/mcp/connections/manager.ts` | Lifecycle management |
| `ConnectionPool` | `src/mcp/connections/pool.ts` | Connection pooling |

### Configured MCP Servers

| Server | Type | Protocol | Purpose |
|--------|------|----------|---------|
| `std` | stdio | Internal | Standard library tools |
| `filesystem` | stdio | @modelcontextprotocol | File operations |
| `fast-fs` | stdio | npm | Fast filesystem |
| `memory` | stdio | @modelcontextprotocol | Knowledge graph |
| `sequential-thinking` | stdio | @modelcontextprotocol | Reasoning |
| `playwright` | stdio | @playwright | Browser automation |
| `exa` | stdio | npm | Web search |
| `fetch` | stdio | uvx | HTTP requests |
| `plots` | stdio | uvx | Visualizations |

### MCP Protocol Flow

```
LLM Request
    │
    ▼
┌────────────────┐
│  MCP Gateway   │
│  (Hono server) │
└───────┬────────┘
        │ JSON-RPC over HTTP/SSE
        ▼
┌────────────────┐
│   Handlers     │
│  - discover    │
│  - execute     │
│  - workflow    │
└───────┬────────┘
        │
        ▼
┌────────────────┐      ┌─────────────────┐
│ ConnectionPool │─────▶│ MCP Clients     │
│   (stdio)      │      │ (subprocess)    │
└────────────────┘      └─────────────────┘
```

---

## Event System (ADR-036)

### BroadcastChannel Architecture

```typescript
// Channels
PML_EVENTS_CHANNEL = "pml-events"   // General events
PML_TRACES_CHANNEL = "pml-traces"   // Algorithm traces
```

### Event Types

| Event | Source | Description |
|-------|--------|-------------|
| `tool.start` | worker-bridge | Tool execution started |
| `tool.complete` | worker-bridge | Tool execution completed |
| `tool.error` | worker-bridge | Tool execution failed |
| `dag.layer_start` | controlled-executor | DAG layer started |
| `dag.layer_complete` | controlled-executor | DAG layer completed |
| `capability.created` | capability-store | New capability saved |
| `capability.matched` | dag-suggester | Capability matched |

### Cross-Context Communication

```
┌──────────────┐    BroadcastChannel    ┌──────────────┐
│   API Server │◄──────────────────────►│  Web Worker  │
└──────────────┘                        └──────────────┘
       │                                       │
       │         BroadcastChannel              │
       │◄─────────────────────────────────────►│
       │                                       │
       ▼                                       ▼
┌──────────────┐                        ┌──────────────┐
│  Dashboard   │                        │   Sandbox    │
│   Islands    │                        │   Worker     │
└──────────────┘                        └──────────────┘
```

---

## External API Integrations

### GitHub OAuth

| Endpoint | Purpose |
|----------|---------|
| `api.github.com/user` | User profile |
| `api.github.com/user/emails` | User emails |

### Sentry (Error Tracking)

| Integration | Path |
|-------------|------|
| Error capture | `src/telemetry/sentry.ts` |
| Transaction tracing | Automatic |
| Breadcrumbs | Manual |

### WASM Dependencies

| Library | Source | Purpose |
|---------|--------|---------|
| `@resvg/resvg-wasm` | unpkg.com | SVG to PNG conversion |
| BGE-M3 | HuggingFace | Embeddings (local) |

---

## Database Connections

### Connection Modes

| Mode | Driver | Use Case |
|------|--------|----------|
| Local | PGlite (WASM) | Development, offline |
| Cloud | PostgreSQL | Production |

### Database Client

```typescript
// src/db/client.ts
export function createDefaultClient(): DbClient {
  if (process.env.DATABASE_URL) {
    return new PostgresClient(DATABASE_URL);
  }
  return new PGliteClient(PML_DB_PATH);
}
```

### Connection Pool

| Setting | Local | Cloud |
|---------|-------|-------|
| Max connections | 1 | 20 |
| Idle timeout | - | 30s |
| Connection timeout | - | 10s |

---

## Internal Module Communication

### Dependency Injection (DIOD)

```typescript
// src/infrastructure/di/container.ts
container.register(GraphRAGEngine).use(GraphRAGEngineImpl);
container.register(CapabilityStore).use(CapabilityStoreImpl);
container.register(VectorSearch).use(VectorSearchImpl);
```

### Module Dependencies

```
┌─────────────┐
│   Handlers  │
└──────┬──────┘
       │
       ├─────────────────┬─────────────────┐
       ▼                 ▼                 ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  GraphRAG   │   │    DAG      │   │  Sandbox    │
│   Engine    │   │  Executor   │   │  Worker     │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       ├─────────────────┼─────────────────┤
       ▼                 ▼                 ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   Vector    │   │ Capability  │   │     MCP     │
│   Search    │   │   Store     │   │   Clients   │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └─────────────────┴─────────────────┘
                         │
                         ▼
                  ┌─────────────┐
                  │  Database   │
                  │  (PGlite/PG)│
                  └─────────────┘
```

---

## Worker Communication

### Sandbox Worker Bridge

```
┌─────────────────┐         ┌─────────────────┐
│   Main Thread   │         │  Sandbox Worker │
│                 │         │                 │
│  WorkerBridge   │◄───────►│  sandbox-worker │
│                 │   RPC   │                 │
│  - callTool()   │         │  - execute()    │
│  - executeCode()│         │  - callMCP()    │
└─────────────────┘         └─────────────────┘
```

### RPC Protocol

```typescript
// Request
{
  id: string,
  method: "callTool" | "executeCode",
  params: {...}
}

// Response
{
  id: string,
  result?: any,
  error?: { code: number, message: string }
}
```

---

## SSE (Server-Sent Events)

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/api/events` | General event stream |
| `/api/traces` | Algorithm trace stream |

### Event Format

```typescript
interface SSEEvent {
  type: EventType;
  source: string;
  timestamp: number;
  payload: Record<string, unknown>;
  correlationId?: string;
}
```

---

## Security Boundaries

### Trust Zones

```
┌─────────────────────────────────────────────────┐
│                  UNTRUSTED                       │
│  ┌───────────────────────────────────────────┐  │
│  │            User Code (Sandbox)            │  │
│  │  - Resource limits                        │  │
│  │  - PII detection                          │  │
│  │  - No network by default                  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                       │
                       │ WorkerBridge RPC
                       ▼
┌─────────────────────────────────────────────────┐
│                   TRUSTED                        │
│  ┌───────────────────────────────────────────┐  │
│  │           PML Core Services                │  │
│  │  - Full permissions                        │  │
│  │  - Database access                         │  │
│  │  - MCP client connections                  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### Permission Profiles (deno.json)

| Profile | Read | Write | Net | Env | Run |
|---------|------|-------|-----|-----|-----|
| minimal | ✗ | ✗ | ✗ | ✗ | ✗ |
| readonly | ./data, /tmp | ✗ | ✗ | ✗ | ✗ |
| network-api | ✗ | ✗ | ✓ | ✗ | ✗ |
| filesystem | ✓ | /tmp | ✗ | ✗ | ✗ |
| mcp-standard | ✓ | /tmp, ./output | ✓ | HOME, PATH | ✗ |
| trusted | ✓ | ✓ | ✓ | ✓ | ✗ |

---

## Monitoring Integration

### OpenTelemetry (OTEL) - Algorithm Tracing

| Component | Port | Protocol | Purpose |
|-----------|------|----------|---------|
| OTEL Collector | 4318 | HTTP/OTLP | Deno native tracing |

```
┌─────────────────┐         ┌─────────────────┐
│  Algorithm      │  OTLP   │  OTEL Collector │
│  Tracer         │────────►│   (:4318)       │
│                 │  HTTP   │                 │
│  - SHGAT        │         │                 │
│  - DR-DSP       │         └────────┬────────┘
│  - Thompson     │                  │
└─────────────────┘                  │
                                     ▼
                              ┌─────────────┐
                              │   Grafana   │
                              │   Tempo     │
                              └─────────────┘
```

### Traced Algorithms

| Algorithm | Trace Data |
|-----------|------------|
| SHGAT | K-head scores, feature contributions, decisions |
| DR-DSP | Path found, weight, node sequence |
| Thompson | Tool outcomes, Beta distributions |
| Unified Search | Semantic scores, reliability factors |

### Grafana Stack

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│ Application │─────►│  Promtail   │─────►│    Loki     │
│   Logs      │      │ (shipper)   │      │ (storage)   │
└─────────────┘      └─────────────┘      └──────┬──────┘
                                                  │
┌─────────────┐      ┌─────────────┐              │
│ Application │─────►│ Prometheus  │              │
│   Metrics   │      │ (scraper)   │              │
└─────────────┘      └──────┬──────┘              │
                            │                     │
                            └──────────┬──────────┘
                                       │
                                       ▼
                               ┌─────────────┐
                               │   Grafana   │
                               │ (dashboard) │
                               └─────────────┘
```
