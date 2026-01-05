# Story 3.8: End-to-End Code Execution Tests & Documentation

**Epic:** 3 - Agent Code Execution & Local Processing **Story ID:** 3.8 **Status:** ready-for-dev
**Estimated Effort:** 6-8 heures

---

## User Story

**As a** developer adopting code execution, **I want** comprehensive tests and documentation, **So
that** I understand how to use the feature effectively.

---

## Acceptance Criteria

1. ✅ E2E test suite créé (`tests/e2e/code-execution/`)
2. ✅ Test scenarios:
   - GitHub commits analysis (large dataset filtering)
   - Multi-server data aggregation (GitHub + Jira + Slack)
   - PII-sensitive workflow (email processing)
   - Error handling (timeout, syntax error, runtime error)
   - Resilient workflows with safe-to-fail branches
3. ✅ Performance regression tests added to benchmark suite
4. ✅ Documentation: README section "Code Execution Mode"
5. ✅ Examples provided: 5+ real-world use cases with code samples
6. ✅ Comparison benchmarks: Tool calls vs Code execution (context & latency)
7. ✅ Migration guide: When to use code execution vs DAG workflows
8. ✅ Security documentation: Sandbox limitations, PII protection details
9. ✅ Resilient workflow patterns comprehensive documentation
10. ✅ Video tutorial: 3-minute quickstart (optional, can be deferred)

---

## Tasks / Subtasks

### Phase 1: E2E Test Suite (3-4h)

