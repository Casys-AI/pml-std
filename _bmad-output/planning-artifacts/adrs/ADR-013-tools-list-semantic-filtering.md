# ADR-013: Tools/List Semantic Filtering for Context Optimization

**Status:** ✅ Implemented **Date:** 2025-11-21

## Context

Casys PML was designed to optimize LLM context usage by providing semantic tool discovery instead of
exposing all MCP tools. However, the current implementation of `tools/list` returns **ALL tools**
from underlying MCP servers (~44.5k tokens, 22% of context).

### Current Behavior

```
Claude Code → Casys PML Gateway → tools/list → Returns 100+ tools (44.5k tokens)
```

### Expected Behavior (per PRD/concepts docs)

```
Claude Code → Casys PML Gateway → tools/list → Returns ~5 relevant tools (2% context)
```

### Evidence from Documentation

From `docs/concepts/mcp-gateway-concepts.md`:

> "Rather than exposing hundreds of individual tools [...] Casys PML exposes a small, fixed set of
> meta-tools that provide intelligent access to the entire ecosystem"

From `docs/prd.md`:

> "Context optimization through semantic tool discovery"

## Problem

The gateway currently acts as a **transparent proxy**, exposing all underlying tools. This defeats
the core value proposition of Casys PML:

- 44.5k tokens consumed just for tool definitions
- No semantic filtering applied
- LLM must process all tool schemas even when irrelevant

## Decision Drivers

1. **Context efficiency**: Primary goal - minimize token usage
2. **Tool discoverability**: LLM must still find relevant tools
3. **Backward compatibility**: Existing workflows should not break
4. **Simplicity**: Avoid over-engineering

## Options Considered

### Option A: Meta-Tools Only (Recommended)

Expose only Casys PML meta-tools:

- `cai_execute_workflow` - Intent-based tool orchestration
- `pml_execute_code` - Sandbox code execution
- `exa_get_code_context_exa` - Code search (high-value)
- `exa_web_search_exa` - Web search (high-value)

**Pros**: Minimal context (~2k tokens), forces intent-based usage **Cons**: Requires workflow engine
for tool access

### Option B: Semantic Query Parameter

Add optional `query` param to `tools/list`:

```json
{ "method": "tools/list", "params": { "query": "search the web" } }
```

Returns only semantically relevant tools.

**Pros**: Dynamic filtering, backward compatible **Cons**: Non-standard MCP extension, complex
implementation

### Option C: Configurable Mode

Add gateway config for exposure mode:

```yaml
gateway:
  tools_exposure: "meta_only" | "semantic" | "full_proxy"
```

**Pros**: Flexible, supports multiple use cases **Cons**: Configuration complexity

## Decision

**Option A: Meta-Tools Only** with semantic discovery via `execute_workflow`.

### Implementation

1. `tools/list` returns only 2 meta-tools:
   - `pml:execute_workflow` - Intent-based workflow execution
   - `pml:execute_code` - Sandbox code execution

2. Tool discovery happens via intent:
   ```json
   { "tool": "pml:execute_workflow", "params": { "intent": "search the web for AI news" } }
   ```

3. DAGSuggester uses vector search (Story 1.5) to find relevant underlying tools internally.

4. **Implemented**: `gateway-server.ts:handleListTools()` modified to return only meta-tools.

## Consequences

### Positive

- Context reduced from 44.5k to ~500 tokens (99% reduction)
- Forces intent-driven tool usage (better UX)
- Aligns with original PRD design

### Negative

- Direct tool access requires workflow wrapper
- Learning curve for users expecting all tools visible

### Risks

- Users may expect transparent proxy behavior
- Need clear documentation on intent-based usage

## Implementation Plan

1. ✅ Modify `gateway-server.ts` `handleListTools()` to return only meta-tools
2. TODO: Update README with intent-based usage examples

## Impact on Story 3.7 (Cache Invalidation)

Story 3.7 implemented cache invalidation based on tool schema changes.

**Before ADR-013**: `loadAllTools()` was called on `tools/list`, which populated `toolSchemaCache`
with all tool schemas.

**After ADR-013**: `tools/list` no longer loads all tools. Cache tracking now happens at tool
execution time:

1. `createToolExecutor()` in `serve.ts` accepts an `onToolCall` callback
2. Callback fires on each tool execution, calling `gateway.trackToolUsage(toolKey)`
3. `trackToolUsage()` queries the DB for the tool's schema and tracks changes
4. Schema changes are detected via hash comparison → cache invalidation

**Status**: ✅ Adapted - tracking now happens on tool execution instead of tool listing.

## References

- PRD: `docs/prd.md`
- Concepts: `docs/concepts/mcp-gateway-concepts.md`
- Gateway: `src/mcp/gateway-server.ts:676`
