# Spike: Hybrid DAG + Agent Delegation (Strategy D)

> **⚠️ DEPRECATED (2025-12-23):** Ce spike est supersédé par
> [2025-12-23-mcp-sampling-agent-nodes.md](./2025-12-23-mcp-sampling-agent-nodes.md)
>
> **Raison:** La spec MCP de novembre 2025 introduit "Sampling with Tools" (SEP-1577) qui permet aux
> serveurs MCP de faire des boucles agentiques via le protocol standard. Cela rend obsolète
> l'approche "spawn Claude instance" proposée ici.
>
> **Ce qui reste pertinent:** Les concepts de design (AgentDelegationTask, tool filtering, budget,
> GraphRAG integration) restent valides et sont repris dans le nouveau spike.

**Date:** 2025-11-23 **Author:** Claude (Sonnet 4.5) **Status:** ❌ DEPRECATED **Estimated Effort:**
2-3 days research + 5-7 days implementation **Risk Level:** 🟡 Medium

---

## Context

Suite à l'audit sur le risque de délégation multi-agents, nous explorons la **Stratégie D : Hybride
DAG + Agents**.

**Problème identifié:**

- Les agents conversationnels délèguent de plus en plus à des sous-agents spécialisés
- Risque de bypass d'Casys PML si sous-agents appellent MCP tools directement
- Besoin de combiner orchestration DAG + spécialisation multi-agents

**Opportunité:** Intégrer la délégation d'agents DANS le DAG comme un type de task à part entière,
permettant:

- Parallélisation entre agents (comme entre tasks)
- GraphRAG learning sur patterns multi-agents
- Context optimization cross-agents
- Orchestration unifiée (tools + code + agents)

---

## Objective

**Spike Goal:** Valider la faisabilité technique d'ajouter un nouveau type de task
`agent_delegation` dans le DAG, permettant d'orchestrer des sous-agents aux côtés des MCP tasks et
code execution tasks.

**Success Criteria:**

- ✅ Prototype fonctionnel (agent task dans un DAG)
- ✅ Design API clair et ergonomique
- ✅ Trade-offs identifiés (coûts, complexité, latence)
- ✅ Recommandation go/no-go pour implémentation complète

---

## Design Proposé

### 1. Nouveau Type de Task : `agent_delegation`

#### Interface TypeScript

```typescript
// Existing task types (ADR-010)
interface MCPTask extends Task {
  tool: string;
  arguments: Record<string, unknown>;
  side_effects?: boolean; // Default: true
}

interface CodeExecutionTask extends Task {
  type: "code_execution";
  code: string;
  sandbox_config?: SandboxConfig;
  side_effects?: boolean; // Default: false
}

// NEW: Agent delegation task
interface AgentDelegationTask extends Task {
  type: "agent_delegation";

  // Agent configuration
  agent_role: string; // "researcher", "coder", "reviewer"
  agent_goal: string; // Natural language goal
  agent_model?: "haiku" | "sonnet" | "opus"; // Default: "haiku"

  // Tools available to agent
  agent_tools?: string[]; // Subset of MCP tools (e.g., ["github:*", "web_search"])
  agent_context?: Record<string, unknown>; // Initial context for agent

  // Execution constraints
  max_iterations?: number; // Default: 5 (prevent infinite loops)
  timeout?: number; // Default: 60s
  budget?: number; // Max cost in tokens (e.g., 10k tokens)

  // Integration with DAG
  depends_on: string[]; // Like other tasks
  side_effects?: boolean; // Default: true (agents can modify state)
}

// Union type (extends existing ADR-010)
type Task = MCPTask | CodeExecutionTask | AgentDelegationTask;
```

#### Example: Simple Agent Task

