# Tech Spec: CasysDB GDS Integration (Node2Vec + HNSW)

**Status:** Draft
**Date:** 2026-01-03
**Related:** Spike Node2Vec Local Alpha, ADR-048 (Local Adaptive Alpha)
**Author:** Erwan + Claude

## 1. Contexte et Motivation

### Benchmark Results

Le spike `hybrid-embeddings.ts` a démontré :

| Méthode | MRR | Amélioration |
|---------|-----|--------------|
| BGE seul | 0.041 | baseline |
| BGE + Node2Vec | 0.355 | **+757%** |
| BGE + Spectral | < 0.355 | moins bon |

Node2Vec surpasse les embeddings spectraux car il capture les **patterns de co-occurrence locaux** (random walks) plutôt que la structure communautaire globale (eigenvectors).

### Problème actuel

- `local-alpha.ts` utilise des embeddings spectraux pour la similarité structurelle
- L'implémentation TS de Node2Vec est O(n²) - trop lente pour production
- Pas de persistence des embeddings graph (recalcul au startup)

### Solution proposée

Implémenter Node2Vec + HNSW nativement en Rust dans les crates CasysDB, exposer via napi bindings.

## 2. Architecture cible

```
┌─────────────────────────────────────────────────────────────────┐
│                      AgentCards (TS)                            │
├─────────────────────────────────────────────────────────────────┤
│  local-alpha.ts                                                 │
│  ├── computeAlphaEmbeddingsHybrides()                          │
│  │   └── casysNapi.node2vecSimilarity(nodeA, nodeB)  ──────────┼──┐
│  └── Pearson correlation (semantic vs structural)              │  │
├─────────────────────────────────────────────────────────────────┤  │
│  search/scoring                                                 │  │
│  └── casysNapi.hnswQuery(embedding, k)  ───────────────────────┼──┤
└─────────────────────────────────────────────────────────────────┘  │
                                                                     │
┌─────────────────────────────────────────────────────────────────┐  │
│                    crates/casys_napi (N-API)                    │◄─┘
├─────────────────────────────────────────────────────────────────┤
│  #[napi] fn node2vec_train(graph_edges, config)                 │
│  #[napi] fn node2vec_similarity(node_a, node_b)                 │
│  #[napi] fn node2vec_embedding(node_id) → Vec<f32>              │
│  #[napi] fn hnsw_build(embeddings, config)                      │
│  #[napi] fn hnsw_query(embedding, k) → Vec<(node_id, score)>    │
│  #[napi] fn hnsw_insert(node_id, embedding)                     │
└────────────────────────────────────────────────────────────────┬┘
                                                                 │
┌─────────────────────────────────────────────────────────────────▼┐
│                    crates/casys_engine                           │
├──────────────────────────────────────────────────────────────────┤
│  src/gds/mod.rs         ← Graph Data Science                     │
│  ├── node2vec.rs        ← Random walks + Skip-gram (~200 LOC)    │
│  ├── pagerank.rs        ← (future)                               │
│  └── community.rs       ← (future)                               │
│                                                                  │
│  src/ann/mod.rs         ← Approximate Nearest Neighbors          │
│  ├── hnsw.rs            ← Hierarchical NSW index (~150 LOC)      │
│  └── flat.rs            ← Brute-force baseline                   │
└──────────────────────────────────────────────────────────────────┘
```

## 3. Composants à implémenter

### 3.1 Node2Vec (casys_engine/src/gds/node2vec.rs)

```rust
/// Node2Vec configuration
pub struct Node2VecConfig {
    pub dimensions: usize,      // 64 default
    pub walk_length: usize,     // 80 default
    pub num_walks: usize,       // 10 per node
    pub p: f32,                 // Return parameter (1.0)
    pub q: f32,                 // In-out parameter (1.0)
    pub window_size: usize,     // Skip-gram window (5)
    pub epochs: usize,          // Training epochs (5)
    pub learning_rate: f32,     // 0.025
}

/// Node2Vec model
pub struct Node2Vec {
    embeddings: HashMap<NodeId, Vec<f32>>,
    config: Node2VecConfig,
}

impl Node2Vec {
    /// Train on graph edges
    pub fn train(edges: &[(NodeId, NodeId, f32)], config: Node2VecConfig) -> Self;

    /// Get embedding for node
    pub fn embedding(&self, node: NodeId) -> Option<&[f32]>;

    /// Cosine similarity between two nodes
    pub fn similarity(&self, a: NodeId, b: NodeId) -> Option<f32>;

    /// Incremental update for new node (approximate)
    pub fn insert_node(&mut self, node: NodeId, neighbors: &[(NodeId, f32)]);

    /// Serialize/deserialize
    pub fn save(&self, path: &Path) -> Result<()>;
    pub fn load(path: &Path) -> Result<Self>;
}
```

