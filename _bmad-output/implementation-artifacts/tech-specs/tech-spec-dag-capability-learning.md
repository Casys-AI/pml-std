# Tech Spec: DAG, Capabilities & Learning Architecture

**Status:** 📋 DRAFT - Discussion **Date:** 2025-12-16 **Authors:** Discussion Claude + User
**Related:** `bug-parallel-execution-tracking.md`, ADR-041, ADR-043

---

## Executive Summary

Cette tech spec adresse plusieurs questions architecturales interconnectées autour de
l'apprentissage depuis les DAGs et le code, la création de capabilities, et la cohérence du modèle
de données.

### Décision clé : Unification des APIs

**On unifie les tools MCP en deux points d'entrée principaux :**

| Avant (fragmenté)         | Après (unifié) |
| ------------------------- | -------------- |
| `pml_search_tools`        | `pml_discover` |
| `pml_search_capabilities` | `pml_discover` |
| `pml_find_capabilities`   | `pml_discover` |
| `pml_execute_dag`         | `pml_execute`  |
| `pml_execute_code`        | `pml_execute`  |

> **Pourquoi `discover` ?** Le système explore intelligemment le graphe, pas juste une recherche
> textuelle.

### Problèmes identifiés

1. **Parallel tracking** : Les tools exécutés en parallèle ne créent pas d'edges
2. **DAG → Capability** : Un DAG exécuté avec succès ne génère pas de capability
3. **Edge types confus** : `sequence` vs `dependency` - quelle différence ?
4. **Manque de `provides`** : Pas d'edge pour montrer qu'un tool/capability fournit les inputs d'un
   autre
5. **Code vs DAG** : Tension entre les deux modèles d'exécution
6. **APIs fragmentées** : Trop de tools séparés pour la recherche
7. **Mode definition vs invocation** : Pas de distinction dans le data model

### Ce qui existe DÉJÀ ✅

| Fonctionnalité          | Implémentation                  | Fichier                         |
| ----------------------- | ------------------------------- | ------------------------------- |
| Intent → DAG suggestion | `processIntent()`               | `workflow-execution-handler.ts` |
| Dependency paths        | `SuggestedDAG.dependencyPaths`  | `types.ts`                      |
| Confidence + rationale  | `SuggestedDAG`                  | `dag-suggester.ts`              |
| Speculative execution   | `mode: "speculative_execution"` | `workflow-execution-handler.ts` |
| Alternatives            | `SuggestedDAG.alternatives`     | `types.ts`                      |
| Timestamps dans traces  | `ts`, `durationMs`              | `worker-bridge.ts`              |
| Parent trace ID         | `parentTraceId`                 | ADR-041                         |

### Ce qui est NOUVEAU 🆕

| Fonctionnalité                         | Pourquoi                                               | Section    |
| -------------------------------------- | ------------------------------------------------------ | ---------- |
| Tracer `result`                        | Valider les `provides` edges                           | §8.4       |
| Reconstruire DAG depuis code           | Rendre le code ré-exécutable                           | §8         |
| `provides` edge type                   | Définir la couverture inputs/outputs (Definition view) | §2.3       |
| Séparation Definition/Invocation views | Clarifier ce qu'on affiche dans Cytoscape              | §7.5       |
| Schemas dans DAG suggestion            | Aider l'IA à remplir les args                          | §2.5       |
| `pml_discover` unifié                  | Simplifier APIs recherche (spec séparée)               | §9 Phase 4 |

---

## 1. Contexte : Deux modèles d'exécution

### 1.1 Le modèle DAG (`pml_execute_dag`)

```typescript
interface Task {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  dependsOn: string[]; // Structure explicite
  type?: "mcp_tool" | "code_execution" | "capability";
  sideEffects?: boolean; // Pour HIL
}
```

**Avantages :**

- Structure explicite (parallélisme, dépendances)
- DAG Suggester peut proposer des workflows
- Speculation possible (prédire next task)
- HIL granulaire par task
- Layers calculables pour exécution optimisée

**Inconvénients :**

- Moins naturel pour l'IA à générer
- Verbeux pour des workflows simples

### 1.2 Le modèle Code (`pml_execute_code`)

```typescript
// L'IA écrit du code naturel
const config = await mcp.fs.read({ path: "config.json" });
const [a, b] = await Promise.all([
  mcp.api.fetch({ url: config.urlA }),
  mcp.api.fetch({ url: config.urlB }),
]);
```

**Avantages :**

- Naturel pour l'IA
- Flexible (loops, conditions, etc.)
- Plus expressif

**Inconvénients :**

- Structure d'orchestration opaque
- DAG Suggester ne peut pas suggérer du code
- Speculation difficile
- HIL moins granulaire

### 1.3 Question fondamentale

> Comment réconcilier ces deux modèles pour que l'apprentissage fonctionne dans les deux cas ?

---

## 2. Parallel Execution Tracking

### 2.1 État actuel (BUG)

**Problème 1 : DAG parallel tasks**

```typescript
// Dans graph-engine.ts:updateFromExecution()
for (const task of execution.dagStructure.tasks) {
  for (const depTaskId of task.dependsOn) { // ← Vide si parallel
    // Crée edge dependency
  }
}
// Si dependsOn: [] → AUCUN edge créé !
```

**Problème 2 : Code execution traces**

```typescript
// Dans execution-learning.ts - Phase 3
for (let i = 0; i < children.length - 1; i++) {
  createEdge(children[i], children[i + 1], "sequence");
  // ← Basé sur l'ordre dans l'array, pas les timestamps !
}
```

### 2.2 Solution proposée

**On a déjà les timestamps !** Dans `worker-bridge.ts` :

```typescript
{
  type: "tool_start",
  tool: toolId,
  ts: Date.now(),           // ← START TIME
  durationMs: durationMs,   // ← DURATION
}
```

**Algorithme de détection (vue Invocation) :**

```typescript
function detectSequence(traces: TraceEvent[]): Edge[] {
  // Calculer endTs = ts + durationMs pour chaque trace
  // Si timestamps overlap → pas d'edge (parallel)
  // Si A finit avant B commence → edge "sequence" A→B
  // Note: le parallélisme est implicite = absence de lien
}
```

### 2.3 Nouveau edge type : `provides` (Definition view)

L'edge `provides` capture la relation "A fournit des données pour B" dans la vue **Definition**.

> **Note importante :** Le parallélisme n'a pas besoin d'edge dédié. Deux tasks parallèles = deux
> tasks sans lien de dépendance entre elles. Ce qui compte c'est le **fan-in/fan-out**, pas une
> relation "co-occurrence".

#### Types d'edges par vue

```typescript
export type EdgeType =
  // Definition view (structure abstraite)
  | "dependency" // A doit finir avant B (DAG explicit)
  | "provides" // A fournit des données utilisables par B (NEW)
  | "contains" // A contient B (hierarchy)
  | "alternative" // A ou B pour même intent
  // Invocation view (exécution réelle)
  | "sequence"; // A observé avant B (temporal order)
```

#### Formalisation mathématique de `provides`