```typescript
const workflow: DAGStructure = {
  tasks: [
    // Layer 0: Fetch raw data (MCP task)
    {
      id: "fetch_api_docs",
      tool: "web_search:scrape",
      arguments: {
        urls: ["https://api.example.com/docs"],
      },
      side_effects: false,
    },

    // Layer 1: Research best practices (AGENT task)
    {
      id: "research_best_practices",
      type: "agent_delegation",
      agent_role: "api_researcher",
      agent_goal: "Analyze API docs and extract authentication best practices",
      agent_model: "haiku", // Cost-effective for research
      agent_tools: ["web_search:*", "read_file"],
      depends_on: ["fetch_api_docs"],
      side_effects: false, // Read-only research
    },

    // Layer 2: Implement (AGENT task)
    {
      id: "implement_auth",
      type: "agent_delegation",
      agent_role: "coder",
      agent_goal: "Implement OAuth2 authentication following best practices",
      agent_model: "sonnet", // More capable for coding
      agent_tools: ["write_file", "run_tests"],
      agent_context: {
        best_practices: "$OUTPUT[research_best_practices]",
      },
      depends_on: ["research_best_practices"],
      side_effects: true, // Writes files
    },

    // Layer 3: Aggregate results (CODE task)
    {
      id: "generate_report",
      type: "code_execution",
      code: `
        return {
          research: deps.research_best_practices.output,
          implementation: deps.implement_auth.output,
          status: "complete"
        };
      `,
      depends_on: ["research_best_practices", "implement_auth"],
      side_effects: false,
    },
  ],
};
```

### 2. Execution Flow

#### High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│          ControlledExecutor (extended)               │
│                                                      │
│  executeStream(dag: DAGStructure) {                  │
│    for (layer of layers) {                           │
│      results = await Promise.all(                    │
│        layer.map(task => {                           │
│          if (task.type === "agent_delegation")       │
│            return executeAgentTask(task);            │
│          else if (task.type === "code_execution")    │
│            return executeCodeTask(task);             │
│          else                                        │
│            return executeMCPTask(task);              │
│        })                                            │
│      );                                              │
│    }                                                 │
│  }                                                   │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│         AgentExecutor (NEW component)                │
│                                                      │
│  async executeAgentTask(task: AgentDelegationTask)   │
│  {                                                   │
│    1. Spawn sub-agent (Claude instance)              │
│    2. Provide tools via MCP gateway                  │
│    3. Inject context from depends_on tasks           │
│    4. Monitor iterations (max_iterations)            │
│    5. Track costs (budget enforcement)               │
│    6. Return result to DAG                           │
│  }                                                   │
└─────────────────────────────────────────────────────┘
```

#### Detailed Execution Steps

```typescript
class AgentExecutor {
  async executeAgentTask(
    task: AgentDelegationTask,
    context: ExecutionContext,
  ): Promise<TaskResult> {
    // 1. Resolve dependencies (like other tasks)
    const resolvedContext = this.resolveDependencies(
      task.depends_on,
      context.completedTasks,
    );

    // 2. Create agent instance
    const agent = await this.createAgent({
      role: task.agent_role,
      model: task.agent_model || "haiku",
      tools: this.filterTools(task.agent_tools), // Subset of available MCP tools
      systemPrompt: this.buildSystemPrompt(task),
    });

    // 3. Execute agent conversation
    let iterations = 0;
    let totalTokens = 0;
    let result: unknown;

    while (iterations < (task.max_iterations || 5)) {
      const response = await agent.sendMessage(task.agent_goal, {
        context: { ...resolvedContext, ...task.agent_context },
        timeout: task.timeout || 60000,
      });

      // Track costs
      totalTokens += response.usage.total_tokens;
      if (task.budget && totalTokens > task.budget) {
        throw new Error(`Agent exceeded token budget: ${totalTokens}/${task.budget}`);
      }

      // Check if agent completed goal
      if (response.stopReason === "end_turn" && response.output) {
        result = response.output;
        break;
      }

      iterations++;
    }

    // 4. Return result (same format as other tasks)
    return {
      status: result ? "success" : "error",
      output: result,
      metadata: {
        iterations,
        tokens: totalTokens,
        cost: this.calculateCost(totalTokens, task.agent_model),
        duration_ms: Date.now() - startTime,
      },
    };
  }

