# Epic 15: CasysDB Native Engine

**Status:** Draft
**Created:** 2026-01-03
**Language:** Rust
**Workspace:** `crates/`

---

## Overview

This epic covers the development and completion of the **CasysDB Native Engine** - a Rust-based graph database with ISO GQL support, designed to provide high-performance graph operations for the PML system.

### Key Insight (from Node2Vec Spikes)

> Node2Vec + BGE hybrid embeddings showed **+757% MRR improvement** over BGE-only.
> **Node2Vec+ (edge-weight-aware) outperforms standard Node2Vec by +5.8% MRR.**
> The priority is **GDS algorithms** (Node2Vec+, HNSW), not storage adapters.

### Current State (from Deep-Dive)

| Component | Status | Priority |
|-----------|--------|----------|
| `casys_core` | Complete | - |
| `casys_engine` | MVP | - |
| `casys_engine/gds/` | **Placeholder** | **HIGH** |
| `casys_engine/ann/` | **Placeholder** | **HIGH** |
| `casys_storage_fs` | Complete | - |
| `casys_storage_pg` | Stub | Low |
| `casys_storage_redis` | Stub | Low |
| `casys_storage_s3` | Stub | Low |
| `casys_pyo3` | Complete | - |
| `casys_napi` | Complete | - |

### Goals

1. **Graph Data Science (GDS)** - Node2Vec+ (edge-weight-aware), random walks, embedding generation
2. **Approximate Nearest Neighbors (ANN)** - HNSW index for fast kNN queries
3. **GQL Extensions** - DELETE, SET for graph maintenance
4. **NAPI Integration** - Expose GDS/ANN to TypeScript for local-alpha.ts

---

## Requirements

### Functional Requirements (Priority Order)

| ID | Requirement | Priority | Rationale |
|----|-------------|----------|-----------|
| **FR15-1** | System must compute **Node2Vec+** embeddings (edge-weight-aware) | **Critical** | +757% MRR (vs BGE) + 5.8% (vs Node2Vec) |
| **FR15-2** | System must provide HNSW index for fast approximate kNN | **Critical** | O(log n) vs O(n) search |
| **FR15-3** | Node2Vec+ must support incremental updates (new nodes) | High | Live learning requirement |
| **FR15-4** | HNSW must support dynamic insertion without full rebuild | High | Live learning requirement |
| FR15-5 | System must support DELETE clause in GQL | Medium | Graph maintenance |
| FR15-6 | System must support SET clause for property updates | Medium | Graph maintenance |
| FR15-7 | NAPI bindings must expose GDS/ANN functions | High | TypeScript integration |
| FR15-8 | System must store embeddings with graph data | Medium | PITR for embeddings |
| FR15-9 | Storage adapters (pg, redis, s3) | Low | Infrastructure, defer |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR15-1 | Node2Vec: 10K nodes in < 5 seconds | High |
| NFR15-2 | HNSW kNN: < 1ms for top-10 on 100K vectors | High |
| NFR15-3 | Memory: < 1GB for 100K nodes with 128-dim embeddings | Medium |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    TypeScript (local-alpha.ts)                   │
│                                                                  │
│  BGE embeddings ──┐                                              │
│  (semantic)       │     ┌──────────────────────────────────┐    │
│                   ├────►│ SHGAT V1 Scoring (K-head attn)   │    │
│  Node2Vec+ ───────┤     │                                  │    │
│  (structural,     │     │ alpha = f(coherence)             │    │
│   edge-weight)    │     └──────────────────────────────────┘    │
└───────────────────┼─────────────────────────────────────────────┘
                    │
                    ▼ NAPI bindings
┌─────────────────────────────────────────────────────────────────┐
│                      casys_engine (Rust)                         │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │     GDS      │  │     ANN      │  │    Engine    │          │
│  │              │  │              │  │              │          │
│  │  Node2Vec+   │  │    HNSW      │  │  GQL Parser  │          │
│  │  RandomWalk  │  │  kNN search  │  │  Planner     │          │
│  │  EdgeWeights │  │  Insert/Del  │  │  Executor    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│         │                 │                  │                   │
│         └─────────────────┴──────────────────┘                  │
│                           │                                      │
│                    InMemoryGraphStore                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Stories

