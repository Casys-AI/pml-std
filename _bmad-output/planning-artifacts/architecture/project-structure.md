# Project Structure

_Updated: December 2025_

```
casys-pml/
├── deno.json                    # Deno config, tasks, imports
├── drizzle.config.ts            # Drizzle ORM configuration
├── mod.ts                       # Public API exports
├── config/
│   └── .mcp-servers.json        # MCP servers configuration
│
├── src/
│   ├── main.ts                  # CLI entry point
│   │
│   ├── cli/                     # CLI commands
│   │   ├── commands/
│   │   │   ├── init.ts          # Initialize PML (migrate config, extract schemas)
│   │   │   ├── serve.ts         # Start MCP gateway server
│   │   │   ├── status.ts        # Health checks
│   │   │   ├── migrate-config.ts # Config migration helper
│   │   │   ├── speculation.ts   # Speculation management
│   │   │   └── workflows.ts     # Workflow commands
│   │   ├── auto-init.ts         # Auto-initialization logic
│   │   ├── config-migrator.ts   # Claude Desktop config migration
│   │   └── utils.ts             # CLI utilities, path helpers
│   │
│   ├── db/                      # Database layer
│   │   ├── client.ts            # PGlite initialization
│   │   ├── migrations.ts        # SQL migration runner
│   │   ├── migrations/          # SQL schema evolution
│   │   │   └── *.sql            # Versioned migrations
│   │   └── schema/              # Drizzle schema definitions
│   │       └── users.ts         # Users table (Epic 9)
│   │
│   ├── lib/                     # Shared libraries
│   │   ├── auth.ts              # Auth helpers (API keys, hashing)
│   │   ├── paths.ts             # Path resolution utilities
│   │   └── *.ts                 # Other shared utilities
│   │
│   ├── server/                  # HTTP server components
│   │   ├── auth/                # Authentication (Epic 9)
│   │   │   ├── middleware.ts    # Auth middleware
│   │   │   ├── oauth.ts         # GitHub OAuth handlers
│   │   │   └── api-key.ts       # API key validation
│   │   ├── events-stream.ts     # SSE event streaming
│   │   └── sse-handler.ts       # SSE connection handler
│   │
│   ├── mcp/                     # MCP protocol layer
│   │   ├── gateway-server.ts    # Main gateway server, tool handlers
│   │   ├── client.ts            # MCP SDK wrapper
│   │   ├── discovery.ts         # Server discovery
│   │   └── types.ts             # MCP type definitions
│   │
│   ├── dag/                     # DAG execution engine
│   │   ├── builder.ts           # Dependency graph construction
│   │   ├── executor.ts          # Parallel execution
│   │   ├── controlled-executor.ts # Adaptive executor (AIL/HIL)
│   │   ├── state.ts             # WorkflowState management
│   │   ├── event-stream.ts      # Event streaming
│   │   ├── command-queue.ts     # Command queue
│   │   ├── checkpoint-manager.ts # Checkpoint/resume
│   │   └── types.ts             # DAG node/edge types
│   │
│   ├── graphrag/                # GraphRAG engine
│   │   ├── graph-engine.ts      # Core graph algorithms
│   │   ├── dag-suggester.ts     # DAG replanning
│   │   ├── workflow-templates.ts # Template sync
│   │   └── types.ts             # Graph types
│   │
│   ├── sandbox/                 # Code execution sandbox
│   │   ├── sandbox-worker.ts    # Isolated worker script
│   │   ├── worker-bridge.ts     # RPC bridge for MCP tools
│   │   ├── context-builder.ts   # Tool injection
│   │   └── types.ts             # Sandbox & RPC types
│   │
│   ├── speculation/             # Speculative execution
│   │   ├── speculative-executor.ts # Speculation engine
│   │   ├── cache.ts             # Result caching
│   │   └── types.ts             # Speculation types
│   │
│   ├── learning/                # Adaptive learning
│   │   ├── episodic-memory-store.ts # Episode storage
│   │   ├── adaptive-threshold.ts # Threshold manager
│   │   └── types.ts             # Learning types
│   │
│   ├── capabilities/            # Emergent capabilities (Epic 7)
│   │   ├── matcher.ts           # Intent → capability matching
│   │   ├── schema-inferrer.ts   # SWC-based parameter inference
│   │   ├── code-generator.ts    # Inline function generation
│   │   ├── executor.ts          # Capability execution
│   │   ├── mod.ts               # Module exports
│   │   └── types.ts             # Capability types
│   │
│   ├── vector/                  # Vector search
│   │   ├── embeddings.ts        # BGE-M3 model inference
│   │   ├── search.ts            # Semantic search
│   │   └── index.ts             # HNSW index management
│   │
│   ├── context/                 # Context management
│   │   └── *.ts                 # Context utilities
│   │
│   ├── health/                  # Health checks
│   │   └── *.ts                 # Health check utilities
│   │
│   ├── errors/                  # Error handling
│   │   └── error-types.ts       # Custom error types
│   │
│   ├── telemetry/               # Observability
│   │   ├── logger.ts            # std/log wrapper
│   │   ├── metrics.ts           # Context/latency tracking
│   │   └── types.ts             # Metric definitions
│   │
│   ├── utils/                   # Shared utilities
│   │   ├── errors.ts            # Error utilities
│   │   ├── retry.ts             # Retry logic with backoff
│   │   └── validation.ts        # Input validation helpers
│   │
│   └── web/                     # Fresh 2 dashboard
│       ├── main.ts              # Fresh entry point
│       ├── dev.ts               # Development server
│       ├── vite.config.ts       # Vite configuration
│       ├── routes/              # Fresh routes
│       │   ├── index.tsx        # Landing page
│       │   ├── auth/            # Auth routes (signin, callback, signout)
│       │   ├── dashboard/       # Dashboard routes
│       │   │   ├── index.tsx    # Main dashboard
│       │   │   └── settings.tsx # User settings
│       │   └── api/             # API routes
│       ├── islands/             # Interactive Preact islands
│       ├── components/          # Shared UI components
│       ├── assets/              # Static assets
│       └── utils/               # Web utilities
│
├── tests/                       # Test suite
│   ├── unit/                    # Unit tests
│   │   ├── sandbox/             # Sandbox tests
│   │   ├── capabilities/        # Capabilities tests
│   │   └── ...
│   ├── integration/             # Integration tests
│   ├── fixtures/                # Mock data
│   └── mocks/                   # Mock MCP servers
│
├── playground/                  # Jupyter notebook playground
│   ├── notebooks/               # Interactive notebooks
│   ├── lib/                     # Playground helpers
│   ├── scripts/                 # Setup scripts
│   └── server.ts                # Playground server
│
├── docs/                        # Documentation
│   ├── architecture/            # Architecture docs (this folder)
│   ├── adrs/                    # Architecture Decision Records
│   ├── sprint-artifacts/        # Sprint stories and specs
│   ├── user-docs/               # User guides
│   ├── spikes/                  # Technical spikes
│   ├── retrospectives/          # Sprint retrospectives
│   └── blog/                    # Blog posts
│
├── drizzle/                     # Drizzle migrations output
│
├── scripts/                     # Ops scripts
│
├── monitoring/                  # Monitoring configs
│
└── .devcontainer/               # Dev container configs
    └── playground/              # Playground devcontainer
```

## Key Directories

### `src/cli/`

CLI commands and utilities. Entry point is `src/main.ts` which routes to commands in
`src/cli/commands/`.

### `src/server/`

HTTP server components including authentication middleware (Epic 9), SSE streaming, and event
handlers.

### `src/mcp/`

MCP protocol implementation. `gateway-server.ts` is the main gateway exposing meta-tools
(`pml:execute_dag`, `pml:search_tools`, etc.).

### `src/sandbox/`

Isolated code execution environment. Uses Deno subprocess with restricted permissions.
`worker-bridge.ts` provides RPC for MCP tool access from sandbox.

### `src/web/`

Fresh 2 + Vite dashboard. Routes are in `routes/`, interactive components in `islands/`.

### `playground/`

Jupyter notebook environment for interactive exploration of PML features.

---
