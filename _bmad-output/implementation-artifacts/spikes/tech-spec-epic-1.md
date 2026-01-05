# Epic Technical Specification: Project Foundation & Context Optimization Engine

Date: 2025-11-05 Author: BMad Epic ID: 1 Status: Draft

---

## Overview

L'Epic 1 établit l'infrastructure fondamentale d'Casys PML en implémentant un système de context
optimization via vector search sémantique. L'objectif principal est de réduire la consommation de
contexte LLM par les tool schemas MCP de 30-50% à <5%, récupérant 90% de la fenêtre
conversationnelle pour usage utile. Cette optimisation repose sur PGlite (PostgreSQL WASM) avec
pgvector pour le vector search HNSW, BGE-Large-EN-v1.5 pour la génération d'embeddings 1024-dim, et
un système de chargement on-demand qui ne présente au LLM que les tools pertinents (top-k=3-10)
identifiés par similarité sémantique.

L'epic livre un système fonctionnel permettant à un développeur d'installer Casys PML, de migrer
automatiquement sa configuration MCP existante, et d'observer immédiatement une réduction du
contexte validant la proposition de valeur principale du projet.

## Objectives and Scope

**In-Scope:**

- Configuration Deno 2.5+ avec structure projet complète (CI/CD, tests, docs)
- PGlite database avec pgvector extension et schema complet (tool_embedding, tool_schema, config
  tables)
- MCP server discovery automatique (stdio + SSE) supportant 15+ servers simultanément
- Extraction et stockage des tool schemas via MCP protocol
- Génération d'embeddings vectoriels 1024-dim avec BGE-Large-EN-v1.5 local inference
- Semantic vector search avec HNSW index et top-k retrieval (cosine similarity)
- Système de chargement on-demand basé sur relevance score (k=3-10 tools)
- Migration tool (pml init) lisant mcp.json de Claude Code
- Logging structuré et telemetry backend opt-in (context tracking, latency metrics)

**Out-of-Scope (deferred to Epic 2):**

- DAG execution et parallélisation des workflows
- SSE streaming pour progressive results
- MCP gateway HTTP server
- Health checks et monitoring production
- End-to-end tests et production hardening
- Error handling advanced (retry logic, circuit breakers)

**Success Criteria:**

- Context window consumption <5% measured (vs 30-50% baseline sans Casys PML)
- Vector search P95 latency <100ms pour top-10 retrieval
- Support fonctionnel de 15+ MCP servers actifs simultanément
- Migration mcp.json → config.yaml sans erreur pour configs typiques
- Zero-config: installation → premier workflow optimisé en <10 minutes

## System Architecture Alignment

**Alignment avec Architecture Decisions:**

- **Runtime:** Deno 2.5/2.2 LTS (TypeScript native, secure by default, npm compat) - Story 1.1 setup
- **Database:** PGlite 0.3.11 (embedded WASM PostgreSQL, portable single-file, 3MB footprint) -
  Story 1.2
- **Vector Search:** pgvector HNSW (production-ready ANN search, <100ms P95) - Story 1.2, 1.5
- **Embeddings:** @huggingface/transformers 2.17.2 (BGE-Large-EN-v1.5, Deno-compatible) - Story 1.4
- **MCP Protocol:** @modelcontextprotocol/sdk official TypeScript SDK - Story 1.3
- **CLI Framework:** cliffy (type-safe, Deno-first) - Story 1.7
- **Logging:** std/log structured logging - Story 1.8

**Modules implémentés:**

- `src/db/` - PGlite client, migrations, queries
- `src/vector/` - Embeddings generation, semantic search, HNSW index
- `src/mcp/` - Server discovery, schema extraction, protocol handling
- `src/cli/` - Command structure (init, serve, status)
- `src/telemetry/` - Logger, metrics tracking
- `src/config/` - YAML loader, validation

**Constraints respectées:**

- Single-file database portability (PGlite)
- Zero external dependencies pour vector search (pgvector built-in)
- Local inference embeddings (aucun API call externe)
- Filesystem access préservé (pas Docker, accès direct ~/.pml/)
- Testing coverage target >80% (Deno.test native)

## Detailed Design

### Services and Modules

| Module            | Location         | Responsibilities                                                 | Story    | Key Components                                                                                               |
| ----------------- | ---------------- | ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| **Database**      | `src/db/`        | PGlite client initialization, schema migrations, query execution | 1.2      | `client.ts` (PGlite init), `migrations/001_initial.sql` (schema), `queries.ts` (prepared statements)         |
| **Vector Search** | `src/vector/`    | Embeddings generation, semantic search, HNSW index management    | 1.4, 1.5 | `embeddings.ts` (BGE-Large-EN-v1.5 inference), `search.ts` (cosine similarity), `index.ts` (HNSW operations) |
| **MCP Protocol**  | `src/mcp/`       | MCP server discovery, protocol handling, schema extraction       | 1.3      | `discovery.ts` (stdio/SSE discovery), `client.ts` (MCP SDK wrapper), `types.ts` (protocol types)             |
| **CLI**           | `src/cli/`       | Command-line interface, user interactions                        | 1.7      | `commands/init.ts` (migration tool), `commands/status.ts` (health), `main.ts` (cliffy setup)                 |
| **Telemetry**     | `src/telemetry/` | Structured logging, metrics tracking, observability              | 1.8      | `logger.ts` (std/log wrapper), `metrics.ts` (context/latency tracking), `types.ts` (metric definitions)      |
| **Configuration** | `src/config/`    | YAML config loading, validation, schema enforcement              | 1.7      | `loader.ts` (YAML parser), `validator.ts` (config schema), `types.ts` (config interfaces)                    |

**Module Dependencies:**

- All modules depend on `src/db/` for persistence
- `src/vector/` depends on `src/db/` for storing embeddings
- `src/mcp/` depends on `src/db/` for caching schemas
- `src/cli/` orchestrates all other modules
- `src/telemetry/` is cross-cutting (used by all modules)

### Data Models and Contracts

**Database Schema (PGlite + pgvector):**

```sql
-- Story 1.2: Tool schema storage
CREATE TABLE tool_schema (
  tool_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  input_schema JSONB NOT NULL,
  output_schema JSONB,
  cached_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Story 1.4: Vector embeddings storage
CREATE TABLE tool_embedding (
  tool_id TEXT PRIMARY KEY REFERENCES tool_schema(tool_id) ON DELETE CASCADE,
  embedding vector(1024) NOT NULL,  -- BGE-Large-EN-v1.5 dimensions
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for cosine similarity search (Story 1.5)
CREATE INDEX idx_embedding_vector ON tool_embedding
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Story 1.7: Configuration metadata
CREATE TABLE config_metadata (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Story 1.8: Telemetry metrics
CREATE TABLE telemetry_metrics (
  id SERIAL PRIMARY KEY,
  metric_name TEXT NOT NULL,
  value NUMERIC NOT NULL,
  tags JSONB,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_metrics_timestamp ON telemetry_metrics(timestamp DESC);
CREATE INDEX idx_metrics_name ON telemetry_metrics(metric_name);
```

**TypeScript Type Definitions:**

```typescript
// src/types.ts

export interface ToolSchema {
  toolId: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  cachedAt: Date;
}

export interface ToolEmbedding {
  toolId: string;
  embedding: Float32Array; // 1024-dim vector
  createdAt: Date;
}

export interface SearchResult {
  toolId: string;
  score: number; // Cosine similarity [0-1]
  schema: ToolSchema;
}

export interface Config {
  mcpServers: MCPServerConfig[];
  vector: {
    topK: number; // Default: 5
    threshold: number; // Default: 0.7
    modelName: string; // "Xenova/bge-large-en-v1.5"
  };
  telemetry: {
    enabled: boolean;
    logLevel: "error" | "warn" | "info" | "debug";
  };
}

export interface MCPServerConfig {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  transport: "stdio" | "sse";
}

export interface TelemetryMetric {
  name: string;
  value: number;
  tags?: Record<string, string>;
  timestamp: Date;
}
```

**JSON Schema Contracts:**

```typescript
// MCP Tool Schema format (from @modelcontextprotocol/sdk)
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
  };
}
```

### APIs and Interfaces

**CLI Commands (Story 1.7):**

