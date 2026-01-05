# Loop Abstraction pour SHGAT Learning

## Contexte et Problème

### Problème Initial

Dans les workflows avec boucles, le DAG logique contenait **toutes les itérations** :

```typescript
// Code utilisateur
for (const item of items) {
  await mcp.click(item.selector);
  await mcp.fill(item.selector, item.value);
}
```

**DAG généré (avant) :**
```
task_1: mcp:click
task_2: mcp:fill
task_3: mcp:click  // Itération 2
task_4: mcp:fill
task_5: mcp:click  // Itération 3
task_6: mcp:fill
...
```

**Problèmes :**
- 6 layers avec le même outil (pour 3 itérations)
- SHGAT apprend "click-fill-click-fill-click-fill" au lieu du pattern
- Non généralisable : le pattern dépend du nombre d'éléments

---

## Solution : Loop Abstraction

### Principe

Les boucles sont représentées comme un **nœud abstrait** contenant une seule itération :

```
loop_1 (forOf: item of items)
  ├── task_1: mcp:click (parentScope: loop_1)
  └── task_2: mcp:fill (parentScope: loop_1)
```

**SHGAT apprend :** "pour itérer sur une collection, utiliser click puis fill"

### Différence avec Two-Level DAG

| Aspect | Fusion (Phase 2a/2b) | Loop Abstraction |
|--------|---------------------|------------------|
| **Niveau** | DAG Physique | DAG Logique |
| **But** | Performance (moins de HIL) | Learning (patterns généralisables) |
| **Ce que SHGAT voit** | Toutes les ops logiques | Pattern abstrait |
| **Exécution** | Fusion en 1 task | Code original s'exécute |

---

## Architecture

### Types de Boucles Supportées

```typescript
type LoopType = "for" | "while" | "forOf" | "forIn" | "doWhile";
```

| Type | Exemple | Condition générée |
|------|---------|-------------------|
| `for` | `for (let i=0; i<10; i++)` | `for(let i=0; i<10; i++)` |
| `while` | `while (hasMore)` | `while(hasMore)` |
| `forOf` | `for (item of items)` | `for(item of items)` |
| `forIn` | `for (key in obj)` | `for(key in obj)` |
| `doWhile` | `do {...} while (cond)` | `do...while(cond)` |

### Structure du Nœud Loop

```typescript
interface LoopNode {
  id: string;           // Ex: "l1"
  type: "loop";
  condition: string;    // Ex: "for(item of items)"
  loopType: LoopType;   // Ex: "forOf"
  position: number;
  parentScope?: string;
}
```

### Type d'Edge : loop_body

```typescript
interface StaticStructureEdge {
  from: string;
  to: string;
  type: "sequence" | "provides" | "conditional" | "contains" | "loop_body";
  // ...
}
```

L'edge `loop_body` connecte le nœud loop au premier nœud de son body.

---

## Flux de Traitement

```
Code Source
    ↓
StaticStructureBuilder (SWC parse)
    ↓
AST Handlers (handleForStatement, handleForOfStatement, etc.)
    ↓
Création du nœud "loop" + analyse du body ONCE
    ↓
DAG LOGIQUE avec abstraction loop
    ↓
Edge Generators (generateLoopEdges)
    ↓
Structure finale pour SHGAT
```

### Exemple Complet

**Code :**
```typescript
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
for (const user of users) {
  await mcp.email.send({ to: user.email, subject: "Hello" });
  await mcp.log.info({ message: `Sent to ${user.name}` });
}
```

**DAG Logique généré :**
```
task_n1: db:query
    ↓ (sequence)
loop_l1: for(user of users)
    ↓ (loop_body)
task_n2: email:send (parentScope: l1)
    ↓ (sequence)
task_n3: log:info (parentScope: l1)
```

**executedPath pour SHGAT :**
```json
["db:query", "loop:forOf", "email:send", "log:info"]
```

---

## Exécution Runtime

### Ce qui ne change pas

L'exécution runtime reste identique :
- Le code original s'exécute avec toutes ses itérations
- Les résultats de chaque itération sont collectés
- Les erreurs sont gérées normalement

### Ce qui change

