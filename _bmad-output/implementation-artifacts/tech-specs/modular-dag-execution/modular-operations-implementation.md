# Implémentation des Opérations Modulaires

## Question : Comment gérer les opérations (filter, map, reduce) ?

Trois options pour intégrer les opérations modulaires dans le système existant.

---

## 📋 **Option 1 : Pseudo-Tools avec Préfixe `code:`** ⭐ RECOMMANDÉ

Les opérations sont traitées comme des **tools** avec un préfixe spécial.

### **Structure de Task**

```typescript
{
  id: "task_c1",
  type: "code_execution",
  tool: "code:filter",        // ← Pseudo-tool ID
  code: "return data.filter(x => x.active);",
  arguments: {},
  dependsOn: ["task_n1"],
  sandboxConfig: {
    permissionSet: "minimal"
  }
}
```

### **Avantages**

✅ **Compatible avec l'existant** : Toutes les fonctions qui utilisent `task.tool` marchent ✅
**Traces automatiques** : `executedPath` contient `["db:query", "code:filter", "code:map"]` ✅
**SHGAT apprend** : Les pseudo-tools sont traités comme des tools normaux ✅ **Pas de changement
DB** : Schéma `execution_trace` inchangé ✅ **Routing simple** : `task.type === "code_execution"` →
CodeExecutor

### **Modifications Nécessaires**

**1. Dans `StaticStructureBuilder`** :

```typescript
// Détection des array operations
if (callee.type === "MemberExpression") {
  const chain = this.extractMemberChain(callee);
  const methodName = chain[chain.length - 1];

  const arrayOps = ["filter", "map", "reduce", "flatMap", "find", "some", "every", "sort"];

  if (arrayOps.includes(methodName)) {
    const nodeId = this.generateNodeId("task");
    nodes.push({
      id: nodeId,
      type: "task",
      tool: `code:${methodName}`, // ← Pseudo-tool
      position,
      parentScope,
    });
    return true;
  }
}
```

**2. Dans `static-to-dag-converter.ts`** :

```typescript
function convertNodeToTask(node: StaticStructureNode): Task {
  if (node.type === "task" && node.tool.startsWith("code:")) {
    // Opération modulaire → code_execution task
    const operation = node.tool.replace("code:", "");
    const code = generateOperationCode(operation, node);

    return {
      id: `task_${node.id}`,
      type: "code_execution",
      tool: node.tool, // ← "code:filter"
      code,
      arguments: {},
      dependsOn: inferDependencies(node),
      sandboxConfig: { permissionSet: "minimal" },
    };
  }

  // MCP tool → mcp_tool task
  return {
    id: `task_${node.id}`,
    type: "mcp_tool",
    tool: node.tool,
    arguments: node.arguments,
    dependsOn: inferDependencies(node),
  };
}
```

**3. Génération de Code** :

```typescript
function generateOperationCode(operation: string, node: StaticStructureNode): string {
  // Extraire le callback de l'AST (déjà parsé par SWC)
  const callback = extractCallback(node);

  // Générer le code avec injection de dépendances
  const prevTaskId = node.dependencies[0]; // Task précédente

  return `
    const input = deps.${prevTaskId}.output;
    return input.${operation}(${callback});
  `;
}

// Exemple :
// operation: "filter"
// callback: "x => x.active"
// → Code généré :
// "const input = deps.task_n1.output; return input.filter(x => x.active);"
```

**4. Dans `worker-bridge.ts`** : Aucun changement !

Les pseudo-tools sont automatiquement tracés :

```typescript
// worker-bridge.ts:354-361
const executedPath = sortedTraces
  .filter((t) => t.type === "tool_end")
  .map((t) => t.tool);

// Résultat :
// ["db:query", "code:filter", "code:map", "code:sort"]
```

### **Exemple Complet**

**Code Agent :**

```typescript
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const active = users.filter((u) => u.active);
const names = active.map((u) => u.name);
```

**DAG Généré :**

```typescript
{
  tasks: [
    {
      id: "task_n1",
      type: "mcp_tool",
      tool: "db:query",
      arguments: { sql: "SELECT * FROM users" },
      dependsOn: [],
    },
    {
      id: "task_c1",
      type: "code_execution",
      tool: "code:filter", // ← Pseudo-tool
      code: "const input = deps.task_n1.output; return input.filter(u => u.active);",
      arguments: {},
      dependsOn: ["task_n1"],
    },
    {
      id: "task_c2",
      type: "code_execution",
      tool: "code:map", // ← Pseudo-tool
      code: "const input = deps.task_c1.output; return input.map(u => u.name);",
      arguments: {},
      dependsOn: ["task_c1"],
    },
  ];
}
```

**Trace Stockée :**

