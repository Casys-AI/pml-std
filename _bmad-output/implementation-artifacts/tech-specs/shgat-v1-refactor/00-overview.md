# SHGAT v1 Refactor: n-SuperHyperGraph Multi-Level Message Passing

**Status**: Draft **Author**: Architecture Team **Date**: 2025-01-XX **Related ADRs**: ADR-050
(SHGAT v2), ADR-051 (DR-DSP)

---

## Executive Summary

Current SHGAT implementation flattens hierarchical capabilities via `collectTransitiveTools()`,
losing n-SuperHyperGraph structure. This refactor implements true multi-level message passing: **V →
E^0 → E^1 → ... → E^n → ... → E^1 → E^0 → V** where capabilities can contain other capabilities as
members, preserving recursive hierarchy.

**Key Changes**:

- Unified `Member` type (tools OR capabilities)
- Multi-level incidence structure replacing single flattened matrix
- N-phase message passing (upward aggregation + downward propagation)
- Hierarchy level computation via topological ordering
- Backward compatibility with legacy API

---

## Document Structure

This tech spec is split into focused documents:

| File                                                         | Description                            | Status |
| ------------------------------------------------------------ | -------------------------------------- | ------ |
| [01-data-model.md](./01-data-model.md)                       | Member type, CapabilityNode, ToolNode  | Draft  |
| [02-hierarchy-computation.md](./02-hierarchy-computation.md) | Topological sort, level computation    | Draft  |
| [03-incidence-structure.md](./03-incidence-structure.md)     | Multi-level incidence matrices I₀, I_k | Draft  |
| [04-message-passing.md](./04-message-passing.md)             | Upward + Downward passes               | Draft  |
| [05-parameters.md](./05-parameters.md)                       | LevelParams, initialization, count     | Draft  |
| [06-scoring-api.md](./06-scoring-api.md)                     | scoreAllCapabilities() changes         | Draft  |
| [07-training.md](./07-training.md)                           | Gradient computation, backprop         | Draft  |
| [08-migration.md](./08-migration.md)                         | Backward compat, DB schema changes     | Draft  |
| [09-testing.md](./09-testing.md)                             | Tests, benchmarks, performance         | Draft  |
| [progress.md](./progress.md)                                 | Implementation checklist               | -      |

---

## Mathematical Foundation

### n-SuperHyperGraph Definition (Smarandache)

Given base vertex set V₀:

- **P^0(V₀) = V₀**: Tools (vertices)
- **P^1(V₀) = P(V₀)**: Level-0 Capabilities (hyperedges over V₀)
- **P^2(V₀) = P(P(V₀))**: Level-1 Meta-Capabilities (hyperedges over P^1)
- **P^n(V₀)**: Level-(n-1) capabilities (hyperedges over P^(n-1))

### Hierarchy Levels

For capability c ∈ P^k(V₀):

```
level(c) = 0    if c contains only tools (c ⊆ V₀)
level(c) = 1 + max{level(c') | c' ∈ c}    otherwise
```

**Topological Property** (from Fujita DASH): In acyclic n-SuperHyperGraph, capabilities can be
totally ordered such that all containment edges are forward edges.

### Message Passing Phases

#### Upward Aggregation (V → E^0 → E^1 → ... → E^L_max)

For each level k from 0 to L_max:

**Phase k=0 (Tools → Level-0 Caps)**:

```
E^0 = σ(I₀^T · (H^V ⊙ α₀))
```

**Phase k>0 (Level-(k-1) → Level-k Caps)**:

```
E^k = σ(I_k^T · (E^(k-1) ⊙ α_k))
```

#### Downward Propagation (E^L_max → ... → E^1 → E^0 → V)

For each level k from L_max-1 down to 0:

**Phase k≥0 (Level-(k+1) → Level-k Caps)**:

```
E^k ← E^k + σ(I_{k+1} · (E^(k+1) ⊙ β_k))
```

**Phase k=-1 (Level-0 → Tools)**:

```
H^V ← H^V + σ(I₀ · (E^0 ⊙ β_{-1}))
```

---

## References

1. **Smarandache, F.** (1998). "n-SuperHyperGraph and Plithogenic n-SuperHyperGraph"
2. **Fujita, Y.** (2025). "DASH: Directed Acyclic SuperHyperGraphs" - Topological ordering theorem
3. **Böhmová et al.** "Sequence Hypergraphs: Paths, Flows, and Cuts" - Sequential structure
   preservation
4. **ADR-050**: SHGAT v2 TraceFeatures integration
5. **ADR-051**: DR-DSP pathfinding with SHGAT scoring

---

## Example Hierarchy

```
Tools (V₀):
  t1: git-clone
  t2: npm-install
  t3: npm-test
  t4: docker-build
  t5: kubectl-apply

Level 0 Capabilities (E^0):
  cap-setup: [t1, t2]                    # Clone + install
  cap-test: [t3]                         # Run tests
  cap-deploy: [t4, t5]                   # Build + deploy

Level 1 Meta-Capabilities (E^1):
  meta-ci: [cap-setup, cap-test]         # CI pipeline
  meta-cd: [cap-deploy]                  # CD pipeline

Level 2 Super-Capabilities (E^2):
  super-release: [meta-ci, meta-cd]      # Full release workflow

Incidence Matrices:
  I₀: t1→cap-setup, t2→cap-setup, t3→cap-test, t4→cap-deploy, t5→cap-deploy
  I₁: cap-setup→meta-ci, cap-test→meta-ci, cap-deploy→meta-cd
  I₂: meta-ci→super-release, meta-cd→super-release

Message Flow:
  Upward:  [t1,t2,t3,t4,t5] → [cap-setup, cap-test, cap-deploy]
           → [meta-ci, meta-cd] → [super-release]

  Downward: [super-release] → [meta-ci, meta-cd]
            → [cap-setup, cap-test, cap-deploy] → [t1,t2,t3,t4,t5]
```

Final tool embeddings H contain context from ALL hierarchy levels. Final capability embeddings E^k
contain context from children AND parents.
