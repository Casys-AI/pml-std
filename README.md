# Casys PML

[![CI](https://github.com/casys-ai/casys-pml/workflows/CI/badge.svg)](https://github.com/casys-ai/casys-pml/actions)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Deno Version](https://img.shields.io/badge/deno-2.x-blue.svg)](https://deno.land)

**Procedural Memory Layer** — An open-source memory layer for AI agents. PML captures workflows and
crystallizes them into reusable skills.

## The Problem

MCP ecosystems have two critical issues:

1. **Context Saturation** — Tool schemas consume 30-50% of LLM context window
2. **Sequential Latency** — Multi-tool workflows run serially

## The Solution

PML exposes intelligent meta-tools instead of proxying all underlying tools:

| Tool           | Description                                             |
| -------------- | ------------------------------------------------------- |
| `pml:discover` | Semantic + graph hybrid search for tools & capabilities |
| `pml:execute`  | Execute workflows (intent-based or explicit DAG)        |

Context usage drops to <5%. Independent tasks run in parallel.

---

## Quick Start

```bash
git clone https://github.com/casys-ai/casys-pml.git
cd casys-pml
deno task dev         # API on :3003
deno task dev:fresh   # Dashboard on :8081
```

### Configure Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "pml": {
      "type": "http",
      "url": "http://localhost:3003/mcp"
    }
  }
}
```

---

## Key Features

- **Semantic Tool Search** — Find tools via natural language intent
- **DAG Execution** — Parallel execution with dependency resolution
- **Sandbox Execution** — Run TypeScript in isolated Deno sandbox
- **GraphRAG Discovery** — Hybrid search with Adamic-Adar algorithm
- **100% Local** — All embeddings (BGE-M3) and data stored locally

---

## Usage Examples

**Search for tools:**

```typescript
await callTool("pml:discover", {
  intent: "read and parse configuration files",
});
```

**Intent-based execution:**

```typescript
await callTool("pml:execute", {
  intent: "Read config.json and create a memory entity",
});
```

**Explicit DAG:**

```typescript
await callTool("pml:execute", {
  workflow: {
    tasks: [
      { id: "t1", tool: "filesystem:read_file", arguments: { path: "config.json" } },
      { id: "t2", tool: "memory:create_entities", arguments: { ... }, depends_on: ["t1"] }
    ]
  }
});
```

---

## Development

```bash
deno task dev              # Start API server
deno task dev:fresh        # Start dashboard
deno task test             # Run tests
deno task check            # Type checking
deno task lint && deno task fmt  # Code quality
```

---

## Documentation

- **[Architecture](docs/architecture/)** — System design and patterns
- **[ADRs](docs/adrs/)** — Architecture decision records
- **[User Guide](docs/user-docs/)** — Getting started guides

---

## Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Make changes and test: `deno task test`
4. Format: `deno task fmt && deno task lint`
5. Open a Pull Request

---

## License

**AGPL-3.0** — See [LICENSE](LICENSE)

---

[Report Bug](https://github.com/casys-ai/casys-pml/issues) |
[Request Feature](https://github.com/casys-ai/casys-pml/issues) | [Documentation](docs/)
