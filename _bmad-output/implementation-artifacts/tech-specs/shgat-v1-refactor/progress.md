# SHGAT v1 Refactor - Progress Tracker

**Last Updated**: 2025-12-26

---

## Implementation Status

### Phase 1: Data Model

- [x] `Member` type supports both tools and capabilities
- [x] `CapabilityNode` has `members: Member[]` field
- [x] `hierarchyLevel` field added to CapabilityNode
- [x] Backward compat helpers (`getDirectTools()`, `getDirectCapabilities()`)
- [x] `createMembersFromLegacy()` helper
- [x] `migrateCapabilityNode()` helper
- [x] `@deprecated` marker on `collectTransitiveTools()` (in graph-builder.ts)

### Phase 2: Hierarchy Computation

- [x] `computeHierarchyLevels()` implemented via topological sort
- [x] Cycle detection throws `HierarchyCycleError`
- [x] `hierarchyLevels: Map<number, Set<string>>` populated
- [x] `maxHierarchyLevel` tracked
- [x] `getCapabilitiesAtLevel()` helper
- [x] `getSortedLevels()` helper
- [x] `validateAcyclic()` utility

### Phase 3: Incidence Structure

- [x] `toolToCapIncidence: Map<string, Set<string>>` for I₀
- [x] `capToCapIncidence: Map<number, Map<string, Set<string>>>` for I_k
- [x] `parentToChildIncidence` reverse mapping
- [x] `capToToolIncidence` reverse mapping (for downward pass)
- [x] `buildMultiLevelIncidence()` implemented
- [x] NO transitive closure (direct membership only)
- [x] Helper functions: `getCapsContainingTool`, `getToolsInCap`, `getParentCaps`, `getChildCaps`
- [x] `getIncidenceStats()` for debugging

### Phase 4: Message Passing

- [x] `MultiLevelEmbeddings` interface defined
- [x] `forward()` returns multi-level structure (`forwardMultiLevel()`)
- [x] Upward pass: `aggregateToolsToCapabilities()` (via VertexToEdgePhase)
- [x] Upward pass: `aggregateCapabilitiesToCapabilities()` (via EdgeToEdgePhase)
- [x] Downward pass: `propagateCapabilitiesToCapabilities()` (via EdgeToEdgePhase reverse)
- [x] Downward pass: `propagateCapabilitiesToTools()` (via EdgeToVertexPhase)
- [x] Attention weights cached for interpretability

### Phase 5: Parameters ✅

- [x] `LevelParams` interface (W_child, W_parent, a_upward, a_downward)
- [x] `levelParams: Map<number, LevelParams>` storage (passed to `forwardMultiLevel`)
- [x] `initializeLevelParameters()` with Xavier init
- [x] `countLevelParameters()` for parameter counting
- [x] `getLevelParams(level)` accessor with error handling
- [x] `exportLevelParams()` / `importLevelParams()` for persistence
- [x] `getAdaptiveHeadsByGraphSize()` - adaptive heads based on graph complexity
- [x] Parameter count formula verified in tests (10 tests pass)

### Phase 6: Scoring API ✅

- [x] `scoreAllCapabilities()` uses multi-level forward pass (`MultiLevelScorer`)
- [x] `targetLevel` optional filter parameter
- [x] `hierarchyLevel` field in AttentionResult
- [x] v2 API unchanged (uses raw embeddings, bypasses message passing)
- [x] Multi-level scorer uses `E.get(level)[idx]` for propagated embeddings
- [x] Convenience methods: `scoreLeafCapabilities()`, `scoreMetaCapabilities()`, `getTopByLevel()`

### Phase 7: Training ✅

- [x] `ForwardCache` extended for multi-level (`ExtendedMultiLevelForwardCache`)
- [x] `intermediateUpward` and `intermediateDownward` caching
- [x] Gradient flow through upward pass (`backwardUpwardPhase()`)
- [x] Gradient flow through downward pass (`backwardDownwardPhase()`)
- [x] Backprop through all hierarchy levels (`backwardMultiLevel()`)
- [x] **Online learning**: `trainOnSingleExample()` for production (no epochs)
- [x] `trainSHGATOnExecution()` high-level wrapper

### Phase 8: Migration

