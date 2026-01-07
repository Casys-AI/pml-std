# Phase 3.3: God Classes Round 2 (P2 - High)

**Parent:** [index.md](./index.md)
**Priority:** P2 - High
**Effort:** Large (2-3 weeks)
**Depends On:** Phase 3.1 (Use Cases pattern), Phase 3.2 (DI Expansion)

---

## Objective

Split remaining God Classes (>500 lines) following the patterns established in Phase 3.1.

---

## Target Files

| File | Lines | Target | Modules to Extract |
|------|-------|--------|-------------------|
| `shgat.ts` | 2,087 | 400 | `shgat-inference.ts`, `shgat-training.ts`, `shgat-utils.ts` |
| `gateway-server.ts` | 1,624 | 300 | `GraphSyncController`, algorithm factory |
| `static-structure-builder.ts` | 1,567 | 400 | Visitor handlers, edge generators |
| `capability-store.ts` | 1,498 | 350 | Transformer, observer, persistence |
| `code-transformer.ts` | 1,245 | 300 | Per-transformation-type modules |
| `worker-bridge.ts` | 1,237 | 350 | RpcHandler, TraceCollector, CapabilityInjector |
| `tool-mapper.ts` | 1,113 | 300 | Per-pattern-type handlers |
| `api/graph.ts` | 1,040 | 250 | Per-endpoint handlers |

---

## 1. SHGAT Refactoring (2,087 → 400 lines)

### Current Structure

```
src/graphrag/algorithms/shgat.ts (2,087 lines)
├── Constructor + initialization (~200)
├── Training logic (~600)
├── Inference logic (~500)
├── Feature extraction (~300)
├── Attention mechanisms (~200)
├── Utilities (~287)
```

### Target Structure

```
src/graphrag/algorithms/shgat/
├── mod.ts                    # Re-exports
├── shgat.ts                  # Orchestrator facade (~400 lines)
├── inference/
│   ├── mod.ts
│   ├── predictor.ts          # Prediction logic (~250)
│   └── attention.ts          # Attention mechanisms (~200)
├── training/
│   ├── mod.ts
│   ├── trainer.ts            # Training orchestration (~300)
│   ├── loss-functions.ts     # Loss computations (~150)
│   └── optimizer.ts          # Gradient updates (~150)
├── features/
│   ├── mod.ts
│   ├── extractor.ts          # Feature extraction (~200)
│   └── normalizer.ts         # Feature normalization (~100)
└── utils/
    ├── mod.ts
    ├── tensor-ops.ts         # Tensor utilities (~150)
    └── config.ts             # Configuration (~50)
```

### Migration Steps

1. **Create directory structure**
2. **Extract `training/trainer.ts`** - Move training loop, loss calculation
3. **Extract `inference/predictor.ts`** - Move prediction, attention
4. **Extract `features/extractor.ts`** - Move feature extraction
5. **Refactor main `shgat.ts`** to orchestrator only
6. **Update imports** across codebase

---

## 2. Gateway Server Refactoring (1,624 → 300 lines)

### Current Structure

```
src/mcp/gateway-server.ts (1,624 lines)
├── Server setup (~150)
├── Handler registration (~200)
├── GraphSyncController logic (~400)
├── Algorithm initialization (~300)
├── Health checks (~100)
├── SSE streaming (~200)
├── Error handling (~274)
```

### Target Structure

```
src/mcp/
├── gateway-server.ts              # Server setup only (~300 lines)
├── graph-sync/
│   ├── mod.ts
│   ├── controller.ts              # Graph sync logic (~250)
│   └── scheduler.ts               # Sync scheduling (~100)
├── algorithm-factory/
│   ├── mod.ts
│   ├── factory.ts                 # Algorithm instantiation (~150)
│   └── config-loader.ts           # Config loading (~80)
└── health/
    ├── mod.ts
    └── checker.ts                 # Health check logic (~100)
```

### Key Extractions

```typescript
// src/mcp/graph-sync/controller.ts
export class GraphSyncController {
  constructor(
    private graphEngine: IGraphEngine,
    private eventBus: IEventBus,
    private scheduler: GraphSyncScheduler,
  ) {}

  async syncNow(): Promise<SyncResult> { /* ... */ }
  async schedulePeriodic(intervalMs: number): Promise<void> { /* ... */ }
  async onToolSchemaChange(): Promise<void> { /* ... */ }
}

// src/mcp/algorithm-factory/factory.ts
export class AlgorithmFactory {
  constructor(
    private container: Container,
    private config: AlgorithmConfig,
  ) {}

  createSHGAT(): ISHGATTrainer { /* ... */ }
  createDRDSP(): IDRDSPAlgorithm { /* ... */ }
  createSpectralClustering(): ISpectralClustering { /* ... */ }
}
```

