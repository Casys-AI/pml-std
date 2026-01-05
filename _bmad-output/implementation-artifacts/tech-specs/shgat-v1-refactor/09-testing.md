# 09 - Testing & Benchmarks

**Parent**: [00-overview.md](./00-overview.md)

---

## Unit Tests

### Hierarchy Level Computation

```typescript
describe("Multi-Level Message Passing", () => {
  it("should compute hierarchy levels correctly", () => {
    // Level 0: cap-a (tools: t1, t2)
    // Level 0: cap-b (tools: t3)
    // Level 1: meta-c (caps: cap-a, cap-b)
    // Level 2: super-d (caps: meta-c)

    // Expected:
    // level(cap-a) = 0, level(cap-b) = 0
    // level(meta-c) = 1
    // level(super-d) = 2
  });

  it("should prevent cycles in hierarchy", () => {
    // cap-a contains cap-b
    // cap-b contains cap-a  ← cycle
    // Should throw error
  });

  it("should handle empty capabilities", () => {
    // cap-empty: members=[]
    // Level should be 0
  });

  it("should handle mixed members", () => {
    // cap-mixed: members=[t1, cap-a]
    // Level = 1 + max{level(cap-a)} = 1
  });
});
```

### Message Passing

```typescript
describe("Message Passing", () => {
  it("should propagate embeddings upward through all levels", () => {
    // Verify E^k depends on E^(k-1) after upward pass
  });

  it("should propagate embeddings downward with residual connections", () => {
    // Verify E^k after downward ≠ E^k after upward (updated)
  });

  it("should cache attention weights", () => {
    // Verify attentionUpward and attentionDownward are populated
  });

  it("should handle single-level hierarchy", () => {
    // Only level-0 capabilities (no meta-caps)
  });

  it("should handle deep hierarchy (L_max = 3+)", () => {
    // Verify correct propagation through many levels
  });
});
```

### Backward Compatibility

```typescript
describe("Backward Compatibility", () => {
  it("should maintain backward compatibility with legacy API", () => {
    // Old code using toolsUsed/children should still work
  });

  it("should migrate legacy CapabilityNode format", () => {
    // migrateCapabilityNode() produces valid new format
  });

  it("should accept legacy addCapabilityLegacy() calls", () => {
    // addCapabilityLegacy(id, emb, toolsUsed, children) works
  });
});
```

---

## Integration Tests

```typescript
describe("End-to-End Scoring", () => {
  it("should score meta-capabilities higher when all children match intent", () => {
    // meta-cap contains cap-a, cap-b
    // cap-a, cap-b both semantically match intent
    // meta-cap should score high (aggregated signal)
  });

  it("should score leaf capabilities correctly", () => {
    // cap-a at level 0 contains tools t1, t2
    // Should match v1 behavior for level-0 caps
  });

  it("should filter by targetLevel", () => {
    // scoreAllCapabilities(intent, 0) returns only level-0
    // scoreAllCapabilities(intent, 1) returns only level-1
  });

  it("should include hierarchyLevel in results", () => {
    // All results have hierarchyLevel field set correctly
  });
});
```

---

## Benchmark

### Comparison Setup

```typescript
// tests/benchmarks/strategic/shgat-hierarchy-comparison.bench.ts

Deno.bench("shgat-v1-old-flattened", async () => {
  // Old implementation with collectTransitiveTools()
});

Deno.bench("shgat-v1-new-multilevel", async () => {
  // New implementation with multi-level message passing
});

Deno.bench("shgat-v2-unchanged", async () => {
  // v2 direct embeddings (baseline, unchanged)
});

Deno.bench("shgat-v3-old-hybrid", async () => {
  // Hybrid with flattened incidence
});

Deno.bench("shgat-v3-new-hybrid", async () => {
  // Hybrid with multi-level message passing
});
```

### Run Command

```bash
deno bench tests/benchmarks/strategic/shgat-hierarchy-comparison.bench.ts
```

---

## Performance Requirements

| Metric            | Old          | New (Target)           |
| ----------------- | ------------ | ---------------------- |
| Forward pass time | X ms         | ≤ 2X ms                |
| Memory usage      | Y MB         | ≤ Y MB (for L_max ≤ 3) |
| Incidence build   | O(C × D_max) | O(C)                   |

### Expected Complexity

**Old (flattened)**:

- Incidence build: O(C × D_max) where D_max = max transitive depth
- Forward pass: O(L × K × T × C)

**New (multi-level)**:

- Incidence build: O(C) (single pass, no recursion)
- Hierarchy level computation: O(C) (topological sort)
- Forward pass: O(L_max × K × M_avg × P_avg)

---

## Memory Profiling

```typescript
Deno.bench({
  name: "shgat-memory-old",
  fn: () => {
    const shgat = createOldSHGAT();
    // Measure memory after creation
  },
  baseline: true,
});

Deno.bench({
  name: "shgat-memory-new",
  fn: () => {
    const shgat = createNewSHGAT();
    // Compare memory usage
  },
});
```

---

## Test Data

### Small Hierarchy (5 tools, 3 caps, 1 meta-cap)

```typescript
const smallHierarchy = {
  tools: ["t1", "t2", "t3", "t4", "t5"],
  capabilities: {
    "cap-a": { members: [{ type: "tool", id: "t1" }, { type: "tool", id: "t2" }] },
    "cap-b": { members: [{ type: "tool", id: "t3" }] },
    "cap-c": { members: [{ type: "tool", id: "t4" }, { type: "tool", id: "t5" }] },
  },
  metaCapabilities: {
    "meta-ab": {
      members: [{ type: "capability", id: "cap-a" }, { type: "capability", id: "cap-b" }],
    },
  },
};
```

### Medium Hierarchy (20 tools, 10 caps, 5 meta-caps, 2 super-caps)

```typescript
const mediumHierarchy = await loadScenario("medium-hierarchy");
```

### Large Hierarchy (100 tools, 50 caps, 20 meta-caps, 5 super-caps)

```typescript
const largeHierarchy = await loadScenario("large-hierarchy");
```

---

## Acceptance Criteria

- [ ] Unit tests for hierarchy level computation
- [ ] Unit tests for cycle detection
- [ ] Unit tests for upward aggregation
- [ ] Unit tests for downward propagation
- [ ] Unit tests for backward compatibility
- [ ] Integration test for end-to-end scoring
- [ ] Benchmark comparing old vs new implementation
- [ ] Performance: forward pass ≤ 2× old implementation time
- [ ] Performance: memory usage ≤ old for L_max ≤ 3
- [ ] Test fixtures for small/medium/large hierarchies
