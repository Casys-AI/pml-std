# ADR-038: Scoring Algorithms & Formulas Reference

**Status:** 📝 Draft **Date:** 2025-12-08 **Related Epics:** Epic 5 (Tools), Epic 7 (Capabilities)
**Related ADRs:** ADR-048 (Local Adaptive Alpha)

## Context

Casys PML utilise plusieurs algorithmes pour la découverte d'outils (Tools) et de capacités
(Capabilities). Ce document centralise les formules mathématiques et justifie les choix
d'architecture (Graphes simples vs Hypergraphes, Additif vs Multiplicatif).

_Note: Cet ADR remplace et consolide les anciennes tentatives de définition d'algorithmes
(ex-ADR-033)._

## Implementation Status

| Algorithm                | Component    | Status             | Location                                              |
| :----------------------- | :----------- | :----------------- | :---------------------------------------------------- |
| **Hybrid Search**        | Tools        | ✅ **Implemented** | `src/graphrag/graph-engine.ts`                        |
| **Next Step Prediction** | Tools        | ✅ **Implemented** | `src/graphrag/dag-suggester.ts` (Refactored Dec 2025) |
| **DAG Construction**     | Structure    | ✅ **Implemented** | `src/graphrag/graph-engine.ts` (Shortest Path)        |
| **Strategic Discovery**  | Capabilities | 🚧 **In Progress** | Story 7.4 (Spectral Clustering + Hypergraph PageRank) |

---

## 1. Algorithms Matrix (Summary)

### Architecture Unifiée (2025-12-21)

L'architecture évolue vers une approche unifiée où **tout est capability** (tools = capabilities
atomiques).

| Mode                    | Fonction            | Algorithme                                     | Input            |
| :---------------------- | :------------------ | :--------------------------------------------- | :--------------- |
| **Search (Actif)**      | `unifiedSearch()`   | `(semantic × α + graph × (1-α)) × reliability` | intent           |
| **Prediction (Passif)** | `predictNextNode()` | DR-DSP → SHGAT                                 | intent + context |
| **Suggestion (DAG)**    | `suggest()`         | SHGAT (scoring) + DR-DSP (pathfinding)         | intent           |

### Matrice Legacy (pour référence)

| Object Type     | Mode: Active Search (User Intent)                                                                      | Mode: Passive Suggestion (Workflow Context)                                                                           |
| :-------------- | :----------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| **Simple Tool** | **1. Hybrid Search** <br> `Semantic * Alpha + Graph * (1-Alpha)` <br> _Approche Additive (Permissive)_ | **2. Next Step Prediction** <br> `Co-occurrence + Louvain + Recency` <br> _Approche Additive (Probabiliste)_          |
| **Capability**  | **3. Capability Match** <br> `Semantic * SuccessRate` <br> _Approche Multiplicative (Stricte)_         | **4. Strategic Discovery** <br> `Spectral Cluster Boost * ToolsOverlap` <br> _Approche Multiplicative (Contextuelle)_ |

> **Note** : La matrice legacy sera remplacée par l'architecture unifiée. Voir spike
> `2025-12-21-capability-pathfinding-dijkstra.md`.

---

## 2. Tool Algorithms (Tactical Layer)

Les algorithmes pour les outils unitaires (ex: `fs:read`) utilisent un **Graphe Simple Orienté** et
des formules **Additives**.

### 2.1 Hybrid Search (Active Tool Search)

**Location:** `src/graphrag/graph-engine.ts`

Combine recherche sémantique et pertinence contextuelle.

```typescript
const finalScore = alpha * semanticScore + (1 - alpha) * graphScore;
```

