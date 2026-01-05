# Deployment Architecture

## Overview

Casys PML is designed as a **local-first** tool with no cloud dependencies for the MVP. The
architecture nevertheless supports evolution toward edge/cloud deployments.

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     USER MACHINE (Local-First)                       │
│                                                                     │
│  ┌─────────────────┐     ┌─────────────────┐     ┌───────────────┐ │
│  │  Claude Desktop │────►│   Casys PML    │────►│  MCP Servers  │ │
│  │  (Claude Code)  │     │    Gateway      │     │  (15+ types)  │ │
│  └─────────────────┘     └────────┬────────┘     └───────────────┘ │
│                                   │                                 │
│                          ┌────────▼────────┐                       │
│                          │    PGlite DB    │                       │
│                          │ ~/.pml/  │                       │
│                          └─────────────────┘                       │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Dashboard (Optional)                                        │   │
│  │  Fresh @ localhost:8080 ──SSE──► Gateway @ localhost:3001   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Deployment Modes

### Mode 1: CLI Binary (Production)

```bash
# Installation via deno install
deno install -Agf -n pml jsr:@pml/cli

# Direct usage
pml init     # MCP config migration
pml serve    # Start gateway
```

**Characteristics:**

- Single compiled binary (~50MB with Deno runtime)
- Zero external dependencies
- Portable between machines

### Mode 2: Development (Source)

```bash
# Clone + run from source
git clone https://github.com/casys-ai/casys-pml.git
cd casys-pml
deno task serve:playground
```

**Characteristics:**

- Hot reload with `deno task dev`
- Debug logs access
- Tests and benchmarks available

### Mode 3: Docker (Future)

```dockerfile
# Future: Dockerfile
FROM denoland/deno:2.5.0
WORKDIR /app
COPY . .
RUN deno cache src/main.ts
CMD ["deno", "run", "-A", "src/main.ts", "serve"]
```

---

## Supported Platforms

| Platform | Architecture  | Status           | Notes                      |
| -------- | ------------- | ---------------- | -------------------------- |
| macOS    | x64 (Intel)   | ✅ Tested        | Primary dev platform       |
| macOS    | ARM64 (M1/M2) | ✅ Tested        | Full support               |
| Linux    | x64           | ✅ Tested        | CI/CD environment          |
| Linux    | ARM64         | 🟡 Not tested    | Should work (Deno support) |
| Windows  | x64           | 🟡 Via WSL       | Native Deno possible       |
| Windows  | ARM64         | ❌ Not supported | Deno support limited       |

---

## System Requirements

### Minimum

| Resource | Value    | Justification                    |
| -------- | -------- | -------------------------------- |
| RAM      | 4 GB     | BGE-M3 model (~2GB) + HNSW index |
| Disk     | 1 GB     | Database + logs + model cache    |
| CPU      | 2 cores  | Parallel DAG execution           |
| Deno     | 2.2+ LTS | Minimum stable version           |

### Recommended

| Resource | Value    | Benefit                            |
| -------- | -------- | ---------------------------------- |
| RAM      | 8 GB     | Margin for multiple MCP servers    |
| Disk     | 5 GB     | Execution history, episodic memory |
| CPU      | 4+ cores | Better DAG parallelism             |
| Deno     | 2.5+     | Latest optimizations               |

---

## Runtime File Structure

```
~/.pml/                    # User data directory
├── config.yaml                   # User configuration
├── pml.db                 # PGlite database (single file)
├── logs/
│   └── pml.log            # Application logs (rotated)
├── cache/
│   ├── embeddings/               # Cached model weights
│   └── results/                  # Execution result cache
└── checkpoints/                  # Workflow checkpoints (resume)
```

---

## Inter-Process Communication

### Claude Desktop ↔ Casys PML

```
┌──────────────────┐          ┌──────────────────┐
│  Claude Desktop  │  stdio   │   Casys PML     │
│                  │◄────────►│   Gateway        │
│  (JSON-RPC)      │          │   (MCP Server)   │
└──────────────────┘          └──────────────────┘
```

**Protocol:** JSON-RPC 2.0 over stdio

- No network port exposed
- Bidirectional synchronous communication
- Timeout: 30s per request

### Casys PML ↔ MCP Servers

```
┌──────────────────┐          ┌──────────────────┐
│   Casys PML     │  stdio   │   MCP Server     │
│   Gateway        │◄────────►│   (filesystem)   │
│                  │          │   (github)       │
│                  │          │   (memory)       │
└──────────────────┘          └──────────────────┘
```

**Process Management:**

- `Deno.Command` for spawning
- Persistent connection pool
- Automatic restart on crash

### Dashboard ↔ Gateway

```
┌──────────────────┐   SSE    ┌──────────────────┐
│   Fresh Web      │◄─────────│   Casys PML     │
│   Dashboard      │   HTTP   │   Gateway        │
│   :8080          │─────────►│   :3001          │
└──────────────────┘          └──────────────────┘
```

**Protocol:**

- SSE (Server-Sent Events) for real-time streaming
- REST for commands (approve, abort, replan)
- WebSocket future option for bidirectional

---

## Observability

### Logs

```typescript
// Structured logging via @std/log
import { getLogger } from "@std/log";
const logger = getLogger();

logger.info("Tool call", {
  server: "filesystem",
  tool: "read_file",
  duration_ms: 42,
});
```

**Levels:** DEBUG, INFO, WARN, ERROR, CRITICAL

### Metrics (Future: Epic 6)

| Metric                      | Type      | Description              |
| --------------------------- | --------- | ------------------------ |
| `dag_execution_duration_ms` | Histogram | Workflow execution time  |
| `tool_call_latency_ms`      | Histogram | Latency per tool         |
| `speculation_success_rate`  | Gauge     | Speculation success rate |
| `context_usage_percent`     | Gauge     | % LLM context used       |

### Tracing (Sentry Optional)

```bash
# Enable Sentry tracing
SENTRY_DSN=https://...@sentry.io/...
SENTRY_TRACES_SAMPLE_RATE=0.1
```

---

## Scaling Considerations

### Horizontal Scaling (Out of Scope MVP)

Casys PML is single-instance by design (local state). For multi-instance:

```
Future: Shared PGlite via S3/GCS + PGlite-sync
       └── Requires: Connection pooling, conflict resolution
```

### Vertical Scaling

| Bottleneck       | Solution                         |
| ---------------- | -------------------------------- |
| RAM (embeddings) | Quantized models (future)        |
| CPU (DAG)        | Increase `maxConcurrency` config |
| Disk I/O         | SSD recommended, NVMe optimal    |

---

## Future Distribution

### Option 1: JSR Package

```bash
deno install -Agf jsr:@pml/cli
```

### Option 2: Homebrew

```bash
brew tap casys-ai/pml
brew install pml
```

### Option 3: npm (via deno compile)

```bash
npx @pml/cli serve
```

### Option 4: Deno Deploy (Edge)

```typescript
// Future: Worker mode for edge deployment
Deno.serve(caiHandler);
```

---

_References:_

- [Development Environment](./development-environment.md) - Developer setup
- [Performance Considerations](./performance-considerations.md) - Optimizations
