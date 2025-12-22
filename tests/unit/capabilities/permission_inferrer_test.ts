/**
 * Unit tests for PermissionInferrer
 *
 * Story: 7.7a Permission Inference - Automatic Permissions Analysis - AC8
 *
 * Tests:
 * - Network pattern detection (fetch, Deno.connect)
 * - Filesystem pattern detection (mcp.fs.read, mcp.fs.write, Deno.readFile)
 * - MCP tool pattern detection (mcp.github, mcp.slack)
 * - Env pattern detection (Deno.env, process.env)
 * - Mixed patterns → mcp-standard
 * - No patterns → minimal with high confidence
 * - Confidence scoring
 * - Error handling (malformed code)
 *
 * @module tests/unit/capabilities/permission_inferrer_test
 */

import { assertEquals, assertExists } from "@std/assert";
import { PermissionInferrer } from "../../../src/capabilities/permission-inferrer.ts";

Deno.test("PermissionInferrer - code with fetch() returns network-api", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const response = await fetch("https://api.example.com/data");
    const data = await response.json();
    return data;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "network-api");
  assertEquals(result.confidence >= 0.90, true);
  assertEquals(result.detectedPatterns.includes("fetch"), true);
});

Deno.test("PermissionInferrer - code with mcp.fs.read() returns readonly", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const content = await mcp.filesystem.read({ path: "/data/file.txt" });
    return content;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "readonly");
  assertEquals(result.confidence >= 0.90, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("filesystem")), true);
});

Deno.test("PermissionInferrer - code with mcp.fs.write() returns filesystem", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    await mcp.filesystem.write({ path: "/tmp/output.txt", content: "data" });
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "filesystem");
  assertEquals(result.confidence >= 0.90, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("filesystem")), true);
});

Deno.test("PermissionInferrer - code with mcp.github.createIssue() returns network-api", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const issue = await mcp.github.createIssue({
      owner: "user",
      repo: "project",
      title: "Bug report",
      body: "Description"
    });
    return issue;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "network-api");
  assertEquals(result.confidence >= 0.90, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("github")), true);
});

Deno.test("PermissionInferrer - code without I/O returns minimal with high confidence", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const a = 1 + 2;
    const b = a * 3;
    return { result: b };
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "minimal");
  assertEquals(result.confidence >= 0.95, true);
  assertEquals(result.detectedPatterns.length, 0);
});

Deno.test("PermissionInferrer - mixed fs + network returns mcp-standard", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const config = await mcp.filesystem.read({ path: "/config.json" });
    const response = await fetch("https://api.example.com/data");
    return { config, response };
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "mcp-standard");
  assertEquals(result.confidence >= 0.70, true);
  assertEquals(result.confidence <= 0.80, true);
  assertEquals(result.detectedPatterns.length >= 2, true);
});

Deno.test("PermissionInferrer - malformed code returns minimal with low confidence", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    this is completely invalid typescript code!!!
    @#$%^&*()
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "minimal");
  assertEquals(result.confidence, 0.0);
  assertEquals(result.detectedPatterns.length, 0);
});

Deno.test("PermissionInferrer - Deno.readFile returns readonly", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const data = await Deno.readFile("/path/to/file.txt");
    return new TextDecoder().decode(data);
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "readonly");
  assertEquals(result.confidence >= 0.90, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("Deno.readFile")), true);
});

Deno.test("PermissionInferrer - Deno.writeFile returns filesystem", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const data = new TextEncoder().encode("content");
    await Deno.writeFile("/tmp/output.txt", data);
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "filesystem");
  assertEquals(result.confidence >= 0.90, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("Deno.writeFile")), true);
});

Deno.test("PermissionInferrer - Deno.env access returns mcp-standard", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const apiKey = Deno.env.get("API_KEY");
    return { apiKey };
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "mcp-standard");
  assertEquals(result.confidence >= 0.80, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("Deno.env")), true);
});

Deno.test("PermissionInferrer - process.env access returns mcp-standard", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const nodeEnv = process.env.NODE_ENV;
    console.log(nodeEnv);
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "mcp-standard");
  assertEquals(result.confidence >= 0.80, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("process.env")), true);
});

Deno.test("PermissionInferrer - mcp.slack returns network-api", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    await mcp.slack.postMessage({
      channel: "#general",
      text: "Hello from the bot!"
    });
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "network-api");
  assertEquals(result.confidence >= 0.90, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("slack")), true);
});

Deno.test("PermissionInferrer - mcp.tavily returns network-api", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const results = await mcp.tavily.search({ query: "TypeScript tutorials" });
    return results;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "network-api");
  assertEquals(result.confidence >= 0.90, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("tavily")), true);
});

Deno.test("PermissionInferrer - Deno.connect returns network-api", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const conn = await Deno.connect({ hostname: "example.com", port: 443 });
    conn.close();
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "network-api");
  assertEquals(result.confidence >= 0.90, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("Deno.connect")), true);
});

Deno.test("PermissionInferrer - unknown MCP tool returns mcp-standard with lower confidence", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const result = await mcp.unknownTool.doSomething({ param: "value" });
    return result;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "mcp-standard");
  assertEquals(result.confidence === 0.50, true);
  assertEquals(result.detectedPatterns.some((p) => p.includes("unknownTool")), true);
});

