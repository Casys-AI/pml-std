# Spike: Dijkstra avec Capabilities comme noeuds intermédiaires

## Status

**Conclu** - Architecture finale définie

## Contexte

### Distinction des deux modes de suggestion

| Mode                       | Fonction            | Input                                  | Output                   | Algorithme                           |
| -------------------------- | ------------------- | -------------------------------------- | ------------------------ | ------------------------------------ |
| **Suggestion DAG complet** | `suggest()`         | Intent seul                            | DAG complet ordonné      | Vector search → Dijkstra N×N         |
| **Prediction passive**     | `predictNextNode()` | Intent + Context (tools déjà exécutés) | Prochain tool/capability | Voisins du contexte + boost spectral |

**Point clé** : La prediction passive a le contexte des tasks précédentes, donc elle peut utiliser
les edges directs depuis les tools du contexte. La suggestion DAG complète n'a que l'intent, donc
Dijkstra doit découvrir les chemins entre tools non encore connectés.

**Note** : `suggestDAG()` utilise bien les historiques via les edges `tool_dependency` appris des
traces passées (avec `observed_count` et `edge_source`). Le graphe Graphology est enrichi par les
exécutions observées.

### Architecture actuelle

Le DAG Suggester utilise Dijkstra pour trouver les chemins entre tools candidats :

```typescript
// dag/builder.ts:48-49
const path = findShortestPath(graph, candidateTools[j], candidateTools[i]);
```

Le graphe Graphology contient :

- **Nodes Tools** : `serena__list_dir`, `git__commit`, etc.
- **Nodes Capabilities** : `capability:{uuid}` (chargés depuis `capability_dependency`)
- **Edges Tool→Tool** : depuis `tool_dependency`
- **Edges Capability→Capability** : depuis `capability_dependency` (avec `contains`, `sequence`)

### Ce qui existe déjà (mais n'est pas synchronisé)

Le **Spectral Clustering** (`spectral-clustering.ts:175-206`) construit déjà une matrice bipartite
Tool↔Capability :

```typescript
// Utilise cap.toolsUsed pour créer les edges
for (const cap of capabilities) {
  for (const toolId of cap.toolsUsed) {
    data[toolIdx][capIdx] = 1; // bidirectionnel
    data[capIdx][toolIdx] = 1;
  }
}
```

Cette donnée (`dag_structure.tools_used`) existe mais n'est **pas synchronisée vers le graphe
Graphology** utilisé par Dijkstra.

### Problème réel identifié

**Ce n'est pas juste l'absence d'edges Tool↔Capability, c'est la sémantique des edge types :**

| Edge Type    | Sémantique                                    | Utilité pour Dijkstra                           |
| ------------ | --------------------------------------------- | ----------------------------------------------- |
| `dependency` | A doit s'exécuter avant B                     | ✅ Ordre causal explicite                       |
| `provides`   | A fournit des données à B                     | ✅ **Data flow = vraie dépendance (dependsOn)** |
| `sequence`   | A vient temporellement avant B dans une trace | ⚠️ Ordre observé, pas causal                    |
| `contains`   | Tool A est dans Capability X                  | ❌ Juste appartenance                           |

**Seul `provides` définit une vraie relation `dependsOn`** : si A provides B, alors B dépend de A.

**Ajouter des edges `contains` bidirectionnels ne résout pas le problème** car `contains` ne dit
rien sur l'ordre d'exécution.

### La vraie source de dépendances : `static_structure`

Les capabilities ont une `static_structure` (`capabilities/types.ts:477-479`) qui contient les
**vraies dépendances** :

```typescript
interface StaticStructureEdge {
  from: string;
  to: string;
  type: "sequence" | "provides" | "conditional" | "contains";
}
```

Ces edges `provides`/`sequence` dans `static_structure.edges` représentent les dépendances réelles
entre tools au sein d'une capability.

## Limitations connues

### Dijkstra et Hypergraph

**Dijkstra standard ne supporte PAS les hyperedges.** Il fonctionne sur un graphe classique (arêtes
binaires).

| Structure                       | Type                      | Compatible Dijkstra      |
| ------------------------------- | ------------------------- | ------------------------ |
| **Graphe Graphology**           | Arêtes binaires Tool→Tool | ✅ Oui                   |
| **Matrice Spectral Clustering** | Bipartite Tool↔Cap        | ❌ Non (matrice séparée) |
| **Hyperedges (ADR-042)**        | N-aires Cap→{Tools}       | ❌ Non                   |

L'Option E ajoute des arêtes **Tool→Tool** (binaires depuis static_structure), donc compatible avec
Dijkstra.

### Proposition de Capabilities vs Tools

