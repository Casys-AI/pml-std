# ADR-047: Tool Sequence vs Deduplication in Capabilities

**Status:** Partially Addressed (see Update 2025-12-15) **Date:** 2025-12-15 **Related:** ADR-038
(Scoring Algorithms), ADR-042 (Capability Hyperedges), ADR-029 (Hypergraph Visualization), ADR-043
(All Tools Must Succeed)

## Update 2025-12-15: Current State Analysis

### Capabilities: ALREADY SOLVED ✅

Le problème pour les **capabilities** est déjà résolu par `tool_invocations` (ajouté dans ADR-043):

```typescript
// dag_structure stocke DÉJÀ:
{
  tools_used: ["read_file", "list_directory"],     // Dédupliqué (pour algos)
  tool_invocations: [                               // Séquence complète (pour viz)
    { id: "read_file#0", tool: "read_file", ts: 1000, sequenceIndex: 0 },
    { id: "read_file#1", tool: "read_file", ts: 1050, sequenceIndex: 1 },
    { id: "list_directory#0", tool: "list_directory", ts: 1100, sequenceIndex: 2 },
    { id: "read_file#2", tool: "read_file", ts: 1150, sequenceIndex: 3 },
  ]
}
```

La proposition `tools_sequence` de cet ADR est donc **redondante** - on peut dériver la séquence:

```typescript
const tools_sequence = toolInvocations
  .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
  .map((inv) => inv.tool);
```

### Tool→Tool Edges: GAP IDENTIFIÉ ⚠️

Pour les edges **Tool→Tool** dans `tool_dependency`, un problème subsiste:

```typescript
// graph-engine.ts:764
if (fromId === toId) continue; // Self-loops IGNORÉS!
```

**Conséquence:** Si on exécute `read_file → read_file → read_file`, AUCUNE edge n'est créée car:

- `nodeId` = juste le nom du tool (pas unique par invocation)
- Les paires identiques sont skippées

**Ce qu'on perd:**

| Info                    | Capabilities                | Tool→Tool edges |
| ----------------------- | --------------------------- | --------------- |
| Séquence complète       | ✅ `tool_invocations`       | ❌ Non stockée  |
| Self-loops (A→A)        | ✅ Visible dans invocations | ❌ Ignorés      |
| Fréquence par exécution | ✅ Comptable                | ❌ Perdu        |

**TODO (Epic futur):** Réfléchir si les self-loops Tool→Tool ont une valeur pour les algos GraphRAG:

- Est-ce qu'une edge `read_file → read_file` a du sens?
- Faut-il stocker la fréquence d'appel par exécution dans `tool_dependency`?
- Ou est-ce du bruit (boucles) qu'on peut ignorer?

### Execution Traces: GAP IDENTIFIÉ ⚠️

Les traces d'exécution brutes (hors capabilities) **ne sont pas persistées en DB**.

| Table                | Contenu                                   | Séquence d'exécution réelle?          |
| -------------------- | ----------------------------------------- | ------------------------------------- |
| `workflow_pattern`   | `dag_structure.tool_invocations`          | ✅ Pour capabilities uniquement       |
| `workflow_execution` | DAG template (tasks + dependsOn)          | ❌ Juste la structure, pas les traces |
| `tool_dependency`    | Paires agrégées (A→B, observed_count)     | ❌ Pas de séquence par exécution      |
| `episodic_events`    | Events haut niveau (workflow_start, etc.) | ❌ Pas les tool calls individuels     |

**Flux actuel:**

```
Exécution → traces[] → updateFromCodeExecution() → edges agrégées → traces PERDUES
                                                 ↓
                                          (sauf si capability créée)
```

**Conséquence frontend:** Impossible d'afficher les séquences d'exécution Tool→Tool brutes qui ne
sont pas des capabilities.

**TODO (Epic futur):** Si on veut visualiser les exécutions brutes:

- Option A: Nouvelle table `execution_trace` pour stocker les traces complètes
- Option B: Enrichir `workflow_execution.dag_structure` avec les traces réelles
- Option C: Accepter la limitation (seules les capabilities ont des séquences visualisables)

---

## Context (Original)

Lors de la capture d'une capability, la liste des tools utilisés (`tools_used`) est **dédupliquée**
via un Set dans `WorkerBridge.getToolsCalled()`:

```typescript
// Actuel: déduplication
getToolsCalled(): string[] {
  const toolsCalled = new Set<string>();
  for (const trace of this.traces) {
    if (trace.type === "tool_end" && trace.success) {
      toolsCalled.add(trace.tool);  // Set = pas de doublons
    }
  }
  return Array.from(toolsCalled);
}
```

**Exemple concret:**

