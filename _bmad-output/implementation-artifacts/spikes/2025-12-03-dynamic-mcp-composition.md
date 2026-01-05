# SPIKE-001: Questions Ouvertes ADR-027 - Code Execution & Capabilities

## Status: Research In Progress

**Date:** 2025-12-03 **Trigger:** Article Docker "Dynamic MCPs" + Réflexion ADR-027 **Related:**
ADR-027 (Execute Code Graph Learning)

---

## Contexte: Ce qu'Casys PML fait déjà (mieux que Docker)

### Notre approche: Intent-based Discovery AVANT exécution

```
┌─────────────────────────────────────────────────────────────────┐
│  execute_code(intent: "analyze commits")                         │
│                                                                  │
│  PHASE 1 - Discovery (AVANT sandbox)                             │
│  ├── vectorSearch.searchTools(intent)                            │
│  │   └── BGE-M3 embedding → pgvector cosine similarity           │
│  │   └── Top-K tools avec score > 0.6                            │
│  │                                                               │
│  ├── contextBuilder.buildContextFromSearchResults(tools)         │
│  │   └── Wrap chaque tool en fonction TypeScript                 │
│  │   └── Validation sécurité (no prototype pollution)            │
│  │                                                               │
│  PHASE 2 - Execution (DANS sandbox)                              │
│  └── sandbox.execute(code, context)                              │
│      └── Tools pré-injectés, scope fixe                          │
│      └── Zéro découverte runtime = zéro récursion                │
└─────────────────────────────────────────────────────────────────┘
```

### Comparaison avec Docker

| Aspect    | Docker (mcp-find/mcp-add)        | Casys PML                          |
| --------- | -------------------------------- | ---------------------------------- |
| Discovery | Catalog lookup runtime           | **Semantic search** (embeddings)   |
| Quand     | PENDANT exécution                | **AVANT** exécution                |
| Récursion | Possible (code appelle mcp-find) | **Impossible** by design           |
| Tracking  | Complexe (events mid-run)        | **Trivial** (tools connus upfront) |
| Sécurité  | Code injecte des MCPs            | **Wrappers contrôlés**             |

**Conclusion:** On n'a pas besoin de copier Docker. Notre approche est architecturalement plus
propre.

---

## Décisions du Party Mode (2025-12-03)

### Architecture à deux niveaux

```
┌─────────────────────────────────────────────────────────────────┐
│  NIVEAU 1: GraphRAG (données brutes)                             │
│  ├── Edges entre tools avec weights                              │
│  ├── Co-occurrences apprises des exécutions                      │
│  └── Signal brut, pas d'interprétation                           │
├─────────────────────────────────────────────────────────────────┤
│  NIVEAU 2: Capabilities (interprétation cristallisée)            │
│  ├── Clusters détectés ou patterns validés                       │
│  ├── Code prêt à l'emploi                                        │
│  └── Cache des résultats                                         │
└─────────────────────────────────────────────────────────────────┘
```

### Définition d'une Capability Explicite

```typescript
interface Capability {
  id: string;
  name: string; // "analyze-weekly-commits"
  intent_text: string; // "analyze commits this week"
  intent_embedding: number[]; // pour vector search matching

  // Les MCPs impliqués
  tool_ids: string[]; // ["github:list_commits", "memory:store"]

  // CODE PRÊT À L'EMPLOI
  code: string; // TypeScript exécutable
  code_fingerprint: string; // pour déduplication

  // Paramètres extraits
  parameters: {
    name: string;
    type: string;
    default?: unknown;
  }[];

  // Stats
  success_count: number;
  failure_count: number;
  avg_execution_ms: number;
  last_used: Date;

  // Cache config
  cache_config: {
    cacheable: boolean;
    ttl_seconds: number;
    invalidation_triggers?: string[]; // tools qui invalident le cache
  };

  // Provenance
  created_from_execution_id?: string;
  cluster_id?: string;
}
```

### Flow Complet avec Capabilities

```
┌─────────────────────────────────────────────────────────────────┐
│  execute_code(intent: "analyze commits this week")               │
│                                                                  │
│  ÉTAPE 1: Chercher capability existante                          │
│  ├── Embed intent (BGE-M3)                                       │
│  ├── Vector search sur capabilities.intent_embedding             │
│  └── Score > 0.85? → MATCH                                       │
│                                                                  │
│  ÉTAPE 2a (si match): Réutiliser                                 │
│  ├── Cache hit? → Retourner résultat caché (INSTANT)             │
│  ├── Cache miss? → Exécuter capability.code                      │
│  ├── Stocker résultat en cache                                   │
│  └── Incrémenter stats                                           │
│                                                                  │
│  ÉTAPE 2b (si pas match): Générer                                │
│  ├── Vector search tools (comme avant)                           │
│  ├── Claude génère le code                                       │
│  ├── Exécuter dans sandbox                                       │
│  ├── TRACKER les appels MCP (events)                             │
│  └── Si succès → CANDIDATE pour nouvelle capability              │
│                                                                  │
│  ÉTAPE 3: Learning                                               │
│  ├── GraphRAG.updateFromExecution() avec vraie séquence          │
│  └── Pattern récurrent détecté? → Promouvoir en capability       │
└─────────────────────────────────────────────────────────────────┘
```

### Trois Niveaux de Gain

| Niveau              | Ce qu'on skip                 | Gain             |
| ------------------- | ----------------------------- | ---------------- |
| **Code Reuse**      | Génération Claude             | ~2-5 secondes    |
| **Execution Reuse** | Exécution sandbox (cache hit) | ~200-500ms       |
| **Partial Cache**   | Appels MCP individuels        | Réduit API calls |

