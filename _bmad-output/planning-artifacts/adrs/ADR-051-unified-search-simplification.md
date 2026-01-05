# ADR-051: Simplification de la Recherche Unifiée

**Status:** Accepted **Date:** 2025-12-22 (Updated 2025-12-25 for v1 refactor) **Supersedes:**

- ADR-015 (Dynamic Alpha)
- ADR-022 (Hybrid Search Alpha)
- ADR-038 (Scoring Algorithms Reference) - sections Search et alpha
- ADR-048 (Local Adaptive Alpha) **Related:**
- spike `2025-12-21-capability-pathfinding-dijkstra.md`
- tech-spec `docs/tech-specs/shgat-v1-refactor/` (multi-level architecture)

## Context

### Problème identifié

La formule actuelle de Hybrid Search (ADR-022) est:

```
score = (semantic × α + graph × (1-α)) × reliability
```

Où:

- `semantic` = similarité cosinus avec la query (BGE-M3)
- `graph` = Adamic-Adar relatedness avec les `contextNodes`
- `α` = alpha adaptatif (global ou local via ADR-048)
- `reliability` = facteur basé sur `successRate`

### Le problème fondamental

**En mode Search (Active), il n'y a PAS de contexte.**

L'utilisateur tape une query ("read file"), il n'a pas encore utilisé d'outils. Donc:

```typescript
// Dans computeGraphRelatedness (adamic-adar.ts)
if (contextNodes.length === 0) return 0; // ← Toujours 0!
```

**Conséquence:** `graphScore = 0` pour toutes les queries de recherche.

La formule devient:

```
score = (semantic × α + 0 × (1-α)) × reliability
score = semantic × α × reliability
```

L'alpha ne fait que **réduire** le score sémantique sans aucun bénéfice!

### Analyse des benchmarks

| Configuration         | Hit@1 | Observation                                         |
| --------------------- | ----- | --------------------------------------------------- |
| α=1.0 (pure semantic) | 61.3% | Baseline                                            |
| α=0.5 (balanced)      | 64.5% | Légère amélioration (queries avec context)          |
| α=0.3 (graph heavy)   | 67.7% | Meilleur (mais seulement pour queries avec context) |
| α=local (ADR-048)     | 19.4% | **Pire!** Alphas variables perturbent le ranking    |

Le benchmark mélangeait **Search** (sans context) et **Prediction** (avec context).

Pour les queries **sans context**, un alpha < 1.0 ne fait que réduire les scores uniformément
(ranking préservé) ou de façon variable (ranking perturbé avec local alpha).

### Architecture cible (SHGAT + DR-DSP)

Le spike `2025-12-21-capability-pathfinding-dijkstra.md` définit l'architecture finale:

```
┌─────────────────────────────────────────────────────────────┐
│  1. SEARCH (Active) - unifiedSearch(intent)                 │
│     score = semantic × reliability                          │
│     Rapide, simple, pour recherche utilisateur              │
│                                                             │
│  2. PREDICTION (Forward) - predictNextNode(intent, context) │
│     a) SHGAT(intent) → TARGET capability                    │
│     b) DR-DSP(currentTool, TARGET) → next step              │
│                                                             │
│  3. SUGGESTION (Backward) - pml_execute(intent)             │
│     a) SHGAT(intent) → TARGET capability                    │
│     b) DR-DSP.backward(TARGET) → DAG des dépendances        │
└─────────────────────────────────────────────────────────────┘
```

### Clarification: SHGAT est context-free (2025-12-22)

**Décision:** SHGAT n'utilise **pas** le context pour le scoring.

Le papier original SHGAT (Fujita) ne traite pas du contexte externe. Les benchmarks de précision ont
confirmé que le contextBoost (×0.3) n'apportait **aucune amélioration** (0% de différence en
accuracy).

### Clarification: Tools vs Capabilities - V1 K-Head Architecture (2025-12-22, Updated 2025-12-26)

**IMPORTANT:** Production uses SHGAT V1 with K adaptive heads (4-16 based on graph size):

| Component       | Description                                                 |
| --------------- | ----------------------------------------------------------- |
| Message Passing | V → E^0 → E^1 → ... → E^L_max (upward) then back (downward) |
| K-Head Scoring  | `score = sigmoid(mean([Q[h]·K[h]/√dim for h in 0..K]))`     |
| Training        | K-head backprop through W_q, W_k + levelParams + W_intent   |

**V1 won benchmark (MRR=0.214 vs V2=0.198)** - pure structural similarity outperforms TraceFeatures.

**Interfaces séparées:**

- `ToolGraphFeatures` : pour tools (`pageRank`, `louvainCommunity`, `adamicAdar`, `cooccurrence`,
  `recency`)
