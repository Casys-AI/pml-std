# Two-Level DAG Architecture : Logique vs Physique

Proposition d'implémentation pour tracker toutes les opérations (learning complet) tout en
maintenant la performance (groupement intelligent).

## 🎯 **Objectif**

- ✅ **DAG logique** : Toutes les opérations sont des tasks → SHGAT apprend patterns complets
- ✅ **DAG physique** : Tasks fusionnées en layers → Exécution performante
- ✅ **Traces complètes** : executedPath contient toutes les opérations

---

## 🔄 **Loop Abstraction (Extension)**

> Voir [loop-abstraction.md](./loop-abstraction.md) pour la documentation complète.

### Problème des Boucles

Les boucles créent des répétitions qui ne généralisent pas bien pour SHGAT :

```typescript
// 3 itérations = 6 nodes
for (item of items) { click(item); fill(item); }
// → click, fill, click, fill, click, fill
```

### Solution : Abstraction au Niveau Logique

Contrairement à la fusion (niveau physique), les boucles sont abstraites au **niveau logique** :

```
loop_l1 (forOf: item of items)
  ├── task_n1: click (parentScope: l1)
  └── task_n2: fill (parentScope: l1)
```

SHGAT apprend : `loop:forOf → click → fill` (pattern universel)

### Complémentarité

| Optimisation | Niveau | But |
|--------------|--------|-----|
| **Loop Abstraction** | DAG Logique | Patterns généralisables pour SHGAT |
| **Fusion Séquentielle** | DAG Physique | Moins de layers/HIL |
| **Fork-Join Fusion** | DAG Physique | Parallélisation |

---

## 🏗️ **Architecture Two-Level**

```
Code Agent
    ↓
StaticStructureBuilder (parse SWC)
    ↓
DAG LOGIQUE (détaillé)
    ├─ task_1: code:reduce
    ├─ task_2: code:get_length
    ├─ task_3: code:divide
    └─ ... (une task par opération)
    ↓
DAG OPTIMIZER (fusion)
    ↓
DAG PHYSIQUE (groupé)
    └─ layer_1: [task_1, task_2, task_3] fusionnées
    ↓
EXECUTION (ControlledExecutor)
    ↓
TRACE GENERATION
    ↓
executedPath: ["code:reduce", "code:get_length", "code:divide"]
    ↓
SHGAT Learning (pattern complet)
```

---

## 📊 **Exemple Concret**

### **Code Agent**

```typescript
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const active = users.filter((u) => u.active);
const totalAge = active.reduce((s, u) => s + u.age, 0);
const count = active.length;
const avg = totalAge / count;
const rounded = Math.round(avg);
```

### **DAG Logique (6 tasks)**

```typescript
{
  tasks: [
    {
      id: "task_n1",
      type: "mcp_tool",
      tool: "db:query",
      dependsOn: [],
    },
    {
      id: "task_c1",
      type: "code_execution",
      tool: "code:filter",
      code: "return deps.task_n1.output.filter(u => u.active);",
      dependsOn: ["task_n1"],
    },
    {
      id: "task_c2",
      type: "code_execution",
      tool: "code:reduce",
      code: "return deps.task_c1.output.reduce((s, u) => s + u.age, 0);",
      dependsOn: ["task_c1"],
    },
    {
      id: "task_c3",
      type: "code_execution",
      tool: "code:get_length",
      code: "return deps.task_c1.output.length;",
      dependsOn: ["task_c1"],
    },
    {
      id: "task_c4",
      type: "code_execution",
      tool: "code:divide",
      code: "return deps.task_c2.output / deps.task_c3.output;",
      dependsOn: ["task_c2", "task_c3"],
    },
    {
      id: "task_c5",
      type: "code_execution",
      tool: "code:Math.round",
      code: "return Math.round(deps.task_c4.output);",
      dependsOn: ["task_c4"],
    },
  ];
}
```

### **Analyse de Dépendances**

