## Epic 10: DAG Capability Learning & Unified APIs

> **Tech-Spec:**
> [tech-spec-dag-capability-learning.md](./tech-specs/tech-spec-dag-capability-learning.md)
> **Status:** In Progress (Stories 10.1-10.5 DONE) **Author:** Erwan + Claude **Depends on:** Epic 7
> (Emergent Capabilities), HIL Phase 2 (Permission Escalation) **Last Updated:** 2025-12-20
> (Post-implementation review)

**Expanded Goal (2-3 sentences):**

Unifier les deux modèles d'exécution (DAG explicite et Code libre) en un système d'apprentissage
cohérent où **tout passe par les mêmes mécanismes**. Implémenter la reconstruction de DAG depuis les
traces de code, permettant au système d'apprendre des workflows qu'il soit exprimé en DAG ou en code
TypeScript. Simplifier les APIs en deux points d'entrée : `pml_discover` (exploration intelligente)
et `pml_execute` (exécution unifiée).

**Problèmes Résolus:**

| Problème                                   | Solution                                              |
| ------------------------------------------ | ----------------------------------------------------- |
| Parallel tracking - pas d'edges créés      | Détection via timestamps `ts` + `durationMs`          |
| DAG → Capability - pas de génération       | Capability unifiée `source: code \| dag`              |
| Edge types confus (sequence vs dependency) | Clarification: Definition view vs Invocation view     |
| Manque de `provides` edge                  | Nouveau type pour data flow (strict/partial/optional) |
| APIs fragmentées (5 tools)                 | Unification: `pml_discover` + `pml_execute`           |

**Value Delivery:**

- ✅ **Apprentissage unifié** - Code ET DAG créent des capabilities
- ✅ **Reconstruction DAG** - Le code peut être "rejoué" comme DAG
- ✅ **APIs simplifiées** - 2 tools au lieu de 5 pour l'IA
- ✅ **Preview intelligent** - `resultPreview` + `pml_get_task_result` pour AIL
- ✅ **Provides edges** - Chaînage data explicite entre tools

---

### Unified Learning Model (Philosophy) — REVISED

> **Principe fondamental révisé:** La **Capability** est créée à l'**analyse statique** (structure
> complète). Les **Traces** sont des instances d'exécution stockées séparément. L'apprentissage
> agrège les traces.

**Distinction clé : Capability vs Trace**

| Concept        | Quand créé                  | Ce qu'il contient                           | Stockage                                          |
| -------------- | --------------------------- | ------------------------------------------- | ------------------------------------------------- |
| **Capability** | Analyse statique (PRE-exec) | Structure complète avec branches/conditions | `workflow_pattern.dag_structure.static_structure` |
| **Trace**      | Après exécution (POST-exec) | Chemin emprunté + résultats concrets        | `execution_trace` (nouvelle table)                |
| **Learning**   | Agrégation des traces       | Stats par chemin, dominant path             | `workflow_pattern.dag_structure.learning`         |

**Pourquoi ce changement ?**

1. **Les conditions sont visibles** dans la capability, pas perdues dans les traces
2. **Mémoire épisodique** (traces) vs **mémoire sémantique** (capability) bien séparées
3. **L'analyse statique EST suffisante** grâce aux schémas MCP et à l'inférence `provides`
4. **On peut afficher** les branches divergentes dans l'UI

**Le flow d'apprentissage révisé:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. CODE SOUMIS                                                          │
│     TypeScript avec appels mcp.* et capabilities.*                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  2. ANALYSE STATIQUE (Story 10.1) → CRÉE LA CAPABILITY                   │
│     - Parse AST avec SWC (réutilise SchemaInferrer/PermissionInferrer)  │
│     - Détecte: tools, capabilities imbriquées, if/else, loops           │
│     - Génère static_structure { nodes, edges }                          │
│     - Calcule provides edges via schémas input/output                   │
│     - Crée CapabilityDependency si appel à d'autres capabilities        │
│     → INSERT workflow_pattern avec dag_structure.static_structure       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  3. VALIDATION HIL (si nécessaire)                                       │
│     - Basée sur static_structure (on sait quels tools seront appelés)  │
│     - Approbation AVANT exécution, pas après échec                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  4. EXÉCUTION (Sandbox)                                                  │
│     - Capture traces via parentTraceId (ADR-041)                        │
│     - Enregistre décisions aux DecisionNodes (branches prises)          │
│     - Résultats par tâche avec timestamps                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  5. STOCKAGE TRACE (Epic 11 - Learning from Traces)                      │
│     → INSERT INTO execution_trace                                       │
│     - executed_path: ["n1", "d1", "n2"] (nodeIds de static_structure)   │
│     - decisions: [{ nodeId: "d1", outcome: "true" }]                    │
│     - task_results: résultats détaillés par tâche                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  6. MISE À JOUR LEARNING (Epic 11 - Agrégation)                          │
│     → UPDATE workflow_pattern.dag_structure.learning                    │
│     - Incrémente path.count pour le chemin emprunté                     │
│     - Recalcule dominantPath                                            │
│     - Update success_rate, usage_count (existant)                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  7. NEXT TIME: REPLAY avec contexte enrichi                              │
│     - Capability matchée par intent                                     │
│     - On connaît le dominantPath ET les variantes                       │
│     - L'IA peut choisir d'exécuter ou de modifier                       │
└─────────────────────────────────────────────────────────────────────────┘
```

**Exemple concret avec conditions:**

```typescript
// Code source
const file = await mcp.fs.stat({ path });
if (file.exists) {
  const content = await mcp.fs.read({ path });
  return content;
} else {
  await mcp.fs.create({ path });
  await mcp.fs.write({ path, content: "" });
}
```

**Structure statique générée (dans la Capability):**

```typescript
static_structure: {
  nodes: [
    { id: "n1", type: "task", tool: "fs:stat" },
    { id: "d1", type: "decision", condition: "file.exists" },
    { id: "n2", type: "task", tool: "fs:read" },
    { id: "n3", type: "task", tool: "fs:create" },
    { id: "n4", type: "task", tool: "fs:write" },
  ],
  edges: [
    { from: "n1", to: "d1", type: "sequence" },
    { from: "d1", to: "n2", type: "conditional", outcome: "true" },
    { from: "d1", to: "n3", type: "conditional", outcome: "false" },
    { from: "n3", to: "n4", type: "sequence" },
    { from: "n1", to: "n2", type: "provides" }  // Data flow inféré
  ]
}
```

**Traces stockées séparément (après 3 exécutions):**

```sql
-- Trace 1: file.exists = true
INSERT INTO execution_trace (capability_id, executed_path, decisions, success)
VALUES ('cap-xxx', ARRAY['n1', 'd1', 'n2'],
        '[{"nodeId": "d1", "outcome": "true"}]', true);

-- Trace 2: file.exists = false
INSERT INTO execution_trace (capability_id, executed_path, decisions, success)
VALUES ('cap-xxx', ARRAY['n1', 'd1', 'n3', 'n4'],
        '[{"nodeId": "d1", "outcome": "false"}]', true);

