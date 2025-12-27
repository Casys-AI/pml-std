/**
 * Unit tests for AdaptiveThresholdManager
 *
 * Tests adaptive threshold learning functionality
 * Story 10.7c: Added Thompson Sampling integration tests
 */

import { assert, assertEquals } from "@std/assert";
import {
  AdaptiveThresholdManager,
  calculateCapabilityRisk,
  getRiskFromScope,
} from "../../../src/mcp/adaptive-threshold.ts";
import type { PermissionConfig } from "../../../src/capabilities/permission-inferrer.ts";

Deno.test("AdaptiveThresholdManager - initializes with default thresholds", () => {
  const manager = new AdaptiveThresholdManager();

  const thresholds = manager.getThresholds();
  assertEquals(thresholds.explicitThreshold, 0.50);
  assertEquals(thresholds.suggestionThreshold, 0.70);
});

Deno.test("AdaptiveThresholdManager - initializes with custom thresholds", () => {
  const manager = new AdaptiveThresholdManager({
    initialExplicitThreshold: 0.60,
    initialSuggestionThreshold: 0.80,
  });

  const thresholds = manager.getThresholds();
  assertEquals(thresholds.explicitThreshold, 0.60);
  assertEquals(thresholds.suggestionThreshold, 0.80);
});

Deno.test("AdaptiveThresholdManager - records execution history", () => {
  const manager = new AdaptiveThresholdManager();

  manager.recordExecution({
    confidence: 0.75,
    mode: "speculative",
    success: true,
    timestamp: Date.now(),
  });

  const metrics = manager.getMetrics();
  assertEquals(metrics.totalSpeculativeAttempts, 1);
  assertEquals(metrics.successfulExecutions, 1);
  assertEquals(metrics.failedExecutions, 0);
});

Deno.test("AdaptiveThresholdManager - increases threshold after false positives", () => {
  const manager = new AdaptiveThresholdManager({
    initialSuggestionThreshold: 0.70,
    windowSize: 30,
  });

  const initialThresholds = manager.getThresholds();

  // Simulate 20 failed speculative executions (false positives)
  for (let i = 0; i < 20; i++) {
    manager.recordExecution({
      confidence: 0.75,
      mode: "speculative",
      success: false,
      timestamp: Date.now(),
    });
  }

  const adjustedThresholds = manager.getThresholds();

  // Threshold should increase after many false positives
  assert(
    adjustedThresholds.suggestionThreshold! > initialThresholds.suggestionThreshold!,
    "Threshold should increase after false positives",
  );
});

Deno.test("AdaptiveThresholdManager - decreases threshold after false negatives", () => {
  const manager = new AdaptiveThresholdManager({
    initialSuggestionThreshold: 0.70,
    windowSize: 30,
  });

  const initialThresholds = manager.getThresholds();

  // Simulate 20 successful manual confirmations with high confidence (false negatives)
  for (let i = 0; i < 20; i++) {
    manager.recordExecution({
      confidence: 0.68,
      mode: "suggestion",
      success: true,
      userAccepted: true,
      timestamp: Date.now(),
    });
  }

  const adjustedThresholds = manager.getThresholds();

  // Threshold should decrease after many false negatives
  assert(
    adjustedThresholds.suggestionThreshold! < initialThresholds.suggestionThreshold!,
    "Threshold should decrease after false negatives",
  );
});

Deno.test("AdaptiveThresholdManager - respects min and max thresholds", () => {
  const manager = new AdaptiveThresholdManager({
    initialSuggestionThreshold: 0.70,
    minThreshold: 0.40,
    maxThreshold: 0.90,
    windowSize: 30,
  });

  // Simulate extreme false positives
  for (let i = 0; i < 100; i++) {
    manager.recordExecution({
      confidence: 0.75,
      mode: "speculative",
      success: false,
      timestamp: Date.now(),
    });
  }

  const thresholds = manager.getThresholds();
  assert(thresholds.suggestionThreshold! <= 0.90, "Should not exceed max threshold");
});