### Phase 1: Graph Data Science (Critical)

#### Story 15.1: Node2Vec+ Random Walks (Edge Weight-Aware)

**Points:** 8
**Priority:** Critical

**Description:**
Implement **Node2Vec+** random walk generation in Rust. Node2Vec+ extends Node2Vec by properly incorporating edge weights into the biased random walk, providing +5.8% MRR improvement over standard Node2Vec. See [spike](../spikes/2026-01-04-node2vec-plus-edge-weights.md).

**Acceptance Criteria:**

- [ ] **AC1:** `Node2VecPlus::new(graph, config)` creates walker with p, q, gamma parameters
- [ ] **AC2:** `generate_walks(node_id, walk_length, num_walks)` returns Vec<Vec<NodeId>>
- [ ] **AC3:** Biased random walk follows **Node2Vec+ algorithm** with edge weight normalization
- [ ] **AC4:** Pre-compute node statistics (μ, σ) for normalized weight calculation
- [ ] **AC5:** Walks respect edge weights via interpolated bias formula
- [ ] **AC6:** Default parameters: **p=2.0, q=0.5** (DFS-like, optimal from benchmark)
- [ ] **AC7:** Performance: 1000 walks of length 80 in < 100ms for 10K node graph
- [ ] **AC8:** Unit tests with known graph structures and edge weights

**Configuration:**
```rust
pub struct Node2VecPlusConfig {
    pub walk_length: usize,      // Default: 15
    pub walks_per_node: usize,   // Default: 30
    pub window_size: usize,      // Default: 5
    pub embedding_dim: usize,    // Default: 32
    pub p: f64,                  // Return parameter (default: 2.0 - low return)
    pub q: f64,                  // In-out parameter (default: 0.5 - explore)
    pub gamma: f64,              // Weight normalization (default: 1.0)
    pub epsilon: f64,            // Division guard (default: 1e-6)
}
```

**Algorithm (Node2Vec+):**
```rust
impl Node2VecPlus {
    /// Pre-compute node statistics for weight normalization
    fn compute_node_stats(&mut self) {
        for node in self.graph.nodes() {
            let weights: Vec<f64> = self.graph.neighbors(node)
                .map(|n| self.graph.edge_weight(node, n))
                .collect();
            let mean = weights.iter().sum::<f64>() / weights.len() as f64;
            let variance = weights.iter().map(|w| (w - mean).powi(2)).sum::<f64>() / weights.len() as f64;
            self.node_stats.insert(node, (mean, variance.sqrt()));
        }
    }

    /// Normalized edge weight (Node2Vec+ formula)
    fn normalized_weight(&self, v: NodeId, u: NodeId) -> f64 {
        let weight = self.graph.edge_weight(v, u);
        let (mean, std) = self.node_stats[&v];
        weight / (mean + self.gamma * std).max(self.epsilon)
    }

    /// Node2Vec+ biased random walk with edge weight interpolation
    fn compute_bias(&self, prev: NodeId, curr: NodeId, next: NodeId) -> f64 {
        // Case 1: Return to previous node
        if next == prev {
            return 1.0 / self.p;
        }

        // Case 2: Check if prev-next are connected
        if self.graph.has_edge(prev, next) {
            let w_tilde = self.normalized_weight(prev, next);
            if w_tilde >= 1.0 {
                // Strongly connected - BFS-like (stay local)
                1.0
            } else {
                // Weakly connected - Node2Vec+ interpolation
                // bias = 1/q + (1 - 1/q) * w̃
                1.0 / self.q + (1.0 - 1.0 / self.q) * w_tilde
            }
        } else {
            // Case 3: Not connected - DFS-like (explore)
            1.0 / self.q
        }
    }

    fn next_step(&self, prev: NodeId, current: NodeId) -> NodeId {
        let neighbors = self.graph.neighbors(current);
        let weights: Vec<f64> = neighbors.iter().map(|n| {
            let edge_weight = self.graph.edge_weight(current, *n);
            let bias = self.compute_bias(prev, current, *n);
            edge_weight * bias  // Final weight = edge_weight × bias
        }).collect();
        weighted_random_choice(&neighbors, &weights)
    }
}
```

