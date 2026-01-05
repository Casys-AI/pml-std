# Data Architecture

_Status: Updated December 2025_

## 0. Overview

```
┌──────────────┐        ┌───────────────────┐        ┌───────────┐
│   Deno KV    │<──────►│ Auth Layer        │        │  Clients  │
│ (sessions)   │        │ (OAuth/API keys)  │        │ (CLI/UI)  │
└──────┬───────┘        └────────┬──────────┘        └────┬──────┘
       │                          │                        │ SSE/Web
       ▼                          ▼                        ▼
┌──────────────┐        ┌───────────────────┐        ┌─────────────┐
│  Drizzle ORM │        │  GraphRAG Engine  │        │ MCP Servers │
│  (users…)    │        │  + Sandbox        │        │ (stdio)     │
└──────┬───────┘        └────────┬──────────┘        └────┬────────┘
       │                          │                         │
       ▼                          ▼                         │
┌──────────────────────────────────────────────────────────────────┐
│                         PGlite (SQL + Vector)                    │
│ tool_schema • tool_embedding • tool_dependency • workflow_* ... │
└──────────────────────────────────────────────────────────────────┘
```

Casys PML currently manages **three families of stores**:

| Store                       | Role                                                   | Tech                                                                    |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| **PGlite (SQL + vectors)**  | Tool index, GraphRAG learning, capabilities, telemetry | `tool_*`, `workflow_*`, `episodic_*`, `adaptive_*`, `metrics`, `config` |
| **Drizzle ORM (on PGlite)** | Multi-tenant application data (users, API keys)        | `users`                                                                 |
| **Deno KV**                 | OAuth/API key sessions, ephemeral caches               | `kv://auth/*`                                                           |

The medium-term goal is to migrate the entire SQL schema to Drizzle, but until that's done **this
document serves as an inventory of reality**.

---

## 1. PGlite – Persistent Stores

### 1.1 Tool Index (Story 1.x)

| Table | Key Columns | Description | Notes |
| ----- | ----------- | ----------- | ----- |

### 1.2 GraphRAG Learning (Epic 2 → 6)

#### `tool_dependency`

| Column             | Type                      | Notes                      |
| ------------------ | ------------------------- | -------------------------- |
| `from_tool_id`     | `TEXT NOT NULL`           | Source edge.               |
| `to_tool_id`       | `TEXT NOT NULL`           | Destination edge.          |
| `observed_count`   | `INTEGER DEFAULT 1`       | Observed frequency.        |
| `confidence_score` | `REAL DEFAULT 0.5`        | Weighted score.            |
| `last_observed`    | `TIMESTAMP DEFAULT NOW()` | Last update.               |
| `source`           | `TEXT DEFAULT 'learned'`  | `learned`, `user`, `hint`. |

PK `(from_tool_id, to_tool_id)`. Indexes: `idx_tool_dependency_from`, `idx_tool_dependency_to`,
`idx_tool_dependency_confidence`, `idx_tool_dependency_source`.

#### `workflow_execution`

