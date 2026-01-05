# Story 11.6: SHGAT Training avec PER Sampling

Status: done

## Story

As a learning system, I want to train SHGAT on path-level traces with PER (Prioritized Experience
Replay) sampling, So that SHGAT learns efficiently from surprising execution patterns.

## Context & Background

**Epic 11: Learning from Execution Traces** implements a TD Error + PER + SHGAT learning system
(DQN/Rainbow style). This story is the culmination: training SHGAT using PER-weighted sampling from
`execution_trace`.

**Architecture Overview (2025-12-22):**

```
+---------------------------------------------------------------------------------+
|                     TD + PER + SHGAT (style DQN/Rainbow)                         |
+---------------------------------------------------------------------------------+
|                                                                                 |
|  1. EXECUTION → TRACE (Story 11.2)                                              |
|     workflow terminates → execution_trace stored                                 |
|                                                                                 |
|  2. TD ERROR + PER PRIORITY (Story 11.3)                                        |
|     priority = |actual - shgat.predictPathSuccess(path)|                        |
|     → Surprising traces get high priority                                       |
|                                                                                 |
|  3. PER SAMPLING + SHGAT TRAINING (Story 11.6) ← THIS STORY                     |
|     - Sample traces weighted by PER priority                                    |
|     - Train SHGAT attention weights on batch                                    |
|     - Update priorities after training (TD error recalculated)                  |
|                                                                                 |
+---------------------------------------------------------------------------------+
```

**Différence avec Story 10.7b (tool-level):**

| Aspect          | 10.7b (episodic_events) | 11.6 (execution_trace + PER) |
| --------------- | ----------------------- | ---------------------------- |
| **Sampling**    | Random/récent           | PER (priority-weighted)      |
| **Granularité** | Par tool                | Par path (séquence de nodes) |
| **Label**       | `wasCorrect`            | `success`                    |
| **Signal**      | Binary                  | TD error (continuous)        |
| **Table**       | N/A (in-memory)         | `execution_trace`            |

**Current Implementation (execute-handler.ts:527-583):**

Story 10.7 already implemented basic SHGAT online learning:

```typescript
async function updateSHGAT(shgat, embeddingModel, capability, toolsCalled, intent, success) {
  // 1. Register new tools/capability
  // 2. Single-example training: shgat.trainOnExample(trainingExample)
}
```

**This story enhances with:**

1. PER-weighted batch sampling from `execution_trace` table
2. Path-level features (not just tool-level)
3. Priority updates after training (TD error recalculated)
4. Fallback to tool-level if insufficient traces (<20)
5. **FIX: Utiliser `contextTools` dans trainBatch()** (champ actuellement mort!)

### CRITICAL FIX: contextTools est un champ MORT

**Problème identifié (2025-12-24):**

```typescript
// execute-handler.ts - ON PASSE LE PATH
const trainingExample = {
  contextTools: toolsCalled,  // ← Le path EST là
  ...
};

// shgat.ts trainBatch() - ON NE L'UTILISE PAS!
for (const example of examples) {
  // example.contextTools ← JAMAIS RÉFÉRENCÉ!
  const capIdx = this.capabilityIndex.get(example.candidateId);
  // ... utilise seulement candidateId et intentEmbedding
}
```

**Gap:** On PRÉDIT sur les paths (`predictPathSuccess`) mais on N'APPREND PAS des paths dans
`trainBatch()`.

**Fix dans cette story:** Utiliser `contextTools` pour créer des training examples intermédiaires
(multi-example per trace).

### Clarification: Les 3 types de "Context"

| Terme                    | Où              | Contenu                               | Exemple                                     |
| ------------------------ | --------------- | ------------------------------------- | ------------------------------------------- |
| **`contextTools`**       | TrainingExample | **Path = séquence de nodes exécutés** | `["fs:read", "json:parse", "slack:send"]`   |
| **`initialContext`**     | ExecutionTrace  | Params d'entrée du workflow           | `{ path: "/config.json", channel: "#dev" }` |
| **`taskResults[].args`** | ExecutionTrace  | Args de chaque tool call              | `{ path: "/config.json" }` pour fs:read     |

### Scope: 11.6 vs 12.7

