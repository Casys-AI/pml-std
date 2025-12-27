/**
 * Autocomplete Search Module
 *
 * Fast prefix-based search on tool names for autocomplete suggestions.
 * Story 6.4 AC10: Search Tools for Autocomplete
 *
 * @module graphrag/search/autocomplete
 */

/**
 * Graph interface for autocomplete operations
 */
export interface AutocompleteGraph {
  forEachNode(
    callback: (
      nodeId: string,
      attrs: { name?: string; serverId?: string; metadata?: { description?: string } },
    ) => void,
  ): void;
}

/**
 * Autocomplete search result
 */
export interface AutocompleteResult {
  tool_id: string;
  name: string;
  server: string;
  description: string;
  score: number;
  pagerank: number;
}

/**
 * Search tools for autocomplete suggestions
 *
 * Fast prefix-based search on tool name/server for autocomplete.
 * Returns results with pagerank for ranking display.
 *
 * @param graph - Graphology graph instance
 * @param pageRanks - Pre-computed PageRank scores
 * @param query - Search query (min 2 chars)
 * @param limit - Maximum results (default: 10)
 * @returns Array of matching tools with metadata
 */
export function searchToolsForAutocomplete(
  graph: AutocompleteGraph,
  pageRanks: Record<string, number>,
  query: string,
  limit: number = 10,
): AutocompleteResult[] {
  if (query.length < 2) return [];

  const lowerQuery = query.toLowerCase();
  const results: AutocompleteResult[] = [];

  // Search through all nodes in graph
  graph.forEachNode((toolId, attrs) => {
    // Extract server and name from tool_id
    let server = "unknown";
    let name = toolId;

    if (toolId.includes(":")) {
      const colonIndex = toolId.indexOf(":");
      server = toolId.substring(0, colonIndex);
      name = toolId.substring(colonIndex + 1);
    } else if (toolId.includes("__")) {
      const parts = toolId.split("__");
      if (parts.length >= 3) {
        server = parts[1];
        name = parts.slice(2).join("__");
      }
    }

    const description = attrs.metadata?.description || attrs.name || "";
    const lowerName = name.toLowerCase();
    const lowerServer = server.toLowerCase();
    const lowerDescription = description.toLowerCase();

    // Score based on match quality
    let score = 0;

    // Exact name match = highest score
    if (lowerName === lowerQuery) {
      score = 1.0;
    } // Name starts with query = high score
    else if (lowerName.startsWith(lowerQuery)) {
      score = 0.9;
    } // Name contains query = medium score
    else if (lowerName.includes(lowerQuery)) {
      score = 0.7;
    } // Server matches = lower score
    else if (lowerServer.includes(lowerQuery)) {
      score = 0.5;
    } // Description contains query = lowest score
    else if (lowerDescription.includes(lowerQuery)) {
      score = 0.3;
    }

    if (score > 0) {
      results.push({
        tool_id: toolId,
        name,
        server,
        description: description.substring(0, 200), // Truncate for autocomplete
        score,
        pagerank: pageRanks[toolId] || 0,
      });
    }
  });

  // Sort by score (desc), then by pagerank (desc)
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.pagerank - a.pagerank;
  });

  return results.slice(0, limit);
}

/**
 * Parse tool ID into server and name components
 *
 * Supports formats:
 * - "server:tool_name" (e.g., "filesystem:read_file")
 * - "mcp__server__tool_name"
 *
 * @param toolId - Tool identifier
 * @returns Object with server and name
 */
export function parseToolId(toolId: string): { server: string; name: string } {
  if (toolId.includes(":")) {
    const colonIndex = toolId.indexOf(":");
    return {
      server: toolId.substring(0, colonIndex),
      name: toolId.substring(colonIndex + 1),
    };
  } else if (toolId.includes("__")) {
    const parts = toolId.split("__");
    if (parts.length >= 3) {
      return {
        server: parts[1],
        name: parts.slice(2).join("__"),
      };
    }
  }
  return { server: "unknown", name: toolId };
}
