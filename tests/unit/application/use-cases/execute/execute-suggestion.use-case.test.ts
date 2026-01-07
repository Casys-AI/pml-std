/**
 * ExecuteSuggestionUseCase Unit Tests
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module tests/unit/application/use-cases/execute/execute-suggestion
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  ExecuteSuggestionUseCase,
  type ExecuteSuggestionDependencies,
  type ISHGATScorer,
  type IDRDSPPathfinder,
  type IEmbeddingModel,
} from "../../../../../src/application/use-cases/execute/execute-suggestion.use-case.ts";
import type { ICapabilityRepository } from "../../../../../src/domain/interfaces/capability-repository.ts";

// ============================================================================
// Mock Factories
// ============================================================================

function createMockCapabilityRepository(): ICapabilityRepository {
  return {
    saveCapability: async () => ({ capability: { id: "cap-123", codeHash: "abc" } as any }),
    findById: async (id) => {
      if (id === "cap-high-score") {
        return {
          id: "cap-high-score",
          codeHash: "abc",
          name: "file:read",
          displayName: "File Read",
          code: "await mcp.filesystem.read_file()",
          intent: "read file",
          toolsUsed: ["filesystem:read_file", "code:parse_json"],
          successRate: 0.95,
          usageCount: 100,
          avgDurationMs: 150,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
      return null;
    },
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

function createMockSHGATScorer(): ISHGATScorer {
  return {
    scoreAllCapabilities: (embedding) => [
      {
        capabilityId: "cap-high-score",
        score: 0.85,
        headScores: [0.8, 0.9],
        headWeights: [0.5, 0.5],
        recursiveContribution: 0.1,
        featureContributions: {
          semantic: 0.7,
          structure: 0.1,
          temporal: 0.05,
          reliability: 0.05,
        },
      },
      {
        capabilityId: "cap-medium-score",
        score: 0.6,
      },
    ],
    hasToolNode: () => true,
    registerTool: () => {},
    registerCapability: () => {},
  };
}

function createMockDRDSPPathfinder(): IDRDSPPathfinder {
  return {
    findShortestHyperpath: (source, target) => ({
      found: true,
      path: [source, target],
      nodeSequence: [source, target],
      hyperedges: [],
      totalWeight: 0.5,
    }),
  };
}

function createMockEmbeddingModel(): IEmbeddingModel {
  return {
    encode: async (text) => Array(384).fill(0.1), // Mock 384-dim embedding
  };
}

function createMockDependencies(): ExecuteSuggestionDependencies {
  return {
    shgat: createMockSHGATScorer(),
    drdsp: createMockDRDSPPathfinder(),
    embeddingModel: createMockEmbeddingModel(),
    capabilityRepo: createMockCapabilityRepository(),
  };
}

// ============================================================================
// Tests
// ============================================================================

Deno.test({
  name: "ExecuteSuggestionUseCase - returns suggestions for valid intent",
  async fn() {
    const deps = createMockDependencies();
    const useCase = new ExecuteSuggestionUseCase(deps);

    const result = await useCase.execute({
      intent: "read a JSON file and parse it",
    });

    assertEquals(result.success, true);
    assertExists(result.data);
    assertEquals(result.data.confidence, 0.85);
    assertExists(result.data.bestCapability);
    assertEquals(result.data.bestCapability?.id, "cap-high-score");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ExecuteSuggestionUseCase - returns empty result without SHGAT",
  async fn() {
    const deps: ExecuteSuggestionDependencies = {
      capabilityRepo: createMockCapabilityRepository(),
      // No SHGAT or embedding model
    };
    const useCase = new ExecuteSuggestionUseCase(deps);

    const result = await useCase.execute({
      intent: "read a file",
    });

    assertEquals(result.success, true);
    assertEquals(result.data?.confidence, 0);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ExecuteSuggestionUseCase - returns empty result without embedding model",
  async fn() {
    const deps: ExecuteSuggestionDependencies = {
      shgat: createMockSHGATScorer(),
      capabilityRepo: createMockCapabilityRepository(),
      // No embedding model
    };
    const useCase = new ExecuteSuggestionUseCase(deps);

    const result = await useCase.execute({
      intent: "read a file",
    });

    assertEquals(result.success, true);
    assertEquals(result.data?.confidence, 0);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ExecuteSuggestionUseCase - handles empty SHGAT results",
  async fn() {
    const deps = createMockDependencies();
    deps.shgat = {
      ...createMockSHGATScorer(),
      scoreAllCapabilities: () => [], // Empty results
    };
    const useCase = new ExecuteSuggestionUseCase(deps);

    const result = await useCase.execute({
      intent: "unknown task",
    });

    assertEquals(result.success, true);
    assertEquals(result.data?.confidence, 0);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "ExecuteSuggestionUseCase - handles embedding failure",
  async fn() {
    const deps = createMockDependencies();
    deps.embeddingModel = {
      encode: async () => [], // Empty embedding
    };
    const useCase = new ExecuteSuggestionUseCase(deps);

    const result = await useCase.execute({
      intent: "test",
    });

    assertEquals(result.success, false);
    assertEquals(result.error?.code, "EMBEDDING_FAILED");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
