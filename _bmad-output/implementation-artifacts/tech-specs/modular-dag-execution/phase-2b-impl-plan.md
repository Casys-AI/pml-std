# Phase 2b : Fork-Join Fusion - Plan d'Implémentation

## Rappel : Objectif Phase 2b

**UNIQUEMENT Optimisation Exécution** (pas de changement pour SHGAT)

- ✅ SHGAT : Traces logiques identiques (déjà complet en Phase 2a)

- ✅ Exécution : Fusion des branches parallèles pour performance

- ✅ UI : Affichage des branches parallèles

---

## 1. Détection des Patterns Fork-Join

### Pattern à détecter

```typescript
// Pattern "Diamond" :

//     A

//    / \

//   B   C    ← Même layer, même parent (A)

//    \ /

//     D

// Conditions pour fusionner B et C :

// 1. Même layer (parallèles)

// 2. Même parent (dépendent tous de A)

// 3. Tous deux sont code_execution + pure

// 4. Même permissionSet
```

### Algorithme de détection

**Fichier** : `src/dag/dag-optimizer.ts`

```typescript
/**

 * Find fork-join patterns in a layer

 *

 * Returns groups of tasks that can be executed in parallel

 * and fused into a single Promise.all() call

 */

function findForkJoinGroups(
  layer: Task[],
  logicalDAG: DAGStructure,
): ForkJoinGroup[] {
  const groups: ForkJoinGroup[] = [];

  const processed = new Set<string>();

  for (const task of layer) {
    if (processed.has(task.id)) continue;

    // Find all sibling tasks (same dependencies, same layer)

    const siblings = layer.filter((t) =>
      !processed.has(t.id) &&
      haveSameDependencies(t, task) &&
      canFuseWithForkJoin(t, task)
    );

    if (siblings.length > 1) {
      // Found a fork-join group

      groups.push({
        tasks: siblings,

        pattern: "fork-join",

        commonDependencies: task.dependsOn,
      });

      siblings.forEach((t) => processed.add(t.id));
    }
  }

  return groups;
}

/**

 * Check if two tasks have identical dependencies

 */

function haveSameDependencies(task1: Task, task2: Task): boolean {
  const deps1 = new Set(task1.dependsOn);

  const deps2 = new Set(task2.dependsOn);

  if (deps1.size !== deps2.size) return false;

  for (const dep of deps1) {
    if (!deps2.has(dep)) return false;
  }

  return true;
}

/**

 * Check if two tasks can be fused in fork-join pattern

 */

function canFuseWithForkJoin(task1: Task, task2: Task): boolean {
  // Both must be code_execution

  if (task1.type !== "code_execution" || task2.type !== "code_execution") {
    return false;
  }

  // Both must be pure

  if (task1.metadata?.pure !== true || task2.metadata?.pure !== true) {
    return false;
  }

  // Same permission set

  const perm1 = task1.sandboxConfig?.permissionSet ?? "minimal";

  const perm2 = task2.sandboxConfig?.permissionSet ?? "minimal";

  if (perm1 !== perm2) {
    return false;
  }

  return true;
}
```

---

## 2. Génération du Code Fusionné avec Promise.all

### Code généré

**Avant (Phase 2a) :**

```typescript
// Sequential fusion (A → B → C)

const result_0 = /* code B */;

const result_1 = /* code C */;

return result_1;
```

**Après (Phase 2b) :**

```typescript
// Fork-join fusion (A → (B, C) → D)

const [result_B, result_C] = await Promise.all([

  Promise.resolve(/* code B */),

  Promise.resolve(/* code C */)

]);

const result_D = /* code D using result_B and result_C */;

return result_D;
```

### Implémentation

**Fichier** : `src/dag/dag-optimizer.ts`

