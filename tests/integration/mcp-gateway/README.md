# MCP Gateway Integration Tests

Comprehensive integration test suite for the MCP Gateway HTTP server, following the test plan
documented in
`/home/ubuntu/CascadeProjects/AgentCards/docs/sprint-artifacts/integration-test-plan-mcp-gateway.md`.

## Test Structure

```
tests/integration/mcp-gateway/
├── fixtures/
│   └── gateway-test-helpers.ts  # Test utilities and helpers
├── 01-lifecycle.test.ts         # Server lifecycle tests (LIFECYCLE-001 to 005)
├── 02-authentication.test.ts    # Authentication tests (AUTH-001 to 007)
├── 03-rate-limiting.test.ts     # Rate limiting tests (RATE-001 to 007)
├── 04-cors.test.ts              # CORS tests (CORS-001 to 006)
├── 05-api-endpoints.test.ts     # API endpoint tests (API-001 to 015)
├── 06-jsonrpc.test.ts           # JSON-RPC protocol tests (JSONRPC-001 to 012)
├── 07-sse-events.test.ts        # SSE streaming tests (SSE-001 to 012)
├── 08-error-handling.test.ts    # Error handling tests (ERROR-001 to 010)
├── 09-concurrency.test.ts       # Concurrency tests (CONCURRENCY-001 to 007)
└── 10-edge-cases.test.ts        # Edge case tests (EDGE-001 to 012)
```

## Running Tests

### Run All Tests

```bash
deno test tests/integration/mcp-gateway/ --allow-all
```

### Run Specific Test Category

```bash
# Lifecycle tests
deno test tests/integration/mcp-gateway/01-lifecycle.test.ts --allow-all

# Authentication tests
deno test tests/integration/mcp-gateway/02-authentication.test.ts --allow-all

# Rate limiting tests
deno test tests/integration/mcp-gateway/03-rate-limiting.test.ts --allow-all

# CORS tests
deno test tests/integration/mcp-gateway/04-cors.test.ts --allow-all

# API endpoint tests
deno test tests/integration/mcp-gateway/05-api-endpoints.test.ts --allow-all

# JSON-RPC tests
deno test tests/integration/mcp-gateway/06-jsonrpc.test.ts --allow-all

# SSE event tests
deno test tests/integration/mcp-gateway/07-sse-events.test.ts --allow-all

# Error handling tests
deno test tests/integration/mcp-gateway/08-error-handling.test.ts --allow-all

# Concurrency tests
deno test tests/integration/mcp-gateway/09-concurrency.test.ts --allow-all

# Edge case tests
deno test tests/integration/mcp-gateway/10-edge-cases.test.ts --allow-all
```

### Run Specific Test

```bash
deno test tests/integration/mcp-gateway/ --allow-all --filter "LIFECYCLE-001"
```

### Run with Coverage

```bash
deno test tests/integration/mcp-gateway/ --allow-all --coverage=coverage
deno coverage coverage
```

## Test Categories

### 1. Lifecycle Tests (5 tests)

- LIFECYCLE-001: HTTP server startup
- LIFECYCLE-002: HTTP server shutdown
- LIFECYCLE-003: Multiple start/stop cycles
- LIFECYCLE-004: Port already in use
- LIFECYCLE-005: Concurrent startup requests

### 2. Authentication Tests (7 tests)

- AUTH-001: Local mode - auth bypass
- AUTH-002: Cloud mode - API key required
- AUTH-003: Cloud mode - valid API key
- AUTH-004: Cloud mode - invalid API key formats
- AUTH-005: Public routes - no auth required
- AUTH-006: Local mode with API key header
- AUTH-007: Multiple auth headers

### 3. Rate Limiting Tests (7 tests)

- RATE-001: MCP endpoint rate limit
- RATE-002: API endpoint rate limit
- RATE-003: Rate limit key isolation
- RATE-004: Rate limit window reset (slow test)
- RATE-005: Public routes - no rate limit
- RATE-006: Rate limit includes CORS headers
- RATE-007: Different endpoints have different limits

### 4. CORS Tests (6 tests)

- CORS-001: Preflight request
- CORS-002: CORS headers on actual requests
- CORS-003: CORS origin configuration
- CORS-004: CORS on error responses
- CORS-005: Preflight for different endpoints
- CORS-006: Wildcard vs specific origin

### 5. API Endpoint Tests (15 tests)

- API-001: Health check endpoint
- API-002: Graph snapshot endpoint
- API-003: Graph path finding endpoint
- API-004: Graph related tools endpoint
- API-005: Graph hypergraph endpoint
- API-006: Capabilities list endpoint
- API-007: Capability dependencies GET
- API-008: Capability dependencies POST
- API-009: Capability dependencies DELETE
- API-010: Metrics endpoint
- API-011: Tools search endpoint
- API-012: Events stream endpoint
- API-013: Dashboard redirect endpoint
- API-014: Method not allowed
- API-015: Not found

### 6. JSON-RPC Protocol Tests (12 tests)

- JSONRPC-001: Initialize handshake
- JSONRPC-002: Initialized notification
- JSONRPC-003: Tools list via JSON-RPC
- JSONRPC-004: Tools call via JSON-RPC
- JSONRPC-005: Method not found error
- JSONRPC-006: Invalid request error
- JSONRPC-007: User context propagation
- JSONRPC-008: Legacy message endpoint
- JSONRPC-009: Missing required parameters
- JSONRPC-010: Concurrent requests with ID matching
- JSONRPC-011: Empty params object
- JSONRPC-012: Tool execution failure

### 7. SSE Event Tests (12 tests)

