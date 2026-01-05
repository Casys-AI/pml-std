# ADR-007: DAG Adaptatif avec Feedback Loops AIL/HIL et Re-planification Dynamique

**Status:** ✅ Implemented **Date:** 2025-11-13 | **Updated:** 2025-11-24 | **Deciders:** BMad

> **Note:** AIL/HIL implementation details superseded by ADR-019.

> **⚠️ UPDATE 2025-11-24:** AIL/HIL implementation approach clarified in **ADR-019: Two-Level AIL
> Architecture**. SSE streaming pattern incompatible with MCP one-shot protocol. Use Gateway HTTP
> response pattern for production MCP compatibility.

---

## Context

### Système Actuel

Le système Casys PML utilise un `ParallelExecutor` qui exécute un DAG de manière linéaire et
complète en une seule passe:

```typescript
class ParallelExecutor {
  async execute(dag: DAGStructure): Promise<DAGExecutionResult> {
    for (const layer of topologicalLayers) {
      await Promise.all(layer.map((task) => executeTask(task)));
    }
    return results;
  }
}
```

**Performances actuelles:**

- ✅ Speedup 5x grâce au parallélisme par layer
- ✅ Exécution déterministe et prévisible
- ✅ Simple à comprendre et débugger

### Gap Identifié

**Limitations critiques:**

1. **Pas de feedback loops:** Exécution linéaire sans possibilité d'interaction
2. **Pas de points de décision:** L'IA ne peut pas faire de choix stratégiques
3. **Pas de multi-turn:** Aucune conversation au sein de l'exécution
4. **Pas de Human-in-the-Loop (HIL):** Impossible de demander validation humaine
5. **Pas d'Agent-in-the-Loop (AIL):** Pas de décisions autonomes avec révision
6. **Pas de branches conditionnelles:** Flux fixe, pas d'adaptation
7. **Pas de re-planification:** GraphRAG ne peut pas être redéclenché
8. **State management manuel:** Error-prone, pas de patterns établis

### Déclencheur

Un spike technique (`docs/spikes/spike-agent-human-dag-feedback-loop.md`) a exploré 3 design options
et identifié le besoin d'une architecture supportant:

- Feedback loops agent et humain
- Multi-turn conversations
- Modification dynamique du DAG
- Re-déclenchement GraphRAG après changement de contexte

---

## Decision Drivers

### Priorités (ordre d'importance)

1. **Requirements Coverage (30%)** - Tous les besoins fonctionnels couverts
2. **Performance (25%)** - Maintenir speedup 5x, minimiser overhead
3. **Implementation Effort (20%)** - Time to market, complexity
4. **State Management (15%)** - Robustesse, persistence, recovery
5. **Developer Experience (10%)** - Maintenabilité, debugging

### Contraintes Non-Négociables

- ❌ **Zéro breaking changes** - Extension compatible de l'architecture existante
- ✅ **Backward compatibility** - Code existant doit continuer de fonctionner
- ✅ **Performance preservation** - Speedup 5x maintenu
- ✅ **Production-ready** - Pas de POC throwaway, code de qualité
- ✅ **TypeScript/Deno stack** - Pas de changement de stack

---

## Options Considered

### Option 1: Synchronous Checkpoints

**Description:** Pause synchrone après chaque layer pour validation.

**Architecture:**

```typescript
for (const layer of layers) {
  await executeLayer(layer);
  const decision = await checkpoint(); // BLOCKING
  if (decision === "abort") break;
}
```

**Score:** 68/100

**Avantages:**

- 🟢 Très simple à implémenter (2-3h)
- 🟢 Compatible architecture existante
- 🟢 Facile à débugger

**Inconvénients:**

- 🔴 Bloque l'exécution (1-3s attente agent/humain)
- 🔴 Pas de contrôle task-level (seulement layer-level)
- 🔴 Incompatible avec speculative execution

**Verdict:** MVP acceptable, mais pas production-ready.

---

### Option 2: Async Event Stream with Command Injection