- [x] `migrateCapabilityNode()` legacy converter (in types.ts)
- [x] `addCapabilityLegacy()` backward compat API (in shgat.ts)
- [ ] `parent_trace_id` DB column added
- [ ] `ExecutionTrace` interface updated
- [ ] `saveTrace()` accepts parentTraceId
- [ ] `buildHierarchy()` reconstruction utility

### Phase 9: Testing

- [x] Unit tests: hierarchy level computation (16 tests in hierarchy_test.ts)
- [x] Unit tests: cycle detection (4 tests in hierarchy_test.ts)
- [x] Unit tests: upward aggregation (10 tests in multi-level-message-passing_test.ts)
- [x] Unit tests: downward propagation (included in message-passing tests)
- [x] Unit tests: backward compatibility (3 tests for legacy API)
- [x] Unit tests: level parameters (10 tests in level-params_test.ts)
- [x] Integration test: end-to-end scoring
- [x] Benchmark: v1 vs v2 vs v3 comparison (shgat-v1-v2-v3-comparison.bench.ts)
- [ ] Performance: forward pass ≤ 2× old time
- [ ] Performance: memory ≤ old for L_max ≤ 3

---

## Acceptance Criteria Summary

| Category        | Criteria                                     | Status                     |
| --------------- | -------------------------------------------- | -------------------------- |
| Data Model      | `CapabilityNode.members` with `Member` type  | ✅                         |
| Incidence       | Multi-level structure, no transitive closure | ✅                         |
| Message Passing | Upward V→E^L_max, Downward E^L_max→V         | ✅                         |
| Parameters      | Xavier init, adaptive heads, serialization   | ✅                         |
| Scoring         | Uses correct level embeddings                | ✅                         |
| Testing         | All unit + integration tests pass            | 🟢 (36/36 unit tests pass) |
| Performance     | Forward ≤ 2× old, Memory ≤ old               | ⬜                         |

---

## Notes

### 2025-12-25: Phase 4 Complete - Multi-Level Message Passing

**Implemented:**

- `MultiLevelEmbeddings` and `LevelParams` interfaces in `types.ts`
- `MultiLevelForwardCache` for backpropagation support
- `forwardMultiLevel()` in `MultiLevelOrchestrator`:
  - Upward pass: V → E^0 (via VertexToEdgePhase) → E^1 → ... → E^L_max (via EdgeToEdgePhase)
  - Downward pass: E^L_max → ... → E^1 → E^0 (via EdgeToEdgePhase reverse) → V (via
    EdgeToVertexPhase)
  - Residual connections in downward pass
  - Attention weights cached per level for interpretability
  - Dropout support during training

**Architecture Notes:**

- Uses existing `VertexToEdgePhase`, `EdgeToEdgePhase`, `EdgeToVertexPhase` classes
- Multi-head attention with concatenation (same as legacy V→E→V)
- Parameters passed as `Map<number, LevelParams>` keyed by level
- Incidence matrices passed separately: `toolToCapMatrix` (I₀) and `capToCapMatrices` (I_k for k≥1)

**Next Steps:**

- Update scoring API to use multi-level embeddings
- Add unit tests for multi-level message passing

### 2025-12-25: Code Review Fixes Applied

**Fixed issues from adversarial code review:**

1. **[HIGH] Missing `initializeLevelParameters()`** ✅
   - Added `initializeLevelParameters(config, maxLevel)` to `initialization/parameters.ts`
   - Uses Xavier initialization for W_child, W_parent, a_upward, a_downward
   - Added `countLevelParameters()` for parameter counting

2. **[HIGH] Dimension mismatch in residual connection** ✅
   - Fixed residual to be applied AFTER `concatHeads()`, not before
   - Both operands now have matching dimensions `[numNodes][numHeads * headDim]`

3. **[HIGH] Empty Map edge case** ✅
   - Added validation: throws if `E_levels_init.size === 0`

4. **[MEDIUM] EdgeToEdgePhase created per iteration** ✅
   - Pre-create phases in a Map before the loop
   - Reuse cached instances: `edgeToEdgePhases.get(\`up-${level}\`)`

5. **[MEDIUM] Untracked files** ✅
   - `hierarchy.ts`, `incidence.ts`, `multi-level-scorer.ts`, `multi-level-trainer.ts` staged

