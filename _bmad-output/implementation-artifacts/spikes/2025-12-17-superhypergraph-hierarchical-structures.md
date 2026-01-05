# Spike: SuperHyperGraphs et Structures Hiérarchiques Récursives

**Date:** 2025-12-17 **Author:** Research Analysis **Status:** Research Complete **Related:** Epic 7
(Emergent Capabilities), ADR-042 (Cap→Cap edges) **Complements:**
`2025-12-17-complex-adaptive-systems-research.md`

---

## Executive Summary

Ce spike explore les **SuperHyperGraphs** - une généralisation des hypergraphes permettant des
**structures récursives imbriquées**. Cette théorie formalise exactement ce que Casys PML fait avec
les **meta-capabilities** (capabilities composées d'autres capabilities via l'edge type `contains`).

**Découverte clé:** Le papier DASH (Directed Acyclic SuperHypergraphs) de 2025 fournit une
formalisation théorique complète avec preuves de topological ordering - directement applicable à
notre DAG de capabilities.

---

## 1. Fondements Théoriques

### 1.1 Évolution des Structures de Graphes

```
Graph           →  Hypergraph        →  SuperHyperGraph
(2 nodes/edge)     (n nodes/edge)       (recursive nesting)

A ── B             {A,B,C}              {{A,B}, {C,{D,E}}}
                   hyperedge            superhyperedge contenant
                                        d'autres superhyperedges
```

### 1.2 Définition Formelle (Smarandache 2019-2020)

**Source:**
[Introduction to n-SuperHyperGraph](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4317064)

Un **n-SuperHyperGraph** est défini sur Pⁿ(V) (n-ième powerset de V) :

```typescript
// Casys PML mapping
type SuperVertex = Tool | Capability | MetaCapability; // Niveaux récursifs

interface SuperHyperEdge {
  id: string;
  members: (SuperVertex | SuperHyperEdge)[]; // Récursif !
  type: "uses" | "contains" | "dependency";
}

interface SuperHyperGraph {
  vertices: Map<string, SuperVertex>;
  edges: SuperHyperEdge[];
  // n = niveau de récursion max
  maxNestingLevel: number;
}
```

**Propriétés clés:**

- **SuperVertices:** Groupes de groupes de vertices (nos meta-capabilities)
- **SuperHyperEdges:** Arêtes connectant des groupes de groupes
- **n-levels:** Profondeur de récursion arbitraire

### 1.3 Comparaison avec Casys PML Actuel

| Concept SuperHyperGraph | Casys PML Actuel              | Location                 |
| ----------------------- | ----------------------------- | ------------------------ |
| SuperVertex niveau 0    | Tool                          | `tool-discovery.ts`      |
| SuperVertex niveau 1    | Capability                    | `capability-learner.ts`  |
| SuperVertex niveau 2+   | Meta-Capability               | ADR-042 `contains` edge  |
| SuperHyperEdge          | `contains` + `dependency`     | `spectral-clustering.ts` |
| n-SuperHyperGraph       | Hypergraph bipartite récursif | ADR-038 Strategic Layer  |

**Conclusion:** Casys PML implémente un **n-SuperHyperGraph non-borné** (Tools → Capabilities →
Meta-Caps → Meta-Meta-Caps → ...). La profondeur n'est pas limitée, elle émerge selon les patterns
d'usage.

---

## 2. DASH: Directed Acyclic SuperHyperGraphs

### 2.1 Papier Principal