L'edge `provides` indique que les **outputs** de A peuvent alimenter les **inputs** de B.

On utilise des concepts mathématiques de relation entre ensembles :

```typescript
interface ProvidesEdge {
  from: string; // Nœud source (provider)
  to: string; // Nœud cible (consumer)
  type: "provides";
  coverage: ProvidesCoverage;
}

type ProvidesCoverage =
  | "strict" // Surjection : outputs couvrent TOUS les required inputs
  | "partial" // Intersection non-vide avec required inputs
  | "optional"; // Couvre uniquement des inputs optionnels

// Formalisation
// Soit R = ensemble des required inputs de B
// Soit O = ensemble des outputs de A
//
// strict:   R ⊆ O  (surjection - tout required est couvert)
// partial:  R ∩ O ≠ ∅ et R ⊄ O (intersection non-vide, mais incomplet)
// optional: R ∩ O = ∅ et optionalInputs(B) ∩ O ≠ ∅ (que des optionnels)
```

#### Exemple visuel

```
┌─────────────┐
│  fs:read    │ outputs: { content: string }
└──────┬──────┘
       │ provides (strict)
       ▼
┌─────────────┐
│ json:parse  │ required: { json: string }  ← content → json
└──────┬──────┘
       │ provides (partial)
       ▼
┌─────────────┐
│ http:post   │ required: { url, body, headers }  ← json → body (manque url, headers)
└─────────────┘
```

#### Calcul de coverage

```typescript
function computeCoverage(
  providerOutputs: Set<string>,
  consumerInputs: { required: Set<string>; optional: Set<string> },
): ProvidesCoverage | null {
  const requiredCovered = intersection(consumerInputs.required, providerOutputs);
  const optionalCovered = intersection(consumerInputs.optional, providerOutputs);

  // Aucune intersection = pas d'edge provides
  if (requiredCovered.size === 0 && optionalCovered.size === 0) {
    return null;
  }

  // Tous les required sont couverts
  if (isSubset(consumerInputs.required, providerOutputs)) {
    return "strict";
  }

  // Quelques required couverts
  if (requiredCovered.size > 0) {
    return "partial";
  }

  // Que des optionnels
  return "optional";
}
```

#### Weights par type d'edge

```typescript
export const EDGE_TYPE_WEIGHTS: Record<EdgeType, number> = {
  // Definition view
  dependency: 1.0, // Causalité explicite
  provides: 0.7, // Relation data flow
  contains: 0.8, // Hiérarchie
  alternative: 0.6, // Options
  // Invocation view
  sequence: 0.5, // Ordre observé
};
```

### 2.5 Schemas dans la suggestion DAG (NOUVEAU)

Quand le DAG Suggester propose un workflow, il doit inclure les **schemas des tools** pour que l'IA
puisse remplir les arguments correctement.

#### Structure actuelle de `SuggestedDAG`

```typescript
interface SuggestedDAG {
  dagStructure: DAGStructure;
  confidence: number;
  rationale: string;
  dependencyPaths?: DependencyPath[];
  alternatives?: string[];
  warning?: string;
}
```

#### Ajout proposé : `toolSchemas`

```typescript
interface SuggestedDAG {
  // ... existant ...

  // NOUVEAU : Schemas des tools utilisés
  toolSchemas?: Record<string, ToolSchema>;
}

interface ToolSchema {
  description: string;
  inputSchema: JSONSchema; // Schema des arguments
  requiredInputs: string[]; // Champs obligatoires
  optionalInputs?: string[]; // Champs optionnels
  outputSchema?: JSONSchema; // Schema du résultat (pour chaînage)
  examples?: ToolExample[]; // Exemples d'utilisation
}

interface ToolExample {
  description: string;
  input: Record<string, unknown>;
  output?: unknown;
}
```

#### Exemple de réponse enrichie

```json
{
  "dagStructure": {
    "tasks": [
      { "id": "t1", "tool": "db:query", "arguments": {}, "dependsOn": [] },
      { "id": "t2", "tool": "json:transform", "arguments": {}, "dependsOn": ["t1"] }
    ]
  },
  "confidence": 0.85,
  "rationale": "Query puis transform est un pattern commun",
  "dependencyPaths": [
    { "from": "db:query", "to": "json:transform", "explanation": "query result → transform input" }
  ],
  "toolSchemas": {
    "db:query": {
      "description": "Execute SQL query",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "SQL query" },
          "params": { "type": "array", "description": "Query parameters" }
        },
        "required": ["query"]
      },
      "requiredInputs": ["query"],
      "outputSchema": { "type": "array", "items": { "type": "object" } }
    },
    "json:transform": {
      "description": "Transform JSON data",
      "inputSchema": {
        "type": "object",
        "properties": {
          "data": { "description": "Input data (from previous task)" },
          "template": { "type": "string", "description": "JMESPath expression" }
        },
        "required": ["data", "template"]
      },
      "requiredInputs": ["data", "template"]
    }
  }
}
```

#### Avantages

1. **L'IA sait quoi remplir** : Les `requiredInputs` indiquent ce qui est obligatoire
2. **Chaînage clair** : `outputSchema` de t1 → `inputSchema.data` de t2
3. **Exemples** : L'IA peut s'inspirer des exemples
4. **Validation possible** : On peut valider les args AVANT exécution

#### Implémentation

Le DAG Suggester récupère les schemas depuis les MCP servers :

```typescript
async function enrichWithSchemas(dag: SuggestedDAG): Promise<SuggestedDAG> {
  const toolIds = dag.dagStructure.tasks.map((t) => t.tool);
  const schemas: Record<string, ToolSchema> = {};

  for (const toolId of new Set(toolIds)) {
    const [serverId, toolName] = toolId.split(":");
    const client = mcpClients.get(serverId);
    if (client) {
      const toolDef = await client.getToolDefinition(toolName);
      schemas[toolId] = {
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
        requiredInputs: toolDef.inputSchema.required || [],
        // outputSchema si disponible
      };
    }
  }

  return { ...dag, toolSchemas: schemas };
}
```

---

## 3. Sequence vs Dependency : Clarification

### 3.1 Définitions actuelles

| Edge Type    | Source          | Sémantique                                |
| ------------ | --------------- | ----------------------------------------- |
| `dependency` | DAG `dependsOn` | A **doit** finir avant B (causalité)      |
| `sequence`   | Traces code     | A **a été observé** avant B (corrélation) |

### 3.2 Le problème

Dans les deux cas, on a "A avant B". La différence est subtile :

- `dependency` = intention explicite du développeur/IA
- `sequence` = observation empirique

### 3.3 Options

**Option A : Garder les deux**

- `dependency` = forte confiance (explicit)
- `sequence` = faible confiance (inferred)
- La différence est capturée par `edge_source` (template vs observed)

**Option B : Fusionner en un seul type**

- Utiliser uniquement `edge_source` pour la confiance
- Simplifier le modèle

**Option C : Renommer pour clarifier**

- `dependency` → `explicit_dependency`
- `sequence` → `observed_sequence`

### 3.4 Recommandation

