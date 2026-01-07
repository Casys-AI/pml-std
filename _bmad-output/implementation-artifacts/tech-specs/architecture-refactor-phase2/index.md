# Architecture Refactoring - Phase 2

**Status:** In Progress
**Priority:** P1 - High
**Created:** 2025-12-29
**Updated:** 2026-01-07
**Depends On:** `tech-spec-large-files-refactoring.md` (Phases 1-4 completed)

---

## Executive Summary

Phase 2 addresses architectural issues that emerged after Phase 1:

1. **New God Classes**: `static-structure-builder.ts` (2,399 lines) was not in scope
2. **File Re-inflation**: Some refactored files have grown back
3. **Type File Explosion**: `capabilities/types.ts` (1,237 lines)
4. **Circular Coupling**: Bidirectional dependencies between modules
5. **Missing Abstractions**: No interfaces, heavy coupling to concrete classes

**New Libraries:**
- **[Hono](https://hono.dev)** - HTTP routing (`jsr:@hono/hono@^4`)
- **[diod](https://github.com/artberri/diod)** - DI container (`npm:diod@^3.0.0`)

---

## Problem Statement

### Code Metrics (2026-01-07 Updated)

| File | Lines | Issues | Priority | Status |
|------|-------|--------|----------|--------|
| `shgat.ts` | 2,087 | God class, training + inference + utils | **P1** | 📋 Phase 3.3 |
| `execute-handler.ts` | 1,803 | 4 responsibilities in one handler | **P1** | 📋 Phase 3.1 |
| `gateway-server.ts` | 1,624 | GraphSyncController inline | **P1** | 📋 Phase 3.3 |
| `static-structure-builder.ts` | 1,567 | God class, mixed concerns | **P2** | 📋 Phase 3.3 |
| `capability-store.ts` | 1,498 | Store + transformer + observer | **P2** | 📋 Phase 3.3 |
| `code-transformer.ts` | 1,245 | Multiple transform types bundled | **P2** | 📋 Phase 3.3 |
| `worker-bridge.ts` | 1,237 | RPC + tracing + injection | **P2** | 📋 Phase 3.3 |
| `tool-mapper.ts` | 1,113 | Multiple pattern handlers | **P3** | 📋 Phase 3.3 |
| `api/graph.ts` | 1,040 | 4 endpoints in one file | **P2** | 📋 Phase 3.3 |
| `sandbox/executor.ts` | 399 | ✅ Refactored | Done | ✅ Phase 2.4 |

### DI Container Issues (2026-01-07 New)

| Issue | Current | Target | Phase |
|-------|---------|--------|-------|
| Registered services | 6 | 20+ | Phase 3.2 |
| Direct `new` in handlers | ~15 | 0 | Phase 3.2 |
| Direct `eventBus` imports | 94 | 0 | Phase 3.4 |

### Circular Dependencies

```mermaid
graph TD
    MCP[mcp/gateway-server.ts<br/>1,215 lines] --> CAP[capabilities/capability-store.ts<br/>1,441 lines]
    MCP --> DAG[dag/controlled-executor.ts<br/>1,556 lines]
    MCP --> GRAPH[graphrag/graph-engine.ts<br/>336 lines]
    DAG --> CAP
    CAP --> DAG
    CAP --> GRAPH
    GRAPH --> CAP

    style MCP fill:#ff6b6b
    style CAP fill:#ff6b6b
    style DAG fill:#ff6b6b
    style GRAPH fill:#ffd93d
```

**Legend:** 🔴 Red: > 1,000 lines | 🟡 Yellow: 500-1,000 lines | ↔️ Bidirectional: Circular dependency

---

## Document Structure

### Phase 2: Foundation (Completed/In Progress)

| Document | Content | Status |
|----------|---------|--------|
| [quick-wins.md](./quick-wins.md) | QW-1 to QW-5 | ✅ Done |
| [phase-2.1-dependency-injection.md](./phase-2.1-dependency-injection.md) | diod, interfaces, domain types | ✅ Done |
| [phase-2.2-god-classes.md](./phase-2.2-god-classes.md) | Refactor large files | 🔄 Partial |
| [phase-2.3-type-splitting.md](./phase-2.3-type-splitting.md) | Split type files | 📋 Planned |
| [phase-2.4-sandbox.md](./phase-2.4-sandbox.md) | Sandbox executor | ✅ Done |
| [phase-2.5-patterns.md](./phase-2.5-patterns.md) | Design patterns, CQRS | 📋 Planned |
| [phase-2.6-testing.md](./phase-2.6-testing.md) | Test architecture | 📋 Planned |
| [phase-2.7-deno-native.md](./phase-2.7-deno-native.md) | Deno APIs, import maps | 🔄 Ongoing |

### Phase 3: Architecture Consolidation (New)

| Document | Content | Priority | Effort |
|----------|---------|----------|--------|
| [phase-3.1-execute-handler-usecases.md](./phase-3.1-execute-handler-usecases.md) | Split execute-handler.ts into Use Cases | **P1** | L |
| [phase-3.2-di-expansion.md](./phase-3.2-di-expansion.md) | Expand DI container (6→20+ services) | **P1** | M |
| [phase-3.3-god-classes-round2.md](./phase-3.3-god-classes-round2.md) | Split remaining God Classes (8 files) | **P2** | L |
| [phase-3.4-eventbus-injection.md](./phase-3.4-eventbus-injection.md) | Replace 94 direct eventBus imports | **P3** | L |

---

## Target Architecture

### Design Principles

1. **Strict Layering**: No upward dependencies
2. **Dependency Inversion**: Depend on interfaces, not implementations
3. **Type Modularity**: Max 300 lines per type file
4. **Single Responsibility**: One concern per class (target: <500 lines)

### Layered Architecture

```
┌─────────────────────────────────────────┐
│  Presentation Layer (mcp-server, web)  │  ← User-facing
├─────────────────────────────────────────┤
│  Application Layer (use-cases)          │  ← Business logic orchestration
├─────────────────────────────────────────┤
│  Domain Layer (entities, interfaces)    │  ← Core business logic
├─────────────────────────────────────────┤
│  Infrastructure (db, vector, events)    │  ← Technical implementations
└─────────────────────────────────────────┘

Rules:
- Each layer can ONLY depend on layers below
- NO circular dependencies between layers
- Infrastructure injects via interfaces (DI)
```

---

## Success Metrics

| Metric | Current | Target | Validation |
|--------|---------|--------|------------|
| **Max file size** | 2,399 lines | 600 lines | `wc -l src/**/*.ts` |
| **Circular deps** | 3+ cycles | 0 cycles | `deno info --json` |
| **Type file size** | 1,237 lines | 300 lines | Manual inspection |
| **Interface coverage** | 0% | 80% | Count interfaces vs classes |
| **Test coverage** | ~60% | >85% | `deno task coverage` |
| **Architecture Tests** | 0 | 4 test files (QW-5) | `deno task test:arch` |
| **DI Container** | Manual (10 params) | diod graph-based | Startup validation |
| **HTTP Router LOC** | ~220 lines | ~50 lines (Hono) | `wc -l` |

---

## Timeline (18 weeks)

### Sprint 1-2: Foundation (Weeks 1-4) ✅
- **QW-1 to QW-5**: Quick wins (parallel)
- **Phase 2.1**: Domain types, interfaces, diod setup

### Sprint 3-4: God Classes Round 1 (Weeks 5-8) 🔄
- **Phase 2.2**: Refactor static-structure-builder, controlled-executor
- **Phase 2.3**: Split type files
- **Phase 2.4**: Sandbox executor ✅

### Sprint 5-6: Patterns & Testing (Weeks 9-12)
- **Phase 2.5**: Design patterns, CQRS, events
- **Phase 2.6**: Test architecture
- **Phase 2.7**: Deno-native patterns (ongoing)

### Sprint 7-8: Architecture Consolidation (Weeks 13-16) 🆕
- **Phase 3.1**: Execute Handler → Use Cases (P1)
- **Phase 3.2**: DI Container Expansion (P1)
- **Phase 3.3**: God Classes Round 2 (P2)

### Sprint 9: Decoupling (Weeks 17-18) 🆕
- **Phase 3.4**: EventBus Injection (P3)

---

## Next Steps

1. **Review & Approve**: Team reviews this spec
2. **Quick Wins First**: Start with QW-3 (interfaces) + QW-4 (Hono) + QW-5 (tests) in parallel
3. **Install libs**: Add diod + Hono to `deno.json`
4. **Kickoff Sprint 1**: Domain types extraction + diod bootstrap

---

## References

### Project References
- **Phase 1 Spec**: `docs/tech-specs/tech-spec-large-files-refactoring.md`
- **ADR-036**: Event Bus pattern
- **ADR-052**: Two-level DAG

### Phase 2 Libraries
- **Hono**: https://hono.dev
- **diod**: https://github.com/artberri/diod

### Architecture Patterns
- **Clean Architecture**: Robert C. Martin
- **CQRS**: Greg Young
- **Dependency Injection**: Martin Fowler
