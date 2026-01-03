/**
 * Tools Module
 *
 * Exports for MCP tool storage and types.
 *
 * @module tools
 */

export { ToolStore } from "./tool-store.ts";
// Re-export from domain layer (canonical source)
export type { IToolRepository, ToolMetadata } from "../domain/interfaces/tool-repository.ts";
// Backward-compatible alias
export type { IToolStore } from "./types.ts";
