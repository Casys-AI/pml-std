# ADR-046: BFF Pattern for Fresh Dashboard

**Status:** Ready for Implementation **Date:** 2025-12-10 | **Deciders:** Architecture Team
**Tech-Spec Source:** `docs/tech-specs/tech-spec-fresh-bff-refactoring.md`

## Context

### Problem

When building the Fresh dashboard for production with Vite, PGLite gets bundled into the server
output. PGLite's binary assets (`vector.tar.gz`, `pglite.data`) use relative paths that break after
bundling:

```
Error: Extension bundle not found: file:///home/ubuntu/.../src/web/_fresh/vector.tar.gz
```

**Root cause:** Fresh routes (`callback.ts`, `regenerate.ts`, etc.) import `getDb()` which pulls
PGLite into the Vite bundle.

### Fresh Community Recommendation

The Fresh community recommends the **BFF (Backend For Frontend) pattern** for database operations:

- Fresh should be a thin UI layer
- All database operations delegated to a backend API
- No direct database imports in Fresh code

## Decision

### Architecture: Fresh as Pure BFF

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
                      │ HTTP + x-internal-secret header
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Gateway API - Port 3001/3003                               │
│  ✅ PGLite database access                                  │
│  ✅ User management endpoints                               │
│  ✅ MCP + public API                                        │
└─────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Fresh never imports PGLite directly**
   - All DB operations go through Gateway API
   - No bundling issues with PGLite binary assets

2. **Internal API authentication via shared secret**
   - `x-internal-secret`: Secret shared between Fresh and Gateway
   - `x-internal-user-id`: User ID extracted from session
   - Same mechanism in dev and prod (dev/prod parity)

3. **Endpoint prefix `/api/internal/`**
   - Clearly separates internal endpoints from public API
   - Protected by `x-internal-secret` validation

4. **Session data optimization**
   - Store user data in KV session at login time
   - Reduces HTTP calls for static user data
   - Fresh only calls Gateway for mutations

### Internal API Endpoints

```
POST /api/internal/users/upsert-oauth     # OAuth callback
POST /api/internal/users/regenerate-api-key
GET  /api/internal/users/me
DELETE /api/internal/users/me
POST /api/internal/algorithm-feedback
```

### Gateway Client Utility

```typescript
// src/web/utils/gateway-client.ts
const GATEWAY_URL = Deno.env.get("GATEWAY_URL") || "http://localhost:3003";
const INTERNAL_SECRET = Deno.env.get("INTERNAL_API_SECRET");

function internalHeaders(userId?: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "x-internal-secret": INTERNAL_SECRET!,
    ...(userId && { "x-internal-user-id": userId }),
  };
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
```

## Consequences

### Positive

- Production builds work without PGLite bundling issues
- Clear separation of concerns (UI vs data layer)
- Fresh becomes stateless and horizontally scalable
- Follows Fresh community best practices
- Existing Islands already use this pattern (GraphExplorer, MetricsPanel)

### Negative

- Additional HTTP hop for all DB operations
- Gateway must be running for Fresh to work
- Slightly increased latency for user operations

### Neutral

- OAuth flow stays on Fresh (uses Deno KV, not PGLite)
- Session storage stays in Deno KV

## Environment Configuration

```bash
# .env (dev)
GATEWAY_URL=http://localhost:3003
INTERNAL_API_SECRET=dev-internal-secret-12345

# .env.production
GATEWAY_URL=http://localhost:3001
INTERNAL_API_SECRET=<64-char-hex-secret>
```

## Acceptance Criteria

- [ ] `deno task prod:build` completes without PGLite bundling errors
- [ ] OAuth login flow works (new user gets API key)
- [ ] API key regeneration works
- [ ] Settings page displays user info
- [ ] Account deletion works
- [ ] No PGLite imports in `src/web/` directory

## Related

- **Tech-Spec**: `docs/tech-specs/tech-spec-fresh-bff-refactoring.md`
- **External**: [BFF Pattern | Auth0](https://auth0.com/blog/the-backend-for-frontend-pattern-bff/)
- **External**:
  [Fresh Database Discussion | GitHub](https://github.com/denoland/fresh/discussions/436)
