/**
 * Unit tests for Playground Workflow Templates (Story 1.3)
 *
 * Validates playground/config/workflow-templates.yaml:
 * - AC #1: Contains 3+ workflows with required patterns
 * - AC #2: Format compatible with pml workflows sync
 * - AC #3: Comments explaining each workflow
 *
 * NOTE: These tests are currently ignored as the playground config feature
 * is not yet implemented. See docs/stories/playground/1-3-workflow-templates-configuration.md
 *
 * @module tests/unit/graphrag/workflow_loader_playground_test
 */

import { assertEquals, assertExists } from "@std/assert";
import { WorkflowLoader } from "../../../src/graphrag/workflow-loader.ts";
import { parse as parseYaml } from "@std/yaml";

const PLAYGROUND_TEMPLATES_PATH = "playground/config/workflow-templates.yaml";

Deno.test({
  name: "Playground Templates - File exists and is readable",
  ignore: true,
  fn: async () => {
    const content = await Deno.readTextFile(PLAYGROUND_TEMPLATES_PATH);
    assertExists(content);
    assertEquals(content.length > 0, true, "File should not be empty");
  },
});

Deno.test({
  name: "Playground Templates - Valid YAML syntax",
  ignore: true,
  fn: async () => {
    const content = await Deno.readTextFile(PLAYGROUND_TEMPLATES_PATH);
    const parsed = parseYaml(content);

    assertExists(parsed, "YAML should parse successfully");
    assertExists((parsed as any).workflows, "Root key 'workflows' should exist");
    assertEquals(
      Array.isArray((parsed as any).workflows),
      true,
      "workflows should be an array",
    );
  },
});

Deno.test({
  name: "Playground Templates - AC #1: Contains 3+ workflows",
  ignore: true,
  fn: async () => {
    const loader = new WorkflowLoader();
    const workflows = await loader.loadFromYaml(PLAYGROUND_TEMPLATES_PATH);

    assertEquals(
      workflows.length >= 3,
      true,
      `Expected at least 3 workflows, got ${workflows.length}`,
    );
  },
});

Deno.test({
  name: "Playground Templates - AC #1: Parallel execution pattern exists",
  ignore: true,
  fn: async () => {
    const loader = new WorkflowLoader();
    const workflows = await loader.loadFromYaml(PLAYGROUND_TEMPLATES_PATH);

    const parallelWorkflow = workflows.find((w) =>
      w.name.includes("parallel") || w.name.includes("fan")
    );
    assertExists(
      parallelWorkflow,
      "Should have a workflow demonstrating parallel execution",
    );

    // Parallel workflows use edges format with multiple edges from same source
    assertExists(parallelWorkflow.edges, "Parallel workflow should use edges format");
    assertEquals(
      parallelWorkflow.edges!.length >= 3,
      true,
      "Parallel workflow should have at least 3 parallel edges",
    );
  },
});

Deno.test({
  name: "Playground Templates - AC #1: Sequential pattern exists (filesystem → memory)",
  ignore: true,
  fn: async () => {
    const loader = new WorkflowLoader();
    const workflows = await loader.loadFromYaml(PLAYGROUND_TEMPLATES_PATH);

    const sequentialWorkflow = workflows.find(
      (w) =>
        w.name.includes("knowledge_graph") ||
        w.name.includes("document") ||
        (w.steps &&
          w.steps.some((s) => s.includes("filesystem")) &&
          w.steps.some((s) => s.includes("memory"))),
    );

    assertExists(
      sequentialWorkflow,
      "Should have a workflow demonstrating filesystem → memory pattern",
    );

    // Sequential workflows can use either steps or edges
    const hasSequence = (sequentialWorkflow.steps && sequentialWorkflow.steps.length >= 2) ||
      (sequentialWorkflow.edges && sequentialWorkflow.edges.length >= 1);
    assertEquals(hasSequence, true, "Sequential workflow should have steps or edges");
  },
});

Deno.test({
  name: "Playground Templates - AC #1: Multi-level DAG exists",
  ignore: true,
  fn: async () => {
    const loader = new WorkflowLoader();
    const workflows = await loader.loadFromYaml(PLAYGROUND_TEMPLATES_PATH);

    const dagWorkflow = workflows.find(
      (w) =>
        w.name.includes("multi") ||
        (w.edges && w.edges.length >= 5), // Multi-level DAG has many edges
    );

    assertExists(dagWorkflow, "Should have a multi-level DAG workflow");
    assertExists(dagWorkflow.edges, "Multi-level DAG should use edges format");
    assertEquals(
      dagWorkflow.edges!.length >= 5,
      true,
      "Multi-level DAG should have at least 5 edges for complexity",
    );
  },
});

Deno.test({
  name: "Playground Templates - AC #2: Format compatible with WorkflowLoader",
  ignore: true,
  fn: async () => {
    const loader = new WorkflowLoader();
    const workflows = await loader.loadFromYaml(PLAYGROUND_TEMPLATES_PATH);
    const validationResults = loader.validate(workflows);

    // All workflows should be valid
    const invalidWorkflows = validationResults.filter((r) => !r.valid);
    assertEquals(
      invalidWorkflows.length,
      0,
      `Found ${invalidWorkflows.length} invalid workflows: ${
        invalidWorkflows.map((r) => r.workflow.name).join(", ")
      }`,
    );

    // Should convert to edges without errors
    const edges = loader.convertToEdges(workflows);
    assertEquals(edges.length >= 3, true, "Should generate at least 3 edges total");
  },
});

