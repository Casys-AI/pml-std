# ADR-009: JSON Configuration Format for MCP Ecosystem Alignment

**Status:** ✅ Implemented **Date:** 2025-11-18 | **Author:** BMad

---

## Context

Casys PML acts as an MCP (Model Context Protocol) gateway that consolidates multiple MCP servers.
The current implementation uses YAML for configuration files (`~/.pml/config.yaml`), while the
entire MCP ecosystem standardizes on JSON:

**MCP Ecosystem Format:**

- Claude Desktop config: `claude_desktop_config.json` (JSON)
- MCP server configurations: JSON
- MCP Protocol: JSON-RPC
- Official MCP documentation examples: JSON
- MCP SDK types: JSON schemas

**Current Casys PML Format:**

- Configuration: `~/.pml/config.yaml` (YAML)
- Creates friction: users must convert between formats
- No direct reuse of existing MCP configurations

**Problem Statement:** The YAML configuration format creates unnecessary friction for users who
already have MCP servers configured in Claude Desktop (JSON format). Users must:

1. Maintain two different config formats (JSON for Claude Desktop, YAML for Casys PML)
2. Manually convert MCP server definitions from JSON → YAML
3. Learn YAML syntax when they're already familiar with JSON from MCP ecosystem

This violates the principle of least surprise and creates onboarding friction.

---

## Decision

**Adopt JSON as the primary configuration format for Casys PML**, with temporary backward
compatibility for YAML during migration period.

**Configuration file:** `~/.pml/config.json` (was: `config.yaml`)

**Migration Strategy:**

1. **Support both formats** (auto-detection by file extension)
2. **Default to JSON** for all new configurations
3. **Deprecate YAML** with migration path
4. **Provide migration tool:** `./pml migrate-config`

---

## Rationale

### Alignment with MCP Ecosystem

**1. Seamless Integration with Claude Desktop**

Users can directly copy MCP server configurations from Claude Desktop:

**Before (YAML - friction):**

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

→ User must convert to YAML:

```yaml
# ~/.pml/config.yaml
mcpServers:
  - id: filesystem
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - /tmp
```

**After (JSON - seamless):**

```json
// ~/.pml/config.json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  },
  "context": {
    "topK": 10,
    "similarityThreshold": 0.7
  }
}
```

Direct copy-paste from Claude Desktop config. Zero conversion needed.

### 2. Native Deno Support

Deno has first-class JSON support with zero dependencies:

```typescript
// JSON (native)
const config = JSON.parse(await Deno.readTextFile("config.json"));

// YAML (requires dependency)
import { parse } from "@std/yaml";
const config = parse(await Deno.readTextFile("config.yaml"));
```

Removing YAML dependency:

- ✅ Reduces bundle size
- ✅ Faster parsing (native JSON.parse)
- ✅ Zero external dependencies for config
- ✅ Better security (no YAML parsing vulnerabilities)

### 3. JSON Schema Validation

JSON enables first-class schema validation with JSON Schema:

```json
{
  "$schema": "https://pml.dev/config.schema.json",
  "mcpServers": { ... }
}
```

Benefits:

- ✅ IDE autocomplete (VSCode, Zed, etc.)
- ✅ Real-time validation errors
- ✅ Type safety for configuration
- ✅ Documentation embedded in schema

### 4. Consistency with MCP Protocol

MCP Protocol itself uses JSON-RPC:

- Request: `{ "method": "tools/list", "params": {...} }` (JSON)
- Response: `{ "result": {...} }` (JSON)
- Tool schemas: JSON Schema

Using JSON for configuration maintains consistency across the entire stack:

```
User Config (JSON) → Casys PML (JSON) → MCP Protocol (JSON-RPC) → MCP Servers (JSON)
```

### 5. Ecosystem Familiarity

Developers working with MCP are already familiar with JSON:

- All MCP examples use JSON
- MCP SDK documentation uses JSON
- Claude Desktop config is JSON
- Industry standard for API configs

Switching to YAML creates cognitive load without tangible benefits.

---

## Alternatives Considered

### Alternative 1: Keep YAML Only

**Rejected:** Creates friction with MCP ecosystem, requires conversion, adds dependency.

### Alternative 2: Support Both YAML and JSON Indefinitely

**Rejected:** Maintenance burden, confusion about which format to use, splits community.

**Why not keep both?**

- Two parsers to maintain
- Two formats in documentation (confusing)
- Users don't know which to choose
- Testing complexity doubles

### Alternative 3: JSON5/JSONC (JSON with Comments)

**Considered but deferred:**

JSON5 adds:

- Comments: `// comment` and `/* comment */`
- Trailing commas: `{ "a": 1, }`
- Unquoted keys: `{ key: "value" }`

**Pros:**

- More readable than strict JSON
- Comments for documentation
- Closer to JavaScript syntax

**Cons:**

