# Technology Stack Details

_Updated: December 2025_

## 1. Runtime & Build

| Layer             | Details                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| **Runtime**       | Deno 2.x (permissioned, `--allow-all` for gateway), TypeScript 5.7 target ES2022 |
| **Module System** | `deno.json` (imports map), npm compatibility for Graphology, HuggingFace, Vite   |
| **Web UI**        | Fresh 2 + Preact 10.27, Tailwind 4 via Vite dev server                           |
| **Tasks**         | `deno task dev`, `deno task dev:fresh`, `deno task db:*`, `deno task prod:*`     |
| **Testing**       | `deno test` (unit + integration), Playwright utils for E2E                       |

## 2. Application Services

| Service                                          | Tech                                        | Notes                                                          |
| ------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------- |
| **Gateway Server** (`src/mcp/gateway-server.ts`) | Deno HTTP server, SSE streaming             | Route `pml:execute_dag`, `pml:execute_code`, MCP orchestration |
| **Sandbox / Executor** (`src/sandbox/*`)         | Deno subprocess isolation, permission-bound | Wraps MCP calls, emits trace events                            |
| **CLI** (`src/main.ts`)                          | Command router (serve, init, status)        | Shares same runtime as gateway                                 |
| **Auth Layer** (`src/server/auth/*`)             | GitHub OAuth + API keys                     | Sessions in Deno KV, users in Drizzle                          |
| **Dashboard** (`src/web/*`)                      | Fresh 2 + Vite                              | Port 8081 (dev) / 8080 (prod)                                  |

### BroadcastChannel Event Distribution (ADR-036)

Pour la communication inter-process (Gateway ↔ Workers ↔ Dashboard), le système utilise
`BroadcastChannel` :

```typescript
// Event distribution via BroadcastChannel
const channel = new BroadcastChannel("pml-events");

// Publisher (Gateway)
channel.postMessage({ type: "task_completed", taskId, result });

// Subscriber (Dashboard SSE handler)
channel.onmessage = (event) => {
  sseController.enqueue(`data: ${JSON.stringify(event.data)}\n\n`);
};
```

**Use Cases :**

- Propagation des événements d'exécution vers le dashboard (real-time updates)
- Synchronisation des caches entre workers
- Notification des changements de configuration

## 3. Data & Storage

| Component          | Technology                                  | Purpose                                             |
| ------------------ | ------------------------------------------- | --------------------------------------------------- |
| **PGlite 0.3.14**  | PostgreSQL 17 WASM + pgvector               | Primary relational store, persisted on filesystem   |
| **Drizzle ORM**    | `drizzle-orm/pglite`                        | Application tables (`users`, future RBAC/secrets)   |
| **SQL Migrations** | Custom runner (`src/db/migrations.ts`)      | Tool index, GraphRAG, episodic memory, telemetry    |
| **Vector Search**  | pgvector HNSW (`vector_cosine_ops`, `m=16`) | `tool_embedding`, `workflow_pattern`                |
| **Deno KV**        | `Deno.openKv()` singleton                   | OAuth sessions, pending states, future secret cache |
| **Database Path**  | `.pml.db` (prod) / `.pml-dev.db` (dev)      | Configurable via `PML_DB_PATH` env var              |

See `docs/architecture/data-architecture.md` for the exhaustive schema.

## 4. Graph & ML Layer

| Capability             | Libraries                                                                                        | Description                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Graph Engine**       | `graphology`, `graphology-communities-louvain`, `graphology-shortest-path`, `graphology-metrics` | PageRank, Louvain communities, shortest path DAG reconstruction                                            |
| **Similarity Models**  | `@huggingface/transformers@3.7.6`, `@huggingface/onnxruntime`                                    | BGE-M3 embeddings for tools & intents                                                                      |
| **Scoring Algorithms** | ADR-038                                                                                          | Hybrid search (semantic + Adamic-Adar), next-step prediction (cooccurrence + Louvain + recency + PageRank) |
| **Learning Stores**    | `tool_dependency`, `workflow_execution`, `episodic_events`, `adaptive_thresholds`                | Updated via sandbox traces                                                                                 |

## 5. MCP & External Integrations

| Area                   | Details                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| **MCP SDK**            | `@modelcontextprotocol/sdk@1.0.4` official implementation                            |
| **Transports**         | stdio (local mode), HTTP Streamable (cloud mode, ADR-025), SSE output to clients     |
| **Hosted MCP Servers** | >15 servers launched via `Deno.Command` (GitHub, Filesystem, Memory, Tavily, etc.)   |
| **Config**             | `config/.mcp-servers.json` (gateway) + future per-user configs (`user_mcp_configs`)  |
| **Meta-Tools**         | `pml:search_tools`, `pml:execute_dag`, `pml:execute_code`, `pml:search_capabilities` |
| **Real Execution**     | Gateway executes DAGs via MCP (ADR-030), not just suggestions                        |

