# Spike: Agent & Human-in-the-Loop DAG Feedback Loop

**Date:** 2025-11-13 **Author:** BMad **Status:** Exploration **Epic:** 2.5 (Agent-Controlled DAG
Execution) **Reviewers:** Winston (Architect), John (PM)

> **⚠️ UPDATE 2025-11-24:** This spike initially proposed 6 command handlers and SSE streaming
> pattern for AIL/HIL. After implementation (Story 2.5-3) and comprehensive analysis, architectural
> decisions were formalized:
>
> - **ADR-018: Command Handlers Minimalism** - Only 4 handlers needed (continue, abort, replan_dag,
>   approval_response), 4 deferred (inject_tasks, skip_layer, modify_args, checkpoint_response) per
>   YAGNI
> - **ADR-019: Two-Level AIL Architecture** - SSE streaming pattern incompatible with MCP one-shot
>   protocol. Use Gateway HTTP response pattern (Level 1) + Agent Delegation tasks (Level 3)
>   instead.
>
> **Spike remains valuable** for architectural concepts (3-Loop Learning, Progressive Discovery,
> Multi-Turn State), but implementation details superseded by ADRs.

---

## Executive Summary

**Problem:** Le DAG executor actuel suit un pattern "fire-and-forget" qui empêche l'agent LLM ET
l'utilisateur humain de réagir pendant l'exécution. Une fois le DAG lancé, il s'exécute jusqu'au
bout sans possibilité d'intervention, de validation, ou d'ajustement dynamique.

**Proposed Solution:** Architecture "Controlled Execution with Multi-Turn Feedback Loop" permettant
interactions continues entre Agent ↔ System ↔ Human pendant l'exécution du DAG, avec **Speculative
Execution** pour optimiser latence.

**Key Benefits:**

- 🤖 **Agent autonomy:** Agent peut adapter le plan selon résultats intermédiaires
- 👤 **Human oversight:** Utilisateur peut valider, corriger, ou arrêter à tout moment
- 🔄 **Adaptive workflows:** Plans dynamiques basés sur feedback réel
- 🛡️ **Safety:** Validation humaine pour opérations critiques
- ⚡ **Speculative execution:** GraphRAG prédit + execute next nodes pendant agent thinking (23-30%
  faster)

---

## Problem Statement

### Current Architecture: "Open Loop Execution"

```
┌─────────┐
│  User   │ "Analyze all JSON files"
└────┬────┘
     │
     ▼
┌─────────┐
│  Agent  │ Génère DAG complet
│ (Claude)│ [read_f1, read_f2, ..., analyze, summarize]
└────┬────┘
     │ (DAG final)
     ▼
┌─────────────────────────────┐
│   DAG Executor              │
│                             │
│  Layer 1: [read_f1, read_f2]│ ─→ Execute
│  Layer 2: [analyze]         │ ─→ Execute
│  Layer 3: [summarize]       │ ─→ Execute
│                             │
└──────────┬──────────────────┘
           │
           ▼ (Résultats finaux)
┌─────────┐
│  User   │ Reçoit résultats seulement à la fin
└─────────┘
```

### Problèmes Identifiés

**1. Agent ne peut pas réagir aux résultats intermédiaires**

- Après `read_f1`: "Ce fichier est 10GB, pas adapté"
- Trop tard: `read_f2` déjà lancé en parallèle

**2. Utilisateur ne peut pas intervenir**

- Détecte erreur dans Layer 1 mais ne peut pas arrêter
- Veut valider avant opération dangereuse (DELETE, WRITE)
- Souhaite voir résultats partiels avant continuer

**3. Plans rigides, pas d'adaptation**

- Agent génère plan complet AVANT d'avoir des infos
- Découverte progressive impossible (e.g., "besoin d'un parser XML")
- Pas de conditional branching basé sur résultats

**4. Pas de feedback loop pour apprentissage**

- User corrige résultats mais agent ne voit pas la correction
- Pas de "verify-then-proceed" workflows
- Impossible de faire "human-in-the-loop" pour décisions critiques

---

## Use Cases Critiques

### Use Case 1: Progressive Discovery avec Validation Humaine

**Scenario:** Analyser une structure de dossiers inconnue

```
User: "Analyze all files in ./data/ and create a report"

Agent: Génère DAG initial
  ├─ Task 1: list_directory("./data/")
  └─ Task 2: ??? (ne sait pas encore quels fichiers)

👉 PROBLÈME ACTUEL: Agent doit deviner tous les tasks à l'avance

SOLUTION DÉSIRÉE:
  1. Execute Task 1 → découvre 3 types de fichiers (JSON, XML, CSV)
  2. 🤖 Agent voit résultats: "Ok, besoin de 3 parsers différents"
  3. 👤 Human validé: "Oui, mais skip les CSV pour l'instant"
  4. Agent génère nouvelle layer: [parse_json, parse_xml]
  5. Continue...
```

### Use Case 2: Human Safety Check sur Opérations Critiques

**Scenario:** Workflow incluant DELETE ou WRITE

```
Agent génère DAG:
  ├─ Layer 1: [read_config, read_data]
  ├─ Layer 2: [process_data]
  └─ Layer 3: [DELETE old_files, WRITE new_results]  ⚠️ DANGER

👉 PROBLÈME ACTUEL: DELETE s'exécute automatiquement

SOLUTION DÉSIRÉE:
  1. Execute Layers 1-2 normalement
  2. 🛑 CHECKPOINT avant Layer 3
  3. 👤 Human review: "DELETE va supprimer 500 fichiers. Continuer?"
     - Approve → Continue
     - Reject → Abort
     - Modify → Change to DELETE only 10 files
  4. Execute Layer 3 modifiée
```

### Use Case 3: Multi-Turn Agent Refinement

**Scenario:** Agent améliore son plan itérativement

```
User: "Create a summary of all GitHub issues"

Turn 1:
  🤖 Agent: "Je vais lire tous les issues"
  System: Execute → 1000 issues trouvés
  🤖 Agent: "C'est trop! Je vais filtrer sur les issues ouvertes"

Turn 2:
  System: Execute → 50 issues ouverts
  🤖 Agent: "Parfait, maintenant je vais les grouper par label"

Turn 3:
  System: Execute → Grouping done
  👤 Human: "Concentre-toi uniquement sur 'bug' labels"
  🤖 Agent: "Ok, je filtre et je crée le summary"

Turn 4:
  System: Execute → Summary créé
  👤 Human: "Excellent! Maintenant export en PDF"
  🤖 Agent: "J'ajoute la tâche d'export"
```

### Use Case 4: Error Recovery avec Human Guidance

**Scenario:** Task fail, agent ne sait pas comment récupérer

```
DAG Execution:
  ├─ Task A: SUCCESS ✅
  ├─ Task B: FAILED ❌ "API rate limit"
  └─ Task C: Depends on B → BLOCKED

👉 PROBLÈME ACTUEL: Task C skip ou fail en cascade

SOLUTION DÉSIRÉE:
  1. Task B fails
  2. 🤖 Agent analyze: "Rate limit error"
  3. System propose options:
     - Retry B with backoff?
     - Skip B and continue with partial data?
     - Abort entire workflow?
  4. 👤 OR 🤖 décide (selon confidence level)
  5. Execute décision
```

---

## Decision Logic: Complete vs Progressive Execution

### Le problème de la décision

