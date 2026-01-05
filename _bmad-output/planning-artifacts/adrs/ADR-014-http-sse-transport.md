# ADR-014: HTTP/SSE Transport for MCP Gateway

**Status:** ✅ Implemented **Date:** 2025-11-21

## Context

The Casys PML gateway currently only supports stdio transport, which makes testing difficult:

- Each `echo | deno run` command launches a new gateway instance
- Cannot send requests to a running standalone gateway
- No way to test with curl or other HTTP tools

## Decision

Add HTTP/SSE transport as an alternative to stdio, using the `--port` option that already exists but
is not implemented.

### Endpoints

- `GET /sse` - SSE connection endpoint for MCP clients
- `POST /messages` - JSON-RPC message endpoint
- `GET /health` - Health check endpoint

### Implementation

- Use `Deno.serve()` for the HTTP server
- Use `SSEServerTransport` from `@modelcontextprotocol/sdk`
- stdio remains the default when no `--port` is specified

## Consequences

### Positive

- Can test gateway with curl
- Can keep gateway running and send multiple requests
- Enables browser-based MCP clients
- Better debugging experience

### Negative

- Additional code path to maintain
- Slightly more complex startup logic

## References

- MCP SDK SSE Transport: https://github.com/modelcontextprotocol/typescript-sdk
