/**
 * Discover Use Case Types
 *
 * Types for tool and capability discovery use cases.
 *
 * @module application/use-cases/discover/types
 */

/**
 * Common discover request fields
 */
export interface DiscoverRequest {
  intent: string;
  limit?: number;
  minScore?: number;
  correlationId?: string;
}

/**
 * Tool discovery result item
 */
export interface DiscoveredTool {
  type: "tool";
  record_type: "mcp-tool";
  id: string;
  name: string;
  description: string;
  score: number;
  server_id?: string;
  input_schema?: Record<string, unknown>;
  related_tools?: Array<{
    tool_id: string;
    relation: string;
    score: number;
  }>;
}

/**
 * Capability discovery result item
 */
export interface DiscoveredCapability {
  type: "capability";
  record_type: "capability";
  id: string;
  name: string;
  description: string;
  score: number;
  code_snippet?: string;
  success_rate?: number;
  usage_count?: number;
  semantic_score?: number;
  call_name?: string;
  input_schema?: Record<string, unknown>;
  called_capabilities?: Array<{
    id: string;
    call_name?: string;
    input_schema?: Record<string, unknown>;
  }>;
}

/**
 * Discover tools result
 */
export interface DiscoverToolsResult {
  tools: DiscoveredTool[];
  totalFound: number;
}

/**
 * Discover capabilities result
 */
export interface DiscoverCapabilitiesResult {
  capabilities: DiscoveredCapability[];
  totalFound: number;
}