| Column              | Type                                         | Notes                       |
| ------------------- | -------------------------------------------- | --------------------------- |
| `execution_id`      | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` | —                           |
| `executed_at`       | `TIMESTAMP DEFAULT NOW()`                    | Timestamp.                  |
| `intent_text`       | `TEXT`                                       | User prompt.                |
| `dag_structure`     | `JSONB NOT NULL`                             | Complete DAG (tasks, deps). |
| `success`           | `BOOLEAN NOT NULL`                           | Overall result.             |
| `execution_time_ms` | `INTEGER NOT NULL`                           | Total duration.             |
| `error_message`     | `TEXT`                                       | Summary stack on failure.   |
| `code_snippet`      | `TEXT` (migration 011)                       | Executed code.              |
| `code_hash`         | `TEXT` (migration 011)                       | Normalized SHA-256.         |

Indexes: `idx_execution_timestamp`, `idx_workflow_execution_code_hash` (partial, non-null).

#### `workflow_pattern`

| Column              | Type                                                  | Notes                   |
| ------------------- | ----------------------------------------------------- | ----------------------- |
| `pattern_id`        | `UUID PRIMARY KEY DEFAULT gen_random_uuid()`          | —                       |
| `pattern_hash`      | `TEXT UNIQUE NOT NULL`                                | DAG hash.               |
| `dag_structure`     | `JSONB NOT NULL`                                      | Workflow snapshot.      |
| `intent_embedding`  | `vector(1024) NOT NULL`                               | For semantic search.    |
| `usage_count`       | `INTEGER DEFAULT 1`                                   | Total observations.     |
| `success_count`     | `INTEGER DEFAULT 0`                                   | Successes.              |
| `last_used`         | `TIMESTAMP DEFAULT NOW()`                             | Last usage.             |
| `code_snippet`      | `TEXT`                                                | Capability code.        |
| `code_hash`         | `TEXT`                                                | Unique (partial index). |
| `parameters_schema` | `JSONB`                                               | Input description.      |
| `cache_config`      | `JSONB DEFAULT '{"ttl_ms":3600000,"cacheable":true}'` | TTL / invalidation.     |
| `name`              | `TEXT`                                                | Human name.             |
| `description`       | `TEXT`                                                | Description.            |
| `success_rate`      | `REAL DEFAULT 1.0`                                    | Ratio.                  |
| `avg_duration_ms`   | `INTEGER DEFAULT 0`                                   | Average time.           |
| `created_at`        | `TIMESTAMPTZ DEFAULT NOW()`                           | Promotion date.         |
| `source`            | `TEXT DEFAULT 'emergent'`                             | `emergent` or `manual`. |

Indexes: `idx_pattern_intent_embedding` (HNSW), `idx_workflow_pattern_code_hash` (partial).

#### `adaptive_config`

| Column          | Type                      | Notes                         |
| --------------- | ------------------------- | ----------------------------- |
| `config_key`    | `TEXT PRIMARY KEY`        | `threshold_speculative`, etc. |
| `config_value`  | `REAL NOT NULL`           | Current value.                |
| `last_updated`  | `TIMESTAMP DEFAULT NOW()` | —                             |
| `total_samples` | `INTEGER DEFAULT 0`       | Learning counter.             |

### 1.3 Adaptive Intelligence (ADR-008 / Episodic Memory)

#### `episodic_events`

| Column         | Type                        | Notes                                                                                                        |
| -------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `id`           | `TEXT PRIMARY KEY`          | UUID v4.                                                                                                     |
| `workflow_id`  | `TEXT NOT NULL`             | Groups events.                                                                                               |
| `event_type`   | `TEXT NOT NULL`             | `speculation_start`, `task_complete`, `ail_decision`, `hil_decision`, `workflow_start`, `workflow_complete`. |
| `task_id`      | `TEXT`                      | Optional.                                                                                                    |
| `timestamp`    | `TIMESTAMPTZ DEFAULT NOW()` | Ordering.                                                                                                    |
| `context_hash` | `TEXT`                      | Hash of contextual dimensions.                                                                               |
| `data`         | `JSONB NOT NULL`            | Free payload (prediction/result).                                                                            |

Indexes: `idx_episodic_workflow`, `idx_episodic_type`, `idx_episodic_timestamp`,
`idx_episodic_context_hash`, `idx_episodic_data` (GIN). Retention: 30 days or 10k events.

#### `adaptive_thresholds`

| Column                 | Type                         | Notes                              |
| ---------------------- | ---------------------------- | ---------------------------------- |
| `context_hash`         | `TEXT PRIMARY KEY`           | Lookup key.                        |
| `context_keys`         | `JSONB NOT NULL`             | Details (workflowType, domain...). |
| `suggestion_threshold` | `REAL NOT NULL DEFAULT 0.70` | Bounded 0.40–0.90.                 |
| `explicit_threshold`   | `REAL NOT NULL DEFAULT 0.50` | Bounded 0.30–0.80.                 |
| `success_rate`         | `REAL`                       | 0.0–1.0 nullable.                  |
| `sample_count`         | `INTEGER DEFAULT 0`          | #observations.                     |
| `created_at`           | `TIMESTAMPTZ DEFAULT NOW()`  | —                                  |
| `updated_at`           | `TIMESTAMPTZ DEFAULT NOW()`  | —                                  |

Indexes: `idx_adaptive_updated`, `idx_adaptive_context_keys` (GIN).

### 1.4 Workflow Continuity & DAG State

#### `workflow_checkpoint`

| Column        | Type                        | Notes                       |
| ------------- | --------------------------- | --------------------------- |
| `id`          | `TEXT PRIMARY KEY`          | UUID v4.                    |
| `workflow_id` | `TEXT NOT NULL`             | Common identifier.          |
| `timestamp`   | `TIMESTAMPTZ DEFAULT NOW()` | For pruning.                |
| `layer`       | `INTEGER NOT NULL`          | Current DAG layer (>=0).    |
| `state`       | `JSONB NOT NULL`            | Serialized `WorkflowState`. |

Indexes: `idx_checkpoint_workflow_ts`, `idx_checkpoint_workflow_id`. Retention: 5 checkpoints /
workflow.

#### `workflow_dags`

| Column        | Type                                            | Notes                     |
| ------------- | ----------------------------------------------- | ------------------------- |
| `workflow_id` | `TEXT PRIMARY KEY`                              | Aligned with checkpoints. |
| `dag`         | `JSONB NOT NULL`                                | `DAGStructure`.           |
| `intent`      | `TEXT`                                          | For debug.                |
| `created_at`  | `TIMESTAMPTZ DEFAULT NOW()`                     | —                         |
| `expires_at`  | `TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour'` | Auto cleanup.             |

