# Tech Spec: pml_discover API - Unified Search & Context Management

**Status:** 📋 DRAFT **Date:** 2025-12-17 **Authors:** Discussion Claude + User **Related:**
`tech-spec-dag-capability-learning.md`, `search-tools.ts`, `search-capabilities.ts`

---

## Executive Summary

Cette tech spec définit l'API unifiée `pml_discover` qui remplace les outils de recherche fragmentés
(`pml_search_tools`, `pml_search_capabilities`, `pml_find_capabilities`). L'objectif est de fournir
une interface unique, context-efficient, avec progressive disclosure.

### Problèmes actuels

1. **APIs fragmentées** : 3+ outils pour chercher tools/capabilities
2. **Pas de gestion du contexte** : Retourne tout, consomme des tokens inutilement
3. **Pas de résumés** : Capabilities complexes retournées en entier
4. **Pas de progressive disclosure** : Tout ou rien

### Solution

Un seul outil `pml_discover` avec :

- Niveaux de verbosité configurables
- Résumés intelligents pour capabilities multi-parties
- Flow en deux temps (discover → get_details si besoin)
- Optimisation tokens pour l'IA

---

## 1. API Specification

### 1.1 Signature

```typescript
pml_discover({
  // Requête
  intent: string;                    // Ce que l'IA cherche à faire

  // Filtres optionnels
  filter?: {
    type?: "tool" | "capability" | "all";  // default: "all"
    servers?: string[];              // Filtrer par serveur MCP
    minScore?: number;               // Score minimum (0-1)
    tags?: string[];                 // Tags/catégories
  };

  // Contrôle du contexte
  verbosity?: "minimal" | "summary" | "full";  // default: "summary"
  limit?: number;                    // Nombre max de résultats (default: 10)

  // Options avancées
  includeAlternatives?: boolean;     // Inclure les alternatives (edge type)
  includeCoOccurrences?: boolean;    // Inclure les co-occurrences suggérées
})
```

### 1.2 Réponse

```typescript
interface DiscoverResponse {
  results: DiscoverResult[];
  meta: {
    totalFound: number;
    returnedCount: number;
    searchTimeMs: number;
    verbosity: "minimal" | "summary" | "full";
  };
}

interface DiscoverResult {
  // Toujours présent (minimal)
  id: string;
  type: "tool" | "capability";
  intent: string; // 1 phrase descriptive
  score: number; // 0-1, pertinence

  // Présent si verbosity >= "summary"
  summary?: ResultSummary;

  // Présent si verbosity == "full"
  details?: ResultDetails;
}
```

---

## 2. Niveaux de Verbosité

### 2.1 `minimal` - Liste rapide

**Use case :** L'IA veut juste voir ce qui existe, choisir ensuite.

**Tokens :** ~50 par résultat

```json
{
  "results": [
    {
      "id": "cap:sales-analysis",
      "type": "capability",
      "intent": "Analyse des ventes par région",
      "score": 0.92
    },
    { "id": "tool:db:query", "type": "tool", "intent": "Exécuter une requête SQL", "score": 0.85 },
    {
      "id": "cap:data-export",
      "type": "capability",
      "intent": "Export données en PDF/CSV",
      "score": 0.78
    }
  ]
}
```

### 2.2 `summary` - Informations utiles (DEFAULT)

**Use case :** L'IA veut comprendre ce que fait chaque résultat sans le code complet.

**Tokens :** ~150 par résultat

```typescript
interface ResultSummary {
  // Pour les tools
  toolSchema?: {
    requiredParams: string[];
    optionalParams: string[];
    returnType: string; // Description courte
  };

  // Pour les capabilities
  pipeline?: PipelineStep[]; // Vue "étapes" compacte
  toolsUsed?: string[]; // Liste des tools
  inputs?: string[]; // Paramètres attendus
  outputs?: string[]; // Ce que ça retourne

  // Métadonnées communes
  successRate?: number;
  avgDurationMs?: number;
  usageCount?: number;
  lastUsed?: string; // ISO date
}

interface PipelineStep {
  step: number;
  action: string; // "fetch", "transform", "export"...
  tools: string[]; // Tools utilisés dans cette étape
}
```

