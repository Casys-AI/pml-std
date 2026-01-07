/**
 * Infrastructure Patterns
 *
 * Design patterns for clean architecture:
 * - Builder: Fluent object construction
 * - Factory: Centralized object creation
 * - Visitor: Separate algorithms from objects (AST traversal, etc.)
 * - Strategy: Encapsulate algorithms, allow runtime switching
 *
 * @module infrastructure/patterns
 */

// Builder Pattern
export { GatewayBuilder, GatewayBuilderError } from "./builder/mod.ts";
export type { GatewayBuilderState } from "./builder/mod.ts";

// Factory Pattern
export { GatewayFactory } from "./factory/mod.ts";
export type { GatewayDependencies, GatewayFactoryOptions, PIIType } from "./factory/mod.ts";

// Visitor Pattern
export { ASTVisitor, createVisitor } from "./visitor/mod.ts";
export type { ASTNode, DefaultHandler, NodeHandler } from "./visitor/mod.ts";

// Strategy Pattern
export { NullDecisionStrategy } from "./strategy/mod.ts";
export type {
  AILResponseResult,
  DecisionEvent,
  DecisionPreparation,
  IDecisionStrategy,
} from "./strategy/mod.ts";

// Template Method Pattern
export { LayerExecutionTemplate } from "./template-method/mod.ts";
export type { IExecutionEvent, LayerExecutionResult } from "./template-method/mod.ts";
