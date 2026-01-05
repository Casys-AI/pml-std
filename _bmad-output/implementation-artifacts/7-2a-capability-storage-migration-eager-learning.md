# Story 7.2a: Capability Storage - Migration & Eager Learning

> **Epic:** 7 - Emergent Capabilities & Learning System **ADRs:** ADR-027 (Execute Code Graph
> Learning), ADR-028 (Emergent Capabilities System) **Prerequisites:** Story 7.1b (Worker RPC
> Bridge - DONE) **Status:** Done

## User Story

As a system persisting learned patterns, I want to store capabilities immediately after first
successful execution, So that learning happens instantly without waiting for repeated patterns.

## Context

### Eager Learning Philosophy

**Key Principle:** Storage dès la 1ère exécution réussie (pas d'attente de 3+ exécutions)

- ON CONFLICT → UPDATE usage_count++ (deduplication par code_hash)
- Storage is cheap (~2KB/capability), on garde tout
- Le filtrage se fait au moment des suggestions, pas du stockage (Story 7.4)

### Existing Schema (Migration 010)

Les tables `workflow_pattern` et `workflow_execution` existent déjà dans
`src/db/migrations/010_graphrag_tables_migration.ts`:

```sql
-- workflow_pattern (existing columns)
pattern_id UUID PRIMARY KEY
pattern_hash TEXT UNIQUE NOT NULL
dag_structure JSONB NOT NULL
intent_embedding vector(1024) NOT NULL
usage_count INTEGER DEFAULT 1
success_count INTEGER DEFAULT 0
last_used TIMESTAMP

-- workflow_execution (existing columns)
execution_id UUID PRIMARY KEY
executed_at TIMESTAMP
intent_text TEXT
dag_structure JSONB NOT NULL
success BOOLEAN NOT NULL
execution_time_ms INTEGER NOT NULL
error_message TEXT
```

### What This Story Adds

Cette story étend ces tables pour supporter les **capabilities** (code exécutable appris):

**workflow_pattern extensions:**

- `code_snippet TEXT` - Le code TypeScript exécuté
- `code_hash TEXT UNIQUE` - Hash pour déduplication (alternative à pattern_hash pour code)
- `parameters_schema JSONB` - Schema JSON des paramètres (rempli par Story 7.2b)
- `cache_config JSONB` - Configuration cache (ttl, cacheable)
- `name TEXT` - Nom auto-généré ou manuel
- `description TEXT` - Description de la capability
- `success_rate REAL` - Taux de succès (0-1, calculé)
- `avg_duration_ms INTEGER` - Durée moyenne d'exécution
- `created_at TIMESTAMPTZ` - Date de création (1ère exec)
- `source TEXT` - 'emergent' ou 'manual'

**workflow_execution extensions:**

- `code_snippet TEXT` - Code exécuté pour cette execution
- `code_hash TEXT` - Hash du code pour liaison avec workflow_pattern

## Acceptance Criteria

### AC1: Migration 011 Created

- [x] Fichier `src/db/migrations/011_capability_storage_migration.ts` créé
- [x] Extension de `workflow_pattern` avec colonnes capability:
  ```sql
  ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS code_snippet TEXT;
  ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS code_hash TEXT UNIQUE;
  ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS parameters_schema JSONB;
  ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS cache_config JSONB DEFAULT '{"ttl_ms": 3600000, "cacheable": true}'::jsonb;
  ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS name TEXT;
  ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS description TEXT;
  ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS success_rate REAL DEFAULT 1.0;
  ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS avg_duration_ms INTEGER DEFAULT 0;
  ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
  ALTER TABLE workflow_pattern ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'emergent';
  ```
- [x] Extension de `workflow_execution` avec colonnes code:
  ```sql
  ALTER TABLE workflow_execution ADD COLUMN IF NOT EXISTS code_snippet TEXT;
  ALTER TABLE workflow_execution ADD COLUMN IF NOT EXISTS code_hash TEXT;
  ```
- [x] Migration enregistrée dans `src/db/migrations.ts`

### AC2: Index HNSW on intent_embedding

- [x] Index HNSW sur `intent_embedding` pour recherche rapide (déjà existant dans migration 010)
- [x] Vérifier que l'index fonctionne avec les nouvelles données

### AC3: Index on code_hash

- [x] Index unique sur `code_hash` pour upsert rapide:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_pattern_code_hash
  ON workflow_pattern(code_hash) WHERE code_hash IS NOT NULL;
  ```

### AC4: CapabilityStore Class

- [x] Fichier `src/capabilities/capability-store.ts` créé (~150 LOC)
- [x] Interface `Capability`:
  ```typescript
  interface Capability {
    id: string;
    codeSnippet: string;
    codeHash: string;
    intentEmbedding: Float32Array;
    parametersSchema?: JSONSchema;
    cacheConfig: CacheConfig;
    name?: string;
    description?: string;
    usageCount: number;
    successCount: number;
    successRate: number;
    avgDurationMs: number;
    createdAt: Date;
    lastUsed: Date;
    source: "emergent" | "manual";
  }
  ```
- [x] Method
      `saveCapability(code: string, intent: string, duration_ms: number): Promise<Capability>`
- [x] Method `findByCodeHash(codeHash: string): Promise<Capability | null>`
- [x] Method `updateUsage(codeHash: string, success: boolean, duration_ms: number): Promise<void>`

### AC5: Eager Insert Logic

- [x] Après chaque execution réussie avec intent:
  ```sql
  INSERT INTO workflow_pattern (code_hash, code_snippet, intent_embedding, name, description, source, created_at, success_rate, avg_duration_ms)
  VALUES ($1, $2, $3, $4, $5, 'emergent', NOW(), 1.0, $6)
  ON CONFLICT (code_hash) DO UPDATE SET
    usage_count = workflow_pattern.usage_count + 1,
    success_count = workflow_pattern.success_count + 1,
    last_used = NOW(),
    success_rate = (workflow_pattern.success_count + 1)::real / (workflow_pattern.usage_count + 1)::real,
    avg_duration_ms = (workflow_pattern.avg_duration_ms * workflow_pattern.usage_count + EXCLUDED.avg_duration_ms) / (workflow_pattern.usage_count + 1)
  RETURNING *;
  ```

### AC6: Hash Function

- [x] Function `hashCode(code: string): string` utilisant SHA-256
- [x] Hash normalisé (trim, consistent whitespace)
- [x] Collision résistant

### AC7: Integration with WorkerBridge

- [x] `WorkerBridge.execute()` appelle `CapabilityStore.saveCapability()` après exécution réussie
- [x] Si intent fourni ET execution réussie → capability créée/mise à jour
- [x] Traces de tool usage incluses dans capability metadata

### AC8: Tests

- [x] Test: exec 1x → verify capability créée avec usage_count = 1
- [x] Test: exec 2x même code → verify usage_count = 2, success_rate recalculée
- [x] Test: exec avec échec → verify success_rate diminue
- [x] Test: migration idempotente (peut être rejouée)
- [x] Test: hash collision handling

## Technical Requirements

### Database

- **PGlite** 0.3.11 avec pgvector
- **Tables:** Extend existing migration 010 tables
- **Indexes:** HNSW pour embeddings, B-tree pour code_hash

### Embeddings

- **Model:** BGE-M3 (Xenova/bge-m3) via @huggingface/transformers 3.7.6
- **Dimensions:** 1024
- **Usage:** Générer embedding depuis intent pour recherche sémantique

### Code Hash

```typescript
import { crypto } from "std/crypto";

export async function hashCode(code: string): Promise<string> {
  // Normalize: trim, collapse whitespace, remove comments (optional)
  const normalized = code.trim().replace(/\s+/g, " ");
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

### File Structure

```
src/capabilities/
├── capability-store.ts     # CapabilityStore class (NEW)
├── types.ts                # Capability interface (NEW)
└── hash.ts                 # hashCode function (NEW)

src/db/migrations/
└── 011_capability_storage_migration.ts  # Migration (NEW)
```

## Architecture Compliance

### Pattern: Eager Learning (Epic 7)

```
┌─────────────────────────────────────────────────────────────────┐
│  EXECUTE                                                         │
│  User provides intent + code → WorkerBridge executes             │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼ (success)
┌─────────────────────────────────────────────────────────────────┐
│  LEARN (Eager - dès exec 1)                                      │
│  → Generate code_hash from code snippet                          │
│  → Generate intent_embedding from intent                         │
│  → UPSERT workflow_pattern                                       │
│  → ON CONFLICT: usage_count++, update success_rate               │
│  → Capability discoverable IMMÉDIATEMENT                         │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼ (future: Story 7.3)
┌─────────────────────────────────────────────────────────────────┐
│  MATCH                                                           │
│  Similar intent → find capability → execute cached code          │
└─────────────────────────────────────────────────────────────────┘
```

### Integration Points

1. **WorkerBridge** (from Story 7.1b): Appelle CapabilityStore après exécution
2. **VectorSearch** (Epic 1): Réutilise pour générer embeddings
3. **GatewayServer**: Expose capability learning stats in metrics

## Previous Story Intelligence (7.1b)

### Learnings from Story 7.1b

- **Worker RPC Bridge** architecture fonctionne correctement
- **Native tracing** dans le bridge capture tous les tool calls
- **34 tests** validés, architecture stable
- **Files créés:** `worker-bridge.ts`, `sandbox-worker.ts`
- **Pattern:** Toujours utiliser `--unstable-worker-options` pour Deno Worker

### Code Patterns to Reuse

```typescript
// From worker-bridge.ts - async database pattern
private async executeWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation();
  } finally {
    clearTimeout(timeout);
  }
}
```

### Files Modified by 7.1b (Reference)

| File                           | Relevance for 7.2a                       |
| ------------------------------ | ---------------------------------------- |
| `src/sandbox/worker-bridge.ts` | Integration point for capability storage |
| `src/sandbox/types.ts`         | May need TraceEvent → Capability mapping |
| `src/mcp/gateway-server.ts`    | Already uses bridge traces               |

## Dev Notes

### Critical Implementation Details

1. **Migration Idempotency:** Utilise `IF NOT EXISTS` pour toutes les modifications
2. **Embedding Generation:** Réutilise le service existant de `src/vector/embeddings.ts`
3. **Transaction Safety:** Wrap upsert dans transaction pour atomicité
4. **Null Handling:** `code_hash` peut être NULL pour anciens patterns (migration 010)

### Potential Gotchas

- `pattern_hash` (existing) vs `code_hash` (new): Deux hash différents
  - `pattern_hash`: Hash du DAG structure
  - `code_hash`: Hash du code snippet
- Migration 010 a déjà un index HNSW sur `intent_embedding`
- `success_rate` calculé comme REAL, pas INTEGER

### Test Commands

```bash
# Run migration
deno task db:migrate

# Run capability store tests
deno test -A tests/unit/capabilities/capability_store_test.ts

# Verify migration
deno task cli db:status
```

## References

- [Epic 7: Emergent Capabilities](../epics.md#epic-7-emergent-capabilities--learning-system)
- [ADR-027: Execute Code Graph Learning](../adrs/ADR-027-execute-code-graph-learning.md)
- [ADR-028: Emergent Capabilities System](../adrs/ADR-028-emergent-capabilities-system.md)
- [Migration 010: GraphRAG Tables](../../src/db/migrations/010_graphrag_tables_migration.ts)
- [Story 7.1b: Worker RPC Bridge](./7-1b-worker-rpc-bridge.md)

## Estimation

- **Effort:** 1-2 jours
- **LOC:** ~250 net (migration + CapabilityStore + tests)
- **Risk:** Low (extension de tables existantes, patterns éprouvés)

---

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- Tests passing: 32/32 (20 capability_store + 12 hash tests)

### Completion Notes List

- Implemented Migration 011 extending workflow_pattern and workflow_execution tables
- Created CapabilityStore class with eager learning UPSERT pattern
- Added SHA-256 hashCode function with whitespace normalization
- Integrated with WorkerBridge - saves capability on successful execution with intent
- All 8 ACs satisfied with comprehensive test coverage

### Change Log

- 2025-12-05: Story implementation complete - all tests passing
- 2025-12-05: Code Review fixes applied:
  - Fixed SQL injection vulnerability in updateUsage (HIGH)
  - Added embedding generation error handling (MEDIUM)
  - Added searchByIntent tests (MEDIUM)
  - Added concurrent operations test (MEDIUM)
  - Removed unused WorkflowPatternRow type (LOW)
  - Unexported hashCodeSync from module (LOW)
  - Total tests: 32 passing

### File List

**New Files:**

- `src/db/migrations/011_capability_storage_migration.ts` - Migration extending tables
- `src/capabilities/capability-store.ts` - CapabilityStore class (~290 LOC)
- `src/capabilities/types.ts` - Type definitions (Capability, CacheConfig, etc.)
- `src/capabilities/hash.ts` - hashCode and normalizeCode functions
- `src/capabilities/mod.ts` - Module exports
- `tests/unit/capabilities/capability_store_test.ts` - 20 tests for CapabilityStore
- `tests/unit/capabilities/hash_test.ts` - 12 tests for hash functions

**Modified Files:**

- `src/db/migrations.ts` - Added import and registration for migration 011
- `src/sandbox/worker-bridge.ts` - Added optional CapabilityStore integration for eager learning

**Code Review Fixes (2025-12-05):**

- `src/capabilities/capability-store.ts` - Fixed SQL injection in updateUsage (parameterized query)
- `src/capabilities/capability-store.ts` - Added error handling for embedding generation failure
- `src/capabilities/types.ts` - Removed unused WorkflowPatternRow type
- `src/capabilities/mod.ts` - Unexported hashCodeSync (internal use only)
- `tests/unit/capabilities/capability_store_test.ts` - Added 5 new tests (searchByIntent,
  concurrent, embedding error)
