# MCP Libraries

This folder contains MCP-compatible libraries and their server bootstraps.

## Architecture

```
lib/
├── mcp-tools.ts              # Pure library (94 primitives)
├── mcp-tools-server.ts       # MCP server bootstrap
└── README.md                 # This file
```

**Separation of concerns:**
- `*-tools.ts` = Pure TypeScript library, no MCP protocol
- `*-server.ts` = MCP server bootstrap (stdio transport)

## Available Libraries

### mcp-tools (Primitives)

94 utility tools across 15 categories:

| Category | Count | Examples |
|----------|-------|----------|
| text | 8 | split, join, regex, case, template |
| json | 5 | parse, stringify, query, merge |
| math | 5 | eval, stats, round, random |
| datetime | 5 | now, format, diff, add, parse |
| crypto | 5 | hash, uuid, base64, hex |
| collections | 7 | map, filter, sort, unique, group |
| fs | 5 | read, write, list (virtual filesystem) |
| data | 5 | fake_name, fake_email, lorem |
| http | 4 | build_url, parse_url, headers |
| validation | 4 | email, url, json_schema, pattern |
| format | 5 | number, bytes, duration, slugify |
| transform | 6 | csv_parse, csv_stringify, xml |
| state | 6 | set, get, delete (KV store with TTL) |
| compare | 5 | diff, levenshtein, similarity, fuzzy |
| algo | 19 | binary_search, group_aggregate, top_n |

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
        "run", "--allow-all",
        "lib/mcp-tools-server.ts",
        "--categories=algo,compare,math"
      ]
    }
  }
}
```

### Option 2: Direct Import (TypeScript/Deno)

```typescript
import { MiniToolsClient, getDefaultMCPClients } from "./lib/mcp-tools.ts";

// All categories
const client = new MiniToolsClient();

// Specific categories only
const mathClient = new MiniToolsClient(["math", "algo", "compare"]);

// List available tools
const tools = await client.listTools();

// Call a tool
const result = await client.callTool("text_split", {
  text: "hello,world",
  separator: ","
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
        input: { type: "string", description: "Input value" }
      },
      required: ["input"]
    },
    handler: ({ input }) => {
      return { result: `Processed: ${input}` };
    }
  },
  // ... more tools
];

// Export client class
export class MyLibraryClient {
  async listTools() {
    return TOOLS.map(({ handler, ...tool }) => tool);
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const tool = TOOLS.find(t => t.name === name);
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

| | Primitives | Connectors |
|--|------------|------------|
| Config | None needed | API keys required |
| Network | Offline OK | Requires network |
| Side effects | Pure data transform | Real actions |
| Cost | Free | API calls = $ |
| Examples | text, algo, compare | github, slack, postgres |

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

## Future Libraries

Planned additions:
- `mcp-connectors.ts` - Curated list of external service connectors
- `mcp-analytics.ts` - Data analysis primitives
- `mcp-ai.ts` - AI/ML utility tools
