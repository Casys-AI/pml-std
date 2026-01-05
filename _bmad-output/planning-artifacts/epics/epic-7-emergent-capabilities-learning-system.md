# Epic 7: Emergent Capabilities & Learning System

> **ADRs:** ADR-027 (Execute Code Graph Learning), ADR-028 (Emergent Capabilities System), ADR-032
> (Sandbox Worker RPC Bridge) **Research:** docs/research/research-technical-2025-12-03.md
> **Status:** In Progress (Story 7.1 done, Story 7.1b planned, Tech Debt Tool Scoring done)

**Expanded Goal (2-3 sentences):**

Transformer Casys PML en système où les capabilities **émergent de l'usage** plutôt que d'être
pré-définies. Implémenter un paradigme où Claude devient un **orchestrateur de haut niveau** qui
délègue l'exécution à Casys PML, récupérant des capabilities apprises et des suggestions proactives.
Ce système apprend continuellement des patterns d'exécution pour cristalliser des capabilities
réutilisables, offrant une différenciation unique par rapport aux solutions concurrentes (Docker
Dynamic MCP, Anthropic Programmatic Tool Calling).

**Value Delivery:**

- ✅ **Tool Scoring Refactor:** Simplification des algos de suggestion tools (ADR-038) - DONE
- 🔄 **Track** les tools réellement appelés via Worker RPC Bridge (native tracing)
- 🔄 **Apprend** des patterns d'exécution et les cristallise en capabilities
- 🔄 **Suggère** proactivement des capabilities et tools pertinents
- 🔄 **Réutilise** le code prouvé (skip génération Claude ~2-5s)
- 🔄 **S'améliore** continuellement avec chaque exécution

**Architecture 3 Couches (ADR-032 - Worker RPC Bridge):**

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: ORCHESTRATION (Claude)                                 │
│  • Reçoit l'intent utilisateur                                   │
│  • Query: "Capability existante?" → YES: execute cached          │
│  • NO: génère code → execute → learn                             │
│  • NE VOIT PAS: données brutes, traces, détails exécution        │
└─────────────────────────────────────────────────────────────────┘
                          ▲ IPC: result + suggestions
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2: CAPABILITY ENGINE + RPC BRIDGE                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Capability   │  │   Worker     │  │  Suggestion  │           │
│  │   Matcher    │  │   Bridge     │  │    Engine    │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│         │                 │                  │                   │
│         │     Native Tracing (ALL calls)     │                   │
│         └─────────────────┼──────────────────┘                   │
│              GraphRAG (PageRank, Louvain, Adamic-Adar)          │
└─────────────────────────────────────────────────────────────────┘
                          ▲ postMessage RPC (tool calls)
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3: EXECUTION (Deno Worker, permissions: "none")           │
│  • Tool proxies: mcp.server.tool() → RPC to bridge               │
│  • Capabilities: inline functions (Option B - no RPC overhead)   │
│  • Isolation complète, pas de discovery runtime                  │
└─────────────────────────────────────────────────────────────────┘
```

**Estimation:** 13 stories (7.1-7.7c), ~3-4 semaines

---

## Story Breakdown - Epic 7

**Story 7.1: IPC Tracking - Tool Usage Capture** ⚠️ SUPERSEDED

> **Status:** Done (2025-12-05) - BUT approach superseded by Story 7.1b
>
> **Hidden Bug Discovered:** `wrapMCPClient()` from Story 3.2 **never actually worked** with the
> subprocess sandbox:
>
> ```typescript
> // context-builder.ts:148 - Creates functions
> const toolContext = wrapMCPClient(client, tools);
> // executor.ts:356 - Serializes for subprocess
> return `const ${key} = ${JSON.stringify(value)};`;
> // JSON.stringify(function) → undefined! Tools silently disappear.
> ```
>
> **Why never caught:** Tests used mock data, no integration test called real MCP tools from
> sandbox.
>
> **Solution:** Story 7.1b implements Worker RPC Bridge (ADR-032) which solves both problems:
>
> 1. Tool proxies instead of serialized functions (actually works!)
> 2. Native tracing in the bridge (no stdout parsing)
>
> **What to keep from 7.1:**
>
> - The trace event types (tool_start, tool_end)
> - The GraphRAG integration (updateFromExecution)
> - The test patterns
>
> **What to remove (Story 7.1b cleanup):**
>
> - `wrapMCPClient()` in context-builder.ts (broken, never worked)
> - `wrapToolCall()` in context-builder.ts
> - `parseTraces()` in gateway-server.ts
> - `rawStdout` in ExecutionResult

---

**Story 7.1b: Worker RPC Bridge - Native Tracing (ADR-032)**

As a system executing code with MCP tools, I want a Worker-based sandbox with RPC bridge for tool
calls, So that MCP tools work in sandbox AND all calls are traced natively without stdout parsing.

**Why this replaces Story 7.1:**

- MCP client functions cannot be JSON.stringify'd to subprocess
- `__TRACE__` stdout parsing is fragile (collision with user console.log)
- Native bridge tracing is 100% reliable and simpler

**Architecture:**

```
Main Process                          Worker (permissions: "none")
┌─────────────────┐                  ┌─────────────────────────────┐
│ MCPClients      │                  │ const mcp = {               │
│ WorkerBridge    │◄─── postMessage ─│   fs: { read: (a) =>        │
│   - traces[]    │                  │     __rpcCall("fs","read",a)│
│   - callTool()  │─── postMessage ──►│   }                        │
│                 │                  │ };                          │
└─────────────────┘                  │ // User code runs here      │
                                     └─────────────────────────────┘
