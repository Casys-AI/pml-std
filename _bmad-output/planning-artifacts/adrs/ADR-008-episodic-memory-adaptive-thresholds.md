# ADR-008: Episodic Memory & Adaptive Thresholds for Meta-Learning

**Status:** ✅ Implemented **Date:** 2025-11-13 | **Updated:** 2025-12-18 | **Deciders:** BMad
**Prerequisite:** ADR-007 + Epic 3 (Sandbox)

**Implementation Status (2025-12-05):**

- ✅ **Phase 1 (Storage Foundation):** DONE
  - Migration 007: `episodic_events` + `adaptive_thresholds` tables
  - `EpisodicMemoryStore` class (280 LOC, 9 tests passing)
  - `AdaptiveThresholdManager` persistence (+100 LOC)
  - Story 4.2 adaptive learning already implemented (2025-11-05)
- ✅ **Phase 2 (Loop Integrations):** DONE
  - ControlledExecutor integration (auto-capture events) - `src/dag/controlled-executor.ts`
  - DAGSuggester context boost (episodic memory queries) - `src/graphrag/dag-suggester.ts`

**Évolutions Epic 11 (2025-12-18):**

- **TD Learning:** Remplace EMA pour les mises à jour de poids (plus réactif, incrémental)
- **PER:** Prioritized Experience Replay pour prioriser les traces surprenantes
- **Référence:** `docs/epics/epic-11-learning-from-traces.md` (Stories 11.2, 11.3)

---

## Context

### Current State

Casys PML implements a 3-loop learning architecture (ADR-007):

- **Loop 1 (Execution):** Event stream + command queue + state management
- **Loop 2 (Adaptation):** Runtime DAG modification via AIL/HIL + DAGSuggester.replanDAG()
- **Loop 3 (Meta-Learning):** GraphRAGEngine.updateFromExecution() updates knowledge graph

**Current Loop 3 Implementation:**

```typescript
// src/graphrag/graph-engine.ts
async updateFromExecution(execution: WorkflowExecution): Promise<void> {
  // Update edges (co-occurrence patterns)
  // Recompute PageRank weights
  // Persist to PGlite
}
```

**Current Speculation (Story 2.5-4):**

```typescript
// Fixed confidence threshold
if (prediction.confidence > 0.7) {
  await executeSpeculatively(prediction);
}
```

### Gap Identified

Loop 3 meta-learning is **incomplete**:

1. **No historical context retrieval** - Cannot learn from similar past executions
2. **Fixed thresholds** - Speculation threshold (0.7) doesn't adapt to actual success rates
3. **No learning feedback** - System doesn't know if speculations were correct/wrong
4. **Missing episodic bridge** - No connection between Loop 1 events and Loop 3 learning

### Problem Statement

**CoALA Framework Insight (from spike-coala-comparison-adaptive-feedback.md):**

CoALA agents use:

- **Episodic Memory:** Store execution trajectories for retrieval during planning
- **Learning Loop:** Reflect on experiences → Update long-term memory → Improve future cycles

**Our Gap:**

- ✅ We have checkpoints (for resume), but NOT for learning retrieval
- ❌ Fixed thresholds waste compute (too aggressive) or miss opportunities (too conservative)
- ❌ No mechanism to capture "what worked" for similar contexts

**Example Scenario:**

```
Week 1: Workflow "data_analysis"
  - Speculation threshold: 0.7 (fixed)
  - Speculations: 50
  - Successful: 45 (90% success rate)
  → Too conservative! Could lower threshold to 0.65 and speculate more

Week 4: Same workflow type
  - Still using 0.7 threshold
  - Missing 20% more speculation opportunities
  → No learning occurred!
```

### Trigger

1. **Spike Analysis:** `spike-episodic-memory-adaptive-thresholds.md` identified architectural
   options
2. **CoALA Comparison:** Framework recommends episodic memory for context-aware decisions
3. **Performance Opportunity:** Adaptive thresholds can improve speculation hit rate by 15-25%
4. **Stories Ready:** 2.5-5 (Episodic Memory) and 2.5-6 (Adaptive Thresholds) drafted

---

## Decision Drivers

### Priorities (order of importance)

1. **Learning Effectiveness (35%)** - System improves over time from experience
2. **Performance Impact (25%)** - <10ms overhead on Loop 1, non-blocking writes
3. **Implementation Effort (20%)** - 5-7h total (fits in Epic 2.5 timeline)
4. **Data Quality (10%)** - Accurate success/failure tracking
5. **Developer Experience (10%)** - Observable, debuggable learning

### Constraints Non-Negotiables