**Question centrale:** Comment le système décide-t-il entre:

- **Mode A (Complete):** Générer DAG complet upfront → Execute tout d'un coup (workflow-level
  speculation)
- **Mode B (Progressive):** Construire DAG noeud par noeud → Multi-turn avec agent feedback
  (node-level speculation)

**Qui décide?** Il y a 3 acteurs:

1. **GraphRAG** - Analyse patterns historiques → Donne confidence score
2. **Agent LLM (Claude)** - Auto-évalue sa compréhension → Peut override
3. **System** - Combine les deux → Décision finale

---

### Architecture de Décision: Hybrid Confidence Model

```typescript
/**
 * Decision engine pour choisir le mode d'exécution
 */
interface ExecutionDecision {
  mode: "complete" | "progressive";
  confidence: number;
  reasoning: string;
  fallbackAllowed: boolean;
}

async function decideExecutionMode(
  userIntent: string,
): Promise<ExecutionDecision> {
  // 1. GraphRAG analyse (patterns historiques)
  const graphRAGAnalysis = await graphRAG.analyzeIntent(userIntent);
  // {
  //   confidence: 0.88,
  //   hasCompleteSolution: true,
  //   hasConditionalBranching: false,  ← NOUVEAU!
  //   reasoning: "Pattern 'GitHub analysis' seen 50 times, success 92%"
  // }
  //
  // hasConditionalBranching = true si:
  //   - DAG contient IF/ELSE basé sur résultats runtime
  //   - Branches dépendent de résultats intermédiaires
  //   - Pattern a plusieurs variations observées

  // 2. Agent LLM auto-évaluation
  const agentAssessment = await agent.assess({
    intent: userIntent,
    graphRAGSuggestion: graphRAGAnalysis.suggestion,
  });
  // {
  //   confidence: 0.75,
  //   canGenerateCompletePlan: true,
  //   uncertainties: ["File format unknown", "Size might be large"],
  //   reasoning: "I can generate a plan but need to validate file format first"
  // }

  // 3. Combined decision (conservative approach)
  const finalConfidence = Math.min(
    graphRAGAnalysis.confidence,
    agentAssessment.confidence,
  );

  // Decision tree
  if (
    finalConfidence >= 0.85 &&
    graphRAGAnalysis.hasCompleteSolution &&
    !graphRAGAnalysis.hasConditionalBranching
  ) { // ← NOUVEAU CRITÈRE!
    return {
      mode: "complete",
      confidence: finalConfidence,
      reasoning: "High confidence in complete workflow with no conditional branches",
      fallbackAllowed: true, // Can fallback to progressive if execution fails
    };
  } else if (finalConfidence >= 0.85 && graphRAGAnalysis.hasConditionalBranching) {
    return {
      mode: "progressive",
      confidence: finalConfidence,
      reasoning: "High confidence BUT conditional branching requires runtime decisions",
      fallbackAllowed: false,
    };
  } else if (finalConfidence >= 0.70) {
    return {
      mode: "progressive",
      confidence: finalConfidence,
      reasoning: "Medium confidence, use guided multi-turn",
      fallbackAllowed: false,
    };
  } else {
    return {
      mode: "progressive",
      confidence: finalConfidence,
      reasoning: "Low confidence, full exploration needed",
      fallbackAllowed: false,
    };
  }
}
```

---

### Exemples Concrets de Décision

#### Exemple 1: Intent Clair → Mode Complete

```
User: "List all commits from my GitHub repo and create a summary"

GraphRAG Analysis:
  - Pattern: "github_list + summarize" vu 50 fois
  - Success rate: 92%
  - Confidence: 0.90
  - Has complete solution: YES

Agent Assessment:
  - "I know exactly what to do"
  - Steps clear: list_commits → fetch_details → create_summary
  - No unknowns
  - Confidence: 0.88

DECISION:
  Mode: COMPLETE (workflow-level speculation)
  Final confidence: min(0.90, 0.88) = 0.88

EXECUTION:
  ✅ Generate complete DAG upfront
  ✅ Execute all tasks in parallel layers
  ✅ No agent checkpoints (fire-and-forget)
  ✅ Return final results
```

#### Exemple 2: Conditional Branching → Mode Progressive (malgré haute confiance!)

```
User: "Analyze repository and run appropriate linter"

GraphRAG Analysis:
  - Pattern: "repo analysis + linting" vu 50 fois
  - Success rate: 92%
  - Confidence: 0.90
  - Has complete solution: YES
  - ⚠️ Has conditional branching: YES (linter depends on language)

Agent Assessment:
  - "I know the pattern well"
  - "BUT I need to detect language first to choose linter"
  - Conditional: IF Python → pylint, IF JavaScript → eslint
  - Confidence: 0.85

DECISION:
  Mode: PROGRESSIVE (despite high confidence!)
  Final confidence: min(0.90, 0.85) = 0.85
  Reasoning: "Conditional branching requires runtime decisions"

EXECUTION:
  1️⃣ Execute: detect_language(repo)
     Results: { language: "Python", version: "3.11" }

  2️⃣ Agent sees results:
     "Python detected → Need pylint"

  3️⃣ Inject conditional branch:
     - run_linter(tool: "pylint", config: ".pylintrc")
     (NOT eslint!)

  4️⃣ Continue with create_report...
```

**Pourquoi Progressive malgré 0.85 confidence?** → GraphRAG sait que le pattern a des **variations**
selon contexte → Il faut exécuter `detect_language` AVANT de décider quel linter → Le DAG ne peut
pas être complètement déterminé upfront

#### Exemple 3: Format Inconnu → Mode Progressive

```
User: "Analyze all files in ./data/ folder"

GraphRAG Analysis:
  - Pattern: "file analysis" vu 100 fois
  - Mais formats variés (XML, JSON, CSV, binary)
  - Confidence: 0.72
  - Has complete solution: NO (depends on file types)

Agent Assessment:
  - "I need to see the file list first"
  - Unknown: File formats, sizes, structure
  - Can't plan complete workflow without info
  - Confidence: 0.60

DECISION:
  Mode: PROGRESSIVE (node-level speculation)
  Final confidence: min(0.72, 0.60) = 0.60

EXECUTION:
  1️⃣ Execute: list_directory
     Results: [file.xml, data.json, config.csv]

  2️⃣ Agent sees results:
     "Ah! Need 3 parsers: XML, JSON, CSV"

  3️⃣ Inject tasks dynamically:
     - parse_xml(file.xml)
     - parse_json(data.json)
     - parse_csv(config.csv)

  4️⃣ Continue multi-turn...
```

#### Exemple 3: Agent Override (Conservative)

```
User: "Delete all temporary files older than 30 days"

GraphRAG Analysis:
  - Pattern: "file cleanup" vu 30 fois
  - Success rate: 95%
  - Confidence: 0.92
  - Has complete solution: YES

Agent Assessment:
  - "This is a DANGEROUS operation"
  - Need to verify what files will be deleted
  - SAFETY CONCERN: Should validate with user first
  - Confidence: 0.50 (deliberately low for safety)

DECISION:
  Mode: PROGRESSIVE (agent overrides GraphRAG)
  Final confidence: min(0.92, 0.50) = 0.50
  Reasoning: "Safety override - critical operation"

EXECUTION:
  1️⃣ Execute: list_temp_files(age > 30 days)
     Results: 523 files, 2.3GB

  2️⃣ 👤 Human checkpoint:
     "About to delete 523 files (2.3GB). Continue?"

  3️⃣ User approves → Continue

  4️⃣ Execute: delete_files(list)
```