```
Layer 0: task_n1 (db:query)
           ↓
Layer 1: task_c1 (filter)
           ↓
         ┌─┴─┐
Layer 2: task_c2 (reduce)  task_c3 (length)  ← PARALLÈLE
         └─┬─┘
           ↓
Layer 3: task_c4 (divide)
           ↓
Layer 4: task_c5 (round)
```

**Problème :** 5 layers séquentielles → 5 rounds de validation HIL → Lent

### **DAG Physique Optimisé (2 layers)**

```typescript
{
  physicalLayers: [
    // Layer 0 : MCP (ne peut pas fusionner)
    {
      tasks: [
        { id: "task_n1", tool: "db:query" }
      ]
    },

    // Layer 1 : Tout le reste fusionné
    {
      tasks: [
        {
          id: "task_fused_1",
          type: "code_execution",
          tool: "code:computation",  // Pseudo-tool générique
          code: `
            // Fused: filter + reduce + length + divide + round
            const active = deps.task_n1.output.filter(u => u.active);
            const totalAge = active.reduce((s, u) => s + u.age, 0);
            const count = active.length;
            const avg = totalAge / count;
            const rounded = Math.round(avg);
            return rounded;
          `,
          logicalTasks: ["task_c1", "task_c2", "task_c3", "task_c4", "task_c5"],
          dependsOn: ["task_n1"]
        }
      ]
    }
  ],

  // Mapping logique → physique
  mapping: {
    "task_c1": "task_fused_1",
    "task_c2": "task_fused_1",
    "task_c3": "task_fused_1",
    "task_c4": "task_fused_1",
    "task_c5": "task_fused_1"
  }
}
```

**Résultat :** 2 layers au lieu de 5 → Plus rapide, moins de HIL validations

### **Trace Générée (Complète)**

```typescript
{
  // Pour SHGAT : Vue logique complète
  executedPath: [
    "db:query",
    "code:filter",
    "code:reduce",
    "code:get_length",
    "code:divide",
    "code:Math.round"
  ],

  // Pour métriques : Vue physique
  physicalExecution: {
    layerCount: 2,
    taskCount: 2,
    totalTime: 35ms  // au lieu de 5 × 10ms = 50ms
  },

  // Détails pour chaque opération logique
  taskResults: [
    { taskId: "task_n1", tool: "db:query", output: [...], success: true },
    { taskId: "task_c1", tool: "code:filter", output: [...], success: true },
    { taskId: "task_c2", tool: "code:reduce", output: 2500, success: true },
    { taskId: "task_c3", tool: "code:get_length", output: 100, success: true },
    { taskId: "task_c4", tool: "code:divide", output: 25, success: true },
    { taskId: "task_c5", tool: "code:Math.round", output: 25, success: true }
  ]
}
```

---

## 🔧 **Implémentation : DAG Optimizer**

### **1. Détection des Groupes Fusionnables**

```typescript
interface FusionGroup {
  tasks: Task[];
  canFuse: boolean;
  reason?: string;
}

/**
 * Détermine si un groupe de tasks peut être fusionné
 */
function canFuseTasks(tasks: Task[]): { canFuse: boolean; reason?: string } {
  // Règle 1 : Toutes les tasks doivent être code_execution
  if (!tasks.every((t) => t.type === "code_execution")) {
    return { canFuse: false, reason: "Contains non-code tasks" };
  }

  // Règle 2 : Pas de MCP calls dans le code
  for (const task of tasks) {
    if (task.code?.includes("mcp.")) {
      return { canFuse: false, reason: "Contains MCP calls" };
    }
  }

  // Règle 3 : Permissions identiques
  const permSets = tasks.map((t) => t.sandboxConfig?.permissionSet ?? "minimal");
  if (new Set(permSets).size > 1) {
    return { canFuse: false, reason: "Different permission sets" };
  }

  // Règle 4 : Dépendances forment une chaîne ou un petit DAG
  if (!formsSimplePattern(tasks)) {
    return { canFuse: false, reason: "Complex dependency graph" };
  }

  return { canFuse: true };
}

/**
 * Vérifie si les dépendances forment un pattern simple
 */
function formsSimplePattern(tasks: Task[]): boolean {
  // Pattern 1 : Chaîne séquentielle (A → B → C)
  // Pattern 2 : Petit fork-join (A → B,C → D)
  // Pattern 3 : Parallèle pur (A,B,C avec même parent)

  const taskIds = new Set(tasks.map((t) => t.id));

  // Toutes les dépendances doivent pointer vers des tasks du groupe
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep) && !isExternalDep(dep)) {
        return false; // Dépendance vers l'extérieur
      }
    }
  }

  // Max 3 niveaux de profondeur
  const depth = computeDepth(tasks);
  return depth <= 3;
}
```

