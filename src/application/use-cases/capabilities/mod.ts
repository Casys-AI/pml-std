/**
 * Capability Use Cases
 *
 * Application layer use cases for capability management.
 *
 * @module application/use-cases/capabilities
 */

// Types
export * from "./types.ts";

// Use Cases
export { SearchCapabilitiesUseCase } from "./search-capabilities.ts";
export type {
  CapabilityMatch,
  IDAGSuggester,
} from "./search-capabilities.ts";