```typescript
/**

 * Generate fused code for fork-join pattern

 */

function generateForkJoinCode(group: ForkJoinGroup): string {
  const codeLines: string[] = [];

  // Generate Promise.all for parallel branches

  const promiseCalls = group.tasks.map((task, idx) => {
    const operation = extractOperationCode(task.code);

    return `  Promise.resolve(${operation}) // ${task.tool}`;
  });

  const varNames = group.tasks.map((_, idx) => `branch_${idx}`);

  codeLines.push(`// Fork-join: ${group.tasks.length} parallel operations`);

  codeLines.push(`const [${varNames.join(", ")}] = await Promise.all([`);

  codeLines.push(promiseCalls.join(",\n"));

  codeLines.push(`]);`);

  // Return results as array or object

  if (group.tasks.length === 2) {
    codeLines.push(`return [${varNames.join(", ")}];`);
  } else {
    // For >2 branches, return as object

    const resultObj = group.tasks.map((task, idx) => `${task.id}: ${varNames[idx]}`).join(", ");

    codeLines.push(`return { ${resultObj} };`);
  }

  return codeLines.join("\n");
}

/**

 * Fuse a fork-join group into a single task

 */

function fuseForkJoinGroup(group: ForkJoinGroup): Task {
  const fusedCode = generateForkJoinCode(group);

  return {
    id: `fused_fj_${group.tasks[0].id}`,

    type: "code_execution",

    tool: "code:fork_join", // Special pseudo-tool for fork-join

    code: fusedCode,

    arguments: {},

    dependsOn: group.commonDependencies,

    sandboxConfig: group.tasks[0].sandboxConfig,

    metadata: {
      fusedFrom: group.tasks.map((t) => t.id),

      logicalTools: group.tasks.map((t) => t.tool),

      fusionPattern: "fork-join", // NEW: Indicate pattern type

      branchCount: group.tasks.length,
    },
  };
}
```

---

## 3. Stratégie d'Optimisation Phase 2b

### Modification de `optimizeDAG()`

**Fichier** : `src/dag/dag-optimizer.ts`

```typescript
/**

 * Optimize DAG using full strategy (Phase 2b)

 *

 * Combines sequential fusion (Phase 2a) + fork-join fusion (Phase 2b)

 */

function optimizeFull(
  logicalDAG: DAGStructure,
  maxFusionSize: number,
): OptimizedDAGStructure {
  const layers = computeLayers(logicalDAG);

  const physicalTasks: Task[] = [];

  const logicalToPhysical = new Map<string, string>();

  const physicalToLogical = new Map<string, string[]>();

  for (const layer of layers) {
    // Step 1: Find fork-join groups (parallel in same layer)

    const forkJoinGroups = findForkJoinGroups(layer, logicalDAG);

    const processedInForkJoin = new Set<string>();

    // Fuse fork-join groups

    for (const group of forkJoinGroups) {
      const fusedTask = fuseForkJoinGroup(group);

      physicalTasks.push(fusedTask);

      // Update mappings

      for (const logicalTask of group.tasks) {
        logicalToPhysical.set(logicalTask.id, fusedTask.id);

        processedInForkJoin.add(logicalTask.id);
      }

      physicalToLogical.set(
        fusedTask.id,
        group.tasks.map((t) => t.id),
      );
    }

    // Step 2: Handle remaining tasks (sequential fusion or standalone)

    const remainingTasks = layer.filter((t) => !processedInForkJoin.has(t.id));

    for (const task of remainingTasks) {
      // Try sequential fusion (Phase 2a)

      const chain = findSequentialChain(task, logicalDAG, processedInForkJoin, maxFusionSize);

      if (chain.length > 1) {
        const fusedTask = fuseSequentialChain(chain);

        physicalTasks.push(fusedTask);

        for (const logicalTask of chain) {
          logicalToPhysical.set(logicalTask.id, fusedTask.id);

          processedInForkJoin.add(logicalTask.id);
        }

        physicalToLogical.set(
          fusedTask.id,
          chain.map((t) => t.id),
        );
      } else if (!processedInForkJoin.has(task.id)) {
        // Standalone task

        physicalTasks.push(task);

        logicalToPhysical.set(task.id, task.id);

        physicalToLogical.set(task.id, [task.id]);
      }
    }
  }

  return {
    tasks: physicalTasks,

    logicalToPhysical,

    physicalToLogical,

    logicalDAG,
  };
}

// Update main function

