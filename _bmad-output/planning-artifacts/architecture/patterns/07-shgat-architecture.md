## Pattern 7: SHGAT Modular Architecture & Subprocess Training

> **Source:** `src/graphrag/algorithms/shgat/` **Tech-Specs:**
>
> - [`shgat-learning-and-dag-edges.md`](../../tech-specs/modular-dag-execution/shgat-learning-and-dag-edges.md)
> - [`operation-embeddings.md`](../../tech-specs/modular-dag-execution/operation-embeddings.md)
>
> **Related:** ADR-053 (SHGAT Subprocess Training), Story 10.7 (Multi-Head Attention)

### Modular Directory Structure

```
src/graphrag/algorithms/shgat/
├── index.ts                 # Public API exports
├── types.ts                 # All SHGAT types (CapabilityNode, ToolNode, etc.)
├── features.ts              # Feature extraction (graph, temporal, semantic)
├── spawn-training.ts        # Subprocess spawning logic
├── train-worker.ts          # Subprocess worker entry point
│
├── graph/                   # Graph construction
│   ├── index.ts
│   └── incidence.ts         # Incidence matrix building
│
├── initialization/          # Parameter initialization
│   ├── index.ts
│   └── parameters.ts        # Weight initialization strategies
│
├── message-passing/         # n-SuperHyperGraph message passing
│   ├── index.ts
│   ├── phase-interface.ts   # Common phase interface
│   ├── vertex-to-edge-phase.ts    # V→E aggregation
│   ├── edge-to-edge-phase.ts      # E→E (hyperedge interaction)
│   ├── edge-to-vertex-phase.ts    # E→V distribution
│   └── multi-level-orchestrator.ts # Orchestrates all phases
│
├── scoring/                 # Scoring implementations
│   ├── index.ts
│   ├── v1-scorer.ts         # DEPRECATED: Legacy 3-head (not used)
│   ├── v2-scorer.ts         # DEPRECATED: TraceFeatures (not used)
│   └── multi-level-scorer.ts # K-head n-SuperHyperGraph (PRODUCTION)
│
├── training/                # Training implementations
│   ├── index.ts
│   ├── v1-trainer.ts        # DEPRECATED: Legacy training
│   ├── v2-trainer.ts        # DEPRECATED: TraceFeatures training
│   ├── multi-level-trainer.ts      # Cosine-based (backup)
│   └── multi-level-trainer-khead.ts # K-head backprop (PRODUCTION)
│
└── utils/
    └── math.ts              # Softmax, cosine similarity, etc.
```

### Production Architecture (v1 refactor)

**Capabilities & Tools/Operations**: K-head attention unifié

```typescript
// Forward pass: multi-level message passing
V → E^0 → E^1 → ... → E^L_max

// K-head scoring (for BOTH capabilities AND tools)
Q = W_q @ intent_projected     // [hiddenDim]
K = W_k @ embedding_propagated // [hiddenDim]
score_h = sigmoid(Q·K / √dim)  // per head

// Fusion: average of K head scores
finalScore = Σ(score_h) / K
```

### Node Types in Graph

| Type           | Prefix    | Scoring          | Example                   |
| -------------- | --------- | ---------------- | ------------------------- |
| **capability** | -         | K-head attention | `local.default.math.sum`  |
| **tool**       | `server:` | K-head attention | `filesystem:read_file`    |
| **operation**  | `code:`   | K-head attention | `code:filter`, `code:map` |

### Operation Embeddings (Phase 2a)

**Toutes les opérations ont maintenant des embeddings sémantiques:**

```typescript
// Avant: pseudo-tools sans embeddings → pas de similarité sémantique
// Après: embeddings uniformes pour MCP tools ET code operations

code:filter  → embedding[1024]  // Semantic: "filter array elements"
code:map     → embedding[1024]  // Semantic: "transform each element"
code:reduce  → embedding[1024]  // Semantic: "aggregate to single value"
```

**Bénéfices:**

- Similarité sémantique entre `code:filter` et `code:select`
- Message passing uniforme (operations participent au graphe)
- Catégories: `array`, `string`, `object`, `math`, `json`, `binary`

### Scorer Versions (historical)

| Version          | Architecture                         | Status         |
| ---------------- | ------------------------------------ | -------------- |
| **v1 (current)** | K-head attention unified             | **Production** |
| v1-legacy        | 3-head (Semantic/Structure/Temporal) | Deprecated     |
| v2               | TraceFeatures-based                  | Experimental   |
| v3               | Hybrid                               | Planned        |

### Message Passing Flow (n-SuperHyperGraph)

```
Tools (vertices)                   Capabilities (hyperedges)
     │                                      │
     │ Vertex-to-Edge Phase                 │
     └──────────────────────────────────────►│
                                            │
                                   Edge-to-Edge Phase
                                   (hyperedge interaction)
                                            │
     ◄──────────────────────────────────────┘
     │ Edge-to-Vertex Phase
     │
     ▼
Updated Tool Embeddings → Scoring
```

### K-Head Attention Details

```typescript
// K attention heads (configurable, default K=4-8)
// Each head has learnable W_q and W_k matrices

for (head h in [0..K-1]):
  Q[h] = W_q[h] @ intent_projected   // Query
  K[h] = W_k[h] @ cap_embedding      // Key
  score[h] = sigmoid(dot(Q[h], K[h]) / √dim)

// Fusion: simple average (no learned fusion weights)
finalScore = mean(score[0..K-1])
```

**Note:** Le 3-head legacy (Semantic/Structure/Temporal avec PageRank, Adamic-Adar, HeatDiffusion) a
été remplacé par K-head unifié qui utilise **uniquement les embeddings propagés** via message
passing.

Les features graph (PageRank, Adamic-Adar, etc.) sont toujours calculées mais utilisées par d'autres
modules (local-alpha, suggestions, clustering) — pas par SHGAT K-head scoring.

### Subprocess Training (ADR-053)

**Problem:** L'entraînement SHGAT bloquait le main event loop (30s pour 500 traces).

**Solution:** Subprocess worker pour entraînement non-bloquant:

```
Main Process                    Subprocess
     │                              │
     │  stdin: JSON                 │
     │ ────────────────────────►    │
     │  {capabilities, examples,    │
     │   config, existingParams}    │
     │                              │
     │                         ┌────┴────┐
     │                         │ SHGAT   │
     │                         │Training │
     │                         │ Loop    │
     │                         └────┬────┘
     │                              │
     │  stdout: JSON                │
     │ ◄────────────────────────    │
     │  {params, tdErrors,          │
     │   finalLoss, accuracy}       │
```

### Training Modes

| Mode      | Epochs | Traces | Trigger                |
| --------- | ------ | ------ | ---------------------- |
| **Batch** | 3-5    | 500    | Démarrage serveur      |
| **PER**   | 1      | 50     | Après chaque exécution |

### Prioritized Experience Replay (PER)

```typescript
// TD error determines sampling priority
priority = |predicted_score - actual_outcome|^α  // α = 0.6

// After training, update trace priorities
await batchUpdatePrioritiesFromTDErrors(traceStore, traces, result.tdErrors);
```

**Affects:** Epic 10 (Static Analysis), Epic 11 (SHGAT Learning)

---
