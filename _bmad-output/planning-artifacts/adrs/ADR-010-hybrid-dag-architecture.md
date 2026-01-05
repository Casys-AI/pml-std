# ADR-010: Architecture DAG Hybride - Nœuds Externes vs Nœuds de Logique

**Status:** ✅ Implemented **Date:** 2025-11-20 | **Deciders:** BMad | **Epic:** 3 (Sandbox)

---

## Context

Casys PML utilise un système de DAG (Directed Acyclic Graph) pour orchestrer des workflows
complexes. Avec l'introduction de l'Epic 3 (code execution dans sandbox), nous avons maintenant
**deux types fondamentalement différents de nœuds** dans nos DAGs qui coexistent et communiquent.

### État Actuel (Post-Epic 2, Pre-Epic 3)

Avant Epic 3, tous les nœuds du DAG étaient des **MCP tasks** :

```typescript
const workflow: DAGStructure = {
  tasks: [
    { id: "fetch", tool: "github:list_commits", ... },
    { id: "filter", tool: "github:filter_commits", ... },
    { id: "create_issue", tool: "github:create_issue", ... }
  ]
};
```

**Limitations :**

- Toute logique de traitement nécessite un MCP tool dédié
- Pas de flexibilité pour transformations ad-hoc
- Logique métier dispersée dans multiples servers MCP
- Pas de distinction entre side effects et pure logic

### Nouveau Besoin (Epic 3)

Epic 3 introduit le **code execution dans sandbox** permettant aux agents d'écrire du code de
traitement qui s'exécute localement. Cela crée naturellement deux catégories de nœuds :

1. **Nœuds qui interagissent avec l'externe** (API calls, DB writes, file creation)
2. **Nœuds qui font de la logique pure** (transformations, calculs, filtrage, agrégation)

**Question clé :** Comment organiser et différencier ces deux types de nœuds dans un DAG unifié ?

---

## Decision

Nous adoptons une **architecture DAG hybride** avec deux types de nœuds distincts mais
interopérables :

### 🔵 Nœuds Externes (MCP Tasks)

**Définition :** Nœuds qui interagissent avec le monde extérieur via MCP protocol.

**Caractéristiques :**

- `tool: "server:tool_name"` (identifié par présence de tool field)
- `side_effects: true` (par défaut, explicite si besoin)
- **NOT safe-to-fail** : L'échec peut avoir des conséquences externes
- Arguments via schema MCP fixe
- Communication : `$OUTPUT[task_id]` pour interpolation string

**Exemples :**

- GitHub API calls (`github:list_commits`, `github:create_issue`)
- Database operations (`postgres:query`, `postgres:insert`)
- File system (`filesystem:write_file`, `filesystem:delete`)
- Web scraping (`puppeteer:navigate`, `puppeteer:screenshot`)

**Utilisation typique :**

```typescript
{
  id: "fetch_data",
  tool: "github:list_commits",
  arguments: {
    repo: "pml",
    limit: 1000
  },
  side_effects: true  // Explicit: external API call
}
```

### 🟢 Nœuds de Logique (Code Execution Tasks)

**Définition :** Nœuds qui exécutent du code arbitraire dans un sandbox isolé.

**Caractéristiques :**

- `type: "code_execution"` (identifié par type field)
- `side_effects: false` (par défaut pour sandbox)
- **Safe-to-fail** : Échec n'a pas de conséquences externes (idempotent)
- Code TypeScript arbitraire
- Communication : `deps.task_id` pour accès object dans scope

**Exemples :**

- Data transformations (filter, map, reduce)
- Statistical analysis, ML inference
- Validation, parsing, formatting
- Aggregation de résultats multiples (resilient patterns)

**Utilisation typique :**

```typescript
{
  id: "analyze_data",
  type: "code_execution",
  code: `
    const commits = deps.fetch_data.output;
    return {
      total: commits.length,
      by_author: groupBy(commits, 'author'),
      trends: detectTrends(commits)
    };
  `,
  depends_on: ["fetch_data"],
  side_effects: false  // Pure logic, no external effects
}
```

### 🔗 Communication Inter-Nœuds

**Deux mécanismes complémentaires :**

#### 1. `$OUTPUT[task_id]` - Pour MCP tasks (arguments)

Résolution par string interpolation **avant** l'exécution du tool :

```typescript
{
  id: "create_issue",
  tool: "github:create_issue",
  arguments: {
    title: "Analysis Results",
    body: "$OUTPUT[analyze_data]"  // Résolu → valeur injectée
  },
  depends_on: ["analyze_data"]
}
```

**Implémentation :** `ParallelExecutor.resolveArguments()` (ligne ~340 de `src/dag/executor.ts`)

#### 2. `deps.task_id` - Pour code_execution (context)

Injection d'objects JavaScript dans le scope d'exécution :

