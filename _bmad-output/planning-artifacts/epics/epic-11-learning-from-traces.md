# Epic 11: Learning from Execution Traces

> **Status:** Proposed (2025-12-18) **Author:** Erwan + Claude **Depends on:** Epic 10 (Capability
> Creation & Unified APIs)

> **⚠️ CLARIFICATION ARCHITECTURE (2025-12-19)**
>
> **Source des traces:** Les traces d'exécution proviennent du **WorkerBridge RPC**, pas d'appels
> MCP directs.
>
> **Pourquoi c'est important:**
>
> - Le Worker exécute avec `permissions: "none"` (sandbox isolée)
> - Tous les appels MCP passent par le proxy RPC (`postMessage`)
> - Cela garantit **100% traçabilité** - aucun appel ne bypass le système
>
> **Prérequis architectural:** Story 10.5 (Architecture Unifiée) doit être complétée pour que
> `ControlledExecutor` utilise `WorkerBridge` au lieu d'appels directs.
>
> Voir: `docs/sprint-artifacts/10-5-execute-code-via-dag.md#architecture-unifiée-2025-12-19`

> **⚠️ SÉPARATION CAPABILITY vs TRACE (2025-12-19)**
>
> **Problème actuel:** `saveCapability()` mélange deux concepts distincts :
>
> ```typescript
> // worker-bridge.ts - ACTUEL (mélange structure et trace)
> await capabilityStore.saveCapability({
>   code,
>   intent, // ← Structure (OK)
>   durationMs,
>   success, // ← Trace (MAUVAIS!)
>   toolsUsed,
>   toolInvocations, // ← Trace (MAUVAIS!)
> });
> ```
>
> **Séparation correcte (Epic 11):**
>
> | Concept        | Table                          | Contenu                                                    | Lifecycle                |
> | -------------- | ------------------------------ | ---------------------------------------------------------- | ------------------------ |
> | **Capability** | `workflow_pattern`             | `code`, `intent`, `static_structure`, `parameters_schema`  | Immutable après création |
> | **Trace**      | `execution_trace` (Story 11.2) | `executed_path`, `task_results`, `decisions`, `durationMs` | Créée à chaque exécution |
>
> **Actions Epic 11:**
>
> - Story 11.1: Capturer `result` dans les traces WorkerBridge
> - Story 11.2: Créer `execution_trace` avec FK vers capability
> - Refactor: `saveCapability()` ne stocke plus `toolsUsed`/`toolInvocations` (→ trace)
> - Les stats agrégées (`avg_duration_ms`, `success_rate`) sont calculées depuis les traces

**Expanded Goal (2-3 sentences):**

Implémenter le système d'apprentissage basé sur les traces d'exécution. Capturer les résultats des
tools/capabilities, stocker les traces avec priorité (PER), et entraîner SHGAT directement sur les
traces avec TD error comme signal. Fournir des vues pour visualiser les patterns d'exécution.

