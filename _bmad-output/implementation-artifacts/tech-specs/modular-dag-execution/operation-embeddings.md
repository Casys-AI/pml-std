# Operation Embeddings for SHGAT Learning

**Created:** 2025-12-27 **Status:** Implemented **Phase:** 2a - DAG Optimizer Integration

---

## Overview

This document describes how pure code operations (`code:filter`, `code:map`, etc.) are represented
as semantic embeddings for SHGAT (Symbolic Hypergraph Attention) learning.

### Problem

Prior to this implementation, pseudo-tools had **inconsistent representation** in the graph:

- **MCP tools** (`github:create_issue`, `filesystem:read`) → Had embeddings in `tool_embedding`
  table
- **Pseudo-tools** (`code:filter`, `code:map`) → **NO embeddings**, only symbolic strings

This created two issues:

1. **Inconsistent graph structure**: SHGAT couldn't use cosine similarity for code operations
2. **No semantic generalization**: `code:filter` and `code:select` couldn't be recognized as similar

### Solution

**Uniform embedding architecture**: All tools (MCP + code) now have semantic embeddings.

---

## Architecture

### Graph Structure

All operations are now **uniformly represented** as nodes with embeddings:

```
Intent (embedding)
   ↓ (sequence edge, weight)
code:filter (type="operation", embedding ✅)
   ↓ (sequence edge, weight)
code:map (type="operation", embedding ✅)
   ↓ (sequence edge, weight)
github:create_issue (type="tool", embedding ✅)
   ↓
Result
```

### Node Type Distinction (Phase 2a)

**Operations** and **Tools** are now distinct node types in the graph:

#### Operation Nodes (`type="operation"`)

Pure JavaScript operations with **no side effects**:

```typescript
{
  type: "operation",
  name: "filter",
  serverId: "code",
  category: "array",        // Semantic category
  pure: true,              // No side effects
  metadata: {
    description: "Filter array elements...",
    source: "pure_operations"
  }
}
```

**Categories**: `array`, `string`, `object`, `math`, `json`, `binary`, `logical`, `bitwise`

**Examples**: `code:filter`, `code:map`, `code:reduce`, `code:split`, `code:JSON.parse`

#### Tool Nodes (`type="tool"`)

External MCP tools with **potential side effects**:

```typescript
{
  type: "tool",
  name: "create_issue",
  serverId: "github",      // External server
  metadata: {
    schema: {...},
    permissions: ["network"]
  }
}
```

**Examples**: `github:create_issue`, `filesystem:read`, `db:query`

#### Benefits of Separation

1. **Semantic Clarity**: Clear distinction between pure code vs external I/O
2. **Filterable Queries**:
   ```typescript
   graph.getNodesByType("operation"); // Only pure operations
   graph.getNodesByType("tool"); // Only MCP tools
   graph.getNodesByCategory("array"); // Only array operations
   ```
3. **SHGAT Learning**: Different patterns for pure chains vs I/O chains
4. **Future Optimization**: Operations can be fused, tools cannot

### Embedding Generation

**Input**: Rich semantic descriptions from `operation-descriptions.ts`

**Example** (`code:filter`):

```
"Filter array elements by removing items that don't match a predicate condition.
Returns new array with only elements where callback returns true.
Common for data selection, conditional filtering, and subset extraction."
```

**Process**:

1. Load BGE-M3 model (`@huggingface/transformers`)
2. Encode description → 1024-dimensional vector
3. Store in `tool_embedding` table with metadata

**Storage** (`tool_embedding` schema):

```sql
INSERT INTO tool_embedding (
  tool_id,        -- "code:filter"
  server_id,      -- "code"
  tool_name,      -- "filter"
  embedding,      -- vector(1024)
  metadata        -- {"description": "...", "category": "array"}
)
```

---

## SHGAT Message Passing

With embeddings, SHGAT now uses **two complementary signals**:

### 1. Topological Structure (Graph Edges)

Learns **co-occurrence patterns**:

```
code:filter → code:map  (weight: 0.8, observed 20 times)
code:map → code:reduce  (weight: 0.9, observed 30 times)
```

### 2. Semantic Similarity (Node Embeddings)

Learns **operation semantics**:

```python
similarity("code:filter", "code:find") = 0.87  # Both are selection
similarity("code:map", "code:flatMap") = 0.92  # Both are transformation
similarity("code:filter", "code:add") = 0.23   # Different purposes
```

### Combined Learning

```
User intent: "select active users and get their names"

SHGAT reasoning:
1. Topological: "filter → map" is a common pattern (high edge weight)
2. Semantic: "select" ≈ "filter" (high embedding similarity)
3. Prediction: Use code:filter → code:map with high confidence
```

---

## Implementation Details

### Files

| File                                             | Purpose                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `src/capabilities/operation-descriptions.ts`     | Semantic descriptions (62 operations) + `getOperationCategory()` helper |
| `scripts/seed-operation-embeddings.ts`           | Generate and insert embeddings                                          |
| `src/capabilities/pure-operations.ts`            | List of pure operations                                                 |
| `src/graphrag/types.ts`                          | TypeScript types for `OperationNode` vs `ToolNode`                      |
| `src/graphrag/dag/execution-learning.ts`         | Creates nodes with `type="operation"` for code operations               |
| `src/graphrag/sync/db-sync.ts`                   | Loads nodes from DB with correct type distinction                       |
| `tests/unit/graphrag/execution-learning.test.ts` | Unit tests for operation vs tool distinction                            |

### Semantic Descriptions

Each operation has:

```typescript
{
  toolId: "code:filter",
  name: "filter",
  description: "Filter array elements by removing items...",  // Rich description
  category: "array"  // For grouping (array, string, object, math, etc.)
}
```

**Description principles**:

- **What** the operation does (transformation, filtering, aggregation)
- **How** it works (element-wise, conditional, accumulative)
- **Purpose** (common use cases)

### Seeding Process

```bash
# Generate embeddings for all 62 pure operations
deno run --allow-all scripts/seed-operation-embeddings.ts
```

**Output**:

```
🌱 Seeding operation embeddings for SHGAT learning
🤖 Loading BGE-M3 embedding model...
📝 Processing 62 code operations...
  ✓ Inserted code:filter
  ✓ Inserted code:map
  ...
📊 Seeding Summary:
  ✅ Inserted: 62
  📈 Total code operations in DB: 62
✅ Operation embeddings seeded successfully!
```

### Node Type Implementation

**Phase 2a**: All graph nodes are now created with `type="operation"` for code operations:

#### Execution Learning (`execution-learning.ts`)

When learning from task execution:

```typescript
// Detect if tool is a code operation
const isOperation = isCodeOperation(task.tool);
const nodeType = isOperation ? "operation" : "tool";

const attributes: Record<string, unknown> = {
  type: nodeType,
  name: task.tool,
};

// Add operation-specific attributes
if (isOperation) {
  const category = getOperationCategory(task.tool);
  attributes.serverId = "code";
  attributes.category = category || "unknown";
  attributes.pure = isPureOperation(task.tool);
}

graph.addNode(task.tool, attributes);
```

#### Database Sync (`db-sync.ts`)

When loading from `tool_embedding` table:

```typescript
// Apply same logic when loading from DB
for (const tool of tools) {
  const toolId = tool.tool_id as string;
  const isOperation = isCodeOperation(toolId);

  const attributes = {
    type: isOperation ? "operation" : "tool",
    name: tool.tool_name,
    serverId: tool.server_id,
    // ... operation-specific attributes if isOperation
  };

  graph.addNode(toolId, attributes);
}
```

**Result**: All code operations (`code:*`) are consistently represented as `type="operation"`
throughout the system.

---

## Benefits

