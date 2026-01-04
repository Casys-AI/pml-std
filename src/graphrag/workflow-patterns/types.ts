/**
 * Workflow Patterns Types
 *
 * Types for scraping n8n workflow templates and extracting
 * tool co-occurrence patterns for DR-DSP and SHGAT.
 *
 * @module graphrag/workflow-patterns/types
 */

// =============================================================================
// n8n API Response Types
// =============================================================================

/**
 * n8n node definition from API
 */
export interface N8nNode {
  /** Node instance name in workflow (e.g., "Google Sheets") */
  name: string;
  /** Node type package (e.g., "n8n-nodes-base.googleSheets") */
  type: string;
  /** Human-readable display name */
  displayName?: string;
  /** Node parameters including operation */
  parameters?: {
    operation?: string;
    resource?: string;
    [key: string]: unknown;
  };
  /** Position in canvas [x, y] */
  position?: [number, number];
}

/**
 * n8n connection target
 */
export interface N8nConnectionTarget {
  /** Target node name */
  node: string;
  /** Connection type (main, ai_tool, ai_languageModel, etc.) */
  type: string;
  /** Output index */
  index: number;
}

/**
 * n8n connections object structure
 * Key = source node name
 * Value = { connectionType: [[targets]] }
 */
export type N8nConnections = Record<
  string,
  Record<string, N8nConnectionTarget[][]>
>;

/**
 * n8n workflow template from API
 */
export interface N8nWorkflow {
  /** Workflow ID */
  id: number;
  /** Workflow name */
  name: string;
  /** View count (popularity metric) */
  totalViews: number;
  /** Workflow description */
  description?: string;
  /** Creation timestamp */
  createdAt: string;
  /** Node definitions */
  nodes: N8nNode[];
  /** Connection graph */
  connections: N8nConnections;
  /** Creator info */
  user?: {
    username: string;
    verified: boolean;
  };
}

/**
 * n8n search API response
 */
export interface N8nSearchResponse {
  totalWorkflows: number;
  workflows: Array<{
    id: number;
    name: string;
    totalViews: number;
    nodes: Array<{
      name: string;
      type: string;
      displayName?: string;
    }>;
  }>;
}

// =============================================================================
// Scraped Pattern Types
// =============================================================================

/**
 * Extracted edge from a workflow
 * Represents a tool → tool transition with operation-level detail
 */
export interface ScrapedEdge {
  /** Source n8n node type (e.g., "n8n-nodes-base.googleSheets") */
  fromNodeType: string;
  /** Source operation (e.g., "getRow") */
  fromOperation?: string;
  /** Target n8n node type */
  toNodeType: string;
  /** Target operation */
  toOperation?: string;
  /** Connection type (main, ai_tool, etc.) */
  connectionType: string;
}

/**
 * Aggregated pattern from multiple workflows
 */
export interface ScrapedPattern {
  /** Canonical n8n source (nodeType:operation or nodeType) */
  fromN8n: string;
  /** Canonical n8n target */
  toN8n: string;
  /** Mapped MCP tool ID (null if no mapping) */
  fromMcp: string | null;
  /** Mapped MCP tool ID (null if no mapping) */
  toMcp: string | null;
  /** Number of times this pattern was observed */
  frequency: number;
  /** Sum of totalViews from workflows containing this pattern */
  totalViews: number;
  /** Source workflows (sample) */
  sampleWorkflowIds: number[];
}

/**
 * Prior pattern ready for DR-DSP injection
 */
export interface PriorPattern {
  /** MCP source tool ID */
  from: string;
  /** MCP target tool ID */
  to: string;
  /** Edge weight (lower = better, calculated from frequency) */
  weight: number;
  /** Original frequency count */
  frequency: number;
  /** Mapping confidence (1.0 = exact, 0.5 = fuzzy) */
  mappingConfidence: number;
  /** Data source */
  source: "n8n";
  /** Is from official/verified creator */
  isOfficial: boolean;
}

// =============================================================================
// Tool Mapping Types
// =============================================================================

/**
 * Mapping entry from n8n node to MCP tool
 */
export interface ToolMapping {
  /** n8n node type (e.g., "n8n-nodes-base.googleSheets") */
  n8nNodeType: string;
  /** Optional operation for more specific mapping */
  n8nOperation?: string;
  /** Target MCP tool ID (e.g., "google:sheets_get_row") */
  mcpToolId: string;
  /** Mapping confidence (1.0 = manual exact, 0.8 = verified, 0.5 = inferred) */
  confidence: number;
  /** Tool description for embedding generation (used when tool not in local DB) */
  description?: string;
}

/**
 * Tool mapper configuration
 */
export interface ToolMapperConfig {
  /** Manual mappings (highest priority) */
  manualMappings: ToolMapping[];
  /** Use embedding similarity for unmapped tools */
  useEmbeddingFallback: boolean;
  /** Minimum similarity threshold for embedding fallback */
  embeddingThreshold: number;
}

// =============================================================================
// Storage Types
// =============================================================================

/**
 * Persisted workflow patterns file structure
 */
export interface WorkflowPatternsFile {
  /** Schema version */
  version: string;
  /** When patterns were scraped */
  scrapedAt: string;
  /** Source platform */
  source: "n8n";
  /** Total workflows processed */
  workflowsProcessed: number;
  /** Raw scraped patterns (before MCP mapping) */
  rawPatterns: ScrapedPattern[];
  /** Mapped patterns ready for DR-DSP */
  priorPatterns: PriorPattern[];
  /** Mapping statistics */
  stats: {
    totalEdgesExtracted: number;
    uniquePatterns: number;
    mappedPatterns: number;
    unmappedPatterns: number;
  };
}

// =============================================================================
// Scraper Options
// =============================================================================

/**
 * N8n scraper configuration
 */
export interface N8nScraperOptions {
  /** Maximum workflows to fetch (default: 1000) */
  maxWorkflows: number;
  /** Page size for API requests (default: 100) */
  pageSize: number;
  /** Delay between requests in ms (default: 100) */
  requestDelay: number;
  /** Minimum views to include workflow (default: 100) */
  minViews: number;
  /** Skip sticky notes and other non-functional nodes */
  skipUtilityNodes: boolean;
  /** Categories to filter (empty = all) */
  categories: number[];
}

/**
 * Default scraper options
 */
export const DEFAULT_SCRAPER_OPTIONS: N8nScraperOptions = {
  maxWorkflows: 1000,
  pageSize: 100,
  requestDelay: 100,
  minViews: 100,
  skipUtilityNodes: true,
  categories: [],
};
