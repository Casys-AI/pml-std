# 01 - Data Model

**Parent**: [00-overview.md](./00-overview.md)

---

## New Types

### Member Type

```typescript
/**
 * Member of a capability (tool OR capability)
 *
 * This enables P^n(V₀) structure where capabilities at level k
 * can contain capabilities from level k-1 OR tools from V₀.
 */
export type Member =
  | { type: "tool"; id: string }
  | { type: "capability"; id: string };
```

### CapabilityNode

```typescript
/**
 * Capability node in n-SuperHyperGraph
 */
export interface CapabilityNode {
  id: string;

  /** Intrinsic embedding (from description or cold start) */
  embedding: number[];

  /** Members: tools (V₀) OR capabilities (P^k, k < level) */
  members: Member[];

  /** Hierarchy level (computed via topological sort) */
  hierarchyLevel: number;

  /** Historical success rate */
  successRate: number;

  /** Hypergraph features for scoring */
  hypergraphFeatures?: HypergraphFeatures;
}
```

### ToolNode

```typescript
/**
 * Tool node (vertex V₀)
 */
export interface ToolNode {
  id: string;
  embedding: number[];
  toolFeatures?: ToolGraphFeatures;
}
```

---

## Removed/Deprecated Fields

```typescript
// REMOVED from CapabilityNode:
// - toolsUsed: string[]   // Use members.filter(m => m.type === 'tool')
// - children: string[]    // Use members.filter(m => m.type === 'capability')
// - parents: string[]     // Reconstruct via reverse incidence if needed
```

---

## Backward Compatibility Helpers

```typescript
class SHGAT {
  /** Get direct tools only (no transitive) */
  getDirectTools(capId: string): string[] {
    const cap = this.capabilityNodes.get(capId);
    return cap?.members
      .filter((m) => m.type === "tool")
      .map((m) => m.id) ?? [];
  }

  /** Get direct child capabilities only */
  getDirectCapabilities(capId: string): string[] {
    const cap = this.capabilityNodes.get(capId);
    return cap?.members
      .filter((m) => m.type === "capability")
      .map((m) => m.id) ?? [];
  }

  /** Get ALL transitive tools (for legacy API only) */
  @deprecated("Use hierarchical message passing instead")
  collectTransitiveTools(capId: string): Set<string> {
    // Keep old implementation for backward compat
    // but mark as deprecated
  }
}
```

---

## Implementation Notes

### File Changes

| File                                     | Change                                     |
| ---------------------------------------- | ------------------------------------------ |
| `src/graphrag/algorithms/shgat/types.ts` | Add `Member` type, update `CapabilityNode` |
| `src/graphrag/algorithms/shgat.ts`       | Add helper methods                         |

### Migration from Old Format

```typescript
// Old format
interface LegacyCapabilityNode {
  id: string;
  toolsUsed: string[];
  children: string[];
  embedding: number[];
  successRate: number;
}

// New format
interface CapabilityNode {
  id: string;
  members: Member[]; // Unified
  hierarchyLevel: number; // Computed
  embedding: number[];
  successRate: number;
}
```

---

## Acceptance Criteria

- [ ] `Member` type exported from `types.ts`
- [ ] `CapabilityNode.members` replaces `toolsUsed` + `children`
- [ ] `hierarchyLevel` field added (default 0)
- [ ] `getDirectTools()` helper works
- [ ] `getDirectCapabilities()` helper works
- [ ] `collectTransitiveTools()` marked deprecated
