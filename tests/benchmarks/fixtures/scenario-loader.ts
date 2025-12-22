/**
 * Benchmark Scenario Loader
 *
 * Loads and parses benchmark scenarios from JSON files.
 * Provides graph construction from scenario data.
 *
 * @module tests/benchmarks/fixtures/scenario-loader
 */

import Graph from "graphology";

// ============================================================================
// Types
// ============================================================================

export interface ToolNode {
  id: string;
  pageRank: number;
  community: number;
}

export interface CapabilityNode {
  id: string;
  toolsUsed: string[];
  successRate: number;
}

export interface MetaCapabilityNode {
  id: string;
  contains: string[];
  description: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "dependency" | "sequence" | "contains";
  source_type: "observed" | "inferred" | "template";
  weight: number;
  count: number;
}

export interface ScenarioData {
  name: string;
  description: string;
  nodes: {
    tools: ToolNode[];
    capabilities: CapabilityNode[];
    metaCapabilities?: MetaCapabilityNode[];
  };
  edges: GraphEdge[];
  expectedResults?: Record<string, unknown>;
  expectedPerformance?: Record<string, { maxMs: number }>;
}

export interface GeneratedScenario extends ScenarioData {
  generatedAt: Date;
}

// ============================================================================
// Scenario Loading
// ============================================================================

/**
 * Load a scenario from JSON file
 */
export async function loadScenario(name: string): Promise<ScenarioData> {
  const path = new URL(`./scenarios/${name}.json`, import.meta.url);
  const text = await Deno.readTextFile(path);
  return JSON.parse(text) as ScenarioData;
}

/**
 * List available scenarios
 */
export async function listScenarios(): Promise<string[]> {
  const scenariosPath = new URL("./scenarios/", import.meta.url);
  const entries: string[] = [];

  for await (const entry of Deno.readDir(scenariosPath)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      entries.push(entry.name.replace(".json", ""));
    }
  }

  return entries;
}

// ============================================================================
// Graph Construction
// ============================================================================

/**
 * Helper to add bidirectional edge (for algorithms like heat diffusion)
 */
function addBidirectionalEdge(
  graph: Graph,
  source: string,
  target: string,
  attrs: Record<string, unknown>
): void {
  if (!graph.hasEdge(source, target)) {
    graph.addEdge(source, target, attrs);
  }
  if (!graph.hasEdge(target, source)) {
    graph.addEdge(target, source, { ...attrs, reverse: true });
  }
}

/**
 * Build a Graphology graph from scenario data
 */
export function buildGraphFromScenario(scenario: ScenarioData): Graph {
  const graph = new Graph({ multi: false, type: "directed" });

  // Add tool nodes
  for (const tool of scenario.nodes.tools) {
    graph.addNode(tool.id, {
      type: "tool",
      pageRank: tool.pageRank,
      community: tool.community,
    });
  }

  // Add capability nodes
  for (const cap of scenario.nodes.capabilities) {
    graph.addNode(cap.id, {
      type: "capability",
      toolsUsed: cap.toolsUsed,
      successRate: cap.successRate,
    });

    // Add bidirectional contains edges from capability to tools
    for (const toolId of cap.toolsUsed) {
      if (graph.hasNode(toolId)) {
        addBidirectionalEdge(graph, cap.id, toolId, {
          edge_type: "contains",
          edge_source: "template",
          weight: 0.8,
          count: 1,
        });
      }
    }
  }

  // Add meta-capability nodes if present
  if (scenario.nodes.metaCapabilities) {
    for (const meta of scenario.nodes.metaCapabilities) {
      graph.addNode(meta.id, {
        type: "meta_capability",
        contains: meta.contains,
        description: meta.description,
      });

      // Add bidirectional contains edges from meta to capabilities
      for (const capId of meta.contains) {
        if (graph.hasNode(capId)) {
          addBidirectionalEdge(graph, meta.id, capId, {
            edge_type: "contains",
            edge_source: "template",
            weight: 0.9,
            count: 1,
          });
        }
      }
    }
  }

  // Add explicit edges (bidirectional for heat diffusion support)
  for (const edge of scenario.edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      addBidirectionalEdge(graph, edge.source, edge.target, {
        edge_type: edge.type,
        edge_source: edge.source_type,
        weight: edge.weight,
        count: edge.count,
      });
    }
  }

  return graph;
}

