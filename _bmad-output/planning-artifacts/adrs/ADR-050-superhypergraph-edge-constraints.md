# ADR-050: SuperHyperGraph Edge Constraints

**Status:** Accepted **Date:** 2025-12-17 (Updated 2025-12-25 for v1 refactor) **Relates to:**
ADR-038 (Scoring Algorithms), ADR-042 (Capability Hyperedges), ADR-045 (Cap-to-Cap Dependencies)
**Research:** `spikes/2025-12-17-superhypergraph-hierarchical-structures.md` **Tech Spec:**
`docs/tech-specs/shgat-v1-refactor/` (multi-level architecture)

---

## Context

Casys PML utilise un **n-SuperHyperGraph non-borné** pour représenter les relations entre tools,
capabilities et meta-capabilities. Le système supporte 4 types d'edges avec des sémantiques
différentes :

| Edge Type    | Sémantique                        | Exemple                                          |
| ------------ | --------------------------------- | ------------------------------------------------ |
| `contains`   | Composition (meta-capability)     | "deploy-full" contains "build", "test", "deploy" |
| `dependency` | Ordre d'exécution requis          | "deploy" dependency "build"                      |
| `provides`   | Flux de données (paramètres)      | "read_file" provides output to "parse_json"      |
| `sequence`   | Co-occurrence temporelle observée | "read" souvent suivi de "write"                  |

La théorie **DASH (Directed Acyclic SuperHyperGraphs)** de Fujita 2025 formalise les propriétés
nécessaires pour garantir un ordonnancement topologique et éviter les deadlocks.

**Question :** Quelles contraintes de cyclicité appliquer à chaque type d'edge ?

---

## Decision

### Contraintes par type d'edge