  private buildSystemPrompt(task: AgentDelegationTask): string {
    return `
You are a specialized agent with the role: ${task.agent_role}

Your goal: ${task.agent_goal}

Available tools: ${task.agent_tools?.join(", ") || "all MCP tools"}

When you have completed your goal, return your final output using the "return_result" tool.

Work efficiently and stay focused on your specific goal.
    `.trim();
  }
}
```

### 3. Agent Instance Management

#### Option A: Spawn New Instance Per Task (Simple)

```typescript
class AgentExecutor {
  async createAgent(config: AgentConfig): Promise<Agent> {
    // Spawn new Claude instance via SDK
    return new ClaudeAgent({
      model: config.model,
      systemPrompt: config.systemPrompt,
      tools: config.tools,
      maxTokens: 4096,
    });
  }
}
```

**Pros:**

- ✅ Simple implementation
- ✅ Isolation totale (pas de pollution de contexte)
- ✅ Parallélisme facile (Promise.all)

**Cons:**

- ❌ Coûts répétés (system prompt à chaque instance)
- ❌ Pas de réutilisation de contexte

#### Option B: Agent Pool + Reuse (Optimized)

```typescript
class AgentPool {
  private pool: Map<string, Agent> = new Map();

  async getAgent(role: string, model: string): Promise<Agent> {
    const key = `${role}:${model}`;

    if (this.pool.has(key)) {
      return this.pool.get(key)!; // Reuse existing
    }

    const agent = await this.createAgent(role, model);
    this.pool.set(key, agent);
    return agent;
  }

  async releaseAgent(role: string) {
    // Reset agent context but keep instance alive
    const agent = this.pool.get(role);
    if (agent) {
      await agent.reset(); // Clear conversation history
    }
  }
}
```

**Pros:**

- ✅ Réduction coûts (réutilisation instances)
- ✅ Warm start (pas de cold start)

**Cons:**

- ⚠️ Complexité accrue (lifecycle management)
- ⚠️ Risque de pollution de contexte (must reset carefully)

**Recommendation:** Start with Option A (simple), optimize to Option B if costs become issue.

### 4. Tool Access for Sub-Agents

#### Architecture: Filtered MCP Gateway

```typescript
class FilteredMCPGateway {
  constructor(
    private baseGateway: Casys PMLGateway,
    private allowedTools: string[], // e.g., ["github:*", "web_search:search"]
  ) {}

  async callTool(toolName: string, args: unknown): Promise<unknown> {
    // Check if tool is allowed
    if (!this.isToolAllowed(toolName)) {
      throw new Error(`Tool ${toolName} not allowed for this agent`);
    }

    // Proxy to base gateway
    return this.baseGateway.callTool(toolName, args);
  }

  private isToolAllowed(toolName: string): boolean {
    return this.allowedTools.some((pattern) => {
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        return toolName.startsWith(prefix);
      }
      return toolName === pattern;
    });
  }
}
```

**Example Usage:**

```typescript
const task: AgentDelegationTask = {
  type: "agent_delegation",
  agent_role: "researcher",
  agent_tools: ["web_search:*", "read_file"], // Only these tools
  // ...
};

// Agent can call:
// ✅ web_search:search
// ✅ web_search:scrape
// ✅ read_file
// ❌ write_file (not allowed)
// ❌ github:create_issue (not allowed)
```

**Benefits:**

- ✅ Security (agents can't access dangerous tools)
- ✅ Cost control (limit expensive tools)
- ✅ Explicit contracts (clear what agent can do)

### 5. Context Injection & Communication

#### Dependency Resolution (Same as Existing Tasks)

```typescript
// Agent task can depend on any task type
{
  id: "implement",
  type: "agent_delegation",
  depends_on: [
    "fetch_docs",        // MCP task
    "analyze",           // Code execution task
    "research"           // Another agent task
  ],
  agent_context: {
    // Inject outputs via $OUTPUT syntax
    docs: "$OUTPUT[fetch_docs]",
    analysis: "$OUTPUT[analyze]",
    best_practices: "$OUTPUT[research]"
  }
}
```

#### Agent Receives Context

```typescript
// Sub-agent sees this in its context
const context = {
  docs: {/* MCP task output */},
  analysis: {/* Code task output */},
  best_practices: {/* Previous agent output */},
};

