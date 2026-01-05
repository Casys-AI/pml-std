# 05 - Learnable Parameters

**Parent**: [00-overview.md](./00-overview.md) **Depends on**:
[04-message-passing.md](./04-message-passing.md)

---

## Parameter Structure

For each hierarchy level k ∈ [0, L_max]:

```typescript
interface LevelParams {
  /** Projection matrices per head */
  W_child: number[][][]; // [head][headDim][inputDim]
  W_parent: number[][][]; // [head][headDim][inputDim]

  /** Attention vectors per head */
  a_upward: number[][]; // [head][2*headDim] for upward pass
  a_downward: number[][]; // [head][2*headDim] for downward pass
}
```

---

## Storage

```typescript
class SHGAT {
  /** Parameters indexed by hierarchy level */
  private levelParams: Map<number, LevelParams>;
}
```

---

## Initialization

```typescript
private initializeLevelParameters(): void {
  this.levelParams = new Map();

  for (let level = 0; level <= this.maxHierarchyLevel; level++) {
    const params: LevelParams = {
      W_child: [],
      W_parent: [],
      a_upward: [],
      a_downward: [],
    };

    for (let head = 0; head < this.config.numHeads; head++) {
      // Xavier initialization
      params.W_child.push(
        this.initXavier(this.config.headDim, this.config.embeddingDim)
      );
      params.W_parent.push(
        this.initXavier(this.config.headDim, this.config.embeddingDim)
      );
      params.a_upward.push(
        this.initXavier(1, 2 * this.config.headDim)[0]
      );
      params.a_downward.push(
        this.initXavier(1, 2 * this.config.headDim)[0]
      );
    }

    this.levelParams.set(level, params);
  }
}

private getLevelParams(level: number): LevelParams {
  return this.levelParams.get(level)!;
}
```

---

## Parameter Count

For L_max hierarchy levels and K heads:

```
Per level k:
- W_child: K × headDim × embDim
- W_parent: K × headDim × embDim
- a_upward: K × 2·headDim
- a_downward: K × 2·headDim

Total per level: K × (2·headDim·embDim + 4·headDim)
Total all levels: (L_max + 1) × K × (2·headDim·embDim + 4·headDim)
```

### Example Calculation

| L_max | K | headDim | embDim | Total Params |
| ----- | - | ------- | ------ | ------------ |
| 2     | 4 | 16      | 1024   | ~394K        |
| 3     | 8 | 16      | 1024   | ~1.05M       |
| 2     | 4 | 32      | 1024   | ~790K        |

```
Example (L_max=2, K=4, headDim=16, embDim=1024):
= 3 × 4 × (2·16·1024 + 4·16)
= 12 × (32768 + 64)
= 393,984 parameters
```

---

## Xavier Initialization

```typescript
private initXavier(rows: number, cols: number): number[][] {
  const limit = Math.sqrt(6.0 / (rows + cols));
  const matrix: number[][] = [];

  for (let i = 0; i < rows; i++) {
    const row: number[] = [];
    for (let j = 0; j < cols; j++) {
      row.push((Math.random() * 2 - 1) * limit);
    }
    matrix.push(row);
  }

  return matrix;
}
```

---

## Serialization

```typescript
exportLevelParams(): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [level, params] of this.levelParams) {
    result[`level_${level}`] = {
      W_child: params.W_child,
      W_parent: params.W_parent,
      a_upward: params.a_upward,
      a_downward: params.a_downward,
    };
  }

  return result;
}

importLevelParams(data: Record<string, unknown>): void {
  this.levelParams = new Map();

  for (const key of Object.keys(data)) {
    const level = parseInt(key.replace('level_', ''));
    const params = data[key] as LevelParams;
    this.levelParams.set(level, params);
  }
}
```

---

## Acceptance Criteria

- [ ] `LevelParams` interface defined
- [ ] `levelParams: Map<number, LevelParams>` storage
- [ ] `initializeLevelParameters()` with Xavier init
- [ ] `getLevelParams(level)` accessor
- [ ] `exportLevelParams()` / `importLevelParams()` for persistence
- [ ] Parameter count matches formula
