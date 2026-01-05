# Spike: CoALA Framework vs Casys PML Adaptive Feedback Loops

**Date:** 2025-11-13 **Author:** Research Analysis **Status:** Analysis Complete **Related:** Epic
2.5 - Adaptive DAG Feedback Loops

---

## Executive Summary

Ce spike compare le framework **CoALA** (Cognitive Architectures for Language Agents) avec notre
architecture **Casys PML Epic 2.5** pour identifier parallèles, différences, et opportunités
d'amélioration.

**Conclusion Clé:** Casys PML implémente une architecture **plus granulaire** (3 loops vs 2) avec
**meta-learning explicite** (GraphRAG), mais pourrait bénéficier des mécanismes CoALA pour:
**confidence adaptative**, **memory structurée**, et **retrieval dynamique**.

### Mise en Abyme Architecturale

**Casys PML = "Procedural Memory Layer"** - ce nom révèle une dualité :

| Niveau              | Rôle de PML                         | Description                                                                                                    |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Macro (CoALA)**   | PML **EST** une mémoire procédurale | Pour les agents LLM, PML stocke "comment faire" : capabilities, workflow patterns, DAGs                        |
| **Micro (Interne)** | PML **A** ses propres mémoires      | Working (WorkflowState), Episodic (Traces+PER), Semantic (Capabilities+GraphRAG), Procedural (DAGSuggester+TD) |

**Implication:** Casys PML peut s'intégrer comme composant "Procedural Memory" d'un système CoALA
plus large, tout en ayant sa propre architecture cognitive interne.

---

## 1. CoALA Framework - Résumé Architecture

### 1.1 Structure Générale

CoALA organise les agents autour de **3 dimensions:**

1. **Memory Modules** (Working + Long-term)
2. **Action Spaces** (External + Internal)
3. **Decision Procedures** (Planning → Execution)

### 1.2 Les Deux Feedback Loops

**Decision Cycle Loop (Inner):**

```
Observation → Planning (Propose → Evaluate → Select) → Execute Action → New Observation
```

- Opère à chaque décision (milliseconds to seconds)
- Working memory = état actif
- Reasoning/Retrieval = actions internes

**Learning Loop (Outer):**

```
Experience trajectories → Reflect → Write to Long-term Memory → Improve future cycles
```

- Opère sur multiples cycles (hours to days)
- Episodic: Store experiences
- Semantic: Extract knowledge
- Procedural: Update LLM/code

### 1.3 Memory Architecture

| Memory Type    | Content                    | Access                    | Write                  |
| -------------- | -------------------------- | ------------------------- | ---------------------- |
| **Working**    | Current state, active info | Read/Write during cycle   | Every cycle            |
| **Episodic**   | Experiences, trajectories  | Retrieval during planning | Learning loop          |
| **Semantic**   | Facts, inferences          | Retrieval for reasoning   | Reflection on episodes |
| **Procedural** | LLM weights + agent code   | LLM calls, function exec  | Fine-tuning, code gen  |

### 1.4 Action Space

**External Actions (Grounding):**

- Physical: Robot control
- Digital: APIs, code execution
- Dialogue: Human interaction

**Internal Actions:**

- **Reasoning:** Generate new info from current state
- **Retrieval:** Read from long-term memory
- **Learning:** Write to long-term memory

### 1.5 Planning Mechanisms

**Simple:** LLM proposes action directly **Intermediate:** Reason → propose code procedure → refine
**Complex:** Tree search (BFS/DFS), MCTS, multi-step simulation

---

## 2. Casys PML Epic 2.5 - Architecture Recap

### 2.1 Notre Structure (3 Loops!)

**Loop 1 (Inner): Execution Loop**

- **Niveau:** DAG Workflow (éphémère)
- **Composants:** Event stream, command queue, state management
- **Cycle:** Task → Event → State update → Next task
- **Fréquence:** Real-time (milliseconds)

**Loop 2 (Middle): Adaptation Loop**

