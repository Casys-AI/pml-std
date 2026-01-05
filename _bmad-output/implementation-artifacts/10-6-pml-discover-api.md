# Story 10.6: pml_discover - Unified Discovery API

Status: done

> **Epic:** 10 - DAG Capability Learning & Unified APIs **Tech-Spec:**
> [epic-10-dag-capability-learning-unified-apis.md](../epics/epic-10-dag-capability-learning-unified-apis.md)
> **ADR:** [ADR-038 Scoring Algorithms](../adrs/ADR-038-scoring-algorithms-reference.md) - Mode
> **Active Search** **Prerequisites:** Story 10.5 (Execute Code via DAG - DONE) **Depends on:**
> VectorSearch, GraphRAGEngine, DAGSuggester, CapabilityStore

---

## Story

As an AI agent, I want a single `pml_discover` tool to search both tools and capabilities, So that I
have a simplified API for finding what I need instead of using multiple separate tools.

---

## Context & Problem

**Le gap actuel:**

Claude doit actuellement choisir entre plusieurs tools de recherche :

| Tool actuel               | Ce qu'il fait                                  | Quand l'utiliser                         |
| ------------------------- | ---------------------------------------------- | ---------------------------------------- |
| `pml_search_tools`        | Recherche sémantique + graph sur les MCP tools | Quand on veut découvrir des tools        |
| `pml_search_capabilities` | Recherche de capabilities apprises             | Quand on veut réutiliser du code éprouvé |

**Problèmes :**

1. **Fragmentation cognitive** - L'IA doit décider quel tool utiliser
2. **Deux appels séparés** - Si l'IA veut les deux, elle fait 2 requêtes
3. **Pas de ranking unifié** - Les scores ne sont pas comparables

**Mode Active Search (ADR-038):**

`pml_discover` implémente le mode **Active Search** - une recherche explicite par intent. C'est
différent du mode **Passive Suggestion** qui suggère automatiquement pendant l'exécution.

| Mode                   | Trigger                         | Algorithms                                 | Implémentation                    |
| ---------------------- | ------------------------------- | ------------------------------------------ | --------------------------------- |
| **Active Search**      | `pml_discover({ intent })`      | Hybrid Search + Capability Match           | Cette story                       |
| **Passive Suggestion** | Pendant workflow (contextTools) | Next Step Prediction + Strategic Discovery | `DAGSuggester.predictNextTools()` |

**Solution : `pml_discover`**

Un seul tool qui :

- Cherche **à la fois** tools ET capabilities
- Retourne un ranking **unifié** par score
- Permet de **filtrer** par type si besoin
- Inclut les **schemas** pour exécution immédiate

**Migration:**

| Phase | Changement                                       |
| ----- | ------------------------------------------------ |
| 10.6  | `pml_discover` créé, anciens tools **dépréciés** |
| 10.7+ | Suppression des anciens tools                    |

---

## Acceptance Criteria

### AC1: Handler pml_discover créé ✅

- [x] Créer `src/mcp/handlers/discover-handler.ts`
- [x] Handler `handleDiscover(args, vectorSearch, graphEngine, dagSuggester)`
- [x] Input validation avec JSON Schema
- [x] Export dans `src/mcp/handlers/mod.ts`

### AC2: Tool Definition créée ✅

- [x] Ajouter `discoverTool` dans `src/mcp/tools/definitions.ts`
- [x] Schema d'input :
  ```typescript
  {
    intent: string;              // Required: natural language query
    filter?: {
      type?: "tool" | "capability" | "all";  // default: "all"
      minScore?: number;         // default: 0.0
    };
    limit?: number;              // default: 10
    include_related?: boolean;   // default: false (graph-based related tools)
  }
  ```
- [x] Ajouter à `getMetaTools()` array

### AC3: Recherche unifiée implémentée ✅

- [x] Vector search sur tools via `graphEngine.searchToolsHybrid()`
- [x] Vector search sur capabilities via `dagSuggester.searchCapabilities()`
- [x] Merge des résultats avec scores normalisés (0-1)
- [x] Sort par `finalScore` décroissant

### AC4: Response format unifié ✅

- [x] Structure de réponse :
  ```typescript
  interface DiscoverResponse {
    results: Array<{
      type: "tool" | "capability";
      id: string; // tool_id ou capability_id
      name: string; // Tool name ou capability name
      description: string;
      score: number; // Final score (0-1)
      // Tool-specific
      server_id?: string;
      input_schema?: JSONSchema;
      related_tools?: RelatedTool[];
      // Capability-specific
      code_snippet?: string;
      success_rate?: number;
      usage_count?: number;
      semantic_score?: number; // For capabilities
    }>;
    meta: {
      query: string;
      filter_type: string;
      total_found: number;
      tools_count: number;
      capabilities_count: number;
    };
  }
  ```