### Scope de l'Epic

**IN SCOPE:**

1. Event tracking des appels MCP dans sandbox
2. GraphRAG learning des séquences réelles
3. Clustering pour détecter patterns
4. Table capabilities avec code stocké
5. Matching intent → capability → exécution directe
6. Cache des résultats avec TTL
7. Invalidation triggers

**OUT OF SCOPE (future epic):**

- UX panel pour gérer les capabilities
- Export/import entre instances
- Health checks automatiques
- Versioning des capabilities

---

## Questions Ouvertes

### Catégorie A: Stockage & Persistence des Capabilities

#### Q-A1: Schema de la table capabilities

**Décision préliminaire:** Utiliser le schema TypeScript défini ci-dessus.

**Questions restantes:**

- Table séparée `capability_tools` (N:M) ou array JSONB?
- Index sur `intent_embedding` (pgvector)?
- Partitioning par date de création?

#### Q-A2: Stockage du cache des résultats

**Options:**

| Option                           | Pour                                | Contre              |
| -------------------------------- | ----------------------------------- | ------------------- |
| Table séparée `capability_cache` | Clean, queryable, monitoring facile | Jointures           |
| Colonne JSONB dans capabilities  | Simple                              | Difficile à purger  |
| Cache externe (Redis)            | Performance                         | Nouvelle dépendance |

**Schema proposé (table séparée):**

```sql
CREATE TABLE capability_cache (
  id TEXT PRIMARY KEY,
  capability_id TEXT REFERENCES capabilities(id),
  input_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  cached_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  hit_count INTEGER DEFAULT 0,

  UNIQUE(capability_id, input_hash)
);
```

#### Q-A3: TTL par défaut du cache

| Type de capability | Exemple                 | TTL suggéré  |
| ------------------ | ----------------------- | ------------ |
| Statique           | "get repo structure"    | 1 heure      |
| Semi-dynamique     | "commits cette semaine" | 5-15 minutes |
| Dynamique          | "build status"          | Pas de cache |

**Question:** Comment détecter automatiquement le type? Ou déclaration manuelle?

#### Q-A4: Taille max du cache

**Options:**

- Par capability: max 100 entrées, LRU eviction
- Global: max 10000 entrées total
- Par taille: max 100MB

---

### Catégorie B: GraphRAG & Clustering pour Capabilities

#### Q-B1: Le GraphRAG peut-il détecter des capabilities automatiquement?

**Idée validée:** Clustering sur les edges pour identifier des groupes de tools = capabilities
implicites.

```
         GraphRAG actuel                      Clustering
┌─────────────────────────────┐      ┌─────────────────────────────┐
│                             │      │                             │
│  github:list ──0.8──► mem   │      │  ┌─────────────────────┐    │
│      │                 │    │  =>  │  │ Cluster "git-memory"│    │
│     0.7               0.6   │      │  │ github:list_commits │    │
│      ▼                 ▼    │      │  │ github:get_commit   │    │
│  github:get ──0.5──► fs     │      │  │ memory:store        │    │
│                             │      │  └─────────────────────┘    │
└─────────────────────────────┘      └─────────────────────────────┘
```

**Algorithmes à évaluer:**

- Louvain (community detection)
- Label Propagation
- K-means sur embeddings des tools
- Spectral clustering

**Questions:**

- Quel seuil de weight minimum pour considérer une edge?
- Fréquence du clustering? (chaque N exécutions? cron?)
- Comment nommer automatiquement un cluster?

#### Q-B2: Capability = Cluster ou entité séparée?

**Décision:** Entité séparée. Le cluster est une _source_ de capability candidate, pas la capability
elle-même.

```
Cluster détecté → Capability candidate → Validation (N succès) → Capability explicite
```

#### Q-B3: Relation tools ↔ capabilities (N:M)

Un tool peut appartenir à plusieurs capabilities:

```
memory:store ∈ {
  "git-analysis",
  "file-indexing",
  "research-workflow"
}
```

**Questions:**

- Membership score (core vs périphérique)?
- Impact sur la suggestion: si tool X est utilisé, suggérer les capabilities qui le contiennent?

---

### Catégorie C: Pattern Learning

#### Q-C1: Comment détecter qu'un pattern est "récurrent"?

**Critères possibles:**

- Même séquence de tools N fois (N = 3? 5? 10?)
- Même intent embedding cluster
- Même fingerprint de code

**Questions:**

- Faut-il que le code soit identique ou juste la séquence de tools?
- Comment gérer les variations mineures? (paramètres différents)
- Fenêtre temporelle? (3 fois en 1 semaine vs 3 fois en 1 an)

#### Q-C2: Promotion automatique vs manuelle

| Mode       | Description                          | Pour           | Contre              |
| ---------- | ------------------------------------ | -------------- | ------------------- |
| **Auto**   | Pattern N fois + succès → capability | Zéro friction  | Peut créer du bruit |
| **Manuel** | User/Claude dit "save this"          | Contrôle total | Friction, oublis    |
| **Hybrid** | Auto-suggest, user confirme          | Balance        | UX à designer       |

**Question:** Quel est le bon équilibre? Notification "Nouveau pattern détecté, voulez-vous le
sauvegarder?"

#### Q-C3: Comment extraire les paramètres du code?

```typescript
// Code stocké
const commits = await github.listCommits({ days: 7 });

// Comment détecter que "7" est un paramètre "days"?
// Et générer:
parameters: [{ name: "days", type: "number", default: 7 }];
```

**Options:**