```bash
# Initialize Casys PML and migrate MCP configuration
pml init [--dry-run] [--config <path>]
# Returns: Migration summary, config.yaml path, next steps

# Status check (Epic 2, out of scope for Epic 1)
pml status [--verbose]
# Returns: Server health, database size, metrics

# Serve gateway (Epic 2, out of scope for Epic 1)
pml serve [--port <port>] [--stdio]
# Starts MCP gateway server
```

**Vector Search API (Stories 1.4, 1.5, 1.6):**

```typescript
// src/vector/search.ts
export interface VectorSearchAPI {
  /**
   * Search for tools matching natural language query
   * @param query - Natural language query string
   * @param topK - Number of results to return (default: 5)
   * @param threshold - Minimum similarity score 0-1 (default: 0.7)
   * @returns Array of search results with scores
   */
  search(query: string, topK?: number, threshold?: number): Promise<SearchResult[]>;

  /**
   * Generate embedding for text
   * @param text - Input text to embed
   * @returns 1024-dim Float32Array embedding
   */
  getEmbedding(text: string): Promise<Float32Array>;

  /**
   * Index a tool schema with vector embedding
   * @param toolId - Unique tool identifier
   * @param schema - Tool schema to index
   */
  indexTool(toolId: string, schema: ToolSchema): Promise<void>;
}
```

**Database API (Story 1.2):**

```typescript
// src/db/client.ts
export interface DatabaseAPI {
  /**
   * Initialize PGlite database with pgvector
   * @param dbPath - Database file path (default: ~/.pml/pml.db)
   */
  initialize(dbPath?: string): Promise<void>;

  /**
   * Run migrations to current schema version
   */
  migrate(): Promise<void>;

  /**
   * Store tool schema
   */
  saveToolSchema(schema: ToolSchema): Promise<void>;

  /**
   * Store tool embedding
   */
  saveToolEmbedding(embedding: ToolEmbedding): Promise<void>;

  /**
   * Vector similarity search query
   * @param queryEmbedding - Query vector (1024-dim)
   * @param topK - Number of results
   * @returns Tool IDs and similarity scores
   */
  searchSimilar(
    queryEmbedding: Float32Array,
    topK: number,
  ): Promise<Array<{ toolId: string; score: number }>>;
}
```

**MCP Discovery API (Story 1.3):**

```typescript
// src/mcp/discovery.ts
export interface MCPDiscoveryAPI {
  /**
   * Discover MCP servers from config
   * @param config - MCP server configurations
   * @returns Array of connected server clients
   */
  discoverServers(config: MCPServerConfig[]): Promise<MCPClient[]>;

  /**
   * Extract tool schemas from MCP server
   * @param client - MCP server client
   * @returns Array of tool schemas
   */
  extractSchemas(client: MCPClient): Promise<ToolSchema[]>;
}

// src/mcp/client.ts
export interface MCPClient {
  serverId: string;
  transport: "stdio" | "sse";

  /**
   * List all tools exposed by this server
   */
  listTools(): Promise<MCPToolDefinition[]>;

  /**
   * Call a tool with arguments (Epic 2, out of scope for Epic 1)
   */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;

  /**
   * Close connection to server
   */
  close(): Promise<void>;
}
```

**Telemetry API (Story 1.8):**

```typescript
// src/telemetry/logger.ts
export interface LoggerAPI {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

// src/telemetry/metrics.ts
export interface MetricsAPI {
  /**
   * Record a metric value
   * @param name - Metric name (e.g., "context_usage_pct", "query_latency_ms")
   * @param value - Metric value
   * @param tags - Optional tags for filtering
   */
  record(name: string, value: number, tags?: Record<string, string>): Promise<void>;

  /**
   * Query metrics for analysis
   * @param name - Metric name filter
   * @param since - Start timestamp
   * @returns Array of metric records
   */
  query(name: string, since?: Date): Promise<TelemetryMetric[]>;
}
```

**Configuration API (Story 1.7):**

```typescript
// src/config/loader.ts
export interface ConfigAPI {
  /**
   * Load configuration from YAML file
   * @param path - Config file path (default: ~/.pml/config.yaml)
   * @returns Validated configuration object
   */
  load(path?: string): Promise<Config>;

  /**
   * Save configuration to YAML file
   */
  save(config: Config, path?: string): Promise<void>;

  /**
   * Validate configuration against schema
   */
  validate(config: unknown): Config;
}
```

**Error Response Codes:**

| Code                  | HTTP Status | Description                                | Recovery                              |
| --------------------- | ----------- | ------------------------------------------ | ------------------------------------- |
| `DB_INIT_ERROR`       | 500         | Database initialization failed             | Check file permissions, disk space    |
| `VECTOR_SEARCH_ERROR` | 500         | Vector search operation failed             | Check index exists, retry             |
| `MCP_SERVER_ERROR`    | 502         | MCP server unreachable or invalid response | Check server config, restart server   |
| `SCHEMA_INVALID`      | 400         | Tool schema validation failed              | Fix schema format, consult MCP spec   |
| `CONFIG_INVALID`      | 400         | Configuration file invalid                 | Fix YAML syntax, check schema         |
| `EMBEDDING_ERROR`     | 500         | Embedding generation failed                | Check model loaded, sufficient memory |

### Workflows and Sequencing

**Workflow 1: Initialization & Migration (Story 1.7)**

```
User runs: pml init
    |
    v
1. Detect claude_desktop_config.json path (OS-specific)
    - macOS: ~/Library/Application Support/Claude/
    - Linux: ~/.config/claude/
    - Windows: %APPDATA%\Claude\
    |
    v
2. Parse existing mcp.json → extract MCP server configs
    |
    v
3. Generate ~/.pml/config.yaml with migrated servers
    |
    v
4. Initialize PGlite database (~/.pml/pml.db)
    - Run migrations (create tables + indexes)
    |
    v
5. Discover MCP servers (Story 1.3 workflow)
    |
    v
6. Extract tool schemas from all servers
    - For each server: connect → list_tools → parse schemas
    |
    v
7. Generate embeddings (Story 1.4 workflow)
    - For each tool: concat(name, description, params) → BGE model → store
    |
    v
8. Display migration summary:
    - Servers discovered: X
    - Tools indexed: Y
    - Embeddings generated: Y
    - Config path: ~/.pml/config.yaml
    |
    v
9. Print instructions for updating mcp.json to point to Casys PML
```

**Workflow 2: MCP Server Discovery (Story 1.3)**

```
Input: MCPServerConfig[] from config.yaml
    |
    v
For each server config:
    |
    v
1. Spawn subprocess via Deno.Command
    - stdio transport: stdin/stdout pipes
    - SSE transport: HTTP connection
    |
    v
2. Initialize MCP protocol handshake
    - Send: initialize request
    - Receive: server capabilities
    |
    v
3. Send list_tools request
    |
    v
4. Receive tool definitions (name, description, inputSchema)
    |
    v
5. Validate schemas (JSON Schema format)
    |
    v
6. Store in tool_schema table
    - tool_id: server_id:tool_name
    - server_id, name, description, input_schema, output_schema
    |
    v
7. Error handling:
    - Server unreachable → log warning, continue with other servers
    - Invalid schema → log error with tool name, skip tool
    |
    v
Output: Array of ToolSchema objects
```

**Workflow 3: Embedding Generation (Story 1.4)**

```
Input: ToolSchema[] from database
    |
    v
1. Load BGE-Large-EN-v1.5 model (lazy init, first time only)
    - Download from HuggingFace Hub if not cached
    - ~1.5GB model size
    |
    v
2. For each tool schema:
    |
    v
3. Prepare text input:
    text = f"{tool.name}. {tool.description}. Parameters: {param_names.join(', ')}"
    |
    v
4. Generate embedding:
    - Tokenize text
    - Model forward pass
    - Extract [CLS] token embedding (1024-dim)
    |
    v
5. Store in tool_embedding table:
    - tool_id (FK to tool_schema)
    - embedding (vector(1024))
    - created_at
    |
    v
6. Progress indication:
    - Console: "Generating embeddings... [42/200]"
    - ETA calculation based on average time per tool
    |
    v
7. Performance target:
    - Total time <2 minutes for 200 tools (~0.6s per tool)
    |
    v
Output: ToolEmbedding records stored in database
```

