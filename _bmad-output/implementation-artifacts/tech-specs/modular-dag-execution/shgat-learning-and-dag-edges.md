# SHGAT Learning & DAG Dependencies avec Tasks Modulaires

Analyse de ce que le **SHGAT** (Sparse Hierarchical Graph Attention Transformer) apprend et comment
les **edges** (dépendances) sont suivies dans le DAG, avec impact des tasks code execution
modulaires.

## 🧠 Ce que SHGAT Apprend (Actuellement)

SHGAT est un modèle de machine learning qui apprend des **traces d'exécution** pour prédire quelle
capability utiliser pour un nouvel intent.

### **1. Données Apprises par Trace**

Chaque trace d'exécution stocke :

| Donnée                | Type                | Exemple                             | Usage SHGAT            |
| --------------------- | ------------------- | ----------------------------------- | ---------------------- |
| **`intentEmbedding`** | `number[1024]`      | BGE-M3 embedding                    | Input pour prédiction  |
| **`executedPath`**    | `string[]`          | `["filesystem:read", "slack:send"]` | Séquence d'outils      |
| **`decisions`**       | `BranchDecision[]`  | `[{nodeId: "d1", outcome: "true"}]` | Branches prises        |
| **`taskResults`**     | `TraceTaskResult[]` | Résultats de chaque task            | Outcome (success/fail) |
| **`toolsUsed`**       | `string[]`          | `["filesystem:read", "slack:send"]` | Dédupliqué             |
| **`successRate`**     | `number`            | `0.85`                              | Reliability scoring    |
| **`durationMs`**      | `number`            | `150`                               | Performance            |

### **2. Architecture SHGAT : Message Passing**

SHGAT utilise un **SuperHyperGraph** avec 2 types de nœuds :

```
┌─────────────────────────────────────────────────┐
│  HYPERGRAPH STRUCTURE                           │
├─────────────────────────────────────────────────┤
│                                                 │
│  VERTICES (Tools)          HYPEREDGES (Caps)    │
│  ┌──────────────┐         ┌─────────────────┐  │
│  │ fs:read      │◄────────┤ read-and-send   │  │
│  │ fs:write     │         │ (capability)    │  │
│  │ slack:send   │◄────────└─────────────────┘  │
│  └──────────────┘                               │
│                                                 │
│  Phase 1: Vertex → Hyperedge                    │
│    - Agréger features des tools vers caps      │
│                                                 │
│  Phase 2: Hyperedge → Vertex                    │
│    - Propager features des caps vers tools     │
│                                                 │
└─────────────────────────────────────────────────┘
```

### **3. Training : Prioritized Experience Replay (PER)**

SHGAT apprend via **TD Error** (Temporal Difference) :

```typescript
TD Error = |predicted - actual|

// Exemple :
intentEmbedding = embed("read config and send to slack")
predicted = SHGAT.predict(intentEmbedding) // → 0.6 pour capability A
actual = 1 (success)                       // Capability A a réussi

TD Error = |0.6 - 1| = 0.4  // ← High priority pour re-training
```

**Priorité** : Plus le TD Error est élevé, plus la trace est prioritaire pour l'apprentissage.

### **4. Ce que SHGAT Apprend à Prédire**

```typescript
// Input :
intentEmbedding: number[1024]  // "read file and send to slack"
contextTools: string[]          // ["filesystem:read"] (déjà utilisés)

// Output :
scores: Map<string, number>     // Probabilité par capability
  → "read-and-send": 0.92       // ← Recommandation forte
  → "just-read": 0.15
  → "just-send": 0.08
```

SHGAT apprend :

- ✅ **Quels outils** sont souvent utilisés ensemble
- ✅ **Quelle séquence** d'outils fonctionne
- ✅ **Quelles décisions** (branches if/else) sont prises
- ✅ **Quel contexte** (tools déjà utilisés) influence le choix

---

## 🔗 Edges (Dépendances) dans le DAG

Le DAG contient **4 types d'edges** qui définissent les dépendances entre tasks :

### **1. Sequence Edges**

**Dépendances séquentielles** : Task B dépend de Task A

```typescript
{
  from: "n1",
  to: "n2",
  type: "sequence"
}
```

