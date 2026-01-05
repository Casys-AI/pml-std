# Integration Test Plan: MCP Gateway Server

**Document Type:** Test Plan **Status:** Draft **Created:** 2025-12-16 **Target:** MCP Gateway
Server (HTTP Transport) **Test Suite Location:** `tests/integration/mcp-gateway/`

## Executive Summary

This document outlines a comprehensive integration test strategy for the MCP Gateway Server's HTTP
transport functionality following its modular refactoring. The test plan covers all API endpoints,
authentication flows, rate limiting, CORS handling, JSON-RPC protocol compliance, and SSE event
streaming.

## Scope

### In Scope

- HTTP server lifecycle (startup/shutdown)
- Authentication and authorization
- Rate limiting behavior
- CORS preflight and header handling
- All REST API endpoints (`/api/*`, `/health`, `/events/stream`, `/dashboard`)
- JSON-RPC protocol endpoints (`/mcp`, `/message`)
- SSE event streaming
- Error handling and edge cases
- Multi-client scenarios

### Out of Scope

- Stdio transport testing (covered by existing E2E tests)
- Unit tests for individual handlers (separate test suite)
- Performance/load testing (separate test suite)
- Database layer testing (separate test suite)
- MCP client connection testing (separate test suite)

## Architecture Overview

### Gateway Server Components

```
PMLGatewayServer
├── HTTP Server (Deno.serve)
├── Authentication Layer (validateRequest)
├── Rate Limiters (MCP: 100/min, API: 200/min)
├── CORS Middleware (getAllowedOrigin, buildCorsHeaders)
├── Routing Layer (routeRequest)
│   ├── /health (public)
│   ├── /events/stream (SSE)
│   ├── /dashboard (redirect)
│   ├── /api/graph/* (4 endpoints)
│   ├── /api/capabilities/* (4 endpoints)
│   ├── /api/metrics (1 endpoint)
│   ├── /api/tools/search (1 endpoint)
│   ├── /mcp (JSON-RPC POST, SSE GET)
│   └── /message (JSON-RPC legacy)
├── JSON-RPC Handler (handleJsonRpcRequest)
└── Events Stream Manager (EventsStreamManager)
```

### Key Configuration

- **Ports:** 3003 (HTTP), 8081 (Dashboard fallback)
- **Auth Modes:** Local (bypass) vs Cloud (API Key required)
- **Rate Limits:** MCP (100 req/60s), API (200 req/60s)
- **CORS:** Dynamic based on DOMAIN env or localhost:8081
- **SSE:** Max 100 clients, 30s heartbeat

---

## Test Categories

## 1. Server Lifecycle Tests

### 1.1 HTTP Server Startup

**Test ID:** `LIFECYCLE-001` **Priority:** CRITICAL **Description:** Verify HTTP server starts
successfully and binds to port

**Preconditions:**

- Port 3003 is available
- All dependencies initialized (db, vectorSearch, graphEngine, etc.)

**Test Steps:**

1. Initialize test database and dependencies
2. Create PMLGatewayServer instance
3. Call `startHttp(3003)`
4. Verify server is listening on port 3003
5. Make GET request to `/health`
6. Verify 200 OK response

**Expected Results:**

- Server starts without errors
- Health check returns `{"status": "ok"}`
- Logs show: "✓ Casys PML MCP gateway started (HTTP mode on port 3003)"

**Edge Cases:**

- Port already in use (should throw error)
- Missing required dependencies (should throw error)
- EventsStreamManager initialization failure

---

### 1.2 HTTP Server Shutdown

**Test ID:** `LIFECYCLE-002` **Priority:** CRITICAL **Description:** Verify graceful shutdown closes
all connections

**Test Steps:**

1. Start HTTP server
2. Create active SSE connection to `/events/stream`
3. Make in-flight request to `/api/graph/snapshot`
4. Call `stop()`
5. Verify server stops accepting new connections
6. Verify active SSE connections are closed
7. Verify in-flight requests complete or abort gracefully

**Expected Results:**

- All MCP client connections closed
- SSE streams terminated
- HTTP server shutdown completes
- Logs show: "✓ Gateway stopped"

**Edge Cases:**

- Multiple concurrent SSE clients
- Shutdown during active workflow execution
- Shutdown during checkpoint save operation

---

### 1.3 Multiple Start/Stop Cycles

**Test ID:** `LIFECYCLE-003` **Priority:** HIGH **Description:** Verify server can be restarted
without resource leaks

**Test Steps:**

1. Start server, make 10 requests, stop server
2. Repeat 5 times
3. Verify no memory leaks (check event listener count)
4. Verify no port binding errors

**Expected Results:**

- All cycles complete successfully
- No increase in memory/resource usage
- Clean restart each time

---

## 2. Authentication and Authorization Tests

### 2.1 Local Mode - Auth Bypass

**Test ID:** `AUTH-001` **Priority:** CRITICAL **Description:** In local mode, all requests should
bypass authentication

**Preconditions:**

- `GITHUB_CLIENT_ID` environment variable is NOT set

**Test Steps:**

1. Make GET request to `/api/graph/snapshot` without API key header
2. Make POST request to `/mcp` without API key header
3. Make GET request to `/events/stream` without API key header

**Expected Results:**

- All requests succeed with 200 status
- User ID defaults to "local"
- No 401 Unauthorized responses

**Edge Cases:**

- Request with invalid API key header (should still succeed in local mode)
- Request with valid API key header (should still succeed, but key ignored)

---

### 2.2 Cloud Mode - API Key Required

**Test ID:** `AUTH-002` **Priority:** CRITICAL **Description:** In cloud mode, protected routes
require valid API key

**Preconditions:**

- `GITHUB_CLIENT_ID=test_client_id` environment variable is set

**Test Steps:**

1. Make GET request to `/api/graph/snapshot` without API key
2. Make POST request to `/mcp` without API key
3. Verify both return 401 Unauthorized

**Expected Results:**

```json
{
  "error": "Unauthorized",
  "message": "Valid API key required"
}
```

- Status: 401
- Content-Type: application/json
- CORS headers present

---

### 2.3 Cloud Mode - Valid API Key

**Test ID:** `AUTH-003` **Priority:** CRITICAL **Description:** Valid API key grants access to
protected routes

**Preconditions:**

- Cloud mode enabled
- Valid API key `ac_123456789012345678901234` exists in database

**Test Steps:**

1. Make GET request to `/api/graph/snapshot` with header `x-api-key: ac_123456789012345678901234`
2. Verify request succeeds (200 or 503 if dependencies unavailable)

**Expected Results:**

- Request authorized successfully
- User ID extracted from database
- Request processed normally

---

### 2.4 Cloud Mode - Invalid API Key Format

**Test ID:** `AUTH-004` **Priority:** HIGH **Description:** Malformed API keys should be rejected

**Test Vectors:**

