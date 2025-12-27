/**
 * Tests for CLI utilities
 *
 * @module tests/unit/cli/utils_test
 */

import { assert, assertEquals } from "@std/assert";
import {
  detectMCPConfigPath,
  getLegacyConfigPath,
  getPmlConfigDir,
  getPmlConfigPath,
  getPmlDatabasePath,
  getWorkflowTemplatesPath,
} from "../../../src/cli/utils.ts";

/**
 * Note: These tests run on the actual OS and verify path generation logic.
 * Mocking Deno.build.os is not possible due to property descriptor limitations.
 */

Deno.test("detectMCPConfigPath - returns OS-specific path", () => {
  const path = detectMCPConfigPath();
  const os = Deno.build.os;

  // Verify path contains OS-specific components
  switch (os) {
    case "darwin":
      assert(path.includes("Library/Application Support/Claude"));
      assert(path.endsWith("claude_desktop_config.json"));
      break;
    case "linux":
      assert(path.includes(".config/Claude"));
      assert(path.endsWith("claude_desktop_config.json"));
      break;
    case "windows":
      assert(path.includes("Claude"));
      assert(path.endsWith("claude_desktop_config.json"));
      break;
  }
});

Deno.test("getPmlConfigDir - returns valid directory path", () => {
  const dir = getPmlConfigDir();

  // Should end with .pml
  assert(dir.endsWith(".pml"));

  // Should contain home directory reference
  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (homeDir) {
    assert(dir.startsWith(homeDir), `Expected ${dir} to start with ${homeDir}`);
  }
});

Deno.test("getPmlConfigPath - returns valid config path (JSON)", () => {
  const path = getPmlConfigPath();

  // Should end with config.json (ADR-009)
  assert(path.endsWith("config.json"));

  // Should contain .pml directory
  assert(path.includes(".pml"));
});

Deno.test("getLegacyConfigPath - returns YAML config path (deprecated)", () => {
  const path = getLegacyConfigPath();

  // Should end with config.yaml (legacy)
  assert(path.endsWith("config.yaml"));

  // Should contain .pml directory
  assert(path.includes(".pml"));
});

Deno.test("getPmlDatabasePath - returns valid database path", () => {
  // Ensure both new and legacy env vars are not set for this test
  const oldCaiPath = Deno.env.get("CAI_DB_PATH");
  const oldAgentCardsPath = Deno.env.get("AGENTCARDS_DB_PATH");
  Deno.env.delete("CAI_DB_PATH");
  Deno.env.delete("AGENTCARDS_DB_PATH");

  try {
    const path = getPmlDatabasePath();

    // Should end with .pml.db
    assert(path.endsWith(".pml.db"));

    // Should contain .pml directory
    assert(path.includes(".pml"));
  } finally {
    // Restore original env vars
    if (oldCaiPath) Deno.env.set("CAI_DB_PATH", oldCaiPath);
    if (oldAgentCardsPath) Deno.env.set("AGENTCARDS_DB_PATH", oldAgentCardsPath);
  }
});

Deno.test("All paths use correct separators for OS", () => {
  const os = Deno.build.os;
  const separator = os === "windows" ? "\\" : "/";

  const configDir = getPmlConfigDir();
  const configPath = getPmlConfigPath();
  const dbPath = getPmlDatabasePath();

  // Verify paths use correct separator
  assert(configDir.includes(separator));
  assert(configPath.includes(separator));
  assert(dbPath.includes(separator));
});

Deno.test("Paths are consistent across utility functions", () => {
  // Ensure both new and legacy env vars are not set for this test
  const oldCaiPath = Deno.env.get("CAI_DB_PATH");
  const oldAgentCardsPath = Deno.env.get("AGENTCARDS_DB_PATH");
  Deno.env.delete("CAI_DB_PATH");
  Deno.env.delete("AGENTCARDS_DB_PATH");

  try {
    const configDir = getPmlConfigDir();
    const configPath = getPmlConfigPath();
    const dbPath = getPmlDatabasePath();

    // Config path should start with config dir
    assert(configPath.startsWith(configDir));

    // Database path should start with config dir (when no env var set)
    assert(dbPath.startsWith(configDir));
  } finally {
    // Restore original env vars
    if (oldCaiPath) Deno.env.set("CAI_DB_PATH", oldCaiPath);
    if (oldAgentCardsPath) Deno.env.set("AGENTCARDS_DB_PATH", oldAgentCardsPath);
  }
});