// Agent can use in prompt
agent.sendMessage(`
  Based on the documentation: ${context.docs}
  And analysis: ${context.analysis}
  Implement the feature following: ${context.best_practices}
`);
```

### 6. Cost Tracking & Budget Enforcement

#### Per-Agent Cost Calculation

```typescript
interface AgentCosts {
  researcher: {
    tokens: 15000;
    cost: 0.003; // $0.003 for haiku
    duration_ms: 5000;
  };
  coder: {
    tokens: 50000;
    cost: 0.015; // $0.015 for sonnet
    duration_ms: 12000;
  };
}

// Total workflow cost
const totalCost = Object.values(agentCosts).reduce(
  (sum, agent) => sum + agent.cost,
  0,
); // $0.018
```

#### Budget Enforcement

```typescript
{
  type: "agent_delegation",
  agent_role: "researcher",
  budget: 10000,  // Max 10k tokens
  // If agent exceeds, task fails with budget_exceeded error
}
```

**Benefits:**

- ✅ Cost visibility (track per agent)
- ✅ Budget protection (prevent runaway costs)
- ✅ Optimization (choose model based on task)

---

## Proof of Concept

### PoC 1: Simple Agent Task in DAG

**Goal:** Validate basic execution of agent task within DAG.

```typescript
// poc-agent-task.ts
import { ControlledExecutor } from "./dag/controlled-executor";
import { AgentExecutor } from "./dag/agent-executor";