export function optimizeDAG(
  logicalDAG: DAGStructure,
  config: OptimizationConfig = {},
): OptimizedDAGStructure {
  const { strategy = "sequential" } = config;

  if (strategy === "sequential") {
    return optimizeSequential(logicalDAG, config.maxFusionSize ?? 10);
  }

  if (strategy === "full") {
    return optimizeFull(logicalDAG, config.maxFusionSize ?? 10);
  }

  throw new Error(`Unknown optimization strategy: ${strategy}`);
}
```

---

## 4. UI : Affichage des Branches Parallèles

### Modification de FusedTaskCard

**Fichier** : `src/web/components/ui/atoms/FusedTaskCard.tsx`

```typescript
export default function FusedTaskCard({
  logicalOps,

  durationMs,

  success,

  color,

  fusionPattern, // NEW: "sequential" | "fork-join"
}: FusedTaskCardProps) {
  const [expanded, setExpanded] = useState(false);

  // Detect fork-join pattern from metadata

  const isForkJoin = fusionPattern === "fork-join";

  return (
    <div onClick={() => setExpanded(!expanded)}>
      {/* Header */}

      <div>
        <span>{isForkJoin ? "⚡" : "📦"}</span>

        <span>
          {isForkJoin ? "Fork-Join" : "Fused"} ({logicalOps.length} ops)
        </span>

        <span>{Math.round(durationMs)}ms</span>

        <span>{expanded ? "▼" : "▶"}</span>
      </div>

      {/* Expandable */}

      {expanded && (
        <div>
          {isForkJoin
            ? (
              // Fork-Join: Show parallel branches

              <div>
                <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>
                  ⚡ Parallel execution:
                </div>

                {logicalOps.map((op, idx) => (
                  <div key={idx}>
                    <span style={{ color: "#999" }}>├─ [Branch {idx + 1}]</span>{" "}
                    <span>{op.toolId.replace("code:", "")}</span>

                    {op.durationMs && <span>({Math.round(op.durationMs)}ms)</span>}
                  </div>
                ))}
              </div>
            )
            : (
              // Sequential: Show chain

              logicalOps.map((op, idx) => {
                const isLast = idx === logicalOps.length - 1;

                return (
                  <div key={idx}>
                    <span>{isLast ? "└─" : "├─"}</span>{" "}
                    <span>{op.toolId.replace("code:", "")}</span>

                    {op.durationMs && <span>({Math.round(op.durationMs)}ms)</span>}
                  </div>
                );
              })
            )}
        </div>
      )}
    </div>
  );
}
```

### Exemple Visuel

**Fork-Join (Phase 2b) :**

```
┌─────────────────────────────────┐

│ ⚡ Fork-Join (4 ops) 60ms       ▶│

└─────────────────────────────────┘

 

Expanded:

┌─────────────────────────────────┐

│ ⚡ Fork-Join (4 ops) 60ms       ▼│

│   ⚡ Parallel execution:         │

│   ├─ [Branch 1] reduce (15ms)   │

│   ├─ [Branch 2] divide (15ms)   │

│   ├─ [Branch 3] reduce (15ms)   │

│   └─ [Branch 4] divide (15ms)   │

└─────────────────────────────────┘
```

---

## 5. Traces : Pas de Changement pour SHGAT

### Trace Generator reste IDENTIQUE

**Fichier** : `src/dag/trace-generator.ts`

```typescript
// AUCUN changement nécessaire !

// generateLogicalTrace() fonctionne déjà :

// - Parcourt optimizedDAG.logicalDAG (pas physique)

// - Génère executedPath avec toutes les opérations logiques

// - Fonctionne pour sequential ET fork-join
```

**Preuve** : Le code actuel itère sur `logicalDAG.tasks`, pas sur les tâches physiques !

```typescript
for (const logicalTask of optimizedDAG.logicalDAG.tasks) {
  executedPath.push(logicalTask.tool); // ← TOUJOURS les opérations logiques
}
```

**Résultat** : SHGAT voit exactement les mêmes traces avec Phase 2a ou Phase 2b !

---

## 6. Backend : Enrichissement des Traces

### Modification mineure dans execute-handler.ts

**Détection du pattern** :

```typescript
const fusionPattern = physicalTask?.metadata?.fusionPattern ?? "sequential";