- Not standard JSON (requires special parser)
- VSCode supports JSONC natively, but JSON5 less so
- MCP ecosystem uses strict JSON

**Decision:** Start with strict JSON for maximum compatibility. Can add JSONC/JSON5 support later if
user demand emerges.

### Alternative 4: TOML

**Rejected:**

- Not used in MCP ecosystem
- Less familiar to MCP developers
- Adds another format to the mix

---

## Implementation

### Phase 1: Dual Format Support (Immediate)

**Auto-detection by file extension:**

```typescript
async function loadConfig(configPath?: string): Promise<Config> {
  // 1. Determine config file
  const path = configPath ?? await findConfigFile();

  // 2. Auto-detect format
  if (path.endsWith(".json")) {
    const content = await Deno.readTextFile(path);
    return JSON.parse(content);
  }

  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    const content = await Deno.readTextFile(path);
    return YAML.parse(content);
  }

  throw new Error(`Unsupported config format: ${path}`);
}

async function findConfigFile(): Promise<string> {
  // Prefer JSON, fallback to YAML
  const jsonPath = `${HOME}/.pml/config.json`;
  const yamlPath = `${HOME}/.pml/config.yaml`;

  try {
    await Deno.stat(jsonPath);
    return jsonPath;
  } catch {
    try {
      await Deno.stat(yamlPath);
      console.warn("⚠️  YAML config detected. JSON is now recommended for MCP compatibility.");
      console.warn("    Run: ./pml migrate-config");
      return yamlPath;
    } catch {
      throw new Error("No config file found");
    }
  }
}
```

### Phase 2: Migration Tool

**Command:** `./pml migrate-config`

```typescript
async function migrateConfig() {
  const yamlPath = `${HOME}/.pml/config.yaml`;
  const jsonPath = `${HOME}/.pml/config.json`;

  // 1. Check if YAML exists
  if (!await exists(yamlPath)) {
    console.log("No YAML config found. Nothing to migrate.");
    return;
  }

  // 2. Check if JSON already exists
  if (await exists(jsonPath)) {
    const overwrite = confirm("JSON config already exists. Overwrite?");
    if (!overwrite) return;
  }

  // 3. Load YAML
  const yamlConfig = YAML.parse(await Deno.readTextFile(yamlPath));

  // 4. Write JSON (pretty-printed)
  await Deno.writeTextFile(
    jsonPath,
    JSON.stringify(yamlConfig, null, 2),
  );

  console.log("✓ Config migrated to JSON");
  console.log(`  Old: ${yamlPath}`);
  console.log(`  New: ${jsonPath}`);
  console.log("\nYou can now delete the YAML file:");
  console.log(`  rm ${yamlPath}`);
}
```

### Phase 3: Default to JSON

**All `init` commands generate JSON:**

```typescript
async function initConfig(mcpServers: MCPServer[]) {
  const config = {
    mcpServers: mcpServers.map((s) => ({
      id: s.id,
      command: s.command,
      args: s.args,
    })),
    context: {
      topK: 10,
      similarityThreshold: 0.7,
    },
    execution: {
      maxConcurrency: 10,
      timeout: 30000,
    },
  };

  // Write JSON (not YAML)
  const configPath = `${HOME}/.pml/config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify(config, null, 2),
  );

  console.log(`✓ Config created: ${configPath}`);
}
```

### Phase 4: YAML Deprecation (Future)

**Timeline:** 3-6 months after JSON adoption

1. **Warning on YAML load:**
   ```
   ⚠️  WARNING: YAML config support will be removed in v2.0
       Please migrate to JSON: ./pml migrate-config
   ```

2. **Documentation updates:**
   - Remove all YAML examples
   - Show only JSON in README
   - Add migration guide

3. **Version 2.0: Remove YAML support**
   - Delete YAML parser dependency
   - Remove YAML loading code
   - Breaking change documented in changelog

---

## Configuration Schema

**JSON Schema for validation:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Casys PML Configuration",
  "type": "object",
  "required": ["mcpServers"],
  "properties": {
    "mcpServers": {
      "type": "object",
      "description": "MCP servers to connect to",
      "additionalProperties": {
        "type": "object",
        "required": ["command"],
        "properties": {
          "command": { "type": "string" },
          "args": {
            "type": "array",
            "items": { "type": "string" }
          },
          "env": {
            "type": "object",
            "additionalProperties": { "type": "string" }
          }
        }
      }
    },
    "context": {
      "type": "object",
      "properties": {
        "topK": {
          "type": "number",
          "minimum": 1,
          "default": 10
        },
        "similarityThreshold": {
          "type": "number",
          "minimum": 0,
          "maximum": 1,
          "default": 0.7
        }
      }
    },
    "execution": {
      "type": "object",
      "properties": {
        "maxConcurrency": {
          "type": "number",
          "minimum": 1,
          "default": 10
        },
        "timeout": {
          "type": "number",
          "minimum": 1000,
          "default": 30000
        }
      }
    }
  }
}
```

