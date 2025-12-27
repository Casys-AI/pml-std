/**
 * Unit Tests: WorkerBridge Code Task Tracing
 *
 * Tests for Phase 1 modular DAG execution - tracing code operations
 * via WorkerBridge.executeCodeTask() for SHGAT learning.
 *
 * Coverage:
 * - executeCodeTask() emits tool_start/tool_end traces
 * - Traces include correct tool name (code:filter, code:map, etc.)
 * - Traces include timing and result information
 * - Error cases emit proper error traces
 * - getTraces() returns sorted traces
 *
 * @module tests/unit/sandbox/worker-bridge-code-tracing.test
 */

import { assertEquals, assertExists } from "@std/assert";
import { WorkerBridge } from "../../../src/sandbox/worker-bridge.ts";
import type { MCPClientBase } from "../../../src/mcp/types.ts";

/**
 * Create empty MCP clients map for testing
 */
function createEmptyMCPClients(): Map<string, MCPClientBase> {
  return new Map();
}

// =============================================================================
// executeCodeTask Trace Emission
// =============================================================================

Deno.test({
  name: "WorkerBridge.executeCodeTask - emits tool_start and tool_end traces",
  sanitizeResources: false, // Worker uses resources
  sanitizeOps: false, // Worker has async ops
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      const result = await bridge.executeCodeTask(
        "code:filter",
        "return [1, 2, 3].filter(x => x > 1);",
        {},
        [],
      );

      assertEquals(result.success, true, "Should execute successfully");

      const traces = bridge.getTraces();

      // Should have at least tool_start and tool_end
      const toolStartTraces = traces.filter((t) => t.type === "tool_start");
      const toolEndTraces = traces.filter((t) => t.type === "tool_end");

      assertEquals(toolStartTraces.length >= 1, true, "Should have tool_start trace");
      assertEquals(toolEndTraces.length >= 1, true, "Should have tool_end trace");

      // Verify tool name in traces
      const codeFilterStart = toolStartTraces.find(
        (t) => t.type === "tool_start" && t.tool === "code:filter"
      );
      const codeFilterEnd = toolEndTraces.find(
        (t) => t.type === "tool_end" && t.tool === "code:filter"
      );

      assertExists(codeFilterStart, "Should have code:filter tool_start");
      assertExists(codeFilterEnd, "Should have code:filter tool_end");
    } finally {
      await bridge.terminate();
    }
  },
});

Deno.test({
  name: "WorkerBridge.executeCodeTask - traces include timing information",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      await bridge.executeCodeTask(
        "code:map",
        "return [1, 2, 3].map(x => x * 2);",
        {},
        [],
      );

      const traces = bridge.getTraces();

      const toolEndTrace = traces.find(
        (t) => t.type === "tool_end" && t.tool === "code:map"
      );

      assertExists(toolEndTrace, "Should have tool_end trace");

      if (toolEndTrace?.type === "tool_end") {
        assertExists(toolEndTrace.ts, "Should have timestamp");
        assertExists(toolEndTrace.durationMs, "Should have duration");
        assertEquals(toolEndTrace.durationMs >= 0, true, "Duration should be non-negative");
      }
    } finally {
      await bridge.terminate();
    }
  },
});

Deno.test({
  name: "WorkerBridge.executeCodeTask - traces include result for successful execution",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      await bridge.executeCodeTask(
        "code:reduce",
        "return [1, 2, 3, 4].reduce((a, b) => a + b, 0);",
        {},
        [],
      );

      const traces = bridge.getTraces();

      const toolEndTrace = traces.find(
        (t) => t.type === "tool_end" && t.tool === "code:reduce"
      );

      assertExists(toolEndTrace, "Should have tool_end trace");

      if (toolEndTrace?.type === "tool_end") {
        assertEquals(toolEndTrace.success, true, "Should be marked successful");
        assertEquals(toolEndTrace.result, 10, "Result should be 10");
      }
    } finally {
      await bridge.terminate();
    }
  },
});