### JSON-RPC Multiplexer Pattern (ADR-044)

Pour les requêtes MCP parallèles, le système utilise un multiplexer au lieu de requêtes
séquentielles :

```typescript
// Pattern: Multiplexer pour requêtes parallèles
class MCPMultiplexer {
  private pending: Map<string, PendingRequest> = new Map();

  async callMany(requests: MCPRequest[]): Promise<MCPResponse[]> {
    // 1. Assigne un ID unique à chaque requête
    // 2. Envoie toutes les requêtes en parallèle
    // 3. Démultiplexe les réponses par ID
    return Promise.all(requests.map((r) => this.callSingle(r)));
  }
}
```

**Bénéfices :**

- Réduit la latence de N requêtes séquentielles à 1 round-trip
- Respecte le protocole JSON-RPC 2.0 (batch requests)
- Utilisé dans `pml:execute_dag` pour les tâches parallèles

## 6. Authentication (Epic 9)

| Component           | Technology                          | Notes                                |
| ------------------- | ----------------------------------- | ------------------------------------ |
| **OAuth Provider**  | GitHub via `@deno/kv-oauth`         | Single sign-on, CSRF protection      |
| **Session Storage** | Deno KV                             | 30-day TTL, cookie-based             |
| **API Keys**        | `ac_` prefix + 24 random chars      | For MCP gateway access (cloud mode)  |
| **Key Hashing**     | Argon2id via `@ts-rex/argon2`       | Secure storage in `users` table      |
| **Mode Detection**  | `GITHUB_CLIENT_ID` env var presence | Cloud mode vs Local mode (zero auth) |

### Dual-Server Architecture

```
┌─────────────────────────────────┐     ┌──────────────────────────┐
│ Fresh Dashboard                 │     │ API Server (MCP Gateway) │
│ Port: 8081 (dev) / 8080 (prod)  │     │ Port: 3003 (dev) / 3001 (prod) │
│                                 │     │                          │
│ Auth: Session Cookie            │     │ Auth: x-api-key Header   │
│ Routes: /dashboard, /settings   │     │ Routes: /mcp, /health    │
└─────────────────────────────────┘     └──────────────────────────┘
```

## 7. DevOps & Observability

| Tooling           | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `@std/log`        | Structured logging (JSON optional)                                      |
| `metrics` table   | Lightweight telemetry (counts, latency)                                 |
| `scripts/` (bash) | Ops helpers (devcontainer, deploy)                                      |
| Systemd targets   | `deno task prod:*` interacts with `casys-dashboard` / `casys-api` units |
| Sentry (optional) | Error tracking, performance monitoring (ADR-011)                        |

## 8. Key Environment Variables

| Variable               | Default   | Description                       |
| ---------------------- | --------- | --------------------------------- |
| `PML_DB_PATH`          | `.pml.db` | Database path                     |
| `PML_API_KEY`          | -         | API key for cloud mode MCP access |
| `GITHUB_CLIENT_ID`     | -         | Enables cloud mode when set       |
| `GITHUB_CLIENT_SECRET` | -         | GitHub OAuth secret               |
| `PORT_API`             | `3003`    | API server port                   |
| `PORT_DASHBOARD`       | `8081`    | Fresh dashboard port              |
| `LOG_LEVEL`            | `info`    | Logging verbosity                 |
| `SENTRY_DSN`           | -         | Sentry error tracking (optional)  |

## 9. Roadmap Items

1. **Full Drizzle schema generation** — Replace ad-hoc SQL migrations for GraphRAG tables
2. **Secret management** — KMS-backed `user_secrets`, envelope encryption
3. **Observability stack** — Export metrics to ClickHouse / Prometheus
4. **Gateway exposure modes** — ADR-017 (semantic, hybrid, full_proxy modes)
5. **Rate limiting** — Story 9.5 (per-user quotas, data isolation)

---

### References

- `deno.json` (tasks + imports)
- `src/db/migrations.ts`, `src/db/schema/*`
- `docs/architecture/data-architecture.md`
- `docs/adrs/ADR-025-mcp-streamable-http-transport.md`
- `docs/adrs/ADR-030-gateway-real-execution.md`
- `docs/adrs/ADR-036-broadcast-channel-event-distribution.md`
- `docs/adrs/ADR-038-scoring-algorithms-reference.md`
- `docs/adrs/ADR-044-json-rpc-multiplexer-mcp-client.md`
- `docs/sprint-artifacts/tech-rename-to-casys-pml.md`
