/**
 * Static Structure to DAG Converter (Epic 10 - Story 10.5)
 *
 * Converts StaticStructure (from static code analysis) to DAGStructure
 * for execution via ControlledExecutor with all DAG features:
 * - Per-layer validation (HIL)
 * - Parallel execution
 * - Checkpoints/resume
 * - SSE streaming
 *
 * @module dag/static-to-dag-converter
 */

import type {
  ArgumentsStructure,
  StaticStructure,
  StaticStructureNode,
} from "../capabilities/types.ts";
import type { Task } from "../graphrag/types.ts";
import { getLogger } from "../telemetry/logger.ts";
import { isPureOperation } from "../capabilities/pure-operations.ts";

const logger = getLogger("default");

/**
 * Condition for conditional task execution
 *
 * When present on a task, the task is only executed if the condition is met.
 * The condition references a decision node and the required outcome.
 */
export interface TaskCondition {
  /** ID of the decision node that controls this task */
  decisionNodeId: string;
  /** Required outcome for this task to execute ("true", "false", "case:value") */
  requiredOutcome: string;
}

/**
 * Extended Task with conditional execution support
 *
 * Extends the base Task with:
 * - condition: For conditional branches (if/else, switch)
 * - staticArguments: Original argument resolution strategies
 */
export interface ConditionalTask extends Task {
  /**
   * Condition for conditional execution (AC4)
   *
   * When set, this task is only executed if the referenced decision node
   * evaluates to the required outcome.
   */
  condition?: TaskCondition;

  /**
   * Original argument resolution strategies from static analysis (AC3)
   *
   * Preserved from StaticStructure for runtime argument resolution.
   * See ArgumentsStructure type for resolution strategies.
   */
  staticArguments?: ArgumentsStructure;
}

/**
 * Extended DAGStructure with conditional tasks
 */
export interface ConditionalDAGStructure {
  tasks: ConditionalTask[];
}

/**
 * Conversion options for staticStructureToDag
 */
export interface ConversionOptions {
  /**
   * Whether to include decision nodes as tasks (default: false)
   *
   * When true, decision nodes become tasks that evaluate conditions.
   * When false, decision nodes only affect conditional edges.
   */
  includeDecisionTasks?: boolean;

  /**
   * Prefix for generated task IDs (default: "task_")
   */
  taskIdPrefix?: string;
}

/**
 * Convert StaticStructure to DAGStructure for execution
 *
 * Mapping rules (AC1):
 * - task node → Task { tool, arguments, type: "mcp_tool" }
 * - capability node → Task { capabilityId, type: "capability" }
 * - decision node → Creates conditional edges (not a task)
 * - fork node → Parallel tasks (no dependencies between them)
 * - join node → Task depends on all fork children
 *
 * Edge mapping (AC1):
 * - sequence edge → Direct dependency (dependsOn)
 * - conditional edge → Task with condition field
 * - provides edge → Data flow dependency (dependsOn)
 *
 * @param structure StaticStructure from static code analysis
 * @param options Conversion options
 * @returns DAGStructure ready for ControlledExecutor
 */