### **2. Stratégie de Groupement**

```typescript
/**
 * Optimise le DAG logique en DAG physique
 */
function optimizeDAG(logicalDAG: DAG): OptimizedDAG {
  const layers = computeLayers(logicalDAG);
  const physicalLayers: PhysicalLayer[] = [];

  for (const layer of layers) {
    // Séparer MCP tools vs code tasks
    const mcpTasks = layer.filter((t) => t.type === "mcp_tool");
    const codeTasks = layer.filter((t) => t.type === "code_execution");

    // MCP tasks : Ne jamais fusionner (side effects)
    for (const mcpTask of mcpTasks) {
      physicalLayers.push({
        tasks: [mcpTask],
        fusionApplied: false,
      });
    }

    // Code tasks : Fusionner si possible
    if (codeTasks.length > 1) {
      const groups = findFusionGroups(codeTasks);

      for (const group of groups) {
        if (group.canFuse && group.tasks.length > 1) {
          // Fusionner le groupe
          const fusedTask = fuseTasks(group.tasks);
          physicalLayers.push({
            tasks: [fusedTask],
            fusionApplied: true,
            logicalTasks: group.tasks.map((t) => t.id),
          });
        } else {
          // Garder séparées
          physicalLayers.push({
            tasks: group.tasks,
            fusionApplied: false,
          });
        }
      }
    } else {
      // Layer avec une seule task
      physicalLayers.push({
        tasks: codeTasks,
        fusionApplied: false,
      });
    }
  }

  return {
    physicalLayers,
    logicalDAG,
    mapping: buildMapping(logicalDAG, physicalLayers),
  };
}
```

### **3. Fusion de Tasks**

```typescript
/**
 * Fusionne plusieurs tasks en une seule
 */
function fuseTasks(tasks: Task[]): Task {
  // Trier par ordre de dépendances
  const sorted = topologicalSort(tasks);

  // Générer le code fusionné
  const fusedCode = generateFusedCode(sorted);

  // Collecter toutes les dépendances externes
  const externalDeps = new Set<string>();
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!tasks.find((t) => t.id === dep)) {
        externalDeps.add(dep);
      }
    }
  }

  return {
    id: `fused_${tasks[0].id}`,
    type: "code_execution",
    tool: "code:computation", // Pseudo-tool générique
    code: fusedCode,
    arguments: {},
    dependsOn: Array.from(externalDeps),
    sandboxConfig: tasks[0].sandboxConfig,
    metadata: {
      fusedFrom: tasks.map((t) => t.id),
      logicalTools: tasks.map((t) => t.tool),
    },
  };
}

/**
 * Génère le code TypeScript pour une task fusionnée
 */
function generateFusedCode(tasks: Task[]): string {
  const codeLines: string[] = [];
  const varMap = new Map<string, string>(); // taskId → variable name

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const varName = `result_${i}`;
    varMap.set(task.id, varName);

    // Extraire l'opération du code
    const operation = extractOperation(task.code);

    // Remplacer les références deps.task_X par les variables
    let code = operation;
    for (const [taskId, varName] of varMap) {
      code = code.replace(`deps.${taskId}.output`, varName);
    }

    codeLines.push(`const ${varName} = ${code};`);
  }

  // Retourner le dernier résultat
  const lastVar = `result_${tasks.length - 1}`;
  codeLines.push(`return ${lastVar};`);

  return codeLines.join("\n");
}

// Exemple de code généré :
// const result_0 = deps.task_c1.output.reduce((s, u) => s + u.age, 0);
// const result_1 = deps.task_c1.output.length;
// const result_2 = result_0 / result_1;
// const result_3 = Math.round(result_2);
// return result_3;
```