- ❌ **Zero blocking on Loop 1** - Event capture must be <1ms, async writes
- ✅ **Backward compatibility** - Existing SpeculativeExecutor continues working
- ✅ **Conservative learning** - Start at 0.92 threshold, gradual adjustments
- ✅ **PGlite storage** - No external dependencies
- ✅ **Privacy-safe** - No PII in episodic events

---

## Options Considered

### Decision 1: Episodic Memory Storage Strategy

#### Option 1A: Pure JSONB (Flexible Schema)

**Architecture:**

```sql
CREATE TABLE episodic_events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  data JSONB NOT NULL,  -- All fields in JSONB
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_episodic_data ON episodic_events USING GIN (data);
```

**Score:** 72/100

**Pros:**

- 🟢 Maximum flexibility (schema can evolve)
- 🟢 No migrations needed for new event types
- 🟢 GIN index for fast JSONB queries

**Cons:**

- 🔴 No type safety at DB level
- 🔴 Complex queries (JSONB path expressions)
- 🟡 Harder to analyze data

---

#### Option 1B: Typed Columns Only

**Architecture:**

```sql
CREATE TABLE episodic_events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  task_id TEXT,
  confidence REAL,
  was_correct BOOLEAN,
  execution_time_ms INTEGER,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
```

**Score:** 68/100

**Pros:**

- 🟢 Type safety at DB level
- 🟢 Simple queries (standard SQL)
- 🟢 Easy analytics

**Cons:**

- 🔴 Rigid schema (migration needed for changes)
- 🔴 Event types have different fields (NULL proliferation)
- 🟡 Less flexible for future needs

---

#### Option 1C: Hybrid (Typed + JSONB) ⭐ RECOMMENDED

**Architecture:**

```sql
CREATE TABLE episodic_events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- Typed: 'speculation_start', 'task_complete', etc.
  task_id TEXT,               -- Typed: For indexing/joins
  timestamp TIMESTAMPTZ DEFAULT NOW(),

  -- JSONB for flexible event-specific data
  data JSONB NOT NULL,

  -- Indexes
  CONSTRAINT valid_event_type CHECK (event_type IN ('speculation_start', 'task_complete', 'ail_decision', 'hil_decision'))
);

CREATE INDEX idx_episodic_workflow ON episodic_events(workflow_id);
CREATE INDEX idx_episodic_type ON episodic_events(event_type);
CREATE INDEX idx_episodic_timestamp ON episodic_events(timestamp DESC);
CREATE INDEX idx_episodic_data ON episodic_events USING GIN (data);
```

**Score:** 85/100

**Pros:**

- ✅ Type safety for common fields (workflow_id, event_type, task_id)
- ✅ Flexibility for event-specific data (JSONB)
- ✅ Fast queries on typed columns
- ✅ Evolvable schema (add JSONB fields without migration)
- ✅ Best of both worlds

**Cons:**

- ⚠️ Slightly more complex (but manageable)

**Verdict:** ⭐ **Option 1C - Hybrid approach**

---

### Decision 2: Retrieval Strategy

#### Option 2A: Exact Context Hash Matching

**Architecture:**

```typescript
async retrieveRelevant(context: Record<string, any>): Promise<EpisodicEvent[]> {
  const contextHash = hashContext(context); // Hash key features

  return await this.db.query(`
    SELECT * FROM episodic_events
    WHERE data->>'contextHash' = $1
    ORDER BY timestamp DESC
    LIMIT 100
  `, [contextHash]);
}
```

**Score:** 82/100

**Pros:**

- 🟢 Fast (index lookup)
- 🟢 Deterministic (exact matches)
- 🟢 Low overhead (<5ms)

**Cons:**

- 🔴 No fuzzy matching (similar workflows not found)
- 🟡 Context definition critical (hash keys)

---

#### Option 2B: Vector Embeddings + Similarity

**Architecture:**

```typescript
async retrieveRelevant(context: Record<string, any>): Promise<EpisodicEvent[]> {
  const contextEmbedding = await embedContext(context);

  return await this.db.query(`
    SELECT * FROM episodic_events
    WHERE embedding <-> $1 < 0.25
    ORDER BY embedding <-> $1
    LIMIT 100
  `, [contextEmbedding]);
}
```

**Score:** 76/100

**Pros:**

- 🟢 Fuzzy matching (similar workflows found)
- 🟢 Semantic understanding

**Cons:**

- 🔴 Embedding overhead (50-100ms)
- 🔴 Requires pgvector
- 🔴 Storage overhead (embeddings)
- 🟡 More complex

---

#### Option 2C: Hybrid (Hash for MVP, Embeddings Phase 2) ⭐ RECOMMENDED

**MVP (Phase 1):**

```typescript
// Fast exact matching
const contextHash = hashContext({ workflowType, domain });
const events = await this.db.query(
  `
  SELECT * FROM episodic_events
  WHERE data->>'contextHash' = $1
  ORDER BY timestamp DESC
  LIMIT 100
