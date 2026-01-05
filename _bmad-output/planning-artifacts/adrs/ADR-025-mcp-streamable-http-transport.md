# ADR-025: MCP Streamable HTTP Transport

**Status:** ✅ Implemented **Date:** 2025-12-02 | **Story:** 6.3 (Infrastructure)

## Context

Claude Code supports HTTP transport for MCP servers, allowing a single server instance to serve
both:

1. The web dashboard (graph visualization, metrics)
2. Claude Code MCP client

Previously, using MCP with Claude Code required stdio transport, which spawned a separate process
with its own database - causing data inconsistency with the dashboard.

## Decision

Implement MCP Streamable HTTP transport at `/mcp` endpoint to allow Claude Code to connect via HTTP
to the same server instance running the dashboard.

### Implementation

**Endpoint:** `GET/POST /mcp`

**Spec:**
[MCP Streamable HTTP Transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)

**Methods supported:**

- `initialize` - MCP handshake, returns server capabilities
- `notifications/initialized` - Client acknowledgment
- `tools/list` - List available tools (existing)
- `tools/call` - Execute tool (existing)

**POST (Client → Server):**

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": { "listChanged": true } },
    "serverInfo": { "name": "pml", "version": "1.0.0" }
  }
}
```

**GET (Server → Client SSE):**

- Returns SSE stream for server-initiated messages
- Reuses existing `/events/stream` infrastructure

## Configuration

Claude Code `.mcp.json`:

```json
{
  "mcpServers": {
    "pml": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

## Consequences

### Positive

- Single server instance for dashboard + MCP
- Shared database and in-memory graph state
- Real-time dashboard reflects MCP activity
- Metrics time-series populated by MCP workflow executions

### Negative

- Requires server to be running before Claude Code connects
- No automatic lifecycle management (unlike stdio)

### Neutral

- Existing stdio transport still works for standalone MCP usage

## Files Changed

- `src/mcp/gateway-server.ts` - Added `/mcp` endpoint and `initialize` handler
- `.mcp.json` - Updated to use HTTP transport

## Related

- [MCP Streamable HTTP Spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- ADR-014: HTTP/SSE Transport (original SSE implementation)
- Story 6.3: Live Metrics & Analytics Panel