export function staticStructureToDag(
  structure: StaticStructure,
  options: ConversionOptions = {},
): ConditionalDAGStructure {
  const { includeDecisionTasks = false, taskIdPrefix = "task_" } = options;

  logger.debug("Converting static structure to DAG", {
    nodeCount: structure.nodes.length,
    edgeCount: structure.edges.length,
    variableBindingsCount: Object.keys(structure.variableBindings ?? {}).length,
  });

  // Phase 1: Create task map from nodes
  const tasks: ConditionalTask[] = [];
  const nodeToTaskId = new Map<string, string>();
  const forkChildren = new Map<string, string[]>(); // fork.id -> child task IDs

  for (const node of structure.nodes) {
    const task = nodeToTask(node, taskIdPrefix, includeDecisionTasks, structure.variableBindings);
    if (task) {
      tasks.push(task);
      nodeToTaskId.set(node.id, task.id);
    }

    // Track fork nodes for join dependency resolution
    if (node.type === "fork") {
      forkChildren.set(node.id, []);
    }
  }

  // Phase 2: Build dependency map from edges
  const dependencies = new Map<string, string[]>();
  const conditions = new Map<string, TaskCondition>();

  for (const edge of structure.edges) {
    const fromTaskId = nodeToTaskId.get(edge.from);
    const toTaskId = nodeToTaskId.get(edge.to);

    if (!toTaskId) continue; // Target node not converted to task

    switch (edge.type) {
      case "sequence":
      case "provides":
        // Direct dependency
        if (fromTaskId) {
          addDependency(dependencies, toTaskId, fromTaskId);
        }
        // Check if this is a fork -> child edge
        if (forkChildren.has(edge.from)) {
          forkChildren.get(edge.from)!.push(toTaskId);
        }
        break;

      case "conditional":
        // Conditional execution (AC4)
        if (edge.outcome) {
          conditions.set(toTaskId, {
            decisionNodeId: edge.from,
            requiredOutcome: edge.outcome,
          });
          // Also add dependency on the decision node (if included)
          if (fromTaskId) {
            addDependency(dependencies, toTaskId, fromTaskId);
          }
        }
        break;

      case "contains":
        // Hierarchy edge - not used for DAG execution
        break;
    }
  }

  // Phase 3: Resolve join dependencies (AC5)
  for (const node of structure.nodes) {
    if (node.type === "join") {
      const joinTaskId = nodeToTaskId.get(node.id);
      if (!joinTaskId) continue;

      // Find the matching fork by looking at incoming edges
      for (const edge of structure.edges) {
        if (edge.to === node.id && forkChildren.has(edge.from)) {
          // Don't add the fork itself, add its children
          continue;
        }
        if (edge.to === node.id && edge.type === "sequence") {
          const fromTaskId = nodeToTaskId.get(edge.from);
          if (fromTaskId) {
            addDependency(dependencies, joinTaskId, fromTaskId);
          }
        }
      }
    }
  }

  // Phase 4: Apply dependencies and conditions to tasks
  for (const task of tasks) {
    const deps = dependencies.get(task.id);
    if (deps) {
      task.dependsOn = [...new Set(deps)]; // Deduplicate
    }

    const condition = conditions.get(task.id);
    if (condition) {
      task.condition = condition;
    }
  }

  logger.debug("Static structure converted to DAG", {
    tasksCount: tasks.length,
    tasksWithDeps: tasks.filter((t) => t.dependsOn.length > 0).length,
    conditionalTasks: tasks.filter((t) => t.condition).length,
  });

  return { tasks };
}

/**
 * Convert a single StaticStructureNode to a Task
 *
 * @param node The node to convert
 * @param prefix Task ID prefix
 * @param includeDecisions Whether to include decision nodes as tasks
 * @param variableBindings Variable to node ID mappings for code task context injection
 * @returns Task or null if node should not become a task
 */
