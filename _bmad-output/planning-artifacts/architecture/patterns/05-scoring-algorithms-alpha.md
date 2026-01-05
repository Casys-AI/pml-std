## Pattern 5: Scoring Algorithms (Unified)

> **ADRs:** ADR-051 (Unified Search Simplification) - supersedes ADR-015, 022, 038, 048 **Related:**
> ADR-023 (Candidate Expansion), ADR-024 (Adjacency Matrix), ADR-026 (Cold Start)

**Problem:** Le scoring des outils et capabilities nécessite différents algorithmes selon le mode
(recherche active vs suggestion passive) et le type d'objet (Tool vs Capability).

**Solution Architecture (ADR-051):**

### Three-Mode Architecture

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
│     c) Retourne DAG complet                                 │
└─────────────────────────────────────────────────────────────┘
```

### Search Mode (Simplified - ADR-051)

**Formula:**

```typescript
score = semantic × reliability
```

**Rationale:** En mode Search (Active), il n'y a PAS de contexte. L'utilisateur tape une query
("read file"), il n'a pas encore utilisé d'outils. Donc le graph score (Adamic-Adar, co-occurrence)
serait toujours 0.

L'alpha **n'apportait rien** sans contexte - il ne faisait que réduire le score sémantique.

### Prediction/Suggestion Mode (SHGAT + DR-DSP)

SHGAT remplace les heuristiques alpha manuelles:

```typescript
// SHGAT K-head scoring (context-free)
const { E } = forwardMultiLevel();  // Message passing through hierarchy
const intentProjected = W_intent @ intentEmbedding;

for (let h = 0; h < numHeads; h++) {
  const Q = W_q[h] @ intentProjected;
  const K = W_k[h] @ E.get(level)[capIdx];  // Propagated embedding
  headScores[h] = dot(Q, K) / sqrt(headDim);
}

score = sigmoid(mean(headScores));
```

**SHGAT est context-free** - le contexte (position actuelle) est géré par **DR-DSP**:

- `DR-DSP.findShortestHyperpath(currentTool, targetTool)` utilise le context comme point de départ
- SHGAT ne voit que l'intent et les features du graphe

### Reliability Factor

```typescript
function calculateReliabilityFactor(successRate: number): number {
  if (successRate < 0.5) return 0.1; // Pénalité
  if (successRate > 0.9) return 1.2; // Boost
  return 1.0; // Neutre
}
```

### Cold Start (ADR-026)

```typescript
// Bayesian approach quand observations < seuil
const confidence = observations >= MIN_OBS
  ? empiricalConfidence
  : bayesianPrior(observations, alpha = 1.0);
```

### Candidate Expansion (ADR-023)

```typescript
// Expansion 1.5-3x selon la densité
const expandedK = Math.min(k * expansionFactor, maxCandidates);
const expansionFactor = 1.5 + (1 - density) * 1.5; // 1.5x dense → 3x sparse
```

### Graph Structure (ADR-024)

**Full Adjacency Matrix N×N:**

- Stocke toutes les paires de tools observées
- Cycle breaking automatique (DAG constraint)
- Edge weights par type et source

**Edge Types & Weights:**

```typescript
const EDGE_TYPE_WEIGHTS = {
  dependency: 1.0, // A dépend de B
  contains: 0.8, // Capability contient Tool
  sequence: 0.5, // A suivi de B (observé)
  alternative: 0.3, // A ou B (interchangeable)
};

const EDGE_SOURCE_WEIGHTS = {
  observed: 1.0, // Vu en production
  inferred: 0.7, // Déduit par algo
  template: 0.5, // Bootstrap initial
};
```

---

## Deprecated: Hybrid Search Alpha (ADR-015, 022, 038, 048)

> **Status:** Superseded by ADR-051

L'ancienne formule de Hybrid Search est **obsolète**:

```typescript
// DEPRECATED - Ne plus utiliser
score = (semantic × α + graph × (1-α)) × reliability
```

Les algorithmes d'alpha (ADR-048) étaient des **heuristiques manuelles**:

- EmbeddingsHybrides: "Si coherence haute → alpha bas"
- Heat Diffusion: "Si heat haute → alpha bas"
- Bayesian: "Si peu d'observations → alpha haut"

**SHGAT apprend ces patterns automatiquement** via attention sur les traces épisodiques.

### Legacy Alpha Matrix (For Reference Only)

| Mode                | Type       | Algorithm               | Status       |
| :------------------ | :--------- | :---------------------- | :----------- |
| Active Search       | Tool/Cap   | Embeddings Hybrides     | **OBSOLETE** |
| Passive Suggestion  | Tool       | Heat Diffusion          | **OBSOLETE** |
| Passive Suggestion  | Capability | Heat Diffusion Hiérarch | **OBSOLETE** |
| Cold Start (<5 obs) | All        | Bayesian Prior          | Still used   |

---

**Affects Epics:** Epic 5 (Tools Scoring), Epic 7 (Capabilities Matching), Epic 11 (SHGAT Learning)

**References:**

- ADR-051: `docs/adrs/ADR-051-unified-search-simplification.md` (current)
- ADR-023: Candidate Expansion
- ADR-024: Adjacency Matrix
- ADR-026: Cold Start

---