---

## 🎭 **Gestion des Layers dans ControlledExecutor**

### **Avant Optimisation**

```typescript
// DAG logique : 5 layers
Layer 0: [task_n1: db:query]
Layer 1: [task_c1: filter]
Layer 2: [task_c2: reduce, task_c3: length]  // Parallèle
Layer 3: [task_c4: divide]
Layer 4: [task_c5: round]

// ControlledExecutor :
for (let i = 0; i < 5; i++) {
  await executeLayer(i);  // 5 rounds
  if (requiresValidation(i)) {
    await waitForHILApproval();  // Potentiellement 5 validations
  }
}
```

### **Après Optimisation**

```typescript
// DAG physique : 2 layers
Layer 0: [task_n1: db:query]
Layer 1: [task_fused_1: computation (c1+c2+c3+c4+c5)]

// ControlledExecutor :
for (let i = 0; i < 2; i++) {
  await executeLayer(i);  // 2 rounds seulement
  if (requiresValidation(i)) {
    await waitForHILApproval();  // Max 2 validations
  }
}
```

**Gain :** 60% moins de rounds, moins de validations HIL.

---

## 📈 **Stratégies de Fusion Avancées**

### **Stratégie 1 : Fusion Séquentielle**

```typescript
// Chaîne A → B → C
// Fusionner si :
// - Toutes code_execution
// - Pas de branches
// - Même permission set

task_fused = { code: "A; B; C;" };
```

### **Stratégie 2 : Fusion Fork-Join**

```typescript
// Fork-join simple :
//     A
//    / \
//   B   C
//    \ /
//     D

// Fusionner en :
task_fused = {
  code: `
    const a = ...;
    const [b, c] = await Promise.all([
      Promise.resolve(B(a)),
      Promise.resolve(C(a))
    ]);
    const d = D(b, c);
    return d;
  `,
};
```

### **Stratégie 3 : Fusion Partielle**

```typescript
// Si trop de tasks, fusionner par blocs :
// A → B → C → D → E → F → G → H

// Fusionner en 3 blocs :
task_1 = { code: "A; B; C;" }; // Bloc 1
task_2 = { code: "D; E; F;" }; // Bloc 2
task_3 = { code: "G; H;" }; // Bloc 3

// Limite : Max 5 opérations par bloc
```

### **Stratégie 4 : Pas de Fusion sur MCP ou Side Effects**

```typescript
// Jamais fusionner :
// - MCP tool calls
// - Tasks avec permissionSet != "minimal"
// - Tasks avec intent (learning requis)

if (
  task.type === "mcp_tool" ||
  task.sandboxConfig?.permissionSet !== "minimal" ||
  task.intent
) {
  // Garder séparée
  return { canFuse: false };
}
```

---

## 🔍 **Trace Generation Post-Exécution**

```typescript
/**
 * Génère la trace logique complète depuis le DAG physique
 */
function generateLogicalTrace(
  optimizedDAG: OptimizedDAG,
  physicalResults: ExecutionResults,
): Trace {
  const executedPath: string[] = [];
  const taskResults: TaskResult[] = [];

  for (const physicalLayer of optimizedDAG.physicalLayers) {
    for (const physicalTask of physicalLayer.tasks) {
      const result = physicalResults.get(physicalTask.id);

      if (physicalTask.metadata?.fusedFrom) {
        // Task fusionnée : Décomposer en tasks logiques
        const logicalTaskIds = physicalTask.metadata.fusedFrom;
        const logicalTools = physicalTask.metadata.logicalTools;

        for (let i = 0; i < logicalTaskIds.length; i++) {
          executedPath.push(logicalTools[i]);

          taskResults.push({
            taskId: logicalTaskIds[i],
            tool: logicalTools[i],
            output: extractIntermediateResult(result, i),
            success: result.success,
            durationMs: result.durationMs / logicalTaskIds.length,
          });
        }
      } else {
        // Task normale
        executedPath.push(physicalTask.tool);

        taskResults.push({
          taskId: physicalTask.id,
          tool: physicalTask.tool,
          output: result.output,
          success: result.success,
          durationMs: result.durationMs,
        });
      }
    }
  }

  return {
    executedPath,
    taskResults,
    toolsUsed: Array.from(new Set(executedPath)),
    success: taskResults.every((r) => r.success),
    totalDurationMs: physicalResults.totalTime,
  };
}
```

