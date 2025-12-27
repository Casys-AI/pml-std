/**
 * Unit Tests for SWC Code Analyzer
 *
 * Tests for the shared SWC-based parsing layer:
 * - analyzeCode() function
 * - MCP tool call extraction (mcp.server.tool)
 * - Capability reference extraction (capabilities.name, capabilities["name"])
 * - Argument extraction from tool calls
 * - Position tracking and offset calculations
 * - Error handling for invalid code
 * - Edge cases (empty code, complex nested structures)
 *
 * @module tests/unit/capabilities/swc-analyzer.test
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  analyzeCode,
  toOriginalPosition,
  WRAPPER_OFFSET,
} from "../../../src/capabilities/swc-analyzer.ts";

// =============================================================================
// Basic Analysis Tests
// =============================================================================

Deno.test("swc-analyzer - analyzeCode returns success for valid code", async () => {
  const result = await analyzeCode("const x = 1;");

  assertEquals(result.success, true);
  assertEquals(result.error, undefined);
});

Deno.test("swc-analyzer - analyzeCode handles empty code", async () => {
  const result = await analyzeCode("");

  assertEquals(result.success, true);
  assertEquals(result.capabilities.length, 0);
  assertEquals(result.tools.length, 0);
});

Deno.test("swc-analyzer - analyzeCode handles whitespace-only code", async () => {
  const result = await analyzeCode("   \n\t  ");

  assertEquals(result.success, true);
  assertEquals(result.capabilities.length, 0);
  assertEquals(result.tools.length, 0);
});

Deno.test("swc-analyzer - analyzeCode returns failure for invalid syntax", async () => {
  const result = await analyzeCode("const x = {{{");

  assertEquals(result.success, false);
  assertExists(result.error);
});

// =============================================================================
// MCP Tool Reference Detection
// =============================================================================

Deno.test("swc-analyzer - detects single MCP tool call", async () => {
  const code = `await mcp.filesystem.read_file({ path: "test.txt" });`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);
  assertEquals(result.tools[0].server, "filesystem");
  assertEquals(result.tools[0].tool, "read_file");
  assertEquals(result.tools[0].toolId, "filesystem:read_file");
});

Deno.test("swc-analyzer - detects multiple MCP tool calls", async () => {
  const code = `
    const file = await mcp.filesystem.read_file({ path: "input.txt" });
    const result = await mcp.ai.generate({ prompt: file.content });
    await mcp.filesystem.write_file({ path: "output.txt", content: result });
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 3);

  const toolIds = result.tools.map((t) => t.toolId);
  assertEquals(toolIds.includes("filesystem:read_file"), true);
  assertEquals(toolIds.includes("ai:generate"), true);
  assertEquals(toolIds.includes("filesystem:write_file"), true);
});

Deno.test("swc-analyzer - extracts arguments from tool call", async () => {
  const code = `await mcp.db.query({ table: "users", limit: 10, active: true });`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);

  const args = result.tools[0].arguments;
  assertExists(args);
  assertEquals(args.table, "users");
  assertEquals(args.limit, 10);
  assertEquals(args.active, true);
});

Deno.test("swc-analyzer - extracts null argument value", async () => {
  const code = `await mcp.api.request({ body: null });`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);
  assertEquals(result.tools[0].arguments?.body, null);
});

Deno.test("swc-analyzer - handles tool call without arguments", async () => {
  const code = `await mcp.system.status();`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);
  assertEquals(result.tools[0].toolId, "system:status");
  assertEquals(result.tools[0].arguments, undefined);
});

Deno.test("swc-analyzer - handles variable reference in arguments", async () => {
  const code = `
    const path = "/data/file.txt";
    await mcp.filesystem.read_file({ path: path });
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);

  // Variable references are returned as $varName placeholders
  assertEquals(result.tools[0].arguments?.path, "$path");
});

Deno.test("swc-analyzer - handles member expression in arguments", async () => {
  const code = `
    const config = { file: { path: "/data" } };
    await mcp.filesystem.read_file({ path: config.file.path });
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);

  // Member expressions are returned as $obj.prop format
  assertEquals(result.tools[0].arguments?.path, "$config.file.path");
});

Deno.test("swc-analyzer - handles nested object in arguments", async () => {
  const code = `await mcp.api.request({ headers: { "Content-Type": "application/json" } });`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);

  const headers = result.tools[0].arguments?.headers;
  assertExists(headers);
  assertEquals(typeof headers, "object");
});

// =============================================================================
// Capability Reference Detection
// =============================================================================

Deno.test("swc-analyzer - detects capability reference with dot notation", async () => {
  const code = `await capabilities.myCapability();`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.capabilities.length, 1);
  assertEquals(result.capabilities[0].name, "myCapability");
  assertEquals(result.capabilities[0].isDotNotation, true);
});

Deno.test("swc-analyzer - detects capability reference with bracket notation", async () => {
  const code = `await capabilities["my-capability-name"]();`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.capabilities.length, 1);
  assertEquals(result.capabilities[0].name, "my-capability-name");
  assertEquals(result.capabilities[0].isDotNotation, false);
});

Deno.test("swc-analyzer - detects capability reference with single quotes", async () => {
  const code = `await capabilities['anotherCapability']();`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.capabilities.length, 1);
  assertEquals(result.capabilities[0].name, "anotherCapability");
  assertEquals(result.capabilities[0].isDotNotation, false);
});

Deno.test("swc-analyzer - detects multiple capability references", async () => {
  const code = `
    const result1 = await capabilities.firstCapability();
    const result2 = await capabilities["second-capability"]();
    const result3 = await capabilities.thirdCapability();
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.capabilities.length, 3);

  const names = result.capabilities.map((c) => c.name);
  assertEquals(names.includes("firstCapability"), true);
  assertEquals(names.includes("second-capability"), true);
  assertEquals(names.includes("thirdCapability"), true);
});

Deno.test("swc-analyzer - detects both MCP tools and capabilities in same code", async () => {
  const code = `
    const data = await mcp.db.query({ table: "users" });
    const processed = await capabilities.processUsers(data);
    await mcp.memory.store({ key: "users", value: processed });
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 2);
  assertEquals(result.capabilities.length, 1);

  assertEquals(result.tools[0].toolId, "db:query");
  assertEquals(result.tools[1].toolId, "memory:store");
  assertEquals(result.capabilities[0].name, "processUsers");
});

// =============================================================================
// Position Tracking Tests
// =============================================================================

Deno.test("swc-analyzer - WRAPPER_OFFSET is correct", () => {
  // The wrapper is: `(async () => { ` which is 15 characters
  assertEquals(WRAPPER_OFFSET, 15);
});

Deno.test("swc-analyzer - toOriginalPosition subtracts offset", () => {
  assertEquals(toOriginalPosition(20), 5); // 20 - 15 = 5
  assertEquals(toOriginalPosition(15), 0); // 15 - 15 = 0
  assertEquals(toOriginalPosition(100), 85); // 100 - 15 = 85
});

Deno.test("swc-analyzer - tool references have start and end positions", async () => {
  const code = `await mcp.test.tool();`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);

  const tool = result.tools[0];
  assertExists(tool.start);
  assertExists(tool.end);
  assertEquals(tool.start < tool.end, true, "Start should be before end");
});

Deno.test("swc-analyzer - capability references have start and end positions", async () => {
  const code = `await capabilities.myCapability();`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.capabilities.length, 1);

  const cap = result.capabilities[0];
  assertExists(cap.start);
  assertExists(cap.end);
  assertEquals(cap.start < cap.end, true, "Start should be before end");
});

Deno.test("swc-analyzer - baseOffset is returned for position adjustment", async () => {
  const code = `const x = 1;`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertExists(result.baseOffset);
  assertEquals(typeof result.baseOffset, "number");
});

// =============================================================================
// Complex Code Patterns
// =============================================================================

Deno.test("swc-analyzer - handles Promise.all with MCP tools", async () => {
  const code = `
    const [users, items] = await Promise.all([
      mcp.db.query({ table: "users" }),
      mcp.db.query({ table: "items" })
    ]);
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 2);
  assertEquals(result.tools[0].toolId, "db:query");
  assertEquals(result.tools[1].toolId, "db:query");
});

Deno.test("swc-analyzer - handles if-else with MCP tools", async () => {
  const code = `
    if (condition) {
      await mcp.filesystem.read_file({ path: "a.txt" });
    } else {
      await mcp.filesystem.write_file({ path: "b.txt", content: "data" });
    }
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 2);

  const toolIds = result.tools.map((t) => t.toolId);
  assertEquals(toolIds.includes("filesystem:read_file"), true);
  assertEquals(toolIds.includes("filesystem:write_file"), true);
});

Deno.test("swc-analyzer - handles chained method calls", async () => {
  const code = `
    const result = await mcp.db.query({ table: "users" })
      .then(data => data.filter(u => u.active))
      .catch(err => console.error(err));
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);
  assertEquals(result.tools[0].toolId, "db:query");
});

Deno.test("swc-analyzer - handles try-catch with MCP tools", async () => {
  const code = `
    try {
      await mcp.filesystem.read_file({ path: "config.json" });
    } catch (error) {
      await mcp.logging.error({ message: error.message });
    }
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 2);

  const toolIds = result.tools.map((t) => t.toolId);
  assertEquals(toolIds.includes("filesystem:read_file"), true);
  assertEquals(toolIds.includes("logging:error"), true);
});

Deno.test("swc-analyzer - handles arrow function with MCP tool", async () => {
  const code = `
    const getData = async () => {
      return await mcp.api.fetch({ url: "https://example.com" });
    };
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);
  assertEquals(result.tools[0].toolId, "api:fetch");
});

Deno.test("swc-analyzer - handles loop with MCP tools", async () => {
  const code = `
    for (const item of items) {
      await mcp.db.insert({ table: "items", data: item });
    }
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);
  assertEquals(result.tools[0].toolId, "db:insert");
});

// =============================================================================
// Edge Cases
// =============================================================================

Deno.test("swc-analyzer - ignores non-mcp member expressions", async () => {
  const code = `
    const result = await something.else.entirely();
    console.log(result);
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 0);
});

Deno.test("swc-analyzer - ignores non-capabilities member expressions", async () => {
  const code = `
    const result = await otherObject.someMethod();
    const data = context.getValue();
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.capabilities.length, 0);
});

Deno.test("swc-analyzer - handles deeply nested MCP call", async () => {
  const code = `
    const result = await (async () => {
      const data = await mcp.nested.deep_call({ value: 42 });
      return data;
    })();
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);
  assertEquals(result.tools[0].toolId, "nested:deep_call");
});

Deno.test("swc-analyzer - handles template literal in arguments", async () => {
  const code = "await mcp.api.request({ url: `https://api.example.com/${id}` });";

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);
  // Template literals with expressions return placeholder for the expression
  // The argument may be undefined or a placeholder depending on implementation
  assertEquals(typeof result.tools[0].arguments, "object");
});

Deno.test("swc-analyzer - handles MCP tool with long server/tool names", async () => {
  const code =
    `await mcp.very_long_server_name.extremely_long_tool_name_that_goes_on({ param: "value" });`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);
  assertEquals(result.tools[0].server, "very_long_server_name");
  assertEquals(result.tools[0].tool, "extremely_long_tool_name_that_goes_on");
});

Deno.test("swc-analyzer - handles special characters in capability name (bracket notation)", async () => {
  const code = `await capabilities["my-capability-with-special_chars.v2"]();`;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.capabilities.length, 1);
  assertEquals(result.capabilities[0].name, "my-capability-with-special_chars.v2");
});

Deno.test("swc-analyzer - handles async/await properly", async () => {
  const code = `
    async function process() {
      const a = await mcp.step.one();
      const b = await mcp.step.two();
      return await mcp.step.three();
    }
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 3);
});

Deno.test("swc-analyzer - handles comments in code", async () => {
  const code = `
    // This is a comment
    await mcp.test.tool();
    /* Multi-line
       comment */
    await mcp.test.another();
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 2);
});

Deno.test("swc-analyzer - handles TypeScript type annotations", async () => {
  const code = `
    interface User { id: number; name: string; }
    const users: User[] = await mcp.db.query({ table: "users" });
  `;

  const result = await analyzeCode(code);

  assertEquals(result.success, true);
  assertEquals(result.tools.length, 1);
  assertEquals(result.tools[0].toolId, "db:query");
});