Index: `idx_workflow_dags_expires`.

### 1.5 Capabilities (Epic 7 + Epic 13)

#### `capability_records` (Epic 13)

Registry table for capability metadata. Links to `workflow_pattern` via FK for code/embedding/stats.

| Column                | Type                           | Notes                                        |
| --------------------- | ------------------------------ | -------------------------------------------- |
| `id`                  | `UUID PRIMARY KEY`             | Immutable identifier.                        |
| `org`                 | `TEXT NOT NULL`                | Organization scope (default: "local").       |
| `project`             | `TEXT NOT NULL`                | Project scope (default: "default").          |
| `namespace`           | `TEXT NOT NULL`                | Capability namespace (e.g., "fs", "math").   |
| `action`              | `TEXT NOT NULL`                | Capability action (e.g., "read_json").       |
| `hash`                | `TEXT NOT NULL`                | 4-char code hash prefix for FQDN.            |
| `workflow_pattern_id` | `UUID REFERENCES workflow_pattern(pattern_id)` | FK to code/embedding/stats. |
| `created_by`          | `TEXT DEFAULT 'local'`         | Creator identifier.                          |
| `created_at`          | `TIMESTAMPTZ DEFAULT NOW()`    | Creation timestamp.                          |
| `updated_by`          | `TEXT`                         | Last updater.                                |
| `updated_at`          | `TIMESTAMPTZ`                  | Last update timestamp.                       |
| `version`             | `INTEGER DEFAULT 1`            | Version number.                              |
| `version_tag`         | `TEXT`                         | Semantic version tag.                        |
| `verified`            | `BOOLEAN DEFAULT false`        | Verification status.                         |
| `signature`           | `TEXT`                         | Cryptographic signature.                     |
| `usage_count`         | `INTEGER DEFAULT 0`            | Total invocations.                           |
| `success_count`       | `INTEGER DEFAULT 0`            | Successful invocations.                      |
| `total_latency_ms`    | `BIGINT DEFAULT 0`             | Cumulative latency.                          |
| `tags`                | `TEXT[] DEFAULT '{}'`          | User-defined tags.                           |
| `visibility`          | `TEXT DEFAULT 'private'`       | `private`, `project`, `org`, `public`.       |
| `routing`             | `TEXT DEFAULT 'local'`         | `local` or `cloud` execution.                |

