# 04 - Multi-Level Message Passing

**Parent**: [00-overview.md](./00-overview.md) **Depends on**:
[03-incidence-structure.md](./03-incidence-structure.md)

---

## Forward Pass Interface

```typescript
interface MultiLevelEmbeddings {
  /** Tool embeddings (level -1) */
  H: number[][];

  /** Capability embeddings by level (E^0, E^1, ..., E^L_max) */
  E: Map<number, number[][]>;

  /** Attention weights for interpretability */
  attentionUpward: Map<number, number[][][]>; // [level][head][child][parent]
  attentionDownward: Map<number, number[][][]>; // [level][head][parent][child]
}
```

---

## Forward Pass Overview

```typescript
forward(): MultiLevelEmbeddings {
  const E = new Map<number, number[][]>();
  const attentionUpward = new Map<number, number[][][]>();
  const attentionDownward = new Map<number, number[][][]>();

  // Initialize tools (level -1)
  let H = this.getToolEmbeddings();

  // Initialize capabilities at each level with intrinsic embeddings
  for (let level = 0; level <= this.maxHierarchyLevel; level++) {
    const capsAtLevel = Array.from(this.hierarchyLevels.get(level) ?? []);
    E.set(level, capsAtLevel.map(id => {
      const cap = this.capabilityNodes.get(id)!;
      return [...cap.embedding]; // Copy
    }));
  }

  // ========================================================================
  // UPWARD PASS: V → E^0 → E^1 → ... → E^L_max
  // ========================================================================

  for (let level = 0; level <= this.maxHierarchyLevel; level++) {
    if (level === 0) {
      // Phase: Tools (V) → Level-0 Capabilities (E^0)
      const { E_new, attention } = this.aggregateToolsToCapabilities(
        H, E.get(0)!, capsAtLevel, level
      );
      E.set(0, E_new);
      attentionUpward.set(0, attention);
    } else {
      // Phase: Level-(k-1) → Level-k Capabilities
      const { E_new, attention } = this.aggregateCapabilitiesToCapabilities(
        E.get(level - 1)!, E.get(level)!, level - 1, level
      );
      E.set(level, E_new);
      attentionUpward.set(level, attention);
    }
  }

  // ========================================================================
  // DOWNWARD PASS: E^L_max → ... → E^1 → E^0 → V
  // ========================================================================

  for (let level = this.maxHierarchyLevel - 1; level >= 0; level--) {
    // Phase: Level-(k+1) → Level-k (downward propagation)
    const { E_new, attention } = this.propagateCapabilitiesToCapabilities(
      E.get(level + 1)!, E.get(level)!, level + 1, level
    );
    E.set(level, E_new);
    attentionDownward.set(level, attention);
  }

  // Final phase: Level-0 → Tools
  const { H_new, attention } = this.propagateCapabilitiesToTools(
    E.get(0)!, H, 0
  );
  H = H_new;
  attentionDownward.set(-1, attention);

  return { H, E, attentionUpward, attentionDownward };
}
```

---

## Upward: Tools → Level-0 Capabilities

