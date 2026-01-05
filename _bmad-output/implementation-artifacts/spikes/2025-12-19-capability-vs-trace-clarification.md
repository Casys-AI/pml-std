# Spike: Capability vs Trace - Clarification Architecturale

**Date:** 2025-12-19 **Auteur:** Erwan + Claude **Status:** Investigation **Contexte:** Discussion
Story 10.5 - Confusion dans le code entre Capability et Trace

---

## Problème Identifié

Le code actuel mélange deux concepts distincts sous le terme "Capability" :

```typescript
// worker-bridge.ts:369 - Après exécution RPC
await this.capabilityStore.saveCapability({
  code: this.lastExecutedCode,
  intent: this.lastIntent,
  toolsUsed: this.getToolsCalled(), // ← Données de TRACE
  toolInvocations, // ← Données de TRACE
});
```

**Le problème :** On appelle `saveCapability()` avec des données d'exécution (trace), pas une vraie
capability.

---

## Définitions Claires

### Capability (Mémoire Sémantique)

**Quand créée :** À l'analyse statique, AVANT exécution **Ce qu'elle contient :** Structure COMPLÈTE
avec toutes les branches possibles **Source :** Analyse AST du code (Story 10.1)

```typescript
interface Capability {
  id: string;
  codeSnippet: string;
  intent: string;

  // Structure COMPLÈTE (analyse statique)
  staticStructure: {
    nodes: StaticStructureNode[]; // Tous les noeuds possibles
    edges: StaticStructureEdge[]; // Toutes les branches (if/else, etc.)
  };

  // Metadata
  permissionSet?: PermissionSet;
  inputSchema?: JSONSchema;
  outputSchema?: JSONSchema;
}
```

**Exemple :**

```typescript
// Code source
if (file.exists) {
  await mcp.fs.read({ path });
} else {
  await mcp.fs.create({ path });
}

// Capability.staticStructure contient :
// - fs:stat
// - decision node
// - fs:read (branche true)
// - fs:create (branche false)
// → Structure COMPLÈTE
```

### Trace / WorkflowExecution (Mémoire Épisodique)

**Quand créée :** APRÈS exécution **Ce qu'elle contient :** Le chemin EMPRUNTÉ (une seule branche)
**Source :** Traçage RPC pendant l'exécution

```typescript
interface ExecutionTrace {
  id: string;
  capabilityId: string; // Référence à la capability
  executedAt: Date;

  // Chemin EMPRUNTÉ
  executedPath: string[]; // ["n1", "d1", "n2"] - les nodeIds traversés
  decisions: DecisionOutcome[]; // [{nodeId: "d1", outcome: "true"}]

  // Résultats
  taskResults: Map<string, TaskResult>;
  success: boolean;
  durationMs: number;
}
```

**Exemple :**

```
Si file.exists = true :
executedPath = ["fs:stat", "decision", "fs:read"]
→ On ne voit PAS fs:create (branche non prise)
```

---

## Comparaison

| Aspect       | Capability             | Trace                       |
| ------------ | ---------------------- | --------------------------- |
| **Quand**    | Analyse statique (PRE) | Exécution (POST)            |
| **Contenu**  | Structure COMPLÈTE     | Chemin EMPRUNTÉ             |
| **Branches** | Toutes visibles        | Une seule (celle prise)     |
| **Stockage** | `workflow_pattern`     | `execution_trace` (à créer) |
| **Analogie** | Plan d'un bâtiment     | GPS trace d'un trajet       |
| **Mémoire**  | Sémantique             | Épisodique                  |

---

## État Actuel du Code

### Ce qui existe

```
saveCapability() ←── Appelé avec des données de TRACE
                     (toolsUsed, toolInvocations viennent de l'exécution)

WorkflowExecution ←── Type qui ressemble à une trace
                      mais pas clairement séparé

workflow_pattern ←── Table qui stocke les "capabilities"
                     mais mélange structure et traces
```

### Ce qui manque

1. **Table `execution_trace`** - Pour stocker les traces séparément
2. **Distinction claire dans le code** - `saveCapability()` vs `saveExecutionTrace()`
3. **Story 10.1 vraiment utilisée** - L'analyse statique crée la capability
4. **Epic 11** - Learning from Traces (agrégation des traces)

---

## Flux Souhaité (Epic 10/11)

```
┌─────────────────────────────────────────────────────────────────┐
│  1. CODE SOUMIS                                                  │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. ANALYSE STATIQUE (Story 10.1)                                │
│     → Génère static_structure (toutes les branches)             │
│     → CRÉE LA CAPABILITY                                         │
│     → INSERT workflow_pattern                                    │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. EXÉCUTION (Worker RPC)                                       │
│     → Trace les appels MCP via RPC                              │
│     → Capture le chemin emprunté                                │
│     → Capture les décisions aux branch points                   │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. STOCKAGE TRACE (Epic 11)                                     │
│     → INSERT execution_trace                                    │
│     → Référence capability_id                                   │
│     → executed_path, decisions, task_results                    │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. LEARNING (Epic 11)                                           │
│     → Agrège les traces par capability                          │
│     → Calcule: dominant_path, success_rate par branche          │
│     → UPDATE workflow_pattern.learning                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Actions Recommandées

### Court terme (clarification)

1. [ ] Renommer ou documenter `saveCapability()` pour clarifier qu'il crée depuis les traces
2. [ ] Ajouter commentaires explicites sur la distinction

### Moyen terme (Epic 11)

3. [ ] Créer table `execution_trace`
4. [ ] Créer `saveExecutionTrace()` distinct de `saveCapability()`
5. [ ] Modifier le flux : analyse statique → capability, exécution → trace

### Long terme (unification)

6. [ ] Story 10.1 génère la capability avec `static_structure`
7. [ ] Les traces référencent la capability et enrichissent le learning
8. [ ] UI montre la structure complète + stats par branche

---

## Impact sur l'Architecture 100% MCP

Si on passe en mode 100% MCP (tous les appels via RPC) :

```
┌─────────────────────────────────────────────────────────────────┐
│  Mode 100% MCP                                                   │
│                                                                  │
│  Capability (analyse statique):                                  │
│    → Détecte mcp.fs.read, mcp.std.json_parse, mcp.github.*      │
│    → Génère structure complète avec branches                    │
│                                                                  │
│  Trace (exécution RPC):                                          │
│    → Tous les appels MCP tracés via WorkerBridge                │
│    → DAG concret reconstruit depuis les traces                  │
│    → Référence la capability pour enrichir le learning          │
│                                                                  │
│  ✅ Distinction claire possible                                  │
│  ✅ 100% tracé                                                   │
│  ✅ Structure + instances séparées                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Références

- **Epic 10:** DAG Capability Learning & Unified APIs
- **Epic 11:** Learning from Traces (à venir)
- **Story 10.1:** Static Code Analysis → Capability Creation
- **Story 10.5:** Execute Code via Inferred DAG
- **ADR-041:** Hierarchical trace tracking
