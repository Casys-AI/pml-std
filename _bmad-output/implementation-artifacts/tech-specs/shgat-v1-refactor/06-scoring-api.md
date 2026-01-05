# 06 - Scoring API Changes

**Parent**: [00-overview.md](./00-overview.md) **Depends on**:
[04-message-passing.md](./04-message-passing.md)

---

## Architecture Summary

| Version | Scoring Method         | Message Passing     | TraceFeatures         |
| ------- | ---------------------- | ------------------- | --------------------- |
| **v1**  | Pure cosine similarity | Yes (n-SHG)         | No                    |
| **v2**  | K heads + MLP          | No (raw embeddings) | Yes                   |
| **v3**  | K heads + MLP          | Yes                 | Yes (dimension issue) |

---

## v1: Pure n-SuperHyperGraph Structure

Based on [Smarandache n-SuperHyperGraph](../../../docs/research/n-superhypergraph-smarandache.pdf)
and [n-SuHGAT](../../../docs/research/Graph+Attention+Networks+(3).pdf) research papers.

```typescript
scoreAllCapabilities(
  intentEmbedding: number[],    // 1024 dim
  _contextToolIds?: string[]    // Unused in v1
): AttentionResult[] {
  // 1. Multi-level message passing: V → E^0 → E^1 → ... → E^L_max
  const { E } = this.forward();

  // 2. Project intent to match propagated embedding dimension
  const intentProjected = this.projectIntent(intentEmbedding); // 1024 → hiddenDim

  for (const [capId, cap] of capabilityNodes) {
    const cIdx = this.graphBuilder.getCapabilityIndex(capId)!;

    // 3. Pure cosine similarity (no TraceFeatures, no MLP)
    const score = cosineSimilarity(intentProjected, E[cIdx]);

    // 4. Normalize [-1, 1] → [0, 1] and apply reliability
    const reliabilityMult = cap.successRate < 0.5 ? 0.5 :
                            cap.successRate > 0.9 ? 1.2 : 1.0;
    const finalScore = Math.min(0.95, Math.max(0, (score + 1) / 2 * reliabilityMult));

    results.push({
      capabilityId: capId,
      score: finalScore,
      headScores: [score],  // Single cosine score
      // ...
    });
  }

  return results.sort((a, b) => b.score - a.score);
}
```

**Key insight**: The multi-level message passing learns structural patterns (pageRank, adamicAdar,
spectralCluster) implicitly via attention weights. No need for explicit `hypergraphFeatures` in v1.

---

## v2: Behavioral Features + K-Head Attention

Uses raw embeddings + TraceFeatures + K-head attention + MLP fusion.

```typescript
scoreAllCapabilitiesV2(
  intentEmbedding: number[],
  traceFeaturesMap: Map<string, TraceFeatures>,
  contextToolIds: string[] = [],
): AttentionResult[] {
  // No message passing - use raw embeddings
  for (const [capId, cap] of capabilityNodes) {
    const features: TraceFeatures = {
      intentEmbedding,                    // 1024 dim
      candidateEmbedding: cap.embedding,  // 1024 dim (raw)
      contextEmbeddings,
      contextAggregated,                  // 1024 dim
      traceStats,                         // 17 behavioral features
    };

    // K-head attention on projected features
    const projected = projectFeaturesV2(features);  // 3089 → hiddenDim
    const headScores = computeMultiHeadScoresV2(projected);

    // MLP fusion: K scores → final score
    const score = fusionMLPForward(headScores);

    results.push({
      capabilityId: capId,
      score,
      headScores,
      // ...
    });
  }

  return results.sort((a, b) => b.score - a.score);
}
```

**TraceStats (17 features):**

- `successRate`, `usageCount`, `avgLatency`, etc.
- Learned from execution history

---

## v3: Hybrid (Dimension Issue)

Combines message passing + TraceFeatures, but has a dimension mismatch:

- W_proj expects: 1024 + 1024 + 1024 + 17 = **3089** input dim
- With E[cIdx] (propagated): 1024 + 256 + 1024 + 17 = **2321** input dim

**Status**: Not recommended until dimension alignment is resolved.

---

## AttentionResult Interface

```typescript
interface AttentionResult {
  capabilityId: string;
  score: number;
  headWeights: number[];
  headScores: number[]; // v1: [cosine], v2: [head1, head2, ...]
  recursiveContribution: number;
  featureContributions?: {
    semantic: number; // v1: cosine, v2: headScores[0]
    structure: number; // v1: 0, v2: headScores[1]
    temporal: number; // v1: 0, v2: headScores[2]
    reliability: number;
  };
  toolAttention?: number[];
  hierarchyLevel?: number;
}
```

---

## Acceptance Criteria

- [x] `scoreAllCapabilities()` uses multi-level forward pass
- [x] Pure cosine similarity (no TraceFeatures, no MLP)
- [x] v2 API unchanged (bypasses message passing)
- [x] Unit tests pass (36/36)
- [x] Scores differentiated across capabilities
