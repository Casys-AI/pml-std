# Story 7.3a: Capability Matching & search_capabilities Tool

> **Epic:** 7 - Emergent Capabilities & Learning System **ADRs:** ADR-027 (Execute Code Graph
> Learning), ADR-028 (Emergent Capabilities System) **Prerequisites:** Story 7.2b (Schema
> Inference - DONE, 19 tests passing) **Status:** in-progress

## User Story

As an AI agent, I want to search for existing capabilities matching my intent, So that I can
discover and reuse proven code.

## Problem Context

### Current State (After Story 7.2b)

The `CapabilityStore` class exists with:

- `saveCapability()` - Stores capabilities on 1st successful execution (eager learning)
- `searchByIntent()` - Vector search on `workflow_pattern.intent_embedding`
- `findByCodeHash()` - Exact match lookup
- `updateUsage()` - Stats update after reuse

**BUT:** No intelligent matching layer exists between Claude and CapabilityStore:

```
Current Flow:
Claude intent → ??? → Manual capability search → Execute code

Desired Flow:
Claude intent → CapabilityMatcher.findMatch() → MATCH → Execute cached code
             → NO MATCH → Generate new code → Learn
```

### Missing Components

1. **CapabilityMatcher** - Intelligent matching with adaptive thresholds
2. **MCP Tool** - `pml:search_capabilities` exposed to Claude
3. **Feedback Loop** - Track match outcomes to improve thresholds (FP/FN auto-adjustment)

### Impact

Without capability matching, Claude must:

- Always generate code from scratch (~2-5s per generation)
- Not benefit from previously learned patterns
- Have no way to discover what capabilities exist

## Solution: CapabilityMatcher + MCP Tool

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Claude (MCP Client)                                                         │
│    │                                                                         │
│    │ 1. search_capabilities({ intent: "parse config file" })                │
│    ▼                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  GatewayServer                                                               │
│    │                                                                         │
│    │ 2. Route to DAGSuggester (Central Intelligence)                         │
│    ▼                                                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ DAGSuggester                                                           │ │
│  │                                                                        │ │
│  │  ┌────────────────────────┐  ┌────────────────────────────────────┐   │ │
│  │  │ CapabilityMatcher      │  │ AdaptiveThresholdManager           │   │ │
│  │  │ (Helper)               │  │ .getThresholds()                   │   │ │
│  │  │ .findMatch()           │  │                                    │   │ │
│  │  └────────────────────────┘  └────────────────────────────────────┘   │ │
│  │                                                                        │ │
│  │  3. Active Search: Semantic * Reliability (ADR-038)                  │ │
│  │  4. Return { capabilities, suggestions, threshold_used }              │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│    │ 5. JSON response to Claude                                             │
│    ▼                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Integration with Adaptive Thresholds (Epic 4)

**Key Integration Point:** `src/mcp/adaptive-threshold.ts`

```typescript
// AdaptiveThresholdManager provides dynamic thresholds
const thresholds = adaptiveThresholds.getThresholds();
// Returns: { explicitThreshold: 0.50, suggestionThreshold: 0.70 }

// CapabilityMatcher uses suggestionThreshold for matching
const matchThreshold = thresholds.suggestionThreshold; // Default: 0.70

// After capability execution, record outcome for feedback
adaptiveThresholds.recordExecution({
  mode: "speculative",
  confidence: similarity,
  success: executionSucceeded,
  executionTime: durationMs,
});
```

**Context Type for Capabilities:**

- Create new context: `capability_matching`
- Initial threshold: `suggestionThreshold` (0.70)
- Auto-adjustment based on:
  - FP: capability matched but execution failed
  - FN: user generated new code when similar capability existed

---

## Acceptance Criteria

### AC1: CapabilityMatcher Class Created

- [x] File `src/capabilities/matcher.ts` created
- [x] Class `CapabilityMatcher` exported
- [x] Constructor signature:
  ```typescript
  constructor(
    capabilityStore: CapabilityStore,
    adaptiveThresholds: AdaptiveThresholdManager,
  )
  ```
