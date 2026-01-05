# 02 - Hierarchy Level Computation

**Parent**: [00-overview.md](./00-overview.md) **Depends on**:
[01-data-model.md](./01-data-model.md)

---

## Algorithm

For capability c ∈ P^k(V₀):

```
level(c) = 0    if c contains only tools (c ⊆ V₀)
level(c) = 1 + max{level(c') | c' ∈ c}    otherwise
```

---

## Implementation

```typescript
private computeHierarchyLevels(): void {
  this.hierarchyLevels = new Map();
  this.maxHierarchyLevel = 0;

  const visited = new Set<string>();
  const levelCache = new Map<string, number>();

  const computeLevel = (capId: string): number => {
    // Cached?
    if (levelCache.has(capId)) {
      return levelCache.get(capId)!;
    }

    // Cycle detection (should not happen in acyclic graph)
    if (visited.has(capId)) {
      throw new Error(`Cycle detected at capability ${capId}`);
    }
    visited.add(capId);

    const cap = this.capabilityNodes.get(capId);
    if (!cap) {
      throw new Error(`Unknown capability ${capId}`);
    }

    // Get child capabilities
    const childCaps = cap.members.filter(m => m.type === 'capability');

    let level: number;
    if (childCaps.length === 0) {
      // Leaf: contains only tools (or nothing)
      level = 0;
    } else {
      // level(c) = 1 + max{level(c') | c' ∈ c}
      const childLevels = childCaps.map(m => computeLevel(m.id));
      level = 1 + Math.max(...childLevels);
    }

    // Cache and track
    levelCache.set(capId, level);
    cap.hierarchyLevel = level;

    const capsAtLevel = this.hierarchyLevels.get(level) ?? new Set();
    capsAtLevel.add(capId);
    this.hierarchyLevels.set(level, capsAtLevel);

    this.maxHierarchyLevel = Math.max(this.maxHierarchyLevel, level);

    visited.delete(capId);
    return level;
  };

  // Compute for all capabilities
  for (const [capId] of this.capabilityNodes) {
    computeLevel(capId);
  }
}
```

---

## Data Structures

```typescript
class SHGAT {
  /** Hierarchy levels: level → set of capability IDs at that level */
  private hierarchyLevels: Map<number, Set<string>>;

  /** Max hierarchy level (L_max) */
  private maxHierarchyLevel: number;
}
```

---

## Example

```
Capabilities:
  cap-a: members=[t1, t2]           → level 0
  cap-b: members=[t3]               → level 0
  meta-c: members=[cap-a, cap-b]    → level 1
  super-d: members=[meta-c]         → level 2

hierarchyLevels:
  0 → {cap-a, cap-b}
  1 → {meta-c}
  2 → {super-d}

maxHierarchyLevel: 2
```

---

## Edge Cases

### Cycle Detection

```typescript
// cap-a contains cap-b
// cap-b contains cap-a  ← cycle
// Should throw: "Cycle detected at capability cap-a"
```

### Empty Capability

```typescript
// cap-empty: members=[]
// Level = 0 (leaf with no members)
```

### Mixed Members

```typescript
// cap-mixed: members=[t1, cap-a]
// Level = 1 + max{level(cap-a)} = 1 + 0 = 1
```

---

## Acceptance Criteria

- [ ] `computeHierarchyLevels()` implemented
- [ ] Cycle detection throws descriptive error
- [ ] `hierarchyLevels` map correctly populated
- [ ] `maxHierarchyLevel` tracked
- [ ] Leaf capabilities (tools only) get level 0
- [ ] Mixed capabilities get correct level
