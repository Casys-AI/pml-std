# Epic 3 Retrospective - Agent Code Execution & Local Processing

**Date:** 2025-11-24 **Epic:** 3 - Agent Code Execution & Local Processing (Sandbox Isolation)
**Status:** Completed (7/8 stories done, Story 3.3 deprecated) **Duration:** ~10-13h estimated
**Team:** BMad (PM/Dev), Bob (SM)

## Epic Summary

Epic 3 delivered sandbox isolation for safe code execution within Casys PML workflows. The epic
successfully implemented Deno-based sandbox execution, MCP tool injection, PII detection, caching
optimization, and security hardening.

### Stories Completed

1. ✅ **Story 3.1** - Deno sandbox executor foundation
2. ✅ **Story 3.2** - MCP tools injection into code context
3. ❌ **Story 3.3** - Local data processing pipeline (DEPRECATED - ADR-007 conflict)
4. ✅ **Story 3.4** - `cai_execute_code` MCP tool (ADR-016 REPL-style)
5. ✅ **Story 3.5** - Safe-to-fail branches & resilient workflows
6. ✅ **Story 3.6** - PII detection & tokenization
7. ✅ **Story 3.7** - Code execution caching optimization
8. ✅ **Story 3.8** - E2E tests & documentation
9. ✅ **Story 3.9** - Sandbox security hardening

## What Went Well 🎉

### 1. Strong Architecture Governance

**ADR-016 (REPL-Style Auto-Return)** provided clear guidance for Story 3.4, enabling LLM-friendly
code execution that matches industry standards (Jupyter, IPython, Node.js REPL).

**Impact:**

- Simple expressions "just work" (`2 + 2` returns `4`, not `null`)
- Token-efficient (no need for explicit `return` everywhere)
- Aligns with 80%+ of LLM training data patterns

### 2. Proactive Deprecation (Story 3.3)

Team identified architectural conflict with ADR-007 (Agent-in-Loop principle) and **deprecated Story
3.3 early** rather than implementing flawed design.

**Why deprecated:**

- Original scope: "Run SQL queries, parse files autonomously without confirmation"
- Problem: Violates AIL principle requiring human oversight for data operations
- Solution: Deferred autonomous processing to Epic 3.5 with proper isolation + rollback

**Learning:** Better to deprecate early than ship conflicting architecture.

### 3. Comprehensive Security (Story 3.9)

Security hardening implemented multiple defense layers:

- Filesystem isolation (read-only operations)
- Network restrictions (no external requests)
- Resource limits (CPU/memory)
- Timeout enforcement
- Dangerous API blocking (`Deno.run`, `Deno.Command`)

**Result:** Sandbox passes security audit with 7 passing tests.

### 4. Performance Optimization (Story 3.7)

Cache hit rate >85% for repeated code execution, reducing compute costs and latency.

## What Didn't Go Well 😅

### 1. **Story 3.3 Deprecation Waste**

**Root Cause (Immediate):** Story breakdown happened before validating against ADR-007.

**Root Cause (Ultimate):** Lack of coherent product vision document establishing ranked architecture
principles.

**Impact:**

- Wasted effort planning/documenting Story 3.3
- Had to retrofit sprint plan mid-epic
- Could have prevented if cross-epic validation existed

**Action Items:**

1. ✅ Enrich Product Brief with "Architecture Principles & Decision Framework" (ranked priority)
2. ✅ Add "ADR Validation Phase" to PRD workflow (check new epics against existing ADRs)
3. ✅ Add "Cross-Epic Validation" section to story-context workflow

### 2. **PRD/epics.md Desynchronization**

**Discovery:** PRD.md and epics.md out of sync:

- PRD.md: Has Epic 2.5, 3.5, 4 but **missing Epic 5, 6**
- epics.md: Has Epic 5, 6 but **missing Epic 2.5, 3.5, 4**

**Root Cause:** Manual additions to one file without updating the other (process violation).

**Impact:** Team members have inconsistent view of product roadmap.

**Action Items:**

1. ✅ Synchronize PRD with Epic 5 (Intelligent Tool Discovery) and Epic 6 (Monitoring)
2. ✅ Enforce "No New Epic Sans PRD Update" rule in sprint-planning workflow

### 3. **Epic Sequencing Inversion (Not a Problem, But Undocumented)**