**Why Node2Vec+ (from benchmark):**

| Method | MRR | Hit@1 | Improvement |
|--------|-----|-------|-------------|
| Node2Vec (p=1, q=1) | 0.214 | 7.0% | baseline |
| **Node2Vec+ (p=2, q=0.5)** | **0.227** | **9.3%** | **+5.8%** |

The DFS-like configuration (p=2.0, q=0.5) with edge weight normalization captures longer-range structural patterns.

---

#### Story 15.2: Skip-gram Embedding Training

**Points:** 8
**Priority:** Critical

**Description:**
Implement Skip-gram model training on random walks to generate node embeddings. This converts random walks into dense vector representations.

**Acceptance Criteria:**

- [ ] **AC1:** `SkipGram::new(embedding_dim, window_size, negative_samples)` creates trainer
- [ ] **AC2:** `train(walks: &[Vec<NodeId>], epochs)` trains embeddings
- [ ] **AC3:** Negative sampling for efficient training
- [ ] **AC4:** Output: `HashMap<NodeId, Vec<f32>>` (embedding vectors)
- [ ] **AC5:** Embedding dimension configurable (default: 128)
- [ ] **AC6:** Performance: 10K nodes, 1000 walks → < 5 seconds
- [ ] **AC7:** Embeddings normalized to unit length

**Algorithm:**
```rust
// Skip-gram with negative sampling
fn train_pair(&mut self, target: NodeId, context: NodeId, label: f32) {
    let target_vec = &self.embeddings[target];
    let context_vec = &self.context_embeddings[context];

    let dot = dot_product(target_vec, context_vec);
    let pred = sigmoid(dot);
    let error = label - pred;

    // SGD update
    for i in 0..self.dim {
        self.embeddings[target][i] += self.lr * error * context_vec[i];
        self.context_embeddings[context][i] += self.lr * error * target_vec[i];
    }
}
```

---

#### Story 15.3: Node2Vec API and GQL Integration

**Points:** 5
**Priority:** Critical

**Description:**
Expose Node2Vec via Engine API and optional GQL syntax. Enable TypeScript to call Node2Vec through NAPI.

**Acceptance Criteria:**

- [ ] **AC1:** `Engine::compute_node2vec(params) -> HashMap<NodeId, Vec<f32>>`
- [ ] **AC2:** Parameters: `p`, `q`, `walk_length`, `num_walks`, `embedding_dim`, `epochs`
- [ ] **AC3:** Results stored in graph store as node property `_embedding`
- [ ] **AC4:** GQL: `CALL gds.node2vec({p: 1.0, q: 0.5})` (optional, nice-to-have)
- [ ] **AC5:** NAPI: `engine.computeNode2Vec(params)` returns embeddings as Float32Array
- [ ] **AC6:** Python: `engine.compute_node2vec(params)` returns numpy array

**NAPI Example:**
```typescript
// TypeScript usage via NAPI
const embeddings = engine.computeNode2VecPlus({
  p: 2.0,           // DFS-like (optimal from benchmark)
  q: 0.5,           // Explore
  gamma: 1.0,       // Weight normalization
  walkLength: 15,
  numWalks: 30,
  windowSize: 5,
  embeddingDim: 32,
  epochs: 5
});

// Returns: Map<nodeId, Float32Array>
const vec = embeddings.get(nodeId);
```

---

### Phase 2: Approximate Nearest Neighbors (Critical)

#### Story 15.4: HNSW Index Implementation

**Points:** 8
**Priority:** Critical

