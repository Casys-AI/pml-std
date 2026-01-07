/**
 * Template Method Pattern Exports
 *
 * Abstract templates defining algorithm skeletons.
 * Concrete implementations provide specific steps.
 *
 * @module infrastructure/patterns/template-method
 */

export {
  LayerExecutionTemplate,
  type IExecutionEvent,
  type LayerExecutionResult,
} from "./layer-execution-template.ts";
