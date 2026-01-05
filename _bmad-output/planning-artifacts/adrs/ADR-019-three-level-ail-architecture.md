# ADR-019: Three-Level AIL Architecture - MCP Compatibility + Internal Agents

**Status:** ⛔ Superseded **Date:** 2025-11-24 | **Superseded by:** ADR-020 (2025-11-25)

> See **ADR-020: AIL Control Protocol** for the consolidated architecture.

## Context

### Problem Statement

During implementation of Epic 2.5 (Adaptive DAG Feedback Loops), Story 2.5-3 implemented an AIL
(Agent-in-the-Loop) pattern based on SSE (Server-Sent Events) streaming for mid-execution decision
points. However, **this pattern is incompatible with external MCP (Model Context Protocol) clients
due to one-shot architecture**.

**Root Cause Discovery (2025-11-24):**

The SSE streaming pattern was designed to receive parallel execution results "au fil de l'eau" (as
they come), allowing agents to make decisions mid-execution. However, MCP is fundamentally a
**Request → Response protocol** (one-shot), which means:

1. **MCP Client (Claude Code)** sends a single request
2. **MCP Server (Casys PML Gateway)** processes the request
3. **MCP Server** returns **ONE response** (not streaming events)
4. **No bidirectional communication** during execution

**Consequence:** Story 2.5-3's `decision_required` SSE events cannot be received by **external MCP
agents** mid-execution.

### Critical Insight: Internal Native Agents CAN Use SSE

**However**, SSE pattern IS valuable for **internal native agents** (Level 2 AIL):

- **External MCP agents** (Claude Code) - ❌ Cannot receive SSE (MCP one-shot)
- **Internal native agents** (JS/TS code in Gateway) - ✅ CAN receive SSE (no MCP limitation)
- **Embedded MCP agents** (haiku/sonnet as tasks) - ❌ Cannot receive SSE (also MCP clients)

**Key distinction:** Internal native agents are JS/TS code running within Gateway, not MCP clients.
They can subscribe to SSE events directly and use command queue for control flow (ADR-018).

### Architecture Documents Analysis

**Story 2.5-3 (Implemented - Valuable for Level 2):**

- AIL decision points emit SSE events per-layer
- Commands queue for async control (continue/replan/abort)
- ❌ **Problem:** MCP one-shot prevents **external agents** from receiving events
- ✅ **Solution:** SSE + Commands valid for **internal native agents** (Level 2)

**ADR-018 (Command Handlers Minimalism):**

- Documents commands as internal control plane
- Use case: Multi-agent collaboration, background workflows, rule-based agents
- Commands = Level 2 AIL mechanism

**ADR-007 (3-Loop Learning):**

- Describes adaptive feedback loops
- Does not specify MCP compatibility constraints
- Assumes agent can respond mid-execution (true for Level 2, false for Level 1/3)

### User Intent Clarification

The original intent was **"validation par layer via HTTP response avec résultats partiels"**
(per-layer validation via HTTP response with partial results) for **external MCP agents**, but SSE
streaming is still useful **internally** for:

1. **Gateway aggregation** - Internal SSE used to aggregate parallel task execution (LangGraph
   pattern)
2. **Internal native agents** - Native JS/TS agents subscribe to SSE, enqueue commands
3. **Multi-agent coordination** - Multiple internal agents collaborate via SSE + commands

**Architecture clarification:**

```
┌─────────────────────────────────────────────────────────┐
│ EXTERNAL: MCP Client (Claude Code)                      │
│                                                          │
│   HTTP Request → Gateway → HTTP Response                │
│   (Level 1 AIL: Per-layer validation)                   │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ GATEWAY: Internal SSE Aggregation                       │
│                                                          │
│   ControlledExecutor → SSE Events → Internal Agents     │
│   (Level 2 AIL: Runtime decisions via commands)         │
│                                                          │
│   ┌───────────────────────────────────────────────┐    │
│   │ Internal Native Agents (JS/TS)                │    │
│   │ - Rule-based decision engines                 │    │
│   │ - LLM agents via API directe                  │    │
│   │ - Multi-agent collaboration                   │    │
│   │ - Background autonomous workflows             │    │
│   └───────────────────────────────────────────────┘    │
│                         ↓                                │
│                   CommandQueue                           │
│   (continue, abort, replan_dag, approval_response)      │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ TASKS: Agent Delegation (Embedded MCP)                  │
│                                                          │
│   DAG Task → haiku/sonnet agent → Task output           │
│   (Level 3 AIL: Agent as compositional task)            │
└─────────────────────────────────────────────────────────┘
```

