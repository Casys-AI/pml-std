/**
 * Smithery Registry Loader
 *
 * Loads MCP servers from the Smithery registry API.
 *
 * @module mcp/smithery-loader
 */

import * as log from "@std/log";
import type { MCPServer, SmitheryServerConfig } from "./types.ts";

/**
 * Response from Smithery registry API
 */
interface SmitheryRegistryResponse {
  servers: SmitheryServerConfig[];
}

/**
 * SmitheryLoader - Loads MCP servers from Smithery registry
 *
 * Connects to the Smithery registry API to fetch configured MCP servers
 * from the user's profile. Servers are connected via HTTP Streamable transport.
 */
export class SmitheryLoader {
  private readonly registryUrl: string;

  constructor(registryUrl: string = "https://registry.smithery.ai/servers") {
    this.registryUrl = registryUrl;
  }

  /**
   * Load servers from Smithery registry
   *
   * Fetches the user's configured MCP servers from Smithery using the API key.
   * The API key determines which profile's servers are returned.
   *
   * @param apiKey - Smithery API key (from SMITHERY_API_KEY env var)
   * @returns Array of MCPServer configs ready for SmitheryMCPClient
   */
  async loadServers(apiKey: string): Promise<MCPServer[]> {
    try {
      log.debug(`Fetching servers from Smithery registry: ${this.registryUrl}`);

      const response = await fetch(this.registryUrl, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Smithery API error (${response.status}): ${errorText}`,
        );
      }

      const data = await response.json() as SmitheryRegistryResponse;

      if (!data.servers || !Array.isArray(data.servers)) {
        log.warn("Smithery registry returned no servers array");
        return [];
      }

      const servers = this.convertToMCPServers(data.servers);
      log.info(`Loaded ${servers.length} server(s) from Smithery registry`);

      return servers;
    } catch (error) {
      // Network errors, JSON parse errors, etc.
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`Failed to load servers from Smithery: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Validate a server object from the API response
   *
   * Ensures required fields are present and have correct types.
   */
  private isValidServer(server: unknown): server is SmitheryServerConfig {
    if (typeof server !== "object" || server === null) {
      return false;
    }

    const s = server as Record<string, unknown>;

    // Required fields
    if (typeof s.qualifiedName !== "string" || s.qualifiedName.length === 0) {
      log.debug(`Invalid server: missing or invalid qualifiedName`);
      return false;
    }

    if (typeof s.displayName !== "string") {
      log.debug(`Invalid server ${s.qualifiedName}: missing displayName`);
      return false;
    }

    if (typeof s.remote !== "boolean") {
      log.debug(`Invalid server ${s.qualifiedName}: missing remote flag`);
      return false;
    }

    // Optional config must be object if present
    if (s.config !== undefined && (typeof s.config !== "object" || s.config === null)) {
      log.debug(`Invalid server ${s.qualifiedName}: config must be object`);
      return false;
    }

    return true;
  }

  /**
   * Convert Smithery server configs to MCPServer format
   *
   * Smithery servers are remote HTTP Streamable servers, not local stdio processes.
   * The command field is set to the Smithery server URL for routing.
   * Validates each server before conversion.
   */
  private convertToMCPServers(smitheryServers: unknown[]): MCPServer[] {
    return smitheryServers
      .filter((s) => this.isValidServer(s)) // Validate structure
      .filter((s) => s.remote === true) // Only remote servers
      .map((s) => ({
        // ID: Use qualified name as unique identifier
        id: `smithery:${s.qualifiedName}`,
        // Name: Use display name for human readability
        name: s.displayName,
        // Command: Smithery server URL (used by SmitheryMCPClient)
        command: `https://server.smithery.ai/${s.qualifiedName}`,
        // Protocol: HTTP Streamable transport
        protocol: "http" as const,
        // Store Smithery config in env for SmitheryMCPClient to use
        env: s.config ? { __smithery_config: JSON.stringify(s.config) } : undefined,
      }));
  }
}