**Option A** - Garder les deux car la sémantique EST différente :

- `dependency` implique une **nécessité** (output de A utilisé par B)
- `sequence` implique juste un **pattern temporel** observé

---

## 4. DAG → Capability : Faut-il créer une capability ?

### 4.1 État actuel

- `execute_code` avec succès → Peut créer une capability (eager learning)
- `execute_dag` avec succès → Crée des edges, **mais pas de capability**

### 4.2 Question

> Un DAG réussi devrait-il devenir une capability réutilisable ?

### 4.3 Options

**Option A : Oui - Le DAG devient une capability**

```typescript
interface Capability {
  id: string;
  intent: string;

  // Deux formes possibles
  code?: string; // Pour code_execution
  dagStructure?: DAGStructure; // NOUVEAU - Pour DAG

  sourceType: "code" | "dag";
  toolsUsed: string[];
}
```

**Avantages :**

- Uniformise le modèle
- Un DAG réussi peut être re-suggéré comme capability
- Permet de "promouvoir" un DAG en capability

**Inconvénients :**

- Deux formats de capability à gérer
- Complexifie le matcher

**Option B : Non - DAG et Capability restent séparés**

Le DAG enrichit le graphe (edges), mais ne crée pas de capability. Les capabilities sont réservées
au code.

**Avantages :**

- Modèle simple
- Séparation claire des responsabilités

**Inconvénients :**

- On perd la possibilité de "rejouer" un DAG appris

**Option C : Hybride - DAG peut être "compilé" en capability code**

Quand un DAG réussit, on génère le code équivalent :

```typescript
// DAG original
{ tasks: [
  { id: "t1", tool: "fs:read", args: {...}, dependsOn: [] },
  { id: "t2", tool: "json:parse", args: {...}, dependsOn: ["t1"] }
]}

// Capability générée (code)
const t1 = await mcp.fs.read({...});
const t2 = await mcp.json.parse({...});
return t2;
```

### 4.4 Recommandation

**Option A** semble la plus cohérente. Une capability peut avoir deux formes d'implémentation
(`code` ou `dag`), mais représente toujours "une procédure apprise pour un intent".

---

## 5. Architecture unifiée : `pml_discover` et `pml_execute`

### 5.1 Le problème des APIs fragmentées

Actuellement, l'IA peut "bypass" le système GraphRAG en utilisant `execute_code` directement :

```
execute_dag:  Intent → Recherche → Suggestion → Exécution → Learning ✅
execute_code: Code → Exécution → (traces mal exploitées) ❌
```

On veut que **tout** passe par le même système d'apprentissage.

### 5.2 Solution : Deux APIs unifiées

#### `pml_discover` - Découverte unifiée

```typescript
pml_discover({
  intent: "lire et parser un fichier JSON",

  // Filtres optionnels
  filter?: {
    type?: "tool" | "capability" | "all",  // default: "all"
    minScore?: number,
  },

  limit?: number,  // default: 10
})

// Retourne
{
  results: [
    { type: "capability", id: "cap_123", intent: "...", score: 0.92,
      source: { type: "code", code: "..." } },
    { type: "tool", id: "fs:read", description: "...", score: 0.85 },
    { type: "capability", id: "cap_456", intent: "...", score: 0.78,
      source: { type: "dag", dagStructure: {...} } },
  ]
}
```

#### `pml_execute` - Exécution unifiée

```typescript
pml_execute({
  intent: "analyser ce fichier JSON et extraire les utilisateurs actifs",

  // Optionnel - si l'IA veut forcer une implémentation
  implementation?: {
    type: "code" | "dag",
    code?: string,
    dagStructure?: DAGStructure,
  }
})
```

### 5.3 Flow de `pml_execute`

```
┌─────────────────────────────────────────────────────┐
│                    INTENT                           │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│  Implementation fournie ?                           │
└─────────────────────┬───────────────────────────────┘
                      │
         ┌────────────┴────────────┐
         ▼                         ▼
       OUI                        NON
         │                         │
         ▼                         ▼
   Exécute le code/dag      Recherche dans graphe :
   fourni par l'IA          - Tools qui matchent
         │                  - Capabilities (code/dag)
         │                         │
         │            ┌────────────┴────────────┐
         │            ▼                         ▼
         │      Confiance haute           Confiance basse
         │      (> seuil)                 (< seuil)
         │            │                         │
         │            ▼                         ▼
         │      EXÉCUTE                   RETOURNE
         │      (speculation)             suggestions
         │            │                         │
         └────────────┴────────────┬────────────┘
                                   ▼
                           Après succès :
                           - Crée/update capability
                           - Update edges (graphe)
                           - Trace structure (parallel, etc.)
```

### 5.4 Mapping avec les anciens tools

| Ancien tool               | Nouveau                                                  | Notes                     |
| ------------------------- | -------------------------------------------------------- | ------------------------- |
| `pml_search_tools`        | `pml_discover({ filter: { type: "tool" } })`             | Filtre sur tools          |
| `pml_search_capabilities` | `pml_discover({ filter: { type: "capability" } })`       | Filtre sur capabilities   |
| `pml_find_capabilities`   | `pml_discover`                                           | Même chose                |
| `pml_execute_dag`         | `pml_execute({ implementation: { type: "dag", ... } })`  | DAG explicite             |
| `pml_execute_code`        | `pml_execute({ implementation: { type: "code", ... } })` | Code explicite            |
| (nouveau)                 | `pml_execute({ intent: "..." })`                         | Laisse le système choisir |

### 5.5 Avantages

1. **Pas de bypass** : Tout passe par le même système
2. **Apprentissage unifié** : Code ou DAG, on apprend pareil
3. **Suggestion intelligente** : Le système propose tools ET capabilities
4. **Simplicité pour l'IA** : Deux tools au lieu de cinq

### 5.6 Speculation

Avec l'architecture unifiée, la speculation fonctionne pour les deux :

- Si le système connaît une capability pour l'intent → exécute en speculation
- Si le système construit un DAG depuis le graphe → même logique qu'avant
- Si confiance basse → retourne suggestions, l'IA choisit

---

## 6. HIL (Human-in-the-Loop) en mode Code

### 6.1 État actuel

Dans un DAG, chaque Task peut avoir `sideEffects: true` → trigger HIL approval.

### 6.2 En mode code

Options :

1. **Permission sets** - Déjà implémenté (`minimal`, `standard`, `privileged`)
2. **Analyse statique** - Détecter les tools à side effects avant exécution
3. **Runtime hooks** - Intercepter les appels dangereux

### 6.3 Recommandation

Utiliser les **permission sets** existants + enrichir avec une liste de tools "dangereux" qui
trigger HIL même en mode code.

---

## 7. Mode Definition vs Invocation (Fresh UI)

### 7.1 Contexte

Dans Fresh, on veut pouvoir afficher :

- **Mode Definition** : La structure abstraite du workflow (template)
- **Mode Invocation** : L'exécution réelle avec résultats

### 7.2 État actuel

Pas de distinction dans le data model. Un DAG/Capability est stocké une fois.

