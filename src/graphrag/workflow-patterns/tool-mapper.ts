/**
 * Tool Mapper
 *
 * Maps n8n node types to real MCP tool IDs from official servers.
 * Based on research from:
 * - https://github.com/modelcontextprotocol/servers
 * - https://github.com/microsoft/playwright-mcp
 * - https://executeautomation.github.io/mcp-playwright
 *
 * @module graphrag/workflow-patterns/tool-mapper
 */

import * as log from "@std/log";
import type { PriorPattern, ScrapedPattern, ToolMapping, ToolMapperConfig } from "./types.ts";

// =============================================================================
// MCP Server Tool Registry
// =============================================================================

/**
 * Official MCP Server Tools
 *
 * Source: https://github.com/modelcontextprotocol/servers
 */
export const MCP_TOOLS = {
  // @modelcontextprotocol/server-filesystem
  filesystem: [
    "read_text_file",
    "read_media_file",
    "read_multiple_files",
    "write_file",
    "edit_file",
    "create_directory",
    "list_directory",
    "list_directory_with_sizes",
    "move_file",
    "search_files",
    "directory_tree",
    "get_file_info",
    "list_allowed_directories",
  ],

  // @modelcontextprotocol/server-memory
  memory: [
    "create_entities",
    "create_relations",
    "add_observations",
    "delete_entities",
    "delete_observations",
    "delete_relations",
    "read_graph",
    "search_nodes",
    "open_nodes",
  ],

  // @modelcontextprotocol/server-git
  git: [
    "git_status",
    "git_diff_unstaged",
    "git_diff_staged",
    "git_diff",
    "git_commit",
    "git_add",
    "git_reset",
    "git_log",
    "git_create_branch",
    "git_checkout",
    "git_show",
    "git_branch",
  ],

  // @modelcontextprotocol/server-fetch
  fetch: ["fetch"],

  // std/http
  http: ["http_get", "http_post", "http_request", "http_build_url", "http_parse_url"],

  // std/python
  python: ["python_exec", "python_eval", "python_pip"],

  // std/transform
  transform: [
    "transform_csv_parse",
    "transform_csv_stringify",
    "transform_json_to_csv",
    "transform_csv_to_json",
    "transform_xml_to_json",
    "transform_json_to_xml",
    "transform_base64",
    "transform_template",
  ],

  // @modelcontextprotocol/server-sequentialthinking
  "sequential-thinking": ["sequential_thinking"],

  // MCP Sampling (standard capability for LLM calls)
  // https://modelcontextprotocol.io/docs/concepts/sampling
  sampling: ["createMessage"],

  // Playwright MCP (microsoft/playwright-mcp or executeautomation/mcp-playwright)
  playwright: [
    "browser_navigate",
    "browser_screenshot",
    "browser_click",
    "browser_fill",
    "browser_select",
    "browser_hover",
    "browser_evaluate",
    "browser_close",
    "browser_snapshot",
    "browser_press_key",
    "browser_drag",
    "browser_resize",
    "browser_take_screenshot",
    "browser_console_messages",
    "browser_pdf",
  ],

  // GitHub MCP
  github: [
    "create_issue",
    "list_issues",
    "get_issue",
    "create_pull_request",
    "list_pull_requests",
    "get_pull_request",
    "create_repository",
    "list_repositories",
    "search_code",
    "search_issues",
  ],

  // Slack MCP
  slack: [
    "post_message",
    "list_channels",
    "list_users",
    "get_channel_history",
    "upload_file",
  ],

  // mcp-gsheets
  "google-sheets": [
    "sheets_get_values",
    "sheets_update_values",
    "sheets_batch_get_values",
    "sheets_get_metadata",
    "sheets_check_access",
  ],

  // @notionhq/notion-mcp-server
  notion: [
    "search",
    "create_page",
    "update_page",
    "archive_page",
    "restore_page",
    "update_page_properties",
  ],

  // @iqai/mcp-telegram
  telegram: ["SEND_MESSAGE"],

  // std/database
  database: ["sqlite_query", "psql_query", "mysql_query", "redis_cli", "sqlite_tables"],

  // std/json
  json: ["json_parse", "json_stringify", "json_query", "json_merge", "json_keys"],

  // std/collections
  collections: ["array_map", "array_filter", "array_sort", "array_unique", "array_group"],

  // std/math - for expression evaluation
  math: ["math_eval", "math_stats", "math_round", "math_random"],

  // std/string - string operations
  string: ["string_split", "string_join", "string_replace", "string_regex", "string_template"],

  // std/format - formatting operations
  format: ["format_number", "format_bytes", "format_duration", "format_sql", "format_javascript"],

  // ==========================================================================
  // Pure code operations (traced JavaScript - from src/capabilities/pure-operations.ts)
  // ==========================================================================

  // Array operations
  "code:array": [
    "filter",
    "map",
    "reduce",
    "flatMap",
    "find",
    "findIndex",
    "some",
    "every",
    "sort",
    "reverse",
    "slice",
    "concat",
    "join",
    "includes",
    "indexOf",
    "lastIndexOf",
  ],

  // String operations
  "code:string": [
    "split",
    "replace",
    "replaceAll",
    "trim",
    "trimStart",
    "trimEnd",
    "toLowerCase",
    "toUpperCase",
    "substring",
    "substr",
    "match",
    "matchAll",
  ],

  // Object operations
  "code:object": ["Object.keys", "Object.values", "Object.entries", "Object.fromEntries", "Object.assign"],

  // Math operations
  "code:math": ["Math.max", "Math.min", "Math.abs", "Math.floor", "Math.ceil", "Math.round"],

  // JSON operations
  "code:json": ["JSON.parse", "JSON.stringify"],

  // Binary operators
  "code:operators": [
    "add",
    "subtract",
    "multiply",
    "divide",
    "modulo",
    "power",
    "equal",
    "strictEqual",
    "notEqual",
    "lessThan",
    "greaterThan",
    "and",
    "or",
  ],
} as const;

