/**
 * Episodic Adapter Tests
 *
 * Tests for episodic memory integration functions:
 * - Context hash generation
 * - Episode retrieval and parsing
 * - Episode statistics loading
 *
 * @module tests/unit/graphrag/learning/episodic-adapter.test
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  type EpisodicEvent,
  getContextHash,
  loadEpisodeStatistics,
  parseEpisodeStatistics,
  retrieveRelevantEpisodes,
} from "../../../../src/graphrag/learning/episodic-adapter.ts";
import type { WorkflowPredictionState } from "../../../../src/graphrag/types.ts";
import type { EpisodicMemoryStore } from "../../../../src/learning/episodic-memory-store.ts";
import type { DagScoringConfig } from "../../../../src/graphrag/dag-scoring-config.ts";
import { DEFAULT_DAG_SCORING_CONFIG } from "../../../../src/graphrag/dag-scoring-config.ts";
import type { RetrieveOptions, ThresholdContext } from "../../../../src/learning/types.ts";

/**
 * Create mock workflow prediction state
 */
function createMockWorkflowState(
  overrides?: Partial<WorkflowPredictionState>,
): WorkflowPredictionState {
  return {
    workflowId: "workflow-123",
    currentLayer: 2,
    completedTasks: [
      { taskId: "task-1", tool: "ReadFile", status: "success" },
      { taskId: "task-2", tool: "AnalyzeCode", status: "success" },
    ],
    context: {
      workflowType: "code-analysis",
      domain: "typescript",
      complexity: "2",
    },
    ...overrides,
  };
}

/**
 * Create mock episodic memory store
 */
function createMockEpisodicMemory(
  episodes: EpisodicEvent[] = [],
): EpisodicMemoryStore {
  return {
    retrieveRelevant: async (_context: ThresholdContext, _options?: RetrieveOptions) => episodes,
  } as unknown as EpisodicMemoryStore;
}

/**
 * Create mock config
 */
function createMockConfig(overrides?: Partial<DagScoringConfig>): DagScoringConfig {
  return {
    ...DEFAULT_DAG_SCORING_CONFIG,
    ...overrides,
  };
}

/**
 * Create a valid mock episode conforming to EpisodicEvent type
 */
function createMockEpisode(overrides: {
  id: string;
  workflow_id?: string;
  event_type: string;
  toolId?: string;
  confidence?: number;
  wasCorrect?: boolean;
  reasoning?: string;
  data?: Record<string, unknown>;
}): EpisodicEvent {
  const base: EpisodicEvent = {
    id: overrides.id,
    workflow_id: overrides.workflow_id ?? `wf-${overrides.id}`,
    event_type: overrides.event_type as EpisodicEvent["event_type"],
    timestamp: Date.now(),
    data: overrides.data ?? {},
  };

  // Add prediction data if toolId provided
  if (overrides.toolId) {
    base.data = {
      ...base.data,
      prediction: {
        toolId: overrides.toolId,
        confidence: overrides.confidence ?? 0.85,
        reasoning: overrides.reasoning ?? "Test prediction reasoning",
        wasCorrect: overrides.wasCorrect,
      },
    };
  }

  return base;
}

Deno.test("episodic-adapter - Context Hash Generation", async (t) => {
  await t.step("getContextHash() generates consistent hash from workflow state", () => {
    const state = createMockWorkflowState();
    const hash = getContextHash(state);

    assertEquals(hash, "workflowType:code-analysis|domain:typescript|complexity:2");
  });

  await t.step("getContextHash() uses defaults for missing context fields", () => {
    const state = createMockWorkflowState({
      context: {},
    });
    const hash = getContextHash(state);

    assertEquals(hash, "workflowType:unknown|domain:general|complexity:2");
  });

  await t.step(
    "getContextHash() uses completedTasks length when context.complexity missing",
    () => {
      const state = createMockWorkflowState({
        context: { workflowType: "test", domain: "general" },
        completedTasks: [
          { taskId: "task-1", tool: "Tool1", status: "success" },
          { taskId: "task-2", tool: "Tool2", status: "success" },
          { taskId: "task-3", tool: "Tool3", status: "success" },
        ],
      });
      const hash = getContextHash(state);

      assertEquals(hash, "workflowType:test|domain:general|complexity:3");
    },
  );

  await t.step("getContextHash() returns 'no-state' for null state", () => {
    const hash = getContextHash(null);
    assertEquals(hash, "no-state");
  });

  await t.step("getContextHash() handles undefined context gracefully", () => {
    const state: WorkflowPredictionState = {
      workflowId: "workflow-123",
      currentLayer: 1,
      completedTasks: [],
    };
    const hash = getContextHash(state);

    assertEquals(hash, "workflowType:unknown|domain:general|complexity:0");
  });

  await t.step("getContextHash() uses '0' complexity when no completed tasks", () => {
    const state = createMockWorkflowState({
      completedTasks: [],
      context: { workflowType: "test" },
    });
    const hash = getContextHash(state);

    assertEquals(hash, "workflowType:test|domain:general|complexity:0");
  });
});

