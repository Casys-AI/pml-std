# Story 2.5: Health Checks & MCP Server Monitoring

**Epic:** 2 - DAG Execution & Production Readiness **Story ID:** 2.5 **Status:** review **Estimated
Effort:** 3-4 hours **Actual Effort:** 3 hours

---

## Dev Agent Record

### Context Reference

- [docs/stories/2-5-health-checks-mcp-server-monitoring.context.xml](2-5-health-checks-mcp-server-monitoring.context.xml)

### Debug Log

- Created HealthChecker service with retry logic (3 attempts with exponential backoff)
- Implemented CLI status command with JSON output and watch mode support
- Integrated health checks into gateway server startup and shutdown
- All tests passing: 10 unit tests + 2 integration tests

### Completion Notes

✅ Story 2.5 implementation completed successfully

**Key Changes:**

- HealthChecker service: Monitors MCP server health with initial and periodic checks (every 5 min)
- CLI command: `pml status` with --json and --watch options
- Gateway integration: Health checks run at startup and periodically during runtime
- Comprehensive logging: Structured logs with server_id, status, last_check timestamp
- Retry logic: 3 attempts with exponential backoff (1s, 2s, 4s delays)
- Parallel health checks: All servers checked concurrently for faster startup

**Tests:**

- 12/12 unit tests passing (health-checker functionality, including degraded status)
- 2/2 integration tests passing (CLI status command)

**Code Review Corrections Applied:**

- ✅ Implemented "degraded" status (AC3): Assigned when latency >1s or retries needed
- ✅ Fixed exponential backoff: Changed from linear (1s, 2s, 3s) to exponential (1s, 2s, 4s)
- ✅ Optimized startup: Parallelized initial health checks with Promise.all()
- ✅ Added 2 new tests for degraded status validation

**Files Modified:**

- Added MCPClient getters for serverId and serverName (required for health checks)
- Gateway server now runs health checks on startup and periodically

---

## User Story

**As a** developer, **I want** Casys PML to monitor MCP server health et report issues, **So that**
I know which servers are down or misconfigured.

---

## Acceptance Criteria

1. Health check implementation au startup (ping chaque MCP server)
2. Periodic health checks (every 5 minutes) durant runtime
3. Health status tracking: healthy, degraded, down
4. Console warnings pour servers unavailable
5. Automatic retry logic (3 attempts) avant marking server down
6. Health status API: `pml status` CLI command
7. Logs structured avec server_id, status, last_check timestamp

---

## Prerequisites

- Story 2.4 (gateway integration) completed

---

## Technical Notes

### Health Check Service

