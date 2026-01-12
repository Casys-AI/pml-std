/**
 * Standard library tools - aggregated exports
 *
 * System tools:
 * - docker.ts     - Container/image management
 * - git.ts        - Repository operations
 * - network.ts    - HTTP, DNS, connectivity
 * - process.ts    - Process management
 * - archive.ts    - Compression (tar, zip)
 * - ssh.ts        - Remote execution
 * - kubernetes.ts - K8s cluster management
 * - database.ts   - SQL/NoSQL access
 * - media.ts      - Audio/video/image
 * - cloud.ts      - AWS, GCP, systemd
 * - sysinfo.ts    - System information
 * - packages.ts   - npm, pip, apt, brew
 * - text.ts       - sed, awk, jq, sort
 *
 * Data tools:
 * - algo.ts       - Sorting, searching algorithms
 * - collections.ts- Array/set/map operations
 * - crypto.ts     - Hashing, encoding, encryption
 * - datetime.ts   - Date/time manipulation
 * - format.ts     - Formatting (numbers, bytes, etc)
 * - http.ts       - HTTP client operations
 * - json.ts       - JSON manipulation
 * - math.ts       - Mathematical operations
 * - transform.ts  - Data transformations (CSV, XML)
 * - validation.ts - Data validation
 * - vfs.ts        - Virtual filesystem
 *
 * New tools:
 * - string.ts     - String manipulation
 * - path.ts       - Path utilities
 * - faker.ts      - Mock data generation
 * - color.ts      - Color manipulation
 * - geo.ts        - Geographic calculations
 * - qrcode.ts     - QR/barcode generation
 * - resilience.ts - Retry/rate limiting
 * - schema.ts     - Schema inference
 * - diff.ts       - Text diff/comparison
 *
 * Agent tools (MCP Sampling):
 * - agent.ts      - LLM-powered decision/analysis via sampling
 *
 * Capability management (MCP Server):
 * - cap.ts        - cap:list, cap:rename, cap:lookup, cap:whois
 *
 * @module lib/std/mod
 */

export { type MiniTool, runCommand } from "./common.ts";
export type { MiniToolHandler, MiniToolResult, ToolCategory } from "./types.ts";

// System tools
export { dockerTools } from "./docker.ts";
export { gitTools } from "./git.ts";
export { networkTools } from "./network.ts";
export { processTools } from "./process.ts";
export { archiveTools } from "./archive.ts";
export { sshTools } from "./ssh.ts";
export { kubernetesTools } from "./kubernetes.ts";
export { databaseTools } from "./database.ts";
export { closePgliteConnection, pgliteTools } from "./pglite.ts";
export { mediaTools } from "./media.ts";
export { cloudTools } from "./cloud.ts";
export { sysinfoTools } from "./sysinfo.ts";
export { packagesTools } from "./packages.ts";
export { textTools } from "./text.ts";

// Data tools
export { algoTools } from "./algo.ts";
export { collectionsTools } from "./collections.ts";
export { cryptoTools } from "./crypto.ts";
export { datetimeTools } from "./datetime.ts";
export { formatTools } from "./format.ts";
export { httpTools } from "./http.ts";
export { jsonTools } from "./json.ts";
export { mathTools } from "./math.ts";
export { transformTools } from "./transform.ts";
export { validationTools } from "./validation.ts";
export { vfsTools } from "./vfs.ts";

// New tools
export { stringTools } from "./string.ts";
export { pathTools } from "./path.ts";
export { fakerTools } from "./faker.ts";
export { colorTools } from "./color.ts";
export { geoTools } from "./geo.ts";
export { qrcodeTools } from "./qrcode.ts";
export { resilienceTools } from "./resilience.ts";
export { schemaTools } from "./schema.ts";
export { diffTools } from "./diff.ts";

// Agent tools (MCP Sampling)
export { agentTools, setSamplingClient } from "./agent.ts";

// Capability management (MCP HTTP Client + types)
// Note: CapModule and PmlStdServer have been moved to src/mcp/handlers/cap-handler.ts
// This module now exports only the HTTP client and types for standalone package use
export { pmlTools } from "./cap.ts";
export type {
  CapListItem,
  CapListOptions,
  CapListResponse,
  CapLookupOptions,
  CapLookupResponse,
  CapMergeOptions,
  CapMergeResponse,
  CapRenameOptions,
  CapRenameResponse,
  CapTool,
  CapToolResult,
  CapWhoisOptions,
  CapWhoisResponse,
  OnCapabilityMerged,
} from "./cap.ts";

// Python execution tools
export { pythonTools } from "./python.ts";

// Legacy tools (backward compat)
export { dataTools } from "./data.ts";
export { stateTools } from "./state.ts";
export { compareTools } from "./compare.ts";

// Utility tools
export { utilTools } from "./util.ts";

