---
stepsCompleted: [
  "step-01-validate-prerequisites",
  "step-02-design-epics",
  "step-03-create-stories",
  "step-04-final-validation",
]
status: complete
inputDocuments:
  - docs/spikes/2025-12-18-speculative-execution-arguments.md
  - docs/epics/epic-10-dag-capability-learning-unified-apis.md
  - docs/epics/epic-11-learning-from-traces.md
---

# Procedural Memory Layer (PML) - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Epic 12: Speculative Execution with
Arguments, decomposing the requirements from the spike document into implementable stories.

### Clarification Terminologique (2025-12-22)

| Concept         | Fonction               | Quand          | Algo              | Ce que c'est                                 |
| --------------- | ---------------------- | -------------- | ----------------- | -------------------------------------------- |
| **Speculation** | `speculateNextLayer()` | Intra-workflow | Aucun (DAG connu) | Pré-exécuter les tasks connues du DAG        |
| **Prediction**  | `predictNextNode()`    | Post-workflow  | SHGAT + DR-DSP    | Prédire la prochaine action de l'utilisateur |

**Distinction clé:**

- **Intra-workflow**: Le DAG est déjà défini (`static_structure`). On ne "prédit" rien, on
  pré-exécute les tasks connues pour gagner du temps.
- **Post-workflow**: L'utilisateur a terminé un workflow. Que va-t-il faire ensuite? ICI on a besoin
  de vraie prédiction (SHGAT + DR-DSP).

## Requirements Inventory

### Functional Requirements

FR1: Initialize WorkflowPredictionState.context with initial execution arguments at workflow start
FR2: Accumulate task results in context after each task execution (context[taskId] = result) FR3:
Resolve static argument definitions (from 10.2) to actual values at runtime (literal→value,
reference→context lookup, parameter→initial args) FR4: Generate real MCP tool calls in speculative
execution (replace placeholder) FR5: Implement security guards (`canSpeculate()`) based on tool
permissions FR6: Lookup ProvidesEdge at speculation time for field-to-field mappings FR7: Support
post-workflow capability prefetching for likely next capabilities FR8: Enable speculation during
per_layer validation pauses (when next layer is safe) FR9: Skip speculation only when argument
cannot be resolved (reference to unexecuted task OR missing parameter) FR10: Validate speculated
results against actual execution (cache hit/miss) FR11: Pass WorkerBridge to SpeculativeExecutor for
real calls (via RPC, 100% traçabilité)

### NonFunctional Requirements

NFR1: Speculative execution must not cause side effects (read-only tools only) NFR2: Speculation
cache should have configurable TTL (default 5 minutes) NFR3: Speculation should add minimal latency
to standard execution path NFR4: Security: If `requiresValidation()` returns true, NO speculation
allowed NFR5: Speculation results must be JSON-serializable for caching

### Additional Requirements

**From Architecture (Epic 10/11 context):**

- **Story 10.2 (Static Argument Extraction) is prerequisite** - provides
  `static_structure.nodes[].arguments` with type info (literal/reference/parameter)
- **Story 10.3 (ProvidesEdge)** provides field mappings for data flow between tools
- `WorkflowPredictionState.context` already exists - just needs to be populated
- ~~`createToolExecutor(mcpClients)` already exists in `workflow-execution-handler.ts:112-122`~~
  **OBSOLÈTE:** Doit être modifié pour utiliser `WorkerBridge` (voir Story 10.5 Architecture
  Unifiée)

**From Spike Security Analysis:**

- Safe to speculate: `read_file`, `list_dir`, `search`, `parse_json`, `format`
- NOT safe: `github:push`, `write_file`, `delete_file`, `http POST/PUT/DELETE`
- Rule: Same criteria as `requiresValidation()` - if needs validation, no speculation

**From Spike Execution Modes:**

- Standard execution (high confidence): DAG runs to completion = implicit speculation
- per_layer execution: CAN speculate during checkpoint pause IF next layer is safe
- Post-workflow prefetch: Preload next likely capabilities after workflow completion

### FR Coverage Map