**Description:** Event stream asynchrone + command queue pour control dynamique.

**Architecture:**

```typescript
class ControlledExecutor extends ParallelExecutor {
  private commandQueue: AsyncQueue<Command>;
  private eventStream: TransformStream<ExecutionEvent>;
  private state: WorkflowState;

  async *executeStream(dag: DAGStructure) {
    for (const layer of layers) {
      yield { type: "layer_start", layer };

      // Process commands before layer
      await this.processCommands();

      // Execute layer
      const results = await executeLayer(layer);

      // Update state with reducers
      this.updateState({ tasks: results });

      // Checkpoint
      await this.checkpoint();

      yield { type: "checkpoint", state: this.state };
    }
  }
}
```

**Score:** 92/100 (initial) → **95/100** (with MessagesState patterns)

**Avantages:**

- ✅ Non-blocking, haute performance
- ✅ Flexible et extensible
- ✅ Agent + Human control simultané
- ✅ Observable (event stream)
- ✅ Compatible speculative execution
- ✅ Pas de breaking changes

**Inconvénients:**

- ⚠️ Complexité moyenne (event-driven + reducers)
- ⚠️ Race conditions possibles (mitigable avec AsyncQueue thread-safe)
- ⚠️ State bloat possible (nécessite pruning)

**Verdict:** ⭐ Recommandé

---

### Option 3: Reactive Generator Pattern

**Description:** Generator pattern avec yield/next pour construction dynamique du DAG.

**Score:** Non recommandé (60/100)

**Inconvénient majeur:** Exécution séquentielle → perd le speedup 5x.

---

### Option 4: State Machine (LangGraph-style)

**Description:** Modéliser le DAG comme une state machine explicite avec nodes/edges.

**Architecture:**

```typescript
const graph = new StateGraph<WorkflowState>();
graph.addNode("task1", async (state) => ({ ...state, result1: "..." }));
graph.addConditionalEdge("task1", (state) => state.condition ? "task2" : "task3");
```

**Score:** 80/100

**Avantages:**

- ✅ State-first design élégant
- ✅ Checkpointing automatique
- ✅ HIL natif (interrupt pattern)
- ✅ Visualisable

**Inconvénients:**

- 🔴 Breaking changes majeurs (refactoring complet)
- 🔴 Migration coûteuse (20-30h)
- 🟡 Parallélisme moins naturel

**Verdict:** 🟡 Excellent pour nouveau projet, trop coûteux pour Casys PML.

---

### Option 5: Pure MessagesState (LangGraph v1.0)

**Description:** Utiliser le pattern MessagesState de LangGraph avec reducers automatiques.

**Score:** 75/100

**Avantages:**

- ✅ Reducers automatiques (add_messages)
- ✅ Moins de boilerplate (15% reduction)
- ✅ Multi-turn natif
- ✅ Type safety

**Inconvénients:**