### 7.3 Proposition

```typescript
interface Capability {
  // ... existing fields

  // Definition (template)
  definition: {
    code?: string;
    dagStructure?: DAGStructure;
    parametersSchema?: JSONSchema; // Quels args le capability attend
  };

  // Invocations (historique)
  invocations?: CapabilityInvocation[]; // Ou dans une table séparée
}

interface CapabilityInvocation {
  id: string;
  capabilityId: string;
  timestamp: Date;
  arguments: Record<string, unknown>; // Args utilisés
  results: TaskResult[]; // Résultats
  success: boolean;
  durationMs: number;
}
```

### 7.4 Questions

- [ ] Stocker les invocations dans la même table ou séparée ?
- [ ] Combien d'invocations garder ? (limite de rétention)
- [ ] L'UI Fresh a-t-elle besoin de plus de détails ?

### 7.5 Clarification des edges par vue Cytoscape (NOUVEAU)

Les vues Definition et Invocation existent déjà dans Cytoscape. La différence principale :

| Vue            | Nœuds                                                      | Exemple                                  |
| -------------- | ---------------------------------------------------------- | ---------------------------------------- |
| **Definition** | Dédupliqués - chaque tool/capability apparaît **une fois** | `fs:read` (1 nœud même si appelé 3 fois) |
| **Invocation** | Un nœud **par appel**                                      | `fs:read_1`, `fs:read_2`, `fs:read_3`    |

#### Edges par vue

Les types d'edges devraient être différents selon la vue :

| Vue            | Edge types                                          | Rationale                                             |
| -------------- | --------------------------------------------------- | ----------------------------------------------------- |
| **Definition** | `dependency`, `provides`, `contains`, `alternative` | Relations **structurelles** entre types de nœuds      |
| **Invocation** | `sequence`, `contains`                              | Relations **temporelles** entre instances d'exécution |

#### Vue Definition : edges structurels

```
┌─────────────────────────────────────────┐
│         DEFINITION VIEW                  │
│    (nœuds dédupliqués par type)          │
├─────────────────────────────────────────┤
│                                         │
│   ┌─────────┐  provides   ┌─────────┐   │
│   │ fs:read │ ──────────▶ │json:parse│  │
│   └─────────┘   (strict)  └────┬────┘   │
│                           dependency    │
│                                │        │
│   ┌─────────┐              ▼        │
│   │http:post│ ◀────────────────────────│
│   └─────────┘  provides (partial)       │
│                                         │
│   Pas d'edge = potentiellement parallel │
└─────────────────────────────────────────┘
```

#### Vue Invocation : edges temporels

```
┌─────────────────────────────────────────┐
│         INVOCATION VIEW                  │
│    (un nœud par appel réel)              │
├─────────────────────────────────────────┤
│                                         │
│   ┌──────────┐ seq ┌──────────┐ seq    │
│   │fs:read_1 │────▶│json:parse│────────▶│
│   │  @0ms    │     │  @50ms   │         │
│   └──────────┘     └──────────┘         │
│                                         │
│   ┌──────────┐              │          │
│   │fs:read_2 │  (parallel)  │ seq      │
│   │  @10ms   │              │          │
│   └──────────┘              ▼          │
│                        ┌──────────┐    │
│                        │http:post │    │
│                        │  @120ms  │    │
│                        └──────────┘    │
│                                         │
│   Timestamps sur les nœuds              │
│   Parallel = timestamps qui overlap     │
└─────────────────────────────────────────┘
```

> **Note :** Le parallélisme en vue Invocation n'a pas besoin d'edge. C'est visible par les
> timestamps qui se chevauchent.

---

## 8. Apprentissage depuis le code (style Temporal)

### 8.1 Philosophie

