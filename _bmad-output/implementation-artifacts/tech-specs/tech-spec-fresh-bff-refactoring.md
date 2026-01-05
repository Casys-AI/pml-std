# Tech-Spec: Fresh BFF Refactoring - Separate DB Access from Frontend

**Created:** 2025-12-10 **Status:** Ready for Development

## Overview

### Problem Statement

When building the Fresh dashboard for production with Vite, PGLite gets bundled into the server
output. PGLite's binary assets (`vector.tar.gz`, `pglite.data`) use relative paths that break after
bundling, causing runtime errors:

```
Error: Extension bundle not found: file:///home/ubuntu/CascadeProjects/Casys PML/src/web/_fresh/vector.tar.gz
```

**Root cause:** Fresh routes (`callback.ts`, `regenerate.ts`, etc.) import `getDb()` which pulls
PGLite into the Vite bundle.

### Solution

Apply the **BFF (Backend For Frontend) pattern** recommended by the Fresh community:

- Fresh remains a thin UI layer with OAuth and session management
- All database operations are delegated to the Gateway API via HTTP calls
- Fresh never imports PGLite directly

### Scope

**In Scope:**

- Create internal API endpoints on Gateway for user operations
- Refactor Fresh routes to call Gateway instead of accessing DB directly
- Remove all PGLite imports from Fresh codebase

**Out of Scope:**

- Changing the OAuth flow (stays on Fresh with `@deno/kv-oauth`)
- Changing session storage (stays in Deno KV)
- Modifying existing public Gateway API endpoints

## Context for Development

### Architecture Pattern (BFF)

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                    │
│  (Cookie session only, no tokens)                          │
└─────────────────────┬───────────────────────────────────────┘
                      │ Cookie HttpOnly (session_id)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Fresh Dashboard (BFF) - Port 8080                          │
│  ✅ OAuth flow (@deno/kv-oauth)                             │
│  ✅ Session storage (Deno KV)                               │
│  ✅ SSR + Islands                                           │
│  ❌ NO direct DB access                                     │
│  → Calls Gateway API for all DB operations                  │
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP + x-internal-user-id header
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Gateway API - Port 3001                                    │
│  ✅ PGLite database access                                  │
│  ✅ User management endpoints                               │
│  ✅ MCP + public API                                        │
└─────────────────────────────────────────────────────────────┘
```

### Codebase Patterns

**Current Fresh OAuth flow (keep as-is):**

- `src/server/auth/oauth.ts` - OAuth helpers using `@deno/kv-oauth`
- `src/server/auth/session.ts` - Session management with Deno KV
- `src/server/auth/kv.ts` - Shared KV singleton
- `src/web/routes/_middleware.ts` - Auth middleware

**Current problematic imports (to refactor):**

- `src/web/routes/auth/callback.ts` → imports `getDb()` from `server/auth/db.ts`
- `src/web/routes/auth/regenerate.ts` → imports `getDb()` from `server/auth/db.ts`
- `src/web/routes/dashboard/settings.tsx` → imports `getDb()` from `server/auth/db.ts`
- `src/web/routes/api/user/delete.ts` → imports `getDb()` from `db/client.ts`
- `src/web/routes/api/user/api-key.ts` → imports `getDb()` from `server/auth/db.ts`
- `src/web/routes/api/algorithm-feedback.ts` → imports `getDb()` from `db/client.ts`

### Files to Reference

| File                              | Purpose                                     |
| --------------------------------- | ------------------------------------------- |
| `src/mcp/gateway-server.ts`       | Add new internal endpoints here             |
| `src/server/auth/db.ts`           | Current DB access (will be unused by Fresh) |
| `src/db/schema/users.ts`          | User table schema                           |
| `src/lib/api-key.ts`              | API key generation/validation               |
| `src/web/routes/auth/callback.ts` | OAuth callback (needs refactoring)          |

### Technical Decisions

1. **Internal API authentication:** Use shared secret + user ID headers
   - `x-internal-secret`: Secret partagé entre Fresh et Gateway (vérifié sur chaque requête)
   - `x-internal-user-id`: ID de l'utilisateur extrait de la session KV
   - Même mécanisme en dev et prod (dev/prod parity) pour faciliter le debug
   - Valeurs différentes: secret simple en dev, secret fort en prod

2. **Endpoint prefix:** Use `/api/internal/` for Fresh-only endpoints
   - Clearly separates from public API
   - Protected by `x-internal-secret` validation

3. **Error handling:** Gateway returns standard JSON errors
   - Fresh routes handle errors and show appropriate UI

4. **Session data optimization:** Store user data in KV session at login
   - Reduces HTTP calls for static user data (username, avatar, apiKeyPrefix)
   - Fresh only calls Gateway for mutations (create, update, delete)

## Implementation Plan

### Task 1: Create Internal User API on Gateway

**File:** `src/mcp/gateway-server.ts`

Add new endpoints:

```typescript
// POST /api/internal/users/upsert-oauth
// Called by Fresh callback.ts after OAuth success
// Body: { githubId, username, email, avatarUrl }
// Returns: { user, apiKey? (if new user) }