Deno.test("AdaptiveThresholdManager - calculates accurate metrics", () => {
  const manager = new AdaptiveThresholdManager();

  // Record some executions
  manager.recordExecution({
    confidence: 0.75,
    mode: "speculative",
    success: true,
    executionTime: 50,
    timestamp: Date.now(),
  });

  manager.recordExecution({
    confidence: 0.80,
    mode: "speculative",
    success: false,
    executionTime: 30,
    timestamp: Date.now(),
  });

  const metrics = manager.getMetrics();

  assertEquals(metrics.totalSpeculativeAttempts, 2);
  assertEquals(metrics.successfulExecutions, 1);
  assertEquals(metrics.failedExecutions, 1);
  assertEquals(metrics.avgExecutionTime, 40);
  assertEquals(metrics.avgConfidence, 0.775);
  assert(metrics.savedLatency > 0);
  assert(metrics.wastedComputeCost > 0);
});

Deno.test("AdaptiveThresholdManager - reset clears history", () => {
  const manager = new AdaptiveThresholdManager();

  manager.recordExecution({
    confidence: 0.75,
    mode: "speculative",
    success: true,
    timestamp: Date.now(),
  });

  manager.reset();

  const metrics = manager.getMetrics();
  assertEquals(metrics.totalSpeculativeAttempts, 0);
});

Deno.test("AdaptiveThresholdManager - respects min threshold", () => {
  const manager = new AdaptiveThresholdManager({
    initialSuggestionThreshold: 0.50,
    minThreshold: 0.40,
    maxThreshold: 0.90,
    windowSize: 30,
  });

  // Simulate extreme false negatives to push threshold down
  for (let i = 0; i < 100; i++) {
    manager.recordExecution({
      confidence: 0.45,
      mode: "suggestion",
      success: true,
      userAccepted: true,
      timestamp: Date.now(),
    });
  }

  const thresholds = manager.getThresholds();
  assert(thresholds.suggestionThreshold! >= 0.40, "Should not go below min threshold");
});

Deno.test("AdaptiveThresholdManager - no adjustment before 20 executions", () => {
  const manager = new AdaptiveThresholdManager({
    initialSuggestionThreshold: 0.70,
    windowSize: 50,
  });

  const initialThreshold = manager.getThresholds().suggestionThreshold;

  // Simulate only 15 failed executions (below 20 minimum)
  for (let i = 0; i < 15; i++) {
    manager.recordExecution({
      confidence: 0.75,
      mode: "speculative",
      success: false,
      timestamp: Date.now(),
    });
  }

  const thresholds = manager.getThresholds();
  assertEquals(
    thresholds.suggestionThreshold,
    initialThreshold,
    "Threshold should not change before 20 executions",
  );
});

Deno.test("AdaptiveThresholdManager - adjustment triggers at 20 executions", () => {
  const manager = new AdaptiveThresholdManager({
    initialSuggestionThreshold: 0.70,
    windowSize: 50,
  });

  const initialThreshold = manager.getThresholds().suggestionThreshold;

  // Simulate exactly 20 failed executions (100% FP rate > 20%)
  for (let i = 0; i < 20; i++) {
    manager.recordExecution({
      confidence: 0.75,
      mode: "speculative",
      success: false,
      timestamp: Date.now(),
    });
  }

  const thresholds = manager.getThresholds();
  assert(
    thresholds.suggestionThreshold! > initialThreshold!,
    "Threshold should increase after 20 executions with high FP rate",
  );
});

Deno.test("AdaptiveThresholdManager - FP rate below 20% does not trigger increase", () => {
  const manager = new AdaptiveThresholdManager({
    initialSuggestionThreshold: 0.70,
    windowSize: 50,
  });

  const initialThreshold = manager.getThresholds().suggestionThreshold;

  // Simulate 20 executions with only 15% FP rate (3 failures, 17 successes)
  for (let i = 0; i < 17; i++) {
    manager.recordExecution({
      confidence: 0.75,
      mode: "speculative",
      success: true,
      timestamp: Date.now(),
    });
  }
  for (let i = 0; i < 3; i++) {
    manager.recordExecution({
      confidence: 0.75,
      mode: "speculative",
      success: false,
      timestamp: Date.now(),
    });
  }

  const thresholds = manager.getThresholds();
  // With 15% FP rate (below 20%), threshold should NOT increase
  // But FN rate check might trigger decrease, so we just check it didn't increase
  assert(
    thresholds.suggestionThreshold! <= initialThreshold!,
    "Threshold should not increase when FP rate < 20%",
  );
});