**Algorithme simplifié:**
1. Generate random walks with biased transition probabilities (p, q)
2. Train Skip-gram model on walks (node = "word", walk = "sentence")
3. Output: dense embedding per node

### 3.2 HNSW (casys_engine/src/ann/hnsw.rs)

```rust
/// HNSW configuration
pub struct HnswConfig {
    pub m: usize,               // Max connections per layer (16)
    pub ef_construction: usize, // Build-time beam width (200)
    pub ef_search: usize,       // Query-time beam width (50)
    pub max_elements: usize,    // Pre-allocated capacity
}

/// HNSW index
pub struct HnswIndex {
    layers: Vec<Layer>,
    config: HnswConfig,
}

impl HnswIndex {
    /// Build index from embeddings
    pub fn build(embeddings: &[(NodeId, Vec<f32>)], config: HnswConfig) -> Self;

    /// Query k nearest neighbors
    pub fn query(&self, embedding: &[f32], k: usize) -> Vec<(NodeId, f32)>;

    /// Insert new element (incremental)
    pub fn insert(&mut self, node: NodeId, embedding: Vec<f32>);

    /// Serialize/deserialize
    pub fn save(&self, path: &Path) -> Result<()>;
    pub fn load(path: &Path) -> Result<Self>;
}
```

### 3.3 N-API Bindings (casys_napi/src/gds.rs)

```rust
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct Node2VecOptions {
    pub dimensions: Option<u32>,
    pub walk_length: Option<u32>,
    pub num_walks: Option<u32>,
    pub p: Option<f64>,
    pub q: Option<f64>,
}

#[napi]
pub struct CasysGds {
    node2vec: Option<Node2Vec>,
    hnsw: Option<HnswIndex>,
}

#[napi]
impl CasysGds {
    #[napi(constructor)]
    pub fn new() -> Self;

    /// Train Node2Vec on graph edges: [[from, to, weight], ...]
    #[napi]
    pub fn node2vec_train(&mut self, edges: Vec<Vec<f64>>, options: Option<Node2VecOptions>) -> Result<()>;

    /// Get similarity between two nodes
    #[napi]
    pub fn node2vec_similarity(&self, node_a: String, node_b: String) -> Option<f64>;

    /// Get embedding vector
    #[napi]
    pub fn node2vec_embedding(&self, node_id: String) -> Option<Vec<f64>>;

    /// Build HNSW index from current Node2Vec embeddings
    #[napi]
    pub fn hnsw_build(&mut self) -> Result<()>;

    /// Query k nearest neighbors
    #[napi]
    pub fn hnsw_query(&self, embedding: Vec<f64>, k: u32) -> Vec<QueryResult>;

    /// Save models to directory
    #[napi]
    pub fn save(&self, dir: String) -> Result<()>;

    /// Load models from directory
    #[napi]
    pub fn load(&mut self, dir: String) -> Result<()>;
}
```

## 4. Intégration avec Local Alpha

### Modification de local-alpha.ts

```typescript
// AVANT (spectral - edge weight only)
const structuralSim = this.getEdgeWeight(nodeId, neighbor);

// APRÈS (Node2Vec via napi)
import { CasysGds } from '@pml/casys-napi';

const gds = new CasysGds();
// ... trained earlier

const structuralSim = gds.node2vecSimilarity(nodeId, neighbor) ?? 0;
```

### Pipeline complet

```
                         ┌─────────────────────────────┐
                         │       Local Alpha           │
                         │  (Pearson correlation)      │
Texte ──→ BGE ───────────┤                             ├──→ Score final
         (semantic)      │   coherence(sem, struct)    │
                         │   → alpha ∈ [0.5, 1.0]      │
Graph ──→ Node2Vec ──────┤                             │
         (via CasysGds)  │   high coherence → low α    │
                         │   low coherence → high α    │
                         └─────────────────────────────┘
```

## 5. Gestion du Live Learning

### Problème

Quand un nouveau capability est ajouté :
1. Graph change (nouveau node + edges)
2. Node2Vec embeddings deviennent stales
3. Recalcul complet = coûteux

### Solutions

