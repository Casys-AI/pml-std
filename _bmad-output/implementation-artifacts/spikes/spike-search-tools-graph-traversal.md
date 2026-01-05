# Spike: search_tools avec traversée de graphe et Adamic-Adar

## Status

Approved - Ready for implementation

## Contexte

### Architecture existante

Casys PML utilise **graphology** pour les algorithmes de graphe:

```typescript
// src/graphrag/graph-engine.ts
import graphologyPkg from "graphology";
import pagerankPkg from "graphology-metrics/centrality/pagerank.js";
import louvainPkg from "graphology-communities-louvain";
import { bidirectional } from "graphology-shortest-path";
```

**Capacités actuelles:**

- `PageRank` - centralité des outils
- `Louvain` - détection de communautés
- `bidirectional` - shortest path entre outils
- `findCommunityMembers()` - outils dans la même communauté

### Problème actuel

`execute_workflow` mélange deux responsabilités:

1. **Recherche d'outils** (sémantique)
2. **Construction de DAG** (graphe)

Le calcul de confidence combine:

```typescript
const confidence = semanticScore * 0.5 + pageRankScore * 0.3 + pathStrength * 0.2;
```

**Problèmes:**

- PageRank inutile pour chercher UN outil (mesure importance globale, pas pertinence)
- Sans edges (0 edges), PageRank = 1/N pour tous → plombe le score
- Seuil 0.50 trop strict: "screenshot" → 0.48 (semantic 75%, pagerank 2%)

## Research Findings

### Comparaison des algorithmes

| Algorithme      | Usage                             | Verdict pour "related tools"  |
| --------------- | --------------------------------- | ----------------------------- |
| **PageRank**    | Importance globale                | ❌ Pas pour la recherche      |
| **Louvain**     | Grouper en catégories             | ❌ Pas pour la recherche      |
| **Adamic-Adar** | "Tools souvent utilisés ensemble" | ✅ **Meilleur choix**         |
| **Jaccard**     | Similarité simple                 | ⚠️ Fallback si peu de données |

**Pourquoi Adamic-Adar gagne:**