| FR   | Epic    | Description                              |
| ---- | ------- | ---------------------------------------- |
| FR1  | Epic 12 | Initialize context with initial args     |
| FR2  | Epic 12 | Accumulate task results in context       |
| FR3  | Epic 12 | Resolve static args to runtime values    |
| FR4  | Epic 12 | Generate real MCP tool calls             |
| FR5  | Epic 12 | Security guards (canSpeculate)           |
| FR6  | Epic 12 | ProvidesEdge field mappings              |
| FR7  | Epic 12 | Post-workflow prefetching                |
| FR8  | Epic 12 | per_layer speculation                    |
| FR9  | Epic 12 | Skip when args unresolved                |
| FR10 | Epic 12 | Cache hit/miss validation                |
| FR11 | Epic 12 | Pass toolExecutor to SpeculativeExecutor |

## Epic List

### Epic 12: Speculative Execution with Arguments

**Goal:** Permettre au système de pré-exécuter les prochains tools/capabilities avec les vrais
arguments, réduisant la latence à ~0ms sur cache hit tout en garantissant la sécurité (pas de side
effects).

**User Value:**

- L'agent AI obtient des résultats instantanés pour les outils prédits correctement
- Le système apprend des patterns d'exécution pour améliorer les prédictions
- Sécurité garantie: seuls les outils read-only sont spéculés

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9, FR10, FR11

**NFRs addressed:** NFR1, NFR2, NFR3, NFR4, NFR5

**Dependencies:**

- Story 10.2 (Static Argument Extraction) - prerequisite
- Story 10.3 (ProvidesEdge) - prerequisite
- Story 10.5 (Architecture Unifiée WorkerBridge) - prerequisite

**Dependents (Stories qui utilisent Epic 12):**

- Story 10.7 AC16-17 (Speculation Automatique avec Session Context) - utilise Epic 12 pour:
  - Session Context Management (stockage résultats workflows précédents)
  - canSpeculate() (Story 12.3)
  - ProvidesEdge matching pour résolution automatique des arguments

---

## Epic 12: Speculative Execution with Arguments

> **⚠️ CLARIFICATION ARCHITECTURE (2025-12-19)**
>
> **Exécution spéculative:** Utilise le même chemin que l'exécution normale - **WorkerBridge RPC**.
>
> **Ce que cela signifie:**
>
> - `toolExecutor` dans Story 12.4 doit utiliser `WorkerBridge`, pas `client.callTool()` direct
> - Les résultats spéculatifs sont capturés via le même système de traces que Epic 11
> - 100% traçabilité, même pour l'exécution spéculative
>
> **Prérequis:** Story 10.5 (Architecture Unifiée) complétée. Voir:
> `docs/sprint-artifacts/10-5-execute-code-via-dag.md#architecture-unifiée-2025-12-19`

Permettre au système de pré-exécuter les prochains tools/capabilities avec les vrais arguments,
réduisant la latence à ~0ms sur cache hit tout en garantissant la sécurité (pas de side effects).

---

### Story 12.1: Context Initialization & Result Accumulation

**As a** speculative execution system, **I want** to store initial execution arguments and
accumulate task results in WorkflowPredictionState.context, **So that** I have all the data needed
to resolve arguments for speculative execution.

**FRs covered:** FR1, FR2

**Acceptance Criteria:**

**Given** a workflow is started with `pml_execute({ context: { path: "/file.txt" } })` **When** the
workflow execution begins **Then** `WorkflowPredictionState.context` is initialized with
`{ path: "/file.txt" }` **And** the initial arguments are accessible for parameter resolution

**Given** a task completes successfully with a result **When** the task execution ends **Then** the
result is stored in `context[taskId]` **And** the result is available for reference resolution in
subsequent predictions

**Given** a task fails with an error **When** the task execution ends **Then** the error is stored
in `context[taskId].error` **And** speculation is skipped for nodes depending on this task's output

**--- Data Sanitization (Runtime Results) ---**

**Given** MCP tool results are stored in context **When** sanitizing for storage **Then** sensitive
patterns (API keys, tokens) are redacted as `[REDACTED]` **And** non-JSON types (Date, BigInt) are
serialized properly **And** total payload > 10KB returns `{ _truncated: true, _originalSize: N }`
**Note:** Circular refs already handled by static analysis (Epic 10.1)