- [x] Dependency injection for both components (testable)

### AC2: findMatch Method (Active Search Mode)

- [x] Method `findMatch(intent: string): Promise<CapabilityMatch | null>` implemented
- [x] **Algorithm (ADR-038):** `Score = SemanticSimilarity * ReliabilityFactor`
  - Semantic: Vector cosine similarity
  - Reliability: Penalize if success_rate < 0.5 (factor 0.1), Boost if > 0.9 (factor 1.2)
- [x] **Threshold from adaptive system:**
  ```typescript
  const threshold = this.adaptiveThresholds.getThresholds().suggestionThreshold;
  // Compare final Score vs Threshold
  ```
- [x] Returns best match above threshold, or null if none

### AC3: CapabilityMatch Return Type

- [x] Type defined in `src/capabilities/types.ts`:
  ```typescript
  interface CapabilityMatch {
    capability: Capability;
    score: number; // Final score (Semantic * Reliability)
    semanticScore: number; // Raw semantic similarity
    thresholdUsed: number;
    parametersSchema: JSONSchema | null;
  }
  ```
- [x] Includes threshold used for transparency/debugging

### AC4: MCP Tool search_capabilities Exposed

- [x] Tool registered in `GatewayServer.listTools()`
- [x] Tool name: `pml:search_capabilities` (existing naming convention with colon)
- [x] Input schema (from epic: "Pas de threshold en param"):
  ```json
  {
    "type": "object",
    "properties": {
      "intent": {
        "type": "string",
        "description": "Natural language description of what you want to do"
      },
      "include_suggestions": {
        "type": "boolean",
        "default": false,
        "description": "Include related tool suggestions"
      }
    },
    "required": ["intent"]
  }
  ```

### AC5: Tool Output Format

- [x] Response includes all relevant data for Claude:
  ```typescript
  interface SearchCapabilitiesResponse {
    capabilities: Array<{
      id: string;
      name: string;
      description: string;
      code_snippet: string;
      parameters_schema: JSONSchema | null;
      success_rate: number;
      usage_count: number;
      score: number; // Final score (Semantic * Reliability)
      semantic_score: number; // Raw semantic similarity
    }>;
    suggestions?: Array<{
      type: "tool" | "capability";
      name: string;
      reason: string;
    }>;
    threshold_used: number;
    total_found: number;
  }
  ```
- [x] `threshold_used` included for adaptive system transparency

### AC6: Feedback Loop Integration

- [x] After capability execution from match:
  ```typescript
  adaptiveThresholds.recordExecution({
    mode: "speculative",
    confidence: match.similarity,
    success: executionResult.success,
    executionTime: durationMs,
  });
  ```
- [x] Stats update via `capabilityStore.updateUsage()`
- [x] Feedback persisted to PGlite (via AdaptiveThresholdManager.saveThresholds)
- Note: Implemented in `gateway-server.ts` execute_code flow (lines 1237-1273)

### AC7: Observability (ADR-039)

- [~] Trace algorithm decisions (partial - uses logger.debug/info):
  ```typescript
  // Current implementation uses:
  logger.info("Capability match found", { score, threshold });
  logger.debug("Capability search completed", { ...details });
  // TODO: Migrate to structured tracer.log format per ADR-039
  ```

### AC8: Tests

- [x] Test: create capability → search by similar intent → verify match uses adaptive threshold
- [x] Test: no match above threshold → returns null
- [x] Test: verify threshold_used matches adaptiveThresholds.getThresholds()
- [ ] Test: recordExecution called after match execution (feedback loop) - TODO
- [ ] Test: after FP (failure), threshold increases (adaptive behavior) - TODO
- [ ] Test: MCP tool registered and callable via gateway - TODO

---

## Tasks / Subtasks