- **Alpha Adaptatif (voir ADR-048 pour alpha local) :**

  - ~~Global (legacy) : `density < 0.01` → `alpha = 1.0`, `density > 0.25` → `alpha = 0.5`~~
  - **Local (ADR-048) :** Alpha calculé par nœud selon le mode et le type :
    - Active Search : Embeddings Hybrides (cohérence sémantique/structurelle)
    - Passive Suggestion : Heat Diffusion (propagation de chaleur depuis le contexte)
    - Cold Start (<5 obs.) : Bayésien (prior alpha=1.0)
  - _Rationale :_ L'alpha global ne capture pas l'hétérogénéité locale du graphe.

- **Graph Score (Weighted Adamic-Adar - ADR-041):**
  - `AA(u,v) = Σ (edge_weight × 1/log(|N(w)|))`
  - Mesure si l'outil cherché a des "amis communs" avec les outils du contexte actuel.
  - **Pondération :** Les contributions sont multipliées par la qualité de l'edge (type × source).

### 2.2 Next Step Prediction (Passive Tool Suggestion)

**Location:** `src/graphrag/dag-suggester.ts`

Prédit le prochain outil probable après l'action courante. Formule simplifiée pour favoriser la
réactivité (Récence) plutôt que la popularité globale.

```typescript
const toolScore = cooccurrenceConfidence * 0.6 + // Historique direct (A -> B)
  communityBoost * 0.3 + // Louvain (Même cluster dense)
  recencyBoost * 0.1 + // Récence (Utilisé récemment dans le projet)
  pageRank * 0.1; // Bonus mineur d'importance globale
```

- **Cooccurrence :** Poids de l'arête A -> B.
- **Louvain :** Bonus si A et B sont dans la même communauté. Préféré à LPA pour sa stabilité et
  qualité (modularité), malgré une complexité théorique plus élevée (O(n log n)).
- **Recency (NEW) :** Bonus si l'outil a été utilisé dans les dernières 24h du projet.
- **PageRank :** Mesure l'importance globale du nœud dans le graphe. Utilisé comme bonus mineur.
- _Note:_ Adamic-Adar a été retiré de ce scope pour réduire le bruit, mais reste utilisé dans le
  Hybrid Search.

### 2.3 DAG Construction (Structural Layer)

**Location:** `src/graphrag/graph-engine.ts`

Une fois les outils sélectionnés, il faut déterminer leur ordre d'exécution (dépendances).

- **Dijkstra Weighted Shortest Path (ADR-041):** _(État actuel)_
  - Utilisé pour inférer les dépendances entre outils sélectionnés.
  - Si `PathLength(A, B) <= 3` (dans le graphe historique), on considère que B dépend de A.
  - **Pondération par qualité d'edge :** `cost = 1 / weight` (poids élevé = coût faible = préféré)
  - **Edge Types :** `dependency` (1.0) > `contains` (0.8) > `sequence` (0.5)
  - **Edge Sources :** `observed` (×1.0) > `inferred` (×0.7) > `template` (×0.5)
  - Permet de favoriser les chemins confirmés par l'historique vs les templates bootstrap.

- **⏳ Évolution planifiée : DR-DSP (Shortest Hyperpath)**
  - Voir spike `2025-12-21-capability-pathfinding-dijkstra.md`
  - Dijkstra ne comprend pas les hyperedges (capabilities comme unités atomiques)
  - **DR-DSP** (Directed Relationship Dynamic Shortest Path) :
    - Natif hypergraph, polynomial pour DAG
    - Updates incrémentaux après chaque observation
    - Optimisé quand les edges `provides` changent (notre cas)

---

## 3. Capability Algorithms (Strategic Layer)