`,
  [contextHash],
);
```

**Phase 2 Enhancement:**

```typescript
// Add vector similarity for fuzzy matching
if (events.length < 10) {
  // Not enough exact matches, try semantic search
  events = await this.vectorSearch(context);
}
```

**Score:** 87/100

**Pros:**

- ✅ Fast MVP (exact matching)
- ✅ Evolvable (add embeddings later)
- ✅ Pragmatic (start simple, enhance if needed)

**Verdict:** ⭐ **Option 2C - Hash matching for MVP, embeddings as Phase 2 enhancement**

---

### Decision 3: Adaptive Thresholds Learning Algorithm

#### Option 3A: Simple Gradient Descent

**Algorithm:**

```typescript
adjustThreshold(currentThreshold: number, successRate: number): number {
  if (successRate > 0.90) {
    return Math.max(0.70, currentThreshold - 0.02); // Lower
  } else if (successRate < 0.80) {
    return Math.min(0.95, currentThreshold + 0.02); // Raise
  }
  return currentThreshold; // Converged
}
```

**Score:** 78/100

**Pros:**

- 🟢 Simple to understand
- 🟢 Predictable behavior
- 🟢 Easy to debug

**Cons:**

- 🔴 Can oscillate around optimal
- 🟡 Fixed step size (0.02)
- 🟡 Slow convergence

---

#### Option 3B: Exponential Moving Average (EMA) ⭐ RECOMMENDED

**Algorithm:**

```typescript
adjustThreshold(currentThreshold: number, successRate: number): number {
  const targetSuccessRate = 0.85;
  const learningRate = 0.05;

  // Calculate optimal threshold based on success rate
  let optimalThreshold = currentThreshold;

  if (successRate > 0.90) {
    // Too conservative, lower threshold
    optimalThreshold = currentThreshold - (successRate - targetSuccessRate) * 0.1;
  } else if (successRate < 0.80) {
    // Too aggressive, raise threshold
    optimalThreshold = currentThreshold + (targetSuccessRate - successRate) * 0.1;
  }

  // Smooth adjustment with EMA
  const newThreshold = currentThreshold * (1 - learningRate) + optimalThreshold * learningRate;

  // Clamp to bounds
  return Math.max(0.70, Math.min(0.95, newThreshold));
}
```

**Score:** 86/100

**Pros:**

- 🟢 Smooth convergence (no oscillation)
- 🟢 Adaptive step size (proportional to error)
- 🟢 Stable in presence of noise
- 🟢 Industry-proven (RL, control systems)

**Cons:**

- ⚠️ Slightly more complex
- ⚠️ Learning rate tuning needed

**Verdict:** ⭐ **Option 3B - Exponential Moving Average**

---

#### Option 3C: PID Controller

**Score:** 82/100 - More sophisticated but overkill for our use case

---

### Decision 4: Context Granularity

#### Option 4A: Per Workflow Type ⭐ RECOMMENDED

**Example:**

```typescript
context = { workflowType: 'data_analysis' } → threshold: 0.82
context = { workflowType: 'web_scraping' } → threshold: 0.91
```

**Score:** 80/100

**Pros:**

- 🟢 Shared learning across users
- 🟢 Fast convergence (more data)
- 🟢 Privacy-friendly (no user data)
- 🟢 Simpler implementation

**Cons:**

- 🟡 No personalization

**Verdict:** ⭐ **Option 4A - Per workflow type for MVP**

---

#### Option 4B: Per User + Workflow Type

**Score:** 75/100 - Better personalization but slower convergence, privacy concerns

---

#### Option 4C: Global (Single Threshold)

**Score:** 60/100 - Too coarse, doesn't adapt to workflow diversity

---

## Decision

### Architecture Choisie: **Episodic Memory with Adaptive Thresholds (Hybrid Storage + EMA Learning)** ⭐⭐

**Rationale:** Combines pragmatic MVP (fast, simple) with clear evolution path (Phase 2
enhancements).

### Architecture Détaillée

#### 1. Episodic Memory Storage (Hybrid)

```typescript
// src/learning/types.ts
export interface EpisodicEvent {
  id: string; // UUID
  workflow_id: string; // Links to workflow execution
  event_type: "speculation_start" | "task_complete" | "ail_decision" | "hil_decision";
  task_id?: string; // Optional task reference
  timestamp: number;
  data: {
    context?: Record<string, any>;
    prediction?: {
      toolId: string;
      confidence: number;
      reasoning: string;
    };
    result?: {
      status: "success" | "error";
      output?: unknown;
      executionTimeMs?: number;
    };
    decision?: {
      type: "ail" | "hil";
      action: string;
      reasoning: string;
    };
  };
}
```