**Given** workflow completes successfully **When** persisting to execution_trace (Epic 11
dependency) **Then** `initial_context` is stored (sanitized) **And** `task_results[].args` and
`task_results[].result` are stored (sanitized)

**Files to create:**

- `src/utils/sanitize-for-storage.ts` - Sanitization utility (~50 LOC)

**Files to modify:**

- `src/speculation/speculative-executor.ts` - Add context initialization
- `src/dag/controlled-executor.ts` - Accumulate results after each task

**Epic 11 dependency:** Story 12.1 requires Epic 11.2 (`execution_trace` with `initial_context` and
`task_results[].args`)

**Estimation:** 1.5 jours

---

### Story 12.2: Argument Resolver

**As a** speculative execution system, **I want** to resolve static argument definitions (from Story
10.2) to actual runtime values, **So that** I can execute tools/capabilities speculatively with
correct arguments.

**FRs covered:** FR3, FR6, FR9

**Acceptance Criteria:**

**Given** a predicted node with `arguments: { path: { type: "literal", value: "config.json" } }`
**When** resolving arguments **Then** the resolved value is `{ path: "config.json" }`

**Given** a predicted node with
`arguments: { input: { type: "reference", expression: "task_0.content" } }` **When** resolving
arguments and `context["task_0"] = { content: "file data" }` **Then** the resolved value is
`{ input: "file data" }`

**Given** a predicted node with
`arguments: { filePath: { type: "parameter", parameterName: "path" } }` **When** resolving arguments
and initial context contains `{ path: "/my/file.txt" }` **Then** the resolved value is
`{ filePath: "/my/file.txt" }`

**Given** a reference argument pointing to an unexecuted task **When** resolving arguments **Then**
resolution returns `null` (skip speculation) **And** the prediction is marked as `unresolvable`

**Given** a parameter argument not provided in initial context **When** resolving arguments **Then**
resolution returns `null` (skip speculation)

**Given** tools connected by a ProvidesEdge with fieldMapping **When** resolving reference arguments
**Then** use fieldMapping to map `fromField` → `toField` correctly

**Files to create:**

- `src/speculation/argument-resolver.ts` (~150 LOC)

**Files to modify:**

- `src/graphrag/dag-suggester.ts` - Call resolver in `predictNextNodes()`

**Estimation:** 2 jours

---

### Story 12.3: Security Guard (canSpeculate)

**As a** speculative execution system, **I want** to verify that a tool/capability is safe to
execute speculatively, **So that** speculation never causes unintended side effects.

**FRs covered:** FR5 **NFRs addressed:** NFR1, NFR4

**Acceptance Criteria:**

**Given** a tool with `scope: "minimal"` and `approvalMode: "auto"` **When** checking
`canSpeculate(toolId)` **Then** returns `true` (safe to speculate)

**Given** a tool with `approvalMode: "hil"` (human-in-the-loop required) **When** checking
`canSpeculate(toolId)` **Then** returns `false` (not safe)

**Given** an unknown tool (not in `mcp-permissions.yaml`) **When** checking `canSpeculate(toolId)`
**Then** returns `false` (not safe - unknown tools require validation)

**Given** a tool that modifies external state (`github:push`, `write_file`, `delete_file`) **When**
checking `canSpeculate(toolId)` **Then** returns `false` (not safe)

**Given** a read-only tool (`read_file`, `list_dir`, `search`, `parse_json`) **When** checking
`canSpeculate(toolId)` **Then** returns `true` (safe)

**Given** `requiresValidation(toolId)` returns `true` **When** checking `canSpeculate(toolId)`
**Then** returns `false` (same criteria)

**Given** a capability containing only safe tools **When** checking `canSpeculate(capabilityId)`
**Then** returns `true`

**Given** a capability containing at least one unsafe tool **When** checking
`canSpeculate(capabilityId)` **Then** returns `false`

**Files to create:**

- `src/speculation/speculation-guard.ts` (~80 LOC)

**Files to modify:**

- `src/speculation/speculative-executor.ts` - Use guard before execution

**Estimation:** 1 jour

---

### Story 12.4: Real Speculative Execution

**As a** speculative execution system, **I want** to execute predicted tools/capabilities with real
MCP calls, **So that** results are cached and available instantly on prediction hit.