Deno.test({
  name: "Playground Templates - AC #2: Each workflow has required fields",
  ignore: true,
  fn: async () => {
    const loader = new WorkflowLoader();
    const workflows = await loader.loadFromYaml(PLAYGROUND_TEMPLATES_PATH);

    for (const workflow of workflows) {
      assertExists(workflow.name, `Workflow should have a name: ${JSON.stringify(workflow)}`);
      assertEquals(
        typeof workflow.name,
        "string",
        `Workflow name should be a string: ${workflow.name}`,
      );

      // Must have either steps OR edges (not both, not neither)
      const hasSteps = workflow.steps && Array.isArray(workflow.steps);
      const hasEdges = workflow.edges && Array.isArray(workflow.edges);

      assertEquals(
        hasSteps || hasEdges,
        true,
        `Workflow '${workflow.name}' must have either steps or edges`,
      );
      assertEquals(
        !(hasSteps && hasEdges),
        true,
        `Workflow '${workflow.name}' cannot have both steps and edges`,
      );
    }
  },
});

Deno.test({
  name: "Playground Templates - AC #2: Tool IDs use correct format (serverId:toolName)",
  ignore: true,
  fn: async () => {
    const loader = new WorkflowLoader();
    const workflows = await loader.loadFromYaml(PLAYGROUND_TEMPLATES_PATH);

    const toolIdPattern = /^[a-z-]+:[a-z_]+$/;

    for (const workflow of workflows) {
      const toolIds: string[] = [];

      if (workflow.steps) {
        toolIds.push(...workflow.steps);
      }

      if (workflow.edges) {
        for (const [from, to] of workflow.edges) {
          toolIds.push(from, to);
        }
      }

      for (const toolId of toolIds) {
        assertEquals(
          toolIdPattern.test(toolId),
          true,
          `Tool ID '${toolId}' in workflow '${workflow.name}' should match format 'serverId:toolName'`,
        );
      }
    }
  },
});

Deno.test({
  name: "Playground Templates - AC #2: Tool IDs reference configured MCP servers",
  ignore: true,
  fn: async () => {
    const loader = new WorkflowLoader();
    const workflows = await loader.loadFromYaml(PLAYGROUND_TEMPLATES_PATH);

    // Load configured MCP servers from playground/config/mcp-servers.json
    const mcpConfig = JSON.parse(
      await Deno.readTextFile("playground/config/mcp-servers.json"),
    );
    const configuredServers = new Set(Object.keys(mcpConfig.mcpServers));

    // Extract all server IDs from tool IDs in workflows
    const usedServers = new Set<string>();

    for (const workflow of workflows) {
      const toolIds: string[] = [];

      if (workflow.steps) {
        toolIds.push(...workflow.steps);
      }

      if (workflow.edges) {
        for (const [from, to] of workflow.edges) {
          toolIds.push(from, to);
        }
      }

      for (const toolId of toolIds) {
        const [serverId] = toolId.split(":");
        usedServers.add(serverId);
      }
    }

    // All used servers should be configured
    for (const serverId of usedServers) {
      assertEquals(
        configuredServers.has(serverId),
        true,
        `Server '${serverId}' used in workflows but not configured in mcp-servers.json. Configured: ${
          Array.from(configuredServers).join(", ")
        }`,
      );
    }
  },
});

Deno.test({
  name: "Playground Templates - AC #3: File contains explanatory comments",
  ignore: true,
  fn: async () => {
    const content = await Deno.readTextFile(PLAYGROUND_TEMPLATES_PATH);
    const lines = content.split("\n");

    // Count comment lines (lines starting with #)
    const commentLines = lines.filter((line) => line.trim().startsWith("#"));

    assertEquals(
      commentLines.length >= 10,
      true,
      `Expected at least 10 comment lines for documentation, got ${commentLines.length}`,
    );

    // Check for specific educational keywords in comments
    const fullComments = commentLines.join(" ").toLowerCase();

    const requiredKeywords = [
      "parallel", // Explains parallelization
      "sequential", // Explains sequential patterns
      "dag", // Explains DAG structure
      "graphrag", // Mentions GraphRAG learning
    ];

    for (const keyword of requiredKeywords) {
      assertEquals(
        fullComments.includes(keyword),
        true,
        `Comments should explain '${keyword}' pattern`,
      );
    }
  },
});

Deno.test({
  name: "Playground Templates - Edge conversion produces correct structure",
  ignore: true,
  fn: async () => {
    const loader = new WorkflowLoader();
    const workflows = await loader.loadFromYaml(PLAYGROUND_TEMPLATES_PATH);
    const edges = loader.convertToEdges(workflows);

    // Each edge should have from, to, and workflowName
    for (const edge of edges) {
      assertExists(edge.from, "Edge should have 'from' field");
      assertExists(edge.to, "Edge should have 'to' field");
      assertExists(edge.workflowName, "Edge should have 'workflowName' field");

      assertEquals(typeof edge.from, "string", "Edge 'from' should be string");
      assertEquals(typeof edge.to, "string", "Edge 'to' should be string");
      assertEquals(typeof edge.workflowName, "string", "Edge 'workflowName' should be string");
    }
  },
});

Deno.test({
  name: "Playground Templates - Workflow names are unique",
  ignore: true,
  fn: async () => {
    const loader = new WorkflowLoader();
    const workflows = await loader.loadFromYaml(PLAYGROUND_TEMPLATES_PATH);

    const names = workflows.map((w) => w.name);
    const uniqueNames = new Set(names);

    assertEquals(
      uniqueNames.size,
      names.length,
      `Workflow names should be unique. Found duplicates: ${
        names.filter((n, i) => names.indexOf(n) !== i).join(", ")
      }`,
    );
  },
});
