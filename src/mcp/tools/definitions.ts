/**
 * MCP Gateway Tool Definitions
 *
 * Contains the schema definitions for all meta-tools exposed by the gateway.
 * These tools provide the public API for DAG execution, tool search, and code execution.
 *
 * @module mcp/tools/definitions
 */

import type { MCPTool } from "../types.ts";

/**
 * Execute DAG tool (pml:execute_dag)
 *
 * Primary tool for workflow execution with intent-based or explicit mode.
 */
export const executeDagTool: MCPTool = {
  name: "pml:execute_dag",
  description: "[DEPRECATED] Use pml:execute. Legacy DAG workflow execution.",
  inputSchema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description:
          "RECOMMENDED: Just describe your goal in natural language. System auto-discovers tools and builds the workflow. Example: 'Read package.json and list all dependencies'",
      },
      workflow: {
        type: "object",
        description:
          "ADVANCED: Explicit DAG with tasks array and dependencies. Use only if you need precise control.",
      },
    },
  },
};

/**
 * Search tools tool (pml:search_tools)
 *
 * Tool discovery via semantic search + graph relationships.
 *
 * @deprecated Use pml:discover instead (Story 10.6)
 */
export const searchToolsTool: MCPTool = {
  name: "pml:search_tools",
  description: "[DEPRECATED] Use pml:discover. Legacy semantic tool search.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What do you want to do? Example: 'read JSON files', 'interact with GitHub', 'make HTTP requests'",
      },
      limit: {
        type: "number",
        description: "How many tools to return (default: 5)",
      },
      include_related: {
        type: "boolean",
        description:
          "Also show tools frequently used together with the matches (from usage patterns)",
      },
      context_tools: {
        type: "array",
        items: { type: "string" },
        description: "Tools you're already using - boosts related tools in results",
      },
    },
    required: ["query"],
  },
};

/**
 * Search capabilities tool (pml:search_capabilities)
 *
 * Find proven code patterns from past executions.
 *
 * @deprecated Use pml:discover instead (Story 10.6)
 */
export const searchCapabilitiesTool: MCPTool = {
  name: "pml:search_capabilities",
  description: "[DEPRECATED] Use pml:discover. Legacy capability search.",
  inputSchema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description: "What do you want to accomplish? System finds similar past successes.",
      },
      include_suggestions: {
        type: "boolean",
        description: "Also show related capabilities (similar tools or patterns)",
      },
    },
    required: ["intent"],
  },
};

/**
 * Execute code tool (pml:execute_code)
 *
 * Sandboxed TypeScript execution with auto-injected MCP tools.
 */
export const executeCodeTool: MCPTool = {
  name: "pml:execute_code",
  description: "[DEPRECATED] Use pml:execute with code parameter. Legacy sandbox execution.",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "TypeScript code to run. MCP tools available as mcp.server.tool(). Example: await mcp.filesystem.read_file({path: 'x.json'})",
      },
      intent: {
        type: "string",
        description:
          "RECOMMENDED: Describe what you're doing → system injects relevant MCP tools automatically. Example: 'read files and call GitHub API'",
      },
      context: {
        type: "object",
        description: "Custom data to inject into sandbox as 'context' variable",
      },
      sandbox_config: {
        type: "object",
        description: "Optional: timeout (ms), memoryLimit (MB), allowedReadPaths",
        properties: {
          timeout: {
            type: "number",
            description: "Max execution time in ms (default: 30000)",
          },
          memoryLimit: {
            type: "number",
            description: "Max heap memory in MB (default: 512)",
          },
          allowedReadPaths: {
            type: "array",
            items: { type: "string" },
            description: "Extra file paths the sandbox can read",
          },
        },
      },
    },
    required: ["code"],
  },
};

/**
 * Continue tool (pml:continue)
 *
 * Resume paused workflow after layer validation.
 */
export const continueTool: MCPTool = {
  name: "pml:continue",
  description: "Resume a paused workflow after layer validation.",
  inputSchema: {
    type: "object",
    properties: {
      workflow_id: {
        type: "string",
        description: "The workflow_id returned by execute_dag",
      },
      reason: {
        type: "string",
        description: "Why you're continuing (optional, for logging)",
      },
    },
    required: ["workflow_id"],
  },
};

/**
 * Abort tool (pml:abort)
 *
 * Stop a running workflow immediately.
 */
export const abortTool: MCPTool = {
  name: "pml:abort",
  description: "Stop a running workflow immediately.",
  inputSchema: {
    type: "object",
    properties: {
      workflow_id: {
        type: "string",
        description: "The workflow_id to stop",
      },
      reason: {
        type: "string",
        description: "Why you're aborting (required for audit trail)",
      },
    },
    required: ["workflow_id", "reason"],
  },
};

/**
 * Replan tool (pml:replan)
 *
 * Modify a running DAG to add new tasks.
 */