**Workflow 4: Semantic Search & Context Optimization (Stories 1.5, 1.6)**

```
Input: Natural language query from LLM
    |
    v
1. Generate query embedding:
    - Same BGE model as tools
    - query_vector = embed(query_text)
    |
    v
2. Vector similarity search (HNSW index):
    SELECT tool_id,
           embedding <=> query_vector AS distance,
           1 - distance AS score
    FROM tool_embedding
    ORDER BY distance
    LIMIT topK;
    |
    v
3. Filter by threshold (default 0.7):
    results = results.filter(r => r.score >= threshold)
    |
    v
4. Retrieve full tool schemas:
    SELECT ts.*
    FROM tool_schema ts
    WHERE ts.tool_id IN (matched_tool_ids)
    |
    v
5. Measure context usage:
    - Count tokens in loaded schemas (estimate: ~100-200 tokens per tool)
    - Calculate percentage of total context window
    - Log metric: context_usage_pct
    |
    v
6. Return SearchResult[] to caller:
    - Tool schemas (only matched tools, not all 200+)
    - Relevance scores
    - Context usage stats
    |
    v
Performance targets:
- Query embedding generation: <50ms
- Vector search (HNSW): <100ms P95
- Full schema retrieval: <50ms
- Total latency: <200ms P95
```

**Workflow 5: Telemetry Collection (Story 1.8)**

```
Throughout all workflows:
    |
    v
1. Logger captures events:
    - logger.info("Workflow started", { workflow: "init", user: "dev" })
    - logger.error("MCP server unreachable", { serverId: "filesystem" })
    |
    v
2. Metrics recorded:
    - metrics.record("context_usage_pct", 3.2, { query: "hash_xyz" })
    - metrics.record("query_latency_ms", 145, { phase: "vector_search" })
    |
    v
3. Log destination:
    - Console: INFO level (colorized)
    - File: ~/.pml/logs/pml.log (all levels, JSON format)
    |
    v
4. Metrics storage:
    - Insert into telemetry_metrics table
    - Timestamp, metric_name, value, tags (JSONB)
    |
    v
5. User consent:
    - First launch: prompt "Enable telemetry? [y/N]"
    - Config: telemetry.enabled = false (default)
    - No data leaves local machine (privacy-first)
```

**Story Execution Sequence (Epic 1):**

```
1.1 (Project Setup)
    ↓
1.2 (PGlite + pgvector) ← Database foundation required by all following stories
    ↓
1.3 (MCP Discovery) ← Requires DB to store schemas
    ↓
1.4 (Embeddings) ← Requires schemas from 1.3, DB from 1.2
    ↓
1.5 (Vector Search) ← Requires embeddings from 1.4
    ↓
1.6 (On-demand Loading) ← Requires vector search from 1.5
    ↓
1.7 (Migration Tool) ← Orchestrates workflows 1.3-1.6
    ↓
1.8 (Telemetry) ← Cross-cutting, implemented throughout

Note: No forward dependencies - each story builds only on completed work
```

## Non-Functional Requirements

### Performance

**Measurable Performance Targets (from PRD NFR001):**

| Metric                               | Target              | Measurement Method                                                 | Story |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------ | ----- |
| **Context Window Consumption**       | <5%                 | Token counting of loaded schemas vs total LLM window (200k tokens) | 1.6   |
| **Vector Search Latency (P95)**      | <100ms              | Benchmark test with 1000+ vectors, measure query execution time    | 1.5   |
| **Query-to-Schema Latency (P95)**    | <200ms              | End-to-end: query → embed → search → retrieve schemas              | 1.6   |
| **Embedding Generation (200 tools)** | <2 minutes          | Batch processing all schemas, measure total time                   | 1.4   |
| **MCP Server Discovery**             | Support 15+ servers | Concurrent connections, measure success rate                       | 1.3   |
| **Database Initialization**          | <5 seconds          | Measure time from db.initialize() to ready state                   | 1.2   |

**Performance Implementation Details:**

- **Vector Search Optimization (Story 1.5):**
  - HNSW index configuration: `m=16` (graph connectivity), `ef_construction=64` (build quality)
  - Query `ef_search=40` (default) for balanced recall/speed
  - Cosine similarity operator: `<=>` (pgvector optimized)
  - Expected recall: >90% for top-10 results

- **Embedding Generation Optimization (Story 1.4):**
  - Model loading: Lazy initialization (first use only)
  - Caching strategy: Never regenerate if schema unchanged (check hash)
  - Progress indication: Console progress bar + ETA
  - Batch processing: Sequential (model in-memory), no batching needed

- **Context Budget Management (Story 1.6):**
  - Token estimation: ~150 tokens per tool schema (average)
  - Budget allocation: 5% of 200k tokens = 10k tokens ≈ 66 tools max
  - Dynamic loading: Load top-k results until budget exhausted
  - Fallback: If budget exceeded, reduce topK parameter

**Latency Breakdown (Target P95):**

```
Total query-to-schema latency: <200ms
├── Query embedding generation: <50ms (BGE model forward pass)
├── Vector similarity search: <100ms (HNSW index lookup)
├── Schema retrieval (SQL): <30ms (indexed PK lookup)
└── Result serialization: <20ms (JSON formatting)
```

**Resource Requirements:**

- **Memory:** 4GB minimum (BGE model ~1.5GB, PGlite ~500MB, HNSW index ~100MB for 200 tools)
- **Disk:** 1GB (database ~50MB, model cache ~1.5GB, logs ~50MB)
- **CPU:** Model inference benefits from multi-core (parallel embedding generation if needed)

### Security

**Security Requirements (from PRD NFR002):**

| Requirement                     | Implementation                                                                 | Story    |
| ------------------------------- | ------------------------------------------------------------------------------ | -------- |
| **Local-first data processing** | All embeddings generated locally, no external API calls                        | 1.4      |
| **No PII leakage**              | User queries and tool schemas never leave local machine                        | All      |
| **Sandboxed execution**         | Deno permissions model enforced (`--allow-read`, `--allow-net` explicit)       | 1.1      |
| **MCP server isolation**        | Each MCP server runs in separate subprocess (stdio isolation)                  | 1.3      |
| **Input validation**            | All CLI args validated via cliffy, MCP responses validated against JSON Schema | 1.7, 1.3 |
| **SQL injection prevention**    | Parameterized queries only (PGlite prepared statements)                        | 1.2      |
| **Filesystem access control**   | Limited to `~/.pml/` directory for database/logs/config                        | 1.2, 1.8 |

**Security Implementation Details:**

- **Deno Security Model (Story 1.1):**
  - Explicit permissions required: `--allow-read=~/.pml`, `--allow-net` (for model download only)
  - No `eval()` or `Function()` constructor usage
  - Import map restrictions: Only trusted npm packages via Deno's npm: prefix

- **Data Protection (Story 1.4, 1.8):**
  - User queries: Embedded locally, stored only as vectors (not plaintext)
  - Tool schemas: Cached locally, never transmitted
  - Telemetry: Opt-in only, no sensitive data (queries/schemas) collected
  - Privacy-first: Default telemetry.enabled = false

- **MCP Protocol Security (Story 1.3):**
  - stdio transport: Isolated subprocess, no network exposure
  - SSE transport: Localhost only (127.0.0.1), no remote connections
  - Schema validation: Reject malformed or malicious schemas
  - Error messages: Sanitized (no sensitive info in logs)

- **Authentication & Authorization:**
  - Not applicable (local CLI tool, single-user)
  - Future consideration: If multi-user deployment needed (Epic 2+)

**Threat Model:**

| Threat                     | Mitigation                                           | Priority |
| -------------------------- | ---------------------------------------------------- | -------- |
| Malicious MCP server       | Schema validation, subprocess isolation              | High     |
| Path traversal attack      | Restrict filesystem access to ~/.pml/                | Medium   |
| Memory exhaustion          | Model size limits, HNSW index size monitoring        | Medium   |
| Dependency vulnerabilities | Deno's built-in security audit, minimal dependencies | High     |
| SQL injection              | Parameterized queries only                           | High     |

### Reliability/Availability

**Reliability Targets (from PRD NFR003):**