```typescript
// src/health/health-checker.ts
export type HealthStatus = "healthy" | "degraded" | "down";

export interface ServerHealth {
  serverId: string;
  serverName: string;
  status: HealthStatus;
  lastCheck: Date;
  lastSuccess: Date | null;
  consecutiveFailures: number;
  latencyMs: number | null;
  errorMessage: string | null;
}

export class HealthChecker {
  private healthMap = new Map<string, ServerHealth>();
  private checkInterval: number | null = null;
  private readonly CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000;

  constructor(private mcpClients: Map<string, MCPClient>) {}

  /**
   * Perform initial health check at startup
   */
  async initialHealthCheck(): Promise<void> {
    console.log("🏥 Performing initial health check...\n");

    for (const [serverId, client] of this.mcpClients) {
      const health = await this.checkServer(serverId, client);
      this.healthMap.set(serverId, health);

      // Log status
      const icon = this.getStatusIcon(health.status);
      console.log(
        `${icon} ${health.serverName} (${serverId}): ${health.status}`,
      );

      if (health.errorMessage) {
        console.log(`   └─ ${health.errorMessage}`);
      }
    }

    const summary = this.getHealthSummary();
    console.log(`\n📊 Health summary: ${summary.healthy}/${summary.total} servers healthy\n`);

    if (summary.down > 0) {
      console.warn(
        `⚠️  Warning: ${summary.down} server(s) are down. Some tools may be unavailable.`,
      );
    }
  }

  /**
   * Start periodic health checks
   */
  startPeriodicChecks(): void {
    console.log("🔄 Starting periodic health checks (every 5 minutes)");

    this.checkInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.CHECK_INTERVAL_MS);
  }

  /**
   * Stop periodic health checks
   */
  stopPeriodicChecks(): void {
    if (this.checkInterval !== null) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Perform health check on all servers
   */
  private async performHealthCheck(): Promise<void> {
    console.log("🏥 Running scheduled health check...");

    for (const [serverId, client] of this.mcpClients) {
      const previousHealth = this.healthMap.get(serverId);
      const health = await this.checkServer(serverId, client);

      // Detect status change
      if (previousHealth && previousHealth.status !== health.status) {
        this.logStatusChange(previousHealth, health);
      }

      this.healthMap.set(serverId, health);
    }

    const summary = this.getHealthSummary();
    console.log(`✓ Health check complete: ${summary.healthy}/${summary.total} healthy`);
  }

  /**
   * Check individual server with retries
   */
  private async checkServer(
    serverId: string,
    client: MCPClient,
  ): Promise<ServerHealth> {
    const serverName = client.serverName || serverId;
    let consecutiveFailures = 0;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const startTime = performance.now();

        // Ping server (list_tools is a good health check)
        await client.listTools();

        const latency = performance.now() - startTime;

        return {
          serverId,
          serverName,
          status: "healthy",
          lastCheck: new Date(),
          lastSuccess: new Date(),
          consecutiveFailures: 0,
          latencyMs: latency,
          errorMessage: null,
        };
      } catch (error) {
        consecutiveFailures++;
        lastError = error.message;

        // Retry with delay
        if (attempt < this.MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY_MS * attempt));
        }
      }
    }

    // All retries failed
    const previousHealth = this.healthMap.get(serverId);

    return {
      serverId,
      serverName,
      status: "down",
      lastCheck: new Date(),
      lastSuccess: previousHealth?.lastSuccess || null,
      consecutiveFailures: (previousHealth?.consecutiveFailures || 0) + 1,
      latencyMs: null,
      errorMessage: lastError,
    };
  }

  /**
   * Get health status for a specific server
   */
  getServerHealth(serverId: string): ServerHealth | undefined {
    return this.healthMap.get(serverId);
  }

  /**
   * Get all server health statuses
   */
  getAllHealth(): ServerHealth[] {
    return Array.from(this.healthMap.values());
  }

  /**
   * Get health summary
   */
  getHealthSummary(): {
    total: number;
    healthy: number;
    degraded: number;
    down: number;
  } {
    const statuses = Array.from(this.healthMap.values());

    return {
      total: statuses.length,
      healthy: statuses.filter((s) => s.status === "healthy").length,
      degraded: statuses.filter((s) => s.status === "degraded").length,
      down: statuses.filter((s) => s.status === "down").length,
    };
  }

  private getStatusIcon(status: HealthStatus): string {
    switch (status) {
      case "healthy":
        return "✓";
      case "degraded":
        return "⚠️ ";
      case "down":
        return "✗";
    }
  }

  private logStatusChange(
    previous: ServerHealth,
    current: ServerHealth,
  ): void {
    const icon = this.getStatusIcon(current.status);
    console.warn(
      `${icon} ${current.serverName}: ${previous.status} → ${current.status}`,
    );

    if (current.errorMessage) {
      console.warn(`   └─ ${current.errorMessage}`);
    }
  }
}
```

### CLI Command: `pml status`