La **trace pour SHGAT** utilise le DAG Logique abstrait :
- Le pattern est représenté une fois
- SHGAT apprend le comportement, pas le nombre d'itérations

---

## Comparaison Avant/Après

### Avant (sans loop abstraction)

```
Code: for (x of [1,2,3]) { click(x); fill(x); }

DAG:
task_1 → task_2 → task_3 → task_4 → task_5 → task_6
(click)   (fill)   (click)  (fill)   (click)  (fill)

SHGAT voit: 6 opérations en séquence
Problème: Pattern non généralisable
```

### Après (avec loop abstraction)

```
DAG:
loop_1 (forOf)
  ├── task_1 (click)
  └── task_2 (fill)

SHGAT voit: loop → click → fill
Avantage: Pattern généralisable à N éléments
```

---

## Implémentation

### Fichiers Modifiés

| Fichier | Changement |
|---------|------------|
| `src/capabilities/static-structure/types.ts` | Ajout `LoopType`, extension `InternalNode` |
| `src/capabilities/static-structure/ast-handlers.ts` | Handlers pour ForStatement, WhileStatement, etc. |
| `src/capabilities/static-structure-builder.ts` | Compteur `loop`, préfixe "l" |
| `src/capabilities/static-structure/edge-generators.ts` | `generateLoopEdges()` |
| `src/capabilities/types/static-analysis.ts` | Extension `StaticStructureNode`, `StaticStructureEdge` |

### Handlers AST

```typescript
// Enregistrement dans createStaticStructureVisitor()
.register("ForStatement", handleForStatement)
.register("WhileStatement", handleWhileStatement)
.register("DoWhileStatement", handleDoWhileStatement)
.register("ForOfStatement", handleForOfStatement)
.register("ForInStatement", handleForInStatement)
```

### Génération d'Edges

```typescript
function generateLoopEdges(nodes, edges) {
  const loopNodes = nodes.filter(n => n.type === "loop");

  for (const loop of loopNodes) {
    const bodyNodes = nodes.filter(n => n.parentScope === loop.id);
    if (bodyNodes.length > 0) {
      const firstNode = bodyNodes.sort((a, b) => a.position - b.position)[0];
      edges.push({
        from: loop.id,
        to: firstNode.id,
        type: "loop_body",
      });
    }
  }
}
```

---

## Relation avec Two-Level DAG

### Complémentarité

| Optimisation | Niveau | But |
|--------------|--------|-----|
| **Loop Abstraction** | DAG Logique | SHGAT learning |
| **Sequential Fusion** (Phase 2a) | DAG Physique | Performance execution |
| **Fork-Join Fusion** (Phase 2b) | DAG Physique | Performance parallèle |

### Flux Combiné

```
Code Source
    ↓
StaticStructureBuilder + Loop Abstraction
    ↓
DAG LOGIQUE (patterns abstraits pour SHGAT)
    ↓
DAG Optimizer (fusion séquentielle/fork-join)
    ↓
DAG PHYSIQUE (optimisé pour execution)
    ↓
Executor (runtime)
    ↓
Traces (basées sur DAG Logique)
```

---

## Bénéfices

| Aspect | Sans Abstraction | Avec Abstraction |
|--------|------------------|------------------|
| **Layers SHGAT** | N × body_size | 1 + body_size |
| **Généralisation** | Pattern spécifique à N | Pattern universel |
| **Noise ratio** | Élevé (répétitions) | Bas (signal pur) |
| **Complexité trace** | O(N × ops) | O(ops) |

---

## Limitations et Considérations

### Ce qui n'est pas capturé