Inspiré de [Temporal](https://temporal.io/) : le code s'exécute, on trace, on reconstruit la
structure après.

> "Il est impossible de visualiser le DAG avant l'exécution car le code est dynamique. Mais on peut
> reconstruire la structure depuis les traces."

### 8.2 Flow d'apprentissage

```
┌─────────────────────────────────────────────────────┐
│  L'IA écrit du code naturel                         │
│  (Promise.all, await, loops, etc.)                  │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│  Le code S'EXÉCUTE                                  │
│  Worker trace chaque tool call avec :               │
│  - ts (timestamp start)                             │
│  - durationMs                                       │
│  - parentTraceId (hiérarchie)                       │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│  RECONSTRUCTION de la structure                     │
│  - Timestamps séquentiels → sequence (Invocation)   │
│  - Timestamps overlap → parallel (pas d'edge)       │
│  - parentTraceId → contains (hierarchy)             │
│  - args/result match → dependency (Definition)      │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│  Stocker comme CAPABILITY                           │
│  - code original                                    │
│  - inferredStructure (le "DAG implicite")           │
│  - edges dans le graphe                             │
└─────────────────────────────────────────────────────┘
```

### 8.3 Structure de la Capability unifiée

```typescript
interface Capability {
  id: string;
  intent: string;

  // Source originale (ce que l'IA a écrit)
  source:
    | { type: "code"; code: string }
    | { type: "dag"; dagStructure: DAGStructure };

  // Structure RECONSTRUITE depuis l'exécution
  // Permet au suggester de travailler même avec du code
  inferredStructure: {
    tools: string[];
    edges: Array<{
      from: string;
      to: string;
      type: "sequence" | "dependency" | "contains"; // sequence=invoc, dependency=definition
    }>;
  };

  // Metadata
  toolsUsed: string[];
  executionCount: number;
  avgDurationMs: number;
  successRate: number;
}
```

### 8.4 Result Preview dans Layer Results (IMPLÉMENTÉ)

> **Note (2025-12-17):** Cette fonctionnalité est déjà implémentée pour supporter l'AIL implicite.

**Fichiers modifiés :**

- `src/dag/types.ts` : Ajout `result`, `resultPreview`, `resultSize` dans
  `ExecutionEvent.task_complete`
- `src/dag/controlled-executor.ts` : Génération du preview (240 chars) lors de `task_complete`
- `src/mcp/handlers/workflow-execution-handler.ts` : Propagation dans `layer_results`

**Format actuel :**

```json
{
  "layer_results": [{
    "taskId": "read_file",
    "status": "success",
    "output": {
      "executionTimeMs": 5.27,
      "resultPreview": "{\"content\":[{\"type\":\"text\"...", // 240 chars max
      "resultSize": 10247 // taille totale en bytes
    }
  }]
}
```

**À implémenter (futur) : `pml_get_task_result`**

Tool pour récupérer le résultat complet si le preview ne suffit pas :

```typescript
pml_get_task_result({
  workflow_id: string;
  task_id: string;
  // Params optionnels pour l'IA
  offset?: number;      // Début (pour pagination)
  limit?: number;       // Longueur max à retourner
  format?: "raw" | "pretty";  // Formatage JSON
})
```

> **À vérifier lors de l'implémentation :** S'assurer que le stockage des résultats complets est
> cohérent avec `CapabilityInvocation.results` (section 7.3) pour éviter la duplication.

### 8.5 Reconstruction des dépendances data (vrai `dependsOn`)

Pour reconstruire un DAG **ré-exécutable** depuis le code, on doit détecter les **dépendances data**
: si le résultat du nœud A est utilisé dans les arguments du nœud B, alors B dépend de A.

#### Types de dépendances data

Les nœuds peuvent être des **tools** OU des **capabilities**. La détection s'applique à tous :

| From                    | To                                                 | Exemple |
| ----------------------- | -------------------------------------------------- | ------- |
| Tool → Tool             | `json:parse` utilise le result de `fs:read`        |         |
| Tool → Capability       | `cap:analyze` utilise le result de `fs:read`       |         |
| Capability → Tool       | `http:post` utilise le result de `cap:transform`   |         |
| Capability → Capability | `cap:summarize` utilise le result de `cap:extract` |         |

> **Note:** L'edge `contains` (existant) capture la **hiérarchie d'appel** (qui appelle qui). Les
> dépendances data capturent le **flux de données** (qui utilise le résultat de qui). Ce sont deux
> informations complémentaires.

#### Ce qu'il faut tracer

Actuellement on trace `args` mais **pas `result`**. Il faut ajouter le result dans les deux types
d'événements :

> **Note (2025-12-16):** Story 7.6 (Algorithm Observability) ne couvre PAS ceci. Story 7.6 trace les
> décisions algorithmiques (scores de CapabilityMatcher, DAGSuggester), pas les résultats
> d'exécution. Le traçage de `result` est **nouveau travail**.

**1. Pour `tool_end` (worker-bridge.ts ligne ~426) :**

```typescript
this.traces.push({
  type: "tool_end",
  tool: toolId,
  traceId: id,
  ts: endTime,
  success: !isToolError,
  durationMs: durationMs,
  parentTraceId: parentTraceId,
  result: result, // ← AJOUTER
});
```

**2. Pour `capability_end` (code-generator.ts ligne ~104) :**

```typescript
// Dans le code généré pour les capabilities
__trace({
  type: "capability_end",
  capability: "${name}",
  capabilityId: "${capability.id}",
  success: __capSuccess,
  error: __capError?.message,
  result: __capResult, // ← AJOUTER (le retour de la capability)
});
```

#### Algorithme de détection

```typescript
function detectDataDependencies(traces: TraceEvent[]): string[] {
  const dependsOn: string[] = [];

  for (const prevTrace of traces) {
    if (prevTrace.traceId === currentTrace.traceId) continue;
    if (prevTrace.ts >= currentTrace.ts) continue;

    // Si le result de prevTrace est dans les args de currentTrace
    if (containsValue(currentTrace.args, prevTrace.result)) {
      dependsOn.push(prevTrace.traceId);
    }
  }

  return dependsOn;
}

function containsValue(args: unknown, result: unknown): boolean {
  const argsStr = JSON.stringify(args);
  const resultStr = JSON.stringify(result);

  // Match exact
  if (argsStr.includes(resultStr)) return true;

  // Match partiel (pour les champs extraits d'un objet)
  if (typeof result === "object" && result !== null) {
    for (const val of Object.values(result)) {
      if (argsStr.includes(JSON.stringify(val))) return true;
    }
  }

  return false;
}
```

#### Exemple

```typescript
// Traces
t1: { tool: "fs:read", args: { path: "config.json" }, result: { content: '{"url":"..."}' } }
t2: { tool: "json:parse", args: { json: '{"url":"..."}' }, result: { url: "..." } }
t3: { tool: "http:fetch", args: { url: "..." }, result: { data: [...] } }

// DAG reconstruit avec vraies dépendances
{
  tasks: [
    { id: "t1", tool: "fs:read", dependsOn: [] },
    { id: "t2", tool: "json:parse", dependsOn: ["t1"] },     // t2.args contient t1.result
    { id: "t3", tool: "http:fetch", dependsOn: ["t2"] },     // t3.args contient t2.result
  ]
}
```

### 8.6 Ce que ça change pour le DAG Suggester

#### Changement clé : `dependsOn` inféré depuis schemas

**Avant :** L'IA devait écrire manuellement les `dependsOn` dans le DAG.

**Maintenant :** Le suggester **infère** les `dependsOn` depuis les `provides` edges (basés sur
schemas).

```
Schemas (outputA ∩ inputB) → provides edge → DAG Suggester → dependsOn (inféré)
```

L'IA reçoit un DAG avec `dependsOn` **pré-rempli**, elle n'a plus qu'à compléter les arguments.

#### Multiple dependsOn (fan-in)

Un task peut dépendre de **plusieurs** tasks - c'est le pattern fan-in :

```
┌─────────┐
│ fs:read │──────┐
└─────────┘      │ provides
                 ▼
┌─────────┐    ┌─────────────┐
│ db:query│───▶│ merge:data  │  dependsOn: ["t1", "t2"]
└─────────┘    └─────────────┘
  provides
```

Le suggester détecte tous les `provides` entrants et les traduit en `dependsOn[]`.

#### Pas de distinction explicit/inferred

On ne marque pas si le `dependsOn` vient du suggester ou de l'IA - c'est juste du `dependsOn`.

#### `provides` ≠ `dependsOn` - Concepts complémentaires

| Concept     | Niveau                 | Relation                       | Vue                 |
| ----------- | ---------------------- | ------------------------------ | ------------------- |
| `provides`  | **Types** d'outils     | `toolA.outputs → toolB.inputs` | Definition (graphe) |
| `dependsOn` | **Instances** de tasks | `task_2 attend task_1`         | DAG (exécution)     |

**Pourquoi les deux sont nécessaires :**

1. **`provides`** capture la **potentialité** de dépendance basée sur les **types de données**.
   - Existe dans le **graphe** entre les définitions de tools
   - Calculé depuis les schemas : `outputSchema(A) ∩ inputSchema(B)`
   - Ne change pas entre exécutions

2. **`dependsOn`** capture la **dépendance réelle** dans une exécution **spécifique**.
   - Existe dans le **DAG** entre les instances de tasks
   - Inféré par le suggester depuis les `provides` edges
   - Peut varier selon l'intent et le contexte

**Flux :**

```
Schemas → provides (graph) → DAG Suggester → dependsOn (DAG)
                                    ↑
                              Intent + context
```

Le suggester lit les `provides` edges et, en fonction de l'intent, crée les `dependsOn` appropriés
dans le DAG proposé.

### 8.7 Limites de la reconstruction et mitigations

#### Limites identifiées

| Limite                    | Description                                                                  | Impact                                 |
| ------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| **Dynamique**             | Chaque exécution = un chemin. Les branches non explorées ne sont pas tracées | DAG incomplet pour code avec `if/else` |
| **Matching partiel**      | Si on utilise `result.data.items[0].id`, le match JSON peut rater            | Faux négatifs sur dépendances          |
| **Side effects externes** | "Write file A puis read file B" sans lien data                               | Dépendances invisibles                 |
| **Closures/État**         | Variables capturées hors du flow tracé                                       | Dépendances implicites manquées        |
| **Loops**                 | Boucles dynamiques avec nombre variable d'itérations                         | Structure non-DAG                      |

#### Pistes de mitigation

##### 1. Dry Run (Safe-to-Fail Execution)

Exécuter le code en mode "exploration" pour découvrir les branches :

```typescript
interface DryRunConfig {
  mode: "explore"; // Explorer toutes les branches
  maxBranches: number; // Limite de branches à explorer
  failSafe: true; // Les erreurs ne cassent pas l'exploration
  collectTraces: true; // Collecter les traces de toutes les branches
}

// Résultat : traces de TOUTES les branches explorées
const branches = await dryRun(code, config);
// branches[0] = traces si condition A vraie
// branches[1] = traces si condition A fausse
```

**Avantages :**

- Découvre les chemins alternatifs
- Permet de construire un DAG plus complet
- Identifie les branches non couvertes

##### 2. Mock d'arguments

Injecter des arguments fictifs pour explorer des chemins spécifiques :

```typescript
interface MockConfig {
  argMocks: Record<string, unknown>; // Forcer certains args
  // Exemple: { "config.env": "production" } → explore la branche prod
}

const traces = await executeWithMocks(code, mockConfig);
```

**Use cases :**

- Tester le comportement avec différentes configs
- Explorer les branches error handling
- Valider les chemins edge cases

##### 3. Mock de résultats

Simuler les résultats de tools pour éviter les side effects :

```typescript
interface ResultMockConfig {
  toolMocks: Record<string, unknown>; // Simuler les résultats
  // Exemple: { "http:post": { status: 500 } } → explore la branche erreur
}

const traces = await executeWithResultMocks(code, resultMockConfig);
```

**Use cases :**

- Tester error handling sans vraies erreurs
- Explorer les branches de retry/fallback
- Éviter les side effects réels (DB writes, API calls)

##### 4. Combinaison : Exploration complète

```typescript
// Découvrir le DAG complet d'une capability
async function exploreCapability(capabilityId: string): Promise<CompleteDAG> {
  const capability = await getCapability(capabilityId);

  // 1. Exécution normale → chemin principal
  const mainPath = await execute(capability);

  // 2. Dry run avec mocks → branches alternatives
  const altPaths = await Promise.all([
    executeWithMocks(capability, { "config.env": "staging" }),
    executeWithResultMocks(capability, { "http:get": { error: true } }),
    // ... autres scénarios
  ]);

  // 3. Fusionner tous les chemins en un DAG complet
  return mergePathsToDAG([mainPath, ...altPaths]);
}
```

##### 5. Annotations explicites (fallback)

Pour les cas vraiment complexes, permettre des annotations :

```typescript
// Dans le code de la capability
// @pml-depends: ["fs:read", "config:load"]
// @pml-branches: ["success", "error", "retry"]
const result = await complexOperation();
```

Ces annotations seraient lues par le système pour enrichir le DAG inféré.

#### Priorité des mitigations

| Mitigation           | Complexité | Valeur     | Priorité                  |
| -------------------- | ---------- | ---------- | ------------------------- |
| Dry run safe-to-fail | Moyenne    | Haute      | P1 - Phase future         |
| Mock de résultats    | Faible     | Haute      | P1 - Facile à implémenter |
| Mock d'arguments     | Faible     | Moyenne    | P2                        |
| Exploration complète | Haute      | Très haute | P3 - Long terme           |
| Annotations          | Faible     | Basse      | P4 - Fallback             |

> **Note :** Ces mitigations sont pour une phase future. La Phase 1-2 du plan actuel couvre 80-90%
> des cas d'usage avec la reconstruction basique depuis traces.

### 8.8 Modular Code Operations Tracing (IMPLÉMENTÉ - Phase 0/1)

> **Status:** ✅ COMPLETE (2025-12-26) **Commits:** c348a58, edf2d40, d878ed8, 438f01e, 0fb74b8

#### Problème résolu

Les opérations JavaScript modulaires (`code:filter`, `code:map`, etc.) n'apparaissaient **pas** dans
les traces d'exécution, rendant impossible l'apprentissage SHGAT de ces patterns.

**Avant :**

```typescript
executed_path = ["db:query"]; // ❌ Missing code operations
```

**Après :**

```typescript
executed_path = ["db:query", "code:filter", "code:map", "code:reduce"]; // ✅ Complete
```

#### Architecture (Option B)

Le problème était que les tâches `code_execution` passaient par `DenoSandboxExecutor` sans tracing,
alors que les tools MCP passaient par `WorkerBridge.callTool()` qui émet des traces.

**Solution : Router les code tasks via WorkerBridge**

```
workflow-execution-handler
  ↓ creates WorkerBridge
  ↓ passes to ControlledExecutor
ControlledExecutor.executeTask()
  ↓ detects code_execution task
  ↓ routes to WorkerBridge.executeCodeTask()
WorkerBridge.executeCodeTask(tool, code, context)
  ↓ emits tool_start("code:filter")
  ↓ executes code in Worker sandbox
  ↓ emits tool_end("code:filter", result, duration)
Traces collected → executedPath
  ↓
SHGAT learns from complete traces ✅
```

#### Implémentation

**1. WorkerBridge.executeCodeTask()** (`src/sandbox/worker-bridge.ts:454-543`)

Nouvelle méthode qui exécute du code et émet des traces comme un pseudo-tool :

```typescript
async executeCodeTask(
  toolName: string,      // "code:filter", "code:map", etc.
  code: string,          // TypeScript code to execute
  context?: Record<string, unknown>,
  toolDefinitions: ToolDefinition[] = [],
): Promise<ExecutionResult> {
  const traceId = `code-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const startTime = Date.now();

  // Emit tool_start trace for pseudo-tool
  this.traces.push({
    type: "tool_start",
    tool: toolName,  // "code:filter"
    traceId,
    ts: startTime,
  });

  // Execute in Worker sandbox (permissions: "none")
  const result = await this.execute(code, toolDefinitions, context);

  // Emit tool_end trace
  this.traces.push({
    type: "tool_end",
    tool: toolName,
    traceId,
    ts: endTime,
    success: result.success,
    durationMs: endTime - startTime,
    result: result.result,
  });

  return result;
}
```

**2. ControlledExecutor routing** (`src/dag/controlled-executor.ts`)

- **Field** (line 101): `private workerBridge: WorkerBridge | null = null`
- **Setter** (lines 132-144): `setWorkerBridge(workerBridge)`
- **Routing logic** (lines 726-728):

```typescript
if (taskType === "code_execution") {
  // Phase 0: Use WorkerBridge for pseudo-tool tracing
  if (this.workerBridge && task.tool) {
    return await this.executeCodeTaskViaWorkerBridge(task, previousResults);
  }

  // Fallback: DenoSandboxExecutor (no tracing)
  // ...
}
```

**3. Integration** (`src/mcp/handlers/workflow-execution-handler.ts:398`)

```typescript
controlledExecutor.setDAGSuggester(deps.dagSuggester);
controlledExecutor.setLearningDependencies(deps.capabilityStore, deps.graphEngine);
// Phase 0: Set WorkerBridge for code execution task tracing
controlledExecutor.setWorkerBridge(context.bridge);
```

#### Détection des opérations (SWC)

**StaticStructureBuilder** détecte les opérations JavaScript et génère des pseudo-tools :

```typescript
// Detect array operation (e.g., users.filter(...))
if (arrayOps.includes(methodName)) {
  const nodeId = this.generateNodeId("task");

  // Extract original code via SWC span
  const span = n.span as { start: number; end: number } | undefined;
  const code = span ? this.originalCode.substring(span.start, span.end) : undefined;

  nodes.push({
    id: nodeId,
    type: "task",
    tool: `code:${methodName}`, // Pseudo-tool: "code:filter"
    code, // Original code: "users.filter(u => u.active)"
  });
}
```

**97 opérations pure** définies dans `src/capabilities/pure-operations.ts` :

- Array: filter, map, reduce, flatMap, find, some, every, sort, slice...
- String: split, replace, trim, toLowerCase, toUpperCase...
- Object: keys, values, entries, assign...
- Math: abs, max, min, round...

#### Conversion DAG

**StaticToDAGConverter** convertit les pseudo-tools en tâches `code_execution` :

```typescript
if (node.tool.startsWith("code:")) {
  const operation = node.tool.replace("code:", "");
  const code = node.code || generateOperationCode(operation);

  return {
    id: taskId,
    tool: node.tool, // Keep "code:filter" for tracing
    type: "code_execution",
    code, // Extracted code from SWC span
    sandboxConfig: {
      permissionSet: "minimal", // Pure operations are safe
    },
    metadata: { pure: isPureOperation(node.tool) },
    staticArguments: node.arguments,
  };
}
```

#### Bypass HIL pour opérations pures

**workflow-execution-handler.ts** skip la validation HIL pour les opérations pures :

```typescript
if (taskType === "code_execution") {
  // Pure operations NEVER require validation (Phase 1)
  if (task.metadata?.pure === true || isPureOperation(task.tool)) {
    log.debug(`Skipping validation for pure operation: ${task.tool}`);
    continue;
  }
  // ...
}
```

#### Impact sur l'apprentissage

**executedPath complet :**

```typescript
// Avant Phase 0
executed_path = ["db:query"];