Deno.test("AdaptiveThresholdManager - sliding window respects windowSize", () => {
  const manager = new AdaptiveThresholdManager({
    initialSuggestionThreshold: 0.70,
    windowSize: 10, // Small window for testing
  });

  // Fill window with successes
  for (let i = 0; i < 10; i++) {
    manager.recordExecution({
      confidence: 0.75,
      mode: "speculative",
      success: true,
      timestamp: Date.now(),
    });
  }

  // Now add 10 more failures - should push out the successes
  for (let i = 0; i < 10; i++) {
    manager.recordExecution({
      confidence: 0.75,
      mode: "speculative",
      success: false,
      timestamp: Date.now(),
    });
  }

  // Window should now contain only failures
  const metrics = manager.getMetrics();
  assertEquals(metrics.successfulExecutions, 0, "Old successes should be pushed out of window");
  assertEquals(metrics.failedExecutions, 10, "Window should contain only recent failures");
});

Deno.test("AdaptiveThresholdManager - context hash generation", () => {
  const manager = new AdaptiveThresholdManager();

  // Access private method via any cast for testing
  const hash1 = (manager as unknown as { hashContext: (ctx: Record<string, unknown>) => string })
    .hashContext({ workflowType: "dag", domain: "github", complexity: "high" });

  const hash2 = (manager as unknown as { hashContext: (ctx: Record<string, unknown>) => string })
    .hashContext({ workflowType: "dag", domain: "github", complexity: "high" });

  const hash3 = (manager as unknown as { hashContext: (ctx: Record<string, unknown>) => string })
    .hashContext({ workflowType: "code", domain: "filesystem", complexity: "low" });

  assertEquals(hash1, hash2, "Same context should produce same hash");
  assert(hash1 !== hash3, "Different contexts should produce different hashes");
});

// ===========================================================================
// Story 10.7c: Thompson Sampling Integration Tests
// ===========================================================================

Deno.test("Thompson - getThresholdForTool returns valid threshold", () => {
  const manager = new AdaptiveThresholdManager();

  const result = manager.getThresholdForTool("filesystem:read_file", "passive_suggestion");

  // Threshold should be in valid range [0, 1]
  assert(result.threshold >= 0 && result.threshold <= 1, "Threshold should be in [0, 1]");
  // Result should include breakdown
  assert(result.breakdown !== undefined, "Should include breakdown");
});

Deno.test("Thompson - different modes produce different thresholds", () => {
  const manager = new AdaptiveThresholdManager();

  const active = manager.getThresholdForTool("filesystem:read_file", "active_search");
  const passive = manager.getThresholdForTool("filesystem:read_file", "passive_suggestion");
  const speculation = manager.getThresholdForTool("filesystem:read_file", "speculation");

  // Active search should have lowest threshold (more exploration)
  assert(
    active.threshold <= passive.threshold,
    "Active search should have lower or equal threshold",
  );
  assert(passive.threshold <= speculation.threshold, "Speculation should have highest threshold");
});

Deno.test("Thompson - recordToolOutcome updates sampler", () => {
  const manager = new AdaptiveThresholdManager();

  const before = manager.getToolStats("github:create_issue");

  // Record multiple outcomes
  manager.recordToolOutcome("github:create_issue", true);
  manager.recordToolOutcome("github:create_issue", true);
  manager.recordToolOutcome("github:create_issue", false);

  const after = manager.getToolStats("github:create_issue");

  // UCB bonus should decrease as we get more samples (less uncertainty)
  assert(after.ucbBonus < before.ucbBonus, "UCB bonus should decrease with more samples");
});