---

## ✅ **Bénéfices de cette Architecture**

| Aspect               | Avant                            | Après                          |
| -------------------- | -------------------------------- | ------------------------------ |
| **Learning SHGAT**   | ❌ Incomplet (manque opérateurs) | ✅ Complet (toutes opérations) |
| **Chemins suggérés** | ❌ Partiels                      | ✅ Complets et réutilisables   |
| **Layers**           | ⚠️ N layers (N = nb opérations)  | ✅ ~2-3 layers (fusionnées)    |
| **HIL validations**  | ⚠️ Potentiellement N validations | ✅ ~2-3 validations            |
| **Overhead**         | ✅ Minimal mais incomplet        | ✅ Optimisé et complet         |
| **Parallélisation**  | ⚠️ Limitée                       | ✅ Automatique (fork-join)     |

---

## 🎯 **Plan d'Implémentation**

### **Phase 1 : DAG Logique Complet (3 jours)**

1. Étendre `StaticStructureBuilder` pour détecter TOUS les opérateurs
2. Créer pseudo-tools pour chaque opération
3. Générer DAG logique détaillé

### **Phase 2 : DAG Optimizer (2 jours)**

1. Implémenter `canFuseTasks()`
2. Implémenter `fuseTasks()`
3. Générer DAG physique optimisé

### **Phase 3 : Trace Generation (1 jour)**

1. Implémenter `generateLogicalTrace()`
2. Mapper résultats physiques → logiques
3. Extraire résultats intermédiaires

### **Phase 4 : Tests & Validation (2 jours)**

1. Tests E2E : Code → DAG logique → DAG physique → Trace
2. Vérifier SHGAT learning
3. Benchmarks performance

---

## 🔧 **Configuration Utilisateur**

```typescript
// Configuration dans le DAG :
{
  optimization: {
    enabled: true,
    strategy: "aggressive" | "conservative" | "none",

    // Aggressive : Fusionner au maximum
    // Conservative : Fusionner seulement séquences simples
    // None : Pas de fusion (debug)

    maxFusionSize: 5,  // Max opérations par fusion
    enableParallelization: true
  },

  tracing: {
    logicalView: true,   // Traces détaillées pour SHGAT
    physicalView: true,  // Métriques d'exécution
    debugMode: false     // Logs de fusion
  }
}
```

---

## 📝 **Exemple Complet**

```typescript
// Code agent :
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const active = users.filter((u) => u.age > 18 && u.verified);
const avgAge = active.reduce((s, u) => s + u.age, 0) / active.length;
const avgSalary = active.reduce((s, u) => s + u.salary, 0) / active.length;
const stats = { avgAge: Math.round(avgAge), avgSalary: Math.round(avgSalary) };

// DAG Logique (11 opérations) :
// task_n1: db:query
// task_c1: filter
// task_c2: reduce (age)
// task_c3: length
// task_c4: divide (avgAge)
// task_c5: round (avgAge)
// task_c6: reduce (salary)
// task_c7: length (duplicate)
// task_c8: divide (avgSalary)
// task_c9: round (avgSalary)
// task_c10: object literal

// DAG Physique (2 layers, 2 tasks) :
// Layer 0: task_n1 (db:query)
// Layer 1: task_fused_1 (filter + calculs fusionnés)

// Trace (vue logique) :
executedPath: [
  "db:query",
  "code:filter",
  "code:reduce",
  "code:get_length",
  "code:divide",
  "code:Math.round",
  "code:reduce",
  "code:get_length",
  "code:divide",
  "code:Math.round",
  "code:object_literal",
];

// SHGAT apprend le pattern COMPLET
// → Réutilisable pour "calculate average age and salary of active users"
```

---

## 🎨 **Affichage UI : Visualisation des Tâches Fusionnées**