- Analyse AST du code
- LLM pour extraire les paramètres
- Template avec placeholders `{{days}}`
- Déclaration manuelle

#### Q-C4: Apprentissage des erreurs

**ADR-027 mentionne:** "Error Learning - Remember what failed and why"

**Questions:**

- Stocker les patterns qui échouent systématiquement?
- Blacklist de séquences de tools à éviter?
- Comment distinguer erreur de code vs erreur de pattern?

---

### Catégorie D: IPC & Execution Tracking

#### Q-D1: Comment tracker les tools réellement appelés dans le sandbox?

**Architecture actuelle:**

```
Gateway Server (parent)
      │
      │ spawn Deno subprocess
      ▼
Sandbox ──stdout──► Parent parse output
```

**Problème:** Comment le sandbox communique les appels MCP au parent?

**Options:**

| Option                | Description                          | Pour                | Contre              |
| --------------------- | ------------------------------------ | ------------------- | ------------------- |
| **stdout JSON lines** | `{"__trace": "tool_start", ...}`     | Simple, Deno-native | Mélangé avec output |
| **stderr séparé**     | Traces sur stderr, result sur stdout | Séparation claire   | stderr = erreurs?   |
| **Channel dédié**     | Pipe ou socket                       | Propre              | Plus de plomberie   |
| **Post-hoc**          | Wrapper retourne metadata            | Simple              | Pas de streaming    |

**Question:** Quel overhead acceptable? (<10ms par appel?)

#### Q-D2: Format des events

```typescript
type ExecutionEvent =
  | { type: "tool_start"; tool: string; args: unknown; ts: number }
  | { type: "tool_end"; tool: string; success: boolean; duration_ms: number; result_size?: number }
  | { type: "progress"; message: string; percent?: number }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "result"; data: unknown };
```

**Questions:**

- Inclure les args dans tool_start? (risque données sensibles)
- Inclure le result dans tool_end? (risque taille)
- Niveau de verbosité configurable?

#### Q-D3: Comment représenter Promise.all() (parallélisme)?

```typescript
const [commits, issues] = await Promise.all([
  github.listCommits(),
  github.listIssues(),
]);
```

**Le DAG actuel est séquentiel.** Comment représenter le parallélisme?

| Option                         | Représentation                          |
| ------------------------------ | --------------------------------------- |
| `depends_on: []` pour les deux | Parallèle implicite (pas de dépendance) |
| `parallel_group: "pg_1"`       | Groupe explicite                        |
| Timestamp-based                | Reconstruire l'ordre réel post-hoc      |

**Question:** Est-ce que le parallélisme est important pour le learning? Ou on peut ignorer et
traiter comme séquentiel?

#### Q-D4: Buffering vs Streaming

**Options:**

- **Buffered:** Collecter tous les events, parser à la fin
- **Streaming:** Parser en temps réel, permettre progress updates

**Trade-off:** Streaming = meilleure UX (progress), mais plus complexe.

#### Q-D5: Communication bidirectionnelle?

**Use case:** Le sandbox pourrait demander des tools supplémentaires mid-execution.

```typescript
// Dans le sandbox
const extraTool = await requestTool("tavily:search"); // demande au parent
```

**Question:** Est-ce qu'on veut ça? Ça ramène la complexité de Docker...

**Intuition:** Non pour le MVP. Garder le scope fixe.

---

### Catégorie E: Fingerprinting & Déduplication

#### Q-E1: Comment fingerprinter le code?

| Méthode                   | Pour              | Contre                |
| ------------------------- | ----------------- | --------------------- |
| `sha256(code)`            | Simple, exact     | Sensible whitespace   |
| `sha256(normalize(code))` | Tolère formatting | Définir normalisation |
| `sha256(tool_sequence)`   | Ignore implem     | Perd détails          |
| `embedding(code)`         | Similarité floue  | Approximatif          |

**Question:** Qu'est-ce que "normaliser"? Strip comments? Rename vars? Format?

#### Q-E2: Quand deux capabilities sont-elles "la même"?

```typescript
// Capability 1
const commits = await github.listCommits({ days: 7 });
return commits.map((c) => c.message);

// Capability 2
const commits = await github.listCommits({ since: "2024-01-01" });
return commits.map((c) => ({ msg: c.message, author: c.author }));
```

**Même tool sequence, code différent.** Même capability ou deux différentes?

---

### Catégorie F: Retrieval & Matching

#### Q-F1: Comment retrouver une capability pour un intent?

**Flow:**

```
Intent → Embed (BGE-M3) → Vector search capabilities → Top-K score > 0.85
```

**Questions:**

- Même index pgvector que tools ou index séparé?
- Seuil de similarité? (0.8? 0.85? 0.9?)
- Multi-match: prendre le meilleur ou demander à l'user?

#### Q-F2: Fallback si capability échoue?

**Scénario:** Capability matchée mais exécution échoue (MCP changed, etc.)

**Options:**

- Retry avec code regénéré
- Marquer capability comme `degraded`
- Fallback silencieux vs notification user

---

### Catégorie G: Cache & Invalidation

#### Q-G1: Invalidation triggers automatiques

**Idée:** Certains appels MCP invalident le cache d'autres capabilities.

```typescript
// Capability "get-open-prs"
invalidation_triggers: [
  "github:create_pull_request", // nouveau PR → invalide
  "github:merge_pull_request", // PR mergé → invalide
];
```

**Questions:**

- Comment détecter ces relations automatiquement?
- Ou déclaration manuelle?
- Graphe de dépendances entre capabilities?

#### Q-G2: Cache warming