return {
  taskId: physicalResult.taskId,

  tool: physicalTask?.tool || "unknown",

  // ... autres fields

  isFused: fused,

  logicalOperations: logicalOps,

  fusionPattern: fusionPattern, // NEW: pour l'UI
};
```

**Ajout au type** : `src/capabilities/types.ts`

```typescript
export interface TraceTaskResult {
  // ... existing fields

  isFused?: boolean;

  logicalOperations?: LogicalOperation[];

  fusionPattern?: "sequential" | "fork-join"; // NEW
}
```

---

## 7. Tests

### Test Fork-Join Simple

```typescript
// Code à tester

const users = await mcp.db.query({ sql: "SELECT * FROM users" });

const active = users.filter((u) => u.active);

// Parallel calculations

const avgAge = active.reduce((s, u) => s + u.age, 0) / active.length;

const avgSalary = active.reduce((s, u) => s + u.salary, 0) / active.length;

// DAG Logique attendu :

// Layer 0: db:query

// Layer 1: filter

// Layer 2: reduce_age, reduce_salary (parallel)

// Layer 3: divide_age, divide_salary (parallel)

// DAG Physique attendu (Phase 2b) :

// Layer 0: db:query

// Layer 1: filter

// Layer 2: fused_fork_join(reduce_age + divide_age, reduce_salary + divide_salary)

// Trace SHGAT attendue (IDENTIQUE Phase 2a et 2b) :

executedPath: [
  "db:query",

  "code:filter",

  "code:reduce", // age

  "code:reduce", // salary

  "code:divide", // age

  "code:divide", // salary
];

// UI attendue :

// ┌─────────────────────────────┐

// │ ⚡ Fork-Join (4 ops) 60ms   ▶│

// └─────────────────────────────┘
```

---

## 8. Ordre d'Implémentation

### Étape 1 (2 jours) : Détection Fork-Join

- [ ] Implémenter `findForkJoinGroups()`

- [ ] Implémenter `haveSameDependencies()`

- [ ] Implémenter `canFuseWithForkJoin()`

- [ ] Tests unitaires

### Étape 2 (1 jour) : Génération Code

- [ ] Implémenter `generateForkJoinCode()`

- [ ] Implémenter `fuseForkJoinGroup()`

- [ ] Tests génération code

### Étape 3 (2 jours) : Stratégie Full

- [ ] Implémenter `optimizeFull()`

- [ ] Combiner sequential + fork-join

- [ ] Tests E2E optimisation

### Étape 4 (1 jour) : UI

- [ ] Modifier FusedTaskCard (icône ⚡, branches)

- [ ] Ajouter fusionPattern au type

- [ ] Tests visuels

### Étape 5 (1 jour) : Tests & Doc

- [ ] Tests E2E complets

- [ ] Vérifier SHGAT traces identiques

- [ ] Benchmarks performance

- [ ] Documentation

**Total : ~7 jours**

---

## 9. Gains Attendus

### Performance

| Scénario | Phase 2a | Phase 2b | Gain |

|----------|----------|----------|------|

| Sequential (A→B→C) | 3 → 1 layer | 3 → 1 layer | 0% (déjà optimal) |

| Fork-Join (A→(B,C)→D) | 4 layers | 3 layers | 25% |

| Complex (A→(B,C,D,E)→F) | 6 layers | 3 layers | 50% |

### HIL Validations

| Scénario | Phase 2a | Phase 2b | Gain |

|----------|----------|----------|------|

| Sequential | 3 → 1 | 3 → 1 | 0% |

| Fork-Join | 4 validations | 3 validations | 25% |

| Complex | 6 validations | 3 validations | 50% |

---

## 10. Résumé

### Ce qui change avec Phase 2b

✅ **Exécution** : Fusion des branches parallèles (Promise.all)

✅ **Performance** : 20-50% de layers en moins selon patterns

✅ **UI** : Affichage branches parallèles (⚡ icon)

### Ce qui NE change PAS

❌ **SHGAT Learning** : Traces logiques IDENTIQUES

❌ **Trace Generator** : Code existant fonctionne déjà

❌ **Backend traces** : Juste ajout fusionPattern (optionnel)

**Phase 2b = Pure optimisation exécution, zéro impact learning ! 🚀**

---

## 11. Fixes Implémentés (2025-12-27)

### Fix 1: Nested Operations Not Executable

**Problème**: SWC extrait des opérations imbriquées dans les callbacks qui génèrent du code
invalide.

```typescript
// Code utilisateur
[1, 2, 3].map((n) => n * 2);