**FRs covered:** FR4, FR7, FR11 **NFRs addressed:** NFR3

**Acceptance Criteria:**

**Given** a predicted tool with resolved arguments and `canSpeculate() = true` **When** speculation
is triggered **Then** `toolExecutor(toolId, resolvedArgs)` is called via **WorkerBridge RPC**
**And** result is captured for caching **And** execution trace is captured (100% traçabilité)

**Given** a predicted capability with resolved arguments and `canSpeculate() = true` **When**
speculation is triggered **Then** capability code is executed in sandbox via **WorkerBridge** with
resolved args **And** result is captured for caching

**Given** `SpeculativeExecutor` is instantiated **When** initializing **Then** `WorkerBridge`
instance is injected (NOT direct `mcpClients`) **And** real MCP calls go through Worker RPC proxy

**Given** `generateSpeculationCode()` is called **When** generating execution code **Then** returns
actual tool/capability invocation (not preparation metadata)

**--- Trigger: Intra-Workflow (speculation sur DAG connu) ---**

**Given** a task completes within a workflow **When** `onTaskComplete(task, result)` fires **Then**
`speculateNextLayer()` is called (PAS de prédiction - DAG connu) **And** next layer tasks from
`static_structure` are pre-executed if safe

**Note:** Intra-workflow = pré-exécution du DAG connu, pas de SHGAT/DR-DSP.

**--- Trigger: Post-Workflow (vraie prédiction) ---**

**Given** a workflow completes successfully **When** `onWorkflowComplete(workflowResult)` fires
**Then** `predictNextNode()` is called (SHGAT + DR-DSP - Story 10.7a/b) **And** predicted
capabilities are speculatively executed with workflow context **And** results cached for instant
response si l'utilisateur demande

**Note:** Post-workflow = vraie prédiction. Utilise les algos de 10.7a/b.

**--- Deux mécanismes distincts ---**

| Trigger           | Fonction               | Input           | Algo              |
| ----------------- | ---------------------- | --------------- | ----------------- |
| Task complete     | `speculateNextLayer()` | DAG + context   | Aucun (DAG connu) |
| Workflow complete | `predictNextNode()`    | Workflow result | SHGAT + DR-DSP    |

**Given** speculation/prediction returns candidates **When** executing speculatively **Then** same
execution logic handles both:

- Resolve arguments from context
- Check `canSpeculate()`
- Execute via `WorkerBridge`
- Cache result

**Files to modify:**

- `src/speculation/speculative-executor.ts` - Replace placeholder, inject **WorkerBridge** (not
  mcpClients) (~100 LOC)
- `src/dag/controlled-executor.ts` - Add `onTaskComplete` trigger
- `src/mcp/handlers/workflow-execution-handler.ts` - Add `onWorkflowComplete` trigger

**Note:** Requires Story 10.5 "Architecture Unifiée" to be completed first (WorkerBridge integration
in ControlledExecutor).

**Estimation:** 3 jours

---

### Story 12.5: Speculation Cache & Validation

**As a** speculative execution system, **I want** to cache speculated results and validate them
against actual execution, **So that** I can serve instant results on cache hit and learn from
prediction accuracy.

**FRs covered:** FR10 **NFRs addressed:** NFR2, NFR5

**Acceptance Criteria:**

**Given** a speculative execution completes successfully **When** storing result **Then** result is
cached with key `{ toolId/capabilityId, argsHash }` **And** TTL is applied (configurable, default 5
minutes)

**Given** actual execution is requested for a tool/capability **When** checking cache **Then**
lookup uses same key `{ toolId/capabilityId, argsHash }`

**Given** cache hit with matching args **When** serving result **Then** cached result is returned
immediately (~0ms latency) **And** actual execution is skipped

**Given** cache hit but args differ **When** validating **Then** cache miss, execute normally
**And** update cache with new result

**Given** cache miss (no speculated result) **When** execution completes **Then** result is NOT
cached (only speculated results are cached)

**--- Validation & Learning ---**

**Given** speculation was correct (cache hit used) **When** tracking metrics **Then** increment
`speculation_hits` counter **And** record prediction confidence for learning

**Given** speculation was wrong (cache miss or different result) **When** tracking metrics **Then**
increment `speculation_misses` counter **And** log prediction details for analysis

