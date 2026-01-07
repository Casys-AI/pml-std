/**
 * Tests for ConfigMigrator
 *
 * @module tests/unit/cli/config-migrator_test
 */

import { assert, assertEquals } from "@std/assert";
import { ConfigMigrator } from "../../../src/cli/config-migrator.ts";
import { join } from "jsr:@std/path@1.0.8";

Deno.test("ConfigMigrator - dry-run preview with sample config", async () => {
  const migrator = new ConfigMigrator();

  // Use test fixture
  const fixturesDir = join(Deno.cwd(), "tests", "fixtures");
  const configPath = join(fixturesDir, "mcp-config-sample.json");

  const result = await migrator.migrate({
    configPath,
    dryRun: true,
  });

  // Should succeed
  assert(result.success, "Dry-run should succeed");

  // Should detect 3 servers from fixture
  assertEquals(result.serversCount, 3, "Should detect 3 servers");

  // No tools extracted in dry-run
  assertEquals(result.toolsExtracted, 0, "Should not extract tools in dry-run");
  assertEquals(result.embeddingsGenerated, 0, "Should not generate embeddings in dry-run");

  // Config path should match
  assertEquals(result.configPath, configPath);
});

Deno.test({
  name: "ConfigMigrator - dry-run with non-existent config",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const migrator = new ConfigMigrator();

    const result = await migrator.migrate({
      configPath: "/non/existent/config.json",
      dryRun: true,
    });

    // Should fail
    assertEquals(result.success, false, "Should fail with non-existent config");
    assert(result.error, "Should have error message");
    assert(result.error!.includes("not found"), "Error should mention file not found");
  },
});

Deno.test({
  name: "ConfigMigrator - preview displays server info",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const migrator = new ConfigMigrator();

    const fixturesDir = join(Deno.cwd(), "tests", "fixtures");
    const configPath = join(fixturesDir, "mcp-config-sample.json");

    // Capture console output
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      await migrator.migrate({
        configPath,
        dryRun: true,
      });

      // Verify output contains expected information
      const fullOutput = logs.join("\n");
      assert(fullOutput.includes("DRY RUN"), "Should indicate dry-run mode");
      assert(fullOutput.includes("filesystem"), "Should list filesystem server");
      assert(fullOutput.includes("github"), "Should list github server");
      assert(fullOutput.includes("memory"), "Should list memory server");
      assert(fullOutput.includes("3"), "Should show server count");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test("ConfigMigrator - generates JSON config (not YAML) per ADR-009", async () => {
  const migrator = new ConfigMigrator();

  const fixturesDir = join(Deno.cwd(), "tests", "fixtures");
  const configPath = join(fixturesDir, "mcp-config-sample.json");

  // Capture console output to verify JSON format message
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };

  try {
    await migrator.migrate({
      configPath,
      dryRun: true,
    });

    const fullOutput = logs.join("\n");

    // Should mention config.json (not config.yaml)
    assert(fullOutput.includes("config.json"), "Should reference config.json output");

    // Should NOT mention YAML
    assert(!fullOutput.toLowerCase().includes("yaml"), "Should not mention YAML format");
  } finally {
    console.log = originalLog;
  }
});