**Exemple :**

```typescript
const file = await mcp.filesystem.read_file({ path }); // n1
await mcp.slack.send({ content: file }); // n2

// Edge : n1 → n2 (sequence)
// n2 ne peut s'exécuter qu'après n1
```

**Impact modulaire :**

```typescript
const users = await mcp.db.query(...);        // n1
const active = users.filter(u => u.active);   // c1 (computation)
const names = active.map(u => u.name);        // c2 (computation)

// Edges :
// n1 → c1 (sequence)
// c1 → c2 (sequence)
```

### **2. Conditional Edges**

**Dépendances conditionnelles** : Task B s'exécute SI condition = outcome

```typescript
{
  from: "d1",      // Decision node
  to: "n2",        // Task node
  type: "conditional",
  outcome: "true"  // Condition result
}
```

**Exemple :**

```typescript
if (file.exists) { // d1
  await mcp.filesystem.read({ path }); // n2
} else {
  await mcp.filesystem.create({ path }); // n3
}

// Edges :
// d1 → n2 (conditional, outcome: "true")
// d1 → n3 (conditional, outcome: "false")
```

**SHGAT apprend :** Quelle branche est prise pour un intent donné.

### **3. Provides Edges**

**Data flow** : Task A produit des données utilisées par Task B

```typescript
{
  from: "n1",
  to: "n2",
  type: "provides",
  properties: ["content", "size"]  // Données fournies
}
```

**Exemple :**

```typescript
const file = await mcp.fs.read({ path }); // n1 (produit: content, size)
await mcp.slack.send({
  content: file.content, // ← Utilise "content" de n1
}); // n2

// Edge : n1 → n2 (provides: ["content"])
```

**Détection automatique** : Compare `inputSchema` de n2 avec `outputSchema` de n1.

**Impact modulaire :**

```typescript
const users = await mcp.db.query(...);     // n1 (produit: users array)
const active = users.filter(u => u.active); // c1 (utilise: users)

// Edge : n1 → c1 (provides: ["array"])
```

### **4. Contains Edges**

**Hiérarchie** : Capability contient des tasks

```typescript
{
  from: "cap_1",     // Capability
  to: "n1",          // Task
  type: "contains"
}
```

**Exemple :**

```typescript
// Capability "read-and-send"
{
  id: "cap_123",
  toolsUsed: ["filesystem:read", "slack:send"]
}

// Edges :
// cap_123 → n1 (contains) où n1.tool = "filesystem:read"
// cap_123 → n2 (contains) où n2.tool = "slack:send"
```

---

## 🚀 Impact des Tasks Modulaires sur SHGAT

### **Actuellement : Apprentissage Coarse-Grained**

```typescript
// Code agent :
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const active = users.filter(u => u.active);
const names = active.map(u => u.name);
const sorted = names.sort();

// Trace actuelle (fallback sandbox) :
{
  executedPath: ["db:query"],  // ← Seulement l'appel MCP
  toolsUsed: ["db:query"],
  success: true,
  durationMs: 150
}

// SHGAT apprend :
// "query users" → capability avec tool "db:query"
// ❌ Pas de connaissance du filtre, map, sort
```

### **Avec Tasks Modulaires : Apprentissage Fine-Grained**

```typescript
// Même code, mais DAG modulaire :
{
  executedPath: [
    "db:query",           // n1
    "code:filter",        // c1
    "code:map",           // c2
    "code:sort"           // c3
  ],
  toolsUsed: ["db:query", "code:filter", "code:map", "code:sort"],
  decisions: [],
  taskResults: [
    { taskId: "n1", output: {...}, success: true },
    { taskId: "c1", output: {...}, success: true },
    { taskId: "c2", output: {...}, success: true },
    { taskId: "c3", output: {...}, success: true }
  ],
  success: true,
  durationMs: 150
}

// SHGAT apprend :
// ✅ "query users" + "filter active" + "map names" + "sort" = pattern ETL
// ✅ Séquence : query → filter → map → sort
// ✅ Chaque opération réussit individuellement
```

### **Pattern Learning Amélioré**

SHGAT peut maintenant apprendre des **micro-patterns réutilisables** :