Deno.test("getPmlDatabasePath - respects CAI_DB_PATH env var", () => {
  const customPath = "/workspaces/PML/.pml.db";

  // Set custom path
  Deno.env.set("CAI_DB_PATH", customPath);

  try {
    const path = getPmlDatabasePath();
    assertEquals(path, customPath);
  } finally {
    // Clean up
    Deno.env.delete("CAI_DB_PATH");
  }
});

Deno.test("getPmlDatabasePath - uses default when env var not set", () => {
  // Ensure both new and legacy env vars are not set
  const oldCaiPath = Deno.env.get("CAI_DB_PATH");
  const oldAgentCardsPath = Deno.env.get("AGENTCARDS_DB_PATH");
  Deno.env.delete("CAI_DB_PATH");
  Deno.env.delete("AGENTCARDS_DB_PATH");

  try {
    const path = getPmlDatabasePath();

    // Should use default path
    assert(path.includes(".pml"));
    assert(path.endsWith(".pml.db"));
  } finally {
    // Restore original env vars
    if (oldCaiPath) Deno.env.set("CAI_DB_PATH", oldCaiPath);
    if (oldAgentCardsPath) Deno.env.set("AGENTCARDS_DB_PATH", oldAgentCardsPath);
  }
});

Deno.test("Legacy YAML path differs from JSON path only in extension", () => {
  const jsonPath = getPmlConfigPath();
  const yamlPath = getLegacyConfigPath();

  // Same base path
  const jsonBase = jsonPath.replace(".json", "");
  const yamlBase = yamlPath.replace(".yaml", "");

  assert(jsonBase === yamlBase, "Base paths should be identical");

  // Different extensions
  assert(jsonPath.endsWith(".json"));
  assert(yamlPath.endsWith(".yaml"));
});

Deno.test("getWorkflowTemplatesPath - respects CAI_WORKFLOW_PATH env var", () => {
  const customPath = "playground/config/workflow-templates.yaml";

  // Set custom path
  Deno.env.set("CAI_WORKFLOW_PATH", customPath);

  try {
    const path = getWorkflowTemplatesPath();
    assertEquals(path, customPath);
  } finally {
    // Clean up
    Deno.env.delete("CAI_WORKFLOW_PATH");
  }
});

Deno.test("getWorkflowTemplatesPath - uses default when env var not set", () => {
  // Ensure both new and legacy env vars are not set
  const oldCaiPath = Deno.env.get("CAI_WORKFLOW_PATH");
  const oldAgentCardsPath = Deno.env.get("AGENTCARDS_WORKFLOW_PATH");
  Deno.env.delete("CAI_WORKFLOW_PATH");
  Deno.env.delete("AGENTCARDS_WORKFLOW_PATH");

  try {
    const path = getWorkflowTemplatesPath();

    // Should use default path
    assertEquals(path, "./config/workflow-templates.yaml");
  } finally {
    // Restore original env vars
    if (oldCaiPath) Deno.env.set("CAI_WORKFLOW_PATH", oldCaiPath);
    if (oldAgentCardsPath) Deno.env.set("AGENTCARDS_WORKFLOW_PATH", oldAgentCardsPath);
  }
});

Deno.test("getWorkflowTemplatesPath - supports various path formats", () => {
  const testPaths = [
    "playground/config/workflow-templates.yaml", // Relative path
    "/absolute/path/workflow-templates.yaml", // Absolute path
    "./config/workflow-templates.yaml", // Dot-relative path
    "../parent/workflow-templates.yaml", // Parent directory path
  ];

  for (const testPath of testPaths) {
    Deno.env.set("CAI_WORKFLOW_PATH", testPath);

    try {
      const path = getWorkflowTemplatesPath();
      assertEquals(
        path,
        testPath,
        `Should return custom path: ${testPath}`,
      );
    } finally {
      Deno.env.delete("CAI_WORKFLOW_PATH");
    }
  }
});