### 1. Semantic Generalization

SHGAT can now recognize similar operations:

```typescript
// Without embeddings:
similarity("code:filter", "code:select") = 0.0  // ❌ No match (different symbols)

// With embeddings:
similarity("code:filter", "code:select") = 0.85  // ✅ High similarity (same semantics)
```

### 2. Cross-Domain Transfer

SHGAT can transfer patterns across operation categories:

```
Learned pattern: "filter → map → reduce" (array operations)
Transfer to: "split → replace → join" (string operations)
Reason: Similar structure (select → transform → aggregate)
```

### 3. Novel Operation Handling

When encountering new operations, SHGAT can use similarity:

```
New operation: "code:findLast" (not in training data)
Nearest neighbors:
  - code:find (similarity: 0.95)
  - code:lastIndexOf (similarity: 0.82)
Inference: Likely a selection operation, use similar patterns
```

---

## Impact on DAG Optimizer (Phase 2a)

With operation embeddings, the DAG Optimizer now generates **semantically-enriched traces**:

### Before (Symbols Only)

```typescript
executedPath: ["code:filter", "code:map", "code:reduce"];
// SHGAT learns: Exact symbolic pattern
// No generalization to similar operations
```

### After (Symbols + Embeddings)

```typescript
executedPath: ["code:filter", "code:map", "code:reduce"];
// SHGAT learns:
// 1. Symbolic pattern (exact match)
// 2. Semantic pattern (selection → transformation → aggregation)
// 3. Can generalize to: ["code:find", "code:flatMap", "code:join"]
```

---

## Future Enhancements

### Phase 2b+: Context-Aware Embeddings

Generate embeddings that include **usage context**:

```typescript
// Current (operation-level)
embedding("code:filter") = encode("Filter array elements...")

// Future (context-aware)
embedding("code:filter", context={intent: "find active users"}) =
  encode("Filter array to select active users based on predicate")
```

### Phase 3: Multi-Modal Embeddings

Combine **code structure + semantics**:

```typescript
// Text embedding (current)
text_emb = encode("Filter array elements...");

// Code structure embedding (future)
struct_emb = encode_ast(parse("arr.filter(x => x.active)"));

// Combined
operation_emb = concat(text_emb, struct_emb);
```

---

## Testing

### Similarity Verification

```typescript
// Run seed script with similarity test
deno run --allow-all scripts/seed-operation-embeddings.ts

// Output:
🔍 Testing semantic similarity...
  Similarity(filter, find) = 0.8723
  Expected: High similarity (both are selection operations)
```

### SHGAT Integration

```typescript
// Verify SHGAT can query embeddings
const result = await graphEngine.searchToolsHybrid("select items", {
  limit: 5,
  alpha: 0.5
});

// Should return:
[
  { toolId: "code:filter", similarity: 0.92 },  // ✅ High similarity
  { toolId: "code:find", similarity: 0.87 },    // ✅ High similarity
  { toolId: "code:some", similarity: 0.81 },    // ✅ Related
  ...
]
```

---

## Maintenance

### Adding New Operations

1. **Add description** to `operation-descriptions.ts`:

```typescript
{
  toolId: "code:newOp",
  name: "newOp",
  description: "Rich semantic description...",
  category: "array"
}
```

2. **Re-run seeding**:

```bash
deno run --allow-all scripts/seed-operation-embeddings.ts
```

3. **Verify**:

```sql
SELECT tool_id, tool_name FROM tool_embedding WHERE tool_id = 'code:newOp';
```

---

## References

- **Phase 1**: Pseudo-tools creation (`static-structure-builder.ts`)
- **Phase 2a**: DAG Optimizer + Logical traces (`dag-optimizer.ts`, `trace-generator.ts`)
- **SHGAT Architecture**: K-head Adaptive Attention, cosine similarity for tools
- **Embedding Model**: BGE-M3 (1024 dimensions)
