# Spike: Smithery MCP Connection Investigation

**Date:** 2026-01-04
**Status:** In Progress
**Related:** workflow-patterns, tool-mapper, MCP discovery

## Context

Smithery connections are often failing or unreliable. Need to investigate:
1. Why connections fail
2. How to reliably fetch server/tool lists for mapping
3. Integration with workflow-patterns tool mapper

## Current Implementation

### Files
- `src/mcp/smithery-client.ts` - HTTP Streamable transport client
- `src/mcp/smithery-loader.ts` - Registry API loader

### Flow
```
SmitheryLoader.loadServers(apiKey)
  → GET https://registry.smithery.ai/servers
  → Filter remote=true servers
  → Create MCPServer configs

SmitheryMCPClient.connect()
  → createSmitheryUrl(serverUrl, {config, apiKey})
  → StreamableHTTPClientTransport(url)
  → client.connect(transport)
```

## Potential Issues

### 1. Registry API Returns ALL Servers
The current `loadServers()` calls `/servers` without filters, which returns 3400+ servers.

**Fix:** Use `q=is:deployed` or specific server names

### 2. Cold Start Latency
Smithery servers may need cold start time (30s default timeout might not be enough).

### 3. Server-Specific Config
Some servers require OAuth or API keys that aren't provided.

### 4. Transport Issues
StreamableHTTPClientTransport may have compatibility issues with certain servers.

## Investigation Plan

### Test 1: Registry API Direct
```bash
curl -H "Authorization: Bearer $SMITHERY_API_KEY" \
  "https://registry.smithery.ai/servers?q=is:deployed&pageSize=10"
```

### Test 2: Specific Server Connection
Test connection to a known-good server:
```typescript
const client = new SmitheryMCPClient({
  id: "smithery:@anthropic/filesystem",
  name: "Filesystem",
  url: "https://server.smithery.ai/@anthropic/filesystem",
}, { apiKey: SMITHERY_API_KEY });
await client.connect();
const tools = await client.listTools();
```

### Test 3: Tool Listing Without Connection
For mapping purposes, we might only need tool schemas from registry, not live connections.

## Proposed Solutions

### Option A: Use Registry Metadata Only
For tool mapping, fetch tool definitions from registry without connecting:
- `GET /servers/{qualifiedName}` might return tool schemas
- Or use `GET /servers?q=name` with semantic search

### Option B: Cached Tool Index
Build a static index of common MCP servers and their tools:
```json
{
  "@anthropic/filesystem": ["read_file", "write_file", "list_directory"],
  "@anthropic/memory": ["create_entities", "search_nodes"],
  "@anthropic/playwright": ["browser_navigate", "browser_click"]
}
```

### Option C: Fix Connection Issues
1. Increase timeout to 60s
2. Add retry logic with backoff
3. Better error categorization (auth vs timeout vs server error)

## Questions to Answer

1. Does the registry API return tool schemas without connecting?
2. What's the cold start time for typical Smithery servers?
3. Which servers are most commonly used and should be prioritized for mapping?
4. Can we use the `@smithery/sdk` directly for better compatibility?

## Next Steps

1. [ ] Test registry API endpoints to understand available data
2. [ ] Identify top 20 most used Smithery servers
3. [ ] Build static mapping for common servers
4. [ ] Improve connection reliability for dynamic discovery