Deno.test({
  name: "WorkerBridge.executeCodeTask - traces include error for failed execution",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      const result = await bridge.executeCodeTask(
        "code:filter",
        "throw new Error('Intentional test error');",
        {},
        [],
      );

      assertEquals(result.success, false, "Should fail");

      const traces = bridge.getTraces();

      const toolEndTrace = traces.find(
        (t) => t.type === "tool_end" && t.tool === "code:filter"
      );

      assertExists(toolEndTrace, "Should have tool_end trace");

      if (toolEndTrace?.type === "tool_end") {
        assertEquals(toolEndTrace.success, false, "Should be marked failed");
        assertExists(toolEndTrace.error, "Should have error message");
      }
    } finally {
      await bridge.terminate();
    }
  },
});

// =============================================================================
// Context Passing
// =============================================================================

Deno.test({
  name: "WorkerBridge.executeCodeTask - receives context variables",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      const context = {
        users: [
          { name: "Alice", active: true },
          { name: "Bob", active: false },
          { name: "Charlie", active: true },
        ],
      };

      const result = await bridge.executeCodeTask(
        "code:filter",
        "return users.filter(u => u.active);",
        context,
        [],
      );

      assertEquals(result.success, true, "Should execute successfully");
      assertEquals(Array.isArray(result.result), true, "Should return array");
      assertEquals((result.result as unknown[]).length, 2, "Should have 2 active users");
    } finally {
      await bridge.terminate();
    }
  },
});

// =============================================================================
// Multiple Code Operations - Trace Accumulation
// =============================================================================

Deno.test({
  name: "WorkerBridge.executeCodeTask - traces accumulate across multiple operations",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      // Execute first operation
      await bridge.executeCodeTask(
        "code:filter",
        "return [1, 2, 3, 4, 5].filter(x => x > 2);",
        {},
        [],
      );

      // Execute second operation
      await bridge.executeCodeTask(
        "code:map",
        "return [3, 4, 5].map(x => x * 10);",
        {},
        [],
      );

      // Execute third operation
      await bridge.executeCodeTask(
        "code:reduce",
        "return [30, 40, 50].reduce((a, b) => a + b, 0);",
        {},
        [],
      );

      const traces = bridge.getTraces();

      // Should have 6 traces: 3 start + 3 end (traces accumulate now!)
      const toolStartTraces = traces.filter((t) => t.type === "tool_start");
      const toolEndTraces = traces.filter((t) => t.type === "tool_end");

      assertEquals(toolStartTraces.length, 3, "Should have 3 tool_start traces");
      assertEquals(toolEndTraces.length, 3, "Should have 3 tool_end traces");

      // Verify each operation was traced
      const toolNames = toolEndTraces.map((t) => (t as { tool: string }).tool);
      assertEquals(toolNames.includes("code:filter"), true, "Should have filter trace");
      assertEquals(toolNames.includes("code:map"), true, "Should have map trace");
      assertEquals(toolNames.includes("code:reduce"), true, "Should have reduce trace");
    } finally {
      await bridge.terminate();
    }
  },
});

// =============================================================================
// Trace Ordering
// =============================================================================

Deno.test({
  name: "WorkerBridge.getTraces - returns traces sorted by timestamp",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      await bridge.executeCodeTask("code:filter", "return [1].filter(x => x);", {}, []);
      await bridge.executeCodeTask("code:map", "return [1].map(x => x);", {}, []);

      const traces = bridge.getTraces();

      // Verify traces are sorted by timestamp
      for (let i = 1; i < traces.length; i++) {
        assertEquals(
          traces[i].ts >= traces[i - 1].ts,
          true,
          `Trace ${i} should have timestamp >= trace ${i - 1}`
        );
      }
    } finally {
      await bridge.terminate();
    }
  },
});