**--- Serialization ---**

**Given** a speculated result **When** caching **Then** result is JSON-serializable **And** circular
references are handled (error or sanitized)

**Given** cache TTL expires **When** accessing cached result **Then** returns cache miss **And**
entry is evicted

**Files to create:**

- `src/speculation/speculation-cache.ts` (~100 LOC)

**Files to modify:**

- `src/speculation/speculative-executor.ts` - Integrate cache
- `src/graphrag/metrics/collector.ts` - Add speculation metrics

**Estimation:** 2 jours

---

### Story 12.6: Per-Layer Speculation

**As a** speculative execution system, **I want** to speculatively execute the next layer during
per_layer validation pauses, **So that** results are ready instantly when the agent continues.

**FRs covered:** FR8

**Note terminologique:** Cette story utilise `speculateNextLayer()` (pas `predictNextNode()`) car le
DAG est connu - on pré-exécute, on ne prédit pas.

**Acceptance Criteria:**

**Given** workflow running with `per_layer_validation: true` **When** a layer completes and
checkpoint pause begins **Then** `speculateNextLayer()` is called (DAG connu, pas de prédiction)
**And** safe nodes from next layer are pre-executed during the pause

**Given** checkpoint pause with next layer containing safe tools only **When** speculation runs
**Then** all next layer nodes are speculatively executed **And** results are cached

**Given** checkpoint pause with next layer containing unsafe tool **When** speculation runs **Then**
only safe tools in next layer are speculatively executed **And** unsafe tools are skipped (await
actual execution)

**Given** agent calls `pml_continue(workflow_id)` **When** resuming execution **Then** check cache
for next layer results **And** serve cached results on hit (instant)

**Given** agent calls `pml_replan(workflow_id, newDag)` **When** DAG is modified during pause
**Then** invalidate speculated results for old next layer **And** optionally speculate new next
layer

**--- Integration with AIL ---**

**Given** AIL is enabled with `decision_points: "per_layer"` **When** decision_required event fires
**Then** speculation can run in parallel with agent decision **And** if agent chooses "continue",
results are ready

**Given** agent chooses "abort" or "replan" **When** speculation was running **Then** speculated
results are discarded **And** no side effects occurred (safe tools only)

**Files to modify:**

- `src/dag/controlled-executor.ts` - Add speculation trigger on checkpoint
- `src/mcp/handlers/workflow-execution-handler.ts` - Integrate with per_layer flow
- `src/speculation/speculative-executor.ts` - Handle layer-based speculation

**Estimation:** 2 jours

---

## Epic 12 Summary

| Story | Titre                                        | FRs            | Estimation |
| ----- | -------------------------------------------- | -------------- | ---------- |
| 12.1  | Context Initialization & Result Accumulation | FR1, FR2       | 1.5j       |
| 12.2  | Argument Resolver                            | FR3, FR6, FR9  | 2j         |
| 12.3  | Security Guard (canSpeculate)                | FR5            | 1j         |
| 12.4  | Real Speculative Execution                   | FR4, FR7, FR11 | 3j         |
| 12.5  | Speculation Cache & Validation               | FR10           | 2j         |
| 12.6  | Per-Layer Speculation                        | FR8            | 2j         |
| 12.7  | Argument-Aware Learning                      | (ext FR2)      | 2-3j       |

**Total Epic 12: ~14 jours**

**Dependencies:**

```
Epic 10.2 (Static Argument Extraction) ──┐
Epic 10.3 (ProvidesEdge) ────────────────┼──→ 12.1 → 12.2 → 12.3 → 12.4 → 12.5
Epic 10.5 (Architecture Unifiée) ────────┤                            ↓
Epic 11.2 (execution_trace) ─────────────┘                          12.6

Note: Story 10.5 est CRITIQUE - sans WorkerBridge, pas de traçabilité des exécutions spéculatives.
```

---

### Story 12.7: Argument-Aware Learning

**As a** learning system, **I want** to learn from argument patterns in execution traces, **So
that** SHGAT can predict success/failure based on argument types and values.

**FRs covered:** (extension de FR2) **NFRs addressed:** NFR5 (JSON-serializable)

**Context utilisé:** `initialContext` + `taskResults[].args`

**Ce qu'on apprend:**