---

## Decision

### Core Principle: Three-Level AIL Architecture

**We adopt a three-level AIL architecture addressing three distinct use cases:**

1. **Level 1: Gateway AIL** - External MCP agents (HTTP Request/Response)
2. **Level 2: Runtime AIL** - Internal native agents (SSE + Commands) **← SSE VALID HERE**
3. **Level 3: Task-Level Agent Delegation** - Embedded MCP agents (Agent as task)

**SSE Pattern Usage:**

- ✅ **Internal Gateway aggregation** - Always used (LangGraph pattern)
- ✅ **Level 2 internal agents** - Can subscribe to SSE (native JS/TS code)
- ❌ **Level 1 external agents** - Cannot receive SSE (MCP one-shot) → Use HTTP
- ❌ **Level 3 embedded agents** - Cannot receive SSE (MCP clients) → Use task output

---

## Level 1: Gateway AIL - External MCP Agents

### Responsibility

Gateway layer detects situations requiring **external agent** (Claude Code) decision and returns
**HTTP responses** (not SSE events) at two points:

1. **Pre-Execution Confidence Check** - Before workflow starts
2. **Per-Layer Validation** - After each layer completes

### Communication Pattern

**HTTP Request → HTTP Response** (MCP one-shot compatible)

### Pre-Execution Confidence Check

**When:** Before DAG execution starts **Detects:** Low GraphRAG confidence (<0.6) or novel
situations **Action:** Return HTTP response with AIL request

**Implementation:**

```typescript
// src/gateway/workflow-gateway.ts
async executeWorkflow(request: { intent: string }) {
  // 1. GraphRAG suggests DAG
  const suggestion = await this.dagSuggester.suggestDAG(request.intent);

  // 2. 🚦 PRE-EXECUTION CONFIDENCE CHECK (Level 1 AIL)
  if (suggestion.confidence < 0.6 || this.isNovelSituation(request.intent)) {
    // ✅ Return HTTP response immediately (MCP compatible)
    return {
      status: "ail_required",
      reason: "Low GraphRAG confidence - agent decision needed",
      confidence: suggestion.confidence,
      suggested_dag: suggestion.dag,  // For info
      options: [
        {
          value: "agent_delegation",
          label: "Launch agent with reasoning capabilities",
          description: "Use agent delegation task for complex analysis"
        },
        {
          value: "manual_dag",
          label: "Construct DAG manually",
          description: "You provide explicit task structure"
        },
        {
          value: "execute_suggested",
          label: "Execute suggested DAG anyway",
          description: "Proceed with low-confidence suggestion"
        },
        {
          value: "abort",
          label: "Cancel workflow",
          description: "Abort execution"
        }
      ]
    };
    // ← External MCP agent receives this in HTTP response, can decide
  }

  // 3. High confidence → Execute
  return await this.executeLayerByLayer(suggestion.dag, request.config);
}
```

**Use Cases:**

- Intent = "Analyze codebase and refactor architecture" (novel, complex) → AIL required
- Intent = "Search for TODO comments" (simple, known pattern) → Auto-execute

### Per-Layer Validation

**When:** After each DAG layer completes **Detects:** Progressive discovery (e.g., found XML files,
need parser) **Action:** Return HTTP response with partial results

**Implementation:**