- Le nombre d'itérations (intentionnel : on veut le pattern, pas le count)
- Les variations entre itérations (si condition dans la boucle)
- Les break/continue (traités comme fin normale de l'itération analysée)

### Boucles Imbriquées

Les boucles imbriquées créent une hiérarchie de scopes :

```typescript
for (const row of rows) {
  for (const cell of row.cells) {
    await process(cell);
  }
}
```

```
loop_l1: for(row of rows)
  └── loop_l2: for(cell of row.cells) (parentScope: l1)
        └── task_n1: process (parentScope: l2)
```

---

## Tests

### Cas de Test Principaux

1. **Boucle simple for-of** : Vérifie création nœud loop + body
2. **Boucle while** : Vérifie condition while
3. **Boucles imbriquées** : Vérifie hiérarchie de scopes
4. **Boucle vide** : Vérifie nœud loop sans body
5. **Boucle avec break/continue** : Vérifie analyse body partiel

---

---

## Implémentation Exécution Runtime (2026-01-03)

### Problème Identifié

L'architecture initiale supposait que les boucles seraient exécutées task par task dans le DAG. Cependant, cela causait des problèmes :

1. **Variables de boucle non résolues** : `for (const file of files)` → `file` n'était pas défini car chaque itération était traitée comme une task séparée
2. **Capability par itération** : Chaque appel MCP dans la boucle créait une capability séparée au lieu d'une seule pour le loop entier

### Solution Implémentée

**Principe** : Les boucles sont exécutées nativement via WorkerBridge comme une seule tâche `code_execution`.

#### 1. Extraction du Code Complet (AST Handlers)

Le span SWC est utilisé pour extraire le code complet de la boucle :

```typescript
// src/capabilities/static-structure/ast-handlers.ts
const span = n.span as { start: number; end: number } | undefined;
const code = ctx.extractCodeFromSpan(span);

ctx.nodes.push({
  id: loopId,
  type: "loop",
  condition,
  loopType: "forOf",
  code, // Full loop code for WorkerBridge execution
  ...
});
```

#### 2. Conversion DAG : Loop → code_execution Task

```typescript
// src/dag/static-to-dag-converter.ts
case "loop":
  return {
    id: taskId,
    tool: `loop:${node.loopType}`,  // "loop:forOf", "loop:while", etc.
    type: "code_execution",
    code: node.code,  // Full loop code
    ...
  };
```

**Important** : Les nodes INSIDE le loop sont skippés (ils sont exécutés par le code natif) :

```typescript
// Skip nodes inside loops - they execute as part of loop task
if (loopMembership.has(node.id)) {
  continue;
}
```

#### 3. Injection ToolDefinitions pour MCP dans les Loops

```typescript
// src/dag/controlled-executor.ts
controlledExecutor.setToolDefinitions(toolDefs);

// Dans executeCodeTaskViaWorkerBridge:
const result = await this.workerBridge!.executeCodeTask(
  task.tool,
  codeToExecute,
  executionContext,
  this.toolDefinitions,  // MCP tools disponibles dans le loop
);
```

#### 4. Wrapper Return pour Capturer les Résultats

Le code de boucle extrait ne contient pas de `return`. On wrappe :

```typescript
// src/dag/controlled-executor.ts
if (task.tool?.startsWith("loop:")) {
  const contextVars = Object.keys(executionContext).filter(
    (k) => k !== "deps" && k !== "args",
  );
  codeToExecute = `${task.code}\nreturn { ${contextVars.join(", ")} };`;
}
```

**Avant** (code extrait) :
```javascript
for (const x of items) {
  const r = await mcp.std.datetime_now({});
  out.push({ x, time: r });
}
```

**Après** (code exécuté) :
```javascript
for (const x of items) {
  const r = await mcp.std.datetime_now({});
  out.push({ x, time: r });
}
return { items, out };
```

### Fichiers Modifiés

| Fichier | Changement |
|---------|------------|
| `src/capabilities/types/static-analysis.ts` | Ajout `code?: string` au type loop |
| `src/capabilities/static-structure/types.ts` | Ajout `code?: string` au type loop |
| `src/capabilities/static-structure/ast-handlers.ts` | Extraction code via span pour tous les loop handlers |
| `src/dag/static-to-dag-converter.ts` | Loop → `code_execution` task, skip nodes inside loop |
| `src/dag/controlled-executor.ts` | `setToolDefinitions()`, wrapper return pour loops |
| `src/mcp/handlers/execute-handler.ts` | Appel `setToolDefinitions()` |
| `src/mcp/handlers/workflow-execution-handler.ts` | Appel `setToolDefinitions()` |

### Résultat

```
Avant:
- Loop avec 3 itérations → 3 tasks séparées → 3 capabilities créées
- Variables de boucle → undefined
- results.push() → non capturé

Après:
- Loop → 1 task "loop:forOf"
- MCP calls dans le loop → fonctionnent via toolDefinitions
- results → capturés via return wrappé
```

**Exemple de résultat** :
```json
{
  "taskId": "task_l1",
  "status": "success",
  "output": {
    "result": {
      "items": ["a", "b"],
      "out": [
        {"x": "a", "time": "2026-01-03T07:40:06Z"},
        {"x": "b", "time": "2026-01-03T07:40:06Z"}
      ]
    }
  }
}
```

---

## Implémentation Capability & Frontend (2026-01-03)

### Problème Identifié

1. **executedPath incorrect** : Les MCP calls étaient tracés N fois (par itération), résultant en `["std:datetime_now", "std:datetime_now", "loop:forOf"]` au lieu du pattern dédupliqué
2. **Pas de capability créée** : Le loop s'exécutait mais ne sauvegardait pas de capability (pas d'intent)
3. **Frontend non adapté** : TraceTimeline attendait plusieurs tasks avec `loopId`, pas un seul loop task