---

### Agent Self-Assessment Prompt

Pour que l'agent LLM puisse s'auto-évaluer, on lui donne ce prompt:

```xml
<agent_assessment_prompt>
You are about to execute a workflow based on user intent.

USER INTENT: "{user_intent}"

GRAPHRAG SUGGESTION:
- Confidence: {graphrag_confidence}
- Complete DAG: {dag_structure}
- Reasoning: {graphrag_reasoning}

ASSESSMENT TASK:
Evaluate your confidence in executing this workflow COMPLETELY upfront vs PROGRESSIVELY.

Answer these questions:
1. Do you have ALL information needed to plan the complete workflow?
   - Unknown file formats? → Need progressive
   - Unknown data sizes? → Need progressive
   - Unknown API responses? → Need progressive
   - Clear, deterministic steps? → Can be complete

2. Are there SAFETY concerns?
   - DELETE operations? → Need human validation
   - WRITE operations? → Need verification
   - EXEC commands? → Need approval

3. What is your confidence (0-1) in generating a COMPLETE plan?
   - 0.9-1.0: "I know exactly what to do"
   - 0.7-0.9: "I have a good idea but may need adjustments"
   - 0.5-0.7: "I need to explore first"
   - 0.0-0.5: "Too many unknowns"

Respond in JSON:
{
  "confidence": 0.0-1.0,
  "canGenerateCompletePlan": boolean,
  "uncertainties": ["list", "of", "unknowns"],
  "safetyConserns": ["list", "of", "risks"],
  "recommendedMode": "complete" | "progressive",
  "reasoning": "explanation"
}
</agent_assessment_prompt>
```

**Agent Response Example:**

```json
{
  "confidence": 0.65,
  "canGenerateCompletePlan": false,
  "uncertainties": [
    "File formats unknown until listing directory",
    "File sizes unknown - might be too large"
  ],
  "safetyConcerns": [],
  "recommendedMode": "progressive",
  "reasoning": "Need to discover file structure before choosing parsers"
}
```

---

### Decision Matrix

| GraphRAG Conf | Agent Conf | Conditional Branch | Unknowns | Safety Risk | Decision        | Mode                  |
| ------------- | ---------- | ------------------ | -------- | ----------- | --------------- | --------------------- |
| >0.85         | >0.85      | ❌ None            | None     | None        | **COMPLETE**    | Workflow-level spec   |
| >0.85         | >0.85      | ✅ **Yes**         | None     | None        | **PROGRESSIVE** | Conditional decisions |
| >0.85         | >0.85      | -                  | None     | HIGH        | **PROGRESSIVE** | Human checkpoints     |
| >0.85         | <0.70      | -                  | Some     | None        | **PROGRESSIVE** | Agent conservative    |
| 0.70-0.85     | >0.70      | -                  | None     | None        | **PROGRESSIVE** | Guided multi-turn     |
| 0.70-0.85     | >0.70      | -                  | Some     | None        | **PROGRESSIVE** | Guided multi-turn     |
| <0.70         | Any        | -                  | Many     | Any         | **PROGRESSIVE** | Full exploration      |

**Rules:**

1. Take the **most conservative** (lowest confidence) between GraphRAG and Agent
2. **Conditional branching override:** Si le DAG contient des IF/ELSE basés sur runtime data →
   ALWAYS Progressive
3. **Safety override:** Si agent détecte safety risk → ALWAYS Progressive avec human checkpoint

**Conditional Branching Detection:** GraphRAG détecte conditional branching en analysant:

- Pattern a **plusieurs variations** dans l'historique (e.g., 60% Python+pylint, 40% JS+eslint)
- DAG nécessite **runtime data** pour choisir la branche (language detection, file format, API
  response)
- Succès dépend de **décisions contextuelles** pas prévisibles upfront

---

### Fallback Mechanism

Si le mode "complete" échoue, fallback automatique vers "progressive":

```typescript
try {
  // Try complete mode
  if (decision.mode === "complete") {
    return await executeComplete(dag);
  }
} catch (error) {
  if (decision.fallbackAllowed && error.recoverable) {
    // Fallback to progressive
    logger.warn("Complete mode failed, falling back to progressive");
    return await executeProgressive(dag, {
      startFrom: error.lastSuccessfulTask,
    });
  } else {
    throw error;
  }
}
```

**Fallback triggers:**

- Task échoue avec erreur inattendue
- Dependency manquante non détectée
- Resource limit exceeded
- Agent confidence drop mid-execution

---

### Configuration & Overrides

L'utilisateur peut override la décision automatique:

```typescript
// Force mode complete (même si low confidence)
await executeWorkflow(intent, {
  mode: "complete",
  force: true,
});

// Force mode progressive
await executeWorkflow(intent, {
  mode: "progressive",
  checkpoints: "all", // Validate every step
});

// Auto mode (default - let system decide)
await executeWorkflow(intent); // Uses decision logic
```

---

## Design Options Explored

### Option 1: Synchronous Checkpoints (Simple)

**Architecture:**

```typescript
async executeWithCheckpoints(
  dag: DAGStructure,
  checkpointHandler: (context: CheckpointContext) => Promise<CheckpointDecision>
): Promise<DAGExecutionResult> {

  const layers = topologicalSort(dag);

  for (const layer of layers) {
    // Execute layer
    const results = await executeLayer(layer);

    // CHECKPOINT: Pause et demande validation
    const decision = await checkpointHandler({
      type: "post-layer",
      completed: results,
      remaining: layers.slice(i+1),
      canModify: true
    });

    if (decision.action === "abort") break;
    if (decision.action === "modify") {
      layers = rebuildLayers(decision.modifications);
    }
  }
}
```

**Flux:**

```
Execute Layer 1 → PAUSE → Ask agent/human → Continue/Abort/Modify → Repeat
```

**Forces:** ✅ Simple à implémenter ✅ État clair entre layers ✅ Facile à débugger ✅ Compatible
architecture actuelle

**Faiblesses:** ⚠️ Bloque l'exécution pendant validation ⚠️ Granularité grossière (layer-level
seulement) ⚠️ Latence: +1-3s par checkpoint pour Claude ⚠️ Pas de contrôle task-by-task

**Verdict:** Bon pour MVP, mais limité pour cas complexes

---

### Option 2: Async Event Stream with Command Injection

**Architecture:**

```typescript
class ControlledExecutor {
  private commandQueue: AsyncQueue<Command>;

  async *executeStream(dag: DAGStructure): AsyncGenerator<ExecutionEvent> {
    const layers = topologicalSort(dag);

    for (const layer of layers) {
      // Process pending commands BEFORE layer
      await this.processCommands();

      // Execute layer avec streaming
      for await (const event of this.executeLayerStream(layer)) {
        yield event; // Stream events en temps réel

        // Check for new commands
        await this.processCommands();
      }
    }
  }

  // Agent ou Human peut injecter commands
  injectCommand(cmd: Command): void {
    this.commandQueue.enqueue(cmd);
  }
}
```

**Flux:**