**FQDN Format:** `{org}.{project}.{namespace}.{action}.{hash}` (e.g., `local.default.fs.read_json.a7f3`)

**Display Name:** `{namespace}:{action}` (e.g., `fs:read_json`)

Indexes: `idx_capability_records_workflow_pattern`, unique constraint on `(org, project, namespace, action, hash)`.

**Important:** Migration 023 removed duplicated columns (`code_snippet`, `description`, `parameters_schema`, `tools_used`) from `capability_records`. These are now accessed via FK join to `workflow_pattern`.

> ⚠️ **Critical ID Relationship:**
> - Graph nodes use `capability:${capability_records.id}` (capability UUID)
> - `workflow_pattern.pattern_id` is a **different** UUID
> - Link: `capability_records.workflow_pattern_id` → `workflow_pattern.pattern_id`
>
> **When querying embeddings** (e.g., for semantic entropy), you MUST join via the FK:
> ```sql
> SELECT cr.id, wp.intent_embedding
> FROM capability_records cr
> JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id
> WHERE cr.id = ANY($1::uuid[])
> ```
> Do NOT assume `pattern_id = capability_records.id` - this was a bug fixed in Dec 2024.

> ⚠️ **Usage Metrics - Two Different Concepts:**
>
> | Metric | Table | What it measures |
> |--------|-------|------------------|
> | `workflow_pattern.usage_count` | workflow_pattern | Code reuse (same code_hash executed again) |
> | `COUNT(*) FROM execution_trace` | execution_trace | Tool activity (for SHGAT frequency features) |
>
> - **workflow_pattern.usage_count**: Incremented when capability code is matched and reused
> - **execution_trace**: Counts individual tool invocations in traces (used by SHGAT for ML)
>
> These are NOT the same metric. Do not consolidate them.
>
> **Migration 034** removed unused `usage_count`/`success_count`/`total_latency_ms` columns
> from `capability_records`. All queries now JOIN with `workflow_pattern` for accurate stats.

#### `workflow_pattern.dag_structure` JSONB Schema

The `dag_structure` JSONB field contains:

```json
{
  "type": "code_execution",
  "tools_used": ["filesystem:fast_read_file", "std:cap_list"],
  "intent_text": "Read deno.json and list all task names",
  "tool_invocations": []
}
```

| Field              | Type       | Description                                      |
| ------------------ | ---------- | ------------------------------------------------ |
| `type`             | `string`   | Execution type (`code_execution`, `dag`, etc.).  |
| `tools_used`       | `string[]` | MCP tools invoked by this capability.            |
| `intent_text`      | `string`   | Original user intent.                            |
| `tool_invocations` | `array`    | Detailed invocation records (optional).          |

**Note:** `tools_used` is extracted from `dag_structure->'tools_used'` for operations like `cap:merge`.

### 1.6 Telemetry & Operational Logging

#### `metrics`

| Column        | Type                        | Notes                                         |
| ------------- | --------------------------- | --------------------------------------------- |
| `id`          | `SERIAL PRIMARY KEY`        | —                                             |
| `metric_name` | `TEXT NOT NULL`             | `context_usage_pct`, `query_latency_ms`, etc. |
| `value`       | `REAL NOT NULL`             | Numeric value.                                |
| `timestamp`   | `TIMESTAMPTZ DEFAULT NOW()` | Time series.                                  |
| `metadata`    | `JSONB`                     | Context (tool ids, intent).                   |

Indexes: `idx_metrics_name_timestamp`, `idx_metrics_timestamp`. Target retention: 90 days.

#### `error_log`