```

**Acceptance Criteria:**

1. `WorkerBridge` class créée (`src/sandbox/worker-bridge.ts`)
   - Spawns Deno Worker with `permissions: "none"`
   - Handles RPC messages (rpc_call → rpc_result)
   - Routes tool calls to MCPClients
   - **Native tracing:** captures tool_start/tool_end in bridge
2. `SandboxWorker` script (`src/sandbox/sandbox-worker.ts`)
   - Receives tool definitions (not functions!)
   - Generates tool proxies: `mcp.server.tool(args) → __rpcCall(...)`
   - Executes user code with proxies available
3. RPC Message Types added to `src/sandbox/types.ts`:
   ```typescript
   interface RPCCallMessage {
     type: "rpc_call";
     id: string;
     server: string;
     tool: string;
     args: unknown;
   }
   interface RPCResultMessage {
     type: "rpc_result";
     id: string;
     success: boolean;
     result?: unknown;
     error?: string;
   }
   ```
4. `DenoSandboxExecutor` extended avec mode Worker (alongside existing subprocess)
5. Tracing: ALL tool calls traced in bridge with `{ tool, duration_ms, success }`
6. GraphRAG: `updateFromExecution()` called with traced tools
7. Tests: execute code calling 2 MCP tools → verify both traced → edges created
8. Performance: RPC overhead < 10ms per call
9. **Cleanup:** Remove Story 7.1 code (wrapToolCall, parseTraces, rawStdout)

**Files to Create:**

- `src/sandbox/worker-bridge.ts` (~150 LOC)
- `src/sandbox/sandbox-worker.ts` (~100 LOC)

**Files to Modify:**

- `src/sandbox/types.ts` - Add RPC message types (~30 LOC)
- `src/sandbox/executor.ts` - Add Worker mode (~30 LOC)
- `src/sandbox/context-builder.ts` - Add `buildToolDefinitions()` (~20 LOC)
- `src/mcp/gateway-server.ts` - Remove parseTraces(), use bridge traces (~-40 LOC)

**Files to Delete (Cleanup):**

- `tests/unit/mcp/trace_parsing_test.ts`
- `tests/unit/sandbox/tracing_performance_test.ts`

**Prerequisites:** Epic 3 (Sandbox operational), ADR-032 approved

**Estimation:** 2-3 jours (~350 LOC net)

---

**Story 7.2a: Capability Storage - Migration & Eager Learning**

As a system persisting learned patterns, I want to store capabilities immediately after first
successful execution, So that learning happens instantly without waiting for repeated patterns.

**Philosophy: Eager Learning**

- Storage dès la 1ère exécution réussie (pas d'attente de 3+)
- ON CONFLICT → UPDATE usage_count++ (deduplication par code_hash)
- Storage is cheap (~2KB/capability), on garde tout
- Le filtrage se fait au moment des suggestions, pas du stockage

**Acceptance Criteria:**

1. Migration 011 créée: extension table `workflow_pattern`
   - `code_snippet TEXT` - Le code exécuté
   - `parameters_schema JSONB` - Schema JSON des paramètres (nullable, rempli par Story 7.2b)
   - `cache_config JSONB` - Configuration cache (ttl, cacheable)
   - `name TEXT` - Nom auto-généré ou manuel
   - `description TEXT` - Description de la capability
   - `success_rate REAL` - Taux de succès (0-1)
   - `avg_duration_ms INTEGER` - Durée moyenne
   - `created_at TIMESTAMPTZ` - Date de création (1ère exec)
   - `last_used TIMESTAMPTZ` - Dernière utilisation
   - `source TEXT` - 'emergent' ou 'manual'
2. Extension table `workflow_execution` avec `code_snippet TEXT`, `code_hash TEXT`
3. **Eager insert:** Après chaque exec réussie avec intent:
   ```sql
   INSERT INTO workflow_pattern (code_hash, code_snippet, intent_embedding, ...)
   ON CONFLICT (code_hash) DO UPDATE SET
     usage_count = usage_count + 1,
     last_used = NOW(),
     success_rate = (success_count + 1) / (usage_count + 1)
   ```
4. Index HNSW sur `intent_embedding` pour recherche rapide
5. Index sur `code_hash` pour upsert rapide
6. Tests: exec 1x → verify capability créée → exec 2x même code → verify usage_count = 2
7. Migration idempotente (peut être rejouée)

**Prerequisites:** Story 7.1b (Worker RPC Bridge with tracing operational)

**Estimation:** 1-2 jours

---

**Story 7.2b: Schema Inference (SWC-based)**

As a system exposing capability interfaces, I want to automatically infer parameter schemas from
TypeScript code, So that Claude knows what arguments to pass when calling capabilities.

**Stack (Deno native ✅):**

- `SWC` via `deno.land/x/swc@0.2.1` - Rust-based AST parser, 20x faster than ts-morph
- Native JSON Schema generation (no Zod needed)

> Note: SWC is Deno-native, validated in POC. ts-morph has Deno compatibility issues (#949, #950).

**Acceptance Criteria:**

1. `SchemaInferrer` class créée (`src/capabilities/schema-inferrer.ts`)
2. Method `inferSchema(code: string, mcpSchemas: Map<string, JSONSchema>)` → JSONSchema
3. Flow d'inférence:
   ```typescript
   // 1. SWC parse AST → trouve args.filePath, args.debug (MemberExpression + ObjectPattern)
   // 2. Inférer types depuis MCP schemas (args.filePath → fs.read.path → string)
   // 3. Générer JSON Schema directement
   ```
4. Détection `args.xxx` via AST traversal (MemberExpression + ObjectPattern destructuring)
5. Inférence de type depuis les MCP schemas quand possible
6. Fallback à `unknown` si type non-inférable
7. Génération JSON Schema directe (pas de Zod intermédiaire)
8. Update `workflow_pattern.parameters_schema` après inférence
9. Tests: code avec `args.filePath` utilisé dans `fs.read()` → schema.filePath = string
10. Tests: code avec `args.unknown` non-mappable → schema.unknown = unknown

**Prerequisites:** Story 7.2a (storage ready)

**Estimation:** 2-3 jours

---

**Story 7.3a: Capability Matching & search_capabilities Tool**

As an AI agent, I want to search for existing capabilities matching my intent, So that I can
discover and reuse proven code.

**Integration avec Adaptive Thresholds (Epic 4):**

- Réutilise `AdaptiveThresholdManager` existant
- Nouveau context type: `capability_matching`
- Seuil initial: `suggestionThreshold` (0.70 par défaut)
- Auto-ajustement basé sur FP (capability échoue) / FN (user génère nouveau code alors que
  capability existait)

**Acceptance Criteria:**

1. `CapabilityMatcher` helper class créée (`src/capabilities/matcher.ts`)
   - **Role:** Low-level matching logic (Vector search + Reliability filtering)
   - **Usage:** Used by `DAGSuggester`, NOT standalone
2. Integration dans `DAGSuggester`:
   - `dagSuggester.searchCapabilities(intent)` appelle `matcher.findMatch()`
3. Method `findMatch(intent)` → Capability | null
   - Threshold = `adaptiveThresholds.getThresholds().suggestionThreshold`
   - Pas de threshold hardcodé!
4. Vector search sur `workflow_pattern.intent_embedding`
5. Nouveau tool MCP `pml:search_capabilities` exposé
6. Input schema: `{ intent: string, include_suggestions?: boolean }`
   - Pas de threshold en param - géré par adaptive system
7. Output:
   `{ capabilities: Capability[], suggestions?: Suggestion[], threshold_used: number, parameters_schema: JSONSchema }`
8. Feedback loop: après exécution capability, appeler `adaptiveThresholds.recordExecution()`
9. Stats update: `usage_count++`, recalc `success_rate` après exécution
10. Tests: créer capability → search by similar intent → verify match uses adaptive threshold

**Prerequisites:** Story 7.2b (schema inference ready), Epic 4 (AdaptiveThresholdManager)

**Estimation:** 1-2 jours

---

**Story 7.3b: Capability Injection - Inline Functions (Option B)**

As a code executor, I want capabilities injected as inline functions in the Worker context, So that
code can call capabilities with zero RPC overhead and proper tracing.

**Architecture Decision: Option B (Inline Functions)**

> **Why Option B instead of RPC for capabilities?**
>
> - **No RPC overhead** for capability → capability calls (direct function call)
> - **Simpler** - capabilities are just functions in the same Worker context
> - **MCP tool calls** still go through RPC bridge (and get traced there natively)
>
> | Call Type               | Mechanism            | Tracing Location    |
> | ----------------------- | -------------------- | ------------------- |
> | Code → MCP tool         | RPC to bridge        | ✅ Bridge (native)  |
> | Code → Capability       | Direct function call | ✅ Worker (wrapper) |
> | Capability → MCP tool   | RPC to bridge        | ✅ Bridge (native)  |
> | Capability → Capability | Direct function call | ✅ Worker (wrapper) |

**How it works with Story 7.1b Worker RPC Bridge:**

```typescript
// In Worker context - generated by WorkerBridge
const mcp = {
  kubernetes: { deploy: (args) => __rpcCall("kubernetes", "deploy", args) },
  slack: { notify: (args) => __rpcCall("slack", "notify", args) },
};

