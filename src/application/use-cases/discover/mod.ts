/**
 * Discover Use Cases Module
 *
 * Use cases for tool and capability discovery.
 *
 * @module application/use-cases/discover
 */

export { DiscoverToolsUseCase, type DiscoverToolsDeps } from "./discover-tools.ts";
export { DiscoverCapabilitiesUseCase, type DiscoverCapabilitiesDeps } from "./discover-capabilities.ts";
export type {
  DiscoverRequest,
  DiscoveredCapability,
  DiscoveredTool,
  DiscoverCapabilitiesResult,
  DiscoverToolsResult,
} from "./types.ts";
