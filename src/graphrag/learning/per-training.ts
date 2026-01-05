/**
 * PER Training - SHGAT Training with Prioritized Experience Replay (Story 11.6)
 *
 * Implements path-level SHGAT training using PER-weighted sampling from execution_trace.
 * Part of the TD + PER + SHGAT architecture (style DQN/Rainbow).
 *
 * Flow:
 * 1. Sample traces weighted by priority (PER - Schaul et al. 2015)
 * 2. Flatten hierarchical paths (meta → cap → tools)
 * 3. Generate multi-example per trace (one per node in path)
 * 4. Train SHGAT batch
 * 5. Update trace priorities (TD error recalculated)
 *
 * @module graphrag/learning/per-training
 */

import type { SHGAT, TrainingExample } from "../algorithms/shgat.ts";
import type { ExecutionTraceStore } from "../../capabilities/execution-trace-store.ts";
import type { ExecutionTrace } from "../../capabilities/types.ts";
import {
  batchUpdatePrioritiesFromTDErrors,
  type EmbeddingProvider,
} from "../../capabilities/per-priority.ts";
import { extractPathLevelFeatures, type PathLevelFeatures } from "./path-level-features.ts";
import { spawnSHGATTraining } from "../algorithms/shgat/spawn-training.ts";
import { getLogger } from "../../telemetry/logger.ts";

const log = getLogger("default");

// ============================================================================
// Constants
// ============================================================================

/** Default minimum traces required for path-level training */
export const DEFAULT_MIN_TRACES = 20;

/** Default maximum traces to process per batch */
export const DEFAULT_MAX_TRACES = 100;

/** Default batch size for SHGAT training */
export const DEFAULT_BATCH_SIZE = 32;

/** Default minimum priority to consider (skip near-zero) */
export const DEFAULT_MIN_PRIORITY = 0.1;

/** Default PER alpha exponent */
export const DEFAULT_PER_ALPHA = 0.6;

// ============================================================================
// Types
// ============================================================================

/**
 * Options for PER-based SHGAT training
 */
export interface PERTrainingOptions {
  /** Minimum traces required to trigger path-level training (default: 20) */
  minTraces?: number;
  /** Maximum traces to process (default: 100) */
  maxTraces?: number;
  /** Batch size for SHGAT.trainBatch() (default: 32) */
  batchSize?: number;
  /** Minimum priority threshold (default: 0.1) */
  minPriority?: number;
  /** PER alpha exponent (default: 0.6) */
  alpha?: number;
  /** Capability ID to filter traces (optional, all if not provided) */
  capabilityId?: string;
}

/**
 * Result of PER-based training
 */
export interface PERTrainingResult {
  /** Average loss across batches */
  loss: number;
  /** Accuracy (correct predictions / total) */
  accuracy: number;
  /** Number of traces processed */
  tracesProcessed: number;
  /** Number of high priority traces (> 0.7) */
  highPriorityCount: number;
  /** Number of trace priorities updated after training */
  prioritiesUpdated: number;
  /** Total training examples generated (multi-example per trace) */
  examplesGenerated: number;
  /** Whether fallback to tool-level was triggered */
  fallback?: "tool-level";
  /** Reason for fallback if triggered */
  fallbackReason?: string;
}

// ============================================================================
// Main Training Function
// ============================================================================

/**
 * Train SHGAT on path-level traces with PER sampling
 *
 * This is the main entry point for Story 11.6 training.
 *
 * 1. Samples traces using PER (priority^α weighting)
 * 2. Flattens hierarchical paths
 * 3. Generates multi-example per trace
 * 4. Trains SHGAT in batches
 * 5. Updates trace priorities post-training
 *
 * @param shgat - SHGAT instance to train
 * @param traceStore - ExecutionTraceStore for fetching/updating traces
 * @param embeddingProvider - Provider for intent embeddings
 * @param options - Training configuration
 * @returns Training results with metrics
 *
 * @example
 * ```typescript
 * const result = await trainSHGATOnPathTraces(
 *   shgat,
 *   traceStore,
 *   embeddingModel,
 *   { minTraces: 20, maxTraces: 100 }
 * );
 *
 * if (result.fallback) {
 *   console.log("Insufficient traces, using tool-level training");
 * }
 * ```
 */
