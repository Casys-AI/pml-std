# PML Standard Library

MCP-compatible utility tools for [PML](https://pml.casys.ai) - Procedural Memory Layer.

**318+ tools** across 21 categories for text processing, data transformation, cryptography, and more.

| | |
|---|---|
| **Website** | https://pml.casys.ai |
| **Docs** | https://docs.pml.casys.ai |
| **GitHub** | https://github.com/Casys-AI/pml-std |
| **Releases** | https://github.com/Casys-AI/pml-std/releases |

## Quick Install

```bash
curl -fsSL https://github.com/Casys-AI/pml-std/releases/latest/download/install.sh | sh
```

## Architecture

```
lib/
├── std/                      # Standard library (~305 tools)
│   ├── mod.ts                # Main entry point
│   ├── text.ts, json.ts, ... # Tool modules by category
│   ├── system.ts             # System CLI tools (docker, git, kubectl, etc.)
│   └── bundle.js             # Pre-bundled for sandbox use
├── mcp-tools.ts              # Re-exports from std/
├── mcp-tools-server.ts       # MCP server bootstrap
└── README.md                 # This file
```

**Separation of concerns:**

- `std/` = Pure TypeScript library, no MCP protocol
- `*-server.ts` = MCP server bootstrap (stdio transport)

## Available Libraries

### std (Standard Library)

**~318 utility tools across 21 categories**, inspired by popular MCP tool servers:

#### Sources & Credits

This library is inspired by and includes tools from the following open-source MCP servers:

| Source              | URL                                           | Tools Used                                                                                           |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **IT-Tools MCP**    | https://github.com/wrenchpilot/it-tools-mcp   | color, network, util, crypto (jwt, ulid, hmac, totp), datetime (cron, unix), format (yaml, markdown) |
| **TextToolkit MCP** | https://github.com/Cicatriiz/text-toolkit     | text (regex, lorem, slugify, nato, diff, stats)                                                      |
| **Math MCP**        | https://github.com/EthanHenrickson/math-mcp   | math (mode, convert)                                                                                 |
| **JSON MCP**        | https://github.com/VadimNastoyashchy/json-mcp | json (flatten, unflatten, pick, omit)                                                                |

#### Categories

| Category    | Count | Examples                                                                                                                                                                                                                                              |
| ----------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **system**  | 71    | docker, git, curl, dig, ping, ps, tar, zip, ssh, rsync, kubectl, sqlite, psql, redis, ffmpeg, imagemagick, npm, pip, aws, gcloud, chmod, df, du, sed, awk, jq                                                                                         |
| **agent**   | 8     | delegate, decide, analyze, extract, classify, summarize, generate, compare (LLM-powered via MCP sampling)                                                                                                                                             |
| **python**  | 5     | exec, eval, pip, script, version (Python execution in isolated subprocess)                                                                                                                                                                            |
| text        | 26    | split, join, regex, case, template, slugify, nato, lorem, diff, stats, crontab, markdown_toc, ascii_art, numeronym, obfuscate, emoji_search, unicode_info, homoglyph, analyze_words, list_convert                                                     |
| format      | 25    | number, bytes, duration, truncate, yaml_to_json, json_to_yaml, toml_to_json, json_to_toml, markdown_to_html, html_to_markdown, json_to_csv, format_sql, format_phone, xml_escape, properties, format_html, format_javascript, format_xml, format_yaml |
| crypto      | 20    | hash, uuid, ulid, base64, hex, url, html, password, jwt_decode, hmac, totp, text_to_binary, generate_token, basic_auth, bcrypt, bip39, md5                                                                                                            |
| collections | 20    | map, filter, sort, unique, group, chunk, zip, flatten, partition, sample                                                                                                                                                                              |
| algo        | 20    | binary_search, group_aggregate, top_n, sort variants, quickselect                                                                                                                                                                                     |
| math        | 17    | eval, stats, round, random, mode, convert, base_convert, roman, convert_angle, convert_energy, convert_power, convert_temperature, percentage, convert_units, financial                                                                               |
| data        | 11    | person, address, company, lorem, internet, finance, date, image, svg_placeholder, qr_code, barcode                                                                                                                                                    |
| network     | 11    | parse_url, build_url, ip_info, ipv6_info, subnet_calc, mac_format, fang_url, decode_safelink, generate_mac, generate_ipv6_ula, random_port                                                                                                            |
| util        | 11    | http_status, mime_type, mime_reverse, rem_px, format_css, normalize_email, port_numbers, file_signature, user_agent_parse, slugify                                                                                                                    |
| validation  | 11    | email, url, uuid, ip, phone, date, json, schema, credit_card, iban                                                                                                                                                                                    |
| state       | 10    | set, get, delete, has, keys, values, clear, size, entries (KV store with TTL)                                                                                                                                                                         |
| json        | 10    | parse, stringify, query, merge, flatten, unflatten, pick, omit, keys, compare                                                                                                                                                                         |
| vfs         | 8     | read, write, list, mkdir, rm, stat, exists, copy                                                                                                                                                                                                      |
| transform   | 8     | csv_parse, csv_stringify, xml_parse, xml_stringify                                                                                                                                                                                                    |
| datetime    | 7     | now, format, diff, add, parse, cron_parse, unix                                                                                                                                                                                                       |
| color       | 7     | hex_to_rgb, rgb_to_hex, rgb_to_hsl, hsl_to_rgb, palette, blend, contrast                                                                                                                                                                              |
| http        | 6     | build_url, parse_url, headers, query_string                                                                                                                                                                                                           |
| compare     | 6     | diff, levenshtein, similarity, fuzzy, deep_equal, array_diff                                                                                                                                                                                          |

## Usage

### Option 1: As MCP Server (via mcp-servers.json)

Add to your `mcp-servers.json`:

```json
{
  "mcpServers": {
    "primitives": {
      "command": "deno",
      "args": ["run", "--allow-all", "lib/mcp-tools-server.ts"]
    }
  }
}
```

With category filtering (load only specific categories):

```json
{
  "mcpServers": {
    "algo-tools": {
      "command": "deno",
      "args": [
        "run",
        "--allow-all",
        "lib/mcp-tools-server.ts",
        "--categories=algo,compare,math"
      ]
    }
  }
}
```

### Option 2: Direct Import (TypeScript/Deno)

```typescript
import { getDefaultMCPClients, MiniToolsClient } from "./lib/mcp-tools.ts";

// All categories
const client = new MiniToolsClient();

// Specific categories only
const mathClient = new MiniToolsClient(["math", "algo", "compare"]);

// List available tools
const tools = await client.listTools();

// Call a tool
const result = await client.callTool("text_split", {
  text: "hello,world",
  separator: ",",
});
```

## Adding a New Library

### Step 1: Create the Pure Library

Create `lib/my-library.ts`:

```typescript
/**
 * My Library
 * @module lib/my-library
 */

// Define your tools
const TOOLS = [
  {
    name: "my_tool",
    description: "Does something useful",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Input value" },
      },
      required: ["input"],
    },
    handler: ({ input }) => {
      return { result: `Processed: ${input}` };
    },
  },
  // ... more tools
];

// Export client class
export class MyLibraryClient {
  async listTools() {
    return TOOLS.map(({ handler, ...tool }) => tool);
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(args);
  }
}
```

### Step 2: Create the MCP Server Bootstrap

Create `lib/my-library-server.ts`:

```typescript
/**
 * MCP Server Bootstrap for My Library
 * @module lib/my-library-server
 */

import { MyLibraryClient } from "./my-library.ts";

// Copy the MCPServer class from mcp-tools-server.ts
// Replace MiniToolsClient with MyLibraryClient

class MCPServer {
  private client: MyLibraryClient;

  constructor() {
    this.client = new MyLibraryClient();
  }

  // ... same handleRequest, dispatch, etc.
}

// ... same stdio transport code
// ... same main() function
```

### Step 3: Add to mcp-servers.json

```json
{
  "mcpServers": {
    "my-library": {
      "command": "deno",
      "args": ["run", "--allow-all", "lib/my-library-server.ts"]
    }
  }
}
```

## Primitives vs Connectors

|              | Primitives          | Connectors              |
| ------------ | ------------------- | ----------------------- |
| Config       | None needed         | API keys required       |
| Network      | Offline OK          | Requires network        |
| Side effects | Pure data transform | Real actions            |
| Cost         | Free                | API calls = $           |
| Examples     | text, algo, compare | github, slack, postgres |

**Primitives** (this library): Zero config, pure data manipulation, safe for learning.

**Connectors** (external MCPs): Need `env` config in mcp-servers.json:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

## Testing

Run the server manually to test:

```bash
# Start server
deno run --allow-all lib/mcp-tools-server.ts

# Send a request (in another terminal, or pipe)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | deno run --allow-all lib/mcp-tools-server.ts

# List tools
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | ...

# Call a tool
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"text_split","arguments":{"text":"a,b,c","separator":","}}}' | ...
```

## Agent Tools & MCP Sampling

The **agent** category provides LLM-powered tools using MCP Sampling (SEP-1577, Nov 2025).

### How it works

1. Agent tools call `samplingClient.createMessage()` with a prompt
2. The MCP client (Claude Code, Gateway) receives `sampling/createMessage`
3. The CLIENT handles the agentic loop and tool execution
4. Results are returned to the server

### Transport-specific setup

| Mode                     | Sampling Handler                 | Status             |
| ------------------------ | -------------------------------- | ------------------ |
| **Claude Code** (stdio)  | Built into `mcp-tools-server.ts` | ✅ Ready           |
| **Cloud/Gateway** (HTTP) | TODO: Implement in Gateway       | ⚠️ Not implemented |

**Cloud mode TODO:** When implementing cloud deployment, the Gateway must:

1. Handle `sampling/createMessage` requests from the MCP server
2. Route to configured LLM API (Anthropic, OpenAI, etc.)
3. Execute the agentic loop with tool filtering
4. Return results to the MCP server

See: `docs/tech-specs/tech-spec-mcp-agent-nodes.md` for architecture details.

## Python Execution

The **python** category enables running Python code in isolated subprocesses.

### Tools

| Tool             | Description                               |
| ---------------- | ----------------------------------------- |
| `python_exec`    | Execute Python code, return stdout/stderr |
| `python_eval`    | Evaluate expression, return JSON result   |
| `python_pip`     | Install pip packages                      |
| `python_script`  | Run a Python script file                  |
| `python_version` | Get Python installation info              |

### Requirements

- **Python 3.8+** required (validated at runtime)
- Override with `PYTHON_PATH` env var if needed

### Security

- Runs in **subprocess** (not FFI) - no access to parent process memory
- Configurable **timeout** (default 30s)
- No sandbox bypass - isolated from Deno runtime

### Example

```typescript
// In generated code
const result = await mcp.python.exec({
  code: `
import pandas as pd
df = pd.read_csv('data.csv')
print(df.describe().to_json())
  `,
  timeout: 60000,
});
```

## Future Libraries

Planned additions:

- `mcp-connectors.ts` - Curated list of external service connectors
- `mcp-analytics.ts` - Data analysis primitives
- `mcp-ai.ts` - AI/ML utility tools