```typescript
{
  id: "aggregate",
  type: "code_execution",
  code: `
    // deps injecté comme variable dans le scope
    if (deps.fast?.status === "success") {
      return deps.fast.output;
    }
  `,
  depends_on: ["fast", "ml", "stats"]
}
```

**Implémentation :** `ControlledExecutor.executeCodeTask()` (ligne ~1080 de
`src/dag/controlled-executor.ts`)

**Important (Story 3.5) :** `deps` contient le **TaskResult complet** :

```typescript
deps[taskId] = {
  status: "success" | "error" | "failed_safe",
  output: any,
  error?: string
}
```

Cela permet les **resilient patterns** (aggregation partielle, graceful degradation).

---

## Architecture Visuelle

### DAG Hybride Typique (ETL Pattern)

```
┌─────────────────┐
│   fetch_data    │  🔵 MCP Task (GitHub API)
│   (external)    │     - tool: github:list_commits
│                 │     - side_effects: true
└────────┬────────┘
         │ $OUTPUT / deps
         │
         ├──────────┬──────────┬──────────┐
         │          │          │          │
         ▼          ▼          ▼          ▼
    ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
    │  fast  │ │   ml   │ │ stats  │ │ filter │  🟢 Code Execution
    │(logic) │ │(logic) │ │(logic) │ │(logic) │     - type: code_execution
    └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘     - side_effects: false
        └──────────┴──────────┴──────────┘
                       │ deps
                       ▼
                ┌──────────────┐
                │  aggregate   │  🟢 Code Execution (Aggregation)
                │   (logic)    │     - Resilient: collecte successes only
                └──────┬───────┘     - deps.task?.status checks
                       │ $OUTPUT
                       ▼
                ┌──────────────┐
                │create_issue  │  🔵 MCP Task (GitHub API)
                │ (external)   │     - tool: github:create_issue
                └──────────────┘     - side_effects: true
```

### Modèle Conceptuel : ETL Moderne

- **Extract** (🔵) : Nœuds externes fetch data depuis sources externes
- **Transform** (🟢) : Nœuds logique traitent, analysent, agrègent
- **Load** (🔵) : Nœuds externes écrivent résultats vers destinations

---

## Rationale

### Pourquoi Deux Types de Nœuds ?

#### 1. Séparation des Responsabilités (SRP)

**🔵 MCP Tasks :**

- Responsabilité : Gérer interactions avec systèmes externes
- Complexité : Protocole MCP, rate limiting, error handling externe
- Expertise : Connaissance des APIs spécifiques

**🟢 Code Execution :**

- Responsabilité : Logique métier, transformations de données
- Complexité : Algorithmes, business rules, calculs
- Expertise : Domain knowledge, data science

#### 2. Safe-to-Fail vs Side Effects (Story 3.5)

**🔵 MCP Tasks (NOT safe-to-fail) :**

- Side effects externes (créer GitHub issue, écrire DB, envoyer email)
- Échec peut avoir des conséquences irréversibles
- Nécessite rollback complexe ou compensation

**🟢 Code Execution (Safe-to-fail) :**

- Sandbox isolé sans accès filesystem/network
- Idempotent : re-exécution produit même résultat
- Échec n'affecte pas l'état système
- Permet **speculation agressive** (Epic 3.5)

#### 3. Flexibilité vs Standardisation

**🔵 MCP Tasks :**

- Schema fixe imposé par le server
- Versioning et compatibilité gérés par MCP
- Réutilisabilité entre agents/workflows

**🟢 Code Execution :**

- Code arbitraire généré par l'agent
- Adaptation dynamique aux besoins spécifiques
- Logique métier inline (pas besoin de créer MCP tool)

#### 4. Performance et Context Usage

**Problème :** Appeler MCP tool qui retourne 1000 commits (1.2MB) sature le contexte LLM.

**Solution hybride :**

```typescript
// 🔵 Fetch externe (unavoidable)
{ id: "fetch", tool: "github:list_commits", limit: 1000 }

// 🟢 Aggregation locale (sauve 99.96% contexte)
{
  id: "analyze",
  type: "code_execution",
  code: `
    const commits = deps.fetch.output; // 1.2MB
    return {
      total: commits.length,
      top_authors: getTopAuthors(commits, 5)
    }; // 500 bytes retournés au LLM
  `
}
```

**Résultat :** LLM voit résumé compact, pas raw data.

---

## Consequences

### Avantages

#### ✅ Architecture claire et extensible

- Deux patterns bien définis pour deux responsabilités distinctes
- Facile d'ajouter nouveaux nœuds (MCP tool ou code)
- Composition flexible dans DAGs

#### ✅ Safe-to-fail patterns (Epic 3.5)

- Nœuds logique peuvent échouer sans corrupting workflow
- Aggregation partielle (prendre successes, ignorer failures)
- Graceful degradation (ML timeout → fallback stats)
- A/B testing (run 2 algorithms, compare results)

#### ✅ Context efficiency

