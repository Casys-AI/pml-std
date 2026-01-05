# 03 - Multi-Level Incidence Structure

**Parent**: [00-overview.md](./00-overview.md) **Depends on**:
[02-hierarchy-computation.md](./02-hierarchy-computation.md)

---

## Concept

Instead of single matrix A[tool][cap], we have:

- **I₀**: Tools → Level-0 Capabilities (binary)
- **I_k**: Level-(k-1) Caps → Level-k Caps (binary, k ≥ 1)

For capability c at level k:

- If k = 0: I₀[t][c] = 1 iff tool t ∈ c.members
- If k > 0: I_k[c'][c] = 1 iff capability c' ∈ c.members

**CRITICAL**: NO TRANSITIVE CLOSURE. Each I_k captures DIRECT membership only.

---

## Data Structures

```typescript
class SHGAT {
  // === Multi-level incidence ===

  /** Tools → Level-0 Capabilities (I₀) */
  private toolToCapIncidence: Map<string, Set<string>>;

  /** Level-k Caps → Level-(k+1) Caps (I_k, k ≥ 1) */
  private capToCapIncidence: Map<number, Map<string, Set<string>>>;

  /** Reverse mapping: parent → children at each level */
  private parentToChildIncidence: Map<number, Map<string, Set<string>>>;

  /** Hierarchy levels: level → set of capability IDs at that level */
  private hierarchyLevels: Map<number, Set<string>>;

  /** Max hierarchy level (L_max) */
  private maxHierarchyLevel: number;
}
```

---

## Build Algorithm

```typescript
private buildMultiLevelIncidence(): void {
  // Step 1: Compute hierarchy levels via topological sort
  this.computeHierarchyLevels();

  // Step 2: Build I₀ (Tools → Level-0 Caps)
  this.toolToCapIncidence = new Map();
  const level0Caps = this.hierarchyLevels.get(0) ?? new Set();

  for (const capId of level0Caps) {
    const cap = this.capabilityNodes.get(capId)!;
    for (const m of cap.members) {
      if (m.type === 'tool') {
        const set = this.toolToCapIncidence.get(m.id) ?? new Set();
        set.add(capId);
        this.toolToCapIncidence.set(m.id, set);
      }
    }
  }

  // Step 3: Build I_k for k ≥ 1 (Cap → Parent Cap)
  this.capToCapIncidence = new Map();
  this.parentToChildIncidence = new Map();

  for (let level = 1; level <= this.maxHierarchyLevel; level++) {
    const capsAtLevel = this.hierarchyLevels.get(level) ?? new Set();
    const childToParent = new Map<string, Set<string>>();
    const parentToChild = new Map<string, Set<string>>();

    for (const parentId of capsAtLevel) {
      const parent = this.capabilityNodes.get(parentId)!;

      for (const m of parent.members) {
        if (m.type === 'capability') {
          // Forward: child → parent
          const parents = childToParent.get(m.id) ?? new Set();
          parents.add(parentId);
          childToParent.set(m.id, parents);

          // Reverse: parent → child
          const children = parentToChild.get(parentId) ?? new Set();
          children.add(m.id);
          parentToChild.set(parentId, children);
        }
      }
    }

    this.capToCapIncidence.set(level, childToParent);
    this.parentToChildIncidence.set(level, parentToChild);
  }
}
```

---

## Example

```
Tools: t1, t2, t3, t4, t5

Level 0 Capabilities:
  cap-setup: [t1, t2]
  cap-test: [t3]
  cap-deploy: [t4, t5]

Level 1 Meta-Capabilities:
  meta-ci: [cap-setup, cap-test]
  meta-cd: [cap-deploy]

Level 2 Super-Capabilities:
  super-release: [meta-ci, meta-cd]

Incidence Structures:

toolToCapIncidence (I₀):
  t1 → {cap-setup}
  t2 → {cap-setup}
  t3 → {cap-test}
  t4 → {cap-deploy}
  t5 → {cap-deploy}

capToCapIncidence:
  level 1:
    cap-setup → {meta-ci}
    cap-test → {meta-ci}
    cap-deploy → {meta-cd}
  level 2:
    meta-ci → {super-release}
    meta-cd → {super-release}

parentToChildIncidence (reverse):
  level 1:
    meta-ci → {cap-setup, cap-test}
    meta-cd → {cap-deploy}
  level 2:
    super-release → {meta-ci, meta-cd}
```

---

## Acceptance Criteria

- [ ] `toolToCapIncidence` correctly maps tools to level-0 caps
- [ ] `capToCapIncidence` maps child caps to parent caps per level
- [ ] `parentToChildIncidence` reverse mapping works
- [ ] NO transitive closure (direct membership only)
- [ ] Rebuild triggered on graph modifications