**Description:**
Implement Hierarchical Navigable Small World (HNSW) graph for fast approximate nearest neighbor search. This enables O(log n) kNN queries instead of O(n) brute force.

**Acceptance Criteria:**

- [ ] **AC1:** `HnswIndex::new(dim, m, ef_construction)` creates empty index
- [ ] **AC2:** `insert(id: NodeId, vector: &[f32])` adds vector to index
- [ ] **AC3:** `search(query: &[f32], k: usize, ef: usize) -> Vec<(NodeId, f32)>` returns k nearest
- [ ] **AC4:** Distance metric: cosine similarity (configurable: L2, dot product)
- [ ] **AC5:** Multi-layer graph with exponential decay (layer probability = 1/M)
- [ ] **AC6:** Performance: < 1ms for top-10 on 100K vectors
- [ ] **AC7:** Recall > 0.95 at ef=100

**Algorithm:**
```rust
struct HnswIndex {
    layers: Vec<HashMap<NodeId, Vec<NodeId>>>,  // Neighbor lists per layer
    vectors: HashMap<NodeId, Vec<f32>>,
    entry_point: Option<NodeId>,
    m: usize,           // Max neighbors per node
    m_max: usize,       // Max neighbors at layer 0
    ef_construction: usize,
}

fn search(&self, query: &[f32], k: usize, ef: usize) -> Vec<(NodeId, f32)> {
    // Start from entry point at top layer
    let mut current = self.entry_point?;

    // Greedy descent through layers
    for layer in (1..self.layers.len()).rev() {
        current = self.search_layer(query, current, 1, layer)[0].0;
    }

    // Search layer 0 with ef candidates
    let candidates = self.search_layer(query, current, ef, 0);
    candidates.into_iter().take(k).collect()
}
```

---

#### Story 15.5: HNSW Dynamic Updates

**Points:** 5
**Priority:** High

**Description:**
Support dynamic insertion and deletion in HNSW index without full rebuild. Essential for live learning when new capabilities are added.

**Acceptance Criteria:**

- [ ] **AC1:** `insert()` adds new vector and updates neighbor connections
- [ ] **AC2:** `delete(id: NodeId)` removes vector and repairs connections
- [ ] **AC3:** `update(id: NodeId, vector: &[f32])` updates existing vector
- [ ] **AC4:** Insertion maintains graph connectivity (no orphan nodes)
- [ ] **AC5:** Deletion uses "tombstone" approach with lazy cleanup
- [ ] **AC6:** Performance: insert < 10ms, delete < 5ms

---

#### Story 15.6: HNSW NAPI Bindings

**Points:** 3
**Priority:** High

**Description:**
Expose HNSW index via NAPI for TypeScript usage in local-alpha.ts.

**Acceptance Criteria:**

- [ ] **AC1:** `new HnswIndex(dim, m, efConstruction)` creates index
- [ ] **AC2:** `index.insert(id, vector: Float32Array)` adds vector
- [ ] **AC3:** `index.search(query: Float32Array, k, ef)` returns nearest neighbors
- [ ] **AC4:** `index.delete(id)` removes vector
- [ ] **AC5:** Batch operations: `insertBatch(ids, vectors)` for efficiency
- [ ] **AC6:** TypeScript type definitions included

**TypeScript Example:**
```typescript
import { HnswIndex } from 'casys-napi';

const index = new HnswIndex(128, 16, 200);

// Insert Node2Vec embeddings
for (const [nodeId, embedding] of embeddings) {
  index.insert(nodeId, embedding);
}

// Find similar nodes
const neighbors = index.search(queryVector, 10, 100);
// Returns: [{ id: NodeId, distance: number }, ...]
```

---

### Phase 3: GQL Extensions (Medium Priority)

#### Story 15.7: DELETE Clause Support

**Points:** 5
**Priority:** Medium

**Description:**
Add support for DELETE clause in GQL to remove nodes and edges.

**Acceptance Criteria:**