### 2025-12-25: Phase 5 Complete - Parameters & Adaptive Heads

**Implemented:**

- `getLevelParams(levelParams, level)` - accessor with error handling
- `exportLevelParams()` / `importLevelParams()` - JSON serialization for persistence
- `getAdaptiveHeadsByGraphSize(numTools, numCaps, maxLevel)` - adaptive heads based on:
  - Graph size: 4→6→8→12→16 heads as graph grows
  - Hierarchy depth: +1-2 heads for deep hierarchies (L_max ≥ 2)
  - Always returns even numHeads for symmetric attention

**Tests Added:**

- `tests/unit/graphrag/shgat/level-params_test.ts` (10 tests)
- Parameter count formula verification
- Round-trip serialization
- Adaptive heads scaling

### 2025-12-25: Phase 6 Complete - Scoring API

**Implemented:**

- `MultiLevelScorer` class in `scoring/multi-level-scorer.ts`
- `scoreAllCapabilities(intent, targetLevel?)` - scores all or filtered level
- `hierarchyLevel` field added to `AttentionResult` interface
- Convenience methods:
  - `scoreLeafCapabilities(intent)` - level 0 only
  - `scoreMetaCapabilities(intent, level)` - specific meta-level
  - `getTopByLevel(intent, topK)` - top-K per level

**API Examples:**

```typescript
const scorer = new MultiLevelScorer(deps);

// Score all levels
const all = scorer.scoreAllCapabilities(intent);

// Score only leaf (level 0)
const leaves = scorer.scoreLeafCapabilities(intent);

// Score meta-capabilities (level 1)
const metas = scorer.scoreMetaCapabilities(intent, 1);

// Top 5 per level
const byLevel = scorer.getTopByLevel(intent, 5);
```

### 2025-12-25: Phase 7 Extended - Online Learning

**Added for production use (no epochs to manage):**

```typescript
import { trainSHGATOnExecution } from "./shgat.ts";

// After each capability execution:
await trainSHGATOnExecution(shgat, {
  intentEmbedding: userIntentVector,
  targetCapId: "executed-capability-id",
  outcome: 1, // 1 = success, 0 = failure
});
```

**Benefits:**

- No epochs/batch configuration needed in production
- Single gradient update per execution
- Continuous learning from user interactions
- Works with 460+ tools (batch training not required at startup)

### 2025-12-26: Multi-Level Forward Wired Up + Cache Format Adapted

**Critical fix: `forwardMultiLevel()` was implemented but never wired up!**

The main `forward()` method was still using the flattened incidence matrix with transitive closure.
Fixed by:

1. **Wired `forwardMultiLevel()` in `SHGAT.forward()`**:
   - Added `rebuildHierarchy()` call on graph changes
   - Added `buildToolToCapMatrix()` for level-0 incidence
   - Added `buildCapToCapMatrices()` for inter-level incidence
   - Added `flattenEmbeddingsByCapabilityOrder()` for backward-compat output

2. **Fixed `transposeMatrix` bug in EdgeToVertexPhase**:
   - Downward pass was transposing the matrix incorrectly
   - `EdgeToVertexPhase.forward()` expects `[tool][cap]` format (same as upward)

3. **Adapted cache format for training**:
   - Added `convertAttentionToLayerFormat()` method
   - Converts `Map<level, [head][src][tgt]>` → `[layer][head][src][tgt]`
   - Interpolates H and E arrays across layers for gradient flow
   - Training backward pass now works with multi-level forward

**Benchmark Results (with training, 30 epochs):**

```
Version                                           MRR       Hit@1     Hit@3
--------------------------------------------------------------------------------
v1 (message passing + cosine)                     0.237     9.3       20.9
v2 (direct + K heads + MLP)                       0.175     2.3       16.3
v3 (HYBRID: message passing + K heads + MLP)      0.175     4.7       11.6
--------------------------------------------------------------------------------
🏆 WINNER (by MRR): v1 with MRR=0.237
```

**v1 Architecture (pure n-SuperHyperGraph):**

- Forward: V → E^0 → E^1 → ... → E^L_max (upward) then back (downward)
- Scoring: `cosine(projectIntent(intent), E_propagated[cap])`
- No TraceFeatures, no MLP fusion - pure structural similarity