### AC5: Filtrage par type ✅

- [x] `filter.type = "tool"` → uniquement des tools
- [x] `filter.type = "capability"` → uniquement des capabilities
- [x] `filter.type = "all"` (default) → mix trié par score
- [x] `filter.minScore` → exclure les résultats sous le seuil

### AC6: Pagination ✅

- [x] `limit` parameter (default: 10, max: 50)
- [x] Résultats triés par score puis tronqués au limit

### AC7: Include Related Tools ✅

- [x] Si `include_related = true`, ajouter `related_tools` pour chaque tool
- [x] Réutiliser la logique existante de `handleSearchTools()`
- [x] Les related tools ne comptent pas dans le `limit`

### AC8: Dépréciation des anciens tools ✅

- [x] `pml_search_tools` : ajouter deprecation notice dans description
- [x] `pml_search_capabilities` : ajouter deprecation notice dans description
- [x] Log warning quand les anciens tools sont utilisés
- [x] Les anciens tools continuent de fonctionner (backward compat)

### AC9: Enregistrement dans GatewayServer ✅

- [x] Importer `handleDiscover` dans `gateway-server.ts`
- [x] Ajouter case `"pml:discover"` dans `handleToolCall()`
- [x] Passer les dépendances nécessaires (vectorSearch, graphEngine, dagSuggester)

### AC10: Tests unitaires ✅

- [x] Test: search "read file" → retourne mix tools + capabilities
- [x] Test: filter type="tool" → que des tools retournés
- [x] Test: filter type="capability" → que des capabilities retournées
- [x] Test: minScore filtre les résultats sous le seuil
- [x] Test: limit respecté
- [x] Test: scores normalisés entre 0 et 1
- [x] Test: include_related ajoute related_tools

### AC11: Tests d'intégration ✅

- [x] Test E2E: appel MCP `pml:discover` via gateway
- [x] Test: dépréciation logged quand `pml_search_tools` utilisé
- [x] Test: réponse backward compatible pour anciens tools

### AC12: Unified Search Algorithm Integration (ex-10.6a) ✅

- [x] Formule simplifiée pour search sans contexte: `score = semantic × reliability`
- [x] Pas d'alpha/graph quand `contextNodes.length === 0` (Adamic-Adar retourne 0)
- [x] Appliquer `reliabilityFactor` aux tools (default successRate=1.0, boosted)
- [x] Support `getTransitiveReliability()` pour capabilities via CapabilityMatcher
- [x] Tests: tools et capabilities scorés avec même formule
- [x] Tests: reliability appliquée aux deux types
- [x] Benchmark: unified-search.bench.ts exécuté

### AC13: Refactor discover-handler pour formule unifiée ✅

- [x] Créer `computeDiscoverScore(semanticScore, successRate)` helper
- [x] Appliquer formule `semantic × reliability` aux tools ET capabilities
- [x] Utiliser `calculateReliabilityFactor()` de unified-search.ts (thresholds)
- [x] Merger les résultats et trier par score (avec formule unifiée)
- [x] Nettoyer: supprimer les formules différentes actuelles

---

## Tasks / Subtasks

- [x] **Task 1: Créer le handler discover** (AC: 1, 3, 4)
  - [x] Créer `src/mcp/handlers/discover-handler.ts`
  - [x] Implémenter `handleDiscover()` function
  - [x] Appeler `graphEngine.searchToolsHybrid()` pour tools
  - [x] Appeler `dagSuggester.searchCapabilities()` pour capabilities
  - [x] Normaliser les scores (tools: finalScore, capabilities: score)
  - [x] Merge et sort par score décroissant
  - [x] Formater la réponse unifiée

- [x] **Task 2: Ajouter la tool definition** (AC: 2, 9)
  - [x] Ajouter `discoverTool` dans `definitions.ts`
  - [x] Définir inputSchema avec tous les paramètres
  - [x] Ajouter à `getMetaTools()` array
  - [x] Enregistrer dans `gateway-server.ts` handleToolCall

- [x] **Task 3: Implémenter le filtrage** (AC: 5, 6)
  - [x] Parser `filter.type` et appliquer
  - [x] Implémenter `filter.minScore` threshold
  - [x] Appliquer `limit` après merge et sort
  - [x] Valider les paramètres (limit max 50)