export async function trainSHGATOnPathTraces(
  shgat: SHGAT,
  traceStore: ExecutionTraceStore,
  _embeddingProvider: EmbeddingProvider, // Unused since migration 030 (embeddings from JOIN)
  options: PERTrainingOptions = {},
): Promise<PERTrainingResult> {
  const {
    minTraces = DEFAULT_MIN_TRACES,
    maxTraces = DEFAULT_MAX_TRACES,
    batchSize = DEFAULT_BATCH_SIZE,
    minPriority = DEFAULT_MIN_PRIORITY,
    alpha = DEFAULT_PER_ALPHA,
    capabilityId,
  } = options;

  const startTime = performance.now();

  // Step 1: Check trace availability
  const traceCount = await traceStore.getTraceCount(capabilityId);

  if (traceCount < minTraces) {
    log.debug("[PER-Training] Insufficient traces for path-level training", {
      available: traceCount,
      required: minTraces,
    });
    return {
      loss: 0,
      accuracy: 0,
      tracesProcessed: 0,
      highPriorityCount: 0,
      prioritiesUpdated: 0,
      examplesGenerated: 0,
      fallback: "tool-level",
      fallbackReason: `insufficient traces (${traceCount} < ${minTraces})`,
    };
  }

  // Step 2: Sample traces using PER
  const traces = await traceStore.sampleByPriority(maxTraces, minPriority, alpha);

  if (traces.length === 0) {
    log.debug("[PER-Training] No traces sampled (all below minPriority)", { minPriority });
    return {
      loss: 0,
      accuracy: 0,
      tracesProcessed: 0,
      highPriorityCount: 0,
      prioritiesUpdated: 0,
      examplesGenerated: 0,
      fallback: "tool-level",
      fallbackReason: "no traces above minPriority threshold",
    };
  }

  // Step 3: Extract path-level features
  const pathFeatures = extractPathLevelFeatures(traces);

  // Step 4: Get ALL embeddings (capabilities + tools) for RANDOM negative mining
  const graphBuilder = (shgat as unknown as { graphBuilder: {
    getCapabilityNodes: () => Map<string, { embedding: number[] }>;
    getToolNodes: () => Map<string, { embedding: number[] }>;
  } }).graphBuilder;

  const allEmbeddings = new Map<string, number[]>();

  // Add capability embeddings
  for (const [capId, cap] of graphBuilder.getCapabilityNodes()) {
    if (cap.embedding) allEmbeddings.set(capId, cap.embedding);
  }

  // Add tool embeddings
  for (const [toolId, tool] of graphBuilder.getToolNodes()) {
    if (tool.embedding) allEmbeddings.set(toolId, tool.embedding);
  }

  // Step 5: Flatten paths and generate training examples
  const allExamples: TrainingExample[] = [];
  // Track which examples belong to which trace (for TD error aggregation)
  const exampleToTraceId: string[] = [];

  // Note: Since migration 030, intentEmbedding comes from capability via JOIN.
  // No need to regenerate embeddings - use trace.intentEmbedding directly.
  // This ensures perfect consistency when capabilities are renamed.

  // Generate examples for each trace
  for (const trace of traces) {
    // Use intentEmbedding from JOIN (comes from workflow_pattern.intent_embedding)
    const intentEmbedding = trace.intentEmbedding;
    if (!intentEmbedding || intentEmbedding.length === 0) {
      log.debug("[PER-Training] Skipping trace without intent embedding", {
        traceId: trace.id,
        capabilityId: trace.capabilityId,
      });
      continue;
    }

    // Flatten hierarchical path
    const flatPath = await flattenExecutedPath(trace, traceStore);

    // Generate multi-example (one per node) with RANDOM negative mining
    const examples = traceToTrainingExamples(trace, flatPath, intentEmbedding, pathFeatures, allEmbeddings);
    for (const _ex of examples) {
      exampleToTraceId.push(trace.id);
    }
    allExamples.push(...examples);
  }

  if (allExamples.length === 0) {
    log.warn("[PER-Training] No training examples generated");
    return {
      loss: 0,
      accuracy: 0,
      tracesProcessed: traces.length,
      highPriorityCount: traces.filter((t) => t.priority > 0.7).length,
      prioritiesUpdated: 0,
      examplesGenerated: 0,
      fallback: "tool-level",
      fallbackReason: "no valid training examples could be generated",
    };
  }

  // Step 5: Train SHGAT in batches with IS weights
  let totalLoss = 0;
  let totalAccuracy = 0;
  let batchCount = 0;
  const allTdErrors: number[] = [];

  // Compute IS weights for PER (Schaul et al. 2015)
  // P(i) ∝ priority^alpha, weight = (N * P(i))^(-beta) / max_weight
  const beta = 0.4; // IS exponent (anneals to 1.0 over training)
  const tracePriorities = traces.map((t) => Math.pow(t.priority + 1e-6, alpha));
  const totalPriority = tracePriorities.reduce((a, b) => a + b, 0);
  const probs = tracePriorities.map((p) => p / totalPriority);
  const minProb = Math.min(...probs);
  const maxWeight = Math.pow(traces.length * minProb, -beta);
  const traceWeights = probs.map((p) => Math.pow(traces.length * p, -beta) / maxWeight);

  // Map trace index to example indices (multi-example per trace)
  const exampleWeights: number[] = [];
  for (let t = 0; t < traces.length; t++) {
    const numExamplesFromTrace = traces[t].executedPath?.length ?? 0;
    for (let e = 0; e < numExamplesFromTrace; e++) {
      exampleWeights.push(traceWeights[t]);
    }
  }

  for (let i = 0; i < allExamples.length; i += batchSize) {
    const batch = allExamples.slice(i, i + batchSize);
    const batchWeights = exampleWeights.slice(i, i + batchSize);
    const result = shgat.trainBatch(batch, batchWeights);
    totalLoss += result.loss;
    totalAccuracy += result.accuracy;
    allTdErrors.push(...result.tdErrors);
    batchCount++;
  }

  const avgLoss = batchCount > 0 ? totalLoss / batchCount : 0;
  const avgAccuracy = batchCount > 0 ? totalAccuracy / batchCount : 0;

  // Step 6: Aggregate TD errors per trace and update priorities
  // Use max |TD error| per trace as priority (surprising = high priority)
  const tdErrorsPerTrace = new Map<string, number>();
  for (let i = 0; i < allTdErrors.length; i++) {
    const traceId = exampleToTraceId[i];
    if (!traceId) continue;
    const absError = Math.abs(allTdErrors[i]);
    const current = tdErrorsPerTrace.get(traceId) ?? 0;
    if (absError > current) {
      tdErrorsPerTrace.set(traceId, absError);
    }
  }

  // Update priorities using pre-computed TD errors (no recalculation needed)
  const prioritiesUpdated = await batchUpdatePrioritiesFromTDErrors(
    traceStore,
    traces,
    tdErrorsPerTrace,
  );

  const elapsed = performance.now() - startTime;

  log.info("[PER-Training] Training completed", {
    tracesProcessed: traces.length,
    examplesGenerated: allExamples.length,
    batches: batchCount,
    avgLoss: avgLoss.toFixed(4),
    avgAccuracy: avgAccuracy.toFixed(4),
    prioritiesUpdated,
    elapsedMs: elapsed.toFixed(1),
  });

  return {
    loss: avgLoss,
    accuracy: avgAccuracy,
    tracesProcessed: traces.length,
    highPriorityCount: traces.filter((t) => t.priority > 0.7).length,
    prioritiesUpdated,
    examplesGenerated: allExamples.length,
  };
}