-- Trace 3: file.exists = true
INSERT INTO execution_trace (capability_id, executed_path, decisions, success)
VALUES ('cap-xxx', ARRAY['n1', 'd1', 'n2'],
        '[{"nodeId": "d1", "outcome": "true"}]', true);
```

**Learning agrégé (dans la Capability):**

```typescript
learning: {
  paths: [
    { path: ["n1", "d1", "n2"], count: 2, successRate: 1.0 },
    { path: ["n1", "d1", "n3", "n4"], count: 1, successRate: 1.0 }
  ],
  dominantPath: ["n1", "d1", "n2"],  // 66% des exécutions
  decisionStats: [{
    nodeId: "d1",
    condition: "file.exists",
    outcomes: { "true": { count: 2 }, "false": { count: 1 } }
  }]
}
```

**Capabilities = Tools abstraits:**

Une Capability n'est pas forcément un DAG interne. Elle peut être:

| Type             | Exemple                                     | Exécution                    |
| ---------------- | ------------------------------------------- | ---------------------------- |
| **DAG interne**  | `fs:read → json:parse → github:createIssue` | PML exécute les tasks        |
| **Code snippet** | TypeScript avec logique complexe            | Sandbox PML                  |
| **Tool externe** | Temporal workflow, Airflow DAG              | Délégation à l'orchestrateur |

**Implications pour l'implémentation:**

1. **Story 10.1** devient la **vraie fondation** - crée la Capability avec static_structure
2. **Epic 11** stocke les **Traces** dans `execution_trace`, pas la structure
3. **Capability.source** reste mais s'enrichit de `static_structure` et `learning`
4. **Les CapabilityDependency** (capability → capability) sont créées à l'analyse statique

---

**Architecture Unifiée (révisée):**

```
┌─────────────────────────────────────────────────────────────────┐
│  pml_execute({ intent: "..." })                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────┐     ┌─────────────────────┐            │
│  │ Implementation      │     │ Recherche GraphRAG   │            │
│  │ fournie par l'IA?   │ NO  │ - Tools matching     │            │
│  │                     │────▶│ - Capabilities       │            │
│  └─────────┬───────────┘     └──────────┬──────────┘            │
│            │ YES                        │                        │
│            ▼                            ▼                        │
│  ┌─────────────────────────────────────────────────────┐        │
│  │  STATIC ANALYSIS (Story 10.1)                        │        │
│  │  - Parse code → static_structure                     │        │
│  │  - CREATE/UPDATE Capability                          │        │
│  │  - HIL validation si tools sensibles                 │        │
│  └─────────────────────────────────────────────────────┘        │
│                            │                                     │
│                            ▼                                     │
│  ┌─────────────────────────────────────────────────────┐        │
│  │  EXECUTION (Sandbox)                                 │        │
│  │  - Traces: tool_start/end + result + parentTraceId  │        │
│  │  - Branch decisions captured                         │        │
│  └─────────────────────────────────────────────────────┘        │
│                            │                                     │
│                            ▼                                     │
│  ┌─────────────────────────────────────────────────────┐        │
│  │  TRACE STORAGE (Epic 11)                             │        │
│  │  - INSERT execution_trace (executed_path, results)  │        │
│  │  - UPDATE Capability.learning (aggregate stats)      │        │
│  └─────────────────────────────────────────────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Estimation:** 7 stories, ~4 semaines MVP (révisé post-implémentation)

---

### Architecture Unifiée Worker-Only (Découverte 10.5)

> **Décision Architecture (2025-12-20):** Suite à l'implémentation de Story 10.5, l'architecture
> d'exécution a été unifiée. Cette section documente les changements par rapport à la vision
> initiale.

**Principe Fondamental:** **TOUT passe par le Worker Sandbox (permissions: "none") pour 100%
traçabilité.**

```
┌─────────────────────────────────────────────────────────────────┐
│  Code TypeScript                                                 │
│       │                                                          │
│       ▼                                                          │
│  Static Analysis (SWC) → static_structure → Capability           │
│       │                                                          │
│       ▼                                                          │
│  ControlledExecutor (orchestration)                              │
│  ├── Layers (parallel groups)                                    │
│  ├── Checkpoints                                                 │
│  └── HIL/per_layer_validation                                    │
│       │                                                          │
│       ▼                                                          │
│  Pour chaque task:                                               │
│       │                                                          │
│       ▼                                                          │
│  WorkerBridge.execute(taskCode)                                  │
│       │                                                          │
│       ▼                                                          │
│  Worker (permissions: "none")                                    │
│       │                                                          │
│       ▼                                                          │
│  RPC Proxy → client.callTool()                                   │
│       │                                                          │
│       ▼                                                          │
│  100% traçabilité ✅                                             │
└─────────────────────────────────────────────────────────────────┘
```

**Changements par rapport à la vision initiale:**

| Aspect            | Vision Epic (avant)                     | Réalité Implémentée                           |
| ----------------- | --------------------------------------- | --------------------------------------------- |
| **Fallback**      | "Fallback gracieux vers sandbox direct" | ❌ Supprimé - UN seul chemin                  |
| **DAG execution** | `client.callTool()` direct              | WorkerBridge pour 100% trace                  |
| **Subprocess**    | Chemin alternatif                       | Conservé uniquement pour features spécifiques |
| **Permissions**   | Granulaires par tool                    | `"none"` toujours (force RPC)                 |

**Performance Mesurée:**

- Worker: ~31ms
- Subprocess: ~53ms
- **Speedup: 1.7x**

**Fichiers Clés:**

- `src/dag/execution/workerbridge-executor.ts` - `createToolExecutorViaWorker()`
- `src/sandbox/executor.ts` - `useWorkerForExecute` option
- `src/sandbox/worker-bridge.ts` - Constante `WORKER_PERMISSIONS = "none"`

---

### Story Breakdown - Epic 10

**Story 10.1: Static Code Analysis → Capability Creation** ⭐ VRAIE FONDATION ✅ DONE

As an execution system, I want to parse code statically to generate a complete `static_structure`,
So that I can **create the Capability immediately** with full branch/condition visibility for HIL.

**Position dans l'Epic (RÉVISÉE):**

- **VRAIE FONDATION** - crée la Capability avec `static_structure` avant exécution
- Débloque Epic 11 (traces) car les traces référencent les nodeIds de static_structure
- Débloque HIL car on connaît tous les tools potentiels avant exécution

**Context (RÉVISÉ):**

Changement de philosophie :

