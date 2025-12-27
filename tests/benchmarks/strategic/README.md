# SHGAT Version Comparison Benchmarks

Comparison of three SHGAT (Semantic Heterogeneous Graph Attention) scoring approaches.

## Architectures

| Version | Description                                                                 |
| ------- | --------------------------------------------------------------------------- |
| **v1**  | Message passing (V→E→V) + 3 specialized heads (semantic/structure/temporal) |
| **v2**  | Direct embeddings + Rich TraceFeatures (17 features) + K heads + Fusion MLP |
| **v3**  | HYBRID: Message passing + TraceFeatures + K heads + Fusion MLP              |

## Results

### Accuracy vs Training Epochs

| Epochs | v1 MRR | v2 MRR    | v3 MRR |
| ------ | ------ | --------- | ------ |
| 3      | 0.275  | 0.298     | 0.198  |
| 15     | 0.315  | 0.437     | 0.151  |
| 25     | 0.178  | **0.733** | 0.233  |

### Best Results (25 epochs, 100 training examples)

| Version | MRR       | Hit@1     | Hit@3     | Latency    |
| ------- | --------- | --------- | --------- | ---------- |
| v1      | 0.178     | 0%        | 33.3%     | 119 ms     |
| **v2**  | **0.733** | **66.7%** | **66.7%** | **2.5 ms** |
| v3      | 0.233     | 0%        | 33.3%     | 121 ms     |

## Key Findings

1. **v2 scales best with training**: MRR improves from 0.298 to 0.733 (+146%)
2. **v1 overfits**: Performance degrades with more training (0.315 → 0.178)
3. **v3 unstable**: Oscillates without clear improvement trend
4. **v2 is 47x faster**: 2.5ms vs ~120ms for v1/v3

## Conclusion

**v2 (direct + K heads + MLP)** is the recommended architecture:

- Best accuracy (MRR 0.733)
- Best latency (2.5ms, 47x faster)
- Best learning capacity (scales with training data)

The message passing approach in v1/v3 adds computational overhead without accuracy benefits.

## Running the Benchmark

```bash
deno task bench tests/benchmarks/strategic/shgat-v1-v2-v3-comparison.bench.ts
```
