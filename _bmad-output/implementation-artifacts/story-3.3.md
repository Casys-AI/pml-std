# Story 3.3: Local Data Processing Pipeline

**Epic:** 3 - Agent Code Execution & Local Processing **Story ID:** 3.3 **Status:** deprecated
**Estimated Effort:** N/A (deprecated)

---

## ⚠️ DEPRECATED - Architecture Decision 2025-11-20

**Raison de dépréciation :**

Cette story est **architecturalement incompatible** avec Epic 2.5 (AIL/HIL Feedback Loops) et
**redondante** avec Story 3.4.

**Problèmes identifiés :**

1. **Coupe l'Agent-in-the-Loop (AIL)** :
   - Processing pipeline séparé = boîte noire sans interaction
   - Agent ne peut pas observer, ajuster, ou replan durant l'exécution
   - Contradictoire avec architecture adaptive DAG (Epic 2.5)

2. **Redondant avec Story 3.4** :
   - Story 3.4 (`pml:execute_code`) permet déjà code execution dans DAG
   - DAG avec code_execution tasks = pipeline de processing
   - Event stream + checkpoints permettent AIL durant processing
   - Exemple : fetch → analyze → deep_dive (agent peut injecter tasks dynamiquement)

3. **Alternative supérieure existe** :
   ```typescript
   // Au lieu de pipeline séparé, utiliser DAG hybride avec AIL :
   const workflow = {
     tasks: [
       { id: "fetch", tool: "github:list_commits" }, // MCP
       { id: "analyze", type: "code_execution", code: "..." }, // Processing
       // Agent peut observer + injecter tasks durant execution
     ],
   };
   ```

**Décision :** Utiliser Story 3.4 (DAG + code_execution) qui préserve AIL et permet workflows
adaptatifs.

**Impact :** Aucun - fonctionnalité déjà couverte par architecture existante.

---

## ⚠️ SCOPE CLARIFICATION NEEDED - Discussion 2025-11-20 (ARCHIVÉ)

### Issue Identified

Story 3.3 scope **overlaps/conflicts** with Story 3.4 and the actual architecture.

### Original Intent vs Reality

**Original Story 3.3 Intent:**

- Implement "data processing pipeline" with pre-built helpers (filter, map, reduce, groupBy)
- Seemed to suggest a library of processing utilities

**Actual Architecture (ADR-007 + Anthropic Code Execution research):**

- The LLM agent **writes TypeScript code directly** to process data
- No pre-built "pipeline" - agents generate custom processing code
- Code executes in sandbox (3.1) with MCP tools injection (3.2)
- **Story 3.4 (`execute_code` tool) already implements this pattern**

### The Confusion

**Key questions:**

1. Who writes the processing code?
   - Original 3.3: Pre-built helpers?
   - Reality: Agent writes custom TypeScript code

2. What's the difference between 3.3 and 3.4?
   - AC #8 in 3.3: "Integration with DAG executor: Code execution as DAG task type"
   - **This is Story 3.4's core responsibility!**

3. Is a "pipeline library" needed?
   - Anthropic approach: Agent writes vanilla TypeScript
   - No mention of pre-built processing helpers in ADR-007 or PRD

### Analysis of Acceptance Criteria Overlap

**Story 3.3 ACs that are actually Story 3.4:**

- AC #1: "Data processing pipeline implemented in sandbox" → 3.4 execute_code
- AC #2: "Agent code can: filter, map, reduce" → 3.4 with agent-written code
- AC #8: "Integration with DAG executor" → **3.4 Phase 3 explicitly covers this**
- AC #9: "Metrics logged" → 3.4 already includes metrics in output schema

**What might be unique to 3.3 (if redefined):**

- AC #6: "Streaming support" - but agents can use ReadableStream in 3.4
- AC #7: "Memory efficiency" - sandbox config in 3.4

### Possible Resolutions

**Option A: SKIP Story 3.3 Entirely** ⭐ RECOMMENDED

- Story 3.4 already covers the real need (code execution + data processing)
- Agent writes custom code, no need for pre-built pipeline
- PRD FR017-FR019 fully covered by Story 3.4
- **Pros:** No duplication, cleaner architecture
- **Cons:** None identified

**Option B: REDEFINE as "Standard Library for Sandbox"**

- Provide common utilities available in sandbox context
- Like lodash, date-fns, or data transformation helpers
- Agents can use them optionally in their code
- **Pros:** Could be helpful for common patterns
- **Cons:** May not be needed, adds maintenance burden

**Option C: DEFER Until Real Need Emerges**

- Implement Story 3.4 first
- Monitor what patterns emerge from actual usage
- Extract common patterns into library later if needed
- **Pros:** Data-driven, avoids over-engineering
- **Cons:** Delays potential optimization