```typescript
[
  { key: "invalid_key", reason: "wrong prefix" },
  { key: "ac_short", reason: "too short" },
  { key: "xx_123456789012345678901234", reason: "wrong prefix" },
  { key: "ac_12345678901234567890123456789", reason: "too long" },
  { key: "", reason: "empty string" },
  { key: "Bearer ac_123456789012345678901234", reason: "bearer format" },
];
```

**Expected Results:**

- All requests return 401 Unauthorized
- No database queries executed (fail fast on format validation)

---

### 2.5 Public Routes - No Auth Required

**Test ID:** `AUTH-005` **Priority:** HIGH **Description:** Public routes accessible without
authentication in cloud mode

**Preconditions:**

- Cloud mode enabled (GITHUB_CLIENT_ID set)

**Test Steps:**

1. Make GET request to `/health` without API key
2. Verify 200 OK response

**Expected Results:**

- `/health` returns `{"status": "ok"}`
- No authentication required
- CORS headers present

**Public Routes List:**

- `/health`

---

## 3. Rate Limiting Tests

### 3.1 MCP Endpoint Rate Limit

**Test ID:** `RATE-001` **Priority:** HIGH **Description:** MCP endpoint enforces 100 requests per
minute

**Preconditions:**

- Cloud mode with valid API key (to test rate limiting per user)

**Test Steps:**

1. Make 100 POST requests to `/mcp` with same API key
2. Verify all 100 succeed
3. Make 101st request
4. Verify 429 Rate Limit Exceeded

**Expected Results:**

```json
{
  "error": "Rate limit exceeded",
  "message": "Too many requests. Please try again later.",
  "retryAfter": 60
}
```

- Status: 429
- Header: `Retry-After: 60`
- CORS headers present

---

### 3.2 API Endpoint Rate Limit

**Test ID:** `RATE-002` **Priority:** HIGH **Description:** API endpoints enforce 200 requests per
minute

**Test Steps:**

1. Make 200 GET requests to `/api/graph/snapshot` with same API key
2. Verify all 200 succeed
3. Make 201st request
4. Verify 429 Rate Limit Exceeded

**Expected Results:**

- Same format as RATE-001

---

### 3.3 Rate Limit Key Isolation

**Test ID:** `RATE-003` **Priority:** MEDIUM **Description:** Rate limits are per-user (different
API keys have separate limits)

**Test Steps:**

1. Make 100 requests with API key A to `/mcp`
2. Make 100 requests with API key B to `/mcp`
3. Verify both succeed (each has own rate limit counter)
4. Make 101st request with API key A
5. Verify only API key A gets 429

**Expected Results:**

- API key B still has capacity
- Rate limits isolated by user_id + client IP

---

### 3.4 Rate Limit Window Reset

**Test ID:** `RATE-004` **Priority:** MEDIUM **Description:** Rate limit window resets after 60
seconds

**Test Steps:**

1. Exhaust rate limit (100 requests to `/mcp`)
2. Wait 61 seconds
3. Make new request
4. Verify request succeeds (limit reset)

**Expected Results:**

- Request after 61s succeeds
- Sliding window properly implemented

---

### 3.5 Public Routes - No Rate Limit

**Test ID:** `RATE-005` **Priority:** LOW **Description:** Public routes not subject to rate
limiting

**Test Steps:**

1. Make 300 requests to `/health` rapidly
2. Verify all succeed

**Expected Results:**

- No 429 responses for public routes

---

## 4. CORS Handling Tests

### 4.1 CORS Preflight Request

**Test ID:** `CORS-001` **Priority:** CRITICAL **Description:** OPTIONS requests return proper CORS
headers

**Test Steps:**

1. Send OPTIONS request to `/api/graph/snapshot`
2. Verify response headers

**Expected Results:**

```
Status: 200
Access-Control-Allow-Origin: http://localhost:8081 (or custom domain)
Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE
Access-Control-Allow-Headers: Content-Type, x-api-key
```

**Edge Cases:**

- OPTIONS to `/mcp`
- OPTIONS to `/events/stream`

---

### 4.2 CORS Headers on Actual Requests

**Test ID:** `CORS-002` **Priority:** HIGH **Description:** All responses include CORS headers

**Test Vectors:**

```typescript
[
  { method: "GET", path: "/health" },
  { method: "GET", path: "/api/graph/snapshot" },
  { method: "POST", path: "/mcp" },
  { method: "GET", path: "/api/metrics" },
];
```

**Expected Results:**

- All responses include `Access-Control-Allow-Origin` header
- Header value matches configured origin

---

### 4.3 CORS Origin Configuration

**Test ID:** `CORS-003` **Priority:** MEDIUM **Description:** CORS origin respects environment
configuration

**Test Scenarios:**

1. **No DOMAIN env:** Origin = `http://localhost:8081`
2. **DOMAIN=example.com:** Origin = `https://example.com`
3. **FRESH_PORT=9000 (no DOMAIN):** Origin = `http://localhost:9000`

**Test Steps:**

1. Set environment variable
2. Start server
3. Make request
4. Verify `Access-Control-Allow-Origin` header

**Expected Results:**

- Origin dynamically set based on config

---

### 4.4 CORS on Error Responses

**Test ID:** `CORS-004` **Priority:** MEDIUM **Description:** Error responses include CORS headers

**Test Steps:**

1. Make request that triggers 401 (invalid API key)
2. Make request that triggers 429 (rate limit exceeded)
3. Make request that triggers 404 (unknown route)
4. Verify all include CORS headers

**Expected Results:**

- CORS headers present on all error responses

---

## 5. API Endpoint Tests

### 5.1 Health Check Endpoint

**Test ID:** `API-001` **Priority:** CRITICAL **Description:** `GET /health` returns server health
status

**Test Steps:**

1. Make GET request to `/health`
2. Verify response

**Expected Results:**

```json
{
  "status": "ok"
}
```

- Status: 200
- Content-Type: application/json
- Public route (no auth)

**Edge Cases:**

- POST to `/health` (should return 405 Method Not Allowed or 404)

---

### 5.2 Graph Snapshot Endpoint

**Test ID:** `API-002` **Priority:** HIGH **Description:** `GET /api/graph/snapshot` returns current
graph state

**Test Steps:**

1. Initialize graph with test data
2. Make GET request to `/api/graph/snapshot`
3. Verify response contains nodes and edges

**Expected Results:**

```json
{
  "nodes": [...],
  "edges": [...],
  "metadata": {
    "node_count": 10,
    "edge_count": 15,
    "timestamp": "..."
  }
}
```

- Status: 200
- Protected route (requires auth in cloud mode)

**Error Cases:**

- GraphEngine not initialized (500 error)

---

### 5.3 Graph Path Finding Endpoint

**Test ID:** `API-003` **Priority:** HIGH **Description:** `GET /api/graph/path?from=A&to=B` finds
shortest path

**Test Steps:**