// =============================================================================
// Trace IDs
// =============================================================================

Deno.test({
  name: "WorkerBridge.executeCodeTask - each operation has unique traceId",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      await bridge.executeCodeTask("code:filter", "return [1];", {}, []);
      await bridge.executeCodeTask("code:map", "return [2];", {}, []);

      const traces = bridge.getTraces();

      // Each operation should have a unique traceId
      const codeTraces = traces.filter(t =>
        t.type === "tool_start" || t.type === "tool_end"
      );
      const traceIds = new Set(codeTraces.map((t) => t.traceId));

      // Should have 2 unique traceIds (one per operation)
      assertEquals(traceIds.size, 2, "Should have 2 unique traceIds");

      // Verify start/end pairs have matching traceIds
      const filterStart = traces.find(t => t.type === "tool_start" && t.tool === "code:filter");
      const filterEnd = traces.find(t => t.type === "tool_end" && t.tool === "code:filter");
      assertEquals(filterStart?.traceId, filterEnd?.traceId, "Filter start/end should have same traceId");

      const mapStart = traces.find(t => t.type === "tool_start" && t.tool === "code:map");
      const mapEnd = traces.find(t => t.type === "tool_end" && t.tool === "code:map");
      assertEquals(mapStart?.traceId, mapEnd?.traceId, "Map start/end should have same traceId");
    } finally {
      await bridge.terminate();
    }
  },
});

// =============================================================================
// Object/Math/JSON Operations
// =============================================================================

Deno.test({
  name: "WorkerBridge.executeCodeTask - traces Object operations",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      await bridge.executeCodeTask(
        "code:Object.keys",
        "return Object.keys({ a: 1, b: 2, c: 3 });",
        {},
        [],
      );

      const traces = bridge.getTraces();

      const toolEndTrace = traces.find(
        (t) => t.type === "tool_end" && t.tool === "code:Object.keys"
      );

      assertExists(toolEndTrace, "Should have code:Object.keys trace");

      if (toolEndTrace?.type === "tool_end") {
        assertEquals(toolEndTrace.success, true);
        assertEquals(toolEndTrace.result, ["a", "b", "c"]);
      }
    } finally {
      await bridge.terminate();
    }
  },
});

Deno.test({
  name: "WorkerBridge.executeCodeTask - traces Math operations",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      await bridge.executeCodeTask(
        "code:Math.max",
        "return Math.max(1, 5, 3, 9, 2);",
        {},
        [],
      );

      const traces = bridge.getTraces();

      const toolEndTrace = traces.find(
        (t) => t.type === "tool_end" && t.tool === "code:Math.max"
      );

      assertExists(toolEndTrace, "Should have code:Math.max trace");

      if (toolEndTrace?.type === "tool_end") {
        assertEquals(toolEndTrace.success, true);
        assertEquals(toolEndTrace.result, 9);
      }
    } finally {
      await bridge.terminate();
    }
  },
});

Deno.test({
  name: "WorkerBridge.executeCodeTask - traces JSON operations",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mcpClients = createEmptyMCPClients();
    const bridge = new WorkerBridge(mcpClients, { timeout: 5000 });

    try {
      await bridge.executeCodeTask(
        "code:JSON.parse",
        'return JSON.parse(\'{"name":"test","value":42}\');',
        {},
        [],
      );

      const traces = bridge.getTraces();

      const toolEndTrace = traces.find(
        (t) => t.type === "tool_end" && t.tool === "code:JSON.parse"
      );

      assertExists(toolEndTrace, "Should have code:JSON.parse trace");

      if (toolEndTrace?.type === "tool_end") {
        assertEquals(toolEndTrace.success, true);
        assertEquals((toolEndTrace.result as { name: string }).name, "test");
        assertEquals((toolEndTrace.result as { value: number }).value, 42);
      }
    } finally {
      await bridge.terminate();
    }
  },
});