Deno.test("episodic-adapter - Episode Retrieval", async (t) => {
  await t.step("retrieveRelevantEpisodes() returns episodes from memory store", async () => {
    const mockEpisodes: EpisodicEvent[] = [
      createMockEpisode({
        id: "ep-1",
        event_type: "speculation_start",
        toolId: "WriteFile",
        confidence: 0.85,
        wasCorrect: true,
      }),
      createMockEpisode({
        id: "ep-2",
        event_type: "speculation_start",
        toolId: "WriteFile",
        confidence: 0.78,
        wasCorrect: false,
      }),
    ];

    const state = createMockWorkflowState();
    const memory = createMockEpisodicMemory(mockEpisodes);
    const config = createMockConfig();

    const episodes = await retrieveRelevantEpisodes(state, memory, config);

    assertEquals(episodes.length, 2);
    assertEquals(episodes[0].id, "ep-1");
    assertEquals(episodes[1].id, "ep-2");
  });

  await t.step("retrieveRelevantEpisodes() returns empty array when memory is null", async () => {
    const state = createMockWorkflowState();
    const config = createMockConfig();

    const episodes = await retrieveRelevantEpisodes(state, null, config);

    assertEquals(episodes, []);
  });

  await t.step("retrieveRelevantEpisodes() returns empty array when state is null", async () => {
    const memory = createMockEpisodicMemory([]);
    const config = createMockConfig();

    const episodes = await retrieveRelevantEpisodes(null, memory, config);

    assertEquals(episodes, []);
  });

  await t.step("retrieveRelevantEpisodes() handles retrieval errors gracefully", async () => {
    const state = createMockWorkflowState();
    const config = createMockConfig();
    const memory = {
      retrieveRelevant: async () => {
        throw new Error("Database connection failed");
      },
    } as unknown as EpisodicMemoryStore;

    const episodes = await retrieveRelevantEpisodes(state, memory, config);

    assertEquals(episodes, []); // Returns empty array on error
  });

  await t.step("retrieveRelevantEpisodes() passes correct context to memory store", async () => {
    let capturedContext: ThresholdContext | undefined;
    let capturedOptions: RetrieveOptions | undefined;

    const state = createMockWorkflowState();
    const config = createMockConfig();
    config.limits.episodeRetrieval = 25;
    const memory = {
      retrieveRelevant: async (context: ThresholdContext, options?: RetrieveOptions) => {
        capturedContext = context;
        capturedOptions = options;
        return [];
      },
    } as unknown as EpisodicMemoryStore;

    await retrieveRelevantEpisodes(state, memory, config);

    assertExists(capturedContext);
    assertEquals(capturedContext.workflowType, "code-analysis");
    assertEquals(capturedContext.domain, "typescript");
    assertEquals(capturedContext.complexity, "2");

    assertExists(capturedOptions);
    assertEquals(capturedOptions.limit, 25);
    assertEquals(capturedOptions.eventTypes, ["speculation_start", "task_complete"]);
  });
});