Les algorithmes pour les Capabilities (groupes d'outils) utilisent un **Hypergraphe Bipartite** et
des formules **Multiplicatives**.

### 3.1 Capability Match (Active Capability Search)

**Location:** `src/capabilities/matcher.ts`

Trouve une capability qui répond à une demande explicite.

```typescript
// Formule Multiplicative Stricte
const matchScore = semanticScore * reliabilityFactor;
```

- **semanticScore :** Vector Cosine Similarity (Intent vs Description).
- **reliabilityFactor :** Basé sur `successRate` historique.

  - Si `success_rate < 0.5` → Factor `0.1` (Disqualification).
  - Si `success_rate > 0.9` → Factor `1.2` (Bonus).

- _Rationale :_ Si une capability ne marche pas (Reliability faible), elle ne doit pas être
  proposée, même si elle ressemble sémantiquement à la demande.

### 3.2 SHGAT - Scoring Unifié Tools & Capabilities (✅ Implémenté)

**Location:** `src/graphrag/algorithms/shgat.ts`, `src/mcp/algorithm-init/initializer.ts`

SHGAT (SuperHyperGraph Attention Networks) score les tools ET capabilities via message passing sur
un n-SuperHyperGraph.

#### Architecture

```
Intent Embedding (1024-dim BGE-M3)
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│                    FORWARD PASS                           │
│                                                           │
│  UPWARD: V → E⁰ → E¹ → ... → Eᴸ                          │
│  - Tools (V) envoient messages aux Capabilities (E⁰)      │
│  - Capabilities propagent vers meta-capabilities (Eᵏ)     │
│                                                           │
│  DOWNWARD: Eᴸ → ... → E⁰ → V                             │
│  - Meta-capabilities propagent signal vers children       │
│  - Level-0 capabilities propagent vers tools connectés    │
│                                                           │
│  Attention multi-head par niveau (numHeads=4, numLayers=2)│
└───────────────────────────────────────────────────────────┘
        │
        ▼
  H_final (tool embeddings propagés)
  E_final (capability embeddings propagés)
        │
        ▼
  Score = cosine(intent, H_final[tool]) ou cosine(intent, E_final[cap])
```

#### Incidence Structure (Tool → Capability connections)

```typescript
// buildMultiLevelIncidence() dans graph/incidence.ts
toolToCapIncidence: Map<string, Set<string>>  // tool → caps qui le contiennent
capToCapIncidence: Map<number, Map<string, Set<string>>>  // level k: child → parents
```

**Important** : Un tool connecté à plusieurs capabilities BÉNÉFICIE du message passing - le signal
des capabilities se propage vers le tool via le downward pass.

#### Training - Contrastive Learning avec Semi-Hard Negative Mining

```typescript
// Pour chaque trace (intent, positive_capability, outcome):
// 1. Positive = la capability utilisée
// 2. Negatives = autres capabilities/tools avec similarité intermédiaire

// ⚠️ CRITICAL FIX (2026-01-09): Exclure les tools de la capability positive
const positiveTools = capToTools.get(trace.capability_id);
for (const [capId, emb] of capEmbeddings) {
  if (capId === trace.capability_id) continue;  // Exclure positive
  if (positiveTools.has(capId)) continue;       // ← FIX: Exclure tools du positive
  // ... sample as potential negative
}
```

**Bug corrigé** : Les tools dans `toolsUsed` de la capability positive étaient utilisés comme
negatives, ce qui apprenait au modèle à les SUPPRIMER. Ex: `psql_query` (dans 7 capabilities)
scorait 0.03 au lieu de 0.50.

#### Persistence

- **Params** : Sauvegardés dans `shgat_params` (PostgreSQL), ~137MB pour 605 tools
- **Training** : Subprocess isolé (`spawn-training.ts`) pour éviter bloquer le main loop
- **Sync Graph** : Au démarrage serveur uniquement (`syncFromDatabase()`)

---

## 4. Decision & Adaptation

### 4.1 Interaction avec Intelligent Adaptive Thresholds (ADR-049)

Le score calculé par les algorithmes ci-dessus (`finalScore`, `matchScore`, etc.) est une valeur
brute. La décision finale passe par l'`IntelligentThresholdManager` (ADR-049).

```typescript
// 1. Calcul du Score Brut (ADR-038)
const score = calculateScore(...); // ex: 0.82

// 2. Récupération du Seuil Intelligent (ADR-049)
// Intègre: Thompson Sampling per-tool + Local Alpha (ADR-048) + Risk Category + Episodic Boost
const { threshold, breakdown } = await intelligentThresholdManager.getThreshold(
  toolId,
  contextTools,
  workflowContext
); // ex: 0.68 pour tool safe avec bon historique

// 3. Décision selon le mode (ADR-049 Decision 6)
// - Active Search: threshold bas, UCB bonus exploration
// - Passive Suggestion: Thompson sampling standard
// - Speculation: threshold haut, pas de variance
if (score >= threshold) {
  return suggestion;
} else {
  return null; // Rejeté (trop risqué pour ce contexte)
}
```

**Note:** ADR-049 remplace l'ancien système EMA global (ADR-008) par un système intelligent à 3
niveaux avec apprentissage per-tool.

### 4.2 Magic Numbers Inventory

Les valeurs utilisées dans les formules doivent être monitorées et ajustées.

| Value    | Algorithm                | Role                          | Status             |
| :------- | :----------------------- | :---------------------------- | :----------------- |
| **0.60** | Tool Prediction          | Poids Cooccurrence            | Validé (Empirique) |
| **0.30** | Tool Prediction          | Poids Louvain                 | Validé (Empirique) |
| **0.50** | Hybrid Search            | Alpha Floor                   | Validé (ADR-022)   |
| **0.50** | Reliability              | Seuil de pénalité SuccessRate | À valider          |
| **1.20** | Reliability              | Bonus High Success            | À valider          |
| **0.50** | Strategic Discovery      | Spectral Cluster Boost        | À valider          |
| **1.00** | Edge Type (ADR-041)      | Poids `dependency`            | Validé             |
| **0.80** | Edge Type (ADR-041)      | Poids `contains`              | Validé             |
| **0.50** | Edge Type (ADR-041)      | Poids `sequence`              | Validé             |
| **1.00** | Edge Source (ADR-041)    | Multiplicateur `observed`     | Validé             |
| **0.70** | Edge Source (ADR-041)    | Multiplicateur `inferred`     | Validé             |
| **0.50** | Edge Source (ADR-041)    | Multiplicateur `template`     | Validé             |
| **3**    | Edge Promotion (ADR-041) | Seuil inferred→observed       | Validé             |

---

## 5. Future Improvements

1. ~~**Online Learning des Poids :**~~ **→ Full SHGAT** : Les poids statiques seront remplacés par
   une attention apprise sur les traces épisodiques. Voir section 3.2.
2. ~~**Unified Hypergraph :**~~ **→ ADR-042 (Capability Hyperedges)** : Les relations
   capability→capability (hyperedges) sont maintenant stockées dans `capability_dependency`. ADR-042
   définit comment enrichir le Spectral Clustering, PageRank, et Capability Match avec ces
   relations.

### 5.1 Architecture Cible (2025-12-21)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ARCHITECTURE CIBLE UNIFIÉE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. SEARCH (Active) - unifiedSearch(intent)                                 │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │   score = (semantic × α + graph × (1-α)) × reliability           │       │
│  │   - Unified pour tools ET capabilities                           │       │
│  │   - POC: src/graphrag/algorithms/unified-search.ts               │       │
│  └──────────────────────────────────────────────────────────────────┘       │
│                                                                             │
│  2. PREDICTION (Passive) - predictNextNode(intent, context)                 │
│  ┌──────────────┐    ┌──────────────┐                                       │
│  │   DR-DSP     │ →  │    SHGAT     │ → Ranked candidates                   │
│  │ (candidats)  │    │  (scoring)   │                                       │
│  └──────────────┘    └──────────────┘                                       │
│                       │                                                     │
│                       ▼ Features hypergraph :                               │
│                       - Spectral Cluster                                    │
│                       - Hypergraph PageRank                                 │
│                       - Co-occurrence (episodic)                            │
│                       - Recency, Reliability                                │
│                                                                             │
│  3. SUGGESTION (DAG) - suggest(intent)                                      │
│  ┌──────────────┐    ┌──────────────┐                                       │
│  │    SHGAT     │ →  │   DR-DSP     │ → DAG (tool OU capability OU path)   │
│  │  (scoring)   │    │ (pathfinding)│                                       │
│  └──────────────┘    └──────────────┘                                       │
│                                                                             │
│  Stratégie (DAGSuggesterAdapter):                                          │
│  1. SHGAT score capabilities ET tools en parallèle                         │
│  2. Compare bestCap vs bestTool                                            │
│  3. Si meilleur score >= 0.6 → retourne capability OU tool directement     │
│  4. Sinon → DR-DSP compose chemin (pathfinding, pas scoring!)              │
│                                                                             │
│  Structure sous-jacente : DASH (Directed Acyclic SuperHyperGraph)           │
│  DR-DSP aligné : tools ET capabilities sont des nodes                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 SHGAT - Message Passing Architecture (Implémentée)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        n-SuperHyperGraph Structure                       │
│                                                                          │
│   Tools (V)              Capabilities (E⁰)        Meta-Caps (E¹...Eᴸ)   │
│   ┌───┐ ┌───┐           ┌─────────────────┐      ┌─────────────────┐    │
│   │t1 │ │t2 │ ───────── │   cap:db-query  │ ──── │  meta:database  │    │
│   └───┘ └───┘           │  toolsUsed:[t1] │      └─────────────────┘    │
│   ┌───┐                 └─────────────────┘                             │
│   │t3 │ ─────────────── ┌─────────────────┐                             │
│   └───┘                 │   cap:fs-ops    │                             │
│                         │ toolsUsed:[t2,t3]│                             │
│                         └─────────────────┘                             │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        SHGAT Forward Pass                                │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ UPWARD (V → E⁰ → E¹ → ... → Eᴸ)                                 │    │
│  │                                                                  │    │
│  │   Pour chaque niveau k, pour chaque head h:                     │    │
│  │   E'ₖ = Σⱼ αᵢⱼ · Wₛₒᵤᵣ꜀ₑ · sourceⱼ    (attention-weighted sum) │    │
│  │                                                                  │    │
│  │   αᵢⱼ = softmax(LeakyReLU(aᵀ · [Wₛ·sⱼ || Wₜ·tᵢ]))             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                          │
│                              ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ DOWNWARD (Eᴸ → ... → E⁰ → V)                                    │    │
│  │                                                                  │    │
│  │   Même mécanique, direction inverse                             │    │
│  │   Tools reçoivent signal des capabilities qui les contiennent   │    │
│  │   + Residual connection (preserveDimResidual=0.3)               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                          │
│                              ▼                                          │
│                    H_final, E_final (propagated embeddings)             │
└─────────────────────────────────────────────────────────────────────────┘
```

**Multi-head** : 4 heads parallèles par niveau, concat puis projection.
Chaque head apprend des patterns d'attention différents (pas semantic/structure/temporal séparés).

**Spikes de référence :**

- `2025-12-21-capability-pathfinding-dijkstra.md` : Architecture unifiée, DR-DSP + SHGAT
- `2025-12-17-superhypergraph-hierarchical-structures.md` : Théorie DASH, implémentation SHGAT

## 6. Related ADRs

- **ADR-041:** Hierarchical Trace Tracking (edge_type, edge_source)
- **ADR-042:** Capability-to-Capability Hyperedges (enrichissement des algorithmes avec les
  relations cap→cap)
- **ADR-048:** Local Adaptive Alpha (pondération semantic vs graph par mode/type)
- **ADR-049:** Intelligent Adaptive Thresholds (Thompson Sampling, Risk Categories, décision
  d'exécution)