**Source:**
[Fujita 2025 - DASH Framework](https://www.researchgate.net/publication/392710720_Directed_Acyclic_SuperHypergraphs_DASH_A_General_Framework_for_Hierarchical_Dependency_Modeling)

DASH unifie :

- **DAG** (Directed Acyclic Graph) - notre DAG executor
- **DAH** (Directed Acyclic Hypergraph) - notre hypergraph capabilities
- **SuperHyperGraph** - notre meta-capabilities récursives

### 2.2 Théorèmes Fondamentaux (Prouvés)

```typescript
// Théorème 2.5: Existence d'une Source
// Dans tout DASH fini, ∃ au moins un supervertex v avec In(v) = ∅
function findSources(dash: DASH): SuperVertex[] {
  return dash.vertices.filter((v) => getIncomingEdges(v).length === 0);
}

// Théorème 2.6: Topological Ordering
// Tout DASH fini admet un ordonnancement topologique
function topologicalSort(dash: DASH): SuperVertex[] {
  const sorted: SuperVertex[] = [];
  const visited = new Set<string>();

  function visit(v: SuperVertex) {
    if (visited.has(v.id)) return;
    visited.add(v.id);

    // Visiter récursivement les membres si c'est un SuperVertex composé
    if (v.members) {
      for (const member of v.members) {
        visit(member);
      }
    }

    // Visiter les dépendances
    for (const dep of getDependencies(v)) {
      visit(dep);
    }

    sorted.push(v);
  }

  for (const source of findSources(dash)) {
    visit(source);
  }

  return sorted;
}

// Théorème 2.8: Ordre Partiel par Atteignabilité
// La relation de reachability ≺ forme un ordre partiel strict
interface ReachabilityOrder {
  isReachable(from: SuperVertex, to: SuperVertex): boolean;
  // Propriétés prouvées:
  // - Irreflexive: ¬(v ≺ v)
  // - Transitive: (u ≺ v) ∧ (v ≺ w) → (u ≺ w)
  // - Asymmetric: (u ≺ v) → ¬(v ≺ u)
}
```

### 2.3 Application à Casys PML

Notre DAG de capabilities respecte déjà DASH :

```typescript
// Validation DASH pour meta-capabilities
class DASHValidator {
  validateAcyclicity(capabilities: Capability[]): boolean {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const hasCycle = (cap: Capability): boolean => {
      if (inStack.has(cap.id)) return true; // Cycle détecté
      if (visited.has(cap.id)) return false;

      visited.add(cap.id);
      inStack.add(cap.id);

      // Vérifier les capabilities contenues
      for (const childId of cap.containedCapabilities ?? []) {
        const child = this.getCapability(childId);
        if (hasCycle(child)) return true;
      }

      inStack.delete(cap.id);
      return false;
    };

    return !capabilities.some(hasCycle);
  }

  // Garantie par construction: on ne peut pas créer de meta-capability
  // contenant une capability qui la contient déjà
  enforceDAGOnCreation(parent: Capability, child: Capability): boolean {
    return !this.isAncestor(child, parent);
  }
}
```

---

## 3. SuperHyperGraph Attention Networks (SHGAT)

### 3.1 Concept

**Source:**
[Fujita - SuperHyperGraph Attention Networks](https://engrxiv.org/preprint/download/4994/8515)

Extension de GAT pour SuperHyperGraphs : l'attention se propage à travers les niveaux de récursion.

### 3.2 Architecture Proposée

```typescript
interface SHGATLayer {
  // Attention à 3 niveaux
  toolAttention: AttentionHead[]; // Niveau 0: Tools
  capabilityAttention: AttentionHead[]; // Niveau 1: Capabilities
  metaAttention: AttentionHead[]; // Niveau 2+: Meta-Capabilities
}

class SuperHyperGraphAttention {
  constructor(
    private spectralClustering: SpectralClusteringManager,
    private embedder: Embedder,
    private maxDepth: number = 3,
  ) {}

  async computeRecursiveScore(
    query: string,
    superVertex: SuperVertex,
    depth: number = 0,
  ): Promise<number> {
    if (depth > this.maxDepth) return 0;

    const queryEmbed = await this.embedder.embed(query);
    const vertexEmbed = await this.getEmbedding(superVertex);

    // Attention locale
    const localAttention = cosineSimilarity(queryEmbed, vertexEmbed);

    // Si c'est un SuperVertex composé, agréger récursivement
    if (this.isComposite(superVertex)) {
      const childScores = await Promise.all(
        superVertex.members.map(async (child) => {
          const childScore = await this.computeRecursiveScore(query, child, depth + 1);
          const childEmbed = await this.getEmbedding(child);
          const childAttention = cosineSimilarity(queryEmbed, childEmbed);
          return childScore * childAttention;
        }),
      );

      // Agrégation pondérée par attention
      const aggregatedChildScore = this.weightedMean(childScores, childAttentions);

      // Combiner local + children avec decay par profondeur
      const depthDecay = Math.pow(0.8, depth);
      return (localAttention * 0.4 + aggregatedChildScore * 0.6) * depthDecay;
    }

    return localAttention;
  }

  // Message passing récursif bottom-up puis top-down
  async propagateMessages(graph: SuperHyperGraph): Promise<void> {
    // Phase 1: Bottom-up (feuilles → racines)
    const sorted = topologicalSort(graph);
    for (const vertex of sorted) {
      await this.aggregateFromChildren(vertex);
    }

    // Phase 2: Top-down (racines → feuilles)
    for (const vertex of sorted.reverse()) {
      await this.propagateToChildren(vertex);
    }
  }
}
```

### 3.3 Contexte: Non Utilisé dans SHGAT (Décision 2025-12-22)

> **Note 2025-12-21:** Le papier SHGAT de Fujita est purement théorique et ne traite PAS du contexte
> externe (outils récemment utilisés, conversation active).

**Analyse du papier original:**

- L'attention SHGAT ne considère que les relations **supervertex ↔ superedge** au sein du graphe
- Deux phases d'attention: Vertex→Hyperedge et Hyperedge→Vertex
- Aucun mécanisme pour injecter du contexte externe

**Validation par benchmark (2025-12-22):**

Les benchmarks de précision ont testé l'impact du contextBoost sur les scores SHGAT:

| Mode                    | Top-1 Accuracy | Top-3 Accuracy | MRR     |
| ----------------------- | -------------- | -------------- | ------- |
| Forward (avec context)  | 88.9%          | 100%           | 0.944   |
| Backward (sans context) | 88.9%          | 100%           | 0.944   |
| **Différence**          | **0%**         | **0%**         | **0.0** |

**Conclusion:** Le contextBoost n'apporte **aucune amélioration** mesurable. Le context est donc
retiré de SHGAT.

**Architecture finale (ADR-050):**

```typescript
/**
 * SHGAT scoring is context-free per the original paper.
 * Context (current position) is handled by DR-DSP pathfinding, not here.
 */
scoreAllCapabilities(
  intentEmbedding: number[],
  // contextToolEmbeddings is DEPRECATED and ignored
): AttentionResult[] {
  // Multi-head attention (4 têtes)
  const headScores = [
    intentSim,                    // Head 0: semantic (intent × cap)
    intentSim,                    // Head 1: semantic (intent × cap)
    features.hypergraphPageRank,  // Head 2: structure
    cooccurrence + recency,       // Head 3: temporal
  ];
  return sigmoid(weighted_sum(headScores) * reliabilityMult);
}
```

**Où le contexte EST utilisé:**

- **DR-DSP pathfinding**: `findShortestHyperpath(currentTool, targetTool)` utilise le contexte comme
  point de départ
- **SHGAT**: Ne voit que l'intent et les features du graphe (context-free)

### 3.4 Intégration avec Stack Existante

```typescript
// Dans dag-suggester.ts - Strategic Discovery
async suggestCapabilities(query: string): Promise<ScoredCapability[]> {
  const caps = await this.capabilityStore.getAll();
  const pageRanks = this.spectralClustering.getAllPageRanks();

  const shgat = new SuperHyperGraphAttention(this.spectralClustering, this.embedder);

  const scores = await Promise.all(
    caps.map(async cap => {
      const pageRank = pageRanks.get(cap.id) ?? 0;
      const shgatScore = await shgat.computeRecursiveScore(query, cap);

      return {
        capability: cap,
        score: pageRank * 0.3 + shgatScore * 0.7,  // SHGAT dominant
        components: { pageRank, shgatScore, depth: this.getDepth(cap) }
      };
    })
  );

  return scores.sort((a, b) => b.score - a.score);
}
```

---

## 4. Hyperbolic Hypergraph Neural Networks (H2GNN)

### 4.1 Pourquoi l'Espace Hyperbolique?

**Source:** [H2GNN - arxiv:2412.12158](https://arxiv.org/abs/2412.12158)

Les structures **arborescentes/hiérarchiques** se représentent mieux en espace hyperbolique
qu'euclidien :

```
Espace Euclidien:           Espace Hyperbolique:
  - Croissance linéaire       - Croissance exponentielle
  - Distortion pour arbres    - Embedding naturel des arbres
  - Pas adapté aux hiérarchies - Parfait pour les hiérarchies
```

### 4.2 Hyper-Star Message Passing

H2GNN utilise un schéma de message passing en "étoile" qui expand les hyperedges en hiérarchies :

```typescript
interface HyperStarMessage {
  center: SuperVertex; // Centre de l'étoile (capability)
  rays: SuperVertex[]; // Rayons (tools ou sub-capabilities)
  hyperbolicDistance: number;
}

class H2GNNLayer {
  // Projection dans l'espace hyperbolique (Poincaré ball)
  projectToHyperbolic(embedding: number[]): HyperbolicPoint {
    const norm = vectorNorm(embedding);
    if (norm >= 1) {
      // Clamp to Poincaré ball
      return embedding.map((x) => x * 0.99 / norm);
    }
    return embedding;
  }

  // Distance hyperbolique (plus naturelle pour hiérarchies)
  hyperbolicDistance(a: HyperbolicPoint, b: HyperbolicPoint): number {
    const normA = vectorNorm(a);
    const normB = vectorNorm(b);
    const diff = vectorSubtract(a, b);
    const normDiff = vectorNorm(diff);

    return Math.acosh(
      1 + 2 * (normDiff * normDiff) / ((1 - normA * normA) * (1 - normB * normB)),
    );
  }

  // Message passing en étoile
  async hyperStarPass(hyperedge: SuperHyperEdge): Promise<Map<string, number[]>> {
    const center = this.getCenter(hyperedge);
    const rays = this.getRays(hyperedge);

    const messages = new Map<string, number[]>();

    // Chaque rayon reçoit un message du centre pondéré par distance hyperbolique
    for (const ray of rays) {
      const dist = this.hyperbolicDistance(center.embedding, ray.embedding);
      const attention = Math.exp(-dist); // Proche = plus d'attention
      messages.set(ray.id, this.scaleMessage(center.embedding, attention));
    }

    return messages;
  }
}
```

### 4.3 Pertinence pour Casys PML

| Aspect                         | Pertinence | Justification                                   |
| ------------------------------ | ---------- | ----------------------------------------------- |
| Hiérarchie Tools→Caps→MetaCaps | ⭐⭐⭐     | Structure arborescente naturelle                |
| Distance sémantique            | ⭐⭐       | Embeddings déjà euclidiens, conversion possible |
| Complexité                     | ⭐         | Ajoute du calcul hyperbolique                   |

**Recommandation:** P3 - Intéressant mais pas prioritaire. SHGAT simple suffit d'abord.

---

## 5. Multilevel Hypergraph Partitioning

### 5.1 Algorithme de Coarsening/Refinement

Pour gérer des SuperHyperGraphs très larges, le partitioning multi-niveau est utile :

```typescript
interface MultilevelPartitioner {
  // Phase 1: Coarsening (bottom-up)
  coarsen(graph: SuperHyperGraph): SuperHyperGraph[];

  // Phase 2: Partition au niveau le plus coarse
  partitionCoarsest(graph: SuperHyperGraph, k: number): Partition[];

  // Phase 3: Refinement (top-down)
  refine(partition: Partition, finerGraph: SuperHyperGraph): Partition;
}

class HierarchicalPartitioner implements MultilevelPartitioner {
  // Coarsening: fusionner les capabilities similaires
  coarsen(graph: SuperHyperGraph): SuperHyperGraph[] {
    const levels: SuperHyperGraph[] = [graph];
    let current = graph;

    while (current.vertices.size > this.minSize) {
      const coarser = this.contractSimilarVertices(current);
      levels.push(coarser);
      current = coarser;
    }

    return levels;
  }

  // Contraction basée sur similarité sémantique
  private contractSimilarVertices(graph: SuperHyperGraph): SuperHyperGraph {
    const pairs = this.findSimilarPairs(graph);
    const contracted = new Map<string, SuperVertex>();

    for (const [v1, v2] of pairs) {
      const merged: SuperVertex = {
        id: `${v1.id}+${v2.id}`,
        members: [v1, v2], // SuperVertex !
        embedding: averageEmbeddings(v1.embedding, v2.embedding),
      };
      contracted.set(merged.id, merged);
    }

    return { vertices: contracted, edges: this.contractEdges(graph.edges, contracted) };
  }
}
```

### 5.2 Application: Clustering Hiérarchique de Capabilities

```typescript
// Extension de SpectralClusteringManager pour SuperHyperGraphs
class HierarchicalSpectralClustering extends SpectralClusteringManager {
  // Clustering à plusieurs niveaux
  async computeHierarchicalClusters(): Promise<ClusterHierarchy> {
    const levels: ClusterLevel[] = [];

    // Niveau 0: Clusters de tools
    const toolClusters = await this.clusterTools();
    levels.push({ level: 0, type: "tools", clusters: toolClusters });

    // Niveau 1: Clusters de capabilities (basés sur tools partagés)
    const capClusters = await this.clusterCapabilities();
    levels.push({ level: 1, type: "capabilities", clusters: capClusters });

    // Niveau 2: Clusters de meta-capabilities
    const metaClusters = await this.clusterMetaCapabilities();
    levels.push({ level: 2, type: "meta-capabilities", clusters: metaClusters });

    return { levels, crossLevelEdges: await this.computeCrossLevelEdges(levels) };
  }
}
```

---

## 6. Comparaison des Approches

| Approche        | Type         | Récursion        | Complexité | Maturité | Pertinence            |
| --------------- | ------------ | ---------------- | ---------- | -------- | --------------------- |
| **DASH**        | Théorie      | ✅ Native        | O(V+E)     | 2025     | ⭐⭐⭐ Formalisation  |
| **SHGAT**       | Attention    | ✅ Native        | O(V×d×L)   | 2024     | ⭐⭐⭐ Implémentation |
| **H2GNN**       | Hyperbolic   | ⚠️ Via expansion | O(V×d²)    | 2024     | ⭐⭐ Optionnel        |
| **HeIHNN**      | Interaction  | ❌ Flat          | O(E²)      | 2024     | ⭐ Non adapté         |
| **Multi-level** | Partitioning | ✅ Coarsening    | O(V log V) | Mature   | ⭐⭐ Scaling          |

**Recommandation:** DASH (théorie) + SHGAT (implémentation) + Multi-level (scaling)

---

## 7. Roadmap d'Implémentation

### 7.1 Phase 1: Validation DASH (1-2h)

```yaml
story:
  id: SHG-1
  title: "Implement DASH validation for meta-capabilities"
  acceptance_criteria:
    - DASHValidator class created
    - Acyclicity check on capability creation
    - Topological ordering for execution order
    - Unit tests with nested capabilities
  effort: 1-2h
  priority: P1
```

### 7.2 Phase 2: Full SHGAT avec Attention Apprise (2 semaines)

> **Décision 2025-12-21:** Implémenter le Full SHGAT dès le départ plutôt que la version simplifiée
> (cosine similarity).
>
> **Rationale:** Les traces épisodiques existantes fournissent déjà les données d'entraînement
> nécessaires :
>
> - `episodic_events` : intent, context, tool choisi, outcome (success/failure)
> - Signal supervisé : "quel next step mène au succès ?"
> - Valeur cumulative : l'attention s'améliore avec chaque trace
>
> Investir 2 semaines maintenant évite de refaire le travail plus tard.

```yaml
story:
  id: SHG-2
  title: "Implement Full SHGAT with learned attention"
  acceptance_criteria:
    - SuperHyperGraphAttention class with multi-head attention
    - Learnable weight matrices (W_i, W_j, a)
    - Training loop on episodic_events outcomes
    - Recursive score computation with depth decay
    - Integration with dag-suggester Strategic Discovery
    - ML runtime: @xenova/transformers ou ONNX
  depends_on: SHG-1
  effort: 2 weeks
  priority: P1
  training_data:
    source: episodic_events
    features: [intent_embedding, context_tools, candidate_capability]
    label: outcome (success=1, failure=0)
```

### 7.3 Phase 3: Hierarchical Clustering (1 semaine)

```yaml
story:
  id: SHG-3
  title: "Add hierarchical clustering for SuperHyperGraph"
  acceptance_criteria:
    - HierarchicalSpectralClustering extends SpectralClusteringManager
    - Multi-level cluster visualization
    - Cross-level PageRank propagation
  depends_on: SHG-2
  effort: 1 week
  priority: P3
```

### 7.4 Phase 4 (Optionnel): H2GNN Hyperbolic

```yaml
story:
  id: SHG-4
  title: "Explore hyperbolic embeddings for hierarchy"
  acceptance_criteria:
    - Poincaré ball projection implemented
    - Hyperbolic distance for attention
    - Comparison vs Euclidean performance
  depends_on: SHG-2
  effort: 2 weeks
  priority: P4
```

---

## 8. Références

### Papiers Fondamentaux

- [Smarandache 2019 - n-SuperHyperGraph](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4317064) -
  Théorie fondatrice
- [Fujita 2025 - DASH](https://www.researchgate.net/publication/392710720) - DAG + SuperHyperGraph
- [Fujita - SHGAT](https://engrxiv.org/preprint/download/4994/8515) - Attention sur SuperHyperGraphs

### Papiers Complémentaires

- [H2GNN - arxiv:2412.12158](https://arxiv.org/abs/2412.12158) - Hyperbolic Hypergraph NN
- [HeIHNN - arxiv:2401.15587](https://arxiv.org/abs/2401.15587) - Hyperedge Interactions
- [Hierarchical Message-Passing GNN - arxiv:2009.03717](https://arxiv.org/abs/2009.03717)

### Ressources

- [Awesome-Hypergraph-Network](https://github.com/gzcsudo/Awesome-Hypergraph-Network) - Liste
  curated
- [Fujita & Smarandache - SuperHyperGraph Classes](https://digitalrepository.unm.edu/nss_journal/vol77/iss1/29/)

---

## 9. Conclusion

Casys PML implémente un **n-SuperHyperGraph non-borné** via les meta-capabilities récursives
(ADR-042 `contains`). La théorie DASH de 2025 formalise exactement cette structure avec des preuves
de propriétés (topological ordering, sources, ordre partiel).

**Actions immédiates:**

1. Valider que notre implémentation respecte DASH (acyclicité garantie)
2. Implémenter SHGAT pour attention récursive sur meta-capabilities
3. Documenter notre système comme un "Directed Acyclic n-SuperHyperGraph"

**Positionnement:** Nous sommes parmi les premiers à appliquer SuperHyperGraph + Attention à un
système de production (vs théorie pure des papiers).