Deno.test("PermissionInferrer - multiple network patterns returns high confidence", async () => {
  const inferrer = new PermissionInferrer();

  // Use different network patterns to get multiple unique patterns
  const code = `
    const resp1 = await fetch("https://api1.example.com/data");
    const conn = await Deno.connect({ hostname: "api2.example.com", port: 443 });
    return [resp1, conn];
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "network-api");
  assertEquals(result.confidence >= 0.95, true);
  assertEquals(result.detectedPatterns.length >= 2, true);
});

Deno.test("PermissionInferrer - mcp.kubernetes returns mcp-standard", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const pods = await mcp.kubernetes.listPods({ namespace: "default" });
    return pods;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "mcp-standard");
  // kubernetes is a known mcp-standard tool, so confidence depends on category classification
  assertEquals(result.confidence === 0.50, true); // 'unknown' category triggers 0.50 confidence
  assertEquals(result.detectedPatterns.some((p) => p.includes("kubernetes")), true);
});

Deno.test("PermissionInferrer - mcp.docker returns mcp-standard", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const containers = await mcp.docker.listContainers();
    return containers;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "mcp-standard");
  // docker is a known mcp-standard tool, so confidence depends on category classification
  assertEquals(result.confidence === 0.50, true); // 'unknown' category triggers 0.50 confidence
  assertEquals(result.detectedPatterns.some((p) => p.includes("docker")), true);
});

// Integration test with CapabilityStore
Deno.test({
  name: "PermissionInferrer - integration with CapabilityStore",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { PGliteClient } = await import("../../../src/db/client.ts");
    const { getAllMigrations, MigrationRunner } = await import("../../../src/db/migrations.ts");
    const { CapabilityStore } = await import("../../../src/capabilities/capability-store.ts");
    const { PermissionInferrer } = await import("../../../src/capabilities/permission-inferrer.ts");

    // Setup test database
    const db = new PGliteClient(":memory:");
    await db.connect();
    const runner = new MigrationRunner(db);
    await runner.runUp(getAllMigrations());

    // Mock EmbeddingModel
    class MockEmbeddingModel {
      async load(): Promise<void> {}
      async encode(_text: string): Promise<number[]> {
        return new Array(1024).fill(0.5);
      }
      isLoaded(): boolean {
        return true;
      }
    }

    const permissionInferrer = new PermissionInferrer();
    const model = new MockEmbeddingModel();
    const store = new CapabilityStore(
      db,
      model as any,
      undefined, // schemaInferrer
      permissionInferrer,
    );

    const code = `
      const response = await fetch("https://api.example.com/data");
      return response.json();
    `;

    const { capability } = await store.saveCapability({
      code,
      intent: "Fetch data from API",
      durationMs: 100,
      success: true,
    });

    // Verify permission was inferred and stored
    assertExists(capability.permissionSet);
    assertEquals(capability.permissionSet, "network-api");
    assertExists(capability.permissionConfidence);
    assertEquals(capability.permissionConfidence >= 0.90, true);

    await db.close();
  },
});

// =============================================================================
// YAML Config Loading Tests (Story 7.7a - config/mcp-permissions.yaml)
// =============================================================================

Deno.test("PermissionInferrer - mcp.playwright returns mcp-standard (from YAML config)", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    await mcp.playwright.click({ selector: "#button" });
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "mcp-standard");
  assertEquals(result.detectedPatterns.some((p) => p.includes("playwright")), true);
});

Deno.test("PermissionInferrer - mcp.postgres returns network-api (from YAML config)", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const result = await mcp.postgres.query({ sql: "SELECT * FROM users" });
    return result;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "network-api");
  assertEquals(result.detectedPatterns.some((p) => p.includes("postgres")), true);
});

Deno.test("PermissionInferrer - mcp.sqlite returns filesystem (from YAML config)", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const db = await mcp.sqlite.open({ path: "./data.db" });
    return db;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "filesystem");
  assertEquals(result.detectedPatterns.some((p) => p.includes("sqlite")), true);
});

Deno.test("PermissionInferrer - mcp.brave_search returns network-api (from YAML config)", async () => {
  const inferrer = new PermissionInferrer();

  // Note: Use underscore (brave_search) not hyphen (brave-search)
  // Hyphen requires bracket notation which AST parser handles differently
  const code = `
    const results = await mcp.brave_search.search({ query: "deno runtime" });
    return results;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "network-api");
  assertEquals(result.detectedPatterns.some((p) => p.includes("brave_search")), true);
});

Deno.test("PermissionInferrer - mcp.memory returns mcp-standard (from YAML config)", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const context = await mcp.memory.recall({ key: "user_preferences" });
    return context;
  `;

  const result = await inferrer.inferPermissions(code);

  // Memory tools still need mcp-standard since they're MCP calls
  // (minimal is only for code with NO detected patterns)
  assertEquals(result.permissionSet, "mcp-standard");
  assertEquals(result.detectedPatterns.some((p) => p.includes("memory")), true);
});

Deno.test("PermissionInferrer - mcp.context7 returns network-api (from YAML config)", async () => {
  const inferrer = new PermissionInferrer();

  const code = `
    const docs = await mcp.context7.search({ query: "authentication" });
    return docs;
  `;

  const result = await inferrer.inferPermissions(code);

  assertEquals(result.permissionSet, "network-api");
  assertEquals(result.detectedPatterns.some((p) => p.includes("context7")), true);
});