async function testAgentTask() {
  const dag: DAGStructure = {
    tasks: [
      {
        id: "research",
        type: "agent_delegation",
        agent_role: "researcher",
        agent_goal: "Research TypeScript best practices for error handling",
        agent_model: "haiku",
        agent_tools: ["web_search:search"],
        max_iterations: 3,
        depends_on: [],
      },
      {
        id: "summarize",
        type: "code_execution",
        code: `
          const research = deps.research.output;
          return {
            summary: research.findings.slice(0, 3),
            source: "agent_delegation"
          };
        `,
        depends_on: ["research"],
      },
    ],
  };

  const executor = new ControlledExecutor({
    agentExecutor: new AgentExecutor(),
  });

  const result = await executor.execute(dag);

  console.log("Agent output:", result.tasks.find((t) => t.id === "research").output);
  console.log("Summary:", result.tasks.find((t) => t.id === "summarize").output);
  console.log("Total cost:", result.metadata.total_cost);
}
```

**Expected Output:**

```json
{
  "tasks": [
    {
      "id": "research",
      "status": "success",
      "output": {
        "findings": [
          "Use custom Error classes for domain errors",
          "Implement Result<T, E> pattern for expected errors",
          "Use try-catch only for unexpected errors"
        ]
      },
      "metadata": {
        "iterations": 2,
        "tokens": 5432,
        "cost": 0.0011,
        "duration_ms": 3200
      }
    },
    {
      "id": "summarize",
      "status": "success",
      "output": {
        "summary": ["Use custom Error classes...", "..."],
        "source": "agent_delegation"
      }
    }
  ],
  "metadata": {
    "total_cost": 0.0011,
    "total_duration_ms": 3500
  }
}
```

### PoC 2: Parallel Agent Tasks

**Goal:** Validate parallel execution of multiple agents (like parallel MCP tasks).

```typescript
const dag: DAGStructure = {
  tasks: [
    // Layer 0: 3 agents in parallel
    {
      id: "research_auth",
      type: "agent_delegation",
      agent_role: "security_researcher",
      agent_goal: "Research OAuth2 best practices",
      agent_model: "haiku",
      depends_on: [],
    },
    {
      id: "research_rate_limiting",
      type: "agent_delegation",
      agent_role: "performance_researcher",
      agent_goal: "Research API rate limiting strategies",
      agent_model: "haiku",
      depends_on: [],
    },
    {
      id: "research_caching",
      type: "agent_delegation",
      agent_role: "performance_researcher",
      agent_goal: "Research API caching best practices",
      agent_model: "haiku",
      depends_on: [],
    },

    // Layer 1: Aggregate (code execution)
    {
      id: "aggregate_research",
      type: "code_execution",
      code: `
        return {
          auth: deps.research_auth.output,
          rate_limiting: deps.research_rate_limiting.output,
          caching: deps.research_caching.output,
          confidence: "high"
        };
      `,
      depends_on: ["research_auth", "research_rate_limiting", "research_caching"],
    },

    // Layer 2: Implement (single agent)
    {
      id: "implement_api",
      type: "agent_delegation",
      agent_role: "coder",
      agent_goal: "Implement API with auth, rate limiting, and caching",
      agent_model: "sonnet",
      agent_context: {
        specifications: "$OUTPUT[aggregate_research]",
      },
      depends_on: ["aggregate_research"],
    },
  ],
};
```

**Expected Behavior:**

- Layer 0: 3 agents run in parallel (like Promise.all)
- Total time: ~max(agent1_time, agent2_time, agent3_time) ≈ 5s (not 15s sequential)
- Layer 1: Aggregation waits for all 3
- Layer 2: Implementation uses aggregated results

### PoC 3: Mixed Tasks (MCP + Code + Agent)

**Goal:** Validate seamless integration of all 3 task types.

```typescript
const dag: DAGStructure = {
  tasks: [
    // MCP task
    {
      id: "fetch_repo",
      tool: "github:get_repository",
      arguments: { repo: "pml" },
    },

    // Agent task
    {
      id: "analyze_architecture",
      type: "agent_delegation",
      agent_role: "architect",
      agent_goal: "Analyze repository structure and identify architectural patterns",
      agent_tools: ["read_file", "grep"],
      agent_context: {
        repo_info: "$OUTPUT[fetch_repo]",
      },
      depends_on: ["fetch_repo"],
    },

    // Code execution task
    {
      id: "generate_diagram",
      type: "code_execution",
      code: `
        const patterns = deps.analyze_architecture.output.patterns;
        return generateMermaidDiagram(patterns);
      `,
      depends_on: ["analyze_architecture"],
    },

    // Another agent task
    {
      id: "write_documentation",
      type: "agent_delegation",
      agent_role: "technical_writer",
      agent_goal: "Write architecture documentation based on analysis and diagram",
      agent_tools: ["write_file"],
      agent_context: {
        analysis: "$OUTPUT[analyze_architecture]",
        diagram: "$OUTPUT[generate_diagram]",
      },
      depends_on: ["analyze_architecture", "generate_diagram"],
    },
  ],
};
```

**Flow:**

```
fetch_repo (MCP)
    ↓
analyze_architecture (AGENT)
    ↓
generate_diagram (CODE)
    ↓
write_documentation (AGENT)
```

---

## Trade-offs Analysis

### Benefits

#### ✅ 1. Best of Both Worlds

- DAG orchestration (parallelism, dependencies)
- Agent specialization (expertise, natural language goals)
- Unified workflow (single DAG, multiple paradigms)

#### ✅ 2. Parallelism at Agent Level

```typescript
// 5 researchers in parallel
tasks: [
  { type: "agent_delegation", agent_role: "researcher", topic: "auth" },
  { type: "agent_delegation", agent_role: "researcher", topic: "caching" },
  { type: "agent_delegation", agent_role: "researcher", topic: "rate_limit" },
  { type: "agent_delegation", agent_role: "researcher", topic: "monitoring" },
  { type: "agent_delegation", agent_role: "researcher", topic: "security" },
];
// Execute in parallel → 5x faster than sequential
```

#### ✅ 3. GraphRAG Learning on Multi-Agent Patterns

```typescript
// GraphRAG learns:
// - Which agent_roles work best for which goals
// - Optimal agent_model selection (haiku vs sonnet)
// - Common agent → agent dependencies
// - Cost/quality trade-offs
```

#### ✅ 4. Cost Optimization

```typescript
// Use cheap model for simple tasks
{ agent_model: "haiku", agent_goal: "Research..." }  // $0.001

