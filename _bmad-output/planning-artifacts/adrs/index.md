# Architecture Decision Records

Index des décisions d'architecture du projet Casys PML.

## Status Legend

| Status       | Description                                       |
| ------------ | ------------------------------------------------- |
| `draft`      | ADR en cours de rédaction (non encore proposée)   |
| `proposed`   | Proposé, en attente de validation d’équipe        |
| `accepted`   | Décision actée et faisant autorité                |
| `deprecated` | Obsolète, ne doit plus être utilisée              |
| `superseded` | Remplacé par une autre ADR (voir `superseded_by`) |
| `rejected`   | Proposée mais explicitement refusée               |

### Implementation Status

| Implementation | Description                                                       |
| -------------- | ----------------------------------------------------------------- |
| `not_started`  | Implémentation non commencée                                      |
| `in_progress`  | Implémentation en cours                                           |
| `done`         | Implémentation complète au niveau code                            |
| `partial`      | Implémentée partiellement (feature flags, périmètre réduit, etc.) |

---

## ADR Index

| #    | ADR                                                                                         | Status     | Implementation | Decision                                              |
| ---- | ------------------------------------------------------------------------------------------- | ---------- | -------------- | ----------------------------------------------------- |
| 001  | [PGlite over SQLite](./ADR-001-pglite-vector-search.md)                                     | accepted   | done           | PGlite + pgvector for vector search                   |
| 002  | [Custom DAG Implementation](./ADR-002-custom-dag-implementation.md)                         | accepted   | done           | Zero external deps for DAG                            |
| 003  | [BGE-M3 Local Embeddings](./ADR-003-bge-m3-local-embeddings.md)                             | accepted   | done           | Local inference embeddings                            |
| 004  | [stdio Transport Primary](./ADR-004-stdio-transport-primary.md)                             | accepted   | done           | MCP stdio primary, SSE optional                       |
| 005  | [Graphology for GraphRAG](./ADR-005-graphology-graphrag.md)                                 | accepted   | done           | True graph algorithms                                 |
| 006  | [Speculative Execution](./ADR-006-speculative-execution.md)                                 | accepted   | partial        | THE feature - 0ms perceived latency                   |
| 007  | [DAG Adaptive Feedback Loops](./ADR-007-dag-adaptive-feedback-loops.md)                     | accepted   | done           | 3-loop learning architecture AIL/HIL                  |
| 008  | [Episodic Memory & Adaptive Thresholds](./ADR-008-episodic-memory-adaptive-thresholds.md)   | accepted   | done           | Meta-learning avec mémoire épisodique                 |
| 009  | [JSON Configuration Format](./ADR-009-json-config-format.md)                                | accepted   | done           | JSON pour config MCP ecosystem                        |
| 010  | [Hybrid DAG Architecture](./ADR-010-hybrid-dag-architecture.md)                             | accepted   | done           | Nœuds externes vs logique interne                     |
| 011  | [Sentry Integration](./ADR-011-sentry-integration.md)                                       | accepted   | done           | Error tracking & performance                          |
| 012  | [MCP STDIO Logging](./ADR-012-mcp-stdio-logging.md)                                         | accepted   | done           | Stratégie logging stdio MCP                           |
| 013  | [Tools/List Semantic Filtering](./ADR-013-tools-list-semantic-filtering.md)                 | accepted   | done           | Filtrage sémantique tools/list                        |
| 014  | [HTTP/SSE Transport](./ADR-014-http-sse-transport.md)                                       | accepted   | done           | Transport SSE pour gateway                            |
| 015  | [Dynamic Alpha Graph Density](./ADR-015-dynamic-alpha-graph-density.md)                     | superseded | done           | → ADR-051 (SHGAT replaces alpha)                      |
| 016  | [REPL-Style Auto-Return](./ADR-016-repl-style-auto-return.md)                               | accepted   | done           | Auto-return code execution                            |
| 017  | [Gateway Exposure Modes](./ADR-017-gateway-exposure-modes.md)                               | draft      | partial        | Modes d'exposition gateway (meta_only actif)          |
| 018  | [Command Handlers Minimalism](./ADR-018-command-handlers-minimalism.md)                     | superseded | done           | → ADR-020                                             |
| 019  | [Three-Level AIL Architecture](./ADR-019-three-level-ail-architecture.md)                   | superseded | done           | → ADR-020                                             |
| 020  | [AIL Control Protocol](./ADR-020-ail-control-protocol.md)                                   | accepted   | done           | Unified command architecture (L1-L2)                  |
| 020b | [Graceful Shutdown Timeout](./ADR-020-graceful-shutdown-timeout.md)                         | accepted   | done           | Timeout guard shutdown 10s                            |
| 021  | [Configurable Database Path](./ADR-021-configurable-database-path.md)                       | accepted   | done           | CAI_DB_PATH env var                                   |
| 021b | [Workflow Sync Missing Nodes](./ADR-021-workflow-sync-missing-nodes.md)                     | accepted   | done           | Création nœuds manquants                              |
| 022  | [Hybrid Search Integration](./ADR-022-hybrid-search-integration.md)                         | superseded | done           | → ADR-051 (simplified formula)                        |
| 023  | [Dynamic Candidate Expansion](./ADR-023-dynamic-candidate-expansion.md)                     | accepted   | done           | Expansion candidats 1.5-3x                            |
| 024  | [Full Adjacency Matrix](./ADR-024-adjacency-matrix-dependencies.md)                         | accepted   | done           | Matrice N×N, cycle breaking                           |
| 025  | [MCP Streamable HTTP](./ADR-025-mcp-streamable-http-transport.md)                           | accepted   | done           | Transport HTTP /mcp endpoint                          |
| 026  | [Cold Start Confidence](./ADR-026-cold-start-confidence-formula.md)                         | accepted   | done           | Adaptive weights cold→mature                          |
| 027  | [Execute Code Graph Learning](./ADR-027-execute-code-graph-learning.md)                     | superseded | not_started    | → ADR-028, ADR-032                                    |
| 028  | [Emergent Capabilities System](./ADR-028-emergent-capabilities-system.md)                   | accepted   | in_progress    | Système capacités émergentes                          |
| 029  | [Hypergraph Visualization](./ADR-029-hypergraph-capabilities-visualization.md)              | draft      | not_started    | Visualisation hypergraph                              |
| 030  | [Gateway Real Execution](./ADR-030-gateway-real-execution.md)                               | accepted   | done           | Implémentation exécution réelle                       |
| 031  | [Intelligent Dry-Run](./ADR-031-intelligent-dry-run.md)                                     | draft      | not_started    | Dry-run avec mocking MCP                              |
| 032  | [Sandbox Worker RPC Bridge](./ADR-032-sandbox-worker-rpc-bridge.md)                         | accepted   | in_progress    | Bridge RPC workers sandboxés                          |
| 033  | [Capability Code Deduplication](./ADR-033-capability-code-deduplication.md)                 | proposed   | not_started    | Déduplication code capacités                          |
| 034  | [Native OpenTelemetry](./ADR-034-native-opentelemetry-deno.md)                              | proposed   | not_started    | OTel natif Deno 2.2+                                  |
| 035  | [Permission Sets Sandbox](./ADR-035-permission-sets-sandbox-security.md)                    | proposed   | not_started    | Permission sets Deno 2.5+                             |
| 036  | [BroadcastChannel Events](./ADR-036-broadcast-channel-event-distribution.md)                | accepted   | done           | Distribution events broadcast                         |
| 037  | [Deno KV Cache Layer](./ADR-037-deno-kv-cache-layer.md)                                     | rejected   | not_started    | Cache layer Deno KV (overkill)                        |
| 038  | [Scoring Algorithms & Formulas Reference](./ADR-038-scoring-algorithms-reference.md)        | superseded | done           | → ADR-051 (Search sections obsolete)                  |
| 039  | [Algorithm Observability & Adaptive Weights](./ADR-039-algorithm-observability-tracking.md) | proposed   | not_started    | Observabilité des algos & préparation des poids       |
| 040  | [Multi-tenant MCP & Secrets](./ADR-040-multi-tenant-mcp-secrets-management.md)              | accepted   | not_started    | Gestion secrets multi-tenant cloud                    |
| 041  | [Hierarchical Trace Tracking](./ADR-041-hierarchical-trace-tracking.md)                     | accepted   | done           | parent_trace_id pour hiérarchie traces                |
| 042  | [Capability Hyperedges](./ADR-042-capability-hyperedges.md)                                 | accepted   | done           | Hyperedges pour capabilities dans le graph            |
| 043  | [All Tools Must Succeed](./ADR-043-all-tools-must-succeed-capability-save.md)               | accepted   | done           | Condition de sauvegarde capabilities                  |
| 044  | [JSON-RPC Multiplexer MCP Client](./ADR-044-json-rpc-multiplexer-mcp-client.md)             | accepted   | done           | Pattern multiplexer pour requêtes MCP parallèles      |
| 045  | [Capability-to-Capability Dependencies](./ADR-045-capability-to-capability-dependencies.md) | accepted   | done           | Table dédiée + edge type `alternative`                |
| 046  | [Fresh BFF Pattern](./ADR-046-fresh-bff-pattern.md)                                         | accepted   | not_started    | Pattern BFF: Fresh → Gateway pour DB                  |
| 047  | [Tool Sequence vs Deduplication](./ADR-047-tool-sequence-vs-deduplication.md)               | accepted   | done           | tool_invocations pour séquence, tools_used dédupliqué |
| 048  | [Local Adaptive Alpha](./ADR-048-hierarchical-heat-diffusion-alpha.md)                      | superseded | done           | → ADR-051 (SHGAT replaces heuristics)                 |
| 049  | [Intelligent Adaptive Thresholds](./ADR-049-intelligent-adaptive-thresholds.md)             | proposed   | not_started    | Seuils adaptatifs intelligents par contexte           |
| 050  | [Superhypergraph Edge Constraints](./ADR-050-superhypergraph-edge-constraints.md)           | accepted   | done           | Contraintes edges superhypergraph                     |
| 051  | [Unified Search Simplification](./ADR-051-unified-search-simplification.md)                 | accepted   | done           | Simplification recherche unifiée (SHGAT v1)           |
| 052  | [Dynamic Capability Routing](./ADR-052-dynamic-capability-routing.md)                       | accepted   | done           | Routing capabilities via MCP proxy                    |
| 053  | [SHGAT Subprocess Training](./ADR-053-shgat-subprocess-per-training.md)                     | accepted   | done           | Subprocess non-blocking training + PER                |
| 054  | [Decision Logger Abstraction](./ADR-054-decision-logger-abstraction.md)                     | accepted   | done           | Unified decision logging interface                    |
| 055  | [SHGAT PreserveDim 1024](./ADR-055-shgat-preservedim-1024-dimension.md)                     | accepted   | done           | Keep 1024-dim through message passing                 |
| 056  | [InfoNCE Contrastive Training](./ADR-056-infonce-contrastive-training.md)                   | accepted   | done           | Contrastive loss for K-head training                  |
| 057  | [Message Passing Backward](./ADR-057-message-passing-backward-training.md)                  | accepted   | done           | Backward pass for message passing layers              |
| 058  | [BLAS FFI Matrix Acceleration](./ADR-058-blas-ffi-matrix-acceleration.md)                   | accepted   | done           | OpenBLAS FFI for 15x scoring speedup                  |
| 059  | [Hybrid Routing Server Analysis](./ADR-059-hybrid-routing-server-analysis-package-execution.md) | accepted | done           | Server analyzes, package executes client tools        |

