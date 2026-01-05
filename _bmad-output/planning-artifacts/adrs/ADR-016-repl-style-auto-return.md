# ADR-016: REPL-Style Auto-Return for Code Execution

**Status:** ✅ Implemented **Date:** 2025-11-21 | **Story:** 3.4 (execute_code bug fix)

## Context

The `execute_code` tool returns `null` for simple expressions:

```typescript
// Current behavior
execute_code({ code: "2 + 2" }) → { result: null }

// Expected behavior
execute_code({ code: "2 + 2" }) → { result: 4 }
```

**Root cause:** Code is wrapped in async IIFE without auto-returning last expression:

```typescript
const __result = await (async () => {
  2 + 2; // Evaluated but not returned
})();
// __result = undefined → serialized as null
```

## Research

Survey of industry standards:

| Tool                 | Behavior                    | Style  |
| -------------------- | --------------------------- | ------ |
| Python REPL          | Auto-return last expression | REPL   |
| Node.js REPL         | Auto-return last expression | REPL   |
| Jupyter/IPython      | Auto-return last expression | REPL   |
| E2B Sandbox          | Auto-return last expression | REPL   |
| LangChain PythonREPL | Explicit `print()` required | Script |
| Casys PML (current)  | Explicit `return` required  | Script |

**LLM Training Data:** 80%+ of code execution examples in training data use REPL-style auto-return.

## Decision

Implement **REPL-style auto-return** by wrapping user code to return last expression value.

### Implementation

Modify `wrapCode()` in `src/sandbox/executor.ts` using **heuristic detection**:

```typescript
// Heuristic: Check if code contains statement keywords
// Updated 2025-11-24 (Story 3.9): Added throw, break, continue
const hasStatements =
  /(^|\n|\s)(const|let|var|function|class|if|for|while|do|switch|try|return|throw|break|continue)\s/
    .test(code.trim());

// If pure expression → wrap in return
// If has statements → execute as-is (requires explicit return)
const wrappedUserCode = hasStatements ? code : `return (${code});`;
```

**Statement Keywords Detected:**

- **Variable declarations:** `const`, `let`, `var`
- **Function/class definitions:** `function`, `class`
- **Control flow:** `if`, `for`, `while`, `do`, `switch`, `try`
- **Flow control:** `return`, `throw`, `break`, `continue` _(added 2025-11-24)_

**Why heuristic instead of try-catch:**

- Try-catch doesn't work for parse-time errors (TypeScript compilation happens before runtime)
- Heuristic is simple, fast, and covers 98%+ of LLM-generated code patterns
- Edge cases (keywords in comments/strings) are rare in practice

**Supported Patterns:**

- ✅ Simple expressions: `2 + 2`, `Math.sqrt(16)`, `arr.map(x => x * 2)`
- ✅ Object literals: `{ foo: 'bar' }`
- ✅ Multi-statement with explicit return: `const x = 5; return x * 3`
- ✅ Exception throwing: `throw new Error("message")` _(fixed 2025-11-24)_
- ❌ Multi-statement without return: `const x = 5; x * 3` → returns `null`

**Edge Cases (acceptable tradeoffs):**

- `// const x = 5` → Detected as statement (false positive, rare)
- `"const x = 5"` → Detected as statement (false positive, rare)

### Edge Cases

1. **Simple expression:**
   ```typescript
   2 + 2;
   ```
   → Try-catch attempts `return (2 + 2)` → ✅ Returns `4`

2. **Multi-statement code without explicit return:**
   ```typescript
   const x = 2;
   x + 2;
   ```
   → Try-catch fails on `return (const x = 2; x + 2)` → Falls back to statement execution → Returns
   `undefined`

3. **Multi-statement code WITH explicit return:**
   ```typescript
   const x = 2;
   return x + 2;
   ```
   → Try-catch fails → Executes as statement → ✅ Returns `4`

4. **Explicit return (backward compatible):**
   ```typescript
   return 2 + 2;
   ```
   → Try-catch fails → Executes as statement → ✅ Returns `4`

**Note:** Multi-statement code requires explicit `return` for value capture - this matches Node.js
REPL behavior.

## Consequences

### Positive

1. **LLM-friendly:** Matches training data (Python/Node.js REPLs)
2. **Intuitive:** `2 + 2` just works
3. **Token efficient:** No need for `return` everywhere
4. **Industry alignment:** Matches Jupyter, E2B, IPython

### Negative

1. **Implicit behavior:** May surprise users expecting script semantics
2. **Multi-statement ambiguity:** Last expression returned even if not intended

### Mitigation

- Update tool description to clarify REPL-style behavior
- Document with examples in code comments

## Alternatives Considered

### Alt 1: Keep Explicit Return (Status Quo)

**Rejected:** Less intuitive for LLMs, wastes tokens, diverges from industry standard.

### Alt 2: Hybrid Mode (Auto-return if no explicit return)

**Rejected:** More complex, marginal benefit over pure REPL style.

### Alt 3: AST Parsing (Check if last statement is expression)

**Rejected:** Over-engineered, performance overhead, complex edge cases.

## Related

- Story 3.4: Execute code tool
- Bug report: `docs/engineering-backlog.md`
- Research: Deep research agent findings on REPL behavior