- 🔴 Pas d'observability temps réel
- 🟡 State bloat (messages s'accumulent)
- 🟡 Moins de contrôle sur event flow

**Verdict:** 🟡 Bons patterns à adopter, mais incomplet sans event stream.

---

### Options 6-8: BPMN, Saga, Continuation-Based

**Verdict:** ❌ Trop complexes ou overkill pour notre use case.

---

## Decision

### Architecture Choisie: **Option 2 Enhanced - Async Event Stream + Commands + MessagesState-inspired Reducers** ⭐⭐

**Rationale:** Combine le meilleur des deux mondes:

- Event Stream → Observability temps réel
- MessagesState Reducers → State management robuste

### Architecture Détaillée

#### 1. State Management (MessagesState-inspired)

```typescript
interface WorkflowState {
  messages: Message[]; // Reducer: add_messages (append)
  tasks: TaskResult[]; // Reducer: add_tasks (append)
  decisions: Decision[]; // Reducer: add_decisions (append)
  context: Record<string, any>; // Reducer: merge (deep merge)
  checkpoint_id?: string;
}

const reducers = {
  messages: (existing, update) => [...existing, ...update],
  tasks: (existing, update) => [...existing, ...update],
  decisions: (existing, update) => [...existing, ...update],
  context: (existing, update) => ({ ...existing, ...update }),
};
```

**Inspiration:** LangGraph v1.0 MessagesState best practices

- "Keep state minimal, explicit, and typed"
- "Use reducer helpers only where you truly need accumulation"

#### 2. Event Stream (Observability)

```typescript
type ExecutionEvent =
  | { type: "layer_start"; layer: number; tasks: Task[] }
  | { type: "task_complete"; taskId: string; result: TaskResult }
  | { type: "state_updated"; state: WorkflowState }
  | { type: "checkpoint"; checkpoint_id: string; state: WorkflowState }
  | { type: "error"; taskId: string; error: Error };
```

**Inspiration:** Event-Driven.io patterns, Prefect observability

#### 3. Command Queue (Control)

```typescript
type Command =
  | { type: "abort"; reason: string }
  | { type: "inject_task"; task: Task }
  | { type: "skip_layer"; layerIndex: number }
  | { type: "modify_args"; taskId: string; newArgs: unknown }
  | { type: "update_state"; update: Partial<WorkflowState> }
  | { type: "checkpoint_response"; approved: boolean };
```

**Inspiration:** CQRS patterns, command bus

#### 4. Execution Flow

```typescript
class ControlledExecutor extends ParallelExecutor {
  private state: WorkflowState;
  private commandQueue: AsyncQueue<Command>;
  private eventStream: TransformStream<ExecutionEvent>;

  // State updates avec reducers automatiques
  private updateState(update: Partial<WorkflowState>) {
    for (const key of Object.keys(update)) {
      if (reducers[key]) {
        this.state[key] = reducers[key](this.state[key], update[key]);
      } else {
        this.state[key] = update[key];
      }
    }

    // Emit event pour observability
    this.emit({ type: "state_updated", state: this.state });

    // Auto-checkpoint
    await this.checkpoint();
  }

  async *executeStream(dag: DAGStructure, config: ExecutionConfig) {
    // Initialize state
    this.state = { messages: [], tasks: [], decisions: [], context: {} };

    for (const layer of topologicalLayers(dag)) {
      yield { type: "layer_start", layer };

      // Process commands (agent/human control)
      await this.processCommands();

      // Execute layer in parallel
      const results = await Promise.all(
        layer.map((task) => this.executeTask(task)),
      );

      // Update state avec reducers
      this.updateState({ tasks: results });

      // Checkpoint
      const checkpoint = await this.checkpoint();
      yield { type: "checkpoint", checkpoint_id: checkpoint.id, state: this.state };

      // Check for abort
      if (this.shouldAbort()) break;
    }

    return this.state;
  }
}
```

---

## Checkpoint Architecture & Limitations

### What Checkpoints Save

Les checkpoints sauvegardent l'**état complet du workflow** dans PGlite :

```typescript
interface Checkpoint {
  id: string; // Unique checkpoint ID
  workflow_id: string; // Parent workflow
  timestamp: Date; // When checkpoint was created
  layer: number; // Current DAG layer (0, 1, 2...)
  state: WorkflowState; // Complete workflow state
}

interface WorkflowState {
  workflow_id: string;
  current_layer: number;
  tasks: TaskResult[]; // Completed tasks with results
  decisions: Decision[]; // AIL/HIL decisions made
  commands: Command[]; // Pending commands
  messages: Message[]; // Multi-turn conversation history
  context: Record<string, any>; // Workflow context
  checkpoint_id?: string;
}
```

**Storage:**

- PGlite database (persistent)
- Saved after each DAG layer execution
- Retention: Keep 5 most recent checkpoints per workflow

### What Checkpoints DON'T Save

⚠️ **Limitation Critique:** Les checkpoints **ne sauvegardent PAS** :

1. **État du filesystem** (fichiers modifiés, créés, supprimés)
2. **Side-effects externes** (API calls, database writes)
3. **État de l'environnement** (variables d'environnement, processus en cours)
4. **Diffs de code** (changements dans la codebase)