- [ ] **AC1:** Parser recognizes `DELETE n` and `DETACH DELETE n` syntax
- [ ] **AC2:** Planner produces `PlanNode::Delete { variables, detach }`
- [ ] **AC3:** `DELETE n` fails if node has edges (referential integrity)
- [ ] **AC4:** `DETACH DELETE n` removes node and all connected edges
- [ ] **AC5:** Edge deletion: `MATCH (a)-[r]->(b) DELETE r`
- [ ] **AC6:** Cascades to HNSW index if embeddings exist

---

#### Story 15.8: SET Clause Support

**Points:** 5
**Priority:** Medium

**Description:**
Add support for SET clause to update properties on nodes and edges.

**Acceptance Criteria:**

- [ ] **AC1:** Parser recognizes `SET n.prop = value` syntax
- [ ] **AC2:** Parser recognizes `SET n += {props}` (merge properties)
- [ ] **AC3:** Planner produces `PlanNode::Set { assignments }`
- [ ] **AC4:** Executor updates properties in store
- [ ] **AC5:** Returns updated entities in RETURN clause

---

### Phase 4: Integration & Polish (Lower Priority)

#### Story 15.9: Incremental Node2Vec

**Points:** 8
**Priority:** Medium

**Description:**
Support incremental embedding updates when new nodes are added without full recomputation.

**Acceptance Criteria:**

- [ ] **AC1:** `add_node_incremental(node_id)` computes embedding for new node
- [ ] **AC2:** Uses random walks starting from new node only
- [ ] **AC3:** Updates HNSW index with new embedding
- [ ] **AC4:** Approximation error < 5% vs full recompute
- [ ] **AC5:** Performance: < 100ms for single node addition

**Algorithm:**
```rust
fn add_node_incremental(&mut self, node_id: NodeId) {
    // Generate walks starting from new node
    let walks = self.walker.generate_walks(node_id, 80, 10);

    // Average neighbor embeddings as initialization
    let neighbors = self.graph.neighbors(node_id);
    let init: Vec<f32> = neighbors.iter()
        .map(|n| self.embeddings[n].clone())
        .fold(zeros(dim), |a, b| add(&a, &b))
        .map(|x| x / neighbors.len() as f32);

    // Fine-tune with local skip-gram
    self.embeddings.insert(node_id, init);
    self.train_local(&walks, 3);  // Few epochs

    // Update HNSW
    self.hnsw.insert(node_id, &self.embeddings[node_id]);
}
```

---

#### Story 15.10: Embedding Persistence

**Points:** 5
**Priority:** Medium

**Description:**
Store embeddings with graph data for PITR and fast startup.

**Acceptance Criteria:**

- [ ] **AC1:** Embeddings saved in segment format alongside graph data
- [ ] **AC2:** HNSW index serialized to segment
- [ ] **AC3:** Load embeddings on `load_branch()` automatically
- [ ] **AC4:** PITR works: load graph + embeddings at specific timestamp
- [ ] **AC5:** Optional: lazy load embeddings (defer until first query)

---

#### Story 15.11: Storage Adapters (Deferred)

**Points:** 21 (bundled)
**Priority:** Low
**Status:** Deferred to future epic

PostgreSQL, Redis, S3 adapters are infrastructure concerns, not core value. Defer until GDS/ANN is complete and proven.

---

### Phase 0: Refactoring (Technical Debt)

#### Story 15.R1: Unify Value Types

**Points:** 3
**Priority:** High (blocks other work)

**Problem:**
Two different `Value` types exist:
- `casys_core::Value` - Null, Bool, Int, Float, String, Bytes, Array, Map
- `casys_engine::exec::executor::Value` - Null, Bool, Int, Float, String, NodeId

**Acceptance Criteria:**

- [ ] **AC1:** Single `Value` enum in `casys_core` with all variants (including `NodeId`)
- [ ] **AC2:** `casys_engine` re-exports `casys_core::Value`
- [ ] **AC3:** Remove duplicate `Value` from `executor.rs`
- [ ] **AC4:** Update all imports in engine to use `casys_core::Value`
- [ ] **AC5:** Tests pass