- MCP fetch brut → Code process localement → Résumé compact au LLM
- Économie 95-99% de contexte sur workflows data-heavy
- LLM contrôle "quoi analyser", processing délégué

#### ✅ Developer experience

- Deux patterns simples à comprendre
- Type safety maintenu (TypeScript pour code, JSON schema pour MCP)
- Debugging clair (échec externe vs échec logique)

### Inconvénients et Mitigations

#### ⚠️ Complexité cognitive (deux patterns)

**Risque :** Confusion sur quel type de nœud utiliser.

**Mitigation :**

- Documentation claire (ce ADR)
- Exemples dans stories (Story 3.5)
- Linting rules possibles (detect side effects in code_execution)

#### ⚠️ Breaking change (Story 3.5)

**Impact :** `deps` structure change (output → full TaskResult).

**Migration :**

```typescript
// Avant (Story 3.4)
const data = deps.fetch;

// Après (Story 3.5)
const data = deps.fetch.output;
```

**Mitigation :**

- Tests existants identifiés (3 locations)
- Migration path documented in Story 3.5
- Could add Proxy getter for backward compat (defer decision)

#### ⚠️ Security boundary

**Risque :** Code execution tasks pourraient tenter d'accéder externe.

**Mitigation :**

- Deno sandbox avec permissions explicites (--allow-read=[], --allow-net=[])
- Filesystem virtuel (hooks dans Story 3.4)
- Runtime validation (detect network calls → error)

---

## Implementation Notes

### Type Definitions

```typescript
// src/graphrag/types.ts
export interface Task {
  id: string;
  depends_on: string[];
  side_effects?: boolean; // Default: true for MCP, false for code_execution

  // MCP Task fields (mutually exclusive with code_execution)
  tool?: string;
  arguments?: Record<string, unknown>;

  // Code Execution fields (mutually exclusive with MCP)
  type?: "code_execution";
  code?: string;
  context?: Record<string, unknown>;
  intent?: string; // Intent-based mode (vector search tools)
  sandbox_config?: {
    timeout?: number;
    memoryLimit?: number;
    allowedReadPaths?: string[];
  };
}

export interface TaskResult {
  status: "success" | "error" | "failed_safe";
  output: unknown;
  error?: string;
}
```

### Detection Logic (Story 3.5)

```typescript
// src/dag/controlled-executor.ts
function isSafeToFail(task: Task): boolean {
  return !task.side_effects && task.type === "code_execution";
}

function isMCPTask(task: Task): boolean {
  return task.tool !== undefined;
}

function isCodeExecutionTask(task: Task): boolean {
  return task.type === "code_execution";
}
```

### Communication Patterns

#### Pattern 1: MCP → Code Execution

```typescript
[
  {
    id: "fetch",
    tool: "github:list_commits",
  },
  {
    id: "analyze",
    type: "code_execution",
    code: "return processCommits(deps.fetch.output);",
    depends_on: ["fetch"],
  },
];
```

#### Pattern 2: Code Execution → MCP

```typescript
[
  {
    id: "analyze",
    type: "code_execution",
    code: "return { insights: [...] };",
  },
  {
    id: "create_issue",
    tool: "github:create_issue",
    arguments: {
      title: "Analysis Results",
      body: "$OUTPUT[analyze]", // String interpolation
    },
    depends_on: ["analyze"],
  },
];
```

#### Pattern 3: Code Execution → Code Execution (Resilient)

```typescript
[
  { id: "fast", type: "code_execution", code: "...", side_effects: false },
  { id: "ml", type: "code_execution", code: "...", side_effects: false },
  { id: "stats", type: "code_execution", code: "...", side_effects: false },
  {
    id: "aggregate",
    type: "code_execution",
    code: `
      const results = [];
      if (deps.fast?.status === "success") results.push(deps.fast.output);
      if (deps.ml?.status === "success") results.push(deps.ml.output);
      if (deps.stats?.status === "success") results.push(deps.stats.output);
      return results.length > 0 ? results[0] : null;
    `,
    depends_on: ["fast", "ml", "stats"],
    side_effects: false,
  },
];
```

---

## Related Decisions

- **ADR-007:** DAG Adaptive Feedback Loops - Définit la base du DAG executor
- **Story 3.4:** `pml:execute_code` MCP Tool - Implémente code execution
- **Story 3.5:** Safe-to-Fail Branches - Exploite cette architecture pour resilience
- **Epic 3 Tech Spec:** Agent Code Execution & Local Processing - Vision globale

---

## References

- [Epic 3 Technical Specification](../tech-spec-epic-3.md)
- [Story 3.4: pml:execute_code](../stories/story-3.4.md)
- [Story 3.5: Safe-to-Fail Branches](../stories/story-3.5.md)
- [ControlledExecutor Implementation](../../src/dag/controlled-executor.ts)
- [ParallelExecutor Implementation](../../src/dag/executor.ts)

---

## Change Log

- **2025-11-20:** Initial version - Architecture hybride documentée post-Story 3.4
