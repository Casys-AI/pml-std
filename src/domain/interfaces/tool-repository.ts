/**
 * Tool Repository Interface
 *
 * Defines the contract for tool metadata storage operations.
 * Implementations: ToolStore
 *
 * Following the same Clean Architecture pattern as ICapabilityRepository.
 *
 * @module domain/interfaces/tool-repository
 */

/**
 * Tool metadata from database (tool_schema table)
 */
export interface ToolMetadata {
  toolId: string;
  serverId: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Interface for tool storage operations
 *
 * This interface abstracts the data access layer for MCP tools,
 * allowing for different implementations and easy mocking in tests.
 */
export interface IToolRepository {
  /**
   * Find a single tool by ID
   *
   * @param toolId - Tool ID (format: "server:toolName")
   * @returns Tool metadata or undefined if not found
   */
  findById(toolId: string): Promise<ToolMetadata | undefined>;

  /**
   * Find multiple tools by IDs (batch)
   *
   * More efficient than multiple findById calls.
   *
   * @param toolIds - Array of tool IDs to fetch
   * @returns Map of toolId to metadata
   */
  findByIds(toolIds: string[]): Promise<Map<string, ToolMetadata>>;
}