1. Populate graph with known structure:
   - A -> B -> C
   - A -> D -> C
2. Query path from A to C
3. Verify returns shortest path

**Expected Results:**

```json
{
  "path": ["A", "B", "C"],
  "total_hops": 2,
  "from": "A",
  "to": "C"
}
```

**Error Cases:**

- Missing `from` parameter → 400 Bad Request
- Missing `to` parameter → 400 Bad Request
- No path exists → `{"path": [], "total_hops": -1}`

---

### 5.4 Graph Related Tools Endpoint

**Test ID:** `API-004` **Priority:** HIGH **Description:**
`GET /api/graph/related?tool_id=X&limit=5` finds similar tools

**Test Steps:**

1. Populate graph with tool relationships
2. Query related tools for known tool_id
3. Verify Adamic-Adar scores

**Expected Results:**

```json
{
  "tool_id": "filesystem:read",
  "related": [
    {
      "tool_id": "filesystem:write",
      "name": "write",
      "server": "filesystem",
      "adamic_adar_score": 0.845,
      "edge_confidence": 0.92
    }
  ]
}
```

**Error Cases:**

- Missing `tool_id` → 400
- Invalid limit → defaults to 5
- Tool not found → empty related array

---

### 5.5 Graph Hypergraph Endpoint

**Test ID:** `API-005` **Priority:** HIGH **Description:** `GET /api/graph/hypergraph` returns
capability hypergraph

**Query Parameters:**

- `include_tools=true|false`
- `min_success_rate=0.0-1.0`
- `min_usage=N`

**Test Steps:**

1. Populate capabilities with varying success rates and usage
2. Query with filters
3. Verify filtering logic

**Expected Results:**

```json
{
  "nodes": [...],
  "edges": [...],
  "capability_zones": [...],
  "capabilities_count": 5,
  "tools_count": 12,
  "metadata": {
    "generated_at": "...",
    "version": "1.0.0"
  }
}
```

**Error Cases:**

- `min_success_rate < 0` → 400
- `min_success_rate > 1` → 400
- `min_usage < 0` → 400
- CapabilityDataService not initialized → 503

---

### 5.6 Capabilities List Endpoint

**Test ID:** `API-006` **Priority:** HIGH **Description:** `GET /api/capabilities` lists stored
capabilities

**Query Parameters:**

- `community_id=N`
- `min_success_rate=0.0-1.0`
- `min_usage=N`
- `limit=N`
- `offset=N`
- `sort=usage_count|success_rate|last_used|created_at`

**Test Steps:**

1. Store multiple capabilities with different attributes
2. Test each filter independently
3. Test filter combinations
4. Test pagination (offset/limit)
5. Test sorting

**Expected Results:**

```json
{
  "capabilities": [
    {
      "id": "cap_123",
      "code_snippet": "...",
      "success_rate": 0.95,
      "usage_count": 42,
      "tools_count": 3,
      "last_used": "2025-12-16T...",
      "created_at": "2025-12-15T..."
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

**Error Cases:**

- Invalid filter values → 400
- Limit > 100 → capped at 100
- Invalid sort field → 400

---

### 5.7 Capability Dependencies GET

**Test ID:** `API-007` **Priority:** MEDIUM **Description:**
`GET /api/capabilities/:id/dependencies` returns dependency graph

**Test Steps:**

1. Create capability with dependencies
2. Query dependencies
3. Verify response

**Expected Results:**

```json
{
  "capability_id": "cap_123",
  "dependencies": [
    {
      "target_id": "cap_456",
      "dependency_type": "requires",
      "confidence": 0.85,
      "created_at": "..."
    }
  ]
}
```

**Error Cases:**

- Capability not found → 404
- Invalid capability ID → 400

---

### 5.8 Capability Dependencies POST

**Test ID:** `API-008` **Priority:** MEDIUM **Description:**
`POST /api/capabilities/:id/dependencies` creates new dependency

**Request Body:**

```json
{
  "target_id": "cap_789",
  "dependency_type": "requires",
  "confidence": 0.9
}
```

**Expected Results:**

- Status: 201 Created
- Returns created dependency object

**Error Cases:**

- Missing target_id → 400
- Invalid dependency_type → 400
- Confidence out of range → 400
- Circular dependency → 400 or 409
- Capability not found → 404

---

### 5.9 Capability Dependencies DELETE

**Test ID:** `API-009` **Priority:** MEDIUM **Description:**
`DELETE /api/capabilities/:from/dependencies/:to` removes dependency

**Test Steps:**

1. Create dependency between cap_A and cap_B
2. DELETE dependency
3. Verify removal
4. Query dependencies (should not include removed)

**Expected Results:**

- Status: 204 No Content

**Error Cases:**

- Dependency not found → 404
- Invalid capability IDs → 400

---

### 5.10 Metrics Endpoint

**Test ID:** `API-010` **Priority:** MEDIUM **Description:** `GET /api/metrics` returns system
metrics

**Test Steps:**

1. Execute some workflows/tool calls to generate metrics
2. Query metrics endpoint
3. Verify metrics structure

**Expected Results:**

```json
{
  "graph_stats": {
    "node_count": 150,
    "edge_count": 300,
    "tool_count": 45,
    "capability_count": 25
  },
  "server_stats": {
    "uptime_seconds": 3600,
    "total_requests": 1000,
    "active_workflows": 2
  },
  "mcp_clients": {
    "filesystem": "healthy",
    "json": "healthy"
  }
}
```

---

### 5.11 Tools Search Endpoint

**Test ID:** `API-011` **Priority:** MEDIUM **Description:** `GET /api/tools/search?q=query`
searches for tools

**Test Steps:**

1. Populate vector search with tool embeddings
2. Search for "read file"
3. Verify semantic results

**Expected Results:**

```json
{
  "query": "read file",
  "results": [
    {
      "tool_id": "filesystem:read",
      "name": "read",
      "server": "filesystem",
      "description": "...",
      "similarity": 0.95
    }
  ],
  "total": 1
}
```

**Error Cases:**

- Missing query parameter → 400
- Empty query → 400

---

### 5.12 Events Stream Endpoint

**Test ID:** `API-012` **Priority:** HIGH **Description:** `GET /events/stream` establishes SSE
connection

**Test Steps:**

1. Make GET request to `/events/stream`
2. Verify Content-Type: text/event-stream
3. Verify initial connection event received
4. Trigger system event (e.g., capability created)
5. Verify event received via SSE

**Expected Results:**

- Status: 200
- Header: `Content-Type: text/event-stream`
- Header: `Cache-Control: no-cache`
- Header: `Connection: keep-alive`
- Initial event:

```
event: system.startup
data: {"client_id":"...","connected_clients":1,"filters":["*"]}
```

**Error Cases:**

- Max clients reached (100) → 503

---

### 5.13 Dashboard Redirect Endpoint

**Test ID:** `API-013` **Priority:** LOW **Description:** `GET /dashboard` redirects to Fresh
dashboard

**Test Steps:**

1. Make GET request to `/dashboard`
2. Verify redirect

**Expected Results:**

- Status: 302 Found
- Header: `Location: http://localhost:8080/dashboard`

