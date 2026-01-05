# Epic to Architecture Mapping

| Epic                                                | Module                                                                               | Key Components                                                                                   | Stories        | Status          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------- | --------------- |
| **Epic 1: Foundation & Context Optimization**       | `src/db/`, `src/vector/`, `src/mcp/`, `src/cli/`, `src/telemetry/`                   | PGlite client, Vector search, Embeddings, MCP discovery, Migration tool                          | 1.1-1.8        | ✅ DONE         |
| **Epic 2: DAG Execution & Production**              | `src/dag/`, `src/streaming/`, `src/mcp/gateway.ts`, `tests/e2e/`                     | DAG builder, Parallel executor, SSE streaming, MCP gateway, Health checks                        | 2.1-2.7        | ✅ DONE         |
| **Epic 2.5: Adaptive DAG Feedback Loops**           | `src/dag/controlled-executor.ts`, `src/dag/state.ts`, `src/graphrag/`                | ControlledExecutor, EventStream, CommandQueue, WorkflowState, Checkpoints, AIL/HIL, DAGSuggester | 2.5-1 to 2.5-4 | ✅ DONE         |
| **Epic 3: Agent Code Execution & Local Processing** | `src/sandbox/`                                                                       | DenoSandboxExecutor, ContextBuilder, execute_code MCP tool, Safe-to-fail pattern                 | 3.1-3.8        | ✅ DONE         |
| **Epic 3.5: Speculative Execution**                 | `src/speculation/`                                                                   | SpeculativeExecutor, Confidence scoring, Cache management, Rollback                              | 3.5-1, 3.5-2   | ✅ DONE         |
| **Epic 4: Episodic Memory & Adaptive Learning**     | `src/learning/`                                                                      | EpisodicMemoryStore, AdaptiveThresholdManager, PGlite persistence                                | 4.1, 4.2       | 🟡 Phase 1 DONE |
| **Epic 5: Intelligent Tool Discovery**              | `src/graphrag/`, `src/mcp/gateway-server.ts`                                         | search_tools MCP tool, Hybrid semantic+graph search, Workflow templates                          | 5.1, 5.2       | ✅ DONE         |
| **Epic 6: Real-time Graph Monitoring**              | `src/server/`, `public/`                                                             | SSE events stream, Graph visualization, Metrics dashboard                                        | 6.1-6.4        | 📋 DRAFTED      |
| **Epic 7: Emergent Capabilities & Learning System** | `src/capabilities/`, `src/sandbox/worker-bridge.ts`, `src/sandbox/sandbox-worker.ts` | WorkerBridge, CapabilityMatcher, SuggestionEngine, SchemaInferrer, CapabilityCodeGenerator       | 7.1b-7.5       | 🟡 IN PROGRESS  |
| **Epic 8: Hypergraph Capabilities Visualization**   | `src/visualization/`, `public/`                                                      | HypergraphBuilder, Capability Explorer, Code Panel, Compound Graphs                              | 8.1-8.5        | 📋 PROPOSED     |
| **Epic 9: GitHub Auth & Multi-Tenancy**             | `src/lib/auth.ts`, `src/web/routes/auth/`, `src/mcp/gateway-server.ts`               | OAuth Handler, API Key validation, Session management, Shared Auth Module                        | 9.1-9.6        | 📋 PROPOSED     |
| **Epic 10: DAG Capability Learning & Unified APIs** | `src/dag/`, `src/capabilities/`, `src/mcp/gateway-server.ts`                         | Static Code Analyzer, DAG Reconstructor, Unified pml_execute/pml_discover, Provides Edge Types   | 10.1-10.10     | 📋 PROPOSED     |

**Boundaries:**

- **Epic 1** delivers: Standalone context optimization (vector search functional, <5% context)
- **Epic 2** builds on: Epic 1 complete, adds DAG parallelization + production hardening
- **Epic 2.5** extends: Epic 2 with adaptive feedback loops (AIL/HIL, checkpoints, replanning)
- **Epic 3** extends: Epic 2.5 with code execution in sandbox (safe-to-fail, local processing)
- **Epic 3.5** extends: Epic 3 with speculative execution (confidence-based prediction, cache)
- **Epic 4** extends: Epic 2.5/3.5 with episodic memory and adaptive threshold learning
- **Epic 5** extends: Epic 1 with hybrid search (semantic + graph-based recommendations)
- **Epic 6** extends: Epic 5 with real-time observability and graph visualization
- **Epic 7** extends: Epic 3 + Epic 4 with emergent capabilities from code execution (Worker RPC
  Bridge, capability learning, suggestions)
- **Epic 8** extends: Epic 6 + Epic 7 with hypergraph visualization of learned capabilities
  (compound nodes, code panel)
- **Epic 9** extends: Epic 1 with dual-mode authentication (Cloud: GitHub OAuth + API Keys,
  Self-hosted: zero-auth)
- **Epic 10** extends: Epic 7 with unified DAG/Code learning (static analysis, DAG reconstruction,
  provides edges)

**Implementation Status Summary:**

- ✅ Epic 1-3: Core foundation complete (context optimization, DAG execution, sandbox)
- ✅ Epic 3.5: Speculative execution with confidence scoring
- ✅ Epic 5: Intelligent tool discovery with hybrid search
- 🟡 Epic 4: Phase 1 complete (storage), Phase 2 pending (integrations)
- 📋 Epic 6: Stories drafted, pending implementation
- 🟡 Epic 7: In progress (Story 7.1 done, 7.1b planned - Worker RPC Bridge)
- 📋 Epic 8: Proposed, depends on Epic 7 capabilities storage
- 📋 Epic 9: Proposed, hybrid auth for Cloud/Self-hosted modes
- 📋 Epic 10: Proposed, unifies DAG and Code execution learning

---
