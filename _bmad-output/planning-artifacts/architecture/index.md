# Architecture Documentation - Casys PML

## Overview

- [Executive Summary](./executive-summary.md) - Vision, 3-layer architecture, key metrics
- [Technology Stack](./technology-stack-details.md) - Runtime, storage, ML, integrations
- [Epic to Architecture Mapping](./epic-to-architecture-mapping.md) - Epics → modules/components

## Core Design

- [Data Architecture](./data-architecture.md) - Database schema, PGlite, migrations
- [Security Architecture](./security-architecture.md) - Auth, sandbox, permissions
- [Performance Considerations](./performance-considerations.md) - Targets, optimization strategies
- [Deployment Architecture](./deployment-architecture.md) - Local vs cloud, dual-server setup

## Patterns

→ **[All Patterns Index](./patterns/index.md)**

### Core Patterns (1-7)

- [01 - DAG Builder JSON Schema](./patterns/01-dag-builder-json-schema.md)
- [02 - Context Budget Management](./patterns/02-context-budget-management.md)
- [03 - Speculative Execution](./patterns/03-speculative-execution-graphrag.md) - THE Feature
- [04 - 3-Loop Learning](./patterns/04-3-loop-learning.md) - AIL/HIL
- [05 - Scoring & Alpha](./patterns/05-scoring-algorithms-alpha.md)
- [06 - Two-Level DAG](./patterns/06-two-level-dag.md) - Phase 2a
- [07 - SHGAT Architecture](./patterns/07-shgat-architecture.md) - Modular

### Epic-Specific Patterns (8-10)

- [08 - Agent Code Execution](./patterns/08-agent-code-execution.md) - Epic 3
- [09 - Worker RPC Bridge](./patterns/09-worker-rpc-bridge.md) - Epic 7
- [10 - Hypergraph Visualization](./patterns/10-hypergraph-visualization.md) - Epic 8

## Implementation

- [Implementation Patterns](./implementation-patterns.md) - Naming, code organization, error
  handling, logging
- [Project Structure](./project-structure.md) - Directory layout, module boundaries

## Static Analysis

- [SWC Static Structure Detection](./swc-static-structure-detection.md) - ⭐ Core: AST parsing, code
  operations, literal bindings, argument extraction

## Tech-Specs

- [Modular DAG Execution](../tech-specs/modular-dag-execution/index.md) - Phase 1/2, Two-Level DAG,
  SHGAT Learning

## Decisions

- [Architecture Decision Records](./architecture-decision-records-adrs.md) →
  [Full ADR Index](../adrs/index.md)

---

## Quick Links

| Need                  | Document                                                   |
| --------------------- | ---------------------------------------------------------- |
| What is PML?          | [Executive Summary](./executive-summary.md)                |
| What tech do we use?  | [Technology Stack](./technology-stack-details.md)          |
| Database schema?      | [Data Architecture](./data-architecture.md)                |
| Architecture pattern? | [Patterns Index](./patterns/index.md)                      |
| DAG/SHGAT details?    | [Tech-Specs](../tech-specs/modular-dag-execution/index.md) |
| How to name things?   | [Implementation Patterns](./implementation-patterns.md)    |
| Why this decision?    | [ADR Index](../adrs/index.md)                              |
| Epic status?          | [Epic Mapping](./epic-to-architecture-mapping.md)          |

---

_Updated: 2025-12-28_