// ============================================================================
// Path Flattening (AC13)
// ============================================================================

/**
 * Flatten a hierarchical execution path
 *
 * Recursively expands capabilities in the path to their underlying tools/sub-capabilities.
 * Ensures consistency with SHGAT.collectTransitiveTools() incidence matrix flattening.
 *
 * @param trace - The execution trace to flatten
 * @param traceStore - Store to look up child traces
 * @returns Flattened path with all nested nodes expanded
 *
 * @example
 * ```typescript
 * // Trace: meta_cap → [cap_A, cap_B]
 * //   └── cap_A → [fs:read, json:parse]
 * //   └── cap_B → [slack:send]
 * //
 * // Result: ["meta_cap", "cap_A", "fs:read", "json:parse", "cap_B", "slack:send"]
 * ```
 */
export async function flattenExecutedPath(
  trace: ExecutionTrace,
  traceStore: ExecutionTraceStore,
): Promise<string[]> {
  const executedPath = trace.executedPath ?? [];

  if (executedPath.length === 0) {
    return [];
  }

  // Get child traces for this trace
  const childTraces = await traceStore.getChildTraces(trace.id);

  if (childTraces.length === 0) {
    // No children, return as-is
    return executedPath;
  }

  // Build a map of capability ID → child trace for efficient lookup
  const childTraceMap = new Map<string, ExecutionTrace>();
  for (const child of childTraces) {
    if (child.capabilityId) {
      childTraceMap.set(child.capabilityId, child);
    }
  }

  // Flatten path by expanding each node
  const flatPath: string[] = [];

  for (const nodeId of executedPath) {
    // Add the node itself
    flatPath.push(nodeId);

    // Check if this node has a child trace (nested capability)
    const childTrace = childTraceMap.get(nodeId);
    if (childTrace) {
      // Recursively flatten child
      const childFlat = await flattenExecutedPath(childTrace, traceStore);
      flatPath.push(...childFlat);
    }
  }

  return flatPath;
}