// Capabilities are INLINE functions (not RPC)
const capabilities = {
  runTests: async (args) => {
    __trace({ type: "capability_start", name: "runTests" });
    const result = await mcp.jest.run({ path: args.path }); // RPC → traced in bridge
    __trace({ type: "capability_end", name: "runTests", success: true });
    return result;
  },
  deployProd: async (args) => {
    __trace({ type: "capability_start", name: "deployProd" });
    await capabilities.runTests({ path: "./tests" }); // Direct call → traced above
    await mcp.kubernetes.deploy({ image: args.image }); // RPC → traced in bridge
    __trace({ type: "capability_end", name: "deployProd", success: true });
    return { deployed: true };
  },
};

// User code has access to both
await capabilities.deployProd({ image: "app:v1.0" });
```

**Acceptance Criteria:**

1. `CapabilityCodeGenerator` class créée (`src/capabilities/code-generator.ts`)
   - Generates inline function code from capability `code_snippet`
   - Wraps each function with `__trace()` calls for capability_start/end
   - Returns string to inject into Worker context
2. `WorkerBridge.buildCapabilityContext()` method added
   - Takes list of relevant capabilities (from CapabilityMatcher)
   - Calls `CapabilityCodeGenerator` to build inline code
   - Injects alongside tool proxies in Worker
3. Worker `__trace()` function collects events in array
   - At execution end, Worker sends traces via postMessage
   - Bridge merges capability traces with tool traces
4. **Learning loop - Capability Graph:**
   - Edges créés entre capabilities qui s'appellent (from traces)
   - `updateFromExecution()` receives both tool and capability traces
   - GraphRAG stores capability→capability edges
5. Tests: capability A calls capability B → both traced → edge A→B in graph
6. Tests: capability calls MCP tool → tool traced in bridge, capability traced in worker
7. Tests: nested capabilities (A → B → C) → all 3 traced with correct parent/child
8. Performance: capability→capability call < 1ms (no RPC)

**Files to Create:**

- `src/capabilities/code-generator.ts` (~80 LOC)

**Files to Modify:**

- `src/sandbox/worker-bridge.ts` - Add `buildCapabilityContext()` (~40 LOC)
- `src/sandbox/sandbox-worker.ts` - Add `__trace()` function, collect traces (~20 LOC)

**Prerequisites:** Story 7.1b (Worker RPC Bridge), Story 7.3a (CapabilityMatcher)

**ADR Integration (2025-12-08):**

- **ADR-036 BroadcastChannel:** capability_start/end emitted in real-time (not batched)
- This introduces the BroadcastChannel pattern, later generalized in Story 6.5 (Full EventBus)
- See Pre-Implementation Review in story file for additional AC11-12 (orchestrator, E2E tests)

**Estimation:** 2.5-3 jours (revised with orchestrator + E2E tests)

---

## Note Architecturale: Worker Context & Capability Layers (ADR-032)

Avec le Worker RPC Bridge (Story 7.1b), le Worker a accès à deux types de fonctions :

```typescript
// Worker context - generated by WorkerBridge

