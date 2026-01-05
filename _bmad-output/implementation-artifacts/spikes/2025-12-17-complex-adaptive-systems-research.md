# Spike: Complex Adaptive Systems Research - Advanced Learning Mechanisms

**Date:** 2025-12-17 **Author:** Research Analysis **Status:** Research Complete **Related:** Epic 4
(Episodic Memory), Epic 7 (Emergent Capabilities) **Complements:**
`spike-coala-comparison-adaptive-feedback.md`, `spike-episodic-memory-adaptive-thresholds.md`

---

## Executive Summary

Ce spike documente les recherches sur les **mécanismes avancés d'apprentissage** issus de la
littérature académique (Reinforcement Learning, Graph Neural Networks, théorie des systèmes
complexes). Il complète le spike CoALA existant avec des techniques concrètes applicables à Casys
PML.

---

## 1. Papiers de Recherche Analysés

### 1.1 Sources Académiques

| Référence                                                                         | Domaine                 | Pertinence            |
| --------------------------------------------------------------------------------- | ----------------------- | --------------------- |
| [CoALA - arxiv:2309.02427](https://arxiv.org/abs/2309.02427)                      | Cognitive Architectures | ⭐⭐⭐ Déjà couvert   |
| [PER - arxiv:1511.05952](https://arxiv.org/abs/1511.05952)                        | Reinforcement Learning  | ⭐⭐⭐ Nouveau        |
| [TD Learning - Sutton 1988](https://link.springer.com/article/10.1007/BF00115009) | RL Foundations          | ⭐⭐ Nouveau          |
| [ODI - arxiv:2503.13754](https://arxiv.org/html/2503.13754v1)                     | Multi-Agent Systems     | ⭐ Nouveau            |
| [GNN for Recommendations](https://aman.ai/recsys/gnn/)                            | Graph Neural Networks   | ⭐⭐ Nouveau          |
| [ACM TAAS CAS Model](https://dl.acm.org/doi/10.1145/3686802)                      | Complex Systems         | ⭐ Contexte théorique |

### 1.2 Gap Analysis vs CoALA Spike

Le spike CoALA existant couvre :

- ✅ Architecture mémoire (Working, Episodic, Semantic, Procedural)
- ✅ Adaptive thresholds (ADR-008 implémenté)
- ✅ Episodic retrieval pour context boosting

**Ce spike ajoute :**

- 🆕 Prioritized Experience Replay (PER)
- 🆕 Temporal Difference Learning pour seuils
- 🆕 Graph Attention Networks (GAT)
- 🆕 Formalisation CAS et métriques d'émergence
- 🆕 Semantic Memory explicite

---

## 2. Prioritized Experience Replay (PER)

### 2.1 Concept

**Source:** [Schaul et al. 2015 - arxiv:1511.05952](https://arxiv.org/abs/1511.05952)

L'Experience Replay classique sample uniformément dans le buffer mémoire. **PER priorise les
expériences "surprenantes"** (gros TD error) pour accélérer l'apprentissage.

```
Uniform Replay:    P(sample_i) = 1/N  (tous égaux)
Prioritized Replay: P(sample_i) ∝ |δ_i|^α  (δ = TD error)
```

### 2.2 Application à Casys PML

**État actuel (episodic-memory-store.ts):**

```typescript
// Sampling uniforme par recency
async retrieveSimilarContexts(contextHash: string, limit: number): Promise<EpisodicEvent[]> {
  return await db.query(`
    SELECT * FROM episodic_events
    WHERE context_hash = $1
    ORDER BY timestamp DESC
    LIMIT $2
  `, [contextHash, limit]);
}
```

**Avec PER:**

```typescript
interface PrioritizedEpisodicEvent extends EpisodicEvent {
  priority: number;        // |predicted_outcome - actual_outcome|
  importance_weight: number; // For unbiased updates
}

async retrievePrioritized(contextHash: string, limit: number): Promise<PrioritizedEpisodicEvent[]> {
  // Priority = TD error = |predicted success - actual success|
  // Higher priority = more surprising outcome = more valuable for learning

  return await db.query(`
    SELECT *,
           ABS(predicted_success - actual_success) as priority,
           -- Importance sampling weight (β annealed towards 1)
           POWER(1.0 / (COUNT(*) OVER() * priority), $3) as importance_weight
    FROM episodic_events
    WHERE context_hash = $1
    ORDER BY priority DESC  -- Prioritized, not recency
    LIMIT $2
  `, [contextHash, limit, beta]);
}

// Usage: weight updates by importance_weight to correct bias
async updateFromEpisode(event: PrioritizedEpisodicEvent): Promise<void> {
  const adjustedLearningRate = this.learningRate * event.importance_weight;
  await this.graphRAG.updateEdge(event.tools, adjustedLearningRate);
}
```

### 2.3 Algorithme PER

```typescript
class PrioritizedReplayBuffer {
  private buffer: PrioritizedEpisodicEvent[] = [];
  private alpha: number = 0.6; // Prioritization exponent (0 = uniform, 1 = full priority)
  private beta: number = 0.4; // Importance sampling (annealed to 1 over training)
  private betaIncrement: number = 0.001;

  add(event: EpisodicEvent, tdError: number): void {
    const priority = Math.pow(Math.abs(tdError) + 0.01, this.alpha); // +ε to avoid 0
    this.buffer.push({ ...event, priority, importance_weight: 0 });
    this.recomputeProbabilities();
  }

  sample(batchSize: number): PrioritizedEpisodicEvent[] {
    // Sample proportional to priority
    const totalPriority = this.buffer.reduce((sum, e) => sum + e.priority, 0);
    const samples: PrioritizedEpisodicEvent[] = [];

    for (let i = 0; i < batchSize; i++) {
      let cumulative = 0;
      const target = Math.random() * totalPriority;

      for (const event of this.buffer) {
        cumulative += event.priority;
        if (cumulative >= target) {
          // Importance sampling weight
          const prob = event.priority / totalPriority;
          const weight = Math.pow(1 / (this.buffer.length * prob), this.beta);
          samples.push({ ...event, importance_weight: weight });
          break;
        }
      }
    }

    // Normalize weights
    const maxWeight = Math.max(...samples.map((s) => s.importance_weight));
    samples.forEach((s) => s.importance_weight /= maxWeight);

    // Anneal beta towards 1
    this.beta = Math.min(1.0, this.beta + this.betaIncrement);

    return samples;
  }

  updatePriority(eventId: string, newTdError: number): void {
    const event = this.buffer.find((e) => e.id === eventId);
    if (event) {
      event.priority = Math.pow(Math.abs(newTdError) + 0.01, this.alpha);
    }
  }
}
```

### 2.4 Bénéfices Attendus

| Métrique              | Sans PER | Avec PER                                      | Source           |
| --------------------- | -------- | --------------------------------------------- | ---------------- |
| Learning speed        | Baseline | **2x faster**                                 | DeepMind paper   |
| Sample efficiency     | 100%     | **50%** (même résultat avec moins de samples) | Atari benchmarks |
| Convergence stability | Variable | **Plus stable** (importance sampling)         | Theoretical      |

### 2.5 Implémentation Recommandée

**Effort:** ~4h **Fichiers à modifier:**

- `src/learning/episodic-memory-store.ts` - Ajouter PrioritizedReplayBuffer
- `src/graphrag/graph-engine.ts` - Utiliser importance weights dans updates

**Story candidate:** "Implement Prioritized Experience Replay for Episodic Memory"

---

## 3. Temporal Difference Learning pour Seuils

### 3.1 Concept

**Source:**
[Sutton 1988 - Learning to predict by temporal differences](https://link.springer.com/article/10.1007/BF00115009)

L'approche actuelle (EMA) attend le **résultat final** pour ajuster les seuils. TD Learning utilise
les **prédictions successives** pour apprendre plus vite.

```
Monte Carlo (actuel):  Update après workflow complet
TD Learning:           Update après chaque step
```

### 3.2 État Actuel vs TD Learning

**EMA actuel (ADR-008):**

```typescript
// Attend 50 workflows pour évaluer
if (this.successHistory.length >= 50) {
  const successRate = this.successHistory.filter((s) => s).length / 50;
  this.threshold = this.threshold * 0.95 + optimalThreshold * 0.05;
}
```

**Avec TD Learning:**

```typescript
class TDThresholdLearner {
  private threshold: number = 0.92;
  private alpha: number = 0.1; // Learning rate
  private gamma: number = 0.9; // Discount factor

  // Update après CHAQUE step, pas après le workflow
  updateFromStep(step: WorkflowStep): void {
    // V(s) = expected success rate from this state
    const currentValue = this.predictSuccessRate(step.state);
    const nextValue = step.isTerminal
      ? (step.success ? 1.0 : 0.0) // Actual outcome
      : this.predictSuccessRate(step.nextState); // Bootstrap

    // TD Error = reward + γ*V(s') - V(s)
    const reward = step.success ? 0.1 : -0.1;
    const tdError = reward + this.gamma * nextValue - currentValue;

    // Update threshold based on TD error
    // Positive TD error = outcome better than expected = can be more aggressive
    // Negative TD error = outcome worse than expected = be more conservative
    this.threshold -= this.alpha * tdError * 0.01;
    this.threshold = Math.max(0.70, Math.min(0.95, this.threshold));
  }

  private predictSuccessRate(state: WorkflowState): number {
    // Use GraphRAG confidence as value estimate
    return this.graphRAG.getAverageConfidence(state.pendingTools);
  }
}
```

### 3.3 TD(λ) - Eligibility Traces

Pour un apprentissage encore plus efficace, on peut utiliser TD(λ) qui combine TD(0) et Monte Carlo:

```typescript
class TDLambdaThresholdLearner {
  private eligibilityTraces: Map<string, number> = new Map();
  private lambda: number = 0.8; // Trace decay

  updateFromStep(step: WorkflowStep, tdError: number): void {
    // Update eligibility trace for current state
    const stateKey = this.getStateKey(step.state);
    const currentTrace = this.eligibilityTraces.get(stateKey) || 0;
    this.eligibilityTraces.set(stateKey, currentTrace + 1);

    // Update ALL visited states proportionally to their eligibility
    for (const [key, trace] of this.eligibilityTraces) {
      // States visited recently get larger updates
      this.updateStateValue(key, this.alpha * tdError * trace);

      // Decay trace for next step
      this.eligibilityTraces.set(key, this.gamma * this.lambda * trace);
    }
  }
}
```

### 3.4 Comparaison des Approches

| Approche                   | Update Frequency | Variance   | Bias | Latence d'adaptation |
| -------------------------- | ---------------- | ---------- | ---- | -------------------- |
| Monte Carlo (fin workflow) | 1 par workflow   | High       | None | ~50 workflows        |
| EMA (actuel)               | 1 par batch 50   | Medium     | Low  | ~50 workflows        |
| TD(0)                      | 1 par step       | Low        | Some | **~10 steps**        |
| TD(λ)                      | 1 par step       | Low-Medium | Low  | **~10 steps**        |

### 3.5 Implémentation Recommandée

**Effort:** ~3h **Fichiers à modifier:**

- `src/learning/adaptive-threshold-manager.ts` - Remplacer EMA par TD Learning

**Story candidate:** "Replace EMA with TD Learning for faster threshold adaptation"

---

## 4. SuperHyperGraph Attention Networks (SHGAT)

> **Note:** Pour une analyse approfondie des SuperHyperGraphs et structures hiérarchiques
> récursives, voir le spike dédié : `2025-12-17-superhypergraph-hierarchical-structures.md`

### 4.0 État du Papier Original : Purement Théorique

**Important:** Le papier de Fujita sur SHGAT
([engrxiv.org/preprint/view/4994](https://engrxiv.org/preprint/view/4994)) est **purement
théorique** :

> _"This investigation is purely theoretical; empirical validation via computational experiments is
> left for future study."_

**Ce que ça signifie :**

- ❌ Pas d'implémentation existante
- ❌ Pas d'expériences ou benchmarks
- ❌ Pas de code disponible
- ✅ Formalisation mathématique solide
- ✅ Extension naturelle de GAT → HyperGAT → SHGAT

**Comparaison avec HyperGAT :**

| Aspect      | HyperGAT (Ding et al., EMNLP 2020)                                 | SHGAT (Fujita, 2025)          |
| ----------- | ------------------------------------------------------------------ | ----------------------------- |
| Publication | EMNLP (peer-reviewed, top venue)                                   | Preprint (engrxiv)            |
| Code        | [GitHub](https://github.com/kaize0409/HyperGAT_TextClassification) | ❌ Aucun                      |
| Expériences | ✅ Text classification benchmarks                                  | ❌ "Left for future study"    |
| Structure   | Hypergraph plat                                                    | **SuperHyperGraph récursif**  |
| Notre cas   | ⚠️ Limité (pas récursif)                                           | ✅ Adapté (meta-capabilities) |

### 4.0.1 Opportunité Business : Première Implémentation Production

**Casys PML pourrait être la première implémentation production de SHGAT.**

Stratégie proposée :

1. Implémenter SHGAT Simplifié (Option A, section 4.8)
2. Valider avec métriques réelles sur Casys PML
3. Contacter Takaaki Fujita avec résultats
4. Potentiel : co-publication, citation, visibilité académique

**Valeur ajoutée :**

- Fujita a les maths, on aurait le code + les expériences
- Win-win : validation de son travail, visibilité pour nous
- Positionne Casys PML comme référence pour SHGAT en production

**Contact :** Fujita est actif sur
[ResearchGate](https://www.researchgate.net/profile/Takaaki-Fujita) et
[Academia.edu](https://independent.academia.edu/TakaakiFujita)

### 4.1 État Actuel : Hypergraph PageRank + Spectral Clustering

**Casys PML a déjà une stack avancée** (ADR-038, `src/graphrag/spectral-clustering.ts`) :

| Algo existant           | Fonction                                   | Location                      |
| ----------------------- | ------------------------------------------ | ----------------------------- |
| **Spectral Clustering** | Clustering sur Laplacienne normalisée      | `computeClusters()`           |
| **Hypergraph PageRank** | Importance des capabilities sur bipartite  | `computeHypergraphPageRank()` |
| **K-means++**           | Clustering sur eigenvectors                | `kMeans()`                    |
| **Cap→Cap Edges**       | ADR-042, edges dirigés dependency/contains | Intégré au PageRank           |

**Ce qui est statique :** Le PageRank calcule l'importance **globale** d'une capability. Ce score
est le **même** quelle que soit la query utilisateur.

### 4.2 Concept GAT → HyperGAT → SHGAT

**Sources:**

- [Veličković et al. 2017 - Graph Attention Networks](https://arxiv.org/abs/1710.10903)
- [Fujita 2025 - SuperHyperGraph Attention Networks](https://engrxiv.org/preprint/download/4994/8515)

```
PageRank (actuel):   importance(cap) = f(structure)           → statique
GAT (graphe simple): importance(node) = Σ attention(query, edge) * features(neighbor)
HyperGAT (flat):     importance(cap) = Σ attention(query, hyperedge) * features(tools)
SHGAT (récursif):    importance(cap) = Σ attention(query, superhyperedge) * recursive(children)
```

**SHGAT** est l'extension naturelle pour Casys PML car on a un **SuperHyperGraph récursif** (tools →
capabilities → meta-capabilities via `contains`).

### 4.3 SHGAT : Attention Récursive sur SuperHyperedges

L'idée est d'ajouter une couche d'attention **conditionnée sur la query** avec **récursion** pour
les meta-capabilities.

```typescript
/**
 * SHGAT pour Casys PML
 *
 * Trois niveaux d'attention (récursif) :
 * 1. Query → Capability : quelle capability est pertinente ?
 * 2. Capability → Tools : quels tools dans cette capability sont pertinents ?
 * 3. Capability → Children : quelles sub-capabilities (si meta-capability) ?
 */
class SuperHypergraphAttention {
  constructor(
    private spectralClustering: SpectralClusteringManager,
    private embedder: Embedder,
  ) {}

  async computeContextualScores(
    query: string,
    capabilities: ClusterableCapability[],
  ): Promise<Map<string, number>> {
    const queryEmbedding = await this.embedder.embed(query);
    const scores = new Map<string, number>();

    // Récupérer le PageRank existant (importance structurelle)
    const pageRanks = this.spectralClustering.getAllPageRanks();

    for (const cap of capabilities) {
      // 1. Attention niveau hyperedge : similarité query ↔ capability
      const capEmbedding = await this.getCapabilityEmbedding(cap);
      const hyperedgeAttention = cosineSimilarity(queryEmbedding, capEmbedding);

      // 2. Attention niveau nodes : moyenne pondérée des tools
      const toolAttentions = await Promise.all(
        cap.toolsUsed.map(async (toolId) => {
          const toolEmbed = await this.embedder.embed(toolId);
          return cosineSimilarity(queryEmbedding, toolEmbed);
        }),
      );
      const avgToolAttention = toolAttentions.reduce((a, b) => a + b, 0) / toolAttentions.length;

      // 3. Score final : combine PageRank (structure) + Attention (contexte)
      const structuralScore = pageRanks.get(cap.id) ?? 0;
      const contextualScore = hyperedgeAttention * 0.6 + avgToolAttention * 0.4;

      // Pondération : 40% structure, 60% contexte (ajustable)
      scores.set(cap.id, structuralScore * 0.4 + contextualScore * 0.6);
    }

    return scores;
  }

  private async getCapabilityEmbedding(cap: ClusterableCapability): Promise<Float32Array> {
    // Option 1: Embedding de l'intent
    // Option 2: Moyenne des embeddings des tools (plus robuste)
    // Option 3: Spectral embedding existant (gratuit, déjà calculé)
    const spectralEmbed = this.spectralClustering.getEmbeddingRow(cap.id);
    if (spectralEmbed) return new Float32Array(spectralEmbed);

    // Fallback: moyenne des tools
    const toolEmbeds = await Promise.all(
      cap.toolsUsed.map((t) => this.embedder.embed(t)),
    );
    return averageEmbeddings(toolEmbeds);
  }
}
```

### 4.4 Comparaison : Avant / Après SHGAT

```
Query: "Je veux déployer sur AWS"

AVANT (PageRank + Cluster Boost):
  Capability "deploy-aws":     PageRank=0.15, ClusterBoost=0.3 → Score: 0.45
  Capability "run-tests":      PageRank=0.18, ClusterBoost=0.0 → Score: 0.18
  → "run-tests" peut être suggéré si PageRank élevé

APRÈS (SHGAT):
  Capability "deploy-aws":     PageRank=0.15, Attention=0.85 → Score: 0.57
  Capability "run-tests":      PageRank=0.18, Attention=0.12 → Score: 0.14
  → "deploy-aws" clairement favorisé par l'attention contextuelle
```

### 4.5 Architecture GAT Classique (pour référence)

```typescript
interface GATLayer {
  // Attention mechanism
  computeAttention(
    nodeFeatures: Float32Array,      // [N, F] node feature matrix
    edgeIndex: [number, number][],   // Edge list
    context: Float32Array            // Current query context
  ): Float32Array;                   // [E] attention weights per edge
}

class GraphAttentionToolSelector {
  private layers: GATLayer[];
  private numHeads: number = 4;  // Multi-head attention

  async predictNextTools(
    currentContext: string,
    graphState: GraphRAGState
  ): Promise<ToolPrediction[]> {
    // 1. Encode context
    const contextEmbedding = await this.encoder.encode(currentContext);

    // 2. Get node features from GraphRAG
    const nodeFeatures = graphState.getToolEmbeddings();

    // 3. Multi-head attention over graph
    let aggregated = nodeFeatures;
    for (const layer of this.layers) {
      const attentionWeights = layer.computeAttention(
        aggregated,
        graphState.edges,
        contextEmbedding
      );
      aggregated = this.aggregateWithAttention(aggregated, attentionWeights);
    }

    // 4. Score each tool based on attended features
    const scores = this.scoreTools(aggregated, contextEmbedding);

    return scores.map((score, i) => ({
      toolId: graphState.tools[i].id,
      confidence: score,
      attentionExplanation: this.explainAttention(i, attentionWeights)
    }));
  }

  private explainAttention(toolIndex: number, weights: Float32Array): string {
    // Explainability: which neighbors contributed most?
    const topNeighbors = this.getTopAttendedNeighbors(toolIndex, weights, k: 3);
    return `Influenced by: ${topNeighbors.map(n => n.name).join(', ')}`;
  }
}
```

### 4.6 Attention Mechanism Detail

```typescript
// Single GAT attention head
function computeAttentionHead(
  Wi: Float32Array,           // [F, F'] - weight matrix for source
  Wj: Float32Array,           // [F, F'] - weight matrix for target
  a: Float32Array,            // [2F'] - attention vector
  nodeFeatures: Float32Array, // [N, F]
  edges: [number, number][]   // Edge list
): Float32Array {
  const attentionScores: number[] = [];

  for (const [i, j] of edges) {
    // Transform features
    const hi = matmul(nodeFeatures[i], Wi);  // [F']
    const hj = matmul(nodeFeatures[j], Wj);  // [F']

    // Attention coefficient
    const concat = [...hi, ...hj];  // [2F']
    const e_ij = leakyReLU(dot(a, concat), alpha: 0.2);

    attentionScores.push(e_ij);
  }

  // Softmax over neighbors for each node
  return softmaxPerNode(attentionScores, edges);
}

// Multi-head attention
function multiHeadAttention(
  nodeFeatures: Float32Array,
  edges: [number, number][],
  numHeads: number
): Float32Array {
  const heads: Float32Array[] = [];

  for (let h = 0; h < numHeads; h++) {
    heads.push(computeAttentionHead(W_i[h], W_j[h], a[h], nodeFeatures, edges));
  }

  // Concatenate or average heads
  return concatenateHeads(heads);
}
```

### 4.7 Avantages SHGAT vs Stack Actuelle

| Aspect         | Actuel (PageRank + Spectral) | SHGAT                     |
| -------------- | ---------------------------- | ------------------------- |
| Structure      | ✅ Hypergraphe bipartite     | ✅ Même structure         |
| Importance     | Statique (PageRank)          | **Dynamique (attention)** |
| Clustering     | ✅ Spectral (eigenvectors)   | ✅ Réutilise embeddings   |
| Contexte query | ❌ Ignoré                    | **✅ Conditionné**        |
| Explainability | Centrality + cluster         | **Attention weights**     |

### 4.8 Options d'Implémentation SHGAT

**Option A: SHGAT Simplifié (recommandé)**

- Réutilise `SpectralClusteringManager` existant
- Attention = cosine similarity sur spectral embeddings
- Effort: ~3-4 jours
- Avantage: Pas de nouvelle dépendance, réutilise `getEmbeddingRow()`

**Option B: Full SHGAT avec ML**

- Librairie: `@xenova/transformers` ou ONNX runtime
- Multi-head attention learnable
- Effort: ~2 semaines
- Avantage: Expressivité maximale, attention apprise

**Option C: Hybrid (progressif)**

- Phase 1: Option A (attention cosine)
- Phase 2: Si métriques insuffisantes → Option B
- Effort: 3-4 jours + 2 semaines si nécessaire

### 4.9 Recommandation

**Approche recommandée:** Option C (Hybrid progressif)

1. Implémenter `HypergraphAttention` simple qui combine :
   - PageRank existant (40% - importance structurelle)
   - Attention cosine sur query (60% - pertinence contextuelle)
2. Mesurer impact sur suggestions avec A/B test
3. Évaluer besoin de full SHGAT learnable

**Story candidate:** "ALM-4: Add SHGAT contextual attention to capability suggestions"

### 4.10 Scope : Strategic Layer Only + Activation Progressive

**IMPORTANT:** SHGAT concerne uniquement le **Strategic Layer** (ADR-038) :

| Layer                        | Structure       | Algo                                     | SHGAT ?             |
| ---------------------------- | --------------- | ---------------------------------------- | ------------------- |
| **Tactical** (Tools)         | Graph simple    | Semantic + Alpha + Louvain + Adamic-Adar | ❌ Déjà couvert     |
| **Strategic** (Capabilities) | SuperHypergraph | PageRank + Spectral                      | ✅ Quand assez gros |

**Seuil d'activation recommandé :**

```typescript
// Dans dag-suggester.ts, Strategic Discovery
async suggestCapabilities(query: string): Promise<ScoredCapability[]> {
  const caps = await this.capabilityStore.getAll();

  // SHGAT activé seulement quand le graphe est assez riche
  const SHGAT_ACTIVATION_THRESHOLD = 30;  // À tuner empiriquement

  if (caps.length < SHGAT_ACTIVATION_THRESHOLD) {
    // PageRank + Spectral Clustering suffit
    // Peu de capabilities = peu de choix = SHGAT marginal
    return this.classicStrategicDiscovery(query, caps);
  }

  // SHGAT pour attention contextuelle récursive
  const shgat = new SuperHypergraphAttention(this.spectralClustering, this.embedder);
  return this.shgatStrategicDiscovery(query, caps, shgat);
}
```

**Pourquoi ce seuil :**

- < 30 capabilities : PageRank + Spectral donne des résultats suffisants
- 30-50 : SHGAT commence à discriminer entre capabilities similaires
- 50+ : SHGAT devient vraiment utile, surtout avec meta-capabilities
- Le seuil peut être configuré via `adaptive-config.yaml`

**Intégration avec code existant (quand activé) :**

```typescript
// Strategic Discovery (ADR-038 §3.2)
const discoveryScore = ToolsOverlap * (1 + StructuralBoost);

// Devient avec SHGAT :
const shgatScore = await shgat.computeContextualScores(query, caps);
const discoveryScore = ToolsOverlap * (1 + StructuralBoost) * (1 + shgatScore);
```

### 4.11 Note : Support des Hypergraphes Hiérarchiques (Meta-Capabilities)

SHGAT fonctionne **nativement sur des SuperHyperGraphes hiérarchiques**. Pour les meta-capabilities
(capabilities composées d'autres capabilities via l'edge type `contains` de ADR-042), l'attention
est récursive :

```
FLAT (actuel):
  Query → Capability → Tools
  (2 niveaux d'attention)

HIERARCHICAL (avec meta-caps):
  Query → Meta-Cap → Capabilities → Tools
  (3+ niveaux d'attention récursive)
```

**Implémentation récursive :**

```typescript
async computeNestedScore(query: string, cap: NestedCapability): Promise<number> {
  const queryEmbed = await this.embedder.embed(query);

  if (cap.childCapabilities.length === 0) {
    // Leaf capability → attention sur tools (comme avant)
    return this.computeToolsAttention(queryEmbed, cap.toolsUsed);
  }

  // Meta-capability → attention récursive sur enfants
  const childScores = await Promise.all(
    cap.childCapabilities.map(async childId => {
      const child = await this.getCapability(childId);
      const childScore = await this.computeNestedScore(query, child);  // Récursif
      const childEmbed = await this.getCapabilityEmbedding(child);
      const attention = cosineSimilarity(queryEmbed, childEmbed);
      return childScore * attention;  // Pondéré par attention
    })
  );

  return childScores.reduce((a, b) => a + b, 0) / childScores.length;
}
```

**Avantage :** L'attention peut "descendre" dans la hiérarchie et focus sur les sous-capabilities
pertinentes même au sein d'une meta-capability large.

**Prérequis :** La structure `contains` (ADR-042) doit être utilisée pour créer des
meta-capabilities. Le PageRank actuel gère déjà ces edges, SHGAT les exploite pour l'attention
contextuelle récursive.

**Voir aussi:** `2025-12-17-superhypergraph-hierarchical-structures.md` pour la théorie DASH et
SHGAT complète.

---

## 5. Semantic Memory Layer

### 5.1 Concept (Extension CoALA)

Le spike CoALA a identifié que notre **Semantic Memory est partielle** (GraphRAG edges =
co-occurrence, pas connaissances). Une vraie Semantic Memory contient des **faits inférés**.

### 5.2 Types de Faits à Capturer

```typescript
interface SemanticFact {
  id: string;
  type: "constraint" | "preference" | "causal" | "incompatibility";
  subject: string; // Tool or capability
  predicate: string; // Relationship
  object: string; // Target
  confidence: number; // Learned confidence
  evidence: string[]; // Workflow IDs that support this fact
}

// Exemples de faits sémantiques
const facts: SemanticFact[] = [
  {
    type: "constraint",
    subject: "github_create_pr",
    predicate: "requires_before",
    object: "github_push",
    confidence: 0.95,
    evidence: ["wf-123", "wf-456"],
  },
  {
    type: "incompatibility",
    subject: "file_write",
    predicate: "fails_with",
    object: "readonly_mode",
    confidence: 0.88,
    evidence: ["wf-789"],
  },
  {
    type: "causal",
    subject: "large_file_param", // param > 10MB
    predicate: "causes",
    object: "timeout_error",
    confidence: 0.72,
    evidence: ["wf-101", "wf-102"],
  },
  {
    type: "preference",
    subject: "user_alice",
    predicate: "prefers",
    object: "verbose_output",
    confidence: 0.65,
    evidence: ["wf-201", "wf-202", "wf-203"],
  },
];
```

### 5.3 Inférence de Faits

```typescript
class SemanticMemoryInferrer {
  // Après chaque workflow, extraire des faits potentiels
  async inferFromWorkflow(workflow: CompletedWorkflow): Promise<SemanticFact[]> {
    const facts: SemanticFact[] = [];

    // 1. Inférer contraintes d'ordre
    for (let i = 0; i < workflow.tasks.length - 1; i++) {
      const current = workflow.tasks[i];
      const next = workflow.tasks[i + 1];

      if (next.dependsOn?.includes(current.id)) {
        facts.push({
          type: 'constraint',
          subject: next.toolId,
          predicate: 'requires_before',
          object: current.toolId,
          confidence: 0.5,  // Initial, will be reinforced
          evidence: [workflow.id]
        });
      }
    }

    // 2. Inférer incompatibilités (échecs)
    for (const task of workflow.tasks) {
      if (task.status === 'failed') {
        const context = this.extractFailureContext(task);
        facts.push({
          type: 'incompatibility',
          subject: task.toolId,
          predicate: 'fails_with',
          object: context,
          confidence: 0.5,
          evidence: [workflow.id]
        });
      }
    }

    // 3. Inférer causalités (corrélations répétées)
    // ... pattern matching sur paramètres et outcomes

    return facts;
  }

  // Consolider avec faits existants
  async consolidate(newFacts: SemanticFact[]): Promise<void> {
    for (const fact of newFacts) {
      const existing = await this.findSimilarFact(fact);

      if (existing) {
        // Renforcer confiance
        existing.confidence = existing.confidence * 0.9 + 0.1;  // EMA
        existing.evidence.push(...fact.evidence);
        await this.update(existing);
      } else {
        await this.insert(fact);
      }
    }

    // Pruning: supprimer faits faible confiance sans évidence récente
    await this.pruneWeakFacts(minConfidence: 0.3, maxAge: 30);
  }
}
```

### 5.4 Utilisation dans DAGSuggester

```typescript
class EnhancedDAGSuggester {
  async suggestNextTools(state: WorkflowState): Promise<ToolSuggestion[]> {
    // 1. GraphRAG suggestions (co-occurrence)
    const graphSuggestions = await this.graphRAG.suggest(state);

    // 2. Filter par contraintes sémantiques
    const constraints = await this.semanticMemory.getConstraints(state.completedTools);
    const filtered = graphSuggestions.filter((s) =>
      !constraints.some((c) => c.subject === s.toolId && c.predicate === "incompatible_with")
    );

    // 3. Boost par préférences utilisateur
    const preferences = await this.semanticMemory.getPreferences(state.userId);
    filtered.forEach((s) => {
      const pref = preferences.find((p) => p.object === s.toolId);
      if (pref) s.confidence *= 1 + pref.confidence * 0.2;
    });

    // 4. Warn sur causalités négatives
    const causalWarnings = await this.semanticMemory.getCausalWarnings(state);

    return filtered.map((s) => ({
      ...s,
      warnings: causalWarnings.filter((w) => w.subject === s.toolId),
    }));
  }
}
```

### 5.5 Schema PGlite

```sql
CREATE TABLE semantic_facts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,  -- 'constraint' | 'preference' | 'causal' | 'incompatibility'
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_semantic_subject ON semantic_facts(subject);
CREATE INDEX idx_semantic_type ON semantic_facts(type);
CREATE INDEX idx_semantic_confidence ON semantic_facts(confidence DESC);
```

### 5.6 Recommandation

**Effort:** ~1 semaine **Impact:** Medium-High (meilleure généralisation, moins d'erreurs)

**Story candidate:** "Implement Semantic Memory layer for fact inference"

---

## 6. SYMBIOSIS / ODI Framework Insights

### 6.1 Concepts Clés

**Source:**
[arxiv:2503.13754 - Orchestrated Distributed Intelligence](https://arxiv.org/html/2503.13754v1)

Le framework ODI propose de voir les systèmes multi-agents comme des **systèmes socio-techniques**
avec:

- Feedback loops explicites
- Comportements émergents mesurables
- Analyse holistique (pas juste performance individuelle)

### 6.2 Métriques d'Émergence

```typescript
interface EmergenceMetrics {
  // Graph complexity over time
  graphEntropy: number; // Shannon entropy of edge distribution
  clusterStability: number; // How stable are Louvain communities?

  // Capability growth
  capabilityCount: number; // Total emerged capabilities
  capabilityDiversity: number; // Unique patterns vs total

  // Self-organization
  parallelizationRate: number; // % of tasks run in parallel
  speculationAccuracy: number; // Hit rate of predictions

  // Adaptation speed
  thresholdConvergenceTime: number; // Workflows to reach stable threshold
  learningVelocity: number; // Rate of graph updates
}

class EmergenceObserver {
  private history: EmergenceMetrics[] = [];

  async captureSnapshot(): Promise<EmergenceMetrics> {
    return {
      graphEntropy: await this.computeGraphEntropy(),
      clusterStability: await this.computeClusterStability(),
      capabilityCount: await this.countCapabilities(),
      capabilityDiversity: await this.computeCapabilityDiversity(),
      parallelizationRate: await this.getParallelizationRate(),
      speculationAccuracy: await this.getSpeculationAccuracy(),
      thresholdConvergenceTime: await this.getThresholdConvergenceTime(),
      learningVelocity: await this.getLearningVelocity(),
    };
  }

  async detectPhaseTransition(): Promise<boolean> {
    // Detect if system is undergoing qualitative change
    if (this.history.length < 10) return false;

    const recent = this.history.slice(-5);
    const older = this.history.slice(-10, -5);

    const entropyChange = Math.abs(
      average(recent.map((m) => m.graphEntropy)) -
        average(older.map((m) => m.graphEntropy)),
    );

    // Significant entropy change = phase transition
    return entropyChange > 0.2;
  }
}
```

### 6.3 Dashboard Émergence

Ajouter au monitoring existant:

```typescript
// MCP tool: get_emergence_metrics
{
  name: 'get_emergence_metrics',
  description: 'Get system emergence and self-organization metrics',
  inputSchema: {
    type: 'object',
    properties: {
      timeRange: { type: 'string', enum: ['1h', '24h', '7d', '30d'] }
    }
  },
  handler: async ({ timeRange }) => {
    const metrics = await emergenceObserver.getMetricsForRange(timeRange);
    const phaseTransition = await emergenceObserver.detectPhaseTransition();

    return {
      current: metrics,
      trend: computeTrend(metrics),
      phaseTransitionDetected: phaseTransition,
      recommendations: generateRecommendations(metrics)
    };
  }
}
```

### 6.4 Recommandation

**Effort:** ~2-3h (métriques de base), ~1 jour (dashboard complet) **Impact:** Low-Medium
(observabilité, pas fonctionnel)

**Story candidate:** "Add emergence metrics to system observability"

---

## 7. Roadmap d'Implémentation

### 7.1 Priorités

| Priorité | Feature                           | Source                    | Effort     | Impact                               | Dépendances                        |
| -------- | --------------------------------- | ------------------------- | ---------- | ------------------------------------ | ---------------------------------- |
| 🔴 P1    | **Prioritized Experience Replay** | PER paper                 | 4h         | 2x learning speed                    | Episodic memory existante          |
| 🔴 P1    | **TD Learning pour seuils**       | Sutton 1988               | 3h         | Adaptation 5x plus rapide            | ADR-008 existant                   |
| 🟡 P2    | **Semantic Memory layer**         | CoALA extended            | 1 semaine  | Meilleure généralisation             | GraphRAG                           |
| 🟡 P2    | **SHGAT Simplifié**               | SuperHyperGraph Attention | 3-4 jours  | Suggestions contextuelles récursives | SpectralClusteringManager existant |
| 🟢 P3    | **Emergence metrics**             | ODI/SYMBIOSIS             | 2-3h       | Observabilité                        | Monitoring existant                |
| 🟢 P3    | **Full SHGAT learnable**          | Fujita SHGAT              | 2 semaines | Attention apprise                    | ML runtime + ALM-4                 |

### 7.2 Stories Candidates

```yaml
# Epic: Advanced Learning Mechanisms

stories:
  - id: ALM-1
    title: "Implement Prioritized Experience Replay"
    description: |
      Replace uniform sampling in episodic memory with prioritized replay
      based on TD error. Include importance sampling correction.
    acceptance_criteria:
      - PrioritizedReplayBuffer class implemented
      - Priority = |predicted - actual| outcome
      - Importance sampling weights computed
      - Beta annealing from 0.4 to 1.0
      - Tests show 2x faster convergence on synthetic data
    effort: 4h
    priority: P1

  - id: ALM-2
    title: "Replace EMA with TD Learning for thresholds"
    description: |
      Modify AdaptiveThresholdManager to use TD(0) or TD(λ) instead of EMA
      for faster threshold adaptation.
    acceptance_criteria:
      - TD error computed per workflow step
      - Threshold updated incrementally
      - Convergence in ~10 steps vs ~50 workflows
      - Optional: eligibility traces for TD(λ)
    effort: 3h
    priority: P1

  - id: ALM-3
    title: "Add Semantic Memory layer"
    description: |
      Implement fact inference from workflows and integrate with DAGSuggester
      for constraint-aware suggestions.
    acceptance_criteria:
      - SemanticFact schema in PGlite
      - Inferrer extracts constraints, preferences, causal relations
      - Consolidation with confidence reinforcement
      - DAGSuggester filters by constraints
      - Pruning of weak facts
    effort: 1 week
    priority: P2

  - id: ALM-4
    title: "Implement SHGAT Simplifié for Capability Suggestions"
    description: |
      Add context-aware attention to capability suggestions on top of existing
      Hypergraph PageRank + Spectral Clustering stack (ADR-038).
      Leverages existing SpectralClusteringManager and getEmbeddingRow().
    acceptance_criteria:
      - HypergraphAttention class created
      - Reuses spectral embeddings from SpectralClusteringManager
      - 2-level attention: hyperedge (capability) + node (tools)
      - Combines PageRank (40%) + contextual attention (60%)
      - Integrated with Strategic Discovery (dag-suggester.ts)
      - A/B test vs pure PageRank + ClusterBoost
    effort: 3-4 days
    priority: P2

  - id: ALM-4b
    title: "Full SHGAT with Learnable Attention"
    description: |
      If ALM-4 shows promise but needs more expressivity, implement
      full SHGAT with multi-head learnable attention for recursive structures.
    acceptance_criteria:
      - Multi-head attention mechanism
      - Learnable weight matrices
      - Training loop on workflow outcomes
      - ONNX or @xenova/transformers integration
    effort: 2 weeks
    priority: P3
    depends_on: ALM-4

  - id: ALM-5
    title: "Add emergence metrics to observability"
    description: |
      Implement EmergenceObserver and expose metrics via MCP tool.
    acceptance_criteria:
      - Graph entropy computed
      - Cluster stability tracked
      - Capability diversity measured
      - Phase transition detection
      - get_emergence_metrics MCP tool
    effort: 3h
    priority: P3
```

### 7.3 Dépendances

```
                    ┌─────────────────┐
                    │  ALM-1 (PER)    │
                    └────────┬────────┘
                             │
                             ▼
┌─────────────────┐    ┌─────────────────┐
│  ALM-2 (TD)     │────│  Episodic       │
└─────────────────┘    │  Memory Store   │
                       └────────┬────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         │                      │                      │
         ▼                      ▼                      ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  ALM-3          │    │  ALM-4          │    │  ALM-5          │
│  (Semantic)     │    │  (Attention)    │    │  (Emergence)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

---

## 8. Conclusion

### 8.1 Résumé

Casys PML est un **Système Complexe Adaptatif** avec 5 boucles de feedback et des propriétés
émergentes. Cette reconnaissance ouvre des opportunités d'amélioration via des techniques éprouvées:

| Technique         | Impact Principal          | Effort    |
| ----------------- | ------------------------- | --------- |
| PER               | Learning 2x plus rapide   | 4h        |
| TD Learning       | Adaptation 5x plus rapide | 3h        |
| Semantic Memory   | Meilleure généralisation  | 1 semaine |
| Graph Attention   | Prédictions contextuelles | 1 semaine |
| Emergence Metrics | Observabilité             | 3h        |

### 8.2 Positionnement Unique

Casys PML combine de manière unique:

- **CAS theory** + **MCP protocol** + **GraphRAG** + **Adaptive learning** + **Emergent
  capabilities**

Aucun concurrent identifié ne fait cette combinaison (Décembre 2025).

### 8.3 Next Steps

1. **Immédiat (Sprint actuel):** ALM-1 (PER) + ALM-2 (TD Learning)
2. **Court terme (2-4 semaines):** ALM-3 (Semantic) + ALM-4 (Attention)
3. **Continu:** ALM-5 (Emergence metrics)

---

## 9. Références

### Papiers Académiques

- [CoALA - arxiv:2309.02427](https://arxiv.org/abs/2309.02427) - Cognitive Architectures for
  Language Agents
- [PER - arxiv:1511.05952](https://arxiv.org/abs/1511.05952) - Prioritized Experience Replay
- [TD Learning - Sutton 1988](https://link.springer.com/article/10.1007/BF00115009) - Learning to
  predict by temporal differences
- [GAT - arxiv:1710.10903](https://arxiv.org/abs/1710.10903) - Graph Attention Networks
- [ODI - arxiv:2503.13754](https://arxiv.org/html/2503.13754v1) - Orchestrated Distributed
  Intelligence
- [ACM TAAS CAS](https://dl.acm.org/doi/10.1145/3686802) - Hierarchical Model for Complex Adaptive
  System

### Documentation Interne

- `docs/spikes/spike-coala-comparison-adaptive-feedback.md` - Comparison CoALA vs Casys PML
- `docs/spikes/spike-episodic-memory-adaptive-thresholds.md` - ADR-008 implementation details
- `docs/adrs/ADR-008-episodic-memory-adaptive-thresholds.md` - Architecture decision
- `docs/architecture/novel-pattern-designs.md` - System patterns

### Ressources Techniques

- [PyTorch Geometric](https://pytorch-geometric.readthedocs.io/) - GNN library
- [GNN for Recommendations](https://aman.ai/recsys/gnn/) - Tutorial
- [Understanding PER](https://danieltakeshi.github.io/2019/07/14/per/) - Deep dive

---

**Author:** Research Analysis **Review Status:** Ready for team review **Action Required:**
Prioritize stories ALM-1 through ALM-5