```
┌─────────────────────────────────────────┐
│          DAG Executor Stream            │
│                                         │
│  Layer 1: Execute                       │
│    ├─ Task A ─→ Event: task_complete   │──┐
│    └─ Task B ─→ Event: task_complete   │  │
│                                         │  │
└─────────────────────────────────────────┘  │
                                              │
                 ┌────────────────────────────┘
                 │ (SSE Stream)
                 ▼
         ┌───────────────┐
         │  Agent Loop   │
         │   (Claude)    │
         └───────┬───────┘
                 │
                 ├─→ injectCommand({ type: "inject_task", task: {...} })
                 ├─→ injectCommand({ type: "abort" })
                 └─→ injectCommand({ type: "modify_args", taskId: "..." })

         ┌───────────────┐
         │  Human Loop   │
         │    (User)     │
         └───────┬───────┘
                 │
                 └─→ injectCommand({ type: "approve_checkpoint" })
```

**Command Types:**

```typescript
type Command =
  | { type: "abort"; reason: string }
  | { type: "inject_task"; task: Task; priority: "high" | "normal" }
  | { type: "skip_layer"; layerIndex: number }
  | { type: "modify_args"; taskId: string; newArgs: Record<string, unknown> }
  | { type: "retry_task"; taskId: string; backoffMs: number }
  | { type: "checkpoint_response"; approved: boolean; modifications?: DAGModification[] };
```

**Forces:** ✅ **Asynchrone**: Agent et Executor découplés ✅ **Contrôle fin**: Commands à tout
moment ✅ **Extensible**: Facile d'ajouter nouveaux commands ✅ **Multi-agent**: Agent + Human
peuvent coexister ✅ **Observable**: Monitoring naturel via events

**Faiblesses:** ⚠️ Complexité implémentation ⚠️ Race conditions possibles ⚠️ State management plus
difficile ⚠️ Besoin queue thread-safe

**Verdict:** Architecture robuste pour production

---

### Option 3: Reactive DAG with Generator Pattern

**Architecture:**

```typescript
async function* reactiveExecute(
  initialTasks: Task[],
): AsyncGenerator<TaskResult, void, AgentDecision> {
  let taskQueue = [...initialTasks];

  while (taskQueue.length > 0) {
    const task = taskQueue.shift();
    const result = await executeTask(task);

    // YIELD: Donne contrôle à agent
    const decision = yield result;

    // Agent peut modifier le queue
    if (decision.newTasks) {
      taskQueue.push(...decision.newTasks);
    }
    if (decision.abort) break;
  }
}

// Usage
const executor = reactiveExecute([task1, task2]);

for await (const result of executor) {
  const decision = await agent.decide(result);
  executor.next(decision); // Send decision back
}
```

**Forces:** ✅ **Pull-based**: Agent contrôle le rythme ✅ **Construction dynamique**: DAG se
construit pendant exécution ✅ **Simple conceptuellement**: Generator pattern familier

**Faiblesses:** ❌ **Perd parallélisation**: Séquentiel par nature ❌ **Performance**: 5x plus lent
sans parallélisme ❌ **Incompatible speculative execution** ❌ **Difficile à visualiser/debugger**

**Verdict:** Trop limitant pour nos objectifs de performance

---

## Recommended Architecture: Hybrid Event-Driven with Multi-Agent Control

### Architecture Overview

```typescript
/**
 * Controlled DAG Executor with Agent + Human feedback loop
 */
class MultiAgentExecutor extends ParallelExecutor {
  private commandQueue: AsyncQueue<Command>;
  private checkpointPolicy: CheckpointPolicy;

  async executeWithControl(
    dag: DAGStructure,
    config: ExecutionConfig,
  ): Promise<DAGExecutionResult> {
    const eventStream = new TransformStream<ExecutionEvent>();
    const writer = eventStream.writable.getWriter();

    // Setup feedback loops
    const agentLoop = this.startAgentLoop(eventStream.readable, config.agent);
    const humanLoop = this.startHumanLoop(eventStream.readable, config.human);

    const layers = this.topologicalSort(dag);

    for (let i = 0; i < layers.length; i++) {
      // 1. Process pending commands
      await this.processCommands();

      // 2. Checkpoint PRE-layer (si policy le demande)
      if (this.checkpointPolicy.shouldCheckpoint("pre-layer", i)) {
        await this.checkpoint({
          type: "pre-layer",
          layer: i,
          remaining: layers.slice(i),
        }, writer);
      }

      // 3. Execute layer avec event streaming
      const layer = layers[i];
      await this.executeLayerWithEvents(layer, writer);

      // 4. Checkpoint POST-layer
      if (this.checkpointPolicy.shouldCheckpoint("post-layer", i)) {
        await this.checkpoint({
          type: "post-layer",
          layer: i,
          results: this.getLayerResults(i),
        }, writer);
      }

      // 5. Process commands issued during layer
      await this.processCommands();
    }

    await writer.close();
    return this.buildResult();
  }

  /**
   * Agent feedback loop (autonome)
   */
  private async startAgentLoop(
    events: ReadableStream<ExecutionEvent>,
    agentConfig: AgentConfig,
  ): Promise<void> {
    const reader = events.getReader();

    while (true) {
      const { done, value: event } = await reader.read();
      if (done) break;

      // Agent analyse l'event
      const decision = await this.agent.react(event, {
        confidence: agentConfig.confidence,
        speculative: agentConfig.speculative,
      });

      // Agent peut injecter commands
      if (decision.commands) {
        for (const cmd of decision.commands) {
          this.commandQueue.enqueue(cmd);
        }
      }
    }
  }

  /**
   * Human feedback loop (interactif)
   */
  private async startHumanLoop(
    events: ReadableStream<ExecutionEvent>,
    humanConfig: HumanConfig,
  ): Promise<void> {
    const reader = events.getReader();

    while (true) {
      const { done, value: event } = await reader.read();
      if (done) break;

      // Filter events pour human (seulement checkpoints critiques)
      if (this.shouldNotifyHuman(event, humanConfig)) {
        const response = await this.askHuman(event);

        if (response.command) {
          this.commandQueue.enqueue(response.command);
        }
      }
    }
  }

  /**
   * Checkpoint: Pause et demande validation
   */
  private async checkpoint(
    context: CheckpointContext,
    writer: WritableStreamDefaultWriter<ExecutionEvent>,
  ): Promise<void> {
    // Emit checkpoint event
    await writer.write({
      type: "checkpoint",
      data: {
        context,
        timestamp: new Date().toISOString(),
      },
    });

    // Wait for checkpoint resolution (via command queue)
    const resolution = await this.waitForCheckpointResolution(context.id);

    if (!resolution.approved) {
      throw new CheckpointRejectedError(resolution.reason);
    }

    // Apply modifications si présentes
    if (resolution.modifications) {
      this.applyModifications(resolution.modifications);
    }
  }
}
```

### Execution Modes

```typescript
interface ExecutionConfig {
  mode: "speculative" | "guided" | "interactive";

  agent: {
    enabled: boolean;
    confidence: number; // 0-1
    speculative: boolean; // Skip checkpoints si confiance > threshold
  };

  human: {
    enabled: boolean;
    checkpoints: "critical-only" | "all" | "none";
    notifications: "all" | "errors-only" | "none";
  };

  checkpointPolicy: {
    preLayer: boolean;
    postLayer: boolean;
    onError: boolean;
    onCriticalOp: boolean; // DELETE, WRITE, EXEC
  };
}
```

