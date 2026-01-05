# Phase 2.4: Sandbox Executor Completion (P1 - High)

**Parent:** [index.md](./index.md)
**Priority:** P1 - High
**Timeline:** Week 7
**Depends On:** Phase 2.2 (God classes refactored)

---

## Objective

Complete Phase 5 from original large-files spec (not yet started).

| File | Current | Target | Reduction |
|------|---------|--------|-----------|
| `sandbox/executor.ts` | 1,302 lines | 250 lines | 81% |

---

## Current State

`src/sandbox/executor.ts` contains:

1. Deno subprocess execution
2. Worker-based execution
3. Output parsing and result handling
4. Timeout management
5. Permission mapping
6. Path validation
7. Tool injection

---

## Target Structure

```
src/sandbox/
├── executor.ts                 # ~250 lines - Main executor facade
├── execution/
│   ├── deno-runner.ts          # Deno subprocess execution
│   ├── worker-runner.ts        # Worker-based execution (default)
│   ├── result-parser.ts        # Output parsing
│   └── timeout-handler.ts      # Timeout management
├── security/
│   ├── permission-mapper.ts    # Permission set mapping
│   └── path-validator.ts       # Path validation
└── tools/
    └── injector.ts             # Tool injection logic
```

---

## Module Breakdown

### 1. `execution/deno-runner.ts` (~150 lines)

```typescript
export class DenoSubprocessRunner {
  constructor(private config: RunnerConfig) {}

  async run(code: string, permissions: PermissionSet): Promise<RunResult> {
    const cmd = this.buildCommand(permissions);
    const process = new Deno.Command(cmd.program, cmd.args);
    // ... subprocess execution
  }

  private buildCommand(permissions: PermissionSet): CommandConfig {
    // Build deno run command with permission flags
  }
}
```

### 2. `execution/worker-runner.ts` (~200 lines)

```typescript
export class WorkerRunner {
  private bridge: WorkerBridge;

  constructor(private config: WorkerConfig) {
    this.bridge = new WorkerBridge(config);
  }

  async run(code: string, context: ExecutionContext): Promise<RunResult> {
    return this.bridge.execute(code, context);
  }
}
```

### 3. `execution/result-parser.ts` (~100 lines)

```typescript
export class ResultParser {
  parse(output: string): ExecutionResult {
    // Parse stdout/stderr
    // Extract return value
    // Handle errors
  }

  parseError(error: unknown): ExecutionError {
    // Classify error type
    // Extract stack trace
  }
}
```

### 4. `execution/timeout-handler.ts` (~80 lines)

```typescript
export class TimeoutHandler {
  constructor(private defaultTimeout: number) {}

  wrap<T>(promise: Promise<T>, timeout?: number): Promise<T> {
    return Promise.race([
      promise,
      this.createTimeout(timeout ?? this.defaultTimeout)
    ]);
  }

  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new TimeoutError(ms)), ms);
    });
  }
}
```

### 5. `security/permission-mapper.ts` (~120 lines)

```typescript
export class PermissionMapper {
  constructor(private profiles: PermissionProfiles) {}

  toDenoFlags(set: PermissionSet): string[] {
    const flags: string[] = [];
    if (set.read) flags.push(`--allow-read=${set.read.join(",")}`);
    if (set.write) flags.push(`--allow-write=${set.write.join(",")}`);
    if (set.net) flags.push(set.net === true ? "--allow-net" : `--allow-net=${set.net.join(",")}`);
    // ... other permissions
    return flags;
  }

  fromProfile(profile: string): PermissionSet {
    return this.profiles[profile] ?? this.profiles.minimal;
  }
}
```

### 6. `security/path-validator.ts` (~100 lines)

```typescript
export class PathValidator {
  constructor(private allowedPaths: string[]) {}

  validate(path: string): ValidationResult {
    const resolved = Deno.realPathSync(path);
    const allowed = this.allowedPaths.some(p => resolved.startsWith(p));
    return { valid: allowed, resolved, reason: allowed ? null : "Path not in allowed list" };
  }

  validateAll(paths: string[]): ValidationResult[] {
    return paths.map(p => this.validate(p));
  }
}
```

### 7. `tools/injector.ts` (~150 lines)

```typescript
export class ToolInjector {
  constructor(private registry: IMCPClientRegistry) {}

  inject(code: string, tools: ToolDefinition[]): string {
    const toolBindings = this.generateBindings(tools);
    return `${toolBindings}\n\n${code}`;
  }

  private generateBindings(tools: ToolDefinition[]): string {
    return tools.map(t => this.createBinding(t)).join("\n");
  }
}
```

---

## Refactored Executor Facade

```typescript
// src/sandbox/executor.ts (~250 lines)
import { DenoSubprocessRunner } from "./execution/deno-runner.ts";
import { WorkerRunner } from "./execution/worker-runner.ts";
import { ResultParser } from "./execution/result-parser.ts";
import { TimeoutHandler } from "./execution/timeout-handler.ts";
import { PermissionMapper } from "./security/permission-mapper.ts";
import { PathValidator } from "./security/path-validator.ts";
import { ToolInjector } from "./tools/injector.ts";

export class SandboxExecutor {
  private runner: WorkerRunner | DenoSubprocessRunner;
  private parser: ResultParser;
  private timeout: TimeoutHandler;
  private permissions: PermissionMapper;
  private pathValidator: PathValidator;
  private toolInjector: ToolInjector;

  constructor(config: SandboxConfig, registry: IMCPClientRegistry) {
    this.runner = config.useWorker
      ? new WorkerRunner(config.worker)
      : new DenoSubprocessRunner(config.subprocess);
    this.parser = new ResultParser();
    this.timeout = new TimeoutHandler(config.defaultTimeout);
    this.permissions = new PermissionMapper(config.permissionProfiles);
    this.pathValidator = new PathValidator(config.allowedPaths);
    this.toolInjector = new ToolInjector(registry);
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    // 1. Validate paths
    const pathValidation = this.pathValidator.validateAll(request.paths ?? []);
    if (pathValidation.some(v => !v.valid)) {
      return { success: false, error: "Invalid paths" };
    }

    // 2. Inject tools
    const code = this.toolInjector.inject(request.code, request.tools ?? []);

    // 3. Map permissions
    const permFlags = this.permissions.toDenoFlags(request.permissions);

    // 4. Execute with timeout
    const result = await this.timeout.wrap(
      this.runner.run(code, { permissions: permFlags }),
      request.timeout
    );

    // 5. Parse result
    return this.parser.parse(result);
  }
}
```

---

## Migration Steps

1. **Create module structure**
   ```bash
   mkdir -p src/sandbox/{execution,security,tools}
   ```

2. **Extract each module** (1 per day)
   - Day 1: `deno-runner.ts`, `worker-runner.ts`
   - Day 2: `result-parser.ts`, `timeout-handler.ts`
   - Day 3: `permission-mapper.ts`, `path-validator.ts`
   - Day 4: `injector.ts`, refactor main executor
   - Day 5: Integration tests, cleanup

3. **Update imports** in consuming code

4. **Delete extracted code** from main executor

---

## Acceptance Criteria

- [ ] Main executor < 250 lines
- [ ] Each module < 200 lines
- [ ] All existing tests pass
- [ ] New unit tests for each module
- [ ] No breaking changes to public API
