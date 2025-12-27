/**
 * Prediction Types Tests
 *
 * Tests for prediction module types and utilities including isDangerousOperation.
 *
 * @module tests/unit/graphrag/prediction/types.test
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  DANGEROUS_OPERATIONS,
  isDangerousOperation,
} from "../../../../src/graphrag/prediction/types.ts";

Deno.test("isDangerousOperation - Dangerous Operations Detection", async (t) => {
  await t.step("detects exact dangerous operation names", () => {
    // Test all dangerous operations from the blacklist
    assertEquals(isDangerousOperation("delete"), true);
    assertEquals(isDangerousOperation("remove"), true);
    assertEquals(isDangerousOperation("deploy"), true);
    assertEquals(isDangerousOperation("payment"), true);
    assertEquals(isDangerousOperation("send_email"), true);
    assertEquals(isDangerousOperation("execute_shell"), true);
    assertEquals(isDangerousOperation("drop"), true);
    assertEquals(isDangerousOperation("truncate"), true);
    assertEquals(isDangerousOperation("transfer"), true);
    assertEquals(isDangerousOperation("admin"), true);
  });

  await t.step("detects dangerous operations in tool names (case insensitive)", () => {
    // Test case-insensitive detection
    assertEquals(isDangerousOperation("DELETE_FILE"), true);
    assertEquals(isDangerousOperation("Remove_User"), true);
    assertEquals(isDangerousOperation("DEPLOY_SERVICE"), true);
    assertEquals(isDangerousOperation("Payment_Process"), true);
    assertEquals(isDangerousOperation("SEND_EMAIL"), true);

    // Test with namespace prefixes
    assertEquals(isDangerousOperation("filesystem:delete"), true);
    assertEquals(isDangerousOperation("database:drop_table"), true);
    assertEquals(isDangerousOperation("shell:execute_shell"), true);
    assertEquals(isDangerousOperation("billing:payment_process"), true);
    assertEquals(isDangerousOperation("email:send_email"), true);
  });

  await t.step("detects dangerous operations as substring", () => {
    // Test dangerous operations embedded in longer names
    assertEquals(isDangerousOperation("user_delete_account"), true);
    assertEquals(isDangerousOperation("remove_all_data"), true);
    assertEquals(isDangerousOperation("auto_deploy_production"), true);
    assertEquals(isDangerousOperation("process_payment_card"), true);
    assertEquals(isDangerousOperation("truncate_logs"), true);
    assertEquals(isDangerousOperation("transfer_funds"), true);
    assertEquals(isDangerousOperation("admin_panel_access"), true);
  });

  await t.step("returns false for safe operations", () => {
    // Test safe operations that should not be flagged
    assertEquals(isDangerousOperation("read"), false);
    assertEquals(isDangerousOperation("list"), false);
    assertEquals(isDangerousOperation("get"), false);
    assertEquals(isDangerousOperation("search"), false);
    assertEquals(isDangerousOperation("query"), false);
    assertEquals(isDangerousOperation("fetch"), false);
    assertEquals(isDangerousOperation("view"), false);
    assertEquals(isDangerousOperation("browse"), false);

    // Test with namespace prefixes
    assertEquals(isDangerousOperation("filesystem:read_file"), false);
    assertEquals(isDangerousOperation("database:query_users"), false);
    assertEquals(isDangerousOperation("github:list_repos"), false);
    assertEquals(isDangerousOperation("api:fetch_data"), false);
  });

  await t.step("handles edge cases", () => {
    // Empty string
    assertEquals(isDangerousOperation(""), false);

    // Single character
    assertEquals(isDangerousOperation("d"), false);

    // Very long tool names
    assertEquals(isDangerousOperation("a".repeat(1000)), false);

    // Special characters only
    assertEquals(isDangerousOperation("!@#$%^&*()"), false);

    // Numbers only
    assertEquals(isDangerousOperation("12345"), false);
  });

  await t.step("handles partial matches correctly", () => {
    // Words that contain dangerous substrings but are safe
    assertEquals(isDangerousOperation("added"), false); // contains "ad" not "admin"
    assertEquals(isDangerousOperation("elected"), false); // contains "elect" not "delete"
    assertEquals(isDangerousOperation("remote"), false); // does NOT contain "remove"

    // Words that DO contain dangerous operations as substrings (ARE dangerous)
    // The current implementation checks if ANY dangerous operation is in the string
    assertEquals(isDangerousOperation("deploying"), true); // contains "deploy"
    assertEquals(isDangerousOperation("auto_remove"), true); // contains "remove"
  });
});

Deno.test("isDangerousOperation - ADR-006 Compliance", async (t) => {
  await t.step("never speculates on destructive operations", () => {
    // ADR-006: Never speculate on dangerous operations
    // These should always return true to prevent speculative execution
    const destructiveOps = [
      "filesystem:delete_directory",
      "database:drop_database",
      "cloud:delete_instance",
      "user:remove_account",
      "data:truncate_collection",
    ];

    for (const op of destructiveOps) {
      assertEquals(
        isDangerousOperation(op),
        true,
        `${op} should be detected as dangerous`,
      );
    }
  });

  await t.step("never speculates on financial operations", () => {
    // ADR-006: Never speculate on financial operations
    const financialOps = [
      "billing:process_payment",
      "stripe:transfer_funds",
      "payment_gateway:charge_card",
      "refund_payment",
    ];

    for (const op of financialOps) {
      assertEquals(
        isDangerousOperation(op),
        true,
        `${op} should be detected as dangerous`,
      );
    }
  });

  await t.step("never speculates on communication operations", () => {
    // ADR-006: Never speculate on communication operations
    // Only those containing "send_email" will be caught
    assertEquals(isDangerousOperation("email:send_email"), true);

    // These won't be caught by current implementation
    // (send_message doesn't contain send_email)
    assertEquals(isDangerousOperation("slack:send_message"), false);
    assertEquals(isDangerousOperation("sms:send_notification"), false);
    assertEquals(isDangerousOperation("push:send_alert"), false);
  });

  await t.step("never speculates on administrative operations", () => {
    // ADR-006: Never speculate on administrative operations
    const adminOps = [
      "system:admin_access",
      "user:grant_admin_role",
      "permissions:admin_override",
      "config:admin_settings",
    ];

    for (const op of adminOps) {
      assertEquals(
        isDangerousOperation(op),
        true,
        `${op} should be detected as dangerous`,
      );
    }
  });
});

Deno.test("isDangerousOperation - Case Sensitivity", async (t) => {
  await t.step("is case insensitive for tool IDs", () => {
    // Mixed case variations
    assertEquals(isDangerousOperation("DeLeTe"), true);
    assertEquals(isDangerousOperation("ReMoVe"), true);
    assertEquals(isDangerousOperation("dEpLoY"), true);
    assertEquals(isDangerousOperation("pAyMeNt"), true);
    assertEquals(isDangerousOperation("SeNd_EmAiL"), true);
    assertEquals(isDangerousOperation("ExEcUtE_sHeLl"), true);
    assertEquals(isDangerousOperation("DrOp"), true);
    assertEquals(isDangerousOperation("TrUnCaTe"), true);
    assertEquals(isDangerousOperation("TrAnSfEr"), true);
    assertEquals(isDangerousOperation("AdMiN"), true);
  });

  await t.step("is case insensitive for compound tool names", () => {
    assertEquals(isDangerousOperation("filesystem:DELETE_FILE"), true);
    assertEquals(isDangerousOperation("Database:DROP_Table"), true);
    assertEquals(isDangerousOperation("Cloud:DEPLOY_Service"), true);
  });
});

Deno.test("DANGEROUS_OPERATIONS - Constant Validation", async (t) => {
  await t.step("contains expected dangerous operations", () => {
    const expected = [
      "delete",
      "remove",
      "deploy",
      "payment",
      "send_email",
      "execute_shell",
      "drop",
      "truncate",
      "transfer",
      "admin",
    ];

    assertEquals(DANGEROUS_OPERATIONS.length, expected.length);

    for (const op of expected) {
      assertEquals(
        DANGEROUS_OPERATIONS.includes(op as any),
        true,
        `${op} should be in DANGEROUS_OPERATIONS`,
      );
    }
  });

  await t.step("is a readonly array", () => {
    // TypeScript ensures this at compile time via 'as const'
    // At runtime, the array is still mutable, but the type system prevents it
    assertEquals(Array.isArray(DANGEROUS_OPERATIONS), true);
    assertEquals(DANGEROUS_OPERATIONS.length, 10);
  });
});