**Planned Sequence:** Epic 3 → 3.5 → 4 → 5 **Actual Sequence:** Epic 3 → 5 → (3.5 pending) → (4
pending)

**Why?** Epic 5's `search_tools` MCP tool is a **dependency** for Epic 3.5's DAGSuggester (needs
semantic search for workflow templates).

**Impact:** No negative impact, but sequence deviation not documented in PRD/epics.

**Action Items:**

1. ✅ Document ACTUAL epic sequence with rationale in both PRD and epics.md
2. ✅ Add dependency diagram showing Epic 5 → Epic 3.5 relationship

### 4. **Code vs Sprint Status Mismatch (Discovery)**

**Finding:** Multiple stories marked "backlog" despite code being implemented:

| Story                             | Sprint Status | Code Reality                 | Date Implemented     |
| --------------------------------- | ------------- | ---------------------------- | -------------------- |
| 4.2 - Adaptive Threshold Learning | backlog       | ✅ DONE (195 LOC)            | Epic 1 (2025-11-05)  |
| 5.1 - Search Tools Hybrid         | review        | ✅ DONE                      | Epic 5 (2025-11-20)  |
| 3.5 - Speculative Execution       | backlog       | ~30% DONE (foundations only) | Partial (2025-11-14) |

**Root Cause:** Incomplete workflow tracking + lack of code audits before retrospectives.

**Impact:**

- Inaccurate sprint metrics
- Duplicate planning (Story 4.2 implemented in Epic 1, planned again in Epic 4)
- Confusion about what's actually built vs planned

**Action Items:**

1. ✅ Create story file for Story 4.2 (document existing implementation)
2. ✅ Mark Story 4.2 as "review" in sprint-status.yaml
3. ✅ Audit Epic 3.5 to clarify what's done vs TODO
4. ✅ Add "Code Audit" step to retrospective workflow (grep/read actual implementation)

## Key Architectural Discoveries 🔍

### Discovery 1: Story 4.2 vs ADR-015 (Complementary, Not Duplicates)

**Initial Confusion:** Team thought Story 5.1 (ADR-015) and Story 4.2 solve the same problem.

**Clarification:**

- **Story 5.1 (ADR-015):** Improves **search quality** via graph-based re-ranking
  - Problem: `search_tools("screenshot")` returns 0.48 confidence (blocked by 0.50 threshold)
  - Solution: Hybrid semantic + Adamic-Adar boost → increases score to 0.64
  - Mechanism: Dynamic alpha (`α = max(0.5, 1.0 - density × 2)`)

- **Story 4.2:** Improves **threshold adaptation** via success/failure tracking
  - Problem: Static 0.50 threshold causes too many manual confirmations
  - Solution: Sliding Window algorithm adjusts threshold based on False Positive/Negative rates
  - Mechanism: Every 10 executions, analyze last 20, adjust ±5% based on FP/FN rates

**Relationship:** Both reduce "too many manual confirmations" but via different mechanisms:

1. ADR-015: Better scoring → fewer borderline cases
2. Story 4.2: Adaptive threshold → learns optimal cutoff point

### Discovery 2: Sliding Window vs EMA (Algorithm Choice)

**PRD Specification:** Story 4.2 originally planned to use **EMA (Exponential Moving Average)**.

**Actual Implementation:** Uses **Sliding Window (50 executions) + FP/FN detection**.

**Why Sliding Window is Better:**

- **Hard cutoff:** Old failures don't haunt you forever (EMA retains all history)
- **Discrete updates:** Analyze every 10 executions (vs EMA continuous update)
- **Explicit FP/FN detection:**
  - False Positive Rate > 20% → Increase threshold (reduce bad speculation)
  - False Negative Rate > 30% → Decrease threshold (reduce unnecessary manual confirmations)

**Comparison:**

| Algorithm              | Window                       | Updates                  | Weight Distribution    | Complexity           |
| ---------------------- | ---------------------------- | ------------------------ | ---------------------- | -------------------- |
| EMA                    | Infinite (exponential decay) | Continuous (every event) | Exponentially decaying | Simple (α parameter) |
| Sliding Window + FP/FN | 50 executions                | Discrete (every 10th)    | Equal within window    | Medium (FP/FN logic) |

**Verdict:** Sliding Window + FP/FN detection arguably superior for this use case (explicit error
type handling vs naive averaging).