// Après Phase 0
executed_path = ["db:query", "code:filter", "code:map", "code:reduce"];
```

**Graph construction :**

```typescript
// SHGAT voit maintenant TOUTES les opérations
graph.addNode("db:query", { type: "tool" });
graph.addNode("code:filter", { type: "tool" });
graph.addNode("code:map", { type: "tool" });
graph.addNode("code:reduce", { type: "tool" });

// Edges séquentiels
graph.addEdge("db:query", "code:filter", { type: "sequence", weight: 1.0 });
graph.addEdge("code:filter", "code:map", { type: "sequence", weight: 1.0 });
graph.addEdge("code:map", "code:reduce", { type: "sequence", weight: 1.0 });
```

**SHGAT K-head attention :**

```typescript
// Incidence matrix inclut maintenant les opérations code
connectivity = [
  //         cap_transform_data
  db:query:      1
  code:filter:   1  // ← SHGAT apprend
  code:map:      1  // ← SHGAT apprend
  code:reduce:   1  // ← SHGAT apprend
];

// K-head attention apprend des patterns
Head 1: "db → filter" pattern
Head 2: "filter+map branches" pattern
Head 3: "map → reduce aggregation" pattern
```

**Feature extraction (TraceStats) :**

```typescript
// executedPath complet permet le calcul de stats
const stats = await extractTraceFeatures(db, "code:filter", intent, context);
// historicalSuccessRate: 0.85
// cooccurrenceWithContext: 0.6
// sequencePosition: 0.5
```

#### Fichiers modifiés

| File                                             | Changes                                              | Lines                 |
| ------------------------------------------------ | ---------------------------------------------------- | --------------------- |
| `src/capabilities/pure-operations.ts`            | **NEW** - Registry of 97 pure operations             | -                     |
| `src/capabilities/static-structure-builder.ts`   | Added span extraction for code operations            | -                     |
| `src/capabilities/types.ts`                      | Added `code?: string` field to `StaticStructureNode` | -                     |
| `src/dag/static-to-dag-converter.ts`             | Convert pseudo-tools to `code_execution` tasks       | -                     |
| `src/dag/execution/task-router.ts`               | Add `isSafeToFail()` for pure operations             | -                     |
| `src/mcp/handlers/workflow-execution-handler.ts` | Bypass validation for pure ops, pass WorkerBridge    | 398                   |
| `src/sandbox/worker-bridge.ts`                   | Add `executeCodeTask()` method for tracing           | 454-543               |
| `src/dag/controlled-executor.ts`                 | Route code tasks through WorkerBridge                | 101, 132-144, 761-813 |

#### Documentation

- **Tech Spec (SHGAT):** `docs/sprint-artifacts/tech-spec-shgat-multihead-traces.md` (Section 13)
- **Architecture (SWC):** `docs/architecture/swc-static-structure-detection.md` (Core SWC, Literal
  Bindings)
- **ADR-032:** Sandbox Worker RPC Bridge

#### Bénéfices

**Avant :**

- ❌ Code operations invisible à SHGAT
- ❌ Can't learn "query → filter → map → reduce" patterns
- ❌ TraceStats incomplete

**Après :**

- ✅ All operations in graph (MCP + code)
- ✅ K-head attention learns modular patterns
- ✅ TraceStats computed for code operations
- ✅ Feature extraction works on complete traces

---

## 9. Plan d'implémentation

### Phase 1 : Enrichir le tracing (Quick Win)

1. **Ajouter `result` dans les traces :**
   - `tool_end` dans `worker-bridge.ts` ligne ~426
   - `capability_end` dans `code-generator.ts` ligne ~104
2. Modifier `execution-learning.ts` pour utiliser les timestamps (`ts`, `durationMs`)
3. **Ajouter edge type `provides` :**
   - Dans `edge-weights.ts` ligne 18 : ajouter `"provides"` à `EdgeType`
   - Dans `edge-weights.ts` ligne 34-39 : ajouter `provides: 0.7` à `EDGE_TYPE_WEIGHTS`
   - Dans `012_edge_types_migration.ts` : pas de changement (column est TEXT)
4. Garder `sequence` pour la vue Invocation (ordre temporel)

**Fichiers :** `worker-bridge.ts`, `code-generator.ts`, `execution-learning.ts`, `edge-weights.ts`,
`types.ts` **Effort estimé :** 1-2 jours

### Phase 2 : Reconstruction DAG depuis traces

1. Implémenter `detectDataDependencies()` - analyser args/result pour trouver les dépendances
2. Implémenter `reconstructDAG()` - construire un DAGStructure complet depuis les traces
3. Combiner avec timestamps pour parallel vs sequence

**Fichiers :** `execution-learning.ts` (nouveau module `dag-reconstruction.ts`) **Effort estimé :**
2-3 jours

### Phase 3 : Capability unifiée

1. Ajouter `source` (code OU dag) dans `Capability`
2. Ajouter `reconstructedDAG` pour les capabilities code
3. Créer capability après TOUT succès (code ou DAG)

**Fichiers :** `capability-store.ts`, `types.ts`, migrations **Effort estimé :** 2-3 jours

### Phase 4 : API unifiée `pml_discover`

1. Créer nouveau handler `pml_discover` qui explore tools ET capabilities
2. Retourner résultats unifiés avec scores
3. Déprécier `pml_search_tools`, `pml_search_capabilities`, `pml_find_capabilities`

> **Spec séparée requise :** La gestion du contexte (verbosity levels, progressive disclosure,
> résumés de capabilities multi-parties) sera traitée dans une tech spec dédiée à `pml_discover`.
> Voir les handlers existants : `search-tools.ts`, `search-capabilities.ts`.

**Fichiers :** `gateway-server.ts`, handlers **Effort estimé :** 2-3 jours

### Phase 5 : API unifiée `pml_execute`

1. Créer nouveau handler `pml_execute`
2. Implémenter le flow : intent → recherche → suggestion/exécution
3. Déprécier `pml_execute_dag` et `pml_execute_code`
4. Assurer l'apprentissage unifié après succès

**Fichiers :** `gateway-server.ts`, `controlled-executor.ts`, handlers **Effort estimé :** 3-5 jours

### Phase 6 : Definition vs Invocation

1. Ajouter table `capability_invocations`
2. Logger chaque exécution avec args et résultats
3. Adapter l'API pour Fresh UI

**Fichiers :** `capability-store.ts`, migrations, API **Effort estimé :** 2-3 jours

### Ordre recommandé

```
Phase 1 (tracing) → Phase 2 (reconstruction) → Phase 3 (capability) → Phase 4 (discover) → Phase 5 (execute) → Phase 6 (invocations)
```

Les phases 1-3 sont le cœur du système d'apprentissage. Les phases 4-5 sont l'unification des APIs.
La phase 6 est pour l'UX Fresh.

---

## 10. Questions ouvertes (À discuter)

### Résolues ✅

1. ~~Option A vs B vs C pour DAG → Capability ?~~ → **Option A** : Capability = code OU dag
2. ~~Fusionner sequence/dependency ou garder les deux ?~~ → **Garder les deux** (sémantique
   différente)
3. ~~Comment l'IA choisit entre code et DAG ?~~ → **Elle ne choisit plus** : `pml_execute` unifié
4. ~~APIs fragmentées ?~~ → **Unification** : `pml_discover` + `pml_execute`
5. ~~Co-occurrence edge type ?~~ → **Non nécessaire** : parallélisme = absence d'edge entre nœuds
6. ~~Edges par vue Cytoscape ?~~ → **Definition** (dependency, provides, contains) vs **Invocation**
   (sequence)
7. ~~Explicit vs Inferred dependsOn ?~~ → **Simplifié** : `provides` (schemas) → `dependsOn` (DAG),
   pas de distinction

8. ~~Seuil de confiance pour speculation ?~~ → **Configurable** via fichier de config existant
9. ~~Rétention des invocations ?~~ → **Tout stocker**, archivage optionnel plus tard
10. ~~Migration des capabilities existantes ?~~ → **Breaking change** - pas de migration
11. ~~Backward compatibility ?~~ → **Breaking change** - pas de période de transition

---

## 10.1 Analyse d'impact (Breaking Changes)

### Vue d'ensemble par phase

| Phase | Changement                       | Breaking ? | Impact                |
| ----- | -------------------------------- | ---------- | --------------------- |
| **1** | `result` dans traces             | ❌ Non     | Interne, additif      |
| **1** | `provides` EdgeType              | ❌ Non     | Nouveau type, additif |
| **2** | `detectDataDependencies()`       | ❌ Non     | Nouveau module        |
| **3** | Capability `source: code \| dag` | ⚠️ **Oui** | Schema change         |
| **4** | Suppression `pml_search_*`       | ⚠️ **Oui** | APIs MCP              |
| **5** | Suppression `pml_execute_*`      | ⚠️ **Oui** | APIs MCP              |
| **6** | Table `capability_invocations`   | ❌ Non     | Nouvelle table        |

### Phase 3 : Impact sur Capability schema

```typescript
// AVANT
interface Capability {
  id: string;
  intent: string;
  code: string; // ← Toujours du code
}

