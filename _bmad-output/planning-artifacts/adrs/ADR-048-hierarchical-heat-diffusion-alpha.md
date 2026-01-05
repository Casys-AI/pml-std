# ADR-048: Local Adaptive Alpha by Mode

**Status:** Accepted (Implemented) **Date:** 2025-12-15 **Related:** ADR-015 (Dynamic Alpha),
ADR-026 (Cold Start), ADR-038 (Scoring Algorithms), ADR-042 (Capability Hyperedges), ADR-049
(Intelligent Adaptive Thresholds)

## Context

### Problème avec l'Alpha Global

L'alpha actuel (ADR-015, ADR-026) est calculé sur la **densité globale** du graphe :

```typescript
const density = totalEdges / maxPossibleEdges; // Global
const alpha = Math.max(0.5, 1.0 - density * 2); // Même pour tous les nœuds
```

**Problème identifié :** Dans un hypergraphe de Tools/Capabilities/MetaCapabilities, certaines zones
sont denses et bien connectées, tandis que d'autres sont isolées. Un alpha global ne capture pas
cette hétérogénéité.

### Cas problématiques

```
┌─────────────────────────────────────────────────────────┐
│                    HYPERGRAPHE                          │
│                                                         │
│  ┌──────────────────┐       ┌──────────────────┐       │
│  │  Cluster A       │       │  Cluster B       │       │
│  │  (File Ops)      │       │  (ML - isolé)    │       │
│  │                  │       │                  │       │
│  │  ●──●──●──●      │       │       ●          │       │
│  │  │╲ │ ╱│ ╲│      │       │                  │       │
│  │  ●──●──●──●      │       │                  │       │
│  │  Densité: 0.8    │       │  Densité: 0.0    │       │
│  └──────────────────┘       └──────────────────┘       │
│                                                         │
│  Densité GLOBALE = 0.15                                │
│  Alpha GLOBAL = 0.7                                    │
│                                                         │
│  PROBLÈME:                                             │
│  - Cluster A devrait avoir alpha ≈ 0.5 (graphe utile)  │
│  - Cluster B devrait avoir alpha ≈ 1.0 (semantic only) │
│  - Mais les deux ont alpha = 0.7 !                     │
└─────────────────────────────────────────────────────────┘
```

### Structure Hiérarchique

Le système a une hiérarchie naturelle :

```
MetaCapabilities (∞, émergentes)
       │ contains
       ▼
Capabilities (dependency, sequence, alternative)
       │ contains
       ▼
Tools (co-occurrence, edges directs)
```

Les MetaCapabilities sont **infinies** et **émergentes** - elles se créent dynamiquement à partir
des patterns d'usage. L'alpha doit respecter cette hiérarchie.

## Decision

Comme pour les algorithmes de scoring (ADR-038), utiliser **différents algorithmes d'alpha selon le
mode et le type d'objet**.

### Matrice des Algorithmes Alpha

| Mode                   | Type       | Algorithme                  | Rationale                                        |
| ---------------------- | ---------- | --------------------------- | ------------------------------------------------ |
| **Active Search**      | Tool       | Embeddings Hybrides         | Query explicite → comparer semantic vs structure |
| **Active Search**      | Capability | Embeddings Hybrides         | Idem                                             |
| **Passive Suggestion** | Tool       | Heat Diffusion              | Propagation depuis le contexte                   |
| **Passive Suggestion** | Capability | Heat Diffusion Hiérarchique | Respecte Tool→Cap→Meta                           |
| **Cold Start**         | Tous       | Bayésien (prior)            | Observations insuffisantes → incertitude haute   |

### Alignement avec ADR-038