- [x] **Task 4: Support include_related** (AC: 7)
  - [x] Si `include_related=true`, enrichir les résultats tools
  - [x] Réutiliser logique de `handleSearchTools()` pour related
  - [x] S'assurer que related_tools ne comptent pas dans limit

- [x] **Task 5: Déprécier les anciens tools** (AC: 8)
  - [x] Ajouter "[DEPRECATED]" au début des descriptions
  - [x] Ajouter note de migration vers `pml_discover`
  - [x] Ajouter log.warn() quand les anciens handlers sont appelés
  - [x] Vérifier backward compatibility

- [x] **Task 6: Tests** (AC: 10, 11)
  - [x] Créer `tests/unit/mcp/handlers/discover_handler_test.ts`
  - [x] Tests unitaires pour chaque AC (10 tests)
  - [x] Tests d'intégration avec GatewayServer

- [x] **Task 7: Unified Scoring Formula** (AC: 12, 13)
  - [x] Créer helper `computeDiscoverScore(semantic, successRate)`
  - [x] Formule: `score = semantic × calculateReliabilityFactor(successRate)`
  - [x] Appliquer aux tools (default successRate=1.0 → boost factor 1.2)
  - [x] Réutiliser `getTransitiveReliability()` de CapabilityMatcher pour capabilities
  - [x] Mettre à jour les tests pour vérifier formule unifiée (AC12-AC13 tests ajoutés)
  - [x] Benchmark: unified-search.bench.ts exécuté

### Review Follow-ups (AI) - 2025-12-22

- [x] [AI-Review][HIGH] AC11 Tests d'intégration manquants - FIXED: 5 E2E tests added in
      mcp_gateway_e2e_test.ts
- [x] [AI-Review][MEDIUM] Documenter unified-search.ts dans File List - FIXED: Added to File List
- [x] [AI-Review][MEDIUM] Valider intent non-vide - FIXED: Added trim() validation + test for
      whitespace-only intent
- [x] [AI-Review][MEDIUM] Single-capability behavior - BY DESIGN: DAGSuggester.searchCapabilities
      returns best match only
- [x] [AI-Review][MEDIUM] Simplifier searchTools() - BY DESIGN: API receives deps, forwards to
      engine (clean separation)
- [x] [AI-Review][MEDIUM] Clarifier meta counts - FIXED: Added returned_count to meta (total_found
      vs returned_count)
- [x] [AI-Review][LOW] transitiveReliability comment - VERIFIED: Implemented in matcher.ts:187-188
- [x] [AI-Review][LOW] Change Log AC12-AC13 - Already documented in existing Change Log entry
- [x] [AI-Review][LOW] Extraire GLOBAL_SCORE_CAP - FIXED: Added constant in unified-search.ts,
      exported and used
- [x] [AI-Review][LOW] Tests dynamiques - FIXED: Tests now use computeDiscoverScore() and
      GLOBAL_SCORE_CAP

---

## Dev Notes

### Unified Search Migration (AC12-13, 2025-12-22)

**Motivation:** Actuellement deux formules différentes pour tools et capabilities. Migration vers
une formule cohérente selon le contexte.

**Avant (deux formules incohérentes):**

```typescript
// Tools (graphEngine.searchToolsHybrid)
finalScore = α × semantic + (1-α) × graph

// Capabilities (capabilityMatcher.findMatch)
score = semantic × reliability
```

**Après (séparation claire):**

```typescript
// pml_discover (recherche sans contexte)
score = semantic × reliability

// predictNextNode (suggestion pendant workflow) → SHGAT + DR-DSP (stories 10.7a/b)
// Voir: src/graphrag/algorithms/dr-dsp.ts (pathfinding hypergraphe)
// Voir: src/graphrag/algorithms/shgat.ts (scoring spectral)
```

**Pourquoi cette séparation:**

- **pml_discover:** Recherche pure par intent, pas de contexte workflow
- **predictNextNode:** Suggère le prochain nœud dans un workflow actif
  - Utilise DR-DSP pour pathfinding sur hypergraphe (remplace Dijkstra)
  - Utilise SHGAT pour scoring avec attention spectrale
  - Story 10.7a (DR-DSP) + 10.7b (SHGAT)

**Architecture des 4 modes:**

- `pml_discover` → Cette story (formule simple `semantic × reliability`)
- `suggestDAG` → Story 10.7a (DR-DSP pour pathfinding)
- `predictNextNode` → Stories 10.7a/b (SHGAT + DR-DSP, **post-workflow** uniquement)
- `speculateNextLayer` → Stories 12.4/12.6 (pas de prédiction, DAG connu, **intra-workflow**)