- `HypergraphFeatures` : pour capabilities (`spectralCluster`, `hypergraphPageRank`,
  `heatDiffusion`, etc.)

**Pour les tools (gateway-server.ts:populateToolFeaturesForSHGAT):**

```typescript
// ToolGraphFeatures interface
const features: ToolGraphFeatures = {
  // HEAD 2: Structure (simple graph algorithms)
  pageRank: graphEngine.getPageRank(toolId),
  louvainCommunity: parseInt(graphEngine.getCommunity(toolId) ?? "0"),
  adamicAdar: graphEngine.computeAdamicAdar(toolId, 1)[0]?.score / 2 ?? 0,

  // HEAD 3: Temporal (from execution_trace table)
  cooccurrence: traceCount / maxTraceCount, // Normalized frequency
  recency: exp(-timeSinceLastUse / oneDayMs), // Exponential decay
};
```

**SHGAT V1 scoring (context-free, K adaptive heads):**

```typescript
// K-head attention scoring (K = 4-16 based on graph size)
const { E } = forwardMultiLevel();  // Message passing through hierarchy
const intentProjected = W_intent @ intentEmbedding;

for (let h = 0; h < numHeads; h++) {
  const Q = W_q[h] @ intentProjected;
  const K = W_k[h] @ E.get(level)[capIdx];  // Propagated embedding
  headScores[h] = dot(Q, K) / sqrt(headDim);
}

score = sigmoid(mean(headScores));
// W_q, W_k, W_intent trained via backprop
```

Le **context** (position actuelle) est géré par **DR-DSP**, pas SHGAT :

- `DR-DSP.findShortestHyperpath(currentTool, targetTool)` utilise le context comme point de départ
- SHGAT ne voit que l'intent et les features du graphe

**Flow complet (Search + Prediction + Suggestion):**

```
┌─────────────────────────────────────────────────────────────┐
│  1. SEARCH (Active) - unifiedSearch(intent)                 │
│     score = semantic × reliability                          │
│     Rapide, simple, pour recherche utilisateur              │
│                                                             │
│  2. PREDICTION (Forward) - predictNextNode(intent, context) │
│     a) SHGAT.scoreAllCapabilities(intent) → TARGET          │
│     b) DR-DSP.findShortestHyperpath(currentTool, TARGET)    │
│     c) Retourne next tool sur le chemin                     │
│                                                             │
│  3. SUGGESTION (Backward) - pml_execute(intent)             │
│     a) SHGAT.scoreAllCapabilities(intent) → TARGET          │
│     b) DR-DSP.backward(TARGET) → DAG des dépendances        │
│     c) Retourne DAG complet (pas de re-scoring, DR-DSP      │
│        utilise déjà les poids basés sur successRate)        │
└─────────────────────────────────────────────────────────────┘
```

**Note:** SHGAT remplace `unifiedSearch` pour Prediction et Suggestion car il intègre les features
du graphe (pageRank, cooccurrence, recency) en plus du semantic. `unifiedSearch` reste pour le mode
Search (plus rapide, suffisant).

## Decision

### 1. Simplifier la formule de Search

**Avant:**

```typescript
score = (semantic × α + graph × (1-α)) × reliability
```

**Après:**

```typescript
score = semantic × reliability
```

Pas d'alpha, pas de graph score (inutile sans context).

### 2. Réserver le graph pour Prediction

Le graph score (Adamic-Adar, co-occurrence) n'a de sens que quand il y a un **contexte** (outils
déjà utilisés). C'est le cas en mode **Prediction**, pas en mode **Search**.

### 3. SHGAT remplace les heuristiques alpha

Les algorithmes d'alpha (ADR-048) étaient des **heuristiques manuelles**:

- EmbeddingsHybrides: "Si coherence haute → alpha bas"
- Heat Diffusion: "Si heat haute → alpha bas"
- Bayesian: "Si peu d'observations → alpha haut"

SHGAT apprend ces patterns automatiquement via attention sur les traces épisodiques. Plus besoin de
règles manuelles.

### 4. Statut des ADRs précédents

| ADR                               | Nouveau statut                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| **ADR-015** (Dynamic Alpha)       | Superseded - remplacé par SHGAT                                                      |
| **ADR-022** (Hybrid Search Alpha) | Superseded - formule simplifiée                                                      |
| **ADR-038** (Scoring Algorithms)  | Superseded - sections Search/alpha obsolètes, reste référence pour Prediction legacy |
| **ADR-048** (Local Alpha)         | Superseded - remplacé par SHGAT                                                      |

## Implementation

### unifiedSearch simplifié

