## Pattern 2: Context Budget Management

> **ADRs:** ADR-013 (Semantic Filtering)

**Problem:** Maintain <5% context consumption while supporting 15+ MCP servers dynamically.

**Solution Architecture:**

### Meta-Tools Only Exposure (ADR-013)

Instead of exposing all MCP tools (~44.5k tokens), the gateway returns only meta-tools:

```typescript
// Before ADR-013: 100+ tools exposed (44.5k tokens)
// After ADR-013: 2 meta-tools exposed (~500 tokens)

const META_TOOLS = [
  "pml:execute_workflow",  // Intent-based workflow execution
  "pml:execute_code",      // Sandbox code execution
];

// Tool discovery via intent, not enumeration
{ "tool": "pml:execute_workflow", "params": { "intent": "search the web for AI news" } }
// DAGSuggester uses vector search internally to find relevant tools
```

**Impact:**

- Context reduced from 44.5k to ~500 tokens (99% reduction)
- Forces intent-driven tool usage (better UX)
- Tool schemas loaded dynamically only when needed

### Context Budget Tracker:

```typescript
interface ContextBudget {
  totalTokens: number; // LLM context window (e.g., 200k)
  budgetTokens: number; // Allocated for tool schemas (5% = 10k)
  usedTokens: number; // Currently loaded schemas
  availableTokens: number; // Remaining budget
}

// Dynamic loading strategy
function loadTools(query: string, budget: ContextBudget): Tool[] {
  const candidates = vectorSearch(query, topK = 20);

  const selected: Tool[] = [];
  let tokens = 0;

  for (const tool of candidates) {
    const toolTokens = estimateTokens(tool.schema);
    if (tokens + toolTokens <= budget.availableTokens) {
      selected.push(tool);
      tokens += toolTokens;
    } else {
      break; // Budget exhausted
    }
  }

  return selected;
}
```

**Affects Epics:** Epic 1 (Story 1.6)

---