- Voisins communs **rares** comptent plus (si 2 tools sont utilisés avec un tool spécialisé, c'est
  plus significatif qu'avec un tool ubiquitaire)
- Surpasse les autres méthodes de link prediction dans les benchmarks académiques
- **Non disponible dans graphology** → implémentation custom requise

### Architecture recommandée (style Netflix)

```
Pipeline de recherche:
1. Candidate Generation (semantic) → top 50 rapide
2. Re-ranking (graph context) → Adamic-Adar boost
3. Final filtering → top 10
```

### Formule hybride avec alpha adaptatif

```typescript
finalScore = α × semanticScore + (1-α) × graphScore

// α s'adapte au contexte:
// - Pas de contexte tools     → α = 1.0 (pure semantic)
// - Graph pauvre (< 10 edges) → α = 0.8
// - Graph riche (> 50 edges)  → α = 0.5-0.6
```

### Stratégies Cold Start (0 edges)

1. **Synthetic edges** - Similarité des descriptions d'outils (embedding)
2. **Templates** - Workflows courants prédéfinis
3. **Category edges** - Tools du même serveur faiblement connectés

## Proposition

### 1. Nouvel outil `search_tools`

```typescript
// API
{
  "name": "pml:search_tools",
  "arguments": {
    "query": "take a screenshot",
    "limit": 5,
    "include_related": true,  // optional
    "context_tools": ["playwright:navigate"]  // optional: boost related to these
  }
}

// Response
{
  "tools": [
    {
      "tool_id": "playwright:screenshot",
      "server_id": "playwright",
      "semantic_score": 0.85,
      "graph_score": 0.72,
      "final_score": 0.80,
      "related_tools": [
        { "tool_id": "playwright:navigate", "relation": "often_before", "score": 0.72 },
        { "tool_id": "filesystem:write_file", "relation": "often_after", "score": 0.65 }
      ]
    }
  ]
}
```

### 2. Algorithmes à implémenter dans GraphRAGEngine

#### a) Neighbors traversal

```typescript
getNeighbors(toolId: string, direction: 'in' | 'out' | 'both' = 'both'): string[] {
  if (!this.graph.hasNode(toolId)) return [];

  switch (direction) {
    case 'in': return this.graph.inNeighbors(toolId);   // tools BEFORE
    case 'out': return this.graph.outNeighbors(toolId); // tools AFTER
    case 'both': return this.graph.neighbors(toolId);
  }
}
```

#### b) Adamic-Adar (implémentation custom)

```typescript
computeAdamicAdar(toolId: string, limit = 10): Array<{toolId: string, score: number}> {
  if (!this.graph.hasNode(toolId)) return [];

  const neighbors = new Set(this.graph.neighbors(toolId));
  const scores = new Map<string, number>();

  for (const neighbor of neighbors) {
    const degree = this.graph.degree(neighbor);
    if (degree <= 1) continue;

    for (const twoHop of this.graph.neighbors(neighbor)) {
      if (twoHop === toolId) continue;
      scores.set(twoHop, (scores.get(twoHop) || 0) + 1 / Math.log(degree));
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ toolId: id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

#### c) Graph relatedness avec contexte

```typescript
computeGraphRelatedness(
  toolId: string,
  contextTools: string[]
): number {
  if (contextTools.length === 0) return 0;

  let maxScore = 0;
  for (const contextTool of contextTools) {
    // Direct neighbor bonus
    if (this.graph.hasEdge(contextTool, toolId) ||
        this.graph.hasEdge(toolId, contextTool)) {
      maxScore = Math.max(maxScore, 1.0);
      continue;
    }

    // Adamic-Adar score
    const aaScore = this.adamicAdarBetween(toolId, contextTool);
    maxScore = Math.max(maxScore, aaScore);
  }

  return maxScore;
}
```

### 3. Séparation des responsabilités

| Outil              | Rôle                          | Scoring                                       |
| ------------------ | ----------------------------- | --------------------------------------------- |
| `search_tools`     | Trouver des outils pertinents | Semantic + Adamic-Adar (adaptatif)            |
| `execute_workflow` | Construire/exécuter un DAG    | Utilise search_tools + PageRank pour ordering |

### 4. Bootstrap du graphe avec templates

```yaml
# config/workflow-templates.yaml
templates:
  web_research:
    description: "Search and store information"
    edges:
      - [tavily:tavily-search, memory:create_entities]
      - [exa:search, memory:create_entities]
      - [tavily:tavily-extract, filesystem:write_file]

  browser_automation:
    description: "Web scraping and screenshots"
    edges:
      - [playwright:playwright_navigate, playwright:playwright_screenshot]
      - [playwright:playwright_navigate, playwright:playwright_click]
      - [playwright:playwright_click, playwright:playwright_fill]
      - [playwright:playwright_screenshot, filesystem:write_file]

  file_operations:
    description: "Read, process, write files"
    edges:
      - [filesystem:read_file, filesystem:write_file]
      - [filesystem:list_directory, filesystem:read_file]
      - [filesystem:read_multiple_files, filesystem:write_file]

  knowledge_management:
    description: "Store and retrieve knowledge"
    edges:
      - [memory:create_entities, memory:search_nodes]
      - [memory:add_observations, memory:search_nodes]
      - [memory:search_nodes, memory:open_nodes]
```

## Plan d'implémentation

### Fichiers à modifier

1. **`src/graphrag/graph-engine.ts`**
   - `getNeighbors(toolId, direction)`
   - `computeAdamicAdar(toolId, limit)`
   - `computeGraphRelatedness(toolId, contextTools)`
   - `bootstrapFromTemplates(templates)`
   - `getEdgeCount()` - pour alpha adaptatif

2. **`src/mcp/gateway-server.ts`**
   - Ajouter `search_tools` dans la liste des meta-tools
   - Handler `handleSearchTools()`

3. **`config/workflow-templates.yaml`** (nouveau)

### Tests

```bash
# Test search_tools
curl -X POST http://localhost:8080/message \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"pml:search_tools",
    "arguments":{"query":"screenshot","limit":5}
  }}'
```

## Références

- [Graphology documentation](https://graphology.github.io/)
- [Adamic-Adar index (Wikipedia)](https://en.wikipedia.org/wiki/Adamic/Adar_index)
- [Netflix recommendation system architecture](https://netflixtechblog.com/)
- [ADR-013: tools/list semantic filtering](../adrs/ADR-013-tools-list-semantic-filtering.md)