| Pattern                  | Executé Path                                                   | Réutilisable Pour         |
| ------------------------ | -------------------------------------------------------------- | ------------------------- |
| **ETL Pipeline**         | `["db:query", "code:filter", "code:map", "code:sort"]`         | Transformation de données |
| **Parallel Aggregation** | `["db:query", "fork", "code:filter1", "code:filter2", "join"]` | Traitement parallèle      |
| **Search Pattern**       | `["db:query", "code:filter", "code:find"]`                     | Recherche dans dataset    |
| **Validation Pattern**   | `["db:query", "code:every"]`                                   | Vérification qualité      |
| **Grouping Pattern**     | `["db:query", "code:reduce:groupBy"]`                          | Agrégation par clé        |

### **Edges Détaillés pour Learning**

Avec tasks modulaires, les edges sont plus riches :

```typescript
// DAG :
task_n1 (db:query)
    ↓ (sequence + provides: ["array"])
task_c1 (code:filter)
    ↓ (sequence + provides: ["filtered_array"])
task_c2 (code:map)
    ↓ (sequence + provides: ["mapped_array"])
task_c3 (code:sort)

// SHGAT apprend :
// - Séquence exacte : n1 → c1 → c2 → c3
// - Data flow : array → filtered_array → mapped_array → sorted_array
// - Opérations : filter, map, sort (dans cet ordre)

// Quand nouvel intent : "get sorted user names"
// SHGAT prédit : Capability avec ce pattern
```

### **Amélioration du Scoring**

Avec tasks modulaires, SHGAT peut scorer plus finement :

**Sans modularité :**

```typescript
intent: "get active users sorted by name"
SHGAT.predict() → {
  "query-users": 0.8,  // ← Trop générique
  "get-users": 0.7
}
```

**Avec modularité :**

```typescript
intent: "get active users sorted by name"
SHGAT.predict() → {
  "query-filter-map-sort": 0.95,  // ← Pattern exact appris
  "query-filter-only": 0.6,
  "query-users": 0.4
}
```

---

## 📊 Edges Multiples pour Même Paire de Tasks

Dans certains cas, il peut y avoir **plusieurs edges** entre deux tasks :

```typescript
// Task A produit des données ET Task B dépend séquentiellement
{
  from: "n1",
  to: "n2",
  edges: [
    { type: "sequence" },           // Ordre d'exécution
    { type: "provides", properties: ["content"] }  // Data flow
  ]
}
```

**Exemple :**

```typescript
const file = await mcp.fs.read({ path }); // n1
const upper = file.content.toUpperCase(); // c1 (computation)

// Edges :
// n1 → c1 : sequence (c1 après n1)
// n1 → c1 : provides (c1 utilise n1.content)
```

**SHGAT utilise :**

- **sequence** : Pour ordre d'exécution et parallélisation
- **provides** : Pour comprendre le data flow et prédire compatibilité

---

## 🎯 Recommandations pour Tasks Modulaires

### **1. Enrichir les Traces**

Avec tasks modulaires, enrichir les traces :

```typescript
{
  executedPath: [
    "db:query",
    "code:filter:active",      // ← Ajouter contexte
    "code:map:name",           // ← Ajouter propriété mappée
    "code:sort:ascending"      // ← Ajouter direction
  ],
  taskResults: [
    {
      taskId: "c1",
      operation: "filter",
      predicate: "u => u.active",  // ← Lambda code
      inputSize: 1000,
      outputSize: 250,             // ← Sélectivité
      success: true
    },
    {
      taskId: "c2",
      operation: "map",
      mapper: "u => u.name",
      inputSize: 250,
      outputSize: 250,
      success: true
    }
  ]
}
```

### **2. Détecter Patterns Compositionnels**

SHGAT peut apprendre des **compositions** :

```typescript
// Pattern simple :
"filter" → "map"

// Pattern composé :
"query" → "filter:active" → "map:name" → "sort"

// SHGAT apprend :
// Intent "get active user names sorted"
//   → Capability avec ce pattern exact
```

### **3. Parallélisation Intelligente**

Avec edges riches, SHGAT peut suggérer parallélisation :