// ============================================================================
// Stress Test Graph Generator
// ============================================================================

export interface StressGraphConfig {
  toolCount: number;
  capabilityCount: number;
  metaCapabilityCount: number;
  edgeDensity: number;
  toolsPerCapability: { min: number; max: number };
  capabilitiesPerMeta: { min: number; max: number };
}

/**
 * Generate a stress test graph with configurable size
 */
export function generateStressGraph(config: StressGraphConfig): ScenarioData {
  const tools: ToolNode[] = [];
  const capabilities: CapabilityNode[] = [];
  const metaCapabilities: MetaCapabilityNode[] = [];
  const edges: GraphEdge[] = [];

  // Generate tools
  const domains = ["fs", "db", "http", "json", "auth", "cache", "log", "crypto", "queue", "storage"];
  const operations = ["read", "write", "get", "set", "query", "insert", "update", "delete", "list", "validate"];

  for (let i = 0; i < config.toolCount; i++) {
    const domain = domains[i % domains.length];
    const op = operations[i % operations.length];
    tools.push({
      id: `${domain}__${op}_${i}`,
      pageRank: Math.random() * 0.1,
      community: Math.floor(i / (config.toolCount / 10)),
    });
  }

  // Generate capabilities
  for (let i = 0; i < config.capabilityCount; i++) {
    const toolCount = config.toolsPerCapability.min +
      Math.floor(Math.random() * (config.toolsPerCapability.max - config.toolsPerCapability.min));
    const toolsUsed: string[] = [];

    for (let j = 0; j < toolCount; j++) {
      const toolIdx = Math.floor(Math.random() * tools.length);
      if (!toolsUsed.includes(tools[toolIdx].id)) {
        toolsUsed.push(tools[toolIdx].id);
      }
    }

    capabilities.push({
      id: `cap__generated_${i}`,
      toolsUsed,
      successRate: 0.7 + Math.random() * 0.25,
    });
  }

  // Generate meta-capabilities
  for (let i = 0; i < config.metaCapabilityCount; i++) {
    const capCount = config.capabilitiesPerMeta.min +
      Math.floor(Math.random() * (config.capabilitiesPerMeta.max - config.capabilitiesPerMeta.min));
    const contains: string[] = [];

    for (let j = 0; j < capCount; j++) {
      const capIdx = Math.floor(Math.random() * capabilities.length);
      if (!contains.includes(capabilities[capIdx].id)) {
        contains.push(capabilities[capIdx].id);
      }
    }

    metaCapabilities.push({
      id: `meta__generated_${i}`,
      contains,
      description: `Generated meta-capability ${i}`,
    });
  }

  // Generate edges between tools
  const edgeCount = Math.floor(config.toolCount * config.toolCount * config.edgeDensity);
  const edgeTypes: ("dependency" | "sequence")[] = ["dependency", "sequence"];
  const edgeSources: ("observed" | "inferred" | "template")[] = ["observed", "inferred", "template"];

  for (let i = 0; i < edgeCount; i++) {
    const source = tools[Math.floor(Math.random() * tools.length)];
    const target = tools[Math.floor(Math.random() * tools.length)];

    if (source.id !== target.id) {
      edges.push({
        source: source.id,
        target: target.id,
        type: edgeTypes[Math.floor(Math.random() * edgeTypes.length)],
        source_type: edgeSources[Math.floor(Math.random() * edgeSources.length)],
        weight: 0.3 + Math.random() * 0.6,
        count: Math.floor(Math.random() * 100) + 1,
      });
    }
  }

  return {
    name: "generated-stress",
    description: `Generated stress graph: ${config.toolCount} tools, ${config.capabilityCount} caps, ${config.metaCapabilityCount} metas`,
    nodes: {
      tools,
      capabilities,
      metaCapabilities,
    },
    edges,
  };
}
