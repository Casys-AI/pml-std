# ADR-001: PGlite over SQLite for Vector Search

**Status:** accepted **Date:** 2025-11-03 **Implementation:** done

## Decision

Use PGlite (PostgreSQL WASM) with pgvector instead of SQLite + sqlite-vec

## Context

The system requires efficient vector search for tool embeddings and semantic discovery. Key
requirements:

- <100ms P95 vector search (NFR001)
- Single-file portability (zero-config)
- Deno compatibility

## Rationale

- sqlite-vec v0.1.0 lacks HNSW index (full-scan only)
- pgvector provides production-ready HNSW + IVFFlat
- PGlite is embedded (3MB WASM), preserves portability requirement
- Deno compatibility verified (npm:@electric-sql/pglite)
- Trade-off: 3MB overhead vs <1MB SQLite, acceptable for performance gain

## Consequences

### Positive

- Enables <100ms P95 vector search (NFR001)
- Single-file portability maintained
- PostgreSQL ecosystem access (future extensions)

### Negative

- 3MB WASM overhead vs <1MB SQLite
- PostgreSQL-specific SQL syntax

## Alternatives Considered

| Alternative     | Reason Rejected                                |
| --------------- | ---------------------------------------------- |
| sqlite-vec      | No HNSW index, full-scan only                  |
| DuckDB VSS      | Experimental persistence, Deno support unclear |
| Full PostgreSQL | Breaks zero-config requirement                 |