### Solution Implémentée

#### 1. Calcul des bodyTools dans le DAG Statique

```typescript
// src/dag/static-to-dag-converter.ts
// Phase 0b: Build loop body tools map for executedPath deduplication
const loopBodyTools = new Map<string, string[]>();
for (const [nodeId, loopInfo] of loopMembership) {
  const node = structure.nodes.find((n) => n.id === nodeId);
  if (node?.type === "task") {
    // Deduplicate: only add if not already present
    if (!tools.includes(taskNode.tool)) {
      tools.push(taskNode.tool);
    }
  }
}

// Loop task metadata includes bodyTools
metadata: {
  loopId: node.id,
  loopType: node.loopType,
  loopCondition: node.condition,
  bodyTools: bodyTools || [],  // Unique tools inside loop
}
```

#### 2. Passage du loopMetadata à WorkerBridge

```typescript
// src/dag/controlled-executor.ts
const loopMetadata = task.tool?.startsWith("loop:")
  ? {
      loopId: task.metadata?.loopId,
      loopCondition: task.metadata?.loopCondition,
      loopType: task.metadata?.loopType,
      bodyTools: task.metadata?.bodyTools,
    }
  : undefined;

const result = await this.workerBridge!.executeCodeTask(
  task.tool,
  codeToExecute,
  executionContext,
  this.toolDefinitions,
  loopMetadata,  // NEW: Loop metadata for capability saving
);
```

#### 3. Sauvegarde Capability avec executedPath Correct

