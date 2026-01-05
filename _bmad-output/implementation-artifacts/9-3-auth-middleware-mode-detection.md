# Story 9.3: Auth Middleware & Mode Detection (Dual-Server)

Status: Done

## Story

As a system administrator, I want automatic mode detection based on environment, So that self-hosted
deployments work without any auth configuration.

## Acceptance Criteria

1. **AC1:** Mode detection + validation helpers created (`src/lib/auth.ts` - shared module)
2. **AC2:** Fresh Dashboard auth middleware (`src/web/routes/_middleware.ts`) validates sessions in
   cloud mode, bypasses in local mode
3. **AC3:** API Server auth (`src/mcp/gateway-server.ts`) validates API Key header in cloud mode,
   bypasses in local mode
4. **AC4:** Protected routes enforced per server (see table below)
5. **AC5:** Mode detection logs at INFO level on server startup
6. **AC6:** Tests cover both modes for both servers
7. **AC7:** 401 JSON response for invalid/missing auth in cloud mode

## Tasks / Subtasks

- [x] **Task 1: Create Shared Auth Module** (AC: #1)

  - [x] 1.1 Create `src/lib/auth.ts` with mode detection and validation helpers
  - [x] 1.2 Implement `isCloudMode()` - checks `GITHUB_CLIENT_ID` env var
  - [x] 1.3 Implement `getDefaultUserId()` - returns `"local"` or `null`
  - [x] 1.4 Implement `validateRequest(req)` - validates API Key header
  - [x] 1.5 Implement `validateApiKeyFromDb(apiKey)` - lookup prefix + verify hash

- [x] **Task 2: Create Fresh Middleware** (AC: #2, #4)

  - [x] 2.1 Create `src/web/routes/_middleware.ts`
  - [x] 2.2 Implement session validation for cloud mode
  - [x] 2.3 Implement auth bypass for local mode
  - [x] 2.4 Inject `ctx.state.user` with user data
  - [x] 2.5 Redirect non-auth to `/auth/signin` for protected routes

- [x] **Task 3: Add API Server Auth** (AC: #3, #4, #7)

  - [x] 3.1 Import `validateRequest` in `gateway-server.ts`
  - [x] 3.2 Add auth check after CORS preflight (~15 lines)
  - [x] 3.3 Return 401 JSON for invalid auth
  - [x] 3.4 Skip auth for `/health` endpoint

- [x] **Task 4: Startup Logging** (AC: #5)

  - [x] 4.1 Log mode detection in Fresh server startup
  - [x] 4.2 Log mode detection in API server startup

- [x] **Task 5: Tests** (AC: #6)
  - [x] 5.1 Unit tests for `src/lib/auth.ts` helpers
  - [x] 5.2 Unit tests for Fresh middleware (mock session)
  - [x] 5.3 Integration tests for API Server auth validation
  - [x] 5.4 Tests for local mode bypass (both servers)

## Dev Notes

### Architecture: Dual-Server Auth

**CRITICAL:** Auth is implemented in TWO places - Fresh middleware and API Server handler.

**Ports:**

- **Production:** Fresh Dashboard 8080, API Server 3001
- **Development:** Fresh Dashboard 8081 (via `FRESH_PORT`), API Server 3003 (via `PORT_API`)

```
┌─────────────────────────────────────────────────────────────────┐
│                 ARCHITECTURE DUAL-SERVER AUTH                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────────────┐   ┌───────────────────────────┐ │
│  │  Fresh Dashboard          │   │  API Server               │ │
│  │  (prod:8080 / dev:8081)   │   │  (prod:3001 / dev:3003)   │ │
│  │  src/web/routes/          │   │  gateway-server.ts        │ │
│  │                           │   │                           │ │
│  │  Auth: Session (cookie)   │   │  Auth: API Key (header)   │ │
│  │  _middleware.ts           │   │  x-api-key: ac_xxx        │ │
│  └───────────────────────────┘   └───────────────────────────┘ │
│              │                             │                     │
│              └──────────┬──────────────────┘                    │
│                         ▼                                        │
│              ┌─────────────────────────┐                        │
│              │  Shared Auth Module     │                        │
│              │  src/lib/auth.ts        │                        │
│              │  • isCloudMode()        │                        │
│              │  • validateRequest()    │                        │
│              │  • getDefaultUserId()   │                        │
│              └─────────────────────────┘                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Protected Routes Summary

| Route            | Server                 | Auth Cloud     | Auth Local |
| ---------------- | ---------------------- | -------------- | ---------- |
| `/dashboard/*`   | Fresh (8080/8081)      | Session cookie | Bypass     |
| `/settings/*`    | Fresh (8080/8081)      | Session cookie | Bypass     |
| `/auth/*`        | Fresh (8080/8081)      | Public         | Public     |
| `/`              | Fresh (8080/8081)      | Public         | Public     |
| `/mcp`           | API Server (3001/3003) | API Key header | Bypass     |
| `/api/graph/*`   | API Server (3001/3003) | API Key header | Bypass     |
| `/events/stream` | API Server (3001/3003) | API Key header | Bypass     |
| `/health`        | API Server (3001/3003) | Public         | Public     |

---

### Task 1: Shared Auth Module

#### 1.1 `src/lib/auth.ts`

```typescript
/**
 * Shared Authentication Module
 *
 * Provides mode detection and validation helpers used by both:
 * - Fresh Dashboard (port 8080) - session-based auth
 * - API Server (port 3003) - API Key auth
 *
 * Mode Detection:
 * - Cloud mode: GITHUB_CLIENT_ID is set → full auth required
 * - Local mode: No GITHUB_CLIENT_ID → auth bypassed, user_id = "local"
 *
 * @module lib/auth
 */

import * as log from "@std/log";
import { getApiKeyPrefix, verifyApiKey } from "./api-key.ts";
import { getDb } from "../server/auth/db.ts";
import { users } from "../db/schema/users.ts";
import { eq } from "drizzle-orm";

/**
 * Check if running in cloud mode (multi-tenant with auth)
 * Cloud mode is enabled when GITHUB_CLIENT_ID is set.
 */
export function isCloudMode(): boolean {
  return !!Deno.env.get("GITHUB_CLIENT_ID");
}

/**
 * Get default user ID for local mode
 * Returns "local" in local mode, null in cloud mode (requires auth)
 */
export function getDefaultUserId(): string | null {
  return isCloudMode() ? null : "local";
}

/**
 * Auth result from request validation
 */
export interface AuthResult {
  user_id: string;
  username?: string;
}

/**
 * Validate API Key from request header
 * Used by API Server (port 3003) for MCP and API routes.
 *
 * @param req - HTTP Request
 * @returns AuthResult if valid, null if invalid/missing
 */
export async function validateRequest(
  req: Request,
): Promise<AuthResult | null> {
  // Local mode: bypass auth, return default user
  if (!isCloudMode()) {
    return { user_id: "local", username: "local" };
  }

  // Cloud mode: require API Key header
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) {
    log.debug("Missing x-api-key header");
    return null;
  }

  return await validateApiKeyFromDb(apiKey);
}

/**
 * Validate API Key against database
 * 1. Validate format (ac_ + 24 chars)
 * 2. Extract prefix for O(1) lookup
 * 3. Find user by prefix
 * 4. Verify full key against stored hash
 *
 * @param apiKey - Full API key (ac_xxx)
 * @returns AuthResult if valid, null if invalid
 */
export async function validateApiKeyFromDb(
  apiKey: string,
): Promise<AuthResult | null> {
  try {
    // Validate format before DB lookup (fail fast)
    if (!apiKey.startsWith("ac_") || apiKey.length !== 27) {
      log.debug("Invalid API key format");
      return null;
    }

    // Extract prefix for lookup
    const prefix = getApiKeyPrefix(apiKey);

    // Find user by prefix
    const db = await getDb();
    const result = await db
      .select()
      .from(users)
      .where(eq(users.apiKeyPrefix, prefix))
      .limit(1);

    if (result.length === 0) {
      log.debug("No user found for API key prefix");
      return null;
    }

    const user = result[0];

    // Verify full key against hash
    if (!user.apiKeyHash) {
      log.debug("User has no API key hash");
      return null;
    }

    const isValid = await verifyApiKey(apiKey, user.apiKeyHash);
    if (!isValid) {
      log.debug("API key verification failed");
      return null;
    }

    return {
      user_id: user.id,
      username: user.username,
    };
  } catch (error) {
    log.error("Error validating API key", { error });
    return null;
  }
}

/**
 * Log auth mode at startup
 * Call this from both servers during initialization.
 */
export function logAuthMode(serverName: string): void {
  const mode = isCloudMode() ? "CLOUD" : "LOCAL";
  log.info(`[${serverName}] Auth mode: ${mode}`);
  if (!isCloudMode()) {
    log.info(
      `[${serverName}] Running in local mode - auth bypassed, user_id = "local"`,
    );
  }
}
```

---

### Task 2: Fresh Middleware

#### 2.1 `src/web/routes/_middleware.ts`

```typescript
/**
 * Fresh 2.x Authentication Middleware
 *
 * Note: Fresh 2.x uses single argument ctx with ctx.req
 * Route guards extracted to src/web/route-guards.ts for testability
 */

import { FreshContext } from "$fresh/server.ts";
import { isCloudMode } from "../../lib/auth.ts";
import { getSessionFromRequest } from "../../server/auth/session.ts";
import { isProtectedRoute, isPublicRoute } from "../route-guards.ts";

export interface AuthState {
  user: { id: string; username: string; avatarUrl?: string } | null;
  isCloudMode: boolean;
}

export async function handler(ctx: FreshContext<AuthState>): Promise<Response> {
  const url = new URL(ctx.req.url);
  const pathname = url.pathname;

  ctx.state.isCloudMode = isCloudMode();
  ctx.state.user = null;

  // Local mode: bypass auth
  if (!isCloudMode()) {
    ctx.state.user = { id: "local", username: "local", avatarUrl: undefined };
    return ctx.next();
  }

  // Cloud mode: check session for protected routes
  if (isProtectedRoute(pathname)) {
    const session = await getSessionFromRequest(ctx.req);
    if (!session) {
      const returnUrl = encodeURIComponent(pathname + url.search);
      return new Response(null, {
        status: 302,
        headers: { Location: `/auth/signin?return=${returnUrl}` },
      });
    }
    ctx.state.user = {
      id: session.userId,
      username: session.username,
      avatarUrl: session.avatarUrl,
    };
  } else if (!isPublicRoute(pathname)) {
    const session = await getSessionFromRequest(ctx.req);
    if (session) {
      ctx.state.user = {
        id: session.userId,
        username: session.username,
        avatarUrl: session.avatarUrl,
      };
    }
  }

  return ctx.next();
}
```

---

### Task 3: API Server Auth

#### 3.2 Modification to `src/mcp/gateway-server.ts`

Add after CORS preflight handling (approximately line 200-220 in the HTTP handler):

```typescript
// Story 9.3: Auth validation for protected routes
import { logAuthMode, validateRequest } from "../lib/auth.ts";

// In startHttpServer() or constructor:
logAuthMode("API Server");

// In the HTTP request handler, after CORS preflight:
const PUBLIC_ROUTES = ["/health"];

if (!PUBLIC_ROUTES.includes(url.pathname)) {
  const auth = await validateRequest(req);
  if (!auth) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized",
        message: "Valid API key required",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }
  // TODO (Story 9.5): Propagate auth.user_id into execution context for data isolation
}
```

---

### Task 4: Startup Logging

#### Fresh Server (`src/web/dev.ts`)

Add logging after builder initialization:

```typescript
// In dev.ts, before builder.listen()
import { logAuthMode } from "./lib/auth.ts";

logAuthMode("Fresh Dashboard");

if (Deno.args.includes("build")) {
  // ...
} else {
  const port = parseInt(Deno.env.get("FRESH_PORT") || "8080");
  // ...
}
```

**Note:** Fresh 2.x uses `FRESH_PORT` env var (not `PORT_DASHBOARD`).

#### API Server (already covered in Task 3)

---

### Task 5: Tests

#### 5.1 `tests/unit/lib/auth_test.ts`

```typescript
import { assertEquals, assertExists } from "@std/assert";
import { getDefaultUserId, isCloudMode, validateRequest } from "../../../src/lib/auth.ts";

Deno.test("isCloudMode - returns false when GITHUB_CLIENT_ID not set", () => {
  // Ensure env var is not set for this test
  const original = Deno.env.get("GITHUB_CLIENT_ID");
  Deno.env.delete("GITHUB_CLIENT_ID");

  assertEquals(isCloudMode(), false);

  // Restore
  if (original) Deno.env.set("GITHUB_CLIENT_ID", original);
});

Deno.test("isCloudMode - returns true when GITHUB_CLIENT_ID is set", () => {
  const original = Deno.env.get("GITHUB_CLIENT_ID");
  Deno.env.set("GITHUB_CLIENT_ID", "test_client_id");

  assertEquals(isCloudMode(), true);

  // Restore
  if (original) {
    Deno.env.set("GITHUB_CLIENT_ID", original);
  } else {
    Deno.env.delete("GITHUB_CLIENT_ID");
  }
});

Deno.test("getDefaultUserId - returns 'local' in local mode", () => {
  Deno.env.delete("GITHUB_CLIENT_ID");
  assertEquals(getDefaultUserId(), "local");
});

Deno.test("getDefaultUserId - returns null in cloud mode", () => {
  const original = Deno.env.get("GITHUB_CLIENT_ID");
  Deno.env.set("GITHUB_CLIENT_ID", "test_client_id");

  assertEquals(getDefaultUserId(), null);

  // Restore
  if (original) {
    Deno.env.set("GITHUB_CLIENT_ID", original);
  } else {
    Deno.env.delete("GITHUB_CLIENT_ID");
  }
});

Deno.test("validateRequest - returns local user in local mode", async () => {
  Deno.env.delete("GITHUB_CLIENT_ID");

  const req = new Request("http://localhost/api/test");
  const result = await validateRequest(req);

  assertExists(result);
  assertEquals(result.user_id, "local");
});

Deno.test(
  "validateRequest - returns null without API key in cloud mode",
  async () => {
    const original = Deno.env.get("GITHUB_CLIENT_ID");
    Deno.env.set("GITHUB_CLIENT_ID", "test_client_id");

    const req = new Request("http://localhost/api/test");
    const result = await validateRequest(req);

    assertEquals(result, null);

    // Restore
    if (original) {
      Deno.env.set("GITHUB_CLIENT_ID", original);
    } else {
      Deno.env.delete("GITHUB_CLIENT_ID");
    }
  },
);
```

#### 5.2 `tests/unit/web/middleware_test.ts`

```typescript
import { assertEquals, assertExists } from "@std/assert";
import { isCloudMode } from "../../../src/lib/auth.ts";

// Test route classification
Deno.test("isProtectedRoute - dashboard routes", () => {
  // Import the function if exported, or test via middleware behavior
  // /dashboard → protected
  // /dashboard/settings → protected
  // /auth/signin → public
});

Deno.test("middleware - local mode bypasses auth", async () => {
  // Ensure GITHUB_CLIENT_ID not set
  Deno.env.delete("GITHUB_CLIENT_ID");

  // Create mock Fresh context
  const mockCtx = {
    state: {} as Record<string, unknown>,
    next: () => Promise.resolve(new Response("OK")),
  };

  // Verify user injected with id="local"
  // (Full test requires Fresh testing utilities)
});

Deno.test("middleware - cloud mode redirects unauthenticated", async () => {
  // Set cloud mode
  Deno.env.set("GITHUB_CLIENT_ID", "test");

  // Request to /dashboard without session
  const req = new Request("http://localhost/dashboard");

  // Verify 302 redirect to /auth/signin?return=%2Fdashboard
  // (Full test requires Fresh testing utilities)

  // Cleanup
  Deno.env.delete("GITHUB_CLIENT_ID");
});
```

#### 5.3 `tests/integration/auth/api_server_auth_test.ts`

```typescript
import { assertEquals } from "@std/assert";

Deno.test(
  "API Server - returns 401 without API key in cloud mode",
  async () => {
    // Set cloud mode
    Deno.env.set("GITHUB_CLIENT_ID", "test");

    // Make request without API key
    // Verify 401 response
  },
);

Deno.test("API Server - allows request in local mode", async () => {
  // Unset cloud mode
  Deno.env.delete("GITHUB_CLIENT_ID");

  // Make request without API key
  // Verify request succeeds
});
```

---

### Project Structure Notes

**Files to Create:**

```
src/
├── lib/
│   └── auth.ts                 # NEW: Shared auth module
└── web/
    └── routes/
        └── _middleware.ts      # NEW: Fresh auth middleware
```

**Files to Modify:**

```
src/
└── mcp/
    └── gateway-server.ts       # ADD: ~15 lines for auth validation
```

**Tests to Create:**

```
tests/
├── unit/
│   ├── lib/
│   │   └── auth_test.ts        # NEW: Auth module tests
│   └── web/
│       └── middleware_test.ts  # NEW: Middleware tests
└── integration/
    └── auth/
        └── api_server_auth_test.ts  # NEW: API Server auth tests
```

---

### Reuse from Previous Stories

| Component                 | Location                     | Usage                     |
| ------------------------- | ---------------------------- | ------------------------- |
| `getApiKeyPrefix()`       | `src/lib/api-key.ts`         | Extract prefix for lookup |
| `verifyApiKey()`          | `src/lib/api-key.ts`         | Verify key against hash   |
| `users` schema            | `src/db/schema/users.ts`     | User lookup by prefix     |
| `getDb()`                 | `src/server/auth/db.ts`      | Database access           |
| `getSessionFromRequest()` | `src/server/auth/session.ts` | Session validation        |

---

### Security Requirements

- **API Key never logged** - only prefix logged for debugging
- **401 response** - consistent JSON format: `{ error: "Unauthorized" }`
- **Local mode explicit** - logged at startup, no silent bypass
- **Session validation** - uses existing Deno KV session store from Story 9.2
- **Format validation first** - reject invalid format before DB lookup (fail fast)

### Integration Notes

- **Rate limiting:** Auth validation happens BEFORE rate limiting in request flow. Story 9.5 will
  add user-based rate limiting using `auth.user_id`.
- **Request context:** Consider caching `AuthResult` on request to avoid re-validation if multiple
  handlers need it.

---

### Environment Variables

```bash
# Cloud mode - enables auth
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx

# Local mode - NO env vars needed
# Auth is automatically bypassed
```

---

### References

- **Tech-Spec:**
  [tech-spec-github-auth-multitenancy.md](tech-spec-github-auth-multitenancy.md#phase-3-mode-detection)
- **Epic Definition:** [docs/epics.md#story-93](../epics.md) - Story 9.3
- **Previous Story:** [9-2-github-oauth-auth-routes.md](9-2-github-oauth-auth-routes.md)
- **API Key Helpers:**
  [9-1-infrastructure-auth-schema-helpers.md](9-1-infrastructure-auth-schema-helpers.md)

## Dev Agent Record

### Context Reference

Story context created by create-story workflow on 2025-12-08.

### Agent Model Used

Claude Sonnet 4 (Cascade)

### Debug Log References

N/A - Clean implementation with no debug issues.

### Completion Notes List

- ✅ Created `src/lib/auth.ts` shared auth module with `isCloudMode()`, `getDefaultUserId()`,
  `validateRequest()`, `validateApiKeyFromDb()`, and `logAuthMode()` functions
- ✅ Created `src/web/routes/_middleware.ts` Fresh middleware for session-based auth with
  cloud/local mode support
- ✅ Created `src/web/route-guards.ts` for testable route classification functions
  (`isProtectedRoute()`, `isPublicRoute()`)
- ✅ Added auth validation in `gateway-server.ts` after CORS preflight (~20 lines), skipping
  `/health` endpoint
- ✅ Added startup logging in both API Server and Fresh Dashboard
- ✅ 37 tests passing: 11 auth unit tests, 16 middleware tests, 10 integration tests
- ✅ All 7 ACs validated

### File List

**New Files:**

- `src/lib/auth.ts` - Shared auth module with mode detection and validation
- `src/web/routes/_middleware.ts` - Fresh auth middleware
- `src/web/route-guards.ts` - Testable route classification functions
- `tests/unit/lib/auth_test.ts` - Auth module unit tests (11 tests)
- `tests/unit/web/middleware_test.ts` - Middleware route tests (16 tests)
- `tests/integration/auth/api_server_auth_test.ts` - API Server auth integration tests (10 tests)

**Modified Files:**

- `src/mcp/gateway-server.ts` - Added auth validation after CORS preflight, startup logging
- `src/web/dev.ts` - Added auth mode startup logging
- `.env.example` - Added GitHub OAuth documentation and renamed PORT_DASHBOARD to FRESH_PORT
- `tests/integration/dashboard_endpoints_test.ts` - Port change 3001→3006, constructor fix
- `tests/integration/mcp_gateway_e2e_test.ts` - Constructor fix for
  capabilityStore/adaptiveThresholdManager
- `tests/unit/mcp/gateway_server_test.ts` - Constructor fix, meta-tools count 7→8

## Change Log

- 2025-12-08: Story 9.3 implemented - Auth middleware & mode detection for dual-server architecture
  (37 tests passing)
