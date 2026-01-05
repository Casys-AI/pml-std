# Integration Test Plan Summary: MCP Gateway Server

**Document:** integration-test-plan-mcp-gateway.md **Status:** Ready for Implementation **Total
Tests:** 62 test cases **Estimated Effort:** 4 weeks (102 hours)

## Overview

This integration test plan provides comprehensive coverage for the MCP Gateway Server's HTTP
transport functionality following its modular refactoring. The plan is designed for systematic
quality assurance with risk-based prioritization.

## Test Coverage Breakdown

### By Category

| Category          | Test Count | Priority Distribution                      | Est. Time |
| ----------------- | ---------- | ------------------------------------------ | --------- |
| Server Lifecycle  | 3          | 2 CRITICAL, 1 HIGH                         | 5h        |
| Authentication    | 5          | 3 CRITICAL, 2 HIGH                         | 7h        |
| Rate Limiting     | 5          | 2 HIGH, 2 MEDIUM, 1 LOW                    | 8h        |
| CORS Handling     | 4          | 1 CRITICAL, 1 HIGH, 2 MEDIUM               | 4h        |
| API Endpoints     | 15         | 1 CRITICAL, 6 HIGH, 7 MEDIUM, 1 LOW        | 26h       |
| JSON-RPC Protocol | 8          | 4 CRITICAL, 2 HIGH, 1 MEDIUM, 1 LOW        | 12h       |
| SSE Event Stream  | 8          | 2 HIGH, 4 MEDIUM, 2 LOW                    | 12h       |
| Error Handling    | 6          | 3 HIGH, 3 MEDIUM                           | 7h        |
| Concurrency       | 4          | 2 HIGH, 2 MEDIUM                           | 8h        |
| Edge Cases        | 6          | 2 MEDIUM, 4 LOW                            | 9h        |
| **TOTAL**         | **62**     | **12 CRITICAL, 21 HIGH, 23 MEDIUM, 6 LOW** | **102h**  |

### By Priority

| Priority | Count | Purpose                                                                              |
| -------- | ----- | ------------------------------------------------------------------------------------ |
| CRITICAL | 12    | Core functionality must work (authentication, protocol compliance, server lifecycle) |
| HIGH     | 21    | Important features and security (rate limiting, error handling, main endpoints)      |
| MEDIUM   | 23    | Extended functionality and edge cases                                                |
| LOW      | 6     | Nice-to-have validations and rarely-used features                                    |

## API Surface Coverage

### Endpoints Tested (15 total)

**Health & Events (3):**

- GET /health (public)
- GET /events/stream (SSE)
- GET /dashboard (redirect)

**Graph API (4):**

- GET /api/graph/snapshot
- GET /api/graph/path
- GET /api/graph/related
- GET /api/graph/hypergraph

**Capabilities API (4):**

- GET /api/capabilities
- GET /api/capabilities/:id/dependencies
- POST /api/capabilities/:id/dependencies
- DELETE /api/capabilities/:from/dependencies/:to

**Other API (2):**

- GET /api/metrics
- GET /api/tools/search

**JSON-RPC (2):**

- POST /mcp (JSON-RPC + SSE)
- POST /message (legacy)

## Key Test Scenarios

### Critical Path Tests (Must Pass)

1. **Server Lifecycle**
   - HTTP server starts and binds to port 3003
   - Graceful shutdown closes all connections
   - Server can restart without resource leaks

2. **Authentication Flow**
   - Local mode: All requests succeed without API key
   - Cloud mode: Protected routes require valid API key
   - Invalid API keys rejected with 401 Unauthorized

3. **JSON-RPC Protocol Compliance**
   - MCP initialize handshake works correctly
   - tools/list returns meta-tools
   - tools/call executes and returns results
   - Error codes follow JSON-RPC 2.0 spec

4. **CORS Handling**
   - OPTIONS preflight returns correct headers
   - All responses include CORS headers
   - Origin configuration respects environment

### High-Value Tests (Quality Gates)

1. **Rate Limiting**
   - MCP endpoint: 100 requests/minute enforced
   - API endpoints: 200 requests/minute enforced
   - Rate limits isolated per user
   - Window resets after 60 seconds

2. **SSE Event Streaming**
   - Clients can establish SSE connections
   - Events broadcast to all connected clients
   - Event filtering with ?filter= parameter
   - Max 100 concurrent clients enforced

3. **Error Handling**
   - Dependency failures return appropriate HTTP codes
   - Invalid JSON returns 400 with error message
   - Missing required fields validated

4. **API Endpoint Functionality**
   - Graph snapshot returns nodes/edges
   - Path finding returns shortest path
   - Hypergraph generation with filters
   - Capabilities CRUD operations

### Edge Cases and Stress Tests

1. **Concurrency**
   - 50 concurrent API requests
   - 20 concurrent JSON-RPC calls
   - Mixed traffic patterns
   - 100 SSE clients with event broadcast

2. **Boundary Conditions**
   - Empty database handling
   - Very large graphs (10,000 nodes)
   - Query parameter edge cases (negative, overflow)
   - Special characters in IDs

3. **Resource Management**
   - Rapid SSE connect/disconnect cycles
   - Multiple start/stop cycles
   - Memory leak detection

## Test Implementation Strategy

### Phase 1: Core Functionality (Week 1)

**Focus:** Get the basics working

- Server lifecycle (3 tests)
- Authentication (5 tests)
- Basic API endpoints (5 tests)
- Core JSON-RPC protocol (4 tests)

**Exit Criteria:** Server stable, auth works, basic endpoints functional

### Phase 2: Extended API Coverage (Week 2)

**Focus:** Complete API surface testing

