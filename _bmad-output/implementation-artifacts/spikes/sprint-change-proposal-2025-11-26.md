# Sprint Change Proposal: ADR-022 Hybrid Search Integration

**Date:** 2025-11-26 **Auteur:** BMad (via correct-course workflow) **Statut:** En attente
d'approbation **Scope:** Minor (Direct Implementation)

---

## Section 1: Résumé du Problème

### Description du Problème

L'ADR-022 identifie une **dette technique** dans l'architecture Casys PML : la logique de recherche
hybride (Semantic + Adamic-Adar + Graph Neighbors) est implémentée dans
`GatewayServer.handleSearchTools` mais **n'est pas réutilisée** par `DAGSuggester.suggestDAG`.

### Contexte de Découverte

- **Story déclencheur:** Story 5.1 (search_tools - Semantic + Graph Hybrid) - DONE
- **Date:** 2025-11-25
- **Découvert par:** Analyse de l'ADR-022 lors de discussion sur l'architecture

### Evidence

1. **Code source - DAGSuggester** ([dag-suggester.ts:63](src/graphrag/dag-suggester.ts#L63)):
   ```typescript
   // Utilise semantic search SEUL
   const candidates = await this.vectorSearch.searchTools(intent.text, 10, 0.6);
   ```

2. **Code source - GatewayServer**
   ([gateway-server.ts:940-976](src/mcp/gateway-server.ts#L940-L976)):
   ```typescript
   // Logique complète hybride NON partagée
   const alpha = Math.max(0.5, 1.0 - density * 2);
   const graphScore = this.graphEngine.computeGraphRelatedness(result.toolId, contextTools);
   const finalScore = alpha * result.score + (1 - alpha) * graphScore;
   ```

3. **ADR-022** - Status "Proposed" (jamais implémenté)

### Conséquence

Les DAGs suggérés par `DAGSuggester` sont "fragiles" - ils omettent des outils intermédiaires
logiquement nécessaires qui auraient été trouvés par la recherche hybride.

**Exemple concret:**

```
Intent: "Deploy my Node.js app"

GatewayServer (search_tools MCP):
  ✅ Trouve: git_clone, npm_install, npm_build, deploy_prod

DAGSuggester (suggestDAG interne):
  ❌ Trouve: git_clone, deploy_prod (manque npm_install, npm_build)
```

---

## Section 2: Analyse d'Impact

### Impact Epic

| Epic     | Impact   | Description                                          |
| -------- | -------- | ---------------------------------------------------- |
| Epic 5   | Modéré   | Story 5.2 doit intégrer l'extraction comme prérequis |
| Epic 3.5 | Indirect | Speculative Execution bénéficie de meilleurs DAGs    |
| Epic 4   | Aucun    | Pas d'impact                                         |

### Impact Stories

| Story     | Status Actuel | Impact                          |
| --------- | ------------- | ------------------------------- |
| Story 5.1 | done          | Source de la logique à extraire |
| Story 5.2 | drafted       | Ajout Task 0 comme prérequis    |

### Impact Artifacts

| Artifact          | Type de Changement                     |
| ----------------- | -------------------------------------- |
| ADR-022           | Status: Proposed → Accepted            |
| graph-engine.ts   | Nouvelle méthode `searchToolsHybrid()` |
| dag-suggester.ts  | Modification `suggestDAG()`            |
| gateway-server.ts | Refactoring `handleSearchTools()`      |
| story-5.2.md      | Ajout Task 0                           |

### Impact Technique

- **Code:** 3 fichiers TypeScript modifiés
- **Tests:** Nouveaux tests unitaires pour `searchToolsHybrid()`
- **Infrastructure:** Aucun
- **Deployment:** Aucun changement

---

## Section 3: Approche Recommandée

### Option Sélectionnée: Direct Adjustment

**Justification:**

1. Changement localisé (3 fichiers core)
2. La logique existe déjà - simple extraction/refactoring
3. Aucun risque architectural (pattern déjà validé par Story 5.1)
4. Améliore la qualité sans casser l'existant

### Effort et Risque

| Critère         | Évaluation      |
| --------------- | --------------- |
| Effort          | **Low** (~1h15) |
| Risque          | **Low**         |
| Impact Timeline | Aucun           |
| Technical Debt  | Réduit          |

### Alternatives Considérées

| Option         | Verdict    | Raison                            |
| -------------- | ---------- | --------------------------------- |
| Rollback       | Non viable | Rien à rollback                   |
| MVP Review     | Non viable | MVP non impacté                   |
| Nouvelle Story | Rejeté     | Trop overhead pour ~1h de travail |

---

## Section 4: Propositions de Changement Détaillées

### Changement 1: ADR-022 Status Update

**Fichier:** `docs/adrs/ADR-022-hybrid-search-integration.md`

```diff
## Status

- Proposed
+ Accepted
```

---

### Changement 2: GraphRAGEngine - Nouvelle méthode

**Fichier:** `src/graphrag/graph-engine.ts` **Action:** Ajouter après `getStats()`

```typescript
/**
 * Hybrid search combining semantic similarity and graph relatedness
 *
 * Extracted from GatewayServer.handleSearchTools for reuse by DAGSuggester
 * See ADR-022 for rationale.
 */
async searchToolsHybrid(
  vectorSearch: VectorSearch,
  query: string,
  limit: number = 10,
  contextTools: string[] = []
): Promise<Array<{
  toolId: string;
  serverId: string;
  score: number;
  semanticScore: number;
  graphScore: number;
}>> {
  // 1. Semantic search (base candidates)
  const semanticResults = await vectorSearch.searchTools(query, limit * 2, 0.5);

  if (semanticResults.length === 0) return [];

  // 2. Adaptive alpha based on graph density
  const edgeCount = this.getEdgeCount();
  const nodeCount = this.getStats().nodeCount;
  const maxPossibleEdges = nodeCount * (nodeCount - 1);
  const density = maxPossibleEdges > 0 ? edgeCount / maxPossibleEdges : 0;
  const alpha = Math.max(0.5, 1.0 - density * 2);

  // 3. Compute final scores with graph boost
  const results = semanticResults.map((result) => {
    const graphScore = this.computeGraphRelatedness(result.toolId, contextTools);
    const finalScore = alpha * result.score + (1 - alpha) * graphScore;

    return {
      toolId: result.toolId,
      serverId: result.serverId,
      score: finalScore,
      semanticScore: result.score,
      graphScore,
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
```

---

### Changement 3: DAGSuggester - Utiliser Hybrid Search

**Fichier:** `src/graphrag/dag-suggester.ts` **Section:** Méthode `suggestDAG()`, ligne ~63

```diff
async suggestDAG(intent: WorkflowIntent): Promise<SuggestedDAG | null> {
  try {
-   // 1. Vector search for semantic candidates
-   const candidates = await this.vectorSearch.searchTools(intent.text, 10, 0.6);
+   // 1. Hybrid search: semantic + graph relatedness (ADR-022)
+   const hybridResults = await this.graphEngine.searchToolsHybrid(
+     this.vectorSearch,
+     intent.text,
+     10,
+     intent.toolsConsidered || []
+   );
+
+   // Convert to candidate format
+   const candidates = hybridResults.map(r => ({
+     toolId: r.toolId,
+     serverId: r.serverId,
+     score: r.score,
+   }));
```

---

### Changement 4: GatewayServer - Refactoring

**Fichier:** `src/mcp/gateway-server.ts` **Section:** Méthode `handleSearchTools()`, lignes ~940-976

```diff
- // 1. Semantic search (main candidates)
- const semanticResults = await this.vectorSearch.searchTools(query, limit * 2, 0.5);
- // ... logique de calcul alpha et graph score ...
+ // 1. Hybrid search using shared method (ADR-022)
+ const hybridResults = await this.graphEngine.searchToolsHybrid(
+   this.vectorSearch,
+   query,
+   limit,
+   contextTools
+ );

- if (semanticResults.length === 0) {
+ if (hybridResults.length === 0) {
    return { content: [{ type: "text", text: JSON.stringify({ tools: [], message: "No tools found" }) }] };
  }

- // 2. Calculate adaptive alpha ... (SUPPRIMÉ - dans searchToolsHybrid)
- // 3. Compute final scores ... (SUPPRIMÉ - dans searchToolsHybrid)
+ // 2. Format results for MCP response
+ const results = hybridResults.map((result) => ({
+   tool_id: result.toolId,
+   server_id: result.serverId,
+   semantic_score: Math.round(result.semanticScore * 100) / 100,
+   graph_score: Math.round(result.graphScore * 100) / 100,
+   final_score: Math.round(result.score * 100) / 100,
+   related_tools: [],
+ }));
```

---

### Changement 5: Story 5.2 - Ajout Prérequis

**Fichier:** `docs/stories/5-2-workflow-templates-graph-bootstrap.md`

```diff
## Tasks / Subtasks

+ - [ ] Task 0: Extract Hybrid Search logic (ADR-022 prerequisite)
+   - [ ] 0.1: Add `searchToolsHybrid()` method to GraphRAGEngine
+   - [ ] 0.2: Refactor GatewayServer.handleSearchTools to use shared method
+   - [ ] 0.3: Update DAGSuggester.suggestDAG to use hybrid search
+   - [ ] 0.4: Add unit tests for searchToolsHybrid
+   - [ ] 0.5: Update ADR-022 status to "Accepted"
+
- [ ] Task 1: Define YAML schema and parser (AC: #1, #5)
```

---

## Section 5: Plan de Handoff

### Classification du Scope

**MINOR** - Implémentation directe par l'équipe de développement

### Routing

| Rôle         | Responsabilité                   |
| ------------ | -------------------------------- |
| **Dev Team** | Implémentation des 5 changements |
| **Reviewer** | Code review standard             |

### Critères de Succès

1. [ ] `searchToolsHybrid()` implémenté et testé
2. [ ] `DAGSuggester` utilise la nouvelle méthode
3. [ ] `GatewayServer` refactorisé (pas de duplication)
4. [ ] Tests unitaires passent
5. [ ] ADR-022 status = "Accepted"

### Timeline Estimée

| Phase          | Durée |
| -------------- | ----- |
| Implémentation | 1h    |
| Tests          | 15min |
| Review         | 15min |
| **Total**      | ~1h30 |

---

## Approbation

- [x] **Proposé par:** BMad (2025-11-26)
- [x] **Approuvé par:** BMad
- [x] **Date d'approbation:** 2025-11-27

**Statut:** APPROUVÉ - Routed to Dev Team

---

_Document généré par le workflow correct-course BMAD_