// Use powerful model for complex tasks
{ agent_model: "sonnet", agent_goal: "Implement..." }  // $0.015

// Budget enforcement prevents runaway costs
{ budget: 10000 }  // Max 10k tokens
```

#### ✅ 5. Gradual Adoption

- Existing DAGs still work (backward compatible)
- Add agent tasks incrementally
- No breaking changes to API

### Costs

#### ❌ 1. Implementation Complexity

**Estimated Effort:**

- AgentExecutor class: 2-3 days
- Agent pool management: 1-2 days
- Tool filtering: 1 day
- Tests: 2 days
- Documentation: 1 day
- **Total: 7-9 days**

**Components to build:**

- `src/dag/agent-executor.ts` (new)
- `src/dag/agent-pool.ts` (new)
- `src/mcp/filtered-gateway.ts` (new)
- Extend `ControlledExecutor` (modify)
- Update `types.ts` with `AgentDelegationTask` (modify)

#### ❌ 2. Monetary Costs

**LLM costs can accumulate:**

```typescript
// Example workflow
tasks: [
  { agent_model: "haiku", tokens: 5k },   // $0.001
  { agent_model: "haiku", tokens: 5k },   // $0.001
  { agent_model: "sonnet", tokens: 20k }, // $0.006
  { agent_model: "sonnet", tokens: 20k }  // $0.006
]
// Total: $0.014 per workflow execution

// If workflow runs 1000 times/day → $14/day → $420/month
```

**Mitigation:**

- Budget enforcement (hard limits)
- Model selection guidance (use haiku by default)
- Cost monitoring dashboards
- Agent result caching (don't re-run same agent goals)

#### ❌ 3. Latency

**Sequential agents add latency:**

```typescript
// Without agent delegation
Layer 0: MCP calls (3s)
Layer 1: Code execution (0.5s)
Total: 3.5s

// With agent delegation
Layer 0: MCP calls (3s)
Layer 1: Agent task (5-10s)  // ← Added latency
Layer 2: Code execution (0.5s)
Total: 8.5-13.5s
```

**Mitigation:**

- Use agents only when necessary (complex goals)
- Parallelize agents aggressively
- Use haiku for speed-critical tasks
- Set aggressive timeouts

#### ❌ 4. Debugging Complexity

**Multi-level debugging:**

```
Workflow fails
  → Which layer?
    → Which task?
      → If agent task:
        → Which iteration?
        → Which tool call?
        → Which decision?