```typescript
// Trace apprise :
{
  executedPath: [
    "db:query",
    "fork",
    "code:filter:active", // Parallèle
    "code:filter:premium", // Parallèle
    "join",
  ];
}

// SHGAT suggère : "Utiliser fork/join pour filtres indépendants"
```

---

## 🔍 Exemple Complet : ETL Pipeline

### **Code Agent**

```typescript
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const active = users.filter((u) => u.active && u.verified);
const enriched = active.map((u) => ({
  ...u,
  displayName: `${u.firstName} ${u.lastName}`,
}));
const sorted = enriched.sort((a, b) => a.displayName.localeCompare(b.displayName));
const top10 = sorted.slice(0, 10);
await mcp.slack.send({ users: top10 });
```

### **DAG Généré (Modulaire)**

```
n1: db:query
  ↓ (sequence + provides: ["users"])
c1: filter (active && verified)
  ↓ (sequence + provides: ["activeUsers"])
c2: map (enrich with displayName)
  ↓ (sequence + provides: ["enrichedUsers"])
c3: sort (by displayName)
  ↓ (sequence + provides: ["sortedUsers"])
c4: slice (0, 10)
  ↓ (sequence + provides: ["top10Users"])
n2: slack:send
```

### **Trace Stockée**

```typescript
{
  intentEmbedding: embed("get top 10 active verified users sorted by name and send to slack"),
  executedPath: [
    "db:query",
    "code:filter",
    "code:map",
    "code:sort",
    "code:slice",
    "slack:send"
  ],
  decisions: [],
  taskResults: [
    { taskId: "n1", output: {count: 1000}, success: true },
    { taskId: "c1", operation: "filter", inputSize: 1000, outputSize: 250, success: true },
    { taskId: "c2", operation: "map", inputSize: 250, outputSize: 250, success: true },
    { taskId: "c3", operation: "sort", inputSize: 250, outputSize: 250, success: true },
    { taskId: "c4", operation: "slice", inputSize: 250, outputSize: 10, success: true },
    { taskId: "n2", success: true }
  ],
  success: true,
  durationMs: 320
}
```

### **SHGAT Apprend**

1. **Pattern** : `query → filter → map → sort → slice → send`
2. **Sélectivité** : Filter réduit 1000 → 250 (25%)
3. **Séquence** : Operations dans cet ordre spécifique
4. **Intent** : "top 10 active verified users sorted" → ce pattern

### **Prochaine Fois**

```typescript
// Intent similaire :
"get top 5 premium users sorted by signup date"

// SHGAT prédit :
capability: "query-filter-map-sort-slice" (score: 0.95)

// Suggère DAG :
db:query → filter:premium → map:enrich → sort:signupDate → slice:5
```

---

## 🎯 Conclusion

### **Ce que SHGAT Apprend :**

| Donnée             | Actuel                       | Avec Tasks Modulaires                                                |
| ------------------ | ---------------------------- | -------------------------------------------------------------------- |
| **Tools utilisés** | `["db:query", "slack:send"]` | `["db:query", "code:filter", "code:map", "code:sort", "slack:send"]` |
| **Séquence**       | Outils MCP seulement         | Outils MCP + opérations code                                         |
| **Patterns**       | Coarse-grained               | Fine-grained (filter→map→sort)                                       |
| **Data flow**      | Implicit                     | Explicit via provides edges                                          |
| **Granularité**    | Capability-level             | Operation-level                                                      |

### **Edges Suivis :**

| Edge Type       | Usage             | Exemple                         |
| --------------- | ----------------- | ------------------------------- |
| **sequence**    | Ordre d'exécution | `n1 → c1 → c2`                  |
| **conditional** | Branches if/else  | `d1 → n2 (if true)`             |
| **provides**    | Data flow         | `n1 → c1 (provides: ["array"])` |
| **contains**    | Hiérarchie        | `cap → task`                    |

### **Impact Tasks Modulaires :**

✅ **Pattern learning** : Micro-patterns réutilisables ✅ **Better scoring** : Précision fine pour
intents ✅ **Compositional** : Apprendre compositions d'opérations ✅ **Parallelization** : Détecter
opportunités parallèles ✅ **Debugging** : Savoir exactement quelle opération échoue