```typescript
// src/sandbox/worker-bridge.ts - executeCodeTask()
if (loopMetadata && toolName.startsWith("loop:") && result.success) {
  // Build correct executedPath: [loop, ...bodyTools] (deduplicated!)
  const executedPath = [toolName, ...(loopMetadata.bodyTools || [])];

  // Generate intent from loop condition
  const intent = loopMetadata.loopCondition
    ? `Execute loop: ${loopMetadata.loopCondition}`
    : `Execute ${toolName}`;

  // Reconstruct complete code with variable declarations
  const contextVars = context
    ? Object.entries(context)
        .filter(([k]) => k !== "deps" && k !== "args")
        .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`)
        .join("\n")
    : "";
  const completeCode = contextVars ? `${contextVars}\n${code}` : code;

  await this.capabilityStore.saveCapability({
    code: completeCode,
    intent,
    traceData: { executedPath, ... },
  });
}
```

#### 4. Traces avec Loop Metadata

```typescript
// src/sandbox/worker-bridge.ts - tool_start/tool_end traces
this.traces.push({
  type: "tool_end",
  tool: toolName,
  // ... autres champs ...
  ...(loopMetadata ? {
    loopId: loopMetadata.loopId,
    loopType: loopMetadata.loopType,
    loopCondition: loopMetadata.loopCondition,
    bodyTools: loopMetadata.bodyTools,
  } : {}),
});
```

#### 5. Frontend TraceTimeline Adapté

```typescript
// src/web/components/ui/molecules/TraceTimeline.tsx
function groupTasksByLoop(tasks: TaskResult[]) {
  for (const task of tasks) {
    // New format: task is a loop task itself (tool starts with "loop:")
    if (task.tool.startsWith("loop:")) {
      loops.push({
        loopId: task.loopId || task.taskId,
        loopType: task.loopType || loopType,
        loopCondition: task.loopCondition,
        uniqueTools: task.bodyTools || [],  // Use bodyTools from static DAG
        // ...
      });
    }
    // Legacy format handled separately...
  }
}
```

### Fichiers Modifiés

| Fichier | Changement |
|---------|------------|
| `src/dag/static-to-dag-converter.ts` | Calcul `loopBodyTools`, ajout au metadata |
| `src/graphrag/types/dag.ts` | Ajout `bodyTools?: string[]` au type Task.metadata |
| `src/dag/controlled-executor.ts` | Extraction et passage loopMetadata à WorkerBridge |
| `src/sandbox/worker-bridge.ts` | Sauvegarde capability avec executedPath dédupliqué, traces avec loop metadata |
| `src/web/components/ui/molecules/TraceTimeline.tsx` | Support nouveau format loop task avec bodyTools |

### Résultat

**Avant :**
```
executedPath: ["std:datetime_now", "std:datetime_now", "loop:forOf"]
capability: non créée
frontend: affichage incorrect
```

**Après :**
```
executedPath: ["loop:forOf", "std:datetime_now"]  // Pattern dédupliqué!
capability: créée avec intent "Execute loop: for(x of items)"
frontend: LoopTaskCard avec badge 🔄 et bodyTools expandables
```

---

## Fix Naming Capability (2026-01-03)

### Problème

Les capabilities loop n'avaient pas de nom correct dans le dashboard :
- `name: "acf11e19"` (juste l'ID hash) au lieu de `loop:exec_XXXX`
- `call_name` manquant
- `description: "Execute loop: for(... of items)"` au lieu de l'intent réel

Les capabilities normales créent un `capability_records` après `saveCapability` (dans execute-handler.ts), mais les loops ne faisaient pas cette étape.

### Solution

Ajout de la création du `capability_records` dans `worker-bridge.ts` :

```typescript
// Create capability_records for proper naming
if (this.capabilityRegistry) {
  const existingRecord = await this.capabilityRegistry.getByWorkflowPatternId(capability.id);

  if (!existingRecord) {
    // namespace: "loop" (from toolName like "loop:forOf")
    const namespace = toolName.includes(":") ? toolName.split(":")[0] : "loop";
    // action: exec_XXXX (from code hash)
    const action = `exec_${capability.codeHash.substring(0, 8)}`;

    await this.capabilityRegistry.create({
      org: "local",
      project: "default",
      namespace,
      action,
      workflowPatternId: capability.id,
      hash: capability.codeHash.substring(0, 4),
      createdBy: "worker_bridge_loop",
      toolsUsed: loopMetadata.bodyTools || [],
    });
  }
}
```

### Résultat (Naming)

Les loop capabilities affichent maintenant :
- `name: "loop:exec_XXXX"` (comme les autres capabilities)
- `call_name: "loop:exec_XXXX"`
- `description` basé sur l'intent ou la condition de loop

---

## Fix TraceTimeline LoopTaskCard (2026-01-03)

### Problème

Le LoopTaskCard ne s'affichait pas dans le dashboard (colonne de droite, execution trace).

**Cause**: On passait `taskResults: []` vide lors de la sauvegarde de la capability loop. Sans taskResults, TraceTimeline n'a rien à rendre.

### Solution

Créer un `taskResult` pour la loop elle-même avec les métadonnées nécessaires:

```typescript
// worker-bridge.ts - dans executeCodeTask() pour les loops
const loopTaskResult = {
  taskId: `task_loop_${Date.now()}`,
  tool: toolName, // e.g., "loop:forOf"
  args: {} as Record<string, JsonValue>,
  result: (result.result ?? null) as JsonValue,
  success: true,
  durationMs,
  layerIndex: 0,
  // Loop metadata for TraceTimeline groupTasksByLoop()
  loopId: loopMetadata.loopId,
  loopType: loopMetadata.loopType,
  loopCondition: loopMetadata.loopCondition,
  bodyTools: loopMetadata.bodyTools,
};

