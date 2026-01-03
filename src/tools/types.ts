/**
 * Tool Types
 *
 * Re-exports domain interfaces for MCP tool metadata.
 * Provides IToolStore as backward-compatible alias for IToolRepository.
 *
 * @module tools/types
 */

// Re-export from domain layer (Clean Architecture)
export type { ToolMetadata, IToolRepository } from "../domain/interfaces/tool-repository.ts";

// Backward-compatible alias
import type { IToolRepository } from "../domain/interfaces/tool-repository.ts";
export type IToolStore = IToolRepository;