```typescript
{
  executedPath: ["db:query", "code:filter", "code:map"],
  toolsUsed: ["db:query", "code:filter", "code:map"],
  taskResults: [
    { taskId: "task_n1", tool: "db:query", success: true },
    { taskId: "task_c1", tool: "code:filter", success: true },
    { taskId: "task_c2", tool: "code:map", success: true }
  ]
}
```

**SHGAT voit :**

- Tool `"code:filter"` utilisé après `"db:query"`
- Tool `"code:map"` utilisé après `"code:filter"`
- Pattern : `db:query → code:filter → code:map`

---

## 📋 **Option 2 : Metadata dans Task (Sans tool ID)**

Les opérations sont des `code_execution` tasks sans `tool` ID, avec metadata.

### **Structure de Task**

```typescript
{
  id: "task_c1",
  type: "code_execution",
  tool: "",  // ← Vide
  code: "return data.filter(x => x.active);",
  metadata: {
    operation: "filter",
    operationType: "array",
    callback: "x => x.active"
  },
  arguments: {},
  dependsOn: ["task_n1"]
}
```

### **Avantages**

✅ **Semantic clarity** : Les opérations ne sont pas des "tools" ✅ **Metadata riche** : Plus
d'informations sur l'opération

### **Inconvénients**

❌ **Pas de tool ID** : `executedPath` vide ou générique ❌ **SHGAT ne voit pas** : Les opérations
ne sont pas dans `toolsUsed` ❌ **Changements DB** : Besoin d'ajouter `metadata` en JSONB ❌ **Plus
complexe** : Logique custom pour traces

### **Modifications Nécessaires**

**1. Ajouter `metadata` à Task** :

```typescript
export interface Task {
  // ... existing fields
  metadata?: {
    operation?: string;
    operationType?: "array" | "string" | "object";
    callback?: string;
  };
}
```

**2. Modifier les traces** :

```typescript
// Au lieu de :
executedPath: ["db:query", "code:filter", "code:map"];

// Devrait être :
executedPath: ["db:query"]; // ← Seulement MCP tools
operations: [
  { operation: "filter", input: "db:query" },
  { operation: "map", input: "filter" },
];
```

**3. SHGAT doit changer** :

SHGAT doit apprendre des `operations` en plus des `tools` → Changements majeurs.

---

## 📋 **Option 3 : Nouveau Type `computation`**

Créer un nouveau type de task distinct.

### **Structure de Task**

```typescript
{
  id: "task_c1",
  type: "computation",  // ← Nouveau type
  operation: "filter",
  code: "x => x.active",
  arguments: {},
  dependsOn: ["task_n1"]
}
```

### **Avantages**

✅ **Typage fort** : Distinction claire computation vs tool ✅ **Extensible** : Facile d'ajouter des
champs spécifiques

### **Inconvénients**

❌ **Changements massifs** : Toutes les fonctions qui switch sur `type` ❌ **Routing complexe** :
Nouvelle branche dans `task-router.ts` ❌ **Traces complexes** : Séparation tools vs computations ❌
**DB changes** : Nouveau type à supporter partout

---

## 🎯 **Comparaison des Options**

| Aspect               | Option 1 (Pseudo-Tools) | Option 2 (Metadata) | Option 3 (Nouveau Type) |
| -------------------- | ----------------------- | ------------------- | ----------------------- |
| **Compatibilité**    | ✅ 100%                 | ⚠️ 60%              | ❌ 30%                  |
| **Changements code** | ✅ Minimal              | ⚠️ Moyen            | ❌ Massif               |
| **SHGAT learning**   | ✅ Auto                 | ❌ Custom           | ❌ Custom               |
| **Traces**           | ✅ Auto                 | ⚠️ Custom           | ⚠️ Custom               |
| **Semantic clarity** | ⚠️ Moyennne             | ✅ Haute            | ✅ Haute                |
| **Extensibilité**    | ✅ Bonne                | ✅ Bonne            | ✅ Excellente           |
| **Temps implem**     | ✅ 1-2 jours            | ⚠️ 3-5 jours        | ❌ 1-2 semaines         |

---

## 🚀 **Recommandation : Option 1 (Pseudo-Tools)**

### **Pourquoi ?**

1. ✅ **Quick win** : Minimal changes, maximum impact
2. ✅ **Zero breaking changes** : Compatible avec tout l'existant
3. ✅ **SHGAT apprend automatiquement** : Pas de refactoring
4. ✅ **Traces correctes** : `executedPath` contient tout
5. ✅ **Convention claire** : Préfixe `code:` indique pseudo-tool

### **Convention de Nommage**

| Opération         | Tool ID                                   | Type   |
| ----------------- | ----------------------------------------- | ------ |
| Array operations  | `code:filter`, `code:map`, `code:reduce`  | Array  |
| String operations | `code:split`, `code:replace`, `code:trim` | String |
| Object operations | `code:Object.keys`, `code:Object.values`  | Object |
| JSON operations   | `code:JSON.parse`, `code:JSON.stringify`  | JSON   |
| Math operations   | `code:Math.max`, `code:Math.min`          | Math   |