```typescript
// src/gateway/workflow-gateway.ts
async executeLayerByLayer(dag: DAGStructure, config: ExecutionConfig) {
  const results = [];

  for (let layerIndex = 0; layerIndex < dag.layers.length; layerIndex++) {
    const layer = dag.layers[layerIndex];

    // Execute layer (SSE aggregation internal to Gateway)
    const layerResults = await this.executor.executeLayer(layer);
    results.push(layerResults);

    // 🚦 PER-LAYER VALIDATION (Level 1 AIL - if enabled)
    if (config.ail?.per_layer_validation === true) {
      // ✅ Return HTTP response with partial results (MCP compatible)
      return {
        status: "layer_complete",
        workflow_id: this.workflowId,
        completed_layer: layerIndex,
        layer_results: layerResults,
        accumulated_results: results,
        next_layer_preview: dag.layers[layerIndex + 1] || null,
        checkpoint_url: `/api/workflow/${this.workflowId}/checkpoint`,
        options: [
          {
            value: "continue",
            label: "Continue to next layer",
            description: "Proceed with execution"
          },
          {
            value: "replan",
            label: "Replan workflow",
            description: "Add/modify tasks based on discoveries",
            requires_input: {
              new_requirement: "string",  // Natural language
              available_context: "object"
            }
          },
          {
            value: "abort",
            label: "Abort workflow",
            description: "Stop execution"
          }
        ]
      };
      // ← External agent receives this, validates, sends new HTTP request
    }
  }

  // All layers complete
  return {
    status: "complete",
    workflow_id: this.workflowId,
    results: results
  };
}
```

### MCP Meta-Tools (ADR-018)

Level 1 external agents use **4 MCP meta-tools** (see ADR-018 for full specification):

- `pml:continue` - Continue to next layer
- `pml:abort` - Abort workflow execution
- `pml:replan_dag` - Replan with new requirement (triggers GraphRAG)
- `pml:approval_response` - Respond to HIL approval checkpoint

**External Agent Workflow (Claude Code via MCP):**

```typescript
// Claude Code (MCP Client) execution flow - using MCP meta-tools
let response = await pml.execute_workflow({
  intent: "Analyze codebase",
  config: { per_layer_validation: true },
});

// Agent constructs DAG "petit à petit" via multiple MCP tool calls
while (response.status === "layer_complete") {
  // Agent validates layer results
  const analysis = analyzeResults(response.layer_results);

  if (analysis.needsMoreTools) {
    // Replan: Add new tools based on discovery
    response = await pml.replan_dag({
      workflow_id: response.workflow_id,
      new_requirement: "Add XML parser for discovered files",
      available_context: { xml_files: ["data.xml", "config.xml"] },
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

// Workflow complete
console.log("Final results:", response.results);
```

**Use Cases:**

- Layer 0 discovers XML files → External agent validates → HTTP replan request
- Layer 1 API call fails → External agent validates → HTTP abort request
- Layer 2 analysis complete → External agent validates → HTTP continue request

---

## Level 2: Runtime AIL - Internal Native Agents

### Responsibility

**Internal native agents** (JS/TS code running within Gateway) make autonomous decisions during
workflow execution via **SSE events + Command queue**.

**Key Distinction:** These are NOT MCP clients. They are native code with direct access to SSE
stream and command queue.

### Communication Pattern

**SSE Events → Internal Agent → Command Queue** (no MCP limitation)

### Architecture

**SSE Pattern for Internal Agents:**

```typescript
// ControlledExecutor emits SSE events
for await (const event of executor.executeStream(dag)) {
  // ✅ Internal agent receives SSE (native JS/TS, not MCP)
  if (event.type === "decision_required") {
    // Internal agent decides autonomously
    const decision = await internalAgent.decide(event.context);

    // Agent enqueues command (ADR-018)
    commandQueue.enqueue({
      type: decision.action, // continue, abort, replan_dag, approval_response
      ...decision.params,
    });
  }
}
```

### Use Case 1: Rule-Based Decision Engine

**Implementation:**