| Requirement                     | Target                         | Implementation                                                       | Story |
| ------------------------------- | ------------------------------ | -------------------------------------------------------------------- | ----- |
| **MCP server failures**         | Graceful degradation           | Log error, continue with other servers, return partial results       | 1.3   |
| **Database corruption**         | Auto-recovery                  | Database file backup on first init, migration rollback capability    | 1.2   |
| **Embedding model unavailable** | Fail-fast with clear message   | Check model download on init, provide installation instructions      | 1.4   |
| **Disk space exhaustion**       | Pre-flight check               | Check available space before init (require 1GB free)                 | 1.7   |
| **Invalid configuration**       | Validation with helpful errors | YAML schema validation, detailed error messages with fix suggestions | 1.7   |

**Error Handling Strategy:**

- **MCP Server Discovery (Story 1.3):**
  ```typescript
  for (const serverConfig of mcpServers) {
    try {
      const client = await connectToServer(serverConfig);
      const schemas = await extractSchemas(client);
      successfulServers.push({ serverId: serverConfig.id, toolCount: schemas.length });
    } catch (error) {
      logger.warn(`MCP server unreachable: ${serverConfig.id}`, { error: error.message });
      failedServers.push({ serverId: serverConfig.id, error: error.message });
      // Continue with other servers (no throw)
    }
  }
  // Return partial success: { successful: X, failed: Y, total: Z }
  ```

- **Database Initialization (Story 1.2):**
  ```typescript
  try {
    await db.initialize();
    await db.migrate();
  } catch (error) {
    if (error.code === "EACCES") {
      throw new DBInitError("Permission denied. Check ~/.pml/ permissions.");
    } else if (error.code === "ENOSPC") {
      throw new DBInitError("Insufficient disk space. Require 1GB free.");
    } else {
      throw new DBInitError(`Database initialization failed: ${error.message}`);
    }
  }
  ```

- **Vector Search Failures (Story 1.5):**
  - HNSW index not found → Rebuild index automatically
  - Query timeout (>5s) → Return error, suggest re-indexing
  - No results found → Return empty array (not error), suggest threshold adjustment

**Degradation Behavior:**

| Failure Scenario              | System Behavior                             | User Experience                                     |
| ----------------------------- | ------------------------------------------- | --------------------------------------------------- |
| 1 MCP server down (out of 15) | Continue with 14 servers                    | Warning logged, partial functionality               |
| All MCP servers down          | Cannot discover tools                       | Clear error message with troubleshooting steps      |
| Vector search slow (>500ms)   | Return results with latency warning         | Suggest re-indexing or reducing topK                |
| Database locked               | Retry with exponential backoff (3 attempts) | Transparent to user if succeeds within 5s           |
| Model download fails          | Fail initialization                         | Provide manual download instructions + retry option |

**Recovery Mechanisms:**

- **Database Recovery (Story 1.2):**
  - Automatic backup: Create `pml.db.backup` on first successful init
  - Manual recovery: `pml init --restore-backup` command
  - Migration rollback: Track migration version, rollback on failure

- **Configuration Recovery (Story 1.7):**
  - Invalid YAML → Print validation errors, keep existing config
  - Missing required fields → Merge with defaults, prompt for manual edit

- **Restart Resilience:**
  - All data persisted in PGlite (no in-memory state)
  - Embeddings cached (no regeneration on restart)
  - MCP connections re-established on demand

### Observability

**Observability Requirements (Story 1.8):**

| Signal Type | Implementation                      | Destination                         | Story |
| ----------- | ----------------------------------- | ----------------------------------- | ----- |
| **Logs**    | Structured JSON logging via std/log | Console (INFO+) + File (ALL levels) | 1.8   |
| **Metrics** | Custom metrics tracking in PGlite   | telemetry_metrics table, queryable  | 1.8   |
| **Traces**  | Not implemented (Epic 1 scope)      | Future: Deno Trace API (Epic 2+)    | N/A   |

**Logging Strategy:**

```typescript
// src/telemetry/logger.ts
import * as log from "std/log";

// Log levels
export enum LogLevel {
  ERROR = "ERROR", // Critical failures requiring attention
  WARN = "WARN", // Degraded functionality, recoverable errors
  INFO = "INFO", // Key user actions, workflow milestones
  DEBUG = "DEBUG", // Detailed troubleshooting info
}

// Structured log format
interface LogEntry {
  timestamp: string; // ISO 8601
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

// Example usage
logger.info("MCP server discovered", {
  serverId: "filesystem",
  toolCount: 42,
  transport: "stdio",
});

logger.error("Vector search failed", {
  query: "sha256_hash_of_query",
  error: error.message,
  latency_ms: 1523,
});
```

**Key Metrics Tracked:**

| Metric Name                | Type      | Description                                        | Target         |
| -------------------------- | --------- | -------------------------------------------------- | -------------- |
| `context_usage_pct`        | Gauge     | Percentage of LLM context consumed by tool schemas | <5%            |
| `query_latency_ms`         | Histogram | End-to-end query-to-schema latency                 | P95 <200ms     |
| `vector_search_latency_ms` | Histogram | Vector similarity search time                      | P95 <100ms     |
| `embedding_generation_ms`  | Histogram | Time to generate single embedding                  | Median <600ms  |
| `mcp_servers_discovered`   | Counter   | Number of successfully connected MCP servers       | N/A            |
| `mcp_servers_failed`       | Counter   | Number of failed MCP server connections            | N/A            |
| `tools_indexed`            | Gauge     | Total number of tools indexed in database          | N/A            |
| `db_size_bytes`            | Gauge     | Size of PGlite database file                       | Monitor growth |

**Metrics Collection Examples:**

```typescript
// Story 1.6: Context usage measurement
await metrics.record("context_usage_pct", 3.2, {
  query_hash: hashQuery(query),
  tools_loaded: 5,
  total_context_tokens: 200000,
});

// Story 1.5: Vector search performance
const startTime = performance.now();
const results = await vectorSearch.search(query, topK);
const latency = performance.now() - startTime;
await metrics.record("vector_search_latency_ms", latency, {
  topK: topK,
  results_count: results.length,
});

// Story 1.3: Server discovery
await metrics.record("mcp_servers_discovered", successfulServers.length);
await metrics.record("mcp_servers_failed", failedServers.length);
```

**Log Destinations:**

- **Console Output (INFO level):**
  - Colorized for terminal (green=success, yellow=warn, red=error)
  - Format: `[TIMESTAMP] [LEVEL] MESSAGE { context }`
  - User-friendly messages (not JSON)

- **File Output (ALL levels):**
  - Location: `~/.pml/logs/pml.log`
  - Format: JSON (one line per entry)
  - Rotation: Daily, keep last 7 days, max 100MB total
  - Example:
    ```json
    {
      "timestamp": "2025-11-05T10:30:45.123Z",
      "level": "INFO",
      "message": "Workflow completed",
      "context": { "duration_ms": 4200, "tools_executed": 5 }
    }
    ```

**Privacy & Telemetry:**

- **Opt-in Consent (Story 1.8):**
  - First launch: Prompt "Enable telemetry? [y/N]"
  - Config: `telemetry.enabled = false` (default)
  - CLI flag: `--telemetry` to override

- **Data Privacy:**
  - NO user queries logged (only SHA256 hashes for correlation)
  - NO tool schemas logged (only tool_ids)
  - NO file paths logged (only directory names)
  - All data stays local (never transmitted)

**Debugging Support:**

- **Debug Mode:**
  ```bash
  pml init --log-level=debug
  # Prints detailed info: SQL queries, embedding vectors, HTTP requests
  ```

- **Queryable Metrics:**
  ```bash
  pml status --metrics
  # Shows:
  # - Average context usage (last 24h)
  # - P95 query latency
  # - MCP server success rate
  # - Database size
  ```

## Dependencies and Integrations

**External Dependencies (from deno.json):**