```typescript
// Code exécuté:
const r1 = await mcp.filesystem.read_file({ path: "a.txt" });
const r2 = await mcp.filesystem.read_file({ path: "b.txt" }); // même tool
const ls = await mcp.filesystem.list_directory({ path: "." });
const r3 = await mcp.filesystem.read_file({ path: "c.txt" }); // même tool encore

// Stocké actuellement:
tools_used: ["filesystem:read_file", "filesystem:list_directory"]; // 2 tools

// Réalité de l'exécution:
sequence: ["read_file", "read_file", "list_directory", "read_file"]; // 4 appels
```

## Problem

### 1. Perte d'information pour la visualisation

Le mode **Invocation** du dashboard (ADR-029) devrait afficher la séquence complète d'exécution avec
chaque appel individuel. Actuellement, il ne peut afficher que les tools uniques.

### 2. Impact potentiel sur les algorithmes GraphRAG

La déduplication affecte plusieurs algorithmes:

| Algorithme                | Code impacté                     | Impact de la déduplication                                                             |
| ------------------------- | -------------------------------- | -------------------------------------------------------------------------------------- |
| **Spectral Clustering**   | `spectral-clustering.ts:169`     | `for (const toolId of cap.toolsUsed)` - Chaque tool compte 1x même si appelé 5x        |
| **Cluster Ratio**         | `spectral-clustering.ts:576-583` | `capToolsInActiveCluster / capability.toolsUsed.length` - Ratio basé sur tools uniques |
| **DAG Suggester Overlap** | `dag-suggester.ts:1599`          | Overlap calculé sur sets uniques                                                       |
| **Tool PageRank**         | `hypergraph-builder.ts:148`      | Edge créée 1x par tool, pas pondérée par fréquence                                     |

**Question clé:** Une capability qui appelle `read_file` 10 fois a-t-elle la même "dépendance" à ce
tool qu'une capability qui l'appelle 1 fois?

### 3. Hypothèses à valider

| Hypothèse                                                       | Impact si vraie                                  |
| --------------------------------------------------------------- | ------------------------------------------------ |
| H1: La fréquence d'appel indique une dépendance forte           | Les algos sous-estiment les dépendances répétées |
| H2: La diversité des tools est plus importante que la fréquence | Status quo est correct                           |
| H3: Les deux informations sont utiles (diversité + fréquence)   | Besoin de deux champs séparés                    |

## Options Considered

### Option A: Garder la déduplication (Status Quo)

**Avantages:**

- Pas de changement
- Comportement actuel des algos préservé
- Simplicité conceptuelle (set de tools)

**Inconvénients:**

- Mode invocation limité (pas de répétitions visibles)
- Perte d'information potentiellement utile

### Option B: Séquence complète uniquement

Remplacer `tools_used` par la séquence avec répétitions.

**Avantages:**

- Information complète préservée
- Mode invocation fonctionnel

**Inconvénients:**

- **Breaking change** pour tous les algos
- Risque de biais (capability avec boucle = poids énorme)
- Calculs de ratio faussés

### Option C: Deux champs distincts (Recommandé)

Ajouter `tools_sequence` tout en gardant `tools_used`:

```typescript
dag_structure: {
  tools_used: ["read_file", "list_directory"],     // Set unique (algos)
  tools_sequence: ["read_file", "read_file", "list_directory", "read_file"]  // Ordre complet (viz)
}
```

**Avantages:**

- Backward compatible
- Chaque usage a le bon champ
- Flexibilité pour future évolution

**Inconvénients:**

- Duplication de données
- Deux champs à maintenir

### Option D: Poids sur les edges du graphe

Garder `tools_used` dédupliqué mais ajouter un **poids** représentant la fréquence:

```typescript
// Dans hypergraph-builder.ts
for (const toolId of cap.toolsUsed) {
  const frequency = toolSequence.filter((t) => t === toolId).length;
  const edge = {
    source: capId,
    target: toolId,
    weight: frequency, // 1, 2, 3... selon répétitions
  };
}
```

**Avantages:**

- Conserve l'info de fréquence
- Algos peuvent utiliser le poids
- Pas de nouveau champ DB

**Inconvénients:**

- Perd l'ordre exact d'exécution
- Modification des algos nécessaire pour utiliser le poids

## Decision

**Option C + D hybride:**

1. **Stockage:** Ajouter `tools_sequence` dans `dag_structure` (Option C)
2. **Algos:** Utiliser `tools_used` (dédupliqué) avec poids optionnel dérivé de `tools_sequence`
   (Option D)
3. **Visualisation:** Utiliser `tools_sequence` pour le mode Invocation

### Implementation

#### 1. WorkerBridge (backend)

```typescript
// Nouveau: séquence complète
getToolsSequence(): string[] {
  const sortedTraces = [...this.traces].sort((a, b) => a.ts - b.ts);
  return sortedTraces
    .filter(t => t.type === "tool_end" && t.success)
    .map(t => t.tool);
}

// Existant: dédupliqué (inchangé)
getToolsCalled(): string[] { /* Set-based */ }
```

