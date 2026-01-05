# ADR-042: Capability-to-Capability Hyperedges

**Status:** Accepted **Date:** 2025-12-11 **Related:** ADR-038 (Scoring Algorithms), ADR-041
(Hierarchical Traces), ADR-048 (Local Alpha), ADR-049 (Intelligent Thresholds), Story 7.4

## Context

ADR-038 définit les algorithmes de scoring pour Tools et Capabilities en utilisant un **hypergraphe
bipartite** (Tools ↔ Capabilities). Cependant, cette modélisation ignore les relations **entre
capabilities elles-mêmes**.

Avec l'implémentation de la table `capability_dependency`, nous avons maintenant des **hyperedges**
reliant des capabilities :

- `contains` : Capability A inclut Capability B (composition)
- `sequence` : A puis B (ordre temporel)
- `dependency` : A dépend de B (DAG explicite)
- `alternative` : A et B répondent au même intent (interchangeables)

Ces relations sont apprises automatiquement depuis les traces d'exécution (via `parentTraceId`) ou
créées manuellement via l'API.

## Problem

Les algorithmes actuels (ADR-038) n'exploitent pas ces relations :

| Algorithme              | Limitation actuelle                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Spectral Clustering** | Matrice bipartite Tools↔Caps uniquement. Ignore les liens Cap↔Cap.                                                           |
| **Hypergraph PageRank** | Calculé sur la même matrice bipartite. Une capability avec beaucoup de dépendances entrantes n'a pas un PageRank plus élevé. |
| **Capability Match**    | `score = semantic × reliability`. Ne propage pas la fiabilité via les dépendances.                                           |
| **Strategic Discovery** | `ToolsOverlap × StructuralBoost`. N'utilise pas les `alternative` edges pour suggérer des alternatives.                      |

## Decision

### 1. Enrichir la matrice du Spectral Clustering

Modifier `SpectralClusteringManager.buildBipartiteMatrix()` pour inclure les capability→capability
edges :

```typescript
// Après les edges Tool↔Capability existants
const capDeps = await db.query(`
  SELECT from_capability_id, to_capability_id, confidence_score, edge_type
  FROM capability_dependency
  WHERE confidence_score > 0.3
`);

for (const dep of capDeps) {
  const fromIdx = this.capabilityIndex.get(`cap-${dep.from_capability_id}`);
  const toIdx = this.capabilityIndex.get(`cap-${dep.to_capability_id}`);

  if (fromIdx !== undefined && toIdx !== undefined) {
    // Poids selon edge_type (ADR-041)
    const weight = EDGE_TYPE_WEIGHTS[dep.edge_type] * dep.confidence_score;

    // Symétrique pour clustering non-dirigé
    data[fromIdx][toIdx] = Math.max(data[fromIdx][toIdx], weight);
    data[toIdx][fromIdx] = Math.max(data[toIdx][fromIdx], weight);
  }
}
```

**Impact:** Les capabilities fortement liées (dependency, contains) seront dans le même cluster
spectral.

### 2. Hypergraph PageRank avec Cap→Cap edges

Le PageRank doit considérer les liens dirigés entre capabilities :

- Une capability avec beaucoup de `dependency` edges **entrantes** = plus importante
- Une capability `contains` d'autres = "meta-capability" importante

```typescript
// Dans computeHypergraphPageRank(), après la matrice bipartite
// Ajouter les edges dirigés Cap→Cap
for (const dep of capDeps) {
  if (dep.edge_type === "dependency" || dep.edge_type === "contains") {
    // Edge dirigé: from → to (to reçoit du PageRank)
    const fromIdx = this.capabilityIndex.get(dep.from_capability_id);
    const toIdx = this.capabilityIndex.get(dep.to_capability_id);
    if (fromIdx && toIdx) {
      // Contribution au PageRank
      adjacencyMatrix[fromIdx][toIdx] += dep.confidence_score;
    }
  }
}
```

### 3. Propagation de la fiabilité dans le Matcher

Si Capability A `depends on` B, la fiabilité de A dépend de B :

```typescript
// Dans CapabilityMatcher.findMatch()
async function computeTransitiveReliability(capId: string): Promise<number> {
  const deps = await capabilityStore.getDependencies(capId, "from");

  if (deps.length === 0) {
    return 1.0; // Pas de dépendances
  }

  // Minimum des fiabilités des dépendances (chaîne aussi forte que le maillon le plus faible)
  let minReliability = 1.0;
  for (const dep of deps.filter((d) => d.edgeType === "dependency")) {
    const depCap = await capabilityStore.findById(dep.toCapabilityId);
    if (depCap) {
      minReliability = Math.min(minReliability, depCap.successRate);
    }
  }

  return minReliability;
}

// Score final
const transitiveReliability = await computeTransitiveReliability(cap.id);
const reliabilityFactor = baseReliabilityFactor * transitiveReliability;
```

### 4. Suggestion d'alternatives

Les `alternative` edges permettent de suggérer des capabilities équivalentes :