| Column       | Type                      | Notes                                   |
| ------------ | ------------------------- | --------------------------------------- |
| `id`         | `SERIAL PRIMARY KEY`      | —                                       |
| `error_type` | `TEXT NOT NULL`           | Category (`GraphRAG`, `Sandbox`, etc.). |
| `message`    | `TEXT NOT NULL`           | Main message.                           |
| `stack`      | `TEXT`                    | Stack trace.                            |
| `context`    | `JSONB`                   | Extra data.                             |
| `timestamp`  | `TIMESTAMP DEFAULT NOW()` | —                                       |

Indexes: `idx_error_log_timestamp`, `idx_error_log_type`.

### 1.4 Capabilities & Future Epic 7

| Table                                 | Key Columns                                                             | Description                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `workflow_pattern` (extension Epic 7) | + `code_snippet TEXT`, `parameters JSONB`, `cache_config JSONB`, `name` | Stores materialized capabilities (code, TTL, invalidation). |
| `workflow_dags`                       | `workflow_id`, `dag JSONB`, `status`, `created_at`                      | Gateway-side DAG planning (Story 6.x).                      |
| `workflow_checkpoints`                | `workflow_id`, `checkpoint_index`, `state JSONB`, `created_at`          | Enables resume/recovery (Story 6.4).                        |

### 1.5 Telemetry / Observability

| Table                              | Key Columns                                           | Description                                                                                               |
| ---------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `metrics` (ex-`telemetry_metrics`) | `metric_name`, `value`, `metadata JSONB`, `timestamp` | Simple time-series (counts, latency). Index `(metric_name, timestamp DESC)`. Future export to ClickHouse. |

---

## 2. Drizzle ORM (PGlite driver)

| Table   | Description                                     | Source                   |
| ------- | ----------------------------------------------- | ------------------------ |
| `users` | Multi-tenant accounts (GitHub OAuth + API keys) | `src/db/schema/users.ts` |

### 2.1 `users` (Drizzle schema)

| Column            | Type                                     | Notes                                                  |
| ----------------- | ---------------------------------------- | ------------------------------------------------------ |
| `id`              | `uuid("id").primaryKey()`                | UUID v4 generated DB-side (Drizzle `defaultRandom()`). |
| `githubId`        | `text("github_id").unique()`             | GitHub ID (string). Nullable if API key only.          |
| `username`        | `text("username").notNull()`             | Displayed handle (GitHub login or alias).              |
| `email`           | `text("email")`                          | Can be `NULL` if not provided.                         |
| `avatarUrl`       | `text("avatar_url")`                     | GitHub avatar URL.                                     |
| `role`            | `text("role").default("user")`           | `user`, `admin`, `ops` (future RBAC).                  |
| `apiKeyHash`      | `text("api_key_hash")`                   | Argon2id hash (`hashApiKey`).                          |
| `apiKeyPrefix`    | `text("api_key_prefix").unique()`        | Prefix `ac_xxxxxx` for fast lookup (11 chars).         |
| `apiKeyCreatedAt` | `timestamp(..., { withTimezone: true })` | Generation timestamp.                                  |
| `createdAt`       | `timestamp(...).defaultNow()`            | Account creation.                                      |
| `updatedAt`       | `timestamp(...).defaultNow()`            | `DEFAULT NOW()` + future trigger.                      |

Constraints:

- `apiKeyPrefix` unique (collision detected).
- `githubId` unique.
- `username` `NOT NULL` (serves as CLI identifier).

Drizzle Roadmap:

- Future tables (`sessions`, `user_secrets`, `user_mcp_configs`) will be added in `src/db/schema/`
  during Epic 9.

> ✅ Decision: We progressively migrate other SQL tables to Drizzle (Epic 9), but until done,
> `users` remains the only table exposed via `src/db/schema`.

---

## 3. Deno KV

`src/server/auth/kv.ts` exposes a singleton `getKv()` used by auth/session modules. Keys follow a
`namespace:key` convention.