export const replanTool: MCPTool = {
  name: "pml:replan",
  description: "Add new tasks to a running workflow based on discovered context.",
  inputSchema: {
    type: "object",
    properties: {
      workflow_id: {
        type: "string",
        description: "The workflow_id to modify",
      },
      new_requirement: {
        type: "string",
        description: "What new capability is needed? Example: 'parse the XML files we found'",
      },
      available_context: {
        type: "object",
        description:
          "Data from previous tasks that informs the replan (e.g., {files: ['a.xml', 'b.xml']})",
      },
    },
    required: ["workflow_id", "new_requirement"],
  },
};

/**
 * Approval response tool (pml:approval_response)
 *
 * Respond to Human-in-the-Loop checkpoints.
 */
export const approvalResponseTool: MCPTool = {
  name: "pml:approval_response",
  description:
    "[DEPRECATED] Use pml:execute with continue_workflow parameter. Approve or reject a Human-in-the-Loop checkpoint.",
  inputSchema: {
    type: "object",
    properties: {
      workflow_id: {
        type: "string",
        description: "The workflow_id waiting for approval",
      },
      checkpoint_id: {
        type: "string",
        description: "The specific checkpoint_id from the approval request",
      },
      approved: {
        type: "boolean",
        description: "true = proceed with the operation, false = skip/cancel it",
      },
      feedback: {
        type: "string",
        description: "Optional message explaining your decision",
      },
    },
    required: ["workflow_id", "checkpoint_id", "approved"],
  },
};

/**
 * Discover tool (pml:discover) - Story 10.6
 *
 * Unified discovery API for tools and capabilities.
 * Replaces pml:search_tools and pml:search_capabilities.
 */
export const discoverTool: MCPTool = {
  name: "pml:discover",
  description: "Search MCP tools and learned capabilities by intent. Returns ranked results.",
  inputSchema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description: "What do you want to accomplish? Natural language description of your goal.",
      },
      filter: {
        type: "object",
        description: "Optional filters for results",
        properties: {
          type: {
            type: "string",
            enum: ["tool", "capability", "all"],
            description: "Filter by result type. Default: 'all' (both tools and capabilities)",
          },
          minScore: {
            type: "number",
            description: "Minimum score threshold (0-1). Default: 0.0",
          },
        },
      },
      limit: {
        type: "number",
        description: "Maximum results to return (default: 1, max: 50)",
      },
      include_related: {
        type: "boolean",
        description:
          "Include related tools for each tool result (from usage patterns). Default: false",
      },
    },
    required: ["intent"],
  },
};

/**
 * Execute tool (pml:execute) - Story 10.7 + Story 13.2
 *
 * Unified execution API with two primary modes and two response patterns:
 *
 * Primary modes:
 * - Direct: intent + code → Execute → Create capability
 * - Suggestion: intent only → Search → Return suggestions
 *
 * Response patterns (to previous execute responses):
 * - Accept Suggestion: Execute a capability/tool from suggestedDag
 * - Continue Workflow: Resume a paused workflow (approval_required)
 */
export const executeTool: MCPTool = {
  name: "pml:execute",
  description:
    "Execute intent with optional code. With code: runs and learns capability. Without: returns suggestions. Use accept_suggestion to execute a suggested capability, or continue_workflow to resume a paused workflow.",
  inputSchema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description:
          "Natural language description of what you want to accomplish. REQUIRED for Direct and Suggestion modes. Example: 'Read a file and create a GitHub issue with its contents'",
      },
      code: {
        type: "string",
        description:
          "TypeScript code to execute. If provided, triggers Direct Mode (execute + learn). MCP tools available as mcp.server.tool(). Example: 'const content = await mcp.fs.read({path: \"x.json\"}); return JSON.parse(content);'",
      },
      options: {
        type: "object",
        description: "Execution options",
        properties: {
          timeout: {
            type: "number",
            description: "Max execution time in ms (default: 30000)",
          },
          per_layer_validation: {
            type: "boolean",
            description: "Enable step-by-step validation for complex workflows (default: false)",
          },
        },
      },
      accept_suggestion: {
        type: "object",
        description:
          "Accept and execute a suggestion from a previous Suggestion mode response. The callName comes from suggestedDag.tasks[n].callName.",
        properties: {
          callName: {
            type: "string",
            description: "Call name from suggestedDag (e.g., 'fs:read_json', 'namespace:action')",
          },
          args: {
            type: "object",
            description: "Arguments for execution, built according to the inputSchema from the suggestion",
          },
        },
        required: ["callName"],
      },
      continue_workflow: {
        type: "object",
        description:
          "Continue a paused workflow from a previous execution that returned status='approval_required'.",
        properties: {
          workflow_id: {
            type: "string",
            description: "Workflow ID from the previous response's workflowId field",
          },
          approved: {
            type: "boolean",
            description: "Approval decision: true to continue, false to abort",
          },
        },
        required: ["workflow_id", "approved"],
      },
    },
  },
};

/**
 * Get all meta-tools to expose via tools/list
 *
 * @returns Array of tool definitions formatted for MCP response
 */
export function getMetaTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const tools = [
    executeTool, // Primary API (Story 10.7)
    discoverTool,
    // Legacy tools removed - use pml:execute instead
    abortTool,
    replanTool,
  ];

  return tools.map((schema) => ({
    name: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema,
  }));
}