- **AVANT :** La Capability était créée après exécution (validée par l'usage)
- **MAINTENANT :** La Capability est créée à l'analyse statique (structure complète)

Pourquoi ? L'analyse statique EST suffisante grâce à :

- SchemaInferrer → infère les dépendances via schémas input/output
- PermissionInferrer → détecte les patterns de permissions
- Les schémas MCP → provides edges calculables statiquement
- La détection des conditions → branches visibles dans la structure

**Différence avec Epic 11 (CLARIFIÉE):**

| Aspect       | 10.1 Static (PRE)                      | Epic 11 Traces (POST)          |
| ------------ | -------------------------------------- | ------------------------------ |
| **Quand**    | Avant exécution                        | Après exécution                |
| **Output**   | **Capability** avec `static_structure` | **Trace** avec `executed_path` |
| **Contenu**  | Structure COMPLÈTE (toutes branches)   | Chemin EMPRUNTÉ (une branche)  |
| **Stockage** | `workflow_pattern.dag_structure`       | `execution_trace` table        |

**Réutilisation de l'existant:**

On a DÉJÀ tout le pipeline SWC :

- `SchemaInferrer` (726 LOC, 19 tests) → parse AST, trouve `args.xxx`, infère types
- `PermissionInferrer` (510 LOC) → parse AST, détecte patterns dangereux
- `tool_schema` table → schemas input/output des MCP tools
- `workflow_pattern` table → schemas des capabilities

**Story 10.1 = Extension de ~200-250 LOC** pour générer `static_structure`.

**Architecture (RÉVISÉE):**

```
Code TypeScript
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  SWC AST Parser (RÉUTILISE SchemaInferrer/PermissionInferrer)│
│  - Même parse(), même traversée AST                          │
│  - Extension: chercher `mcp.*.*()` ET `capabilities.*()`    │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  Structure Builder (NOUVEAU)                                 │
│  - Génère des StaticStructureNodes pour chaque élément      │
│  - type: "task" pour tools/capabilities                     │
│  - type: "decision" pour if/switch/ternary                  │
│  - type: "fork"/"join" pour Promise.all                     │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  Edge Generator                                              │
│  - "sequence" : await séquentiel                            │
│  - "conditional" : branches de if/switch avec outcome       │
│  - "provides" : data flow via schémas (coverage calculé)    │
│  - "contains" : capability imbriquée                        │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  Capability Creation / Update                                │
│  - INSERT/UPDATE workflow_pattern                           │
│  - dag_structure.static_structure = { nodes, edges }        │
│  - Crée CapabilityDependency si appels à capabilities       │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
Validation HIL → Exécution → Trace (Epic 11)
```

**Patterns à détecter et STRUCTURE générée:**

```typescript
// Code source
const file = await mcp.fs.stat({ path });
if (file.exists) {
  const content = await mcp.fs.read({ path });
  return content;
} else {
  await mcp.fs.create({ path });
  await mcp.fs.write({ path, content: "" });
}

// static_structure générée:
{
  nodes: [
    { id: "n1", type: "task", tool: "fs:stat" },
    { id: "d1", type: "decision", condition: "file.exists" },
    { id: "n2", type: "task", tool: "fs:read" },
    { id: "n3", type: "task", tool: "fs:create" },
    { id: "n4", type: "task", tool: "fs:write" },
  ],
  edges: [
    { from: "n1", to: "d1", type: "sequence" },
    { from: "d1", to: "n2", type: "conditional", outcome: "true" },
    { from: "d1", to: "n3", type: "conditional", outcome: "false" },
    { from: "n3", to: "n4", type: "sequence" },
    { from: "n1", to: "n2", type: "provides" }  // Data flow inféré via schémas
  ]
}
```

**Patterns détaillés:**

```typescript
// Pattern 1: Appel MCP tool simple
const result = await mcp.fs.read({ path: "config.json" });
// → Node { id: "n1", type: "task", tool: "fs:read" }

// Pattern 2: Appel capability (crée aussi CapabilityDependency)
const summary = await capabilities.summarize({ text: content });
// → Node { id: "n2", type: "capability", capabilityId: "cap-xxx" }
// → CapabilityDependency { from: currentCap, to: "cap-xxx", edgeType: "contains" }

// Pattern 3: Parallélisme
const [a, b] = await Promise.all([
  mcp.api.fetch({ url: urlA }),
  mcp.api.fetch({ url: urlB }),
]);
// → Node { id: "f1", type: "fork" }
// → Node { id: "n3", type: "task", tool: "api:fetch" }
// → Node { id: "n4", type: "task", tool: "api:fetch" }
// → Node { id: "j1", type: "join" }
// → Edges: f1→n3, f1→n4, n3→j1, n4→j1

// Pattern 4: Conditionnel
if (condition) {
  await mcp.db.write({ data });
}
// → Node { id: "d1", type: "decision", condition: "condition" }
// → Node { id: "n5", type: "task", tool: "db:write" }
// → Edge { from: "d1", to: "n5", type: "conditional", outcome: "true" }
```

**Acceptance Criteria (RÉVISÉS):**

1. `StaticStructureBuilder` class créée, **étend les patterns de SchemaInferrer**
2. Réutilise le même `parse()` SWC que SchemaInferrer/PermissionInferrer
3. Types `StaticStructure` définis :
   ```typescript
   // Nœuds de la structure statique
   type StaticStructureNode =
     | { id: string; type: "task"; tool: string }
     | { id: string; type: "decision"; condition: string }
     | { id: string; type: "capability"; capabilityId: string }
     | { id: string; type: "fork" }
     | { id: string; type: "join" };

   // Edges de la structure
   interface StaticStructureEdge {
     from: string;
     to: string;
     type: "sequence" | "provides" | "conditional" | "contains";
     outcome?: string; // Pour conditional: "true", "false", "case1"
     coverage?: "strict" | "partial" | "optional"; // Pour provides
   }

   interface StaticStructure {
     nodes: StaticStructureNode[];
     edges: StaticStructureEdge[];
   }
   ```
4. Method `buildStaticStructure(code: string, db: PGliteClient)` → `StaticStructure`
5. **Détection des nœuds:**
   - `mcp.*.*()` → Node type "task"
   - `capabilities.*()` → Node type "capability"
   - `if/switch/ternary` → Node type "decision"
   - `Promise.all/allSettled` → Nodes "fork" + "join"
6. **Génération des edges:**
   - `await` séquentiel → edge "sequence"
   - Branches de if → edges "conditional" avec outcome
   - Data flow via schémas → edges "provides" avec coverage
7. **Création de Capability:**
   - INSERT/UPDATE `workflow_pattern` avec `dag_structure.static_structure`
   - Crée `CapabilityDependency` pour chaque capability imbriquée
8. **Intégration avec HIL:**
   - Extraire tous les tools de `static_structure.nodes`
   - Vérifier permissions via `getToolPermissionConfig()`
   - Si tool avec `approvalMode: "hil"` → demander approbation
9. Tests: code avec tools → nodes "task" générés
10. Tests: code avec if/else → node "decision" + edges "conditional"
11. Tests: code avec Promise.all → nodes "fork"/"join"
12. Tests: code avec capability → node "capability" + CapabilityDependency créée
13. Tests: chaînage tool→tool → edge "provides" calculé

**Files to Create:**

- `src/capabilities/static-structure-builder.ts` (~200-250 LOC)

**Files to Modify:**

- `src/capabilities/types.ts` - Ajouter `StaticStructure` types (~40 LOC)
- `src/capabilities/capability-store.ts` - Intégrer static_structure dans saveCapability (~30 LOC)
- `src/mcp/handlers/code-execution-handler.ts` - Build structure avant exécution (~20 LOC)

**Prerequisites:** Story 7.2b (SWC parsing - DONE)

**Estimation:** 3-4 jours (augmenté car scope élargi)

**Changement clé:** Cette story **crée la Capability** avec sa structure complète. Les traces
(Epic 11) viennent ensuite enrichir le `learning` avec les chemins réellement empruntés.

---

**Story 10.2: Static Argument Extraction for Speculative Execution** ✅ DONE

> **Status:** DONE (2025-12-19) **Tech-Spec:**
> [10-2-static-argument-extraction.md](../sprint-artifacts/10-2-static-argument-extraction.md)

As a speculative execution system, I want to extract and store tool arguments from static code
analysis, So that I can execute capabilities speculatively without requiring runtime argument
inference.

**Context:** Story 10.1 extracts tool calls but NOT their arguments. For speculative execution to
work, we need to know what arguments to pass. Arguments can be:

- **Literals**: `{ path: "config.json" }` - can be stored and reused directly
- **References**: `{ input: file.content }` - resolved via ProvidesEdge at runtime
- **Parameters**: `{ path: userPath }` - capability input parameters from input_schema

**Why this matters for speculation:** Without arguments, we can only "prepare" execution, not
actually execute speculatively. By storing argument structure, we enable true speculative execution
with 0ms latency.

**Types:**

```typescript
// JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
interface ArgumentValue {
  type: "literal" | "reference" | "parameter";
  value?: JsonValue; // For literal (JSON-serializable)
  expression?: string; // For reference: "file.content"
  parameterName?: string; // For parameter: "userPath"
}

type StaticStructureNode = {
  id: string;
  type: "task";
  tool: string;
  arguments?: Record<string, ArgumentValue>;
};
// ... other variants unchanged
```

**Acceptance Criteria:**

1. [ ] `ArgumentValue` and `ArgumentsStructure` types defined in types.ts
2. [ ] `StaticStructureNode` (task variant) extended with optional `arguments`
3. [ ] Literal arguments extracted from ObjectExpression (strings, numbers, objects, arrays)
4. [ ] Reference arguments detected from MemberExpression (e.g., `file.content`)
5. [ ] Parameter arguments detected from Identifier referencing function params
6. [ ] `PredictedNode.arguments` populated from capability's static_structure
7. [ ] Tests for literal, reference, parameter, and mixed argument scenarios

**Files to modify:**

- `src/capabilities/types.ts` - Add ArgumentValue types
- `src/capabilities/static-structure-builder.ts` - Add argument extraction
- `src/graphrag/dag-suggester.ts` - Populate PredictedNode.arguments

**Prerequisites:** Story 10.1 (static_structure builder - DONE)

**Estimation:** 1-2 jours

---

**Story 10.3: Provides Edge Type - Data Flow Relationships** ✅ DONE

> **Status:** DONE (2025-12-18) **Tech-Spec:**
> [10-3-provides-edge-type.md](../sprint-artifacts/10-3-provides-edge-type.md)

As a graph learning system, I want a `provides` edge type that captures data flow between tools, So
that I can understand which tools can feed data to which other tools.

**Context:** Le `provides` edge est pour la vue **Definition** (structure abstraite). Il indique que
les outputs de A peuvent alimenter les inputs de B, basé sur les schemas.

**Edge Coverage Types:**

```typescript
type ProvidesCoverage =
  | "strict" // R ⊆ O (tous les required inputs couverts)
  | "partial" // R ∩ O ≠ ∅ (intersection non-vide)
  | "optional"; // Que des inputs optionnels couverts
```

**Acceptance Criteria:**

1. **Cleanup EdgeType** dans `edge-weights.ts`:
   - Ajouter `provides`
   - Retirer `alternative` (non utilisé, pas dans ADR-050)
   - `EdgeType` final : `"dependency" | "contains" | "sequence" | "provides"`
2. Weight configuré: `provides: 0.7` dans `EDGE_TYPE_WEIGHTS`
3. Interface `ProvidesEdge` définie avec **schemas exposés**:
   ```typescript
   interface ProvidesEdge {
     from: string; // Tool/capability provider
     to: string; // Tool/capability consumer
     type: "provides";
     coverage: ProvidesCoverage;

     // Schemas exposés pour que l'IA sache remplir les args
     providerOutputSchema: JSONSchema; // Ce que A produit
     consumerInputSchema: JSONSchema; // Ce que B attend (required + optional)
     fieldMapping: Array<{ // Correspondances champ par champ
       fromField: string; // e.g., "content"
       toField: string; // e.g., "json"
       typeCompatible: boolean; // Types compatibles ?
     }>;
   }
   ```
4. `computeCoverage()` function implémentée:
   - Input: `providerOutputs: Set<string>`, `consumerInputs: { required, optional }`
   - Output: `ProvidesCoverage | null`
   - Retourne `null` si aucune intersection
5. `createProvidesEdges()` calculé depuis les MCP tool schemas:
   - Pour chaque paire de tools, calculer coverage
   - Créer edge si coverage !== null
6. Stockage en DB: column `edge_type` déjà TEXT, pas de migration
7. Tests: fs:read (output: content) → json:parse (input: json) → coverage = "strict"
8. Tests: json:parse → http:post (need url, body) → coverage = "partial"

**Files to Create:**

- `src/graphrag/provides-edge-calculator.ts` (~100 LOC)

**Files to Modify:**

- `src/graphrag/edge-weights.ts` (~5 LOC)
- `src/graphrag/types.ts` (~15 LOC)

**Prerequisites:** Story 10.1 (static_structure with provides edges)

**Note:** Les provides edges sont calculés à l'analyse statique via les schémas MCP, pas depuis les
résultats d'exécution. Voir Story 10.1.

**Estimation:** 1-2 jours

---

**Story 10.5: Execute Code via Inferred DAG** ✅ DONE

> **Status:** DONE (2025-12-20) **Tech-Spec:**
> [10-5-execute-code-via-dag.md](../sprint-artifacts/10-5-execute-code-via-dag.md)

As an execution system, I want to execute code via its inferred DAG structure, So that code
execution benefits from DAG features (per-layer validation, parallel execution, checkpoints, SSE
streaming).

**Context:** Story 10.1 génère `static_structure` (le DAG inféré du code), mais `execute_code` ne
l'utilisait pas.

**Architecture Unifiée (Découverte pendant l'implémentation):**

```
AVANT (2 chemins - problématique):
├── DAG mode → client.callTool() direct (❌ pas de trace)
└── Sandbox mode → subprocess (❌ lent, pas unifié)

APRÈS (1 seul chemin - implémenté):
Code → static_structure → DAGStructure → ControlledExecutor
                                              ↓
                                         WorkerBridge
                                              ↓
                                    Worker (permissions: "none")
                                              ↓
                                         RPC Proxy
                                              ↓
                                    100% traçabilité ✅
```

**Décision Architecture Clé:**

- **Worker permissions = "none" toujours** - Force TOUT à passer par MCP RPC
- **Pas de fallback** - UN seul chemin d'exécution (Worker)
- **Performance:** Worker ~31ms vs subprocess ~53ms (1.7x speedup)

**Acceptance Criteria (Révisés post-implémentation):**

1. ✅ `staticStructureToDag(structure: StaticStructure): DAGStructure` converter
2. ✅ `handleExecuteCode()` modifié pour utiliser ControlledExecutor
3. ✅ `resolveArguments(args, context, previousResults)` implémenté
4. ✅ Conditional execution support (decision nodes → conditional branches)
5. ✅ Parallel execution from fork/join nodes
6. ✅ Per-layer validation for code execution
7. ~~Fallback to direct execution~~ → **SUPPRIMÉ** (Architecture unifiée)
8. ✅ Response includes DAG execution metadata
9. ✅ Tests: 23 tests (12 converter + 11 resolver)

**Nouveaux ACs (Découverts pendant l'implémentation):**

10. ✅ **WorkerBridge Integration** - `createToolExecutorViaWorker()` remplace les appels directs
11. ✅ **Signature Refactorisée** - Génère code TypeScript pour chaque appel tool via Worker
12. ✅ **Tests WorkerBridge** - 6 tests unitaires
13. ✅ **Unification execute()** - `DenoSandboxExecutor.execute()` utilise Worker par défaut
    - 268 tests sandbox passent
    - `useWorkerForExecute: false` pour features subprocess-only (allowedReadPaths, memoryLimit)

**Files Created:**

- `src/dag/static-to-dag-converter.ts` (~220 LOC)
- `src/dag/argument-resolver.ts` (~230 LOC)
- `src/dag/execution/workerbridge-executor.ts` (WorkerBridge-based ToolExecutor)
- `tests/integration/code-to-dag-execution_test.ts` (7 tests)

**Files Modified:**

- `src/mcp/handlers/code-execution-handler.ts` (~350 LOC changes)
- `src/mcp/handlers/workflow-execution-handler.ts` (WorkerBridge)
- `src/mcp/handlers/control-commands-handler.ts` (WorkerBridge)
- `src/sandbox/executor.ts` (Worker unification)

**Effort Réel:** 4-5 jours (vs 2-3 estimés) - Scope élargi avec architecture unifiée

---

**Story 10.6: pml_discover - Unified Discovery API**

As an AI agent, I want a single `pml_discover` tool to search both tools and capabilities, So that I
have a simplified API for finding what I need.

**Context:** Phase 4 de la tech spec. Remplace `pml_search_tools`, `pml_search_capabilities`,
`pml_find_capabilities`.

**API Design:**

```typescript
pml_discover({
  intent: "lire et parser un fichier JSON",
  filter?: {
    type?: "tool" | "capability" | "all",  // default: "all"
    minScore?: number,
  },
  limit?: number,  // default: 10
})

// Response
{
  results: [
    { type: "capability", id: "cap_123", score: 0.92, source: {...} },
    { type: "tool", id: "fs:read", score: 0.85 },
    { type: "capability", id: "cap_456", score: 0.78, source: {...} },
  ]
}
```

**Acceptance Criteria:**

1. Handler `pml_discover` créé dans `src/mcp/handlers/`
2. Recherche unifiée:
   - Vector search sur tools (`tool_graph.intent_embedding`)
   - Vector search sur capabilities (`workflow_pattern.intent_embedding`)
   - Merge et sort par score
3. Input validation avec JSON Schema
4. Filter par type: `tool`, `capability`, ou `all`
5. Pagination: `limit` + `offset`
6. Response inclut pour chaque résultat:
   - `type`: "tool" | "capability"
   - `id`: tool_id ou capability_id
   - `score`: similarity score
   - `source`: (pour capabilities) code ou dag preview
   - `toolSchemas`: (pour tools) input/output schemas
7. **Dépréciation** des anciens tools:
   - `pml_search_tools` → deprecated, redirige vers pml_discover
   - `pml_search_capabilities` → deprecated
   - `pml_find_capabilities` → deprecated
8. System prompt updated pour mentionner pml_discover
9. Tests: search "read file" → retourne mix tools + capabilities
10. Tests: filter type="tool" → que des tools
11. Tests: filter type="capability" → que des capabilities

**Files to Create:**

- `src/mcp/handlers/discover-handler.ts` (~150 LOC)

**Files to Modify:**

- `src/mcp/gateway-server.ts` - Register new handler
- `src/mcp/handlers/search-handler.ts` - Add deprecation notice

**Prerequisites:** Story 10.5 (unified capability model)

**Estimation:** 2-3 jours

---

**Story 10.7: pml_execute - Unified Execution API** _(includes DR-DSP from 10.7a)_

As an AI agent, I want a single `pml_execute` tool that handles code execution with automatic
learning, So that I have a simplified API and the system learns from my executions.

**Context:** Phase 5 de la tech spec. Remplace `pml_execute_dag` et `pml_execute_code`. **Inclut
DR-DSP** (anciennement Story 10.7a) pour le pathfinding hypergraph.

**Design Principles:**

- **Code-first**: Tout est du code TypeScript. Le DAG est inféré via analyse statique (Story 10.1)
- **Le code contient son context**: Les arguments sont des littéraux dans le code (pas de param
  `context` séparé)
- **DR-DSP pour hypergraph**: Remplace Dijkstra, comprend les capabilities comme hyperedges
- **2 modes simples**: Direct (code) vs Suggestion (intent seul)

**API Design:**

```typescript
pml_execute({
  intent: string,     // REQUIRED - natural language description
  code?: string,      // OPTIONAL - TypeScript code to execute
  options?: {
    timeout?: number;                // default: 30000ms
    per_layer_validation?: boolean;  // default: false
  }
})
```

**Les 2 Modes d'Exécution:**

| Input             | Mode           | Algo   | Ce qui se passe                                        | SWC Parsing ? |
| ----------------- | -------------- | ------ | ------------------------------------------------------ | ------------- |
| `intent` + `code` | **Direct**     | SWC    | Exécute → Crée capability                              | ✅ OUI        |
| `intent` seul     | **Suggestion** | DR-DSP | Trouve → Exécute si confiance haute, sinon suggestions | ❌ NON        |

**Execution Flow:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  pml_execute({ intent, code? })                                      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │   code fourni?    │
                    └─────────┬─────────┘
                    ┌─────────┴─────────┐
                   OUI                 NON
                    │                   │
                    ▼                   ▼
         ┌──────────────────┐  ┌──────────────────┐
         │   MODE DIRECT    │  │ MODE SUGGESTION  │
         │ (exécute+apprend)│  │    (DR-DSP)      │
         └────────┬─────────┘  └────────┬─────────┘
                  │                     │
                  ▼                     ▼
         1. Analyse statique    1. DR-DSP.findShortestHyperpath()
            (SWC)               2. Confiance haute + canSpeculate()?
         2. Exécute code           │
         3. Crée capability    ┌───┴───┐
                  │           OUI     NON
                  │            │       │
                  │            ▼       ▼
                  │         Exécute  RETURN
                  │         capability suggestions
                  │            │
                  │            ▼
                  │         Update usage_count++
                  │            │
                  └────────────┴────────┐
                                        ▼
                                  RETURN result
```

**ATTENTION: Analyse statique selon le mode**

| Mode           | Analyse statique SWC     | Pourquoi                                         |
| -------------- | ------------------------ | ------------------------------------------------ |
| **Direct**     | ✅ OUI - AVANT exécution | Doit créer `static_structure` pour la capability |
| **Suggestion** | ❌ NON - SKIP            | Capability existante a déjà `static_structure`   |

**Cycle d'Apprentissage (Procedural Memory):**

1. **Jour 1:** Claude écrit du code → `pml_execute({ intent, code })` → capability créée
2. **Jour 2:** Intent similaire → `pml_execute({ intent })` → DR-DSP trouve → exécute
3. **Amélioration continue:** success_rate, usage_count mis à jour

**Évolution future (10.7b, Epic 12):**

| Story       | Ajout                         | Description                                                       |
| ----------- | ----------------------------- | ----------------------------------------------------------------- |
| **10.7b**   | SHGAT Persistence             | Sauvegarder/charger les poids SHGAT entre redémarrages            |
| **10.7c**   | Thompson Sampling             | Seuils de confiance adaptatifs (exploration/exploitation)         |
| **Epic 12** | Speculation + Session Context | Pré-exécution intra-workflow + cache session workflows précédents |

**Acceptance Criteria:**

1. Handler `pml_execute` créé dans `src/mcp/handlers/`
2. **Mode Direct** (`code` fourni):
   - Analyse statique du code (Story 10.1)
   - Exécute via WorkerBridge
   - Crée/update capability avec `static_structure`
   - **Exécute toujours** - pas de check confiance
3. **Mode Suggestion** (`intent` seul) avec DR-DSP:
   - Initialise `DRDSP` avec `buildDRDSPFromCapabilities()` au démarrage
   - Appelle `DRDSP.findShortestHyperpath()` pour trouver capability
   - Si confiance haute + canSpeculate() → exécute capability
   - Sinon → retourne suggestions (tools + capabilities)
   - **Skip SWC parsing** (capability déjà parsée)
4. **DR-DSP Integration** (ex-10.7a):
   - `DRDSP` instance créée au démarrage du gateway
   - `applyUpdate()` appelé quand nouvelle capability apprise
   - Benchmark: DR-DSP vs Dijkstra
5. Support `per_layer_validation` pour tools avec permissions élevées
6. **Dépréciation** des anciens tools:
   - `pml_execute_dag` → deprecated
   - `pml_execute_code` → deprecated
7. Response unifiée avec `status: "success" | "approval_required" | "suggestions"`
8. Tests: execute avec code → mode direct + capability créée
9. Tests: execute avec intent seul + DR-DSP match → exécute
10. Tests: execute avec intent seul + pas de match → suggestions

**Files to Create:**

- `src/mcp/handlers/execute-handler.ts` (~300 LOC)

**Files to Modify:**

- `src/mcp/gateway-server.ts` - Register handler + init DRDSP
- `src/mcp/handlers/workflow-execution-handler.ts` - Add deprecation
- `src/mcp/handlers/code-execution-handler.ts` - Add deprecation

**Prerequisites:** Story 10.6 (pml_discover)

**Estimation:** 4-6 jours (inclut DR-DSP integration)

---

**Story 10.7a: DR-DSP Integration for DAG Suggestion** ✅ MERGED INTO 10.7

> **Note:** Cette story a été mergée dans Story 10.7. Le contenu ci-dessous est conservé pour
> référence.

As a DAG suggestion system, I want to use DR-DSP for pathfinding, So that I find optimal hyperpaths
through the capability graph instead of simple Dijkstra paths.

**Context:** Le module `src/graphrag/algorithms/dr-dsp.ts` est déjà implémenté (POC). ~~Cette story
intègre DR-DSP dans `suggestDAG()` pour remplacer Dijkstra.~~ **→ Maintenant intégré directement
dans Story 10.7**

**Ce qui existe déjà:

- `DRDSP` class avec `findShortestHyperpath(source, target)`
- `buildDRDSPFromCapabilities()` factory
- `applyUpdate()` pour mise à jour dynamique
- Support des hyperedges (N-ary relations)

**Acceptance Criteria:**

1. `suggestDAG()` utilise `DRDSP.findShortestHyperpath()` au lieu de Dijkstra
2. `buildDRDSPFromCapabilities()` appelé au démarrage avec graph existant
3. Hyperedges créés depuis les capabilities (tools groupés)
4. `applyUpdate()` appelé quand une nouvelle capability est apprise
5. Tests: hyperpath trouvé pour intent → DAG suggestion
6. Benchmark: performance DR-DSP vs Dijkstra

**Files to Modify:**

- `src/graphrag/dag-suggester.ts` - Remplacer Dijkstra par DR-DSP
- `src/mcp/handlers/execute-handler.ts` - Utiliser nouveau suggester

**Prerequisites:** Story 10.7 (execute handler created)

**Estimation:** 1-2 jours

---

**Story 10.7b: SHGAT Persistence** ✅ DONE (2025-12-23)

As a learning system, I want SHGAT weights to persist between server restarts, So that learned
attention patterns are not lost and the system improves over time.

> **Note (2025-12-23):** Scope clarifié - "Cache Session" déplacé vers Epic 12. Le scoring SHGAT a
> été mergé dans Story 10.7. Cette story couvre uniquement la persistence des poids.

**Ce qui a été fait dans 10.7:**

- ✅ SHGAT initialisé au démarrage gateway
- ✅ Scoring backward (sans context) pour mode Suggestion
- ✅ Scoring forward (avec context) pour predictNextNode()
- ✅ Training pipeline sur `episodic_events`
- ✅ Fallback si <20 traces
- ✅ `exportParams()` / `importParams()` existent

**Implémenté (10.7b):**

- [x] Migration: `010_shgat_params.sql` - table avec user_id UNIQUE
- [x] `loadSHGATParams()` au startup → `importParams()` si row existe
- [x] `saveSHGATParams()` au shutdown → `exportParams()` + UPSERT
- [x] Sauvegarde périodique (toutes les 10 min) pour éviter perte en cas de crash
- [x] Tests: 4 tests unitaires (export/import, JSON round-trip, DB simulation)

**Design décidé (2025-12-23):**

- **Stockage:** PostgreSQL (cohérent, multi-tenant, backup auto)
- **Pas de reimport en cours de route:** weights en mémoire, live learning les modifie
- **Un row par user_id:** UPSERT à chaque sauvegarde

```sql
CREATE TABLE shgat_params (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT DEFAULT 'local' UNIQUE,
  params JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Files to Create:**

- `src/db/migrations/020_shgat_params.sql` (~15 LOC)

**Files to Modify:**

- `src/mcp/gateway-server.ts` (~40 LOC) - load at startup, save at shutdown

**Estimation:** 0.5 jour

---

**Story 10.7c: Thompson Sampling Integration**

As a decision system, I want to use Thompson Sampling for execution decisions, So that I balance
exploration (trying uncertain tools) and exploitation (using reliable tools).

**Context:** Le module `src/graphrag/algorithms/thompson.ts` est déjà implémenté (POC). Cette story
intègre Thompson Sampling dans le flow de décision AIL/HIL.

**Ce qui existe déjà:**

- `ThompsonSampler` class avec Beta distribution per tool
- `getThreshold(toolId, riskCategory, mode)` - threshold adaptatif
- `recordOutcome(toolId, success)` - mise à jour Bayésienne
- `classifyToolRisk()` - classification safe/moderate/dangerous
- UCB exploration bonus pour tools sous-explorés

**Acceptance Criteria:**

1. `AdaptiveThresholdManager` utilise `ThompsonSampler` en interne
2. Seuils par tool calculés via `getThreshold()`:
   - Mode `active_search` → seuil plus bas (exploration)
   - Mode `passive_suggestion` → seuil standard
   - Mode `speculation` → seuil plus haut (conservateur)
3. `recordOutcome()` appelé après chaque exécution
4. UCB bonus appliqué aux tools peu utilisés
5. Risk classification automatique via `classifyToolRisk()`
6. Migration: importer historique depuis `adaptive_thresholds` table
7. Tests: Thompson converge vers seuil optimal après N exécutions
8. Benchmark: variance des décisions réduite avec Thompson

**Files to Modify:**

- `src/mcp/adaptive-threshold.ts` - Intégrer ThompsonSampler
- `src/dag/controlled-executor.ts` - Utiliser nouveaux seuils

**Prerequisites:** Story 10.7 (pml_execute with DR-DSP + SHGAT)

**Estimation:** 1-2 jours

---

**Story 10.8: pml_get_task_result - Result Fetching Meta-Tool**

As an AI agent reviewing DAG execution results, I want to fetch the full result of a specific task,
So that I can make informed decisions when the preview isn't sufficient.

**Context:** Complémente le `resultPreview` (240 chars) déjà implémenté. Si l'IA a besoin de plus de
contexte pour décider, elle peut demander le résultat complet.

**API Design:**

```typescript
pml_get_task_result({
  workflow_id: string;
  task_id: string;
  offset?: number;      // Pour pagination (grands résultats)
  limit?: number;       // Longueur max à retourner
  format?: "raw" | "pretty";  // Formatage JSON
})
```

**Acceptance Criteria:**

1. Handler `pml_get_task_result` créé
2. Stockage des résultats complets:
   - Nouveau champ `fullResult` dans execution traces
   - Ou table séparée `task_results` (workflow_id, task_id, result)
3. Récupération avec pagination:
   - `offset` pour commencer à un point
   - `limit` pour limiter la taille
4. Formatage:
   - `raw`: JSON tel quel
   - `pretty`: JSON.stringify avec indentation
5. TTL sur les résultats stockés (configurable, default 1h)
6. Tests: execute dag → get_task_result → retourne résultat complet
7. Tests: pagination fonctionne sur grand résultat
8. Tests: résultat expiré → erreur appropriée

**Files to Create:**

- `src/mcp/handlers/task-result-handler.ts` (~80 LOC)

**Files to Modify:**

- `src/mcp/gateway-server.ts` - Register handler
- `src/dag/controlled-executor.ts` - Store full results

**Prerequisites:** Story 10.7 (pml_execute)

**Estimation:** 1-2 jours

---

### Epic 10 Breaking Changes Summary

| Phase | Change                              | Breaking?  | Impact        |
| ----- | ----------------------------------- | ---------- | ------------- |
| 1     | `static_structure` in dag_structure | ❌ No      | Additive      |
| 3     | `provides` EdgeType                 | ❌ No      | Additive      |
| 5     | Capability `source: code \| dag`    | ⚠️ **Yes** | Schema change |
| 6     | Deprecate `pml_search_*`            | ⚠️ **Yes** | MCP APIs      |
| 7     | Deprecate `pml_execute_*`           | ⚠️ **Yes** | MCP APIs      |

**Migration Strategy:**

- Phase 5-7: Breaking changes. No transition period - clean cut.

> **Note:** Stories DB cleanup et learning déplacées vers Epic 11.

---

### Epic 10 Dependencies — RÉVISÉES

```
┌─────────────────────────────────────────────────────────────────┐
│  FLOW SÉQUENTIEL (Capability Creation & APIs)                    │
│                                                                  │
│  ★ Story 10.1 (Static Analysis → Capability Creation)           │
│        │  ← VRAIE FONDATION : crée la Capability avec           │
│        │     static_structure, provides edges, HIL               │
│        │                                                         │
│        ▼                                                         │
│  Story 10.2 (Static Argument Extraction)                         │
│        │  ← Extraction des arguments pour exécution spéculative │
│        │                                                         │
│        ├──────────────────┬──────────────────┐                   │
│        │                  │                  │                   │
│        ▼                  ▼                  ▼                   │
│  Story 10.3          Story 10.5       Story 10.6                 │
│  (provides edges)    (Unified Model)  (pml_discover)             │
│        │                  │                  │                   │
│        └──────────────────┴──────────────────┘                   │
│                           │                                      │
│                           ▼                                      │
│                    Story 10.7 (pml_execute)                      │
│                           │                                      │
│                           ▼                                      │
│                    Story 10.8 (pml_get_task_result)              │
│                                                                  │
│  ────────────────────────────────────────────────────────────    │
│  Stories déplacées vers Epic 11 (Learning from Traces):          │
│  - 11.0 DB Schema Cleanup (ex-10.3b + spike recommandations)     │
│  - 11.1 Result Tracing (ex-10.2)                                 │
│  - 11.2/11.3 execution_trace + PER/TD (ex-10.4)                  │
│  - 11.4 Definition/Invocation Views (ex-10.9)                    │
│  - 11.5 Dry Run (ex-10.10)                                       │
└─────────────────────────────────────────────────────────────────┘
```

**Ordre d'implémentation recommandé (RÉVISÉ):**

| Ordre | Story                               | Justification                                                  |
| ----- | ----------------------------------- | -------------------------------------------------------------- |
| 1     | **10.1** Static Analysis            | **VRAIE FONDATION** - crée la Capability avec static_structure |
| 2     | **10.2** Static Argument Extraction | Extraction arguments pour exécution spéculative                |
| 3     | **10.3** Provides Edge              | Types d'edges pour data flow                                   |
| 4     | **10.5** Unified Capability         | source: code \| dag \| tool                                    |
| 5     | **10.6** pml_discover               | API unifiée de découverte                                      |
| 6     | **10.7** pml_execute                | API unifiée d'exécution                                        |
| 7     | **10.8** pml_get_task_result        | Complément pour AIL                                            |

**Changement clé:**

- Stories de learning et DB cleanup déplacées vers Epic 11
- Epic 10 se concentre sur **création de capability** et **APIs unifiées**

**Pourquoi 10.1 d'abord?**

1. La Capability est créée à l'analyse statique (structure complète avec conditions)
2. L'HIL fonctionne immédiatement (on connaît les tools avant exécution)
3. Les APIs unifiées peuvent être construites directement sur cette base

**External Dependencies:**

- Epic 7 Story 7.1b (Worker RPC Bridge)
- HIL Phase 2 (per_layer_validation, resultPreview)

---

### Epic 10 FR Coverage

| FR       | Description                                                               | Story      |
| -------- | ------------------------------------------------------------------------- | ---------- |
| **FR1**  | **Capability Creation à l'analyse statique (static_structure)**           | **10.1**   |
| **FR1b** | **Validation permissions avant exécution**                                | **10.1**   |
| **FR1c** | **HIL pre-execution approval flow**                                       | **10.1**   |
| **FR1d** | **Détection conditions/branches dans static_structure**                   | **10.1**   |
| **FR2**  | **Extraction arguments (literal, reference, parameter) pour spéculation** | **10.2**   |
| FR3      | Edge type `provides` avec coverage                                        | 10.3       |
| FR5      | Capability unifiée (code OU dag)                                          | 10.5       |
| FR6      | API `pml_discover` unifiée                                                | 10.6       |
| FR7      | API `pml_execute` unifiée                                                 | 10.7       |
| FR8      | `pml_get_task_result` pour résultats complets                             | 10.8       |
| FR10     | Dépréciation anciennes APIs                                               | 10.6, 10.7 |
| FR11     | Learning automatique après succès                                         | 10.7       |

> **Note:** FRs liés au DB cleanup et learning déplacés vers Epic 11.

### Epic 10 → PRD FR Traceability Matrix

> **Note:** Cette table lie les FRs locaux de l'Epic 10 aux FRs globaux du PRD pour assurer la
> traçabilité.

| Epic 10 FR | PRD FR | PRD Requirement                                              | Relation       |
| ---------- | ------ | ------------------------------------------------------------ | -------------- |
| FR1        | FR005  | Analyser dépendances input/output pour construire graphe DAG | **Implements** |
| FR1        | FR006  | Identifier automatiquement tools parallèles vs séquentiels   | **Implements** |
| FR1b       | FR017  | Exécution TypeScript dans Deno sandbox isolé                 | **Extends**    |
| FR1c       | FR018  | Branches DAG safe-to-fail (resilient workflows)              | **Extends**    |
| FR2        | FR005  | Analyser dépendances input/output pour construire graphe DAG | **Extends**    |
| FR2        | FR007  | Exécuter simultanément branches indépendantes du DAG         | **Enables**    |
| FR3        | FR005  | Analyser dépendances input/output pour construire graphe DAG | **Extends**    |
| FR5        | FR017  | Exécution TypeScript dans Deno sandbox isolé                 | **Extends**    |
| FR5        | FR019  | Injecter MCP tools dans contexte sandbox via vector search   | **Extends**    |
| FR6        | FR002  | Recherche sémantique pour identifier top-k tools pertinents  | **Unifies**    |
| FR6        | FR003  | Charger tool schemas on-demand pour tools pertinents         | **Unifies**    |
| FR7        | FR007  | Exécuter simultanément branches indépendantes du DAG         | **Unifies**    |
| FR7        | FR017  | Exécution TypeScript dans Deno sandbox isolé                 | **Unifies**    |
| FR8        | FR008  | Streamer résultats via SSE pour feedback progressif          | **Extends**    |
| FR10       | -      | N/A (internal cleanup)                                       | **Internal**   |
| FR11       | -      | N/A (Epic 7 extension)                                       | **Epic 7**     |

> **Note:** FRs DB cleanup et learning déplacés vers Epic 11.

**Legend:**

- **Implements**: Implémentation directe du FR PRD
- **Extends**: Étend/améliore un FR PRD existant
- **Unifies**: Unifie plusieurs FRs PRD en une seule API
- **Internal**: Nettoyage interne sans FR PRD correspondant

---

### Epic 10 Estimation Summary (Révisé 2025-12-22)

| Ordre | Story     | Description                                     | Estimé   | Réel     | Status           |
| ----- | --------- | ----------------------------------------------- | -------- | -------- | ---------------- |
| 1     | **10.1**  | **Static Analysis → Capability** ⭐ FONDATION   | 3-4j     | **4j**   | ✅ DONE          |
| 2     | **10.2**  | Static Argument Extraction                      | 1-2j     | **2j**   | ✅ DONE          |
| 3     | **10.3**  | Provides Edge + DB Persistence                  | 1-2j     | **2j**   | ✅ DONE          |
| 4     | **10.5**  | Execute via DAG + Worker Unification            | 2-3j     | **5j**   | ✅ DONE          |
| 5     | 10.6      | pml_discover + Unified Scoring Formula          | 2.5-3.5j | **2j**   | ✅ DONE          |
| 6     | **10.7**  | **pml_execute + DR-DSP + SHGAT** (merged 10.7a) | 3-4j     | **3j**   | ✅ DONE          |
| -     | ~~10.7a~~ | ~~DR-DSP Integration~~                          | -        | -        | ✅ MERGED → 10.7 |
| 7     | **10.7b** | SHGAT Persistence (weights saved/loaded)        | 0.5j     | **0.5j** | ✅ DONE          |
| 8     | **10.7c** | Thompson Sampling Integration                   | 0.5-1j   | -        | ⬜ TODO          |
| 9     | 10.8      | pml_get_task_result                             | 1-2j     | -        | ⬜ TODO          |

**Progression: 7/9 stories (78%)** _(10.7a merged, 10.7+10.7b done)_

**Note (2025-12-23):**

- Story 10.6a (Unified Search) mergée dans 10.6
- **Story 10.7a (DR-DSP) mergée dans 10.7** - DR-DSP intégré directement
- **Story 10.7b scope clarifié** - Persistence uniquement, "Cache Session" → Epic 12
- **Algorithmes déjà implémentés (POC):** DR-DSP (460 LOC), SHGAT (1284 LOC), Thompson (708 LOC)
- **Stories 10.7b-c = petites intégrations** (~0.5-1j chacune)

**Effort réel vs estimé:**

- Stories 10.1-10.5: **13 jours** (vs 7-11j estimés)
- Raison principale: Story 10.5 a découvert le besoin d'architecture unifiée Worker-only (+2j)

> **Note:** Stories déplacées vers Epic 11 :
>
> - 11.0 DB Schema Cleanup complet (2-3j)
> - 11.1 Result Tracing (0.5-1j)
> - 11.2 execution_trace table (2-3j)
> - 11.3 PER + TD Learning (2-3j)
> - 11.4 Definition/Invocation Views (2-3j)
> - 11.5 Dry Run (3-4j, optional)

**🎯 Découvertes clés pendant l'implémentation:**

1. **Architecture unifiée Worker-only** - Tout passe par WorkerBridge (100% traçabilité)
2. **Performance Worker** - 1.7x plus rapide que subprocess
3. **Pas de fallback** - Un seul chemin d'exécution (simplicité)
4. **Sandbox bypass bug** - Corrigé avec `createToolExecutorViaWorker()`
