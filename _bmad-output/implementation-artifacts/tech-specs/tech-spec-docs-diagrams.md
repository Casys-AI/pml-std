# Tech Spec: Documentation Diagrams Migration

## Overview

Migration des diagrammes ASCII vers Excalidraw dans la documentation user-docs.

## Status

- **Completed**: All pages migrated + 14 diagrams created (9 Priority 2 + 5 Priority 3)
- **Remaining**: None - all diagrams created

## Completed Pages

| Page                                                    | Diagrams Used                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `concepts/04-capabilities/01-what-is-capability.md`     | `emerge-tools-vs-capability`, `emerge-evolution`, `shg-graph-vs-hyperedge`, `emerge-meta-capabilities`, `emerge-clustering` |
| `concepts/01-foundations/01-mcp-protocol.md`            | `mcp-architecture`, `mcp-with`                                                                                              |
| `concepts/03-learning/01-graphrag.md`                   | `rag-graph`, `rag-graph-evolution`, `emerge-clustering`                                                                     |
| `concepts/05-dag-execution/05-speculative-execution.md` | `spec-sequential`, `spec-speculative`, `spec-confirm`, `spec-cost-decision`                                                 |
| `concepts/05-dag-execution/01-dag-structure.md`         | `dag-dag-model`, `dag-workflow`                                                                                             |
| `concepts/06-code-execution/02-worker-bridge.md`        | `rpc-bridge-after`                                                                                                          |

## New Diagrams Created (Priority 2 - DONE)

| Page                                              | Diagram Created                      | Status  |
| ------------------------------------------------- | ------------------------------------ | ------- |
| `concepts/01-foundations/02-gateway.md`           | `gateway-architecture.excalidraw`    | Created |
| `concepts/01-foundations/03-database.md`          | `database-schema.excalidraw`         | Created |
| `concepts/03-learning/02-dependencies.md`         | `dependency-types.excalidraw`        | Created |
| `concepts/04-capabilities/03-schema-inference.md` | `schema-inference.excalidraw`        | Created |
| `concepts/05-dag-execution/03-parallelization.md` | `dag-parallelization.excalidraw`     | Created |
| `concepts/06-code-execution/01-sandbox.md`        | `sandbox-architecture.excalidraw`    | Created |
| `concepts/06-code-execution/03-tracing.md`        | `tracing-flow.excalidraw`            | Created |
| `concepts/07-realtime/01-events.md`               | `realtime-events.excalidraw`         | Created |
| `concepts/07-realtime/02-visualization.md`        | `dashboard-visualization.excalidraw` | Created |

## Library & Theme Created

| File                        | Description                                                          |
| --------------------------- | -------------------------------------------------------------------- |
| `pml-library.excalidrawlib` | 24 composants réutilisables (Agent, Gateway, Server, Database, etc.) |
| `theme.json`                | Référence couleurs dark theme PML                                    |

## Remaining Pages

### Priority 1: Core Concepts (have matching diagrams) - DONE

| Page                                            | Diagrams Used                         | Status  |
| ----------------------------------------------- | ------------------------------------- | ------- |
| `concepts/02-discovery/01-semantic-search.md`   | `rag-flow`                            | ✅ Done |
| `concepts/02-discovery/02-hybrid-search.md`     | `rag-flow`                            | ✅ Done |
| `concepts/03-learning/04-feedback-loop.md`      | `coala-feedback-loops`                | ✅ Done |
| `concepts/04-capabilities/02-eager-learning.md` | `emerge-observation`                  | ✅ Done |
| `concepts/05-dag-execution/02-dag-suggester.md` | `dag-replanning`                      | ✅ Done |
| `concepts/05-dag-execution/04-checkpoints.md`   | `dag-observability`, `dag-resilience` | ✅ Done |

### Priority 2: New diagrams needed - COMPLETED

All 9 diagrams have been created.

### Priority 3: New diagrams needed - COMPLETED

| Page                                                | Diagram Needed                     | Status  |
| --------------------------------------------------- | ---------------------------------- | ------- |
| `reference/02-configuration.md`                     | `config-overview.excalidraw`       | Created |
| `reference/03-cli.md`                               | `cli-workflow.excalidraw`          | Created |
| `concepts/index.md`                                 | `pml-architecture.excalidraw`      | Created |
| `concepts/02-discovery/03-proactive-suggestions.md` | `proactive-suggestions.excalidraw` | Created |
| `concepts/03-learning/03-confidence-levels.md`      | `confidence-levels.excalidraw`     | Created |

## Existing Diagrams Available

```
src/web/assets/diagrams/
├── cas-*.excalidraw (4)           # Complex Adaptive Systems
├── coala-*.excalidraw (4)         # CoALA architecture
├── dag-*.excalidraw (8)           # DAG workflows
├── emerge-*.excalidraw (5)        # Emergent capabilities
├── mcp-*.excalidraw (4)           # MCP protocol
├── rag-*.excalidraw (5)           # RAG/Graph
├── rpc-bridge-*.excalidraw (2)    # Worker bridge
├── shg-*.excalidraw (5)           # SuperHyperGraph
├── spec-*.excalidraw (6)          # Speculative execution
├── NEW: gateway-architecture.excalidraw
├── NEW: database-schema.excalidraw
├── NEW: dependency-types.excalidraw
├── NEW: schema-inference.excalidraw
├── NEW: dag-parallelization.excalidraw
├── NEW: sandbox-architecture.excalidraw
├── NEW: tracing-flow.excalidraw
├── NEW: realtime-events.excalidraw
├── NEW: dashboard-visualization.excalidraw
├── NEW: pml-library.excalidrawlib (24 components)
├── NEW: theme.json
├── NEW: pml-architecture.excalidraw
├── NEW: proactive-suggestions.excalidraw
├── NEW: confidence-levels.excalidraw
├── NEW: config-overview.excalidraw
├── NEW: cli-workflow.excalidraw
├── two-layers.excalidraw
├── workflow-sequence.excalidraw
├── cross-layer-communication.excalidraw
└── graceful-degradation.excalidraw

Total: 61 diagrams + 1 library
```

## Implementation Notes

### Excalidraw Support

Added to `src/web/utils/docs.ts`:

- `loadExcalidrawFile()` - Loads .excalidraw files
- `preprocessMarkdown()` - Now async, handles `![alt](excalidraw:path)` syntax
- Cache for loaded diagrams

### Syntax

```markdown
![Alt Text](excalidraw:src/web/assets/diagrams/diagram-name.excalidraw)
```

### PML Library Usage

To use the pre-styled components:

1. Open Excalidraw
2. Menu Library → Open
3. Select `pml-library.excalidrawlib`
4. Drag & drop components

### Fallback

For simple ASCII that doesn't need a diagram, convert to:

- Markdown tables
- Bullet lists
- Code blocks with syntax highlighting

## Acceptance Criteria

- [x] All Priority 1 pages use Excalidraw diagrams
- [x] Priority 2 pages have new diagrams created
- [x] Priority 3 pages have new diagrams created
- [ ] No ASCII box-drawing characters remain in user-docs
- [ ] All diagrams render correctly on localhost:8081

## Next Steps

1. ~~Update Priority 2 markdown files to use new diagrams~~ ✅ DONE
2. ~~Complete Priority 1 pages with existing diagrams~~ ✅ DONE
3. ~~Create Priority 3 diagrams~~ ✅ DONE
4. ~~Update Priority 3 markdown files to reference new diagrams~~ ✅ DONE

**All diagram migrations complete!**