// =============================================================================
// n8n → MCP Mappings
// =============================================================================

/**
 * Manual mappings from n8n nodes to MCP tools
 *
 * Format: n8nNodeType[:operation] → mcpServer:toolName
 */
const DEFAULT_MANUAL_MAPPINGS: ToolMapping[] = [
  // ============================================================================
  // Filesystem operations → @modelcontextprotocol/server-filesystem
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.readBinaryFile",
    mcpToolId: "filesystem:read_text_file",
    confidence: 0.9,
    description: "Read the contents of a text file from the filesystem",
  },
  {
    n8nNodeType: "n8n-nodes-base.readBinaryFiles",
    mcpToolId: "filesystem:read_multiple_files",
    confidence: 0.9,
    description: "Read multiple files at once from the filesystem",
  },
  {
    n8nNodeType: "n8n-nodes-base.writeBinaryFile",
    mcpToolId: "filesystem:write_file",
    confidence: 0.9,
    description: "Write content to a file on the filesystem",
  },
  {
    n8nNodeType: "n8n-nodes-base.localFileTrigger",
    mcpToolId: "filesystem:read_text_file",
    confidence: 0.7,
    description: "Read the contents of a text file from the filesystem",
  },

  // ============================================================================
  // HTTP operations → std/http
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.httpRequest",
    n8nOperation: "get",
    mcpToolId: "http:http_get",
    confidence: 0.95,
    description: "Make an HTTP GET request to fetch data from a URL",
  },
  {
    n8nNodeType: "n8n-nodes-base.httpRequest",
    n8nOperation: "post",
    mcpToolId: "http:http_post",
    confidence: 0.95,
    description: "Make an HTTP POST request to send data to a URL",
  },
  {
    n8nNodeType: "n8n-nodes-base.httpRequest",
    n8nOperation: "put",
    mcpToolId: "http:http_request",
    confidence: 0.9,
    description: "Make a generic HTTP request with custom method and body",
  },
  {
    n8nNodeType: "n8n-nodes-base.httpRequest",
    n8nOperation: "patch",
    mcpToolId: "http:http_request",
    confidence: 0.9,
    description: "Make a generic HTTP request with custom method and body",
  },
  {
    n8nNodeType: "n8n-nodes-base.httpRequest",
    n8nOperation: "delete",
    mcpToolId: "http:http_request",
    confidence: 0.9,
    description: "Make a generic HTTP request with custom method and body",
  },
  {
    n8nNodeType: "n8n-nodes-base.httpRequest",
    mcpToolId: "http:http_request",
    confidence: 0.8,
    description: "Make a generic HTTP request with custom method and body",
  },
  {
    n8nNodeType: "n8n-nodes-base.httpRequestTool",
    mcpToolId: "http:http_get",
    confidence: 0.85,
    description: "Make an HTTP GET request to fetch data from a URL",
  },
  {
    n8nNodeType: "n8n-nodes-base.webhook",
    mcpToolId: "http:http_request",
    confidence: 0.6,
    description: "Make a generic HTTP request with custom method and body",
  },

  // ============================================================================
  // Browser/Playwright → playwright MCP
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.puppeteer",
    mcpToolId: "playwright:browser_navigate",
    confidence: 0.8,
    description: "Navigate to a URL in the browser",
  },

  // ============================================================================
  // Code execution → Pure operations (code:*) for JS, python:* for Python
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.code",
    n8nOperation: "python",
    mcpToolId: "python:python_exec",
    confidence: 0.95,
    description: "Execute Python code and return the result",
  },
  {
    n8nNodeType: "n8n-nodes-base.code",
    n8nOperation: "javascript",
    mcpToolId: "code:map",
    confidence: 0.85,
    description: "Transform each element in an array using a function",
  },
  {
    n8nNodeType: "n8n-nodes-base.code",
    mcpToolId: "code:map",
    confidence: 0.7,
    description: "Transform each element in an array using a function",
  },
  {
    n8nNodeType: "n8n-nodes-base.function",
    mcpToolId: "code:map",
    confidence: 0.8,
    description: "Transform each element in an array using a function",
  },
  {
    n8nNodeType: "n8n-nodes-base.functionItem",
    mcpToolId: "code:map",
    confidence: 0.8,
    description: "Transform each element in an array using a function",
  },

  // ============================================================================
  // Git → @modelcontextprotocol/server-git
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.git",
    mcpToolId: "git:git_status",
    confidence: 0.7,
    description: "Show the current status of a Git repository",
  },
  // ============================================================================
  // GitHub → @modelcontextprotocol/server-github
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.github",
    n8nOperation: "issue:create",
    mcpToolId: "github:create_issue",
    confidence: 0.95,
    description: "Create a new issue in a GitHub repository",
  },
  {
    n8nNodeType: "n8n-nodes-base.github",
    n8nOperation: "issue:get",
    mcpToolId: "github:get_issue",
    confidence: 0.95,
    description: "Get details of a specific GitHub issue",
  },
  {
    n8nNodeType: "n8n-nodes-base.github",
    n8nOperation: "issue:update",
    mcpToolId: "github:update_issue",
    confidence: 0.95,
    description: "Update an existing GitHub issue",
  },
  {
    n8nNodeType: "n8n-nodes-base.github",
    n8nOperation: "repo:create",
    mcpToolId: "github:create_repository",
    confidence: 0.95,
    description: "Create a new GitHub repository",
  },
  {
    n8nNodeType: "n8n-nodes-base.github",
    n8nOperation: "file:get",
    mcpToolId: "github:get_file_contents",
    confidence: 0.95,
    description: "Get the contents of a file from a GitHub repository",
  },
  {
    n8nNodeType: "n8n-nodes-base.github",
    n8nOperation: "pullrequest:create",
    mcpToolId: "github:create_pull_request",
    confidence: 0.95,
    description: "Create a new pull request in a GitHub repository",
  },
  {
    n8nNodeType: "n8n-nodes-base.github",
    mcpToolId: "github:list_issues",
    confidence: 0.7,
    description: "List issues in a GitHub repository",
  },

  // ============================================================================
  // Memory/Knowledge Graph → @modelcontextprotocol/server-memory
  // ============================================================================
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.memoryBufferWindow",
    mcpToolId: "memory:create_entities",
    confidence: 0.7,
    description: "Create entities in a knowledge graph",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.toolWikipedia",
    mcpToolId: "fetch:fetch",
    confidence: 0.6,
    description: "Fetch content from a URL using HTTP",
  },

  // ============================================================================
  // AI/LLM operations → MCP Sampling (LLM completions)
  // https://modelcontextprotocol.io/docs/concepts/sampling
  //
  // All LLM-related nodes (agents, chains, chat models) make LLM calls
  // which maps to MCP's sampling capability (createMessage)
  // ============================================================================
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.agent",
    mcpToolId: "sampling:createMessage",
    confidence: 0.9,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.chainLlm",
    mcpToolId: "sampling:createMessage",
    confidence: 0.9,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.chainRetrievalQa",
    mcpToolId: "sampling:createMessage",
    confidence: 0.85,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.chainSummarization",
    mcpToolId: "sampling:createMessage",
    confidence: 0.85,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
    mcpToolId: "sampling:createMessage",
    confidence: 0.95,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.lmChatGoogleGemini",
    mcpToolId: "sampling:createMessage",
    confidence: 0.95,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.lmChatAnthropic",
    mcpToolId: "sampling:createMessage",
    confidence: 0.95,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.openAi",
    mcpToolId: "sampling:createMessage",
    confidence: 0.95,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.lmChatOllama",
    mcpToolId: "sampling:createMessage",
    confidence: 0.95,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.lmChatGroq",
    mcpToolId: "sampling:createMessage",
    confidence: 0.95,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.lmChatMistralCloud",
    mcpToolId: "sampling:createMessage",
    confidence: 0.95,
    description: "Generate a response from a language model (LLM completion)",
  },
  // Additional LangChain nodes
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.lmChatOpenRouter",
    mcpToolId: "sampling:createMessage",
    confidence: 0.95,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.googleGemini",
    mcpToolId: "sampling:createMessage",
    confidence: 0.95,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.toolThink",
    mcpToolId: "sampling:createMessage",
    confidence: 0.85,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.outputParserStructured",
    mcpToolId: "code:JSON.parse",
    confidence: 0.9,
    description: "Parse a JSON string into a JavaScript object",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.outputParserItemList",
    mcpToolId: "code:JSON.parse",
    confidence: 0.85,
    description: "Parse a JSON string into a JavaScript object",
  },
  // Embeddings → sampling (generates embeddings via LLM)
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.embeddingsOpenAi",
    mcpToolId: "sampling:createMessage",
    confidence: 0.8,
    description: "Generate a response from a language model (LLM completion)",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.embeddingsGoogleGemini",
    mcpToolId: "sampling:createMessage",
    confidence: 0.8,
    description: "Generate a response from a language model (LLM completion)",
  },
  // Vector stores → memory
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.vectorStoreSupabase",
    mcpToolId: "memory:create_entities",
    confidence: 0.75,
    description: "Create entities in a knowledge graph",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.vectorStorePinecone",
    mcpToolId: "memory:create_entities",
    confidence: 0.75,
    description: "Create entities in a knowledge graph",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.vectorStoreInMemory",
    mcpToolId: "memory:create_entities",
    confidence: 0.8,
    description: "Create entities in a knowledge graph",
  },
  // Document loaders
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.documentDefaultDataLoader",
    mcpToolId: "filesystem:read_text_file",
    confidence: 0.7,
    description: "Read the contents of a text file from the filesystem",
  },
  {
    n8nNodeType: "@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter",
    mcpToolId: "code:split",
    confidence: 0.85,
    description: "Split a string into an array by a separator",
  },

  // ============================================================================
  // Google services → mcp-gsheets
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.googleSheets",
    n8nOperation: "read",
    mcpToolId: "google-sheets:sheets_get_values",
    confidence: 0.95,
    description: "Read values from a Google Sheets spreadsheet range",
  },
  {
    n8nNodeType: "n8n-nodes-base.googleSheets",
    n8nOperation: "append",
    mcpToolId: "google-sheets:sheets_update_values",
    confidence: 0.9,
    description: "Update or append values to a Google Sheets spreadsheet",
  },
  {
    n8nNodeType: "n8n-nodes-base.googleSheets",
    n8nOperation: "appendorupdate",
    mcpToolId: "google-sheets:sheets_update_values",
    confidence: 0.85,
    description: "Update or append values to a Google Sheets spreadsheet",
  },
  {
    n8nNodeType: "n8n-nodes-base.googleSheets",
    n8nOperation: "update",
    mcpToolId: "google-sheets:sheets_update_values",
    confidence: 0.95,
    description: "Update or append values to a Google Sheets spreadsheet",
  },
  {
    n8nNodeType: "n8n-nodes-base.googleSheets",
    mcpToolId: "google-sheets:sheets_get_values",
    confidence: 0.7,
    description: "Read values from a Google Sheets spreadsheet range",
  },

  // ============================================================================
  // Communication - Slack → @mcp-monorepo/slack
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.slack",
    n8nOperation: "post",
    mcpToolId: "slack:post_message",
    confidence: 0.95,
    description: "Post a message to a Slack channel",
  },
  {
    n8nNodeType: "n8n-nodes-base.slack",
    n8nOperation: "gethistory",
    mcpToolId: "slack:get_channel_history",
    confidence: 0.9,
    description: "Get message history from a Slack channel",
  },
  {
    n8nNodeType: "n8n-nodes-base.slack",
    mcpToolId: "slack:post_message",
    confidence: 0.8,
    description: "Post a message to a Slack channel",
  },

  // ============================================================================
  // Communication - Telegram → @iqai/mcp-telegram
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.telegram",
    n8nOperation: "sendmessage",
    mcpToolId: "telegram:SEND_MESSAGE",
    confidence: 0.95,
    description: "Send a text message to a Telegram chat",
  },
  {
    n8nNodeType: "n8n-nodes-base.telegram",
    n8nOperation: "sendvideo",
    mcpToolId: "telegram:SEND_MESSAGE",
    confidence: 0.9,
    description: "Send a text message to a Telegram chat",
  },
  {
    n8nNodeType: "n8n-nodes-base.telegram",
    n8nOperation: "sendphoto",
    mcpToolId: "telegram:SEND_MESSAGE",
    confidence: 0.9,
    description: "Send a text message to a Telegram chat",
  },
  {
    n8nNodeType: "n8n-nodes-base.telegram",
    n8nOperation: "file",
    mcpToolId: "telegram:SEND_MESSAGE",
    confidence: 0.85,
    description: "Send a text message to a Telegram chat",
  },
  {
    n8nNodeType: "n8n-nodes-base.telegram",
    mcpToolId: "telegram:SEND_MESSAGE",
    confidence: 0.8,
    description: "Send a text message to a Telegram chat",
  },

  // ============================================================================
  // Database operations → std/database
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.postgres",
    mcpToolId: "database:psql_query",
    confidence: 0.95,
    description: "Execute a SQL query against a PostgreSQL database",
  },
  {
    n8nNodeType: "n8n-nodes-base.mySql",
    mcpToolId: "database:mysql_query",
    confidence: 0.95,
    description: "Execute a SQL query against a MySQL database",
  },
  {
    n8nNodeType: "n8n-nodes-base.redis",
    mcpToolId: "database:redis_cli",
    confidence: 0.9,
    description: "Execute a Redis command",
  },
  {
    n8nNodeType: "n8n-nodes-base.sqlite",
    mcpToolId: "database:sqlite_query",
    confidence: 0.95,
    description: "Execute a SQL query against a SQLite database",
  },

  // ============================================================================
  // RSS
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.rssFeedReadTool",
    mcpToolId: "fetch:fetch",
    confidence: 0.7,
    description: "Fetch content from a URL using HTTP",
  },

  // ============================================================================
  // Control flow / Data manipulation → Pure operations (code:*)
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.set",
    mcpToolId: "code:Object.assign", // Set fields = Object.assign
    confidence: 0.9,
    description: "Merge properties from source objects into a target object",
  },
  {
    n8nNodeType: "n8n-nodes-base.merge",
    mcpToolId: "code:concat", // Merge arrays
    confidence: 0.85,
    description: "Concatenate multiple arrays into a single array",
  },
  {
    n8nNodeType: "n8n-nodes-base.splitInBatches",
    mcpToolId: "code:slice", // Split = slice into batches
    confidence: 0.85,
    description: "Extract a portion of an array from start to end index",
  },
  {
    n8nNodeType: "n8n-nodes-base.splitOut",
    mcpToolId: "code:flatMap", // Split out = flatMap
    confidence: 0.9,
    description: "Map each element to an array then flatten the result",
  },
  {
    n8nNodeType: "n8n-nodes-base.filter",
    mcpToolId: "code:filter", // Direct match!
    confidence: 0.95,
    description: "Filter array elements based on a condition",
  },
  {
    n8nNodeType: "n8n-nodes-base.aggregate",
    mcpToolId: "code:reduce", // Aggregate = reduce
    confidence: 0.9,
    description: "Reduce an array to a single value using an accumulator function",
  },
  {
    n8nNodeType: "n8n-nodes-base.if",
    mcpToolId: "code:filter", // If = conditional filter
    confidence: 0.8,
    description: "Filter array elements based on a condition",
  },
  {
    n8nNodeType: "n8n-nodes-base.switch",
    mcpToolId: "code:filter", // Switch = multi-way filter
    confidence: 0.7,
    description: "Filter array elements based on a condition",
  },
  {
    n8nNodeType: "n8n-nodes-base.removeDuplicates",
    mcpToolId: "code:filter", // Remove duplicates via filter
    confidence: 0.85,
    description: "Filter array elements based on a condition",
  },
  {
    n8nNodeType: "n8n-nodes-base.sort",
    mcpToolId: "code:sort", // Direct match!
    confidence: 0.95,
    description: "Sort array elements in ascending or descending order",
  },
  {
    n8nNodeType: "n8n-nodes-base.limit",
    mcpToolId: "code:slice", // Limit = slice
    confidence: 0.9,
    description: "Extract a portion of an array from start to end index",
  },
  {
    n8nNodeType: "n8n-nodes-base.itemLists",
    mcpToolId: "code:map", // Item lists manipulation
    confidence: 0.8,
    description: "Transform each element in an array using a function",
  },
  {
    n8nNodeType: "n8n-nodes-base.compareDatasets",
    mcpToolId: "code:filter", // Compare = filter differences
    confidence: 0.75,
    description: "Filter array elements based on a condition",
  },

  // ============================================================================
  // Data transformation → Pure operations (code:JSON.*) + std/transform
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.xml",
    n8nOperation: "jsontoxml",
    mcpToolId: "transform:transform_json_to_xml", // MCP for XML (complex)
    confidence: 0.95,
    description: "Convert a JSON object to an XML string",
  },
  {
    n8nNodeType: "n8n-nodes-base.xml",
    n8nOperation: "xmltojson",
    mcpToolId: "transform:transform_xml_to_json",
    confidence: 0.95,
    description: "Parse an XML string into a JSON object",
  },
  {
    n8nNodeType: "n8n-nodes-base.spreadsheetFile",
    n8nOperation: "fromfile",
    mcpToolId: "transform:transform_csv_parse",
    confidence: 0.85,
    description: "Parse CSV text into an array of objects",
  },
  {
    n8nNodeType: "n8n-nodes-base.spreadsheetFile",
    n8nOperation: "tofile",
    mcpToolId: "transform:transform_csv_stringify",
    confidence: 0.85,
    description: "Convert an array of objects to CSV text",
  },
  // JSON operations → Pure operations
  {
    n8nNodeType: "n8n-nodes-base.json",
    n8nOperation: "parse",
    mcpToolId: "code:JSON.parse", // Pure operation!
    confidence: 0.95,
    description: "Parse a JSON string into a JavaScript object",
  },
  {
    n8nNodeType: "n8n-nodes-base.json",
    n8nOperation: "stringify",
    mcpToolId: "code:JSON.stringify", // Pure operation!
    confidence: 0.95,
    description: "Convert a JavaScript value to a JSON string",
  },
  {
    n8nNodeType: "n8n-nodes-base.json",
    mcpToolId: "code:JSON.parse", // Default
    confidence: 0.8,
    description: "Parse a JSON string into a JavaScript object",
  },
  // Edit fields (rename, set, delete) → Object operations
  {
    n8nNodeType: "n8n-nodes-base.renameKeys",
    mcpToolId: "code:Object.fromEntries", // Rename = transform entries
    confidence: 0.85,
    description: "Transform an iterable of key-value pairs into an object",
  },
  {
    n8nNodeType: "n8n-nodes-base.moveKeysAndValues",
    mcpToolId: "code:Object.entries", // Move keys = work with entries
    confidence: 0.8,
    description: "Get an array of key-value pairs from an object",
  },

  // ============================================================================
  // Notion → @notionhq/notion-mcp-server
  // ============================================================================
  {
    n8nNodeType: "n8n-nodes-base.notion",
    n8nOperation: "create",
    mcpToolId: "notion:create_page",
    confidence: 0.95,
    description: "Create a new page in a Notion database or workspace",
  },
  {
    n8nNodeType: "n8n-nodes-base.notion",
    n8nOperation: "update",
    mcpToolId: "notion:update_page",
    confidence: 0.95,
    description: "Update the content or properties of a Notion page",
  },
  {
    n8nNodeType: "n8n-nodes-base.notion",
    n8nOperation: "get",
    mcpToolId: "notion:search",
    confidence: 0.85,
    description: "Search for pages and databases in Notion by title",
  },
  {
    n8nNodeType: "n8n-nodes-base.notion",
    n8nOperation: "archive",
    mcpToolId: "notion:archive_page",
    confidence: 0.95,
    description: "Archive a Notion page (soft delete)",
  },
  {
    n8nNodeType: "n8n-nodes-base.notion",
    mcpToolId: "notion:search",
    confidence: 0.7,
    description: "Search for pages and databases in Notion by title",
  },
];

