/**
 * DAG Suggester Interface
 *
 * Defines the contract for generating workflow suggestions.
 * Uses SHGAT for scoring and DR-DSP for path construction.
 *
 * Phase 3.1: Execute Handler → Use Cases refactoring
 *
 * @module domain/interfaces/dag-suggester
 */

/**
 * Suggested task in a DAG
 */
export interface SuggestedDAGTask {
  id: string;
  /** Call name for invocation (e.g., "fs:read" or "math:sum") */
  callName: string;
  /** Whether this is a tool or capability */
  type: "tool" | "capability";
  /** JSON Schema for input parameters */
  inputSchema?: unknown;
  /** Task IDs this depends on */
  dependsOn: string[];
}

/**
 * Suggested DAG structure
 */
export interface DAGSuggestion {
  tasks: SuggestedDAGTask[];
}

/**
 * Capability match from SHGAT scoring
 */
export interface CapabilityMatch {
  capabilityId: string;
  score: number;
  /** Per-head attention scores (SHGAT K-head) */
  headScores?: number[];
  headWeights?: number[];
  recursiveContribution?: number;
  featureContributions?: {
    semantic?: number;
    structure?: number;
    temporal?: number;
    reliability?: number;
  };
}

/**
 * Result of suggestion generation
 */
export interface SuggestionResult {
  /** Suggested workflow DAG */
  suggestedDag?: DAGSuggestion;
  /** Confidence score from SHGAT (0-1) */
  confidence: number;
  /** Best capability match (if any) */
  bestMatch?: CapabilityMatch;
  /** Whether speculation can be used (high confidence) */
  canSpeculate?: boolean;
}

/**
 * Interface for DAG suggestion generation
 *
 * This interface abstracts the SHGAT + DR-DSP suggestion pipeline,
 * allowing for different implementations and easy mocking in tests.
 */
export interface IDAGSuggester {
  /**
   * Generate DAG suggestion from natural language intent
   *
   * @param intent - Natural language description
   * @param correlationId - Optional correlation ID for tracing
   * @returns Suggestion result with DAG and confidence
   */
  suggest(intent: string, correlationId?: string): Promise<SuggestionResult>;

  /**
   * Score all capabilities for an intent (raw SHGAT scoring)
   *
   * @param intentEmbedding - Pre-computed intent embedding
   * @returns Sorted capability matches
   */
  scoreCapabilities?(intentEmbedding: number[]): CapabilityMatch[];
}