---

### 5.14 Method Not Allowed

**Test ID:** `API-014` **Priority:** MEDIUM **Description:** Wrong HTTP method returns 405

**Test Vectors:**

```typescript
[
  { method: "POST", path: "/health" },
  { method: "POST", path: "/api/graph/snapshot" },
  { method: "DELETE", path: "/health" },
  { method: "PUT", path: "/api/metrics" },
];
```

**Expected Results:**

- Status: 405 Method Not Allowed
- CORS headers present

---

### 5.15 Not Found

**Test ID:** `API-015` **Priority:** MEDIUM **Description:** Unknown routes return 404

**Test Steps:**

1. Make GET request to `/unknown/route`
2. Make POST request to `/api/unknown`

**Expected Results:**

- Status: 404 Not Found
- Body: "Not Found"

---

## 6. JSON-RPC Protocol Tests

### 6.1 MCP Initialize Handshake

**Test ID:** `JSONRPC-001` **Priority:** CRITICAL **Description:** `POST /mcp` with initialize
method returns server info

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "clientInfo": {
      "name": "test-client",
      "version": "1.0.0"
    }
  }
}
```

**Expected Results:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": { "listChanged": true }
    },
    "serverInfo": {
      "name": "mcp-gateway",
      "title": "PML Gateway - ...",
      "version": "1.0.0"
    }
  }
}
```

---

### 6.2 MCP Initialized Notification

**Test ID:** `JSONRPC-002` **Priority:** CRITICAL **Description:** `notifications/initialized`
acknowledgment

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "notifications/initialized"
}
```

**Expected Results:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {}
}
```

---

### 6.3 Tools List via JSON-RPC

**Test ID:** `JSONRPC-003` **Priority:** CRITICAL **Description:** `tools/list` returns meta-tools

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/list"
}
```

**Expected Results:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "tools": [
      {
        "name": "pml:execute_dag",
        "description": "...",
        "inputSchema": {...}
      },
      {
        "name": "pml:search_tools",
        "description": "...",
        "inputSchema": {...}
      }
      // ... other meta-tools
    ]
  }
}
```

---

### 6.4 Tools Call via JSON-RPC

**Test ID:** `JSONRPC-004` **Priority:** CRITICAL **Description:** `tools/call` executes tool and
returns result

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "pml:search_tools",
    "arguments": {
      "query": "read file",
      "limit": 5
    }
  }
}
```

**Expected Results:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"results\": [...]}"
      }
    ]
  }
}
```

**Error Cases:**

- Missing `name` parameter → error code -32602 (INVALID_PARAMS)
- Unknown tool → error code -32602
- Tool execution failure → error code -32603 (INTERNAL_ERROR)

---

### 6.5 JSON-RPC Error: Method Not Found

**Test ID:** `JSONRPC-005` **Priority:** HIGH **Description:** Unknown method returns error

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "unknown/method"
}
```

**Expected Results:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32601,
    "message": "Method not found: unknown/method"
  }
}
```

---

### 6.6 JSON-RPC Error: Invalid Request

**Test ID:** `JSONRPC-006` **Priority:** HIGH **Description:** Malformed JSON returns parse error

**Request:**

```
{invalid json
```

**Expected Results:**

```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32700,
    "message": "Parse error: ..."
  }
}
```

- Status: 400

---

### 6.7 JSON-RPC User Context

**Test ID:** `JSONRPC-007` **Priority:** MEDIUM **Description:** User ID from auth passed to tool
handlers

**Test Steps:**

1. Make authenticated JSON-RPC call to `tools/call` with `pml:execute_dag`
2. Verify user_id propagated to workflow handler
3. Verify workflow execution logged with correct user

**Expected Results:**

- User ID correctly extracted from API key
- Passed to `handleCallTool(request, userId)`
- Available in workflow execution context

---

### 6.8 Legacy Message Endpoint

**Test ID:** `JSONRPC-008` **Priority:** LOW **Description:** `POST /message` still works (backward
compatibility)

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

**Expected Results:**

- Same behavior as `/mcp` endpoint
- Returns tools list

---

## 7. SSE Event Stream Tests

### 7.1 SSE Connection Establishment

**Test ID:** `SSE-001` **Priority:** HIGH **Description:** Client can establish SSE connection

**Test Steps:**

1. Make GET request to `/events/stream` with auth
2. Keep connection open
3. Verify connection event received
4. Verify heartbeat events every 30s

**Expected Results:**

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

event: system.startup
data: {"client_id":"...","connected_clients":1,"filters":["*"]}

: heartbeat