// Bug: Crée 2 tasks
// - code:map (executable ✓)
// - code:multiply (non-executable ✗) → `n * 2` invalide hors contexte callback
```

**Solution**: Metadata `executable: false` pour les opérations imbriquées.

```typescript
// static-structure-builder.ts
nodes.push({
  id,
  type: "task",
  tool: toolId,
  metadata: {
    executable: nestingLevel === 0, // false si dans un callback
    nestingLevel,
    parentOperation: currentParentOp, // "map", "filter", etc.
  },
});

// static-to-dag-converter.ts - Option B: Filter non-executable
const executableTasks = layer.filter((t) => t.metadata?.executable !== false);
```

### Fix 2: Pre-Execution HIL (Human-in-the-Loop)

**Problème**: HIL demandait "continue?" APRÈS l'exécution, pas avant.

```
// AVANT (broken)
Execute task → SUCCESS → "continue/abort?" → (inutile, c'est fait)

// APRÈS (correct)
"About to execute X. Continue?" → (user: yes) → Execute task → return result
```

**Solution**: Check HIL AVANT `Promise.allSettled` dans `controlled-executor.ts`:

```typescript
// controlled-executor.ts ~ligne 427
const hilTasks = executableTasks.filter(taskRequiresHIL);
if (hilTasks.length > 0) {
  yield { type: "decision_required", tasks: hilTasks, ... };
  const cmd = await waitForDecisionCommand(...);
  if (cmd.type === "abort") return;
}
// Seulement APRÈS approbation
let layerResults = await Promise.allSettled(...);
```

**Helper**:

```typescript
function taskRequiresHIL(task: Task): boolean {
  if (!task.tool) return false;
  const prefix = task.tool.split(":")[0];
  const config = getToolPermissionConfig(prefix);
  return !config || config.approvalMode === "hil";
}
```

### Fix 3: MCP Permissions Init

**Problème**: `mcp-permissions.yaml` n'était pas chargé au démarrage → tous les tools considérés
"unknown" → HIL partout.

**Solution**: Appeler `initMcpPermissions()` au démarrage du gateway:

```typescript
// gateway-server.ts
async start(): Promise<void> {
  await initMcpPermissions(); // Load mcp-permissions.yaml
  await this.initializeAlgorithms();
  ...
}
```

### Fix 4: Capabilities Calling Conventions

**Syntaxes supportées**:

| Syntaxe                       | Format Généré             | Handler            | Status  |
| ----------------------------- | ------------------------- | ------------------ | ------- |
| `mcp.filesystem.read()`       | `filesystem:read`         | mcpClients proxy   | ✓ Works |
| `mcp.std.cap_list()`          | `std:cap_list`            | PmlStdServer       | ✓ Works |
| `capabilities.double_array()` | node `type: "capability"` | CapabilityExecutor | ✓ Works |
| `mcp.cap.double_array()`      | `cap:double_array`        | ❌ Pas de handler  | 🔧 TODO |

**TODO**: Router `cap:xxx` vers CapabilityMCPServer ou convertir en `mcp__cap__xxx`.

### Fichiers Modifiés

| Fichier                                   | Changement                               |
| ----------------------------------------- | ---------------------------------------- |
| `src/dag/controlled-executor.ts`          | `taskRequiresHIL()` + pre-exec HIL check |
| `src/dag/types.ts`                        | Ajout `workflow_abort` event type        |
| `src/capabilities/permission-inferrer.ts` | Export `initMcpPermissions()`            |
| `src/mcp/gateway-server.ts`               | Appel `initMcpPermissions()` au start    |
| `config/mcp-permissions.yaml`             | Ajout `std: approvalMode: auto`          |