// POST /api/internal/users/regenerate-api-key
// Called by Fresh regenerate.ts
// Header: x-internal-user-id
// Returns: { key, prefix }

// GET /api/internal/users/me
// Called by Fresh settings.tsx
// Header: x-internal-user-id
// Returns: { user }

// DELETE /api/internal/users/me
// Called by Fresh delete.ts
// Header: x-internal-user-id
// Returns: { success }

// POST /api/internal/algorithm-feedback
// Called by Fresh algorithm-feedback.ts
// Header: x-internal-user-id
// Body: { action, context }
// Returns: { success }
```

**Implementation details:**

- Extract user operations from current route handlers
- Reuse existing `getDb()` (stays in Gateway, no bundling issue)
- Add localhost-only check for `/api/internal/*` routes

### Task 2: Create Fresh API Client Utility

**File:** `src/web/utils/gateway-client.ts` (new)

```typescript
/**
 * Gateway API Client for Fresh BFF
 * All DB operations go through this client
 * Uses shared secret for internal API authentication (dev/prod parity)
 */

const GATEWAY_URL = Deno.env.get("GATEWAY_URL") || "http://localhost:3003";
const INTERNAL_SECRET = Deno.env.get("INTERNAL_API_SECRET");

if (!INTERNAL_SECRET) {
  console.warn("⚠️ INTERNAL_API_SECRET not set - internal API calls will fail");
}

/** Common headers for all internal API calls */
function internalHeaders(userId?: string): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "x-internal-secret": INTERNAL_SECRET!,
  };
  if (userId) {
    headers["x-internal-user-id"] = userId;
  }
  return headers;
}