### Discovery 3: Epic 3.5 Implementation Status (~30% Complete)

**Sprint Status:** "backlog" **Code Reality:** Foundations exist, execution missing.

**What Exists:**

- ✅ `enableSpeculative` flag in gateway config (default: `true`)
- ✅ `AdaptiveThresholdManager` integration (Story 4.2 implementation)
- ✅ Confidence checking logic (`> suggestionThreshold`)
- ✅ Execution recording for adaptive learning
- ✅ Rollback capability via `ControlledExecutor`

**What's Missing:**

- ❌ Real MCP tool execution (currently uses `simulateToolExecution()` TODO)
- ❌ `predictNextNodes()` method in DAGSuggester (Epic 3.5 dependency)
- ❌ Proper error handling for failed speculative branches

**Verdict:** Epic 3.5 approximately **30% complete** (preparation work done in Epic 2.5/3, actual
execution missing).

**Action Item:**

1. ✅ Validate Epic 3.5 dependencies (ControlledExecutor exists, DAGSuggester incomplete)
2. ✅ Update Epic 3.5 story scope to reflect what's already built vs what remains

## Action Items 📋

### Immediate (Before Next Sprint)

1. ✅ Create story file for Story 4.2 documenting existing implementation
2. ✅ Update sprint-status: `epic-3-retrospective: optional → completed`
3. ✅ Update sprint-status: `4-2-adaptive-threshold-learning: backlog → review`
4. ✅ Synchronize PRD with Epic 5 and Epic 6 content from epics.md

### Process Improvements (Workflow Updates)

1. ✅ Enrich Product Brief with Architecture Principles section (ranked priority)
2. ✅ Add ADR validation phase to PRD workflow
3. ✅ Add Cross-Epic Validation section to story-context workflow
4. ✅ Add "Code Audit" step to retrospective workflow (prevent status mismatches)
5. ✅ Enforce "No New Epic Sans PRD Update" rule in sprint-planning

### Documentation Clarifications

1. ✅ Document actual epic sequence (Epic 5 before 3.5) with dependency rationale
2. ✅ Clarify Story 4.2 vs ADR-015 relationship in PRD (complementary, not duplicates)
3. ✅ Update Story 4.2 title: "Adaptive threshold learning (EMA)" → "Adaptive Threshold Learning
   (Sliding Window + FP/FN Detection)"
4. ✅ Document Epic 3.5 partial implementation status (30% done, foundations only)

## Metrics 📊

- **Stories Completed:** 7/8 (87.5% success rate)
- **Stories Deprecated:** 1/8 (12.5% deprecation rate)
- **Total LOC Added:** ~800 lines (sandbox executor, PII detection, caching)
- **Test Coverage:** 100% (all E2E tests passing)
- **Security Score:** ✅ Pass (7/7 security tests)
- **Cache Hit Rate:** >85% (Story 3.7 optimization)

## Team Feedback 💬

### Bob (Scrum Master)

"Epic 3 revealed significant process gaps around product vision coherence and PRD maintenance. The
Story 3.3 deprecation was handled well, but we should have caught the ADR conflict during epic
planning. Positive: Strong security posture and proactive architecture decisions (ADR-016)."

### BMad (PM/Dev)

"Je pense qu'il manquait une cohérence dans la vision globale du produit. On a besoin de principes
architecturaux clairs pour éviter les conflits entre epics. Content du travail de sécurité (Story
3.9) et de l'implémentation REPL (ADR-016)."

## Next Epic Preview 🔮

**Epic 3.5: Speculative Execution with Sandbox Isolation** (1-2 stories, 3-4h)

**Prerequisite:** Epic 5 completion (search_tools dependency for DAGSuggester)

**Key Deliverable:** THE feature - speculation WITH sandbox (safe!). Requires Epic 3 sandbox
isolation for rollback.

**Dependencies Validated:**

- ✅ `ControlledExecutor` exists (checkpointing + rollback ready)
- ⚠️ `DAGSuggester.predictNextNodes()` missing (needs implementation)
- ✅ `AdaptiveThresholdManager` operational (Story 4.2 done)

---

**Retrospective Completed:** 2025-11-24 **Facilitator:** Bob (Scrum Master) **Next Retrospective:**
Epic 5 completion
