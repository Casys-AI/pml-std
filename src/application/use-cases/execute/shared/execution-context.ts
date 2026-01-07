/**
 * Execution Context Builder
 *
 * Builds execution context from various inputs.
 * Handles tool discovery, static analysis, and DAG conversion.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module application/use-cases/execute/shared/execution-context
 */

import type { StaticStructure } from "../../../../capabilities/types/mod.ts";
import type { DAGStructure } from "../../../../graphrag/types.ts";
import type { ExecutorToolDefinition } from "../../../../domain/interfaces/code-executor.ts";

/**
 * Execution context with all computed data
 */
export interface ExecutionContextData {
  /** Static structure from code analysis */
  staticStructure: StaticStructure;
  /** Logical DAG (before optimization) */
  logicalDAG?: DAGStructure;
  /** Physical DAG (after optimization) */
  physicalDAG?: DAGStructure;
  /** Tool definitions for sandbox */
  toolDefinitions: ExecutorToolDefinition[];
  /** Whether code can be executed as DAG */
  canExecuteAsDAG: boolean;
  /** Tools discovered in code */
  discoveredTools: string[];
}

/**
 * Input for building execution context
 */
export interface BuildContextInput {
  code: string;
  intent: string;
  timeout?: number;
}

/**
 * Dependencies for context building
 */
export interface ContextBuilderDeps {
  /** Static structure builder */
  buildStaticStructure: (code: string) => Promise<StaticStructure>;
  /** Tool definition builder */
  buildToolDefinitions: (staticStructure: StaticStructure) => Promise<ExecutorToolDefinition[]>;
  /** DAG conversion check */
  isValidForDagConversion: (staticStructure: StaticStructure) => boolean;
  /** Convert to DAG */
  staticStructureToDag: (staticStructure: StaticStructure) => DAGStructure;
  /** Optimize DAG */
  optimizeDAG: (dag: DAGStructure) => DAGStructure;
}

/**
 * Build execution context from code
 *
 * @param input - Build input
 * @param deps - Dependencies
 * @returns Execution context data
 */
export async function buildExecutionContext(
  input: BuildContextInput,
  deps: ContextBuilderDeps,
): Promise<ExecutionContextData> {
  // Step 1: Static analysis via SWC
  const staticStructure = await deps.buildStaticStructure(input.code);

  // Step 2: Build tool definitions
  const toolDefinitions = await deps.buildToolDefinitions(staticStructure);

  // Step 3: Extract discovered tools
  const discoveredTools = staticStructure.nodes
    .filter((n): n is typeof n & { type: "task"; tool: string } => n.type === "task")
    .map((n) => n.tool);

  // Step 4: Check if DAG conversion is possible
  const canExecuteAsDAG = deps.isValidForDagConversion(staticStructure);

  let logicalDAG: DAGStructure | undefined;
  let physicalDAG: DAGStructure | undefined;

  if (canExecuteAsDAG) {
    // Step 5: Convert to logical DAG
    logicalDAG = deps.staticStructureToDag(staticStructure);

    if (logicalDAG.tasks.length > 0) {
      // Step 6: Optimize to physical DAG
      physicalDAG = deps.optimizeDAG(logicalDAG);
    }
  }

  return {
    staticStructure,
    logicalDAG,
    physicalDAG,
    toolDefinitions,
    canExecuteAsDAG: canExecuteAsDAG && (physicalDAG?.tasks.length ?? 0) > 0,
    discoveredTools,
  };
}

/**
 * Extract tools called from execution traces
 *
 * @param traces - Execution traces
 * @returns Array of tool IDs called
 */
export function extractToolsCalled(
  traces: Array<{ type: string; tool?: string }>,
): string[] {
  return traces
    .filter((t) => t.type === "tool_start" && t.tool)
    .map((t) => t.tool!);
}

/**
 * Count tool calls from traces (for loop iteration counting)
 *
 * @param traces - Execution traces
 * @returns Map of tool ID to call count
 */
export function countToolCalls(
  traces: Array<{ type: string; tool?: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const trace of traces) {
    if (trace.type === "tool_start" && trace.tool) {
      const count = counts.get(trace.tool) || 0;
      counts.set(trace.tool, count + 1);
    }
  }

  return counts;
}