- **Niveau:** DAG Workflow (modification runtime)
- **Composants:** AIL/HIL decisions, DAGSuggester.replanDAG()
- **Cycle:** Discovery → Decision → Query GraphRAG → Inject new nodes
- **Fréquence:** Per-layer (seconds to minutes)

**Loop 3 (Outer/Meta): Learning Loop**

- **Niveau:** GraphRAG Knowledge Graph (permanent)
- **Composants:** GraphRAGEngine.updateFromExecution()
- **Cycle:** Workflow complete → Extract patterns → Update graph → Better suggestions
- **Fréquence:** Per-workflow (minutes to days)

### 2.2 Notre Memory Architecture (Implicite)

| Type           | Casys PML Équivalent                                  | Storage   | Scope            |
| -------------- | ----------------------------------------------------- | --------- | ---------------- |
| **Working**    | `WorkflowState` (messages, tasks, decisions, context) | In-memory | Current workflow |
| **Episodic**   | `state.tasks[]` + Checkpoints (PGlite)                | PGlite    | Current + resume |
| **Semantic**   | Capabilities + Intent (pur) + GraphRAG (hybride)      | PGlite    | All workflows    |
| **Procedural** | DAGSuggester + GraphRAGEngine code                    | Code      | System-wide      |

**Clarification Mémoire Sémantique:**

```
┌─────────────────────────────────────────────────────────────┐
│                    MÉMOIRE SÉMANTIQUE                       │
├─────────────────────────────────────────────────────────────┤
│  SÉMANTIQUE PURE                                            │
│  └── Capabilities + Intent (workflow_pattern table)         │
│      "Ce pattern sert à envoyer un email avec pièce jointe" │
│      → Faits explicites sur ce que font les outils          │
├─────────────────────────────────────────────────────────────┤
│  HYBRIDE (Graph + Sémantique)                               │
│  └── GraphRAG                                               │
│      - Graph: tool_A →(0.8)→ tool_B (patterns appris)      │
│      - RAG: retrieval par similarité sémantique             │
│      → Mélange structure relationnelle + sens               │
└─────────────────────────────────────────────────────────────┘
```

**Note:** GraphRAG n'est pas purement sémantique. La partie "Graph" (edges, PageRank) est plutôt
procédurale/épisodique (patterns appris des exécutions). La partie "RAG" est sémantique (retrieval
par sens).

### 2.3 Notre Action Space

**External Actions:**

- MCP tool execution (digital grounding)
- Code execution (Deno sandbox - Epic 3)

**Internal Actions:**

- **Reasoning:** Agent decisions (AIL)
- **Retrieval:** DAGSuggester queries GraphRAG
- **Learning:** GraphRAGEngine.updateFromExecution()

---

## 3. Mapping Détaillé: CoALA ↔ Casys PML

### 3.1 Feedback Loops Comparison

| Aspect             | CoALA Decision Cycle                  | Casys PML Loop 1 (Execution)             |
| ------------------ | ------------------------------------- | ---------------------------------------- |
| **Purpose**        | Make decisions with planning          | Execute DAG tasks with observability     |
| **Components**     | Propose → Evaluate → Select → Execute | Event stream → Command queue → Execute   |
| **Memory**         | Working memory (symbolic variables)   | WorkflowState (messages, tasks, context) |
| **Cycle time**     | Per-decision                          | Per-task                                 |
| **Key difference** | ❌ No explicit evaluation step        | ✅ Event-driven, observable              |

| Aspect             | CoALA Learning Loop               | Casys PML Loop 3 (Meta-Learning)      |
| ------------------ | --------------------------------- | ------------------------------------- |
| **Purpose**        | Improve agent from trajectories   | Improve system from all workflows     |
| **Memory**         | Episodic → Semantic → Procedural  | GraphRAG (edges, PageRank)            |
| **Scope**          | Single agent's experiences        | ✅ **Cross-workflow, cross-user**     |
| **Learning**       | Reflection, fine-tuning, code gen | Graph updates, PageRank recomputation |
| **Key difference** | Individual agent learning         | ✅ **System-wide meta-learning**      |

### 3.2 Le Loop Manquant dans CoALA