| Stratégie | Quand | Complexité |
|-----------|-------|------------|
| **Full retrain** | Au startup, ou périodique (horaire) | O(n × walks) |
| **Incremental** | À chaque insert | O(neighbors) approximatif |
| **Lazy** | Quand node est query sans embedding | O(neighbors) |

### Implémentation recommandée

1. **Startup**: Full train sur graph existant
2. **Insert**: Approximation rapide via moyennage des voisins
3. **Background**: Retrain complet toutes les heures (ou 100 inserts)

```typescript
// Pseudo-code
class GdsManager {
  private gds: CasysGds;
  private insertsSinceRetrain = 0;

  async onCapabilityAdded(cap: Capability, edges: Edge[]) {
    // Approximation rapide
    const neighborEmbeddings = edges.map(e => this.gds.node2vecEmbedding(e.target));
    const approxEmbedding = average(neighborEmbeddings);
    this.gds.insertApproximate(cap.id, approxEmbedding);

    this.insertsSinceRetrain++;
    if (this.insertsSinceRetrain > 100) {
      await this.scheduleRetrain();
    }
  }
}
```

## 6. Stockage et Persistence

### Option A: Fichiers (simple)

```
data/
├── gds/
│   ├── node2vec.bin     # Embeddings sérialisés
│   └── hnsw.bin         # Index sérialisé
```

### Option B: CasysDB branches (PITR)

```rust
// Stocker embeddings comme propriétés de nodes
engine.execute_gql_on_store(&mut store, &GqlQuery(r#"
  MATCH (c:Capability {id: $id})
  SET c.node2vec_embedding = $embedding
"#), params)?;
```

**Recommandation**: Option A pour MVP, Option B pour versioning/PITR.

## 7. Tasks

### Phase 1: Core Rust Implementation

- [ ] **T1.1** Implémenter `casys_engine/src/gds/node2vec.rs`
  - Random walk generation avec biais p/q
  - Skip-gram training simplifié
  - Serialization bincode

- [ ] **T1.2** Implémenter `casys_engine/src/ann/hnsw.rs`
  - Layer structure avec M connections
  - Insert avec ef_construction
  - Query avec ef_search
  - Serialization

- [ ] **T1.3** Tests unitaires Rust
  - `tests/gds_test.rs`
  - `tests/ann_test.rs`

### Phase 2: N-API Bindings

- [ ] **T2.1** Ajouter `casys_napi/src/gds.rs`
  - Wrapper `CasysGds` struct
  - Conversion types Rust ↔ JS

- [ ] **T2.2** Build et publish npm package
  - `@pml/casys-napi`
  - Prebuild binaries (linux-x64, darwin-arm64)

### Phase 3: TS Integration

- [ ] **T3.1** Modifier `local-alpha.ts`
  - Remplacer spectral par Node2Vec
  - Lazy loading du module

- [ ] **T3.2** Ajouter `GdsManager` service
  - Lifecycle (train/save/load)
  - Incremental updates
  - Background retrain

### Phase 4: Tests et Benchmark

- [ ] **T4.1** Benchmark MRR avec Node2Vec natif vs TS
- [ ] **T4.2** Tests d'intégration avec vraies traces
- [ ] **T4.3** Load test (10k nodes, 100k edges)

## 8. Acceptance Criteria

- [ ] `cargo test` passe pour tous les crates
- [ ] Node2Vec training < 1s pour 1000 nodes
- [ ] HNSW query < 1ms pour k=10
- [ ] MRR >= 0.35 (matching spike results)
- [ ] Incremental insert < 10ms
- [ ] Memory < 100MB pour 10k nodes

## 9. Risques et Mitigations

| Risque | Impact | Mitigation |
|--------|--------|------------|
| Node2Vec plus lent que prévu en Rust | Medium | Profiling, SIMD, parallélisme rayon |
| HNSW recall trop bas | High | Tuning ef_construction/ef_search |
| N-API overhead significatif | Medium | Batch operations, moins d'aller-retours |
| Embeddings stales après inserts | Low | Background retrain + approximation |

## 10. Références

- `src/graphrag/hybrid-embeddings.ts` - Spike Node2Vec TS
- `src/graphrag/local-alpha.ts` - Current adaptive alpha (ADR-048)
- `crates/casys_engine/src/gds/mod.rs` - Placeholder actuel
- `crates/casys_engine/src/ann/mod.rs` - Placeholder actuel
- [Node2Vec paper](https://arxiv.org/abs/1607.00653)
- [HNSW paper](https://arxiv.org/abs/1603.09320)
