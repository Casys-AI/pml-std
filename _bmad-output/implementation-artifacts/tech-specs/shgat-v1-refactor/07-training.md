# 07 - Training & Gradient Computation

**Parent**: [00-overview.md](./00-overview.md) **Depends on**:
[04-message-passing.md](./04-message-passing.md), [05-parameters.md](./05-parameters.md)

---

## Forward Cache for Backprop

```typescript
interface ForwardCache {
  H: number[][]; // Final tool embeddings
  E: Map<number, number[][]>; // Cap embeddings per level
  attentionUpward: Map<number, number[][][]>;
  attentionDownward: Map<number, number[][][]>;

  // Intermediate activations for gradient computation
  intermediateUpward: Map<number, {
    childProj: number[][][]; // [cap][head][dim]
    parentProj: number[][][];
    scores: number[][][];
  }>;
  intermediateDownward: Map<number, {
    parentProj: number[][][];
    childProj: number[][][];
    scores: number[][][];
  }>;
}
```

---

## Gradient Flow

For loss L at capability c ∈ E^k:

### Upward Gradients

```
∂L/∂E^k[c] → ∂L/∂α_k → ∂L/∂W_k^child, ∂L/∂W_k^parent, ∂L/∂a_k
           → ∂L/∂E^(k-1)[children of c]
```

### Downward Gradients

```
∂L/∂E^k[c] → ∂L/∂β_k → ∂L/∂W_k^parent, ∂L/∂W_k^child, ∂L/∂b_k
           → ∂L/∂E^(k+1)[parents of c]
```

---

## Backward Pass Structure

```typescript
backward(
  loss: number,
  cache: ForwardCache,
  targetCapId: string
): void {
  const cap = this.capabilityNodes.get(targetCapId)!;
  const level = cap.hierarchyLevel;

  // Initialize gradient at target capability
  const dE = new Map<number, number[][]>();
  for (let l = 0; l <= this.maxHierarchyLevel; l++) {
    const capsAtLevel = Array.from(this.hierarchyLevels.get(l) ?? []);
    dE.set(l, capsAtLevel.map(() => new Array(this.config.embeddingDim).fill(0)));
  }

  // Set gradient at target
  const capsAtLevel = Array.from(this.hierarchyLevels.get(level) ?? []);
  const targetIdx = capsAtLevel.indexOf(targetCapId);
  dE.get(level)![targetIdx] = this.computeLossGradient(loss, cache, targetCapId);

  // ========================================================================
  // BACKWARD THROUGH DOWNWARD PASS (reverse order)
  // ========================================================================
  // Propagate gradients from E^0 → E^1 → ... → E^L_max

  for (let l = 0; l < this.maxHierarchyLevel; l++) {
    this.backwardDownwardPhase(l, l + 1, dE, cache);
  }

  // ========================================================================
  // BACKWARD THROUGH UPWARD PASS (reverse order)
  // ========================================================================
  // Propagate gradients from E^L_max → E^(L_max-1) → ... → E^0 → V

  for (let l = this.maxHierarchyLevel; l >= 0; l--) {
    if (l === 0) {
      this.backwardToolsToCapabilities(dE, cache);
    } else {
      this.backwardCapabilitiesToCapabilities(l - 1, l, dE, cache);
    }
  }

  // ========================================================================
  // ACCUMULATE GRADIENTS
  // ========================================================================
  this.accumulateLevelParamGradients(dE, cache);
}
```

---

## Gradient Through Attention

For attention weights α computed via softmax:

```typescript
/**
 * Backprop through softmax attention
 *
 * Given: dL/d(output), attention weights α, values V
 * Compute: dL/d(scores), dL/d(V)
 */
private backpropAttention(
  dOutput: number[],      // Gradient of loss w.r.t. attention output
  attention: number[],    // Softmax attention weights [numChildren]
  values: number[][],     // Value vectors [numChildren][dim]
  scores: number[]        // Pre-softmax scores
): { dScores: number[]; dValues: number[][] } {
  const numChildren = attention.length;
  const dim = values[0].length;

  // dL/dV[i] = α[i] * dOutput
  const dValues: number[][] = [];
  for (let i = 0; i < numChildren; i++) {
    dValues.push(dOutput.map(g => attention[i] * g));
  }

  // dL/d(scores) via softmax jacobian
  // d(softmax)/d(scores) = diag(α) - α ⊗ α^T
  const dScores: number[] = [];
  for (let i = 0; i < numChildren; i++) {
    let grad = 0;
    for (let j = 0; j < numChildren; j++) {
      const jacobian = (i === j) ? attention[i] * (1 - attention[i]) : -attention[i] * attention[j];
      // Sum over output dimensions
      const outputGrad = values[j].reduce((sum, v, d) => sum + v * dOutput[d], 0);
      grad += jacobian * outputGrad;
    }
    dScores.push(grad);
  }

  return { dScores, dValues };
}
```

---

## Gradient Accumulation

```typescript
interface LevelGradients {
  dW_child: number[][][][];   // [head][row][col]
  dW_parent: number[][][][];
  da_upward: number[][][];    // [head][dim]
  da_downward: number[][][];
}

private levelGradients: Map<number, LevelGradients>;

private accumulateLevelParamGradients(
  dE: Map<number, number[][]>,
  cache: ForwardCache
): void {
  for (let level = 0; level <= this.maxHierarchyLevel; level++) {
    const grads = this.levelGradients.get(level)!;
    const intermediate = cache.intermediateUpward.get(level)!;

    // Accumulate gradients from all capabilities at this level
    // ... detailed accumulation logic
  }
}
```

---

## Apply Gradients

```typescript
applyLevelGradients(learningRate: number): void {
  for (const [level, grads] of this.levelGradients) {
    const params = this.levelParams.get(level)!;

    for (let head = 0; head < this.config.numHeads; head++) {
      // W_child
      for (let i = 0; i < params.W_child[head].length; i++) {
        for (let j = 0; j < params.W_child[head][i].length; j++) {
          params.W_child[head][i][j] -= learningRate * grads.dW_child[head][i][j];
        }
      }

      // W_parent, a_upward, a_downward similarly...
    }
  }

  // Reset gradients
  this.resetLevelGradients();
}
```

---

## Deferred Details

Full implementation of backward pass through each phase is deferred to implementation phase. The
structure above provides the framework.

---

## Acceptance Criteria

- [ ] `ForwardCache` extended for multi-level intermediates
- [ ] `backward()` propagates through all levels
- [ ] `backpropAttention()` correctly handles softmax gradients
- [ ] Gradient accumulation per level
- [ ] `applyLevelGradients()` updates all level parameters
- [ ] Training loop integrates with existing batch training