### Implications par Type de Workflow

#### ✅ Workflows Read-Only (Ideal Case)

**Exemples:**

- Analyse de codebase (queries GraphRAG, vector search)
- Data extraction (scraping, parsing)
- Reporting (generate docs from existing data)

**Comportement au Resume:**

```
Layer 0: Query GraphRAG → Checkpoint saved
Layer 1: Analyze results → Crash ❌
Resume: Relance Layer 1 avec state de Layer 0
```

**✅ Résultat:** Resume parfait, zéro data loss.

#### ⚠️ Workflows avec Modifications (Problematic)

**Exemples:**

- Code generation (write files)
- Refactoring (modify multiple files)
- Database migrations (schema changes)

**Comportement au Resume:**

```
Layer 0: Modify A.ts, B.ts → Checkpoint saved
Layer 1: Modify C.ts → Crash ❌ (C.ts partiellement écrit)
Resume: Checkpoint dit "relance Layer 1"
Mais C.ts est dans un état inconsistant !
```

**❌ Risque:** Corruption de données, état incohérent.

### Stratégies de Mitigation pour Epic 2.5

Epic 2.5 (ADR-007) se concentre sur **l'orchestration et la décision**, pas sur l'exécution de code
:

#### 1. Workflows Primaires = Orchestration (✅ Safe)

Les workflows principaux d'Epic 2.5 sont :

- **Loop 1 (Execution):** Command queue, event stream, state management
- **Loop 2 (Adaptation):** AIL/HIL decisions, DAG replanning, GraphRAG queries
- **Loop 3 (Meta-Learning):** GraphRAG updates, pattern learning

**Aucune modification directe de fichiers** → Checkpoints suffisants.

#### 2. Délégation à des Tasks Atomiques (✅ Mitigation)

Si un workflow Epic 2.5 doit modifier des fichiers, il **délègue** à des tasks atomiques :

```typescript
// Epic 2.5 workflow (orchestration only)
const dag = {
  layer0: [
    { type: "analyze_code", tool: "graphrag_query" },
    { type: "generate_plan", tool: "llm_reasoning" }
  ],
  layer1: [
    {
      type: "delegate_code_modification",
      tool: "epic3_sandbox_executor",  // ← Délégué à Epic 3
      args: { files: ["A.ts", "B.ts"], changes: [...] }
    }
  ]
};
```

**Avantage:**

- Epic 2.5 checkpoint = orchestration state uniquement
- Epic 3 (Sandbox) gère l'isolation et la persistance des modifications

#### 3. Idempotence Requise pour Tasks (⚠️ Manual Effort)

Si une task Epic 2.5 écrit directement des fichiers (non-délégué), elle **DOIT** être idempotente :

```typescript
// ❌ Non-idempotent (échoue au re-run)
async function writeConfig() {
  fs.appendFileSync("config.json", newData); // Duplicate au resume!
}

// ✅ Idempotent (safe au re-run)
async function writeConfig() {
  const existing = JSON.parse(fs.readFileSync("config.json"));
  const merged = { ...existing, ...newData };
  fs.writeFileSync("config.json", JSON.stringify(merged));
}
```

**Responsabilité:** Développeur de la task (pas géré automatiquement).

### Résolution Complète : Epic 3 (Sandbox Isolation)

**Epic 3** résoudra complètement cette limitation via **sandbox isolé** :

```typescript
// Epic 3: Sandbox Executor (à venir)
const sandbox = new DenoSandbox({
  permissions: { read: true, write: true },
  isolation: "complete", // Filesystem virtuel isolé
});

// Modifications isolées
const result = await sandbox.execute(agentCode);

// Checkpoint sauvegarde les résultats, pas les fichiers
checkpoint.tasks = [{
  task_id: "code_gen",
  result: result.output, // Output data
  sandbox_snapshot: result.state, // Virtual FS state (optional)
}];
```

**Avantages Epic 3:**