**All 10 multi-level message passing tests pass.**

### 2025-12-26: Dimension Bug Fix - propagatedDim

**Critical bug found and fixed in dimension calculations!**

The code had `propagatedDim = numHeads * hiddenDim` which was **wrong**.

**Correct formula:**

```
hiddenDim = numHeads * headDim    (e.g., 4 * 16 = 64)
propagatedDim = hiddenDim         (NOT numHeads * hiddenDim!)
```

After `concatHeads()`, the output dimension is `numHeads * headDim = hiddenDim`. So `W_intent`
should project intent from `embeddingDim` → `hiddenDim` (not `numHeads * hiddenDim`).

**Files fixed:**

- `initialization/parameters.ts:186`: `propagatedDim = hiddenDim`
- `initialization/parameters.ts:161`: `layerInputDim = l === 0 ? embeddingDim : hiddenDim`
- `initialization/parameters.ts:573`: Same fix for `countParameters()`
- `training/v1-trainer.ts:82,106`: Same fix for gradient accumulators

**Dimension flow (with adaptive heads):**

```
Graph size    numHeads  headDim  hiddenDim  propagatedDim
< 50          4         16       64         64
< 200         6         16       96         96
< 500         8         32       256        256
< 1000        12        32       384        384
>= 1000       16        32       512        512
```

**All 36 unit tests pass after fix.**

### 2025-12-26: K-Head Training + Production Integration

**K-Head Scoring Architecture:**

```
score = sigmoid(mean(headScores))
headScore[h] = Q[h] · K[h] / √dim
Q[h] = W_q[h] @ intentProjected
K[h] = W_k[h] @ capEmbedding
```

**Problem solved:** Xavier init gave W_q, W_k ~ 0.01 → Q·K ≈ 0 → sigmoid(0) = 0.5 → gradNorm = 0.002

**Fix:** `initMatrixScaled(rows, cols, 10)` - scale × 10 for W_q/W_k

- gradNorm: 0.002 → 0.023 (× 11)
- Scores now diversified (0.5995-0.6005 vs all 0.6000)

**New Training Functions:**

```typescript
// Batch training with K-head backprop
trainBatchV1KHead(examples): { loss, accuracy, tdErrors, gradNorm }

// Online learning (production) - trains after each execution
trainSHGATOnExecution(shgat, { intentEmbedding, targetCapId, outcome })
```

**Files added/modified:**

- `training/multi-level-trainer-khead.ts` - K-head backprop (W_q, W_k gradients)
- `initialization/parameters.ts` - `initMatrixScaled()` for K-head init
- `learning/online-learning.ts` - Event listener for live training

**Production Integration (execute-handler.ts):**

```typescript
// Switched from V2 to V1 (V1 won benchmark)
const shgatCapabilities = deps.shgat.scoreAllCapabilities(intentEmbedding);
const shgatTools = deps.shgat.scoreAllTools(intentEmbedding);
```

**Benchmark Results (V1 K-head, 30 epochs):**

```
Version                              MRR       Hit@1     Hit@3
v1 (message passing + K heads)       0.214     4.7%      23.3%
v2 (direct + K heads + MLP)          0.198     4.7%      20.9%
v3 (HYBRID)                          0.170     4.7%      7.0%
🏆 WINNER: v1 with MRR=0.214
```

**Event types added:**

- `learning.online.trained` - emitted after each online training

### 2025-12-26: Online Learning Fix - Fetch Trace from DB

**Bug:** `OnlineLearningController` expected `intent_embedding` in event payload, but
`execution.trace.saved` doesn't include it.

**Fix:** Controller now fetches the trace from DB via `traceStore.getTraceById(trace_id)`:

```typescript
// Before (broken):
const payload = event.payload as { trace_id; capability_id; success; intent_embedding };
// intent_embedding was always undefined!

// After (fixed):
const trace = await this.traceStore.getTraceById(payload.trace_id);
if (!trace?.intentEmbedding) return;
// Now uses trace.intentEmbedding from DB
```

**API change:**

```typescript
// Constructor now requires traceStore
new OnlineLearningController(shgat, traceStore, config);
startOnlineLearning(shgat, traceStore, config);
```