// 1. MCP Tools: Proxies that call bridge via RPC (traced in bridge)
const mcp = {
  github: { createIssue: (args) => __rpcCall("github", "createIssue", args) },
  filesystem: { read: (args) => __rpcCall("filesystem", "read", args) },
  kubernetes: { deploy: (args) => __rpcCall("kubernetes", "deploy", args) },
};

// 2. Capabilities: Inline functions (traced in worker via __trace())
const capabilities = {
  parseConfig: async (args) => {
    __trace({ type: "capability_start", name: "parseConfig" });
    const content = await mcp.filesystem.read({ path: args.path }); // RPC
    const parsed = JSON.parse(content);
    __trace({ type: "capability_end", name: "parseConfig", success: true });
    return parsed;
  },
  deployProd: async (args) => {
    __trace({ type: "capability_start", name: "deployProd" });
    await capabilities.runTests({ path: "./tests" }); // Direct call (no RPC)
    await capabilities.buildDocker({ tag: "v1.0" }); // Direct call (no RPC)
    await mcp.kubernetes.deploy({ image: "app:v1.0" }); // RPC
    __trace({ type: "capability_end", name: "deployProd", success: true });
  },
};
```

**Key Benefits of Option B:**

- **Zero overhead** for capability → capability calls (direct function call)
- **Unified tracing** - bridge traces MCP tools, worker traces capabilities
- **Simple architecture** - no complex RPC routing for capabilities

**Limites à considérer (future story si besoin):**

- Profondeur max de récursion (3 niveaux?)
- Détection de cycles (A → B → A)
- Call stack dans traces (parent_trace_id)

---

**Story 7.4: DAGSuggester Extension - Mixed DAG (Tools + Capabilities)**

As an AI agent, I want DAGs that include both MCP tools AND capabilities, So that I can reuse
learned patterns in larger workflows.

**Context:** This story implements the "Strategic Discovery" mode (Passive Suggestion) defined in
ADR-038.

**Algorithm (ADR-038):**

- **Mode:** Passive Suggestion (Implicit Context)
- **Algo:** `Score = ToolsOverlap * (1 + SpectralClusterBoost)`
- **Hypergraph:** Bipartite graph (Tools ↔ Capabilities) for Spectral Clustering

**Acceptance Criteria:**

1. `DAGSuggester.suggestDAG()` étendu pour chercher aussi les capabilities
2. Nouveau type de task dans DAGStructure: `type: "tool" | "capability"`
3. **Spectral Clustering Integration:**
   - Implementer `GraphRAGEngine.computeSpectralClusters()` (ou library équivalente)
   - Identifier le cluster dominant du contexte actuel
   - Booster les capabilities de ce cluster (ADR-038)
4. **Ranking unifié:**
   - Trier tools (Recency/Cooc) et capabilities (Spectral/Overlap) dans une liste unique
5. `execute_dag` mis à jour pour gérer les deux types
6. `predictNextNodes()` retourne mix tools + capabilities
7. Observabilité (ADR-039) pour tracer les suggestions spectrales

**Prerequisites:** Story 7.3b (capability injection)

**Estimation:** 2-3 jours

---

**Story 7.5a: Capability Result Cache**

As a system optimizing for performance, I want cached capability results, So that repeat executions
are instant.

**Acceptance Criteria:**

1. Cache multi-niveaux implémenté:
   - **Level 1:** Execution cache (existant) - hash(code + context)
   - **Level 2:** Capability result cache - capability_id + params_hash
   - **Level 3:** Intent similarity cache (optional) - embedding similarity > 0.95
2. Table `capability_cache` créée:
   ```sql
   CREATE TABLE capability_cache (
     capability_id UUID REFERENCES workflow_pattern(id),
     params_hash TEXT,
     result JSONB,
     created_at TIMESTAMPTZ,
     expires_at TIMESTAMPTZ,
     PRIMARY KEY (capability_id, params_hash)
   )
   ```
3. Cache lookup avant exécution: `findCachedResult(capability_id, params)`
4. Cache write après exécution réussie
5. Invalidation triggers:
   - Tool schema change → invalidate capabilities using this tool
   - 3+ failures consécutifs → invalidate capability cache
   - Manual: `DELETE FROM capability_cache WHERE capability_id = ?`
6. Tests: exec capability → verify cache hit on 2nd call → verify result identical
7. Metrics: `cache_hit_rate`
8. Config: `CAPABILITY_CACHE_TTL` (default: 1 hour)

**Prerequisites:** Story 7.4 (suggestion engine)

**Estimation:** 1-2 jours

---

**Story 7.5b: Capability Pruning (Optional)**

As a system managing storage, I want periodic cleanup of unused capabilities, So that storage stays
clean.

**Note:** Cette story est optionnelle. Avec eager learning, on stocke tout. Le pruning peut être
activé si le stockage devient un problème.

**Acceptance Criteria:**

1. Pruning job configurable (cron ou trigger manuel)
2. Pruning query:
   ```sql
   DELETE FROM workflow_pattern
   WHERE usage_count = 1
     AND last_used < NOW() - INTERVAL '30 days'
     AND source = 'emergent'  -- Never prune manual capabilities
   ```
3. Pruning désactivé par défaut: `PRUNING_ENABLED` (default: false)
4. Dry-run mode: `prune(dryRun: true)` → returns count without deleting
5. Logs: "Pruned N capabilities older than 30 days with usage_count=1"
6. Tests: create old capability → run pruning → verify deleted
7. Metrics: `capabilities_pruned_total`

**Prerequisites:** Story 7.5a (cache ready)

**Estimation:** 0.5-1 jour

---

**Story 7.6: Algorithm Observability Implementation (ADR-039)**

As a system administrator, I want to trace algorithm decisions and outcomes, So that I can
validatethe scoring weights and detect anomalies.

**Context:** ADR-039 defines a logging structure for scoring algorithms. This story implements the
persistence layer.

**Acceptance Criteria:**

1. Migration Drizzle pour table `algorithm_traces` (PostgreSQL/PGlite)
2. `AlgorithmTracer` service pour bufferiser et écrire les logs (async)
3. Integration dans `DAGSuggester` et `CapabilityMatcher` pour logger chaque décision
4. Route API pour feedback (Frontend peut dire "J'ai cliqué sur cette suggestion")
5. Metrics de base:
   - `avg_final_score` par type (tool vs capability)
   - `conversion_rate` (suggestions acceptées / total)
   - `spectral_relevance` (est-ce que le cluster boost prédit le clic ?)

**Prerequisites:** Story 7.4 (Scoring implemented)

**Estimation:** 1-2 jours

---

**Story 7.7a: Permission Inference - Analyse Automatique des Permissions (ADR-035)**

As a system executing capabilities in sandbox, I want automatic permission inference from code
analysis, So that capabilities run with minimal required permissions (principle of least privilege).

**Context:** Deno demande actuellement des permissions globales pour tout le sandbox. Avec Deno 2.5+
Permission Sets, on peut définir des profils de permissions granulaires. Cette story infère
automatiquement le profil approprié en analysant le code via SWC (réutilisation de Story 7.2b).

**Permission Profiles Définis:**

| Profile        | Read         | Write      | Net         | Env     | Use Case                     |
| -------------- | ------------ | ---------- | ----------- | ------- | ---------------------------- |
| `minimal`      | ❌           | ❌         | ❌          | ❌      | Pure computation, math       |
| `readonly`     | `["./data"]` | ❌         | ❌          | ❌      | Data analysis                |
| `filesystem`   | `["./"]`     | `["/tmp"]` | ❌          | ❌      | File processing              |
| `network-api`  | ❌           | ❌         | `["api.*"]` | ❌      | API calls (fetch)            |
| `mcp-standard` | ✅           | `["/tmp"]` | ✅          | Limited | Standard MCP tools           |
| `trusted`      | ✅           | ✅         | ✅          | ✅      | Manual/verified capabilities |

**Acceptance Criteria:**

1. `PermissionInferrer` class créée (`src/capabilities/permission-inferrer.ts`)
2. Réutilise SWC parsing de Story 7.2b pour analyser l'AST
3. Détection des patterns:
   - `fetch(`, `Deno.connect` → network-api
   - `mcp.filesystem`, `mcp.fs`, `Deno.readFile` → filesystem
   - `Deno.env`, `process.env` → env access
4. Method `inferPermissions(code: string)` retourne:
   ```typescript
   interface InferredPermissions {
     permissionSet: string; // "minimal" | "readonly" | "network-api" | etc.
     confidence: number; // 0-1
     detectedPatterns: string[]; // ["fetch", "mcp.filesystem"]
   }
   ```
5. Migration DB ajoutée (012):
   ```sql
   ALTER TABLE workflow_pattern
   ADD COLUMN permission_set VARCHAR(50) DEFAULT 'minimal',
   ADD COLUMN permission_confidence FLOAT DEFAULT 0.0;
   CREATE INDEX idx_workflow_pattern_permission ON workflow_pattern(permission_set);
   ```
6. Integration avec `saveCapability()` - permission inférée automatiquement au stockage
7. Tests: code avec `fetch()` → permission_set = "network-api"
8. Tests: code avec `mcp.fs.read()` → permission_set = "filesystem"
9. Tests: code sans I/O → permission_set = "minimal", confidence = 0.95

**Files to Create:**

- `src/capabilities/permission-inferrer.ts` (~120 LOC)

**Files to Modify:**

- `src/capabilities/capability-store.ts` - Appeler inferPermissions au save (~15 LOC)
- `drizzle/migrations/` - Migration 012 (~20 LOC)

**Prerequisites:** Story 7.2b (SWC parsing disponible)

**Estimation:** 1-2 jours

---

**Story 7.7b: Sandbox Permission Integration - Exécution avec Permissions Granulaires (ADR-035)**

As a sandbox executor, I want to run capabilities with their inferred permission set, So that each
capability has only the minimum permissions required.

**Context:** Cette story modifie `SandboxExecutor` pour utiliser les permission sets stockés en DB.
Inclut un fallback pour Deno < 2.5 avec les flags explicites.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Capability Execution Flow                                       │
│                                                                  │
│  1. Load capability from DB (includes permission_set)            │
│  2. Determine final permissions:                                 │
│     - source="manual" → use stored permission_set                │
│     - confidence < 0.7 → use "minimal" (safety)                  │
│     - else → use inferred permission_set                         │
│  3. Execute with determined permissions                          │
└─────────────────────────────────────────────────────────────────┘
```

**Acceptance Criteria:**

1. `SandboxExecutor.execute()` accepte paramètre `permissionSet?: string`
2. Ajout des permission sets dans `deno.json`:
   ```json
   {
     "permissions": {
       "minimal": { "read": false, "write": false, "net": false, "env": false },
       "readonly": { "read": ["./data", "/tmp"], "write": false, "net": false },
       "network-api": { "read": false, "write": false, "net": true },
       "filesystem": { "read": ["./"], "write": ["/tmp"], "net": false },
       "mcp-standard": {
         "read": true,
         "write": ["/tmp", "./output"],
         "net": true,
         "env": ["HOME", "PATH"]
       },
       "trusted": { "read": true, "write": true, "net": true, "env": true }
     }
   }
   ```
3. Deno 2.5+ : utilise `--permission-set=${permissionSet}`
4. Deno < 2.5 : fallback avec `permissionSetToFlags()` mapping
5. Method `supportsPermissionSets()` détecte version Deno
6. `--no-prompt` toujours ajouté (jamais d'interaction)
7. Tests e2e: capability "minimal" → PermissionDenied si tente fetch
8. Tests e2e: capability "network-api" → fetch fonctionne
9. Tests: fallback flags pour Deno 2.4

**Files to Modify:**

- `src/sandbox/executor.ts` - Ajout permission set support (~60 LOC)
- `deno.json` - Permission sets configuration (~30 LOC)

**Prerequisites:** Story 7.7a (Permission Inference)

**Estimation:** 1-2 jours

---

**Story 7.7c: HIL Permission Escalation - Escalade avec Approbation Humaine (ADR-035)**

As a user, I want to approve permission escalations when a capability needs more access, So that
security is maintained while allowing legitimate operations.

**Context:** Quand une capability échoue avec PermissionDenied, le système peut demander à
l'utilisateur d'approuver une escalade de permissions. Intégration avec le système HIL existant (DAG
executor).

**Flow:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Execution fails: PermissionDenied                               │
│                                                                  │
│  → Detect error type (read, write, net, env)                     │
│  → Suggest escalation (minimal → network-api)                    │
│  → Request HIL approval via existing ControlledExecutor          │
│  → If approved: update capability.permission_set in DB           │
│  → Retry execution with new permissions                          │
│  → Log decision for audit trail                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Acceptance Criteria:**

1. Interface `PermissionEscalationRequest` définie:
   ```typescript
   interface PermissionEscalationRequest {
     capabilityId: string;
     currentSet: string; // "minimal"
     requestedSet: string; // "network-api"
     reason: string; // "PermissionDenied: net access to api.example.com"
     detectedOperation: string; // "fetch"
   }
   ```
2. `suggestEscalation(error: string)` analyse l'erreur et suggère le profil approprié
3. Integration avec `ControlledExecutor.requestHILApproval()` existant
4. Si approuvé: UPDATE capability permission_set en DB
5. Si refusé: log et retourne erreur propre à l'utilisateur
6. Audit logging: toutes les décisions d'escalation loggées
   ```typescript
   interface PermissionAuditLog {
     timestamp: Date;
     capabilityId: string;
     from: string;
     to: string;
     approved: boolean;
     approvedBy?: string;
   }
   ```
7. Table `permission_audit_log` créée (migration 013)
8. Tests: capability échoue → HIL request → approve → retry succeeds
9. Tests: capability échoue → HIL request → deny → error propagée
10. Tests: audit log contient toutes les décisions

**Files to Create:**

- `src/capabilities/permission-escalation.ts` (~100 LOC)

**Files to Modify:**

- `src/dag/controlled-executor.ts` - Ajout type "permission_escalation" (~30 LOC)
- `drizzle/migrations/` - Migration 013 permission_audit_log (~15 LOC)

**Prerequisites:** Story 7.7b (Sandbox Permission Integration), HIL system (Story 2.5)

**Estimation:** 1-1.5 jours

---

## Epic 7 Capability Lifecycle (Architecture Unifiée)

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1: EXECUTE & LEARN (Eager - dès exec 1)                  │
├─────────────────────────────────────────────────────────────────┤
│  Intent → execute_code → Worker Sandbox → Track via RPC        │
│  → Success? UPSERT workflow_pattern immédiatement               │
│  → ON CONFLICT: usage_count++, update success_rate              │
│  → Capability discoverable IMMÉDIATEMENT                        │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 2: DAG SUGGESTION (Mixed Tools + Capabilities)           │
├─────────────────────────────────────────────────────────────────┤
│  Intent → DAGSuggester.suggestDAG()                             │
│      ├─→ searchToolsHybrid() (existing)                         │
│      └─→ searchCapabilities() (NEW - Story 7.4)                 │
│                                                                 │
│  → Ranking unifié: tools + capabilities triés ensemble          │
│  → Threshold adaptatif (AdaptiveThresholdManager)               │
│  → Hypergraph PageRank (bipartite tools ↔ capabilities)        │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 3: EXECUTE MIXED DAG                                      │
├─────────────────────────────────────────────────────────────────┤
│  execute_dag orchestre:                                         │
│      ├─→ type: "tool" → MCP call (aujourd'hui)                  │
│      │                → execute_code (future)                   │
│      └─→ type: "capability" → execute_code(cap.code)            │
│                                                                 │
│  → Tout passe par sandbox (isolation, tracing)                  │
│  → Capabilities = appels execute_code avec code pré-existant    │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 4: OPTIONAL PRUNING (background, désactivé par défaut)   │
├─────────────────────────────────────────────────────────────────┤
│  DELETE WHERE usage_count = 1 AND last_used < 30 days ago      │
│  → Nettoie les capabilities jamais réutilisées                  │
│  → Configurable: PRUNING_ENABLED=true                           │
└─────────────────────────────────────────────────────────────────┘
```

**Architecture clé:**

- ✅ **Un seul suggester:** `DAGSuggester` gère tools ET capabilities
- ✅ **Pas de classe séparée:** Pas de `CapabilityMatcher` ni `SuggestionEngine`
- ✅ **Mixed DAG:** tasks peuvent être `type: "tool"` ou `type: "capability"`
- ✅ **Thresholds adaptatifs:** Pas de valeurs hardcodées (0.85, 0.7)
- ✅ **Future:** Tout via `execute_code` (même les tools simples)

---

## Epic 7 Market Comparison

| Feature            | Docker Dynamic MCP | Anthropic PTC | **Casys PML Epic 7**        |
| ------------------ | ------------------ | ------------- | --------------------------- |
| **Discovery**      | Runtime            | Pre-config    | Pre-exec + Capability Match |
| **Learning**       | ❌ None            | ❌ None       | ✅ GraphRAG + Capabilities  |
| **Suggestions**    | ❌ None            | ❌ None       | ✅ Louvain + Adamic-Adar    |
| **Code Reuse**     | ❌ None            | ❌ None       | ✅ Capability cache         |
| **Recursion Risk** | ⚠️ Possible        | N/A           | ❌ Impossible (scope fixe)  |
| **Security**       | Container          | Sandbox       | Sandbox + scope fixe        |

**Différenciateur clé:**

> "Casys PML apprend de chaque exécution et suggère des capabilities optimisées - comme un
> pair-programmer qui se souvient de tout."

---
