# ADR-002: Custom DAG Implementation (Zero External Dependencies)

**Status:** accepted **Date:** 2025-11-03 **Implementation:** done

## Decision

Implement DAG builder and executor from scratch, no external graph libraries for core DAG
operations.

## Context

Story 2.1 AC explicitly requires "custom, zero external dependency" for DAG implementation. The
system needs topological sorting and parallel execution capabilities.

## Rationale

- Story 2.1 AC explicitly requires "custom, zero external dependency"
- Topological sort is ~50 LOC (simple algorithm)
- Avoids dependency bloat for single-purpose feature
- Educational value for agents implementing this
- Full control over execution semantics

## Consequences

### Positive

- Full control over algorithm
- No security vulnerabilities from external deps
- Smaller bundle size
- No dependency update maintenance

### Negative

- More testing required (edge cases, cycles)
- Must implement algorithms ourselves

## Implementation

Key components:

- `src/dag/builder.ts` - DAG construction from tool dependencies
- `src/dag/executor.ts` - Parallel execution with topological ordering
- `src/dag/types.ts` - Type definitions

## Note

This ADR applies to core DAG operations. Graphology (ADR-005) is used separately for GraphRAG
algorithms (PageRank, community detection) which are non-trivial to implement correctly.
