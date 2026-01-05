# ADR-018: Command Handlers Minimalism - Unified Control Plane

**Status:** ⛔ Superseded **Date:** 2025-11-24 | **Superseded by:** ADR-020 (2025-11-25)

> See **ADR-020: AIL Control Protocol** for the consolidated architecture.

> **⚠️ ARCHITECTURE UPDATE 2025-11-25:** The 4 command handlers serve **two purposes**:
>
> 1. **Level 1 (External MCP agents)**: Exposed as MCP meta-tools (`pml:continue`, `pml:abort`,
>    `pml:replan_dag`, `pml:approval_response`)
> 2. **Level 2 (Internal native agents)**: Used via CommandQueue for async control

## Context

### Problem Statement

During implementation of Epic 2.5 (Adaptive DAG Feedback Loops), we discovered:

1. **Story 2.5-3** implemented SSE pattern with command queue
2. **Original intent**: External agent (Claude Code MCP) would enqueue commands
3. **Reality**: MCP one-shot protocol prevents external agents from receiving SSE events
4. **Discovery**: Commands still valuable for **internal native agents** (ADR-019 Level 2)

### Use Cases for Commands

**Level 1 - External MCP agents (Claude Code)**:

- ✅ Via MCP meta-tools: `pml:continue`, `pml:abort`, `pml:replan_dag`, `pml:approval_response`
- ✅ HTTP Request/Response pattern (MCP compatible)

**Level 2 - Internal native agents (JS/TS in Gateway)**:

- ✅ Via CommandQueue (async message passing)
- ✅ SSE events + Commands pattern
- ✅ Multi-agent collaboration
- ✅ Background autonomous workflows
- ✅ Rule-based decision engines
- ✅ LLM agents via API directe

**NOT for**:

- ❌ Embedded MCP agents (agent delegation tasks) - use task output (ADR-019 Level 3)

### Evidence-Based Analysis

**Documents analyzed:**

1. `docs/architecture.md` - Details `replan_dag` as primary mechanism
2. `docs/spikes/spike-agent-human-dag-feedback-loop.md` - Proposes 6 commands, tests 1
3. `docs/stories/story-2.5-4.md` - Proposes 8 handlers (4 existing + 4 new)
4. **Comprehensive discussion 2025-11-24**: Identified internal agent use cases

**Key Insight:** Commands = **internal control plane** for native agents, not external MCP
communication.

---

## Decision

### Core Principle: Commands as Internal Control Plane

**We adopt a minimalist command handler set (4 commands) for internal native agent control. Commands
enable autonomous agents (Level 2 AIL) to control workflow execution via async message passing.**

### Architecture Context

Commands fit into **ADR-019 Level 2 AIL** (Runtime AIL with Internal Native Agents):

```typescript
// Level 2: Internal native agent (NO MCP)
class InternalAgent {
  async decide(context) {
    // Native JS/TS code
    if (context.errors.length > 5) {
      return { action: "abort", reason: "Too many errors" };
    }
    return { action: "continue" };
  }
}

// Gateway executes with internal agent
const stream = executor.executeStream(dag);
for await (const event of stream) {
  if (event.type === "decision_required") {
    // ✅ Internal agent receives SSE (no MCP limitation)
    const decision = await internalAgent.decide(event);

    // ✅ Agent enqueues command (internal control plane)
    commandQueue.enqueue({
      type: decision.action,
      ...decision.params,
    });
  }
}
```

**Key difference from external agents:**

- External MCP agents: Cannot receive SSE → Use Gateway HTTP (Level 1)
- Internal native agents: Can receive SSE → Use commands (Level 2)

---

## Approved Command Handlers (4 only)

### 1. `continue` - Resume Control

```typescript
interface ContinueCommand {
  type: "continue";
  reason?: string;
}
```

**Purpose**: Internal agent signals workflow should continue **Use Case**:

- ✅ Internal agent validates layer results → continue
- ✅ Multi-agent consensus → continue
- ✅ Rule-based decision engine → conditions met → continue **Status**: ✅ Implemented (Story 2.5-3)

**Example**:

```typescript
// Internal rule-based agent
class RuleBasedAgent {
  decide(context) {
    if (this.validationPasses(context)) {
      return { type: "continue", reason: "Validation passed" };
    }
  }
}
```

---

### 2. `abort` - Workflow Termination

```typescript
interface AbortCommand {
  type: "abort";
  reason: string;
}
```

**Purpose**: Internal agent signals workflow should terminate **Use Case**:

- ✅ Internal agent detects unrecoverable error → abort
- ✅ Security agent detects threat → abort
- ✅ Cost agent exceeds budget → abort **Status**: ✅ Implemented (Story 2.5-3)

**Example**:

```typescript
// Multi-agent with security agent
class SecurityAgent {
  async decide(context) {
    const threat = await this.detectThreat(context);
    if (threat.severity === "critical") {
      return {
        type: "abort",
        reason: `Security threat detected: ${threat.description}`,
      };
    }
  }
}
```

---

### 3. `replan_dag` - Dynamic Workflow Adaptation (PRIMARY)

```typescript
interface ReplanDAGCommand {
  type: "replan_dag";
  new_requirement: string; // Natural language goal
  available_context: Record<string, unknown>; // Discovered data
}
```

**Purpose**: Internal agent triggers workflow replanning via GraphRAG **Use Case**:

- ✅ Progressive discovery (agent finds XML → replan to add parser)
- ✅ Error recovery (agent detects API failure → replan with fallback)
- ✅ Optimization (performance agent suggests better tools) **Implementation**:
  `DAGSuggester.replanDAG()` queries knowledge graph **Status**: ✅ Implemented, tested

**Why This is Better**:

- Intent-based (natural language) not manual task construction
- Uses GraphRAG intelligence (learns patterns over time)
- Type-safe (GraphRAG validates tools exist)
- Optimized paths (PageRank ranking)

**Example**:

```typescript
// Internal agent with progressive discovery
class DiscoveryAgent {
  async decide(context) {
    const files = context.layerResults.files;
    const hasXML = files.some((f) => f.endsWith(".xml"));

    if (hasXML && !this.hasXMLParser(context)) {
      return {
        type: "replan_dag",
        new_requirement: "Parse XML files discovered in directory",
        available_context: {
          xml_files: files.filter((f) => f.endsWith(".xml")),
        },
      };
    }
  }
}
```

---

### 4. `approval_response` - Human-in-the-Loop

```typescript
interface ApprovalResponseCommand {
  type: "approval_response";
  checkpoint_id: string;
  approved: boolean;
  feedback?: string;
}
```

**Purpose**: Human approval/rejection at HIL checkpoints **Use Case**: Critical operations (DELETE,
WRITE), safety validation **Status**: ✅ Implemented, tested

**Note**: HIL is hybrid pattern:

- Internal agent can enqueue approval_response for automated HIL
- Human can also enqueue via admin UI
- Both use same command interface

---

## MCP Meta-Tools (Level 1 External Agents)

The 4 commands are exposed as MCP meta-tools for external agents (Claude Code):

### Tool: `pml:continue`

```typescript
{
  name: "pml:continue",
  description: "Continue workflow execution to next layer",
  inputSchema: {
    type: "object",
    properties: {
      workflow_id: { type: "string", description: "Workflow ID from execute_workflow" },
      reason: { type: "string", description: "Optional reason for continuing" }
    },
    required: ["workflow_id"]
  }
}
```

### Tool: `pml:abort`

```typescript
{
  name: "pml:abort",
  description: "Abort workflow execution",
  inputSchema: {
    type: "object",
    properties: {
      workflow_id: { type: "string", description: "Workflow ID from execute_workflow" },
      reason: { type: "string", description: "Reason for aborting" }
    },
    required: ["workflow_id", "reason"]
  }
}
```

### Tool: `pml:replan_dag`

```typescript
{
  name: "pml:replan_dag",
  description: "Replan workflow with new requirement (triggers GraphRAG)",
  inputSchema: {
    type: "object",
    properties: {
      workflow_id: { type: "string", description: "Workflow ID from execute_workflow" },
      new_requirement: { type: "string", description: "Natural language description of new tasks needed" },
      available_context: { type: "object", description: "Context data for replanning (e.g., discovered files)" }
    },
    required: ["workflow_id", "new_requirement"]
  }
}
```

### Tool: `pml:approval_response`

```typescript
{
  name: "pml:approval_response",
  description: "Respond to HIL (Human-in-the-Loop) approval checkpoint",
  inputSchema: {
    type: "object",
    properties: {
      workflow_id: { type: "string", description: "Workflow ID from execute_workflow" },
      checkpoint_id: { type: "string", description: "Checkpoint ID requiring approval" },
      approved: { type: "boolean", description: "true to approve, false to reject" },
      feedback: { type: "string", description: "Optional feedback or reason" }
    },
    required: ["workflow_id", "checkpoint_id", "approved"]
  }
}
```