| KV Namespace         | Content                                                | Retention                   | Product Owner |
| -------------------- | ------------------------------------------------------ | --------------------------- | ------------- |
| `auth/session:*`     | GitHub OAuth sessions (access_token + minimal profile) | TTL 24h, invalidated logout | Platform      |
| `auth/pending:*`     | PKCE/verifier state during OAuth dance                 | TTL 15 min                  | Platform      |
| `auth/api-key:*`     | API key proof (rate limiting)                          | TTL 1h                      | Platform      |
| (future) `secrets/*` | Encrypted user secrets cache (KMS envelope)            | TTL 10 min + LRU eviction   | Capabilities  |

### 3.1 KV Details

| Namespace                                   | Key format              | Value                                                   |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `auth/session:${sessionId}`                 | `sessionId` = UUID v4   | `{ userId, githubToken, expiresAt }` (JSON serialized)  |
| `auth/pending:${state}`                     | `state` = random string | `{ verifier, createdAt, redirectUri }`                  |
| `auth/api-key:${prefix}`                    | `prefix` = `ac_xxxxx`   | `{ userId, lastUsedAt, windowCount }` for rate limiting |
| `secrets:${userId}:${secretName}` (planned) | user-scoped             | `{ ciphertext, expiresAt }` (cache of `user_secrets`)   |

Policy:

- KV used only for volatile data (24h max). Persistent data must go to SQL (`users`, future
  `user_secrets`).

> KV is ideal for volatile data. For persistent secrets we plan an encrypted SQL table
> (`user_secrets` + KMS envelope encryption).

---

## 4. Main Flows

### 4.1 Detailed Sequences

1. **Tool Discovery (Story 1.x / 2.x)**

   - `mcp-tool-sync` invokes each MCP → `tool_schema`.
   - Embedding pipeline (`vector/embed.ts`) → `tool_embedding` + HNSW.
   - `vectorSearch.searchTools()` combines:
     - Cosine similarity (pgvector)
     - Graph score (Adamic-Adar) via `tool_dependency`
     - Adaptive alpha (density-based)

2. **Workflow Execution / Learning (Stories 3-6)**

   - Instrumented sandbox ➜ JSON traces.
   - `workflow_execution` receives actual DAG + outcome.
   - `GraphRAGEngine.updateFromExecution()`:
     - Increments `tool_dependency`.
     - Recomputes PageRank + Louvain in memory.
   - `episodic_events` stores key events (speculation, decisions, results).
   - `AdaptiveThresholdManager` writes to `adaptive_thresholds`.

3. **Capabilities (Epic 7)**

   - `workflow_pattern` detects recurring intent embeddings.
   - Promotion pipeline → writes `code_snippet`, `parameters`, `cache_config`.
   - Cache TTL in `workflow_pattern.cache_config`.

4. **Auth & Secrets (Cloud)**
   - GitHub OAuth: `users` + `kv://auth/session`.
   - API keys: Argon2id (`apiKeyHash`, `apiKeyPrefix`).
   - (Planned) Client secrets: `user_secrets` (AES-256-GCM + KMS), `user_mcp_configs`.

---

## 5. Data Roadmap

| Item                    | Description                                                             | Status                |
| ----------------------- | ----------------------------------------------------------------------- | --------------------- |
| Drizzle full adoption   | Generate all SQL tables via Drizzle (GraphRAG, episodic, metrics…)      | 🚧 Epic 9             |
| Encrypted secrets       | `user_secrets` + `user_mcp_configs` (KMS envelope encryption, KV cache) | 📝 Design in progress |
| Unified observability   | Export `metrics` + `workflow_execution` to ClickHouse/Prometheus        | 🧊 Backlog            |
| Data retention policies | Formalize prune jobs (episodic 30d, metrics 90d, workflows 6m)          | 📝 To document        |

---

### References

- `src/graphrag/graph-engine.ts`, `dag-suggester.ts`
- `docs/adrs/ADR-038-scoring-algorithms-reference.md`
- `docs/spikes/2025-12-03-dynamic-mcp-composition.md`
