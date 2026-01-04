/**
 * Worker RPC Bridge - Native Tool Tracing via Web Workers
 *
 * Story 7.1b / ADR-032: Replaces subprocess-based sandbox with Web Worker + RPC bridge.
 * Story 7.3b: Capability injection with BroadcastChannel tracing (ADR-036).
 *
 * Architecture:
 * - WorkerBridge (this file): Main process coordinator
 * - SandboxWorker: Worker script that executes user code
 * - RPC Protocol: postMessage-based tool invocation
 * - BroadcastChannel: Real-time capability trace collection (ADR-036)
 *
 * Benefits:
 * - MCP tools work in sandbox (proxies instead of serialized functions)
 * - Native tracing (no stdout parsing)
 * - Structured RPC communication
 * - Real-time capability tracing via BroadcastChannel
 *
 * @module sandbox/worker-bridge
 */

import type { MCPClientBase } from "../mcp/types.ts";
import type { JsonValue, TraceTaskResult } from "../capabilities/types.ts";
// Story 13.5: Import getCapModule for cap_* tool handling
import { getCapModule } from "../../lib/std/cap.ts";
import type {
  CapabilityTraceEvent,
  ExecutionCompleteMessage,
  ExecutionResult,
  InitMessage,
  RPCCallMessage,
  RPCResultMessage,
  ToolDefinition,
  ToolTraceEvent,
  TraceEvent,
  WorkerToBridgeMessage,
} from "./types.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { Capability } from "../capabilities/types.ts";
import { getCapabilityFqdn } from "../capabilities/capability-registry.ts";
import type { GraphRAGEngine } from "../graphrag/graph-engine.ts";
import { CapabilityCodeGenerator } from "../capabilities/code-generator.ts";
import { getLogger } from "../telemetry/logger.ts";
// Story 6.5: EventBus integration (ADR-036)
import { eventBus } from "../events/mod.ts";

const logger = getLogger("default");

/**
 * Maximum length for toString fallback in non-serializable results.
 * Prevents huge strings from being stored in traces while preserving useful debug info.
 */
const MAX_TOSTRING_LENGTH = 500;

/**
 * Safely serialize a result for tracing (Story 11.1)
 * Handles circular references and non-serializable objects gracefully.
 *
 * @param result - The result to serialize
 * @returns A JSON-safe representation of the result
 */
function safeSerializeResult(result: unknown): unknown {
  if (result === undefined || result === null) {
    return result;
  }

  try {
    // Test if result is JSON-serializable
    JSON.stringify(result);
    return result;
  } catch {
    // Fallback for non-serializable results (circular refs, functions, etc.)
    return {
      __type: "non-serializable",
      typeof: typeof result,
      toString: String(result).substring(0, MAX_TOSTRING_LENGTH),
    };
  }
}

/**
 * Configuration for WorkerBridge
 */
export interface WorkerBridgeConfig {
  /** Maximum execution time in milliseconds (default: 30000) */
  timeout?: number;
  /** RPC call timeout in milliseconds (default: 10000) */
  rpcTimeout?: number;
  /** Optional CapabilityStore for eager learning (Story 7.2a) */
  capabilityStore?: CapabilityStore;
  /** Optional GraphRAGEngine for trace learning (Story 7.3b - AC#5) */
  graphRAG?: GraphRAGEngine;
  /** Optional CapabilityRegistry for routing to capabilities when MCP server not found */
  capabilityRegistry?: import("../capabilities/capability-registry.ts").CapabilityRegistry;
  // Note: permissionSet removed - Worker always uses "none" permissions.
  // Note: cap_* tools use global CapModule via getCapModule() (Story 13.5)
  // All I/O goes through MCP RPC for complete tracing. See WORKER_PERMISSIONS.
}

/**
 * Deno Worker permissions are always "none" (most restrictive).
 *
 * DESIGN DECISION (2025-12-19):
 * All I/O operations MUST go through MCP RPC proxy. This ensures:
 * 1. Complete tracing of all operations (100% observable)
 * 2. Centralized permission control in main process
 * 3. No bypass possible via direct Deno APIs
 *
 * PermissionSet in mcp-permissions.yaml is used for METADATA only
 * (inference, audit, HIL detection), not for Worker sandbox permissions.
 *
 * @see docs/spikes/2025-12-19-capability-vs-trace-clarification.md
 * @see docs/tech-specs/tech-spec-hil-permission-escalation-fix.md
 */
const WORKER_PERMISSIONS = "none" as const;

/**
 * Default configuration values
 */
const DEFAULTS = {
  TIMEOUT_MS: 30000,
  RPC_TIMEOUT_MS: 10000,
} as const;

