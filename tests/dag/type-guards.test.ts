/**
 * Type Safety Tests: Decision Command Type Guards
 *
 * Tests for H3 fix: isDecisionCommand type guard must validate command structure
 * to prevent runtime errors from invalid commands.
 *
 * @safety CRITICAL - Validates type safety fix
 */

import { assertEquals } from "jsr:@std/assert@1";
import { type DecisionCommand, isDecisionCommand } from "../../src/dag/loops/decision-waiter.ts";

Deno.test("Type Guard: isDecisionCommand - H3 Fix Validation", async (t) => {
  await t.step("Valid DecisionCommand with all optional fields → true", () => {
    const cmd: DecisionCommand = {
      type: "approval_response",
      approved: true,
      feedback: "Looks good",
      reason: "Test reason",
      new_requirement: "Updated requirement",
      available_context: { key: "value" },
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept valid command with all fields");
  });

  await t.step("Valid DecisionCommand with only required field (type) → true", () => {
    const cmd = {
      type: "continue",
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept command with only type field");
  });

  await t.step("Valid DecisionCommand with type + approved → true", () => {
    const cmd = {
      type: "approval_response",
      approved: true,
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept command with type and approved");
  });

  await t.step("Valid DecisionCommand with type + feedback → true", () => {
    const cmd = {
      type: "approval_response",
      feedback: "User feedback text",
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept command with type and feedback");
  });

  await t.step("Valid DecisionCommand with type + reason → true", () => {
    const cmd = {
      type: "abort",
      reason: "Emergency stop",
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept command with type and reason");
  });

  await t.step("Invalid: missing type field → false", () => {
    const cmd = {
      approved: true,
      feedback: "No type field",
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, false, "SAFETY: Should reject command without type field");
  });

  await t.step("Invalid: type is not a string → false", () => {
    const cmd = {
      type: 123, // number instead of string
      approved: true,
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, false, "SAFETY: Should reject command with non-string type");
  });

  await t.step("Invalid: type is null → false", () => {
    const cmd = {
      type: null,
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, false, "SAFETY: Should reject command with null type");
  });

  await t.step("Invalid: approved is not a boolean → false", () => {
    const cmd = {
      type: "approval_response",
      approved: "true", // string instead of boolean
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, false, "SAFETY: Should reject command with non-boolean approved");
  });

  await t.step("Invalid: feedback is not a string → false", () => {
    const cmd = {
      type: "approval_response",
      feedback: 123, // number instead of string
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, false, "SAFETY: Should reject command with non-string feedback");
  });

  await t.step("Invalid: reason is not a string → false", () => {
    const cmd = {
      type: "abort",
      reason: { text: "object instead of string" },
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, false, "SAFETY: Should reject command with non-string reason");
  });

  await t.step("Invalid: new_requirement is not a string → false", () => {
    const cmd = {
      type: "replan_dag",
      new_requirement: 123,
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, false, "SAFETY: Should reject command with non-string new_requirement");
  });

  await t.step("Invalid: null input → false", () => {
    const result = isDecisionCommand(null);
    assertEquals(result, false, "SAFETY: Should reject null input");
  });

  await t.step("Invalid: undefined input → false", () => {
    const result = isDecisionCommand(undefined);
    assertEquals(result, false, "SAFETY: Should reject undefined input");
  });

  await t.step("Invalid: primitive string → false", () => {
    const result = isDecisionCommand("not an object");
    assertEquals(result, false, "SAFETY: Should reject primitive string");
  });

  await t.step("Invalid: primitive number → false", () => {
    const result = isDecisionCommand(123);
    assertEquals(result, false, "SAFETY: Should reject primitive number");
  });

  await t.step("Invalid: array → false", () => {
    const result = isDecisionCommand([{ type: "continue" }]);
    assertEquals(result, false, "SAFETY: Should reject array input");
  });

  await t.step("Edge case: extra unknown fields should be allowed", () => {
    // Type guard should allow extra fields (forward compatibility)
    const cmd = {
      type: "continue",
      extraField: "should be allowed",
      anotherExtra: 123,
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should allow extra unknown fields for forward compatibility");
  });

  await t.step("Edge case: empty type string → true (technically valid)", () => {
    const cmd = {
      type: "",
    };

    const result = isDecisionCommand(cmd);
    // Empty string is still a string, so type guard should accept it
    // Validation of specific command types happens elsewhere
    assertEquals(
      result,
      true,
      "Should accept empty string type (validated later by command processor)",
    );
  });

  await t.step("Edge case: very long feedback string → true", () => {
    const cmd = {
      type: "approval_response",
      feedback: "x".repeat(10000), // 10KB feedback
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept very long feedback strings");
  });

  await t.step("Real-world: AIL continue command", () => {
    const cmd = {
      type: "continue",
      reason: "Execution looks good, proceeding",
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept real AIL continue command");
  });

  await t.step("Real-world: AIL abort command", () => {
    const cmd = {
      type: "abort",
      reason: "Critical error detected in layer output",
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept real AIL abort command");
  });

  await t.step("Real-world: HIL approval response", () => {
    const cmd = {
      type: "approval_response",
      checkpointId: "checkpoint-layer-2",
      approved: true,
      feedback: "Approved after review",
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept real HIL approval response");
  });

  await t.step("Real-world: HIL rejection response", () => {
    const cmd = {
      type: "approval_response",
      checkpointId: "checkpoint-layer-2",
      approved: false,
      feedback: "Rejected due to security concerns",
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept real HIL rejection response");
  });

  await t.step("Real-world: Permission escalation response", () => {
    const cmd = {
      type: "permission_escalation_response",
      approved: true,
      feedback: "Granting network access for this execution",
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, true, "Should accept real permission escalation response");
  });

  await t.step("SECURITY: Malformed command from untrusted source → false", () => {
    // Simulating a malicious or corrupted command
    const malformed = {
      type: "approval_response",
      approved: "yes", // String instead of boolean - could cause bugs
      feedback: 123, // Number instead of string
    };

    const result = isDecisionCommand(malformed);
    assertEquals(result, false, "SECURITY: Should reject malformed command to prevent bugs");
  });

  await t.step("SECURITY: Command with function fields → false", () => {
    const cmd = {
      type: "continue",
      feedback: () => "malicious function", // Function instead of string
    };

    const result = isDecisionCommand(cmd);
    assertEquals(result, false, "SECURITY: Should reject command with function fields");
  });
});
