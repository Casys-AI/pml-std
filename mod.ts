/**
 * MCP Standard Library
 *
 * A comprehensive collection of MCP tools for AI agents.
 *
 * @module lib/std
 */

// Re-export client and tools
export {
  // Client
  defaultClient,
  MiniToolsClient,
  MiniToolsMCP,
  miniToolsMCP,
  // Tools
  allTools,
  getCategories,
  getToolByName,
  getToolsByCategory,
  toolsByCategory,
} from "./src/client.ts";

// Re-export client types
export type {
  MCPClientBase,
  MCPTool,
  MiniToolsClientOptions,
} from "./src/client.ts";

// Re-export types
export type {
  MiniTool,
  MiniToolHandler,
  MiniToolResult,
  ToolCategory,
} from "./src/client.ts";

// Re-export individual tool arrays for direct access
export {
  // System tools
  archiveTools,
  cloudTools,
  databaseTools,
  dockerTools,
  gitTools,
  kubernetesTools,
  mediaTools,
  networkTools,
  packagesTools,
  pgliteTools,
  closePgliteConnection,
  processTools,
  sshTools,
  sysinfoTools,
  textTools,
  // Data tools
  algoTools,
  collectionsTools,
  cryptoTools,
  datetimeTools,
  formatTools,
  httpTools,
  jsonTools,
  mathTools,
  transformTools,
  validationTools,
  vfsTools,
  // New tools
  colorTools,
  compareTools,
  dataTools,
  diffTools,
  fakerTools,
  geoTools,
  pathTools,
  qrcodeTools,
  resilienceTools,
  schemaTools,
  stateTools,
  stringTools,
  utilTools,
  // Agent tools
  agentTools,
  createAgenticSamplingClient,
  setSamplingClient,
  // Python tools
  pythonTools,
  // Common utilities
  runCommand,
} from "./src/tools/mod.ts";

/** Alias for backward compatibility */
export { allTools as systemTools } from "./src/tools/mod.ts";