### Recommendation

**Skip or Defer Story 3.3:**

- Story 3.4 delivers the actual architectural need
- No clear differentiation from 3.4 in current form
- If utilities are needed, add them incrementally in future stories

### Action Items

- [ ] BMad decision: Skip, Redefine, or Defer?
- [ ] If Skip: Update sprint-status to "cancelled" with reason
- [ ] If Redefine: New ACs focusing on stdlib, not pipeline
- [ ] If Defer: Move to backlog pending 3.4 completion + usage analysis

---

## User Story (ORIGINAL - SUBJECT TO CHANGE)

**As a** user executing workflows with large datasets, **I want** data to be processed locally
before reaching the LLM context, **So that** I save context tokens and get faster responses.

**⚠️ NOTE:** This user story may be redundant with Story 3.4 execute_code tool.

---

## Acceptance Criteria (⚠️ ORIGINAL - LIKELY REDUNDANT WITH 3.4)

**NOTE:** These ACs overlap significantly with Story 3.4. Review needed before implementation.

1. ✅ Data processing pipeline implemented in sandbox
2. ✅ Agent code can: filter, map, reduce, aggregate large datasets
3. ✅ Example use case working: Fetch 1000 GitHub commits → filter last week → return summary
4. ✅ Context measurement: Raw data (1MB+) processed locally, summary (<1KB) returned
5. ✅ Performance benchmark: 1000-item dataset processed in <2 seconds
6. ✅ Streaming support: Large datasets streamed through processing pipeline
7. ✅ Memory efficiency: Process datasets larger than heap limit via streaming
8. ✅ Integration with DAG executor: Code execution as DAG task type
9. ✅ Metrics logged: input_size_bytes, output_size_bytes, processing_time_ms

---

## Tasks / Subtasks (⚠️ ORIGINAL - SUBJECT TO MAJOR REVISION)

**NOTE:** These tasks assume a "pipeline library" approach that may not align with the actual
architecture. Awaiting scope clarification.

### Phase 1: Pipeline Foundation (2h) - MAY BE REDUNDANT