**Mode 1: Speculative (Agent autonome, confiance >0.85)**

```typescript
const config = {
  mode: "speculative",
  agent: { enabled: true, confidence: 0.9, speculative: true },
  human: { enabled: false, checkpoints: "none" },
  checkpointPolicy: { preLayer: false, postLayer: false, onError: true },
};

// Résultat: Exécution rapide sans pauses, sauf erreurs
```

**Mode 2: Guided (Agent + Human oversight)**

```typescript
const config = {
  mode: "guided",
  agent: { enabled: true, confidence: 0.7, speculative: false },
  human: { enabled: true, checkpoints: "critical-only" },
  checkpointPolicy: { preLayer: false, postLayer: true, onError: true, onCriticalOp: true },
};

// Résultat: Agent contrôle routine, Human valide opérations critiques
```

**Mode 3: Interactive (Human-in-the-loop complet)**

```typescript
const config = {
  mode: "interactive",
  agent: { enabled: true, confidence: 0.5, speculative: false },
  human: { enabled: true, checkpoints: "all" },
  checkpointPolicy: { preLayer: true, postLayer: true, onError: true, onCriticalOp: true },
};

// Résultat: Validation humaine à chaque étape
```

### Integration avec Architecture Existante

**Modifications requises:**

```typescript
// src/dag/executor.ts
export class ParallelExecutor {
  // Extract method pour permettre extension
  protected async executeLayer(layer: Task[]): Promise<Map<string, TaskResult>> {
    const results = await Promise.allSettled(
      layer.map((task) => this.executeTask(task)),
    );
    return this.collectResults(results);
  }
}

// src/dag/controlled-executor.ts [NOUVEAU]
export class ControlledExecutor extends ParallelExecutor {
  // Ajoute command queue + checkpoints
  // Voir code ci-dessus
}

// src/dag/types.ts [EXTEND]
export interface ExecutionEvent {
  type: "task_start" | "task_complete" | "checkpoint" | "error";
  data: {
    taskId?: string;
    context?: CheckpointContext;
    timestamp: string;
  };
}

export interface Command {
  id: string;
  type: "abort" | "inject_task" | "skip_layer" | "modify_args" | "checkpoint_response";
  payload: unknown;
  timestamp: string;
}

export interface CheckpointContext {
  id: string;
  type: "pre-layer" | "post-layer" | "on-error" | "critical-op";
  layer?: number;
  task?: Task;
  results?: TaskResult[];
  remaining?: Task[];
}
```

---

## Human-in-the-Loop UI/UX Considerations

### Terminal-Based Interface (MVP)

**Checkpoint Prompt Example:**

```bash
┌─────────────────────────────────────────────────────────┐
│ 🛑 CHECKPOINT: Critical Operation Detected              │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ The next task will DELETE files:                        │
│                                                          │
│   Task: filesystem:delete_files                         │
│   Args: { path: "./temp/*", count: 523 files }         │
│                                                          │
│ Completed so far:                                       │
│   ✅ Layer 1: [read_config, read_data] (2/2 success)   │
│   ✅ Layer 2: [process_data] (1/1 success)             │
│                                                          │
│ Remaining:                                              │
│   ⏸️  Layer 3: [DELETE files, WRITE results]           │
│                                                          │
├─────────────────────────────────────────────────────────┤
│ Options:                                                │
│   [c] Continue with deletion                            │
│   [a] Abort workflow                                    │
│   [m] Modify task (reduce file count)                  │
│   [s] Skip this task only                              │
│                                                          │
│ Your choice: _                                          │
└─────────────────────────────────────────────────────────┘
```

### SSE-Based Web Interface (Future)

**Real-time Dashboard:**

```
┌────────────────────────────────────────────────────┐
│  DAG Execution: "Analyze GitHub Repository"        │
├────────────────────────────────────────────────────┤
│                                                     │
│  Layer 1: [list_repos, get_issues] ✅ COMPLETE    │
│    ├─ list_repos: 15 repos found (120ms)          │
│    └─ get_issues: 523 issues (450ms)              │
│                                                     │
│  Layer 2: [filter_issues] 🔄 IN PROGRESS          │
│    └─ filter_issues: Processing... (45%)          │
│                                                     │
│  Layer 3: [create_summary] ⏸️ PENDING             │
│                                                     │
│  🤖 Agent suggests: "Too many issues, filter by   │
│     'bug' label only"                              │
│                                                     │
│  👤 Your approval needed:                          │
│     [Approve] [Reject] [Modify Filter]             │
│                                                     │
└────────────────────────────────────────────────────┘
```

---

## Implementation Roadmap

### Sprint 1: MVP - Synchronous Checkpoints (2-3 heures)

**Scope:**

- Refactor `ParallelExecutor.executeLayer()` extraction
- Add checkpoint callback post-layer
- Support "continue" | "abort" decisions
- Terminal-based prompt pour human approval

**Story:** Epic 2.5.1 - Checkpoint Infrastructure

**Acceptance Criteria:**

```typescript
// Test case
const executor = new ControlledExecutor(toolExecutor);

const result = await executor.executeWithCheckpoints(
  dag,
  async (context) => {
    // Mock human decision
    if (context.type === "post-layer" && context.layer === 1) {
      return { action: "abort", reason: "User stopped" };
    }
    return { action: "continue" };
  },
);

expect(result.aborted).toBe(true);
expect(result.completedLayers).toBe(1);
```

---

### Sprint 2: Command Queue & Agent Control (2-3 heures)

**Scope:**

- Implement `AsyncQueue<Command>` thread-safe
- Add command types: abort, inject_task, skip_layer, modify_args
- Process commands before/after each layer
- Agent loop avec simple decision logic

**Story:** Epic 2.5.2 - Command Queue & Agent Control

**Acceptance Criteria:**

```typescript
const executor = new ControlledExecutor(toolExecutor);
const eventStream = new TransformStream<ExecutionEvent>();

// Agent loop (mock)
const agentLoop = async () => {
  for await (const event of eventStream.readable) {
    if (event.type === "task_complete" && event.data.output.size > 1000000) {
      // File trop gros, abort
      executor.injectCommand({
        type: "abort",
        reason: "File size exceeded limit",
      });
    }
  }
};

agentLoop(); // Start agent loop
await executor.executeWithControl(dag, eventStream);

expect(result.aborted).toBe(true);
```

---

### Sprint 3: Full Event-Driven + Human Loop (2-3 heures)

**Scope:**

- Async generator pattern pour `executeStream()`
- Integration agent.react() avec Claude API
- Terminal UI pour human checkpoints
- Checkpoint policies (speculative, guided, interactive)
- End-to-end tests avec multi-turn scenarios

**Story:** Epic 2.5.3 - Event-Driven Agent Loop

**Acceptance Criteria:**

```typescript
// Full multi-turn test
const config: ExecutionConfig = {
  mode: "guided",
  agent: { enabled: true, confidence: 0.7 },
  human: { enabled: true, checkpoints: "critical-only" },
  checkpointPolicy: { onCriticalOp: true },
};

const executor = new ControlledExecutor(toolExecutor, config);

// Mock agent decisions
const agentDecisions = [
  { action: "inject_task", task: newParserTask },
  { action: "continue" },
];

// Mock human approvals
const humanApprovals = [
  { approved: true }, // Allow DELETE
];

const result = await executor.executeWithControl(dag);

expect(result.totalTasks).toBe(dag.tasks.length + 1); // +1 injected
expect(result.humanInterventions).toBe(1);
expect(result.agentModifications).toBe(1);
```

