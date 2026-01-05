# Spike: BM25 + RRF Hybrid Search

**Date:** 2025-12-28 **Status:** Exploration **Author:** Erwan + Claude

## Problem Statement

Current `pml:discover` uses embeddings (BGE-M3) for semantic search but lexical matching is weak:

- Exact tool names like `mcp__filesystem__read` don't always rank highest
- FQDN matching relies on semantic similarity which can be fuzzy
- Current fallback is ILIKE with fixed score=0.5 (no ranking)

## Proposed Solution

Add **BM25** (lexical search) alongside embeddings, fuse results with **Reciprocal Rank Fusion
(RRF)**.

```
┌─────────────────────────────────────────────────────────┐
│                  pml:discover / pml:execute              │
├─────────────────────────────────────────────────────────┤
│  Query: "mcp__filesystem__read"                         │
│                                                         │
│  ┌─────────────┐        ┌─────────────────┐            │
│  │   BM25      │        │   Embeddings    │            │
│  │  (lexical)  │        │   (semantic)    │            │
│  └──────┬──────┘        └────────┬────────┘            │
│         │                        │                      │
│         ▼                        ▼                      │
│    rank=[1,3,7]           rank=[2,1,5]                 │
│                                                         │
│         └────────┬───────────────┘                      │
│                  ▼                                      │
│           ┌───────────┐                                │
│           │    RRF    │  1/(k + rank_bm25) +           │
│           │  Fusion   │  1/(k + rank_embed)            │
│           └─────┬─────┘                                │
│                 ▼                                      │
│          final_ranking                                  │
└─────────────────────────────────────────────────────────┘
```

## BM25 Algorithm

Standard Okapi BM25 formula:

```
BM25(D, Q) = Σ IDF(qi) × (f(qi, D) × (k1 + 1)) / (f(qi, D) + k1 × (1 - b + b × |D|/avgdl))
```

Where:

- `f(qi, D)` = term frequency of qi in document D
- `|D|` = document length
- `avgdl` = average document length in corpus
- `k1` = term saturation (typically 1.2-2.0)
- `b` = length normalization (typically 0.75)

## RRF Algorithm

Reciprocal Rank Fusion combines multiple rankings:

```typescript
function rrf(rankings: Map<string, number>[], k = 60): Map<string, number> {
  const scores = new Map<string, number>();

  for (const ranking of rankings) {
    for (const [docId, rank] of ranking) {
      const current = scores.get(docId) || 0;
      scores.set(docId, current + 1 / (k + rank));
    }
  }

  return scores;
}
```

- `k=60` is standard (prevents top ranks from dominating too much)
- Higher k = more uniform weighting across ranks

## Current Architecture Analysis

### What exists

| Component        | File                                   | Current Logic                  |
| ---------------- | -------------------------------------- | ------------------------------ |
| Vector Search    | `src/vector/search.ts`                 | BGE-M3 cosine similarity       |
| Hybrid Search    | `src/graphrag/search/hybrid-search.ts` | semantic + graph (Adamic-Adar) |
| Discover Handler | `src/mcp/handlers/discover-handler.ts` | Final scoring + merging        |
| Fallback         | `src/vector/search.ts:162-201`         | ILIKE with score=0.5           |

### Database indexes (current)

```sql
-- Vector indexes (HNSW)
CREATE INDEX idx_tool_embedding_hnsw ON tool_embedding
  USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);

CREATE INDEX idx_pattern_intent_embedding ON workflow_pattern
  USING hnsw (intent_embedding vector_cosine_ops) WITH (m=16, ef_construction=64);

-- NO full-text search indexes currently!
```

## Implementation Options

### Option A: PostgreSQL tsvector + ts_rank (Recommended)

PostgreSQL has built-in full-text search with ranking similar to BM25.

```sql
-- Migration: Add tsvector columns
ALTER TABLE tool_schema ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, ''))) STORED;

CREATE INDEX idx_tool_schema_fts ON tool_schema USING gin(fts);

-- Query with ranking
SELECT tool_id, name, ts_rank(fts, plainto_tsquery('filesystem read')) AS bm25_score
FROM tool_schema
WHERE fts @@ plainto_tsquery('filesystem read')
ORDER BY bm25_score DESC;
```

**Pros:**

- No external dependencies
- Built into PostgreSQL
- GIN index is fast

**Cons:**

- Not exactly BM25 (ts_rank uses different formula)
- Less tunability than pure BM25

### Option B: Pure TypeScript BM25

Implement BM25 in TypeScript, load all documents in memory.

```typescript
// src/search/bm25.ts
interface BM25Index {
  documents: Map<string, string[]>; // docId -> tokens
  idf: Map<string, number>; // term -> IDF score
  avgDocLength: number;
  k1: number; // 1.5
  b: number; // 0.75
}

function buildBM25Index(docs: { id: string; text: string }[]): BM25Index;
function searchBM25(index: BM25Index, query: string, topK: number): { id: string; score: number }[];
```

**Pros:**

- Exact BM25 algorithm
- Full control over tokenization
- Works with any DB

**Cons:**

- Memory overhead (all docs in RAM)
- Need to sync index with DB

### Option C: Hybrid PostgreSQL + Weighted Fusion

Combine `ts_rank` with custom weighting for tool names (exact match boost).