- ✅ Filesystem isolé → Modifications sûres
- ✅ Rollback natif → Abort sans corruption
- ✅ Checkpoint light → Pas besoin de sauvegarder tous les fichiers
- ✅ Speculation safe → Branches parallèles sans conflit

### Recommandation pour Epic 2.5

**Pour l'implémentation Epic 2.5 (ADR-007) :**

1. **Focus sur orchestration** (AIL/HIL, replanning, GraphRAG) → Checkpoints suffisants
2. **Déléguer modifications de code** à Epic 3 quand disponible
3. **Si modifications directes nécessaires** → Documenter l'exigence d'idempotence
4. **Tests de resume** → Inclure scenarios avec crash mid-layer

**Note dans les stories :**

- Stories 2.5-1 à 2.5-4 = orchestration primarily → ✅ Checkpoints safe
- Toute task qui modifie des fichiers → ⚠️ Documenter idempotence requirement

### Context Management & Decision Architecture

**Architecture : Un Seul Agent en Conversation Continue**

Epic 2.5 utilise un seul agent qui exécute le DAG via ses MCP tools et prend les décisions dans sa
conversation continue.

```typescript
class ControlledExecutor {
  private agent: ClaudeAgent;  // Un agent, une conversation

  async executeStream(dag: DAGStructure) {
    for (const layer of layers) {
      // Agent exécute les tasks via MCP tools
      // Les résultats MCP apparaissent dans SA conversation
      const results = await this.executeLayer(layer);

      // Checkpoint
      yield { type: "checkpoint", state: this.state };

      // AIL: Agent continue sa conversation
      const decision = await this.agent.continue(
        `Layer ${layer} completed. Continue or replan?`
      );

      // ✅ Agent voit tous les MCP results (comportement naturel de Claude)
      // ✅ Pas de filtering contexte
      // ✅ Décisions informées avec contexte complet
    }
  }
}
```

**Principes :**

- ✅ **Agent voit tous les MCP results** : Comportement normal de Claude (comme Bash, Read, etc.)
- ✅ **Conversation continue** : Pas de re-contexte, pas de pruning
- ✅ **Décisions informées** : Agent a accès à l'intégralité des résultats pour décider
- ✅ **Summary pour HIL uniquement** : Génération de résumés pour affichage humain (UI)

**Coût contexte :**

- AIL : Minimal (agent continue sa conversation)
- HIL : ~500-1000 tokens (génération summary pour affichage UI)

---

## Consequences

### Positive

- ✅ **100% requirements coverage** - AIL, HIL, multi-turn, dynamic DAG, GraphRAG re-trigger
- ✅ **Performance optimale** - Speedup 5x préservé, speculation 23-30% gain
- ✅ **15% code reduction** - Reducers automatiques vs manual state management
- ✅ **Modern patterns** - MessagesState best practices (LangGraph v1.0 2025)
- ✅ **No breaking changes** - Extension de ParallelExecutor, backward compatible
- ✅ **Low risk** - Implémentation progressive en 4 sprints, rollback possible
- ✅ **Production-ready** - Patterns éprouvés (LangGraph + Event-Driven + Prefect)
- ✅ **Best of both worlds** - State-first (LangGraph) + Observability (Event Stream)
- ✅ **Time to market** - 9-13h vs 20-30h pour alternatives
- ✅ **Type safety** - WorkflowState typed, reducers typed
- ✅ **Observable** - Event stream pour monitoring temps réel
- ✅ **Testable** - State updates isolés, reducers unitaires, event mocking

### Negative

- ⚠️ **Complexité moyenne** - Event-driven + reducers (mais patterns standards)
- ⚠️ **State bloat possible** - Nécessite pruning strategy (LangGraph même issue)
- ⚠️ **Race conditions possibles** - Nécessite careful design (AsyncQueue thread-safe)
- ⚠️ **Debugging async flows** - Plus complexe que linéaire (event logs + state snapshots
  compensent)

### Neutral