: heartbeat
```

---

### 7.2 SSE Event Broadcasting

**Test ID:** `SSE-002` **Priority:** HIGH **Description:** Events broadcast to all connected clients

**Test Steps:**

1. Connect 3 SSE clients
2. Trigger system event (e.g., graph.node_created)
3. Verify all 3 clients receive event

**Expected Results:**

- All clients receive same event
- Event format:

```
event: graph.node_created
data: {"node_id":"...","timestamp":...}
```

---

### 7.3 SSE Event Filtering

**Test ID:** `SSE-003` **Priority:** MEDIUM **Description:** `?filter=` parameter filters events

**Test Steps:**

1. Connect client A with `?filter=graph.node_created,graph.edge_created`
2. Connect client B with no filter (all events)
3. Trigger events: graph.node_created, workflow.started, graph.edge_created
4. Verify client A only receives graph.* events
5. Verify client B receives all events

**Expected Results:**

- Filter applied correctly
- Client A: 2 events (node_created, edge_created)
- Client B: 3 events (all)

---

### 7.4 SSE Max Clients Limit

**Test ID:** `SSE-004` **Priority:** HIGH **Description:** 101st client receives 503 error

**Test Steps:**

1. Connect 100 SSE clients
2. Attempt 101st connection
3. Verify 503 Service Unavailable

**Expected Results:**

```json
{
  "error": "Too many clients",
  "max": 100
}
```

- Status: 503

---

### 7.5 SSE Client Disconnect

**Test ID:** `SSE-005` **Priority:** MEDIUM **Description:** Client disconnect properly cleaned up

**Test Steps:**

1. Connect 3 SSE clients
2. Disconnect client 2
3. Verify server logs "SSE client disconnected (2/100)"
4. Trigger event
5. Verify only clients 1 and 3 receive event

**Expected Results:**

- Client removed from active list
- No errors sending to disconnected client

---

### 7.6 SSE Heartbeat

**Test ID:** `SSE-006` **Priority:** MEDIUM **Description:** Heartbeat comments sent every 30s

**Test Steps:**

1. Connect SSE client
2. Wait and record incoming messages
3. Verify heartbeat every 30s

**Expected Results:**

- Heartbeat format: `: heartbeat\n\n`
- Interval: 30000ms ± 1000ms

---

### 7.7 SSE CORS Headers

**Test ID:** `SSE-007` **Priority:** MEDIUM **Description:** SSE responses include CORS headers

**Test Steps:**

1. Make OPTIONS request to `/events/stream`
2. Make GET request to `/events/stream` with Origin header
3. Verify CORS headers

**Expected Results:**

- CORS headers present on SSE response

---

### 7.8 SSE GET to /mcp

**Test ID:** `SSE-008` **Priority:** LOW **Description:** `GET /mcp` redirects to SSE stream (MCP
spec)

**Test Steps:**

1. Make GET request to `/mcp`
2. Verify SSE stream established

**Expected Results:**

- Same behavior as `/events/stream`

---

## 8. Error Handling Tests

### 8.1 Dependency Initialization Failure

**Test ID:** `ERROR-001` **Priority:** HIGH **Description:** Graceful handling when
EventsStreamManager fails to initialize

**Test Steps:**

1. Mock EventBus to throw error
2. Start HTTP server
3. Make request to `/events/stream`
4. Verify 503 error

**Expected Results:**

```json
{
  "error": "Events stream not initialized"
}
```

---

### 8.2 GraphEngine Failure

**Test ID:** `ERROR-002` **Priority:** HIGH **Description:** API returns 500 when GraphEngine throws
error

**Test Steps:**

1. Mock GraphEngine.getGraphSnapshot() to throw
2. Make request to `/api/graph/snapshot`
3. Verify 500 error with message

**Expected Results:**

```json
{
  "error": "Failed to get graph snapshot: ..."
}
```

---

### 8.3 CapabilityDataService Unavailable

**Test ID:** `ERROR-003` **Priority:** MEDIUM **Description:** Hypergraph endpoint returns 503 when
service unavailable

**Test Steps:**

1. Create PMLGatewayServer without CapabilityDataService
2. Make request to `/api/graph/hypergraph`
3. Verify 503 error

**Expected Results:**

```json
{
  "error": "CapabilityDataService not configured"
}
```

---

### 8.4 Database Connection Loss

**Test ID:** `ERROR-004` **Priority:** HIGH **Description:** Graceful degradation when database
unavailable

**Test Steps:**

1. Start server normally
2. Simulate database connection loss
3. Make request to `/api/capabilities`
4. Verify error handling

**Expected Results:**

- 500 error with descriptive message
- Server remains running (doesn't crash)
- Can recover when DB reconnects

---

### 8.5 Invalid JSON Body

**Test ID:** `ERROR-005` **Priority:** MEDIUM **Description:** POST with invalid JSON returns 400

**Test Steps:**

1. POST to `/mcp` with body: `{invalid}`
2. POST to `/api/capabilities/123/dependencies` with body: `not json`

**Expected Results:**

- Status: 400
- Error message about invalid JSON

---

### 8.6 Missing Required Fields

**Test ID:** `ERROR-006` **Priority:** MEDIUM **Description:** API validates required fields

**Test Vectors:**

- POST `/api/capabilities/:id/dependencies` without `target_id`
- tools/call without `name` parameter

**Expected Results:**

- Status: 400
- Error message listing missing fields

---

## 9. Multi-Client and Concurrency Tests

### 9.1 Concurrent API Requests

**Test ID:** `CONCURRENCY-001` **Priority:** HIGH **Description:** Handle 50 concurrent API requests

**Test Steps:**

1. Make 50 simultaneous GET requests to `/api/graph/snapshot`
2. Verify all succeed
3. Verify responses are correct

**Expected Results:**

- All requests return 200
- No race conditions or corrupted responses

---

### 9.2 Concurrent JSON-RPC Calls

**Test ID:** `CONCURRENCY-002` **Priority:** HIGH **Description:** Handle concurrent JSON-RPC
requests

**Test Steps:**

1. Make 20 concurrent `tools/call` requests with different IDs
2. Verify all responses match request IDs correctly
3. Verify no response mixing

**Expected Results:**

- Each response.id matches request.id
- No cross-contamination

---

### 9.3 Mixed Traffic Pattern

**Test ID:** `CONCURRENCY-003` **Priority:** MEDIUM **Description:** Handle mixed API and JSON-RPC
traffic

**Test Steps:**

1. Simultaneously:
   - 10 clients to `/api/graph/snapshot`
   - 10 clients to `/mcp` (JSON-RPC)
   - 5 SSE clients to `/events/stream`
2. Verify all succeed

**Expected Results:**

- No blocking between different endpoint types
- All requests processed correctly

---

### 9.4 SSE Broadcast Performance

**Test ID:** `CONCURRENCY-004` **Priority:** MEDIUM **Description:** Broadcast event to 100 SSE
clients

**Test Steps:**

1. Connect 100 SSE clients
2. Trigger single event
3. Measure time to broadcast to all
4. Verify all clients receive event

**Expected Results:**

- Broadcast completes in < 1 second
- All clients receive event

---

## 10. Edge Cases and Boundary Tests

### 10.1 Empty Database

**Test ID:** `EDGE-001` **Priority:** MEDIUM **Description:** API handles empty database gracefully

**Test Steps:**

1. Start server with fresh database (no data)
2. Query `/api/graph/snapshot`
3. Query `/api/capabilities`

**Expected Results:**

```json
{
  "nodes": [],
  "edges": [],
  "metadata": {...}
}
```

```json
{
  "capabilities": [],
  "total": 0
}
```

---

### 10.2 Very Large Graph

**Test ID:** `EDGE-002` **Priority:** LOW **Description:** Handle large graph with 10,000 nodes

**Test Steps:**

1. Populate graph with 10,000 nodes, 20,000 edges
2. Query `/api/graph/snapshot`
3. Verify response (may be paginated or filtered)

**Expected Results:**

- Request completes (may take longer)
- No memory errors
- Response size manageable

---

### 10.3 Query Parameter Edge Cases

**Test ID:** `EDGE-003` **Priority:** MEDIUM **Description:** Handle unusual query parameters

**Test Vectors:**

```typescript
[
  { param: "limit=-1", expected: "default to server limit" },
  { param: "limit=999999", expected: "cap at 100" },
  { param: "offset=-10", expected: "400 error" },
  { param: "min_success_rate=1.5", expected: "400 error" },
  { param: "sort=invalid_field", expected: "400 error" },
];
```

---

### 10.4 Special Characters in IDs

**Test ID:** `EDGE-004` **Priority:** LOW **Description:** Handle special characters in capability
IDs

**Test Steps:**

1. Create capability with ID containing `:`, `/`, `?`, `#`
2. Query via API
3. Verify encoding/decoding

**Expected Results:**

- Proper URL encoding
- Correct retrieval

---

### 10.5 Very Long Event Filter

