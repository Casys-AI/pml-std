/**
 * DAG Optimizer - Two-Level DAG Architecture (Phase 2)
 *
 * Optimizes logical DAGs by fusing sequential code operations into physical tasks.
 * This eliminates variable binding issues while maintaining SHGAT learning granularity.
 *
 * Architecture:
 * - Logical DAG: All operations as separate tasks (SHGAT sees everything)
 * - Physical DAG: Fused tasks for efficient execution (fewer layers)
 * - Trace mapping: Physical results → Logical traces for SHGAT
 *
 * See: docs/tech-specs/modular-dag-execution/two-level-dag-architecture.md
 *
 * @module dag/dag-optimizer
 */

import type { Task, DAGStructure } from "../graphrag/types.ts";
import { getLogger } from "../telemetry/logger.ts";

const log = getLogger("dag-optimizer");

/**
 * Optimized DAG structure with logical-to-physical mapping
 */
export interface OptimizedDAGStructure {
  /** Physical tasks for execution (may be fused) */
  tasks: Task[];

  /** Mapping from logical task IDs to physical task IDs */
  logicalToPhysical: Map<string, string>;

  /** Mapping from physical task IDs to logical task IDs */
  physicalToLogical: Map<string, string[]>;

  /** Original logical DAG for trace generation */
  logicalDAG: DAGStructure;
}

/**
 * Configuration for DAG optimization
 */
export interface OptimizationConfig {
  /** Enable fusion optimization (default: true) */
  enabled?: boolean;

  /** Maximum number of tasks to fuse together (default: 10) */
  maxFusionSize?: number;

  /** Strategy: "sequential" (Phase 2a) or "full" (Phase 2b+) */
  strategy?: "sequential" | "full";
}

/**
 * Optimize a logical DAG by fusing sequential code operations
 *
 * Phase 2a: Only fuses simple sequential chains (A→B→C)
 * Phase 2b+: Handles fork-join, partial fusion, etc.
 *
 * @param logicalDAG DAG with all operations as separate tasks
 * @param config Optimization configuration
 * @returns Optimized DAG with fused physical tasks
 */
export function optimizeDAG(
  logicalDAG: DAGStructure,
  config: OptimizationConfig = {}
): OptimizedDAGStructure {
  const {
    enabled = true,
    maxFusionSize = 10,
    strategy = "sequential"
  } = config;

  if (!enabled) {
    log.debug("Optimization disabled, returning logical DAG as-is");
    return {
      tasks: logicalDAG.tasks,
      logicalToPhysical: new Map(logicalDAG.tasks.map(t => [t.id, t.id])),
      physicalToLogical: new Map(logicalDAG.tasks.map(t => [t.id, [t.id]])),
      logicalDAG
    };
  }

  log.debug("Optimizing DAG", {
    logicalTaskCount: logicalDAG.tasks.length,
    strategy
  });

  // Phase 2a: Sequential fusion only
  if (strategy === "sequential") {
    return optimizeSequential(logicalDAG, maxFusionSize);
  }

  // Phase 2b+: Full optimization (not implemented yet)
  throw new Error(`Optimization strategy "${strategy}" not implemented yet`);
}

/**
 * Optimize DAG using sequential fusion strategy
 *
 * Finds chains of sequential code tasks and fuses them:
 * - MCP tasks stay separate (side effects)
 * - Code tasks in sequence get fused
 * - Maintains dependencies correctly
 */
function optimizeSequential(
  logicalDAG: DAGStructure,
  maxFusionSize: number
): OptimizedDAGStructure {
  const physicalTasks: Task[] = [];
  const logicalToPhysical = new Map<string, string>();
  const physicalToLogical = new Map<string, string[]>();
  const processed = new Set<string>();

  for (const task of logicalDAG.tasks) {
    if (processed.has(task.id)) continue;

    // If it's an MCP task, keep as-is
    if (task.type === "mcp_tool") {
      physicalTasks.push(task);
      logicalToPhysical.set(task.id, task.id);
      physicalToLogical.set(task.id, [task.id]);
      processed.add(task.id);
      continue;
    }

    // If it's a code task, try to find a fusible chain
    if (task.type === "code_execution" && task.tool?.startsWith("code:")) {
      const chain = findSequentialChain(task, logicalDAG, processed, maxFusionSize);

      if (chain.length > 1 && canFuseTasks(chain)) {
        // Fuse the chain
        const fusedTask = fuseTasks(chain);
        physicalTasks.push(fusedTask);

        // Update mappings
        for (const chainTask of chain) {
          logicalToPhysical.set(chainTask.id, fusedTask.id);
          processed.add(chainTask.id);
        }
        physicalToLogical.set(fusedTask.id, chain.map(t => t.id));

        log.debug("Fused task chain", {
          fusedTaskId: fusedTask.id,
          logicalTasks: chain.map(t => t.id),
          operations: chain.map(t => t.tool)
        });
      } else {
        // Keep as-is (single task or can't fuse)
        physicalTasks.push(task);
        logicalToPhysical.set(task.id, task.id);
        physicalToLogical.set(task.id, [task.id]);
        processed.add(task.id);
      }
    } else {
      // Other task types (capability, etc.) - keep as-is
      physicalTasks.push(task);
      logicalToPhysical.set(task.id, task.id);
      physicalToLogical.set(task.id, [task.id]);
      processed.add(task.id);
    }
  }

  log.info("DAG optimization complete", {
    logicalTasks: logicalDAG.tasks.length,
    physicalTasks: physicalTasks.length,
    fusionRate: Math.round((1 - physicalTasks.length / logicalDAG.tasks.length) * 100)
  });

  return {
    tasks: physicalTasks,
    logicalToPhysical,
    physicalToLogical,
    logicalDAG
  };
}