- 🟡 **Dev time 9-13h** - Acceptable pour la valeur apportée
- 🟡 **Learning curve** - Patterns async/await familiers + reducers simples
- 🟡 **Memory overhead** - ~5MB (state + events + commands)

---

## Implementation Plan

### Phase 1: Sprint 1 - State Management & Checkpoints (2-3h)

**Objectifs:**

- ✅ Définir `WorkflowState` interface
- ✅ Implémenter reducers automatiques
- ✅ Refactor `ParallelExecutor` pour extension
- ✅ Checkpoint infrastructure

**Livrables:**

- `src/dag/state.ts` - WorkflowState + reducers
- `src/dag/controlled-executor.ts` - Base class
- Tests unitaires (state updates, reducers)

### Phase 2: Sprint 2 - Command Queue & Agent Control (2-3h)

**Objectifs:**

- ✅ AsyncQueue implementation
- ✅ Command types et processors
- ✅ Agent decision loop

**Livrables:**

- `src/dag/command-queue.ts`
- `src/dag/commands.ts`
- Integration tests

### Phase 3: Sprint 3 - Full Event-Driven + Human Loop (2-3h)

**Objectifs:**

- ✅ Event stream implementation
- ✅ Human-in-the-loop UI
- ✅ Multi-turn state management

**Livrables:**

- `src/dag/event-stream.ts`
- `src/ui/checkpoint-prompt.ts`
- End-to-end tests

### Phase 4: Sprint 4 - Speculative Execution + GraphRAG Integration (3-4h)

**Objectifs:**

- ✅ GraphRAG next-node prediction (graph suggester)
- ✅ Speculative task execution
- ✅ Speculation resolution
- ✅ GraphRAG re-trigger sur modification de contexte
- ✅ Feedback loop enrichment du graph

**Livrables:**

- `src/dag/speculation.ts`
- `src/dag/graph-suggester.ts` - Interface avec GraphRAG
- Performance benchmarks
- Metrics tracking

**GraphRAG Integration Details:**

**⚠️ ARCHITECTURE CLARIFICATION - Graph vs DAG:**

- **GraphRAG (Knowledge Graph)** = Base de connaissances permanente
  - Nodes: Tools disponibles dans le système
  - Edges: Relations entre tools (co-occurrence, dependencies)
  - Storage: PGlite (persistent)
  - Role: Source de vérité pour suggestions
  - Managed by: `GraphRAGEngine`

- **DAG (Workflow Execution Graph)** = Plan d'exécution éphémère
  - Nodes: Tasks spécifiques à exécuter maintenant
  - Edges: Ordre d'exécution des tasks
  - Storage: In-memory + checkpoints
  - Role: Blueprint pour ce workflow uniquement
  - Created by: `DAGSuggester` (queries GraphRAG)

**Flow:**

```
User Intent → DAGSuggester → Query GraphRAG → Build Workflow DAG → Execute
                                    ↑                                  │
                                    └──────── Update Learning ─────────┘
```

**Extensions to Existing Code (No Duplicates):**

```typescript
// src/graphrag/dag-suggester.ts - ÉTENDRE la classe existante
export class DAGSuggester {
  // ✅ EXISTE DÉJÀ
  async suggestDAG(intent: WorkflowIntent): Promise<SuggestedDAG | null>;

  // ✅ NOUVELLE MÉTHODE - Prédire prochains nodes pour speculation
  async predictNextNodes(
    currentState: WorkflowState,
    completedTasks: TaskResult[],
  ): Promise<PredictedNode[]> {
    // 1. Get tools utilisés from completedTasks
    // 2. Query GraphEngine pour adjacency (PageRank sur neighbors)
    // 3. Filter par confidence >0.7
    // 4. Return top 3 predictions avec reasoning
  }

  // ✅ NOUVELLE MÉTHODE - Re-planning dynamique
  async replanDAG(
    currentDAG: DAGStructure,
    newContext: {
      completedTasks: TaskResult[];
      newRequirement: string;
      availableContext: Record<string, any>;
    },
  ): Promise<DAGStructure> {
    // 1. Extract new requirements from context
    // 2. VectorSearch pour tools pertinents (utilise this.vectorSearch existant)
    // 3. GraphEngine.buildDAG() pour générer new nodes
    // 4. Merge with existing DAG (preserve completed tasks)
    // 5. Return updated DAG
  }
}

// src/graphrag/graph-engine.ts - UTILISER méthode existante
export class GraphRAGEngine {
  // ✅ EXISTE DÉJÀ - Utiliser cette méthode pour feedback loop!
  async updateFromExecution(execution: WorkflowExecution): Promise<void> {
    // - Updates edges based on executed path
    // - Recomputes PageRank
    // - Persists to PGlite
  }

  // Note: Pas besoin de "updateGraphWithFeedback" séparé -
  // updateFromExecution() fait déjà ce qu'on veut!
}
```