function nodeToTask(
  node: StaticStructureNode,
  prefix: string,
  includeDecisions: boolean,
  variableBindings?: Record<string, string>,
): ConditionalTask | null {
  const taskId = `${prefix}${node.id}`;

  switch (node.type) {
    case "task":
      // Check if this is a pseudo-tool (code operation)
      if (node.tool.startsWith("code:")) {
        const operation = node.tool.replace("code:", "");
        // Use extracted code from SWC span (Phase 1)
        const code = node.code || generateOperationCode(operation);

        if (!node.code) {
          logger.warn("Code operation missing extracted code, using fallback", {
            tool: node.tool,
            nodeId: node.id,
          });
        }

        // Get metadata from static analysis (Option B: executable tracking)
        const nodeMetadata = (node as { metadata?: Record<string, unknown> }).metadata;

        return {
          id: taskId,
          tool: node.tool, // Keep the pseudo-tool ID for tracing
          arguments: {}, // Will be resolved at runtime
          dependsOn: [],
          type: "code_execution",
          code,
          sandboxConfig: {
            permissionSet: "minimal", // Pure operations have minimal permissions
          },
          // Merge node metadata with pure operation check (Option B)
          metadata: {
            pure: isPureOperation(node.tool),
            ...nodeMetadata, // Preserve executable, nestingLevel, parentOperation
          },
          staticArguments: node.arguments,
          // Pass variable bindings for context injection at runtime
          variableBindings,
        };
      }

      // Regular MCP tool
      return {
        id: taskId,
        tool: node.tool,
        arguments: {}, // Will be resolved at runtime via staticArguments
        dependsOn: [],
        type: "mcp_tool",
        staticArguments: node.arguments,
      };

    case "capability":
      return {
        id: taskId,
        tool: `capability:${node.capabilityId}`,
        arguments: {},
        dependsOn: [],
        type: "capability",
        capabilityId: node.capabilityId,
      };

    case "decision":
      if (includeDecisions) {
        // Decision nodes can be tasks that evaluate conditions
        return {
          id: taskId,
          tool: "internal:decision",
          arguments: { condition: node.condition },
          dependsOn: [],
          type: "mcp_tool",
        };
      }
      return null; // Decision nodes are not tasks by default

    case "fork":
      // Fork nodes are structural, not tasks
      // They indicate parallel execution starts here
      return null;

    case "join":
      // Join nodes can be represented as synchronization points
      // For now, we don't create explicit join tasks
      // The join is implicit in the dependencies
      return null;

    default:
      logger.warn("Unknown node type in static structure", { node });
      return null;
  }
}

/**
 * Generate executable code for a code operation (filter, map, reduce, etc.)
 *
 * Takes an operation name and generates placeholder JavaScript code.
 * This is a simplified Phase 1 implementation - actual code execution
 * will need proper dependency resolution.
 *
 * @param operation The operation name (e.g., "filter", "map", "add")
 * @returns JavaScript code string for execution
 */
function generateOperationCode(operation: string): string {
  // Array operations with callbacks
  if (
    ["filter", "map", "reduce", "flatMap", "find", "findIndex", "some", "every"].includes(operation)
  ) {
    if (operation === "reduce") {
      return `// Auto-generated placeholder for ${operation}
const input = Object.values(deps)[0]?.output;
// TODO: Extract actual callback from source
return input.${operation}((acc, item) => acc + item, 0);`;
    }
    return `// Auto-generated placeholder for ${operation}
const input = Object.values(deps)[0]?.output;
// TODO: Extract actual callback from source
return input.${operation}(item => item);`;
  }

  // Array operations without callbacks
  if (
    ["sort", "reverse", "slice", "concat", "join", "includes", "indexOf", "lastIndexOf"].includes(
      operation,
    )
  ) {
    return `// Auto-generated placeholder for ${operation}
const input = Object.values(deps)[0]?.output;
return input.${operation}();`;
  }

  // String operations
  if (
    [
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
    ].includes(operation)
  ) {
    return `// Auto-generated placeholder for ${operation}
const input = Object.values(deps)[0]?.output;
return input.${operation}();`;
  }

  // Object operations
  if (operation.startsWith("Object.")) {
    const method = operation.replace("Object.", "");
    return `// Auto-generated for ${operation}
const input = Object.values(deps)[0]?.output;
return Object.${method}(input);`;
  }

  // Math operations
  if (operation.startsWith("Math.")) {
    const method = operation.replace("Math.", "");
    return `// Auto-generated for ${operation}
const input = Object.values(deps)[0]?.output;
return Math.${method}(...input);`;
  }

  // JSON operations
  if (operation.startsWith("JSON.")) {
    const method = operation.replace("JSON.", "");
    if (method === "stringify") {
      return `// Auto-generated for ${operation}
const input = Object.values(deps)[0]?.output;
return JSON.stringify(input, null, 2);`;
    }
    return `// Auto-generated for ${operation}
const input = Object.values(deps)[0]?.output;
return JSON.${method}(input);`;
  }

  // Binary operators
  const binaryOps = [
    "add",
    "subtract",
    "multiply",
    "divide",
    "modulo",
    "power",
    "equal",
    "strictEqual",
    "notEqual",
    "strictNotEqual",
    "lessThan",
    "lessThanOrEqual",
    "greaterThan",
    "greaterThanOrEqual",
    "and",
    "or",
    "bitwiseAnd",
    "bitwiseOr",
    "bitwiseXor",
    "leftShift",
    "rightShift",
    "unsignedRightShift",
  ];

  if (binaryOps.includes(operation)) {
    const operatorMap: Record<string, string> = {
      add: "+",
      subtract: "-",
      multiply: "*",
      divide: "/",
      modulo: "%",
      power: "**",
      equal: "==",
      strictEqual: "===",
      notEqual: "!=",
      strictNotEqual: "!==",
      lessThan: "<",
      lessThanOrEqual: "<=",
      greaterThan: ">",
      greaterThanOrEqual: ">=",
      and: "&&",
      or: "||",
      bitwiseAnd: "&",
      bitwiseOr: "|",
      bitwiseXor: "^",
      leftShift: "<<",
      rightShift: ">>",
      unsignedRightShift: ">>>",
    };

    const operator = operatorMap[operation] || "+";
    return `// Auto-generated for ${operation} (${operator})
const deps_array = Object.values(deps);
const left = deps_array[0]?.output;
const right = deps_array[1]?.output;
return left ${operator} right;`;
  }

  // Fallback for unknown operations
  logger.warn("Unknown code operation, generating fallback", { operation });
  return `// Fallback for unknown operation: ${operation}
const input = Object.values(deps)[0]?.output;
return input;`;
}