export async function upsertOAuthUser(data: OAuthUserData): Promise<UpsertResult> {
  const response = await fetch(`${GATEWAY_URL}/api/internal/users/upsert-oauth`, {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`Gateway error: ${response.status}`);
  return response.json();
}

export async function regenerateApiKey(userId: string): Promise<ApiKeyResult> {
  const response = await fetch(`${GATEWAY_URL}/api/internal/users/regenerate-api-key`, {
    method: "POST",
    headers: internalHeaders(userId),
  });
  if (!response.ok) throw new Error(`Gateway error: ${response.status}`);
  return response.json();
}

export async function deleteUser(userId: string): Promise<void> {
  const response = await fetch(`${GATEWAY_URL}/api/internal/users/me`, {
    method: "DELETE",
    headers: internalHeaders(userId),
  });
  if (!response.ok) throw new Error(`Gateway error: ${response.status}`);
}

export async function recordAlgorithmFeedback(
  userId: string,
  feedback: FeedbackData,
): Promise<void> {
  const response = await fetch(`${GATEWAY_URL}/api/internal/algorithm-feedback`, {
    method: "POST",
    headers: internalHeaders(userId),
    body: JSON.stringify(feedback),
  });
  if (!response.ok) throw new Error(`Gateway error: ${response.status}`);
}
```

**File:** `src/mcp/gateway-server.ts` (add validation helper)

```typescript
/**
 * Validate internal API request from Fresh BFF
 * Checks x-internal-secret header matches env variable
 */
function validateInternalRequest(req: Request): boolean {
  const secret = req.headers.get("x-internal-secret");
  const expectedSecret = Deno.env.get("INTERNAL_API_SECRET");

  if (!expectedSecret) {
    log.warn("INTERNAL_API_SECRET not configured");
    return false;
  }

  return secret === expectedSecret;
}

// Usage in route handler:
if (url.pathname.startsWith("/api/internal/")) {
  if (!validateInternalRequest(req)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized", message: "Invalid internal secret" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  // ... handle internal routes
}
```

### Task 3: Refactor Fresh Routes

**3.1 - callback.ts**

```typescript
// BEFORE
import { getDb } from "../../../server/auth/db.ts";
// ... direct DB insert

// AFTER
import { upsertOAuthUser } from "../../utils/gateway-client.ts";
// ...
const { user, apiKey } = await upsertOAuthUser({
  githubId: ghUser.id.toString(),
  username: ghUser.login,
  email: ghEmail,
  avatarUrl: ghUser.avatar_url,
});
```

**3.2 - regenerate.ts**

```typescript
// BEFORE
import { getDb } from "../../../server/auth/db.ts";
// ... direct DB update

// AFTER
import { regenerateApiKey } from "../../utils/gateway-client.ts";
// ...
const { key, prefix } = await regenerateApiKey(session.userId);
```

**3.3 - settings.tsx**

```typescript
// BEFORE
import { getDb } from "../../../server/auth/db.ts";
// ... direct DB query

// AFTER
import { getUser } from "../../utils/gateway-client.ts";
// ...
const user = await getUser(session.userId);
```

**3.4 - api/user/delete.ts**

```typescript
// BEFORE
import { getDb } from "../../../../server/auth/db.ts";
import { getDb as getPGliteDb } from "../../../../db/client.ts";
// ... direct DB delete + anonymization

// AFTER
import { deleteUser } from "../../../utils/gateway-client.ts";
// ...
await deleteUser(session.userId);
```

**3.5 - api/user/api-key.ts**

```typescript
// BEFORE
import { getDb } from "../../../../server/auth/db.ts";

// AFTER
import { getUser } from "../../../utils/gateway-client.ts";
```

**3.6 - api/algorithm-feedback.ts**

```typescript
// BEFORE
import { getDb } from "../../../db/client.ts";

// AFTER
import { recordAlgorithmFeedback } from "../../utils/gateway-client.ts";
```

### Task 4: Remove Unused DB Code from Fresh

- Delete or deprecate `src/server/auth/db.ts` (no longer used by Fresh)
- Verify no other Fresh files import PGLite
- Run `deno task prod:build` to confirm no bundling errors

### Task 5: Add Environment Configuration

**File:** `.env` (dev)

```bash
# Gateway URL for Fresh BFF calls
GATEWAY_URL=http://localhost:3003

# Internal API secret (same mechanism as prod, simple value for dev)
INTERNAL_API_SECRET=dev-internal-secret-12345
```

**File:** `.env.production`

```bash
# Gateway URL for Fresh BFF calls
GATEWAY_URL=http://localhost:3001

# Internal API secret (generate with: openssl rand -hex 32)
INTERNAL_API_SECRET=<your-64-char-hex-secret>
```

**Dev/Prod Parity:** Same code, same validation, different secret values.

### Task 6: Testing

- Unit tests for `gateway-client.ts`
- Integration test: OAuth flow end-to-end
- Manual test: Production build + deploy

## Acceptance Criteria

- [ ] AC1: `deno task prod:build` completes without PGLite bundling errors
- [ ] AC2: Dashboard starts successfully in production (`casys-dashboard` service)
- [ ] AC3: OAuth login flow works (new user gets API key)
- [ ] AC4: API key regeneration works
- [ ] AC5: Settings page displays user info
- [ ] AC6: Account deletion works
- [ ] AC7: Algorithm feedback recording works
- [ ] AC8: No PGLite imports in `src/web/` directory (verified via grep)

## Additional Context

### Dependencies

- Gateway API must be running for Fresh to work
- Both services share the same Deno KV for sessions (already the case)

### Testing Strategy

1. **Unit tests:** Mock fetch for gateway-client.ts
2. **Integration tests:** Real Gateway + Fresh, test OAuth flow
3. **Smoke test:** Production deploy, manual login test

### Rollback Plan

If issues arise:

1. Revert to previous Fresh routes (git revert)
2. Use quick-fix (externalize PGLite in vite.config.ts) as temporary measure

### References

- [BFF Pattern | Auth0](https://auth0.com/blog/the-backend-for-frontend-pattern-bff/)
- [Fresh Database Discussion | GitHub](https://github.com/denoland/fresh/discussions/436)
- [deno-fresh-oauth | GitHub](https://github.com/cdoremus/deno-fresh-oauth)
- [Deno KV OAuth | GitHub](https://github.com/denoland/deno_kv_oauth)

### Notes

- This refactoring follows the Fresh community recommendation: "API-first approach for DB
  operations"
- The same pattern is used by the existing Islands (GraphExplorer, MetricsPanel) which already call
  Gateway API
- After this change, Fresh becomes a pure BFF: OAuth + Sessions + UI rendering only