**Feedback Loop Complet:**

```
┌─────────────────────────────────────────────────────────┐
│          DAGSuggester + GraphRAG Feedback Loop           │
└─────────────────────────────────────────────────────────┘

1. DAGSuggester.suggestDAG() → Queries GraphRAG Knowledge
   │                            (vectorSearch, PageRank, buildDAG)
   ▼
2. Exécution avec ControlledExecutor
   │
   ├─► Agent Decision (AIL)
   │   └─► DAGSuggester.replanDAG() → Re-queries GraphRAG
   │       └─► Inject nouveaux nodes dans workflow DAG
   │
   ├─► Human Decision (HIL)
   │   └─► DAGSuggester.replanDAG() → Re-queries GraphRAG
   │       └─► Merge updated workflow DAG
   │
   ▼
3. Completion: GraphRAGEngine.updateFromExecution()
   │              Updates Knowledge Graph with learning
   └─► Enrichit le knowledge graph pour prochaines suggestions
```

**Total:** 9-13 heures sur 2-3 jours

---

## Success Metrics

### Must-Have (Go/No-Go)

- ✅ Suspend/resume exécution DAG fonctionne
- ✅ Human peut approuver/rejeter à checkpoints
- ✅ Agent peut injecter commands dynamiquement
- ✅ Multi-turn state persiste correctement
- ✅ DAG peut être modifié en cours d'exécution
- ✅ Speedup 5x préservé (checkpoints OFF)
- ✅ Zero breaking changes

### Performance Targets

- ✅ Checkpoint overhead <50ms (hors agent response time)
- ✅ Command injection latency <10ms
- ✅ Memory footprint <10MB
- ✅ Speculation hit rate >60% (si activé)

### Code Quality Targets

- ✅ Tests coverage >80%
- ✅ Reducer tests coverage >90%
- ✅ Code reduction ~15% vs manual state management
- ✅ Documentation complète
- ✅ Examples d'utilisation

---

## Risk Assessment & Mitigation

### Risque 1: Complexity Creep ⚠️ Medium

**Impact:** Implémentation devient trop complexe, timeline dépasse 13h.

**Mitigation:**

- Implémentation progressive en 4 sprints indépendants
- Chaque sprint peut fonctionner standalone
- Fallback: Rester sur Sprint 1 (MVP checkpoints) si besoin

**Contingency:** Si Sprint 3 trop complexe, reporter features avancées à Phase 2.

### Risque 2: Race Conditions ⚠️ Medium

**Impact:** Commands ou state updates concurrent causent inconsistencies.

**Mitigation:**

- AsyncQueue thread-safe avec locks
- Command versioning (optimistic locking)
- State updates atomic via reducers

**Testing:** Integration tests avec concurrency scenarios.

### Risque 3: Performance Degradation 🟡 Low-Medium

**Impact:** Checkpoints/events dégradent le speedup 5x.

**Mitigation:**

- Checkpoints configurable (ON/OFF)
- Speculation opt-in (feature flag)
- Benchmarks avant/après chaque phase

**Validation:** Performance tests automatisés.

### Risque 4: State Bloat 🟡 Low