- [ ] **Task 1: Create E2E test structure** (AC: #1)
  - [ ] Créer `tests/e2e/code-execution/` directory
  - [ ] Créer structure: `01-setup.test.ts`, `02-github-analysis.test.ts`, etc.
  - [ ] Setup helpers: mock MCP servers, test data generators
  - [ ] Cleanup helpers: DB reset, cache clear

- [ ] **Task 2: GitHub commits analysis test** (AC: #2.1)
  - [ ] Test: Fetch 1000 commits → filter last week → aggregate by author
  - [ ] Valider: Output <1KB, input >1MB (context savings)
  - [ ] Valider: Execution time <3 seconds
  - [ ] Valider: Cache hit on second run

- [ ] **Task 3: Multi-server aggregation test** (AC: #2.2)
  - [ ] Test: Fetch from GitHub + Jira + Slack (3 MCP servers)
  - [ ] Tool injection: Vector search finds relevant tools
  - [ ] Aggregate results in sandbox
  - [ ] Valider: All 3 servers called correctly

- [ ] **Task 4: PII-sensitive workflow test** (AC: #2.3)
  - [ ] Test: Dataset avec emails → PII tokenization → agent execution
  - [ ] Valider: Agent code never sees raw emails
  - [ ] Valider: Tokens `[EMAIL_1]` présents dans output
  - [ ] Valider: De-tokenization fonctionne si activée

- [ ] **Task 5: Error handling tests** (AC: #2.4)
  - [ ] Test: Syntax error → structured error response
  - [ ] Test: Runtime error → exception caught et retournée
  - [ ] Test: Timeout → process killed après 30s
  - [ ] Test: Memory limit → process killed si heap >512MB

### Phase 2: Performance & Regression Tests (2h)

- [ ] **Task 6: Performance regression tests** (AC: #3)
  - [ ] Benchmark: Sandbox startup time (<100ms)
  - [ ] Benchmark: Code execution overhead (<50ms)
  - [ ] Benchmark: Cache hit latency (<10ms)
  - [ ] Benchmark: Large dataset processing (1000 items <2s)
  - [ ] Ajouter à `tests/benchmarks/` suite

- [ ] **Task 7: Comparison benchmarks** (AC: #6)
  - [ ] Benchmark: Direct tool calls (baseline)
  - [ ] Benchmark: Code execution (local processing)
  - [ ] Mesurer: Latency (time), Context usage (tokens)
  - [ ] Documenter speedup et context savings

### Phase 3: Documentation (2-3h)

- [ ] **Task 8: README Code Execution Mode section** (AC: #4)
  - [ ] Section overview: What is code execution mode?
  - [ ] When to use: Large datasets, complex processing
  - [ ] Quick start: First code execution example
  - [ ] Configuration: Flags, config options

- [ ] **Task 9: Real-world use cases** (AC: #5)
  - [ ] Example 1: GitHub commit analysis
  - [ ] Example 2: Log aggregation across services
  - [ ] Example 3: Data pipeline (fetch → transform → export)
  - [ ] Example 4: PII-safe data processing
  - [ ] Example 5: Multi-step workflow with caching
  - [ ] Code samples pour chaque use case

- [ ] **Task 10: Migration guide** (AC: #7)
  - [ ] Decision tree: Code execution vs DAG vs Direct tool calls
  - [ ] When to use code execution: criteria + examples
  - [ ] When to use DAG workflows: criteria + examples
  - [ ] When to use direct tool calls: criteria + examples
  - [ ] Migration examples: Before/After comparisons

- [ ] **Task 11: Security documentation** (AC: #8)
  - [ ] Sandbox security model: Permissions, isolation
  - [ ] PII protection: Detection, tokenization, opt-out
  - [ ] Limitations: No network, no filesystem write
  - [ ] Best practices: Input validation, error handling

### Phase 4: Video Tutorial (Optional, 1h)

- [ ] **Task 12: 3-minute quickstart video** (AC: #9, optional)
  - [ ] Script: Install → Configure → First code execution
  - [ ] Demo: GitHub commits analysis example
  - [ ] Show: Context savings metrics
  - [ ] Upload: Embed in README
  - [ ] **Note: Can be deferred to post-epic**

---

## Dev Notes

### E2E Test Suite Structure

**Test Organization:**

```
tests/e2e/code-execution/
├── 01-sandbox-isolation.test.ts       # Security tests
├── 02-github-commits-analysis.test.ts # Real-world use case
├── 03-multi-server-aggregation.test.ts # Cross-server workflow
├── 04-pii-protection.test.ts          # PII tokenization
├── 05-error-handling.test.ts          # Error scenarios
├── 06-caching.test.ts                 # Cache behavior
└── 07-performance.test.ts             # Performance benchmarks
```

**Test Helpers:**

```typescript
// tests/fixtures/code-execution-helpers.ts
export async function setupCodeExecutionTest() {
  const db = createTestDB();
  const sandbox = new CodeSandbox();
  const mockGitHub = new MockGitHubClient();
  return { db, sandbox, mockGitHub };
}

export async function cleanupCodeExecutionTest({ db, sandbox }) {
  await db.close();
  await sandbox.cleanup();
}
```

### Example Test: GitHub Commits Analysis

```typescript
Deno.test("E2E: GitHub commits analysis", async () => {
  const { sandbox, mockGitHub } = await setupCodeExecutionTest();

  // Mock: 1000 commits (2MB dataset)
  const commits = generateMockCommits(1000);
  mockGitHub.setCommits(commits);

  // Execute code in sandbox
  const result = await sandbox.execute(
    `
    const commits = await github.listCommits({ limit: 1000 });
    const lastWeek = commits.filter(c =>
      new Date(c.date) > Date.now() - 7*24*3600*1000
    );
    return {
      total: lastWeek.length,
      authors: [...new Set(lastWeek.map(c => c.author))]
    };
  `,
    { github: mockGitHub },
  );

  // Validate results
  assertEquals(result.result.total, 42);
  assertEquals(result.result.authors.length, 5);

  // Validate context savings
  const inputSize = Buffer.byteLength(JSON.stringify(commits), "utf8");
  const outputSize = Buffer.byteLength(JSON.stringify(result.result), "utf8");
  assert(inputSize > 1_000_000); // >1MB input
  assert(outputSize < 1_000); // <1KB output
  const savings = ((inputSize - outputSize) / inputSize) * 100;
  assert(savings > 99); // >99% savings

  await cleanupCodeExecutionTest({ sandbox, mockGitHub });
});
```

### Documentation Structure

**README.md Section: Code Execution Mode**

````markdown
## Code Execution Mode

### Overview

Casys PML allows agents to write and execute TypeScript code locally in a secure sandbox, enabling:

- **Context savings**: Process large datasets (MB) locally, return summaries (KB)
- **Performance**: Parallel processing, streaming support
- **Privacy**: PII detection and tokenization
- **Flexibility**: Full TypeScript language support

### Quick Start

```typescript
// 1. Enable code execution mode
await mcp.callTool("pml:execute_code", {
  intent: "Analyze GitHub commits from last week",
  code: `
    const commits = await github.listCommits({ limit: 1000 });
    const lastWeek = commits.filter(c => isLastWeek(c.date));
    return { count: lastWeek.length };
  `,
});
```
````

### When to Use Code Execution

| Scenario                  | Use Code Execution? | Rationale                  |
| ------------------------- | ------------------- | -------------------------- |
| Process >100 items        | ✅ Yes              | Save context tokens        |
| Complex transformations   | ✅ Yes              | Full TypeScript support    |
| Single tool, small result | ❌ No               | Direct tool call faster    |
| Real-time (<100ms)        | ❌ No               | Use DAG parallel execution |

### Security & Privacy

- **Sandbox isolation**: No filesystem write, no network access
- **PII protection**: Automatic email, phone, credit card tokenization
- **Timeout**: 30s default (configurable)
- **Memory limit**: 512MB heap

### Performance Benchmarks

| Metric               | Direct Tool Call | Code Execution | Improvement         |
| -------------------- | ---------------- | -------------- | ------------------- |
| Latency (1000 items) | 5s               | 2s             | 2.5x faster         |
| Context usage        | 2MB              | 500 bytes      | 99.98% savings      |
| Cache hit rate       | N/A              | 70%            | 10x faster (cached) |

```
### Migration Guide Content

**Decision Tree:**
```

Need to process data? ├─ Small dataset (<100 items)? │ └─ Use: Direct tool call │ ├─ Large dataset
(>100 items)? │ ├─ Complex processing needed? │ │ └─ Use: Code execution │ │ │ └─ Simple
aggregation? │ └─ Use: Code execution OR DAG │ └─ Multiple independent tools? └─ Use: DAG parallel
execution

````
**Example Migrations:**

**Before (Direct tool call):**
```typescript
const commits = await github.listCommits({ limit: 1000 });
// Problem: 2MB data loaded into LLM context
````

**After (Code execution):**

```typescript
await pml.executeCode({
  intent: "Get commit count",
  code: `
    const commits = await github.listCommits({ limit: 1000 });
    return { count: commits.length };
  `,
});
// Solution: Only 20 bytes in context
```

### Security Documentation

**Sandbox Security Model:**

```
Deno Sandbox Permissions:
✅ --allow-env                 (Environment variables)
✅ --allow-read=~/.pml  (Casys PML data only)
❌ --deny-write                (No write access)
❌ --deny-net                  (No network access)
❌ --deny-run                  (No subprocess spawning)
❌ --deny-ffi                  (No native code)
```

**PII Protection:**

- Automatically detects: emails, phones, credit cards, SSNs, API keys
- Replaces with tokens: `[EMAIL_1]`, `[PHONE_2]`, etc.
- Opt-out: `--no-pii-protection` flag

### Learnings from Previous Stories

**From Story 2.7 (E2E Tests):**

- E2E test structure patterns
- Mock MCP servers utilities
- Performance benchmarking approaches [Source: stories/story-2.7.md]

**From Stories 3.1-3.6:**

- Complete code execution infrastructure
- All features implemented and tested
- Ready for E2E integration testing

### Testing Strategy

**Coverage Goals:**

- E2E tests: 100% of user workflows
- Performance tests: All critical paths benchmarked
- Security tests: All isolation mechanisms validated

**Test Execution:**

```bash
# Run E2E suite
deno test tests/e2e/code-execution/

# Run performance benchmarks
deno bench tests/benchmarks/code-execution/

# Run full suite with coverage
deno test --coverage=coverage tests/
deno coverage coverage
```

### Out of Scope (Story 3.7)

- Video tutorial (optional, can be deferred)
- Advanced optimization guides
- Multi-language code support (only TypeScript)

### References

- [Epic 3 Overview](../epics.md#Epic-3-Agent-Code-Execution--Local-Processing)
- [Story 3.1 - Sandbox](./story-3.1.md)
- [Story 3.2 - Tools Injection](./story-3.2.md)
- [Story 3.3 - Data Pipeline](./story-3.3.md)
- [Story 3.4 - execute_code Tool](./story-3.4.md)
- [Story 3.5 - PII Detection](./story-3.5.md)
- [Story 3.6 - Caching](./story-3.6.md)
- [Story 2.7 - E2E Tests (Epic 2)](./story-2.7.md)

---

## Dev Agent Record

### Context Reference

- [Story 3.8 Context XML](./story-3.8.context.xml) - Generated 2025-11-20

### Agent Model Used

_To be filled by Dev Agent_

### Debug Log References

_Dev implementation notes, challenges, and solutions go here_

### Completion Notes List

_Key completion notes for next story (patterns, services, deviations) go here_

### File List

**Files to be Created (NEW):**

- `tests/e2e/code-execution/01-sandbox-isolation.test.ts`
- `tests/e2e/code-execution/02-github-commits-analysis.test.ts`
- `tests/e2e/code-execution/03-multi-server-aggregation.test.ts`
- `tests/e2e/code-execution/04-pii-protection.test.ts`
- `tests/e2e/code-execution/05-error-handling.test.ts`
- `tests/e2e/code-execution/06-caching.test.ts`
- `tests/e2e/code-execution/07-performance.test.ts`
- `tests/fixtures/code-execution-helpers.ts`
- `tests/benchmarks/code-execution/comparison_bench.ts`
- `docs/guides/code-execution-migration.md`
- `docs/guides/code-execution-security.md`

**Files to be Modified (MODIFIED):**

- `README.md` (add Code Execution Mode section)
- `.github/workflows/ci.yml` (add E2E code-execution tests)

**Files to be Deleted (DELETED):**

- None

---

## Change Log

- **2025-11-09**: Story drafted by BMM workflow, based on Epic 3 requirements