Deno.test("episodic-adapter - Episode Statistics Parsing", async (t) => {
  await t.step("parseEpisodeStatistics() calculates success rates correctly", () => {
    const episodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: {
            toolId: "WriteFile",
            confidence: 0.85,
            wasCorrect: true,
            reasoning: "test",
          },
        },
      },
      {
        id: "ep-2",
        workflow_id: "wf-2",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: {
            toolId: "WriteFile",
            confidence: 0.78,
            wasCorrect: true,
            reasoning: "test",
          },
        },
      },
      {
        id: "ep-3",
        workflow_id: "wf-3",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: {
            toolId: "WriteFile",
            confidence: 0.72,
            wasCorrect: false,
            reasoning: "test",
          },
        },
      },
    ];

    const stats = parseEpisodeStatistics(episodes);

    assertExists(stats.get("WriteFile"));
    const writeFileStats = stats.get("WriteFile")!;
    assertEquals(writeFileStats.total, 3);
    assertEquals(writeFileStats.successes, 2);
    assertEquals(writeFileStats.failures, 1);
    assertEquals(writeFileStats.successRate, 2 / 3);
    assertEquals(writeFileStats.failureRate, 1 / 3);
  });

  await t.step("parseEpisodeStatistics() handles multiple tools", () => {
    const episodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "ReadFile", confidence: 0.90, wasCorrect: true, reasoning: "test" },
        },
      },
      {
        id: "ep-2",
        workflow_id: "wf-2",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: {
            toolId: "WriteFile",
            confidence: 0.75,
            wasCorrect: false,
            reasoning: "test",
          },
        },
      },
    ];

    const stats = parseEpisodeStatistics(episodes);

    assertEquals(stats.size, 2);
    assertExists(stats.get("ReadFile"));
    assertExists(stats.get("WriteFile"));
    assertEquals(stats.get("ReadFile")!.successRate, 1.0);
    assertEquals(stats.get("WriteFile")!.successRate, 0.0);
  });

  await t.step("parseEpisodeStatistics() returns empty map for empty episodes", () => {
    const stats = parseEpisodeStatistics([]);
    assertEquals(stats.size, 0);
  });

  await t.step("parseEpisodeStatistics() handles episodes without wasCorrect field", () => {
    const episodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "ReadFile", confidence: 0.85, reasoning: "test" },
        },
      },
    ];

    const stats = parseEpisodeStatistics(episodes);

    assertExists(stats.get("ReadFile"));
    const readFileStats = stats.get("ReadFile")!;
    assertEquals(readFileStats.total, 1);
    assertEquals(readFileStats.successes, 0);
    assertEquals(readFileStats.failures, 1);
  });

  await t.step("parseEpisodeStatistics() skips task_complete events (not yet implemented)", () => {
    const episodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "task_complete",
        timestamp: Date.now(),
        data: {
          result: { status: "success" },
        },
      },
    ];

    const stats = parseEpisodeStatistics(episodes);
    assertEquals(stats.size, 0); // Task complete events are skipped for now
  });

  await t.step("parseEpisodeStatistics() skips episodes without prediction data", () => {
    const episodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {},
      },
    ];

    const stats = parseEpisodeStatistics(episodes);
    assertEquals(stats.size, 0);
  });

  await t.step("parseEpisodeStatistics() accumulates stats for repeated tools", () => {
    const episodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Bash", confidence: 0.85, wasCorrect: true, reasoning: "test" },
        },
      },
      {
        id: "ep-2",
        workflow_id: "wf-2",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Bash", confidence: 0.80, wasCorrect: true, reasoning: "test" },
        },
      },
      {
        id: "ep-3",
        workflow_id: "wf-3",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Bash", confidence: 0.70, wasCorrect: false, reasoning: "test" },
        },
      },
      {
        id: "ep-4",
        workflow_id: "wf-4",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Bash", confidence: 0.75, wasCorrect: true, reasoning: "test" },
        },
      },
    ];

    const stats = parseEpisodeStatistics(episodes);

    assertExists(stats.get("Bash"));
    const bashStats = stats.get("Bash")!;
    assertEquals(bashStats.total, 4);
    assertEquals(bashStats.successes, 3);
    assertEquals(bashStats.failures, 1);
    assertEquals(bashStats.successRate, 0.75);
    assertEquals(bashStats.failureRate, 0.25);
  });

  await t.step("parseEpisodeStatistics() handles 100% success rate", () => {
    const episodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Read", confidence: 0.95, wasCorrect: true, reasoning: "test" },
        },
      },
      {
        id: "ep-2",
        workflow_id: "wf-2",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Read", confidence: 0.92, wasCorrect: true, reasoning: "test" },
        },
      },
    ];

    const stats = parseEpisodeStatistics(episodes);

    const readStats = stats.get("Read")!;
    assertEquals(readStats.successRate, 1.0);
    assertEquals(readStats.failureRate, 0.0);
  });

  await t.step("parseEpisodeStatistics() handles 100% failure rate", () => {
    const episodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Write", confidence: 0.60, wasCorrect: false, reasoning: "test" },
        },
      },
      {
        id: "ep-2",
        workflow_id: "wf-2",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Write", confidence: 0.55, wasCorrect: false, reasoning: "test" },
        },
      },
    ];

    const stats = parseEpisodeStatistics(episodes);

    const writeStats = stats.get("Write")!;
    assertEquals(writeStats.successRate, 0.0);
    assertEquals(writeStats.failureRate, 1.0);
  });
});