| Edge Type    | Contrainte           | Enforcement        | Justification                                               |
| ------------ | -------------------- | ------------------ | ----------------------------------------------------------- |
| `contains`   | **DAG strict**       | Block at insertion | Impossibilité logique (A ne peut contenir B qui contient A) |
| `dependency` | **DAG strict**       | Block at insertion | Évite deadlocks à l'exécution                               |
| `provides`   | **Cycles autorisés** | None               | Interdépendances fonctionnelles valides                     |
| `sequence`   | **Cycles autorisés** | None               | Patterns temporels naturels (boucles d'usage)               |

### Implémentation

#### 1. Validation DAG pour `contains` et `dependency`

```typescript
// src/graphrag/edge-validator.ts
export class DASHValidator {
  /**
   * Vérifie qu'ajouter un edge ne crée pas de cycle
   * Applicable à: contains, dependency
   */
  wouldCreateCycle(
    from: string,
    to: string,
    edgeType: "contains" | "dependency",
  ): boolean {
    // Si "to" peut atteindre "from" via des edges du même type → cycle
    return this.isReachable(to, from, edgeType);
  }

  private isReachable(
    source: string,
    target: string,
    edgeType: string,
  ): boolean {
    const visited = new Set<string>();
    const stack = [source];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const neighbors = this.getOutgoingNeighbors(current, edgeType);
      stack.push(...neighbors);
    }
    return false;
  }

  /**
   * Appelé avant insertion d'un edge contains ou dependency
   */
  validateEdgeInsertion(
    from: string,
    to: string,
    edgeType: EdgeType,
  ): ValidationResult {
    if (edgeType === "contains" || edgeType === "dependency") {
      if (this.wouldCreateCycle(from, to, edgeType)) {
        return {
          valid: false,
          error:
            `Cycle detected: adding ${edgeType} edge ${from} → ${to} would violate DASH properties`,
          suggestion: edgeType === "dependency"
            ? 'Consider using "provides" for bidirectional data flow'
            : "Meta-capabilities cannot contain each other cyclically",
        };
      }
    }
    return { valid: true };
  }
}
```

#### 2. Topological Ordering (DASH Theorem 2.6)

```typescript
/**
 * Calcule l'ordre d'exécution pour un ensemble de capabilities
 * Garanti par la contrainte DAG sur contains/dependency
 */
export function topologicalSort(
  capabilities: Capability[],
  edgeType: "contains" | "dependency",
): Capability[] {
  const sorted: Capability[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function visit(cap: Capability): void {
    if (inStack.has(cap.id)) {
      // Ne devrait jamais arriver si DASHValidator est utilisé
      throw new Error(`Unexpected cycle at ${cap.id}`);
    }
    if (visited.has(cap.id)) return;

    inStack.add(cap.id);

    const children = getEdgeTargets(cap.id, edgeType);
    for (const childId of children) {
      const child = capabilities.find((c) => c.id === childId);
      if (child) visit(child);
    }

    inStack.delete(cap.id);
    visited.add(cap.id);
    sorted.push(cap);
  }

  for (const cap of capabilities) {
    visit(cap);
  }

  return sorted;
}
```

#### 3. Pas de validation pour `provides` et `sequence`

```typescript
// Ces edges peuvent avoir des cycles - pas de validation
async addProvidesEdge(from: string, to: string, params: string[]): Promise<void> {
  // Stockage direct, cycles autorisés
  await this.storeEdge(from, to, 'provides', { params });
}

async addSequenceEdge(from: string, to: string, weight: number): Promise<void> {
  // Stockage direct, cycles autorisés (patterns temporels)
  await this.storeEdge(from, to, 'sequence', { weight });
}
```

---

## Rationale

### Pourquoi DAG strict pour `contains` ?

C'est une **impossibilité logique** : si A contient B et B contient A, on a une récursion infinie.
C'est comme une poupée russe qui se contiendrait elle-même.

```
❌ Invalid:
  meta-cap-A contains cap-B
  cap-B contains meta-cap-A  // Impossible

✅ Valid:
  meta-cap-A contains cap-B
  meta-cap-A contains cap-C
  cap-B (no children)
```

### Pourquoi DAG strict pour `dependency` ?

Pour l'**exécution**, un cycle de dépendances crée un deadlock :

```
❌ Deadlock:
  cap-A depends on cap-B
  cap-B depends on cap-A
  → Lequel exécuter en premier ?

✅ Valid:
  cap-A depends on cap-B
  cap-B depends on cap-C
  → Ordre: C → B → A
```

### Pourquoi autoriser les cycles pour `provides` ?

`provides` représente un **flux de données**, pas un ordre d'exécution. Deux tools peuvent se
fournir mutuellement des données dans des contextes différents :

```
✅ Valid (contextes différents):
  read_file provides {content} to parse_json
  parse_json provides {structured_data} to write_file
  write_file provides {path} to read_file  // Pour vérification

Ce n'est pas un cycle d'exécution, c'est une description des flux de données possibles.
```

### Pourquoi autoriser les cycles pour `sequence` ?

`sequence` capture des **patterns temporels observés**. Les boucles sont naturelles dans l'usage
réel :

```
✅ Natural pattern:
  read_file → process → validate → write_file → read_file (vérification)
           ↑__________________________________|

C'est un pattern d'usage, pas une contrainte d'exécution.
```

---

## Consequences

### Positives

1. **Garantie DASH** : Les propriétés prouvées (topological ordering, sources) sont garanties pour
   `contains`/`dependency`
2. **Pas de deadlocks** : L'exécution de DAGs est toujours possible
3. **Flexibilité** : `provides` et `sequence` capturent la richesse des patterns réels
4. **Messages d'erreur clairs** : Le système explique pourquoi un edge est rejeté

### Negatives

1. **Coût de validation** : O(V+E) à chaque insertion de `contains`/`dependency`
2. **Complexité** : 4 types d'edges avec des règles différentes

### Mitigations

- Cache des résultats de reachability pour edges fréquents
- Validation lazy (batch) pour imports en masse
- Documentation claire des règles par type d'edge

---

## Utility Functions (DASH Theorems)

### Find Root Capabilities (Theorem 2.5)

Tout DASH a au moins une "source" (vertex sans edges entrants). Utile pour trouver les points
d'entrée.

```typescript
/**
 * DASH Theorem 2.5: Il existe toujours au moins une source
 * Retourne les capabilities qui ne dépendent de rien
 */
function findRootCapabilities(
  capabilities: Capability[],
  edgeType: "contains" | "dependency" = "dependency",
): Capability[] {
  return capabilities.filter((cap) => !hasIncomingEdges(cap.id, edgeType));
}

// Usage: points d'entrée pour exécution ou navigation UI
const entryPoints = findRootCapabilities(allCaps, "dependency");
```

### Ancestry Queries (Theorem 2.8)

La relation de reachability forme un ordre partiel. Utile pour requêtes "qui utilise X" / "X utilise
quoi".

```typescript
/**
 * DASH Theorem 2.8: Reachability = ordre partiel strict
 */
function getDescendants(capId: string, edgeType: EdgeType): string[] {
  const descendants: string[] = [];
  const stack = [capId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const children = getOutgoingNeighbors(current, edgeType);
    descendants.push(...children);
    stack.push(...children);
  }

  return descendants;
}

function getAncestors(capId: string, edgeType: EdgeType): string[] {
  const ancestors: string[] = [];
  const stack = [capId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const parents = getIncomingNeighbors(current, edgeType);
    ancestors.push(...parents);
    stack.push(...parents);
  }

  return ancestors;
}

// Usage: UI "Show all capabilities that use tool X"
const usedBy = getAncestors(toolId, "contains");
```

---

## Implementation Notes

### Fichiers à modifier

| Fichier                                | Modification                          |
| -------------------------------------- | ------------------------------------- |
| `src/graphrag/edge-validator.ts`       | Nouveau - DASHValidator class         |
| `src/graphrag/graph-engine.ts`         | Appeler DASHValidator avant insertion |
| `src/capabilities/capability-store.ts` | Valider `contains` edges              |
| `src/graphrag/types.ts`                | Ajouter `ValidationResult` type       |

### Tests requis

```typescript
describe("DASHValidator", () => {
  it("should reject cyclic contains edges", () => {
    validator.addEdge("A", "B", "contains");
    const result = validator.validateEdgeInsertion("B", "A", "contains");
    expect(result.valid).toBe(false);
  });

  it("should reject cyclic dependency edges", () => {
    validator.addEdge("A", "B", "dependency");
    const result = validator.validateEdgeInsertion("B", "A", "dependency");
    expect(result.valid).toBe(false);
  });

  it("should allow cyclic provides edges", () => {
    validator.addEdge("A", "B", "provides");
    const result = validator.validateEdgeInsertion("B", "A", "provides");
    expect(result.valid).toBe(true);
  });

  it("should allow cyclic sequence edges", () => {
    validator.addEdge("A", "B", "sequence");
    const result = validator.validateEdgeInsertion("B", "A", "sequence");
    expect(result.valid).toBe(true);
  });
});
```

---

## SHGAT Multi-Head Attention Architecture

### K Adaptive Heads (v1 Refactor - 2025-12-26)

Head count adapts to graph size (4-16 heads):

| Graph Size    | numHeads | hiddenDim | headDim |
| ------------- | -------- | --------- | ------- |
| < 50 nodes    | 4        | 64        | 16      |
| < 200 nodes   | 6        | 96        | 16      |
| < 500 nodes   | 8        | 256       | 32      |
| < 1000 nodes  | 12       | 384       | 32      |
| >= 1000 nodes | 16       | 512       | 32      |

### K-Head Scoring (Production)

```typescript
// K-head attention scoring
score = sigmoid(mean(headScores))

for (h = 0; h < numHeads; h++) {
  Q[h] = W_q[h] @ intentProjected   // [headDim]
  K[h] = W_k[h] @ capEmbedding      // [headDim]
  headScores[h] = dot(Q[h], K[h]) / sqrt(headDim)
}
```

### Learnable Parameters (per head)

| Parameter | Shape                      | Description                        |
| --------- | -------------------------- | ---------------------------------- |
| W_q       | [hiddenDim × embeddingDim] | Query projection                   |
| W_k       | [hiddenDim × embeddingDim] | Key projection                     |
| W_v       | [hiddenDim × embeddingDim] | Value projection (message passing) |
| a         | [2 × hiddenDim]            | Attention vector                   |

**Initialization (critical for convergence):**

```typescript
// Standard Xavier for W_v, a
W_v = initMatrix(hiddenDim, embeddingDim);

// Scaled Xavier (× 10) for W_q, W_k to escape sigmoid(0) = 0.5
W_q = initMatrixScaled(hiddenDim, embeddingDim, 10);
W_k = initMatrixScaled(hiddenDim, embeddingDim, 10);
```

Without scaled init: gradNorm ≈ 0.002, scores stuck at 0.6 With scaled init (× 10): gradNorm ≈
0.023, scores diversified

### HeatDiffusion for Tools vs Capabilities

**Design Decision:** HeatDiffusion is computed for BOTH tools and capabilities, but with different
semantics:

| Entity           | Heat Computation                                                                       | Rationale                                                        |
| ---------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Tools**        | Simple graph heat: degree-based intrinsic heat + neighbor propagation                  | Tools have local heat based on connectivity in the tool graph    |
| **Capabilities** | Hierarchical heat: aggregated from constituent tools + capability neighbor propagation | Capabilities inherit heat from their tools, weighted by position |

```typescript
// Tool heat (simple)
toolHeat = intrinsicWeight * (degree / maxDegree) + neighborWeight * avgNeighborHeat;

// Capability heat (hierarchical)
capHeat = Σ(toolHeat[i] * positionWeight[i]) / totalWeight;
propagatedCapHeat = intrinsicWeight * capHeat + neighborWeight * neighborCapHeat * hierarchyDecay;
```

This allows:

- Tools to have local connectivity signals (useful for tool graph navigation)
- Capabilities to aggregate tool-level heat with hierarchical propagation
- Different decay rates for tool vs capability heat propagation

### Multi-Level Message Passing (v1 Refactor - 2025-12-25)

**Core mechanism:** n-SuperHyperGraph with hierarchical message passing. Unlike flat V→E→V, the
refactored architecture propagates through **all hierarchy levels**.

#### Data Model

```typescript
// Capability members can be tools OR other capabilities
type Member = { type: "tool"; id: string } | { type: "capability"; id: string };

interface CapabilityNode {
  id: string;
  embedding: number[];
  members: Member[]; // Direct children only (no transitive)
  hierarchyLevel: number; // Computed via topological sort
  successRate: number;
}
```

#### Hierarchy Levels

```
level(c) = 0                          if c contains only tools
level(c) = 1 + max{level(c') | c' ∈ c}  otherwise
```

Example:

```
Level 2: release-cycle (contains deploy-full, rollback-plan)
Level 1: deploy-full (contains build, test), rollback-plan (contains tools)
Level 0: build (tools only), test (tools only)
```

#### Multi-Level Incidence Structure

**NO transitive closure.** Each mapping captures direct membership only:

| Structure                | Description                             |
| ------------------------ | --------------------------------------- |
| `I₀: toolToCapIncidence` | Tool → Level-0 Caps (direct membership) |
| `I_k: capToCapIncidence` | Level-(k-1) Caps → Level-k Caps (k ≥ 1) |
| `parentToChildIncidence` | Reverse mapping for downward pass       |

#### Upward Phase: V → E^0 → E^1 → ... → E^L_max

```
For level k = 0 to L_max:
  For each parent capability c at level k:
    children = level-(k-1) caps or tools in c

    For each head h:
      child_proj = W_child[h] @ child_emb
      parent_proj = W_parent[h] @ parent_emb

      score = a_upward[h]^T · LeakyReLU([child_proj || parent_proj])
      attention = softmax(scores over children)

      E[k][c][h] = Σ attention[i] × child_proj[i]

    E[k][c] = concat(E[k][c][0], ..., E[k][c][K-1])
```

#### Downward Phase: E^L_max → ... → E^0 → V

```
For level k = L_max-1 down to 0:
  For each child c at level k:
    parents = level-(k+1) caps containing c

    For each head h:
      parent_proj = W_parent[h] @ parent_emb
      child_proj = W_child[h] @ child_emb

      score = a_downward[h]^T · LeakyReLU([parent_proj || child_proj])
      attention = softmax(scores over parents)

      update = Σ attention[i] × parent_proj[i]

    E[k][c] = E[k][c] + α × concat(updates)  // Residual connection
```

#### Per-Level Parameters

```typescript
interface LevelParams {
  W_child: number[][][]; // [numHeads][headDim][inputDim]
  W_parent: number[][][]; // [numHeads][headDim][inputDim]
  a_upward: number[][]; // [numHeads][2*headDim]
  a_downward: number[][]; // [numHeads][2*headDim]
}

// Parameter count per level k:
// K × (2·headDim·inputDim + 4·headDim)
// Level 0: inputDim = embeddingDim (1024)
// Level k>0: inputDim = numHeads × headDim
```

#### Intent Projection

```typescript
// W_intent: learnable projection [propagatedDim × 1024]
intentProjected = W_intent @ intentEmbedding

// Score using PROPAGATED embedding from multi-level pass
score = cosineSimilarity(intentProjected, E.get(level)[capIdx])
```

#### Multi-Level Scoring API

```typescript
const scorer = new MultiLevelScorer(deps);

// Score all levels
const all = scorer.scoreAllCapabilities(intent);
// Returns AttentionResult[] with hierarchyLevel field

// Score only leaf capabilities (level 0)
const leaves = scorer.scoreLeafCapabilities(intent);

// Score meta-capabilities at specific level
const metas = scorer.scoreMetaCapabilities(intent, 1);

// Top-K per level
const byLevel = scorer.getTopByLevel(intent, 5);
// Returns Map<number, AttentionResult[]>
```

#### Training (Backpropagation)

```typescript
// Extended cache for gradient flow
interface ExtendedMultiLevelForwardCache extends MultiLevelForwardCache {
  intermediateUpwardActivations: Map<number, LevelIntermediates>;
  intermediateDownwardActivations: Map<number, LevelIntermediates>;
}

// Backward pass through phases
backwardMultiLevel(dLoss, targetCapId, targetLevel, cache, ...)
  → Backward through downward pass (E^0 → E^L_max)
  → Backward through upward pass (E^L_max → E^0 → V)
  → Accumulate gradients for W_child, W_parent, a_upward, a_downward
```

#### Adaptive Heads

```typescript
// Scale heads based on graph complexity
const { numHeads, hiddenDim, headDim } = getAdaptiveHeadsByGraphSize(
  numTools,
  numCaps,
  maxHierarchyLevel,
);
// 4 heads for small graphs → 16 heads for large/deep graphs
```

### Hierarchical Capabilities (n-SuperHyperGraph)

Per n-SuperHyperGraph theory (Smarandache 2019), hyperedges can contain other hyperedges
recursively:

```
E ⊆ P(V) ∪ P(E)  // Hyperedges can contain vertices OR other hyperedges
```

This enables arbitrary nesting depth (n=∞):

```
Level 2: Meta-Meta-Capability "release-cycle"
           └── contains: [deploy-full, rollback-plan]

Level 1: Meta-Capability "deploy-full"
           └── contains: [build, test]
         Meta-Capability "rollback-plan"
           └── contains: [kubectl-tool, rollback-script-tool]

Level 0: Capability "build" → Tools: [compiler, linker]
         Capability "test" → Tools: [pytest]
```

#### Direct Membership (NO Transitive Flattening)

**Key change in v1 refactor:** We do NOT flatten the hierarchy. Instead, multi-level message passing
propagates information through each level explicitly.

```
I₀ (Tools → Level-0 Caps):    I₁ (Level-0 → Level-1):
  compiler → {build}            build → {deploy-full}
  linker → {build}              test → {deploy-full}
  pytest → {test}
```

**Benefits:**

- Explicit hierarchy awareness in scoring
- `hierarchyLevel` field enables level-filtered queries
- Gradients flow through correct paths
- Memory efficient (no redundant edges)

### Implementation Files (v1 Refactor)

| File                                                                        | Content                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `src/graphrag/algorithms/shgat.ts`                                          | SHGAT class orchestrator, backward-compat APIs           |
| `src/graphrag/algorithms/shgat/types.ts`                                    | Types: Member, CapabilityNode, LevelParams, ForwardCache |
| `src/graphrag/algorithms/shgat/graph/hierarchy.ts`                          | `computeHierarchyLevels()`, cycle detection              |
| `src/graphrag/algorithms/shgat/graph/incidence.ts`                          | Multi-level incidence: I₀, I_k, reverse mappings         |
| `src/graphrag/algorithms/shgat/graph/graph-builder.ts`                      | Node registration, incidence matrix building             |
| `src/graphrag/algorithms/shgat/initialization/parameters.ts`                | Xavier init, `initializeLevelParameters()`               |
| `src/graphrag/algorithms/shgat/message-passing/multi-level-orchestrator.ts` | Upward + downward phases                                 |
| `src/graphrag/algorithms/shgat/scoring/multi-level-scorer.ts`               | `MultiLevelScorer` with level filtering                  |
| `src/graphrag/algorithms/shgat/training/multi-level-trainer.ts`             | Backprop through all levels                              |
| `tests/unit/graphrag/shgat/`                                                | 36 unit tests for hierarchy, params, message passing     |
| `tests/benchmarks/strategic/shgat-v1-v2-v3-comparison.bench.ts`             | Performance benchmarks                                   |

### Benchmarking

```bash
# Run SHGAT unit tests
deno test --allow-all tests/unit/graphrag/shgat/

# Run SHGAT benchmarks
deno bench --allow-all tests/benchmarks/strategic/shgat-v1-v2-v3-comparison.bench.ts

# Benchmark groups:
# - shgat-v1-scoring: Multi-level scoring performance
# - shgat-v2-scoring: TraceFeatures-based scoring
# - shgat-v3-hybrid: v1 message passing + v2 scoring
# - shgat-hierarchy: Deep hierarchy scaling (L_max = 1, 2, 3)
```

---

## References

- [DASH - Fujita 2025](https://www.researchgate.net/publication/392710720) - Directed Acyclic
  SuperHypergraphs
- [n-SuperHyperGraph - Smarandache 2019](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4317064)
- ADR-038: Scoring Algorithms Reference
- ADR-042: Capability Hyperedges
- Spike: `2025-12-17-superhypergraph-hierarchical-structures.md`