- Remaining API endpoints (10 tests)
- CORS handling (4 tests)
- Error handling (6 tests)

**Exit Criteria:** All endpoints tested, error handling comprehensive

### Phase 3: Advanced Features (Week 3)

**Focus:** Real-time and security features

- SSE event streaming (8 tests)
- Rate limiting (5 tests)
- JSON-RPC edge cases (4 tests)

**Exit Criteria:** SSE reliable, rate limiting effective

### Phase 4: Stress and Edge Cases (Week 4)

**Focus:** Production readiness

- Concurrency tests (4 tests)
- Edge cases (6 tests)
- Integration with existing test suite
- Performance profiling

**Exit Criteria:** No concurrency issues, edge cases handled, full suite passes

## Test Infrastructure

### Required Test Fixtures

1. **Gateway Test Helpers** (`gateway-test-helpers.ts`)
   - `createTestGatewayServer()` - Initialize with all dependencies
   - `makeGatewayRequest()` - HTTP request helper with auth
   - `makeJsonRpcRequest()` - JSON-RPC request helper
   - `connectSSE()` - SSE connection helper
   - `parseSSEStream()` - SSE event parser

2. **Environment Helpers** (`test-env.ts`)
   - `withEnv()` - Temporarily set environment variables
   - `withCloudMode()` - Test in cloud auth mode
   - `withLocalMode()` - Test in local auth mode

3. **Test Data Seeders** (`test-data.ts`)
   - `seedTestApiKeys()` - Create valid API keys in DB
   - `seedTestGraph()` - Populate graph with test data
   - `seedTestCapabilities()` - Create test capabilities

### Test Organization

```
tests/integration/mcp-gateway/
├── fixtures/
│   ├── gateway-test-helpers.ts
│   ├── test-env.ts
│   └── test-data.ts
├── 01-lifecycle.test.ts
├── 02-authentication.test.ts
├── 03-rate-limiting.test.ts
├── 04-cors.test.ts
├── 05-api-endpoints.test.ts
├── 06-jsonrpc.test.ts
├── 07-sse-events.test.ts
├── 08-error-handling.test.ts
├── 09-concurrency.test.ts
└── 10-edge-cases.test.ts
```

## Success Criteria

### Coverage Targets

- Endpoint Coverage: 100% (15/15 endpoints)
- Authentication Paths: 100% (local + cloud modes)
- Error Scenarios: All JSON-RPC error codes tested
- CORS: All HTTP methods tested

### Quality Metrics

- Pass Rate: 100% (62/62 tests pass)
- Flaky Tests: 0 (deterministic tests only)
- Execution Time: < 5 minutes for full suite
- Code Coverage: > 80% for gateway-server.ts and routing modules

### Documentation

- All tests documented with ID, description, expected results
- Test fixtures well-documented
- Example requests/responses provided
- Troubleshooting guide available

## Risk Assessment

### High-Risk Areas

1. **SSE Connection Management** (RISK: Memory Leaks)
   - **Mitigation:** Track client count, verify cleanup after disconnect
   - **Tests:** SSE-005 (disconnect), EDGE-006 (rapid churn)

2. **Rate Limiting** (RISK: Timing Sensitivity)
   - **Mitigation:** Use generous margins, reset state between tests
   - **Tests:** RATE-004 (window reset) with 61s wait

3. **Authentication** (RISK: Database Dependency)
   - **Mitigation:** Use test database seeding, cleanup after tests
   - **Tests:** AUTH-003 (valid key) with seedTestApiKeys()

4. **Concurrency** (RISK: Race Conditions)
   - **Mitigation:** Use barriers, verify response IDs match
   - **Tests:** CONCURRENCY-002 (JSON-RPC ID matching)

## Dependencies

### Testing Infrastructure

- Deno test runner (built-in)
- @std/assert for assertions
- Mock MCP clients (from existing fixtures)
- Test database utilities (from test-helpers.ts)
- SSE polyfill/parser (custom implementation)

### External Services

- PGlite database (test instance)
- Mock embedding model (SemanticMockEmbedding)
- Mock MCP servers (filesystem, json)

### Environment Requirements

- Available port 3003 (configurable)
- Write access for test database directory
- Environment variable control (Deno.env)

## Next Steps

### Immediate Actions (Day 1)

1. Review test plan with stakeholders
2. Prioritize tests based on release timeline
3. Set up test infrastructure (fixtures, helpers)
4. Implement Phase 1 (CRITICAL tests)

### Short-Term (Week 1-2)

1. Complete Phase 1 and Phase 2 tests
2. Address any architectural issues discovered
3. Document test failures and patterns
4. Set up CI integration

### Medium-Term (Week 3-4)

1. Complete Phase 3 and Phase 4 tests
2. Performance profiling and optimization
3. Integration with existing test suite
4. Final documentation and knowledge transfer

### Long-Term (Post-Release)

1. Monitor flaky test patterns
2. Add regression tests for bugs discovered
3. Expand concurrency test coverage
4. Performance benchmarking suite

## Conclusion

This integration test plan provides comprehensive coverage of the MCP Gateway Server with 62
well-defined test cases organized into 10 categories. The systematic approach with phased
implementation ensures critical functionality is validated first, while edge cases and stress tests
build confidence for production deployment.

**Key Strengths:**

- Risk-based prioritization (CRITICAL tests first)
- Complete API surface coverage (15 endpoints)
- Clear success criteria and quality metrics
- Practical test implementation patterns
- Realistic timeline with buffer (4 weeks)

**Recommended Action:** Approve plan and begin Phase 1 implementation immediately, targeting Week 1
completion of all CRITICAL tests.
