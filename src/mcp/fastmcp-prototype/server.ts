/**
 * FastMCP Prototype Server
 *
 * Equivalent implementation of PML Gateway using FastMCP framework.
 * Compares DX (Developer Experience) with the original SDK-based implementation.
 *
 * Original gateway-server.ts: ~1200 lines
 * This prototype: ~200 lines (for same core functionality)
 *
 * @see https://github.com/punkpeye/fastmcp
 * @module mcp/fastmcp-prototype/server
 */

import { FastMCP } from "fastmcp";
import { z } from "zod";

// Types for tool responses
interface DiscoverResult {
  tools: Array<{
    name: string;
    description: string;
    score: number;
    source: "tool" | "capability";
  }>;
  capabilities: Array<{
    id: string;
    description: string;
    score: number;
  }>;
}

interface ExecuteResult {
  success: boolean;
  data?: unknown;
  error?: string;
  traceId?: string;
}

// Initialize FastMCP server
const server = new FastMCP({
  name: "pml-gateway-fastmcp",
  version: "0.1.0",
});

/**
 * PML Discover Tool
 *
 * Search MCP tools and learned capabilities by intent.
 * Returns ranked results.
 */
server.addTool({
  name: "pml_discover",
  description: "Search MCP tools and learned capabilities by intent. Returns ranked results.",
  parameters: z.object({
    intent: z.string().describe(
      "What do you want to accomplish? Natural language description of your goal.",
    ),
    limit: z.number().optional().default(5).describe(
      "Maximum results to return (default: 5, max: 50)",
    ),
    include_related: z.boolean().optional().default(false).describe(
      "Include related tools for each tool result (from usage patterns). Default: false",
    ),
    filter: z
      .object({
        type: z.enum(["tool", "capability", "all"]).optional().describe(
          "Filter by result type. Default: 'all' (both tools and capabilities)",
        ),
        minScore: z.number().optional().describe(
          "Minimum score threshold (0-1). Default: 0.0",
        ),
      })
      .optional(),
  }),
  execute: async (_args) => {
    // Placeholder - would integrate with vectorSearch and graphEngine
    const result: DiscoverResult = {
      tools: [
        {
          name: "filesystem:read_file",
          description: "Read a file from disk",
          score: 0.95,
          source: "tool",
        },
        {
          name: "filesystem:write_file",
          description: "Write content to a file",
          score: 0.82,
          source: "tool",
        },
      ],
      capabilities: [
        {
          id: "cap-123",
          description: "Parse JSON and extract data",
          score: 0.78,
        },
      ],
    };

    return JSON.stringify(result, null, 2);
  },
});

/**
 * PML Execute Tool
 *
 * Execute intent with optional code. With code: runs and learns capability.
 * Without: finds matching capability or suggests tools.
 */
server.addTool({
  name: "pml_execute",
  description: `Execute intent with optional code. With code: runs and learns capability. Without: finds matching capability or suggests tools.`,
  parameters: z.object({
    intent: z.string().describe(
      "REQUIRED: Natural language description of what you want to accomplish.",
    ),
    code: z.string().optional().describe(
      "OPTIONAL: TypeScript code to execute. If provided, triggers Direct Mode (execute + learn).",
    ),
    options: z
      .object({
        timeout: z.number().optional().describe("Max execution time in ms (default: 30000)"),
        per_layer_validation: z.boolean().optional().describe(
          "Enable step-by-step validation for complex workflows (default: false)",
        ),
      })
      .optional(),
  }),
  execute: async (args) => {
    // Placeholder - would integrate with CapabilityStore and WorkerBridge
    const result: ExecuteResult = {
      success: true,
      data: {
        message: `Executed intent: ${args.intent}`,
        hasCode: !!args.code,
      },
      traceId: `trace-${Date.now()}`,
    };

    return JSON.stringify(result, null, 2);
  },
});

/**
 * PML Execute DAG Tool
 *
 * Legacy DAG workflow execution.
 */
server.addTool({
  name: "pml_execute_dag",
  description: "[DEPRECATED] Use pml:execute. Legacy DAG workflow execution.",
  parameters: z.object({
    intent: z.string().optional().describe(
      "RECOMMENDED: Just describe your goal in natural language.",
    ),
    workflow: z
      .object({
        tasks: z.array(
          z.object({
            id: z.string(),
            tool: z.string(),
            args: z.record(z.unknown()).optional(),
            dependencies: z.array(z.string()).optional(),
          }),
        ),
        dependencies: z.array(
          z.object({
            from: z.string(),
            to: z.string(),
          }),
        ).optional(),
      })
      .optional()
      .describe("ADVANCED: Explicit DAG with tasks array and dependencies."),
  }),
  execute: async (_args) => {
    // Placeholder - would integrate with ControlledExecutor
    return JSON.stringify({
      success: true,
      workflowId: `wf-${Date.now()}`,
      results: {},
      durationMs: 100,
    });
  },
});

/**
 * PML Continue Tool
 *
 * Resume a paused workflow after layer validation.
 */
server.addTool({
  name: "pml_continue",
  description: "Resume a paused workflow after layer validation.",
  parameters: z.object({
    workflow_id: z.string().describe("The workflow_id returned by execute_dag"),
    reason: z.string().optional().describe("Why you're continuing (optional, for logging)"),
  }),
  execute: async (args) => {
    return JSON.stringify({
      success: true,
      workflowId: args.workflow_id,
      status: "resumed",
    });
  },
});

/**
 * PML Abort Tool
 *
 * Stop a running workflow immediately.
 */
server.addTool({
  name: "pml_abort",
  description: "Stop a running workflow immediately.",
  parameters: z.object({
    workflow_id: z.string().describe("The workflow_id to stop"),
    reason: z.string().describe("Why you're aborting (required for audit trail)"),
  }),
  execute: async (args) => {
    return JSON.stringify({
      success: true,
      workflowId: args.workflow_id,
      status: "aborted",
      reason: args.reason,
    });
  },
});

/**
 * PML Approval Response Tool
 *
 * Approve or reject a Human-in-the-Loop checkpoint.
 */
server.addTool({
  name: "pml_approval_response",
  description: "Approve or reject a Human-in-the-Loop checkpoint.",
  parameters: z.object({
    workflow_id: z.string().describe("The workflow_id waiting for approval"),
    checkpoint_id: z.string().describe("The specific checkpoint_id from the approval request"),
    approved: z.boolean().describe("true = proceed with the operation, false = skip/cancel it"),
    feedback: z.string().optional().describe("Optional message explaining your decision"),
  }),
  execute: async (args) => {
    return JSON.stringify({
      success: true,
      workflowId: args.workflow_id,
      checkpointId: args.checkpoint_id,
      approved: args.approved,
    });
  },
});

// Export server instance for testing
export { server };

// Export start function
export async function startFastMCPServer(options: {
  transport: "stdio" | "httpStream";
  port?: number;
}): Promise<void> {
  if (options.transport === "stdio") {
    await server.start({ transportType: "stdio" });
  } else {
    await server.start({
      transportType: "httpStream",
      httpStream: {
        port: options.port ?? 3004,
      },
    });
  }
}

// CLI entry point
if (import.meta.main) {
  const transport = Deno.args.includes("--http") ? "httpStream" : "stdio";
  const portArg = Deno.args.find((a) => a.startsWith("--port="));
  const port = portArg ? parseInt(portArg.split("=")[1]) : 3004;

  console.error(`[FastMCP] Starting PML Gateway prototype with ${transport} transport`);
  startFastMCPServer({ transport: transport as "stdio" | "httpStream", port });
}