**Impact:** Messages/tasks s'accumulent, memory overflow.

**Mitigation:**

- Pruning strategy (keep last N items)
- Configurable retention policy
- Periodic state cleanup

**Monitoring:** Memory usage metrics.

### Risque 5: Speculation Waste 🟡 Low

**Impact:** Speculative execution gaspille compute sans bénéfice.

**Mitigation:**

- Confidence threshold >0.7
- Safety whitelist (read-only operations uniquement)
- Track hit rate et net benefit

**Abort criteria:** Si hit rate <40%, désactiver speculation.

---

## Related Decisions

### ADR-001: DAG-Based Workflow Execution

- **Status:** Accepted
- **Impact:** Base architecture que nous étendons

### ADR-003: GraphRAG for Tool Discovery

- **Status:** Accepted
- **Impact:** GraphRAG peut être redéclenché pour re-planification

### ADR-005: Parallel Layer Execution

- **Status:** Accepted
- **Impact:** Speedup 5x à préserver

### ADR-008: Episodic Memory & Adaptive Thresholds (Extension)

- **Status:** Proposed
- **Impact:** Extends Loop 3 (Meta-Learning) with:
  - Episodic memory for historical context retrieval
  - Adaptive thresholds for self-improving speculation
  - Replaces fixed threshold (0.7) with learned thresholds (0.70-0.95)
- **Scope:** ADR-007 covers Loop 1-2 + base Loop 3. ADR-008 extends Loop 3 with enhanced learning
  mechanisms.
- **Timeline:** Implement after ADR-007 stories (2.5-1 to 2.5-4) are complete

---

## References

### Research & Analysis

- **Technical Research:** `docs/research-technical-2025-11-13.md`
- **Spike:** `docs/spikes/spike-agent-human-dag-feedback-loop.md`

### Industry Patterns

- **LangGraph v1.0:** https://langchain-ai.github.io/langgraphjs/
  - MessagesState pattern
  - Checkpointing architecture
  - State reducers best practices

- **LangGraph Best Practices:** https://www.swarnendu.de/blog/langgraph-best-practices/
  - "Keep state minimal, explicit, and typed"
  - Reducer patterns

- **Prefect Interactive Workflows:** https://docs.prefect.io/v3/advanced/interactive
  - pause_flow_run pattern
  - wait_for_input API

- **Event-Driven.io:** https://event-driven.io/en/inmemory_message_bus_in_typescript/
  - Command bus patterns
  - TypeScript implementations

- **Temporal:** https://temporal.io/blog
  - Durable execution insights
  - Multi-agent workflows

### Academic/Research Papers

- **Speculative Execution:** SpeQL (DAG-based query execution with speculation)
- **Workflow Performance:** DAG-FGL, DAG-Transformer models

---

## Change Log

### v1.0 (2025-11-13 initial)

- Option 2 Hybridée - Event Stream + Commands
- Score: 92/100
- Status: Proposed

### v2.0 (2025-11-13 updated)

-
  - MessagesState-inspired reducers
-
  - State-first design
-
  - 15% code reduction
- Score: **95/100**
- Status: Proposed v2

---

## Approval

**Proposed by:** Technical Research Team **Date:** 2025-11-13 **Approved by:** BMad **Approval
date:** 2025-11-13

**Status:** ✅ Approved for implementation

**Implementation Plan:**

1. ✅ Epic 2.5 created in sprint-status.yaml
2. ⏳ Update PRD with Epic 2.5 scope (Loop 1, Loop 2, base Loop 3)
3. ⏳ Update `docs/architecture.md` with Pattern 4 details
4. ⏳ Create workflow document for Epic 2.5
5. ⏳ Generate 4 stories following BMM process (2.5-1 to 2.5-4)
6. ⏳ Begin implementation after story generation

**Note:** ADR-008 (Episodic Memory & Adaptive Thresholds) will extend Loop 3 after ADR-007
implementation is complete.

---

**Document Status:** ✅ Approved - Implementation Phase
