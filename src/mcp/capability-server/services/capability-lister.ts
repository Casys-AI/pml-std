/**
 * Capability Lister Service
 *
 * Story 13.3: CapabilityMCPServer + Gateway
 *
 * Lists capabilities as MCP tools with proper naming format.
 * Implements CapabilityLister interface following Repository pattern.
 *
 * @module mcp/capability-server/services/capability-lister
 */

import type { MCPTool } from "../../types.ts";
import type { CapabilityLister } from "../interfaces.ts";
import { toMCPToolName } from "../interfaces.ts";
import type { CapabilityStore } from "../../../capabilities/capability-store.ts";
import type { ListWithSchemasOptions } from "../../../capabilities/types.ts";
import { getLogger } from "../../../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Default schema for tools without parameters_schema
 */
const DEFAULT_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
};

/**
 * CapabilityListerService
 *
 * Lists all capabilities as MCP tools using the Repository pattern.
 * Delegates to CapabilityStore.listWithSchemas() for data access.
 *
 * @example
 * ```typescript
 * const lister = new CapabilityListerService(capabilityStore);
 * const tools = await lister.listTools();
 * // [{ name: "mcp__code__analyze", description: "...", inputSchema: {...} }]
 * ```
 */
export class CapabilityListerService implements CapabilityLister {
  constructor(private capabilityStore: CapabilityStore) {}

  /**
   * List all capabilities as MCP tools (AC1, AC4, AC7)
   *
   * - AC1: Returns tools with `mcp__namespace__action` format
   * - AC4: inputSchema from capability's parameters_schema
   * - AC7: Fresh query (no cache) for immediate visibility
   *
   * @returns MCP tools representing capabilities
   */
  async listTools(): Promise<MCPTool[]> {
    const options: ListWithSchemasOptions = {
      visibility: ["public", "org", "project", "private"],
      limit: 100,
      orderBy: "usageCount",
    };

    const capabilities = await this.capabilityStore.listWithSchemas(options);

    logger.debug("CapabilityListerService.listTools", {
      capabilitiesFound: capabilities.length,
    });

    return capabilities.map((cap) => ({
      name: toMCPToolName(cap.namespace, cap.action),
      description: cap.description || `Capability: ${cap.namespace}:${cap.action}`,
      inputSchema: cap.parametersSchema || DEFAULT_INPUT_SCHEMA,
    }));
  }
}