```typescript
// Internal state machine agent (native JS/TS)
class RuleBasedAgent {
  decide(context: {
    layerResults: any[],
    completedLayers: number,
    errors: any[]
  }) {
    // Business logic rules
    if (context.errors.length > 3) {
      return { type: "abort", reason: "Too many errors" };
    }

    if (context.completedLayers > 10) {
      return { type: "abort", reason: "Workflow too long" };
    }

    const hasXML = context.layerResults.some(r =>
      r.files?.some(f => f.endsWith('.xml'))
    );

    if (hasXML && !this.hasXMLParser(context)) {
      return {
        type: "replan_dag",
        new_requirement: "Add XML parser",
        available_context: { xml_files: [...] }
      };
    }

    return { type: "continue" };
  }
}

// Gateway executes with internal agent
async function executeWithRules(dag) {
  const stream = executor.executeStream(dag);

  for await (const event of stream) {
    if (event.type === "decision_required") {
      // ✅ Internal agent receives SSE
      const decision = ruleBasedAgent.decide(event.context);
      commandQueue.enqueue(decision);
    }
  }
}
```

**Use Cases:**

- Error threshold enforcement (>3 errors → abort)
- Workflow depth limits (>10 layers → abort)
- Progressive discovery (found XML → replan to add parser)

### Use Case 2: Multi-Agent Collaboration

**Implementation:**