---

## Consequences

### Positive

1. **✅ Seamless MCP Integration**
   - Direct copy-paste from Claude Desktop config
   - Zero format conversion needed
   - Consistent with MCP ecosystem

2. **✅ Reduced Dependencies**
   - Remove YAML parser (@std/yaml)
   - Native JSON.parse (faster, smaller bundle)

3. **✅ Better IDE Support**
   - JSON Schema autocomplete
   - Real-time validation
   - Inline documentation

4. **✅ Simpler Onboarding**
   - Users already know JSON from MCP
   - No new syntax to learn
   - Familiar format

5. **✅ Type Safety**
   - JSON Schema validation
   - Compile-time checking
   - Runtime validation

### Negative

1. **⚠️ Breaking Change for Existing Users**
   - Users with YAML configs must migrate
   - **Mitigation:** Migration tool + backward compat period

2. **⚠️ Less Readable Than YAML**
   - JSON requires quotes everywhere
   - No native comments
   - **Mitigation:** Consider JSONC later if users request

3. **⚠️ Migration Effort**
   - Update documentation
   - Update examples
   - Support dual formats temporarily
   - **Mitigation:** Automated migration tool

### Neutral

1. **Parsing Performance**
   - JSON.parse is faster than YAML
   - Config only parsed once at startup
   - Negligible impact either way

---

## Migration Path

### For Users

**Step 1: Auto-migration on next run**

```bash
# Casys PML detects YAML and prompts
./pml serve

# Output:
# ⚠️  YAML config detected: ~/.pml/config.yaml
#     Casys PML now uses JSON for MCP compatibility.
#     Migrate now? (Y/n): y
#
# ✓ Config migrated to: ~/.pml/config.json
# You can delete the old YAML file:
#   rm ~/.pml/config.yaml
```

**Step 2: Manual migration**

```bash
./pml migrate-config
```

**Step 3: New users**

```bash
./pml init  # → generates config.json (not YAML)
```

### For Developers

**Timeline:**

| Phase       | Duration     | Action                        |
| ----------- | ------------ | ----------------------------- |
| **Phase 1** | Week 1       | Implement dual format support |
| **Phase 2** | Week 1       | Add migration tool            |
| **Phase 3** | Week 2       | Update all docs to JSON       |
| **Phase 4** | Months 1-3   | Deprecation warnings          |
| **Phase 5** | v2.0 release | Remove YAML support           |

**Backward Compatibility Window:** 3-6 months

---

## Success Metrics

1. **User Friction Reduced**
   - Measure: Time to configure Casys PML (before/after)
   - Target: <2 minutes (was: 5-10 minutes with YAML conversion)

2. **Support Questions Reduced**
   - Measure: Config-related issues in GitHub
   - Target: 50% reduction in config questions

3. **Adoption Rate**
   - Measure: % of users migrated to JSON after 3 months
   - Target: >90% migration

4. **Zero Regression**
   - Measure: All existing tests pass
   - Target: 100% test pass rate

---

## References

- **MCP Protocol Specification:** https://spec.modelcontextprotocol.io/
- **Claude Desktop Config:** `~/.config/Claude/claude_desktop_config.json`
- **JSON Schema:** http://json-schema.org/
- **ADR-001 (MCP Gateway Architecture):** Referenced MCP ecosystem alignment
- **User Feedback:** GitHub Issue #XX (YAML confusion)

---

## Related ADRs

- **ADR-001:** MCP Gateway Architecture (chose MCP protocol → implies JSON)
- **ADR-007:** DAG Adaptive Feedback Loops (uses JSON for checkpoint serialization)
- **ADR-008:** Episodic Memory (uses JSON for telemetry logging)

Pattern: Casys PML consistently uses JSON for data serialization. Configuration should follow the
same pattern.

---

## Appendix: Example Configurations

### Before (YAML)

```yaml
# ~/.pml/config.yaml
mcpServers:
  - id: filesystem
    name: Filesystem Server
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - /tmp

  - id: github
    name: GitHub Server
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-github"
    env:
      GITHUB_TOKEN: ${GITHUB_TOKEN}

context:
  topK: 10
  similarityThreshold: 0.7

execution:
  maxConcurrency: 10
  timeout: 30000
```

### After (JSON)

```json
{
  "$schema": "https://pml.dev/config.schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  },
  "context": {
    "topK": 10,
    "similarityThreshold": 0.7
  },
  "execution": {
    "maxConcurrency": 10,
    "timeout": 30000
  }
}
```

**Key Difference:** JSON format matches Claude Desktop exactly. Zero conversion needed.

---

**Decision:** APPROVED **Implementation:** Immediate (Phase 1-3), with 3-6 month deprecation window
for YAML **Review Date:** 2025-05-01 (reassess YAML usage, consider full removal in v2.0)