**Exemple :**

```json
{
  "id": "cap:sales-analysis",
  "type": "capability",
  "intent": "Analyse complète des ventes avec visualisation",
  "score": 0.92,
  "summary": {
    "pipeline": [
      { "step": 1, "action": "fetch", "tools": ["db:query"] },
      { "step": 2, "action": "aggregate", "tools": ["data:groupBy", "data:sum"] },
      { "step": 3, "action": "visualize", "tools": ["chart:bar", "chart:pie"] },
      { "step": 4, "action": "export", "tools": ["pdf:generate"] }
    ],
    "toolsUsed": ["db:query", "data:groupBy", "data:sum", "chart:bar", "chart:pie", "pdf:generate"],
    "inputs": ["dateRange", "regionFilter"],
    "outputs": ["pdfReport", "chartData"],
    "successRate": 0.94,
    "avgDurationMs": 2500,
    "usageCount": 47
  }
}
```

### 2.3 `full` - Tout inclus

**Use case :** L'IA veut voir le code/DAG complet pour comprendre ou modifier.

**Tokens :** ~500-2000 par résultat

**⚠️ Attention :** À utiliser avec parcimonie, consomme beaucoup de contexte.

```typescript
interface ResultDetails {
  // Pour les tools
  fullSchema?: JSONSchema; // Schema JSON complet
  examples?: ToolExample[]; // Exemples d'utilisation

  // Pour les capabilities
  source?: {
    type: "code" | "dag";
    code?: string; // Code complet
    dagStructure?: DAGStructure; // DAG complet
  };
  reconstructedDAG?: DAGStructure; // Si code → DAG inféré
  invocationHistory?: Invocation[]; // Dernières exécutions
}
```

---

## 3. Capabilities Multi-Parties

### 3.1 Problème

Une capability peut être un workflow complexe avec plusieurs étapes. Retourner tout le code est
inefficace.

### 3.2 Solution : Vue Pipeline

On génère automatiquement une vue "pipeline" depuis le DAG/code :

```typescript
function generatePipelineSummary(capability: Capability): PipelineStep[] {
  const dag = capability.reconstructedDAG || capability.dagStructure;
  if (!dag) return [];

  // Grouper les tasks par "layer" (dépendances)
  const layers = computeLayers(dag.tasks);

  return layers.map((layer, idx) => ({
    step: idx + 1,
    action: inferAction(layer.tasks), // "fetch", "transform", etc.
    tools: layer.tasks.map((t) => t.tool),
  }));
}

function inferAction(tasks: Task[]): string {
  // Heuristiques basées sur les noms de tools
  const tools = tasks.map((t) => t.tool.toLowerCase());

  if (tools.some((t) => t.includes("query") || t.includes("fetch") || t.includes("get"))) {
    return "fetch";
  }
  if (tools.some((t) => t.includes("parse") || t.includes("transform") || t.includes("map"))) {
    return "transform";
  }
  if (tools.some((t) => t.includes("aggregate") || t.includes("group") || t.includes("sum"))) {
    return "aggregate";
  }
  if (tools.some((t) => t.includes("chart") || t.includes("plot") || t.includes("render"))) {
    return "visualize";
  }
  if (tools.some((t) => t.includes("export") || t.includes("pdf") || t.includes("csv"))) {
    return "export";
  }
  if (tools.some((t) => t.includes("send") || t.includes("post") || t.includes("write"))) {
    return "output";
  }

  return "process";
}
```

### 3.3 Accès aux sous-parties

Si l'IA veut juste une partie d'une capability :