```typescript
/**
 * Unified Search - Simplified (ADR-050)
 *
 * For Active Search (query only, no context), the formula is simply:
 *   score = semantic × reliability
 *
 * Graph scores are not used because there's no context to relate to.
 * SHGAT will handle Prediction mode separately.
 */
export async function unifiedSearch(
  vectorSearch: VectorSearch,
  nodes: Map<string, SearchableNode>,
  query: string,
  options: { limit?: number; minScore?: number } = {},
): Promise<UnifiedSearchResult[]> {
  const { limit = 10, minScore = 0.5 } = options;

  // 1. Semantic search
  const candidates = await vectorSearch.search(query, limit * 2, minScore);

  // 2. Apply reliability factor
  const results = candidates.map(({ nodeId, score: semanticScore }) => {
    const node = nodes.get(nodeId);
    if (!node) return null;

    const reliabilityFactor = calculateReliabilityFactor(node.successRate);
    const finalScore = Math.min(semanticScore * reliabilityFactor, 0.95);

    return {
      nodeId,
      nodeType: node.type,
      name: node.name,
      description: node.description,
      semanticScore,
      reliabilityFactor,
      finalScore,
      serverId: node.serverId,
    };
  }).filter(Boolean);

  // 3. Sort and limit
  results.sort((a, b) => b.finalScore - a.finalScore);
  return results.slice(0, limit);
}
```

### Reliability factor (inchangé)

```typescript
function calculateReliabilityFactor(successRate: number): number {
  if (successRate < 0.5) return 0.1; // Pénalité
  if (successRate > 0.9) return 1.2; // Boost
  return 1.0; // Neutre
}
```

## Consequences

### Positives

1. **Simplicité** - Formule claire et facile à comprendre
2. **Performance** - Pas de calcul de graph score inutile
3. **Prédictibilité** - Le ranking reflète directement la similarité sémantique
4. **Préparation SHGAT** - Architecture clean pour intégrer SHGAT en Prediction

### Negatives

1. **Perte du graph en Search** - Mais il n'apportait rien sans context
2. **ADR-048 devient obsolète** - Travail "perdu", mais c'était transitoire

### Neutres

1. **Reliability reste** - C'est toujours utile de pénaliser les outils peu fiables

## Migration

1. Mettre à jour `src/graphrag/algorithms/unified-search.ts` avec la formule simplifiée
2. Supprimer les paramètres `alpha`, `localAlphaCalculator`, `contextNodes` de
   `UnifiedSearchOptions`
3. Mettre à jour les tests et benchmarks
4. Marquer ADR-022 et ADR-048 comme obsolètes pour Search

## Future Work

1. **Implémenter SHGAT** pour Prediction (intent + context → ranked candidates)
2. **Implémenter DR-DSP** pour DAG Suggestion (shortest hyperpath)
3. **Retirer le code alpha** une fois SHGAT stable

## Implementation Status (2025-12-22)

### SHGAT Live Learning (Updated 2025-12-24)

SHGAT apprend maintenant **en temps réel** après chaque exécution `pml_execute`:

```
Mode Direct réussi
  → saveCapability() (stocke en DB)
  → updateDRDSP() (met à jour le graphe hyperedges)
  → registerSHGATNodes() (enregistre capability + tools)
  → runPERBatchTraining() (PER-weighted path-level training)
    → Sample traces par priorité (P(i) ∝ priority^α)
    → Multi-example per trace (1 example par node du path)
    → trainBatch() avec path features
    → Update priorities (TD error recalculé)
```

**Story 11.6:** Remplace `updateSHGAT()` (single-example tool-level) par PER batch training
(path-level). Un verrou empêche les trainings concurrents si plusieurs exécutions en parallèle.

**Méthodes SHGAT V1 - Scoring (K-head attention):**

| Méthode                           | Input             | Output                                    | Usage                    |
| --------------------------------- | ----------------- | ----------------------------------------- | ------------------------ |
| `scoreAllCapabilities(intentEmb)` | intent embedding  | ranked capabilities with `hierarchyLevel` | Production (pml_execute) |
| `scoreAllTools(intentEmb)`        | intent embedding  | ranked tools                              | Production (pml_execute) |
| `trainBatchV1KHead(examples)`     | TrainingExample[] | { loss, accuracy, tdErrors, gradNorm }    | Batch training           |
| `trainSHGATOnExecution(...)`      | single execution  | { loss, accuracy, gradNorm }              | Online learning          |

**Multi-Level Scoring API (v1 Refactor - 2025-12-25):**

```typescript
// MultiLevelScorer - hierarchy-aware scoring
const scorer = new MultiLevelScorer(deps);

// Score all capabilities across all hierarchy levels
const all = scorer.scoreAllCapabilities(intent);
// Returns AttentionResult[] with hierarchyLevel field

// Score only leaf capabilities (level 0 - most specific)
const leaves = scorer.scoreLeafCapabilities(intent);

// Score meta-capabilities at specific level
const metas = scorer.scoreMetaCapabilities(intent, 1);

// Get top-K per level (for hierarchical exploration)
const byLevel = scorer.getTopByLevel(intent, 5);
// Returns Map<number, AttentionResult[]>
```