/**
 * WorkerBridge - RPC Bridge for Sandbox Code Execution
 *
 * Coordinates between main process (MCP clients) and Worker (sandbox code).
 * All tool calls are traced natively in the bridge, not via stdout parsing.
 * Story 7.3b: Capability traces received via BroadcastChannel (ADR-036).
 *
 * @example
 * ```typescript
 * const bridge = new WorkerBridge(mcpClients);
 * const toolDefs = buildToolDefinitions(searchResults);
 * const capContext = bridge.buildCapabilityContext(capabilities);
 * const result = await bridge.execute(code, toolDefs, context, capContext);
 * const traces = bridge.getTraces(); // Tool + Capability traces!
 * ```
 */
export class WorkerBridge {
  private config: Omit<
    Required<WorkerBridgeConfig>,
    "capabilityStore" | "graphRAG" | "capabilityRegistry"
  >;
  private capabilityStore?: CapabilityStore;
  private graphRAG?: GraphRAGEngine;
  private capabilityRegistry?: import("../capabilities/capability-registry.ts").CapabilityRegistry;
  private worker: Worker | null = null;
  private traces: TraceEvent[] = [];
  private pendingRPCs: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }> = new Map();
  private completionPromise: {
    resolve: (result: ExecutionResult) => void;
    reject: (error: Error) => void;
  } | null = null;
  private startTime: number = 0;
  private lastExecutedCode: string = "";
  private lastIntent?: string;
  private lastContext?: Record<string, unknown>;
  private lastParentTraceId?: string;

  // Story 7.3b: BroadcastChannel for real-time capability trace collection (ADR-036)
  private traceChannel: BroadcastChannel;
  private codeGenerator: CapabilityCodeGenerator;

  constructor(
    private mcpClients: Map<string, MCPClientBase>,
    config?: WorkerBridgeConfig,
  ) {
    this.config = {
      timeout: config?.timeout ?? DEFAULTS.TIMEOUT_MS,
      rpcTimeout: config?.rpcTimeout ?? DEFAULTS.RPC_TIMEOUT_MS,
    };
    this.capabilityStore = config?.capabilityStore;
    this.graphRAG = config?.graphRAG;
    this.capabilityRegistry = config?.capabilityRegistry;

    // Story 7.3b: Setup BroadcastChannel for capability traces
    // Story 6.5: Bridge capability traces to unified EventBus (ADR-036)
    // Channel name: PML_TRACES_CHANNEL from src/events/event-bus.ts
    this.traceChannel = new BroadcastChannel("pml-traces");
    this.traceChannel.onmessage = (e: MessageEvent<CapabilityTraceEvent>) => {
      // Add capability traces to unified trace array in real-time (backward compat)
      this.traces.push(e.data);

      // Story 6.5: Forward capability traces to unified EventBus
      // ADR-041: Include parentTraceId for hierarchical tracking
      if (e.data.type === "capability_start") {
        eventBus.emit({
          type: "capability.start",
          source: "sandbox-worker",
          payload: {
            capabilityId: e.data.capabilityId,
            capability: e.data.capability,
            traceId: e.data.traceId,
            parentTraceId: e.data.parentTraceId, // ADR-041
            args: e.data.args, // ADR-041
          },
        });
      } else if (e.data.type === "capability_end") {
        eventBus.emit({
          type: "capability.end",
          source: "sandbox-worker",
          payload: {
            capabilityId: e.data.capabilityId,
            capability: e.data.capability,
            traceId: e.data.traceId,
            parentTraceId: e.data.parentTraceId, // ADR-041
            success: e.data.success ?? true,
            durationMs: e.data.durationMs ?? 0,
            error: e.data.error,
            result: e.data.result, // Story 11.1
          },
        });
      }
    };

    // Story 7.3b: Code generator for capability injection
    this.codeGenerator = new CapabilityCodeGenerator();

    logger.debug("WorkerBridge initialized", {
      mcpClientsCount: mcpClients.size,
      timeout: this.config.timeout,
      rpcTimeout: this.config.rpcTimeout,
      capabilityStoreEnabled: !!this.capabilityStore,
      graphRAGEnabled: !!this.graphRAG,
    });
  }

  /**
   * Build capability context code for injection into Worker
   * Story 7.3b: Generates inline JavaScript functions with tracing
   *
   * @param capabilities - Array of capabilities to inject
   * @returns JavaScript code string defining capabilities object
   */
  buildCapabilityContext(capabilities: Capability[]): string {
    return this.codeGenerator.buildCapabilitiesObject(capabilities);
  }

  /**
   * Execute code in Worker sandbox with RPC bridge for tool calls
   *
   * @param code TypeScript code to execute
   * @param toolDefinitions Tool definitions for proxy generation
   * @param context Optional context variables to inject (may include 'intent' for capability learning)
   * @param capabilityContext Optional capability code (Story 7.3b - generated by buildCapabilityContext)
   * @param parentTraceId Optional parent trace ID for hierarchical tracking (ADR-041)
   * @returns Execution result with traces available via getTraces()
   */
  async execute(
    code: string,
    toolDefinitions: ToolDefinition[],
    context?: Record<string, unknown>,
    capabilityContext?: string,
    parentTraceId?: string,
    options?: { preserveTraces?: boolean },
  ): Promise<ExecutionResult> {
    this.startTime = performance.now();
    // Reset traces for new execution (unless preserveTraces is set)
    if (!options?.preserveTraces) {
      this.traces = [];
    }
    this.lastExecutedCode = code;
    this.lastIntent = context?.intent as string | undefined;
    this.lastContext = context; // Story 11.2: Store for traceData
    this.lastParentTraceId = parentTraceId; // Story 11.2: Store for traceData

    try {
      logger.debug("Starting Worker execution", {
        codeLength: code.length,
        toolCount: toolDefinitions.length,
        contextKeys: context ? Object.keys(context) : [],
        workerPermissions: WORKER_PERMISSIONS, // Always "none" - all I/O via RPC
      });

      // 1. Spawn Worker with "none" permissions - all I/O goes through MCP RPC
      const workerUrl = new URL("./sandbox-worker.ts", import.meta.url).href;
      this.worker = new Worker(workerUrl, {
        type: "module",
        // @ts-ignore: Deno-specific Worker option for permissions
        deno: { permissions: WORKER_PERMISSIONS },
      });

      // Emit sandbox.worker.spawned event
      eventBus.emit({
        type: "sandbox.worker.spawned",
        source: "worker-bridge",
        payload: {
          permissions: WORKER_PERMISSIONS,
          timeout: this.config.timeout,
          toolCount: toolDefinitions.length,
        },
      });

      // 2. Setup message handler
      this.worker.onmessage = (e: MessageEvent<WorkerToBridgeMessage>) => {
        this.handleWorkerMessage(e.data);
      };

      this.worker.onerror = (e: ErrorEvent) => {
        logger.error("Worker error", { message: e.message });
        if (this.completionPromise) {
          this.completionPromise.reject(new Error(`Worker error: ${e.message}`));
        }
      };

      // 3. Create completion promise
      const result = await new Promise<ExecutionResult>((resolve, reject) => {
        this.completionPromise = { resolve, reject };

        // Setup overall timeout
        const timeoutId = setTimeout(() => {
          // Emit sandbox.execution.timeout event
          eventBus.emit({
            type: "sandbox.execution.timeout",
            source: "worker-bridge",
            payload: {
              timeoutMs: this.config.timeout,
              tracesCount: this.traces.length,
            },
          });

          this.terminate();
          reject(new Error("TIMEOUT"));
        }, this.config.timeout);

        // Send init message (Story 7.3b: include capabilityContext, ADR-041: include parentTraceId)
        const initMessage: InitMessage = {
          type: "init",
          code,
          toolDefinitions,
          context,
          capabilityContext,
          parentTraceId, // ADR-041: Propagate trace hierarchy
        };

        this.worker!.postMessage(initMessage);

        // Clear timeout on completion (handled in handleWorkerMessage)
        this.completionPromise.resolve = (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        };
      });

      logger.info("Worker execution completed", {
        success: result.success,
        executionTimeMs: result.executionTimeMs,
        tracesCount: this.traces.length,
      });

      // Eager Learning: Save capability after successful execution (Story 7.2a)
      // Only save if ALL tools succeeded - partial failures create inconsistent capabilities
      const hasToolFailures = this.hasAnyToolFailed();
      if (result.success && this.capabilityStore && this.lastIntent && !hasToolFailures) {
        try {
          // Get detailed invocations for sequence visualization
          const invocations = this.getToolInvocations();
          const toolInvocations = invocations
            .filter((inv) => inv.success) // Only successful invocations
            .map((inv) => ({
              id: inv.id,
              tool: inv.tool,
              ts: inv.ts,
              durationMs: inv.durationMs,
              sequenceIndex: inv.sequenceIndex,
            }));

          // Story 11.2: Build taskResults from tool traces for execution trace persistence
          const sortedTraces = [...this.traces].sort((a, b) => a.ts - b.ts);
          const taskResults: TraceTaskResult[] = sortedTraces
            .filter((
              t,
            ): t is TraceEvent & {
              tool: string;
              args?: Record<string, unknown>;
              result?: unknown;
            } => t.type === "tool_end" && "tool" in t)
            .map((t, idx) => ({
              taskId: `task-${idx}`,
              tool: t.tool,
              args: (t.args ?? {}) as Record<string, JsonValue>,
              result: (t.result ?? null) as JsonValue,
              success: t.success ?? false,
              durationMs: t.durationMs ?? 0,
            }));

          // Build executedPath from traces (tool and capability nodes in execution order)
          const executedPath = sortedTraces
            .filter((t): t is ToolTraceEvent | CapabilityTraceEvent =>
              t.type === "tool_end" || t.type === "capability_end"
            )
            .map((t) => {
              if (t.type === "tool_end") return t.tool;
              return (t as CapabilityTraceEvent).capability;
            });

          const { trace } = await this.capabilityStore.saveCapability({
            code: this.lastExecutedCode,
            intent: this.lastIntent,
            durationMs: Math.round(result.executionTimeMs),
            success: true,
            toolsUsed: this.getToolsCalled(),
            toolInvocations,
            // Story 11.2: Include traceData for execution trace persistence
            traceData: {
              initialContext: (this.lastContext ?? {}) as Record<string, JsonValue>,
              executedPath,
              decisions: [], // Branch decisions not yet captured at runtime
              taskResults,
              userId: (this.lastContext?.userId as string) ?? "local",
              parentTraceId: this.lastParentTraceId,
            },
          });
          logger.debug("Capability saved via eager learning", {
            intent: this.lastIntent.substring(0, 50),
            toolsUsed: this.getToolsCalled().length,
            toolInvocations: toolInvocations.length,
            traceId: trace?.id,
          });
        } catch (capError) {
          // Don't fail execution if capability storage fails
          logger.warn("Failed to save capability", {
            error: capError instanceof Error ? capError.message : String(capError),
          });
        }
      } else if (hasToolFailures) {
        const failedTools = this.traces
          .filter((t): t is TraceEvent & { tool: string } =>
            t.type === "tool_end" && !t.success && "tool" in t
          )
          .map((t) => t.tool);
        logger.info("Capability not saved due to tool failures", {
          intent: this.lastIntent?.substring(0, 50),
          failedTools,
        });
      }

      // Story 7.3b (AC#5): Update GraphRAG with execution traces for dependency learning
      if (this.graphRAG && this.traces.length >= 2) {
        try {
          await this.graphRAG.updateFromCodeExecution(this.getTraces());
          logger.debug("GraphRAG updated from code execution", {
            tracesCount: this.traces.length,
          });
        } catch (graphError) {
          // Don't fail execution if GraphRAG update fails
          logger.warn("Failed to update GraphRAG from execution", {
            error: graphError instanceof Error ? graphError.message : String(graphError),
          });
        }
      }

      return result;
    } catch (error) {
      const executionTimeMs = performance.now() - this.startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.debug("Worker execution failed", {
        error: errorMessage,
        executionTimeMs,
      });

      // Map error types
      if (errorMessage.includes("TIMEOUT")) {
        return {
          success: false,
          error: {
            type: "TimeoutError",
            message: `Execution exceeded timeout of ${this.config.timeout}ms`,
          },
          executionTimeMs,
        };
      }

      return {
        success: false,
        error: {
          type: "RuntimeError",
          message: errorMessage,
        },
        executionTimeMs,
      };
    } finally {
      this.terminate();
    }
  }

  /**
   * Execute code task with pseudo-tool tracing (Phase 1)
   *
   * This method executes code_execution tasks (e.g., code:filter, code:map)
   * and emits tool_start/tool_end traces so they appear in executedPath
   * alongside MCP tools for SHGAT learning.
   *
   * @param toolName - Pseudo-tool name (e.g., "code:filter", "code:map")
   * @param code - TypeScript code to execute
   * @param context - Optional context variables
   * @param toolDefinitions - Available MCP tools for RPC
   * @returns Execution result with traces
   *
   * @example
   * ```typescript
   * const result = await bridge.executeCodeTask(
   *   "code:filter",
   *   "return users.filter(u => u.active);",
   *   { users: [...] },
   *   []
   * );
   * // Emits: tool_start("code:filter") → execute code → tool_end("code:filter")
   * ```
   */
  async executeCodeTask(
    toolName: string,
    code: string,
    context?: Record<string, unknown>,
    toolDefinitions: ToolDefinition[] = [],
    // Loop Capability Fix: metadata for correct executedPath building and capability saving
    loopMetadata?: {
      loopId?: string;
      loopCondition?: string;
      loopType?: string;
      bodyTools?: string[];
    },
  ): Promise<ExecutionResult> {
    const traceId = `code-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const startTime = Date.now();

    // Phase 1: Emit tool_start trace for pseudo-tool
    // Loop Capability Fix: Include loop metadata for frontend display
    this.traces.push({
      type: "tool_start",
      tool: toolName,
      traceId,
      ts: startTime,
      ...(loopMetadata ? {
        loopId: loopMetadata.loopId,
        loopType: loopMetadata.loopType,
        loopCondition: loopMetadata.loopCondition,
        bodyTools: loopMetadata.bodyTools,
      } : {}),
    });

    logger.debug(`Trace: tool_start for ${toolName}`, { traceId, loopId: loopMetadata?.loopId });

    try {
      // Execute code via Worker with preserveTraces to accumulate traces
      const result = await this.execute(
        code,
        toolDefinitions,
        context,
        undefined, // capabilityContext
        undefined, // parentTraceId
        { preserveTraces: true }, // Don't reset traces
      );

      const endTime = Date.now();
      const durationMs = endTime - startTime;

      // Phase 1: Emit tool_end trace for successful execution
      // Loop Capability Fix: Include loop metadata for frontend display
      this.traces.push({
        type: "tool_end",
        tool: toolName,
        traceId,
        ts: endTime,
        success: result.success,
        durationMs,
        result: result.result,
        ...(result.error ? { error: result.error.message } : {}),
        ...(loopMetadata ? {
          loopId: loopMetadata.loopId,
          loopType: loopMetadata.loopType,
          loopCondition: loopMetadata.loopCondition,
          bodyTools: loopMetadata.bodyTools,
        } : {}),
      });

      logger.debug(`Trace: tool_end for ${toolName}`, {
        traceId,
        success: result.success,
        durationMs,
      });

      // Loop Capability Fix: Save capability for loop tasks with correct executedPath
      if (
        loopMetadata &&
        toolName.startsWith("loop:") &&
        result.success &&
        this.capabilityStore
      ) {
        try {
          // Build correct executedPath: [loop, ...bodyTools] (deduplicated from static analysis)
          const executedPath = [toolName, ...(loopMetadata.bodyTools || [])];

          // Use original intent from context (like normal capabilities) or generate from loop condition
          const originalIntent = context?.intent as string | undefined;
          const intent = originalIntent
            || (loopMetadata.loopCondition
              ? `Loop over ${loopMetadata.loopCondition.replace(/^for\s*\(/, "").replace(/\)$/, "")}`
              : `Execute ${toolName}`);

          // Reconstruct complete code with variable declarations for readable capability
          const contextVars = context
            ? Object.entries(context)
                .filter(([k]) => k !== "deps" && k !== "args" && k !== "intent")
                .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`)
                .join("\n")
            : "";
          const completeCode = contextVars ? `${contextVars}\n${code}` : code;

          // Create taskResult for the loop itself so TraceTimeline can render it
          const loopTaskResult = {
            taskId: `task_loop_${Date.now()}`,
            tool: toolName, // e.g., "loop:forOf"
            args: {} as Record<string, JsonValue>, // Loop has no args
            result: (result.result ?? null) as JsonValue, // Loop result
            success: true,
            durationMs,
            layerIndex: 0,
            // Loop metadata for TraceTimeline groupTasksByLoop()
            loopId: loopMetadata.loopId,
            loopType: loopMetadata.loopType as "for" | "while" | "forOf" | "forIn" | "doWhile" | undefined,
            loopCondition: loopMetadata.loopCondition,
            bodyTools: loopMetadata.bodyTools,
          };

          const { capability } = await this.capabilityStore.saveCapability({
            code: completeCode,
            intent,
            durationMs,
            success: true,
            toolsUsed: loopMetadata.bodyTools || [],
            traceData: {
              initialContext: (context ?? {}) as Record<string, JsonValue>,
              executedPath,
              decisions: [],
              taskResults: [loopTaskResult],
            },
          });

          // Create capability_records for proper naming (like execute-handler does)
          // This gives us namespace:action like "loop:exec_XXXX" instead of just the ID
          if (this.capabilityRegistry) {
            try {
              const existingRecord = await this.capabilityRegistry.getByWorkflowPatternId(
                capability.id,
              );

              if (!existingRecord) {
                // Create new capability_records
                // namespace: "loop" (from toolName like "loop:forOf")
                const namespace = toolName.includes(":") ? toolName.split(":")[0] : "loop";
                // action: exec_XXXX (from code hash)
                const action = `exec_${capability.codeHash.substring(0, 8)}`;
                // 4-char hash for FQDN
                const hash = capability.codeHash.substring(0, 4);

                await this.capabilityRegistry.create({
                  org: "local",
                  project: "default",
                  namespace,
                  action,
                  workflowPatternId: capability.id,
                  hash,
                  createdBy: "worker_bridge_loop",
                  toolsUsed: loopMetadata.bodyTools || [],
                });

                logger.info("Registered loop capability in registry", {
                  name: `${namespace}:${action}`,
                  capabilityId: capability.id,
                });
              }
            } catch (registryError) {
              // Log but don't fail
              logger.warn("Failed to register loop capability in registry", {
                error: registryError instanceof Error ? registryError.message : String(registryError),
              });
            }
          }

          logger.info("Saved loop capability", {
            tool: toolName,
            intent,
            bodyTools: loopMetadata.bodyTools,
            executedPath,
          });
        } catch (saveError) {
          // Don't fail execution if capability save fails
          logger.warn("Failed to save loop capability", {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          });
        }
      }

      return result;
    } catch (error) {
      const endTime = Date.now();
      const durationMs = endTime - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Phase 1: Emit tool_end trace for execution errors
      this.traces.push({
        type: "tool_end",
        tool: toolName,
        traceId,
        ts: endTime,
        success: false,
        durationMs,
        error: errorMessage,
      });

      logger.debug(`Trace: tool_end (error) for ${toolName}`, { traceId, error: errorMessage });

      throw error;
    }
  }

  /**
   * Handle messages from Worker
   */
  private handleWorkerMessage(msg: WorkerToBridgeMessage): void {
    if (msg.type === "rpc_call") {
      this.handleRPCCall(msg as RPCCallMessage);
    } else if (msg.type === "execution_complete") {
      this.handleExecutionComplete(msg as ExecutionCompleteMessage);
    }
  }

  /**
   * Handle RPC call from Worker - route to MCPClient with native tracing
   * Story 6.5: Also emits events to EventBus (ADR-036)
   * ADR-041: Extracts parentTraceId for hierarchical tracking
   */
  private async handleRPCCall(msg: RPCCallMessage): Promise<void> {
    const { id, server, tool, args, parentTraceId } = msg;
    const toolId = `${server}:${tool}`;
    const startTime = Date.now();

    // TRACE START - native tracing in bridge!
    // ADR-041: Include args and parentTraceId for hierarchical tracking
    this.traces.push({
      type: "tool_start",
      tool: toolId,
      traceId: id,
      ts: startTime,
      args: args,
      parentTraceId: parentTraceId, // ADR-041: Propagate hierarchy
    });

    // Story 6.5: Emit tool.start event to EventBus
    // ADR-041: Include parentTraceId in event payload
    eventBus.emit({
      type: "tool.start",
      source: "worker-bridge",
      payload: {
        toolId: toolId,
        traceId: id,
        args: args,
        parentTraceId: parentTraceId, // ADR-041
      },
    });

    logger.debug("RPC call received", { id, server, tool, argsKeys: Object.keys(args || {}) });

    try {
      // Story 13.5: Intercept cap_* tools and handle via global CapModule
      // These tools require gateway's CapModule, not the std MCP server
      if (server === "std" && tool.startsWith("cap_")) {
        const capModule = getCapModule(); // Uses global set by PmlStdServer
        // Map cap_list → cap:list, cap_rename → cap:rename, etc.
        const capToolName = "cap:" + tool.slice(4); // "cap_list" → "cap:list"
        logger.debug("Routing cap tool to CapModule", { tool, capToolName });
        const capResult = await capModule.call(capToolName, args || {});
        // Format as MCP-like response
        const result = {
          content: capResult.content,
          isError: capResult.isError,
        };
        const endTime = Date.now();
        const durationMs = endTime - startTime;
        const safeResult = safeSerializeResult(result);
        this.traces.push({
          type: "tool_end",
          tool: toolId,
          traceId: id,
          ts: endTime,
          success: !capResult.isError,
          durationMs: durationMs,
          parentTraceId: parentTraceId,
          result: safeResult,
        });
        eventBus.emit({
          type: "tool.end",
          source: "worker-bridge",
          payload: {
            toolId,
            traceId: id,
            success: !capResult.isError,
            durationMs,
            parentTraceId,
            result: safeResult,
          },
        });
        // Send result back to Worker
        const response: RPCResultMessage = {
          type: "rpc_result",
          id,
          success: true,
          result: result as JsonValue,
        };
        this.worker?.postMessage(response);
        logger.debug("Cap tool RPC call succeeded", { id, tool: toolId, durationMs });
        return;
      }

      // Handle $cap:<uuid> capability references (from code-transformer)
      // server="$cap", tool=uuid → look up by UUID directly
      if (server === "$cap" && this.capabilityRegistry && this.capabilityStore) {
        const uuid = tool; // tool is the UUID
        const record = await this.capabilityRegistry.getById(uuid);
        if (record && record.workflowPatternId) {
          const pattern = await this.capabilityStore.findById(record.workflowPatternId);
          if (pattern?.codeSnippet) {
            logger.info("Routing $cap:<uuid> to capability", { uuid, id: record.id });

            // Create NEW WorkerBridge for capability execution
            const capBridge = new WorkerBridge(this.mcpClients, {
              timeout: this.config.timeout,
              capabilityStore: this.capabilityStore,
              graphRAG: this.graphRAG,
            });

            try {
              const capResult = await capBridge.execute(
                pattern.codeSnippet,
                [],
                { ...args, __capability_id: record.id },
              );
              const endTime = Date.now();
              const durationMs = endTime - startTime;
              this.traces.push({
                type: "tool_end",
                tool: toolId,
                traceId: id,
                ts: endTime,
                success: capResult.success,
                durationMs,
                parentTraceId,
                result: capResult.result,
              });
              const response: RPCResultMessage = {
                type: "rpc_result",
                id,
                success: capResult.success,
                result: capResult.result as JsonValue,
              };
              this.worker?.postMessage(response);
              logger.debug("$cap UUID RPC call succeeded", { id, uuid, durationMs });
              return;
            } finally {
              capBridge.cleanup();
            }
          }
        }
        // UUID not found
        throw new Error(`Capability UUID not found: ${uuid}`);
      }

      // Unified routing: Check capabilities FIRST, then MCP servers
      // This allows capabilities to use namespaces like "filesystem" without conflict
      if (this.capabilityRegistry && this.capabilityStore) {
        const capabilityName = `${server}:${tool}`;
        const record = await this.capabilityRegistry.resolveByName(
          capabilityName,
          { org: "local", project: "default" },
        );
        if (record && record.workflowPatternId) {
          // Found capability - execute via NEW WorkerBridge (avoid re-entrance bug)
          const pattern = await this.capabilityStore.findById(record.workflowPatternId);
          if (pattern?.codeSnippet) {
            logger.info("Routing to capability (unified)", {
              server,
              tool,
              fqdn: getCapabilityFqdn(record),
            });

            // Create NEW WorkerBridge for capability execution
            // IMPORTANT: Cannot use this.execute() - it would overwrite this.worker!
            // Pass capabilityRegistry to allow nested capability calls
            const capBridge = new WorkerBridge(this.mcpClients, {
              timeout: this.config.timeout,
              capabilityStore: this.capabilityStore,
              graphRAG: this.graphRAG,
              capabilityRegistry: this.capabilityRegistry,
            });

            try {
              const capResult = await capBridge.execute(
                pattern.codeSnippet,
                [], // toolDefinitions - capability code is self-contained
                { ...args, __capability_id: record.id },
              );
              const endTime = Date.now();
              const durationMs = endTime - startTime;
              this.traces.push({
                type: "tool_end",
                tool: toolId,
                traceId: id,
                ts: endTime,
                success: capResult.success,
                durationMs,
                parentTraceId,
                result: capResult.result,
              });
              const response: RPCResultMessage = {
                type: "rpc_result",
                id,
                success: capResult.success,
                result: capResult.result as JsonValue,
              };
              this.worker?.postMessage(response);
            } finally {
              capBridge.cleanup();
            }
            return;
          }
        }
      }

      // No capability found - route to MCP server
      const client = this.mcpClients.get(server);
      if (!client) {
        throw new Error(
          `MCP server "${server}" not connected and no capability "${server}:${tool}" found`,
        );
      }

      const result = await client.callTool(tool, args || {});
      const endTime = Date.now();
      const durationMs = endTime - startTime;

      // ADR-043: Check if MCP tool returned isError (soft failure)
      // Note: Use optional chaining since result can be null (valid MCP response)
      const mcpResult = result as { isError?: boolean; content?: Array<{ text?: string }> } | null;
      const isToolError = mcpResult?.isError === true;
      const errorMessage = isToolError && mcpResult?.content?.[0]?.text
        ? mcpResult.content[0].text
        : undefined;

      // Story 11.1: Safely serialize result for tracing
      const safeResult = safeSerializeResult(result);

      // TRACE END - success or soft failure
      // ADR-041: Include parentTraceId for hierarchical tracking
      // Story 11.1: Include result for learning
      this.traces.push({
        type: "tool_end",
        tool: toolId,
        traceId: id,
        ts: endTime,
        success: !isToolError,
        durationMs: durationMs,
        parentTraceId: parentTraceId, // ADR-041
        result: safeResult, // Story 11.1
        ...(isToolError && errorMessage ? { error: errorMessage } : {}),
      });

      // Story 6.5: Emit tool.end event to EventBus
      // Story 11.1: Include result in payload
      eventBus.emit({
        type: "tool.end",
        source: "worker-bridge",
        payload: {
          toolId: toolId,
          traceId: id,
          success: !isToolError,
          durationMs: durationMs,
          parentTraceId: parentTraceId, // ADR-041
          result: safeResult, // Story 11.1
        },
      });

      // Send result back to Worker (still send the result, let user code handle it)
      const response: RPCResultMessage = {
        type: "rpc_result",
        id,
        success: true, // RPC succeeded, but tool may have returned isError
        result: result as JsonValue,
      };
      this.worker?.postMessage(response);

      logger.debug("RPC call succeeded", { id, tool: toolId, durationMs: durationMs });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const endTime = Date.now();
      const durationMs = endTime - startTime;

      // TRACE END - failure
      // ADR-041: Include parentTraceId for hierarchical tracking
      this.traces.push({
        type: "tool_end",
        tool: toolId,
        traceId: id,
        ts: endTime,
        success: false,
        durationMs: durationMs,
        error: errorMessage,
        parentTraceId: parentTraceId, // ADR-041
      });

      // Story 6.5: Emit tool.end event to EventBus (failure)
      eventBus.emit({
        type: "tool.end",
        source: "worker-bridge",
        payload: {
          toolId: toolId,
          traceId: id,
          success: false,
          durationMs: durationMs,
          error: errorMessage,
          parentTraceId: parentTraceId, // ADR-041
        },
      });

      // Send error back to Worker
      const response: RPCResultMessage = {
        type: "rpc_result",
        id,
        success: false,
        error: errorMessage,
      };
      this.worker?.postMessage(response);

      logger.debug("RPC call failed", { id, tool: toolId, error: errorMessage });
    }
  }

  /**
   * Handle execution complete message from Worker
   */
  private handleExecutionComplete(msg: ExecutionCompleteMessage): void {
    const executionTimeMs = performance.now() - this.startTime;

    if (this.completionPromise) {
      if (msg.success) {
        this.completionPromise.resolve({
          success: true,
          result: msg.result,
          executionTimeMs,
        });
      } else {
        this.completionPromise.resolve({
          success: false,
          error: {
            type: "RuntimeError",
            message: msg.error || "Unknown error",
          },
          executionTimeMs,
        });
      }
    }
  }

  /**
   * Get all trace events from the execution (sorted chronologically)
   * Story 7.3b: Includes both tool traces (from RPC) and capability traces (from BroadcastChannel)
   */
  getTraces(): TraceEvent[] {
    // Return copy sorted by timestamp (tool and capability traces interleaved correctly)
    return [...this.traces].sort((a, b) => a.ts - b.ts);
  }

  /**
   * Get list of successfully called tools - DEDUPLICATED (for GraphRAG algorithms)
   * Used by spectral clustering, dag-suggester, and other graph algorithms
   */
  getToolsCalled(): string[] {
    const toolsCalled = new Set<string>();

    for (const trace of this.traces) {
      if (trace.type === "tool_end" && trace.success) {
        toolsCalled.add(trace.tool);
      }
    }

    return Array.from(toolsCalled);
  }

  /**
   * Get FULL sequence of tool calls with repetitions (for invocation mode visualization)
   * Preserves execution order and repeated calls to the same tool
   */
  getToolsSequence(): string[] {
    const toolsSequence: string[] = [];

    // Sort traces by timestamp to preserve execution order
    const sortedTraces = [...this.traces].sort((a, b) => a.ts - b.ts);

    for (const trace of sortedTraces) {
      if (trace.type === "tool_end" && trace.success) {
        toolsSequence.push(trace.tool);
      }
    }

    return toolsSequence;
  }

  /**
   * Check if any tool call failed during execution
   * Used to prevent saving capabilities with partial tool failures
   */
  hasAnyToolFailed(): boolean {
    for (const trace of this.traces) {
      if (trace.type === "tool_end" && !trace.success) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get detailed tool invocations with timestamps for sequence visualization
   * Unlike getToolsCalled() which deduplicates, this returns EVERY invocation.
   * Enables graph visualization of execution order and parallelism detection.
   */
  getToolInvocations(): import("./types.ts").ToolInvocation[] {
    const invocations: import("./types.ts").ToolInvocation[] = [];
    let sequenceIndex = 0;

    // Sort traces by timestamp to get execution order
    const sortedTraces = [...this.traces].sort((a, b) => a.ts - b.ts);

    for (const trace of sortedTraces) {
      if (trace.type === "tool_end" && "tool" in trace) {
        invocations.push({
          id: `${trace.tool}#${sequenceIndex}`,
          tool: trace.tool,
          traceId: trace.traceId,
          ts: trace.ts,
          durationMs: trace.durationMs ?? 0,
          success: trace.success ?? false,
          sequenceIndex,
          error: trace.error,
        });
        sequenceIndex++;
      }
    }

    return invocations;
  }

  /**
   * Terminate the Worker and cleanup resources
   * Story 7.3b: Also closes BroadcastChannel
   */
  terminate(): void {
    // Cancel pending RPC calls
    for (const [id, pending] of this.pendingRPCs) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Worker terminated"));
      this.pendingRPCs.delete(id);
    }

    // Terminate worker
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;

      // Emit sandbox.worker.terminated event
      eventBus.emit({
        type: "sandbox.worker.terminated",
        source: "worker-bridge",
        payload: {
          tracesCount: this.traces.length,
        },
      });
    }

    // Note: Don't close traceChannel here - it may be reused for next execution
    // The channel is closed when WorkerBridge is garbage collected

    logger.debug("WorkerBridge terminated", { tracesCount: this.traces.length });
  }

  /**
   * Cleanup resources (call when WorkerBridge is no longer needed)
   * Story 7.3b: Closes BroadcastChannel
   */
  cleanup(): void {
    this.terminate();
    this.traceChannel.close();
    logger.debug("WorkerBridge cleanup complete");
  }
}
