/**
 * Execution Module
 *
 * Execution utilities for sandbox (Phase 2.4 refactor).
 *
 * @module sandbox/execution
 */

export {
  ResultParser,
  resultParser,
  RESULT_MARKER,
  type ParsedOutput,
} from "./result-parser.ts";

export {
  TimeoutHandler,
  type CommandOutput,
} from "./timeout-handler.ts";

export {
  DenoSubprocessRunner,
  type DenoRunnerConfig,
  type SubprocessResult,
} from "./deno-runner.ts";

export {
  WorkerRunner,
  type WorkerRunnerConfig,
  type WorkerExecutionResult,
} from "./worker-runner.ts";