**K-head architecture (K = 4-16 adaptive heads with multi-level message passing):**

```typescript
// Forward pass propagates through hierarchy levels
const { E } = forwardMultiLevel();  // E: Map<level, embeddings[][]>

// Score using K-head attention on PROPAGATED embeddings
scoreAllCapabilities(intentEmbedding: number[]): AttentionResult[] {
  const intentProjected = W_intent @ intentEmbedding;

  for (const level of hierarchyLevels.keys()) {
    for (const [idx, capId] of capsAtLevel) {
      const capEmb = E.get(level)[idx];  // Propagated embedding

      // K-head scoring
      const headScores: number[] = [];
      for (let h = 0; h < numHeads; h++) {
        const Q = W_q[h] @ intentProjected;
        const K = W_k[h] @ capEmb;
        headScores.push(dot(Q, K) / sqrt(headDim));
      }

      const score = sigmoid(mean(headScores));
      results.push({ capabilityId, score, hierarchyLevel: level, ... });
    }
  }
}
```

**Benchmark (V1 K-head wins):**

```
v1 (message passing + K heads): MRR=0.214, Hit@3=23.3%
v2 (direct + K heads + MLP):    MRR=0.198, Hit@3=20.9%
v3 (HYBRID):                    MRR=0.170, Hit@3=7.0%
```

**predictPathSuccess pour TD Learning (Story 11.3):**

```typescript
// Prédit la probabilité de succès d'un path exécuté
// Utilisé pour calculer TD Error = actual - predicted
predictPathSuccess(intentEmbedding: number[], path: string[]): number {
  if (path.length === 0) return 0.5;  // Cold start

  const nodeScores: number[] = [];

  for (const nodeId of path) {
    // Utiliser scoreAllTools ou scoreAllCapabilities selon le type
    if (this.toolNodes.has(nodeId)) {
      const toolScores = this.scoreAllTools(intentEmbedding);
      const score = toolScores.find(t => t.toolId === nodeId)?.score ?? 0.5;
      nodeScores.push(score);
    } else if (this.capabilityNodes.has(nodeId)) {
      const capScores = this.scoreAllCapabilities(intentEmbedding);
      const score = capScores.find(c => c.capabilityId === nodeId)?.score ?? 0.5;
      nodeScores.push(score);
    } else {
      nodeScores.push(0.5);  // Unknown node
    }
  }

  // Weighted average (later nodes more critical)
  let weightedSum = 0, weightTotal = 0;
  for (let i = 0; i < nodeScores.length; i++) {
    const weight = 1 + i * 0.5;  // 1.0, 1.5, 2.0...
    weightedSum += nodeScores[i] * weight;
    weightTotal += weight;
  }

  return weightedSum / weightTotal;
}
```

**Méthodes utilitaires ajoutées:**

- `hasToolNode(toolId)` - vérifie si un tool est déjà enregistré
- `hasCapabilityNode(capabilityId)` - vérifie si une capability existe
- `trainBatch(examples)` - training batch sur plusieurs examples (utilisé par PER)

**Flow complet (Story 11.6 + v1 Refactor):**

1. Au démarrage: SHGAT initialisé avec capabilities existantes
   - `computeHierarchyLevels()` calcule les niveaux via tri topologique
   - `buildMultiLevelIncidence()` construit I₀, I_k sans fermeture transitive
   - `initializeLevelParameters()` initialise W_child, W_parent, a_upward, a_downward par niveau
2. À chaque exécution:
   - `registerSHGATNodes()` - enregistre capability + tools dans le graphe
   - Recalcul des niveaux de hiérarchie si nouvelles capabilities
   - `runPERBatchTraining()` - PER-weighted training sur traces stockées
3. Training multi-level: gradients propagés à travers tous les niveaux (upward + downward)
4. Verrou anti-concurrence: skip training si un autre est en cours

### SERVER_TITLE Update

Description du serveur PML mise à jour:

```
"PML - Orchestrate any MCP workflow. Use pml_execute with just an 'intent'
(natural language) to auto-discover tools and execute. Or provide explicit
'code' for custom TypeScript workflows. Learns from successful executions."
```

## References

- ADR-015: Dynamic Alpha (superseded)
- ADR-022: Hybrid Search Alpha (superseded)
- ADR-038: Scoring Algorithms Reference (superseded pour Search)
- ADR-048: Local Adaptive Alpha (superseded)
- Spike: `2025-12-21-capability-pathfinding-dijkstra.md`
