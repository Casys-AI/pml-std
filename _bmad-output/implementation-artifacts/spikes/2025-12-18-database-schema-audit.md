# Spike: Database Schema Audit — Complete Analysis

**Date:** 2025-12-18 **Author:** Architecture Review **Status:** Complete **Related:** Epic 10 (DAG
Capability Learning), ADR-037 (Deno KV), ADR-041 (Trace Hierarchy)

---

## Executive Summary

Audit complet du schéma PGlite de Casys PML. Identifie **20 tables** réparties sur **18
migrations**. Révèle des duplications, des FKs manquantes, et des clarifications nécessaires.

**Actions immédiates (Epic 11 - Story 11.0):**

- `workflow_dags` → Deno KV
- Merger `tool_schema` et `mcp_tool`
- Ajouter FK sur `permission_audit_log`
- Supprimer colonne redondante `source` de `tool_dependency`

**Actions Epic 11 (Stories 11.2+):**

- `workflow_execution` → remplacée par `execution_trace` (Story 11.2)

**Actions futures (hors Epic 11):**

- Renommer `workflow_pattern` → `capability` (breaking change significatif)
- Renommer `adaptive_config` → `default_thresholds`

---

## 1. Inventaire Complet des Tables

### 1.1 Tables de Configuration (3)

| Table                 | Migration | Description                                            | Utilisée par            |
| --------------------- | --------- | ------------------------------------------------------ | ----------------------- |
| `config`              | 001       | Key-value store générique                              | Peu utilisée            |
| `adaptive_config`     | 010       | Seuils **globaux** (speculative, suggestion, explicit) | `workflow-sync.ts`      |
| `adaptive_thresholds` | 007       | Seuils **par contexte** (context_hash → thresholds)    | `adaptive-threshold.ts` |

**Clarification `adaptive_config` vs `adaptive_thresholds`:**

```
adaptive_config (GLOBAL)              adaptive_thresholds (PER-CONTEXT)
─────────────────────────             ─────────────────────────────────
config_key: "threshold_suggestion"    context_hash: "abc123"
config_value: 0.70                    context_keys: {"domain": "finance"}
                                      suggestion_threshold: 0.75
                                      explicit_threshold: 0.55
```

- `adaptive_config` = defaults système (3 valeurs fixes)
- `adaptive_thresholds` = apprentissage par contexte (N entrées dynamiques)

**Verdict:** Pas de duplication, mais **naming confus**. Suggestion: renommer `adaptive_config` →
`default_thresholds`.

---

### 1.2 Tables MCP Tools (4)

| Table            | Migration | Description                       | Utilisée par                        |
| ---------------- | --------- | --------------------------------- | ----------------------------------- |
| `tool_schema`    | 001       | Cache des définitions MCP tools   | `schema-extractor.ts`, `db-sync.ts` |
| `tool_embedding` | 001       | Embeddings vector(1024) des tools | `embeddings.ts`, `search.ts`        |
| `mcp_server`     | 004       | Serveurs MCP enregistrés          | `gateway-server.ts`                 |
| `mcp_tool`       | 004       | Tools MCP par serveur             | E2E tests surtout                   |

**Duplication identifiée:**

```
tool_schema (Migration 001)          mcp_tool (Migration 004)
───────────────────────────          ────────────────────────
tool_id TEXT PRIMARY KEY             id SERIAL PRIMARY KEY
server_id TEXT NOT NULL              server_id TEXT NOT NULL
name TEXT NOT NULL                   tool_name TEXT NOT NULL
description TEXT                     tool_schema JSONB NOT NULL
input_schema JSONB NOT NULL
output_schema JSONB
```

**Verdict:** `tool_schema` est la table principale (utilisée partout). `mcp_tool` a été créée pour
les E2E tests avec un schéma différent.

**Recommandation:** Merger vers `tool_schema`, adapter les tests E2E.

---

### 1.3 Tables Capabilities / Patterns (3)

| Table                   | Migration     | Description                          | Utilisée par                             |
| ----------------------- | ------------- | ------------------------------------ | ---------------------------------------- |
| `workflow_pattern`      | 010+011+15+17 | **Capabilities** (mal nommée)        | `capability-store.ts`, `db-sync.ts`      |
| `capability_dependency` | 016           | Edges Capability→Capability          | `capability-store.ts`, `data-service.ts` |
| `permission_audit_log`  | 018           | Audit des escalations de permissions | `permission-audit-store.ts`              |

**Structure `workflow_pattern` après toutes les migrations:**