### **Problématique**

Avec le DAG physique, l'interface affichait seulement les tâches fusionnées :

```
Layer 0: db:query (20ms)
Layer 1: computation (45ms)  ← Que s'est-il passé dedans ?
```

**Problème :** L'utilisateur ne voit pas les opérations atomiques qui ont été fusionnées.

**Solution :** Affichage deux niveaux dans le CodePanel/TraceTimeline.

---

### **Architecture d'Affichage**

```
Backend (Enrichissement des Traces)
    ↓
TraceTaskResult + Fusion Metadata
    ↓
    {
      taskId: "task_fused_1",
      tool: "code:computation",
      isFused: true,
      logicalOperations: [
        { toolId: "code:filter", durationMs: 15 },
        { toolId: "code:reduce", durationMs: 15 },
        { toolId: "code:Math.round", durationMs: 15 }
      ]
    }
    ↓
Frontend (Composants React)
    ↓
FusedTaskCard (Expandable)
    ↓
Affichage Hiérarchique
```

---

### **Implémentation Backend**

#### **1. Types TypeScript** (`src/capabilities/types.ts`)

```typescript
export interface LogicalOperation {
  /** Tool ID de l'opération logique (ex: "code:filter") */
  toolId: string;

  /** Durée estimée en ms (durée physique / nb opérations) */
  durationMs?: number;
}

export interface TraceTaskResult {
  taskId: string;
  tool: string;
  args: Record<string, JsonValue>;
  result: JsonValue;
  success: boolean;
  durationMs: number;
  layerIndex?: number;

  // Phase 2a: Métadonnées de fusion
  /** true si cette tâche physique contient plusieurs opérations logiques */
  isFused?: boolean;

  /** Opérations atomiques fusionnées dans cette tâche */
  logicalOperations?: LogicalOperation[];
}
```

#### **2. Enrichissement des Traces** (`src/mcp/handlers/execute-handler.ts`)

```typescript
// Build task results for trace (using physical tasks with logical detail)
// Phase 2a: Include fusion metadata for UI display
const taskResults: TraceTaskResult[] = physicalResults.results.map((physicalResult) => {
  const physicalTask = optimizedDAG.tasks.find((t) => t.id === physicalResult.taskId);
  const logicalTaskIds = optimizedDAG.physicalToLogical.get(physicalResult.taskId) || [];
  const fused = logicalTaskIds.length > 1;

  let logicalOps: LogicalOperation[] | undefined;
  if (fused) {
    // Extraction des opérations logiques pour les tâches fusionnées
    const estimatedDuration = (physicalResult.executionTime || 0) / logicalTaskIds.length;
    logicalOps = logicalTaskIds.map((logicalId) => {
      const logicalTask = optimizedDAG.logicalDAG.tasks.find((t) => t.id === logicalId);
      return {
        toolId: logicalTask?.tool || "unknown",
        durationMs: estimatedDuration,
      };
    });
  }

  return {
    taskId: physicalResult.taskId,
    tool: physicalTask?.tool || "unknown",
    args: {} as Record<string, JsonValue>,
    result: physicalResult.output as JsonValue ?? null,
    success: physicalResult.status === "success",
    durationMs: physicalResult.executionTime || 0,
    layerIndex: physicalResult.layerIndex,
    // Phase 2a: Métadonnées de fusion
    isFused: fused,
    logicalOperations: logicalOps,
  };
});
```

#### **3. Mapping snake_case ↔ camelCase** (`src/capabilities/execution-trace-store.ts`)

**TypeScript interne** : `camelCase` (isFused, logicalOperations) **PostgreSQL/API** : `snake_case`
(is_fused, logical_operations)