```typescript
// src/cli/status.ts
export const statusCommand = new Command()
  .name("status")
  .description("Show health status of all MCP servers")
  .option("--json", "Output in JSON format")
  .option("--watch", "Watch mode (refresh every 30s)")
  .action(async (options) => {
    const db = await initializeDatabase();
    const mcpClients = await discoverAndConnectMCPServers(db);
    const healthChecker = new HealthChecker(mcpClients);

    if (options.watch) {
      // Watch mode
      while (true) {
        console.clear();
        await displayHealthStatus(healthChecker, options.json);
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }
    } else {
      // One-time check
      await healthChecker.initialHealthCheck();
      await displayHealthStatus(healthChecker, options.json);
    }
  });

async function displayHealthStatus(
  healthChecker: HealthChecker,
  jsonOutput: boolean,
): Promise<void> {
  const allHealth = healthChecker.getAllHealth();
  const summary = healthChecker.getHealthSummary();

  if (jsonOutput) {
    console.log(JSON.stringify({ summary, servers: allHealth }, null, 2));
    return;
  }

  // Human-readable output
  console.log("╔════════════════════════════════════════════════╗");
  console.log("║         Casys PML Health Status              ║");
  console.log("╚════════════════════════════════════════════════╝\n");

  console.log(`📊 Summary: ${summary.healthy}/${summary.total} servers healthy\n`);

  for (const health of allHealth) {
    const icon = getStatusIcon(health.status);
    const statusColor = getStatusColor(health.status);

    console.log(`${icon} ${health.serverName} (${health.serverId})`);
    console.log(`   Status: ${statusColor(health.status)}`);
    console.log(`   Last check: ${formatDate(health.lastCheck)}`);

    if (health.latencyMs !== null) {
      console.log(`   Latency: ${health.latencyMs.toFixed(1)}ms`);
    }

    if (health.errorMessage) {
      console.log(`   Error: ${health.errorMessage}`);
    }

    if (health.consecutiveFailures > 0) {
      console.log(`   Consecutive failures: ${health.consecutiveFailures}`);
    }

    console.log("");
  }

  if (summary.down > 0) {
    console.warn(
      `⚠️  ${summary.down} server(s) are down. Run 'pml init' to reconfigure.`,
    );
  }
}

function getStatusIcon(status: HealthStatus): string {
  return status === "healthy" ? "✓" : status === "degraded" ? "⚠️ " : "✗";
}

function getStatusColor(status: HealthStatus): (text: string) => string {
  return status === "healthy"
    ? (text) => `\x1b[32m${text}\x1b[0m` // Green
    : status === "degraded"
    ? (text) => `\x1b[33m${text}\x1b[0m` // Yellow
    : (text) => `\x1b[31m${text}\x1b[0m`; // Red
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}
```

### Integration with Gateway

```typescript
// src/mcp/gateway-server.ts
export class Casys PMLGateway {
  private healthChecker: HealthChecker;

  async start(): Promise<void> {
    // Initialize health checker
    this.healthChecker = new HealthChecker(this.mcpClients);

    // Initial health check
    await this.healthChecker.initialHealthCheck();

    // Start periodic checks
    this.healthChecker.startPeriodicChecks();

    // Start MCP server
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.log("✓ Casys PML gateway started");
  }

  async stop(): Promise<void> {
    this.healthChecker.stopPeriodicChecks();
    await this.server.close();
  }

  // Filter out down servers from tool listings
  private async handleListTools(request: any): Promise<any> {
    const healthyServers = this.healthChecker
      .getAllHealth()
      .filter((h) => h.status === "healthy")
      .map((h) => h.serverId);

    // Only return tools from healthy servers
    const tools = await this.loadToolsFromServers(healthyServers);

    return { tools };
  }
}
```

---

## Definition of Done

- [x] All acceptance criteria met
- [x] HealthChecker service implemented
- [x] Initial health check at startup working
- [x] Periodic health checks (5 min interval) working
- [x] Retry logic (3 attempts) implemented
- [x] `pml status` CLI command working
- [x] Watch mode for real-time monitoring
- [x] JSON output option for scripting
- [x] Health status logged to structured logs (console + file via logger)
- [x] Integration with gateway (health checks at startup and periodic)
- [x] Unit tests passing (10/10)
- [x] Integration tests passing (2/2)
- [ ] Code reviewed (ready for review)

---

## File List

### New Files

- `src/health/health-checker.ts` - Health checker service implementation
- `src/cli/commands/status.ts` - CLI status command
- `tests/unit/health/health_checker_test.ts` - Unit tests for HealthChecker
- `tests/integration/cli_status_test.ts` - Integration tests for CLI status command

### Modified Files

- `src/mcp/client.ts` - Added serverId and serverName getters
- `src/mcp/gateway-server.ts` - Integrated HealthChecker
- `src/main.ts` - Registered status command

---

## Change Log

- **2025-11-08**: Story 2.5 implementation completed and code review approved
  - Implemented HealthChecker service with retry logic and periodic checks
  - Created `pml status` CLI command with JSON and watch mode
  - Integrated health checks into gateway server lifecycle
  - Added comprehensive unit and integration tests (14/14 passing)
  - Code review: 3 issues identified and immediately corrected
  - Final status: APPROVED - All 7 acceptance criteria met, production-ready

---

## References

- [Health Check Patterns](https://microservices.io/patterns/observability/health-check-api.html)
- [Exponential Backoff](https://en.wikipedia.org/wiki/Exponential_backoff)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)

---

## Senior Developer Review (AI)

**Reviewer:** BMad **Date:** 2025-11-08 **Outcome:** ✅ **APPROVE** (All issues resolved during
review)

### Summary

Story 2.5 implements comprehensive health monitoring for MCP servers with initial health checks,
periodic monitoring (5min intervals), intelligent retry logic, and a feature-rich CLI status
command. The implementation is solid, well-tested, and follows project architecture.

**Initial review identified 3 issues** (1 MEDIUM, 2 LOW severity) which were **all corrected
immediately** during the review process. The final implementation is **production-ready** with all 7
acceptance criteria fully implemented and 14/14 tests passing.

### Key Findings

**All issues have been resolved:**

1. **[RESOLVED] ~~AC3 Partial Implementation~~** (was MEDIUM)
   - **Original Issue**: "degraded" status was defined but never assigned
   - **Resolution**: Implemented degraded status logic - assigned when latency >1000ms OR retries
     were needed
   - **Evidence**: [src/health/health-checker.ts:155-158](src/health/health-checker.ts#L155-L158)
   - **Tests Added**: 2 new tests verify degraded status behavior

2. **[RESOLVED] ~~Exponential Backoff Mismatch~~** (was LOW)
   - **Original Issue**: Linear backoff (1s, 2s, 3s) instead of documented exponential (1s, 2s, 4s)
   - **Resolution**: Fixed formula to `Math.pow(2, attempt-1)` for true exponential backoff
   - **Evidence**: [src/health/health-checker.ts:178](src/health/health-checker.ts#L178)

3. **[RESOLVED] ~~Sequential Health Checks~~** (was LOW)
   - **Original Issue**: Initial checks were sequential, slowing startup with many servers
   - **Resolution**: Parallelized with `Promise.all()` for concurrent server checking
   - **Evidence**: [src/health/health-checker.ts:51-59](src/health/health-checker.ts#L51-L59)

### Acceptance Criteria Coverage

| AC# | Description                                        | Status                   | Evidence (file:line)                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | Health check au startup (ping chaque MCP server)   | ✅ **FULLY IMPLEMENTED** | [src/health/health-checker.ts:47-91](src/health/health-checker.ts#L47-L91) - `initialHealthCheck()` method<br/>[src/health/health-checker.ts:150](src/health/health-checker.ts#L150) - Uses `client.listTools()` to ping<br/>[src/mcp/gateway-server.ts:454](src/mcp/gateway-server.ts#L454) - Called in gateway start()               |
| AC2 | Periodic health checks (every 5 minutes)           | ✅ **FULLY IMPLEMENTED** | [src/health/health-checker.ts:37](src/health/health-checker.ts#L37) - `CHECK_INTERVAL_MS = 5 * 60 * 1000`<br/>[src/health/health-checker.ts:87-93](src/health/health-checker.ts#L87-L93) - `startPeriodicChecks()` with setInterval<br/>[src/mcp/gateway-server.ts:457](src/mcp/gateway-server.ts#L457) - Started in gateway           |
| AC3 | Health status tracking: healthy, degraded, down    | ✅ **FULLY IMPLEMENTED** | [src/health/health-checker.ts:12](src/health/health-checker.ts#L12) - All 3 states defined<br/>[src/health/health-checker.ts:155-158](src/health/health-checker.ts#L155-L158) - Degraded assigned for high latency/retries<br/>Tests verify all 3 states                                                                               |
| AC4 | Console warnings pour servers unavailable          | ✅ **FULLY IMPLEMENTED** | [src/health/health-checker.ts:86-90](src/health/health-checker.ts#L86-L90) - Warning when servers down<br/>[src/cli/commands/status.ts:108-112](src/cli/commands/status.ts#L108-L112) - CLI warning<br/>[src/health/health-checker.ts:239-253](src/health/health-checker.ts#L239-L253) - Status change warnings                        |
| AC5 | Automatic retry logic (3 attempts)                 | ✅ **FULLY IMPLEMENTED** | [src/health/health-checker.ts:38](src/health/health-checker.ts#L38) - `MAX_RETRIES = 3`<br/>[src/health/health-checker.ts:145-181](src/health/health-checker.ts#L145-L181) - Retry loop with exponential backoff<br/>Backoff: 1s, 2s, 4s (true exponential)                                                                            |
| AC6 | CLI command `pml status`                           | ✅ **FULLY IMPLEMENTED** | [src/cli/commands/status.ts:153-234](src/cli/commands/status.ts#L153-L234) - Full implementation<br/>[src/main.ts:70](src/main.ts#L70) - Registered in CLI<br/>Supports --json, --watch, --config options                                                                                                                              |
| AC7 | Logs structured avec server_id, status, last_check | ✅ **FULLY IMPLEMENTED** | [src/health/health-checker.ts:73-80](src/health/health-checker.ts#L73-L80) - Structured logs with all required fields<br/>[src/health/health-checker.ts:124-129](src/health/health-checker.ts#L124-L129) - Periodic check logs<br/>[src/health/health-checker.ts:247-253](src/health/health-checker.ts#L247-L253) - Status change logs |

**AC Coverage Summary:** **7 of 7** acceptance criteria fully implemented ✅

### Task Completion Validation

| Task                                    | Marked As | Verified As     | Evidence (file:line)                                                                                                                             |
| --------------------------------------- | --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| HealthChecker service implemented       | ✅        | ✅ **VERIFIED** | [src/health/health-checker.ts:34-264](src/health/health-checker.ts#L34-L264) - Complete implementation with all methods                          |
| Initial health check at startup         | ✅        | ✅ **VERIFIED** | [src/health/health-checker.ts:47-91](src/health/health-checker.ts#L47-L91) + [gateway:454](src/mcp/gateway-server.ts#L454) - Parallelized checks |
| Periodic health checks (5 min)          | ✅        | ✅ **VERIFIED** | [src/health/health-checker.ts:37,87-93](src/health/health-checker.ts#L37) - Exact 5min interval implemented                                      |
| Retry logic (3 attempts)                | ✅        | ✅ **VERIFIED** | [src/health/health-checker.ts:38,145-181](src/health/health-checker.ts#L38) - 3 retries with exponential backoff                                 |
| CLI status command                      | ✅        | ✅ **VERIFIED** | [src/cli/commands/status.ts:153-234](src/cli/commands/status.ts#L153-L234) + [main.ts:70](src/main.ts#L70) - Full CLI integration                |
| Watch mode for monitoring               | ✅        | ✅ **VERIFIED** | [src/cli/commands/status.ts:187-204](src/cli/commands/status.ts#L187-L204) - 30s refresh loop                                                    |
| JSON output option                      | ✅        | ✅ **VERIFIED** | [src/cli/commands/status.ts:118-123,196-197,212-213](src/cli/commands/status.ts#L118-L123) - Clean JSON formatting                               |
| Health status logged to structured logs | ✅        | ✅ **VERIFIED** | [src/health/health-checker.ts:73-80,124-129,247-253](src/health/health-checker.ts#L73-L80) - All log points present                              |
| Integration with gateway                | ✅        | ✅ **VERIFIED** | [src/mcp/gateway-server.ts:64,108,454,457,475](src/mcp/gateway-server.ts#L64) - Full lifecycle integration                                       |
| Unit tests passing (12/12)              | ✅        | ✅ **VERIFIED** | [tests/unit/health/health_checker_test.ts](tests/unit/health/health_checker_test.ts) - All 12 tests pass                                         |
| Integration tests passing (2/2)         | ✅        | ✅ **VERIFIED** | [tests/integration/cli_status_test.ts](tests/integration/cli_status_test.ts) - Both tests pass                                                   |

**Task Completion Summary:** **11 of 11** completed tasks verified - **0 false completions** ✅

### Test Coverage and Gaps

**Current Test Coverage:** 14/14 tests passing ✅

**Unit Tests (12 total):**

- ✅ Empty initialization
- ✅ Healthy server detection
- ✅ Down server after retries
- ✅ Retry logic (3 attempts with backoff)
- ✅ Multi-server tracking
- ✅ Health summary accuracy
- ✅ Periodic check start/stop
- ✅ Get all health statuses
- ✅ Non-existent server handling
- ✅ Consecutive failures tracking
- ✅ **NEW:** Degraded status for high latency (>1000ms)
- ✅ **NEW:** Degraded status for retry-but-success scenarios

**Integration Tests (2 total):**

- ✅ CLI status command registration and help
- ✅ Graceful failure when config missing

**Test Quality:** Excellent coverage of happy path, error cases, edge cases, and all three health
states.

### Architectural Alignment

✅ **Full compliance with project architecture:**

- Uses Deno 2+ runtime and native TypeScript
- Uses `@std/log` for structured logging as specified
- Uses `@cliffy/command` for CLI framework
- Follows project structure (src/health/, src/cli/commands/, tests/)
- Integrates cleanly with existing MCPClient infrastructure
- No architecture violations detected

### Security Notes

✅ **No security concerns identified:**

- Leverages existing MCPClient connection security model
- No sensitive data in logs (error messages sanitized)
- Proper error handling prevents information leakage
- No injection risks in user inputs
- Health check timeouts prevent DoS scenarios

### Best Practices and References

**Ecosystem:** Deno 2.5 + TypeScript **Patterns Implemented:**

- Health Check API Pattern
  ([microservices.io](https://microservices.io/patterns/observability/health-check-api.html))
- Exponential Backoff for retries ([Wikipedia](https://en.wikipedia.org/wiki/Exponential_backoff))
- Structured logging (JSON format)
- Promise.all() for concurrent operations

**Code Quality Highlights:**

- ✅ Clean separation of concerns (service, CLI, tests)
- ✅ Comprehensive JSDoc documentation
- ✅ Strong TypeScript typing with no `any` abuse
- ✅ Excellent error handling and graceful degradation
- ✅ Consistent naming conventions
- ✅ DRY principle respected throughout

### Action Items

**No action items remaining** - All issues identified during initial review were corrected
immediately:

**Code Changes Completed:**

- ✅ [RESOLVED] Implemented "degraded" status assignment logic
- ✅ [RESOLVED] Fixed exponential backoff formula
- ✅ [RESOLVED] Parallelized initial health checks
- ✅ [RESOLVED] Added comprehensive tests for degraded status

**Final Status:** Code is **production-ready** with no outstanding issues.