**Scénario:** On sait qu'une capability sera utilisée (ex: cron job).

**Question:** Pre-compute le cache? Ou lazy only?

---

### Catégorie H: Lifecycle & Maintenance

#### Q-H1: Health checks des capabilities

**Proposition:**

```typescript
interface CapabilityHealth {
  last_validated: Date;
  validation_result: "passed" | "failed" | "degraded";
  failure_reason?: string;
}
```

**Questions:**

- Fréquence des health checks? (daily? weekly?)
- Que faire si health check échoue? (soft delete? notification?)

#### Q-H2: Versioning des capabilities

- Multi-versions d'une capability?
- Migration v1 → v2?
- Rollback possible?

---

## Expérimentations Proposées

### Exp 1: Event Tracking dans Sandbox

Instrumenter `wrapMCPClient()` pour émettre des events:

```typescript
// Dans context-builder.ts
wrapped[methodName] = async (args) => {
  const traceId = crypto.randomUUID();
  console.log(JSON.stringify({
    __trace: true,
    type: "tool_start",
    tool: `${serverId}:${toolName}`,
    trace_id: traceId,
    ts: Date.now(),
  }));

  const start = performance.now();
  const result = await client.callTool(toolName, args);

  console.log(JSON.stringify({
    __trace: true,
    type: "tool_end",
    tool: `${serverId}:${toolName}`,
    trace_id: traceId,
    success: true,
    duration_ms: performance.now() - start,
  }));

  return result;
};
```

### Exp 2: Clustering GraphRAG

Tester community detection sur le graph existant:

```typescript
// Pseudo-code
const edges = await db.query(`
  SELECT source_tool, target_tool, weight
  FROM tool_edges
  WHERE weight > 0.5
`);
const clusters = louvain(edges, { resolution: 1.0 });
// Analyser: les clusters font-ils sens?
```

### Exp 3: Capability Retrieval

```typescript
const capabilities = await db.query(
  `
  SELECT id, name, intent_text, tool_ids, code,
         1 - (intent_embedding <=> $1::vector) AS score
  FROM capabilities
  WHERE 1 - (intent_embedding <=> $1::vector) > 0.85
  ORDER BY score DESC
  LIMIT 3
`,
  [intentEmbedding],
);
```

---

## Prochaines Étapes

1. [ ] **Implémenter event tracking** dans `context-builder.ts`
2. [ ] **Parser les events** côté Gateway
3. [ ] **Appeler GraphRAG.updateFromExecution()** avec vraie séquence
4. [ ] **Définir schema capabilities** (table + migrations)
5. [ ] **Prototyper clustering** sur graph existant
6. [ ] **Implémenter capability matching** par intent
7. [ ] **Ajouter cache layer** avec TTL

---

## Références