/**
 * Add a dependency to the dependency map
 */
function addDependency(
  deps: Map<string, string[]>,
  taskId: string,
  dependsOn: string,
): void {
  if (!deps.has(taskId)) {
    deps.set(taskId, []);
  }
  deps.get(taskId)!.push(dependsOn);
}

/**
 * Check if a static structure is valid for DAG conversion
 *
 * Returns false for empty structures or structures with only
 * non-executable nodes (fork/join without tasks).
 *
 * @param structure StaticStructure to validate
 * @returns true if structure can be converted to a meaningful DAG
 */
export function isValidForDagConversion(structure: StaticStructure): boolean {
  if (!structure || !structure.nodes || structure.nodes.length === 0) {
    return false;
  }

  // Check if there's at least one executable node (task or capability)
  const hasExecutableNode = structure.nodes.some(
    (node) => node.type === "task" || node.type === "capability",
  );

  return hasExecutableNode;
}

/**
 * Get the list of tools that will be executed from a static structure
 *
 * Useful for HIL approval summaries and permission checking.
 *
 * @param structure StaticStructure to analyze
 * @returns List of tool IDs that will be executed
 */
export function getToolsFromStaticStructure(structure: StaticStructure): string[] {
  const tools: string[] = [];

  for (const node of structure.nodes) {
    if (node.type === "task") {
      tools.push(node.tool);
    }
  }

  return tools;
}

/**
 * Estimate parallel execution layers from static structure
 *
 * Analyzes the structure to determine how many parallel execution
 * layers will be created. Useful for progress estimation.
 *
 * @param structure StaticStructure to analyze
 * @returns Estimated number of parallel layers
 */
export function estimateParallelLayers(structure: StaticStructure): number {
  // Simple heuristic: count fork nodes + 1
  const forkCount = structure.nodes.filter((n) => n.type === "fork").length;

  if (forkCount === 0) {
    // Sequential execution: each task is a layer
    const taskCount = structure.nodes.filter(
      (n) => n.type === "task" || n.type === "capability",
    ).length;
    return taskCount;
  }

  // With parallelism: approximate based on fork/join structure
  // Each fork adds potential parallelism
  return Math.max(1, forkCount + 1);
}