```

**Mitigation:**

- Enhanced event stream (agent-level events)
- Agent conversation logs
- Step-by-step replay capability

### Risks

#### ⚠️ 1. Agent Reliability

**Agents can fail unpredictably:**

- Hallucinations (wrong tool calls)
- Infinite loops (max_iterations critical)
- Context overflow (long conversations)

**Mitigation:**

- Strict max_iterations (default: 5)
- Timeout enforcement (default: 60s)
- Budget limits (default: 10k tokens)
- Agent prompt engineering (clear goals, constraints)

#### ⚠️ 2. Cost Runaway

**Without controls, costs can explode:**

```typescript
// Dangerous: No limits
{
  type: "agent_delegation",
  max_iterations: 100,  // ← Can run forever
  budget: undefined      // ← No cost limit
}
```

**Mitigation:**

- Hard-coded max limits (max_iterations ≤ 20)
- Required budget field (make it explicit)
- Cost alerts (notify if >$1 per workflow)

#### ⚠️ 3. Security

**Agents with broad tool access are risky:**

```typescript
// Dangerous: Agent can delete anything
{
  agent_tools: ["filesystem:*"],  // ← Includes delete_file
  agent_goal: "Clean up old files"
}
```

**Mitigation:**

- Whitelist-only tool access (explicit allow list)
- Audit logs (track all agent tool calls)
- Dry-run mode (preview agent actions before executing)

---

## GraphRAG Integration

### Learning Opportunities

**What GraphRAG can learn from agent tasks:**

1. **Optimal Agent Roles**
   ```typescript
   // Learn: "researcher" role works well for "API analysis" goals
   graphRAG.addPattern({
     agent_role: "researcher",
     goal_type: "api_analysis",
     success_rate: 0.92,
     avg_tokens: 5000,
   });
   ```

2. **Model Selection**
   ```typescript
   // Learn: haiku sufficient for research, sonnet needed for implementation
   graphRAG.addPattern({
     task_type: "research",
     optimal_model: "haiku",
     cost_vs_quality: 0.95, // 95% quality at 1/5 the cost
   });
   ```

3. **Agent Dependencies**
   ```typescript
   // Learn: "researcher" → "coder" is common pattern
   graphRAG.addEdge({
     from_role: "researcher",
     to_role: "coder",
     confidence: 0.88,
   });
   ```

4. **Tool Preferences**
   ```typescript
   // Learn: "researcher" role commonly uses web_search + read_file
   graphRAG.addPattern({
     agent_role: "researcher",
     common_tools: ["web_search:*", "read_file"],
     frequency: 0.85,
   });
   ```

### Suggestion Engine Enhancement

**DAGSuggester can now suggest agent tasks:**

```typescript
class DAGSuggester {
  async suggestDAG(intent: string): Promise<SuggestedDAG> {
    // Existing: Suggest MCP tools + code execution
    const mcpTasks = await this.suggestMCPTasks(intent);
    const codeTasks = await this.suggestCodeTasks(intent);

    // NEW: Suggest agent tasks based on complexity
    const agentTasks = await this.suggestAgentTasks(intent);

    return {
      tasks: [...mcpTasks, ...codeTasks, ...agentTasks],
      confidence: this.calculateConfidence(),
    };
  }

