## Pattern 6: Two-Level DAG Architecture (Phase 2a)

> **Source:** `src/dag/dag-optimizer.ts`, `src/capabilities/static-structure-builder.ts`
> **Tech-Spec:**
> [`docs/tech-specs/modular-dag-execution/`](../../tech-specs/modular-dag-execution/index.md)
> **Related:** ADR-052 (Dynamic Capability Routing), ADR-053 (SHGAT Subprocess Training)

**Problem:** Le DAG logique contient toutes les opérations comme tâches séparées (pour que SHGAT
apprenne chaque opération), mais l'exécution devient inefficace avec beaucoup de layers.

**Solution Architecture:**

### Two-Level DAG

```
Logical DAG (SHGAT learning)         Physical DAG (Execution)
┌─────────────────────────┐          ┌────────────────────────┐
│ n1: code:parseInt       │          │ fused_n1:              │
│         ↓               │    ══>   │  parseInt + filter +   │
│ n2: code:filter         │          │  map (single task)     │
│         ↓               │          └────────────────────────┘
│ n3: code:map            │
└─────────────────────────┘
```

- **Logical DAG:** Toutes les opérations séparées → SHGAT voit la granularité complète
- **Physical DAG:** Tâches fusionnées → Moins de layers, exécution efficace
- **Mapping:** `physicalToLogical` permet de générer les traces pour SHGAT depuis les résultats
  physiques

### Phase 2a: Sequential Fusion

```typescript
// Fusion rules (canFuseTasks):
// 1. All tasks must be code_execution
// 2. All tasks must be executable standalone (not nested in callbacks)
// 3. All tasks must be pure operations (metadata.pure === true)
// 4. All tasks must have same permission set
// 5. No MCP calls in the code (no side effects)

const optimized = optimizeDAG(logicalDAG, {
  enabled: true,
  maxFusionSize: 10,
  strategy: "sequential", // Phase 2a only
});
// optimized.tasks = fused physical tasks
// optimized.physicalToLogical = Map<physicalId, logicalIds[]>
```

### Option B: Nested Operations (Non-Executable)

Les opérations imbriquées dans des callbacks (ex: inside `.map()`, `.filter()`) sont marquées comme
`executable: false`:

```typescript
// Code: array.map(x => x * 2)
// Static analysis detects:
{
  id: "n2",
  type: "task",
  tool: "code:multiply",
  metadata: {
    executable: false,      // Cannot be executed standalone
    nestingLevel: 1,        // Inside callback
    parentOperation: "code:map"
  }
}
```

Ces tâches:

- Sont **exclues** de la Physical DAG (non exécutées séparément)
- Sont **incluses** dans la Logical DAG (SHGAT les voit pour apprendre)
- Sont **exécutées** comme partie du parent operation

### Pre-Execution HIL Approval

L'approbation HIL se fait **AVANT** l'exécution, pas après:

```typescript
// ControlledExecutor flow:
// 1. Build logical DAG
// 2. Optimize to physical DAG
// 3. → HIL approval checkpoint (BEFORE execution)
// 4. Execute physical tasks
// 5. Map results to logical traces
// 6. Update SHGAT
```

### Operation vs Tool Node Types

Séparation claire dans le graphe:

| Node Type   | Description                | Example                |
| ----------- | -------------------------- | ---------------------- |
| `tool`      | MCP tool avec side effects | `filesystem:read_file` |
| `operation` | Code operation pure        | `code:filter`          |
| `task`      | Generic task in workflow   | Fused code block       |

Cette séparation permet:

- SHGAT d'apprendre les patterns d'opérations distinctement des tools
- L'optimizer de savoir quelles tâches peuvent être fusionnées
- La UI d'afficher les détails de fusion

### Fusion Display in UI

Le dashboard affiche les détails de fusion pour chaque tâche physique:

```typescript
// TracingPanel shows:
{
  physicalTask: "fused_n1",
  fusedFrom: ["n1", "n2", "n3"],
  logicalTools: ["code:parseInt", "code:filter", "code:map"],
  fusionRate: "67%" // (1 - 1/3) * 100
}
```

**Affects:** Epic 10 (Static Analysis), Epic 11 (SHGAT Learning)

---
