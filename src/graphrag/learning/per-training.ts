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

  // Step 4: Get ALL embeddings (capabilities + tools) for negative mining
  const graphBuilder = (shgat as unknown as { graphBuilder: {
    getCapabilityNodes: () => Map<string, { embedding: number[]; toolsUsed?: string[] }>;
    getToolNodes: () => Map<string, { embedding: number[] }>;
  } }).graphBuilder;

  const allEmbeddings = new Map<string, number[]>();

  // Add capability embeddings and build capToTools map
  const capToTools = new Map<string, Set<string>>();
  for (const [capId, cap] of graphBuilder.getCapabilityNodes()) {
    if (cap.embedding) allEmbeddings.set(capId, cap.embedding);
    capToTools.set(capId, new Set(cap.toolsUsed ?? []));
  }

  // Add tool embeddings and build cosine clusters
  const COSINE_THRESHOLD = 0.7;
  const toolEmbeddings = new Map<string, number[]>();
  for (const [toolId, tool] of graphBuilder.getToolNodes()) {
    if (tool.embedding) {
      allEmbeddings.set(toolId, tool.embedding);
      toolEmbeddings.set(toolId, tool.embedding);
    }
  }

  // Build tool clusters using cosine similarity (semantic)
  const toolClusters = new Map<string, Set<string>>();
  for (const [toolId, toolEmb] of toolEmbeddings) {
    const cluster = new Set<string>([toolId]);
    for (const [otherId, otherEmb] of toolEmbeddings) {
      if (otherId === toolId) continue;
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < Math.min(toolEmb.length, otherEmb.length); i++) {
        dot += toolEmb[i] * otherEmb[i];
        normA += toolEmb[i] * toolEmb[i];
        normB += otherEmb[i] * otherEmb[i];
      }
      const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-9);
      if (sim > COSINE_THRESHOLD) {
        cluster.add(otherId);
      }
    }
    toolClusters.set(toolId, cluster);
  }
  log.debug(`[PER-Training] Built ${toolClusters.size} tool clusters (cosine > ${COSINE_THRESHOLD})`);

  // Step 5: Flatten paths and generate training examples
  const allExamples: TrainingExample[] = [];
  // Track which examples belong to which trace (for TD error aggregation)
  const exampleToTraceId: string[] = [];

  // Note: Since migration 030, intentEmbedding comes from capability via JOIN.
  // No need to regenerate embeddings - use trace.intentEmbedding directly.
  // This ensures perfect consistency when capabilities are renamed.

  // Helper: compute percentile
  const percentile = (arr: number[], p: number): number => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor((p / 100) * (sorted.length - 1));
    return sorted[idx];
  };

  // Helper: cosine similarity
  const cosineSim = (a: number[], b: number[]): number => {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  };

  // Compute adaptive thresholds from all traces
  const allSims: number[] = [];
  for (const trace of traces) {
    const intentEmb = trace.intentEmbedding;
    if (!intentEmb || intentEmb.length === 0) continue;
    for (const [capId, emb] of allEmbeddings) {
      if (capId === trace.capabilityId) continue;
      allSims.push(cosineSim(intentEmb, emb));
    }
  }
  let adaptiveMin = allSims.length > 0 ? percentile(allSims, 25) : 0.15;
  let adaptiveMax = allSims.length > 0 ? percentile(allSims, 75) : 0.65;

  // Ensure minimum spread of 0.3 (if too narrow, embeddings are too clustered)
  const MIN_SPREAD = 0.3;
  if (adaptiveMax - adaptiveMin < MIN_SPREAD) {
    const mid = (adaptiveMin + adaptiveMax) / 2;
    adaptiveMin = Math.max(0, mid - MIN_SPREAD / 2);
    adaptiveMax = Math.min(1, mid + MIN_SPREAD / 2);
    log.debug(`[PER-Training] Spread too narrow, expanded to: [${adaptiveMin.toFixed(2)}, ${adaptiveMax.toFixed(2)}]`);
  }

  log.debug(`[PER-Training] Adaptive thresholds: [${adaptiveMin.toFixed(2)}, ${adaptiveMax.toFixed(2)}]`);

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

    // Generate multi-example (one per node) with semi-hard negative mining
    // Pass capToTools and toolClusters to exclude anchor capability's tools + similar tools
    const examples = traceToTrainingExamples(trace, flatPath, intentEmbedding, pathFeatures, allEmbeddings, capToTools, toolClusters, adaptiveMin, adaptiveMax);
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
  // Use loop instead of Math.min(...) to avoid stack overflow with large arrays
  let minProb = Infinity;
  for (const p of probs) {
    if (p < minProb) minProb = p;
  }
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
  allEmbeddings?: Map<string, number[]>, // Optional: for semi-hard negative mining (caps + tools)
  capToTools?: Map<string, Set<string>>, // Optional: capability → toolsUsed for exclusion
  toolClusters?: Map<string, Set<string>>, // Optional: tool → community members (Louvain)
  semiHardMin: number = 0.15, // Adaptive threshold (P25)
  semiHardMax: number = 0.65, // Adaptive threshold (P75)
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

  const NUM_NEGATIVES = 8;
  const SEMI_HARD_MIN = semiHardMin; // Adaptive threshold (P25)
  const SEMI_HARD_MAX = semiHardMax; // Adaptive threshold (P75)

  // Helper: cosine similarity
  const cosineSim = (a: number[], b: number[]): number => {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  };

  // Pre-compute SEMI-HARD negatives for the whole trace (same intent for all examples)
  // Semi-hard: negatives similar to ANCHOR (not intent) for challenging discrimination
  let semiHardNegativeCapIds: string[] | undefined;
  if (allEmbeddings && allEmbeddings.size > NUM_NEGATIVES) {
    // Get tools to exclude: anchor capability's toolsUsed (they're related, not negatives)
    const anchorTools = trace.capabilityId ? (capToTools?.get(trace.capabilityId) ?? new Set<string>()) : new Set<string>();

    // Build expanded exclusion set: anchor tools + their community members (cosine clusters)
    const excludedTools = new Set<string>();
    for (const toolId of anchorTools) {
      excludedTools.add(toolId);
      const cluster = toolClusters?.get(toolId);
      if (cluster) {
        for (const member of cluster) {
          excludedTools.add(member);
        }
      }
    }

    // Compute similarity to INTENT for all candidates
    const candidatesWithSim: Array<{ id: string; sim: number }> = [];
    for (const [itemId, emb] of allEmbeddings) {
      // Skip items in the executed path
      if (flatPath.includes(itemId)) continue;
      // Skip tools in the exclusion cluster (anchor's tools + community members)
      if (excludedTools.has(itemId)) continue;
      const sim = cosineSim(intentEmbedding, emb);
      candidatesWithSim.push({ id: itemId, sim });
    }

    // Semi-hard negative mining: filter to P25-P75 similarity range
    // PER handles curriculum learning by prioritizing harder examples within this range
    const semiHard = candidatesWithSim.filter(
      (c) => c.sim >= SEMI_HARD_MIN && c.sim <= SEMI_HARD_MAX
    );

    if (semiHard.length >= NUM_NEGATIVES) {
      // Enough hard negatives: shuffle and take N
      for (let i = semiHard.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [semiHard[i], semiHard[j]] = [semiHard[j], semiHard[i]];
      }
      semiHardNegativeCapIds = semiHard.slice(0, NUM_NEGATIVES).map((c) => c.id);
    } else {
      // Not enough hard negatives: sort by similarity descending and take top
      const sorted = [...candidatesWithSim].sort((a, b) => b.sim - a.sim);
      const needed = NUM_NEGATIVES - semiHard.length;
      const rest = sorted
        .filter((c) => !semiHard.some(s => s.id === c.id))
        .slice(0, needed);
      semiHardNegativeCapIds = [
        ...semiHard.map((c) => c.id),
        ...rest.map((c) => c.id),
      ];
    }
  }

  // Generate one example per node in the path
  for (let i = 0; i < flatPath.length; i++) {
    const candidateId = flatPath[i];

    examples.push({
      intentEmbedding,
      contextTools: flatPath.slice(0, i), // Nodes before this point
      candidateId,
      outcome: adjustedOutcome,
      negativeCapIds: semiHardNegativeCapIds,
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
  /** Number of epochs (default: 3 for live with PER curriculum, 5+ for batch) */
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

  // Step 4: Get ALL embeddings (capabilities + tools) for negative mining
  const allEmbeddings = new Map<string, number[]>();

  // Add capability embeddings from options and build capToTools map
  const capToTools = new Map<string, Set<string>>();
  for (const cap of capabilities) {
    if (cap.embedding) allEmbeddings.set(cap.id, cap.embedding);
    capToTools.set(cap.id, new Set(cap.toolsUsed ?? []));
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
    // Pass capToTools to exclude anchor capability's tools from negatives
    const examples = traceToTrainingExamples(trace, flatPath, intentEmbedding, pathFeatures, allEmbeddings, capToTools);

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
