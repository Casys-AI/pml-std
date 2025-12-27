/**
 * Execution Module Exports
 *
 * Re-exports task routing and execution functionality.
 *
 * @module dag/execution
 */

export {
  getTaskType,
  isMCPTool,
  isSafeToFail,
  requiresSandbox,
  type TaskType,
} from "./task-router.ts";

export { type CodeExecutorDeps, executeCodeTask, executeWithRetry } from "./code-executor.ts";

export {
  type CapabilityExecutorDeps,
  executeCapabilityTask,
  getCapabilityPermissionSet,
} from "./capability-executor.ts";

export { resolveDependencies } from "./dependency-resolver.ts";