**PGlite Schema:**

```sql
CREATE TABLE episodic_events (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('speculation_start', 'task_complete', 'ail_decision', 'hil_decision')),
  task_id TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  data JSONB NOT NULL,

  CONSTRAINT valid_data CHECK (data IS NOT NULL)
);

CREATE INDEX idx_episodic_workflow ON episodic_events(workflow_id);
CREATE INDEX idx_episodic_type ON episodic_events(event_type);
CREATE INDEX idx_episodic_timestamp ON episodic_events(timestamp DESC);
CREATE INDEX idx_episodic_data ON episodic_events USING GIN (data);
```

#### 2. Episodic Memory Manager

```typescript
// src/learning/episodic-memory-store.ts
export class EpisodicMemoryStore {
  private buffer: EpisodicEvent[] = [];
  private bufferSize = 50; // Batch writes

  constructor(private db: PGliteClient) {}

  /**
   * Capture event (non-blocking, buffered)
   */
  async capture(event: Omit<EpisodicEvent, "id">): Promise<void> {
    const fullEvent: EpisodicEvent = {
      id: crypto.randomUUID(),
      ...event,
    };

    this.buffer.push(fullEvent);

    // Flush if buffer full (non-blocking)
    if (this.buffer.length >= this.bufferSize) {
      this.flush().catch((err) => console.error("Episodic flush error:", err));
    }
  }

  /**
   * Flush buffer to PGlite (async, batched)
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const toFlush = [...this.buffer];
    this.buffer = []; // Clear buffer immediately

    // Batch insert
    await this.db.transaction(async (tx) => {
      for (const event of toFlush) {
        await tx.query(
          `
          INSERT INTO episodic_events (id, workflow_id, event_type, task_id, timestamp, data)
          VALUES ($1, $2, $3, $4, to_timestamp($5), $6)
        `,
          [
            event.id,
            event.workflow_id,
            event.event_type,
            event.task_id,
            event.timestamp / 1000,
            JSON.stringify(event.data),
          ],
        );
      }
    });
  }

  /**
   * Retrieve relevant events for context
   */
  async retrieveRelevant(
    context: Record<string, any>,
    options: {
      limit?: number;
      eventTypes?: string[];
    } = {},
  ): Promise<EpisodicEvent[]> {
    const { limit = 100, eventTypes } = options;

    // Hash context for exact matching
    const contextHash = this.hashContext(context);

    let query = `
      SELECT * FROM episodic_events
      WHERE data->>'contextHash' = $1
    `;

    if (eventTypes && eventTypes.length > 0) {
      query += ` AND event_type = ANY($2)`;
    }

    query += ` ORDER BY timestamp DESC LIMIT $${eventTypes ? 3 : 2}`;

    const params = eventTypes ? [contextHash, eventTypes, limit] : [contextHash, limit];

    const result = await this.db.query(query, params);

    return result.rows.map((row) => ({
      id: row.id,
      workflow_id: row.workflow_id,
      event_type: row.event_type,
      task_id: row.task_id,
      timestamp: new Date(row.timestamp).getTime(),
      data: row.data,
    }));
  }

  /**
   * Get workflow events (all events for a workflow)
   */
  async getWorkflowEvents(workflowId: string): Promise<EpisodicEvent[]> {
    const result = await this.db.query(
      `
      SELECT * FROM episodic_events
      WHERE workflow_id = $1
      ORDER BY timestamp ASC
    `,
      [workflowId],
    );

    return result.rows.map((row) => this.deserialize(row));
  }

  /**
   * Prune old events (retention policy)
   */
  async pruneOldEvents(retentionDays: number = 30): Promise<number> {
    const result = await this.db.query(`
      DELETE FROM episodic_events
      WHERE timestamp < NOW() - INTERVAL '${retentionDays} days'
      RETURNING id
    `);

    return result.rows.length;
  }

  private hashContext(context: Record<string, any>): string {
    const keys = ["workflowType", "domain", "complexity"];
    return keys
      .map((k) => `${k}:${context[k] ?? "default"}`)
      .join("|");
  }

  private deserialize(row: any): EpisodicEvent {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      event_type: row.event_type,
      task_id: row.task_id,
      timestamp: new Date(row.timestamp).getTime(),
      data: row.data,
    };
  }
}
```

#### 3. Adaptive Threshold Manager (EMA Algorithm)