### External Agent Flow (Claude Code)

```typescript
// 1. Start workflow with per-layer validation
let response = await pml.execute_workflow({
  intent: "Analyze codebase for security issues",
  config: { per_layer_validation: true },
});

// 2. Loop until complete
while (response.status === "layer_complete") {
  // Agent analyzes layer results
  const analysis = analyzeResults(response.layer_results);

  if (analysis.needsMoreTools) {
    // Replan: Add new tools based on discovery
    response = await pml.replan_dag({
      workflow_id: response.workflow_id,
      new_requirement: "Add XML parser for config files",
      available_context: { xml_files: analysis.discoveredFiles },
    });
  } else if (analysis.criticalIssue) {
    // Abort: Stop execution
    response = await pml.abort({
      workflow_id: response.workflow_id,
      reason: "Critical security issue found",
    });
    break;
  } else {
    // Continue: Proceed to next layer
    response = await pml.continue({
      workflow_id: response.workflow_id,
    });
  }
}

// 3. Final results
console.log("Workflow complete:", response.results);
```

---

## Clarification: Two Types of Checkpoints

Il y a **deux mécanismes de checkpoint distincts** dans l'architecture :

### Type 1: Fault Tolerance Checkpoints (Story 2.5-2)

**But:** Sauvegarder l'état du workflow pour reprendre après un crash ou une interruption.

```
Layer 0 → [Checkpoint sauvegardé] → Layer 1 → [Checkpoint] → CRASH
                                                    ↓
                                        Resume depuis ce checkpoint
```

**Réponse:** `checkpoint_response`

```typescript
{
  type: "checkpoint_response",
  checkpoint_id: string,
  decision: "continue" | "rollback" | "modify",
  modifications?: Record<string, unknown>
}
```

**Use cases:**

- `continue` - reprendre l'exécution normalement
- `rollback` - revenir à un état précédent (ex: layer N-1)
- `modify` - modifier le state avant de reprendre

**Stockage:** PGlite (5 derniers checkpoints par workflow)

---

### Type 2: HIL Approval Checkpoints (Story 2.5-3)

**But:** Demander l'approbation humaine avant une opération dangereuse ou critique.

```
Layer 2 → [PAUSE: "About to DELETE 500 files"] → Humain approuve → Layer 3
```

**Réponse:** `approval_response`

```typescript
{
  type: "approval_response",
  checkpoint_id: string,
  approved: boolean,
  feedback?: string
}
```

**Use cases:**

- `approved: true` - oui, continue l'opération
- `approved: false` - non, abort le workflow

**Déclencheurs:** Opérations avec `side_effects: true`, DELETE, WRITE, etc.

---

### Différence clé

| Aspect          | Fault Tolerance            | HIL Approval               |
| --------------- | -------------------------- | -------------------------- |
| **But**         | Reprise après crash        | Sécurité opérationnelle    |
| **Déclencheur** | Automatique (chaque layer) | Opération critique         |
| **Qui répond**  | Système ou agent           | Humain (ou agent autorisé) |
| **Options**     | continue/rollback/modify   | approved yes/no            |
| **Command**     | `checkpoint_response`      | `approval_response`        |

**Ces deux mécanismes ne sont PAS redondants** - ils adressent des besoins différents.

---

## Deferred Command Handlers (Explicit YAGNI)

### ❌ `inject_tasks` - DEFERRED (not redundant)

**Original reason:** Pensé redondant avec `replan_dag` (intent-based)

**Révision 2025-11-25:** `inject_tasks` n'est PAS redondant - il permet à l'agent de contrôler
précisément les tasks à ajouter quand il connaît les tools disponibles.

| Command        | Qui décide | Use case                                                         |
| -------------- | ---------- | ---------------------------------------------------------------- |
| `replan_dag`   | GraphRAG   | Agent dit "j'ai besoin de parser XML" → GraphRAG choisit le tool |
| `inject_tasks` | Agent      | Agent connaît le tool exact et construit la task manuellement    |

**Status:** Déféré (YAGNI) mais pourrait être ajouté si besoin prouvé.

**Reconsider if:** >5 use cases où l'agent veut contrôle précis sans GraphRAG

---

### ❌ `skip_layer` - DEFERRED

**Reason**: Safe-to-fail pattern (Epic 3.5) couvre ce use case

**Example**:

```typescript
// INSTEAD OF: Explicit skip command
commandQueue.enqueue({ type: "skip_layer", target: "next" });

// USE: Safe-to-fail task pattern
{
  id: "visualize",
  tool: "viz:create",
  side_effects: false,  // ← Safe-to-fail
  depends_on: ["analyze"]
}
// → If analyze fails, visualize skips naturally
```

**Reconsider if:** >5 proven use cases where conditional skip needed

---

### ❌ `modify_args` - DEFERRED

**Reason**: Pas de workflow HIL correction prouvé pour le moment

**Use case potentiel:**

```typescript
// HIL correction: Human veut modifier les args avant exécution
commandQueue.enqueue({
  type: "modify_args",
  task_id: "create_issue",
  new_arguments: { assignee: "correct-username" },
});
```

**Reconsider if:** >3 user requests for runtime argument modification

---

### ❌ `retry_task` - DEFERRED

**Reason**: Géré automatiquement par l'executor (retry avec backoff)

**Use case potentiel:**

```typescript
// Manual retry avec config custom
commandQueue.enqueue({
  type: "retry_task",
  task_id: "api_call",
  backoff_ms: 5000,
});
```

**Reconsider if:** >3 use cases où retry automatique insuffisant

---

### ✅ `checkpoint_response` - APPROVED (separate from approval_response)

**Révision 2025-11-25:** `checkpoint_response` n'est PAS redondant avec `approval_response`.

Voir section "Clarification: Two Types of Checkpoints" ci-dessus.

| Command               | Type checkpoint                  | Options                  |
| --------------------- | -------------------------------- | ------------------------ |
| `checkpoint_response` | Fault tolerance (crash recovery) | continue/rollback/modify |
| `approval_response`   | HIL approval (sécurité)          | approved yes/no          |

**Status:** ✅ Types définis dans `src/dag/types.ts` (lines 282-287). Handler à implémenter (Story
2.5-4).

---

## Use Cases: Internal Native Agents

### Use Case 1: Rule-Based Decision Engine

```typescript
// Internal state machine agent
class RuleBasedAgent {
  decide(context: {
    layerResults: any[];
    completedLayers: number;
    errors: any[];
  }) {
    // Business logic rules
    if (context.errors.length > 3) {
      return { type: "abort", reason: "Too many errors" };
    }

    if (context.completedLayers > 10) {
      return { type: "abort", reason: "Workflow too long" };
    }

    const hasXML = context.layerResults.some((r) => r.files?.some((f) => f.endsWith(".xml")));

    if (hasXML && !this.hasXMLParser(context)) {
      return {
        type: "replan_dag",
        new_requirement: "Add XML parser",
      };
    }

    return { type: "continue" };
  }
}

// Gateway executes with rule-based agent
async function executeWithRules(dag) {
  const stream = executor.executeStream(dag);

  for await (const event of stream) {
    if (event.type === "decision_required") {
      const decision = ruleBasedAgent.decide(event.context);
      commandQueue.enqueue(decision);
    }
  }
}
```

---

### Use Case 2: Multi-Agent Collaboration

```typescript
// Multiple internal agents collaborate
class MultiAgentWorkflow {
  private agents = {
    security: new SecurityAgent(),
    performance: new PerformanceAgent(),
    cost: new CostAgent(),
  };

  async execute(dag) {
    const stream = executor.executeStream(dag);

    for await (const event of stream) {
      if (event.type === "decision_required") {
        // All agents decide in parallel
        const decisions = await Promise.all([
          this.agents.security.review(event),
          this.agents.performance.review(event),
          this.agents.cost.review(event),
        ]);

        // Aggregate decisions
        const consensus = this.aggregate(decisions);

        // Enqueue command based on consensus
        if (consensus.shouldAbort) {
          commandQueue.enqueue({
            type: "abort",
            reason: consensus.reasons.join("; "),
          });
        } else if (consensus.shouldOptimize) {
          commandQueue.enqueue({
            type: "replan_dag",
            new_requirement: consensus.optimization,
          });
        } else {
          commandQueue.enqueue({ type: "continue" });
        }
      }
    }
  }
}
```

---

### Use Case 3: Background Autonomous Workflow