  private async suggestAgentTasks(intent: string): Promise<Task[]> {
    // Analyze intent complexity
    const complexity = await this.analyzeComplexity(intent);

    if (complexity < 0.5) {
      return []; // Simple intent, no agents needed
    }

    // Query GraphRAG for similar agent patterns
    const patterns = await this.graphRAG.findAgentPatterns(intent);

    return patterns.map((pattern) => ({
      type: "agent_delegation",
      agent_role: pattern.role,
      agent_goal: this.extractGoal(intent),
      agent_model: pattern.optimal_model,
      agent_tools: pattern.common_tools,
    }));
  }
}
```

---

## Migration Path

### Phase 1: Prototype (Week 1)

**Goal:** Validate core concept

**Deliverables:**

- ✅ `AgentExecutor` basic implementation
- ✅ Single agent task in DAG (PoC 1)
- ✅ Cost tracking
- ✅ Basic tests

**Effort:** 2-3 days

### Phase 2: Production-Ready (Week 2-3)

**Goal:** Full feature set

**Deliverables:**

- ✅ Agent pool management
- ✅ Parallel agent execution (PoC 2)
- ✅ Tool filtering
- ✅ Mixed tasks (PoC 3)
- ✅ GraphRAG integration
- ✅ Comprehensive tests
- ✅ Documentation

**Effort:** 5-7 days

### Phase 3: Optimization (Week 4+)

**Goal:** Production optimization

**Deliverables:**

- ✅ Agent result caching
- ✅ Cost optimization strategies
- ✅ Performance benchmarks
- ✅ Monitoring dashboards
- ✅ Best practices guide

**Effort:** 3-5 days

**Total Timeline:** 3-4 weeks

---

## Success Metrics

### Must-Have (Go/No-Go)

- ✅ Agent task executes successfully in DAG
- ✅ Parallel agent execution works
- ✅ Cost tracking accurate (±5%)
- ✅ Budget enforcement works (hard stop)
- ✅ No breaking changes to existing DAGs

### Performance Targets

- ✅ Agent task overhead <10% vs standalone agent
- ✅ Parallel agents achieve >80% theoretical speedup
- ✅ Mixed DAG (MCP + code + agent) executes without errors

### Cost Targets

- ✅ Avg cost per agent task <$0.01 (with haiku)
- ✅ Cost visibility (track per task, per agent, per workflow)
- ✅ Budget overrun = 0 (hard enforcement)

---

## Recommendation

### Go/No-Go: **🟢 GO**

**Rationale:**

1. **Technical feasibility:** High (builds on existing architecture)
2. **Value proposition:** Strong (best of DAG + multi-agents)
3. **Risk:** Manageable (budget enforcement, tool filtering, timeouts)
4. **Competitive advantage:** Significant (no framework does this)

**Conditions:**

- ✅ Start with Phase 1 (prototype) to validate assumptions
- ✅ Hard budget/timeout limits mandatory (no opt-out)
- ✅ Cost monitoring dashboard before production
- ✅ Clear migration guide for users

### Next Steps

**Immediate (This Week):**

1. Create `docs/spikes/spike-hybrid-dag-agent-delegation.md` ✅
2. Prototype `AgentExecutor` class (PoC 1)
3. Test single agent task in DAG
4. Measure costs (haiku vs sonnet)

**Short-Term (Next 2 Weeks):**

1. Implement full `AgentDelegationTask` type
2. Parallel agent execution (PoC 2)
3. Tool filtering
4. GraphRAG integration

**Medium-Term (Month 2):**

1. Production deployment
2. Cost optimization
3. Documentation + examples
4. Community feedback

---

## Open Questions

### Q1: Agent Conversation Persistence?

**Question:** Should agent conversations be saved/logged?

**Options:**

- A. Ephemeral (discard after task completes)
- B. Log to PGlite (for debugging/audit)
- C. Optional (controlled by user)

**Recommendation:** **B (Log to PGlite)** - Critical for debugging and audit trails.

### Q2: Agent Context Limit?

**Question:** Max context size for agent_context?

**Options:**

- A. No limit (risk: overflow)
- B. 10k tokens (practical limit)
- C. Dynamic based on model

**Recommendation:** **B (10k tokens)** - Prevent context overflow, force summarization.

### Q3: Agent Failure Handling?

**Question:** If agent task fails, how does DAG handle it?

**Options:**

- A. Fail entire DAG (strict)
- B. Mark as `failed_safe` if no side_effects (resilient)
- C. Retry with different model (adaptive)

**Recommendation:** **B (failed_safe pattern)** - Consistent with ADR-010 safe-to-fail branches.

### Q4: Agent Result Caching?

**Question:** Should identical agent goals return cached results?

**Example:**

```typescript
// First execution
{
  agent_goal: "Research OAuth2 best practices";
} // → Execute, cache result

// Second execution (same goal)
{
  agent_goal: "Research OAuth2 best practices";
} // → Return cached?
```

**Options:**

- A. No caching (always fresh)
- B. TTL cache (e.g., 24h)
- C. Opt-in caching (user decides)

**Recommendation:** **B (TTL cache with 24h default)** - Balance freshness and cost.

---

## Conclusion

La **Stratégie D (Hybrid DAG + Agent Delegation)** est techniquement faisable, stratégiquement
pertinente, et offre une différenciation forte vs frameworks multi-agents existants.

**Key Innovation:**

> Agents ne sont plus des entités autonomes, mais des **tasks orchestrables** dans un DAG,
> permettant parallélisme, context optimization, et GraphRAG learning.

**Recommendation: GO with phased rollout.**

---

**Next Spike:** Agent pool optimization strategies (if this spike validates as GO)

**Date:** 2025-11-23 **Author:** Claude Sonnet 4.5 **Status:** ✅ Ready for Review