// ============================================================================
// Multi-Example Generation (AC11)
// ============================================================================

/**
 * Convert a trace to multiple training examples (one per node in path)
 *
 * This fixes the "dead contextTools" issue by creating examples where:
 * - contextTools = nodes executed BEFORE this point
 * - candidateId = current node
 *
 * This enables SHGAT to learn sequential dependencies.
 *
 * @param trace - The execution trace
 * @param flatPath - Flattened path (from flattenExecutedPath)
 * @param intentEmbedding - Pre-computed intent embedding
 * @param pathFeatures - Path-level features map
 * @returns Array of training examples
 *
 * @example
 * ```typescript
 * // Path: ["fs:read", "json:parse", "slack:send"]
 * // Generates 3 examples:
 * // 1. contextTools=[], candidateId="fs:read"
 * // 2. contextTools=["fs:read"], candidateId="json:parse"
 * // 3. contextTools=["fs:read", "json:parse"], candidateId="slack:send"
 * ```
 */
export function traceToTrainingExamples(
  trace: ExecutionTrace,
  flatPath: string[],
  intentEmbedding: number[],
  pathFeatures: Map<string, PathLevelFeatures>,
  capEmbeddings?: Map<string, number[]>, // Optional: for RANDOM negative mining
): TrainingExample[] {
  if (flatPath.length === 0) {
    return [];
  }

  const examples: TrainingExample[] = [];
  const outcome = trace.success ? 1 : 0;

  // Get path-level features for weighting (optional enhancement)
  const pathKey = flatPath.join("->");
  const features = pathFeatures.get(pathKey);

  // Apply outcome weighting based on path features
  // Dominant paths with high success rates have stronger positive signal
  let adjustedOutcome = outcome;
  if (features) {
    // Weight by path success rate: reinforce successful paths more
    const weight = features.pathSuccessRate;
    adjustedOutcome = outcome * (0.5 + 0.5 * weight);
  }

  const NUM_NEGATIVES = 4;

  // Pre-compute RANDOM negatives for the whole trace (same intent for all examples)
  // Random negatives provide varied difficulty levels for learning
  // (Hard negatives were too similar - all ~0.9 cosine - causing 51% accuracy)
  let randomNegativeCapIds: string[] | undefined;
  if (capEmbeddings && capEmbeddings.size > NUM_NEGATIVES) {
    // RANDOM NEGATIVE SAMPLING: Select random capabilities (excluding executed path)
    const candidateIds: string[] = [];
    for (const [capId] of capEmbeddings) {
      // Exclude all nodes in the executed path
      if (flatPath.includes(capId)) continue;
      candidateIds.push(capId);
    }

    // Fisher-Yates shuffle and take first NUM_NEGATIVES
    for (let i = candidateIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidateIds[i], candidateIds[j]] = [candidateIds[j], candidateIds[i]];
    }
    randomNegativeCapIds = candidateIds.slice(0, NUM_NEGATIVES);
  }

  // Generate one example per node in the path
  for (let i = 0; i < flatPath.length; i++) {
    const candidateId = flatPath[i];

    examples.push({
      intentEmbedding,
      contextTools: flatPath.slice(0, i), // Nodes before this point
      candidateId,
      outcome: adjustedOutcome,
      negativeCapIds: randomNegativeCapIds,
    });
  }

  return examples;
}

// ============================================================================
// Training Trigger Logic
// ============================================================================

/**
 * Execution counter for periodic batch training
 */
let executionCounter = 0;

