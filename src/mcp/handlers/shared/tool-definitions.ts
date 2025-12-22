/**
 * Shared Tool Definition Builder
 *
 * Extracts tool definitions from DAG structures or static structures.
 * Used by multiple handlers to build WorkerBridge context.
 *
 * Story 10.7: Consolidated from duplicated code in:
 * - code-execution-handler.ts
 * - workflow-execution-handler.ts
 * - control-commands-handler.ts
 * - execute-handler.ts
 *
 * @module mcp/handlers/shared/tool-definitions
 */

import type { ToolDefinition } from "../../../sandbox/types.ts";
import type { MCPClientBase } from "../../types.ts";

/**
 * Minimal DAG structure interface for tool extraction
 */
export interface DAGWithTasks {
  tasks: Array<{ tool?: string }>;
}

/**
 * Minimal static structure interface for tool extraction
 */
export interface StaticStructureWithNodes {
  nodes: Array<{ type: string; tool?: string }>;
}

/**
 * Dependencies required for building tool definitions
 */
export interface ToolDefinitionDeps {
  mcpClients: Map<string, MCPClientBase>;
}

/**
 * Build tool definitions from a DAG structure
 *
 * Extracts unique tools from DAG tasks and fetches their schemas
 * from the corresponding MCP servers.
 *
 * @param dag - DAG structure with tasks array
 * @param deps - Dependencies with MCP clients
 * @returns Array of tool definitions for WorkerBridge context
 */
export async function buildToolDefinitionsFromDAG(
  dag: DAGWithTasks,
  deps: ToolDefinitionDeps,
): Promise<ToolDefinition[]> {
  const toolDefs: ToolDefinition[] = [];
  const seenTools = new Set<string>();

  for (const task of dag.tasks) {
    if (!task.tool || seenTools.has(task.tool)) continue;
    seenTools.add(task.tool);

    const colonIndex = task.tool.indexOf(":");
    if (colonIndex === -1) continue;

    const serverId = task.tool.substring(0, colonIndex);
    const toolName = task.tool.substring(colonIndex + 1);

    const client = deps.mcpClients.get(serverId);
    if (!client) continue;

    try {
      const tools = await client.listTools();
      const toolSchema = tools.find((t) => t.name === toolName);
      if (toolSchema) {
        toolDefs.push({
          server: serverId,
          name: toolName,
          description: toolSchema.description ?? "",
          inputSchema: toolSchema.inputSchema as Record<string, unknown>,
        });
      }
    } catch {
      // Server doesn't have schema, add minimal definition
      toolDefs.push({
        server: serverId,
        name: toolName,
        description: "",
        inputSchema: {},
      });
    }
  }

  return toolDefs;
}

/**
 * Build tool definitions from a static structure
 *
 * Similar to buildToolDefinitionsFromDAG but works with static analysis nodes.
 * Filters for task nodes only.
 *
 * @param staticStructure - Static structure with nodes array
 * @param deps - Dependencies with MCP clients
 * @returns Array of tool definitions for WorkerBridge context
 */
export async function buildToolDefinitionsFromStaticStructure(
  staticStructure: StaticStructureWithNodes,
  deps: ToolDefinitionDeps,
): Promise<ToolDefinition[]> {
  const toolDefs: ToolDefinition[] = [];
  const seenTools = new Set<string>();

  for (const node of staticStructure.nodes) {
    if (node.type !== "task" || !node.tool || seenTools.has(node.tool)) continue;
    seenTools.add(node.tool);

    const colonIndex = node.tool.indexOf(":");
    if (colonIndex === -1) continue;

    const serverId = node.tool.substring(0, colonIndex);
    const toolName = node.tool.substring(colonIndex + 1);

    const client = deps.mcpClients.get(serverId);
    if (!client) continue;

    try {
      const tools = await client.listTools();
      const toolSchema = tools.find((t) => t.name === toolName);
      if (toolSchema) {
        toolDefs.push({
          server: serverId,
          name: toolName,
          description: toolSchema.description ?? "",
          inputSchema: toolSchema.inputSchema as Record<string, unknown>,
        });
      }
    } catch {
      // Server doesn't have schema, add minimal definition
      toolDefs.push({
        server: serverId,
        name: toolName,
        description: "",
        inputSchema: {},
      });
    }
  }

  return toolDefs;
}