---

## By Status

### Accepted (41)

ADR-001, 002, 003, 004, 005, 006, 007, 008, 009, 010, 011, 012, 013, 014, 016, 020, 020b, 021, 021b,
023, 024, 025, 026, 028, 030, 032, 036, 040, 041, 042, 043, 044, 045, 046, 047, 050, 051, 052, 053,
054, 055, 056, 057, 058, 059

### Draft (3)

ADR-017, ADR-029, ADR-031

### Proposed (5)

ADR-033, ADR-034, ADR-035, ADR-039, ADR-049

### Superseded (7)

- ADR-015 → remplacé par ADR-051 (SHGAT replaces alpha)
- ADR-018 → consolidé dans ADR-020
- ADR-019 → remplacé par ADR-020
- ADR-022 → remplacé par ADR-051 (simplified formula)
- ADR-027 → remplacé par ADR-028, ADR-032
- ADR-038 → remplacé par ADR-051 (Search sections obsolete)
- ADR-048 → remplacé par ADR-051 (SHGAT replaces heuristics)

### Rejected (1)

- ADR-037 (Deno KV Cache) → overkill, PGlite suffit

---

## By Implementation Status

### Done (39)

ADR-001, 002, 003, 004, 005, 007, 008, 009, 010, 011, 012, 013, 014, 015, 016, 018, 019, 020, 020b,
021, 021b, 022, 023, 024, 025, 026, 030, 036, 038, 041, 042, 043, 044, 045, 047, 048, 050, 051, 052,
053, 054, 055, 056, 057, 058, 059

### In Progress (2)

ADR-028, ADR-032

### Partial (2)

ADR-006, ADR-017

### Not Started (9)

ADR-027, 029, 031, 033, 034, 035, 037, 039, 040, 046, 049

---

## Notes

- **ADRs 001-006** : ADRs fondamentaux dans
  [architecture-decision-records-adrs.md](../architecture/architecture-decision-records-adrs.md)
- **Numérotation dupliquée** : ADR-020 et ADR-021 ont des doublons (020b, 021b) - à renommer
- Pour changer un status, éditer ce fichier ET ajouter frontmatter YAML dans l'ADR
- **Couverture implémentation** : 39/54 (72%) done, 43/54 (80%) avec travail commencé ou terminé