// Imports for combined export
import { dockerTools } from "./docker.ts";
import { gitTools } from "./git.ts";
import { networkTools } from "./network.ts";
import { processTools } from "./process.ts";
import { archiveTools } from "./archive.ts";
import { sshTools } from "./ssh.ts";
import { kubernetesTools } from "./kubernetes.ts";
import { databaseTools } from "./database.ts";
import { pgliteTools } from "./pglite.ts";
import { mediaTools } from "./media.ts";
import { cloudTools } from "./cloud.ts";
import { sysinfoTools } from "./sysinfo.ts";
import { packagesTools } from "./packages.ts";
import { textTools } from "./text.ts";
import { algoTools } from "./algo.ts";
import { collectionsTools } from "./collections.ts";
import { cryptoTools } from "./crypto.ts";
import { datetimeTools } from "./datetime.ts";
import { formatTools } from "./format.ts";
import { httpTools } from "./http.ts";
import { jsonTools } from "./json.ts";
import { mathTools } from "./math.ts";
import { transformTools } from "./transform.ts";
import { validationTools } from "./validation.ts";
import { vfsTools } from "./vfs.ts";
import { stringTools } from "./string.ts";
import { pathTools } from "./path.ts";
import { fakerTools } from "./faker.ts";
import { colorTools } from "./color.ts";
import { geoTools } from "./geo.ts";
import { qrcodeTools } from "./qrcode.ts";
import { resilienceTools } from "./resilience.ts";
import { schemaTools } from "./schema.ts";
import { diffTools } from "./diff.ts";
// Agent imports
import { agentTools } from "./agent.ts";
// PML imports (capability management)
import { pmlTools } from "./cap.ts";
// Python imports
import { pythonTools } from "./python.ts";
// Legacy imports
import { dataTools } from "./data.ts";
import { stateTools } from "./state.ts";
import { compareTools } from "./compare.ts";
// Utility imports
import { utilTools } from "./util.ts";
import type { MiniTool as MiniToolType } from "./types.ts";

/** All system tools combined */
export const systemTools = [
  // System tools
  ...dockerTools,
  ...gitTools,
  ...networkTools,
  ...processTools,
  ...archiveTools,
  ...sshTools,
  ...kubernetesTools,
  ...databaseTools,
  ...pgliteTools,
  ...mediaTools,
  ...cloudTools,
  ...sysinfoTools,
  ...packagesTools,
  ...textTools,
  // Data tools
  ...algoTools,
  ...collectionsTools,
  ...cryptoTools,
  ...datetimeTools,
  ...formatTools,
  ...httpTools,
  ...jsonTools,
  ...mathTools,
  ...transformTools,
  ...validationTools,
  ...vfsTools,
  // New tools
  ...stringTools,
  ...pathTools,
  ...fakerTools,
  ...colorTools,
  ...geoTools,
  ...qrcodeTools,
  ...resilienceTools,
  ...schemaTools,
  ...diffTools,
  // Agent tools
  ...agentTools,
  // PML tools (capability management)
  ...pmlTools,
  // Python tools
  ...pythonTools,
  // Legacy tools
  ...dataTools,
  ...stateTools,
  ...compareTools,
  // Utility tools
  ...utilTools,
];

/** Alias for backward compatibility */
export const allTools = systemTools;

/** Tools organized by category */
export const toolsByCategory: Record<string, MiniToolType[]> = {
  text: textTools,
  json: jsonTools,
  math: mathTools,
  datetime: datetimeTools,
  crypto: cryptoTools,
  collections: collectionsTools,
  vfs: vfsTools,
  data: dataTools,
  http: httpTools,
  validation: validationTools,
  format: formatTools,
  transform: transformTools,
  state: stateTools,
  compare: compareTools,
  algo: algoTools,
  color: colorTools,
  network: networkTools,
  string: stringTools,
  path: pathTools,
  faker: fakerTools,
  geo: geoTools,
  qrcode: qrcodeTools,
  resilience: resilienceTools,
  schema: schemaTools,
  diff: diffTools,
  // System tools
  docker: dockerTools,
  git: gitTools,
  process: processTools,
  archive: archiveTools,
  ssh: sshTools,
  kubernetes: kubernetesTools,
  database: databaseTools,
  pglite: pgliteTools,
  media: mediaTools,
  cloud: cloudTools,
  sysinfo: sysinfoTools,
  packages: packagesTools,
  // Utility tools
  util: utilTools,
  // Agent tools (MCP Sampling)
  agent: agentTools,
  // PML tools (capability management)
  pml: pmlTools,
  // Python execution
  python: pythonTools,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get tools by category
 */
export function getToolsByCategory(category: string): MiniToolType[] {
  return toolsByCategory[category] || [];
}

/**
 * Get a specific tool by name
 */
export function getToolByName(name: string): MiniToolType | undefined {
  return allTools.find((t) => t.name === name);
}

/**
 * Get all available categories
 */
export function getCategories(): string[] {
  return Object.keys(toolsByCategory);
}

// ============================================================================
// MiniToolsClient Class
// ============================================================================

export interface MiniToolsClientOptions {
  categories?: string[];
}

/**
 * Client for executing mini-tools
 */
export class MiniToolsClient {
  private tools: MiniToolType[];

  constructor(options?: MiniToolsClientOptions) {
    if (options?.categories) {
      this.tools = options.categories.flatMap((cat) => getToolsByCategory(cat));
    } else {
      this.tools = allTools;
    }
  }

  /**
   * List available tools
   */
  listTools(): MiniToolType[] {
    return this.tools;
  }

  /**
   * Convert tools to MCP format
   */
  toMCPFormat(): Array<
    { name: string; description: string; inputSchema: Record<string, unknown> }
  > {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Execute a tool by name
   */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return await tool.handler(args);
  }

  /**
   * Get tool count
   */
  get count(): number {
    return this.tools.length;
  }
}

/** Default client instance with all tools */
export const defaultClient: MiniToolsClient = new MiniToolsClient();