---

### Sprint 4: Speculative Execution avec GraphRAG (3-4 heures)

**Scope:**

- GraphRAG next-node prediction basé sur patterns historiques
- Speculative task execution pendant agent thinking time
- Speculation resolution (keep/discard)
- Feature flag + safety constraints (read-only speculation)
- Performance metrics tracking (hit rate, latency reduction)

**Story:** Epic 2.5.4 - Speculative Execution avec GraphRAG

**Problem Statement:**

Le multi-turn agent feedback loop introduit une **latence incompressible** à chaque décision:

```
Task A complete (200ms)
  ↓
Agent thinking (1-3s) ← LATENCE: On attend que l'agent décide
  ↓
Task B execute (500ms)
```

**Total latency:** 200ms + 1500ms + 500ms = **2200ms**

Avec speculation, on peut réduire ça à ~1700ms (gain de 23%)

**Solution: Speculative Next-Node Execution**

Pendant que l'agent réfléchit, on **exécute spéculativement** le(s) noeud(s) suivant(s) le(s) plus
probable(s) basé sur GraphRAG predictions:

```
Task A complete (200ms)
  ↓
  ├─→ Agent thinking (1500ms)
  └─→ GraphRAG predict + Execute Task B speculatively (500ms) ← EN PARALLÈLE
  ↓
Agent decision: "Task B" ✅ MATCH!
  ↓
Task B result already available (0ms wait) ← GAIN: 500ms saved
```

**Net latency:** 200ms + max(1500ms, 500ms) + 0ms = **1700ms** (23% faster)

---

#### Architecture: SpeculativeExecutor

```typescript
/**
 * Speculative Executor with GraphRAG-based prediction
 */
class SpeculativeExecutor extends ControlledExecutor {
  private graphRAG: GraphRAGPredictor;
  private speculationEnabled: boolean;

  async executeWithSpeculation(
    dag: DAGStructure,
    config: ExecutionConfig,
  ): Promise<DAGExecutionResult> {
    const layers = this.topologicalSort(dag);

    for (let i = 0; i < layers.length; i++) {
      // 1. Execute current layer
      const results = await executeLayer(layers[i]);

      // 2. Start speculation while agent thinks
      const speculationPromise = this.speculateNextNodes(results, layers.slice(i + 1));

      // 3. Agent decides (runs in parallel with speculation)
      const agentDecisionPromise = this.agent.decide(results);

      // 4. Wait for both to complete
      const [speculation, decision] = await Promise.all([
        speculationPromise,
        agentDecisionPromise,
      ]);

      // 5. Resolve speculation
      if (speculation && this.isMatch(speculation.task, decision.task)) {
        // 🎉 SPECULATION HIT! Use speculative results
        results.merge(speculation.results);

        this.metrics.speculationHit++;
        this.metrics.timeSaved += speculation.executionTime;
      } else {
        // 🗑️ SPECULATION MISS: Discard and execute real decision
        if (speculation) {
          await speculation.cleanup(); // Cancel if still running
          this.metrics.speculationMiss++;
        }

        // Execute agent's actual decision
        await this.executeTask(decision.task);
      }
    }

    return this.buildResult();
  }

  /**
   * Speculate next nodes using GraphRAG
   */
  private async speculateNextNodes(
    currentResults: TaskResult[],
    remainingLayers: Task[][],
  ): Promise<Speculation | null> {
    if (!this.speculationEnabled) return null;

    // 1. Use GraphRAG to predict next nodes
    const predictions = await this.graphRAG.predictNextNodes({
      completed: currentResults,
      remaining: remainingLayers.flat(),
      topK: 3,
      confidenceThreshold: 0.7,
    });

    // predictions = [
    //   { task: "parse_xml", confidence: 0.85, reasoning: "XML format detected" },
    //   { task: "parse_json", confidence: 0.60, reasoning: "Fallback option" },
    //   { task: "validate_schema", confidence: 0.45, reasoning: "Low confidence" }
    // ]

    if (predictions.length === 0 || predictions[0].confidence < 0.7) {
      // Not confident enough to speculate
      return null;
    }

    const topPrediction = predictions[0];

    // 2. Safety check: Only speculate on safe tasks
    if (!this.isSafeToSpeculate(topPrediction.task)) {
      // Don't speculate on DELETE, WRITE, EXEC operations
      return null;
    }

    // 3. Execute speculatively
    const startTime = performance.now();

    const speculationPromise = this.executeTask(topPrediction.task, {
      speculative: true,
      timeout: 5000, // Max 5s speculation
    });

    return {
      task: topPrediction.task,
      confidence: topPrediction.confidence,
      resultsPromise: speculationPromise,
      startTime,
      cleanup: () => speculationPromise.cancel(),
    };
  }

  /**
   * Check if task is safe to speculate
   */
  private isSafeToSpeculate(task: Task): boolean {
    const UNSAFE_OPERATIONS = [
      "delete",
      "remove",
      "write",
      "update",
      "exec",
      "run",
      "execute",
      "modify",
    ];

    const toolName = task.tool.toLowerCase();

    return !UNSAFE_OPERATIONS.some((op) => toolName.includes(op));
  }

  /**
   * Check if speculation matches agent decision
   */
  private isMatch(speculatedTask: Task, decidedTask: Task): boolean {
    return speculatedTask.id === decidedTask.id &&
      speculatedTask.tool === decidedTask.tool &&
      JSON.stringify(speculatedTask.arguments) === JSON.stringify(decidedTask.arguments);
  }
}
```

---

#### GraphRAG Next-Node Prediction

GraphRAG utilise 3 sources d'information pour prédire le prochain noeud:

**1. Historical Pattern Analysis (PGlite)**

```typescript
class GraphRAGPredictor {
  async predictNextNodes(context: PredictionContext): Promise<Prediction[]> {
    // Analyze historical task sequences
    const patterns = await this.db.query(
      `
      SELECT
        next_task_id,
        next_task_tool,
        COUNT(*) as frequency,
        AVG(confidence) as avg_confidence
      FROM task_sequences
      WHERE
        prev_task_id = $1
        AND result_type = $2
      GROUP BY next_task_id, next_task_tool
      ORDER BY frequency DESC
      LIMIT 5
    `,
      [context.completed[0].taskId, context.completed[0].output.type],
    );

    // Example result:
    // [
    //   { next_task: "parse_xml", frequency: 85, avg_confidence: 0.90 },
    //   { next_task: "validate_xml", frequency: 10, avg_confidence: 0.75 },
    //   { next_task: "skip", frequency: 5, avg_confidence: 0.60 }
    // ]
  }
}
```

**2. Vector Similarity Search**

```typescript
// Find similar workflows in history
const similarWorkflows = await this.vectorSearch.search(
  this.buildQueryFromContext(context),
  k: 10,
  threshold: 0.75
);

// Example:
// Query: "read XML file format detected 10KB size"
//
// Similar workflows:
// 1. "read XML config parse transform" (similarity: 0.92)
// 2. "read XML data validate export" (similarity: 0.85)
// 3. "read JSON parse transform" (similarity: 0.70)

// Extract next-node patterns from similar workflows
const nextNodePatterns = this.extractNextNodes(similarWorkflows);
// → parse_xml appears in 8/10 workflows → High confidence
```