#### 2. CapabilityStore (stockage)

```typescript
const dagStructure = {
  type: "code_execution",
  tools_used: toolsUsed, // string[] dédupliqué
  tools_sequence: toolsSequence, // string[] avec répétitions
  tool_invocations: toolInvocations,
  intent_text: intent,
};
```

#### 3. Types

```typescript
interface CapabilityNode {
  data: {
    // ...existing fields
    toolsUsed: string[]; // Unique tools (pour algos)
    toolsSequence?: string[]; // Full sequence (pour viz)
  };
}
```

#### 4. API Gateway

```typescript
// Dans mapNodeData() pour capabilities
tools_used: capNode.data.toolsUsed,
tools_sequence: capNode.data.toolsSequence,  // Nouveau
```

#### 5. Frontend CytoscapeGraph

```typescript
// Mode invocation: préférer tools_sequence si disponible
const toolsList = currentNodeMode === "invocation"
  ? (cap.toolsSequence ?? cap.toolsUsed)
  : cap.toolsUsed;
```

## Algorithm Impact Analysis

### Spectral Clustering

**Actuel:** Matrice bipartite où chaque edge Cap→Tool a poids 1.

**Amélioration possible (Phase 2):**

```typescript
// Option: pondérer par fréquence
const frequency = cap.toolsSequence?.filter((t) => t === toolId).length ?? 1;
const weight = Math.log2(frequency + 1); // Log pour éviter explosion
adjacencyMatrix[capIdx][toolIdx] = weight;
```

**Décision:** Garder poids uniforme pour Phase 1. Évaluer l'impact en Phase 2.

### PageRank

**Actuel:** Chaque tool dans une capability contribue également au PageRank.

**Amélioration possible:**

```typescript
// Contribution pondérée
const contribution = baseContribution * (frequency / totalCalls);
```

**Décision:** Garder uniforme pour Phase 1.

### Capability Match Ratio

**Actuel:** `capToolsInActiveCluster / capability.toolsUsed.length`

**Risque si basé sur sequence:** Une capability avec 100 appels à 1 tool aurait ratio très
différent.

**Décision:** Garder basé sur `tools_used` (unique).

## Migration Path

| Phase       | Scope                                                 | Risque                       |
| ----------- | ----------------------------------------------------- | ---------------------------- |
| **Phase 1** | Ajouter `tools_sequence` au stockage + API + Frontend | Faible (additive)            |
| **Phase 2** | Évaluer l'impact des poids sur Spectral Clustering    | Moyen (nécessite benchmarks) |
| **Phase 3** | Décider si les algos doivent utiliser la fréquence    | À déterminer                 |

## Consequences

### Positive

- Mode Invocation affiche la séquence complète avec répétitions
- Information préservée pour future analyse
- Backward compatible (algos inchangés Phase 1)
- Flexibilité pour expérimenter avec les poids

### Negative

- Duplication de données (tools_used + tools_sequence)
- Complexité accrue du stockage
- Taille des capabilities augmentée

### Risks

- **Data drift:** Anciennes capabilities n'auront pas `tools_sequence` → Fallback sur `tools_used`
- **Performance:** Séquences longues (100+ appels) → Limiter à 500 appels max?

## Open Questions

1. **Faut-il pondérer les edges par fréquence?** → Benchmark nécessaire
2. **La fréquence d'appel corrèle-t-elle avec l'importance?** → Analyse à faire
3. **Limite de taille pour tools_sequence?** → Proposé: 500 appels max

## References

- ADR-038: Scoring Algorithms Reference
- ADR-029: Hypergraph Capabilities Visualization
- ADR-043: All Tools Must Succeed (introduced `tool_invocations`)
- `src/sandbox/worker-bridge.ts`: getToolsCalled(), getToolInvocations()
- `src/graphrag/spectral-clustering.ts`: buildBipartiteMatrix()
- `src/graphrag/graph-engine.ts`: updateFromCodeExecution() - line 764 self-loop skip

---

## Updated Decision (2025-12-15)

### For Capabilities: NO ACTION NEEDED

`tool_invocations` (ADR-043) already provides:

- Full sequence with timestamps
- Individual invocation IDs
- Duration tracking
- Parallelism detection capability

The frontend can derive `tools_sequence` on-demand from `toolInvocations.map(i => i.tool)`.

### For Tool→Tool Edges: DEFERRED

The self-loop issue in `graph-engine.ts:764` is noted but **not urgent**:

1. **Current algos don't need it** - They use edge diversity (A→B, B→C), not repetition frequency
2. **Self-loops are semantically questionable** - Does `read_file → read_file` mean anything?
3. **Info is preserved in capabilities** - If needed, can be reconstructed from `tool_invocations`

**Recommendation:** Revisit in a future epic focused on GraphRAG algorithm improvements if
benchmarks show value in frequency-weighted edges.
