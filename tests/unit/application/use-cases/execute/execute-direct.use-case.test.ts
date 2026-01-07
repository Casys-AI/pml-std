/**
 * ExecuteDirectUseCase Unit Tests
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module tests/unit/application/use-cases/execute/execute-direct
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  ExecuteDirectUseCase,
  type ExecuteDirectDependencies,
  type IDAGExecutor,
  type IStaticStructureBuilder,
  type IToolDefinitionsBuilder,
  type IDAGConverter,
  type IWorkerBridgeFactory,
} from "../../../../../src/application/use-cases/execute/execute-direct.use-case.ts";
import type { ICapabilityRepository } from "../../../../../src/domain/interfaces/capability-repository.ts";
import type { StaticStructure } from "../../../../../src/capabilities/types/mod.ts";
import type { DAGExecutionResults } from "../../../../../src/application/use-cases/execute/shared/result-mapper.ts";

// ============================================================================
// Mock Factories
// ============================================================================

function createMockStaticStructure(): StaticStructure {
  return {
    nodes: [
      { id: "task_0", type: "task", tool: "filesystem:read_file" },
      { id: "task_1", type: "task", tool: "code:parse_json" },
    ],
    edges: [
      { from: "task_0", to: "task_1", type: "dataflow" },
    ],
    entryPoints: ["task_0"],
    variables: [],
    loops: [],
    branches: [],
    exports: [],
    codeHash: "abc123",
  };
}

function createMockDAGExecutionResults(): DAGExecutionResults {
  return {
    results: [
      { taskId: "task_0", status: "success", output: { content: "test" }, executionTimeMs: 100, layerIndex: 0 },
      { taskId: "task_1", status: "success", output: { parsed: true }, executionTimeMs: 50, layerIndex: 1 },
    ],
    successfulTasks: 2,
    failedTasks: 0,
    errors: [],
    parallelizationLayers: 2,
  };
}

function createMockCapabilityRepository(): ICapabilityRepository {
  return {
    saveCapability: async (input) => ({
      capability: {
        id: "cap-123",
        codeHash: "abc123",
        name: "test:capability",
        displayName: "Test Capability",
        code: input.code,
        intent: input.intent,
        toolsUsed: input.toolsUsed ?? [],
        successRate: 1.0,
        usageCount: 1,
        avgDurationMs: input.durationMs,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    }),
    findById: async () => null,
    findByCodeHash: async () => null,
    searchByIntent: async () => [],
    updateUsage: async () => {},
    getCapabilityCount: async () => 0,
    getStats: async () => ({ totalCapabilities: 0, totalExecutions: 0, avgSuccessRate: 0, avgDurationMs: 0 }),
    getStaticStructure: async () => null,
    addDependency: async () => ({
      fromCapabilityId: "",
      toCapabilityId: "",
      confidence: 0,
      coOccurrenceCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    removeDependency: async () => {},
    getAllDependencies: async () => [],
  };
}

function createMockStaticStructureBuilder(): IStaticStructureBuilder {
  return {
    buildStaticStructure: async () => createMockStaticStructure(),
    inferDecisions: () => [],
  };
}

function createMockToolDefinitionsBuilder(): IToolDefinitionsBuilder {
  return {
    buildFromStaticStructure: async () => [
      { id: "filesystem:read_file", name: "read_file" },
      { id: "code:parse_json", name: "parse_json" },
    ],
  };
}

function createMockDAGConverter(): IDAGConverter {
  return {
    isValidForDagConversion: () => true,
    staticStructureToDag: () => ({
      tasks: [
        { id: "task_0", tool: "filesystem:read_file", arguments: {}, dependsOn: [] },
        { id: "task_1", tool: "code:parse_json", arguments: {}, dependsOn: ["task_0"] },
      ],
    }),
    optimizeDAG: (dag) => ({
      tasks: dag.tasks as Array<{ id: string; tool: string; metadata?: unknown }>,
      physicalToLogical: new Map([
        ["task_0", ["task_0"]],
        ["task_1", ["task_1"]],
      ]),
      logicalDAG: dag as { tasks: Array<{ id: string; tool: string }> },
    }),
    generateLogicalTrace: () => ({
      executedPath: ["filesystem:read_file", "code:parse_json"],
      toolsUsed: ["filesystem:read_file", "code:parse_json"],
    }),
  };
}

function createMockWorkerBridgeFactory(): IWorkerBridgeFactory {
  const mockExecutor: IDAGExecutor = {
    execute: async () => createMockDAGExecutionResults(),
    setWorkerBridge: () => {},
    setToolDefinitions: () => {},
    calculateSpeedup: () => 1.5,
  };

  return {
    create: () => [mockExecutor, { bridge: {}, traces: [] }],
    cleanup: () => {},
  };
}

function createMockDependencies(): ExecuteDirectDependencies {
  return {
    capabilityRepo: createMockCapabilityRepository(),
    staticStructureBuilder: createMockStaticStructureBuilder(),
    toolDefinitionsBuilder: createMockToolDefinitionsBuilder(),
    dagConverter: createMockDAGConverter(),
    workerBridgeFactory: createMockWorkerBridgeFactory(),
  };
}

// ============================================================================
// Tests
// ============================================================================

Deno.test({
  name: "ExecuteDirectUseCase - executes code successfully",
  async fn() {
    const deps = createMockDependencies();
    const useCase = new ExecuteDirectUseCase(deps);

    const result = await useCase.execute({
      code: 'const data = await mcp.filesystem.read_file({ path: "test.json" }); return JSON.parse(data);',
      intent: "read and parse JSON file",
    });

    assertEquals(result.success, true);
    assertExists(result.data);
    assertEquals(result.data.success, true);
    assertEquals(result.data.mode, "direct");
    assertExists(result.data.capabilityId);
    assertEquals(result.data.dag?.mode, "dag");
    assertEquals(result.data.dag?.tasksCount, 2);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ExecuteDirectUseCase - rejects oversized code",
  async fn() {
    const deps = createMockDependencies();
    deps.maxCodeSizeBytes = 100; // Very small limit for testing
    const useCase = new ExecuteDirectUseCase(deps);

    const result = await useCase.execute({
      code: "x".repeat(200), // Exceeds 100 bytes
      intent: "test",
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.code, "CODE_TOO_LARGE");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ExecuteDirectUseCase - handles invalid code for DAG conversion",
  async fn() {
    const deps = createMockDependencies();
    deps.dagConverter = {
      ...createMockDAGConverter(),
      isValidForDagConversion: () => false,
    };
    const useCase = new ExecuteDirectUseCase(deps);

    const result = await useCase.execute({
      code: "console.log('hello')",
      intent: "print hello",
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.code, "INVALID_CODE");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ExecuteDirectUseCase - handles execution failure",
  async fn() {
    const deps = createMockDependencies();

    // Mock executor that returns failure
    const failingExecutor: IDAGExecutor = {
      execute: async () => ({
        results: [
          { taskId: "task_0", status: "error", error: "File not found", executionTimeMs: 50, layerIndex: 0 },
        ],
        successfulTasks: 0,
        failedTasks: 1,
        errors: [{ taskId: "task_0", error: "File not found" }],
        parallelizationLayers: 1,
      }),
    };

    deps.workerBridgeFactory = {
      create: () => [failingExecutor, { bridge: {}, traces: [] }],
      cleanup: () => {},
    };

    const useCase = new ExecuteDirectUseCase(deps);

    const result = await useCase.execute({
      code: 'await mcp.filesystem.read_file({ path: "nonexistent.txt" })',
      intent: "read file",
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.code, "EXECUTION_FAILED");
    assertExists(result.data?.toolFailures);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
