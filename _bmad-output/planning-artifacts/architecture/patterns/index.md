# Architecture Patterns

Index des patterns d'architecture du projet PML.

> **Tech-Spec détaillée:**
> [`docs/tech-specs/modular-dag-execution/`](../../tech-specs/modular-dag-execution/index.md)

## Core Patterns (Algorithmic)

| #  | Pattern                                                         | Description                          | ADRs                                    |
| -- | --------------------------------------------------------------- | ------------------------------------ | --------------------------------------- |
| 01 | [DAG Builder JSON Schema](./01-dag-builder-json-schema.md)      | Dependency detection via JSON Schema | ADR-002, 010, 022                       |
| 02 | [Context Budget Management](./02-context-budget-management.md)  | <5% context consumption, meta-tools  | ADR-013                                 |
| 03 | [Speculative Execution](./03-speculative-execution-graphrag.md) | THE Feature - 0ms latency            | ADR-005, 006, 010, 030                  |
| 04 | [3-Loop Learning](./04-3-loop-learning.md)                      | AIL/HIL adaptive feedback            | ADR-007, 008, 020                       |
| 05 | [Scoring Algorithms](./05-scoring-algorithms-alpha.md)          | Search/Prediction/Suggestion modes   | ADR-051 (supersedes 015, 022, 038, 048) |
| 06 | [Two-Level DAG](./06-two-level-dag.md)                          | Phase 2a - Logical/Physical fusion   | ADR-052                                 |
| 07 | [SHGAT Architecture](./07-shgat-architecture.md)                | Modular n-SuperHyperGraph            | ADR-053                                 |

## Epic-Specific Patterns (Implementation)

| #  | Pattern                                                      | Epic   | Description           |
| -- | ------------------------------------------------------------ | ------ | --------------------- |
| 08 | [Agent Code Execution](./08-agent-code-execution.md)         | Epic 3 | Sandbox, safe-to-fail |
| 09 | [Worker RPC Bridge](./09-worker-rpc-bridge.md)               | Epic 7 | Capabilities learning |
| 10 | [Hypergraph Visualization](./10-hypergraph-visualization.md) | Epic 8 | Compound graphs       |

---

_Updated: 2025-12-28_