---

#### Story 15.R2: Move Graph Types to Core

**Points:** 3
**Priority:** High

**Problem:**
`Node`, `Edge`, `GraphReadStore`, `GraphWriteStore` are in `casys_engine/src/index/` but should be in `casys_core` as domain types and ports.

**Acceptance Criteria:**

- [ ] **AC1:** `Node`, `Edge` structs moved to `casys_core`
- [ ] **AC2:** `GraphReadStore`, `GraphWriteStore` traits moved to `casys_core` (ports)
- [ ] **AC3:** `casys_engine` re-exports these from core
- [ ] **AC4:** Storage adapters can implement `GraphReadStore`/`GraphWriteStore`
- [ ] **AC5:** No breaking changes to public API

---

#### Story 15.R3: Fix Layering Violation in Persistence

**Points:** 5
**Priority:** High (architectural debt)

**Problem:**
`casys_engine/src/index/persistence.rs` imports `casys_storage_fs::catalog` directly, violating hexagonal architecture.

```rust
// VIOLATION - engine depends on concrete adapter
use casys_storage_fs::catalog;
```

**Acceptance Criteria:**

- [ ] **AC1:** Remove direct import of `casys_storage_fs` from engine
- [ ] **AC2:** Persistence uses `StorageBackend` trait (injected)
- [ ] **AC3:** `InMemoryGraphStore::flush_to_segments()` takes `&dyn SegmentStore` parameter
- [ ] **AC4:** `InMemoryGraphStore::load_from_segments()` takes `&dyn SegmentStore` parameter
- [ ] **AC5:** Engine feature `fs` only enables optional convenience constructors
- [ ] **AC6:** Tests use mock storage backend

**Refactored API:**
```rust
// Before (violation)
impl InMemoryGraphStore {
    pub fn flush_to_segments(&self, root: &Path, db: &DatabaseName, branch: &BranchName) -> Result<(), EngineError>
}

// After (hexagonal)
impl InMemoryGraphStore {
    pub fn flush(&self, store: &dyn SegmentStore, root: &Path, db: &DatabaseName) -> Result<(), EngineError>
}
```

---

#### Story 15.R4: Create Workspace Cargo.toml

**Points:** 1
**Priority:** Low

**Problem:**
No workspace `Cargo.toml` at `crates/` root. Each crate managed separately.

**Acceptance Criteria:**

- [ ] **AC1:** Create `crates/Cargo.toml` with workspace members
- [ ] **AC2:** Shared dependencies in `[workspace.dependencies]`
- [ ] **AC3:** `cargo build --workspace` works
- [ ] **AC4:** `cargo test --workspace` runs all tests

---

## Story Map (Revised)

