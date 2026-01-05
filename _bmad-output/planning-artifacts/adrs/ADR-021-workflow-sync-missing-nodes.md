# ADR-021: Workflow Sync Missing Node Creation

**Status:** ✅ Implemented **Date:** 2025-12-01

## Context

During Story 6.2 (Interactive Graph Visualization Dashboard) testing, we discovered that the
workflow sync command (`deno task cli workflows sync`) creates edges in `tool_dependency` table but
does NOT create corresponding node entries in `tool_embedding` table.

## Problem Analysis

### Root Cause

`GraphRAGEngine.syncFromDatabase()` loads the graph in two steps:

1. Load nodes from `tool_embedding` table
2. Load edges from `tool_dependency` table (only if both nodes exist)

The workflow sync (`WorkflowSyncService.upsertEdges()`) only writes to `tool_dependency`, resulting
in:

- 0 nodes loaded (empty `tool_embedding`)
- 0 edges loaded (nodes don't exist, so edges are skipped)
- Empty graph in dashboard

### Evidence

```
# Sync reports success
[WorkflowSync] Sync complete: 0 created, 13 updated, 3 workflows

# But graph is empty
curl http://localhost:3001/api/graph/snapshot
{"nodes":[],"edges":[],"metadata":{"total_nodes":0,"total_edges":0}}
```

### Deeper Issue Discovered

The original ADR proposed a simple fix (insert minimal rows into `tool_embedding`), but this was
insufficient because:

1. **`tool_embedding.embedding` is NOT NULL** - requires a real 1024-dimensional vector
2. **Zero vectors don't work for semantic search** - breaks the VectorSearch functionality
3. **`tool_schema` must be populated first** - embeddings are generated from schema text

### Data Flow Dependencies

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  MCP Servers    │───▶│  tool_schema    │───▶│ tool_embedding  │
│  (discovery)    │    │  (name, desc,   │    │  (+ embedding   │
│                 │    │   input_schema) │    │   vector 1024D) │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        │                      │                      │
        │                      ▼                      │
        │               schemaToText()                │
        │                      │                      │
        │                      ▼                      │
        │               EmbeddingModel                │
        │                 .encode()                   │
        │                      │                      │
        │                      ▼                      │
        └──────────────────────┴──────────────────────┘
                               │
                               ▼
                        tool_dependency
                        (workflow edges)
```

## Solution Implemented

### 1. Strict Tool Validation (WorkflowLoader)

Changed unknown tool handling from WARNING to ERROR:

```typescript
// workflow-loader.ts - validateSteps() and validateEdges()
// Before: warnings.push(`Unknown tool ID '${step}'...`);
// After:
errors.push(
  `Unknown tool ID '${step}' in workflow '${workflow.name}'. Tool must exist in tool_schema.`,
);
```

### 2. Load Known Tools Before Validation (WorkflowSyncService)

Added `loadKnownTools()` and integrated into sync flow:

```typescript
// workflow-sync.ts
private async loadKnownTools(): Promise<string[]> {
  const result = await this.db.query(
    `SELECT tool_id FROM tool_schema ORDER BY tool_id`
  );
  return result.map((row) => row.tool_id as string);
}

async sync(yamlPath: string, force: boolean = false): Promise<SyncResult> {
  // 1. Check if sync needed...

  // 2. Load known tools from tool_schema for strict validation
  const knownTools = await this.loadKnownTools();
  if (knownTools.length === 0) {
    return { success: false, error: "No tools in tool_schema..." };
  }
  this.loader.setKnownTools(knownTools);  // Enable strict validation

  // 3. Load and validate workflows...
}
```

### 3. Generate Real Embeddings (WorkflowSyncService)

Added `ensureEmbeddingsExist()` to generate embeddings from `tool_schema`:

```typescript
private async ensureEmbeddingsExist(edges: WorkflowEdge[]): Promise<number> {
  // 1. Collect unique tool IDs from edges
  // 2. Check which are missing from tool_embedding
  // 3. For each missing tool:
  //    a. Fetch schema from tool_schema
  //    b. Generate text via schemaToText()
  //    c. Generate embedding via EmbeddingModel.encode()
  //    d. Insert into tool_embedding
}
```

### 4. Fix Bootstrap Detection (WorkflowSyncService)

Fixed `isGraphEmpty()` to check the correct table:

```typescript
// Before: checked tool_dependency (edges) - WRONG
// Old edges existed, so bootstrap was skipped even with 0 nodes

// After: checks tool_embedding (nodes) - CORRECT
async isGraphEmpty(): Promise<boolean> {
  const result = await this.db.queryOne(
    `SELECT COUNT(*) as count FROM tool_embedding`  // Was: tool_dependency
  );
  return (result?.count as number) === 0;
}
```

This ensures bootstrap runs when nodes are missing, not just when edges are missing.

## Affected Files

### Modified

- `src/graphrag/workflow-sync.ts`
  - Added `loadKnownTools()` method
  - Added `ensureEmbeddingsExist()` method (replaces `ensureToolsExist()`)
  - Fixed `isGraphEmpty()` to check `tool_embedding` instead of `tool_dependency`
  - Updated `sync()` to validate tools before processing
  - Imports `EmbeddingModel` and `schemaToText` from vector/embeddings

- `src/graphrag/workflow-loader.ts`
  - Changed `validateSteps()`: unknown tools → error (was warning)
  - Changed `validateEdges()`: unknown tools → error (was warning)

- `src/cli/commands/serve.ts`
  - Moved `bootstrapIfEmpty()` after MCP connection and embedding model load
  - Ensures `tool_schema` is populated before workflow validation

### Unchanged (reference only)

- `src/graphrag/graph-engine.ts:92` - `syncFromDatabase()` expects nodes in `tool_embedding`
- `src/vector/embeddings.ts` - Provides `EmbeddingModel` and `schemaToText`
- `src/mcp/schema-extractor.ts` - Populates `tool_schema` during init

## Usage Requirements

### Prerequisites

Before running workflow sync, ensure:

1. MCP servers are configured in `pml.json`
2. Run `pml init` to discover tools and populate `tool_schema`
3. Workflow templates reference valid tool IDs

### Command Flow

```bash
# 1. Initialize (populates tool_schema)
pml init

# 2. Sync workflows (validates tools, generates embeddings, creates edges)
pml workflows sync --file playground/config/workflow-templates.yaml

# 3. Start server (graph will load correctly)
pml serve
```

### Error Messages

If tools are missing from `tool_schema`:

```
[WorkflowSync] No tools found in tool_schema. Run 'pml serve' first to discover tools.
```

If workflow references unknown tool:

```
Unknown tool ID 'filesystem:read_file' in workflow 'my_workflow'. Tool must exist in tool_schema.
```

## Order of Operations (Fixed)

The bootstrap order in `serve.ts` has been corrected:

```typescript
// serve.ts - Corrected order
Step 2/6: Database init + migrations
↓
Step 3/6: Connect to MCP servers (tool_schema populated)
↓
Step 4/6: Load AI models (embedding model ready)
↓
Bootstrap workflow ← Now called here, after dependencies are ready
↓
graphEngine.syncFromDatabase() ← Graph loads correctly
```

### Modified File

- `src/cli/commands/serve.ts` - Moved `bootstrapIfEmpty()` after MCP connection and embedding model
  load

## Related

- Story 5.2: Workflow Templates Sync Service
- Story 6.2: Interactive Graph Visualization Dashboard
- `setKnownTools()` mechanism in WorkflowLoader (was unused, now activated)