```typescript
// SAVE: camelCase → snake_case
const sanitizedResults = trace.taskResults.map((r) => ({
  task_id: r.taskId,
  tool: r.tool,
  args: sanitizeForStorage(r.args) as Record<string, JsonValue>,
  result: sanitizeForStorage(r.result),
  success: r.success,
  duration_ms: r.durationMs,
  layer_index: r.layerIndex,
  // Phase 2a: Fusion metadata
  is_fused: r.isFused,
  logical_operations: r.logicalOperations?.map((op) => ({
    tool_id: op.toolId,
    duration_ms: op.durationMs,
  })),
}));

// LOAD: snake_case → camelCase
taskResults = (rawResults as any[]).map((r: any) => ({
  taskId: r.task_id,
  tool: r.tool,
  args: r.args || {},
  result: r.result,
  success: r.success,
  durationMs: r.duration_ms,
  layerIndex: r.layer_index,
  // Phase 2a: Fusion metadata
  isFused: r.is_fused,
  logicalOperations: r.logical_operations?.map((op: any) => ({
    toolId: op.tool_id,
    durationMs: op.duration_ms,
  })),
}));
```

**Note :** Pas de migration DB nécessaire, les données sont en JSONB.

---

### **Implémentation Frontend**

#### **1. Composant FusedTaskCard** (`src/web/components/ui/atoms/FusedTaskCard.tsx`)

```typescript
interface FusedTaskCardProps {
  logicalOps: LogicalOperation[];
  durationMs: number;
  success: boolean;
  color: string;
}

export default function FusedTaskCard({
  logicalOps,
  durationMs,
  success,
  color,
}: FusedTaskCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      style={{
        border: `2px solid ${color}`,
        borderRadius: "8px",
        padding: "8px 12px",
        backgroundColor: success ? "#f0fff4" : "#fff5f5",
        cursor: "pointer",
        minWidth: "200px",
      }}
    >
      {/* Header - Tâche Physique */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span>📦</span>
        <span style={{ fontWeight: 600 }}>
          Fused ({logicalOps.length} ops)
        </span>
        <span style={{ marginLeft: "auto", fontSize: "12px", color: "#666" }}>
          {Math.round(durationMs)}ms
        </span>
        <span style={{ fontSize: "12px" }}>
          {expanded ? "▼" : "▶"}
        </span>
      </div>

      {/* Expandable - Opérations Logiques */}
      {expanded && (
        <div style={{ marginTop: "8px", paddingLeft: "16px" }}>
          {logicalOps.map((op, idx) => {
            const toolName = op.toolId.replace("code:", "");
            const isLast = idx === logicalOps.length - 1;
            return (
              <div
                key={idx}
                style={{
                  fontSize: "12px",
                  color: "#555",
                  fontFamily: "monospace",
                  marginTop: "4px",
                }}
              >
                <span style={{ color: "#999" }}>
                  {isLast ? "└─" : "├─"}
                </span>{" "}
                <span style={{ fontWeight: 500 }}>{toolName}</span>
                {op.durationMs && (
                  <span style={{ color: "#888", marginLeft: "8px" }}>
                    ({Math.round(op.durationMs)}ms)
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

#### **2. Intégration dans TraceTimeline** (`src/web/components/ui/molecules/TraceTimeline.tsx`)

```typescript
{
  tasks.map((task, taskIdx) => {
    const [server = "unknown", ...nameParts] = task.tool.split(":");
    const toolName = nameParts.join(":") || task.tool;
    const color = getServerColor?.(server) ||
      DEFAULT_COLORS[server.charCodeAt(0) % DEFAULT_COLORS.length];

    // Phase 2a: Render fused tasks with expandable logical operations
    if (task.isFused && task.logicalOperations) {
      return (
        <FusedTaskCard
          key={`${layerIdx}-${taskIdx}`}
          logicalOps={task.logicalOperations}
          durationMs={task.durationMs}
          success={task.success}
          color={color}
        />
      );
    }

    // Regular task card
    return (
      <TaskCard
        key={`${layerIdx}-${taskIdx}`}
        toolName={toolName}
        server={server}
        durationMs={task.durationMs}
        success={task.success}
        color={color}
      />
    );
  });
}
```

---

### **Exemple Visuel**

#### **État Collapsed (Par défaut)**

```
┌─────────────────────────────┐
│ 📦 Fused (5 ops) 45ms      ▶│
└─────────────────────────────┘
```

#### **État Expanded (Après clic)**

```
┌─────────────────────────────┐
│ 📦 Fused (5 ops) 45ms      ▼│
│   ├─ filter (9ms)           │
│   ├─ reduce (9ms)           │
│   ├─ get_length (9ms)       │
│   ├─ divide (9ms)           │
│   └─ Math.round (9ms)       │
└─────────────────────────────┘
```

---

### **Bénéfices**

| Aspect          | Avant                                       | Après                              |
| --------------- | ------------------------------------------- | ---------------------------------- |
| **Visibilité**  | ❌ Tâches fusionnées opaques                | ✅ Détail des opérations atomiques |
| **Debug**       | ❌ Impossible de voir ce qui a été fusionné | ✅ Vue hiérarchique claire         |
| **Performance** | ✅ DAG physique compact                     | ✅ Maintenu (affichage optionnel)  |
| **Learning**    | ✅ Traces logiques pour SHGAT               | ✅ + Visibilité utilisateur        |
| **UX**          | ⚠️ Confusion sur fusion                     | ✅ Transparence totale             |

---

### **Estimation des Durées**

**Durée physique :** Mesurée réellement lors de l'exécution **Durée logique :** Estimée par
`durationPhysique / nbOpérations`

**Exemple :**

- Tâche fusionnée : 45ms (mesuré)
- 5 opérations logiques
- Durée estimée par opération : 45 / 5 = 9ms

**Note :** C'est une estimation (les opérations peuvent avoir des coûts différents), mais suffisante
pour la visualisation.

---

### **Architecture Complète End-to-End**

```
1. DAG Optimizer
   └─ Fusionne tasks → Crée mapping physicalToLogical