```typescript
// Dans DAGSuggester.discoverStrategicCapabilities()
if (matchedCapability) {
  const alternatives = await capabilityStore.getDependencies(
    matchedCapability.id,
    "both",
  ).filter((d) => d.edgeType === "alternative");

  // Proposer les alternatives avec score légèrement réduit
  for (const alt of alternatives) {
    const altCap = await capabilityStore.findById(alt.toCapabilityId);
    if (altCap && altCap.successRate > 0.7) {
      suggestions.push({
        capability: altCap,
        score: matchedCapability.score * 0.9, // -10% pour alternative
        reason: "alternative_to_match",
      });
    }
  }
}
```

## Weights Summary (Updated from ADR-038)

| Edge Type     | Base Weight | Usage                          |
| ------------- | ----------- | ------------------------------ |
| `dependency`  | 1.0         | DAG explicite, forte liaison   |
| `contains`    | 0.8         | Composition, meta-capability   |
| `alternative` | 0.6         | Même intent, interchangeable   |
| `sequence`    | 0.5         | Ordre temporel, liaison faible |

| Edge Source | Modifier | Condition               |
| ----------- | -------- | ----------------------- |
| `observed`  | ×1.0     | ≥3 observations         |
| `inferred`  | ×0.7     | 1-2 observations        |
| `template`  | ×0.5     | Bootstrap, non confirmé |

## Migration Path

1. **Phase 1 (Done):** Table `capability_dependency` + CRUD + API endpoints
2. **Phase 2 (Done):** Modifier `SpectralClusteringManager` (§1 + §2) - `buildBipartiteMatrix()` et
   `computeHypergraphPageRank()` supportent maintenant les Cap→Cap edges
3. **Phase 3 (Done):** Modifier `CapabilityMatcher` (§3) - `computeTransitiveReliability()`
   implémente la propagation de fiabilité
4. **Phase 4 (Done):** Modifier `DAGSuggester` pour alternatives (§4) - `suggestAlternatives()`
   suggère des capabilities interchangeables

## Consequences

### Positive

- Clustering plus précis (capabilities liées = même cluster)
- PageRank reflète l'importance structurelle des capabilities
- Fiabilité transitive évite de suggérer des chaînes fragiles
- Alternatives enrichissent les suggestions

### Negative

- Complexité accrue du Spectral Clustering (matrice plus dense)
- Requêtes supplémentaires pour la fiabilité transitive (mitigé par cache)
- Cache du clustering doit être invalidé quand des cap→cap edges sont créés

### Risks

- **Cycles dans `contains`:** A contains B contains A → Paradoxe détecté mais toléré (warning)
- **Performance:** Matrice plus grande → O(n³) pour eigendecomposition. Mitigé par cache TTL.

## Integration with ADR-048 & ADR-049

### ADR-048: Local Alpha for Capabilities

Le Heat Diffusion Hiérarchique (ADR-048) pour Capabilities utilise les relations Cap→Cap :

```typescript
// Dans computeHierarchyPropagation() pour Capabilities
case 'capability':
  // 1. Héritage de la meta-capability parente (contient)
  const metaParent = getParent(nodeId, 'meta');

  // 2. NOUVEAU: Propagation via dependency edges (ADR-042)
  const deps = await capabilityStore.getDependencies(nodeId, 'to');
  const depHeat = deps
    .filter(d => d.edgeType === 'dependency')
    .reduce((sum, d) => sum + computeHierarchicalHeat(d.fromCapabilityId, 'capability'), 0);

  return metaParent
    ? computeHierarchicalHeat(metaParent, 'meta') * 0.7 + depHeat * 0.3
    : depHeat;
```

**Impact:** Une capability avec beaucoup de dépendances entrantes a une chaleur plus élevée → alpha
plus bas → graphe plus fiable pour cette capability.

### ADR-049: Intelligent Thresholds for Capabilities

Le système de thresholds (ADR-049) s'applique aussi aux Capabilities :

| Aspect             | Tools                               | Capabilities                        |
| ------------------ | ----------------------------------- | ----------------------------------- |
| **Thompson State** | Per-tool Beta(α,β)                  | Per-capability Beta(α,β)            |
| **Risk Category**  | Pattern matching (delete→dangerous) | Transitive reliability (ADR-042 §3) |
| **Episodic Boost** | algorithm_traces par tool           | algorithm_traces par capability     |

```typescript
// Extension pour Capabilities
function getCapabilityRiskCategory(capId: string): "safe" | "moderate" | "dangerous" {
  // 1. Transitive reliability from ADR-042
  const transitiveReliability = await computeTransitiveReliability(capId);

  // 2. Agrégation des risques des tools contenus
  const tools = await capabilityStore.getTools(capId);
  const maxToolRisk = tools.map((t) => getToolRiskCategory(t.id))
    .reduce((max, r) => riskLevel(r) > riskLevel(max) ? r : max, "safe");

  // Si un tool est dangerous OU reliability < 0.5 → dangerous
  if (maxToolRisk === "dangerous" || transitiveReliability < 0.5) {
    return "dangerous";
  }
  if (maxToolRisk === "moderate" || transitiveReliability < 0.8) {
    return "moderate";
  }
  return "safe";
}
```

## References

- ADR-038: Scoring Algorithms Reference
- ADR-041: Hierarchical Trace Tracking
- ADR-048: Local Alpha (Heat Diffusion utilise Cap→Cap pour propagation)
- ADR-049: Intelligent Thresholds (Risk category hérite des tools contenus + transitive reliability)
- Tech-spec: capability-dependency (implémentation table + API)