```typescript
/**
 * Aggregate tool embeddings to level-0 capabilities
 *
 * E^0 = σ(I₀^T · (H ⊙ α₀))
 */
private aggregateToolsToCapabilities(
  H: number[][],              // Tool embeddings [numTools][embDim]
  E_current: number[][],      // Current cap embeddings [numCaps][embDim]
  capsAtLevel: string[],      // Capability IDs at this level
  level: number
): { E_new: number[][]; attention: number[][][] } {
  const numCaps = capsAtLevel.length;
  const numHeads = this.config.numHeads;
  const headDim = this.config.headDim;

  const E_new: number[][] = [];
  const attention: number[][][] = []; // [head][tool][cap]

  const params = this.getLevelParams(level);

  for (let head = 0; head < numHeads; head++) {
    const headAttention: number[][] = [];

    for (let c = 0; c < numCaps; c++) {
      const capId = capsAtLevel[c];
      const cap = this.capabilityNodes.get(capId)!;

      // Get direct tools for this capability
      const toolMembers = cap.members.filter(m => m.type === 'tool');
      const toolIndices = toolMembers.map(m =>
        this.toolIndex.get(m.id)
      ).filter(idx => idx !== undefined) as number[];

      if (toolIndices.length === 0) {
        // No tools: keep intrinsic embedding
        if (head === 0) E_new[c] = [...E_current[c]];
        headAttention[c] = [];
        continue;
      }

      // Compute attention scores
      const scores: number[] = [];
      for (const tIdx of toolIndices) {
        const toolEmb = H[tIdx];
        const capEmb = E_current[c];

        const toolProj = this.matmul([toolEmb], params.W_child[head])[0];
        const capProj = this.matmul([capEmb], params.W_parent[head])[0];
        const concat = [...toolProj, ...capProj];
        const activated = concat.map(x => this.leakyRelu(x));
        const score = this.dot(params.a_upward[head], activated);
        scores.push(score);
      }

      // Softmax attention
      const attentionWeights = this.softmax(scores);
      headAttention[c] = attentionWeights;

      // Weighted aggregation
      const aggregated = new Array(headDim).fill(0);
      for (let i = 0; i < toolIndices.length; i++) {
        const tIdx = toolIndices[i];
        const toolProj = this.matmul([H[tIdx]], params.W_child[head])[0];
        const weight = attentionWeights[i];
        for (let d = 0; d < headDim; d++) {
          aggregated[d] += weight * toolProj[d];
        }
      }

      // Apply activation
      const activated = aggregated.map(x => this.elu(x));

      // Multi-head: concatenate
      if (head === 0) {
        E_new[c] = activated;
      } else {
        for (let d = 0; d < headDim; d++) {
          E_new[c][head * headDim + d] = activated[d];
        }
      }
    }
    attention.push(headAttention);
  }

  return { E_new, attention };
}
```

---

## Upward: Capability → Parent Capability

```typescript
/**
 * Aggregate level-(k-1) capabilities to level-k capabilities
 *
 * E^k = σ(I_k^T · (E^(k-1) ⊙ α_k))
 */
private aggregateCapabilitiesToCapabilities(
  E_child: number[][],
  E_parent: number[][],
  childLevel: number,
  parentLevel: number
): { E_new: number[][]; attention: number[][][] } {
  // Similar structure to aggregateToolsToCapabilities
  // but iterates over child capabilities instead of tools
  // See full implementation in original spec
}
```

---

## Downward: Parent → Child Capability

```typescript
/**
 * Propagate parent embeddings down to children
 *
 * E^k ← E^k + σ(I_{k+1} · (E^(k+1) ⊙ β_{k+1}))
 */
private propagateCapabilitiesToCapabilities(
  E_parent: number[][],
  E_child: number[][],
  parentLevel: number,
  childLevel: number
): { E_new: number[][]; attention: number[][][] } {
  // Residual connection: E_new[c] = E_child[c] + weighted_sum(parent_projections)
  // Uses reverse mapping: childToParents
}
```

---

## Downward: Level-0 → Tools

```typescript
/**
 * Propagate level-0 capability embeddings to tools
 *
 * H ← H + σ(I₀ · (E^0 ⊙ β₀))
 */
private propagateCapabilitiesToTools(
  E_caps: number[][],
  H: number[][],
  level: number
): { H_new: number[][]; attention: number[][][] } {
  // Residual connection: H_new[t] = H[t] + weighted_sum(cap_projections)
  // Uses reverse mapping: toolToCaps
}
```

---

## Attention Formula

```
α_k[i][j] = softmax_j(LeakyReLU(a_k^T · [W_k^child · e_i || W_k^parent · e_j]))
β_k[i][j] = softmax_j(LeakyReLU(b_k^T · [W_k^parent · e_i || W_k^child · e_j]))
```

Where:

- `e_i`: Child embedding (from level k-1)
- `e_j`: Parent embedding (from level k)
- `||`: Concatenation
- `W_k^child`, `W_k^parent`, `a_k`, `b_k`: Learnable parameters per level k

---

## Acceptance Criteria

- [ ] `forward()` returns `MultiLevelEmbeddings`
- [ ] Upward pass: V → E^0 → ... → E^L_max
- [ ] Downward pass: E^L_max → ... → E^0 → V
- [ ] Residual connections in downward pass
- [ ] Attention weights cached for interpretability
- [ ] Multi-head attention with concatenation
