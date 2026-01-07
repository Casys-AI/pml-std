# Spike: Dynamic Tool Injection in MCP

**Date:** 2025-01-06
**Status:** ❌ BLOCKED - Claude Code doesn't support it yet
**Epic:** 14 (JSR Package + Local/Cloud MCP Routing)

## Question

Can PML dynamically inject tools into Claude's tool registry DURING a conversation (not just at startup)?

## Context

Currently, `tools/list` is called once at MCP server startup. Claude sees a static list.

**Desired behavior:**
- User asks "search for X in my notes"
- PML detects `smartSearch` capability would help
- PML injects `smartSearch:run` into Claude's available tools
- Claude can now use it directly

## MCP Protocol Support ✅

The MCP spec includes `notifications/tools/list_changed`:

```typescript
// Server declares capability
{ "tools": { "listChanged": true } }

// Server sends notification to client
{
  "jsonrpc": "2.0",
  "method": "notifications/tools/list_changed"
}

// Client SHOULD then call tools/list again
// Server returns updated tool list
```

**Reference:** https://spec.modelcontextprotocol.io/specification/server/tools/

## Investigation Results (2025-01-06)

### Client Support Status

| Client | `tools/list_changed` Support |
|--------|------------------------------|
| VSCode MCP Extension | ✅ Supported |
| Cursor | ✅ Supported |
| Claude Desktop | ❌ Not supported |
| **Claude Code** | ❌ **Not supported** |

### Claude Code Issue Tracking

- **Issue:** [#4118 - Capture MCP Tools Changed notifications](https://github.com/anthropics/claude-code/issues/4118)
- **Status:** Open (49 👍 reactions)
- **Assigned:** `ollie-anthropic`
- **ETA:** None provided
- **Created:** July 2025

### Current Workarounds

1. **Restart Claude Code** - forces full re-scan of MCP servers
2. **`/mcp` reconnect** - manually refresh MCP connection
3. **`claude mcp remove/add`** - CLI reconnection

### Community Feedback (from issue)

> "VSCode and Cursor already support this. It's frustrating that Anthropic's own client doesn't implement basic MCP spec features." - @bowlofarugula

> "This would be a huge quality-of-life improvement" - @coygeek

## Impact on PML Architecture

### Mode C (Hybrid) is BLOCKED

Mode C requires dynamic tool injection to work without restart:
```
Claude sees (dynamic, no restart needed):  ← NOT POSSIBLE YET
├── pml:discover
├── pml:execute
├── pml:smartSearch   ← Can't add dynamically
```

### Available Options

| Option | Description | Status |
|--------|-------------|--------|
| **Wait** | Monitor issue #4118 for Claude Code support | Passive |
| **Mode A/B only** | Ship without Mode C, add later | Safe |
| **Contribute** | Submit PR to Claude Code | High effort |
| **Curated at startup** | Pre-load top N tools at init | Workaround |

### Recommended Approach

1. **Ship Mode A + B now** (Epic 14 Stories 14.1-14.10)
2. **Implement server-side `listChanged` capability** (future-proof)
3. **Monitor #4118** for Claude Code support
4. **When supported:** Enable Mode C with config flag

## Future-Proof Implementation

Even though Claude Code ignores it, PML should send the notification:

```typescript
// In stdio-command.ts
function notifyToolsListChanged(): void {
  sendResponse({
    jsonrpc: "2.0",
    method: "notifications/tools/list_changed"
  });
}

// When curated list changes, call:
notifyToolsListChanged();
// Claude Code will ignore it now, but will work when #4118 is fixed
```

## Related

- Story 14.10: Standalone Capability Distribution
- Epic 14: PML architecture
- [MCP Discussion #76](https://github.com/orgs/modelcontextprotocol/discussions/76)

## Sources

- [Issue #4118 - MCP Tools Changed notifications](https://github.com/anthropics/claude-code/issues/4118)
- [Issue #4094 - prompts/list_changed support](https://github.com/anthropics/claude-code/issues/4094)
- [MCP Discussion #76 - Using notifications/tools/list_changed](https://github.com/orgs/modelcontextprotocol/discussions/76)
