# Phase 3.4: EventBus Injection (P3 - Medium)

**Parent:** [index.md](./index.md)
**Priority:** P3 - Medium
**Effort:** Large (1-2 weeks)
**Depends On:** Phase 3.2 (DI Expansion)

---

## Objective

Replace 94 direct `eventBus` imports with dependency injection, improving testability and decoupling.

---

## Current State

### Direct Imports (Anti-pattern)

```typescript
// Found in 94 files
import { eventBus } from "../events/mod.ts";

export function someFunction() {
  // Direct usage - hard to test, tight coupling
  eventBus.emit({ type: "some.event", payload: data });
}
```

### Problems

1. **Tight Coupling**: Every module depends on global singleton
2. **Hard to Test**: Can't mock events without global state manipulation
3. **Hidden Dependencies**: Event emissions not visible in function signatures
4. **No Interface**: `eventBus` is concrete, not abstracted

---

## Target State

### Interface Definition

```typescript
// src/domain/interfaces/event-bus.ts

export interface IEventBus {
  emit<T extends EventType>(event: Event<T>): void;
  on<T extends EventType>(type: T, handler: EventHandler<T>): Unsubscribe;
  once<T extends EventType>(type: T, handler: EventHandler<T>): void;
  off<T extends EventType>(type: T, handler: EventHandler<T>): void;
}

export type Unsubscribe = () => void;

export interface Event<T extends EventType = EventType> {
  type: T;
  source: string;
  payload: EventPayload<T>;
  timestamp?: number;
}
```

### Injection Pattern

```typescript
// After: Injected via constructor
export class WorkerBridge {
  constructor(
    private mcpClients: Map<string, MCPClientBase>,
    private eventBus: IEventBus,  // Injected!
    config?: WorkerBridgeConfig,
  ) {}

  private handleRPCCall(msg: RPCCallMessage): void {
    // Now mockable!
    this.eventBus.emit({
      type: "tool.start",
      source: "worker-bridge",
      payload: { toolId, traceId: id },
    });
  }
}
```

---

## Files to Update

### High Priority (Core modules)

| File | Emissions | Subscriptions |
|------|-----------|---------------|
| `worker-bridge.ts` | 12 | 1 |
| `gateway-server.ts` | 8 | 4 |
| `controlled-executor.ts` | 10 | 2 |
| `capability-store.ts` | 6 | 0 |
| `graph-engine.ts` | 5 | 3 |

### Medium Priority (Handlers)

| File | Emissions | Subscriptions |
|------|-----------|---------------|
| `execute-handler.ts` | 4 | 0 |
| `tool-handler.ts` | 3 | 0 |
| `sse-handler.ts` | 0 | 8 |

### Low Priority (Utilities)

| File | Emissions | Subscriptions |
|------|-----------|---------------|
| `telemetry/*.ts` | 2 | 5 |
| `sandbox/*.ts` | 3 | 1 |
| Other modules | ~40 | ~20 |

---

## Migration Strategy

### Phase A: Create Interface (Day 1)

```typescript
// src/domain/interfaces/event-bus.ts
export interface IEventBus {
  emit<T extends EventType>(event: Event<T>): void;
  on<T extends EventType>(type: T, handler: EventHandler<T>): Unsubscribe;
  once<T extends EventType>(type: T, handler: EventHandler<T>): void;
  off<T extends EventType>(type: T, handler: EventHandler<T>): void;
}
```

### Phase B: Create Adapter (Day 1)

```typescript
// src/infrastructure/di/adapters/event-bus.adapter.ts
import { eventBus as globalEventBus } from "@/events/mod.ts";
import type { IEventBus } from "@/domain/interfaces/event-bus.ts";

@Injectable()
export class EventBusAdapter implements IEventBus {
  emit<T extends EventType>(event: Event<T>): void {
    globalEventBus.emit(event);
  }

  on<T extends EventType>(type: T, handler: EventHandler<T>): Unsubscribe {
    return globalEventBus.on(type, handler);
  }

  once<T extends EventType>(type: T, handler: EventHandler<T>): void {
    globalEventBus.once(type, handler);
  }

  off<T extends EventType>(type: T, handler: EventHandler<T>): void {
    globalEventBus.off(type, handler);
  }
}
```