**Test ID:** `EDGE-005` **Priority:** LOW **Description:** SSE filter with 100 event types

**Test Steps:**

1. Connect SSE with `?filter=type1,type2,...,type100`
2. Verify connection succeeds
3. Verify filtering works

**Expected Results:**

- Filter parsed correctly
- Performance acceptable

---

### 10.6 Rapid Connect/Disconnect SSE

**Test ID:** `EDGE-006` **Priority:** MEDIUM **Description:** Rapid SSE client churn

**Test Steps:**

1. Connect 10 clients
2. Disconnect all
3. Repeat 10 times rapidly
4. Verify no resource leaks

**Expected Results:**

- Client count correctly maintained
- No memory leaks

---

## Test Implementation Guidelines

### Test Fixtures and Helpers

**Location:** `tests/integration/mcp-gateway/fixtures/`

```typescript
// gateway-test-helpers.ts
export async function createTestGatewayServer(config?: Partial<GatewayServerConfig>) {
  const testDir = await Deno.makeTempDir({ prefix: "mcp_gateway_test_" });
  const db = await initializeTestDatabase(testDir);
  const vectorSearch = new VectorSearch(db, await loadMockEmbeddingModel());
  const graphEngine = new GraphRAGEngine(db);
  // ... initialize all dependencies

  const gateway = new PMLGatewayServer(
    db,
    vectorSearch,
    graphEngine,
    dagSuggester,
    executor,
    mcpClients,
    capabilityStore,
    adaptiveThresholdManager,
    config
  );

  return { gateway, db, testDir, cleanup: async () => { ... } };
}

export async function makeGatewayRequest(
  port: number,
  path: string,
  options?: RequestInit & { apiKey?: string }
) {
  const headers = new Headers(options?.headers);
  if (options?.apiKey) {
    headers.set("x-api-key", options.apiKey);
  }

  return await fetch(`http://localhost:${port}${path}`, {
    ...options,
    headers,
  });
}

export async function makeJsonRpcRequest(
  port: number,
  method: string,
  params?: Record<string, unknown>,
  id: number | string = 1,
  apiKey?: string
) {
  return await makeGatewayRequest(port, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    apiKey,
  });
}

export async function connectSSE(
  port: number,
  filter?: string,
  apiKey?: string
): Promise<EventSource> {
  const url = new URL(`http://localhost:${port}/events/stream`);
  if (filter) url.searchParams.set("filter", filter);

  // Note: EventSource doesn't support custom headers, may need polyfill
  // For tests, use fetch with ReadableStream instead
  const response = await makeGatewayRequest(port, url.pathname + url.search, {
    method: "GET",
    apiKey,
  });

  return response; // Return response with readable stream
}

export function parseSSEStream(response: Response): AsyncIterable<SSEEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  return {
    async *[Symbol.asyncIterator]() {
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = parseSSEBuffer(buffer);
        for (const event of events) {
          yield event;
        }
      }
    }
  };
}
```

### Test Organization

```
tests/integration/mcp-gateway/
├── fixtures/
│   ├── gateway-test-helpers.ts
│   ├── mock-dependencies.ts
│   └── test-data.ts
├── 01-lifecycle.test.ts         (LIFECYCLE-001 to LIFECYCLE-003)
├── 02-authentication.test.ts    (AUTH-001 to AUTH-005)
├── 03-rate-limiting.test.ts     (RATE-001 to RATE-005)
├── 04-cors.test.ts              (CORS-001 to CORS-004)
├── 05-api-endpoints.test.ts     (API-001 to API-015)
├── 06-jsonrpc.test.ts           (JSONRPC-001 to JSONRPC-008)
├── 07-sse-events.test.ts        (SSE-001 to SSE-008)
├── 08-error-handling.test.ts    (ERROR-001 to ERROR-006)
├── 09-concurrency.test.ts       (CONCURRENCY-001 to CONCURRENCY-004)
└── 10-edge-cases.test.ts        (EDGE-001 to EDGE-006)
```

### Common Test Patterns

```typescript
// Pattern 1: Basic endpoint test
Deno.test("API-001: Health check endpoint", async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = 3003;

  try {
    await gateway.startHttp(port);

    const response = await makeGatewayRequest(port, "/health");

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.status, "ok");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});