| Package                          | Version    | Purpose                                                   | Story               | License    |
| -------------------------------- | ---------- | --------------------------------------------------------- | ------------------- | ---------- |
| `@electric-sql/pglite`           | 0.3.11     | Embedded PostgreSQL WASM with pgvector                    | 1.2                 | Apache 2.0 |
| `@electric-sql/pglite/vector`    | 0.3.11     | pgvector extension for HNSW vector search                 | 1.5                 | Apache 2.0 |
| `@xenova/transformers`           | 2.17.2     | HuggingFace Transformers.js (BGE-Large-EN-v1.5 inference) | 1.4                 | Apache 2.0 |
| `@cliffy/command`                | 1.0.0-rc.7 | Type-safe CLI framework for Deno                          | 1.7                 | MIT        |
| `@std/log`                       | 0.224.11   | Deno standard library structured logging                  | 1.8                 | MIT        |
| `@std/yaml`                      | 1.0.6      | YAML parsing for config files                             | 1.7                 | MIT        |
| `@std/fs`                        | 1.0.19     | Filesystem utilities                                      | 1.2, 1.7            | MIT        |
| `@std/assert`                    | 1.0.11     | Test assertions                                           | All (testing)       | MIT        |
| `graphology`                     | ^0.25.4    | Graph data structure library (Epic 2)                     | Out of scope Epic 1 | MIT        |
| `graphology-metrics`             | ^2.2.0     | PageRank and centrality metrics (Epic 2)                  | Out of scope Epic 1 | MIT        |
| `graphology-shortest-path`       | ^2.0.2     | Shortest path algorithms (Epic 2)                         | Out of scope Epic 1 | MIT        |
| `graphology-communities-louvain` | ^2.0.1     | Community detection (Epic 2)                              | Out of scope Epic 1 | MIT        |

**Note:** Graphology dependencies are pre-installed for Epic 2 but not used in Epic 1
implementation.

**MCP Protocol Dependency:**

The official MCP SDK is **not listed** in deno.json as it will be integrated in Epic 2 (Story 2.4 -
Gateway Integration). Epic 1 uses basic stdio subprocess communication via `Deno.Command` for server
discovery only.

Expected addition in Epic 2:

```json
"@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@latest"
```

**Built-in Deno APIs (no external dependency):**

- `Deno.Command` - Subprocess management for MCP servers (Story 1.3)
- `Deno.readTextFile` / `Deno.writeTextFile` - File I/O (Story 1.7)
- `Deno.stat` - Filesystem checks (Story 1.7)
- `crypto.subtle.digest` - SHA256 hashing for query privacy (Story 1.8)
- `performance.now()` - High-resolution timing for metrics (Story 1.5, 1.8)

**Integration Points:**

| Integration               | Direction               | Protocol                                                     | Story         |
| ------------------------- | ----------------------- | ------------------------------------------------------------ | ------------- |
| **MCP Servers**           | Casys PML → MCP Servers | stdio (stdin/stdout)                                         | 1.3           |
| **Claude Desktop Config** | Read-only               | JSON file read (~/.config/Claude/claude_desktop_config.json) | 1.7           |
| **PGlite Database**       | Internal                | SQL queries (parameterized)                                  | 1.2           |
| **BGE Model Cache**       | HuggingFace Hub         | HTTP download (first time only)                              | 1.4           |
| **Filesystem**            | Read/Write              | Deno file APIs (~/.pml/ directory)                           | 1.2, 1.7, 1.8 |

**External System Dependencies:**