- ADR-027: Execute Code Graph Learning
- ADR-016: Deno Sandbox Execution
- [Docker: Dynamic MCPs](https://www.docker.com/blog/dynamic-mcps-stop-hardcoding-your-agents-world/)
  (2025-12-01)
- `src/graphrag/graph-engine.ts`
- `src/sandbox/context-builder.ts`
- `src/vector/search.ts`

---

## Research: Alignement avec le Code Existant (2025-12-03)

### Ce qui EXISTE déjà

#### 1. Table `workflow_pattern` (Migration 010, lines 45-61) ⚠️ JAMAIS UTILISÉE

```sql
CREATE TABLE workflow_pattern (
  pattern_id UUID PRIMARY KEY,
  pattern_hash TEXT UNIQUE,
  dag_structure JSONB,
  intent_embedding vector(1024),  -- ✅ Prêt pour semantic search!
  usage_count INTEGER,
  success_count INTEGER,
  last_used TIMESTAMP
);
```

**🔍 Découverte importante:** Cette table existe dans les migrations mais **n'est utilisée nulle
part dans le code**!

- **Origine:** Migration 010 récupère un vieux fichier SQL (`003_graphrag_tables.sql`) qui n'avait
  jamais été intégré
- **Story 3.5-1:** Implémente le speculative execution avec `tool_dependency`, PAS
  `workflow_pattern`
- **Aucune référence:** Grep sur tout le codebase = 0 utilisation

**📋 Ce qu'elle a déjà:**

- ✅ `intent_embedding vector(1024)` avec index HNSW - parfait pour semantic search
- ✅ `dag_structure JSONB` - structure du workflow
- ✅ `usage_count`, `success_count` - stats de succès
- ✅ `pattern_hash` - déduplication

**📋 Ce qui manque pour en faire une table Capabilities:**

- ❌ `code_snippet TEXT` - le code exécutable
- ❌ `parameters JSONB` - paramètres extraits
- ❌ `cache_config JSONB` - TTL et invalidation

**🎯 Opportunité:** Réutiliser cette table existante plutôt que créer une nouvelle table
`capabilities`.

---

### Contexte Historique: Pourquoi `workflow_pattern` existe mais n'est pas utilisé

#### Sources documentaires

1. **Design original:** `docs/spikes/graphrag-technical-implementation.md`
   - Définit `workflow_pattern` pour le "semantic search" de workflows
   - Index HNSW sur `intent_embedding` pour retrouver des patterns similaires

2. **Rationale complet:** `docs/legacy/option-d-graphrag-assisted-dag-OBSOLETE.md`
   - Explique la vision initiale du pattern-based learning
   - Décrit la progression Cold → Warm → Hot State

#### L'évolution architecturale

| Phase              | Approche                                                      | Status    |
| ------------------ | ------------------------------------------------------------- | --------- |
| **Design initial** | Pattern-based: stocker des DAGs complets avec embeddings      | Documenté |
| **Réalisation**    | Edge-based plus simple et puissant avec Graphology            | Choisi    |
| **Story 3.5-1**    | Implémente `tool_dependency` (edges) + algos Graphology       | Done      |
| **Résultat**       | `workflow_pattern` créé en migration, jamais connecté au code | Dormant   |

#### Deux approches, deux granularités

```
┌─────────────────────────────────────────────────────────────────┐
│  OPTION A: Pattern-Based (workflow_pattern) - ABANDONNÉ         │
│  ─────────────────────────────────────────────────────────────  │
│  • Stocke: DAG complet + intent embedding                       │
│  • Query: "Trouve un workflow similaire à cet intent"           │
│  • Pros: Réutilisation de workflows entiers                     │
│  • Cons: Lourd, snapshots rigides, moins flexible               │
├─────────────────────────────────────────────────────────────────┤
│  OPTION B: Edge-Based (tool_dependency) - IMPLÉMENTÉ            │
│  ─────────────────────────────────────────────────────────────  │
│  • Stocke: Paires A→B avec confidence + observed_count          │
│  • Query: "Après tool A, quel tool est probable?"               │
│  • Pros: Léger, incrémental, composable, Graphology algos       │
│  • Cons: Pas de réutilisation de code                           │
└─────────────────────────────────────────────────────────────────┘
```

#### Conclusion

**Ce n'est PAS un oubli, c'est un choix délibéré.** L'équipe a opté pour l'approche edge-based car:

1. Plus simple à implémenter et maintenir
2. Fonctionne mieux avec Graphology (PageRank, Louvain, Adamic-Adar)
3. Apprentissage incrémental vs snapshots
4. Composition dynamique vs patterns figés

**Pour les Capabilities:** On peut maintenant "réveiller" `workflow_pattern` pour stocker du code
réutilisable. C'est complémentaire à `tool_dependency`:

- `tool_dependency` = apprendre les séquences (edges)
- `workflow_pattern` = stocker les capabilities (code + cache)

---

#### 2. Table `tool_dependency` (Migration 009, lines 252-268)

```sql
CREATE TABLE tool_dependency (
  from_tool_id TEXT NOT NULL,
  to_tool_id TEXT NOT NULL,
  observed_count INTEGER DEFAULT 1,
  confidence_score REAL DEFAULT 0.5,
  last_observed TIMESTAMP DEFAULT NOW(),
  source TEXT DEFAULT 'learned',  -- 'user', 'learned', 'hint'
  PRIMARY KEY (from_tool_id, to_tool_id)
);
```

**Observation:** Edges avec poids et source. Manque `relationship_type` pour `followed_by` vs
`parallel_with`.

#### 3. Table `workflow_execution` (Migration 010, lines 25-40)

```sql
CREATE TABLE workflow_execution (
  execution_id UUID PRIMARY KEY,
  executed_at TIMESTAMP DEFAULT NOW(),
  intent_text TEXT,
  dag_structure JSONB NOT NULL,
  success BOOLEAN NOT NULL,
  execution_time_ms INTEGER NOT NULL,
  error_message TEXT
);
```

**Observation:** Manque `tool_sequence TEXT[]`, `code_snapshot TEXT`, `execution_source TEXT`.

#### 4. `updateFromExecution()` (graph-engine.ts:325-433)

- ✅ Parse `dag_structure.tasks`
- ✅ Crée/met à jour les edges
- ✅ Recompute PageRank + Louvain
- ✅ Persist to DB
- ✅ Emit events

**Conclusion:** Cette fonction FONCTIONNE. Il suffit de l'appeler depuis `handleExecuteCode()`.

---

### Ce qui MANQUE (à implémenter)

#### Gap 1: Tracking dans `wrapMCPClient()` (context-builder.ts:373-404)

**Code actuel:**

```typescript
wrapped[methodName] = async (args) => {
  // NO TRACKING - juste l'appel direct
  const result = await client.callTool(toolName, args);
  return result;
};
```

**Code à ajouter:**

```typescript
wrapped[methodName] = async (args) => {
  const traceId = crypto.randomUUID();
  const startTs = Date.now();

  // Emit start event
  console.log(`__TRACE__${
    JSON.stringify({
      type: "tool_start",
      tool: `${serverId}:${toolName}`,
      trace_id: traceId,
      ts: startTs,
    })
  }`);

  try {
    const result = await client.callTool(toolName, args);

    // Emit end event
    console.log(`__TRACE__${
      JSON.stringify({
        type: "tool_end",
        tool: `${serverId}:${toolName}`,
        trace_id: traceId,
        success: true,
        duration_ms: Date.now() - startTs,
      })
    }`);

    return result;
  } catch (error) {
    console.log(`__TRACE__${
      JSON.stringify({
        type: "tool_end",
        tool: `${serverId}:${toolName}`,
        trace_id: traceId,
        success: false,
        duration_ms: Date.now() - startTs,
      })
    }`);
    throw error;
  }
};
```

**Complexité:** Moyen (~30 lignes)

---

#### Gap 2: Graph update dans `handleExecuteCode()` (gateway-server.ts, après ligne 1131)

**Code à ajouter:**

```typescript
// Track tool usage for graph learning (ADR-027)
if (result.success && request.intent && toolResults.length > 0) {
  try {
    await this.graphEngine.updateFromExecution({
      execution_id: crypto.randomUUID(),
      executed_at: new Date(),
      intent_text: request.intent,
      dag_structure: {
        tasks: toolResults.map((t, i) => ({
          id: `code_task_${i}`,
          tool: `${t.serverId}:${t.toolName}`,
          arguments: {},
          depends_on: [],
        })),
      },
      success: true,
      execution_time_ms: executionTimeMs,
    });
    log.debug(`Graph updated with ${toolResults.length} tools from execute_code`);
  } catch (err) {
    log.warn(`Failed to update graph from execute_code: ${err}`);
  }
}
```

**Note:** `toolResults` doit être déclaré en dehors du bloc `if (request.intent)` pour être
accessible.

**Complexité:** Simple (~20 lignes)

---

#### Gap 3: Migrations à ajouter

**Migration 011: Extend workflow tables**

```sql
-- Add columns to workflow_execution
ALTER TABLE workflow_execution ADD COLUMN tool_sequence TEXT[];
ALTER TABLE workflow_execution ADD COLUMN code_snapshot TEXT;
ALTER TABLE workflow_execution ADD COLUMN execution_source TEXT DEFAULT 'dag';

-- NOTE: On n'ajoute PAS relationship_type à tool_dependency
-- Raison: On ne sait pas détecter les vraies dépendances (Learning 3)
-- On garde juste l'ordre d'appel, l'inférence statistique fait le reste

-- Repurpose workflow_pattern as capabilities table (already exists, unused!)
-- See: Migration 010, Story 3.5-1 uses tool_dependency instead
ALTER TABLE workflow_pattern ADD COLUMN code_snippet TEXT;
ALTER TABLE workflow_pattern ADD COLUMN parameters JSONB;
ALTER TABLE workflow_pattern ADD COLUMN cache_config JSONB;
ALTER TABLE workflow_pattern ADD COLUMN name TEXT;  -- human-readable capability name

-- Optional: rename table for clarity
-- ALTER TABLE workflow_pattern RENAME TO capability;
```

**Note:** `workflow_pattern` existe déjà avec `intent_embedding` indexé en HNSW. Au lieu de créer
une nouvelle table `capabilities`, on étend celle-ci.

**Complexité:** Simple

---

#### Gap 4: Check capability dans DAG Suggester (dag-suggester.ts, après ligne 92)

**Code à ajouter:**

```typescript
// Check for existing capability match
const capabilityMatch = await this.findMatchingCapability(intent);
if (capabilityMatch && capabilityMatch.confidence > 0.85) {
  return {
    source: "capability",
    capability_id: capabilityMatch.pattern_id,
    code: capabilityMatch.code_snippet,
    tools: capabilityMatch.dag_structure.tasks,
    confidence: capabilityMatch.confidence,
  };
}
// Else: continue with normal DAG building...
```

**Complexité:** Moyen (nouvelle fonction + queries)

---

### Roadmap d'implémentation

#### ⚠️ Learning critique: Gap 1 est un prérequis!

**Problème identifié lors de la review:**

```
execute_code(intent, code)
    │
    ├─► searchTools(intent) → Découvre 4 tools
    ├─► buildContext(tools) → Injecte les 4 tools
    ├─► sandbox.execute(code) → Code s'exécute...
    │                           MAIS quels tools ont été VRAIMENT appelés?
    │                           On ne sait pas! 🤷
    └─► return result
```

**Sans Gap 1 (tracking), Gap 2 ne peut pas fonctionner:**

- On injecte N tools dans le sandbox
- Le code en utilise peut-être seulement 2
- Sans traces, on ne sait pas lesquels
- `updateFromExecution()` recevrait des données FAUSSES (tools injectés ≠ tools utilisés)

**Conclusion:** L'ordre initial était FAUX. Gap 1 doit venir EN PREMIER.

---

#### Ordre corrigé

| Phase | Gap   | Description                                      | Dépendance | Complexité |
| ----- | ----- | ------------------------------------------------ | ---------- | ---------- |
| **1** | Gap 1 | Tracking `__TRACE__` dans `wrapMCPClient()`      | Aucune     | ~30 lignes |
| **2** | -     | Parser les traces côté Gateway                   | Phase 1    | ~20 lignes |
| **3** | Gap 2 | Appeler `updateFromExecution()` avec VRAIS tools | Phase 1+2  | ~20 lignes |
| **4** | Gap 3 | Migrations (tool_sequence, code_snapshot)        | -          | Simple     |
| **5** | Gap 4 | Capability check dans DAG Suggester              | Phase 3+4  | Moyen      |
| **6** | -     | Cache layer avec TTL                             | Phase 5    | Moyen      |

**Note:** On a retiré `relationship_type` des migrations - on ne sait pas détecter les vraies
dépendances (voir Learning 3).

**Quick Win révisé:** Phase 1-3 ensemble = ~70 lignes, débloque le learning RÉEL.

#### Flux complet après implémentation

```
execute_code(intent, code)
    │
    ├─► searchTools(intent) → Découvre 4 tools
    ├─► buildContext(tools) → Injecte avec wrappers tracés
    │
    ├─► sandbox.execute(code)
    │   │
    │   ├─► github.listCommits()
    │   │   └─► __TRACE__{"type":"tool_start","tool":"github:list_commits","ts":1000}
    │   │   └─► __TRACE__{"type":"tool_end","tool":"github:list_commits","ts":1050}
    │   │
    │   └─► memory.store()
    │       └─► __TRACE__{"type":"tool_start","tool":"memory:store","ts":1060}
    │       └─► __TRACE__{"type":"tool_end","tool":"memory:store","ts":1080}
    │
    ├─► Gateway parse stdout → toolsUsed = ["github:list_commits", "memory:store"]
    │
    └─► graphEngine.updateFromExecution({
          intent_text: intent,
          dag_structure: { tasks: toolsUsed },  // VRAIS tools!
          success: true
        })
```

---

## Discussion Log

### 2025-12-03 - Party Mode Session #1

**Participants:** Winston (Architect), John (PM), Dr. Quinn (Problem Solver), Victor (Strategist),
Carson (Brainstorm), Sally (UX), Murat (Test), Amelia (Dev), Bob (SM), Mary (Analyst), BMad Master

**Décisions clés:**

1. Architecture deux niveaux: GraphRAG (raw) + Capabilities (cristallisé)
2. Capability = noeud avec code prêt à l'emploi
3. Cache des résultats avec TTL et invalidation triggers
4. Event tracking MCP = fondation de tout le learning
5. Clustering + table explicite = IN SCOPE de l'epic

**Insights:**

- "Casys PML apprend et se souvient" = value prop différenciante
- Trois niveaux de gain: code reuse, execution reuse, partial cache
- Le tracking des appels MCP est la Story 0 de l'Epic

---

### 2025-12-03 - Party Mode Session #2 (Pattern Learning & IPC)

#### Pattern Learning - Pistes à étudier

**Définition d'un pattern récurrent (3 dimensions):**

```
DIMENSION 1: Séquence de tools
github:list_commits → memory:store (identique N fois)

DIMENSION 2: Intent similaire
"analyze commits" ≈ "get commit history" (embedding cluster > 0.8)

DIMENSION 3: Code similaire
Même structure/logique (fingerprint)
```

**Proposition de critères de détection:**

- Intent cluster (embedding similarity > 0.8)
- Même tool sequence
- Minimum 3 occurrences
- Success rate > 80%

**Score de confiance proposé:**

```typescript
interface PatternConfidence {
  total_executions: number;
  successful: number;
  failed: number;
  success_rate: number; // successful / total
  recency_score: number; // decay basé sur last_used
  confidence: number; // success_rate * recency_score
}

const PROMOTION_THRESHOLD = {
  min_executions: 3,
  min_success_rate: 0.8,
  min_confidence: 0.7,
};
```

**Promotion auto vs manuel:**

- Mode Auto (background): détection silencieuse, promotion si confidence > threshold
- Mode Explicit: Claude suggère ou user demande explicitement
- Défaut: Auto, explicit pour power users

**Question ouverte:** Patterns sous-optimaux - comment détecter/suggérer des alternatives?

---

#### IPC - Pistes à étudier

**Mécanisme proposé: stdout JSON lines avec préfixe**

```typescript
// Dans le sandbox
function trace(event: ExecutionEvent) {
  console.log(`__TRACE__${JSON.stringify(event)}`);
}

// Dans le parent (Gateway)
subprocess.stdout.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (line.startsWith("__TRACE__")) {
      const event = JSON.parse(line.slice(9));
      handleTraceEvent(event);
    }
  }
});
```

**Avantages:**

- Simple, Deno-native
- Pas de dépendance externe
- Préfixe évite collisions avec console.log user

**Détection du parallélisme via timestamps:**

```typescript
// Events avec trace_id + timestamp
{ type: "tool_start", tool: "github:list_commits", trace_id: "a1", ts: 1000 }
{ type: "tool_start", tool: "github:list_issues", trace_id: "b2", ts: 1001 }
{ type: "tool_end", tool: "github:list_issues", trace_id: "b2", ts: 1050 }
{ type: "tool_end", tool: "github:list_commits", trace_id: "a1", ts: 1200 }

// Reconstruction post-hoc:
// - timestamps proches (< 10ms) → parallèle
// - tool_start après tool_end précédent → séquentiel
```

**Nouveau type de relation GraphRAG proposé:**

```typescript
// Séquentiel
{ source: "A", target: "B", relationship: "followed_by", weight: 0.8 }

// Parallèle
{ source: "A", target: "B", relationship: "parallel_with", weight: 0.6 }
```

**Question ouverte:** Le parallélisme est-il important pour les capabilities ou juste détail
d'implémentation?

---

### Récap - Pistes à étudier

| Catégorie            | Piste                                                    | Status                                   |
| -------------------- | -------------------------------------------------------- | ---------------------------------------- |
| **Pattern Learning** | Intent cluster + tool sequence + 3 succès                | À valider                                |
| **Pattern Learning** | Score de confiance avec success_rate                     | À valider                                |
| **Pattern Learning** | Promotion auto par défaut                                | À valider                                |
| **IPC**              | stdout `__TRACE__` prefix pour tracker les tools appelés | À prototyper                             |
| ~~**IPC**~~          | ~~Parallélisme déduit des timestamps~~                   | ❌ Abandonné                             |
| ~~**GraphRAG**~~     | ~~Relations `followed_by` vs `parallel_with`~~           | ❌ Abandonné                             |
| **Parallélisme**     | Émerge du learning (absence de dépendance = parallèle)   | ✅ Déjà implémenté!                      |
| **Dépendances**      | Inférence statistique via `tool_dependency`              | ✅ Déjà implémenté!                      |
| **Dépendances**      | Détection explicite des deps de données                  | ⚠️ Pas nécessaire pour MVP               |
| **Cache**            | LRU + TTL pour code execution                            | ✅ Déjà implémenté! (`sandbox/cache.ts`) |
| **Cache**            | Cache par intent/capability ID                           | ⚠️ Extension future                      |
| **Cache**            | Invalidation triggers automatiques                       | À étudier (post-MVP)                     |

---

## Learnings & Corrections (2025-12-03)

### Learning 1: Gap 1 est un prérequis pour Gap 2

**Erreur initiale:** La roadmap proposait de commencer par Gap 2 (appeler `updateFromExecution()`)
comme "quick win".

**Problème découvert:** Sans tracking (Gap 1), on ne sait pas quels tools ont été VRAIMENT appelés
dans le sandbox:

- On injecte N tools découverts par intent search
- Le code utilisateur n'en appelle peut-être que 2
- `updateFromExecution()` avec les tools injectés = données FAUSSES

**Correction:** Gap 1 (tracking `__TRACE__`) doit venir EN PREMIER.

---

### Learning 2: `workflow_pattern` vs `tool_dependency` - choix délibéré

**Découverte:** La table `workflow_pattern` existe mais n'est jamais utilisée. Ce n'est PAS un
oubli.

**Historique trouvé:**

- `docs/spikes/graphrag-technical-implementation.md` - design original
- `docs/legacy/option-d-graphrag-assisted-dag-OBSOLETE.md` - rationale complet

**Évolution:**

1. Design initial: pattern-based (stocker DAGs complets)
2. Réalisation: edge-based plus simple et puissant
3. Story 3.5-1: implémente `tool_dependency` + Graphology
4. Résultat: `workflow_pattern` dormant, prêt à être réutilisé pour capabilities

**Les deux sont complémentaires:**

- `tool_dependency` = edges pour speculation (local: A→B)
- `workflow_pattern` = patterns pour capabilities (global: intent→[A,B,C]+code)

---

### Learning 3: Le parallélisme ÉMERGE du learning, pas de la détection

**Idée initiale (abandonnée):** Déduire le parallélisme via timestamps.

**Pourquoi c'était une mauvaise piste:**

- On cherchait à DÉTECTER le parallélisme dans `execute_code`
- Mais le parallélisme n'est pas une propriété à détecter
- C'est une OPTIMISATION qui émerge de l'ABSENCE de dépendances

---

#### Comment ça marche VRAIMENT (vérifié dans le code)

**1. `buildDAG()` cherche les dépendances (graph-engine.ts:256-316):**

```typescript
const path = this.findShortestPath(fromTool, toTool);

// Si path ≤3 hops → DÉPENDANCE
if (path && path.length > 0 && path.length <= 4) {
  adjacency[i][j] = true;
}
// Sinon → PAS de dépendance → depends_on reste vide
```

**2. `depends_on: []` = parallèle (executor.ts:173-217):**

```typescript
// Tasks avec depends_on vide → même layer → Promise.allSettled
const layerResults = await Promise.allSettled(
  layer.map((task) => this.executeTask(task, results)),
);
```

**3. Le graphe apprend des exécutions (graph-engine.ts:340-360):**

```typescript
// Chaque exécution renforce les edges observés
const newConfidence = Math.min(oldConfidence * 1.1, 1.0);
this.graph.setEdgeAttribute(fromTool, toTool, "weight", newConfidence);
```

---

#### Résumé: Pas besoin de détecter le parallélisme!

| Ce qu'on observe       | Ce que le graphe apprend   | Résultat                          |
| ---------------------- | -------------------------- | --------------------------------- |
| A toujours avant B     | Edge A→B, confidence élevé | **Dépendance → Séquentiel**       |
| A et B, ordre variable | Pas d'edge fort            | **Pas de dépendance → Parallèle** |
| A et B jamais ensemble | Pas d'edge                 | **Indépendants → Parallèle**      |

**Le parallélisme émerge naturellement:**

1. On track les tools appelés (séquence)
2. `updateFromExecution()` crée/renforce les edges
3. `buildDAG()` cherche les paths dans le graphe
4. Pas de path = pas de dépendance = `depends_on: []` = parallèle

---

#### Ce qui reste comme question ouverte

**Les vraies dépendances de DONNÉES** (A produit X, B consomme X) ne sont pas détectées
explicitement. On les INFÈRE statistiquement:

- Si A précède toujours B avec succès → probable dépendance
- Si ordre variable et succès → probablement indépendants

**Pour le MVP:** L'inférence statistique suffit. Les faux positifs (séquentiel inutile) ne cassent
rien, juste moins optimal.

---

### Learning 4: Le cache d'exécution existe déjà!

**Découverte:** `CodeExecutionCache` dans `src/sandbox/cache.ts` est déjà implémenté ET utilisé.

#### Ce qui existe (`DenoSandboxExecutor`)

```typescript
// AVANT exécution (executor.ts:213)
const cached = this.cache.get(cacheKey);
if (cached) return cached.result; // Cache hit!

// APRÈS exécution (executor.ts:268)
this.cache.set(cacheKey, {
  code,
  context,
  result,
  toolVersions,
  expiresAt: now + ttlMs,
});
```

**Features déjà implémentées:**

- ✅ LRU cache (max 100 entries)
- ✅ TTL (5 minutes par défaut)
- ✅ Cache key: `hash(code + context + tool_versions)`
- ✅ Invalidation quand tool schema change
- ✅ Stats: hit rate, latency saved

#### Ce qui manque pour les capabilities

| Feature                 | Status | Notes                                   |
| ----------------------- | ------ | --------------------------------------- |
| Cache par intent        | ❌     | Actuellement par code exact             |
| Cache par capability ID | ❌     | Nouveau concept à ajouter               |
| Invalidation triggers   | ❌     | "tool X change → invalide capability Y" |

**Pour le MVP:** Le cache actuel suffit. Même code + même context = cache hit.

L'extension vers "cache par intent" peut venir après, quand les capabilities seront implémentées.

---

_Spike de recherche - décisions finales lors de la création de l'Epic_
