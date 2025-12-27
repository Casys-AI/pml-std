/**
 * Rationale Generation Tests
 *
 * Comprehensive unit tests for the rationale generation module.
 * Tests path explanation, hybrid rationale, and prediction reasoning.
 *
 * @module tests/unit/graphrag/suggestion/rationale.test
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  explainPath,
  generatePredictionReasoning,
  generateRationaleHybrid,
} from "../../../../src/graphrag/suggestion/rationale.ts";
import type { RationaleCandidate } from "../../../../src/graphrag/suggestion/rationale.ts";
import type { DependencyPath } from "../../../../src/graphrag/types.ts";
import { DEFAULT_DAG_SCORING_CONFIG } from "../../../../src/graphrag/dag-scoring-config.ts";

const config = DEFAULT_DAG_SCORING_CONFIG;

Deno.test("explainPath - Happy Path", async (t) => {
  await t.step("explains direct dependency (2 nodes)", () => {
    const path = ["tool1", "tool2"];
    const explanation = explainPath(path);

    assertEquals(explanation, "Direct dependency: tool1 → tool2");
  });

  await t.step("explains transitive dependency (3 nodes)", () => {
    const path = ["tool1", "tool2", "tool3"];
    const explanation = explainPath(path);

    assertEquals(explanation, "Transitive: tool1 → tool2 → tool3");
  });

  await t.step("explains long transitive path (4+ nodes)", () => {
    const path = ["tool1", "tool2", "tool3", "tool4"];
    const explanation = explainPath(path);

    assertEquals(explanation, "Transitive: tool1 → tool2 → tool3 → tool4");
  });

  await t.step("explains very long path", () => {
    const path = ["a", "b", "c", "d", "e", "f"];
    const explanation = explainPath(path);

    assertEquals(explanation, "Transitive: a → b → c → d → e → f");
  });
});

Deno.test("explainPath - Edge Cases", async (t) => {
  await t.step("handles single node path", () => {
    const path = ["tool1"];
    const explanation = explainPath(path);

    // Single node doesn't match either condition, falls to else
    assertStringIncludes(explanation, "Transitive");
    assertStringIncludes(explanation, "tool1");
  });

  await t.step("handles empty path", () => {
    const path: string[] = [];
    const explanation = explainPath(path);

    // Empty path should produce transitive explanation with empty intermediate
    assertStringIncludes(explanation, "Transitive");
  });

  await t.step("handles paths with special characters", () => {
    const path = ["tool-1", "tool_2", "tool.3"];
    const explanation = explainPath(path);

    assertStringIncludes(explanation, "tool-1");
    assertStringIncludes(explanation, "tool_2");
    assertStringIncludes(explanation, "tool.3");
  });

  await t.step("handles paths with long tool names", () => {
    const path = [
      "very_long_tool_name_with_many_characters",
      "another_very_long_tool_name",
    ];
    const explanation = explainPath(path);

    assertEquals(
      explanation,
      "Direct dependency: very_long_tool_name_with_many_characters → another_very_long_tool_name",
    );
  });
});

Deno.test("generateRationaleHybrid - Happy Path", async (t) => {
  await t.step("generates rationale with all components", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.15,
    }];

    const paths: DependencyPath[] = [
      {
        from: "tool0",
        to: "tool1",
        path: ["tool0", "tool1"],
        hops: 1,
        explanation: "Direct",
        confidence: 0.95,
      },
    ];

    const rationale = generateRationaleHybrid(candidates, paths, config);

    assertStringIncludes(rationale, "hybrid search");
    assertStringIncludes(rationale, "85%");
    assertStringIncludes(rationale, "semantic: 80%");
    assertStringIncludes(rationale, "graph: 5%");
    assertStringIncludes(rationale, "PageRank:");
    assertStringIncludes(rationale, "1 deps (1 direct)");
  });

  await t.step("generates rationale without graph score", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.85,
      semanticScore: 0.85,
      graphScore: 0.0,
      pageRank: 0.15,
    }];

    const paths: DependencyPath[] = [];

    const rationale = generateRationaleHybrid(candidates, paths, config);

    assertStringIncludes(rationale, "hybrid search");
    assertStringIncludes(rationale, "semantic: 85%");
    // Should not include graph score if it's 0
    assert(!rationale.includes("graph:"));
  });

  await t.step("generates rationale without semantic score", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.85,
      semanticScore: 0.0,
      graphScore: 0.85,
      pageRank: 0.15,
    }];

    const paths: DependencyPath[] = [];

    const rationale = generateRationaleHybrid(candidates, paths, config);

    assertStringIncludes(rationale, "hybrid search");
    assertStringIncludes(rationale, "graph: 85%");
    // Should not include semantic score if it's 0
    assert(!rationale.includes("semantic:"));
  });

  await t.step("omits PageRank below threshold", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.005, // Below threshold (0.01)
    }];

    const paths: DependencyPath[] = [];

    const rationale = generateRationaleHybrid(candidates, paths, config);

    assertStringIncludes(rationale, "hybrid search");
    // Should not include PageRank if below threshold
    assert(!rationale.includes("PageRank"));
  });

  await t.step("includes PageRank above threshold", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.02, // Above threshold (0.01)
    }];

    const paths: DependencyPath[] = [];

    const rationale = generateRationaleHybrid(candidates, paths, config);

    assertStringIncludes(rationale, "PageRank:");
  });

  await t.step("reports dependency counts correctly", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.15,
    }];

    const paths: DependencyPath[] = [
      { from: "a", to: "b", path: ["a", "b"], hops: 1, explanation: "Direct" },
      { from: "b", to: "c", path: ["b", "c"], hops: 1, explanation: "Direct" },
      { from: "a", to: "c", path: ["a", "x", "c"], hops: 2, explanation: "Indirect" },
      { from: "d", to: "e", path: ["d", "y", "z", "e"], hops: 3, explanation: "Indirect" },
    ];

    const rationale = generateRationaleHybrid(candidates, paths, config);

    assertStringIncludes(rationale, "4 deps (2 direct)");
  });

  await t.step("generates minimal rationale without optional components", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.85,
      semanticScore: 0.0,
      graphScore: 0.0,
      pageRank: 0.005, // Below threshold
    }];

    const paths: DependencyPath[] = [];

    const rationale = generateRationaleHybrid(candidates, paths, config);

    assertStringIncludes(rationale, "hybrid search");
    assertStringIncludes(rationale, "85%");
    // Should only have the base hybrid score
  });
});

Deno.test("generateRationaleHybrid - Edge Cases", async (t) => {
  await t.step("returns message for empty candidates", () => {
    const rationale = generateRationaleHybrid([], [], config);

    assertEquals(rationale, "No candidates found.");
  });

  await t.step("handles no dependency paths", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.15,
    }];

    const rationale = generateRationaleHybrid(candidates, [], config);

    assertStringIncludes(rationale, "hybrid search");
    // Should not include deps section
    assert(!rationale.includes("deps"));
  });

  await t.step("handles all direct dependencies", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.15,
    }];

    const paths: DependencyPath[] = [
      { from: "a", to: "b", path: ["a", "b"], hops: 1, explanation: "Direct" },
      { from: "b", to: "c", path: ["b", "c"], hops: 1, explanation: "Direct" },
    ];

    const rationale = generateRationaleHybrid(candidates, paths, config);

    assertStringIncludes(rationale, "2 deps (2 direct)");
  });

  await t.step("handles no direct dependencies", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.85,
      semanticScore: 0.80,
      graphScore: 0.05,
      pageRank: 0.15,
    }];

    const paths: DependencyPath[] = [
      { from: "a", to: "c", path: ["a", "b", "c"], hops: 2, explanation: "Indirect" },
      { from: "d", to: "e", path: ["d", "x", "y", "e"], hops: 3, explanation: "Indirect" },
    ];

    const rationale = generateRationaleHybrid(candidates, paths, config);

    assertStringIncludes(rationale, "2 deps (0 direct)");
  });

  await t.step("rounds percentages correctly", () => {
    const candidates: RationaleCandidate[] = [{
      toolId: "tool1",
      score: 0.856,
      semanticScore: 0.804,
      graphScore: 0.052,
      pageRank: 0.156,
    }];

    const paths: DependencyPath[] = [];

    const rationale = generateRationaleHybrid(candidates, paths, config);

    assertStringIncludes(rationale, "86%"); // Rounded from 85.6%
    assertStringIncludes(rationale, "semantic: 80%"); // Rounded from 80.4%
    assertStringIncludes(rationale, "graph: 5%"); // Rounded from 5.2%
    assertStringIncludes(rationale, "15.6%"); // PageRank keeps 1 decimal
  });
});

Deno.test("generatePredictionReasoning - Community Source", async (t) => {
  await t.step("generates community reasoning with defaults", () => {
    const reasoning = generatePredictionReasoning("community", {
      lastToolId: "tool1",
    });

    assertStringIncludes(reasoning, "Same community as tool1");
    assertStringIncludes(reasoning, "PageRank: 0.0%");
    assertStringIncludes(reasoning, "α=0.75");
  });

  await t.step("generates community reasoning with custom values", () => {
    const reasoning = generatePredictionReasoning("community", {
      lastToolId: "tool2",
      pageRank: 0.15,
      alpha: 0.85,
    });

    assertStringIncludes(reasoning, "Same community as tool2");
    assertStringIncludes(reasoning, "PageRank: 15.0%");
    assertStringIncludes(reasoning, "α=0.85");
  });

  await t.step("handles high PageRank", () => {
    const reasoning = generatePredictionReasoning("community", {
      lastToolId: "tool3",
      pageRank: 0.95,
      alpha: 0.50,
    });

    assertStringIncludes(reasoning, "PageRank: 95.0%");
  });
});

Deno.test("generatePredictionReasoning - Co-occurrence Source", async (t) => {
  await t.step("generates co-occurrence reasoning with defaults", () => {
    const reasoning = generatePredictionReasoning("co-occurrence", {});

    assertStringIncludes(reasoning, "Historical co-occurrence");
    assertStringIncludes(reasoning, "60%");
    assertStringIncludes(reasoning, "Community (30%)");
    assertStringIncludes(reasoning, "Recency (0%)");
    assertStringIncludes(reasoning, "α=0.75");
  });

  await t.step("generates co-occurrence reasoning with recency boost", () => {
    const reasoning = generatePredictionReasoning("co-occurrence", {
      recencyBoost: 0.10,
      alpha: 0.80,
    });

    assertStringIncludes(reasoning, "Recency (10%)");
    assertStringIncludes(reasoning, "α=0.80");
  });

  await t.step("handles high recency boost", () => {
    const reasoning = generatePredictionReasoning("co-occurrence", {
      recencyBoost: 0.25,
    });

    assertStringIncludes(reasoning, "Recency (25%)");
  });
});

Deno.test("generatePredictionReasoning - Capability Source", async (t) => {
  await t.step("generates capability reasoning with overlap only", () => {
    const reasoning = generatePredictionReasoning("capability", {
      overlapScore: 0.75,
    });

    assertStringIncludes(reasoning, "Capability matches context");
    assertStringIncludes(reasoning, "75% overlap");
    assertStringIncludes(reasoning, "α=0.75");
    assert(!reasoning.includes("cluster boost"));
  });

  await t.step("generates capability reasoning with cluster boost", () => {
    const reasoning = generatePredictionReasoning("capability", {
      overlapScore: 0.65,
      clusterBoost: 0.15,
      alpha: 0.70,
    });

    assertStringIncludes(reasoning, "65% overlap");
    assertStringIncludes(reasoning, "+15% cluster boost");
    assertStringIncludes(reasoning, "α=0.70");
  });

  await t.step("omits cluster boost when zero", () => {
    const reasoning = generatePredictionReasoning("capability", {
      overlapScore: 0.80,
      clusterBoost: 0,
    });

    assert(!reasoning.includes("cluster boost"));
  });

  await t.step("handles very high overlap score", () => {
    const reasoning = generatePredictionReasoning("capability", {
      overlapScore: 1.0,
      clusterBoost: 0.20,
    });

    assertStringIncludes(reasoning, "100% overlap");
    assertStringIncludes(reasoning, "+20% cluster boost");
  });
});

Deno.test("generatePredictionReasoning - Alternative Source", async (t) => {
  await t.step("generates alternative reasoning with defaults", () => {
    const reasoning = generatePredictionReasoning("alternative", {});

    assertStringIncludes(reasoning, "Alternative to capability");
    assertStringIncludes(reasoning, "0% success rate");
  });

  await t.step("generates alternative reasoning with custom capability", () => {
    const reasoning = generatePredictionReasoning("alternative", {
      matchedCapabilityName: "data_processing",
      successRate: 0.85,
    });

    assertStringIncludes(reasoning, "Alternative to data_processing");
    assertStringIncludes(reasoning, "85% success rate");
  });

  await t.step("handles high success rate", () => {
    const reasoning = generatePredictionReasoning("alternative", {
      matchedCapabilityName: "file_operations",
      successRate: 0.95,
    });

    assertStringIncludes(reasoning, "95% success rate");
  });

  await t.step("handles low success rate", () => {
    const reasoning = generatePredictionReasoning("alternative", {
      successRate: 0.25,
    });

    assertStringIncludes(reasoning, "25% success rate");
  });
});

Deno.test("generatePredictionReasoning - Edge Cases", async (t) => {
  await t.step("handles unknown source", () => {
    // @ts-expect-error Testing invalid source
    const reasoning = generatePredictionReasoning("unknown", {});

    assertEquals(reasoning, "Unknown prediction source");
  });

  await t.step("handles empty details object", () => {
    const reasoning1 = generatePredictionReasoning("community", {});
    const reasoning2 = generatePredictionReasoning("co-occurrence", {});
    const reasoning3 = generatePredictionReasoning("capability", {});
    const reasoning4 = generatePredictionReasoning("alternative", {});

    // All should generate valid strings with defaults
    assert(reasoning1.length > 0);
    assert(reasoning2.length > 0);
    assert(reasoning3.length > 0);
    assert(reasoning4.length > 0);
  });

  await t.step("handles undefined optional fields", () => {
    const reasoning = generatePredictionReasoning("community", {
      lastToolId: "tool1",
      pageRank: undefined,
      alpha: undefined,
    });

    assertStringIncludes(reasoning, "tool1");
    assertStringIncludes(reasoning, "PageRank: 0.0%");
    assertStringIncludes(reasoning, "α=0.75");
  });

  await t.step("handles zero values", () => {
    const reasoning1 = generatePredictionReasoning("community", {
      lastToolId: "tool1",
      pageRank: 0,
      alpha: 0.5,
    });

    const reasoning2 = generatePredictionReasoning("capability", {
      overlapScore: 0,
      clusterBoost: 0,
    });

    assertStringIncludes(reasoning1, "PageRank: 0.0%");
    assertStringIncludes(reasoning2, "0% overlap");
  });

  await t.step("formats percentages consistently", () => {
    const reasoning = generatePredictionReasoning("community", {
      lastToolId: "tool1",
      pageRank: 0.1567,
    });

    // Should format to 1 decimal place
    assertStringIncludes(reasoning, "15.7%");
  });

  await t.step("formats alpha consistently", () => {
    const reasoning = generatePredictionReasoning("community", {
      lastToolId: "tool1",
      alpha: 0.8765,
    });

    // Should format to 2 decimal places
    assertStringIncludes(reasoning, "α=0.88");
  });
});

// Helper function for assertions
function assert(condition: boolean, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}