/**
 * Check if batch training should run
 *
 * @param interval - Run every N executions (default: 10)
 * @param force - Force run regardless of counter
 * @returns Whether to run batch training
 */
export function shouldRunBatchTraining(interval = 10, force = false): boolean {
  executionCounter++;
  return force || executionCounter % interval === 0;
}

/**
 * Reset execution counter (for testing)
 */
export function resetExecutionCounter(): void {
  executionCounter = 0;
}

/**
 * Get current execution count (for testing/debugging)
 */
export function getExecutionCount(): number {
  return executionCounter;
}

// ============================================================================
// Subprocess PER Training
// ============================================================================

/**
 * Capability data needed for subprocess training
 */
interface CapabilityForTraining {
  id: string;
  embedding: number[];
  toolsUsed: string[];
  successRate: number;
}

/**
 * Options for subprocess PER training
 */
export interface SubprocessPEROptions extends PERTrainingOptions {
  /** Capabilities with embeddings for SHGAT initialization */
  capabilities: CapabilityForTraining[];
  /** Number of epochs (default: 1 for live, 3-5 for batch) */
  epochs?: number;
}

/**
 * Train SHGAT on path traces using subprocess (non-blocking)
 *
 * Same algorithm as trainSHGATOnPathTraces but runs training in subprocess.
 * Uses TD errors from subprocess to update priorities.
 *
 * @param shgat - SHGAT instance (will import returned params)
 * @param traceStore - ExecutionTraceStore for traces and priority updates
 * @param embeddingProvider - Provider for intent embeddings
 * @param options - Training options including capabilities
 * @returns Training results with metrics
 */
