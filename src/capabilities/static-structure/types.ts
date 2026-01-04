/**
 * Static Structure Builder Types
 *
 * Internal types used by the static structure builder modules.
 *
 * @module capabilities/static-structure/types
 */

import type { ArgumentsStructure, JsonValue } from "../types.ts";

/**
 * Tool schema from database for provides edge calculation
 */
export interface ToolSchema {
  toolId: string;
  inputSchema: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  outputSchema?: {
    properties?: Record<string, unknown>;
  };
}

/**
 * Metadata for Option B: executable tracking
 */
export interface NodeMetadata {
  /** Whether this task is executable standalone (false if nested in callback) */
  executable?: boolean;
  /** Nesting level: 0 = top-level, 1+ = inside callback */
  nestingLevel?: number;
  /** Parent operation that contains this nested op (e.g., "code:map") */
  parentOperation?: string;
  /** Story 10.2c: Node ID of the chained input (for method chaining) */
  chainedFrom?: string;
}

/**
 * Internal node representation for AST traversal and edge generation
 *
 * This type extends StaticStructureNode with position information needed
 * during the analysis phase. The position field tracks AST traversal order
 * for generating sequence edges, and parentScope tracks containment for
 * conditional branches and parallel blocks.
 *
 * Uses TypeScript discriminated union pattern:
 * - `type: "task"` → MCP tool call with `tool` field (e.g., "filesystem:read_file")
 * - `type: "decision"` → Control flow (if/switch/ternary) with `condition` string
 * - `type: "capability"` → Nested capability call with `capabilityId` field
 * - `type: "fork"` → Start of Promise.all/allSettled parallel block
 * - `type: "join"` → End of parallel block
 *
 * @internal This type is not exported - use StaticStructureNode for external APIs
 */
/**
 * Loop type enumeration for SHGAT semantic understanding
 */
export type LoopType = "for" | "while" | "forOf" | "forIn" | "doWhile";

export type InternalNode =
  & {
    /** Unique node identifier (e.g., "n1", "d1", "f1", "l1") */
    id: string;
    /** AST traversal position for ordering sequence edges */
    position: number;
    /** Parent scope for conditional/parallel containment (e.g., "d1:true", "f1", "l1") */
    parentScope?: string;
    /** Option B: Execution metadata for nested operation tracking */
    metadata?: NodeMetadata;
  }
  & (
    | { type: "task"; tool: string; arguments?: ArgumentsStructure; code?: string }
    | { type: "decision"; condition: string }
    | { type: "capability"; capabilityId: string }
    | { type: "fork" }
    | { type: "join" }
    | { type: "loop"; condition: string; loopType: LoopType; code?: string }
  );

/**
 * Node counters for generating unique IDs
 */
export interface NodeCounters {
  task: number;
  decision: number;
  capability: number;
  fork: number;
  join: number;
  loop: number;
}

/**
 * Context passed to handler functions
 */
export interface HandlerContext {
  /** Generated nodes during analysis */
  nodes: InternalNode[];
  /** Current position counter */
  position: number;
  /** Current parent scope (for conditionals/forks) */
  parentScope?: string;
  /** Current nesting level for callbacks */
  nestingLevel: number;
  /** Parent operation for nested ops */
  parentOperation?: string;
}

/**
 * Shared state for the builder
 */
export interface BuilderState {
  /** Counter for generating unique node IDs */
  nodeCounters: NodeCounters;
  /** Maps variable names to node IDs */
  variableToNodeId: Map<string, string>;
  /** Maps variable names to literal values */
  literalBindings: Map<string, JsonValue>;
  /** Tracks processed CallExpression spans to prevent double-processing */
  processedSpans: Map<string, string>;
  /** Original source code for span extraction */
  originalCode: string;
  /** SWC span base offset */
  spanBaseOffset: number;
}
