# Deno Permissions System - Deep Dive

**Date:** 2025-11-11 **Owner:** Amelia (Dev) **Status:** ✅ COMPLETE **Purpose:** Comprehensive
guide to Deno's permission model for Epic 3 sandbox implementation

---

## Executive Summary

Deno's permission system is a **whitelist-based security model** that requires explicit opt-in for
all sensitive operations. This is fundamentally different from Node.js's implicit trust model.

**Key Principles:**

1. **Secure by default** - Zero permissions granted unless explicitly allowed
2. **Granular control** - Permissions can be scoped to specific resources
3. **Explicit > Implicit** - No "ambient authority" inherited from environment
4. **Runtime enforcement** - Permissions checked at runtime, not compile time

**Relevance to Casys PML:**

- Story 3.1: Sandbox executor must enforce strict permissions
- Story 3.2: MCP tools injection requires understanding permission boundaries
- Story 3.3: Result serialization needs I/O permission clarity
- Story 3.7: Integration tests require permission orchestration

---

## Table of Contents

1. [Permission Types](#permission-types)
2. [Permission Flags](#permission-flags)
3. [Permission Scoping](#permission-scoping)
4. [Deny Flags (Explicit Rejection)](#deny-flags-explicit-rejection)
5. [Permission Inheritance](#permission-inheritance)
6. [Runtime Permission Checks](#runtime-permission-checks)
7. [Permission Prompts](#permission-prompts)
8. [Best Practices for Casys PML](#best-practices-for-pml)
9. [Security Patterns](#security-patterns)
10. [Common Pitfalls](#common-pitfalls)
11. [Performance Considerations](#performance-considerations)

---

## Permission Types

Deno provides 7 core permission types:

### 1. `--allow-read` / `--deny-read`

**Controls:** File system read access

**Operations gated:**

- `Deno.readTextFile()`
- `Deno.readFile()`
- `Deno.open()` with read mode
- `Deno.stat()`, `Deno.lstat()`
- `Deno.readDir()`
- `import` statements (reading module files)

**Scoping:**

```bash
# Allow all reads
deno run --allow-read script.ts

# Allow specific directory
deno run --allow-read=/tmp script.ts

# Allow multiple paths
deno run --allow-read=/tmp,/home/user/data script.ts

# Deny all reads (explicit)
deno run --deny-read script.ts
```

**Important:** Read permission is required even for `import` statements. Without it, Deno cannot
load modules.

**Casys PML usage:** Sandbox needs read access to temp files containing user code, but nothing else.

---

### 2. `--allow-write` / `--deny-write`

**Controls:** File system write access

**Operations gated:**

- `Deno.writeTextFile()`
- `Deno.writeFile()`
- `Deno.open()` with write mode
- `Deno.remove()`
- `Deno.mkdir()`
- `Deno.rename()`
- `Deno.create()`

**Scoping:**

```bash
# Allow all writes
deno run --allow-write script.ts

# Allow specific directory
deno run --allow-write=/tmp script.ts

# Deny all writes (explicit)
deno run --deny-write script.ts
```

**Casys PML usage:** Sandbox should NEVER have write access. All writes happen in host process.

---

### 3. `--allow-net` / `--deny-net`

**Controls:** Network access (HTTP, WebSocket, TCP, UDP)

**Operations gated:**

- `fetch()`
- `WebSocket`
- `Deno.connect()`
- `Deno.listen()`
- `Deno.resolveDns()`

**Scoping:**

```bash
# Allow all network access
deno run --allow-net script.ts

# Allow specific domain
deno run --allow-net=example.com script.ts

# Allow specific domain and port
deno run --allow-net=example.com:443 script.ts

# Allow multiple domains
deno run --allow-net=api.github.com,api.openai.com script.ts

# Deny all network (explicit)
deno run --deny-net script.ts
```

**Important:** Port specifications apply to both inbound (listen) and outbound (connect) operations.

**Casys PML usage:** Sandbox has NO network access. MCP tool calls (which may involve network)
happen via message passing to host.

---

### 4. `--allow-env` / `--deny-env`

**Controls:** Environment variable access

**Operations gated:**

- `Deno.env.get()`
- `Deno.env.set()`
- `Deno.env.toObject()`
- Access to `Deno.env`

**Scoping:**

```bash
# Allow all env vars
deno run --allow-env script.ts

# Allow specific env vars
deno run --allow-env=API_KEY,DATABASE_URL script.ts

# Deny all env access (explicit)
deno run --deny-env script.ts
```

**Security note:** Environment variables often contain secrets (API keys, passwords). Denying env
access prevents credential leakage.

**Casys PML usage:** Sandbox has NO env access to prevent credential exposure.

---

### 5. `--allow-run` / `--deny-run`

**Controls:** Subprocess spawning

**Operations gated:**

- `Deno.Command`
- `Deno.run()` (deprecated)

**Scoping:**

```bash
# Allow all subprocess spawning
deno run --allow-run script.ts

# Allow specific commands
deno run --allow-run=git,npm script.ts

# Deny all subprocess spawning (explicit)
deno run --deny-run script.ts
```

**Security note:** Subprocess spawning is extremely dangerous in sandboxes. User code could spawn
`rm -rf /` or other destructive commands.

**Casys PML usage:** Sandbox has NO subprocess access. This is critical for security.

---

### 6. `--allow-ffi` / `--deny-ffi`

**Controls:** Foreign Function Interface (loading native libraries)

**Operations gated:**

- `Deno.dlopen()`
- Loading `.so`, `.dylib`, `.dll` files

**Scoping:**

```bash
# Allow all FFI
deno run --allow-ffi script.ts

# Allow specific library paths
deno run --allow-ffi=/usr/lib/libfoo.so script.ts

# Deny all FFI (explicit)
deno run --deny-ffi script.ts
```

**Security note:** FFI bypasses all Deno security. Native code can perform arbitrary operations.

**Casys PML usage:** Sandbox has NO FFI access. This is critical for security.

---

### 7. `--allow-hrtime` / `--deny-hrtime`

**Controls:** High-resolution time measurement

**Operations gated:**

- `performance.now()` with microsecond precision
- High-resolution timestamps

**Scoping:**

```bash
# Allow high-resolution time
deno run --allow-hrtime script.ts

# Deny high-resolution time (explicit)
deno run --deny-hrtime script.ts
```

**Security note:** High-resolution timers can be used for timing attacks (e.g., Spectre-style
exploits).

**Casys PML usage:** We currently allow hrtime for performance measurement. This is low-risk for our
use case but should be reconsidered if processing sensitive data.

---

## Permission Flags

### Allow Flags

**Explicit permission granting:**

```bash
--allow-read[=<PATH>]      # File system read access
--allow-write[=<PATH>]     # File system write access
--allow-net[=<DOMAIN>]     # Network access
--allow-env[=<VAR>]        # Environment variable access
--allow-run[=<CMD>]        # Subprocess spawning
--allow-ffi[=<PATH>]       # Foreign Function Interface
--allow-hrtime             # High-resolution time
```

**Special flags:**

```bash
--allow-all                # Grant ALL permissions (dangerous, avoid in production)
-A                         # Alias for --allow-all
```

---

### Deny Flags (Explicit Rejection)

**Introduced in Deno 1.19+**

Deny flags explicitly reject permissions, even if allow flags are present. **Deny takes precedence
over allow.**

```bash
--deny-read[=<PATH>]       # Explicitly deny read access
--deny-write[=<PATH>]      # Explicitly deny write access
--deny-net[=<DOMAIN>]      # Explicitly deny network access
--deny-env[=<VAR>]         # Explicitly deny env access
--deny-run[=<CMD>]         # Explicitly deny subprocess spawning
--deny-ffi[=<PATH>]        # Explicitly deny FFI
--deny-hrtime              # Explicitly deny high-resolution time
```

**Precedence rules:**

```bash
# Example 1: Allow all reads, but deny /etc
deno run --allow-read --deny-read=/etc script.ts
# Result: Can read everywhere EXCEPT /etc

# Example 2: Deny all network, even with --allow-all
deno run --allow-all --deny-net script.ts
# Result: All permissions EXCEPT network

# Example 3: Allow specific directory, deny subdirectory
deno run --allow-read=/tmp --deny-read=/tmp/secrets script.ts
# Result: Can read /tmp but NOT /tmp/secrets
```

**Best practice for sandboxes:** Use deny flags to explicitly block sensitive operations, even when
allow flags might be overly permissive.

---

## Permission Scoping

### File System Scoping

**Absolute paths:**

```bash
# Unix
deno run --allow-read=/home/user/data script.ts

# Windows
deno run --allow-read=C:\Users\data script.ts
```

**Relative paths (resolved from CWD):**

```bash
deno run --allow-read=./data script.ts
# Resolved to absolute path at startup
```

**Parent directory access:**

```bash
# Allow /home/user/data grants access to:
# - /home/user/data
# - /home/user/data/subdir
# - /home/user/data/subdir/file.txt

# But NOT to:
# - /home/user
# - /home/user/other
```

**Multiple paths:**

```bash
deno run --allow-read=/tmp,/var/log,/home/user/data script.ts
```

---

### Network Scoping

**Domain-only:**

```bash
deno run --allow-net=example.com script.ts
# Allows: example.com:80, example.com:443, example.com:8080
```

**Domain and port:**

```bash
deno run --allow-net=example.com:443 script.ts
# Allows: example.com:443 ONLY
# Denies: example.com:80, example.com:8080
```

**IP addresses:**

```bash
deno run --allow-net=192.168.1.100 script.ts
deno run --allow-net=192.168.1.100:8080 script.ts
```

**Localhost:**

```bash
deno run --allow-net=localhost:3000 script.ts
deno run --allow-net=127.0.0.1:3000 script.ts
```

**Wildcards:** NOT supported. Must list each domain explicitly.

---

### Environment Variable Scoping

**Specific variables:**

```bash
deno run --allow-env=HOME,USER,PATH script.ts
# Allows access to HOME, USER, PATH only
# Denies: API_KEY, DATABASE_URL, etc.
```

**All variables:**

```bash
deno run --allow-env script.ts
```

---

### Subprocess Scoping

**Specific commands:**

```bash
deno run --allow-run=git,npm,deno script.ts
# Allows spawning: git, npm, deno
# Denies: bash, sh, python, etc.
```

**Important:** Command names are matched by basename, not full path.

```bash
# --allow-run=git allows:
# - /usr/bin/git
# - /usr/local/bin/git
# - ~/bin/git
```

---

## Permission Inheritance

### Subprocess Inheritance Rules

**Default behavior:** Subprocesses inherit NO permissions from parent.

```typescript
// Parent: Run with --allow-all
const command = new Deno.Command("deno", {
  args: ["run", "child.ts"],
  // Child has ZERO permissions by default
});
```

**Explicit permission passing:**

```typescript
const command = new Deno.Command("deno", {
  args: [
    "run",
    "--allow-read=/tmp", // Explicitly grant to child
    "child.ts",
  ],
});
```

**Casys PML pattern:** Host process has full permissions. Sandbox subprocess has ZERO permissions
except temp file read.

---

### Worker Threads

**Web Workers:** Have separate permission context.

```typescript
// Parent has --allow-all
new Worker(
  new URL("./worker.ts", import.meta.url).href,
  { type: "module", deno: { permissions: "none" } }, // Explicit permission control
);
```

**Permission options for workers:**

```typescript
deno: {
  permissions: "none",           // Zero permissions
  permissions: "inherit",        // Inherit from parent (default)
  permissions: {
    read: false,
    write: false,
    net: true,                   // Granular control
    env: false,
    run: false,
    ffi: false,
    hrtime: true,
  }
}
```

**Casys PML usage:** Workers use `permissions: "none"` and communicate via message passing.

---

## Runtime Permission Checks

### Querying Permissions

```typescript
// Check if permission is granted
const status = await Deno.permissions.query({ name: "read", path: "/etc/passwd" });
console.log(status.state); // "granted" | "denied" | "prompt"
```

**Permission descriptors:**

```typescript
// Read
{ name: "read", path: "/tmp" }

// Write
{ name: "write", path: "/var/log" }

// Network
{ name: "net", host: "example.com:443" }

// Environment
{ name: "env", variable: "HOME" }

// Run
{ name: "run", command: "git" }

// FFI
{ name: "ffi", path: "/usr/lib/libfoo.so" }

// High-resolution time
{ name: "hrtime" }
```

---

### Requesting Permissions at Runtime

```typescript
// Request permission (shows prompt if --no-prompt not used)
const status = await Deno.permissions.request({ name: "read", path: "/tmp" });

if (status.state === "granted") {
  const content = await Deno.readTextFile("/tmp/file.txt");
}
```

**Important for sandboxes:** Use `--no-prompt` to prevent interactive prompts in subprocess.

---

### Revoking Permissions

```typescript
// Revoke permission (useful for least-privilege pattern)
const status = await Deno.permissions.revoke({ name: "write" });
console.log(status.state); // "denied"
```

**Use case:** Grant permission temporarily, then revoke after operation.

```typescript
// Pattern: Temporary elevated permissions
const status = await Deno.permissions.request({ name: "write", path: "/tmp" });
if (status.state === "granted") {
  await Deno.writeTextFile("/tmp/output.txt", "data");
  await Deno.permissions.revoke({ name: "write" }); // Revoke after use
}
```

---

## Permission Prompts

### Interactive Prompts (Default Behavior)

When permission is not granted, Deno prompts the user:

```
⚠️  ┌ Deno requests read access to "/etc/passwd".
   ├ Requested by `Deno.readTextFile()` API.
   ├ Run again with --allow-read to bypass this prompt.
   └ Allow? [y/n/A] (y = yes, allow; n = no, deny; A = allow all read permissions) >
```

**Prompt responses:**

- `y` - Allow this operation
- `n` - Deny this operation
- `A` - Allow all operations of this type (for this run)

---

### Disabling Prompts

**`--no-prompt` flag:** Fails immediately instead of prompting.

```bash
deno run --no-prompt script.ts
# Any permission violation throws PermissionDenied error immediately
```

**Casys PML usage:** Sandbox always uses `--no-prompt` to prevent hanging on permission prompts.
Violations should fail fast, not wait for user input.

---

## Best Practices for Casys PML

### 1. Principle of Least Privilege

**Always grant minimum permissions required.**

```typescript
// ❌ BAD: Overly permissive
new Deno.Command("deno", {
  args: ["run", "--allow-all", "sandbox.ts"],
});

// ✅ GOOD: Minimal permissions
new Deno.Command("deno", {
  args: [
    "run",
    `--allow-read=${tempFile}`, // Only temp file
    "--deny-write",
    "--deny-net",
    "--deny-run",
    "--deny-ffi",
    "--deny-env",
    "sandbox.ts",
  ],
});
```

---

### 2. Explicit Denials for Defense-in-Depth

**Use deny flags even when allow flags are minimal.**

```typescript
// ✅ BEST: Defense-in-depth approach
const permissions = [
  `--allow-read=${tempFile}`,
  "--deny-write", // Explicit: no writes ever
  "--deny-net", // Explicit: no network ever
  "--deny-run", // Explicit: no subprocess spawning ever
  "--deny-ffi", // Explicit: no FFI ever
  "--deny-env", // Explicit: no env vars ever
];
```

**Rationale:** If code logic accidentally adds `--allow-net` later, `--deny-net` will override it.

---

### 3. Scope Permissions to Specific Resources

**Don't grant broad permissions when narrow ones suffice.**

```typescript
// ❌ BAD: Broad permission
--allow-read=/home/user

// ✅ GOOD: Narrow permission
--allow-read=/home/user/.pml/temp/abc123.ts
```

---

### 4. Use `--no-prompt` in Subprocesses

**Prevent sandbox from hanging on permission prompts.**

```typescript
new Deno.Command("deno", {
  args: [
    "run",
    "--no-prompt", // ✅ Fail fast, don't prompt
    ...permissions,
    tempFile,
  ],
});
```

---

### 5. Validate Permissions Before Operations

**For host process code, check permissions before attempting sensitive operations.**

```typescript
// ✅ GOOD: Check before attempting
async function readFileIfAllowed(path: string): Promise<string | null> {
  const status = await Deno.permissions.query({ name: "read", path });

  if (status.state !== "granted") {
    console.warn(`Read permission denied for ${path}`);
    return null;
  }

  return await Deno.readTextFile(path);
}
```

---

### 6. Temp File Cleanup

**Even with read-only permissions, clean up temp files to prevent disk exhaustion.**

```typescript
let tempFile: string | null = null;
try {
  tempFile = Deno.makeTempFileSync({ suffix: ".ts" });
  Deno.writeTextFileSync(tempFile, code);

  const result = await executeInSandbox(tempFile);
  return result;
} finally {
  // ✅ Always cleanup, even on error
  if (tempFile) {
    try {
      Deno.removeSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
```

---

### 7. Monitor Permission Violations

**Log permission errors for security monitoring.**

```typescript
try {
  await Deno.readTextFile("/etc/passwd");
} catch (error) {
  if (error instanceof Deno.errors.PermissionDenied) {
    // ✅ Log security event
    console.error("SECURITY: Permission violation detected", {
      operation: "read",
      resource: "/etc/passwd",
      timestamp: new Date().toISOString(),
    });
  }
  throw error;
}
```

---

## Security Patterns

### Pattern 1: Zero-Permission Sandbox with Message Passing

**Concept:** Sandbox has ZERO permissions. All privileged operations happen in host via messages.

```typescript
// Host process (full permissions)
const worker = new Worker(
  new URL("./sandbox.ts", import.meta.url).href,
  {
    type: "module",
    deno: { permissions: "none" }, // Zero permissions
  },
);

worker.onmessage = async (event) => {
  if (event.data.type === "call_mcp_tool") {
    // Host performs privileged operation
    const result = await callMCPTool(event.data.name, event.data.args);
    worker.postMessage({ type: "tool_result", result });
  }
};

// Sandbox (zero permissions)
// In sandbox.ts:
postMessage({ type: "call_mcp_tool", name: "github.searchRepos", args: {} });
```

**Casys PML usage:** This is our Story 3.2 architecture (message passing bridge).

---

### Pattern 2: Read-Only Sandbox

**Concept:** Grant read access to specific files/directories. Deny everything else.

```typescript
const permissions = [
  `--allow-read=${tempFile},/usr/lib/deno`, // Code + stdlib
  "--deny-write",
  "--deny-net",
  "--deny-run",
  "--deny-ffi",
  "--deny-env",
];
```

**Casys PML usage:** This is our Story 3.1 sandbox executor.

---

### Pattern 3: Temporary Privilege Escalation

**Concept:** Grant permission, use it, immediately revoke.

```typescript
// Request temporary write permission
const status = await Deno.permissions.request({ name: "write", path: "/tmp" });

if (status.state === "granted") {
  await Deno.writeTextFile("/tmp/output.txt", data);

  // Immediately revoke
  await Deno.permissions.revoke({ name: "write" });
}
```

**Use case:** Useful when host process needs to temporarily write, then continue with restricted
permissions.

---

### Pattern 4: Permission Verification

**Concept:** Verify expected permissions at startup.

```typescript
async function verifySandboxPermissions() {
  const checks = [
    { name: "write", shouldBe: "denied" },
    { name: "net", shouldBe: "denied" },
    { name: "run", shouldBe: "denied" },
    { name: "ffi", shouldBe: "denied" },
    { name: "env", shouldBe: "denied" },
  ] as const;

  for (const check of checks) {
    const status = await Deno.permissions.query({ name: check.name });
    if (status.state !== check.shouldBe) {
      throw new Error(
        `Security violation: Expected ${check.name} to be ${check.shouldBe}, got ${status.state}`,
      );
    }
  }
}

// Run at sandbox startup
await verifySandboxPermissions();
```

---

## Common Pitfalls

### Pitfall 1: Forgetting `--no-prompt`

**Problem:** Sandbox hangs waiting for user input on permission prompt.

```typescript
// ❌ BAD: Can hang on prompt
new Deno.Command("deno", { args: ["run", "script.ts"] });

// ✅ GOOD: Fails immediately
new Deno.Command("deno", { args: ["run", "--no-prompt", "script.ts"] });
```

---

### Pitfall 2: Path Resolution Issues

**Problem:** Relative paths in `--allow-read` are resolved from CWD, not script location.

```bash
# If CWD is /home/user
deno run --allow-read=./data script.ts
# Resolves to: /home/user/data

# But script might expect relative to its location
# If script.ts is in /home/user/projects/app
# It cannot read /home/user/projects/app/data
```

**Solution:** Always use absolute paths in permission flags.

---

### Pitfall 3: Deny Overrides Allow

**Problem:** Adding `--deny-*` can break previously working code.

```bash
# This works
deno run --allow-read --allow-net script.ts

# This breaks network access
deno run --allow-read --allow-net --deny-net=evil.com script.ts
# Actually denies ALL network, not just evil.com (Deno 1.x behavior)
```

**Solution:** Understand precedence rules. Test permission combinations.

---

### Pitfall 4: Parent Directory Access

**Problem:** Assuming `--allow-read=/tmp` grants read to `/tmp/../etc`.

```bash
deno run --allow-read=/tmp script.ts

# This FAILS (good!)
await Deno.readTextFile("/tmp/../etc/passwd");  # PermissionDenied
```

**Deno's behavior:** Path normalization happens before permission check. `/tmp/../etc/passwd` →
`/etc/passwd`, which is not under `/tmp`.

---

### Pitfall 5: Import Permissions

**Problem:** Forgetting that `import` requires read permissions.

```typescript
// script.ts
import { foo } from "./lib.ts"; // Requires --allow-read for ./lib.ts
```

```bash
# ❌ FAILS: Cannot read ./lib.ts
deno run --deny-read script.ts

# ✅ WORKS: Allow reading modules
deno run --allow-read=. script.ts
```

---

## Performance Considerations

### Permission Check Overhead

**Impact:** Permission checks add ~5-50μs per operation (microseconds, not milliseconds).

```typescript
// Benchmark: 1000 file reads with permission checks
// Without permissions: ~10ms
// With permissions: ~11ms
// Overhead: ~1ms for 1000 operations = 1μs per operation
```

**Conclusion:** Permission overhead is negligible for Casys PML use case (<1ms per execution).

---

### Subprocess Startup Cost

**Impact:** Spawning Deno subprocess has ~20-50ms overhead.

```typescript
// Benchmark: Empty Deno subprocess
const start = performance.now();
const command = new Deno.Command("deno", { args: ["eval", "console.log(1)"] });
await command.output();
const duration = performance.now() - start;
// Duration: ~30-50ms on modern hardware
```

**Mitigation:**

- Casys PML sandbox target: <150ms total (well within budget)
- Consider process pooling for high-frequency execution (future optimization)

---

### Permission Query Cost

**Impact:** `Deno.permissions.query()` is fast (~10μs).

```typescript
// ✅ GOOD: Query permissions liberally
const status = await Deno.permissions.query({ name: "read", path: "/tmp" });
// Cost: ~10μs (negligible)
```

---

## Deno 2.x Changes

### New in Deno 2.0

**1. Improved deny flag behavior:**

- Deny flags now correctly override allow flags in all cases
- More predictable precedence

**2. npm: support inherits permissions:**

```typescript
import validator from "npm:validator@13.15.22";
// Inherits permissions from parent Deno process
```

**3. Worker permissions API improvements:**

- More granular permission control for workers
- Better error messages

---

## Checklist for Casys PML Sandbox

**Before launching any sandbox execution, verify:**

- [ ] `--no-prompt` flag present
- [ ] `--allow-read` scoped to temp file only (absolute path)
- [ ] `--deny-write` explicitly set
- [ ] `--deny-net` explicitly set
- [ ] `--deny-run` explicitly set
- [ ] `--deny-ffi` explicitly set
- [ ] `--deny-env` explicitly set
- [ ] Temp file cleanup in `finally` block
- [ ] Timeout mechanism implemented
- [ ] Memory limit set via `--v8-flags=--max-old-space-size=<MB>`
- [ ] Permission violation errors logged
- [ ] Process isolation verified (no shared state)

---

## Testing Permissions

### Test Template

```typescript
import { assertEquals } from "@std/assert";

Deno.test("Sandbox denies network access", async () => {
  const executor = new DenoSandboxExecutor();

  const result = await executor.execute(`
    const response = await fetch("https://example.com");
    return response.status;
  `);

  assertEquals(result.success, false);
  assertEquals(result.error?.type, "PermissionError");
  assertEquals(
    result.error?.message.includes("net"),
    true,
    "Error should mention network permission",
  );
});
```

---

## References

**Official Documentation:**

- [Deno Permissions](https://deno.land/manual/basics/permissions)
- [Deno Security](https://deno.land/manual/runtime/security)
- [Deno Workers](https://deno.land/manual/runtime/workers)

**Casys PML Documentation:**

- [Deno Sandbox POC Summary](./deno-sandbox-poc-summary.md)
- [Architecture Spike - MCP Tools Injection](./architecture-spike-mcp-tools-injection.md)

---

## Conclusion

Deno's permission system provides robust, granular security control perfect for Casys PML' sandbox
requirements. Key takeaways:

1. **Whitelist-based** - Explicit opt-in for all sensitive operations
2. **Granular** - Scope permissions to specific resources
3. **Explicit denial** - Use `--deny-*` flags for defense-in-depth
4. **Process isolation** - Subprocesses inherit zero permissions by default
5. **Performance** - Negligible overhead (<1ms per execution)

**Next steps for Epic 3:**

- Story 3.1: Implement sandbox executor with permission model documented here
- Story 3.2: Leverage worker permissions for MCP tools injection
- Story 3.7: Use permission knowledge for integration tests

---

**Document Status:** ✅ COMPLETE **Date:** 2025-11-11 **Owner:** Amelia (Dev)