- **Claude Desktop (optional):** Config migration reads from `claude_desktop_config.json`
  - Path: macOS: `~/Library/Application Support/Claude/`
  - Path: Linux: `~/.config/claude/`
  - Path: Windows: `%APPDATA%\Claude\`

- **MCP Servers (15+):** Discovered via config, each runs as independent subprocess
  - Communication: stdio (stdin/stdout pipes)
  - Isolation: Each server in separate process
  - Failure handling: Graceful degradation (continue with other servers)

**Dependency Version Constraints:**

- **Deno Runtime:** 2.2+ (LTS) or 2.5+ (latest)
- **TypeScript:** 5.7+ (via Deno)
- **Node Compatibility:** nodeModulesDir="auto" for npm packages

**Dependency Installation:**

Deno automatically installs dependencies on first run (no manual `npm install` needed):

```bash
deno task dev  # Auto-installs all imports from deno.json
```

**Security & Licensing:**

- All dependencies use permissive licenses (MIT, Apache 2.0)
- No GPL or copyleft licenses
- No known CVEs in specified versions (as of 2025-11-05)
- Deno's built-in security audit: `deno cache --lock=deno.lock --lock-write`

## Acceptance Criteria (Authoritative)

These acceptance criteria are extracted from Epic 1 stories ([epics.md](./epics.md)) and serve as
the authoritative definition of "done" for this epic.

**Story 1.1: Project Setup & Repository Structure**

1. Repository initialisé avec structure Deno standard (src/, tests/, docs/)
2. GitHub Actions CI configuré (lint, typecheck, tests)
3. deno.json configuré avec tasks scripts (test, lint, fmt, dev)
4. README.md avec badges CI et quick start guide
5. .gitignore approprié pour Deno projects
6. License MIT et CODE_OF_CONDUCT.md

**Story 1.2: PGlite Database Foundation with pgvector**

1. PGlite database initialization dans `~/.pml/.pml.db`
2. pgvector extension loaded et operational
3. Database schema créé avec tables: tool_embedding, tool_schema, config
4. Vector index HNSW créé sur tool_embedding.embedding avec pgvector
5. Basic CRUD operations testés (insert, query, update, delete)
6. Database migration system en place pour schema evolution future

**Story 1.3: MCP Server Discovery & Schema Extraction**

1. MCP server discovery via stdio et SSE protocols
2. Connection établie avec chaque discovered server
3. Tool schemas extracted via MCP protocol `list_tools` call
4. Schemas parsed et validated (input/output schemas, descriptions)
5. Schemas stockés dans PGlite `tool_schema` table
6. Error handling pour servers unreachable ou invalid schemas
7. Console output affiche nombre de servers discovered et tools extracted
8. Support au minimum 15 MCP servers simultanément

**Story 1.4: Embeddings Generation with BGE-Large-EN-v1.5**

1. BGE-Large-EN-v1.5 model downloaded et loaded (via @xenova/transformers)
2. Tool schemas (name + description + parameters) concatenés en text input
3. Embeddings (1024-dim) générés pour chaque tool
4. Embeddings stockés dans `tool_embeddings` table avec metadata
5. Progress bar affichée durant génération (peut prendre ~60s pour 100+ tools)
6. Embeddings cachés (pas de régénération si schema unchanged)
7. Total generation time <2 minutes pour 200 tools

**Story 1.5: Semantic Vector Search Implementation**

1. Query embedding génération (même modèle BGE-Large-EN-v1.5)
2. Cosine similarity search sur vector index (<100ms query time P95)
3. API: `searchTools(query: string, topK: number)` → tool_ids + scores
4. Top-k results returned sorted par relevance score (default k=5)
5. Configurable similarity threshold (default 0.7)
6. Unit tests validant accuracy avec sample queries
7. Benchmark test confirmant P95 <100ms pour 1000+ vectors

**Story 1.6: On-Demand Schema Loading & Context Optimization**

1. Integration semantic search avec schema loading
2. Workflow: query → vector search → retrieve top-k tools → load schemas
3. Schemas retournés uniquement pour matched tools (pas all-at-once)
4. Context usage measurement et logging (<5% target)
5. Comparison metric affiché: before (30-50%) vs after (<5%)
6. Cache hit pour frequently used tools (évite reloading)
7. Performance: Total query-to-schema latency <200ms P95

**Story 1.7: Migration Tool (`pml init`)**

1. CLI command `pml init` implemented
2. Detection automatique du claude_desktop_config.json path (OS-specific)
3. Parsing du mcp.json existant et extraction des MCP servers
4. Generation de `~/.pml/config.yaml` avec servers migrés
5. Embeddings generation triggered automatiquement post-migration
6. Console output avec instructions pour éditer mcp.json
7. Template affiché pour nouvelle config mcp.json (juste pml gateway)
8. Rollback capability si erreur durant migration
9. Dry-run mode (`--dry-run`) pour preview changes

**Story 1.8: Basic Logging & Telemetry Backend**

1. Structured logging avec std/log (Deno standard library)
2. Log levels: error, warn, info, debug
3. Log output: console + file (`~/.pml/logs/pml.log`)
4. Telemetry table dans PGlite: `metrics` (timestamp, metric_name, value)
5. Metrics tracked: context_usage_pct, query_latency_ms, tools_loaded_count
6. Opt-in consent prompt au premier launch (telemetry disabled by default)
7. CLI flag `--telemetry` pour enable/disable
8. Privacy: aucune data sensitive (queries, schemas) ne quitte local machine

## Traceability Mapping

This table maps each acceptance criteria to its implementation in this tech spec, the responsible
component(s), and test verification strategy.

| Story   | AC#   | Acceptance Criteria                     | Spec Section(s)                                                         | Component(s)                                  | Test Strategy                                                        |
| ------- | ----- | --------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| 1.1     | 1     | Repository structure initialized        | System Architecture Alignment                                           | Project root                                  | Integration test: Verify directory structure exists                  |
| 1.1     | 2     | GitHub Actions CI configured            | (Out of spec scope)                                                     | .github/workflows/                            | CI pipeline execution                                                |
| 1.1     | 3     | deno.json with task scripts             | Dependencies and Integrations                                           | deno.json                                     | Unit test: Parse and validate tasks                                  |
| 1.1     | 4     | README.md with badges                   | (Out of spec scope)                                                     | README.md                                     | Manual review                                                        |
| 1.1     | 5     | .gitignore configured                   | (Out of spec scope)                                                     | .gitignore                                    | Manual review                                                        |
| 1.1     | 6     | License and CODE_OF_CONDUCT             | (Out of spec scope)                                                     | LICENSE, CODE_OF_CONDUCT.md                   | Manual review                                                        |
| **1.2** | **1** | **PGlite initialization**               | **Data Models, APIs (DatabaseAPI)**                                     | **src/db/client.ts**                          | **Unit test: db.initialize() succeeds, file created**                |
| 1.2     | 2     | pgvector extension loaded               | Data Models (SQL schema)                                                | src/db/migrations/001_initial.sql             | Unit test: Query `SELECT * FROM pg_extension WHERE extname='vector'` |
| 1.2     | 3     | Schema tables created                   | Data Models (tool_schema, tool_embedding, config_metadata)              | src/db/migrations/001_initial.sql             | Unit test: SELECT from each table, verify columns                    |
| 1.2     | 4     | HNSW index created                      | Data Models (idx_embedding_vector)                                      | src/db/migrations/001_initial.sql             | Unit test: Query pg_indexes, verify HNSW index exists                |
| 1.2     | 5     | CRUD operations tested                  | APIs (DatabaseAPI methods)                                              | src/db/client.ts, src/db/queries.ts           | Unit test: Insert, select, update, delete rows                       |
| 1.2     | 6     | Migration system                        | Workflows (Database Recovery)                                           | src/db/migrations/                            | Integration test: Run migrations, verify versioning                  |
| **1.3** | **1** | **MCP discovery (stdio + SSE)**         | **APIs (MCPDiscoveryAPI), Workflows (Workflow 2)**                      | **src/mcp/discovery.ts**                      | **Integration test: Mock MCP servers, verify discovery**             |
| 1.3     | 2     | Connection to servers                   | APIs (MCPClient)                                                        | src/mcp/client.ts                             | Integration test: Connect to mock server, verify handshake           |
| 1.3     | 3     | Schema extraction via list_tools        | APIs (MCPDiscoveryAPI.extractSchemas)                                   | src/mcp/discovery.ts                          | Integration test: Mock list_tools response, verify parsing           |
| 1.3     | 4     | Schema parsing and validation           | APIs (MCPDiscoveryAPI), Data Models (MCPToolDefinition)                 | src/mcp/discovery.ts                          | Unit test: Valid/invalid schemas, verify JSON Schema validation      |
| 1.3     | 5     | Schemas stored in DB                    | Data Models (tool_schema table)                                         | src/db/queries.ts                             | Integration test: Extract schemas, query DB, verify stored           |
| 1.3     | 6     | Error handling for failures             | Reliability (MCP Server Discovery), Workflows (Workflow 2)              | src/mcp/discovery.ts                          | Unit test: Mock server failures, verify graceful degradation         |
| 1.3     | 7     | Console output with counts              | Observability (Logging)                                                 | src/mcp/discovery.ts                          | Integration test: Capture console output, verify format              |
| 1.3     | 8     | Support 15+ servers                     | Performance (MCP Server Discovery)                                      | src/mcp/discovery.ts                          | Load test: 15 mock servers, verify all discovered                    |
| **1.4** | **1** | **BGE model loaded**                    | **Dependencies (Transformers.js), Workflows (Workflow 3)**              | **src/vector/embeddings.ts**                  | **Integration test: Load model, verify ready state**                 |
| 1.4     | 2     | Schema text concatenation               | Workflows (Workflow 3, step 3)                                          | src/vector/embeddings.ts                      | Unit test: Input schema, verify text format                          |
| 1.4     | 3     | 1024-dim embeddings generated           | APIs (VectorSearchAPI.getEmbedding), Data Models (ToolEmbedding)        | src/vector/embeddings.ts                      | Unit test: Generate embedding, verify dimensions                     |
| 1.4     | 4     | Embeddings stored in DB                 | Data Models (tool_embedding table)                                      | src/db/queries.ts                             | Integration test: Generate + store, query DB, verify vector          |
| 1.4     | 5     | Progress bar displayed                  | Workflows (Workflow 3, step 6)                                          | src/vector/embeddings.ts                      | Manual test: Run with console, verify progress output                |
| 1.4     | 6     | Embeddings cached                       | Workflows (Workflow 3), Performance (Embedding Optimization)            | src/vector/embeddings.ts                      | Unit test: Regenerate same schema, verify cache hit                  |
| 1.4     | 7     | <2 min for 200 tools                    | Performance (Embedding Generation)                                      | src/vector/embeddings.ts                      | Benchmark test: 200 tools, measure total time                        |
| **1.5** | **1** | **Query embedding generation**          | **APIs (VectorSearchAPI.getEmbedding), Workflows (Workflow 4, step 1)** | **src/vector/embeddings.ts**                  | **Unit test: Embed query, verify 1024-dim output**                   |
| 1.5     | 2     | <100ms P95 cosine search                | Performance (Vector Search Latency)                                     | src/vector/search.ts                          | Benchmark test: 1000+ queries, measure P95                           |
| 1.5     | 3     | searchTools API                         | APIs (VectorSearchAPI.search)                                           | src/vector/search.ts                          | Unit test: Call API, verify return format                            |
| 1.5     | 4     | Top-k sorted by score                   | Workflows (Workflow 4, step 2-3)                                        | src/vector/search.ts                          | Unit test: Query, verify descending score order                      |
| 1.5     | 5     | Configurable threshold                  | APIs (VectorSearchAPI.search parameters)                                | src/vector/search.ts                          | Unit test: Set threshold, verify filtering                           |
| 1.5     | 6     | Accuracy unit tests                     | (Test strategy only)                                                    | tests/unit/vector/search_test.ts              | Unit test: Known queries, verify expected top results                |
| 1.5     | 7     | Benchmark P95 <100ms                    | Performance (Vector Search Latency)                                     | tests/benchmark/vector_search_bench.ts        | Benchmark test: P95 measurement                                      |
| **1.6** | **1** | **Search + schema loading integration** | **Workflows (Workflow 4)**                                              | **src/vector/search.ts + src/db/queries.ts**  | **Integration test: Query → search → load, verify schemas**          |
| 1.6     | 2     | Workflow: query → results               | Workflows (Workflow 4, full sequence)                                   | src/vector/search.ts                          | Integration test: Full workflow, verify each step                    |
| 1.6     | 3     | Only matched tools loaded               | Workflows (Workflow 4, step 4)                                          | src/vector/search.ts                          | Unit test: topK=5, verify only 5 schemas returned                    |
| 1.6     | 4     | Context usage <5%                       | Performance (Context Window Consumption)                                | src/telemetry/metrics.ts                      | Integration test: Measure tokens, verify <5%                         |
| 1.6     | 5     | Before/after comparison                 | Observability (Metrics: context_usage_pct)                              | src/telemetry/metrics.ts                      | Integration test: Log metrics, verify comparison logged              |
| 1.6     | 6     | Cache hit optimization                  | Performance (Context Budget Management)                                 | src/vector/search.ts                          | Unit test: Repeat query, verify cache behavior                       |
| 1.6     | 7     | <200ms P95 latency                      | Performance (Query-to-Schema Latency)                                   | tests/benchmark/context_optimization_bench.ts | Benchmark test: End-to-end P95 measurement                           |
| **1.7** | **1** | **pml init command**                    | **APIs (CLI Commands), Workflows (Workflow 1)**                         | **src/cli/commands/init.ts**                  | **Integration test: Run CLI, verify command executes**               |
| 1.7     | 2     | Auto-detect config path                 | Workflows (Workflow 1, step 1)                                          | src/cli/commands/init.ts                      | Unit test: Mock OS, verify correct path detection                    |
| 1.7     | 3     | Parse mcp.json                          | Workflows (Workflow 1, step 2)                                          | src/config/loader.ts                          | Unit test: Sample mcp.json, verify parsing                           |
| 1.7     | 4     | Generate config.yaml                    | APIs (ConfigAPI.save), Workflows (Workflow 1, step 3)                   | src/config/loader.ts                          | Integration test: Parse + generate, verify YAML output               |
| 1.7     | 5     | Trigger embeddings post-migration       | Workflows (Workflow 1, step 7)                                          | src/cli/commands/init.ts                      | Integration test: Full init, verify embeddings generated             |
| 1.7     | 6     | Console output with instructions        | Workflows (Workflow 1, step 8)                                          | src/cli/commands/init.ts                      | Integration test: Capture stdout, verify instructions                |
| 1.7     | 7     | Template for new mcp.json               | Workflows (Workflow 1, step 9)                                          | src/cli/commands/init.ts                      | Manual test: Verify template printed to console                      |
| 1.7     | 8     | Rollback on error                       | Reliability (Configuration Recovery)                                    | src/cli/commands/init.ts                      | Unit test: Force error, verify rollback                              |
| 1.7     | 9     | Dry-run mode                            | APIs (CLI Commands: --dry-run flag)                                     | src/cli/commands/init.ts                      | Integration test: Run --dry-run, verify no changes                   |
| **1.8** | **1** | **Structured logging with std/log**     | **Dependencies (@std/log), Observability (Logging)**                    | **src/telemetry/logger.ts**                   | **Unit test: Log message, verify structured format**                 |
| 1.8     | 2     | Log levels (error, warn, info, debug)   | APIs (LoggerAPI)                                                        | src/telemetry/logger.ts                       | Unit test: Each level, verify output                                 |
| 1.8     | 3     | Console + file output                   | Observability (Log Destinations)                                        | src/telemetry/logger.ts                       | Integration test: Log, verify both destinations                      |
| 1.8     | 4     | Metrics table in DB                     | Data Models (telemetry_metrics)                                         | src/db/migrations/001_initial.sql             | Unit test: Insert metric, query table                                |
| 1.8     | 5     | Metrics tracked                         | Observability (Key Metrics Tracked)                                     | src/telemetry/metrics.ts                      | Integration test: Record metrics, verify storage                     |
| 1.8     | 6     | Opt-in consent prompt                   | Observability (Privacy & Telemetry)                                     | src/cli/commands/init.ts                      | Manual test: First launch, verify prompt                             |
| 1.8     | 7     | --telemetry CLI flag                    | APIs (CLI Commands)                                                     | src/cli/main.ts                               | Unit test: Parse flag, verify config override                        |
| 1.8     | 8     | Privacy: no data leakage                | Security (Data Protection), Observability (Privacy)                     | All components                                | Security audit: Review logs, verify no sensitive data                |

## Risks, Assumptions, Open Questions

**RISKS:**

| ID | Risk                                                                     | Impact                              | Likelihood | Mitigation                                                                                       | Owner          |
| -- | ------------------------------------------------------------------------ | ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ | -------------- |
| R1 | BGE model download fails (network issues, HuggingFace Hub down)          | High - blocks initialization        | Medium     | Provide manual download instructions, local cache fallback, retry with exponential backoff       | Story 1.4      |
| R2 | PGlite WASM performance slower than expected on low-end devices          | Medium - degraded UX                | Low        | Benchmark on target devices early, document minimum requirements (4GB RAM), optimize HNSW params | Story 1.2, 1.5 |
| R3 | Vector search recall <90% for ambiguous queries                          | Medium - incorrect tool suggestions | Medium     | Extensive testing with real-world queries, adjustable threshold, user feedback loop              | Story 1.5      |
| R4 | MCP server diversity causes parsing failures (non-standard schemas)      | Medium - partial functionality      | High       | Robust JSON Schema validation, graceful degradation, log invalid schemas for investigation       | Story 1.3      |
| R5 | Memory exhaustion from large HNSW index (>1000 tools)                    | Low - crashes on load               | Low        | Monitor memory usage, implement index size limits, paginate if needed                            | Story 1.5      |
| R6 | Claude Desktop config path detection fails on non-standard installations | Medium - migration fails            | Medium     | Provide manual config path flag (--config), clear error messages with troubleshooting steps      | Story 1.7      |
| R7 | Token counting inaccuracy leads to >5% context usage                     | High - defeats core value prop      | Low        | Use same tokenizer as Claude (cl100k_base), add 10% safety margin, measure with real LLM         | Story 1.6      |

**ASSUMPTIONS:**

| ID | Assumption                                                                           | Validation                                                            | Impact if False                                    |
| -- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------- |
| A1 | Claude Desktop uses `claude_desktop_config.json` format consistently across versions | Check Claude documentation, test with multiple versions               | Migration tool breaks, require manual config       |
| A2 | MCP servers expose stdio transport reliably                                          | Test with 5+ popular MCP servers (filesystem, database, github, etc.) | Cannot discover servers, need SSE fallback         |
| A3 | BGE-Large-EN-v1.5 provides sufficient accuracy for tool search (>80% recall)         | Benchmark with ground-truth dataset of 50+ queries                    | Need to switch models or hybrid search             |
| A4 | PGlite supports concurrent reads without locking issues                              | Load test with parallel queries                                       | Performance degradation, need connection pooling   |
| A5 | Users have 4GB RAM and 1GB disk space available                                      | Document system requirements clearly                                  | Out-of-memory errors, cannot store model/database  |
| A6 | MCP protocol spec remains stable (no breaking changes)                               | Monitor @modelcontextprotocol/sdk releases                            | Need to update implementation for protocol changes |
| A7 | Vector search on 200-1000 tools fits in memory without pagination                    | Test with 1000 tool embeddings (~400MB)                               | Need to implement index sharding or pagination     |
| A8 | Deno 2.5+ npm compatibility works for all dependencies                               | Test all npm packages (PGlite, Transformers.js)                       | Need to find Deno-native alternatives              |

**OPEN QUESTIONS:**

| ID | Question                                                                              | Decision Needed By | Assigned To    |
| -- | ------------------------------------------------------------------------------------- | ------------------ | -------------- |
| Q1 | Should we support migration from other MCP clients (not just Claude Desktop)?         | Story 1.7 start    | Product (BMad) |
| Q2 | What is the fallback strategy if BGE model is unavailable (no internet, limited RAM)? | Story 1.4 start    | Architecture   |
| Q3 | Do we need to support custom embedding models (allow users to choose)?                | Epic 2 (deferred)  | Product        |
| Q4 | Should telemetry be opt-out instead of opt-in for better observability?               | Story 1.8 start    | Legal/Privacy  |
| Q5 | What is the strategy for handling MCP protocol version mismatches?                    | Epic 2 (Story 2.4) | Architecture   |
| Q6 | Should we cache MCP server responses to reduce discovery latency?                     | Story 1.3 design   | Architecture   |
| Q7 | How do we handle tool schema changes (versioning, invalidation)?                      | Story 1.3 design   | Architecture   |
| Q8 | Is <5% context usage sufficient, or should we target <3% for more buffer?             | Story 1.6 testing  | Product        |

**DECISION LOG:**

| Date       | Question                                                | Decision                            | Rationale                                                            |
| ---------- | ------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| 2025-11-03 | Q: Use sqlite-vec or pgvector?                          | Decision: pgvector via PGlite       | HNSW support, production-ready, <100ms P95 performance               |
| 2025-11-03 | Q: Local embeddings vs API (OpenAI)?                    | Decision: Local (BGE-Large-EN-v1.5) | Privacy-first, no API costs, offline support                         |
| 2025-11-03 | Q: Custom DAG implementation or library?                | Decision: Custom (zero deps)        | Explicit AC requirement, educational value, no bloat                 |
| 2025-11-03 | Q: Use Graphology or implement graph algorithms in SQL? | Decision: Graphology                | True algorithms (PageRank, Louvain), 90% simpler schema, 3-5x faster |
| 2025-11-05 | Q: Should Epic 1 include MCP gateway?                   | Decision: No, defer to Epic 2       | Epic 1 focuses on context optimization only, gateway adds complexity |

## Test Strategy Summary

**Testing Levels and Coverage Target:**

| Test Level            | Coverage Target      | Tools                       | Responsibility                     |
| --------------------- | -------------------- | --------------------------- | ---------------------------------- |
| **Unit Tests**        | >80% code coverage   | Deno.test, @std/assert      | Per-function logic, edge cases     |
| **Integration Tests** | All AC workflows     | Deno.test, mock fixtures    | Component interactions, data flow  |
| **Benchmark Tests**   | All performance ACs  | Deno bench                  | P95 latency, throughput validation |
| **E2E Tests**         | Critical user paths  | Deno.test, real MCP servers | Full initialization workflow       |
| **Manual Tests**      | UX validation        | Human testing               | Console output, error messages     |
| **Security Audit**    | Privacy/security ACs | Code review                 | No PII leakage, input validation   |

**Test Organization:**

```
tests/
├── unit/                           # Unit tests (co-located with source)
│   ├── db/
│   │   ├── client_test.ts         # Story 1.2: Database init, migrations
│   │   └── queries_test.ts        # Story 1.2: CRUD operations
│   ├── vector/
│   │   ├── embeddings_test.ts     # Story 1.4: Embedding generation, caching
│   │   └── search_test.ts         # Story 1.5: Vector search, accuracy
│   ├── mcp/
│   │   ├── discovery_test.ts      # Story 1.3: Server discovery, error handling
│   │   └── client_test.ts         # Story 1.3: MCP protocol communication
│   ├── config/
│   │   └── loader_test.ts         # Story 1.7: YAML parsing, validation
│   └── telemetry/
│       ├── logger_test.ts         # Story 1.8: Log levels, formatting
│       └── metrics_test.ts        # Story 1.8: Metric recording, querying
│
├── integration/                    # Integration tests
│   ├── vector_db_test.ts          # Story 1.5: Vector search + DB integration
│   ├── mcp_discovery_e2e_test.ts  # Story 1.3: Discovery → extraction → storage
│   ├── context_optimization_test.ts # Story 1.6: Query → search → load workflow
│   └── migration_workflow_test.ts # Story 1.7: Full init workflow with mocks
│
├── benchmark/                      # Benchmark tests (Deno bench)
│   ├── vector_search_bench.ts     # Story 1.5 AC7: P95 <100ms validation
│   ├── embedding_generation_bench.ts # Story 1.4 AC7: <2min for 200 tools
│   └── context_optimization_bench.ts # Story 1.6 AC7: P95 <200ms end-to-end
│
├── fixtures/                       # Test data
│   ├── mcp-config-sample.json     # Sample Claude Desktop config
│   ├── tool-schemas.json          # Mock MCP tool schemas
│   └── embeddings-sample.json     # Pre-computed embeddings for tests
│
└── mocks/                          # Mock servers/services
    ├── filesystem-mock.ts         # Mock MCP server (stdio)
    ├── database-mock.ts           # Mock MCP server (database)
    └── api-mock.ts                # Mock HTTP responses (HuggingFace Hub)