```typescript
// Multiple internal agents collaborate via SSE + Commands
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
        // ✅ All internal agents receive SSE in parallel
        const decisions = await Promise.all([
          this.agents.security.review(event),
          this.agents.performance.review(event),
          this.agents.cost.review(event),
        ]);

        // Aggregate decisions (consensus, voting, etc.)
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

**Use Cases:**

- Security agent detects threat → abort
- Performance agent suggests optimization → replan
- Cost agent enforces budget → abort
- Consensus-based decisions (2/3 agents agree → continue)

### Use Case 3: Background Autonomous Workflow

**Implementation:**

```typescript
// Workflow runs autonomously in background (hours/days)
class BackgroundAutonomousWorkflow {
  async executeLongRunning(dag) {
    const workflowId = uuid();

    // Run in background (no HTTP waiting)
    this.runInBackground(async () => {
      const stream = executor.executeStream(dag);

      for await (const event of stream) {
        if (event.type === "decision_required") {
          // ✅ Autonomous internal agent decides without human
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
          // Auto-recovery via replan
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

**Use Cases:**

- Long-running data pipelines (ETL workflows)
- Continuous monitoring and adaptation
- Auto-recovery from transient failures
- No human supervision required

### Use Case 4: LLM Agent via API Directe

**Implementation:**

```typescript
// Internal agent with LLM (API directe, NOT via MCP)
class LLMInternalAgent {
  private anthropic: Anthropic;

  async decide(context) {
    // Call LLM directly (NOT via MCP client)
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

// Gateway executes with LLM internal agent
async function executeWithLLM(dag) {
  const stream = executor.executeStream(dag);

  for await (const event of stream) {
    if (event.type === "decision_required") {
      // ✅ Internal agent receives SSE, calls LLM, enqueues command
      const decision = await llmAgent.decide(event.context);
      commandQueue.enqueue(decision);
    }
  }
}
```

**Use Cases:**

- LLM-based decision making (haiku for speed)
- Natural language reasoning about workflow state
- Adaptive strategies based on context

### Commands Reference (ADR-018)

Level 2 internal agents use 4 approved command handlers:

1. **`continue`** - Resume workflow execution
2. **`abort`** - Terminate workflow with reason
3. **`replan_dag`** - Trigger GraphRAG replanning with new requirement
4. **`approval_response`** - Respond to HIL checkpoint (human or automated)

**See ADR-018 for detailed command specifications and examples.**

---

## Level 3: Task-Level Agent Delegation

### Responsibility

Embed **agent reasoning** directly as a **DAG task** for complex analysis requiring multi-step
reasoning.

**Key Distinction:** Agent is executed AS a task (embedded MCP agent like haiku/sonnet), output
becomes available to dependent tasks.

### Communication Pattern

**DAG Task Execution → Agent Output → Dependent Tasks** (standard task flow)

### Implementation (Proposed - Epic 3.5+)

**Agent Delegation Task:**

```typescript
// Future: Agent delegation task type
const dag: DAGStructure = {
  tasks: [
    {
      id: "fetch_api_docs",
      tool: "web_search:scrape",
      arguments: { url: "https://api.example.com/docs" },
    },
    {
      // 🤖 AGENT DELEGATION TASK (Level 3 AIL)
      id: "analyze_api",
      type: "agent_delegation",
      agent_role: "api_researcher",
      agent_goal: "Analyze API docs and extract authentication patterns",
      agent_model: "haiku", // Fast embedded MCP agent
      agent_tools: ["read_file", "web_search:*"],
      max_iterations: 5,
      timeout: 60000, // 60s
      depends_on: ["fetch_api_docs"],
    },
    {
      id: "implement_client",
      tool: "code:generate",
      arguments: {
        template: "api_client",
        config: "{{analyze_api.output}}", // Uses agent output
      },
      depends_on: ["analyze_api"],
    },
  ],
};
```

**Execution Flow:**

```
1. fetch_api_docs executes → returns API docs HTML
2. analyze_api (haiku agent) executes:
   - Receives API docs as input
   - Runs reasoning loop (up to 5 iterations)
   - Analyzes authentication patterns
   - Returns structured output (JSON)
3. implement_client executes:
   - Receives agent output as {{analyze_api.output}}
   - Generates API client code
```

**Benefits:**

- ✅ Agent reasoning embedded in workflow (compositional)
- ✅ No MCP limitation (agent is task, output is normal result)
- ✅ Parallel execution possible (multiple agents in different branches)
- ✅ Type-safe dependencies (task graph validation)
- ✅ Timeout/budget controls per agent

**Use Cases:**

- API analysis and client generation
- Architecture decision making
- Code review and recommendations
- Pattern extraction from documentation
- Complex multi-step reasoning tasks

**Status:** Deferred to Epic 3.5+ (spike exists: `spike-hybrid-dag-agent-delegation.md`)

---

## SSE Pattern Clarification

### Internal Gateway Aggregation (Always Used)

**Purpose:** Gateway uses SSE internally to aggregate parallel task execution (LangGraph pattern)

```typescript
// ControlledExecutor aggregates parallel tasks via SSE
async *executeStream(dag: DAGStructure) {
  for (const layer of dag.layers) {
    // Execute tasks in parallel
    const promises = layer.tasks.map(task => this.executeTask(task));

    // Yield results as they complete (SSE internal aggregation)
    for await (const result of this.aggregateResults(promises)) {
      yield {
        type: "task_complete",
        task_id: result.task_id,
        output: result.output
      };
    }

    // Yield layer complete
    yield {
      type: "layer_complete",
      layer_index: layerIndex,
      results: layerResults
    };
  }
}
```

**Key Point:** This is **internal implementation detail**, NOT exposed to external MCP agents.

### Who Can Subscribe to SSE Events?

| Agent Type                               | Can Subscribe to SSE? | Why?                   | Communication Method       |
| ---------------------------------------- | --------------------- | ---------------------- | -------------------------- |
| **Level 1: External MCP (Claude Code)**  | ❌ NO                 | MCP one-shot protocol  | HTTP Request → Response    |
| **Level 2: Internal Native (JS/TS)**     | ✅ YES                | Native code in Gateway | SSE Events + Command Queue |
| **Level 3: Embedded MCP (haiku/sonnet)** | ❌ NO                 | Also MCP clients       | Task Input → Task Output   |

**Why Level 3 cannot use SSE:**

Level 3 agents (haiku/sonnet) are embedded MCP agents running as tasks. They:

- Are MCP clients (same protocol as Claude Code)
- Run via MCP server invocation (one-shot)
- Receive input at task start, return output at task end
- Cannot subscribe to SSE mid-execution

**Only Level 2 (internal native agents) can use SSE because they are JS/TS code running within
Gateway process, not MCP clients.**

---

## Consequences

### Positive

✅ **Three Distinct Use Cases Addressed**

- Level 1: External agent validation (MCP compatible HTTP)
- Level 2: Internal agent autonomy (SSE + Commands)
- Level 3: Agent as compositional task (embedded reasoning)

✅ **SSE Pattern Value Preserved**

- Internal Gateway aggregation (LangGraph pattern)
- Level 2 internal agents can subscribe to SSE
- Story 2.5-3 implementation NOT wasted

✅ **MCP Compatibility**

- Level 1 external agents: HTTP Request → Response
- Level 3 embedded agents: Task Input → Output
- No SSE exposure to MCP clients

✅ **Actor Model Pattern (Level 2)**

- Commands as async message passing
- Multi-agent collaboration
- Background autonomous workflows
- ADR-018 command handlers enable this

✅ **Per-Layer Validation Preserved (Level 1)**

- Original intent maintained ("validation par layer via HTTP")
- External agent validates after each layer
- Progressive discovery supported (replan between layers)

✅ **Agent Delegation Pattern (Level 3)**

- Compositional workflow design
- Agent reasoning embedded as tasks
- Type-safe dependencies

### Negative

⚠️ **Story 2.5-3 Limited Scope**

- SSE pattern only useful for internal agents (Level 2)
- Cannot be used with external MCP agents (Level 1)
- **Mitigation:** Document as known limitation, clarify Level 2 use cases

⚠️ **Complexity**

- Three orchestration modes (HTTP, SSE+Commands, Task Delegation)
- Must document clearly which mode for which use case
- **Mitigation:** This ADR provides clear separation

⚠️ **BUG-001 Still Needs Fix**

- Race condition in CommandQueue.processCommands() (Story 2.5-4)
- Blocking for Level 2 internal agents
- **Resolution:** Story 2.5-4 includes fix + Gateway HTTP implementation

⚠️ **No Real-Time Progress for External Agents**

- Level 1 external agents don't see tasks completing real-time during layer
- Only see results after layer completes
- **Mitigation:** Acceptable tradeoff - agent validates per-layer, not per-task

### Neutral

🔄 **Epic 2.5 Scope Impact**

- Story 2.5-3: Update with Level 2 clarification (internal agents only)
- Story 2.5-4: Gateway HTTP (Level 1) + BUG-001 fix (Level 2)
- ADR-018: Commands = Level 2 control plane (already documented)

---

## Implementation Plan

### Phase 1: Documentation Updates (Immediate)

**Update Story 2.5-3:**

```markdown
## Scope Clarification (Added 2025-11-24)

✅ **Level 2 AIL Pattern:** The SSE + Commands pattern implemented in this story is designed for
**internal native agents** (Level 2 AIL - ADR-019), NOT for external MCP clients.

**Valid Use Cases:**

- Internal rule-based agents (state machines)
- Multi-agent collaboration (security, performance, cost agents)
- Background autonomous workflows (long-running pipelines)
- LLM agents via API directe (not via MCP)

**Known Limitations:**

- ❌ Cannot be used with external MCP agents (Claude Code) - use Level 1 (Gateway HTTP)
- ❌ Cannot be used with embedded MCP agents (haiku/sonnet tasks) - use Level 3 (Task Delegation)

**Resolution:** See ADR-019: Three-Level AIL Architecture for complete architecture.
```

**Update Story 2.5-4:**

- **Part 1:** Fix BUG-001 (CommandQueue race condition) - 2h
- **Part 2:** Implement Level 1 Gateway HTTP (pre-execution + per-layer validation) - 4-6h
- **Part 3:** Documentation and integration tests - 1h

**Update Architecture.md:**

- Reference ADR-019 for AIL architecture
- Clarify SSE for internal aggregation + Level 2 agents
- Document three levels with use cases

**Update ADR-007:**

- Add note: "AIL/HIL implementation details superseded by ADR-019"

### Phase 2: Level 1 Implementation (Story 2.5-4)

**Create Gateway HTTP endpoints:**

- `POST /api/workflow/execute` - Execute workflow with AIL detection
- `POST /api/workflow/:id/continue` - Continue/replan/abort after layer validation
- `GET /api/workflow/:id/status` - Check workflow status

**Files to Create:**

- `src/gateway/ail-detector.ts` - Confidence detection logic
- `src/gateway/layer-validator.ts` - Per-layer validation HTTP responses

**Files to Modify:**

- `src/gateway/workflow-gateway.ts` - Add AIL detection + per-layer validation
- `src/dag/types.ts` - Add AIL config to ExecutionConfig
- `src/executor/command-queue.ts` - Fix BUG-001 race condition

### Phase 3: Level 2 Examples (Documentation)

**Create example implementations:**

- `examples/internal-agents/rule-based-agent.ts`
- `examples/internal-agents/multi-agent-collaboration.ts`
- `examples/internal-agents/background-workflow.ts`
- `examples/internal-agents/llm-agent-api.ts`

### Phase 4: Level 3 Agent Delegation (Epic 3.5+)

**Prerequisite:** Epic 3 (Sandbox Isolation) complete **Story:** Implement `agent_delegation` task
type **Estimate:** 3-4 weeks (Phases 1-3 per spike)

---

## Success Metrics

### Immediate (Week 1)

- ✅ ADR-019 approved and published
- ✅ ADR-018 updated with Level 2 clarification
- ✅ Story 2.5-3 updated with scope clarification (Level 2 internal agents)
- ✅ Architecture.md, ADR-007 references updated

### Short-term (Month 1)

- ✅ Story 2.5-4 implemented (Gateway HTTP + BUG-001 fix)
- ✅ Level 1 pre-execution confidence check working (confidence <0.6 → AIL required)
- ✅ Level 1 per-layer validation working (external agent validates after each layer)
- ✅ BUG-001 fixed (CommandQueue race condition resolved)
- ✅ E2E test: External agent discovers XML → HTTP replan → Adds parser → HTTP continue

### Long-term (Month 3)

- ✅ Level 1 validated in production (>100 workflows with external agents)
- ✅ Level 2 internal agents deployed (1+ use case: rule-based or multi-agent)
- ✅ Epic 3.5 (Agent Delegation) completed (Level 3 implemented)
- ✅ 0 MCP incompatibility issues reported
- ✅ Three-level architecture pattern validated

---

## Related Documents

- **ADR-007**: 3-Loop Learning Architecture (AIL/HIL concepts)
- **ADR-018**: Command Handlers Minimalism (Level 2 internal control plane)
- **Story 2.5-3**: AIL/HIL Integration (SSE + Commands for Level 2 internal agents)
- **Story 2.5-4**: Gateway HTTP + BUG-001 fix (Level 1 + Level 2 fixes)
- **Spike**: Agent-Human DAG Feedback Loop (over-scoped, corrected here)
- **Spike**: Hybrid DAG Agent Delegation (Level 3 design)
- **Architecture.md**: Pattern 4 (3-Loop Learning)

---

## Future Review

**Conditions to reconsider architecture:**

**If MCP adds streaming support:**

- **Threshold:** MCP protocol spec updated to support SSE or WebSocket
- **Action:** Re-evaluate Level 1 for real-time progress updates to external agents
- **Likelihood:** Low (MCP designed for one-shot by Anthropic)

**If Level 2 adoption low:**

- **Threshold:** <3 internal agent implementations after 6 months
- **Action:** Re-evaluate complexity vs. value tradeoff
- **Likelihood:** Medium (depends on use case demand)

**Review Date:** 2026-02-24 (3 months post-Epic 2.5 completion)

---

## Approval

**Author**: BMad + Claude Sonnet 4.5 **Date**: 2025-11-24 **Status**: APPROVED

---

**Decision**: Adopt **Three-Level AIL Architecture**:

1. **Level 1**: Gateway AIL (External MCP agents) - HTTP Request/Response
2. **Level 2**: Runtime AIL (Internal native agents) - SSE + Commands (ADR-018)
3. **Level 3**: Task-Level Delegation (Embedded MCP agents) - Agent as task

**Key Insight**: Only Level 2 can use SSE because agents are native JS/TS code, not MCP clients.