- "Quand args.path = *.json → 90% succès"
- "Quand args.channel = #prod → plus de risque d'échec"
- Patterns d'arguments qui influencent le succès

**Acceptance Criteria:**

**Given** execution traces with `taskResults[].args` stored **When** extracting argument features
**Then** `ArgumentPattern` is computed for each trace **And** patterns are stored for learning

**Given** a set of traces with argument patterns **When** training SHGAT **Then** argument features
influence the training **And** SHGAT can predict better based on arg types

**Given** a new execution with similar arguments to past successes **When** SHGAT scores
capabilities **Then** score is boosted by argument pattern match

**Dépendances:**

- Story 12.1 (Context Initialization) - stocke `initial_context`
- Story 12.2 (Argument Resolver) - résout les args

**Files to create:**

- `src/graphrag/learning/argument-features.ts` (~100 LOC)

**Files to modify:**

- `src/graphrag/learning/per-training.ts` - Integrate argument features
- `src/graphrag/algorithms/shgat.ts` - Accept argument features in training

**Implementation notes:**

```typescript
interface ArgumentPattern {
  hasFilePath: boolean; // args contient un path
  fileExtension?: string; // .json, .xml, .txt
  hasChannelRef: boolean; // args contient un channel
  argCount: number; // nombre d'arguments
}

// Feature engineering sur les args pour enrichir le training
function extractArgumentFeatures(args: Record<string, JsonValue>): ArgumentPattern;
```

**Estimation:** 2-3 jours

---

## Epic 11 Updates Required

Pour supporter Epic 12 (post-workflow speculation), Epic 11.2 doit inclure:

**Nouveau champ dans `execution_trace`:**

```sql
ALTER TABLE execution_trace ADD COLUMN initial_context JSONB DEFAULT '{}';
```

**Structure enrichie de `task_results`:**

```typescript
// JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
task_results: [
  {
    taskId: string,
    tool: string,
    args: Record<string, JsonValue>, // ← NOUVEAU
    result: JsonValue,
    success: boolean,
    durationMs: number,
  },
];
```

**Data Sanitization (shared utility):**

- `src/utils/sanitize-for-storage.ts` - utilisé par Epic 11 ET Epic 12
- Redact sensitive data, truncate large payloads, handle circular refs

---

## Architecture Decision Records (ADRs) - Epic 12

### ADR-12.1: Unified Speculation Mechanism

**Decision:** Mécanisme unifié pour intra-workflow et post-workflow speculation.

**Rationale:**

- Même flow: resolve args → canSpeculate → execute → cache
- Seule différence: source de prédiction (DAG vs patterns)
- Réduit duplication et surface de bugs

### ADR-12.2: Storage Strategy

**Decision:** Utiliser `execution_trace` de Epic 11 (PostgreSQL).

**Rationale:**

- Epic 11 stocke déjà `task_results`
- Ajout de `initial_context` et `task_results[].args` suffisant
- Pas de duplication, données disponibles pour learning ET speculation

### ADR-12.3: Security Model

**Decision:** Réutiliser `requiresValidation()` pour `canSpeculate()`.

**Rationale:**

- Logique déjà implémentée et testée
- Cohérence: si HIL requis → pas de speculation
- Pas de nouveau schema à maintenir

### ADR-12.4: Confidence Threshold

**Decision:** Réutiliser `AdaptiveThresholdManager` existant.

**Rationale:**

- Déjà implémenté (`src/mcp/adaptive-threshold.ts`)
- Apprend des false positives/negatives
- `SpeculationManager` l'utilise déjà

### ADR-12.5: Argument Resolution

**Decision:** 3-type resolution avec skip si non résolvable.

| Type        | Source                     | Fallback |
| ----------- | -------------------------- | -------- |
| `literal`   | static_structure           | N/A      |
| `reference` | context[taskId].result     | Skip     |
| `parameter` | initial_context[paramName] | Skip     |

### ADR-12.6: Data Sanitization

**Decision:** Shared utility pour Epic 11 et 12.

- Circular refs: Handled by static analysis (Epic 10.1)
- Sensitive data: Redact patterns (API keys, tokens)
- Large payloads: Truncate > 10KB
- Non-JSON types: Serialize properly
