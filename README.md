# MCP Standard Library

A collection of **318+ MCP tools** for text processing, data transformation, cryptography, and more.

Works with any MCP client: Claude Code, Claude Desktop, Cursor, etc.

## Installation

### With Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "std": {
      "command": "deno",
      "args": ["run", "-A", "jsr:@casys/mcp-std/server"]
    }
  }
}
```

### With specific categories only

```json
{
  "mcpServers": {
    "std": {
      "command": "deno",
      "args": ["run", "-A", "jsr:@casys/mcp-std/server", "--categories=text,json,math"]
    }
  }
}
```

## Categories

### System Tools

| Category | Description | Examples |
|----------|-------------|----------|
| docker | Container management | build, run, ps, logs, compose |
| git | Repository operations | status, diff, log, commit, branch |
| process | Process management | exec, spawn, kill, ps |
| archive | Compression | tar, zip, gzip, unzip |
| ssh | Remote execution | exec, scp, tunnel |
| kubernetes | K8s cluster management | get, apply, delete, logs |
| database | SQL/NoSQL access | psql, sqlite, redis |
| pglite | Embedded PostgreSQL | query, exec (in-process PG) |
| media | Audio/video/image | ffmpeg, imagemagick |
| cloud | Cloud providers | aws, gcloud, systemd |
| sysinfo | System information | cpu, memory, disk, network |
| packages | Package managers | npm, pip, apt, brew |

### Data Tools

| Category | Description | Examples |
|----------|-------------|----------|
| text | Text manipulation | split, join, regex, case, template, slugify |
| string | String utilities | trim, pad, truncate, wrap |
| json | JSON operations | parse, query, merge, flatten, pick |
| format | Formatting | number, bytes, yaml, toml, markdown, sql |
| transform | Data conversion | csv_parse, xml_parse, csv_stringify |
| crypto | Cryptography | hash, uuid, base64, jwt, hmac, totp, bcrypt |
| math | Mathematical ops | eval, stats, round, convert, roman |
| datetime | Date/time | now, format, diff, add, cron_parse |
| collections | Array/set/map | map, filter, sort, unique, group, chunk |
| algo | Algorithms | binary_search, top_n, quickselect, sort |
| validation | Data validation | email, url, uuid, ip, phone, credit_card |
| compare | Comparison | levenshtein, similarity, fuzzy, deep_equal |
| diff | Text diff | unified_diff, patch, compare_lines |

### Utility Tools

| Category | Description | Examples |
|----------|-------------|----------|
| network | Network utilities | parse_url, ip_info, subnet_calc, dns |
| http | HTTP helpers | build_url, headers, query_string |
| path | Path utilities | join, dirname, basename, resolve |
| color | Color manipulation | hex_to_rgb, rgb_to_hsl, palette, blend |
| vfs | Virtual filesystem | read, write, list, mkdir, rm |
| state | KV store with TTL | set, get, delete, keys, values |
| util | General utilities | http_status, mime_type, user_agent |

### Generation Tools

| Category | Description | Examples |
|----------|-------------|----------|
| faker | Mock data | person, address, company, lorem |
| data | Data generation | image, svg, qr_code, barcode |
| qrcode | QR/barcode | generate, decode, svg |
| geo | Geographic | distance, bearing, bbox, geocode |
| schema | Schema inference | infer, validate, generate |
| resilience | Reliability | retry, rate_limit, circuit_breaker |

### Scripting Tools

| Category | Description | Examples |
|----------|-------------|----------|
| python | Python execution | exec, eval, pip, script |
| agent | LLM-powered | delegate, analyze, classify, summarize |

> **Note:** The `agent` category requires [MCP Sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling). Use with [PML](https://pml.casys.ai) which handles sampling server-side, or a client that supports sampling (VS Code Copilot). Claude Code doesn't support sampling yet ([tracking issue](https://github.com/anthropics/claude-code/issues/1785)).

## TypeScript Usage

```typescript
import { MiniToolsClient } from "jsr:@casys/mcp-std";

const client = new MiniToolsClient();

// List all tools
const tools = await client.listTools();

// Call a tool
const result = await client.callTool("text_split", {
  text: "hello,world",
  separator: ","
});
```

## Credits

This library includes tools inspired by:

| Source | URL |
|--------|-----|
| IT-Tools MCP | https://github.com/wrenchpilot/it-tools-mcp |
| TextToolkit MCP | https://github.com/Cicatriiz/text-toolkit |
| Math MCP | https://github.com/EthanHenrickson/math-mcp |
| JSON MCP | https://github.com/VadimNastoyashchy/json-mcp |

## License

MIT