```

**Test Execution:**

```bash
# Run all tests (unit + integration)
deno task test

# Run only unit tests
deno task test:unit

# Run integration tests (excludes E2E)
deno task test:integration

# Run E2E tests (requires real MCP servers)
deno task test:e2e

# Run benchmarks
deno task bench

# Type checking (no execution)
deno task check

# Coverage report
deno test --coverage=coverage/ --allow-all
deno coverage coverage/
```

**Critical Test Scenarios (High Priority):**

1. **Story 1.2:** Database initialization on fresh system, migration rollback on failure
2. **Story 1.3:** MCP server discovery with 15+ servers, graceful failure handling (5 down, 10 up)
3. **Story 1.4:** Embedding generation with network failure (mock HuggingFace Hub down), cache hit
   verification
4. **Story 1.5:** Vector search accuracy with ambiguous queries, P95 latency <100ms with 1000
   vectors
5. **Story 1.6:** Context usage measurement accuracy, <5% target validation with token counting
6. **Story 1.7:** Migration tool with malformed mcp.json, dry-run mode verification, rollback on
   error
7. **Story 1.8:** Privacy validation: no queries or schemas in logs (only hashes/IDs)

**Performance Test Matrix:**

| Test                     | Story | Load Profile                | Success Criteria        | Priority |
| ------------------------ | ----- | --------------------------- | ----------------------- | -------- |
| Vector search P95        | 1.5   | 1000 queries, 1000+ vectors | P95 <100ms              | Critical |
| Embedding generation     | 1.4   | 200 tool schemas            | Total time <2 minutes   | High     |
| Context optimization E2E | 1.6   | 50 queries, topK=5          | P95 <200ms, context <5% | Critical |
| MCP server discovery     | 1.3   | 15 concurrent connections   | All connected <10s      | High     |
| Database CRUD            | 1.2   | 1000 inserts, 10k queries   | P95 <50ms per operation | Medium   |

**Mocking Strategy:**

- **MCP Servers:** Mock stdio communication with predefined responses (fixtures/tool-schemas.json)
- **BGE Model:** Mock transformers.js inference for fast tests, use real model for accuracy
  validation
- **Filesystem:** Use Deno's `--unstable-fs` for in-memory filesystem (fast, isolated)
- **HuggingFace Hub:** Mock HTTP responses for model downloads (avoid network dependency)

**Continuous Integration (CI):**

```yaml
# .github/workflows/test.yml
name: Test Suite
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: denoland/setup-deno@v1
        with:
          deno-version: 2.5
      - run: deno task lint
      - run: deno task check
      - run: deno task test # Unit + integration (exclude E2E)
      - run: deno task bench # Run benchmarks, fail if targets missed
      - run: deno coverage coverage/ --lcov > coverage.lcov
      - uses: codecov/codecov-action@v3 # Upload coverage report
