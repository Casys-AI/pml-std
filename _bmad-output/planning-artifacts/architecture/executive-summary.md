# Executive Summary

_Updated: December 2025_

## Vision

**Casys PML** (PML) is an **intelligent MCP gateway** that solves two critical problems in MCP
ecosystems:

1. **LLM context saturation** — Tool schemas consume 30-50% of the context window → reduced to
   **<5%**
2. **Sequential latency** — Multi-tool workflows run serially → parallelized via **DAG execution**
   (5x speedup)

## Key Differentiation

| Problem                        | PML Solution                                | Benefit               |
| ------------------------------ | ------------------------------------------- | --------------------- |
| 100+ tools = saturated context | Meta-tools only + semantic search on-demand | <5% context used      |
| Sequential workflows           | DAG with automatic dependency detection     | 5x speedup            |
| Static suggestions             | GraphRAG (PageRank, Louvain, Adamic-Adar)   | Continuous learning   |
| Manual execution               | Speculative Execution (confidence > 0.85)   | 0ms perceived latency |
| Code isolated from tools       | Sandbox with MCP injection                  | Hybrid orchestration  |

## 3-Layer Architecture

> **Interactive diagram:**
> [architecture-overview.excalidraw](../diagrams/architecture-overview.excalidraw)

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: ORCHESTRATION (Claude / LLM)                      │
│  • Receives user intent                                     │
│  • Calls PML meta-tools (pml:execute_dag, etc.)             │
│  • Sees only aggregated results                             │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: INTELLIGENT GATEWAY                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Vector Search│  │  DAG Engine  │  │  GraphRAG Engine │   │
│  │  (BGE-M3)    │  │  (Parallel)  │  │  (Graphology)    │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Speculation │  │   Learning   │  │    Sandbox       │   │
│  │   Engine     │  │   (Episodic) │  │   (Worker RPC)   │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  LAYER 3: MCP SERVERS                                       │
│  filesystem, github, memory, slack, notion, tavily, etc.    │
└─────────────────────────────────────────────────────────────┘
```

## Technology Stack

| Component        | Technology                | Justification                           |
| ---------------- | ------------------------- | --------------------------------------- |
| Runtime          | Deno 2.x                  | Native TypeScript, secure by default    |
| Database         | PGlite (PostgreSQL WASM)  | Portable single-file, built-in pgvector |
| ORM              | Drizzle ORM               | Type-safe, migrations, users table      |
| Vector Search    | pgvector HNSW             | <100ms P95, 1024-dim embeddings         |
| Embeddings       | BGE-M3 (Transformers.js)  | 100% local, multilingual, SOTA open     |
| Graph Algorithms | Graphology                | PageRank, Louvain, bidirectional search |
| MCP Protocol     | @modelcontextprotocol/sdk | Official SDK, stdio + HTTP transport    |
| Web UI           | Fresh 2 + Vite + Preact   | SSR, islands architecture, Tailwind 4   |
| Auth             | GitHub OAuth + API Keys   | Deno KV sessions, Argon2id hashing      |

## Target Metrics

| Metric                   | Target           | Status         |
| ------------------------ | ---------------- | -------------- |
| Context usage            | <5%              | ✅ Achieved    |
| Vector search P95        | <100ms           | ✅ Achieved    |
| 5-tool workflow P95      | <3s              | ✅ Achieved    |
| DAG speedup              | 5x vs sequential | ✅ Achieved    |
| Speculation success rate | >85%             | 🟡 In progress |

## Epic Roadmap

```
Epic 1-3   ✅ DONE      Foundation + DAG + Sandbox
Epic 3.5   ✅ DONE      Speculative Execution
Epic 4     🟡 PARTIAL   Episodic Memory (Phase 1 done)
Epic 5     ✅ DONE      Intelligent Discovery
Epic 6     ✅ DONE      Real-time Dashboard
Epic 7     🟡 PROGRESS  Emergent Capabilities
Epic 8     📋 PROPOSED  Hypergraph Visualization
Epic 9     🟡 PROGRESS  Authentication & Multi-tenancy (4/5 stories done)
```

### Epic 9 - Authentication (Current Focus)

| Story | Description                            | Status     |
| ----- | -------------------------------------- | ---------- |
| 9.1   | Infrastructure Auth - Schema & Helpers | ✅ Done    |
| 9.2   | GitHub OAuth & Auth Routes             | ✅ Done    |
| 9.3   | Auth Middleware & Mode Detection       | ✅ Done    |
| 9.4   | Landing Page & Dashboard UI Auth       | ✅ Done    |
| 9.5   | Rate Limiting & Data Isolation         | 📋 Backlog |

## Authentication Architecture

```
┌─────────────────────────────┐     ┌──────────────────────────┐
│ Fresh Dashboard                 │     │ API Server (MCP Gateway) │
│ (prod:8080 / dev:8081)          │     │ (prod:3001 / dev:3003)   │
│                                 │     │                          │
│ Auth: Session Cookie            │     │ Auth: API Key Header     │
│ Protected: /dashboard, /settings│     │ Protected: All endpoints │
│ Public: /, /auth/*              │     │ Public: /health          │
└─────────────────────────────────┘     └──────────────────────────┘

Mode Detection: GITHUB_CLIENT_ID env var
  - Cloud Mode: OAuth required
  - Local Mode: Zero auth (bypass all checks)
```

## Guiding Principles

1. **Boring Technology** — Prefer proven solutions (PGlite, Deno) over experimental ones
2. **Local-First** — All data stays on the user's machine (local mode)
3. **Zero-Config** — Auto-discovery of MCP servers, automatic embedding generation
4. **Speculative by Default** — Speculative execution is THE feature, not an option
5. **Meta-Tools Only** — Expose intelligent meta-tools, no transparent proxying

---

_For technical details, see the specific documents:_

- [Project Structure](./project-structure.md) — Project structure
- [Novel Pattern Designs](./novel-pattern-designs.md) — Innovative architectural patterns
- [Technology Stack Details](./technology-stack-details.md) — Detailed tech stack
- [ADRs](./architecture-decision-records-adrs.md) — Documented technical decisions
- [Epic Mapping](./epic-to-architecture-mapping.md) — PRD → Architecture traceability
