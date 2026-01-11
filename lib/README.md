# PML Standard Library (MiniTools)

The official MCP-compatible utility library for [PML](https://pml.casys.ai) - Procedural Memory Layer.

**318+ tools across 21 categories** for text processing, data transformation, cryptography, and more.

## Links

- **Website:** https://pml.casys.ai
- **Documentation:** https://docs.pml.casys.ai
- **GitHub:** https://github.com/Casys-AI/pml-std
- **CLI Download:** https://github.com/Casys-AI/pml-std/releases

## Quick Install

```bash
curl -fsSL https://github.com/Casys-AI/pml-std/releases/latest/download/install.sh | sh
```

## Categories

| Category | Count | Description |
|----------|-------|-------------|
| **system** | 71 | docker, git, curl, kubectl, psql, ffmpeg, aws, gcloud... |
| **text** | 26 | split, join, regex, case, template, slugify, lorem... |
| **format** | 25 | yaml, json, toml, markdown, csv, sql formatting... |
| **crypto** | 20 | hash, uuid, base64, jwt, hmac, totp, bcrypt... |
| **collections** | 20 | map, filter, sort, unique, group, chunk, zip... |
| **algo** | 20 | binary_search, top_n, quickselect, sort variants... |
| **math** | 17 | eval, stats, round, convert, roman numerals... |
| **data** | 11 | faker data: person, address, company, lorem... |
| **network** | 11 | parse_url, ip_info, subnet_calc, mac_format... |
| **validation** | 11 | email, url, uuid, ip, phone, credit_card, iban... |
| **util** | 11 | http_status, mime_type, user_agent_parse... |
| **state** | 10 | KV store with TTL: set, get, delete, keys... |
| **json** | 10 | parse, query, merge, flatten, pick, omit... |
| **vfs** | 8 | virtual filesystem: read, write, list, mkdir... |
| **transform** | 8 | csv_parse, xml_parse, csv_stringify... |
| **datetime** | 7 | now, format, diff, add, cron_parse, unix... |
| **color** | 7 | hex_to_rgb, rgb_to_hsl, palette, blend... |
| **http** | 6 | build_url, parse_url, headers, query_string... |
| **compare** | 6 | diff, levenshtein, similarity, fuzzy_match... |
| **agent** | 8 | LLM-powered: delegate, analyze, classify... |
| **python** | 5 | exec, eval, pip, script (isolated subprocess) |

## Usage

### With PML CLI

```bash
# Initialize PML in your project
pml init

# Start MCP server
pml stdio
```

### Direct Import (Deno/TypeScript)

```typescript
import { tools } from "jsr:@casys/pml-std";

// Use any tool
const result = tools.text_split({ text: "a,b,c", separator: "," });
// => ["a", "b", "c"]
```

### As MCP Server

```json
{
  "mcpServers": {
    "pml-std": {
      "command": "deno",
      "args": ["run", "-A", "jsr:@casys/pml-std/server"]
    }
  }
}
```

## Credits

Inspired by and includes tools from:
- [IT-Tools MCP](https://github.com/wrenchpilot/it-tools-mcp)
- [TextToolkit MCP](https://github.com/Cicatriiz/text-toolkit)
- [Math MCP](https://github.com/EthanHenrickson/math-mcp)
- [JSON MCP](https://github.com/VadimNastoyashchy/json-mcp)

## License

MIT - See [LICENSE](../LICENSE)