```sql
workflow_pattern (
  -- Core (Migration 010)
  pattern_id UUID PRIMARY KEY,
  pattern_hash TEXT UNIQUE NOT NULL,
  dag_structure JSONB NOT NULL,
  intent_embedding vector(1024) NOT NULL,
  usage_count INTEGER DEFAULT 1,
  success_count INTEGER DEFAULT 0,
  last_used TIMESTAMP,

  -- Capability Storage (Migration 011)
  code_snippet TEXT,
  code_hash TEXT,
  parameters_schema JSONB,
  cache_config JSONB,
  name TEXT,
  description TEXT,
  success_rate REAL DEFAULT 1.0,
  avg_duration_ms INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ,
  source TEXT DEFAULT 'emergent',

  -- Community (Migration 015)
  community_id INTEGER,

  -- Permissions (Migration 017)
  permission_set VARCHAR(50) DEFAULT 'minimal',
  permission_confidence REAL DEFAULT 0.0
)
```

**Naming:** `workflow_pattern` devrait s'appeler `capability`. **Action future:** Renommer (breaking
change significatif).

---

### 1.4 Tables Execution & Traces (4)

| Table                 | Migration | Description                      | Utilisée par                 | Status          |
| --------------------- | --------- | -------------------------------- | ---------------------------- | --------------- |
| `workflow_execution`  | 010+013   | Historique d'exécution           | `db-sync.ts`, `collector.ts` | **À SUPPRIMER** |
| `workflow_checkpoint` | 006       | Checkpoints pour resume          | `checkpoint-manager.ts`      | OK              |
| `workflow_dags`       | 008       | État temporaire MCP continuation | `workflow-dag-store.ts`      | **→ KV**        |
| `algorithm_traces`    | 014       | Traces des décisions de scoring  | `algorithm-tracer.ts`        | OK              |

**Problème `workflow_execution`:**

```sql
-- ACTUEL: pas de FK, stocke dag_structure en dur
workflow_execution (
  execution_id UUID PRIMARY KEY,
  dag_structure JSONB NOT NULL,  -- Redondant!
  success BOOLEAN,
  execution_time_ms INTEGER,
  user_id TEXT,  -- Migration 013
  ...
)

-- FUTUR (Story 10.4): execution_trace avec FK
execution_trace (
  id UUID PRIMARY KEY,
  capability_id UUID REFERENCES workflow_pattern(pattern_id),  -- FK!
  executed_path TEXT[],
  decisions JSONB,
  priority FLOAT,  -- PER
  ...
)
```

---

### 1.5 Tables Episodic Memory (1)

| Table             | Migration | Description                               | Utilisée par               |
| ----------------- | --------- | ----------------------------------------- | -------------------------- |
| `episodic_events` | 007       | Événements de workflow pour apprentissage | `episodic-memory-store.ts` |

**Structure:**

```sql
episodic_events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- 'speculation_start', 'task_complete', 'ail_decision', etc.
  task_id TEXT,
  timestamp TIMESTAMPTZ,
  context_hash TEXT,
  data JSONB NOT NULL
)
```

**Distinction avec `algorithm_traces`:**

| Aspect  | `episodic_events`                 | `algorithm_traces`            |
| ------- | --------------------------------- | ----------------------------- |
| ADR     | ADR-008                           | ADR-039                       |
| Scope   | Événements workflow               | Décisions de scoring          |
| Contenu | task_complete, ail_decision, etc. | signals, params, final_score  |
| Usage   | Retrieval pour context boosting   | Observabilité des algorithmes |

**Verdict:** Pas de duplication, périmètres différents.

---

### 1.6 Tables Graphs (2)

| Table                   | Migration   | Description                 | Utilisée par                                        |
| ----------------------- | ----------- | --------------------------- | --------------------------------------------------- |
| `tool_dependency`       | 010+009+012 | Edges Tool→Tool             | `db-sync.ts`, `workflow-sync.ts`, `alternatives.ts` |
| `capability_dependency` | 016         | Edges Capability→Capability | `capability-store.ts`                               |

**Structure `tool_dependency`:**

```sql
tool_dependency (
  from_tool_id TEXT NOT NULL,
  to_tool_id TEXT NOT NULL,
  observed_count INTEGER DEFAULT 1,
  confidence_score REAL DEFAULT 0.5,
  last_observed TIMESTAMP,
  source TEXT DEFAULT 'learned',        -- Migration 009
  edge_type TEXT DEFAULT 'sequence',    -- Migration 012
  edge_source TEXT DEFAULT 'inferred',  -- Migration 012
  PRIMARY KEY (from_tool_id, to_tool_id)
)
```