```
     Phase 0             Phase 1              Phase 2              Phase 3           Phase 4
   Refactoring       Graph Data Science       ANN Index         GQL Extensions      Integration
  ───────────────   ─────────────────────   ─────────────────   ─────────────────   ─────────────

  ┌─────────────┐   ┌─────────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────┐
  │ 15.R1 Unify │   │ 15.1 Node2Vec+      │ │ 15.4 HNSW Index │ │ 15.7 DELETE     │ │ 15.9 Increm.│
  │ Value (3pt) │   │ Walks (8 pts)       │ │     (8 pts)     │ │     (5 pts)     │ │ N2V+ (8pts) │
  │    HIGH     │   │     CRITICAL        │ │     CRITICAL    │ │     Medium      │ │   Medium    │
  └─────────────┘   └─────────────────────┘ └─────────────────┘ └─────────────────┘ └─────────────┘

  ┌─────────────┐   ┌─────────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────┐
  │ 15.R2 Graph │   │ 15.2 Skip-gram      │ │ 15.5 HNSW       │ │ 15.8 SET        │ │ 15.10 Embed │
  │ Types (3pt) │   │ Training (8 pts)    │ │ Updates (5 pts) │ │     (5 pts)     │ │ Persist(5pt)│
  │    HIGH     │   │     CRITICAL        │ │     High        │ │     Medium      │ │   Medium    │
  └─────────────┘   └─────────────────────┘ └─────────────────┘ └─────────────────┘ └─────────────┘

  ┌─────────────┐   ┌─────────────────────┐ ┌─────────────────┐
  │ 15.R3 Layer │   │ 15.3 Node2Vec API   │ │ 15.6 HNSW NAPI  │
  │ Fix (5 pts) │   │     (5 pts)         │ │     (3 pts)     │        ┌─────────────────────────┐
  │    HIGH     │   │     CRITICAL        │ │     High        │        │ 15.11 Storage Adapters  │
  └─────────────┘   └─────────────────────┘ └─────────────────┘        │ (21 pts) - DEFERRED     │
                                                                       │ pg/redis/s3 - later     │
  ┌─────────────┐                                                      └─────────────────────────┘
  │ 15.R4 Wksp  │
  │ (1 pt) LOW  │
  └─────────────┘

  ═══════════════════════════════════════════════════════════════════════════════════════════════
  Phase 0: 12 pts   Phase 1: 21 pts       Phase 2: 16 pts       Phase 3: 10 pts      Phase 4: 13 pts
  (Tech Debt)       (CRITICAL)            (CRITICAL/High)       (Medium)             (Medium)

                         Total: 72 pts (excl. deferred 21 pts)
```

---

## Dependencies

### Internal Dependencies

| Story | Depends On | Notes |
|-------|------------|-------|
| **15.R1 Unify Value** | - | Do first (blocks R2) |
| **15.R2 Graph Types** | 15.R1 | Moves Node/Edge to core |
| **15.R3 Layer Fix** | 15.R2 | Clean architecture |
| 15.1 Random Walks | 15.R2 | Uses core types |
| 15.2 Skip-gram | 15.1 | - |
| 15.3 Node2Vec API | 15.1, 15.2 | - |
| 15.4 HNSW Index | 15.R1 | Uses unified Value |
| 15.6 HNSW NAPI | 15.4 | - |
| 15.9 Incremental | 15.1, 15.2, 15.4 | - |
| 15.10 Persistence | 15.R3, 15.3, 15.6 | Needs clean layers |

### Recommended Order

```
15.R1 → 15.R2 → 15.R3 → 15.1 → 15.2 → 15.3 (Node2Vec complete)
                    ↘
                     15.4 → 15.5 → 15.6 (HNSW complete)
```

### External Dependencies

| Dependency | Purpose |
|------------|---------|
| `rand` | Random walk generation |
| `napi-rs` | TypeScript bindings |
| `pyo3` | Python bindings (optional) |

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **MRR improvement** | +500% | Benchmark vs spectral embeddings |
| Node2Vec training | < 5s | 10K nodes, 128-dim |
| HNSW kNN | < 1ms | Top-10 on 100K vectors |
| HNSW recall | > 0.95 | At ef=100 |
| Incremental update | < 100ms | Single node addition |

---

## References

- [Node2Vec Spike](../spikes/2026-01-01-node2vec-local-alpha-integration.md) - +757% MRR benchmark (BGE+Node2Vec vs BGE-only)
- [Node2Vec+ Spike](../spikes/2026-01-04-node2vec-plus-edge-weights.md) - +5.8% MRR improvement (Node2Vec+ vs Node2Vec)
- [Node2Vec+ Paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC9891245/) - Liu & Hirn (2023)
- [Deep-Dive: Rust Crates](../deep-dive-crates.md) - Current architecture
- [ADR-048: Local Adaptive Alpha](../adrs/adr-048-local-adaptive-alpha.md) - Integration target
- [ADR-053: SHGAT V1 K-head](../adrs/ADR-053-shgat-subprocess-per-training.md) - Production SHGAT architecture
- [local-alpha.ts](../../src/graphrag/local-alpha.ts) - TypeScript consumer