/**
 * Find a sequential chain of code tasks starting from a given task
 *
 * A chain is sequential if each task depends only on the previous task.
 */
function findSequentialChain(
  startTask: Task,
  dag: DAGStructure,
  processed: Set<string>,
  maxSize: number
): Task[] {
  const chain: Task[] = [startTask];
  let currentTask = startTask;

  while (chain.length < maxSize) {
    // Find tasks that depend ONLY on the current task
    const nextCandidates = dag.tasks.filter(t =>
      !processed.has(t.id) &&
      t.id !== currentTask.id &&
      t.type === "code_execution" &&
      t.tool?.startsWith("code:") &&
      t.dependsOn.length === 1 &&
      t.dependsOn[0] === currentTask.id
    );

    if (nextCandidates.length !== 1) {
      // Either no next task, or multiple tasks depend on current (fork)
      break;
    }

    const nextTask = nextCandidates[0];

    // Check if any other task depends on the current task
    const otherDependents = dag.tasks.filter(t =>
      t.id !== nextTask.id &&
      t.dependsOn.includes(currentTask.id)
    );

    if (otherDependents.length > 0) {
      // Current task has multiple dependents (fork point)
      break;
    }

    chain.push(nextTask);
    currentTask = nextTask;
  }

  return chain;
}

/**
 * Check if a group of tasks can be fused together
 *
 * Fusion rules:
 * 1. All tasks must be code_execution
 * 2. All tasks must be pure operations (no side effects)
 * 3. All tasks must have same permission set
 * 4. No MCP calls in the code
 */
export function canFuseTasks(tasks: Task[]): boolean {
  if (tasks.length === 0) return false;

  // Rule 1: All must be code_execution
  if (!tasks.every(t => t.type === "code_execution")) {
    return false;
  }

  // Rule 2: No MCP calls in code (side effects)
  for (const task of tasks) {
    if (task.code?.includes("mcp.")) {
      return false;
    }
  }

  // Single task passes basic checks - can be part of a fusion
  if (tasks.length === 1) return true;

  // Rule 3: All must be pure operations (Phase 2a: checked via metadata)
  // For multi-task fusion, we require explicit pure marking
  if (!tasks.every(t => t.metadata?.pure === true)) {
    return false;
  }

  // Rule 4: Same permission set
  const permSets = tasks.map(t => t.sandboxConfig?.permissionSet ?? "minimal");
  if (new Set(permSets).size > 1) {
    return false;
  }

  return true;
}

/**
 * Fuse multiple tasks into a single physical task
 *
 * Generates fused code by combining all task codes sequentially.
 * Uses the original extracted code from SWC spans.
 */
export function fuseTasks(tasks: Task[]): Task {
  if (tasks.length === 0) {
    throw new Error("Cannot fuse empty task list");
  }

  if (tasks.length === 1) {
    return tasks[0];
  }

  log.debug("Fusing tasks", {
    taskIds: tasks.map(t => t.id),
    operations: tasks.map(t => t.tool)
  });

  // Collect external dependencies (dependencies outside the fused group)
  const taskIds = new Set(tasks.map(t => t.id));
  const externalDeps = new Set<string>();

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        externalDeps.add(dep);
      }
    }
  }

  // Generate fused code
  const fusedCode = generateFusedCode(tasks);

  // Create fused task
  const fusedTask: Task = {
    id: `fused_${tasks[0].id}`,
    type: "code_execution",
    tool: "code:computation", // Generic pseudo-tool for fused tasks
    code: fusedCode,
    arguments: {},
    dependsOn: Array.from(externalDeps),
    sandboxConfig: tasks[0].sandboxConfig,
    metadata: {
      fusedFrom: tasks.map(t => t.id),
      logicalTools: tasks.map(t => t.tool!),
      pure: true
    },
    // Preserve variable bindings from first task (for MCP dependencies)
    variableBindings: tasks[0].variableBindings
  };

  return fusedTask;
}

/**
 * Generate fused code from multiple tasks
 *
 * Phase 2a (simple): Concatenate code blocks
 * Phase 2b+ (advanced): Smart variable renaming, deps.task_X.output substitution
 */
function generateFusedCode(tasks: Task[]): string {
  const codeBlocks: string[] = [];

  for (const task of tasks) {
    if (!task.code) {
      log.warn("Task missing code, skipping in fusion", { taskId: task.id });
      continue;
    }

    // For now, just use the original code as-is
    // Phase 2b+ will add smart variable substitution
    codeBlocks.push(task.code);
  }

  // Join with newlines and return last result
  const fusedCode = codeBlocks.join('\n');

  // Wrap in function that returns the last expression result
  return `
// Fused code from ${tasks.length} operations
${fusedCode}
`.trim();
}