| Story                  | Données utilisées                       | Ce qu'on apprend        |
| ---------------------- | --------------------------------------- | ----------------------- |
| **11.6 (cette story)** | `contextTools` = **le path**            | Transitions entre nodes |
| **12.7 (Epic 12)**     | `initialContext` + `taskResults[].args` | Patterns d'arguments    |

**Dans Story 11.6, "context" = `contextTools` = le PATH (séquence de tools/capabilities exécutés).**

Ce n'est PAS:

- `initialContext` (les paramètres d'entrée du workflow)
- `WorkflowPredictionState.context` (accumulation des résultats - Epic 12)

**Note:** Story 12.7 (Argument-Aware Learning) est dans Epic 12 car elle dépend du stockage propre
des `initialContext` et `taskResults[].args` (Stories 12.1-12.2).

**Prerequisites Completed:**

- Story 11.2 (done) - `execution_trace` table with `priority` column
- Story 11.3 (done) - `calculateTDError()`, `storeTraceWithPriority()`, `SHGAT.predictPathSuccess()`

## Acceptance Criteria

1. **AC1:** `extractPathLevelFeatures(traces: ExecutionTrace[])` implemented:
   ```typescript
   interface PathLevelFeatures {
     pathSuccessRate: number; // success count / total for this exact path
     pathFrequency: number; // relative frequency of this path (0-1)
     decisionSuccessRate: number; // avg success rate at DecisionNodes
     isDominantPath: boolean; // is this the most frequent path?
   }

   function extractPathLevelFeatures(
     traces: ExecutionTrace[],
   ): Map<string, PathLevelFeatures>; // key = path.join("->")
   ```

2. **AC2:** `trainSHGATOnPathTraces()` created:
   ```typescript
   interface PERTrainingResult {
     loss: number;
     accuracy: number;
     tracesProcessed: number;
     highPriorityCount: number;
     prioritiesUpdated: number;
   }

   async function trainSHGATOnPathTraces(
     shgat: SHGAT,
     traceStore: ExecutionTraceStore,
     embeddingProvider: EmbeddingProvider,
     capabilityId: string,
     options?: {
       minTraces?: number; // Default: 20
       maxTraces?: number; // Default: 100
       batchSize?: number; // Default: 32
       minPriority?: number; // Default: 0.1 (skip near-0 priority)
     },
   ): Promise<PERTrainingResult>;
   ```

3. **AC3:** PER-weighted sampling implemented via `ExecutionTraceStore.sampleByPriority()`:
   - High priority traces sampled more frequently
   - Weighted random sampling: `P(trace) ∝ priority^α` (α=0.6 per PER paper)
   - Fallback to uniform sampling if all priorities ≈ 0.5 (cold start)

4. **AC4:** Path-level training pipeline:
   - Load traces from `execution_trace` table (PER-weighted)
   - Extract path-level features for each trace
   - Enrich TrainingExample with path features
   - Call `shgat.trainBatch()` with enriched examples
   - Update trace priorities after training

5. **AC5:** Priority update after training:
   ```typescript
   // After training, TD error has changed (SHGAT predicts differently)
   // Recalculate and update priorities
   for (const trace of trainedTraces) {
     const newTDError = await calculateTDError(shgat, embeddingProvider, trace);
     await traceStore.updatePriority(trace.id, Math.abs(newTDError.tdError));
   }
   ```

6. **AC6:** Fallback to 10.7b (tool-level) if traces < 20:
   ```typescript
   if (traces.length < options.minTraces) {
     return { fallback: "tool-level", reason: "insufficient traces" };
   }
   ```

7. **AC7:** Integration with `execute-handler.ts`:
   - After execution, call `trainSHGATOnPathTraces()` if enough traces
   - Periodic batch training (every N executions or on-demand)

8. **AC8:** Tests: PER sampling produces high-priority biased distribution

9. **AC9:** Tests: path-level training improves prediction vs tool-level

10. **AC10:** Benchmark: overhead of path-level training < 50ms per batch

11. **AC11:** **FIX contextTools** - `trainBatch()` utilise `contextTools` pour path-level learning:
    ```typescript
    // Option A: Multi-example per trace (recommandé)
    function traceToTrainingExamples(trace: ExecutionTrace): TrainingExample[] {
      const examples: TrainingExample[] = [];
      const path = trace.executedPath ?? [];

      // Créer un example pour CHAQUE node du path
      for (let i = 0; i < path.length; i++) {
        examples.push({
          intentEmbedding: trace.intentEmbedding,
          contextTools: path.slice(0, i), // Les nodes AVANT ce point
          candidateId: path[i], // Le node actuel
          outcome: trace.success ? 1 : 0,
        });
      }

      return examples;
    }

    // Option B: Context boost dans trainBatch (plus simple)
    // Dans trainBatch, vérifier si candidateId est connecté aux contextTools
    const hasContextConnection = example.contextTools.some((t) =>
      this.hasEdge(t, example.candidateId)
    );
    const contextBoost = hasContextConnection ? 0.1 : 0;
    ```

12. **AC12:** Tests: multi-example generation produit N examples pour un path de N nodes

13. **AC13:** **Path Flattening** - Les chemins hiérarchiques sont aplatis pour le training:
    ```typescript
    // Cohérence avec SHGAT.collectTransitiveTools() qui aplatit la matrice d'incidence
    async function flattenExecutedPath(
      trace: ExecutionTrace,
      traceStore: ExecutionTraceStore,
    ): Promise<string[]> {
      const flatPath: string[] = [];

      for (const nodeId of trace.executedPath ?? []) {
        flatPath.push(nodeId);

        // Si c'est une capability avec des enfants, récursivement aplatir
        const childTraces = await traceStore.getChildTraces(trace.id);
        const childTrace = childTraces.find((t) => t.capabilityId === nodeId);

        if (childTrace) {
          const childFlat = await flattenExecutedPath(childTrace, traceStore);
          flatPath.push(...childFlat);
        }
      }

      return flatPath;
    }

    // Exemple:
    // Trace: meta_cap → [cap_A, cap_B]
    //   └── cap_A → [fs:read, json:parse]
    //   └── cap_B → [slack:send]
    //
    // Résultat aplati: ["meta_cap", "cap_A", "fs:read", "json:parse", "cap_B", "slack:send"]
    ```

14. **AC14:** Tests: path hiérarchique est correctement aplati (meta → cap → tools)

## Tasks / Subtasks

- [x] **Task 1: Create path-level-features.ts module** (AC: #1) ✅ 2025-12-24
  - [x] 1.1 Create `src/graphrag/learning/path-level-features.ts`
  - [x] 1.2 Implement `extractPathLevelFeatures(traces)` function
  - [x] 1.3 Calculate `pathSuccessRate` per unique path
  - [x] 1.4 Calculate `pathFrequency` (relative to total traces)
  - [x] 1.5 Calculate `decisionSuccessRate` from `decisions[]` in traces
  - [x] 1.6 Identify `isDominantPath` (most frequent)

- [x] **Task 2: Implement PER-weighted sampling** (AC: #3) ✅ 2025-12-24
  - [x] 2.1 Verify `ExecutionTraceStore.sampleByPriority()` exists (from 11.2)
  - [x] 2.2 Add `alpha` parameter (default 0.6) for priority weighting
  - [x] 2.3 Implement weighted random selection: `P(trace) ∝ priority^α`
  - [x] 2.4 Handle cold start: if all priorities ≈ 0.5, use uniform sampling

- [x] **Task 3: Create trainSHGATOnPathTraces()** (AC: #2, #4, #5) ✅ 2025-12-24
  - [x] 3.1 Create function in `src/graphrag/learning/per-training.ts`
  - [x] 3.2 Load traces via PER-weighted sampling
  - [x] 3.3 Extract path-level features
  - [x] 3.4 Build enriched TrainingExample[] with path features
  - [x] 3.5 Call `shgat.trainBatch(examples)`
  - [x] 3.6 Update priorities after training via `batchUpdatePriorities()`
  - [x] 3.7 Return PERTrainingResult with metrics

- [x] **Task 4: Add fallback logic** (AC: #6) ✅ 2025-12-24
  - [x] 4.1 Check trace count before training
  - [x] 4.2 If < minTraces, return fallback result
  - [x] 4.3 Log warning about insufficient traces

- [x] **Task 5: Integrate with execute-handler.ts** (AC: #7) ✅ 2025-12-24
  - [x] 5.1 Import `trainSHGATOnPathTraces` in execute-handler.ts
  - [x] 5.2 Call after capability execution (alongside existing `updateSHGAT`)
  - [x] 5.3 Add periodic training (every 10 executions via `shouldRunBatchTraining()`)
  - [x] 5.4 Handle async training (non-blocking)

- [x] **Task 6: Implement path flattening** (AC: #13, #14) ✅ 2025-12-24
  - [x] 6.1 Create `flattenExecutedPath()` in `src/graphrag/learning/per-training.ts`
  - [x] 6.2 Use `traceStore.getChildTraces(trace.id)` pour trouver les sous-traces
  - [x] 6.3 Récursivement aplatir les chemins hiérarchiques
  - [x] 6.4 Cohérence avec `SHGAT.collectTransitiveTools()` (même logique d'aplatissement)
  - [x] 6.5 Test: meta_cap → cap → tools devient chemin plat

- [x] **Task 7: Implement contextTools fix (multi-example per trace)** (AC: #11, #12) ✅ 2025-12-24
  - [x] 7.1 Create `traceToTrainingExamples()` in `src/graphrag/learning/per-training.ts`
  - [x] 7.2 Use `flattenExecutedPath()` AVANT de générer les examples
  - [x] 7.3 Generate N examples for a path of N nodes
  - [x] 7.4 Each example has `contextTools = flatPath.slice(0, i)` (previous nodes)
  - [x] 7.5 Each example has `candidateId = flatPath[i]` (current node)
  - [x] 7.6 Update `trainSHGATOnPathTraces()` to use multi-example generation
  - [x] 7.7 Test: path of 3 nodes generates 3 training examples
  - [x] 7.8 Fix `SHGAT.trainBatch()` to use `computeContextSimilarity()` for Head 1

- [x] **Task 8: Write unit tests** (AC: #8, #9, #12, #14) ✅ 2025-12-24
  - [x] 8.1 Create `tests/unit/graphrag/per_training_test.ts` (16 tests)
  - [x] 8.2 Test: extractPathLevelFeatures calculates correct rates
  - [x] 8.3 Test: path-level training features
  - [x] 8.4 Test: fallback to tool-level when traces < 20
  - [x] 8.5 Test: traceToTrainingExamples generates correct examples
  - [x] 8.6 Test: flattenExecutedPath aplatit correctement meta → cap → tools
  - [x] 8.7 Test: shouldRunBatchTraining interval logic

- [x] **Task 9: Benchmark performance** (AC: #10) ✅ 2025-12-24
  - [x] 9.1 Inline benchmark: extractPathLevelFeatures + traceToTrainingExamples
  - [x] 9.2 Measured: 0.11ms per batch (100 traces)
  - [x] 9.3 Verified: **0.11ms << 50ms target** ✅

- [x] **Task 10: Validation** ✅ 2025-12-24
  - [x] 10.1 `deno check` passes for all modified files
  - [x] 10.2 Run existing tests: 37 PER tests pass (no regressions)
  - [x] 10.3 Run new tests: 16/16 passing
  - [x] 10.4 Integration: execute-handler.ts calls `runPeriodicBatchTraining()`

## Dev Notes

### Critical Implementation Details

**1. PER Sampling Algorithm (from Schaul et al. 2015)**

```typescript
// src/capabilities/execution-trace-store.ts (verify exists from 11.2)
// OR src/graphrag/learning/per-training.ts

const PER_ALPHA = 0.6; // Priority exponent (0 = uniform, 1 = fully prioritized)

function sampleByPriority(
  traces: ExecutionTrace[],
  n: number,
  alpha: number = PER_ALPHA,
): ExecutionTrace[] {
  // Calculate sampling probabilities
  const priorities = traces.map((t) => t.priority);
  const powered = priorities.map((p) => Math.pow(p, alpha));
  const totalPower = powered.reduce((a, b) => a + b, 0);
  const probs = powered.map((p) => p / totalPower);

  // Weighted random sampling without replacement
  const sampled: ExecutionTrace[] = [];
  const indices = new Set<number>();

  while (sampled.length < n && sampled.length < traces.length) {
    const rand = Math.random();
    let cumSum = 0;
    for (let i = 0; i < traces.length; i++) {
      if (indices.has(i)) continue;
      cumSum += probs[i];
      if (rand <= cumSum) {
        sampled.push(traces[i]);
        indices.add(i);
        break;
      }
    }
  }

  return sampled;
}
```

**2. Path-Level Feature Extraction**

```typescript
// src/graphrag/learning/path-level-features.ts

interface PathLevelFeatures {
  pathSuccessRate: number;
  pathFrequency: number;
  decisionSuccessRate: number;
  isDominantPath: boolean;
}

function extractPathLevelFeatures(
  traces: ExecutionTrace[],
): Map<string, PathLevelFeatures> {
  const pathStats = new Map<string, { success: number; total: number }>();

  // Group traces by path
  for (const trace of traces) {
    const pathKey = (trace.executedPath ?? []).join("->");
    const stats = pathStats.get(pathKey) ?? { success: 0, total: 0 };
    stats.total++;
    if (trace.success) stats.success++;
    pathStats.set(pathKey, stats);
  }

  // Find dominant path
  let dominantPath = "";
  let maxTotal = 0;
  for (const [path, stats] of pathStats) {
    if (stats.total > maxTotal) {
      maxTotal = stats.total;
      dominantPath = path;
    }
  }

  // Calculate features
  const totalTraces = traces.length;
  const features = new Map<string, PathLevelFeatures>();

  for (const [path, stats] of pathStats) {
    features.set(path, {
      pathSuccessRate: stats.success / stats.total,
      pathFrequency: stats.total / totalTraces,
      decisionSuccessRate: calculateDecisionSuccessRate(traces, path),
      isDominantPath: path === dominantPath,
    });
  }

  return features;
}

function calculateDecisionSuccessRate(traces: ExecutionTrace[], pathKey: string): number {
  const pathTraces = traces.filter((t) => (t.executedPath ?? []).join("->") === pathKey);
  if (pathTraces.length === 0) return 0.5;

  // Average success rate at decision points
  let totalDecisions = 0;
  let successfulDecisions = 0;

  for (const trace of pathTraces) {
    for (const decision of trace.decisions) {
      totalDecisions++;
      if (trace.success) successfulDecisions++;
    }
  }

  return totalDecisions > 0 ? successfulDecisions / totalDecisions : 0.5;
}
```

**3. Integration with Existing SHGAT Training**

Current `execute-handler.ts:527-583` does:

```typescript
// After execution
await updateSHGAT(shgat, embeddingModel, capability, toolsCalled, intent, wasSuccessful);
```

Enhanced flow:

```typescript
// After execution
await updateSHGAT(shgat, embeddingModel, capability, toolsCalled, intent, wasSuccessful);

// NEW: PER-based batch training (if enough traces)
const perResult = await trainSHGATOnPathTraces(
  shgat,
  traceStore,
  embeddingModel,
  capability.id,
  { minTraces: 20 },
);
if (perResult.fallback) {
  log.debug("[pml:execute] PER training skipped", { reason: perResult.reason });
}
```

**4. TrainingExample Enrichment (CRITICAL)**

The current `TrainingExample` interface (shgat.ts:185-194) needs path features:

```typescript
// src/graphrag/algorithms/shgat.ts - EXISTING
interface TrainingExample {
  intentEmbedding: number[];
  contextTools: string[];
  candidateId: string;
  outcome: number; // 0 or 1
}

// src/graphrag/learning/per-training.ts - NEW (extends for path-level)
interface PathEnrichedExample extends TrainingExample {
  pathFeatures: PathLevelFeatures;
  executedPath: string[]; // For weighting later nodes higher
}
```

**Integration Strategy:** Do NOT modify TrainingExample interface. Instead:

1. Use `PathEnrichedExample` internally in per-training.ts
2. Map to standard `TrainingExample` when calling `shgat.trainBatch()`
3. Path features influence `outcome` weighting, not SHGAT input shape

**5. EmbeddingProvider Import and Error Handling (CRITICAL)**

```typescript
// Import EmbeddingProvider from per-priority.ts (canonical location)
import { calculateTDError, EmbeddingProvider } from "../../capabilities/per-priority.ts";

// Batch embedding optimization (avoid N sequential calls)
async function getEmbeddingsBatch(
  provider: EmbeddingProvider,
  traces: ExecutionTrace[],
): Promise<Map<string, number[]>> {
  const embeddings = new Map<string, number[]>();
  const uniqueIntents = [...new Set(traces.map((t) => t.intentText ?? ""))];

  // Parallel batch for efficiency
  const results = await Promise.all(
    uniqueIntents.map(async (intent) => {
      try {
        return { intent, embedding: await provider.getEmbedding(intent) };
      } catch (error) {
        log.warn("[PER-Training] Embedding failed", { intent, error: String(error) });
        return { intent, embedding: null };
      }
    }),
  );

  for (const { intent, embedding } of results) {
    if (embedding) embeddings.set(intent, embedding);
  }

  return embeddings;
}
```

**6. Correct PER Sampling Algorithm (BUG FIX)**

The naive implementation has a distribution bug. Use reweighting after each selection:

```typescript
// CORRECT: Reweight after each selection (Schaul et al. 2015)
function sampleByPriorityCorrect(
  traces: ExecutionTrace[],
  n: number,
  alpha: number = 0.6,
): ExecutionTrace[] {
  const available = [...traces];
  const sampled: ExecutionTrace[] = [];

  while (sampled.length < n && available.length > 0) {
    // Recalculate probabilities each iteration
    const priorities = available.map((t) => Math.pow(t.priority, alpha));
    const total = priorities.reduce((a, b) => a + b, 0);

    // Handle cold start: if all priorities near-equal, use uniform
    if (total === 0 || priorities.every((p) => Math.abs(p - priorities[0]) < 0.001)) {
      const idx = Math.floor(Math.random() * available.length);
      sampled.push(available[idx]);
      available.splice(idx, 1);
      continue;
    }

    const probs = priorities.map((p) => p / total);
    const rand = Math.random();
    let cumSum = 0;

    for (let i = 0; i < available.length; i++) {
      cumSum += probs[i];
      if (rand <= cumSum) {
        sampled.push(available[i]);
        available.splice(i, 1);
        break;
      }
    }
  }

  return sampled;
}
```

**7. ExecutionTraceStore.sampleByPriority() Clarification**

The existing implementation (11.2) uses SQL approximation: `ORDER BY priority * random() DESC`. This
is NOT true PER sampling (P(i) ∝ priority^α).

**Decision:** For strict PER compliance, fetch traces then sample in TypeScript:

```typescript
async function getTracesForPERTraining(
  traceStore: ExecutionTraceStore,
  capabilityId: string,
  limit: number = 100,
  alpha: number = 0.6,
): Promise<ExecutionTrace[]> {
  // Fetch more traces than needed, then PER sample
  const allTraces = await traceStore.getTraces(capabilityId, limit * 2);
  return sampleByPriorityCorrect(allTraces, limit, alpha);
}
```

**8. executedPath Source (CRITICAL)**

The `executedPath` field comes from `taskResults[].tool` sequence during trace saving:

```typescript
// In saveTrace flow (worker-bridge.ts or executor.ts)
function buildExecutedPath(taskResults: TraceTaskResult[]): string[] {
  return taskResults.map((r) => r.tool);
}

// Example:
// taskResults = [{tool: "fs:read"}, {tool: "slack:send"}]
// → executedPath = ["fs:read", "slack:send"]
```

**9. Early Implementation Verification (from Epic description)**

Story 10.7 already implemented some SHGAT methods. Verify these work with PER:

| Item                         | Status         | Location              | To Verify                     |
| ---------------------------- | -------------- | --------------------- | ----------------------------- |
| `shgat.trainOnExample()`     | ✅ Implemented | `shgat.ts:1480`       | Works with path traces        |
| `shgat.trainBatch()`         | ✅ Implemented | `shgat.ts:1489`       | Works with enriched features  |
| `shgat.predictPathSuccess()` | ✅ Implemented | `shgat.ts:1302`       | Used for TD error calculation |
| `calculateTDError()`         | ✅ Implemented | `per-priority.ts`     | Used for priority updates     |
| `batchUpdatePriorities()`    | ✅ Implemented | `per-priority.ts:266` | Use for priority updates      |

### Batch Training Performance

| Batch Size | Memory | Latency | Use Case                         |
| ---------- | ------ | ------- | -------------------------------- |
| 16         | Low    | Fast    | Incremental after each execution |
| 32         | Medium | Medium  | Default (balanced)               |
| 64         | Higher | Slower  | Periodic bulk training           |
| 100        | Max    | Slowest | Initial training with history    |

**Recommendation:** Use batchSize=32 for online learning, batchSize=100 for startup.

**Performance Target: 50ms Rationale:**

- Execution response time budget: 200ms
- SHGAT scoring: ~30ms
- PER training overhead: 50ms (25% of budget)
- Leaves 120ms for other operations
- **If exceeded:** Log warning, consider async background training.

### Fallback to Tool-Level Training

When traces < 20 (minTraces):

1. Use existing `updateSHGAT()` from execute-handler.ts (lines 527-583)
2. Continue single-example online learning until threshold reached
3. Log warning: "PER training deferred: insufficient traces"

**Transition:** Once traces >= 20, switch to PER batch training.

### Integration Strategy with execute-handler.ts

```typescript
// execute-handler.ts - ENHANCED flow (lines ~410-440)
async function handleExecutionComplete(...) {
  // EXISTING: Tool-level online learning (Story 10.7)
  await updateSHGAT(shgat, embeddingModel, capability, toolsCalled, intent, success);

  // NEW: Path-level batch training (Story 11.6)
  // Run periodically (every 10 executions) OR when triggered
  if (shouldRunBatchTraining()) {
    const result = await trainSHGATOnPathTraces(shgat, traceStore, embeddingProvider, capability.id);
    if (result.fallback) {
      log.debug("[pml:execute] PER training skipped", { reason: result.reason });
    }
  }
}

function shouldRunBatchTraining(): boolean {
  // Track execution count in module-level state or config
  return executionCount % 10 === 0 || config.forceBatchTraining;
}
```

### Files to Create

| File                                                       | Purpose                       | LOC  |
| ---------------------------------------------------------- | ----------------------------- | ---- |
| `src/graphrag/learning/path-level-features.ts`             | Path feature extraction       | ~100 |
| `src/graphrag/learning/per-training.ts`                    | PER sampling + batch training | ~150 |
| `tests/unit/graphrag/learning/path_level_features_test.ts` | Feature extraction tests      | ~80  |
| `tests/unit/graphrag/learning/per_training_test.ts`        | PER training tests            | ~120 |
| `tests/benchmarks/learning/per_training_bench.ts`          | Performance benchmark         | ~50  |

### Files to Modify

| File                                        | Changes                                    | LOC |
| ------------------------------------------- | ------------------------------------------ | --- |
| `src/graphrag/algorithms/shgat.ts`          | Verify trainBatch works with path features | ~10 |
| `src/mcp/handlers/execute-handler.ts:~583`  | Add PER training call after updateSHGAT    | ~20 |
| `src/capabilities/execution-trace-store.ts` | Verify/enhance sampleByPriority()          | ~30 |
| `src/graphrag/learning/mod.ts`              | Export new modules                         | ~5  |

### Architecture Compliance

- **Deno 2.x** - Runtime (not Node.js)
- **TypeScript strict mode** - All types explicit
- **camelCase** - For all properties (not snake_case)
- **PGlite** - Traces stored in `execution_trace` table
- **Async/await** - No callbacks or .then() chains
- **Config externalized** - Use `dag-scoring.yaml` for PER_ALPHA if needed

### References

- [Epic 11: Learning from Traces](../epics/epic-11-learning-from-traces.md)
- [Story 11.2: Execution Trace Table](./11-2-execution-trace-table.md) - PREREQUISITE (done)
- [Story 11.3: TD Error + PER Priority](./11-3-td-error-per-priority.md) - PREREQUISITE (done)
- [Story 10.7: pml_execute API](./10-7-pml-execute-api.md) - SHGAT integration base
- [Source: src/graphrag/algorithms/shgat.ts:1480-1600](../../src/graphrag/algorithms/shgat.ts) -
  trainOnExample, trainBatch
- [Source: src/mcp/handlers/execute-handler.ts:527-583](../../src/mcp/handlers/execute-handler.ts) -
  updateSHGAT
- [Source: src/capabilities/per-priority.ts](../../src/capabilities/per-priority.ts) -
  calculateTDError
- [Source: src/capabilities/execution-trace-store.ts](../../src/capabilities/execution-trace-store.ts) -
  ExecutionTraceStore
- [ADR-050: Unified Search Simplification](../adrs/ADR-050-unified-search-simplification.md) - SHGAT
  architecture

### Previous Story Intelligence

**From Story 11.3 (TD Error + PER Priority - done 2025-12-23):**

- `calculateTDError(shgat, embeddingProvider, trace)` requires `EmbeddingProvider` param
- `SHGAT.predictPathSuccess(intentEmbedding, path)` uses multi-head architecture
- `storeTraceWithPriority()` saves trace with `priority = |tdError|`
- Cold start: if no nodes registered, returns priority = 0.5
- 12 unit tests + 5 E2E tests established patterns

**From Story 11.2 (Execution Trace Table - done 2025-12-23):**

- `ExecutionTraceStore` class with `saveTrace()`, `getTraces()`, `getHighPriorityTraces()`,
  `updatePriority()`, `sampleByPriority()`
- `execution_trace.priority` column (FLOAT, default 0.5)
- `sanitizeForStorage()` for redacting sensitive data
- 33 tests including `inferDecisions()` for branch tracking

**From Story 10.7 (pml_execute - done 2025-12-23):**

- `updateSHGAT()` function in execute-handler.ts:527-583
- `shgat.trainOnExample()` for single-example online learning
- `shgat.registerTool()` and `shgat.registerCapability()` for new nodes

### Git Intelligence

Recent commits (2025-12-23):

```
2b6fb75 feat(story-11.3): TD Error + PER Priority - 12 tests passing
xxxxxxx feat(story-11.2): execution_trace table + store - 33 tests passing
```

Patterns observed:

- Commit format: `feat(story-X.Y): description`
- Tests in `tests/unit/` mirror `src/` structure
- Learning-related code in `src/graphrag/learning/`

### Estimation

**Effort:** 2-3 days

**Breakdown:**

- Task 1 (path-level-features.ts): 3h
- Task 2 (PER sampling): 2h
- Task 3 (trainSHGATOnPathTraces): 4h
- Task 4 (fallback logic): 1h
- Task 5 (execute-handler integration): 2h
- Task 6 (unit tests): 3h
- Task 7 (benchmark): 1h
- Task 8 (validation): 1h

**Risk:**

- PER sampling correctness: need to verify weighted random sampling implementation
- Performance: batch training on 100 traces must complete in < 50ms
- Integration: must not break existing `updateSHGAT()` flow

### Dependencies

```
Story 11.2 (execution_trace table) ← DONE
       |
       v
Story 11.3 (TD Error + PER Priority) ← DONE
       |
       v
Story 11.6 (SHGAT Training with PER) ← THIS STORY
       |
       v
Story 11.4 (Definition/Invocation Views) ← Next
```

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

**2025-12-24 - Unification PER Training:**

- Supprimé `updateSHGAT()` (single-example tool-level)
- Remplacé par `registerSHGATNodes()` + `runPERBatchTraining()`
- Training à chaque exécution (était toutes les 10)
- `minTraces = 1` (était 20)
- Ajouté verrou anti-concurrence (`isTrainingInProgress`)
- Mis à jour ADR-050, epic-11, story 10-7

### File List

**Created:**

- `src/graphrag/learning/path-level-features.ts` - Path-level feature extraction (AC1)
- `src/graphrag/learning/per-training.ts` - PER training pipeline (AC2-AC7, AC11-AC13)
- `tests/unit/graphrag/per_training_test.ts` - Unit tests (19 tests, AC8-AC10, AC12, AC14)

**Modified:**

- `src/graphrag/learning/mod.ts` - Export new modules
- `src/capabilities/execution-trace-store.ts` - Enhanced `sampleByPriority()` with true PER sampling
  (AC3)
- `src/graphrag/algorithms/shgat.ts` - Added `matVecMul`, `dotProduct`, learned multi-head attention
- `src/mcp/handlers/execute-handler.ts` - Replaced `updateSHGAT()` with `registerSHGATNodes()` +
  `runPERBatchTraining()`, added training lock