```typescript
// Workflow runs autonomously in background (hours)
class BackgroundAutonomousWorkflow {
  async executeLongRunning(dag) {
    const workflowId = uuid();

    // Run in background (no HTTP waiting)
    this.runInBackground(async () => {
      const stream = executor.executeStream(dag);

      for await (const event of stream) {
        if (event.type === "decision_required") {
          // Autonomous agent decides without human
          const decision = await this.autonomousAgent.decide(event);

          if (decision.needsIntervention) {
            // Log for later inspection
            await this.logDecision(workflowId, decision);
          }

          // Agent enqueues command autonomously
          commandQueue.enqueue({
            type: decision.action,
            ...decision.params,
          });
        }

        if (event.type === "error") {
          // Auto-recovery
          commandQueue.enqueue({
            type: "replan_dag",
            new_requirement: "Recover from error: " + event.error,
          });
        }
      }
    });

    return { workflow_id: workflowId, status: "running" };
  }
}
```

---

### Use Case 4: LLM Agent via API Directe

```typescript
// Internal agent with LLM (API directe, not MCP)
class LLMInternalAgent {
  private anthropic: Anthropic;

  async decide(context) {
    // Call LLM directly (NOT via MCP)
    const response = await this.anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      messages: [{
        role: "user",
        content: `Analyze workflow results and decide action:

        Results: ${JSON.stringify(context.layerResults)}
        Errors: ${JSON.stringify(context.errors)}

        Options: continue, replan (with requirement), abort (with reason)

        Decide:`,
      }],
    });

    return this.parseDecision(response.content);
  }
}

// Gateway executes with LLM agent
async function executeWithLLM(dag) {
  const stream = executor.executeStream(dag);

  for await (const event of stream) {
    if (event.type === "decision_required") {
      const decision = await llmAgent.decide(event.context);
      commandQueue.enqueue(decision);
    }
  }
}
```

---

## Consequences

### Positive

✅ **Internal Autonomy Enabled**

- Native agents can control workflow execution
- Async message passing (actor model pattern)
- No HTTP interruption (continuous flow)

✅ **Multi-Agent Collaboration**

- Multiple agents decide in parallel
- Command queue as message bus
- Decoupled architecture

✅ **Background Workflows**

- Long-running autonomous workflows
- Auto-recovery mechanisms
- No human supervision required

✅ **Future-Ready Architecture**

- Actor model pattern
- Extensible control plane
- Proven design pattern

✅ **Replan-First Pattern**

- `replan_dag` as primary mechanism
- Intent-based (GraphRAG intelligence)
- Learns patterns over time

### Negative

⚠️ **Must Fix BUG-001**

- Race condition in CommandQueue.processCommands()
- Blocking for internal agent use
- **Resolution**: Story 2.5-4 includes fix

⚠️ **Complexity**

- Two orchestration modes (HTTP + Commands)
- Must document clearly which mode for which use case
- **Mitigation**: ADR-019 clarifies three levels

### Neutral

🔄 **Story 2.5-3 Value Preserved**

- SSE pattern useful for internal agents
- CommandQueue useful for internal control
- Not wasted implementation (originally thought incompatible)

---

## Implementation Plan

### Story 2.5-4 Scope

**Part 1: Fix BUG-001 (2h)**

- Fix race condition in CommandQueue.processCommands()
- Integration tests (10 commands → verify all processed)
- Concurrency tests (parallel enqueue/dequeue)

**Part 2: Gateway HTTP (4-6h)**

- Pre-execution confidence check (Level 1 AIL)
- Per-layer HTTP validation
- Replanning via HTTP
- External MCP agent flow (no commands)

**Part 3: Documentation (1h)**

- Update Story 2.5-3 (commands for internal agents)
- Update ADR-019 (three-level clarification)
- Examples for both modes (HTTP vs Commands)

---

## Related Documents

- **ADR-019**: Three-Level AIL Architecture (commands = Level 2 internal agents)
- **Story 2.5-3**: AIL/HIL Integration (SSE + Commands for internal agents)
- **Story 2.5-4**: Gateway HTTP + BUG-001 fix
- **Epic 2.5**: Adaptive DAG Feedback Loops

---

## Future Review

**Conditions to reconsider deferred handlers:**

**`inject_tasks`**: If >5 use cases where agent needs precise tool control (not GraphRAG)
**`skip_layer`**: If >5 use cases where safe-to-fail insufficient **`modify_args`**: If >3 requests
for HIL correction workflow **`retry_task`**: If >3 use cases where auto-retry insufficient

**Review Date**: 2026-02-24 (3 months post-Epic 2.5 completion)

---

## Approval

**Author**: BMad + Claude Sonnet 4.5 **Date**: 2025-11-24 **Status**: APPROVED

**Decision**: Adopt **4 core command handlers** as internal control plane for native agents (Level 2
AIL). Commands enable autonomous agent orchestration via async message passing.