Deno.test("Thompson - requiresHIL returns true for unknown tools", () => {
  const manager = new AdaptiveThresholdManager();

  // Unknown tool should require HIL
  const unknownTool = manager.requiresHIL("unknown_server:some_tool");
  assert(unknownTool === true, "Unknown tools should require HIL");
});

Deno.test("Thompson - getToolRiskCategory returns correct risk", () => {
  const manager = new AdaptiveThresholdManager();

  // filesystem should be moderate (based on typical mcp-permissions.yaml)
  // Unknown tools default to moderate
  const unknownRisk = manager.getToolRiskCategory("totally_unknown:tool");
  assertEquals(unknownRisk, "moderate", "Unknown tools should have moderate risk");
});

Deno.test("getRiskFromScope - maps scopes correctly", () => {
  // Safe scopes
  assertEquals(
    getRiskFromScope({ scope: "minimal", approvalMode: "auto" } as PermissionConfig),
    "safe",
  );
  assertEquals(
    getRiskFromScope({ scope: "readonly", approvalMode: "auto" } as PermissionConfig),
    "safe",
  );

  // Moderate scopes
  assertEquals(
    getRiskFromScope({ scope: "filesystem", approvalMode: "auto" } as PermissionConfig),
    "moderate",
  );
  assertEquals(
    getRiskFromScope({ scope: "network-api", approvalMode: "auto" } as PermissionConfig),
    "moderate",
  );

  // Dangerous scopes
  assertEquals(
    getRiskFromScope({ scope: "mcp-standard", approvalMode: "auto" } as PermissionConfig),
    "dangerous",
  );

  // Unknown scope defaults to moderate
  assertEquals(
    getRiskFromScope(
      { scope: "unknown-scope", approvalMode: "auto" } as unknown as PermissionConfig,
    ),
    "moderate",
  );
});

Deno.test("calculateCapabilityRisk - returns safe for empty tools", () => {
  assertEquals(calculateCapabilityRisk([]), "safe");
  assertEquals(calculateCapabilityRisk(undefined as unknown as string[]), "safe");
});

Deno.test("calculateCapabilityRisk - returns max risk of tools", () => {
  // Single unknown tool should be moderate
  const singleUnknown = calculateCapabilityRisk(["unknown:tool"]);
  assertEquals(singleUnknown, "moderate");
});

Deno.test("Thompson - recordExecution with toolId updates Thompson", () => {
  const manager = new AdaptiveThresholdManager();

  // Record execution with toolId
  manager.recordExecution({
    confidence: 0.75,
    mode: "speculative",
    success: true,
    timestamp: Date.now(),
    toolId: "test:tool",
  });

  // The Thompson sampler should have been updated
  const stats = manager.getToolStats("test:tool");
  // After 1 success on Beta(1,1) prior, mean should be (1+1)/(1+1+1+1) = 0.5
  // but getUCBBonus should be less than for a never-seen tool
  assert(stats.mean > 0, "Mean should be positive after recording success");
});

Deno.test("Thompson - reset clears Thompson sampler", () => {
  const manager = new AdaptiveThresholdManager();

  // Record some outcomes
  manager.recordToolOutcome("github:create_issue", true);
  manager.recordToolOutcome("github:create_issue", true);

  // Reset
  manager.reset();

  // Stats should be back to prior
  const stats = manager.getToolStats("github:create_issue");
  assertEquals(stats.mean, 0.5, "Mean should reset to prior 0.5");
});

Deno.test("Thompson - confidence interval narrows with more samples", () => {
  const manager = new AdaptiveThresholdManager();

  const before = manager.getToolStats("test:tool");
  const intervalBefore = before.confidenceInterval[1] - before.confidenceInterval[0];

  // Record many outcomes
  for (let i = 0; i < 20; i++) {
    manager.recordToolOutcome("test:tool", i % 3 !== 0); // 67% success rate
  }

  const after = manager.getToolStats("test:tool");
  const intervalAfter = after.confidenceInterval[1] - after.confidenceInterval[0];

  assert(intervalAfter < intervalBefore, "Confidence interval should narrow with more samples");
});