```typescript
// src/learning/adaptive-threshold-manager.ts
export interface ThresholdConfig {
  initial: number; // 0.92 (conservative start)
  min: number; // 0.70
  max: number; // 0.95
  targetSuccessRate: number; // 0.85
  learningRate: number; // 0.05 (EMA smoothing)
  evaluationWindow: number; // 50 (samples before adjustment)
}

export interface ThresholdRecord {
  contextHash: string;
  contextKeys: Record<string, any>;
  threshold: number;
  successRate: number;
  sampleCount: number;
  updatedAt: Date;
}

export class AdaptiveThresholdManager {
  private cache: Map<string, ThresholdRecord> = new Map();

  constructor(
    private db: PGliteClient,
    private config: ThresholdConfig = {
      initial: 0.92,
      min: 0.70,
      max: 0.95,
      targetSuccessRate: 0.85,
      learningRate: 0.05,
      evaluationWindow: 50,
    },
  ) {}

  /**
   * Get threshold for context (with caching)
   */
  async getThreshold(context: Record<string, any>): Promise<number> {
    const contextHash = this.hashContext(context);

    // Check cache
    if (this.cache.has(contextHash)) {
      return this.cache.get(contextHash)!.threshold;
    }

    // Query database
    const result = await this.db.query(
      `
      SELECT * FROM adaptive_thresholds
      WHERE context_hash = $1
    `,
      [contextHash],
    );

    if (result.rows.length > 0) {
      const record = this.deserialize(result.rows[0]);
      this.cache.set(contextHash, record);
      return record.threshold;
    }

    // No record: return initial threshold
    return this.config.initial;
  }

  /**
   * Update threshold based on speculation outcomes
   */
  async updateFromEpisodes(
    context: Record<string, any>,
    episodes: EpisodicEvent[],
  ): Promise<void> {
    const contextHash = this.hashContext(context);

    // Filter speculation events
    const speculationEvents = episodes.filter(
      (e) => e.event_type === "speculation_start" && e.data.prediction,
    );

    if (speculationEvents.length < this.config.evaluationWindow) {
      // Not enough samples, skip update
      return;
    }

    // Calculate success rate
    const successful =
      speculationEvents.filter((e) => e.data.prediction?.wasCorrect === true).length;
    const successRate = successful / speculationEvents.length;

    // Get current threshold
    const currentThreshold = await this.getThreshold(context);

    // Apply EMA learning algorithm
    const newThreshold = this.adjustThreshold(
      currentThreshold,
      successRate,
    );

    // Save to database
    await this.saveThreshold(
      contextHash,
      context,
      newThreshold,
      successRate,
      speculationEvents.length,
    );

    console.log(
      `[AdaptiveThreshold] Context: ${contextHash}, Success: ${
        (successRate * 100).toFixed(1)
      }%, Threshold: ${currentThreshold.toFixed(3)} → ${newThreshold.toFixed(3)}`,
    );
  }

  /**
   * EMA learning algorithm
   */
  private adjustThreshold(
    currentThreshold: number,
    successRate: number,
  ): number {
    const { targetSuccessRate, learningRate, min, max } = this.config;

    // Calculate optimal threshold based on success rate
    let optimalThreshold = currentThreshold;

    if (successRate > 0.90) {
      // Too conservative (success >90%)
      // Lower threshold to speculate more
      optimalThreshold = currentThreshold - (successRate - targetSuccessRate) * 0.1;
    } else if (successRate < 0.80) {
      // Too aggressive (success <80%)
      // Raise threshold to speculate less
      optimalThreshold = currentThreshold + (targetSuccessRate - successRate) * 0.1;
    }
    // else: success rate in target range (80-90%), no change needed

    // Apply EMA smoothing
    const newThreshold = currentThreshold * (1 - learningRate) + optimalThreshold * learningRate;

    // Clamp to bounds
    return Math.max(min, Math.min(max, newThreshold));
  }

  /**
   * Get metrics for all contexts
   */
  async getThresholdMetrics(): Promise<{
    contexts: Array<{
      context: string;
      threshold: number;
      successRate: number;
      sampleCount: number;
      converged: boolean;
    }>;
  }> {
    const result = await this.db.query(`
      SELECT
        context_hash,
        context_keys,
        threshold,
        success_rate,
        sample_count
      FROM adaptive_thresholds
      ORDER BY updated_at DESC
    `);

    return {
      contexts: result.rows.map((row) => ({
        context: row.context_hash,
        threshold: row.threshold,
        successRate: row.success_rate,
        sampleCount: row.sample_count,
        converged: this.isConverged(row.threshold, row.success_rate),
      })),
    };
  }

  private isConverged(threshold: number, successRate: number): boolean {
    // Converged if success rate is in target range (80-90%)
    return successRate >= 0.80 && successRate <= 0.90;
  }

  private hashContext(context: Record<string, any>): string {
    const keys = ["workflowType", "domain", "complexity"];
    return keys
      .map((k) => `${k}:${context[k] ?? "default"}`)
      .join("|");
  }

  private async saveThreshold(
    contextHash: string,
    context: Record<string, any>,
    threshold: number,
    successRate: number,
    sampleCount: number,
  ): Promise<void> {
    await this.db.query(
      `
      INSERT INTO adaptive_thresholds (
        context_hash,
        context_keys,
        threshold,
        success_rate,
        sample_count,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (context_hash) DO UPDATE SET
        threshold = $3,
        success_rate = $4,
        sample_count = adaptive_thresholds.sample_count + $5,
        updated_at = NOW()
    `,
      [
        contextHash,
        JSON.stringify(context),
        threshold,
        successRate,
        sampleCount,
      ],
    );

    // Update cache
    this.cache.set(contextHash, {
      contextHash,
      contextKeys: context,
      threshold,
      successRate,
      sampleCount,
      updatedAt: new Date(),
    });
  }

  private deserialize(row: any): ThresholdRecord {
    return {
      contextHash: row.context_hash,
      contextKeys: row.context_keys,
      threshold: row.threshold,
      successRate: row.success_rate,
      sampleCount: row.sample_count,
      updatedAt: new Date(row.updated_at),
    };
  }
}
```

**PGlite Schema:**

```sql
CREATE TABLE adaptive_thresholds (
  context_hash TEXT PRIMARY KEY,
  context_keys JSONB NOT NULL,
  threshold REAL NOT NULL,
  success_rate REAL NOT NULL,
  sample_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_threshold CHECK (threshold >= 0.7 AND threshold <= 0.95),
  CONSTRAINT valid_success_rate CHECK (success_rate >= 0.0 AND success_rate <= 1.0)
);

CREATE INDEX idx_adaptive_threshold_updated ON adaptive_thresholds(updated_at DESC);
CREATE INDEX idx_adaptive_threshold_context ON adaptive_thresholds USING GIN (context_keys);
```

#### 4. Integration with Loops

**Loop 1 (Execution) - Capture Events:**

```typescript
// src/dag/controlled-executor.ts
class ControlledExecutor extends ParallelExecutor {
  constructor(
    toolExecutor: ToolExecutor,
    private episodicMemory: EpisodicMemoryStore,
  ) {}

  async executeTask(task: Task): Promise<TaskResult> {
    const result = await super.executeTask(task);

    // Capture event (non-blocking)
    await this.episodicMemory.capture({
      workflow_id: this.executionId,
      event_type: "task_complete",
      task_id: task.id,
      timestamp: Date.now(),
      data: {
        result: {
          status: result.success ? "success" : "error",
          output: result.output,
          executionTimeMs: result.executionTimeMs,
        },
      },
    });

    return result;
  }
}
```

**Loop 2 (Adaptation) - Retrieve Context:**

```typescript
// src/graphrag/dag-suggester.ts
class DAGSuggester {
  constructor(
    private graphEngine: GraphRAGEngine,
    private episodicMemory: EpisodicMemoryStore,
  ) {}

  async predictNextNodes(
    state: WorkflowState,
    completed: TaskResult[],
  ): Promise<PredictedNode[]> {
    // Retrieve relevant episodes
    const episodes = await this.episodicMemory.retrieveRelevant(
      state.context,
      { eventTypes: ["task_complete", "speculation_start"], limit: 50 },
    );

    // Boost confidence based on episodic patterns
    const predictions = await this.graphEngine.predictNextNodes(state, completed);

    return this.boostWithEpisodicContext(predictions, episodes);
  }

  private boostWithEpisodicContext(
    predictions: PredictedNode[],
    episodes: EpisodicEvent[],
  ): PredictedNode[] {
    // Boost confidence if similar context succeeded before
    return predictions.map((pred) => {
      const successCount = episodes.filter((e) =>
        e.data.prediction?.toolId === pred.task.toolId &&
        e.data.prediction?.wasCorrect === true
      ).length;

      if (successCount > 0) {
        const boost = Math.min(0.10, successCount * 0.02); // Max +10%
        pred.confidence = Math.min(1.0, pred.confidence + boost);
        pred.reasoning += ` (episodic boost: +${(boost * 100).toFixed(0)}%)`;
      }

      return pred;
    });
  }
}
```

**Loop 3 (Meta-Learning) - Update Thresholds:**

```typescript
// src/graphrag/graph-engine.ts
class GraphRAGEngine {
  constructor(
    private storage: GraphStorage,
    private episodicMemory: EpisodicMemoryStore,
    private adaptiveThresholds: AdaptiveThresholdManager,
  ) {}

  async updateFromExecution(execution: WorkflowExecution): Promise<void> {
    // Existing: Update graph edges and PageRank
    await this.updateGraphFromExecution(execution);

    // NEW: Update adaptive thresholds
    const episodes = await this.episodicMemory.getWorkflowEvents(
      execution.workflow_id,
    );

    await this.adaptiveThresholds.updateFromEpisodes(
      execution.context,
      episodes,
    );
  }
}
```

**SpeculativeExecutor - Use Adaptive Threshold:**

```typescript
// src/dag/speculative-executor.ts
class SpeculativeExecutor {
  constructor(
    private executor: ParallelExecutor,
    private adaptiveThresholds: AdaptiveThresholdManager,
  ) {}

  async start(
    predictions: PredictedNode[],
    context: Record<string, any>,
  ): Promise<void> {
    // Get adaptive threshold for context
    const threshold = await this.adaptiveThresholds.getThreshold(context);

    console.log(
      `[Speculation] Using adaptive threshold: ${threshold.toFixed(3)} for context:`,
      context,
    );

    // Only speculate on high-confidence predictions
    const highConfidence = predictions.filter(
      (p) => p.confidence > threshold,
    );

    for (const pred of highConfidence) {
      this.executeInBackground(pred);
    }
  }
}
```

---

## Consequences

### Positive

- ✅ **Continuous learning** - System improves from every execution
- ✅ **Context-aware** - Different thresholds per workflow type (data_analysis vs web_scraping)
- ✅ **Performance** - <1ms event capture, <10ms retrieval, async writes
- ✅ **Storage efficient** - ~5MB for 10,000 events
- ✅ **Convergence** - Thresholds reach optimal (0.80-0.88) in 10-15 workflows (~2 weeks)
- ✅ **Observable** - Metrics show learning progress (success rate, threshold evolution)
- ✅ **Conservative start** - 0.92 initial threshold minimizes risk
- ✅ **Smooth learning** - EMA prevents oscillation
- ✅ **No breaking changes** - Extends existing SpeculativeExecutor
- ✅ **Privacy-safe** - No PII, context hashing only
- ✅ **Low effort** - 5-7h total implementation

### Negative

- ⚠️ **Cold start** - First workflows use conservative threshold (0.92)
- ⚠️ **Learning delay** - Requires 50-100 speculations before first adjustment
- ⚠️ **Storage growth** - Retention policy needed (30 days / 10,000 events)
- ⚠️ **Context definition** - Hash keys must be chosen carefully
- ⚠️ **No fuzzy matching** - MVP uses exact hash matching only

### Neutral

- 🟡 **Learning rate tuning** - May need adjustment based on real data
- 🟡 **Memory overhead** - ~2MB for in-memory buffer + cache
- 🟡 **PGlite dependency** - Requires migration script

---

## Implementation Plan

### Phase 1: Episodic Memory Foundation (2.5-3h) - Story 2.5-5

**Sprint 1: Storage & Data Model (1h)**

- Create migration `006_episodic_events.sql`
- Define `EpisodicEvent` interface
- Implement `EpisodicMemoryStore` class

**Sprint 2: Integration (1-1.5h)**

- Integrate with `ControlledExecutor` (capture events)
- Integrate with `DAGSuggester` (retrieve context)
- Unit tests (capture, flush, retrieve)

**Sprint 3: Retention & Cleanup (0.5h)**

- Implement pruning policy
- Scheduled cleanup task

### Phase 2: Adaptive Thresholds Learning (2-2.5h) - Story 2.5-6

**Sprint 1: Threshold Storage & Manager (1h)**

- Create migration `007_adaptive_thresholds.sql`
- Define `ThresholdConfig` interface
- Implement `AdaptiveThresholdManager` class

**Sprint 2: Learning Algorithm (0.5-1h)**

- Implement EMA adjustment algorithm
- Convergence detection
- Metrics tracking

**Sprint 3: Integration (0.5h)**

- Integrate with `SpeculativeExecutor` (use threshold)
- Integrate with `GraphRAGEngine` (update threshold)
- Unit tests (learning algorithm, bounds)

**Total MVP:** 4.5-5.5 hours

### Phase 3: Validation & Monitoring (1h)

- End-to-end tests (complete learning cycle)
- Performance benchmarks
- Metrics dashboard

---

## Success Metrics

### Must-Have (Go/No-Go)

- ✅ Event capture overhead <1ms
- ✅ Batch writes non-blocking
- ✅ Retrieval latency <10ms
- ✅ Threshold bounds respected (0.70-0.95)
- ✅ Conservative initial threshold (0.92)
- ✅ Zero breaking changes

### Performance Targets

- ✅ Storage: <5MB for 10,000 events
- ✅ Write throughput: >1000 events/sec (batched)
- ✅ Read latency: <10ms (hash matching)
- ✅ Retention policy: 30 days or 10,000 events

### Learning Targets

- ✅ Convergence time: 10-15 workflows (~1-2 weeks)
- ✅ Success rate: 80-90% after convergence
- ✅ Episodic boost: +2-10% confidence
- ✅ Threshold stability: <±0.02 variance after convergence

### Quality Targets

- ✅ Test coverage: >90%
- ✅ No data loss on crash (batch writes)
- ✅ Privacy compliance (no PII)

---

## Risk Assessment & Mitigation

### Risk 1: Cold Start Performance ⚠️ Medium

**Impact:** First workflows use conservative threshold (0.92) → miss speculation opportunities

**Mitigation:**

- Acceptable trade-off (safety > speed for new workflows)
- Pre-seed with default thresholds per domain
- Monitor convergence time, optimize if >3 weeks

**Contingency:** Allow manual threshold override for power users

### Risk 2: Storage Growth 🟡 Low-Medium

**Impact:** Episodic events accumulate → PGlite file grows

**Mitigation:**

- Retention policy: 30 days OR 10,000 events (hybrid)
- Automated pruning (scheduled cleanup)
- Monitoring alerts if storage >50MB

**Contingency:** Add compression, archive old events

### Risk 3: Learning Instability 🟡 Low

**Impact:** EMA algorithm doesn't converge or oscillates

**Mitigation:**

- Conservative learning rate (0.05)
- Evaluation window (50 samples minimum)
- Bounds enforcement (0.70-0.95)

**Testing:** Simulation with synthetic data before production

### Risk 4: Context Hash Collisions 🟡 Low

**Impact:** Different workflows share same hash → incorrect learning

**Mitigation:**

- Include multiple context keys (workflowType, domain, complexity)
- Monitor collision rate
- Add more keys if collisions >5%

**Contingency:** Switch to vector embeddings (Phase 2)

---

## Related Decisions

### ADR-007: DAG Adaptive Feedback Loops

- **Status:** Accepted
- **Impact:** Provides Loop 1-2 foundation, this ADR extends Loop 3

### Related Spikes

- **spike-agent-human-dag-feedback-loop.md** - Execution & Control (Stories 2.5-1 to 2.5-4)
- **spike-episodic-memory-adaptive-thresholds.md** - Detailed architecture analysis
- **spike-coala-comparison-adaptive-feedback.md** - Theoretical foundation

---

## References

### Architectural Decisions

- ADR-007: DAG Adaptive Feedback Loops
- Spike: Episodic Memory & Adaptive Thresholds Architecture
- Spike: CoALA Comparison

### Research & Patterns

- **CoALA Framework:** Episodic memory for learning retrieval
- **Reinforcement Learning:** EMA for value estimation
- **Control Systems:** PID controllers for adaptive thresholds
- **LangGraph v1.0:** MessagesState patterns for event accumulation

### Implementation

- Story 2.5-5: Episodic Memory Foundation
- Story 2.5-6: Adaptive Thresholds Learning
- `src/graphrag/graph-engine.ts` - Existing Loop 3 implementation
- `src/dag/speculative-executor.ts` - Speculation with fixed threshold

---

## Change Log

### v1.0 (2025-11-13)

- Initial proposal
- Hybrid storage (typed + JSONB)
- EMA learning algorithm
- Per-workflow-type context granularity
- Status: Accepted

### v1.1 (2025-12-18)

- Référence Epic 11 évolutions (TD Learning, PER)
- Clarification mémoire sémantique (GraphRAG = hybride, Capabilities+Intent = pur)

---

## Approval

**Proposed by:** System Architect **Date:** 2025-11-13 **Approved by:** BMad **Approval date:**
2025-11-13

**Status:** ✅ Approved for implementation (after ADR-007 completion)

**Implementation Prerequisites:**

1. ✅ ADR-007 approved
2. ⏳ Stories 2.5-1 to 2.5-4 completed (Loop 1, Loop 2, base Loop 3)
3. ⏳ SpeculativeExecutor with fixed threshold (0.7) working

**Implementation Plan:**

1. ⏳ Update PRD with Loop 3 extended scope
2. ⏳ Update architecture.md with episodic memory + adaptive thresholds
3. ⏳ Create workflow for Stories 2.5-5 and 2.5-6
4. ⏳ Generate Story 2.5-5 (Episodic Memory - 2.5-3h)
5. ⏳ Generate Story 2.5-6 (Adaptive Thresholds - 2-2.5h)
6. ⏳ Begin implementation after ADR-007 stories complete

**Success Criteria:**

- Week 1: Conservative threshold (0.92), event capture working
- Week 2-3: First threshold adjustments, convergence observable
- Week 4+: Thresholds converged (0.80-0.88), stable 80-90% success rate

---

**Document Status:** ✅ Approved - Pending ADR-007 Completion
