# Story 13.8: Unified PML Registry (VIEW approach)

**Epic:** 13 - Capability Naming & Curation **Story ID:** 13.8 **Status:** done **Estimated
Effort:** 2-3 heures (réduit grâce à l'approche VIEW)

---

## User Story

**As a** platform developer, **I want** a unified registry view for MCP tools and capabilities, **So
that** `pml:discover` can search both uniformly and support dynamic import via `code_url`.

---

## Context

### Situation actuelle

- **Capabilities** → `capability_records` (+ FK vers `workflow_pattern`)
- **MCP tools** → `tool_schema` (définitions des outils MCP)

Ces deux tables ont des rôles différents :
- `capability_records` = code appris qui UTILISE les outils MCP
- `tool_schema` = définitions des outils MCP externes

### Décision architecturale

**❌ Ancienne approche** : Renommer `capability_records` → `pml_registry` (risqué, 32 fichiers à modifier)

**✅ Nouvelle approche** : Créer une VIEW `pml_registry` qui UNION les deux tables
- Pas de migration destructive
- Chaque table garde sa logique métier
- Interface unifiée pour discovery

---

## Acceptance Criteria

1. **AC1: Colonnes ajoutées à tool_schema**
   - `code_url TEXT` - URL pour dynamic import (`pml.casys.ai/mcp/{fqdn}`)
   - `routing TEXT DEFAULT 'local'` - `local` (défaut, sécurité) ou `cloud`

2. **AC2: VIEW pml_registry créée**
   - UNION de `tool_schema` et `capability_records`
   - Expose `record_type`, `id`, `name`, `description`, `code_url`, `routing`

3. **AC3: pml:discover retourne record_type**
   - Résultats incluent `record_type` ('mcp-tool' | 'capability')
   - Format compatible avec le schéma de la VIEW `pml_registry`
   - Note: La recherche sémantique continue via vectors (pas SQL sur VIEW)

4. **AC4: Tests passent**
   - `deno task test` passe
   - `deno task check` passe

---

## Out of Scope (Différé)

- ❌ Seeding des MCP servers avec `code_url` (sera fait dans Epic 14)
- ❌ Renommer `capability_records` (plus nécessaire)
- ❌ Modifier cap:* tools (ils continuent à utiliser `capability_records` directement)

---

## Tasks / Subtasks

### Phase 1: Migration DB (1h)

- [x] **Task 1: Créer migration 031** (AC: #1, #2)
  - [x] Ajouter `code_url TEXT` à `tool_schema`
  - [x] Ajouter `routing TEXT DEFAULT 'local'` à `tool_schema`
  - [x] Créer VIEW `pml_registry`
  - [x] Rollback: DROP VIEW, DROP colonnes

### Phase 2: Mise à jour du code (1h)

- [x] **Task 2: Mettre à jour discover-handler.ts** (AC: #3)
  - [x] Ajouter `record_type` dans les résultats (`'mcp-tool'` | `'capability'`)
  - [x] Format compatible avec VIEW (recherche sémantique inchangée)

- [x] **Task 3: Mettre à jour les types** (AC: #3)
  - [x] Ajouter `PmlRegistryRecord` type dans `src/capabilities/types/fqdn.ts`
  - [x] Ajouter `record_type` dans `DiscoverResultItem`

### Phase 3: Tests (30min)

- [x] **Task 4: Tests d'intégration** (AC: #4)
  - [x] Tester la VIEW retourne les deux types (7 tests migration)
  - [x] Tester pml:discover inclut `record_type` (3 tests Story 13.8)

---

## Files to Update

```
src/db/migrations/031_pml_registry_view.ts  # NEW (030 already exists)
src/mcp/handlers/discover-handler.ts
src/capabilities/types.ts
tests/unit/mcp/discover_handler_test.ts
```

**Files NOT modified** (inchangés):
- `capability-registry.ts` - continue à utiliser `capability_records`
- `capability-store.ts` - continue à utiliser `capability_records`
- `lib/std/cap.ts` - continue à utiliser `capability_records`

---

## Technical Notes

### Migration 031: pml_registry VIEW

```sql
-- Ajouter colonnes à tool_schema
-- DEFAULT 'local' pour sécurité: stdio MCPs avec accès système
-- ne doivent PAS s'exécuter en cloud (accèderaient au filesystem serveur!)
ALTER TABLE tool_schema ADD COLUMN code_url TEXT;
ALTER TABLE tool_schema ADD COLUMN routing TEXT DEFAULT 'local'
  CHECK (routing IN ('local', 'cloud'));

-- Créer la VIEW unifiée
CREATE VIEW pml_registry AS
  -- MCP Tools
  SELECT
    'mcp-tool'::text as record_type,
    tool_id as id,
    name,
    description,
    code_url,
    routing,
    server_id,
    NULL::uuid as workflow_pattern_id,
    NULL::text as org,
    NULL::text as project,
    NULL::text as namespace,
    NULL::text as action
  FROM tool_schema

  UNION ALL

  -- Capabilities (id is UUID after migration 028)
  SELECT
    'capability'::text as record_type,
    cr.id::text,  -- UUID PK, cast to text for uniformity
    cr.namespace || ':' || cr.action as name,
    wp.description,
    NULL as code_url,  -- capabilities n'ont pas de code_url (code dans workflow_pattern)
    cr.routing,
    NULL as server_id,
    cr.workflow_pattern_id,
    cr.org,
    cr.project,
    cr.namespace,
    cr.action
  FROM capability_records cr
  LEFT JOIN workflow_pattern wp ON cr.workflow_pattern_id = wp.pattern_id;
```

### Schéma de la VIEW

| Colonne | Type | Source (mcp-tool) | Source (capability) |
|---------|------|-------------------|---------------------|
| `record_type` | TEXT | 'mcp-tool' | 'capability' |
| `id` | TEXT | tool_id | cr.id::text (UUID) |
| `name` | TEXT | name | namespace:action |
| `description` | TEXT | description | wp.description |
| `code_url` | TEXT | code_url | NULL |
| `routing` | TEXT | routing | cr.routing |
| `server_id` | TEXT | server_id | NULL |
| `workflow_pattern_id` | UUID | NULL | cr.workflow_pattern_id |
| `org`, `project`, `namespace`, `action` | TEXT | NULL | cr.* |

### Exemples de requêtes

```sql
-- Chercher tout (MCP tools + capabilities)
SELECT * FROM pml_registry WHERE name ILIKE '%file%';

-- Filtrer par type
SELECT * FROM pml_registry WHERE record_type = 'mcp-tool';
SELECT * FROM pml_registry WHERE record_type = 'capability';

-- Pour routing
SELECT * FROM pml_registry WHERE routing = 'local';
```

---

## Definition of Done

- [x] Migration 031 créée et testée (up + down)
- [x] VIEW `pml_registry` fonctionne
- [x] `deno task check` passe
- [x] Tests unitaires passent (25 tests: 7 migration + 18 discover handler)
- [x] pml:discover retourne `record_type` pour MCP tools ET capabilities

---

## Dev Agent Record

### Validation Notes (2025-12-30)

- Migration number corrected: 029 → 031 (029, 030 already exist)
- Routing default corrected: 'cloud' → 'local' (security: stdio MCPs with system access)
- VIEW SQL validated against current schema (capability_records.id is UUID after migration 028)

### Implementation Notes (2025-12-30)

**Files created:**
- `src/db/migrations/031_pml_registry_view.ts` - Migration with VIEW

**Files modified:**
- `src/db/migrations.ts` - Added import and registration
- `src/mcp/handlers/discover-handler.ts` - Added `record_type` field
- `src/capabilities/types/fqdn.ts` - Added `PmlRegistryRecord` type
- `tests/unit/mcp/handlers/discover_handler_test.ts` - Added 3 Story 13.8 tests
- `tests/unit/db/migrations/pml_registry_view_test.ts` - New test file (7 tests)

**Architecture Note:** La VIEW `pml_registry` est disponible pour requêtes SQL directes. `pml:discover` continue d'utiliser la recherche vectorielle (embeddings) pour le semantic search, mais retourne `record_type` compatible avec le schéma de la VIEW.