// APRÈS
interface Capability {
  id: string;
  intent: string;
  source: // ← BREAKING: nouveau champ obligatoire
    | { type: "code"; code: string }
    | { type: "dag"; dagStructure: DAGStructure };
}
```

**Ce qui casse :**

- Code qui lit `capability.code` directement → doit lire `capability.source.code`
- Sérialisation/désérialisation
- Tests unitaires sur Capability

**Action requise :**

- Rechercher tous les usages de `capability.code` dans le codebase
- Mettre à jour vers `capability.source.type === "code" ? capability.source.code : null`

### Phases 4-5 : Impact sur APIs MCP

```
SUPPRIMÉ                        REMPLACÉ PAR
────────                        ────────────
pml_search_tools         →      pml_discover({ filter: { type: "tool" } })
pml_search_capabilities  →      pml_discover({ filter: { type: "capability" } })
pml_find_capabilities    →      pml_discover()
pml_execute_dag          →      pml_execute({ implementation: { type: "dag", ... } })
pml_execute_code         →      pml_execute({ implementation: { type: "code", ... } })
```

**Ce qui casse :**

1. **System prompts MCP** - Doivent référencer les nouveaux tools
2. **Tests d'intégration** - Tous les tests appelant les anciens tools
3. **Documentation utilisateur** - Guides d'utilisation à réécrire
4. **Clients externes** (si existants) - Doivent migrer

**Actions requises :**

| Fichier/Zone        | Action                                             |
| ------------------- | -------------------------------------------------- |
| `gateway-server.ts` | Supprimer handlers des anciens tools               |
| `system-prompts/`   | Mettre à jour avec `pml_discover` et `pml_execute` |
| `tests/`            | Migrer tous les tests vers nouvelles APIs          |
| `docs/`             | Réécrire la documentation MCP                      |

### Checklist pré-déploiement

- [ ] Tous les usages de `capability.code` migrés
- [ ] System prompts mis à jour
- [ ] Tests migrés et passent
- [ ] Documentation à jour
- [ ] Anciens handlers supprimés (pas de mode déprécié)

---

## 11. Références

- `docs/sprint-artifacts/bug-parallel-execution-tracking.md` - Bug original
- `docs/adrs/ADR-041-hierarchical-trace-tracking.md` - Trace hierarchy
- `docs/adrs/ADR-043-all-tools-must-succeed-capability-save.md` - Capability save rules
- `src/graphrag/dag/execution-learning.ts` - Learning from traces
- `src/graphrag/graph-engine.ts` - Graph updates
- `src/sandbox/worker-bridge.ts` - Trace collection
