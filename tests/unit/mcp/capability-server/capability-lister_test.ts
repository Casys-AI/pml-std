/**
 * Tests for CapabilityListerService
 *
 * Story 13.3: CapabilityMCPServer + Gateway
 * AC1: Tool Listing - returns tools with mcp__namespace__action format
 * AC4: InputSchema from parameters_schema
 * AC7: Immediate Visibility - fresh query
 */

import { assertEquals, assertExists } from "@std/assert";
import { CapabilityListerService } from "../../../../src/mcp/capability-server/services/capability-lister.ts";
import type {
  CapabilityWithSchema,
  ListWithSchemasOptions,
} from "../../../../src/capabilities/types.ts";

// Mock CapabilityStore
class MockCapabilityStore {
  private capabilities: CapabilityWithSchema[] = [];

  setCapabilities(caps: CapabilityWithSchema[]): void {
    this.capabilities = caps;
  }

  async listWithSchemas(_options: ListWithSchemasOptions): Promise<CapabilityWithSchema[]> {
    return this.capabilities;
  }
}

Deno.test("CapabilityListerService - listTools returns empty array when no capabilities", async () => {
  const mockStore = new MockCapabilityStore();
  // @ts-ignore - mock
  const lister = new CapabilityListerService(mockStore);

  const tools = await lister.listTools();

  assertEquals(tools, []);
});

Deno.test("CapabilityListerService - AC1: returns tools with mcp__namespace__action format", async () => {
  const mockStore = new MockCapabilityStore();
  mockStore.setCapabilities([
    {
      id: "cap-1",
      namespace: "code",
      action: "analyze",
      displayName: "code:analyze",
      description: "Analyze code structure",
      parametersSchema: { type: "object", properties: { file: { type: "string" } } },
      usageCount: 10,
    },
    {
      id: "cap-2",
      namespace: "data",
      action: "transform",
      displayName: "data:transform",
      description: "Transform data",
      parametersSchema: null,
      usageCount: 5,
    },
  ]);

  // @ts-ignore - mock
  const lister = new CapabilityListerService(mockStore);
  const tools = await lister.listTools();

  assertEquals(tools.length, 2);
  assertEquals(tools[0].name, "mcp__code__analyze");
  assertEquals(tools[1].name, "mcp__data__transform");
});

Deno.test("CapabilityListerService - AC4: inputSchema from parameters_schema", async () => {
  const mockStore = new MockCapabilityStore();
  const schema = {
    type: "object",
    properties: {
      file: { type: "string", description: "File path" },
      options: { type: "object" },
    },
    required: ["file"],
  };

  mockStore.setCapabilities([
    {
      id: "cap-1",
      namespace: "code",
      action: "analyze",
      displayName: "code:analyze",
      description: "Analyze code",
      parametersSchema: schema,
      usageCount: 10,
    },
  ]);

  // @ts-ignore - mock
  const lister = new CapabilityListerService(mockStore);
  const tools = await lister.listTools();

  assertEquals(tools.length, 1);
  assertEquals(tools[0].inputSchema, schema);
});

Deno.test("CapabilityListerService - default schema when parameters_schema is null", async () => {
  const mockStore = new MockCapabilityStore();
  mockStore.setCapabilities([
    {
      id: "cap-1",
      namespace: "test",
      action: "run",
      displayName: "test:run",
      description: "Run tests",
      parametersSchema: null,
      usageCount: 1,
    },
  ]);

  // @ts-ignore - mock
  const lister = new CapabilityListerService(mockStore);
  const tools = await lister.listTools();

  assertEquals(tools.length, 1);
  assertExists(tools[0].inputSchema);
  assertEquals(tools[0].inputSchema.type, "object");
  assertEquals(tools[0].inputSchema.properties, {});
});

Deno.test("CapabilityListerService - description falls back to displayName", async () => {
  const mockStore = new MockCapabilityStore();
  mockStore.setCapabilities([
    {
      id: "cap-1",
      namespace: "my_namespace",
      action: "my_action",
      displayName: "My Cool Capability",
      description: null, // No description
      parametersSchema: null,
      usageCount: 1,
    },
  ]);

  // @ts-ignore - mock
  const lister = new CapabilityListerService(mockStore);
  const tools = await lister.listTools();

  assertEquals(tools.length, 1);
  assertEquals(tools[0].description, "Capability: My Cool Capability");
});

Deno.test("CapabilityListerService - uses description when available", async () => {
  const mockStore = new MockCapabilityStore();
  mockStore.setCapabilities([
    {
      id: "cap-1",
      namespace: "api",
      action: "fetch",
      displayName: "api:fetch",
      description: "Fetch data from API endpoint",
      parametersSchema: null,
      usageCount: 1,
    },
  ]);

  // @ts-ignore - mock
  const lister = new CapabilityListerService(mockStore);
  const tools = await lister.listTools();

  assertEquals(tools.length, 1);
  assertEquals(tools[0].description, "Fetch data from API endpoint");
});

Deno.test("CapabilityListerService - handles multiple capabilities", async () => {
  const mockStore = new MockCapabilityStore();
  mockStore.setCapabilities([
    {
      id: "cap-1",
      namespace: "code",
      action: "analyze",
      displayName: "code:analyze",
      description: "Analyze code",
      parametersSchema: { type: "object" },
      usageCount: 100,
    },
    {
      id: "cap-2",
      namespace: "code",
      action: "refactor",
      displayName: "code:refactor",
      description: "Refactor code",
      parametersSchema: { type: "object" },
      usageCount: 50,
    },
    {
      id: "cap-3",
      namespace: "data",
      action: "transform",
      displayName: "data:transform",
      description: "Transform data",
      parametersSchema: { type: "object" },
      usageCount: 25,
    },
  ]);

  // @ts-ignore - mock
  const lister = new CapabilityListerService(mockStore);
  const tools = await lister.listTools();

  assertEquals(tools.length, 3);

  // Verify all have correct format
  const names = tools.map((t) => t.name);
  assertEquals(names.includes("mcp__code__analyze"), true);
  assertEquals(names.includes("mcp__code__refactor"), true);
  assertEquals(names.includes("mcp__data__transform"), true);
});