```typescript
pml_discover({
  intent: "juste la partie visualisation",
  filter: { type: "capability" }
})

// Le système peut suggérer :
{
  "results": [
    // Étape spécifique extraite
    {
      "id": "cap:sales-analysis#step3",
      "type": "capability",
      "intent": "Visualisation des données ventes",
      "score": 0.95,
      "summary": {
        "pipeline": [{ "step": 1, "action": "visualize", "tools": ["chart:bar", "chart:pie"] }],
        "inputs": ["aggregatedData"],
        "outputs": ["chartData"]
      },
      "note": "Extrait de cap:sales-analysis (étape 3/4)"
    },
    // Capability complète aussi proposée
    {
      "id": "cap:sales-analysis",
      "type": "capability",
      "intent": "Analyse complète des ventes",
      "score": 0.72,
      "note": "Contient visualisation mais fait plus"
    }
  ]
}
```

---

## 4. Flow en Deux Temps

### 4.1 Pattern recommandé

```
┌─────────────────────────────────────────────────────────────┐
│  1. Découverte rapide                                       │
│     pml_discover({ intent: "...", verbosity: "summary" })   │
│     → Liste avec résumés                                    │
└─────────────────────────────────────────────────────────────┘
                              │
              L'IA choisit ce qui l'intéresse
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2a. Exécution directe (si confiance haute)                 │
│      pml_execute({ capabilityId: "cap:sales", args: {...} })│
│                                                             │
│  2b. OU demande de détails (si besoin de comprendre)        │
│      pml_get_details({ id: "cap:sales" })                   │
│      → Retourne code/DAG complet                            │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Outil complémentaire : `pml_get_details`

```typescript
pml_get_details({
  id: string;                    // ID du tool ou capability
  include?: {
    code?: boolean;              // Inclure le code source
    dag?: boolean;               // Inclure le DAG (explicit ou inferred)
    history?: boolean;           // Inclure les dernières invocations
    schema?: boolean;            // Inclure le schema complet (tools)
  };
})
```

**Réponse :** Retourne `ResultDetails` complet pour l'élément demandé.

---

## 5. Suggestions Intelligentes

### 5.1 Co-occurrences

Si `includeCoOccurrences: true`, on ajoute les tools souvent utilisés ensemble :

```json
{
  "results": [
    { "id": "tool:db:query", "score": 0.92, "type": "tool" },
    {
      "id": "tool:cache:get",
      "score": 0.65,
      "type": "tool",
      "suggestionReason": "co-occurrence",
      "coOccurrenceWith": "db:query",
      "coOccurrenceStrength": 0.78
    }
  ]
}
```

### 5.2 Alternatives

Si `includeAlternatives: true`, on ajoute les alternatives connues :

```json
{
  "results": [
    { "id": "tool:http:fetch", "score": 0.90, "type": "tool" },
    {
      "id": "tool:http:axios",
      "score": 0.70,
      "type": "tool",
      "suggestionReason": "alternative",
      "alternativeTo": "http:fetch"
    }
  ]
}
```

---

## 6. Optimisation Tokens

### 6.1 Budget estimé par verbosité

| Verbosity | Tokens/résultat | Pour 10 résultats |
| --------- | --------------- | ----------------- |
| `minimal` | ~50             | ~500              |
| `summary` | ~150            | ~1500             |
| `full`    | ~500-2000       | ~5000-20000       |

### 6.2 Recommandations

1. **Défaut : `summary`** - Bon compromis info/tokens
2. **`minimal` pour exploration** - Quand l'IA browse plusieurs options
3. **`full` rarement** - Seulement si l'IA doit modifier/comprendre le code
4. **Limit bas** - `limit: 5` suffit souvent

### 6.3 Compression des résumés

Pour les capabilities avec beaucoup d'étapes :

```typescript
function compressPipeline(steps: PipelineStep[], maxSteps: number = 5): PipelineStep[] {
  if (steps.length <= maxSteps) return steps;

  // Garder first, last, et résumer le milieu
  const first = steps[0];
  const last = steps[steps.length - 1];
  const middle = steps.slice(1, -1);

  const compressed: PipelineStep = {
    step: 2,
    action: `${middle.length} étapes intermédiaires`,
    tools: [...new Set(middle.flatMap((s) => s.tools))],
  };

  return [
    first,
    compressed,
    { ...last, step: 3 },
  ];
}
```

**Résultat :**

```json
{
  "pipeline": [
    { "step": 1, "action": "fetch", "tools": ["db:query"] },
    {
      "step": 2,
      "action": "5 étapes intermédiaires",
      "tools": ["transform", "validate", "enrich", "..."]
    },
    { "step": 3, "action": "export", "tools": ["pdf:generate"] }
  ]
}
```

---

## 7. Implémentation

### 7.1 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    pml_discover handler                      │
└─────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  ToolSearcher   │  │CapabilityMatcher│  │  GraphRAG       │
│  (existant)     │  │  (existant)     │  │ (co-occurrences)│
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
                    ┌─────────────────┐
                    │  ResultMerger   │
                    │  - Dedupe       │
                    │  - Score blend  │
                    │  - Verbosity    │
                    └─────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ SummaryGenerator│
                    │ - Pipeline view │
                    │ - Compression   │
                    └─────────────────┘
```