export async function trainSHGATOnPathTracesSubprocess(
  shgat: SHGAT,
  traceStore: ExecutionTraceStore,
  _embeddingProvider: EmbeddingProvider, // Unused since migration 030 (embeddings from JOIN)
  options: SubprocessPEROptions,
): Promise<PERTrainingResult> {
  const {
    minTraces = DEFAULT_MIN_TRACES,
    maxTraces = DEFAULT_MAX_TRACES,
    batchSize = DEFAULT_BATCH_SIZE,
    minPriority = DEFAULT_MIN_PRIORITY,
    alpha = DEFAULT_PER_ALPHA,
    capabilityId,
    capabilities,
    epochs = 1,
  } = options;

  const startTime = performance.now();

  // Step 1: Check trace availability
  const traceCount = await traceStore.getTraceCount(capabilityId);

  if (traceCount < minTraces) {
    log.debug("[PER-Subprocess] Insufficient traces", {
      available: traceCount,
      required: minTraces,
    });
    return {
      loss: 0,
      accuracy: 0,
      tracesProcessed: 0,
      highPriorityCount: 0,
      prioritiesUpdated: 0,
      examplesGenerated: 0,
      fallback: "tool-level",
      fallbackReason: `insufficient traces (${traceCount} < ${minTraces})`,
    };
  }

  // Step 2: Sample traces using PER
  const traces = await traceStore.sampleByPriority(maxTraces, minPriority, alpha);

  if (traces.length === 0) {
    log.debug("[PER-Subprocess] No traces sampled", { minPriority });
    return {
      loss: 0,
      accuracy: 0,
      tracesProcessed: 0,
      highPriorityCount: 0,
      prioritiesUpdated: 0,
      examplesGenerated: 0,
      fallback: "tool-level",
      fallbackReason: "no traces above minPriority threshold",
    };
  }

  // Step 3: Extract path-level features
  const pathFeatures = extractPathLevelFeatures(traces);

  // Step 4: Get ALL embeddings (capabilities + tools) for RANDOM negative mining
  const allEmbeddings = new Map<string, number[]>();

  // Add capability embeddings from options
  for (const cap of capabilities) {
    if (cap.embedding) allEmbeddings.set(cap.id, cap.embedding);
  }

  // Add tool embeddings from SHGAT graphBuilder
  const graphBuilder = (shgat as unknown as { graphBuilder: {
    getToolNodes: () => Map<string, { embedding: number[] }>;
  } }).graphBuilder;

  for (const [toolId, tool] of graphBuilder.getToolNodes()) {
    if (tool.embedding) allEmbeddings.set(toolId, tool.embedding);
  }

  // Step 5: Generate training examples
  const allExamples: TrainingExample[] = [];
  const exampleToTraceId: string[] = [];

  // Note: Since migration 030, intentEmbedding comes from capability via JOIN.
  // No need to regenerate embeddings - use trace.intentEmbedding directly.

  // Generate examples for each trace
  for (const trace of traces) {
    // Use intentEmbedding from JOIN (comes from workflow_pattern.intent_embedding)
    const intentEmbedding = trace.intentEmbedding;
    if (!intentEmbedding || intentEmbedding.length === 0) {
      log.debug("[PER-Subprocess] Skipping trace without intent embedding", {
        traceId: trace.id,
        capabilityId: trace.capabilityId,
      });
      continue;
    }

    const flatPath = await flattenExecutedPath(trace, traceStore);
    const examples = traceToTrainingExamples(trace, flatPath, intentEmbedding, pathFeatures, allEmbeddings);

    for (const _ex of examples) {
      exampleToTraceId.push(trace.id);
    }
    allExamples.push(...examples);
  }

  if (allExamples.length === 0) {
    log.warn("[PER-Subprocess] No training examples generated");
    return {
      loss: 0,
      accuracy: 0,
      tracesProcessed: traces.length,
      highPriorityCount: traces.filter((t) => t.priority > 0.7).length,
      prioritiesUpdated: 0,
      examplesGenerated: 0,
      fallback: "tool-level",
      fallbackReason: "no valid training examples could be generated",
    };
  }

  // Step 5: Collect all tools from examples for subprocess SHGAT
  const allToolsFromExamples = new Set<string>();
  for (const ex of allExamples) {
    for (const tool of ex.contextTools) {
      allToolsFromExamples.add(tool);
    }
  }

  // Ensure first capability includes all tools
  const capsForWorker = capabilities.map((c, i) => ({
    ...c,
    toolsUsed: i === 0 ? [...new Set([...c.toolsUsed, ...allToolsFromExamples])] : c.toolsUsed,
  }));

  // Step 6: Train in subprocess
  log.info(`[PER-Subprocess] Spawning training with ${allExamples.length} examples...`);

  const result = await spawnSHGATTraining({
    capabilities: capsForWorker,
    examples: allExamples,
    epochs,
    batchSize,
    existingParams: shgat.exportParams(),
  });

  if (!result.success) {
    log.error(`[PER-Subprocess] Training failed: ${result.error}`);
    return {
      loss: 0,
      accuracy: 0,
      tracesProcessed: traces.length,
      highPriorityCount: traces.filter((t) => t.priority > 0.7).length,
      prioritiesUpdated: 0,
      examplesGenerated: allExamples.length,
      fallback: "tool-level",
      fallbackReason: `subprocess failed: ${result.error}`,
    };
  }

  // Step 7: Import trained params
  if (result.params) {
    shgat.importParams(result.params);
  }

  // Step 8: Update priorities using TD errors
  let prioritiesUpdated = 0;
  if (result.tdErrors && result.tdErrors.length > 0) {
    // Aggregate TD errors per trace (max |TD error| per trace)
    const tdErrorsPerTrace = new Map<string, number>();
    for (let i = 0; i < result.tdErrors.length && i < exampleToTraceId.length; i++) {
      const traceId = exampleToTraceId[i];
      if (!traceId) continue;
      const absError = Math.abs(result.tdErrors[i]);
      const current = tdErrorsPerTrace.get(traceId) ?? 0;
      if (absError > current) {
        tdErrorsPerTrace.set(traceId, absError);
      }
    }

    prioritiesUpdated = await batchUpdatePrioritiesFromTDErrors(
      traceStore,
      traces,
      tdErrorsPerTrace,
    );
  }

  const elapsed = performance.now() - startTime;

  log.info("[PER-Subprocess] Training completed", {
    tracesProcessed: traces.length,
    examplesGenerated: allExamples.length,
    epochs,
    loss: result.finalLoss?.toFixed(4),
    accuracy: result.finalAccuracy?.toFixed(4),
    prioritiesUpdated,
    elapsedMs: elapsed.toFixed(1),
  });

  return {
    loss: result.finalLoss ?? 0,
    accuracy: result.finalAccuracy ?? 0,
    tracesProcessed: traces.length,
    highPriorityCount: traces.filter((t) => t.priority > 0.7).length,
    prioritiesUpdated,
    examplesGenerated: allExamples.length,
  };
}