/**
 * Tool Mapper class
 *
 * Maps n8n node types to MCP tool IDs using configurable strategies.
 */
export class ToolMapper {
  private config: ToolMapperConfig;
  private mappingIndex: Map<string, ToolMapping>;

  constructor(config?: Partial<ToolMapperConfig>) {
    this.config = {
      manualMappings: config?.manualMappings ?? DEFAULT_MANUAL_MAPPINGS,
      useEmbeddingFallback: config?.useEmbeddingFallback ?? false,
      embeddingThreshold: config?.embeddingThreshold ?? 0.8,
    };

    // Build index for fast lookup
    this.mappingIndex = new Map();
    for (const mapping of this.config.manualMappings) {
      const key = mapping.n8nOperation
        ? `${mapping.n8nNodeType}:${mapping.n8nOperation}`
        : mapping.n8nNodeType;
      this.mappingIndex.set(key, mapping);
    }

    log.info(`[ToolMapper] Initialized with ${this.mappingIndex.size} mappings`);
  }

  /**
   * Map a single n8n identifier to MCP tool ID
   *
   * @param n8nId - n8n identifier (nodeType or nodeType:operation)
   * @returns MCP tool ID and confidence, or null if no mapping
   */
  map(n8nId: string): { mcpToolId: string; confidence: number } | null {
    // Try exact match first (with operation)
    const exactMatch = this.mappingIndex.get(n8nId);
    if (exactMatch) {
      return { mcpToolId: exactMatch.mcpToolId, confidence: exactMatch.confidence };
    }

    // Try without operation
    const nodeType = n8nId.split(":")[0];
    const nodeOnlyMatch = this.mappingIndex.get(nodeType);
    if (nodeOnlyMatch) {
      // Slightly lower confidence when operation not matched
      return { mcpToolId: nodeOnlyMatch.mcpToolId, confidence: nodeOnlyMatch.confidence * 0.9 };
    }

    // TODO: Embedding fallback
    if (this.config.useEmbeddingFallback) {
      log.debug(`[ToolMapper] No mapping for ${n8nId}, embedding fallback not implemented yet`);
    }

    return null;
  }