```
ADR-038 (Scoring Algorithms):
┌─────────────────┬────────────────────┬─────────────────────┐
│                 │ Active Search      │ Passive Suggestion  │
├─────────────────┼────────────────────┼─────────────────────┤
│ Tool            │ Hybrid Search      │ Next Step Predict   │
│ Capability      │ Capability Match   │ Strategic Discovery │
└─────────────────┴────────────────────┴─────────────────────┘

ADR-048 (Alpha Algorithms):
┌─────────────────┬────────────────────┬─────────────────────┐
│                 │ Active Search      │ Passive Suggestion  │
├─────────────────┼────────────────────┼─────────────────────┤
│ Tool            │ Emb. Hybrides      │ Heat Diffusion      │
│ Capability      │ Emb. Hybrides      │ Heat Diffusion Hier.│
└─────────────────┴────────────────────┴─────────────────────┘

+ Fallback Bayésien si observations < seuil (Cold Start)
```

### Clarification: Modes vs États

ADR-049 introduit un troisième mode d'exécution (**Speculation**) pour les thresholds. Voici comment
Alpha et Threshold s'articulent :

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    MODES ET ÉTATS                                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ADR-048 (ALPHA): Modes de calcul alpha                                 │
│  ├── Active Search     → Embeddings Hybrides                            │
│  └── Passive Suggestion → Heat Diffusion                                │
│                                                                          │
│  ADR-049 (THRESHOLD): Modes d'exécution                                 │
│  ├── Active Search      → threshold bas, UCB bonus, user confirme       │
│  ├── Passive Suggestion → threshold moyen, Thompson sampling            │
│  └── Speculation        → threshold haut, mean only, exécution auto     │
│                                                                          │
│  ÉTAT (transversal):                                                    │
│  └── Cold Start (<5 obs) → Bayesian fallback (alpha) + Thompson prior   │
│                                                                          │
│  MAPPING Alpha → Threshold:                                             │
│  ├── Active Search      uses Alpha from: Embeddings Hybrides            │
│  ├── Passive Suggestion uses Alpha from: Heat Diffusion                 │
│  └── Speculation        uses Alpha from: Heat Diffusion (same as Passive)│
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Note:** Speculation est un sous-mode de Passive où le système décide d'exécuter sans confirmation.
L'alpha utilisé est le même que Passive (Heat Diffusion), mais le threshold est calculé différemment
(plus conservateur, pas de sampling).

---

## 1. Embeddings Hybrides (Active Search)

**Utilisé pour :** Active Search (Tool & Capability)

**Principe :** Mesurer si la structure du graphe reflète les relations sémantiques en comparant les
**patterns de similarité** entre un nœud et ses voisins.

### Rationale

En mode Active Search, on a une **query explicite**. La question est : "Le graphe confirme-t-il ce
que la sémantique suggère ?"

L'idée originale était de comparer directement les embeddings sémantiques (BGE-M3, 1024d) avec les
embeddings structurels (eigenvectors spectraux, ~4d). Cependant, la similarité cosinus n'est pas
définie pour des vecteurs de dimensions différentes.

**Solution : Corrélation des Patterns de Similarité**

Au lieu de comparer les embeddings directement, on compare les **patterns de relations** :