**3. Dependency Graph Analysis**

```typescript
// Analyze what tasks are actually available (dependencies satisfied)
const availableTasks = context.remaining.filter((task) =>
  task.depends_on.every((dep) => context.completed.some((r) => r.taskId === dep))
);

// availableTasks = [parse_xml, validate_xml, skip, create_report]

// Combine with historical patterns:
// parse_xml: Available ✅ + High frequency (85%) → Top prediction
// validate_xml: Available ✅ + Medium frequency (10%) → Backup
// create_report: Available ✅ but depends on parsing → Low priority
```

**Combined Prediction:**

```typescript
const predictions = this.combineSignals({
  historical: { parse_xml: 0.85, validate_xml: 0.10 },
  similarity: { parse_xml: 0.90, validate_xml: 0.70 },
  available: { parse_xml: true, validate_xml: true, create_report: true },
});

// Final predictions with confidence:
return [
  {
    task: "parse_xml",
    confidence: 0.88,
    reasoning: "High historical frequency + vector similarity",
  },
  { task: "validate_xml", confidence: 0.65, reasoning: "Medium historical pattern" },
  { task: "create_report", confidence: 0.30, reasoning: "Available but premature" },
];
```

---

#### Performance Model

**Scenario 1: High-confidence prediction (>0.85)**

```
Without speculation:
  Task A: 200ms
  Agent thinking: 1500ms ← WAITING
  Task B: 500ms
  Total: 2200ms

With speculation:
  Task A: 200ms
  Agent thinking: 1500ms } Parallel
  Task B (speculative): 500ms }
  → max(1500, 500) = 1500ms
  Speculation hit: 0ms (result ready)
  Total: 1700ms

GAIN: 500ms (23% faster)
```

**Scenario 2: Speculation miss (agent chooses different task)**

```
With speculation:
  Task A: 200ms
  Agent thinking: 1500ms } Parallel
  Task B (speculative): 500ms } Wasted!
  → max(1500, 500) = 1500ms
  Speculation miss: discard results
  Task C (actual): 500ms
  Total: 2200ms

LOSS: 500ms wasted computation (but no latency penalty)
```

**Break-even Analysis:**

```
Expected value = P(hit) × Gain - P(miss) × Cost

With 70% hit rate:
EV = 0.70 × 500ms - 0.30 × 0ms = 350ms gain

With 50% hit rate:
EV = 0.50 × 500ms - 0.50 × 0ms = 250ms gain

With 30% hit rate:
EV = 0.30 × 500ms - 0.70 × 0ms = 150ms gain

→ Profitable même avec 30% hit rate!
   (Pas de coût en latency si miss, juste CPU waste)
```

---

#### Safety Constraints

**Read-only Speculation Policy:**

```typescript
const SPECULATION_POLICY = {
  // ✅ SAFE: Read-only operations
  allowed: [
    "filesystem:read_file",
    "github:list_commits",
    "database:query",
    "api:get_*",
    "xml:parse",
    "json:parse",
  ],

  // ❌ UNSAFE: Write/Delete/Execute operations
  forbidden: [
    "filesystem:write_file",
    "filesystem:delete_*",
    "database:insert",
    "database:update",
    "database:delete",
    "api:post_*",
    "api:put_*",
    "api:delete_*",
    "exec:run_command",
  ],

  // Default: Conservative (deny unknown operations)
  default: "deny",
};
```

**Timeout Protection:**

```typescript
// Speculation ne doit jamais bloquer l'agent
const SPECULATION_TIMEOUT = 5000; // 5 seconds max

if (speculationTime > agentThinkingTime) {
  // Speculation trop lente, cancel
  speculation.cancel();
  this.metrics.speculationTimeout++;
}
```

---

#### Feature Flag & Configuration

```typescript
interface SpeculationConfig {
  enabled: boolean; // Default: false (opt-in)
  confidenceThreshold: number; // Default: 0.7
  maxConcurrent: number; // Default: 1 (only top prediction)
  timeout: number; // Default: 5000ms
  allowedOperations: string[]; // Whitelist
  forbiddenOperations: string[]; // Blacklist
}

// Usage
const executor = new SpeculativeExecutor(toolExecutor, {
  speculation: {
    enabled: true,
    confidenceThreshold: 0.75,
    maxConcurrent: 1,
  },
});
```

---

#### Metrics & Observability

```typescript
interface SpeculationMetrics {
  total: number;
  hits: number;
  misses: number;
  timeouts: number;
  hitRate: number; // hits / total
  avgTimeSaved: number; // milliseconds
  totalTimeSaved: number; // milliseconds
  wastedCompute: number; // milliseconds on misses
  netBenefit: number; // totalTimeSaved - wastedCompute (should be positive!)
}

// Example metrics after 100 workflows:
{
  total: 250,
  hits: 175,
  misses: 65,
  timeouts: 10,
  hitRate: 0.70,
  avgTimeSaved: 450, // ms per hit
  totalTimeSaved: 78750, // ms total
  wastedCompute: 32500, // ms on misses (but no latency impact!)
  netBenefit: 46250 // ms net gain (59% efficiency)
}
```

---

#### Acceptance Criteria

```typescript
// Test: Speculation hit
const executor = new SpeculativeExecutor(toolExecutor, {
  speculation: { enabled: true, confidenceThreshold: 0.7 },
});

// Mock GraphRAG to predict "parse_xml" with 0.85 confidence
mockGraphRAG.predictNextNodes.mockResolvedValue([
  { task: { id: "parse_xml", tool: "xml:parse" }, confidence: 0.85 },
]);

// Mock agent to decide "parse_xml" (match!)
mockAgent.decide.mockResolvedValue({
  task: { id: "parse_xml", tool: "xml:parse" },
});

const result = await executor.executeWithSpeculation(dag);

expect(result.metrics.speculationHit).toBe(1);
expect(result.metrics.timeSaved).toBeGreaterThan(0);

// Test: Speculation miss
mockAgent.decide.mockResolvedValue({
  task: { id: "parse_json", tool: "json:parse" }, // Different!
});

const result2 = await executor.executeWithSpeculation(dag);

expect(result2.metrics.speculationMiss).toBe(1);
expect(result2.metrics.wastedCompute).toBeGreaterThan(0);
// But latency should NOT increase (parallel execution)

// Test: Safety - forbidden operations
mockGraphRAG.predictNextNodes.mockResolvedValue([
  { task: { id: "delete_files", tool: "filesystem:delete_file" }, confidence: 0.90 },
]);

const result3 = await executor.executeWithSpeculation(dag);

// Should NOT speculate on unsafe operation
expect(result3.metrics.speculationAttempts).toBe(0);
```

---

## Success Metrics

### Technical Metrics

- ✅ **Checkpoint latency:** <50ms overhead per checkpoint (excluant agent/human response time)
- ✅ **Parallelism preserved:** Speedup 5x maintenu avec checkpoints désactivés
- ✅ **Command processing:** <10ms latency pour command injection
- ✅ **Memory overhead:** <5MB pour command queue et event stream buffers
- ✅ **Speculation hit rate:** >60% (GraphRAG predictions correctes)
- ✅ **Speculation latency reduction:** >30% sur workflows multi-turn
- ✅ **Speculation safety:** 0 unsafe operations executed speculatively