// Pattern 2: Authentication test
Deno.test("AUTH-002: Cloud mode requires API key", async () => {
  await withEnv("GITHUB_CLIENT_ID", "test_client", async () => {
    const { gateway, cleanup } = await createTestGatewayServer();
    const port = 3003;

    try {
      await gateway.startHttp(port);

      const response = await makeGatewayRequest(port, "/api/graph/snapshot");

      assertEquals(response.status, 401);
      const body = await response.json();
      assertEquals(body.error, "Unauthorized");
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

// Pattern 3: SSE test
Deno.test("SSE-001: SSE connection establishment", async () => {
  const { gateway, cleanup } = await createTestGatewayServer();
  const port = 3003;

  try {
    await gateway.startHttp(port);

    const response = await connectSSE(port);

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "text/event-stream");

    const events = parseSSEStream(response);
    const firstEvent = await events[Symbol.asyncIterator]().next();

    assertEquals(firstEvent.value.event, "system.startup");
  } finally {
    await gateway.stop();
    await cleanup();
  }
});
```

### Environment Configuration for Tests

```typescript
// tests/integration/mcp-gateway/fixtures/test-env.ts
export async function withEnv<T>(
  key: string,
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const original = Deno.env.get(key);
  if (value === undefined) {
    Deno.env.delete(key);
  } else {
    Deno.env.set(key, value);
  }
  try {
    return await fn();
  } finally {
    if (original !== undefined) {
      Deno.env.set(key, original);
    } else {
      Deno.env.delete(key);
    }
  }
}

export async function withCloudMode<T>(fn: () => Promise<T>): Promise<T> {
  return await withEnv("GITHUB_CLIENT_ID", "test_client_id", fn);
}

export async function withLocalMode<T>(fn: () => Promise<T>): Promise<T> {
  return await withEnv("GITHUB_CLIENT_ID", undefined, fn);
}
```

## Test Execution Plan

### Phase 1: Core Functionality (Week 1)

- LIFECYCLE tests (3 tests)
- AUTH tests (5 tests)
- API-001 to API-005 (health, graph endpoints)
- JSONRPC-001 to JSONRPC-004 (core protocol)

**Exit Criteria:**

- Server can start/stop cleanly
- Authentication works in both modes
- Basic API endpoints functional
- JSON-RPC protocol compliant

### Phase 2: Extended API Coverage (Week 2)

- API-006 to API-015 (capabilities, metrics, tools, errors)
- CORS tests (4 tests)
- ERROR tests (6 tests)

**Exit Criteria:**

- All API endpoints tested
- CORS properly configured
- Error handling comprehensive

### Phase 3: Advanced Features (Week 3)

- SSE tests (8 tests)
- RATE tests (5 tests)
- JSONRPC-005 to JSONRPC-008 (error cases, user context)

**Exit Criteria:**

- SSE streaming reliable
- Rate limiting effective
- All JSON-RPC error cases handled

### Phase 4: Stress and Edge Cases (Week 4)

- CONCURRENCY tests (4 tests)
- EDGE tests (6 tests)
- Integration with existing test suite

**Exit Criteria:**

- No concurrency issues
- Edge cases handled gracefully
- Full test suite passes

## Success Criteria

### Coverage Targets

- **Endpoint Coverage:** 100% of documented API endpoints
- **Authentication Paths:** Both local and cloud modes
- **Error Scenarios:** All error codes tested
- **CORS:** All HTTP methods and endpoints
- **JSON-RPC:** All methods and error codes

### Quality Metrics

- **All tests pass:** 100% pass rate
- **No flaky tests:** Tests should be deterministic
- **Test execution time:** < 5 minutes for full suite
- **Code coverage:** > 80% for gateway-server.ts and routing modules

### Documentation

- All test cases documented with ID, description, expected results
- Test fixtures and helpers well-documented
- Example requests/responses provided
- Troubleshooting guide for common failures

## Risk Assessment

### High Risk Areas

1. **SSE Connection Management:** Potential memory leaks with many clients
2. **Rate Limiting:** Timing-sensitive, may be flaky
3. **Authentication:** Database dependency, may require seeding
4. **Concurrency:** Race conditions possible

### Mitigation Strategies

1. **Memory Monitoring:** Track client count, check for leaks after disconnect
2. **Rate Limit Testing:** Use generous time margins, reset state between tests
3. **Auth Mocking:** Use in-memory mock database for auth tests
4. **Concurrency Control:** Use barriers/coordination primitives for reproducibility

## Test Maintenance

### Continuous Integration

- Run full test suite on every PR
- Run subset (CRITICAL tests) on every commit
- Nightly runs with extended concurrency tests

### Test Review

- Review test failures weekly
- Update tests when API changes
- Refactor flaky tests immediately

### Test Data Management

- Use fixtures for consistent test data
- Clean up test databases after each test
- Avoid hard-coded IDs, generate dynamically

---

## Appendix A: Full Test Inventory

| Test ID         | Category    | Priority | Description                       | Est. Time |
| --------------- | ----------- | -------- | --------------------------------- | --------- |
| LIFECYCLE-001   | Lifecycle   | CRITICAL | HTTP server startup               | 2h        |
| LIFECYCLE-002   | Lifecycle   | CRITICAL | HTTP server shutdown              | 2h        |
| LIFECYCLE-003   | Lifecycle   | HIGH     | Multiple start/stop cycles        | 1h        |
| AUTH-001        | Auth        | CRITICAL | Local mode bypass                 | 1h        |
| AUTH-002        | Auth        | CRITICAL | Cloud mode API key required       | 1h        |
| AUTH-003        | Auth        | CRITICAL | Valid API key accepted            | 2h        |
| AUTH-004        | Auth        | HIGH     | Invalid API key format            | 1h        |
| AUTH-005        | Auth        | HIGH     | Public routes no auth             | 1h        |
| RATE-001        | Rate Limit  | HIGH     | MCP endpoint rate limit           | 2h        |
| RATE-002        | Rate Limit  | HIGH     | API endpoint rate limit           | 2h        |
| RATE-003        | Rate Limit  | MEDIUM   | Rate limit isolation              | 2h        |
| RATE-004        | Rate Limit  | MEDIUM   | Rate limit window reset           | 1h        |
| RATE-005        | Rate Limit  | LOW      | Public routes no limit            | 1h        |
| CORS-001        | CORS        | CRITICAL | Preflight request                 | 1h        |
| CORS-002        | CORS        | HIGH     | CORS on actual requests           | 1h        |
| CORS-003        | CORS        | MEDIUM   | CORS origin config                | 1h        |
| CORS-004        | CORS        | MEDIUM   | CORS on errors                    | 1h        |
| API-001         | API         | CRITICAL | Health check                      | 1h        |
| API-002         | API         | HIGH     | Graph snapshot                    | 2h        |
| API-003         | API         | HIGH     | Graph path finding                | 2h        |
| API-004         | API         | HIGH     | Graph related tools               | 2h        |
| API-005         | API         | HIGH     | Graph hypergraph                  | 3h        |
| API-006         | API         | HIGH     | Capabilities list                 | 3h        |
| API-007         | API         | MEDIUM   | Capability deps GET               | 2h        |
| API-008         | API         | MEDIUM   | Capability deps POST              | 2h        |
| API-009         | API         | MEDIUM   | Capability deps DELETE            | 2h        |
| API-010         | API         | MEDIUM   | Metrics endpoint                  | 2h        |
| API-011         | API         | MEDIUM   | Tools search                      | 2h        |
| API-012         | API         | HIGH     | Events stream                     | 3h        |
| API-013         | API         | LOW      | Dashboard redirect                | 1h        |
| API-014         | API         | MEDIUM   | Method not allowed                | 1h        |
| API-015         | API         | MEDIUM   | Not found                         | 1h        |
| JSONRPC-001     | JSON-RPC    | CRITICAL | Initialize handshake              | 2h        |
| JSONRPC-002     | JSON-RPC    | CRITICAL | Initialized notification          | 1h        |
| JSONRPC-003     | JSON-RPC    | CRITICAL | Tools list                        | 2h        |
| JSONRPC-004     | JSON-RPC    | CRITICAL | Tools call                        | 3h        |
| JSONRPC-005     | JSON-RPC    | HIGH     | Method not found error            | 1h        |
| JSONRPC-006     | JSON-RPC    | HIGH     | Invalid request error             | 1h        |
| JSONRPC-007     | JSON-RPC    | MEDIUM   | User context propagation          | 2h        |
| JSONRPC-008     | JSON-RPC    | LOW      | Legacy message endpoint           | 1h        |
| SSE-001         | SSE         | HIGH     | Connection establishment          | 2h        |
| SSE-002         | SSE         | HIGH     | Event broadcasting                | 2h        |
| SSE-003         | SSE         | MEDIUM   | Event filtering                   | 2h        |
| SSE-004         | SSE         | HIGH     | Max clients limit                 | 1h        |
| SSE-005         | SSE         | MEDIUM   | Client disconnect                 | 2h        |
| SSE-006         | SSE         | MEDIUM   | Heartbeat                         | 1h        |
| SSE-007         | SSE         | MEDIUM   | CORS headers                      | 1h        |
| SSE-008         | SSE         | LOW      | GET /mcp SSE                      | 1h        |
| ERROR-001       | Error       | HIGH     | EventsStream init failure         | 1h        |
| ERROR-002       | Error       | HIGH     | GraphEngine failure               | 1h        |
| ERROR-003       | Error       | MEDIUM   | CapabilityDataService unavailable | 1h        |
| ERROR-004       | Error       | HIGH     | Database connection loss          | 2h        |
| ERROR-005       | Error       | MEDIUM   | Invalid JSON body                 | 1h        |
| ERROR-006       | Error       | MEDIUM   | Missing required fields           | 1h        |
| CONCURRENCY-001 | Concurrency | HIGH     | Concurrent API requests           | 2h        |
| CONCURRENCY-002 | Concurrency | HIGH     | Concurrent JSON-RPC               | 2h        |
| CONCURRENCY-003 | Concurrency | MEDIUM   | Mixed traffic                     | 2h        |
| CONCURRENCY-004 | Concurrency | MEDIUM   | SSE broadcast performance         | 2h        |
| EDGE-001        | Edge Cases  | MEDIUM   | Empty database                    | 1h        |
| EDGE-002        | Edge Cases  | LOW      | Very large graph                  | 2h        |
| EDGE-003        | Edge Cases  | MEDIUM   | Query param edge cases            | 2h        |
| EDGE-004        | Edge Cases  | LOW      | Special chars in IDs              | 1h        |
| EDGE-005        | Edge Cases  | LOW      | Very long event filter            | 1h        |
| EDGE-006        | Edge Cases  | MEDIUM   | Rapid SSE connect/disconnect      | 2h        |

**Total Tests:** 62 **Total Estimated Time:** 102 hours (≈ 13 days @ 8h/day) **Recommended
Timeline:** 4 weeks (allows for debugging, refactoring, documentation)

---

## Appendix B: Test Data Templates

### Mock API Key Database Seeding

```typescript
export async function seedTestApiKeys(db: PGliteClient) {
  const validApiKey = "ac_123456789012345678901234";
  const prefix = "ac_1234"; // First 7 chars
  const hash = await hashApiKey(validApiKey);

  await db.query(
    `
    INSERT INTO users (id, username, api_key_hash, api_key_prefix)
    VALUES ('user_1', 'test_user', $1, $2)
  `,
    [hash, prefix],
  );

  return { validApiKey, userId: "user_1" };
}
```

### Mock Graph Data

```typescript
export async function seedTestGraph(graphEngine: GraphRAGEngine) {
  // Nodes
  graphEngine.addNode("filesystem:read", { type: "tool", server: "filesystem", label: "read" });
  graphEngine.addNode("filesystem:write", { type: "tool", server: "filesystem", label: "write" });
  graphEngine.addNode("json:parse", { type: "tool", server: "json", label: "parse" });

  // Edges
  graphEngine.addEdge("filesystem:read", "json:parse", { weight: 0.8 });
  graphEngine.addEdge("filesystem:read", "filesystem:write", { weight: 0.9 });
}
```

### Mock Capability Data

```typescript
export async function seedTestCapabilities(db: PGliteClient) {
  await db.query(`
    INSERT INTO capabilities (id, code_snippet, success_rate, usage_count, tools_count)
    VALUES
      ('cap_1', 'read and parse JSON', 0.95, 42, 2),
      ('cap_2', 'write file', 0.88, 28, 1),
      ('cap_3', 'process data', 0.75, 15, 3)
  `);
}
```

---

## Appendix C: Example Test Implementation

```typescript
/**
 * Example Integration Test: Authentication Flow
 * tests/integration/mcp-gateway/02-authentication.test.ts
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  createTestGatewayServer,
  makeGatewayRequest,
  seedTestApiKeys,
  withCloudMode,
  withLocalMode,
} from "./fixtures/gateway-test-helpers.ts";

Deno.test("AUTH-001: Local mode - auth bypass", async () => {
  await withLocalMode(async () => {
    const { gateway, db, cleanup } = await createTestGatewayServer();
    const port = 3003;

    try {
      await gateway.startHttp(port);

      // Test API endpoint without auth
      const apiResponse = await makeGatewayRequest(port, "/api/graph/snapshot");
      assertEquals(apiResponse.status, 200);

      // Test MCP endpoint without auth
      const mcpResponse = await makeGatewayRequest(port, "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      });
      assertEquals(mcpResponse.status, 200);

      // Test SSE endpoint without auth
      const sseResponse = await makeGatewayRequest(port, "/events/stream");
      assertEquals(sseResponse.status, 200);
      assertEquals(sseResponse.headers.get("content-type"), "text/event-stream");
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test("AUTH-002: Cloud mode - API key required", async () => {
  await withCloudMode(async () => {
    const { gateway, db, cleanup } = await createTestGatewayServer();
    const port = 3003;

    try {
      await gateway.startHttp(port);

      // Test API endpoint without key
      const apiResponse = await makeGatewayRequest(port, "/api/graph/snapshot");
      assertEquals(apiResponse.status, 401);

      const body = await apiResponse.json();
      assertEquals(body.error, "Unauthorized");
      assertEquals(body.message, "Valid API key required");

      // Verify CORS headers present
      assertExists(apiResponse.headers.get("access-control-allow-origin"));
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test("AUTH-003: Cloud mode - valid API key", async () => {
  await withCloudMode(async () => {
    const { gateway, db, cleanup } = await createTestGatewayServer();
    const { validApiKey } = await seedTestApiKeys(db);
    const port = 3003;

    try {
      await gateway.startHttp(port);

      // Test with valid API key
      const response = await makeGatewayRequest(port, "/api/graph/snapshot", {
        apiKey: validApiKey,
      });

      // Should succeed (200 or 503 if GraphEngine not initialized)
      assertEquals([200, 503].includes(response.status), true);

      if (response.status === 200) {
        const body = await response.json();
        assertExists(body.nodes);
        assertExists(body.edges);
      }
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test("AUTH-004: Cloud mode - invalid API key formats", async () => {
  await withCloudMode(async () => {
    const { gateway, cleanup } = await createTestGatewayServer();
    const port = 3003;

    const invalidKeys = [
      "invalid_key",
      "ac_short",
      "xx_123456789012345678901234",
      "ac_12345678901234567890123456789",
      "",
      "Bearer ac_123456789012345678901234",
    ];

    try {
      await gateway.startHttp(port);

      for (const invalidKey of invalidKeys) {
        const response = await makeGatewayRequest(port, "/api/graph/snapshot", {
          apiKey: invalidKey,
        });

        assertEquals(response.status, 401, `Failed for key: ${invalidKey}`);
      }
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});

Deno.test("AUTH-005: Public routes - no auth required", async () => {
  await withCloudMode(async () => {
    const { gateway, cleanup } = await createTestGatewayServer();
    const port = 3003;

    try {
      await gateway.startHttp(port);

      // Health check should work without auth even in cloud mode
      const response = await makeGatewayRequest(port, "/health");
      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "ok");
    } finally {
      await gateway.stop();
      await cleanup();
    }
  });
});
```

---

**End of Integration Test Plan**