1. Pour chaque voisin du nœud cible :
   - Calculer la similarité **sémantique** (cosine entre embeddings BGE-M3, même dimension)
   - Récupérer la similarité **structurelle** (poids de l'edge normalisé)

2. Calculer la **corrélation de Pearson** entre ces deux listes de similarités

3. Interprétation :
   - Corrélation haute (+1) → les voisins proches sémantiquement sont aussi proches structurellement
     → graphe fiable → **alpha bas**
   - Corrélation basse (0) → pas de relation entre sémantique et structure → **alpha moyen**
   - Corrélation négative (-1) → structure contredit la sémantique → **alpha haut**

### Exemple concret

```
Nœud cible: fs:read
Voisins dans le graphe: [fs:write, git:diff, db:query]

Similarités sémantiques (cosine BGE-M3):
  fs:read ↔ fs:write  = 0.85  (très similaire)
  fs:read ↔ git:diff  = 0.42  (moyennement)
  fs:read ↔ db:query  = 0.25  (peu similaire)

Similarités structurelles (edge weights normalisés):
  fs:read → fs:write  = 0.90  (souvent co-utilisés)
  fs:read → git:diff  = 0.50  (parfois)
  fs:read → db:query  = 0.20  (rarement)

Pearson([0.85, 0.42, 0.25], [0.90, 0.50, 0.20]) ≈ 0.99

→ Graphe très cohérent avec la sémantique → alpha bas (≈0.5)
```

### Implémentation

```typescript
/**
 * Calcule l'alpha local via corrélation des patterns de similarité
 *
 * @param nodeId - ID du nœud cible
 * @returns Alpha entre 0.5 et 1.0
 */
function computeAlphaEmbeddingsHybrides(nodeId: string): number {
  const neighbors = graph.neighbors(nodeId);
  if (neighbors.length < 2) return 1.0; // Fallback

  const targetEmb = getSemanticEmbedding(nodeId);
  if (!targetEmb) return 1.0;

  const semanticSims: number[] = [];
  const structuralSims: number[] = [];

  // Normalisation des poids d'edges
  const maxWeight = Math.max(...neighbors.map((n) => getEdgeWeight(nodeId, n)));

  for (const neighbor of neighbors) {
    const neighborEmb = getSemanticEmbedding(neighbor);
    if (!neighborEmb) continue;

    // Similarité sémantique (1024d vs 1024d ✓)
    semanticSims.push(cosineSimilarity(targetEmb, neighborEmb));

    // Similarité structurelle (poids normalisé)
    structuralSims.push(getEdgeWeight(nodeId, neighbor) / maxWeight);
  }

  if (semanticSims.length < 2) return 1.0;

  // Corrélation de Pearson entre les patterns
  const correlation = pearsonCorrelation(semanticSims, structuralSims);

  // Normalise [-1, 1] → [0, 1]
  const normalizedCoherence = (correlation + 1) / 2;

  // Cohérence haute → alpha bas
  return Math.max(0.5, 1.0 - normalizedCoherence * 0.5);
}
```

### Avantages de cette approche

| Aspect               | Ancienne approche                 | Nouvelle approche                                                    |
| -------------------- | --------------------------------- | -------------------------------------------------------------------- |
| **Dimensions**       | ❌ Compare 1024d vs 4d (invalide) | ✅ Compare scalaires vs scalaires                                    |
| **Interprétabilité** | Opaque                            | Clair : "voisins proches sémantiquement = proches structurellement?" |
| **Dépendances**      | Nécessite spectral clustering     | Utilise uniquement le graphe et les embeddings existants             |

### Briques existantes

| Composant                     | Statut        | Location                                    |
| ----------------------------- | ------------- | ------------------------------------------- |
| Embedding sémantique (BGE-M3) | ✅ Existe     | `src/vector/embeddings.ts`                  |
| Poids des edges               | ✅ Existe     | `graph.getEdgeAttribute(a, b, "weight")`    |
| Cosine similarity             | ✅ Existe     | `LocalAlphaCalculator.cosineSimilarity()`   |
| Pearson correlation           | ✅ **Ajouté** | `LocalAlphaCalculator.pearsonCorrelation()` |

---

## 2. Heat Diffusion (Passive Suggestion - Tools)

**Utilisé pour :** Passive Suggestion de Tools

**Principe :** La "chaleur" représente la **confiance structurelle** locale. Elle se propage depuis
les zones denses vers les zones sparse.

### Rationale

En mode Passive Suggestion, on n'a **pas de query** - juste un contexte (outils déjà utilisés). La
question est : "Y a-t-il de la structure utile autour du nœud cible, depuis là où on est ?"

- Zone dense et bien connectée au contexte → chaleur haute → alpha bas
- Zone sparse ou déconnectée du contexte → chaleur basse → alpha haut

### Implémentation

```typescript
/**
 * Calcule l'alpha local via Heat Diffusion (Passive Suggestion Tools)
 *
 * @param targetNodeId - ID du nœud cible
 * @param contextNodes - Tools déjà utilisés dans le workflow
 * @returns Alpha entre 0.5 et 1.0
 */
function computeAlphaHeatDiffusion(
  targetNodeId: string,
  contextNodes: string[],
): number {
  // Chaleur intrinsèque du nœud (basée sur son degré)
  const targetHeat = computeLocalHeat(targetNodeId);

  // Chaleur du contexte (d'où on vient)
  const contextHeat = contextNodes.length > 0
    ? contextNodes.reduce((sum, n) => sum + computeLocalHeat(n), 0) / contextNodes.length
    : 0;

  // Chaleur du chemin (connectivité entre contexte et cible)
  const pathHeat = computePathHeat(contextNodes, targetNodeId);

  // Score de confiance structurelle [0, 1]
  const structuralConfidence = 0.4 * targetHeat +
    0.3 * contextHeat +
    0.3 * pathHeat;

  return Math.max(0.5, 1.0 - structuralConfidence * 0.5);
}

/**
 * Chaleur locale d'un nœud (degré normalisé + voisinage)
 */
function computeLocalHeat(nodeId: string): number {
  const degree = graph.degree(nodeId);
  const maxDegree = getMaxDegreeForType("tool");

  // Chaleur intrinsèque
  const intrinsicHeat = degree / maxDegree;

  // Chaleur des voisins (propagation)
  const neighbors = graph.neighbors(nodeId);
  const neighborHeat = neighbors.length > 0
    ? neighbors.reduce((sum, n) => sum + graph.degree(n), 0) / (neighbors.length * maxDegree)
    : 0;

  return 0.6 * intrinsicHeat + 0.4 * neighborHeat;
}

/**
 * Chaleur du chemin entre contexte et cible
 */
function computePathHeat(contextNodes: string[], targetId: string): number {
  if (contextNodes.length === 0) return 0;

  // Moyenne des scores de connectivité
  let totalConnectivity = 0;
  for (const ctx of contextNodes) {
    // Edge direct ?
    if (graph.hasEdge(ctx, targetId)) {
      totalConnectivity += graph.getEdgeAttribute(ctx, targetId, "weight") || 1.0;
    } else {
      // Adamic-Adar pour connexion indirecte
      totalConnectivity += computeAdamicAdar(ctx, targetId);
    }
  }

  return Math.min(1.0, totalConnectivity / contextNodes.length);
}
```

---

## 3. Heat Diffusion Hiérarchique (Passive Suggestion - Capabilities)

**Utilisé pour :** Passive Suggestion de Capabilities

**Principe :** Comme Heat Diffusion, mais avec **propagation hiérarchique** à travers Tool →
Capability → MetaCapability, **enrichie par les Cap→Cap edges** (ADR-042).

### Rationale

Les Capabilities ont une structure hiérarchique ET des relations horizontales (dependency, contains,
alternative, sequence). La chaleur se propage :

- **Bottom-up** : MetaCapability chaude si ses Capabilities enfants sont chaudes
- **Top-down** : Tool isolé hérite de la chaleur de sa Capability parente
- **Horizontal (ADR-042)** : Capability reçoit de la chaleur via ses dependency/contains edges

### Implémentation

```typescript
/**
 * Calcule l'alpha local via Heat Diffusion Hiérarchique (Passive Suggestion Capabilities)
 */
function computeAlphaHeatDiffusionHierarchical(
  targetNodeId: string,
  targetType: "tool" | "capability" | "meta",
  contextNodes: string[],
): number {
  const heat = computeHierarchicalHeat(targetNodeId, targetType);
  const contextHeat = computeContextHeat(contextNodes);
  const pathHeat = computeHierarchicalPathHeat(contextNodes, targetNodeId);

  const structuralConfidence = 0.4 * heat +
    0.3 * contextHeat +
    0.3 * pathHeat;

  return Math.max(0.5, 1.0 - structuralConfidence * 0.5);
}

/**
 * Chaleur hiérarchique avec propagation bidirectionnelle
 */
function computeHierarchicalHeat(nodeId: string, nodeType: NodeType): number {
  const weights = getHierarchyWeights(nodeType);

  const intrinsicHeat = computeIntrinsicHeat(nodeId, nodeType);
  const neighborHeat = computeNeighborHeat(nodeId);
  const hierarchyHeat = computeHierarchyPropagation(nodeId, nodeType);

  return weights.intrinsic * intrinsicHeat +
    weights.neighbor * neighborHeat +
    weights.hierarchy * hierarchyHeat;
}

/**
 * Propagation dans la hiérarchie + Cap→Cap edges (ADR-042)
 */
function computeHierarchyPropagation(nodeId: string, nodeType: NodeType): number {
  switch (nodeType) {
    case "meta":
      // Agrégation bottom-up des capabilities enfants
      const children = getChildren(nodeId, "capability");
      if (children.length === 0) return 0;
      return children.reduce((sum, c) => sum + computeHierarchicalHeat(c, "capability"), 0) /
        children.length;

    case "capability":
      // 1. Héritage de la meta-capability parente
      const metaParent = getParent(nodeId, "meta");
      const metaHeat = metaParent ? computeHierarchicalHeat(metaParent, "meta") * 0.5 : 0;

      // 2. NEW (ADR-042): Chaleur des capabilities liées via dependency/contains
      const deps = capabilityStore.getDependencies(nodeId, "to");
      const depHeat = deps
        .filter((d) => d.edgeType === "dependency" || d.edgeType === "contains")
        .reduce(
          (sum, d) =>
            sum + computeHierarchicalHeat(d.fromCapabilityId, "capability") * d.confidenceScore,
          0,
        ) / Math.max(1, deps.length);

      // Combine: vertical (50%) + horizontal (50%)
      return metaHeat + depHeat * 0.5;

    case "tool":
      // Héritage de la capability parente
      const capParent = getParent(nodeId, "capability");
      if (!capParent) return 0;
      return computeHierarchicalHeat(capParent, "capability") * 0.5;
  }
}

/**
 * Poids selon le niveau hiérarchique
 */
function getHierarchyWeights(nodeType: NodeType): HeatWeights {
  switch (nodeType) {
    case "tool":
      return { intrinsic: 0.5, neighbor: 0.3, hierarchy: 0.2 };
    case "capability":
      return { intrinsic: 0.3, neighbor: 0.4, hierarchy: 0.3 };
    case "meta":
      return { intrinsic: 0.2, neighbor: 0.2, hierarchy: 0.6 };
  }
}
```

---

## 4. Bayésien - Cold Start Fallback

**Utilisé pour :** Tous les modes quand observations < seuil

**Principe :** Modéliser l'**incertitude** explicitement. Un nœud avec peu d'observations a une
variance haute → on ne fait pas confiance au graphe.

### Rationale

Pour les nouveaux nœuds (MetaCapabilities émergentes notamment), on n'a pas assez de données pour
que les autres algorithmes soient fiables. Le fallback Bayésien garantit qu'on ne fait pas confiance
au graphe prématurément.

### Implémentation

```typescript
const COLD_START_THRESHOLD = 5; // Minimum observations

/**
 * Vérifie si on est en cold start et calcule l'alpha Bayésien si nécessaire
 */
function computeAlphaWithColdStartCheck(
  nodeId: string,
  mode: "active" | "passive",
  nodeType: NodeType,
  contextNodes: string[],
): number {
  const observations = getObservationCount(nodeId);

  // Cold start: pas assez d'observations
  if (observations < COLD_START_THRESHOLD) {
    return computeAlphaBayesian(nodeId, observations);
  }

  // Sinon, utiliser l'algorithme approprié au mode
  if (mode === "active") {
    return computeAlphaEmbeddingsHybrides(nodeId);
  } else {
    if (nodeType === "tool") {
      return computeAlphaHeatDiffusion(nodeId, contextNodes);
    } else {
      return computeAlphaHeatDiffusionHierarchical(nodeId, nodeType, contextNodes);
    }
  }
}

/**
 * Alpha Bayésien basé sur l'incertitude
 *
 * Prior: alpha = 1.0 (semantic only)
 * Posterior: converge vers l'algo principal avec plus d'observations
 */
function computeAlphaBayesian(nodeId: string, observations: number): number {
  // Prior: on ne fait pas confiance au graphe
  const priorAlpha = 1.0;

  // Avec plus d'observations, on fait de plus en plus confiance
  // Formule: alpha = prior * (1 - observations/threshold) + target * (observations/threshold)
  const confidence = observations / COLD_START_THRESHOLD;
  const targetAlpha = 0.7; // Valeur cible intermédiaire

  return priorAlpha * (1 - confidence) + targetAlpha * confidence;
}
```

---

## Implementation Plan

### Fichiers à CRÉER

| Fichier                                   | Lignes | Description                                          |
| ----------------------------------------- | ------ | ---------------------------------------------------- |
| `src/graphrag/local-alpha.ts`             | ~200   | Classe `LocalAlphaCalculator` avec les 4 algorithmes |
| `tests/unit/graphrag/local_alpha_test.ts` | ~150   | Tests unitaires pour les 4 algos                     |

### Fichiers à MODIFIER

| Fichier                               | Impact | Changements                                                                      |
| ------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `src/graphrag/graph-engine.ts`        | Moyen  | `searchToolsHybrid()` : remplacer calcul alpha global par `LocalAlphaCalculator` |
| `src/graphrag/dag-suggester.ts`       | Moyen  | `getAdaptiveWeights()` : utiliser alpha local au lieu de densité globale         |
| `src/graphrag/spectral-clustering.ts` | Faible | Exposer `getEmbeddingRow(nodeIndex)` pour Embeddings Hybrides                    |
| `src/graphrag/types.ts`               | Faible | Ajouter `AlphaMode`, `NodeType`, `LocalAlphaResult`                              |

### Tests à ADAPTER

| Fichier                                            | Changements                                        |
| -------------------------------------------------- | -------------------------------------------------- |
| `tests/unit/graphrag/graph_engine_metrics_test.ts` | Adapter tests `getAdaptiveAlpha` → `getLocalAlpha` |
| `tests/integration/dashboard_metrics_test.ts`      | Adapter tests `adaptiveAlpha` dans metrics         |

### Estimation

```
Créer:    2 fichiers  (~350 lignes)
Modifier: 4 fichiers  (~100 lignes de changements)
Tests:    2 à adapter

Total: ~450 lignes de code
```

### Interface principale

```typescript
type AlphaMode = "active" | "passive";
type NodeType = "tool" | "capability" | "meta";

interface LocalAlphaCalculator {
  /**
   * Point d'entrée principal
   */
  getLocalAlpha(
    mode: AlphaMode,
    nodeId: string,
    nodeType: NodeType,
    contextNodes?: string[],
  ): number;

  /**
   * Pour debug/observabilité
   */
  getAlphaBreakdown(
    mode: AlphaMode,
    nodeId: string,
    nodeType: NodeType,
    contextNodes?: string[],
  ): {
    algorithm: "embeddings_hybrides" | "heat_diffusion" | "heat_hierarchical" | "bayesian";
    alpha: number;
    inputs: Record<string, number>;
    coldStart: boolean;
  };
}
```

---

## API: Alpha Statistics Endpoint

### GET /api/alpha-stats

Returns statistics about local adaptive alpha usage for observability and algorithm tuning.

**Query Parameters:**

| Parameter     | Type   | Default | Description                |
| ------------- | ------ | ------- | -------------------------- |
| `windowHours` | number | 24      | Query window (1-168 hours) |

**Response Schema:**

```json
{
  "success": true,
  "windowHours": 24,
  "stats": {
    "avgAlphaByMode": {
      "activeSearch": 0.75,
      "passiveSuggestion": 0.82
    },
    "alphaDistribution": {
      "bucket05_06": 15,
      "bucket06_07": 25,
      "bucket07_08": 30,
      "bucket08_09": 20,
      "bucket09_10": 10
    },
    "algorithmDistribution": {
      "embeddingsHybrides": 40,
      "heatDiffusion": 35,
      "heatHierarchical": 10,
      "bayesian": 15,
      "none": 0
    },
    "coldStartStats": {
      "total": 15,
      "percentage": 15.0
    },
    "alphaImpact": {
      "lowAlphaAvgScore": 0.72,
      "highAlphaAvgScore": 0.58
    }
  }
}
```

**Response Fields:**

| Field                   | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `avgAlphaByMode`        | Average alpha values per algorithm mode            |
| `alphaDistribution`     | Histogram of alpha values in 0.1 buckets           |
| `algorithmDistribution` | Count of traces per alpha algorithm                |
| `coldStartStats`        | Cold start occurrences and percentage              |
| `alphaImpact`           | Average scores for low (<0.7) vs high (≥0.7) alpha |

**Example Usage:**

```bash
# Get last 24 hours stats
curl -X GET "http://localhost:8000/api/alpha-stats"

# Get last 48 hours stats
curl -X GET "http://localhost:8000/api/alpha-stats?windowHours=48"
```

**Authentication:**

- Local mode: No authentication required
- Cloud mode: Requires authenticated user (returns 401 if not authenticated)

---

### Algorithm Trace Signals (Extended)

The `algorithm_traces` table now includes alpha-related signals:

```typescript
interface AlgorithmSignals {
  // Existing fields...
  semanticScore?: number;
  toolsOverlap?: number;
  successRate?: number;
  pagerank?: number;
  cooccurrence?: number;
  graphDensity: number;
  spectralClusterMatch: boolean;
  adamicAdar?: number;

  // ADR-048: New alpha signals
  localAlpha?: number; // Alpha value used (0.5-1.0)
  alphaAlgorithm?: string; // Algorithm: "embeddings_hybrides" | "heat_diffusion" | "heat_hierarchical" | "bayesian" | "none"
  coldStart?: boolean; // True if in cold start mode
}
```

---

## Observability: Algorithm Tracing Integration (Story 7.6)

Le local alpha est tracé via `AlgorithmTracer` pour l'observabilité et le tuning. Deux points
d'intégration :

### 1. DAGSuggester (Existant)

Les méthodes `selectNextTools()`, `predictFromCommunity()`, `suggestCapabilities()` tracent déjà les
décisions avec les signaux local alpha.

### 2. GraphRAGEngine.searchToolsHybrid (Nouveau)

Ajout du traçage pour couvrir les appels directs via l'API `/api/search` :

```typescript
// src/graphrag/graph-engine.ts

// Nouveau setter pour injecter le tracer
setAlgorithmTracer(tracer: AlgorithmTracer): void {
  this.algorithmTracer = tracer;
}

// Dans searchToolsHybrid(), après sélection des topResults :
if (this.algorithmTracer) {
  for (const result of topResults) {
    this.algorithmTracer.logTrace({
      algorithmMode: "active_search",
      targetType: "tool",
      intent: query.substring(0, 200),
      signals: {
        semanticScore: result.semanticScore,
        graphScore: result.graphScore,        // Nouveau signal
        graphDensity: density,
        spectralClusterMatch: false,
        localAlpha: breakdown.alpha,
        alphaAlgorithm: breakdown.algorithm,  // ADR-048
        coldStart: breakdown.coldStart,       // ADR-048
      },
      params: { alpha: breakdown.alpha, reliabilityFactor: 1.0, structuralBoost: 0 },
      finalScore: result.finalScore,
      thresholdUsed: 0.5,
      decision: "accepted",
    });
  }
}
```

### Signal `graphScore` ajouté

Le signal `graphScore` a été ajouté à `AlgorithmSignals` pour tracer le score de proximité graphe
(Adamic-Adar / edges directs) :

```typescript
// src/telemetry/algorithm-tracer.ts
export interface AlgorithmSignals {
  // ... existing fields
  graphScore?: number; // Graph relatedness score (Adamic-Adar / direct edges)
}
```

### Couverture de traçage

| Composant                         | Trace local alpha ?        |
| --------------------------------- | -------------------------- |
| DAGSuggester.selectNextTools      | ✅                         |
| DAGSuggester.predictFromCommunity | ✅                         |
| DAGSuggester.suggestCapabilities  | ✅                         |
| GraphRAGEngine.searchToolsHybrid  | ✅ (Nouveau)               |
| GatewayServer /api/search         | ✅ (via searchToolsHybrid) |

---

## Integration: Replacing Global Density Weights (ADR-026)

L'ancienne méthode `getAdaptiveWeights()` basée sur la densité globale a été remplacée par le local
alpha dans `suggestDAG()`:

### Avant (ADR-026)

```typescript
// Global density → same weights for all candidates
private getAdaptiveWeights(): { hybrid: number; pageRank: number; path: number } {
  const density = this.graphEngine.getGraphDensity();  // GLOBAL
  if (density < 0.01) return { hybrid: 0.85, pageRank: 0.05, path: 0.10 };
  if (density < 0.10) return { hybrid: 0.65, pageRank: 0.20, path: 0.15 };
  return { hybrid: 0.55, pageRank: 0.30, path: 0.15 };
}
```

### Après (ADR-048)

```typescript
// Local alpha per candidate → averaged for confidence
private getAdaptiveWeightsFromAlpha(avgAlpha: number): { hybrid: number; pageRank: number; path: number } {
  const factor = (avgAlpha - 0.5) * 2;  // Normalize 0.5-1.0 → 0-1

  // High alpha → trust semantic more, low alpha → trust graph more
  return {
    hybrid: 0.55 + factor * 0.30,     // [0.55, 0.85]
    pageRank: 0.30 - factor * 0.25,   // [0.05, 0.30]
    path: 0.15 - factor * 0.05,       // [0.10, 0.15]
  };
}
```

**Avantages:**

- Cohérent: même alpha local pour Active Search et Passive Suggestions
- Granulaire: chaque candidat contribue son alpha local à la moyenne
- Interprétable: les traces incluent `localAlpha` et `alphaAlgorithm`

---

## Consequences

### Positives

- **Cohérent avec ADR-038** : Même pattern (algo par mode/type)
- **Harmonisé avec suggestDAG()** : Remplace l'ancienne densité globale (ADR-026)
- **Chaque algo optimisé pour son cas** : Pas de compromis one-size-fits-all
- **Cold start géré explicitement** : Bayésien évite les faux positifs
- **Interprétable** : On sait quel algo est utilisé et pourquoi

### Négatives

- **4 algorithmes à maintenir** : Plus complexe qu'un algo unique
- **Transitions** : Passage cold start → normal peut créer des discontinuités

### Risques

- **Performance** : Embeddings Hybrides requiert 2 embeddings → Mitigé par cache
- **Tuning** : Poids dans Heat Diffusion à ajuster → Valeurs par défaut raisonnables

---

## Métriques de Succès

| Métrique                                 | Avant      | Après (cible)        |
| ---------------------------------------- | ---------- | -------------------- |
| Variance des alphas                      | 0 (global) | > 0.1 (distribution) |
| Précision Active Search                  | ~70%       | > 85%                |
| Précision Passive Suggestion zone dense  | ~70%       | > 85%                |
| Précision Passive Suggestion zone sparse | ~60%       | > 75%                |
| Cold start false positives               | N/A        | < 5%                 |

---

## References

- [Hypergraph Signal Processing](https://arxiv.org/abs/2003.08034)
- [Heat Diffusion on Graphs](https://arxiv.org/abs/1205.6347)
- [Spectral Graph Theory](https://mathweb.ucsd.edu/~fan/research/revised.html)
- ADR-038: Scoring Algorithms Reference
- ADR-042: Capability-to-Capability Hyperedges
- ADR-049: Intelligent Adaptive Thresholds (utilise local alpha pour ajuster les thresholds
  d'exécution)
