# Spike: MCP Workflow State Persistence

**Status:** In Progress **Created:** 2025-11-25 **Story:** 2.5-4 (MCP Control Tools & Per-Layer
Validation)

## Problem Statement

Pour les MCP control tools (Story 2.5-4), un agent externe (Claude Code) doit pouvoir:

1. Appeler `pml:execute` avec `per_layer_validation: true`
2. Recevoir `{ status: "layer_complete", workflow_id: "..." }`
3. Appeler `pml:continue(workflow_id)` pour continuer

**Problème découvert:** Le `Checkpoint` actuel ne sauvegarde PAS le DAG original!

```typescript
interface Checkpoint {
  id: string;
  workflow_id: string;
  timestamp: Date;
  layer: number;
  state: WorkflowState; // Tasks, decisions, context - mais PAS le DAG!
}
```

Quand `continue(workflow_id)` est appelé, on ne peut pas reprendre car on n'a pas le DAG:

```typescript
// resumeFromCheckpoint() REQUIERT le DAG!
async *resumeFromCheckpoint(
  dag: DAGStructure,      // ← D'où vient-il?
  checkpoint_id: string,
)
```

## Questions à Résoudre

1. **Où stocker le DAG pour MCP stateless?**
   - Option A: Dans le checkpoint (modifier schéma)
   - Option B: Dans `context` du WorkflowState (hacky)
   - Option C: Table séparée `workflow_dags` (propre)
   - Option D: In-memory avec timeout (workflow-state.ts)

2. **Fan-in/Fan-out impacté?**
   - Le topological sort gère déjà fan-in/fan-out
   - Le checkpoint sauve après chaque layer complet
   - Pas d'impact direct, mais le DAG doit persister

3. **Performance?**
   - Un DAG peut être gros (100+ tâches)
   - Sérialisation JSONB dans PGlite
   - Benchmark nécessaire

## Options Détaillées

### Option A: Ajouter DAG au Checkpoint

```typescript
interface Checkpoint {
  id: string;
  workflow_id: string;
  timestamp: Date;
  layer: number;
  state: WorkflowState;
  dag: DAGStructure; // ← NOUVEAU
}
```

**Avantages:**

- Simple, tout au même endroit
- Survit au restart
- Auto-cleanup avec pruning existant

**Inconvénients:**

- Duplication: même DAG pour chaque checkpoint
- Taille: DAG peut être gros
- Migration nécessaire

### Option B: Stocker DAG dans WorkflowState.context

```typescript
// Dans execute()
state.context = {
  ...state.context,
  __dag: dag, // Convention: préfixe __
};
```

**Avantages:**

- Pas de migration
- Pas de nouveau champ

**Inconvénients:**

- Hacky, pollution du context
- Pas explicite
- Fragile

### Option C: Table Séparée `workflow_dags`

```sql
CREATE TABLE workflow_dags (
  workflow_id TEXT PRIMARY KEY,
  dag JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP  -- Auto-cleanup
);
```

**Avantages:**

- Propre, séparation des concerns
- Un seul DAG par workflow (pas de duplication)
- TTL explicite

**Inconvénients:**

- Nouvelle table, nouvelle migration
- Cleanup séparé des checkpoints

### Option D: In-Memory (workflow-state.ts)

```typescript
const activeWorkflows = new Map<string, {
  dag: DAGStructure;
  executor: ControlledExecutor;
  // ...
}>();
```

**Avantages:**

- Simple, rapide
- Pas de persistence

**Inconvénients:**

- Perdu au restart
- Pas de recovery possible
- C'était l'approche rushée qu'on a supprimée

## Décision: Option C (Table Séparée)

**Choix:** Table `workflow_dags` séparée des checkpoints.

**Raisons:**

1. **Pas de duplication** - Un workflow = un DAG (vs 5x dans checkpoints)
2. **Séparation des concerns** - DAG ≠ Checkpoint state
3. **Cleanup indépendant** - TTL propre, pas lié au pruning checkpoints
4. **Plus propre architecturalement** - Normalisation des données

**Schéma:**

```sql
CREATE TABLE workflow_dags (
  workflow_id TEXT PRIMARY KEY,
  dag JSONB NOT NULL,
  intent TEXT,  -- Pour debug/observabilité
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '1 hour'
);

-- Index pour cleanup
CREATE INDEX idx_workflow_dags_expires ON workflow_dags(expires_at);
```

**Flow:**

```
execute(intent, per_layer_validation: true)
  │
  ├─► DAGSuggester.suggest(intent) → DAG
  │
  ├─► INSERT INTO workflow_dags(workflow_id, dag, intent)
  │
  ├─► ControlledExecutor.executeStream(dag)
  │
  └─► Return { workflow_id, checkpoint_id, layer_results }

continue(workflow_id)
  │
  ├─► SELECT dag FROM workflow_dags WHERE workflow_id = ?
  │
  ├─► CheckpointManager.loadCheckpoint(checkpoint_id)
  │
  ├─► ControlledExecutor.resumeFromCheckpoint(dag, checkpoint_id)
  │
  └─► Return { checkpoint_id, layer_results } ou { status: complete }
```

**Estimation impact:**

- Migration 008: CREATE TABLE workflow_dags
- Nouveau module: `src/mcp/workflow-dag-store.ts`
- Modifier handlers dans `gateway-server.ts`
- Cleanup job (cron ou on-demand)

## Actions

- [x] Valider l'option avec @user → **Option C choisie**
- [ ] Créer migration 008 pour table `workflow_dags`
- [ ] Créer `src/mcp/workflow-dag-store.ts`
- [ ] Implémenter handlers dans `gateway-server.ts`
- [ ] Ajouter cleanup automatique (TTL 1h)
- [ ] Tests d'intégration

## Références

- `src/dag/checkpoint-manager.ts` - CheckpointManager existant
- `src/dag/controlled-executor.ts` - resumeFromCheckpoint()
- `src/dag/types.ts:212` - Interface Checkpoint
- `docs/adrs/ADR-020-ail-control-protocol.md` - Architecture AIL
- Story 2.5-2: Checkpoint & Resume
