# ADR-004: stdio Transport Primary, SSE Optional

**Status:** accepted **Date:** 2025-11-03 **Implementation:** done

## Decision

MCP gateway uses stdio transport as primary, SSE/HTTP as optional enhancement.

## Context

MCP (Model Context Protocol) supports multiple transports:

- stdio: Process-based, used by Claude Code
- SSE: HTTP-based Server-Sent Events
- HTTP Streamable: New HTTP-based transport

## Rationale

- MCP servers commonly use stdio (Claude Code default)
- SSE adds complexity (HTTP server required)
- Story 2.4 AC: "stdio mode primary"
- Local CLI tool doesn't need HTTP transport for MVP
- stdio is simpler to implement and debug

## Consequences

### Positive

- Simpler architecture (no HTTP server for MVP)
- Compatible with all stdio MCP servers
- Lower latency (no HTTP overhead)
- Easier debugging (simple process communication)

### Negative

- Cannot be used remotely without additional infrastructure
- Single client per server instance

## Evolution

SSE transport was later added (ADR-014) for:

- Dashboard real-time updates
- Remote deployment scenarios
- Multi-client support

HTTP Streamable transport added (ADR-025) for:

- MCP spec compliance
- Better streaming support