**Note:** `source` (mig 009) vs `edge_source` (mig 012) = redondance.

- `source`: 'user' | 'learned' | 'hint'
- `edge_source`: 'template' | 'inferred' | 'observed'

**Clarification:** `source` = origine, `edge_source` = niveau de confiance. Pourrait être simplifié
en gardant uniquement `edge_source`.

---

### 1.7 Tables Logging (2)

| Table       | Migration | Description       | Utilisée par            |
| ----------- | --------- | ----------------- | ----------------------- |
| `metrics`   | 002       | Telemetry metrics | `metrics.ts`            |
| `error_log` | 003       | Error logging     | `sentry.ts` (optionnel) |

**Verdict:** OK, pas de problème.

---

## 2. Problèmes Identifiés

### 2.1 Duplications

| Problème              | Tables                     | Sévérité | Action                          |
| --------------------- | -------------------------- | -------- | ------------------------------- |
| MCP tools en double   | `tool_schema` + `mcp_tool` | Moyenne  | Merger vers `tool_schema`       |
| Source vs edge_source | `tool_dependency` colonnes | Faible   | Garder `edge_source` uniquement |

### 2.2 FKs Manquantes

```sql
-- MANQUE: workflow_execution → workflow_pattern
-- Sera corrigé par execution_trace (Story 10.4)

-- MANQUE: permission_audit_log → workflow_pattern
ALTER TABLE permission_audit_log
  ALTER COLUMN capability_id TYPE UUID USING capability_id::uuid;
ALTER TABLE permission_audit_log
  ADD CONSTRAINT fk_permission_audit_capability
  FOREIGN KEY (capability_id) REFERENCES workflow_pattern(pattern_id);

-- MANQUE: mcp_tool → mcp_server (si on garde mcp_tool)
ALTER TABLE mcp_tool
  ADD CONSTRAINT fk_mcp_tool_server
  FOREIGN KEY (server_id) REFERENCES mcp_server(server_id);
```

### 2.3 Naming Confus

| Actuel             | Devrait être         | Breaking? |
| ------------------ | -------------------- | --------- |
| `workflow_pattern` | `capability`         | **Oui**   |
| `adaptive_config`  | `default_thresholds` | Non       |
| `tool_dependency`  | `tool_edge`          | Faible    |

### 2.4 Tables à Migrer (Epic 11)

| Table                | Action                   | Story | Raison                         |
| -------------------- | ------------------------ | ----- | ------------------------------ |
| `workflow_dags`      | → Deno KV                | 11.0  | État temporaire, TTL natif     |
| `mcp_tool`           | DROP (merge tool_schema) | 11.0  | Duplication                    |
| `workflow_execution` | → `execution_trace`      | 11.2  | FK capability, champs learning |

---

## 3. Fichiers Utilisant Chaque Table

### 3.1 Tables Critiques (haute utilisation)

**`workflow_pattern` (Capability):**

```
src/capabilities/capability-store.ts    -- CRUD principal
src/capabilities/data-service.ts        -- Queries agrégées
src/graphrag/sync/db-sync.ts           -- Sync patterns
src/graphrag/metrics/collector.ts      -- Métriques
```

**`tool_schema`:**

```
src/mcp/schema-extractor.ts            -- Extraction MCP
src/graphrag/sync/db-sync.ts           -- Sync tools
src/vector/search.ts                   -- Recherche sémantique
src/capabilities/schema-inferrer.ts    -- Inférence schémas
```

**`tool_dependency`:**

```
src/graphrag/sync/db-sync.ts           -- Création edges
src/graphrag/workflow-sync.ts          -- Sync workflows
src/graphrag/prediction/alternatives.ts -- Prédiction
```

### 3.2 Tables Moyennement Utilisées

**`episodic_events`:**

```
src/learning/episodic-memory-store.ts  -- Store principal
```

**`adaptive_thresholds`:**

```
src/mcp/adaptive-threshold.ts          -- Gestion seuils
```

**`algorithm_traces`:**

```
src/telemetry/algorithm-tracer.ts      -- Tracer ADR-039
```

### 3.3 Tables Peu Utilisées

**`mcp_tool` / `mcp_server`:**

```
src/mcp/gateway-server.ts              -- Gateway MCP
src/cli/commands/serve.ts              -- CLI serve
-- Principalement E2E tests
```

**`config`:**

```
-- Peu utilisée, remplacée par adaptive_config
```

