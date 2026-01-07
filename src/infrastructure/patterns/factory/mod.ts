/**
 * Factory Pattern Exports
 *
 * @module infrastructure/patterns/factory
 */

export { GatewayFactory } from "./gateway-factory.ts";
export type { GatewayDependencies, GatewayFactoryOptions, PIIType } from "./gateway-factory.ts";

export { AlgorithmFactory } from "./algorithm-factory.ts";
export type {
  AlgorithmCapabilityInput,
  DRDSPCapabilityInput,
  SHGATFactoryOptions,
  SHGATFactoryResult,
} from "./algorithm-factory.ts";