### **Namespace Collision**

Aucun risque de collision avec MCP tools car :

- MCP tools : `server:tool` (ex: `db:query`, `filesystem:read`)
- Code operations : `code:operation` (ex: `code:filter`, `code:map`)
- Le préfixe `code:` est **réservé** pour les opérations

### **Détection dans le Code**

```typescript
function isCodeOperation(toolId: string): boolean {
  return toolId.startsWith("code:");
}

function isMCPTool(toolId: string): boolean {
  return !toolId.startsWith("code:");
}
```

### **Extensions Futures**

Avec cette convention, on peut facilement ajouter :

```typescript
// Custom transformations
"code:custom:myTransform";

// Async operations
"code:Promise.race";

// Complex patterns
"code:groupBy";
"code:deduplicate";
```

---

## 📝 **Plan d'Implémentation (Option 1)**

### **Phase 1 : Array Operations (2 jours)**

1. ✅ Modifier `StaticStructureBuilder` pour détecter array ops
2. ✅ Générer tasks avec `tool: "code:operation"`
3. ✅ Implémenter `generateOperationCode()`
4. ✅ Tests unitaires

### **Phase 2 : Validation & Tests (1 jour)**

1. ✅ Test E2E : Code agent → DAG → Exécution
2. ✅ Vérifier traces : `executedPath` correct
3. ✅ Vérifier SHGAT : Apprend les patterns

### **Phase 3 : Extensions (Optionnel)**

1. ⚠️ String operations
2. ⚠️ Object operations
3. ⚠️ JSON operations

---

## 🔍 **Exemple de Code Généré**

### **Input (Code Agent)**

```typescript
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const active = users.filter((u) => u.active && u.verified);
const enriched = active.map((u) => ({
  ...u,
  displayName: `${u.firstName} ${u.lastName}`,
}));
const sorted = enriched.sort((a, b) => a.displayName.localeCompare(b.displayName));
```

### **Output (DAG avec Pseudo-Tools)**

```typescript
{
  tasks: [
    // MCP Tool
    {
      id: "task_n1",
      type: "mcp_tool",
      tool: "db:query",
      arguments: { sql: "SELECT * FROM users" },
      dependsOn: [],
    },

    // Pseudo-Tool 1 : filter
    {
      id: "task_c1",
      type: "code_execution",
      tool: "code:filter",
      code: `
        const input = deps.task_n1.output;
        return input.filter(u => u.active && u.verified);
      `,
      dependsOn: ["task_n1"],
    },

    // Pseudo-Tool 2 : map
    {
      id: "task_c2",
      type: "code_execution",
      tool: "code:map",
      code: `
        const input = deps.task_c1.output;
        return input.map(u => ({
          ...u,
          displayName: \`\${u.firstName} \${u.lastName}\`
        }));
      `,
      dependsOn: ["task_c1"],
    },

    // Pseudo-Tool 3 : sort
    {
      id: "task_c3",
      type: "code_execution",
      tool: "code:sort",
      code: `
        const input = deps.task_c2.output;
        return input.sort((a, b) => a.displayName.localeCompare(b.displayName));
      `,
      dependsOn: ["task_c2"],
    },
  ];
}
```

### **Trace Résultante**

```typescript
{
  executedPath: [
    "db:query",
    "code:filter",
    "code:map",
    "code:sort"
  ],
  toolsUsed: [
    "db:query",
    "code:filter",
    "code:map",
    "code:sort"
  ],
  taskResults: [
    { taskId: "task_n1", tool: "db:query", output: {...}, success: true },
    { taskId: "task_c1", tool: "code:filter", output: {...}, success: true },
    { taskId: "task_c2", tool: "code:map", output: {...}, success: true },
    { taskId: "task_c3", tool: "code:sort", output: {...}, success: true }
  ]
}
```

### **SHGAT Apprend**

```typescript
// Pattern ETL Pipeline
shgat.registerCapability({
  id: "etl-pipeline-123",
  embedding: embed("get verified users with display names sorted"),
  toolsUsed: [
    "db:query",
    "code:filter",
    "code:map",
    "code:sort"
  ],
  successRate: 1.0
});

// Prochaine prédiction :
intent: "get active premium users sorted by name"
shgat.predict() → {
  "etl-pipeline-123": 0.92  // ← Reconnaît le pattern !
}
```

---

## ✅ **Conclusion**

**Option 1 (Pseudo-Tools avec `code:`)** est la meilleure approche car :

1. ✅ Changements minimaux
2. ✅ Compatible 100% avec existant
3. ✅ SHGAT apprend automatiquement
4. ✅ Traces correctes
5. ✅ Quick win (2-3 jours)

**Convention :** Préfixe `code:` réservé pour opérations modulaires.

**Pas de confusion** avec MCP tools (format `server:tool`).

**Extensible** pour futures opérations.
