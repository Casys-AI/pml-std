# ADR-021: Configurable Database Path via Environment Variable

**Status:** ✅ Implemented **Date:** 2025-12-01 | **Story:** 1.3 (Workflow Templates)

---

## Context and Problem Statement

Casys PML stores its PGlite database in a hardcoded location: `~/.pml/.pml.db` (user home
directory).

**Problem:** In ephemeral environments like **GitHub Codespaces**, the home directory
(`/home/ubuntu/`) is **not persisted** between sessions. Only the workspace directory
(`/workspaces/<project>/`) is persisted.

This causes:

- ❌ Database loss on Codespace restart
- ❌ Loss of synced workflow templates
- ❌ Need to re-initialize on every session
- ❌ Poor experience for playground users

**Discovered during:** Story 1.3 implementation when testing workflow sync in Codespace environment.

---

## Decision Drivers

1. **Playground UX:** Educational playground needs persistent data across Codespace sessions
2. **Developer Experience:** Local development should continue to work seamlessly
3. **Testing Flexibility:** Isolated test databases for parallel testing
4. **Backwards Compatibility:** Existing users should not be affected
5. **Minimal Code Changes:** Low-risk, surgical modification

---

## Considered Options

### Option 1: ✅ Environment Variable (CHOSEN)

**Implementation:** Add `PML_DB_PATH` env var support to `getCasys PMLDatabasePath()`

**Pros:**

- ✅ Simple implementation (5 lines of code)
- ✅ Zero breaking changes (default behavior unchanged)
- ✅ Flexible for all use cases (Codespace, testing, custom deployments)
- ✅ Standard pattern (Docker, many CLI tools use this)
- ✅ Easy to configure in `.devcontainer.json`

**Cons:**

- ⚠️ Requires documentation
- ⚠️ Users must set env var manually (but Story 1.5 will automate)

### Option 2: Config File Option

**Implementation:** Add `database.path` to `~/.pml/config.json`

**Pros:**

- ✅ Persistent configuration
- ✅ User-friendly for non-technical users

**Cons:**

- ❌ Config file is also in `~/.pml/` (same persistence problem!)
- ❌ Chicken-and-egg: Can't read config if DB path is in config
- ❌ More complex implementation

### Option 3: Automatic Detection

**Implementation:** Auto-detect Codespace environment and use `/workspaces/` path

**Pros:**

- ✅ Zero configuration needed

**Cons:**

- ❌ Magic behavior (harder to debug)
- ❌ Fragile (relies on environment detection)
- ❌ Less flexible (what about other ephemeral environments?)
- ❌ Doesn't help with testing use case

### Option 4: Change Default Path

**Implementation:** Move default to project directory (e.g., `./.pml.db`)

**Pros:**

- ✅ Simple

**Cons:**

- ❌ **BREAKING CHANGE** for existing users
- ❌ Pollutes project directories
- ❌ Multiple DBs per user (confusing)
- ❌ Not appropriate for CLI tool pattern

---

## Decision

**Chosen Option:** **Option 1 - Environment Variable**

Add support for `PML_DB_PATH` environment variable to override the default database path.

### Implementation

**Modified:** `src/cli/utils.ts`

```typescript
export function getCasys PMLDatabasePath(): string {
  // Allow custom DB path via environment variable (ADR-021)
  const customPath = Deno.env.get("PML_DB_PATH");
  if (customPath) {
    return customPath;
  }

  // Default: ~/.pml/.pml.db
  const configDir = getCasys PMLConfigDir();
  const os = Deno.build.os;
  const separator = os === "windows" ? "\\" : "/";
  return `${configDir}${separator}.pml.db`;
}
```

**Added Tests:** `tests/unit/cli/utils_test.ts`

- Test env var is respected when set
- Test default path is used when env var not set

---

## Consequences

### Positive

✅ **Codespace Persistence:** Playground users can persist data across sessions

```bash
# In .devcontainer.json
"remoteEnv": {
  "PML_DB_PATH": "/workspaces/Casys PML/.pml.db"
}
```

✅ **Test Isolation:** Parallel tests can use isolated databases

```bash
PML_DB_PATH=/tmp/test-db-${TEST_ID}.db deno test
```

✅ **Zero Breaking Changes:** Existing users unaffected (default unchanged)

✅ **Deployment Flexibility:** Production deployments can customize DB location

```bash
# Production server
PML_DB_PATH=/var/lib/pml/pml.db pml serve
```

### Negative

⚠️ **Documentation Burden:** Need to document this feature in:

- README.md
- Playground setup guide
- CLI help text (future)

⚠️ **User Responsibility:** Users must set env var (but Story 1.5 `ensurePlaygroundReady()` will
handle this automatically for notebooks)

### Neutral

🔄 **Story 1.5 Integration:** `ensurePlaygroundReady()` helper can leverage this to automatically
configure playground environment

---

## Validation

**Tests:** ✅ 10/10 passing (`tests/unit/cli/utils_test.ts`)

- Existing tests continue to pass (default behavior unchanged)
- New tests validate env var behavior

**Manual Testing:**

```bash
# Test 1: Default behavior (unchanged)
deno task cli workflows sync --file playground/config/workflow-templates.yaml
# → Uses ~/.pml/.pml.db ✅

# Test 2: Custom path via env var
PML_DB_PATH=/workspaces/Casys PML/.pml.db \
  deno task cli workflows sync --file playground/config/workflow-templates.yaml
# → Uses /workspaces/Casys PML/.pml.db ✅
```

---

## Related Decisions

- **ADR-009:** MCP Config Format (JSON vs YAML) - Similar env var pattern could be applied
- **Story 1.5:** Idempotent Init Helper - Will leverage this feature for playground setup
- **Story 2.4:** MCP Gateway Integration - Uses same database path resolution

---

## References

- **Issue Context:** Story 1.3 - Workflow Templates Configuration
- **Problem Discovery:** Codespace testing during playground implementation
- **Similar Patterns:**
  - Docker: `DOCKER_CONFIG`, `DOCKER_HOST`
  - PostgreSQL: `PGDATA`, `PGHOST`
  - Node.js: `NODE_PATH`, `NPM_CONFIG_PREFIX`
  - Git: `GIT_DIR`, `GIT_WORK_TREE`

---

## Implementation Checklist

- [x] Code implementation (`src/cli/utils.ts`)
- [x] Unit tests added and passing
- [x] ADR document created
- [x] Story 1.3 updated with this change
- [ ] README.md updated (future)
- [ ] Playground setup guide updated (Story 1.5)
- [ ] `.devcontainer.json` configured with env var (future)

---

**Date Approved:** 2025-12-01 **Approved By:** Dev Team (during Story 1.3 implementation)