**Casys PML Loop 2 (Adaptation)** n'a **pas d'équivalent direct** dans CoALA!

CoALA: Decision cycle → Learning loop (gap: pas d'adaptation runtime du plan)

Casys PML: Execution → **Adaptation (replan)** → Learning

**Pourquoi c'est critique:**

- CoALA agents re-planifient à chaque cycle (from scratch)
- Casys PML **modifie le plan existant dynamiquement** (efficient)
- AIL/HIL decisions pendant exécution (pas après)

**Exemple:**

```
CoALA: Execute 5 tasks → Complete → Reflect → Next workflow starts fresh
Casys PML: Execute task 1 → Discover XML → Replan → Add parse_xml → Continue
```

### 3.3 Memory Architecture Comparison

| Memory         | CoALA                        | Casys PML                                      | Gap/Opportunity                           |
| -------------- | ---------------------------- | ---------------------------------------------- | ----------------------------------------- |
| **Working**    | Symbolic variables, goals    | WorkflowState                                  | ⚠️ No explicit goals tracking             |
| **Episodic**   | Training pairs, trajectories | Checkpoints + Execution Traces                 | ✅ Epic 11 ajoute PER pour prioritization |
| **Semantic**   | Facts, inferences            | Capabilities+Intent (pur) + GraphRAG (hybride) | ✅ Plus riche que CoALA!                  |
| **Procedural** | LLM + code                   | DAGSuggester + TD Learning                     | ✅ Epic 11 ajoute TD Learning             |

**Clarification importante:**

- **Semantic pure** = Capabilities + Intent (faits explicites sur les outils)
- **Semantic hybride** = GraphRAG (Graph = patterns appris, RAG = retrieval sémantique)
- **Episodic amélioré** = PER (Prioritized Experience Replay) priorise les traces surprenantes
  (Epic 11)
- **Procedural amélioré** = TD Learning met à jour les poids du graphe incrémentalement (Epic 11)

**Key Insight:** Notre checkpoints sont pour **resume**, pas pour **learning retrieval**. CoALA
utilise episodic memory activement pendant planning (retrieval). **Epic 11 comble ce gap avec PER.**

---

## 4. Différences Architecturales Majeures

### 4.1 Planning vs Execution Focus

**CoALA:**

- Focus: **Planning sophistiqué** (proposal, evaluation, selection)
- Strength: Multi-step simulation, tree search
- Agents **proposent plusieurs options**, évaluent, sélectionnent

**Casys PML:**

- Focus: **Execution efficace** (DAG parallelization, speculation)
- Strength: 5x speedup, 0ms latency speculation
- System **suggère DAG optimal**, exécute directement

**Trade-off:**

- CoALA: Plus de délibération, moins d'action
- Casys PML: Action rapide, délibération implicite (GraphRAG pre-computed)

### 4.2 Individual vs System Learning

**CoALA:**

- **Individual agent** learns from ses propres experiences
- Fine-tuning LLM per-agent
- Episodic memory = agent's personal history

**Casys PML:**

- **System-wide** learning across tous les workflows
- GraphRAG = shared knowledge base
- Meta-learning: Améliore suggestions pour TOUS les users

**Implication:**

- CoALA: Personnalisation par agent
- Casys PML: Amélioration collective (plus scalable)

### 4.3 Confidence Handling

**CoALA:**

- ⚠️ **Pas explicite** dans le framework
- Mentionne "probabilistic formulation" des LLMs
- Pas de seuils adaptatifs documentés

**Casys PML:**

- ✅ **Confidence explicite** (calculateConfidence)
- Path confidence, PageRank, semantic scores
- Seuils pour speculation (>0.7)
- ⚠️ **Mais pas adaptatif** (fixed threshold)

**Opportunité:** Ajouter adaptive thresholds inspiré des mécanismes CoALA (learning-based
adaptation).

---

## 5. Opportunités d'Amélioration Inspirées de CoALA

### 5.1 ⭐ Confidence Adaptative (High Priority)

**Problème Actuel:**

```typescript
// Fixed threshold
if (prediction.confidence > 0.7) speculate();
```

**Inspiration CoALA:**

- Agents adaptent leur "decision-making procedures" basé sur success rates
- Fine-tuning on "high-scoring trajectories"

**Proposition:**

```typescript
// Adaptive threshold based on success rate
interface AdaptiveThresholdConfig {
  initialThreshold: number; // Start: 0.92 (conservative)
  targetSuccessRate: number; // Goal: 0.85
  targetWasteRate: number; // Max: 0.15
  learningRate: number; // How fast to adapt
  evaluationWindow: number; // Evaluate every N workflows
}

class AdaptiveThresholdManager {
  private threshold: number = 0.92;
  private successHistory: boolean[] = [];

  updateFromOutcome(speculated: boolean, correct: boolean): void {
    if (speculated) {
      this.successHistory.push(correct);
    }

    // Every 50 workflows, adjust threshold
    if (this.successHistory.length >= 50) {
      const successRate = this.successHistory.filter((s) => s).length / 50;

      if (successRate > 0.90) {
        // Too conservative, lower threshold (speculate more)
        this.threshold = Math.max(0.70, this.threshold - 0.02);
      } else if (successRate < 0.80) {
        // Too aggressive, raise threshold (speculate less)
        this.threshold = Math.min(0.95, this.threshold + 0.02);
      }

      this.successHistory = []; // Reset window
    }
  }

  getThreshold(): number {
    return this.threshold;
  }
}
```

**Bénéfices:**

- 🎯 Auto-tune optimal threshold per domain
- 🎯 Balance success rate vs latency automatically
- 🎯 Adapts to user patterns over time

**Effort:** +1-2h dans Story 2.5-4

---

### 5.2 ⭐ Episodic Memory pour Retrieval (Medium Priority)

**Problème Actuel:**

- Checkpoints = resume uniquement
- Pas de retrieval actif pendant planning

**Inspiration CoALA:**

- Episodic memory retrieved **during planning** for context
- "Recency, importance, relevance scores" (Generative Agents)

**Proposition:**

```typescript
// Story 2.5-4 enhancement
interface EpisodicEvent {
  workflow_id: string;
  timestamp: Date;
  context: Record<string, any>;
  tools_used: string[];
  decisions: Decision[];
  outcome: 'success' | 'failure';
  relevance_score?: number;
}

class EpisodicMemory {
  async retrieveRelevant(
    currentContext: Record<string, any>,
    k: number = 5
  ): Promise<EpisodicEvent[]> {
    // 1. Vector search on context similarity
    // 2. Score by recency (exponential decay)
    // 3. Score by importance (outcome + user feedback)
    // 4. Return top-k relevant events
  }
}

// Usage in DAGSuggester.predictNextNodes()
async predictNextNodes(state: WorkflowState): Promise<PredictedNode[]> {
  // Retrieve similar past experiences
  const relevantEvents = await this.episodicMemory.retrieveRelevant(
    state.context,
    k: 5
  );

  // Boost predictions that worked in similar contexts
  predictions.forEach(pred => {
    const contextBoost = relevantEvents.filter(e =>
      e.tools_used.includes(pred.toolId) && e.outcome === 'success'
    ).length / 5;

    pred.confidence += contextBoost * 0.1;  // Bonus up to +0.1
  });

  return predictions;
}
```

**Bénéfices:**

- 🎯 Context-aware predictions (pas juste co-occurrence)
- 🎯 Learn from similar situations
- 🎯 Better cold-start (nouveaux workflows)

**Effort:** +2-3h (nouvelle Story 2.5-5?)

---

### 5.3 🔵 Proposal-Evaluation-Selection Pattern (Low Priority)

**Inspiration CoALA:**

- Planning stage: Propose → Evaluate → Select
- Multiple proposals considérées
- Explicit evaluation step

**Proposition:**

```typescript
// Alternative to direct execution in ControlledExecutor
interface ProposedAction {
  task: Task;
  confidence: number;
  costEstimate: number;      // Time/resource cost
  expectedValue: number;     // Predicted benefit
}

async planNextActions(state: WorkflowState): Promise<Task> {
  // 1. PROPOSE multiple candidates
  const proposals = await this.dagSuggester.predictNextNodes(state);

  // 2. EVALUATE each proposal
  const evaluatedProposals = proposals.map(prop => ({
    ...prop,
    costEstimate: this.estimateCost(prop.task),
    expectedValue: this.estimateValue(prop.task, state)
  }));

  // 3. SELECT best based on value/cost ratio
  const best = evaluatedProposals
    .sort((a, b) => (b.expectedValue / b.costEstimate) - (a.expectedValue / a.costEstimate))
    [0];

  return best.task;
}
```

**Bénéfices:**

- 🎯 Cost-aware decisions
- 🎯 Explicit trade-offs (speed vs quality)
- 🎯 Better handling of expensive tools

**Trade-off:**

- ⚠️ Adds latency (evaluation step)
- ⚠️ Complexity increase

**Recommandation:** **Pas prioritaire** - Notre speculation déjà efficace. Considérer pour v2.

---

### 5.4 🔵 Working Memory Goals Tracking (Low Priority)

**Inspiration CoALA:**

- Working memory includes explicit **goals**
- Helps focus reasoning and retrieval

**Proposition:**

```typescript
interface WorkflowState {
  messages: Message[];
  tasks: TaskResult[];
  decisions: Decision[];
  context: Record<string, any>;
  goals: Goal[]; // ✨ NEW
}

interface Goal {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  priority: number;
  constraints?: string[]; // e.g., "budget < $10", "latency < 2s"
}

// Usage: Filter predictions by goal relevance
predictions.filter((pred) => this.isRelevantToGoal(pred.task, state.goals));
```

**Bénéfices:**

- 🎯 Goal-oriented planning
- 🎯 Filter irrelevant tools
- 🎯 Better explainability

**Effort:** +1-2h

**Recommandation:** **Nice-to-have** pour Epic 3+

---

## 6. Ce Qu'on Fait MIEUX que CoALA

### 6.1 ✅ Meta-Learning Explicite (GraphRAG)

**CoALA:**

- Learning loop = individual agent améliore ses propres procédures
- Pas de knowledge sharing entre agents

**Casys PML:**

- ✅ GraphRAG = **system-wide knowledge base**
- ✅ Tous les workflows contribuent
- ✅ Cross-user, cross-context learning
- ✅ Scalable (N agents → 1 graph)

**C'est notre différenciateur clé!**

### 6.2 ✅ Runtime Adaptation (Loop 2)

**CoALA:**

- Re-plan = start new decision cycle from scratch

**Casys PML:**

- ✅ **Dynamic DAG modification** pendant exécution
- ✅ AIL/HIL decisions en temps réel
- ✅ Efficient (pas de restart)

### 6.3 ✅ Granularité de Confidence

**CoALA:**

- Pas de mécanisme explicite

**Casys PML:**

- ✅ Path-level confidence (per hop)
- ✅ Task-level confidence (per prediction)
- ✅ DAG-level confidence (overall)

**Opportunité:** Rendre adaptatif (voir 5.1)

### 6.4 ✅ Performance Focus

**CoALA:**

- Focus: Reasoning sophistication
- Trade-off: Planning overhead

**Casys PML:**

- ✅ Speculation = 0ms latency
- ✅ DAG parallelization = 5x speedup
- ✅ Performance targets explicites (<200ms replan, <50ms checkpoint)

---

## 7. Recommandations & Next Steps

### 7.1 Priorité Immédiate (Epic 2.5)

**✅ À Implémenter:**

1. **Confidence Adaptative** (5.1) - Add to Story 2.5-4
   - Effort: +1-2h
   - Impact: High (auto-tuning optimal threshold)
   - Risk: Low (fallback to fixed 0.7)

**📝 À Documenter:** 2. **Clarifier les 3 loops** dans architecture.md

- Effort: 30min
- Impact: Medium (clarté conceptuelle)

### 7.2 Futur (Epic 2.5+ ou Epic 3)

**🔄 Considérer:** 3. **Episodic Memory pour Retrieval** (5.2)

- Effort: +2-3h (nouvelle story?)
- Impact: Medium-High (context-aware predictions)
- Dépend de: Volumétrie checkpoints

4. **Goals Tracking** (5.4)
   - Effort: +1-2h
   - Impact: Medium (explainability)

**❌ Pas prioritaire:** 5. **Proposal-Evaluation-Selection** (5.3)

- Raison: Speculation déjà efficace, adds complexity
- Reconsidérer si: Performance issues avec speculation

### 7.3 Architecture Documentation Updates

**Ajouter à `docs/architecture.md` Pattern 4:**

1. **Section "Comparison with CoALA"**
   - Map nos 3 loops vs leurs 2 loops
   - Highlight meta-learning advantage
   - Explain Loop 2 (adaptation) uniqueness

2. **Section "Adaptive Mechanisms"**
   - Document fixed thresholds currently
   - Note opportunity for adaptive thresholds
   - Reference this spike

3. **Memory Architecture Clarification**
   - Map WorkflowState → Working memory
   - Map Checkpoints → Episodic memory (partial)
   - Map GraphRAG → Semantic memory
   - Map Code → Procedural memory

---

## 8. Conclusion

### 8.1 Verdict

**Casys PML Epic 2.5 a une architecture plus granulaire et scalable que CoALA:**

- ✅ 3 loops vs 2 (adaptation explicite)
- ✅ Meta-learning system-wide
- ✅ Performance-focused (speculation, parallelization)

**Mais on peut emprunter de CoALA:**

- 🎯 Adaptive thresholds (high value, low effort)
- 🎯 Episodic retrieval (medium value, medium effort)
- 🎯 Goals tracking (low value, nice-to-have)

### 8.2 Impact sur Epic 2.5 Stories

**Story 2.5-4 Enhancement:**

```typescript
// Add AdaptiveThresholdManager
class SpeculativeExecutor {
  private thresholdManager: AdaptiveThresholdManager;

  async start(predictions: PredictedNode[]): Promise<void> {
    const threshold = this.thresholdManager.getThreshold(); // Dynamic!

    for (const pred of predictions) {
      if (pred.confidence > threshold) {
        await this.executeInBackground(pred);
      }
    }
  }

  reportOutcome(predicted: boolean, correct: boolean): void {
    this.thresholdManager.updateFromOutcome(predicted, correct);
  }
}
```

**Minimal impact sur stories existantes** - enhancement optionnel.

### 8.3 Key Takeaway

**Notre architecture est solide.** CoALA valide nos choix (feedback loops, memory structure) mais
suggère des raffinements (adaptive mechanisms, episodic retrieval) qu'on peut intégrer
progressivement.

**Ne pas copier CoALA, mais s'inspirer pour les adaptive mechanisms.**

---

## Related Spikes

### Implementation Spikes (Epic 2.5)

This theoretical comparison spike has been translated into two implementation spikes:

#### 1. Agent & Human-in-the-Loop DAG Feedback Loop

**See:** `docs/spikes/spike-agent-human-dag-feedback-loop.md`

Implements Stories 2.5-1 to 2.5-4:

- Event Stream + Command Queue (Loop 1)
- Checkpoints & Resume
- AIL/HIL Integration (Loop 2 - unique to Casys PML)
- Speculative Execution with GraphRAG

**Maps to CoALA:** Decision Cycle (Loop 1) + partial Learning Loop

#### 2. Episodic Memory & Adaptive Thresholds

**See:** `docs/spikes/spike-episodic-memory-adaptive-thresholds.md`

Implements Stories 2.5-5 to 2.5-6 (based on recommendations from Section 5 of this spike):

- Episodic Memory for context-aware retrieval (Section 5.2)
- Adaptive Thresholds learning (Section 5.1)
- Loop 3 Meta-Learning details

**Maps to CoALA:** Learning Loop (outer loop) with enhanced meta-learning

**Together:** These implementation spikes realize the 3-loop architecture that this comparison spike
identified as superior to CoALA's 2-loop model.

---

## 9. Évolutions Post-Spike: TD Learning & PER (Epic 11)

**Date mise à jour:** 2025-12-18

Depuis la rédaction initiale de ce spike, l'architecture a évolué avec l'ajout de mécanismes
d'apprentissage avancés dans **Epic 11 - Learning from Traces**.

### 9.1 TD Learning (Temporal Difference Learning)

**Problème initial:** Les poids du GraphRAG étaient mis à jour en batch, pas incrémentalement.

**Solution Epic 11 (Story 11.2):**

```typescript
// TD Learning: mise à jour incrémentale des poids
// V(s) ← V(s) + α * (reward + γ * V(s') - V(s))

interface TDUpdate {
  edge_id: string;
  old_weight: number;
  reward: number; // 1.0 = succès, 0.0 = échec
  learning_rate: number; // α = 0.1 par défaut
}

function updateWeight(current: number, reward: number, α = 0.1): number {
  const prediction_error = reward - current;
  return current + α * prediction_error;
}
```

**Mapping CoALA:** Équivalent au "Learning Loop" mais **incrémental** (pas batch).

### 9.2 PER (Prioritized Experience Replay)

**Problème initial:** Toutes les traces d'exécution avaient la même importance.

**Solution Epic 11 (Story 11.3):**

```typescript
// PER: priorité basée sur la "surprise" (|predicted - actual|)
interface ExecutionTrace {
  trace_id: string;
  capability_id: string;
  tool_sequence: string[];
  outcome: "success" | "failure";
  priority: number; // Calculé par PER
}

function calculatePriority(predicted: number, actual: number): number {
  // Plus la prédiction était fausse, plus la trace est prioritaire
  return Math.abs(predicted - actual);
}

// Exemples:
// - Nouveau chemin jamais vu → priority = 1.0 (max learning)
// - Échec sur chemin dominant (95% success) → priority ≈ 0.95
// - Succès sur chemin dominant → priority ≈ 0.05 (peu informatif)
```

**Mapping CoALA:** Améliore l'Episodic Memory avec **retrieval intelligent** basé sur l'importance.

### 9.3 Impact sur l'Architecture CoALA Comparison

| Aspect              | Avant Epic 11             | Après Epic 11              | Comparaison CoALA    |
| ------------------- | ------------------------- | -------------------------- | -------------------- |
| **Learning Loop**   | Batch (GraphRAG.update)   | Incrémental (TD Learning)  | ✅ Plus réactif      |
| **Episodic Memory** | Checkpoints (resume only) | + PER (prioritized traces) | ✅ Retrieval actif   |
| **Procédural**      | Code fixe                 | + TD weights adaptatifs    | ✅ Auto-amélioration |

**Conclusion:** Epic 11 comble les gaps identifiés dans ce spike (sections 5.1, 5.2) avec des
mécanismes issus du Reinforcement Learning.

**Référence:** `docs/epics/epic-11-learning-from-traces.md` (Stories 11.2, 11.3)

---

## References

- **CoALA Paper:** https://arxiv.org/html/2309.02427v3
- **Our ADR-007:** docs/adrs/ADR-007-dag-adaptive-feedback-loops.md
- **Our Research:** docs/research-technical-2025-11-13.md
- **Architecture:** docs/architecture.md Pattern 4
- **Implementation Spikes:**
  - `docs/spikes/spike-agent-human-dag-feedback-loop.md`
  - `docs/spikes/spike-episodic-memory-adaptive-thresholds.md`
- **Epic 11 (Learning):** `docs/epics/epic-11-learning-from-traces.md` (TD Learning, PER)

---

**Next Action:** Review with team, decide on adaptive threshold implementation in Story 2.5-4.

---

**Changelog:**

- 2025-11-13: Spike initial - comparaison CoALA vs Casys PML
- 2025-12-18: Ajout section 9 (TD Learning & PER), clarification mémoire sémantique (GraphRAG =
  hybride)
- 2025-12-18: Ajout "Mise en Abyme Architecturale" - PML est ET a une mémoire procédurale