**Architecture Learning Combinée (2025-12-22):**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     TD + PER + SHGAT (style DQN/Rainbow)                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. EXÉCUTION → TRACE                                                       │
│     workflow terminé → execution_trace stockée                              │
│                                                                             │
│  2. TD ERROR (signal d'apprentissage)                                       │
│     td_error = actual_success - shgat.predict(path)                         │
│     └── Si SHGAT prédit 0.9 et outcome = 0.0 → td_error = -0.9 (surprise!) │
│                                                                             │
│  3. PER (priorité de replay)                                                │
│     priority = |td_error|                                                   │
│     └── Traces surprenantes → haute priorité → échantillonnées plus souvent│
│                                                                             │
│  4. SHGAT (le modèle qui apprend)                                           │
│     - Sample traces selon PER priority                                      │
│     - Train attention weights sur ces traces                                │
│     - Loss = td_error² (MSE sur prédiction vs actual)                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Rôle de chaque composant:**

| Composant    | Rôle                   | Ce qu'il produit                        |
| ------------ | ---------------------- | --------------------------------------- |
| **TD Error** | Signal d'apprentissage | `                                       |
| **PER**      | Priorisation du replay | Traces pondérées par surprise           |
| **SHGAT**    | Le modèle lui-même     | Attention weights, scores de prédiction |

**⚠️ DÉPRÉCIATIONS (2025-12-22):**

| Déprécié                           | Remplacé par                       | Raison                                |
| ---------------------------------- | ---------------------------------- | ------------------------------------- |
| `CapabilityLearning` structure     | SHGAT weights                      | SHGAT apprend directement des traces  |
| `workflow_pattern.learning` column | `execution_trace.priority` + SHGAT | Plus de stats intermédiaires          |
| `updateLearningTD()` → stats       | `updatePriority()` → PER only      | TD error = signal pour PER, pas stats |
| `pathSuccessRate` calculé          | SHGAT prédit directement           | Le réseau apprend les patterns        |

**Problèmes Résolus:**

| Problème                                 | Solution                                     | Story       |
| ---------------------------------------- | -------------------------------------------- | ----------- |
| Schema DB avec dette technique           | Cleanup complet (KV, FKs, duplications)      | **11.0**    |
| Pas de capture des résultats d'exécution | Result tracing dans les events               | 11.1        |
| Traces non persistées                    | Table `execution_trace` avec FK capability   | 11.2        |
| Toutes les traces ont même importance    | PER avec TD error comme priority             | 11.3        |
| Apprentissage batch (pas incrémental)    | SHGAT training incrémental avec PER sampling | 11.3 + 11.6 |
| Pas de vue sur les exécutions réelles    | Definition vs Invocation views               | 11.4        |

**Value Delivery:**

- ✅ **Mémoire épisodique** - Traces d'exécution persistées et requêtables
- ✅ **Apprentissage incrémental** - TD Learning met à jour après chaque exécution
- ✅ **Priorisation intelligente** - PER focus sur les traces surprenantes
- ✅ **Observabilité** - Vues Definition (structure) vs Invocation (exécutions)

---

## Relation avec Epic 10

**Epic 10** crée les Capabilities (analyse statique) et les APIs unifiées. **Epic 11** apprend des
exécutions pour enrichir les Capabilities.

### Décision Architecturale: DAG Complet vs Trace Exécutée

| Couche                   | Stocke                                    | Raison                                   | Envoyé au LLM               |
| ------------------------ | ----------------------------------------- | ---------------------------------------- | --------------------------- |
| **Capability** (Epic 10) | DAG complet avec branches conditionnelles | Réutilisabilité, toutes les alternatives | ❌ Non (trop verbeux)       |
| **Trace** (Epic 11)      | Chemin réellement exécuté                 | Learning, résultats concrets             | ✅ Oui (minimal, pertinent) |

**Pourquoi stocker le DAG complet dans Capability ?**

- Les conditions (`file.exists`, `response.status === 200`) ne sont évaluables qu'au runtime
- On ne peut pas savoir à l'avance quel chemin sera pris
- Stocker toutes les branches permet de réutiliser la capability dans différents contextes

**Pourquoi ne retourner que la trace au LLM ?**

- Évite la pollution du contexte avec des branches non prises
- Le LLM n'a besoin que de ce qui s'est passé, pas de ce qui aurait pu se passer
- La trace inclut les `decisions` (quelle branche prise et pourquoi)

> **Note sur l'apprentissage des branches (2025-12-23):**
>
> Actuellement, on **n'apprend PAS sur les branches séparément**. SHGAT apprend sur la capability
> entière (success/fail), pas sur chaque branche individuelle.
>
> **Design voulu:** Les capabilities doivent être des **workflows linéaires**. Les if/else dans le
> code généré sont des **gardes** (error handling, edge cases), pas des **options** métier.
> L'adaptation se fait au niveau de la **sélection** de capability, pas dans les branches internes.
>
> Exemple correct:
>
> ```typescript
> // Garde (OK) - gestion d'erreur
> const result = await mcp.fs.read({ path });
> if (!result.success) throw new Error("File not found");
> await mcp.fs.write({ out, content: result.data });
> ```
>
> Exemple à éviter:
>
> ```typescript
> // Options métier (éviter) - devrait être 2 capabilities séparées
> if (format === "json") {
>   await mcp.json.parse(...);
> } else {
>   await mcp.csv.parse(...);
> }
> ```
>
> Pour le cas "options métier", préférer 2 capabilities distinctes (`parse_json`, `parse_csv`) et
> laisser la sélection choisir la bonne selon le contexte.

**Flow d'exécution :**

```
┌─────────────────────────────────────────────────────────────┐
│  1. Capability.static_structure (DAG complet)               │
│     └── Stocké avec toutes les branches conditionnelles     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ exécution runtime
┌─────────────────────────────────────────────────────────────┐
│  2. Évaluation des conditions au runtime                    │
│     └── file.exists? → true → prend branche A               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ après exécution
┌─────────────────────────────────────────────────────────────┐
│  3. ExecutionTrace (chemin réel)                            │
│     └── executed_path: ["check_file", "read_file"]          │
│     └── decisions: [{nodeId: "d1", outcome: "true"}]        │
│     └── task_results: [...]                                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ retour au LLM
┌─────────────────────────────────────────────────────────────┐
│  4. Réponse minimale                                        │
│     └── Seulement les résultats du chemin exécuté           │
│     └── Pas les branches non prises                         │
└─────────────────────────────────────────────────────────────┘
```

### Flux Epic 10 → Epic 11

```
Epic 10 (Capability Creation)          Epic 11 (Learning from Traces)
─────────────────────────────          ─────────────────────────────────
                                       11.0 DB Schema Cleanup ⭐ FIRST
                                            ↓
10.1 Static Analysis ──────────────▶   11.1 Result Tracing
     ↓                                      ↓
10.3 Provides Edges                    11.2 execution_trace Table
     ↓                                      ↓
10.5 Unified Capability Model          11.3 PER + TD Learning
     ↓                                      ↓
10.6 pml_discover                      11.4 Definition/Invocation Views
     ↓                                      ↓
10.7 pml_execute ──────────────────▶   (traces générées par pml_execute)
     ↓
10.8 pml_get_task_result
```

---

## Story Breakdown - Epic 11

### Story 11.0: DB Schema Cleanup & Infrastructure ⭐ FOUNDATION

As a developer, I want a clean database schema with proper separation of concerns, So that the
learning system has solid infrastructure foundations.

**Context:**

Audit complet du schéma DB (spike 2025-12-18) révèle plusieurs problèmes à corriger AVANT
d'implémenter le learning :

1. **`workflow_dags`** : état runtime temporaire stocké en PostgreSQL (overkill)
2. **`tool_schema` vs `mcp_tool`** : duplication partielle
3. **FKs manquantes** : `permission_audit_log` → `workflow_pattern`
4. **Colonnes redondantes** : `source` vs `edge_source` dans `tool_dependency`

**Référence:** `docs/spikes/2025-12-18-database-schema-audit.md`

**Changements proposés:**

**1. Migrer `workflow_dags` → Deno KV (réactiver ADR-037)**

**Infrastructure existante à réutiliser :**

- `src/server/auth/kv.ts` - Singleton KV avec `getKv()` / `closeKv()`
- Pattern déjà utilisé pour les sessions auth

```typescript
// AVANT (src/mcp/workflow-dag-store.ts - PostgreSQL)
await db.query(`INSERT INTO workflow_dags ...`, [workflowId, dag, intent]);
await db.query(`SELECT dag FROM workflow_dags WHERE expires_at > NOW()`, [workflowId]);

// APRÈS (Deno KV avec singleton existant)
import { getKv } from "../server/auth/kv.ts"; // Réutiliser le singleton

const kv = await getKv();
await kv.set(["workflow", workflowId], { dag, intent }, { expireIn: 3600_000 }); // 1h TTL
const result = await kv.get<{ dag: DAGStructure; intent: string }>(["workflow", workflowId]);
```

**Note:** Considérer déplacer `src/server/auth/kv.ts` → `src/cache/kv.ts` pour un meilleur naming.

**2. Merger `mcp_tool` → `tool_schema`**

```sql
-- Vérifier que toutes les données de mcp_tool sont dans tool_schema
-- (elles le sont normalement car tool_schema est la source principale)

-- Drop mcp_tool (principalement utilisée par E2E tests)
DROP TABLE IF EXISTS mcp_tool CASCADE;

-- Adapter les E2E tests pour utiliser tool_schema
```

**3. Ajouter FK sur `permission_audit_log`**

```sql
ALTER TABLE permission_audit_log
  ALTER COLUMN capability_id TYPE UUID USING capability_id::uuid;
ALTER TABLE permission_audit_log
  ADD CONSTRAINT fk_permission_audit_capability
  FOREIGN KEY (capability_id) REFERENCES workflow_pattern(pattern_id);
```

**4. Supprimer colonne redondante `source` de `tool_dependency`**

```sql
-- Garder uniquement edge_source (plus précis)
-- source: 'user' | 'learned' | 'hint'
-- edge_source: 'template' | 'inferred' | 'observed' ← KEEP
ALTER TABLE tool_dependency DROP COLUMN IF EXISTS source;
```

**Stratégie de Migration (IMPORTANT):**

On utilise une **migration additive idempotente** pour ne pas casser l'historique :

```sql
-- src/db/migrations/019_db_schema_cleanup.sql

-- 1. Drop workflow_dags (remplacé par Deno KV)
DROP TABLE IF EXISTS workflow_dags CASCADE;

-- 2. Drop mcp_tool (merged into tool_schema)
DROP TABLE IF EXISTS mcp_tool CASCADE;

-- 3. Remove redundant column from tool_dependency
ALTER TABLE tool_dependency DROP COLUMN IF EXISTS source;

-- 4. Add missing FK on permission_audit_log (idempotent)
DO $$ BEGIN
  -- First ensure capability_id is UUID type
  ALTER TABLE permission_audit_log
    ALTER COLUMN capability_id TYPE UUID USING capability_id::uuid;
EXCEPTION
  WHEN others THEN NULL; -- Already UUID or doesn't exist
END $$;

DO $$ BEGIN
  ALTER TABLE permission_audit_log
    ADD CONSTRAINT fk_permission_audit_capability
    FOREIGN KEY (capability_id) REFERENCES workflow_pattern(pattern_id);
EXCEPTION
  WHEN duplicate_object THEN NULL; -- FK already exists
END $$;
```

**Pourquoi cette approche ?**

- ✅ Fonctionne avec ou sans données existantes
- ✅ Ne modifie pas les anciennes migrations (historique intact)
- ✅ Idempotente (peut être rejouée sans erreur)
- ✅ Les migrations 004, 008, 009 continuent de fonctionner, puis 019 nettoie

**Acceptance Criteria:**

1. Migration 019 créée avec `IF EXISTS` / `IF NOT EXISTS`
2. `workflow_dags` supprimée de PostgreSQL
3. `src/mcp/workflow-dag-store.ts` utilise Deno KV avec TTL
4. `mcp_tool` table supprimée, E2E tests adaptés
5. FK ajoutée sur `permission_audit_log.capability_id`
6. Colonne `source` supprimée de `tool_dependency`
7. Tests: store/retrieve workflow state via KV
8. Tests: TTL expiration fonctionne
9. Tests E2E: utilisent `tool_schema` au lieu de `mcp_tool`
10. Migration rejouable sans erreur (idempotente)

**Files to Create:**

- `src/db/migrations/019_db_schema_cleanup.sql` (~40 LOC)
- `src/cache/kv.ts` (~30 LOC) - Singleton KV
- `src/cache/workflow-state-cache.ts` (~60 LOC) - Remplace workflow-dag-store

**Files to Modify:**

- `src/mcp/workflow-dag-store.ts` → utiliser KV
- E2E tests utilisant `mcp_tool` → utiliser `tool_schema`
- Code utilisant `tool_dependency.source` → utiliser `edge_source`

**Prerequisites:** Aucun (peut commencer immédiatement)

**Estimation:** 2-3 jours

---

### Story 11.1: Result Tracing - Capture des Résultats d'Exécution

As a learning system, I want to capture the `result` of each tool and capability execution, So that
I can store execution traces with actual outcomes for learning.

**Context:**

Actuellement on trace `args` mais pas `result`. Pour apprendre des exécutions, on a besoin des
résultats réels pour :

- Valider que les provides edges fonctionnent
- Calculer les success rates par chemin
- Détecter les patterns de données

**Note:** Cette story n'est PAS requise pour les provides edges (calculés statiquement en 10.1).
Elle est pour le **learning** basé sur les exécutions réelles.

**Acceptance Criteria:**

1. `tool_end` event inclut `result` dans `worker-bridge.ts`:
   ```typescript
   this.traces.push({
     type: "tool_end",
     tool: toolId,
     traceId: id,
     ts: endTime,
     success: !isToolError,
     durationMs: durationMs,
     parentTraceId: parentTraceId,
     result: result, // ← NOUVEAU
   });
   ```
2. `capability_end` event inclut `result` dans `code-generator.ts`:
   ```typescript
   __trace({
     type: "capability_end",
     capability: "${name}",
     capabilityId: "${capability.id}",
     success: __capSuccess,
     error: __capError?.message,
     result: __capResult, // ← NOUVEAU
   });
   ```
3. Types mis à jour dans `src/dag/types.ts`:
   - `TraceEvent.tool_end.result?: unknown`
   - `TraceEvent.capability_end.result?: unknown`
4. Tests: tool execution → result captured in trace
5. Tests: capability execution → result captured in trace
6. Tests: result is JSON-serializable (no circular refs)

**Files to Modify:**

- `src/sandbox/worker-bridge.ts` (~5 LOC)
- `src/capabilities/code-generator.ts` (~5 LOC)
- `src/dag/types.ts` (~10 LOC)

**Prerequisites:** Epic 10 complete (capabilities exist)

**Estimation:** 0.5-1 jour

---

### Story 11.2: Execution Trace Table & Store

As a learning system, I want a unified `execution_trace` table that stores execution history, So
that I can track execution patterns with proper FK to capabilities and learning-specific fields.

**Context:**

Remplace `workflow_execution` (pas de FK, stocke dag_structure en dur) par `execution_trace` avec :

- FK vers `workflow_pattern` (capability)
- Champs learning (executed_path, decisions, priority)
- Multi-tenancy (user_id, created_by)

**Schema:**

```sql
CREATE TABLE execution_trace (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FK vers capability (nullable pour exécutions ad-hoc)
  capability_id UUID REFERENCES workflow_pattern(pattern_id),

  -- Contexte
  intent_text TEXT,
  initial_context JSONB DEFAULT '{}',   -- Arguments initiaux du workflow (Epic 12 dependency)
  executed_at TIMESTAMPTZ DEFAULT NOW(),

  -- Résultats
  success BOOLEAN NOT NULL,
  duration_ms INTEGER NOT NULL,
  error_message TEXT,

  -- Multi-tenancy
  user_id TEXT DEFAULT 'local',
  created_by TEXT DEFAULT 'local',
  updated_by TEXT,

  -- Learning
  executed_path TEXT[],             -- Chemin pris dans static_structure
  decisions JSONB DEFAULT '[]',     -- Décisions aux DecisionNodes
  task_results JSONB DEFAULT '[]',  -- Résultats par tâche

  -- PER (Prioritized Experience Replay) - utilisé par 11.3 et 11.6
  -- 0.5 = neutral (cold start, SHGAT pas encore entraîné)
  -- 0.0 = attendu (trace non surprenante)
  -- 1.0 = surprenant (td_error maximal)
  priority FLOAT DEFAULT 0.5,

  -- Hiérarchie (ADR-041)
  parent_trace_id UUID REFERENCES execution_trace(id)
);

-- Indexes
CREATE INDEX idx_exec_trace_capability ON execution_trace(capability_id);
CREATE INDEX idx_exec_trace_timestamp ON execution_trace(executed_at DESC);
CREATE INDEX idx_exec_trace_user ON execution_trace(user_id);
CREATE INDEX idx_exec_trace_path ON execution_trace USING GIN(executed_path);
CREATE INDEX idx_exec_trace_priority ON execution_trace(capability_id, priority DESC);
```

**Migration depuis workflow_execution:**

```sql
-- Option 1: Si données à migrer
INSERT INTO execution_trace (intent_text, executed_at, success, duration_ms, error_message, user_id)
SELECT intent_text, executed_at, success, execution_time_ms, error_message, COALESCE(user_id, 'local')
FROM workflow_execution;

-- Option 2: Si base de test vide
DROP TABLE IF EXISTS workflow_execution CASCADE;
```

**Acceptance Criteria:**

1. Migration créée (`src/db/migrations/019_execution_trace.ts`)
2. `workflow_execution` migrée ou supprimée
3. Types TypeScript définis:
   ```typescript
   // JSON-serializable type (for JSONB storage)
   type JsonPrimitive = string | number | boolean | null;
   type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

   interface ExecutionTrace {
     id: string;
     capabilityId?: string;
     intentText?: string;
     initialContext?: Record<string, JsonValue>; // ← Epic 12 dependency
     executedAt: Date;
     success: boolean;
     durationMs: number;
     errorMessage?: string;
     executedPath?: string[];
     decisions: BranchDecision[];
     taskResults: TraceTaskResult[];
     priority: number;
     parentTraceId?: string;
   }

   interface TraceTaskResult {
     taskId: string;
     tool: string;
     args: Record<string, JsonValue>; // ← Epic 12 dependency
     result: JsonValue;
     success: boolean;
     durationMs: number;
   }
   ```
4. `ExecutionTraceStore` class créée avec:
   - `saveTrace(capabilityId, trace)` → INSERT
   - `getTraces(capabilityId, limit?)` → SELECT
   - `getTraceById(traceId)` → SELECT
   - `getHighPriorityTraces(limit)` → SELECT ORDER BY priority DESC (pour PER sampling)
   - `updatePriority(traceId, priority)` → UPDATE priority (pour 11.6 après training)
   - `sampleByPriority(limit, minPriority?)` → SELECT avec weighted sampling
5. Fichiers mis à jour pour utiliser `execution_trace`:
   - `src/graphrag/sync/db-sync.ts`
   - `src/graphrag/metrics/collector.ts`
   - `src/web/routes/api/user/delete.ts`
6. Tests: INSERT trace avec FK capability
7. Tests: SELECT traces par capability_id
8. Tests: migration depuis workflow_execution (si données)
9. `initial_context` stocke les arguments initiaux du workflow (Epic 12 dependency)
10. `task_results[].args` stocke les arguments de chaque tâche (Epic 12 dependency)
11. Data sanitization appliquée avant stockage (redact sensitive, truncate large payloads)
12. **Refactor appels post-exécution (séparation Capability vs Trace):**

- `executor.ts:394` → utiliser `executionTraceStore.saveTrace()` au lieu de `saveCapability()`
- `worker-bridge.ts:300` → utiliser `executionTraceStore.saveTrace()` au lieu de `saveCapability()`
- `saveCapability()` signature nettoyée: retirer `durationMs`, `success`, `toolsUsed`,
  `toolInvocations`
- La Capability est créée via analyse statique (Story 10.1), la Trace est créée après exécution

**Files to Create:**

- `src/db/migrations/019_execution_trace.ts` (~100 LOC)
- `src/capabilities/execution-trace-store.ts` (~150 LOC)
- `src/utils/sanitize-for-storage.ts` (~50 LOC) - Shared with Epic 12

**Files to Modify:**

- `src/capabilities/types.ts` (~50 LOC)
- `src/graphrag/sync/db-sync.ts` (~20 LOC)
- `src/graphrag/metrics/collector.ts` (~15 LOC)
- `src/sandbox/executor.ts` (~20 LOC) - AC12: refactor saveCapability → saveTrace
- `src/sandbox/worker-bridge.ts` (~20 LOC) - AC12: refactor saveCapability → saveTrace
- `src/capabilities/capability-store.ts` (~30 LOC) - AC12: nettoyer signature saveCapability

**Prerequisites:** Story 11.1 (result in traces)

**Estimation:** 2-3 jours

---

### Story 11.3: TD Error + PER Priority (Refactoré 2025-12-22)

As a learning system, I want to calculate TD error for PER priority, So that SHGAT can sample and
learn from surprising traces efficiently.

**Context (Architecture Combinée TD+PER+SHGAT):**

**AVANT (ancienne architecture - DÉPRÉCIÉE):**

```
trace → TD Learning → CapabilityLearning (stats) → utilisé pour scoring
```

**APRÈS (nouvelle architecture - style DQN/Rainbow):**

```
trace → TD Error → PER priority → SHGAT sample + train
```

**TD Error = signal pour PER, pas pour stats explicites:**

```typescript
// Après exécution, calculer TD error via SHGAT
async function storeTraceWithPriority(
  shgat: SHGAT,
  trace: ExecutionTrace,
): Promise<void> {
  // 1. Get SHGAT prediction for this path
  const predicted = await shgat.predictPathSuccess(trace.executedPath);

  // 2. Compute TD error
  const actual = trace.success ? 1.0 : 0.0;
  const tdError = actual - predicted;

  // 3. Priority = |TD error| (plus c'est surprenant, plus on apprend)
  const priority = Math.abs(tdError);

  // 4. Store trace with PER priority
  await traceStore.save({
    ...trace,
    priority, // Utilisé par 11.6 pour PER sampling
  });
}
```

**PER Sampling (utilisé par Story 11.6):**

```typescript
// SHGAT sample traces weighted by PER priority
async function sampleTracesForTraining(
  traceStore: ExecutionTraceStore,
  batchSize: number = 32,
): Promise<ExecutionTrace[]> {
  // High priority first, with some randomness for exploration
  return await traceStore.query(
    `
    SELECT * FROM execution_trace
    ORDER BY priority DESC, random()
    LIMIT $1
  `,
    [batchSize],
  );
}
```

**⚠️ DÉPRÉCIATIONS:**

| Ancien                             | Nouveau                    | Raison                       |
| ---------------------------------- | -------------------------- | ---------------------------- |
| `CapabilityLearning` type          | ❌ Supprimé                | SHGAT apprend directement    |
| `updateLearningTD()` → stats       | `storeTraceWithPriority()` | TD = signal PER              |
| `workflow_pattern.learning` col    | ❌ Pas créée               | Plus de stats intermédiaires |
| `capabilityStore.updateLearning()` | ❌ Pas créée               | SHGAT = le modèle            |

**Acceptance Criteria:**

1. `calculateTDError(shgat, trace)` implémentée:
   ```typescript
   async function calculateTDError(
     shgat: SHGAT,
     trace: { executedPath: string[]; success: boolean },
   ): Promise<number> {
     const predicted = await shgat.predictPathSuccess(trace.executedPath);
     const actual = trace.success ? 1.0 : 0.0;
     return actual - predicted;
   }
   ```
2. `storeTraceWithPriority()` sauvegarde trace avec `priority = |tdError|`
3. **COLD START:** Si SHGAT pas encore entraîné, priority = 0.5 (neutre)
4. `ExecutionTraceStore.getHighPriorityTraces(limit)` pour PER sampling
5. Tests: nouveau chemin (SHGAT prédit 0.5) + success → priority = 0.5
6. Tests: chemin avec SHGAT prédit 0.9 + failure → priority = 0.9
7. Tests: chemin avec SHGAT prédit 0.9 + success → priority = 0.1
8. Tests: cold start → priority = 0.5

**Files to Create:**

- `src/capabilities/per-priority.ts` (~60 LOC)

**Files to Modify:**

- `src/capabilities/execution-trace-store.ts` (~20 LOC) - Add priority queries
- `src/graphrag/algorithms/shgat.ts` (~10 LOC) - Add `predictPathSuccess()`

**Prerequisites:** Story 11.2 (execution_trace table), Story 10.7b (SHGAT base)

**Estimation:** 1-2 jours (simplifié car pas de CapabilityLearning)

---

### Story 11.4: Definition vs Invocation Views

As a user, I want to toggle between Definition view (structure) and Invocation view (executions), So
that I can understand both the capability structure and its execution patterns.

**Context:**

| Vue            | Nœuds                | Edges                          | Source             |
| -------------- | -------------------- | ------------------------------ | ------------------ |
| **Definition** | Dédupliqués par type | dependency, provides, contains | `static_structure` |
| **Invocation** | Par appel réel       | sequence (temporel)            | `execution_trace`  |

**Acceptance Criteria:**

1. Toggle button dans dashboard: `[Definition] [Invocation]`
2. **Vue Definition:**
   - Nœuds dédupliqués par tool/capability type
   - Edges: `dependency`, `provides`, `contains`
   - Layout optimisé pour structure (dagre/hierarchical)
   - Source: `static_structure` de la capability
3. **Vue Invocation:**
   - Un nœud par appel réel (suffixe `_1`, `_2`, etc.)
   - Timestamps affichés sur les nœuds
   - Edges: `sequence` (basé sur ordre temporel)
   - Parallel visible par timestamps qui overlap
   - Source: `execution_trace.task_results`
4. API endpoint `/api/traces/:capabilityId`
5. Cytoscape layout adapté par vue
6. Tests: même capability, 3 exécutions → Definition (1 nœud) vs Invocation (3 nœuds)
7. Tests: exécution avec parallélisme visible en Invocation view

**Files to Create:**

- `src/web/islands/DefinitionInvocationToggle.tsx` (~80 LOC)

**Files to Modify:**

- `src/web/routes/dashboard.tsx` (~30 LOC)
- `src/visualization/hypergraph-builder.ts` (~50 LOC)

**Prerequisites:** Story 11.2 (execution_trace), Epic 8 (Hypergraph visualization)

**Estimation:** 2-3 jours

---

### Story 11.5: Dry Run Mode (Optional)

As a developer, I want to dry-run a capability without side effects, So that I can test and debug
workflows before real execution.

**Context:**

Exécute la capability avec des mocks pour les tools à effets de bord. Utile pour debugging de
workflows avec MCP connecteurs externes.

**Acceptance Criteria:**

1. `pml_execute({ ..., dryRun: true })` option
2. Mode dry-run:
   - Tools marqués `sideEffect: true` → mock response
   - Tools read-only → exécution réelle
   - Traces générées normalement (marquées `dryRun: true`)
3. Mock responses configurables:
   - Default: `{ success: true, mocked: true }`
   - Custom via `dryRunMocks: { "github:createIssue": {...} }`
4. Tests: dry-run avec side-effect tool → pas d'appel réel
5. Tests: dry-run avec read-only tool → appel réel
6. Tests: traces générées avec flag dryRun

**Prerequisites:** Epic 10 complete, Story 11.1 (result tracing)

**Estimation:** 3-4 jours

**Status:** Optional (post-MVP)

---

### Story 11.6: SHGAT Training avec PER Sampling (Refactoré 2025-12-22)

As a learning system, I want to train SHGAT on path-level traces with PER sampling, So that SHGAT
learns efficiently from surprising execution patterns.

**Context (Architecture Combinée TD+PER+SHGAT):**

Story 11.3 calcule `priority = |td_error|` pour chaque trace. Cette story utilise PER sampling pour
entraîner SHGAT sur les traces prioritaires.

**Différence avec 10.7b (tool-level):**

| Aspect          | 10.7b (episodic_events) | 11.6 (execution_trace + PER) |
| --------------- | ----------------------- | ---------------------------- |
| **Sampling**    | Random/récent           | PER (priority-weighted)      |
| **Granularité** | Par tool                | Par path (séquence)          |
| **Label**       | `wasCorrect`            | `success`                    |
| **Signal**      | Binary                  | TD error (continuous)        |

**SHGAT Path Encoder:**

```typescript
// SHGAT encode une séquence de nodes en un embedding
interface SHGATPathEncoder {
  // Encode path sequence → single embedding
  encodePath(path: string[]): Float32Array;

  // Predict success probability for a path
  predictPathSuccess(path: string[]): number;

  // Train on batch with PER weights
  trainBatch(
    traces: { path: string[]; success: boolean; priority: number }[],
  ): TrainingResult;
}
```

**Training pipeline enrichi:**

```
┌─────────────────────────────────────────────────────────────┐
│  1. Récupérer traces récentes                                │
│     SELECT * FROM execution_trace                            │
│     WHERE capability_id = X                                  │
│     ORDER BY executed_at DESC LIMIT 100                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Extraire features path-level                             │
│     - pathSuccessRate = count(success) / count(*)           │
│     - decisionSuccessRate par decision node                 │
│     - isDominantPath = path === capability.learning.dominantPath
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Enrichir SHGAT features                                  │
│     features = { ...toolLevelFeatures, ...pathLevelFeatures }│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Train SHGAT avec features enrichies                      │
│     shgat.trainBatch(enrichedFeatures, pathSuccessLabels)   │
└─────────────────────────────────────────────────────────────┘
```

**Acceptance Criteria:**

1. `extractPathLevelFeatures(traces: ExecutionTrace[])` implémentée
2. Features path-level ajoutées:
   - `pathSuccessRate` - succès du path spécifique
   - `pathFrequency` - fréquence relative du path
   - `decisionSuccessRate` - succès aux DecisionNodes
   - `isDominantPath` - booléen
3. `trainSHGATOnPathTraces()` créée, utilise `execution_trace`:
   ```typescript
   async function trainSHGATOnPathTraces(
     shgat: SHGAT,
     traceStore: ExecutionTraceStore,
     capabilityId: string,
     options?: { minTraces?: number; maxTraces?: number },
   ): Promise<TrainingResult>;
   ```
4. Pipeline de training:
   - Au démarrage: charge traces récentes, train initial avec path features
   - Après exécution: `trainBatch()` incrémental avec nouvelles traces
5. Fallback vers 10.7b (tool-level) si pas assez de traces (<20)
6. Params SHGAT mis à jour pour nouvelles dimensions de features
7. Tests: path-level training améliore précision vs tool-level seul
8. Tests: fallback vers tool-level si traces insuffisantes
9. Benchmark: overhead du path-level training < 50ms

**Files to Create:**

- `src/graphrag/learning/path-level-features.ts` (~100 LOC)

**Files to Modify:**

- `src/graphrag/algorithms/shgat.ts` (~30 LOC) - Nouvelles dimensions features
- `src/learning/episodic-adapter.ts` (~50 LOC) - Ajouter path-level training
- `src/graphrag/dag-suggester.ts` (~20 LOC) - Utiliser training enrichi

**Prerequisites:** Story 11.2 (execution_trace table), Story 10.7b (SHGAT base integration)

**Estimation:** 2-3 jours

**✅ Implementation Complete (2025-12-24):**

Story 11.6 replaced single-example `updateSHGAT()` with PER batch training:

| Item                       | Status         | Location                     | Notes                                      |
| -------------------------- | -------------- | ---------------------------- | ------------------------------------------ |
| `registerSHGATNodes()`     | ✅ Implemented | `execute-handler.ts:531-571` | Registers capability + tools (no training) |
| `runPERBatchTraining()`    | ✅ Implemented | `execute-handler.ts:585-628` | PER-weighted path-level training           |
| `trainSHGATOnPathTraces()` | ✅ Implemented | `per-training.ts:127-270`    | Core PER training logic                    |
| `shgat.trainBatch()`       | ✅ Implemented | `shgat.ts`                   | Batch training with path features          |
| Training lock              | ✅ Implemented | `execute-handler.ts:576`     | Prevents concurrent training               |

**Key changes from 10.7:**

- ~~`updateSHGAT()` + `trainOnExample()`~~ → `registerSHGATNodes()` + `runPERBatchTraining()`
- Single-example → Multi-example per trace (1 per node in path)
- Tool-level → Path-level learning
- Binary outcome → PER priority (TD error weighted)
- Train every 10 exec → Train every exec (with lock)

---

## Epic 11 Dependencies (Refactoré 2025-12-22)

```
┌─────────────────────────────────────────────────────────────────┐
│  EPIC 10 (Prerequisite)                                          │
│  - Capabilities exist with static_structure                      │
│  - pml_execute generates traces                                  │
│  - Story 10.7b: SHGAT tool-level training (episodic_events)     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Story 11.0: DB Schema Cleanup                                   │
│  - Migrate workflow_dags → Deno KV                              │
│  - Drop mcp_tool, add FKs                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Story 11.1: Result Tracing                                      │
│  - Add `result` to tool_end and capability_end events           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Story 11.2: Execution Trace Table                               │
│  - CREATE TABLE execution_trace (avec priority column)          │
│  - ExecutionTraceStore class                                     │
│  - Migrate/DROP workflow_execution                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Story 11.3: TD Error + PER Priority (REFACTORÉ)                │
│  - calculateTDError(shgat, trace) → |predicted - actual|       │
│  - storeTraceWithPriority() → priority = |td_error|             │
│  - ❌ DÉPRÉCIÉ: CapabilityLearning, updateLearningTD()          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Story 11.6: SHGAT Training avec PER Sampling (REFACTORÉ)       │
│  - trainSHGATWithPER() → sample par priority, train batch      │
│  - SHGATPathEncoder: encodePath(), predictPathSuccess()        │
│  - Update priorities après training (TD error recalculé)        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Story 11.4: Definition/Invocation Views                         │
│  - Toggle UI component                                           │
│  - API endpoint for traces                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Story 11.5: Dry Run Mode (Optional)                             │
│  - Mock side-effect tools                                        │
│  - dryRun flag in traces                                         │
└─────────────────────────────────────────────────────────────────┘
```

**Note:** 11.3 et 11.6 sont maintenant SÉQUENTIELLES (11.3 → 11.6) car 11.6 utilise les priorities
de 11.3.

---

## Epic 11 Estimation Summary (Révisé 2025-12-22)

| Ordre | Story    | Description                             | Effort | Cumulative |
| ----- | -------- | --------------------------------------- | ------ | ---------- |
| 0     | 11.0     | DB Schema Cleanup                       | 2-3j   | 3j         |
| 1     | 11.1     | Result Tracing                          | 0.5-1j | 4j         |
| 2     | 11.2     | execution_trace Table (avec priority)   | 2-3j   | 7j         |
| 3     | **11.3** | **TD Error + PER Priority** (simplifié) | 1-2j   | 9j         |
| 4     | **11.6** | **SHGAT Training avec PER**             | 2-3j   | 12j        |
| 5     | 11.4     | Definition/Invocation Views             | 2-3j   | 15j        |
| 6     | 11.5     | Dry Run (optional)                      | 3-4j   | 19j        |

**Total MVP (11.0-11.4 + 11.6): ~2-2.5 semaines** (réduit car 11.3 simplifié) **Total avec 11.5: ~3
semaines**

**Changements 2025-12-22 (Architecture TD+PER+SHGAT):**

| Avant                                              | Après                                   | Impact                  |
| -------------------------------------------------- | --------------------------------------- | ----------------------- |
| 11.3 produisait `CapabilityLearning`               | 11.3 produit `priority` pour PER        | Simplifié               |
| 11.6 utilisait `CapabilityLearning` comme features | 11.6 utilise PER sampling + train SHGAT | Plus efficace           |
| 11.3 et 11.6 parallélisables                       | 11.3 → 11.6 séquentielles               | 11.6 dépend de priority |
| TD Learning → stats explicites                     | TD Error → signal pour PER              | SHGAT apprend tout      |

**Dépréciations:**

- `CapabilityLearning` type → supprimé
- `workflow_pattern.learning` column → pas créée
- `updateLearningTD()` → remplacé par `storeTraceWithPriority()`
- `capabilityStore.updateLearning()` → pas créée

---

## Breaking Changes Summary

| Story | Change                      | Breaking?  | Impact          |
| ----- | --------------------------- | ---------- | --------------- |
| 11.1  | `result` in trace events    | ❌ No      | Additive        |
| 11.2  | DROP `workflow_execution`   | ⚠️ **Yes** | Table supprimée |
| 11.2  | CREATE `execution_trace`    | ❌ No      | Additive        |
| 11.3  | `learning` in dag_structure | ❌ No      | Additive        |
| 11.4  | Toggle UI component         | ❌ No      | Additive        |

---

## References

- **Spike:** `docs/spikes/2025-12-17-complex-adaptive-systems-research.md` (PER, TD Learning)
- **Spike:** `docs/spikes/2025-12-18-database-schema-audit.md` (execution_trace schema)
- **ADR-041:** Hierarchical Trace Tracking (parentTraceId)
- **Epic 10:** Capability Creation & Unified APIs (prerequisite)