- SSE-001: Connection establishment
- SSE-002: Event broadcasting (slow test)
- SSE-003: Event filtering
- SSE-004: Max clients limit (slow test)
- SSE-005: Client disconnect
- SSE-006: Heartbeat (slow test)
- SSE-007: CORS headers
- SSE-008: GET /mcp SSE
- SSE-009: Multiple filters
- SSE-010: Wildcard filter
- SSE-011: Empty filter parameter
- SSE-012: Rapid connect/disconnect

### 8. Error Handling Tests (10 tests)

- ERROR-001: EventsStreamManager initialization failure
- ERROR-002: GraphEngine failure
- ERROR-003: CapabilityDataService unavailable
- ERROR-004: Database connection loss (slow test)
- ERROR-005: Invalid JSON body
- ERROR-006: Missing required fields
- ERROR-007: Malformed Content-Type header
- ERROR-008: Very large request body (slow test)
- ERROR-009: Error responses include CORS headers
- ERROR-010: Server recovers from transient errors

### 9. Concurrency Tests (7 tests)

- CONCURRENCY-001: Concurrent API requests
- CONCURRENCY-002: Concurrent JSON-RPC calls
- CONCURRENCY-003: Mixed traffic pattern
- CONCURRENCY-004: SSE broadcast performance (slow test)
- CONCURRENCY-005: Sequential vs concurrent performance
- CONCURRENCY-006: No response mixing
- CONCURRENCY-007: Concurrent requests to different endpoints

### 10. Edge Case Tests (12 tests)

- EDGE-001: Empty database
- EDGE-002: Very large graph (slow test)
- EDGE-003: Query parameter edge cases
- EDGE-004: Special characters in IDs
- EDGE-005: Very long event filter
- EDGE-006: Rapid SSE connect/disconnect
- EDGE-007: Empty query strings
- EDGE-008: Unicode in parameters
- EDGE-009: Duplicate query parameters
- EDGE-010: Case sensitivity in paths
- EDGE-011: Very long URL (slow test)
- EDGE-012: Missing slash in path

## Test Helpers

The `fixtures/gateway-test-helpers.ts` file provides:

- **createTestGatewayServer()**: Creates a fully configured test gateway with all dependencies
- **makeGatewayRequest()**: Makes HTTP requests to the gateway with optional API key
- **makeJsonRpcRequest()**: Makes JSON-RPC requests with proper formatting
- **connectSSE()**: Establishes SSE connections with optional filtering
- **readSSEEvents()**: Parses SSE event stream
- **waitForSSEEvent()**: Waits for specific SSE event type
- **withEnv()**: Runs test with temporary environment variable
- **withCloudMode()**: Runs test in cloud mode (auth enabled)
- **withLocalMode()**: Runs test in local mode (auth disabled)
- **seedTestDatabase()**: Seeds database with test data
- **seedTestApiKeys()**: Creates test API keys for authentication testing

## Test Configuration

### Environment Variables

- `GITHUB_CLIENT_ID`: Set to enable cloud mode (API key required)
- `DOMAIN`: Custom domain for CORS configuration
- `FRESH_PORT`: Dashboard port (default: 8081)

### Slow Tests

Some tests are marked with `ignore: true` because they:

- Require significant time (e.g., waiting for rate limit reset)
- Are resource-intensive (e.g., 100+ SSE connections)
- Require external dependencies or specific setup

To run slow tests:

```bash
deno test tests/integration/mcp-gateway/ --allow-all --ignore=false
```

## Test Statistics

- **Total Tests**: 97
- **CRITICAL Priority**: ~15 tests
- **HIGH Priority**: ~30 tests
- **MEDIUM Priority**: ~35 tests
- **LOW Priority**: ~17 tests

## Coverage Goals

- **Endpoint Coverage**: 100% of documented API endpoints
- **Authentication Paths**: Both local and cloud modes
- **Error Scenarios**: All documented error codes
- **CORS**: All HTTP methods and endpoints
- **JSON-RPC**: All protocol methods and error codes

## Notes

1. **Port Selection**: Tests use `getRandomPort()` to avoid port conflicts when running in parallel
2. **Cleanup**: All tests properly clean up resources (close connections, stop servers)
3. **Realistic Testing**: Tests use actual HTTP server, not mocked transports
4. **Authentication**: Tests cover both local mode (auth bypass) and cloud mode (API key required)
5. **Rate Limiting**: Rate limit tests use smaller sample sizes to keep tests fast while verifying
   behavior
6. **SSE Tests**: Some SSE tests are marked as slow due to heartbeat intervals and event triggering
   requirements

## Troubleshooting

### Port Already in Use

If you see "Address already in use" errors:

```bash
# Kill any processes using test ports
pkill -f "deno test"
# Wait a moment for cleanup
sleep 2
# Rerun tests
deno test tests/integration/mcp-gateway/ --allow-all
```

### Database Connection Issues

Tests create temporary in-memory databases. If you see database errors:

- Ensure PGlite dependencies are installed
- Check that migrations are up to date
- Verify sufficient memory is available

### Test Timeouts

Some tests (especially concurrency tests) may timeout on slow systems:

```bash
# Increase timeout
deno test tests/integration/mcp-gateway/ --allow-all --timeout=60000
```

## Contributing

When adding new tests:

1. Follow the existing test ID convention (e.g., `CATEGORY-NNN`)
2. Add test description in the file header
3. Update this README with the new test
4. Use test helpers from `fixtures/gateway-test-helpers.ts`
5. Properly clean up resources in `finally` blocks
6. Mark slow tests with `ignore: true` and document why

## References

- [Integration Test Plan](../../../docs/sprint-artifacts/integration-test-plan-mcp-gateway.md)
- [Gateway Server Implementation](../../../src/mcp/gateway-server.ts)
- [HTTP Server Module](../../../src/mcp/server/http.ts)
- [Routing Module](../../../src/mcp/routing/mod.ts)