**Note (2025-12-22):** `predictNextNode` = post-workflow (prédit après workflow terminé).
L'intra-workflow utilise `speculateNextLayer` qui pré-exécute le DAG connu sans prédiction.

**Modules existants à réutiliser:**

- `src/graphrag/algorithms/unified-search.ts` → **UNIQUEMENT** `calculateReliabilityFactor()`
  - PAS le search algorithm complet (réservé pour future use)
  - PAS pour `predictNextNode` (utilise SHGAT + DR-DSP en 10.7a/b)
- `src/graphrag/capability-store.ts` → `successRate` des capabilities

**Architecture cible (simplifiée):**

```
┌─────────────────────────────────────────────────────────────┐
│  handleDiscover(intent)                                      │
│                                                              │
│  1. Vector search sur tools → semanticScore                  │
│  2. Vector search sur capabilities → semanticScore           │
│                                                              │
│  3. Pour chaque résultat:                                    │
│     reliability = calculateReliabilityFactor(successRate)    │
│     score = semanticScore × reliability                      │
│                                                              │
│  4. Merge + sort par score                                   │
└─────────────────────────────────────────────────────────────┘
```

**Note:** Le graph (alpha, Adamic-Adar) n'est PAS utilisé dans pml_discover car il n'y a pas de
contexte. Pour `predictNextNode()` (workflow en cours), on utilise SHGAT + DR-DSP (stories 10.7a/b),
pas unified-search.

**Estimation:** +0.5 jour sur story existante (formule simplifiée)

---

### Architecture existante à réutiliser (ADR-038 Active Search)

**Pour les tools - Hybrid Search (ADR-038 §2.1):**

```typescript
// Formule: finalScore = alpha * semanticScore + (1 - alpha) * graphScore
// Utilise graphEngine.searchToolsHybrid() qui retourne:
interface HybridSearchResult {
  toolId: string;
  serverId: string;
  description: string;
  schema?: { inputSchema: JSONSchema };
  semanticScore: number;
  graphScore: number; // Weighted Adamic-Adar
  finalScore: number; // Score normalisé 0-1
  relatedTools?: RelatedTool[];
}
```

**Pour les capabilities - searchByIntent + Capability Match (ADR-038 §3.1):**

```typescript
// Flow: dagSuggester.searchCapabilities()
//       → capabilityMatcher.findMatch()
//           → capabilityStore.searchByIntent() (vector search)
//           → score = semanticScore * reliabilityFactor (ADR-038)

// capabilityStore.searchByIntent() retourne:
interface CapabilitySearchResult {
  capability: Capability;
  semanticScore: number; // Cosine similarity (vector search)
}

// capabilityMatcher.findMatch() applique ADR-038 et retourne:
interface CapabilityMatch {
  capability: Capability;
  score: number; // Final = semanticScore * reliabilityFactor
  semanticScore: number;
  parametersSchema?: JSONSchema;
  thresholdUsed: number;
}
```

**Note cold start:** Pas de problème - une capability existe seulement après 1ère exécution réussie,
donc `successRate >= 1.0` au départ (Story 7.2a eager learning).

**Note:** Le mode Passive Suggestion (`DAGSuggester.predictNextTools()`) utilise des algorithmes
différents (Next Step Prediction, Strategic Discovery) - voir ADR-038 §2.2 et §3.2.

### Score Normalization

Les scores des deux sources sont déjà normalisés entre 0 et 1 :

- Tools: `finalScore` = weighted combination of semantic + graph scores
- Capabilities: `score` = semantic × reliability

**Pas besoin de normalisation supplémentaire** - on peut directement merger et trier.

### Response Mapping

```typescript
// Tool result → DiscoverResult
{
  type: "tool",
  id: result.toolId,
  name: result.toolId.split(":")[1],  // e.g., "read_file"
  description: result.description,
  score: result.finalScore,
  server_id: result.serverId,
  input_schema: result.schema?.inputSchema,
  related_tools: result.relatedTools,
}

// Capability result → DiscoverResult
{
  type: "capability",
  id: match.capability.id,
  name: match.capability.name ?? match.capability.id.substring(0, 8),
  description: match.capability.description ?? "Learned capability",
  score: match.score,
  code_snippet: match.capability.codeSnippet,
  success_rate: match.capability.successRate,
  usage_count: match.capability.usageCount,
  semantic_score: match.semanticScore,
}
```

### Files to Create

| File                                          | Description       | LOC estimé |
| --------------------------------------------- | ----------------- | ---------- |
| `src/mcp/handlers/discover-handler.ts`        | Handler principal | ~150 LOC   |
| `tests/mcp/handlers/discover-handler_test.ts` | Tests unitaires   | ~200 LOC   |