```

**Acceptance Criteria Validation Checklist:**

For each story, QA validates:

- [ ] All ACs pass automated tests (green CI)
- [ ] Performance targets met (benchmark tests)
- [ ] Manual UX review completed (console output, error messages)
- [ ] Security audit passed (no sensitive data leaks)
- [ ] Documentation updated (if applicable)
- [ ] Code review approved by senior developer

**Test Data:**

- **Tool Schemas:** 50 sample schemas covering diverse MCP servers (filesystem, database, github,
  slack, etc.)
- **Queries:** 100 test queries with ground-truth expected results for accuracy validation
- **Embeddings:** Pre-computed embeddings for test schemas (avoid model loading delay in tests)

**Edge Cases and Error Scenarios:**

| Scenario                                   | Test Coverage                                               | Story |
| ------------------------------------------ | ----------------------------------------------------------- | ----- |
| Empty database (first run)                 | Unit test: db.initialize() on fresh system                  | 1.2   |
| All MCP servers down                       | Integration test: Discovery returns empty, no crash         | 1.3   |
| Invalid tool schema (malformed JSON)       | Unit test: Graceful skip, log error                         | 1.3   |
| Query with no results (threshold too high) | Unit test: Return empty array, log warning                  | 1.5   |
| Disk full during migration                 | Integration test: Rollback, clean partial data              | 1.7   |
| Model download interrupted                 | Integration test: Retry with backoff, fail after 3 attempts | 1.4   |

**Success Metrics:**

- All 8 stories complete with 100% AC pass rate
- Test coverage >80% (target: 85%)
- All benchmark tests pass (P95 targets met)
- Zero critical bugs found in manual testing
- Privacy audit: No PII leakage detected

---

**Generated:** 2025-11-05 **Author:** BMad **Epic:** 1 - Project Foundation & Context Optimization
Engine **Status:** Draft → Ready for Review
