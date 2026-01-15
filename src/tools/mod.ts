/**
 * Standard library tools - aggregated exports
 *
 * @module lib/std/src/tools/mod
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
export { agentTools, createAgenticSamplingClient, setSamplingClient } from "./agent.ts";

// Capability management moved to pml:discover and pml:admin
// Types no longer exported - use pml gateway directly

// Python execution tools
export { pythonTools } from "./python.ts";

// Legacy tools (backward compat)
export { dataTools } from "./data.ts";
export { stateTools } from "./state.ts";
export { compareTools } from "./compare.ts";

// Utility tools
export { utilTools } from "./util.ts";

// Imports for combined arrays
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
import { agentTools } from "./agent.ts";
// pmlTools removed - capability management via pml:admin/pml:discover
import { pythonTools } from "./python.ts";
import { dataTools } from "./data.ts";
import { stateTools } from "./state.ts";
import { compareTools } from "./compare.ts";
import { utilTools } from "./util.ts";
import type { MiniTool } from "./types.ts";

/** All tools combined */
export const allTools: MiniTool[] = [
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
  ...stringTools,
  ...pathTools,
  ...fakerTools,
  ...colorTools,
  ...geoTools,
  ...qrcodeTools,
  ...resilienceTools,
  ...schemaTools,
  ...diffTools,
  ...agentTools,
  ...pythonTools,
  ...dataTools,
  ...stateTools,
  ...compareTools,
  ...utilTools,
];

/** Tools organized by category */
export const toolsByCategory: Record<string, MiniTool[]> = {
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
  util: utilTools,
  agent: agentTools,
  python: pythonTools,
};

/** Get tools by category */
export function getToolsByCategory(category: string): MiniTool[] {
  return toolsByCategory[category] || [];
}

/** Get a specific tool by name */
export function getToolByName(name: string): MiniTool | undefined {
  return allTools.find((t) => t.name === name);
}

/** Get all available categories */
export function getCategories(): string[] {
  return Object.keys(toolsByCategory);
}