---

## 4. Recommandations

### 4.1 Actions Immédiates (Epic 11 - Story 11.0)

| Action                                     | Story | Effort |
| ------------------------------------------ | ----- | ------ |
| `workflow_dags` → Deno KV                  | 11.0  | 1j     |
| DROP `mcp_tool` (merger vers tool_schema)  | 11.0  | 0.5j   |
| FK sur `permission_audit_log`              | 11.0  | 0.5j   |
| DROP colonne `source` de `tool_dependency` | 11.0  | 0.5j   |

### 4.2 Actions Epic 11 (Post-11.0)

| Action                                               | Story | Effort |
| ---------------------------------------------------- | ----- | ------ |
| DROP `workflow_execution` + CREATE `execution_trace` | 11.2  | 2-3j   |

### 4.3 Actions Futures (Post-Epic 11)

| Action                                            | Effort | Breaking? |
| ------------------------------------------------- | ------ | --------- |
| Renommer `workflow_pattern` → `capability`        | 2-3j   | **Oui**   |
| Renommer `adaptive_config` → `default_thresholds` | 0.5j   | Non       |

### 4.4 Schema Cible (Post-Cleanup)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CONFIGURATION                                                           │
├─────────────────────────────────────────────────────────────────────────┤
│  default_thresholds (ex adaptive_config)                                 │
│  adaptive_thresholds (per-context)                                       │
│  config (key-value)                                                      │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  MCP TOOLS                                                               │
├─────────────────────────────────────────────────────────────────────────┤
│  tool_schema (unified, ex tool_schema + mcp_tool)                        │
│  tool_embedding                                                          │
│  mcp_server                                                              │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  CAPABILITIES                                                            │
├─────────────────────────────────────────────────────────────────────────┤
│  capability (ex workflow_pattern)                                        │
│  capability_dependency ──FK──▶ capability                                │
│  permission_audit_log ──FK──▶ capability                                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  EXECUTION & LEARNING                                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  execution_trace ──FK──▶ capability (NEW, Story 10.4)                    │
│  workflow_checkpoint                                                     │
│  episodic_events                                                         │
│  algorithm_traces                                                        │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  GRAPHS                                                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  tool_dependency (tool → tool edges)                                     │
│  capability_dependency (capability → capability edges)                   │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  LOGGING                                                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  metrics                                                                 │
│  error_log                                                               │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  DENO KV (Runtime State)                                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  ["workflow", workflowId] → { dag, intent, expiresIn }                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Migration SQL Proposées (Future Story)

### 5.1 FK pour permission_audit_log

```sql
-- Backup data
CREATE TABLE permission_audit_log_backup AS SELECT * FROM permission_audit_log;

-- Recreate with proper FK
DROP TABLE permission_audit_log;

CREATE TABLE permission_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  capability_id UUID NOT NULL REFERENCES workflow_pattern(pattern_id),
  from_set TEXT NOT NULL,
  to_set TEXT NOT NULL,
  approved BOOLEAN NOT NULL,
  approved_by TEXT,
  reason TEXT,
  detected_operation TEXT
);

-- Restore data (if any)
INSERT INTO permission_audit_log (id, timestamp, capability_id, from_set, to_set, approved, approved_by, reason, detected_operation)
SELECT id::uuid, to_timestamp(timestamp/1000), capability_id::uuid, from_set, to_set, approved::boolean, approved_by, reason, detected_operation
FROM permission_audit_log_backup;

DROP TABLE permission_audit_log_backup;
```

### 5.2 Merger mcp_tool → tool_schema

```sql
-- Vérifier que toutes les données de mcp_tool sont dans tool_schema
-- (normalement oui car tool_schema est la source principale)

-- Drop mcp_tool
DROP TABLE IF EXISTS mcp_tool CASCADE;

-- Optionnel: ajouter colonne connection_info à tool_schema si nécessaire
-- ALTER TABLE tool_schema ADD COLUMN IF NOT EXISTS connection_info JSONB;
```

---

## 6. Conclusion

Le schéma DB a évolué organiquement avec les epics, résultant en quelques incohérences. L'Epic 11
corrige tous les problèmes dans Story 11.0 (cleanup) et Story 11.2 (execution_trace).

**Priorités:**

1. **Story 11.0** - Cleanup complet : KV migration, merge mcp_tool, FK, drop source
2. **Story 11.2** - `workflow_execution` → `execution_trace` avec FK capability
3. **Post-Epic 11** - Rename `workflow_pattern` → `capability` (breaking change)