2. ControlledExecutor
   └─ Exécute DAG physique → Mesure durées réelles

3. Execute Handler
   └─ Enrichit traces avec metadata fusion
      └─ isFused: true
      └─ logicalOperations: [{ toolId, durationMs }]

4. Execution Trace Store
   └─ Sauvegarde en PostgreSQL (snake_case)
      └─ task_results JSONB: { is_fused, logical_operations }

5. API / Frontend Load
   └─ Charge traces (camelCase mapping)
      └─ TraceTaskResult: { isFused, logicalOperations }

6. TraceTimeline Component
   └─ Détecte isFused
      └─ Regular TaskCard (si isFused = false)
      └─ FusedTaskCard (si isFused = true)
         └─ Header: Tâche physique (📦)
         └─ Expandable: Opérations logiques (├─ └─)
```

---

### **Tests End-to-End**

```typescript
// Test : Fusion de 3 opérations
const code = `
  const data = [1, 2, 3, 4, 5];
  const doubled = data.map(x => x * 2);
  const sum = doubled.reduce((a, b) => a + b, 0);
  return sum;
`;

// DAG Logique attendu :
// - task_c1: code:map
// - task_c2: code:reduce

// DAG Physique attendu :
// - task_fused_1: code:computation (map + reduce)

// Trace attendue :
{
  taskResults: [
    {
      taskId: "task_fused_1",
      tool: "code:computation",
      durationMs: 10,
      isFused: true,
      logicalOperations: [
        { toolId: "code:map", durationMs: 5 },
        { toolId: "code:reduce", durationMs: 5 },
      ],
    },
  ];
}

// UI attendue :
// ┌─────────────────────┐
// │ 📦 Fused (2 ops) 10ms ▶│
// └─────────────────────┘
//
// Après clic :
// ┌─────────────────────┐
// │ 📦 Fused (2 ops) 10ms ▼│
// │   ├─ map (5ms)       │
// │   └─ reduce (5ms)    │
// └─────────────────────┘
```

---

## ✅ **Conclusion**

**Two-level architecture** = Solution optimale :

- ✅ DAG logique détaillé → SHGAT apprend tout
- ✅ DAG physique optimisé → Performance maintenue
- ✅ Traces complètes → Chemins réutilisables
- ✅ Fusion intelligente → Moins de layers/HIL
- ✅ Parallélisation auto → Gain de perf
- ✅ **UI transparente** → Visibilité totale pour l'utilisateur

**Prêt pour implémentation !**