- [ ] **Task 1: Implement data processing helpers** (AC: #1, #2)
  - [ ] Créer `src/sandbox/data-pipeline.ts` module
  - [ ] Implémer helpers standards: `filter()`, `map()`, `reduce()`, `groupBy()`
  - [ ] Supporter chaining d'opérations
  - [ ] Retourner résultats JSON-serializable uniquement

- [ ] **Task 2: GitHub commits example use case** (AC: #3)
  - [ ] Créer test case: fetch 1000 commits via mock GitHub client
  - [ ] Code agent: filter commits from last week
  - [ ] Code agent: aggregate by author
  - [ ] Code agent: return top 5 authors + commit count
  - [ ] Valider output summary < 1KB

### Phase 2: Context Optimization & Metrics (2h)

- [ ] **Task 3: Context measurement** (AC: #4)
  - [ ] Mesurer taille données input (bytes)
  - [ ] Mesurer taille données output (bytes)
  - [ ] Calculer ratio compression (input/output)
  - [ ] Logger metrics via telemetry system
  - [ ] Target: >99% reduction pour large datasets

- [ ] **Task 4: Performance benchmarks** (AC: #5)
  - [ ] Benchmark: 100 items → <200ms
  - [ ] Benchmark: 1000 items → <2 seconds
  - [ ] Benchmark: 10000 items → <20 seconds
  - [ ] Comparer vs sequential tool calls (baseline)
  - [ ] Documenter speedup gains

### Phase 3: Streaming Support (2h)

- [ ] **Task 5: Implement streaming pipeline** (AC: #6, #7)
  - [ ] Support `ReadableStream` dans sandbox
  - [ ] Permettre traitement chunk-by-chunk
  - [ ] Éviter loading dataset entier en mémoire
  - [ ] Exemple: stream 100k commits, process par batches de 1000
  - [ ] Valider memory usage reste constant (no heap growth)

### Phase 4: DAG Integration & Telemetry (1-2h)

- [ ] **Task 6: DAG executor integration** (AC: #8)
  - [ ] Ajouter `"code_execution"` comme type de tâche DAG
  - [ ] Permettre code execution dans workflow parallèle
  - [ ] Exemple: Task A (code) → Task B (MCP tool) → Task C (code)
  - [ ] Tester workflow hybride (code + tools)

- [ ] **Task 7: Metrics logging** (AC: #9)
  - [ ] Logger `input_size_bytes` dans telemetry
  - [ ] Logger `output_size_bytes` dans telemetry
  - [ ] Logger `processing_time_ms` dans telemetry
  - [ ] Logger `compression_ratio` (input/output)
  - [ ] Dashboard-ready format (opt-in telemetry)

---

## Dev Notes

### Value Proposition: Context Savings

**Example: GitHub Commits Analysis**

**Without Local Processing (baseline):**

```typescript
// Fetch 1000 commits via MCP tool
const commits = await github.listCommits({ repo: "anthropics/claude", limit: 1000 });
// Result: ~2MB JSON loaded into LLM context
// Context consumption: ~500k tokens
```

**With Local Processing (this story):**

```typescript
// Agent writes code that runs in sandbox
const code = `
  const commits = await github.listCommits({ repo: "anthropics/claude", limit: 1000 });

  // Filter last week (local processing, no context cost)
  const lastWeek = commits.filter(c =>
    new Date(c.date) > Date.now() - 7 * 24 * 3600 * 1000
  );

  // Aggregate by author (local)
  const byAuthor = lastWeek.reduce((acc, c) => {
    acc[c.author] = (acc[c.author] || 0) + 1;
    return acc;
  }, {});

  // Return only top 5 (local)
  return Object.entries(byAuthor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([author, count]) => ({ author, count }));
`;

// Result: ~500 bytes JSON returned to LLM context
// Context consumption: ~100 tokens (99.98% reduction!)
```

**Savings: 2MB → 500 bytes = 99.98% context reduction**

### Architecture Constraints

**Memory Management:**

- Sandbox heap limit: 512MB (from Story 3.1)
- For datasets > 512MB: MUST use streaming
- Streaming allows processing unlimited data size
- Chunk size: 1000 items per batch (configurable)

**Performance Targets:**

| Dataset Size | Target Time | Rationale                 |
| ------------ | ----------- | ------------------------- |
| 100 items    | <200ms      | Real-time UX              |
| 1000 items   | <2s         | Acceptable for background |
| 10000 items  | <20s        | Batch processing          |

**Integration with Epic 1 & 2:**

- Reuse vector search for tool discovery (Story 1.5)
- Integrate with DAG executor for hybrid workflows (Story 2.2)
- Tool injection from Story 3.2 enables data fetching

### Project Structure Alignment

**New Module: `src/sandbox/data-pipeline.ts`**

```
src/sandbox/
├── executor.ts           # Story 3.1 - Sandbox execution
├── context-builder.ts    # Story 3.2 - Tool injection
├── data-pipeline.ts      # Story 3.3 - Data processing (NEW)
└── types.ts              # Shared types
```

**Integration Points:**

- `src/dag/executor.ts`: Add `code_execution` task type
- `src/dag/types.ts`: Extend `TaskType` enum
- `src/telemetry/metrics.ts`: Log processing metrics

### Testing Strategy

**Test Organization:**

```
tests/unit/sandbox/
└── data_pipeline_test.ts         # Pipeline operations tests

tests/integration/
└── code_execution_flow_test.ts   # End-to-end: fetch → process → return

tests/benchmarks/
└── data_processing_bench.ts      # Performance benchmarks
```

**Benchmark Tests:**

```typescript
Deno.bench("Process 100 commits", async () => {
  const commits = generateMockCommits(100);
  const result = await sandbox.execute(
    `
    const filtered = commits.filter(c => c.author === "alice");
    return { count: filtered.length };
  `,
    { commits },
  );
  assertEquals(result.result.count, 20);
});
```

### Learnings from Previous Stories

**From Story 3.1 (Sandbox Foundation):**

- Sandbox startup <100ms validated
- Timeout 30s sufficient pour large datasets
- Memory limit 512MB → streaming needed pour >512MB datasets [Source: stories/story-3.1.md]

**From Story 3.2 (Tools Injection):**

- Tool wrappers disponibles dans code context
- Vector search identifies relevant tools
- MCP calls routed via gateway
- Use `github.listCommits()` syntax in agent code [Source: stories/story-3.2.md]

**From Story 2.2 (DAG Executor):**

- DAG supports multiple task types (MCP tools)
- Can extend to support code execution tasks
- Topological sort handles dependencies
- Parallel execution for independent tasks [Source: stories/story-2.2.md]

### Example Use Cases

**Use Case 1: Commit Analysis (from AC #3)**

```typescript
const commits = await github.listCommits({ limit: 1000 });
const lastWeek = commits.filter((c) => isLastWeek(c.date));
return {
  total: lastWeek.length,
  authors: [...new Set(lastWeek.map((c) => c.author))],
  files: getMostChanged(lastWeek),
};
// Input: 2MB → Output: 300 bytes
```

**Use Case 2: Multi-Source Aggregation**

```typescript
const [commits, issues, prs] = await Promise.all([
  github.listCommits({ limit: 100 }),
  github.listIssues({ state: "open" }),
  github.listPRs({ state: "open" }),
]);

return {
  activity_score: calculateScore(commits, issues, prs),
  top_contributors: getTopContributors([commits, issues, prs]),
};
// Input: 5MB → Output: 200 bytes
```

**Use Case 3: Streaming Large Dataset**

```typescript
const stream = github.listCommitsStream({ limit: 100000 });

let total = 0;
let byDay = {};

for await (const batch of stream) {
  total += batch.length;
  for (const commit of batch) {
    const day = commit.date.split("T")[0];
    byDay[day] = (byDay[day] || 0) + 1;
  }
}

return { total, daily: byDay };
// Input: 200MB streamed → Output: 2KB
```

### Performance Optimizations

**Strategy 1: Lazy Evaluation**

- Don't process all data if early exit possible
- Example: `find()` stops at first match

**Strategy 2: Batch Processing**

- Process 1000 items per batch for streaming
- Balance memory usage vs overhead

**Strategy 3: Parallel Processing (future)**

- Out of scope for Story 3.3
- Could use Web Workers in sandbox (future optimization)

### Security Considerations

**Data Privacy:**

- All processing happens locally in sandbox
- No data sent to external services
- PII tokenization (Story 3.5) will add extra layer

**Resource Limits:**

- Timeout prevents infinite loops
- Memory limit prevents OOM attacks
- CPU throttling (future consideration)

### Out of Scope (Story 3.3)

- PII detection/tokenization (Story 3.5)
- Result caching (Story 3.6)
- MCP tool `pml:execute_code` (Story 3.4)
- E2E documentation (Story 3.7)

### References

- [Epic 3 Overview](../epics.md#Epic-3-Agent-Code-Execution--Local-Processing)
- [Story 3.1 - Sandbox Foundation](./story-3.1.md)
- [Story 3.2 - Tools Injection](./story-3.2.md)
- [Story 2.2 - DAG Executor](./story-2.2.md)

---

## Dev Agent Record

### Context Reference

<!-- Context will be generated when story scope is clarified -->

### Agent Model Used

_To be filled by Dev Agent_

### Debug Log References

_Dev implementation notes, challenges, and solutions go here_

### Completion Notes List

_Key completion notes for next story (patterns, services, deviations) go here_

### File List

**Files to be Created (NEW):**

- `src/sandbox/data-pipeline.ts`
- `tests/unit/sandbox/data_pipeline_test.ts`
- `tests/integration/code_execution_flow_test.ts`
- `tests/benchmarks/data_processing_bench.ts`

**Files to be Modified (MODIFIED):**

- `src/dag/executor.ts` (add code_execution task type)
- `src/dag/types.ts` (extend TaskType enum)
- `src/telemetry/metrics.ts` (log processing metrics)
- `mod.ts` (export data pipeline)

**Files to be Deleted (DELETED):**

- None

---

## Change Log

- **2025-11-20**: **SCOPE CLARIFICATION ADDED** - Story overlaps significantly with Story 3.4.
  Marked for review: Skip, Redefine, or Defer pending BMad decision.
- **2025-11-09**: Story drafted by BMM workflow, based on Epic 3 requirements

---

## Summary of Discussion (2025-11-20)

### What We Discovered

During Story 3.4 contextualization, we realized that:

1. **Story 3.3 and 3.4 solve the same problem differently:**
   - 3.3: Pre-built "pipeline" with helpers (filter, map, reduce)
   - 3.4: Agent writes custom TypeScript code

2. **Anthropic's architecture (which we're following) uses 3.4's approach:**
   - No pre-built pipeline library
   - Agents write vanilla TypeScript code
   - Code executes in sandbox with tool injection

3. **Multiple ACs in 3.3 are actually 3.4's responsibility:**
   - AC #8: "Integration with DAG executor" → **This is 3.4 Phase 3!**
   - AC #1, #2, #9: Already covered by 3.4

### Three Options Forward

**Option A: Skip 3.3** ⭐

- Story 3.4 delivers the actual need
- No duplication, cleaner Epic 3 scope
- FR017-FR019 from PRD fully covered by 3.4

**Option B: Redefine as "Sandbox Standard Library"**

- Provide optional utilities (lodash-style)
- Agents can use if helpful
- Not a "pipeline" but a "stdlib"

**Option C: Defer**

- Implement 3.4 first
- See what patterns emerge
- Extract common utilities later if needed

### Next Steps

Awaiting BMad's decision on which option to pursue before any further work on Story 3.3.