  /**
   * Map scraped patterns to prior patterns with MCP tool IDs
   */
  mapPatterns(patterns: ScrapedPattern[]): {
    priorPatterns: PriorPattern[];
    unmapped: ScrapedPattern[];
    stats: { mapped: number; unmapped: number };
  } {
    const priorPatterns: PriorPattern[] = [];
    const unmapped: ScrapedPattern[] = [];

    for (const pattern of patterns) {
      const fromMapping = this.map(pattern.fromN8n);
      const toMapping = this.map(pattern.toN8n);

      if (fromMapping && toMapping) {
        // Calculate weight (lower = better)
        // Base formula: 2.0 / log10(frequency + 1)
        // Adjusted by mapping confidence
        const freqBoost = Math.log10(pattern.frequency + 1);
        const avgConfidence = (fromMapping.confidence + toMapping.confidence) / 2;
        const weight = 2.0 / (freqBoost * avgConfidence);

        priorPatterns.push({
          from: fromMapping.mcpToolId,
          to: toMapping.mcpToolId,
          weight: Math.round(weight * 100) / 100, // Round to 2 decimals
          frequency: pattern.frequency,
          mappingConfidence: avgConfidence,
          source: "n8n",
          isOfficial: false, // TODO: Track verified creators
        });

        // Update scraped pattern with mappings
        pattern.fromMcp = fromMapping.mcpToolId;
        pattern.toMcp = toMapping.mcpToolId;
      } else {
        unmapped.push(pattern);
      }
    }

    // Sort by weight (best first)
    priorPatterns.sort((a, b) => a.weight - b.weight);

    log.info(
      `[ToolMapper] Mapped ${priorPatterns.length} patterns, ${unmapped.length} unmapped`,
    );

    return {
      priorPatterns,
      unmapped,
      stats: { mapped: priorPatterns.length, unmapped: unmapped.length },
    };
  }