### UX Metrics

- ✅ **Agent intervention rate:** 20-40% des workflows nécessitent agent modifications
- ✅ **Human intervention rate:** <10% des workflows en mode "guided"
- ✅ **False positive checkpoints:** <5% (checkpoints inutiles)
- ✅ **User satisfaction:** NPS >75 pour contrôle utilisateur

### Business Metrics

- ✅ **Error recovery:** 80% des erreurs résolues automatiquement par agent
- ✅ **Workflow adaptability:** 60% des workflows s'adaptent dynamiquement
- ✅ **Human oversight confidence:** 90% users feel "in control"

---

## Risks & Mitigations

### Risk 1: Checkpoint Latency Impact

**Risk:** Chaque checkpoint = 1-3s pour Claude → workflows 10x plus lents

**Mitigation:**

- Mode speculative par défaut (skip checkpoints si confiance >0.85)
- Checkpoint policies configurables
- Batch multiple checkpoints en une seule requête Claude

### Risk 2: Command Queue Race Conditions

**Risk:** Agent et Human injectent commands simultanément → état incohérent

**Mitigation:**

- Thread-safe AsyncQueue avec locks
- Command versioning et conflict detection
- Last-write-wins policy pour modifications conflictuelles

### Risk 3: Complexity Creep

**Risk:** Architecture trop complexe → difficile à maintenir

**Mitigation:**

- Implémentation progressive (4 sprints)
- Fallback vers mode simple si erreurs
- Documentation exhaustive + tests end-to-end

### Risk 4: User Fatigue (Checkpoint Overload)

**Risk:** Trop de checkpoints → user ignore ou désactive

**Mitigation:**

- Checkpoint policies intelligentes (critical-only par défaut)
- Learn from user behavior (ML-based checkpoint prediction future)
- Clear checkpoint messaging (pourquoi ce checkpoint?)

### Risk 5: Speculation Resource Waste

**Risk:** Speculation misses → compute gaspillé sans bénéfice

**Mitigation:**

- Confidence threshold >0.7 (only speculate sur high-confidence predictions)
- Track net benefit metric (timeSaved - wastedCompute > 0)
- Feature flag OFF par défaut (opt-in)
- Safety whitelist (read-only operations only)

### Risk 6: Speculation Side Effects

**Risk:** Speculation task a side effects (cache invalidation, logs pollution)

**Mitigation:**

- Strict read-only policy pour speculation
- Blacklist toutes operations avec side effects (WRITE, DELETE, EXEC)
- Timeout 5s max pour speculation
- Audit log pour speculation attempts

---

## Open Questions

### Q1: Granularité des checkpoints

**Question:** Checkpoints au niveau layer ou task?

**Options:**

- A) Layer-level: Simple mais granularité grossière
- B) Task-level: Contrôle fin mais overhead important
- C) Hybrid: Critical tasks seulement (DELETE, WRITE, EXEC)

**Recommendation:** Option C (Hybrid) - balances control vs performance

### Q2: Agent confidence threshold

**Question:** Quel threshold pour mode speculative?

**Options:**

- 0.75: Conservatif, beaucoup de checkpoints
- 0.85: Équilibré (recommended)
- 0.95: Aggressif, très peu de checkpoints

**Recommendation:** 0.85 par défaut, configurable par user

### Q3: Human timeout policy

**Question:** Que faire si human ne répond pas à checkpoint?

**Options:**

- A) Timeout after 5min → auto-abort
- B) Timeout → continue (assume approved)
- C) Timeout → ask agent to decide

**Recommendation:** Option A (auto-abort) pour sécurité

### Q4: Persistence des commands

**Question:** Faut-il persister command queue pour recovery?

**Answer:** Oui pour workflows longs (>5min). Sauvegarder état dans PGlite pour recovery post-crash.

---

## Decision

**Selected Architecture:** Hybrid Event-Driven with Multi-Agent Control (Option 2)

**Rationale:**

- ✅ Balance performance (parallélisme) et contrôle (checkpoints)
- ✅ Supporte agent autonomy ET human oversight
- ✅ Extensible pour futurs use cases (multi-agent collaboration)
- ✅ Compatible architecture message-passing existante
- ✅ Path to production clair (4 sprints progressifs)
- ✅ **Speculative execution** réduit latence 23-30% sans risques

**Next Steps:**

1. Create Epic 2.5 dans sprint-status.yaml
2. Draft 4 stories (2.5.1, 2.5.2, 2.5.3, 2.5.4)
3. Create ADR-007 pour tracer cette décision
4. Update architecture.md avec nouveau pattern

---

## Related Spikes

### Episodic Memory & Adaptive Thresholds

**See:** `docs/spikes/spike-episodic-memory-adaptive-thresholds.md`

This spike extends the speculation mechanism (Sprint 4, lines 1197-1680) with meta-learning
capabilities:

**What this spike covers (Stories 2.5-1 to 2.5-4):**

- ✅ Event Stream + Command Queue (Loop 1 execution)
- ✅ Checkpoints & Resume
- ✅ AIL/HIL Integration (Loop 2 adaptation)
- ✅ Speculative Execution with **fixed threshold (0.7)**
- ✅ GraphRAG predictions

**What the Episodic Memory spike adds (Stories 2.5-5 to 2.5-6):**

- 🆕 **Episodic Memory**: Storage of speculation outcomes for learning
- 🆕 **Adaptive Thresholds**: Self-adjusting confidence thresholds (replacing fixed 0.7)
- 🆕 **Loop 3 Meta-Learning Details**: How speculation success rates improve over time
- 🆕 **Context-aware retrieval**: Past experiences boost prediction confidence (+2-10%)

**Architecture Integration:**

```
This Spike (Execution & Control)          Episodic Spike (Learning & Improvement)
┌─────────────────────────────┐          ┌──────────────────────────────┐
│ Loop 1: Execute tasks       │──events─→│ EpisodicMemory.capture()     │
│ Loop 2: Adapt DAG (AIL/HIL) │          │   ↓                          │
│ Loop 3: Update GraphRAG     │          │ AdaptiveThreshold.learn()    │
│                             │          │   ↓                          │
│ SpeculativeExecutor uses    │←threshold─│ Dynamic threshold (0.70-0.95)│
│   Fixed 0.7 threshold       │          │   (vs fixed 0.7)             │
└─────────────────────────────┘          └──────────────────────────────┘
```

Together, these spikes implement the complete **3-loop learning architecture** inspired by the CoALA
framework comparison.

---

## References

- **Architect Review:** Winston, 2025-11-13
- **PM Review:** John, 2025-11-13
- **Related Spikes:**
  - `docs/spikes/spike-episodic-memory-adaptive-thresholds.md` - Meta-learning (Loop 3 details)
  - `docs/spikes/spike-coala-comparison-adaptive-feedback.md` - CoALA framework comparison
- **Related Docs:**
  - `docs/architecture.md` - System Architecture
  - `docs/PRD.md` - FR018 (Sandbox safe-to-fail branches)
  - `src/dag/executor.ts` - Current ParallelExecutor implementation
  - `src/dag/streaming.ts` - SSE streaming support

---

**Status:** ✅ Ready for Review **Reviewers:** Winston (Architect), John (PM) **Approval Required:**
BMad

---

_Generated: 2025-11-13_ _Last Updated: 2025-11-13_