```sql
SELECT tool_id, name,
  ts_rank(fts, q) * 0.5 +
  CASE WHEN name ILIKE '%' || $1 || '%' THEN 0.5 ELSE 0 END AS score
FROM tool_schema, plainto_tsquery('english', $1) q
WHERE fts @@ q OR name ILIKE '%' || $1 || '%'
ORDER BY score DESC;
```

## Proposed Implementation Plan

### Phase 1: Database Schema (Migration 021)

```sql
-- Add FTS columns
ALTER TABLE tool_schema ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

ALTER TABLE workflow_pattern ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

-- Create GIN indexes
CREATE INDEX idx_tool_schema_fts ON tool_schema USING gin(fts);
CREATE INDEX idx_workflow_pattern_fts ON workflow_pattern USING gin(fts);
```

### Phase 2: BM25 Search Module

```typescript
// src/search/bm25-search.ts
export interface BM25Result {
  id: string;
  name: string;
  score: number;
  rank: number;
}

export async function searchToolsBM25(
  db: PGlite,
  query: string,
  topK: number = 20,
): Promise<BM25Result[]> {
  const result = await db.query(
    `
    SELECT tool_id, name, ts_rank(fts, plainto_tsquery($1)) AS score
    FROM tool_schema
    WHERE fts @@ plainto_tsquery($1)
    ORDER BY score DESC
    LIMIT $2
  `,
    [query, topK],
  );

  return result.rows.map((row, idx) => ({
    id: row.tool_id,
    name: row.name,
    score: row.score,
    rank: idx + 1,
  }));
}
```

### Phase 3: RRF Fusion

```typescript
// src/search/rrf-fusion.ts
export interface RankedResult {
  id: string;
  name: string;
  scores: {
    bm25?: number;
    embedding?: number;
    graph?: number;
  };
  ranks: {
    bm25?: number;
    embedding?: number;
    graph?: number;
  };
  rrfScore: number;
}

export function fuseWithRRF(
  bm25Results: BM25Result[],
  embeddingResults: VectorSearchResult[],
  k: number = 60,
): RankedResult[] {
  const scores = new Map<string, RankedResult>();

  // Add BM25 ranks
  for (const r of bm25Results) {
    const entry = scores.get(r.id) || createEmpty(r.id, r.name);
    entry.ranks.bm25 = r.rank;
    entry.scores.bm25 = r.score;
    entry.rrfScore += 1 / (k + r.rank);
    scores.set(r.id, entry);
  }

  // Add embedding ranks
  for (let i = 0; i < embeddingResults.length; i++) {
    const r = embeddingResults[i];
    const rank = i + 1;
    const entry = scores.get(r.toolId) || createEmpty(r.toolId, r.toolName);
    entry.ranks.embedding = rank;
    entry.scores.embedding = r.similarity;
    entry.rrfScore += 1 / (k + rank);
    scores.set(r.toolId, entry);
  }

  return [...scores.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}
```

### Phase 4: Integration in discover-handler.ts

```typescript
// In searchTools()
async function searchTools(intent: string): Promise<DiscoverResultItem[]> {
  // Parallel search
  const [embeddingResults, bm25Results] = await Promise.all([
    graphEngine.searchToolsHybrid(intent, contextTools, topK),
    searchToolsBM25(db, intent, topK),
  ]);

  // RRF fusion
  const fusedResults = fuseWithRRF(bm25Results, embeddingResults);

  // Apply reliability factor (existing logic)
  return fusedResults.map((r) => ({
    ...r,
    score: Math.min(r.rrfScore * reliabilityFactor, 0.95), // ADR-038 cap
  }));
}
```

## Benchmarks to Run

### Test Cases

1. **Exact name match:**
   - Query: `mcp__filesystem__read`
   - Expected: `mcp__filesystem__read_file` should be #1

2. **Partial name match:**
   - Query: `filesystem`
   - Expected: All filesystem tools in top 5

3. **FQDN lookup:**
   - Query: `local.default.fs.read_json.a7f3`
   - Expected: Exact capability #1

4. **Semantic only:**
   - Query: `read configuration files`
   - Expected: Config-related tools/capabilities ranked high

5. **Mixed:**
   - Query: `mcp read config`
   - Expected: Good balance of lexical + semantic

### Metrics

- **MRR** (Mean Reciprocal Rank) for exact matches
- **NDCG@5** for relevance ranking
- **Latency** P50/P95 for search

## Open Questions

1. **Weight tuning:** Should RRF use k=60 or tune per-use-case?
2. **Graph integration:** Keep current graph score or fold into RRF?
3. **Tokenization:** Use PostgreSQL default or custom for tool names (split on `__`, `:`, etc.)?
4. **Caching:** Cache BM25 index in memory or always query DB?

## Next Steps

1. [ ] Create migration 021 for FTS columns
2. [ ] Implement `src/search/bm25-search.ts`
3. [ ] Implement `src/search/rrf-fusion.ts`
4. [ ] Integrate in discover-handler.ts
5. [ ] Benchmark with test cases
6. [ ] Tune k and weights based on results

## References

- [Okapi BM25 (Wikipedia)](https://en.wikipedia.org/wiki/Okapi_BM25)
- [RRF Paper (Cormack et al., 2009)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [PostgreSQL Full Text Search](https://www.postgresql.org/docs/current/textsearch.html)
- [Hybrid Search Best Practices](https://www.pinecone.io/learn/hybrid-search/)