  /**
   * Add custom mappings
   */
  addMappings(mappings: ToolMapping[]): void {
    for (const mapping of mappings) {
      const key = mapping.n8nOperation
        ? `${mapping.n8nNodeType}:${mapping.n8nOperation}`
        : mapping.n8nNodeType;
      this.mappingIndex.set(key, mapping);
      this.config.manualMappings.push(mapping);
    }
    log.info(`[ToolMapper] Added ${mappings.length} mappings, total: ${this.mappingIndex.size}`);
  }

  /**
   * Get all registered mappings
   */
  getMappings(): ToolMapping[] {
    return [...this.config.manualMappings];
  }

  /**
   * Get mapping statistics
   */
  getStats(): { totalMappings: number; byService: Record<string, number> } {
    const byService: Record<string, number> = {};

    for (const mapping of this.config.manualMappings) {
      const service = mapping.mcpToolId.split(":")[0];
      byService[service] = (byService[service] || 0) + 1;
    }

    return {
      totalMappings: this.config.manualMappings.length,
      byService,
    };
  }

  /**
   * Get available MCP tools by server
   */
  static getMCPTools(): typeof MCP_TOOLS {
    return MCP_TOOLS;
  }
}

/**
 * Default tool mapper instance
 */
let defaultMapper: ToolMapper | null = null;

/**
 * Get or create default tool mapper
 */
export function getDefaultToolMapper(): ToolMapper {
  if (!defaultMapper) {
    defaultMapper = new ToolMapper();
  }
  return defaultMapper;
}