**Problème** : L'Option E enrichit le graphe avec des arêtes Tool→Tool. Dijkstra trouve des chemins
entre tools, pas des capabilities.

**Exemple** : Si capability "backup_workflow" contient [read_file, compress, upload] :

- Dijkstra trouve : `read_file → compress → upload`
- On propose : 3 tasks individuelles, pas la capability

**Solution** : Combiner Option E + Option C (post-processing)

1. Option E : Dijkstra découvre les chemins via les arêtes `provides`
2. Option C : Après buildDAG, détecter si une capability "couvre" le chemin trouvé et la proposer à
   la place

```typescript
// Post-processing après buildDAG
const dag = buildDAG(graph, candidateTools);
const coveredCapabilities = findCoveringCapabilities(dag.tasks, capabilityStore);
if (coveredCapabilities.length > 0) {
  // Proposer capability au lieu des tasks individuelles
  return { ...dag, suggestedCapabilities: coveredCapabilities };
}
```

### Dijkstra n'est peut-être pas le bon algorithme

**Problème fondamental** : Dijkstra ne comprend pas les "super edges" (capabilities) comme points
d'arrivée.

**Exemple** :

```
Capability X = [A → B → C]
Tool D dépend de la Capability X (pas juste de C)

Dijkstra voit : A → B → C → D (chemin linéaire)
Sémantiquement : X → D (la capability entière est le prérequis)
```

Quand un tool D dépend d'une capability X, il ne dépend pas juste du dernier tool de X, mais de
**l'exécution complète de X**.

### Algorithmes existants à explorer