---

## 3. Capability Store Refactoring (1,498 → 350 lines)

### Current Structure

```
src/capabilities/capability-store.ts (1,498 lines)
├── CRUD operations (~300)
├── Code transformation (~400)
├── Event emission (~150)
├── Search/query (~200)
├── Caching (~150)
├── Validation (~148)
├── Utilities (~150)
```

### Target Structure

```
src/capabilities/
├── capability-store.ts            # Core CRUD (~350 lines)
├── transformation/
│   ├── mod.ts
│   ├── transformer.ts             # Orchestrator (~150)
│   ├── capability-ref.ts          # $cap: transformations (~150)
│   ├── literal-transform.ts       # Literal transformations (~100)
│   └── variable-normalize.ts      # Variable normalization (~100)
├── events/
│   ├── mod.ts
│   └── capability-observer.ts     # Event emission (~150)
└── search/
    ├── mod.ts
    ├── semantic-search.ts         # Vector search (~150)
    └── text-search.ts             # Text search (~100)
```

---

## 4. Worker Bridge Refactoring (1,237 → 350 lines)

### Current Structure

```
src/sandbox/worker-bridge.ts (1,237 lines)
├── RPC handling (~400)
├── Capability injection (~250)
├── Trace collection (~200)
├── Timeout management (~100)
├── Worker lifecycle (~150)
├── Error handling (~137)
```

### Target Structure

```
src/sandbox/
├── worker-bridge.ts               # Orchestrator (~350 lines)
├── rpc/
│   ├── mod.ts
│   ├── handler.ts                 # RPC call handling (~200)
│   ├── protocol.ts                # Message types (~50)
│   └── router.ts                  # Server routing (~150)
├── tracing/
│   ├── mod.ts
│   ├── collector.ts               # Trace collection (~150)
│   └── broadcaster.ts             # BroadcastChannel (~100)
└── capabilities/
    ├── mod.ts
    └── injector.ts                # Capability injection (~200)
```

---

## 5. API Graph Refactoring (1,040 → 250 lines)

### Current Structure

```
src/api/graph.ts (1,040 lines)
├── /snapshot endpoint (~200)
├── /path endpoint (~200)
├── /insights endpoint (~200)
├── /hypergraph endpoint (~200)
├── Shared utilities (~240)
```

### Target Structure

```
src/api/graph/
├── mod.ts                         # Router setup (~100 lines)
├── handlers/
│   ├── snapshot.ts                # Snapshot handler (~150)
│   ├── path.ts                    # Path handler (~150)
│   ├── insights.ts                # Insights handler (~150)
│   └── hypergraph.ts              # Hypergraph handler (~150)
└── utils/
    ├── response-mapper.ts         # Response formatting (~80)
    └── query-parser.ts            # Query parsing (~60)
```

---

## Priority Order

| Order | File | Effort | Impact |
|-------|------|--------|--------|
| 1 | `gateway-server.ts` | S | High - enables DI patterns |
| 2 | `capability-store.ts` | M | High - core data layer |
| 3 | `worker-bridge.ts` | M | Medium - sandbox isolation |
| 4 | `api/graph.ts` | S | Medium - API organization |
| 5 | `code-transformer.ts` | M | Medium - code analysis |
| 6 | `shgat.ts` | L | Medium - ML algorithms |
| 7 | `tool-mapper.ts` | M | Low - workflow analysis |

---

## Acceptance Criteria

- [ ] All files < 500 lines after refactoring
- [ ] Each extracted module < 300 lines
- [ ] No breaking changes to public APIs
- [ ] All existing tests pass
- [ ] New unit tests for extracted modules
- [ ] Imports updated across codebase
- [ ] Documentation updated

---

## Test Strategy

Each extracted module should have:

1. **Unit tests** - Test in isolation with mocks
2. **Integration tests** - Test with real dependencies
3. **Regression tests** - Ensure existing behavior preserved

```typescript
// Example: tests/unit/mcp/graph-sync/controller.test.ts

Deno.test("GraphSyncController - triggers sync on tool schema change", async () => {
  const mockEngine = createMockGraphEngine();
  const mockEventBus = createMockEventBus();
  const mockScheduler = createMockScheduler();

  const controller = new GraphSyncController(mockEngine, mockEventBus, mockScheduler);
  await controller.onToolSchemaChange();

  assertSpyCalled(mockEngine.sync);
  assertSpyCalled(mockEventBus.emit, { type: "graph.synced" });
});
```