### Phase C: Register in Container (Day 1)

```typescript
// src/infrastructure/di/container.ts
builder.register(IEventBus).use(EventBusAdapter).asSingleton();
```

### Phase D: Update High-Priority Files (Day 2-4)

**Pattern for each file:**

1. Add `eventBus: IEventBus` to constructor
2. Remove direct import
3. Use `this.eventBus` instead of global
4. Update factory/bootstrap code
5. Update tests

```typescript
// Before
import { eventBus } from "../events/mod.ts";

export class WorkerBridge {
  constructor(private mcpClients: Map<string, MCPClientBase>) {}

  private emit() {
    eventBus.emit({ type: "tool.start", ... });
  }
}

// After
import type { IEventBus } from "@/domain/interfaces/event-bus.ts";

export class WorkerBridge {
  constructor(
    private mcpClients: Map<string, MCPClientBase>,
    private eventBus: IEventBus,
  ) {}

  private emit() {
    this.eventBus.emit({ type: "tool.start", ... });
  }
}
```

### Phase E: Update Medium-Priority Files (Day 5-7)

Follow same pattern for handlers and secondary modules.

### Phase F: Update Low-Priority Files (Day 8-10)

Follow same pattern for utilities and edge modules.

---

## Test Improvements

### Before: Global Mocking (Fragile)

```typescript
Deno.test("emits event on success", async () => {
  const events: Event[] = [];
  const unsubscribe = eventBus.on("*", (e) => events.push(e));

  try {
    await functionUnderTest();
    assertEquals(events.length, 1);
  } finally {
    unsubscribe();
  }
});
```

### After: Injected Mock (Clean)

```typescript
Deno.test("emits event on success", async () => {
  const mockEventBus = createMockEventBus();

  const instance = new ClassUnderTest(mockEventBus);
  await instance.execute();

  assertSpyCalled(mockEventBus.emit, {
    type: "tool.start",
    payload: { toolId: "test" },
  });
});
```

### Mock Factory

```typescript
// tests/mocks/event-bus.mock.ts
export function createMockEventBus(): IEventBus & { calls: Event[] } {
  const calls: Event[] = [];

  return {
    calls,
    emit: (event: Event) => calls.push(event),
    on: () => () => {},
    once: () => {},
    off: () => {},
  };
}
```

---

## Backwards Compatibility

During migration, maintain backwards compatibility:

```typescript
// src/events/mod.ts

// Existing global (deprecated but still works)
export const eventBus = new EventBus();

// New way: Get from container
export function getEventBus(): IEventBus {
  return container.get(IEventBus);
}
```

After migration complete:
1. Mark `eventBus` export as `@deprecated`
2. Add lint rule to warn on direct imports
3. Eventually remove global export

---

## Acceptance Criteria

- [ ] `IEventBus` interface created
- [ ] `EventBusAdapter` registered in DI container
- [ ] 0 direct `eventBus` imports in core modules (Phase D files)
- [ ] All handlers use injected `IEventBus`
- [ ] Mock factory available for tests
- [ ] All existing tests pass
- [ ] New tests use mock injection pattern

---

## Metrics

| Metric | Before | After |
|--------|--------|-------|
| Direct `eventBus` imports | 94 | 0 |
| Files with hidden event deps | 94 | 0 |
| Testable event emissions | ~30% | 100% |
| Event-related test complexity | High | Low |

---

## Rollout Plan

| Week | Scope | Files |
|------|-------|-------|
| 1 | High priority | 5 core modules |
| 2 | Medium priority | 10 handlers |
| 3 | Low priority | Remaining ~79 files |
| 4 | Cleanup | Deprecate global, add lint rules |

---

## Dependencies

**Requires:**
- Phase 3.2: DI Container Expansion (container must be set up)

**Enables:**
- Better unit testing across codebase
- Event-driven architecture improvements
- Easier event bus implementation swapping (e.g., for distributed events)