// Passer ce taskResult dans traceData
traceData: {
  ...
  taskResults: [loopTaskResult],
}
```

### Comment TraceTimeline détecte les loops

`groupTasksByLoop()` dans TraceTimeline.tsx détecte les loops de 2 façons:

1. **Nouveau format**: `task.tool.startsWith("loop:")` → utilise `bodyTools` pour les nested tasks
2. **Legacy format**: `task.loopId` → groupe les tasks par loopId

Le nouveau format est plus simple car on a UNE seule task loop avec ses bodyTools, au lieu de N tasks groupées.

---

## Conclusion

L'abstraction des boucles au niveau du DAG Logique permet à SHGAT d'apprendre des **patterns généralisables** plutôt que des séquences d'opérations répétées. Cette approche est complémentaire à l'optimisation Two-Level DAG qui opère au niveau physique pour la performance d'exécution.

L'implémentation complète (2026-01-03) couvre maintenant :
1. ✅ Exécution native des boucles avec accès MCP
2. ✅ Capture des résultats via return wrappé
3. ✅ executedPath dédupliqué pour SHGAT learning
4. ✅ Sauvegarde capability avec code complet et intent
5. ✅ Frontend avec LoopTaskCard et bodyTools
6. ✅ Création capability_records pour naming correct (loop:exec_XXXX)
7. ✅ taskResults avec loop metadata pour TraceTimeline
8. ✅ Sérialisation/désérialisation loop metadata dans execution_trace

---

## Fix LoopTaskCard Expansion (2026-01-03)

### Problème

Le LoopTaskCard s'affichait mais ne pouvait pas s'expandre pour montrer les `bodyTools`.

**Cause**: Les champs `loop_id`, `loop_type`, `loop_condition`, `body_tools` n'étaient pas sérialisés/désérialisés dans `execution-trace-store.ts`.

### Solution

#### 1. Ajout du type `bodyTools` à `TraceTaskResult`

```typescript
// src/capabilities/types/execution.ts
export interface TraceTaskResult {
  // ... autres champs ...
  bodyTools?: string[];  // Loop Abstraction: Tools inside the loop body
}
```

#### 2. Sérialisation (camelCase → snake_case)

```typescript
// src/capabilities/execution-trace-store.ts - save()
const sanitizedResults = trace.taskResults.map((r) => ({
  // ... autres champs ...
  // Loop Abstraction metadata
  loop_id: r.loopId,
  loop_type: r.loopType,
  loop_condition: r.loopCondition,
  body_tools: r.bodyTools,
}));
```

#### 3. Désérialisation (snake_case → camelCase)

```typescript
// src/capabilities/execution-trace-store.ts - getById()
taskResults = (rawResults as any[]).map((r: any) => ({
  // ... autres champs ...
  // Loop Abstraction metadata
  loopId: r.loop_id,
  loopType: r.loop_type,
  loopCondition: r.loop_condition,
  bodyTools: r.body_tools,
}));
```

### Vérification

Query PostgreSQL confirmant le stockage correct :
```json
{
  "tool": "loop:forOf",
  "loop_id": "l1",
  "loop_type": "forOf",
  "loop_condition": "for(... of numbers)",
  "body_tools": ["code:multiply"]
}
```

### Fichiers Modifiés

| Fichier | Changement |
|---------|------------|
| `src/capabilities/types/execution.ts` | Ajout `bodyTools?: string[]` à `TraceTaskResult` |
| `src/capabilities/execution-trace-store.ts` | Sérialisation et désérialisation des loop metadata |

---

## Conclusion

L'abstraction des boucles au niveau du DAG Logique permet à SHGAT d'apprendre des **patterns généralisables** plutôt que des séquences d'opérations répétées. Cette approche est complémentaire à l'optimisation Two-Level DAG qui opère au niveau physique pour la performance d'exécution.

L'implémentation complète (2026-01-03) couvre maintenant :
1. ✅ Exécution native des boucles avec accès MCP
2. ✅ Capture des résultats via return wrappé
3. ✅ executedPath dédupliqué pour SHGAT learning
4. ✅ Sauvegarde capability avec code complet et intent
5. ✅ Frontend avec LoopTaskCard et bodyTools expandables
6. ✅ Création capability_records pour naming correct (loop:exec_XXXX)
7. ✅ taskResults avec loop metadata pour TraceTimeline
8. ✅ Sérialisation/désérialisation loop metadata dans execution_trace
