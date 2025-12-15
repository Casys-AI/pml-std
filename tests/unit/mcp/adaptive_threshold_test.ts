/**
 * Unit tests for AdaptiveThresholdManager
 *
 * Tests adaptive threshold learning functionality
 */

import { assert, assertEquals } from "@std/assert";
import { AdaptiveThresholdManager } from "../../../src/mcp/adaptive-threshold.ts";

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