| Algorithme                                                                   | Concept                                                                        | Applicable                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| **[Dynamic Shortest Path for Hypergraphs](https://arxiv.org/abs/1202.0082)** | Premier algo pour shortest path sur hypergraphes dynamiques. HE-DSP et DR-DSP. | ✅ **Recommandé** - natif hypergraph |
| **[Higher-order shortest paths](https://arxiv.org/html/2502.03020)**         | Paper 2025 sur les hyperpaths                                                  | ✅ Très récent                       |
| ~~**Contraction Hierarchies**~~                                              | Préprocessing pour graphes routiers                                            | ❌ Pas adapté aux hypergraphes       |
| **[HPA* / HSP](https://www.cs.ubc.ca/~mack/Publications/FICCDAT07.pdf)**     | Partition en clusters, pathfinding à 2 niveaux                                 | ⚠️ Graphes classiques                |

**Complexité du Shortest Hyperpath** :

- **Général** : NP-hard à approximer
- **DAG (acyclique)** : **Polynomial** ✅

Nos capabilities forment un DAG → l'algo polynomial s'applique !

**Concept clé : Hyperpath**

> "A hyperpath between u and v is a sequence of hyperedges {e0, e1,...,em} such that u∈e0, v∈em, and
> ei∩ei+1 ≠∅"

Traduction : Un hyperpath traverse des hyperedges consécutives qui partagent au moins un nœud.

### Détails des algorithmes HE-DSP et DR-DSP

**Sources** : [HAL Inria](https://inria.hal.science/hal-00763797),
[IEEE Xplore](https://ieeexplore.ieee.org/document/6260461/)

Ces deux algorithmes sont les **premiers à résoudre le problème du shortest path dynamique sur
hypergraphes généraux**. Ils se complètent selon le type de dynamique du graphe.

#### HE-DSP (HyperEdge-based Dynamic Shortest Path)

Extension de l'algorithme de Gallo pour les hypergraphes.

| Aspect               | Description                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------- |
| **Complexité**       | O(\|δ\| log \|δ\| + \|δΦ\|) pour weight increase/decrease                                    |
| **Optimisé pour**    | Hypergraphes **denses** avec hyperedges de **haute dimension**                               |
| **Quand l'utiliser** | Changements fréquents sur des hyperedges qui ne sont **pas** sur les shortest paths courants |
| **Cas d'usage**      | Réseau avec changements aléatoires de topologie/poids                                        |

#### DR-DSP (Directed Relationship Dynamic Shortest Path)

| Aspect               | Description                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Complexité**       | Même complexité statique que Gallo, meilleure dynamique quand les paths changent souvent                   |
| **Optimisé pour**    | Réseaux où les changements d'hyperedges **impactent souvent** les shortest paths                           |
| **Quand l'utiliser** | Hyperedges sur les shortest paths sont plus sujets aux changements (attaques, usage fréquent, maintenance) |
| **Cas d'usage**      | Réseau avec changements ciblés sur les chemins critiques                                                   |

#### Application à Casys PML

| Critère               | HE-DSP                                                     | DR-DSP                                                                    |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Notre cas**         | ⚠️ Nos capabilities sont relativement petites (2-10 tools) | ✅ Les edges `provides` changent quand on observe de nouvelles exécutions |
| **Dynamique typique** | -                                                          | Les shortest paths changent quand on apprend de nouvelles dépendances     |
| **Recommandation**    | -                                                          | **DR-DSP semble plus adapté** à notre cas                                 |

**Note** : Ces algos calculent le shortest path en temps **polynomial par rapport à la taille du
changement**, pas du graphe entier. Idéal pour les mises à jour incrémentales après observation
d'exécutions.

### Pourquoi l'algo natif hypergraph > Contraction Hierarchies

- Contraction Hierarchies = optimisé pour graphes routiers (millions de nœuds)
- Notre cas = hypergraphe de capabilities (centaines de nœuds)
- L'algo natif comprend les hyperedges comme unités atomiques

**Pistes à explorer** :

1. **Contracted Graph / Hierarchical Pathfinding**
   - Contracter les capabilities en "super-nœuds"
   - Dijkstra trouve des chemins entre super-nœuds
   - Expansion ensuite pour l'exécution

2. **Hypergraph Traversal dédié**
   - Algorithme qui comprend les hyperedges comme unités atomiques
   - Peut "sauter" directement à une capability comme destination

3. **Two-phase approach**
   - Phase 1 : Dijkstra sur le graphe contracté (capabilities comme nœuds)
   - Phase 2 : Expansion des capabilities sélectionnées en tasks

```typescript
// Contracted graph approach
interface ContractedNode {
  type: "tool" | "capability";
  id: string;
  // Si capability: tools contenus
  containedTools?: string[];
}

function buildContractedGraph(tools: Tool[], capabilities: Capability[]): Graph {
  // Ajouter capabilities comme super-nœuds
  for (const cap of capabilities) {
    graph.addNode(`cap:${cap.id}`, { type: "capability", containedTools: cap.toolsUsed });
  }

  // Edges: Tool → Capability (si tool est le dernier de la cap)
  // Edges: Capability → Tool (si tool dépend de la cap entière)
  // Edges: Capability → Capability (depuis capability_dependency)
}
```

**Question ouverte** : Comment savoir si D dépend de C (le tool) ou de X (la capability) ?

- Via `capability_dependency` table ?
- Via analyse des `provides` dans static_structure ?
- Via observation des exécutions passées ?

## Questions de recherche

1. ~~**Sémantique** : Que signifie un chemin `tool → capability → tool` ?~~
   - **Réponse** : `contains` = appartenance, pas d'ordre. Seul `provides` = vraie dépendance.

2. **Performance** : Quel impact sur le nombre d'edges si on extrait les static_structure ?
   - À mesurer : combien d'edges `provides` dans les capabilities existantes ?

3. ~~**Architecture** : Comment préserver la séparation bipartite (ADR-042) ?~~
   - **Réponse** : On n'ajoute pas des edges Tool↔Capability, on ajoute des edges Tool→Tool depuis
     les static_structures.

## Options à explorer

### Option A : Cross-edges Tool↔Capability (contains) ❌

Ajouter des edges bidirectionnels `contains` entre tools et leurs capabilities.

**Problème** : `contains` ne représente pas une dépendance d'exécution. Un chemin via `contains` ne
garantit pas l'ordre.

### Option B : Graphe multi-layer ❌

Complexité excessive pour un gain incertain.

### Option C : Post-processing intelligent

Après Dijkstra, analyser le chemin pour détecter si une capability "couvre" plusieurs nodes
consécutifs.

**Avantages** : Pas de changement au graphe **Inconvénients** : Pas de vraie découverte de chemins,
juste remplacement post-hoc

### Option D : Hypergraph pathfinding natif ❌

Changement d'architecture majeur, pas de lib existante.

### Option E : Extraire les edges `provides` depuis static_structure ✅ RECOMMANDÉE

Enrichir le graphe Graphology avec les vraies dépendances (`provides` = data flow) extraites des
`static_structure` des capabilities.

**Note** : On n'extrait que `provides`, pas `sequence`. `sequence` représente l'ordre temporel
observé dans une trace, pas une vraie dépendance causale.

```typescript
// Dans db-sync.ts - après le sync des capabilities
const caps = await db.query(`
  SELECT pattern_id, dag_structure->'static_structure' as static_structure
  FROM workflow_pattern
  WHERE dag_structure->'static_structure' IS NOT NULL
`);

for (const cap of caps) {
  const structure = JSON.parse(cap.static_structure);
  if (!structure?.edges) continue;

  // Map node IDs to tool IDs
  const nodeToTool = new Map<string, string>();
  for (const node of structure.nodes || []) {
    if (node.type === "task" && node.tool) {
      nodeToTool.set(node.id, node.tool);
    }
  }

  // Extract ONLY provides edges (data flow = real dependency)
  for (const edge of structure.edges) {
    if (edge.type !== "provides") continue; // Only provides, not sequence

    const fromTool = nodeToTool.get(edge.from);
    const toTool = nodeToTool.get(edge.to);

    if (fromTool && toTool && graph.hasNode(fromTool) && graph.hasNode(toTool)) {
      if (!graph.hasEdge(fromTool, toTool)) {
        graph.addEdge(fromTool, toTool, {
          edge_type: "provides",
          edge_source: "template", // vient d'une capability, pas encore observé
          weight: EDGE_TYPE_WEIGHTS["provides"] * EDGE_SOURCE_MODIFIERS["template"],
          // 0.7 * 0.5 = 0.35 (poids faible, sera renforcé si observé)
        });
      }
    }
  }
}
```

**Avantages** :

- Réutilise les données existantes (static_structure)
- Sémantique correcte (`provides` = data flow = `dependsOn`)
- Compatible avec le système de poids existant (edge_source = "template" → "observed")
- Dijkstra fonctionne tel quel

**Inconvénients** :

- Dépend de la qualité des static_structure existantes
- Les edges sont "template" (poids 0.35) jusqu'à observation (poids 0.7)

## Critères de décision

| Critère                     | Poids | Option C | Option E |
| --------------------------- | ----- | -------- | -------- |
| Simplicité d'implémentation | 30%   | +        | ++       |
| Performance                 | 20%   | ++       | +        |
| Sémantique claire           | 25%   | +        | ++       |
| Compatibilité existante     | 25%   | +        | ++       |

**Recommandation** : Option E (extraction static_structure) avec fallback Option C
(post-processing).

## Prochaines étapes

### Court terme (Option E + C)

1. [ ] Mesurer combien de capabilities ont des static_structure avec edges `provides`
2. [ ] Implémenter Option E dans db-sync.ts
3. [ ] Ajouter tests unitaires pour le nouveau sync
4. [ ] Benchmark performance avant/après (nombre d'edges, temps de sync)

### Moyen terme (Algorithme natif hypergraph)

5. [ ] Lire le paper [Dynamic Shortest Path for Hypergraphs](https://arxiv.org/abs/1202.0082) -
       HE-DSP et DR-DSP
6. [ ] Lire le paper récent [Higher-order shortest paths](https://arxiv.org/html/2502.03020) (2025)
7. [ ] Chercher si une lib JS/TS existe pour hypergraph pathfinding
8. [ ] Sinon, implémenter l'algo polynomial pour DAG hypergraphs
9. [ ] Définir comment détecter si un tool dépend d'une capability (pas juste du dernier tool)

## Références

- ADR-042: Capability-to-Capability Hyperedges
- ADR-048: Local Alpha (Heat Diffusion)
- `src/graphrag/dag/builder.ts` - buildDAG avec Dijkstra
- `src/graphrag/algorithms/pathfinding.ts` - findShortestPath
- `src/graphrag/sync/db-sync.ts` - chargement du graphe
- `src/graphrag/prediction/capabilities.ts` - injectMatchingCapabilities

## Conclusion - Architecture Finale

### Décision

Remplacer Dijkstra par des algorithmes natifs hypergraph. Architecture unifiée où **tout est
capability** (tools = capabilities atomiques).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ARCHITECTURE FINALE UNIFIÉE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. SEARCH (Active) - pml_discover(intent) [Story 10.6]                     │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │   score = semantic × reliability                                  │       │
│  │   - Formule simplifiée (pas de context → pas de graph)           │       │
│  │   - Unified pour tools ET capabilities                           │       │
│  │   - Reliability = calculateReliabilityFactor(successRate)        │       │
│  │   - Graph (Adamic-Adar) = 0 sans context nodes                   │       │
│  └──────────────────────────────────────────────────────────────────┘       │
│                                                                             │
│  2. PREDICTION (Passive) - predictNextNode(intent, context)                 │
│  ┌──────────────┐    ┌──────────────┐                                       │
│  │   DR-DSP     │ →  │    SHGAT     │ → Ranked candidates                   │
│  │ (candidats)  │    │  (scoring)   │                                       │
│  └──────────────┘    └──────────────┘                                       │
│                       │                                                     │
│                       ▼                                                     │
│           ┌─────────────────────────────────────┐                           │
│           │  SHGAT Features (multi-head):       │                           │
│           │  - Spectral Cluster (hypergraph)    │                           │
│           │  - Hypergraph PageRank              │                           │
│           │  - Co-occurrence (episodic)         │                           │
│           │  - Recency                          │                           │
│           │  - Reliability                      │                           │
│           └─────────────────────────────────────┘                           │
│                                                                             │
│  3. SUGGESTION (DAG) - suggestDAG(intent)                                   │
│  ┌──────────────┐                                                           │
│  │   DR-DSP     │ → DAG complet (shortest hyperpath)                        │
│  └──────────────┘                                                           │
│                                                                             │
│  Structure sous-jacente : DASH (Directed Acyclic SuperHyperGraph)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Les 4 modes clarifiés

| Mode            | Fonction               | Quand                  | Input           | Algo                   | Story     |
| --------------- | ---------------------- | ---------------------- | --------------- | ---------------------- | --------- |
| **Search**      | `pml_discover()`       | Recherche active       | intent          | semantic × reliability | 10.6      |
| **Suggestion**  | `suggestDAG()`         | Construire un workflow | intent          | DR-DSP                 | 10.7a     |
| **Prediction**  | `predictNextNode()`    | **Post-workflow**      | workflow result | DR-DSP → SHGAT         | 10.7a/b   |
| **Speculation** | `speculateNextLayer()` | **Intra-workflow**     | DAG + context   | Aucun (DAG connu)      | 12.4/12.6 |

**Distinction Prediction vs Speculation (2025-12-22):**

- **Prediction** (`predictNextNode`): Après un workflow terminé, prédit ce que l'utilisateur va
  demander ensuite. Utilise SHGAT + DR-DSP.
- **Speculation** (`speculateNextLayer`): Pendant un workflow, pré-exécute les tasks connues du DAG.
  Pas de prédiction, juste optimisation.

### Unification Tools ↔ Capabilities

**Avant** (asymétrique) :

- Tools : Hybrid Search élaboré (semantic + graph + alpha adaptatif)
- Capabilities : Simple (semantic × reliability)

**Après** (unifié par contexte) :

- Tout est capability (tools = capabilities atomiques)
- **Sans contexte** (`pml_discover`) : `score = semantic × reliability`
- **Avec contexte** (`predictNextNode`) : DR-DSP → SHGAT (pas la formule hybrid)
- Raison : graph score = 0 sans context nodes (Adamic-Adar retourne 0)

### Algorithmes choisis

| Use Case                           | Algorithme                 | Rôle                            | Story     |
| ---------------------------------- | -------------------------- | ------------------------------- | --------- |
| `pml_discover(intent)`             | **semantic × reliability** | Recherche active (sans context) | 10.6      |
| `suggestDAG(intent)`               | **DR-DSP**                 | Pathfinding hyperpath           | 10.7a     |
| `predictNextNode(workflowResult)`  | **DR-DSP + SHGAT**         | Prédiction post-workflow        | 10.7a/b   |
| `speculateNextLayer(dag, context)` | **Aucun**                  | Pré-exécution DAG connu         | 12.4/12.6 |

### Pourquoi ces choix

1. **pml_discover** (Story 10.6)
   - Formule simplifiée : `semantic × reliability`
   - Pas de graph car pas de context nodes (Adamic-Adar retourne 0)
   - Reliability via `calculateReliabilityFactor(successRate)` de unified-search.ts

2. **DR-DSP** (Directed Relationship Dynamic Shortest Path)
   - Natif hypergraph (comprend les capabilities comme hyperedges)
   - Polynomial pour DAG (notre cas)
   - Optimisé pour les changements qui impactent les shortest paths (notre cas : les edges
     `provides` changent à chaque observation)

3. **SHGAT** (SuperHyperGraph Attention Networks)
   - **1 seul modèle** avec multi-head attention
   - Chaque tête apprend un aspect différent (sémantique, structure, temporel)
   - Features d'entrée (hypergraph-specific) :
     - `spectralCluster` : cluster spectral sur l'hypergraph
     - `hypergraphPageRank` : importance sur les hyperedges
     - `cooccurrence` : fréquence co-usage depuis traces épisodiques
     - `recency` : utilisé récemment
     - `reliability` : success rate
   - Score les candidats selon l'intent ET le context

4. **DASH** (Directed Acyclic SuperHyperGraph)
   - Formalisation théorique de notre structure (Tools → Capabilities → Meta-Capabilities)
   - Garantit topological ordering et propriétés d'ordre partiel

### Architecture SHGAT détaillée

```
                ┌─────────────────────────────┐
                │         SHGAT               │
                │   (1 instance, multi-head)  │
                └─────────────────────────────┘
                          │
      ┌───────────────────┼───────────────────┐
      ▼                   ▼                   ▼
┌──────────┐       ┌──────────┐        ┌──────────┐
│  Head 1  │       │  Head 2  │        │  Head 3  │
│ semantic │       │ structure│        │ temporal │
│embedding │       │pagerank  │        │cooccur.  │
│          │       │spectral  │        │recency   │
└──────────┘       └──────────┘        └──────────┘
      │                   │                   │
      └───────────────────┼───────────────────┘
                          ▼
                ┌─────────────────┐
                │  Learned Fusion │
                │  (attention)    │
                └─────────────────┘
                          │
                          ▼
                    Final Score
```

**Note** : Les algos de support (Spectral Clustering, Hypergraph PageRank, Co-occurrence) ne sont
plus utilisés directement pour le scoring. Ils fournissent des **features** que SHGAT apprend à
pondérer.

### Distinction Tools vs Capabilities - Algorithmes différents (2025-12-22)

**IMPORTANT:** Les tools et capabilities utilisent des algorithmes différents dans SHGAT:

| Head           | Tools (graph simple)                | Capabilities (hypergraph)              |
| -------------- | ----------------------------------- | -------------------------------------- |
| 0-1 (Semantic) | Cosine similarity                   | Cosine similarity                      |
| 2 (Structure)  | **PageRank + Louvain + AdamicAdar** | Spectral cluster + Hypergraph PageRank |
| 3 (Temporal)   | **Cooccurrence + Recency** (traces) | Cooccurrence + Recency + HeatDiffusion |

**Raison:** Les tools existent dans un **graph simple** (Graphology), tandis que les capabilities
sont des **hyperedges** dans le superhypergraph.

**Implémentation (gateway-server.ts:populateToolFeaturesForSHGAT):**

- PageRank: `graphEngine.getPageRank(toolId)`
- Louvain community: `graphEngine.getCommunity(toolId)`
- AdamicAdar: `graphEngine.computeAdamicAdar(toolId, 1)[0].score`
- Cooccurrence/Recency: Query `execution_trace` table for temporal features

### Relation avec les autres spikes

- `2025-12-17-superhypergraph-hierarchical-structures.md` : Théorie DASH + SHGAT
- `2025-12-17-complex-adaptive-systems-research.md` : Détails implémentation SHGAT (section 4)

### Prochaines étapes

1. [ ] Implémenter DR-DSP pour `suggestDAG()` (remplace Dijkstra)
2. [ ] Intégrer **Full SHGAT** pour `predictNextNode()` (attention apprise sur `episodic_events`)
   - Décision 2025-12-21 : Full SHGAT dès le départ car on a déjà les traces d'entraînement
   - Voir spike `2025-12-17-superhypergraph-hierarchical-structures.md` section 7.2
3. [ ] Valider que la structure respecte DASH (acyclicité garantie)
4. [ ] **Créer le framework de benchmark** pour comparer les algos :
   ```
   tests/benchmarks/
   ├── fixtures/scenarios/     # JSON test data
   ├── tactical/               # Tool-level algos (Louvain, PageRank...)
   ├── strategic/              # Cap-level algos (SHGAT, Spectral...)
   ├── pathfinding/            # DR-DSP vs Dijkstra
   └── utils/                  # Metrics, comparison reports
   ```
5. [ ] Benchmark DR-DSP vs Dijkstra sur les capabilities existantes

---

## Notes de discussion

- 2025-12-21: Identifié lors de l'analyse du flux de suggestion DAG. Dijkstra ne traverse que les
  tools, les capabilities sont un layer séparé.
- 2025-12-21: **Clarification importante** :
  - `suggest()` = intent seul → besoin de Dijkstra pour découvrir les chemins
  - `predictNextNode()` = intent + context → peut utiliser les edges directs depuis le contexte
  - Le spectral clustering (`spectral-clustering.ts:175-206`) construit déjà une matrice bipartite
    Tool↔Capability via `toolsUsed`, mais cette info n'est pas synchronisée vers Graphology
  - `contains` = appartenance, pas d'ordre → inutile pour Dijkstra
  - `sequence` = ordre temporel observé dans une trace → pas une vraie dépendance
  - **Seul `provides` = data flow = vraie relation `dependsOn`**
  - Solution recommandée : extraire les edges `provides` depuis `static_structure.edges` des
    capabilities
- 2025-12-21: **Conclusion finale** : DR-DSP (pathfinding) + SHGAT (scoring) sur structure DASH
- 2025-12-22: **Clarification données d'entraînement SHGAT** :
  - SHGAT s'entraîne sur les **mêmes traces** que le TD Learning (Epic 11)
  - Sources de données :
    - `episodic_events` : event-level, `speculation_start.wasCorrect` comme label
    - `execution_trace` (Epic 11.2) : workflow-level, `executed_path` + `success` comme labels
  - Différence d'approche :
    - TD Learning : formule explicite `V(s) ← V(s) + α(actual - V(s))`
    - SHGAT : réseau d'attention qui apprend les poids automatiquement
  - **Conséquence** : Epic 11 (execution_trace) enrichit les données pour SHGAT ET TD Learning
  - Relation avec APIs : SHGAT/DR-DSP sont les algorithmes **derrière** `pml_discover` (10.6) et
    `pml_execute` (10.7)
- 2025-12-22: **Clarification formules par mode** :
  - `pml_discover` (sans context) → `score = semantic × reliability` (formule simplifiée)
  - `predictNextNode` (avec context) → DR-DSP + SHGAT (pas unified-search)
  - Raison : graphScore = 0 sans context nodes, donc la formule hybrid est inutile
  - Le module `unified-search.ts` n'est utilisé que pour `calculateReliabilityFactor()`
- 2025-12-22: **Distinction Prediction vs Speculation** :
  - `predictNextNode()` = **post-workflow** (après un workflow terminé, prédit le prochain)
  - `speculateNextLayer()` = **intra-workflow** (pendant un workflow, pré-exécute le DAG connu)
  - Intra-workflow n'a pas besoin de prédiction car le DAG est déjà défini (static_structure)
  - Seul post-workflow utilise SHGAT + DR-DSP pour vraie prédiction
- 2025-12-22: **SHGAT en mode Suggestion (backward) - Story 10.7** :
  - Mode Suggestion = `pml_execute(intent)` sans code → construire un DAG
  - Flow: `unifiedSearch(intent)` → TARGET node → DR-DSP backward → dépendances → DAG
  - SHGAT peut scorer les chemins **SANS context** (`contextTools=[]`)
  - Features utilisées: semantic (intent×cap), graph (PageRank, spectralCluster, cooccurrence,
    reliability)
  - Le context n'est qu'un boost optionnel (×0.3), pas requis
  - Après training sur `episodic_events`, SHGAT apprend aussi les patterns de suggestion
  - **Conclusion**: SHGAT utile en forward (predict) ET backward (suggest)
  - Voir ADR-050 section "Clarification: SHGAT avec et sans context"

---

## Proposition : Transformer Attention pour Semantic Heads (2025-12-22)

### Contexte

Actuellement, les semantic heads (0-1) de SHGAT utilisent **cosine similarity** :

```typescript
// shgat.ts:707
const intentSim = this.cosineSimilarity(intentEmbedding, capOriginalEmb);
headScores = [intentSim, intentSim, pagerank, temporal];
```

**Problème** : Cosine est une formule géométrique fixe qui ne capture pas les relations sémantiques
spécifiques au domaine MCP/workflow.

### Proposition : Scaled Dot-Product Attention

Remplacer cosine par une attention apprise (comme dans les transformers) :

```typescript
// Actuel (fixe)
score = cosine(intent, cap)  // angle entre vecteurs

// Proposé (appris)
Q = W_q × intent    // intent comme query
K = W_k × cap       // capability comme key
V = W_v × cap       // capability comme value
score = softmax(Q·K^T / √d) × V  // attention apprise
```

### Avantages

| Aspect         | Cosine (actuel)          | Transformer (proposé)                      |
| -------------- | ------------------------ | ------------------------------------------ |
| **Similarité** | Géométrique fixe         | Apprise sur les traces                     |
| **Domaine**    | Générique (BGE-M3)       | Spécifique MCP/workflow                    |
| **Relations**  | "read" ≠ "write"         | "read" → "write" (appris du contexte file) |
| **Training**   | Aucun                    | `episodic_events` (déjà disponible)        |
| **Cold start** | Fonctionne immédiatement | Besoin de données                          |

### Architecture SHGAT révisée

```
┌───────────────────────────────────────────────────────────┐
│                    SHGAT (avec Transformer)               │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  Semantic Heads (0-1) : TRANSFORMER ATTENTION             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Q = W_q × intent         [hiddenDim × embeddingDim] │  │
│  │  K = W_k × cap_embedding  [hiddenDim × embeddingDim] │  │
│  │  V = W_v × cap_embedding  [hiddenDim × embeddingDim] │  │
│  │                                                       │  │
│  │  attn_score = (Q · K^T) / √hiddenDim                  │  │
│  │  semantic_score = sigmoid(attn_score)                 │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  Structure Head (2) : PageRank + Spectral (inchangé)      │
│  Temporal Head (3) : Co-occurrence + Recency (inchangé)   │
│                                                           │
│  Fusion : Learned attention over heads (existant)         │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### Changements dans shgat.ts

```typescript
// 1. Nouveaux paramètres apprenables
private semanticParams: {
  W_q: number[][];  // [hiddenDim, embeddingDim] = [64, 1024]
  W_k: number[][];  // [hiddenDim, embeddingDim]
  W_v: number[][];  // [hiddenDim, embeddingDim]
};

// 2. Nouvelle méthode (remplace cosineSimilarity pour semantic)
private transformerAttention(intent: number[], cap: number[]): number {
  // Project to hidden dimension
  const Q = this.matVec(this.semanticParams.W_q, intent);  // [64]
  const K = this.matVec(this.semanticParams.W_k, cap);     // [64]

  // Scaled dot-product attention
  const d = Q.length;
  const attnScore = this.dot(Q, K) / Math.sqrt(d);

  return this.sigmoid(attnScore);  // [0, 1]
}

// 3. Dans scoreAllCapabilities (ligne 707)
// Avant:
const intentSim = this.cosineSimilarity(intentEmbedding, capOriginalEmb);
// Après:
const intentSim = this.transformerAttention(intentEmbedding, capOriginalEmb);
```

### Stratégie d'entraînement

Les paramètres `W_q`, `W_k`, `W_v` s'entraînent avec le reste de SHGAT sur `episodic_events` :

```typescript
// Dans trainBatch(), ajouter les gradients pour semantic params
const dW_q = gradients.get("W_q")!;
const dW_k = gradients.get("W_k")!;

// Backprop through attention
// d(attn)/d(W_q) = cap · intent^T / √d
// d(attn)/d(W_k) = intent · cap^T / √d
```

### Fallback Cosine (Cold Start)

Pour le cold start (pas encore de données d'entraînement), on peut utiliser cosine comme fallback :

```typescript
private getSemanticScore(intent: number[], cap: number[]): number {
  if (this.isTransformerTrained) {
    return this.transformerAttention(intent, cap);
  }
  // Fallback to cosine for cold start
  return this.cosineSimilarity(intent, cap);
}
```

### Benchmark POC

Créer un benchmark pour comparer cosine vs transformer :

```
tests/benchmarks/
├── semantic-similarity.bench.ts   # NEW
│   ├── cosine_baseline            # Current implementation
│   ├── transformer_untrained      # Random weights
│   ├── transformer_trained_10ep   # After 10 epochs
│   └── transformer_trained_100ep  # After 100 epochs
```

Métriques à mesurer :

- **Accuracy** : % de bonnes prédictions sur episodic_events holdout
- **MRR** (Mean Reciprocal Rank) : position moyenne de la bonne réponse
- **Latency** : temps d'inférence (cosine ~0.1ms, transformer ~1ms?)

### Décision

**À valider via benchmark POC** avant intégration dans 10.7b.

Si le transformer montre une amélioration significative (>5% accuracy), l'intégrer dans 10.7b avec :

- Estimation révisée : 2-3j (au lieu de 1-2j)
- Fallback cosine pour cold start

---

## Implementation Update (2025-12-22)

### SHGAT Live Learning

SHGAT apprend maintenant **en temps réel** après chaque exécution `pml_execute` (Mode Direct):

```
pml_execute({ intent, code })
  → Exécute code via WorkerBridge
  → saveCapability() (stocke en DB)
  → updateDRDSP() (met à jour le graphe hyperedges)
  → updateSHGAT() (enregistre + entraîne)
    → Génère embedding de l'intent
    → Enregistre nouveaux tools via registerTool()
    → Enregistre capability via registerCapability()
    → trainOnExample({ intent, tools, outcome })
```

**Méthodes ajoutées à SHGAT (shgat.ts):**

- `hasToolNode(toolId)` - vérifie si un tool est déjà enregistré
- `hasCapabilityNode(capabilityId)` - vérifie si une capability existe
- `trainOnExample(example)` - training online sur un seul exemple

**Flow complet:**

1. **Démarrage serveur**: SHGAT initialisé avec capabilities existantes + training sur traces (≥20)
2. **Chaque exécution réussie**: nouvelle capability enregistrée + training immédiat
3. **Résultat**: SHGAT s'améliore continuellement sans redémarrage

### SERVER_TITLE Update

Description du serveur PML mise à jour dans `src/mcp/server/constants.ts`:

```
"PML - Orchestrate any MCP workflow. Use pml_execute with just an 'intent'
(natural language) to auto-discover tools and execute. Or provide explicit
'code' for custom TypeScript workflows. Learns from successful executions."
```

### Fichiers modifiés

- `src/mcp/handlers/execute-handler.ts` - `updateSHGAT()` function
- `src/graphrag/algorithms/shgat.ts` - `hasToolNode()`, `hasCapabilityNode()`, `trainOnExample()`
- `src/mcp/server/constants.ts` - `SERVER_TITLE`
