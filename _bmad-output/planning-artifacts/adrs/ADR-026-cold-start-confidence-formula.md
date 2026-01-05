# ADR-026: Cold Start Confidence Formula for DAG Suggestions

**Status:** ✅ Implemented **Date:** 2025-12-02

## Context

### Problème Découvert (2025-12-02)

L'intent-based DAG suggestion retournait `confidence: 0` même quand la recherche sémantique trouvait
des outils pertinents avec des scores élevés (0.72+).

**Exemple (avant fix):**

```
Intent: "Read the deno.json file"
search_tools result: filesystem:read_text_file (semantic_score: 0.72)
execute_dag result: {"mode": "explicit_required", "confidence": 0}
```

### Cause Racine

La formule de confidence dans `dag-suggester.ts` donnait 30% du poids au PageRank:

```typescript
confidence = hybridScore * 0.55 + pageRankScore * 0.30 + pathStrength * 0.15;
```

En **cold start** (graphe vide/sparse):

- `hybridScore` = 0.72 (bon score sémantique)
- `pageRankScore` = 0 (pas de PageRank calculé - graphe vide)
- `pathStrength` = 0.5 (valeur par défaut, pas de chemins)

```
confidence = 0.72 * 0.55 + 0 * 0.30 + 0.5 * 0.15
           = 0.396 + 0 + 0.075
           = 0.471
```

**0.471 < 0.50 (seuil) → `return null` → confidence: 0**

### Impact

- Les utilisateurs ne pouvaient pas utiliser l'intent-based DAG en cold start
- Obligation de fournir un workflow explicite
- Le meta-tool `search_tools` fonctionnait, mais `execute_dag` avec intent échouait

## Decision

Implémenter **Option A + C combinées**:

### 1. Poids Adaptatifs selon Densité du Graphe

Nouvelle méthode `getAdaptiveWeights()` dans `dag-suggester.ts`:

```typescript
private getAdaptiveWeights(): { hybrid: number; pageRank: number; path: number } {
  const density = this.graphEngine.getGraphDensity();

  if (density < 0.01) {
    // Cold start: trust semantic heavily
    return { hybrid: 0.85, pageRank: 0.05, path: 0.10 };
  } else if (density < 0.10) {
    // Growing: balanced
    return { hybrid: 0.65, pageRank: 0.20, path: 0.15 };
  } else {
    // Mature: current formula (ADR-022)
    return { hybrid: 0.55, pageRank: 0.30, path: 0.15 };
  }
}
```

| Densité | Phase      | Hybrid | PageRank | Path |
| ------- | ---------- | ------ | -------- | ---- |
| <0.01   | Cold start | 85%    | 5%       | 10%  |
| <0.10   | Growing    | 65%    | 20%      | 15%  |
| ≥0.10   | Mature     | 55%    | 30%      | 15%  |

### 2. Ne Jamais Retourner Null si Candidats Valides

Au lieu de retourner `null` quand confidence < 0.50, retourner une suggestion avec warning:

```typescript
if (confidence < 0.50) {
  return {
    dagStructure,
    confidence,
    rationale,
    dependencyPaths,
    alternatives,
    warning:
      "Low confidence suggestion - graph is in cold start mode. Confidence may improve with usage.",
  };
}
```

## Résultat

**Après fix:**

```
Intent: "Read the deno.json file"
execute_dag result: {
  "mode": "suggestion",
  "confidence": 0.665,
  "suggested_dag": { ... }
}
```

Nouvelle formule en cold start:

```
confidence = 0.72 * 0.85 + 0.059 * 0.05 + 0.5 * 0.10
           = 0.612 + 0.003 + 0.05
           ≈ 0.665
```

## Fichiers Modifiés

| Fichier                         | Changement                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/graphrag/dag-suggester.ts` | Ajout `getAdaptiveWeights()`, modification `calculateConfidenceHybrid()`, condition ligne 139-159 |
| `src/graphrag/types.ts`         | Ajout `warning?: string` à `SuggestedDAG`                                                         |
| `src/mcp/gateway-handler.ts`    | Propagation du warning dans la réponse                                                            |

## Relations avec autres ADRs

- **ADR-022 (Hybrid Search)**: La formule mature (density ≥ 0.10) reste celle de ADR-022
- **ADR-015 (Dynamic Alpha)**: Même principe d'adaptation selon la densité du graphe
- **ADR-023 (Dynamic Candidate Expansion)**: Proposé mais non encore implémenté, complémentaire

## Consequences

### Positives

- Intent-based DAG fonctionne dès le cold start
- Alignement du comportement entre `search_tools` et `execute_dag`
- Transition fluide vers formule mature quand le graphe se remplit
- Observabilité via le warning dans la réponse

### Négatives

- Peut suggérer des DAGs moins précis en cold start (acceptable car mode "suggestion")
- Légère complexité ajoutée avec les 3 tiers de densité

## Tests de Validation

```bash
# Test manuel validé (2025-12-02)
curl -s -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pml:execute_dag","arguments":{"intent":"Read the deno.json file"}}}'

# Résultat attendu: confidence > 0, mode = "suggestion"
```

## Notes

- Découvert pendant code review Story 6.3
- Le problème était la formule de confidence, pas la recherche sémantique
- La densité du graphe est déjà calculée via `getGraphDensity()` (Story 6.3)