- [x] **Task 1: Create CapabilityMatcher class** (AC: #1, #2, #3)

  - [x] 1.1 Create `src/capabilities/matcher.ts`
  - [x] 1.2 Implement constructor with DI
  - [x] 1.3 Implement `findMatch()` method
  - [x] 1.4 Add CapabilityMatch type to types.ts
  - [x] 1.5 Export from `src/capabilities/mod.ts`

- [x] **Task 2: Expose MCP tool** (AC: #4, #5)

  - [x] 2.1 Add tool schema in `gateway-server.ts`
  - [x] 2.2 Implement tool handler for `pml:search_capabilities`
  - [x] 2.3 Wire CapabilityMatcher to gateway (via DAGSuggester)
  - [x] 2.4 Wire CapabilityMatcher in serve.ts runtime init

- [x] **Task 3: Feedback loop integration** (AC: #6)

  - [x] 3.1 Add recordExecution call in execution flow
  - [x] 3.2 Add updateUsage call after execution
  - [x] 3.3 Verify persistence with saveThresholds

- [~] **Task 4: Unit tests** (AC: #8) - PARTIAL

  - [x] 4.1 Create `tests/unit/capabilities/matcher_test.ts`
  - [x] 4.2 Test adaptive threshold integration (3 tests passing)
  - [ ] 4.3 Test feedback loop (FP → threshold increase) - TODO
  - [ ] 4.4 Test MCP tool registration - TODO

---

## Dev Notes

### Critical Implementation Details

1. **NO HARDCODED THRESHOLDS**

   ```typescript
   // WRONG ❌
   if (similarity >= 0.7) {
     return capability;
   }

   // CORRECT ✅
   const threshold = this.adaptiveThresholds.getThresholds().suggestionThreshold;
   if (similarity >= threshold) {
     return capability;
   }
   ```

2. **Quality via Feedback Loop (pas de quality gate hardcodé)**

   - FP (capability matched but failed) → `recordExecution({ success: false })` → threshold augmente
   - FN (user generated new code when capability existed) → threshold diminue
   - Le système apprend automatiquement à éviter les capabilities de mauvaise qualité

3. **MCP Tool Naming Convention**: Use colons (existing pattern)

   - `pml:search_capabilities` ✅
   - `cai_search_capabilities` ❌

4. **Feedback Loop Critical**: Without recordExecution, thresholds never adapt!

### Project Structure Notes

**Files to Create:**

```
src/capabilities/
├── matcher.ts           # NEW: CapabilityMatcher class (~80-100 LOC)
└── types.ts             # MODIFY: Add CapabilityMatch type
```

**Files to Modify:**

```
src/capabilities/mod.ts        # Add CapabilityMatcher export
src/mcp/gateway-server.ts      # Add search_capabilities tool (~40 LOC)
```

**File Locations (from architecture):**

- Capabilities: `src/capabilities/`
- MCP tools: `src/mcp/gateway-server.ts`
- Adaptive thresholds: `src/mcp/adaptive-threshold.ts`

### Existing Code Patterns to Follow

**CapabilityStore.searchByIntent** (`src/capabilities/capability-store.ts:251-274`):

```typescript
async searchByIntent(
  intent: string,
  limit = 5,
  minSimilarity = 0.5,
): Promise<Array<{ capability: Capability; similarity: number }>> {
  const embedding = await this.embeddingModel.encode(intent);
  const embeddingStr = `[${embedding.join(",")}]`;

  const result = await this.db.query(
    `SELECT *,
      1 - (intent_embedding <=> $1::vector) as similarity
    FROM workflow_pattern
    WHERE code_hash IS NOT NULL
      AND 1 - (intent_embedding <=> $1::vector) >= $2
    ORDER BY intent_embedding <=> $1::vector
    LIMIT $3`,
    [embeddingStr, minSimilarity, limit],
  );

  return result.map((row) => ({
    capability: this.rowToCapability(row as Row),
    similarity: row.similarity as number,
  }));
}
```

**AdaptiveThresholdManager.getThresholds** (`src/mcp/adaptive-threshold.ts:340-347`):

```typescript
getThresholds(): { explicitThreshold?: number; suggestionThreshold?: number } {
  return {
    explicitThreshold: this.currentThresholds.explicitThreshold ??
      this.config.initialExplicitThreshold,
    suggestionThreshold: this.currentThresholds.suggestionThreshold ??
      this.config.initialSuggestionThreshold,
  };
}
```

**GatewayServer tool registration pattern** (follow existing tools):

```typescript
// In listTools(), add:
{
  name: "pml:search_capabilities",
  description: "Search for existing learned capabilities matching your intent",
  inputSchema: { /* ... */ },
}

// In callTool(), add handler case
```

### References

- **CapabilityStore:** `src/capabilities/capability-store.ts`
- **AdaptiveThresholdManager:** `src/mcp/adaptive-threshold.ts`
- **GatewayServer:** `src/mcp/gateway-server.ts`
- **Types:** `src/capabilities/types.ts`
- **Previous story (7.2b):** `docs/sprint-artifacts/7-2b-schema-inference-swc.md`
- **Epics doc:** `docs/epics.md` (Story 7.3a section)

---

## Previous Story Intelligence

### From Story 7.2b (SchemaInferrer)

- **What worked:** SWC import via URL, no deno.json changes needed
- **Pattern used:** Constructor with optional dependencies for backward compat
- **Integration point:** `CapabilityStore.saveCapability()` calls `schemaInferrer.inferSchema()`
- **Testing pattern:** 19 tests covering AST traversal, type inference, edge cases

### Code from 7.2b that 7.3a can reuse:

```typescript
// CapabilityStore already handles parametersSchema storage
// Just need to return it in the match result
const capability = await store.findByCodeHash(hash);
// capability.parametersSchema is available (from 7.2b)
```

---

## Git Intelligence

### Recent Commits (last 5):

```
beaf19f chore: prepare repository for open source release
aded1c5 readme update
a14f755 adrs status refacto
c3eee2a fix(epic-7): code review fixes for story 7.2b schema inference
eeaf7ef ci: remove SSH deploy, add local deploy tasks
```

### Learnings from c3eee2a (7.2b code review):

- Schema inference integrated into CapabilityStore constructor
- Non-critical failures don't block capability save
- Tests follow `*_test.ts` naming convention in `tests/unit/capabilities/`

---

## Technical Stack (from Architecture)

- **Runtime:** Deno 2.5+ with TypeScript 5.7+
- **Database:** PGlite 0.3.11 with pgvector
- **Embeddings:** BGE-M3 (1024-dim), via `src/vector/embeddings.ts`
- **MCP:** @modelcontextprotocol/sdk, stdio transport
- **Testing:** Deno test runner, `deno task test:unit`

---

## Estimation

- **Effort:** 1-2 jours
- **LOC:** ~150-200 (matcher.ts ~100, gateway-server.ts ~40, tests ~100)
- **Risk:** Low (builds on existing CapabilityStore + AdaptiveThresholds)

---

## Dev Agent Record

### Context Reference

- `src/capabilities/capability-store.ts:251-274` - searchByIntent (base for matcher)
- `src/mcp/adaptive-threshold.ts:340-347` - getThresholds (threshold source)
- `src/mcp/adaptive-threshold.ts:247-259` - recordExecution (feedback loop)
- `src/mcp/gateway-server.ts` - Tool registration pattern
- `src/capabilities/types.ts` - Type definitions

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

(Will be filled during implementation)

### Completion Notes List

(Will be filled during implementation)

### File List

- [x] `src/capabilities/matcher.ts` - NEW (CapabilityMatcher)
- [x] `src/capabilities/types.ts` - MODIFY (add CapabilityMatch)
- [x] `src/capabilities/mod.ts` - MODIFY (export CapabilityMatcher)
- [x] `src/mcp/gateway-server.ts` - MODIFY (add search_capabilities tool)
- [x] `src/cli/commands/serve.ts` - MODIFY (wire CapabilityMatcher runtime)
- [x] `src/graphrag/dag-suggester.ts` - MODIFY (add searchCapabilities method)
- [x] `docs/adrs/ADR-038-scoring-algorithms-reference.md` - MODIFY (document algorithm)
- [x] `tests/unit/capabilities/matcher_test.ts` - NEW (unit tests, 3 passing)