Deno.test("episodic-adapter - Load Episode Statistics", async (t) => {
  await t.step("loadEpisodeStatistics() combines retrieval and parsing", async () => {
    const mockEpisodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Grep", confidence: 0.88, wasCorrect: true, reasoning: "test" },
        },
      },
      {
        id: "ep-2",
        workflow_id: "wf-2",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Grep", confidence: 0.82, wasCorrect: true, reasoning: "test" },
        },
      },
    ];

    const state = createMockWorkflowState();
    const memory = createMockEpisodicMemory(mockEpisodes);
    const config = createMockConfig();

    const stats = await loadEpisodeStatistics(state, memory, config);

    assertEquals(stats.size, 1);
    assertExists(stats.get("Grep"));
    assertEquals(stats.get("Grep")!.total, 2);
    assertEquals(stats.get("Grep")!.successRate, 1.0);
  });

  await t.step("loadEpisodeStatistics() returns empty map when memory is null", async () => {
    const state = createMockWorkflowState();
    const config = createMockConfig();

    const stats = await loadEpisodeStatistics(state, null, config);

    assertEquals(stats.size, 0);
  });

  await t.step("loadEpisodeStatistics() returns empty map when state is null", async () => {
    const memory = createMockEpisodicMemory([]);
    const config = createMockConfig();

    const stats = await loadEpisodeStatistics(null, memory, config);

    assertEquals(stats.size, 0);
  });

  await t.step("loadEpisodeStatistics() handles retrieval errors gracefully", async () => {
    const state = createMockWorkflowState();
    const config = createMockConfig();
    const memory = {
      retrieveRelevant: async () => {
        throw new Error("Network timeout");
      },
    } as unknown as EpisodicMemoryStore;

    const stats = await loadEpisodeStatistics(state, memory, config);

    assertEquals(stats.size, 0); // Returns empty map on error
  });

  await t.step("loadEpisodeStatistics() returns empty map when no episodes found", async () => {
    const state = createMockWorkflowState();
    const memory = createMockEpisodicMemory([]);
    const config = createMockConfig();

    const stats = await loadEpisodeStatistics(state, memory, config);

    assertEquals(stats.size, 0);
  });
});

Deno.test("episodic-adapter - Edge Cases and Error Handling", async (t) => {
  await t.step("handles workflow state with missing completedTasks", () => {
    const state: WorkflowPredictionState = {
      workflowId: "wf-1",
      currentLayer: 0,
      completedTasks: undefined as unknown as never[],
    };

    const hash = getContextHash(state);
    assertEquals(hash, "workflowType:unknown|domain:general|complexity:0");
  });

  await t.step("handles episodes with malformed data structures", () => {
    // Episode with empty data (no prediction)
    const episodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {}, // Empty data - no prediction field
      },
      {
        id: "ep-2",
        workflow_id: "wf-2",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: { metadata: { someField: "value" } }, // Data without prediction
      },
    ];

    const stats = parseEpisodeStatistics(episodes);
    assertEquals(stats.size, 0); // Skips episodes without prediction data
  });

  await t.step("parseEpisodeStatistics handles mixed event types", () => {
    const episodes: EpisodicEvent[] = [
      {
        id: "ep-1",
        workflow_id: "wf-1",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Read", confidence: 0.85, wasCorrect: true, reasoning: "test" },
        },
      },
      {
        id: "ep-2",
        workflow_id: "wf-2",
        event_type: "workflow_complete",
        timestamp: Date.now(),
        data: { metadata: { success: true } },
      },
      {
        id: "ep-3",
        workflow_id: "wf-3",
        event_type: "speculation_start",
        timestamp: Date.now(),
        data: {
          prediction: { toolId: "Write", confidence: 0.75, wasCorrect: false, reasoning: "test" },
        },
      },
    ];

    const stats = parseEpisodeStatistics(episodes);

    assertEquals(stats.size, 2);
    assertExists(stats.get("Read"));
    assertExists(stats.get("Write"));
  });
});