### Files to Modify

| File                                 | Changement                            | LOC estimé |
| ------------------------------------ | ------------------------------------- | ---------- |
| `src/mcp/tools/definitions.ts`       | Ajouter `discoverTool` + getMetaTools | ~40 LOC    |
| `src/mcp/handlers/mod.ts`            | Export handleDiscover                 | ~2 LOC     |
| `src/mcp/handlers/search-handler.ts` | Deprecation warnings                  | ~15 LOC    |
| `src/mcp/gateway-server.ts`          | Register discover handler             | ~20 LOC    |

### Learnings from Previous Story (10.5)

1. **Architecture unifiée Worker-only** - Tout passe par WorkerBridge maintenant
2. **Performance** - Worker ~31ms vs subprocess ~53ms (1.7x speedup)
3. **createToolExecutorViaWorker()** - Nouveau pattern pour exécution tools
4. **Pas de fallback** - Un seul chemin d'exécution (simplicité)

Ces patterns ne s'appliquent pas directement à cette story (recherche pure, pas d'exécution), mais
le principe de **simplicité** s'applique : UN seul tool de découverte.

### Git Intelligence (Recent Commits)

```
ae79a59 fix: update std_tools tests for expanded tool library
eb96cbb fix: resolve type errors and add MiniToolsClient after branch merge
9545420 feat(std): expand docker and database tools for comprehensive coverage
6d348fe feat(config): add reliability and community multipliers to DagScoringConfig
```

**Patterns observés :**

- Ajout récent de ~120 tools dans `lib/std/` (docker, database, etc.)
- Configuration scoring via `DagScoringConfig`
- Tests mis à jour pour nouvelle tool library

### Key References

**Source Files:**

- `src/mcp/handlers/search-handler.ts:28-119` - handleSearchTools (réutiliser)
- `src/mcp/handlers/search-handler.ts:131-193` - handleSearchCapabilities (réutiliser)
- `src/mcp/tools/definitions.ts:49-111` - searchToolsTool, searchCapabilitiesTool (déprécier)
- `src/graphrag/graph-engine.ts` - searchToolsHybrid()
- `src/graphrag/dag-suggester.ts` - searchCapabilities()

**Epic & Previous Stories:**

- [Epic 10](../epics/epic-10-dag-capability-learning-unified-apis.md) - Unified APIs goal
- [Story 10.5](10-5-execute-code-via-dag.md) - Architecture Worker unifiée

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- All 10 unit tests passing
- Type checks passing for all modified files

### Completion Notes List

1. Created unified discover handler (`discover-handler.ts`) implementing ADR-038 Active Search mode
2. Uses `graphEngine.searchToolsHybrid()` for tools (Hybrid Search algorithm)
3. Uses `dagSuggester.searchCapabilities()` for capabilities (Capability Match algorithm)
4. Scores already normalized 0-1, no additional normalization needed
5. Removed old tools from MCP exposure (`pml_search_tools`, `pml_search_capabilities`)
6. Backward compatibility maintained - old handlers still work if called directly (log warnings)

### Change Log

- 2025-12-20: Story context created via create-story workflow (Claude Opus 4.5)
- 2025-12-21: Implementation completed (Claude Opus 4.5)
- 2025-12-22: Code review - 1 HIGH, 5 MEDIUM, 4 LOW issues identified. 10 action items created.
  (Claude Opus 4.5)
- 2025-12-22: All 10 review follow-ups completed - 5 E2E tests added, intent validation,
  GLOBAL_SCORE_CAP extracted, returned_count in meta, tests refactored (Claude Opus 4.5)

### File List

- [x] `src/mcp/handlers/discover-handler.ts` - NEW (220 LOC)
- [x] `src/mcp/tools/definitions.ts` - MODIFY (~50 LOC)
- [x] `src/mcp/handlers/mod.ts` - MODIFY (~2 LOC)
- [x] `src/mcp/handlers/search-handler.ts` - MODIFY (~4 LOC deprecation warnings)
- [x] `src/mcp/gateway-server.ts` - MODIFY (~5 LOC)
- [x] `src/graphrag/algorithms/unified-search.ts` - MODIFY (~10 LOC: GLOBAL_SCORE_CAP export)
- [x] `tests/unit/mcp/handlers/discover_handler_test.ts` - NEW (~450 LOC)
- [x] `tests/integration/mcp_gateway_e2e_test.ts` - MODIFY (~330 LOC: AC11 E2E tests)
