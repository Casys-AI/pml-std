/**
 * Tool Registry
 *
 * Tool registration, lookup, and management.
 *
 * @module mcp/registry/tool-registry
 */

import type { MCPTool } from "../types.ts";

// Import tool definitions
import {
  abortTool,
  approvalResponseTool,
  continueTool,
  executeCodeTool,
  executeDagTool,
  replanTool,
  searchCapabilitiesTool,
  searchToolsTool,
} from "../tools/definitions.ts";

/**
 * Tool Registry
 *
 * Manages registration and lookup of MCP tools.
 */
export class ToolRegistry {
  private tools: Map<string, MCPTool> = new Map();

  constructor() {
    // Register default meta-tools
    this.registerDefaults();
  }

  /**
   * Register default meta-tools
   */
  private registerDefaults(): void {
    this.register(executeDagTool);
    this.register(searchToolsTool);
    this.register(searchCapabilitiesTool);
    this.register(executeCodeTool);
    this.register(continueTool);
    this.register(abortTool);
    this.register(replanTool);
    this.register(approvalResponseTool);
  }

  /**
   * Register a tool
   */
  register(tool: MCPTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get a tool by name
   */
  get(name: string): MCPTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all tool names
   */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all tools as array
   */
  getAll(): MCPTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools formatted for MCP response
   */
  getMetaTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Search tools by name or description
   */
  search(query: string): MCPTool[] {
    const lowerQuery = query.toLowerCase();
    return this.getAll().filter(
      (tool) =>
        tool.name.toLowerCase().includes(lowerQuery) ||
        tool.description.toLowerCase().includes(lowerQuery),
    );
  }
}

/**
 * Default tool registry instance
 */
export const defaultRegistry = new ToolRegistry();

/**
 * Get meta-tools for MCP response (convenience function)
 */
export function getMetaTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return defaultRegistry.getMetaTools();
}