### 7.2 Fichiers à créer/modifier

```
src/mcp/handlers/
├── discover.ts              # NOUVEAU - Handler principal
├── get-details.ts           # NOUVEAU - Handler détails
├── search-tools.ts          # MODIFIER - Marquer deprecated
└── search-capabilities.ts   # MODIFIER - Marquer deprecated

src/capabilities/
└── summary-generator.ts     # NOUVEAU - Génération résumés

src/graphrag/
└── co-occurrence-suggester.ts  # NOUVEAU (ou extension de dag-suggester)
```

### 7.3 Migration

1. **Phase 1** : Créer `pml_discover` qui wrap les existants
2. **Phase 2** : Ajouter les résumés et verbosity
3. **Phase 3** : Déprécier les anciens outils (warning logs)
4. **Phase 4** : Retirer les anciens outils (major version)

---

## 8. Exemples d'utilisation

### 8.1 Exploration rapide

```typescript
// L'IA explore ce qui existe
pml_discover({
  intent: "manipuler des fichiers JSON",
  verbosity: "minimal",
  limit: 10,
});

// → Liste rapide de 10 options
// L'IA choisit et demande plus de détails si besoin
```

### 8.2 Recherche ciblée

```typescript
// L'IA sait à peu près ce qu'elle veut
pml_discover({
  intent: "convertir CSV en JSON avec validation",
  verbosity: "summary",
  limit: 5,
  filter: { type: "capability", minScore: 0.7 },
});

// → Top 5 capabilities avec résumés pipeline
// L'IA peut exécuter directement ou demander détails
```

### 8.3 Compréhension profonde

```typescript
// L'IA veut comprendre/modifier une capability
pml_get_details({
  id: "cap:csv-to-json",
  include: { code: true, dag: true },
});

// → Code complet + DAG pour analyse
```

---

## 9. Questions ouvertes

1. **Caching des résumés** : Pré-calculer les pipeline summaries ou à la volée ?
2. **Extraction de sous-parties** : Comment identifier automatiquement les "étapes extractibles" ?
3. **Scoring blend** : Comment combiner les scores tools vs capabilities ?
4. **Limite de compression** : Jusqu'où compresser les pipelines longs ?

---

## 10. Références

- `tech-spec-dag-capability-learning.md` - Reconstruction DAG
- `src/mcp/handlers/search-tools.ts` - Handler actuel tools
- `src/mcp/handlers/search-capabilities.ts` - Handler actuel capabilities
- `src/capabilities/matcher.ts` - CapabilityMatcher
- `src/graphrag/dag-suggester.ts` - DAGSuggester (co-occurrences)
