# Story 9.2: GitHub OAuth & Auth Routes

Status: done

## Story

As a cloud user, I want to authenticate via GitHub OAuth, So that I can access the dashboard and get
my API key.

## Acceptance Criteria

1. **AC1:** Deno KV OAuth configured for GitHub (`src/server/auth/oauth.ts`)
2. **AC2:** OAuth routes created in Fresh (`src/web/routes/auth/`)
3. **AC3:** Callback creates/updates user in `users` table + generates API Key
4. **AC4:** Session stored in Deno KV with 30-day TTL
5. **AC5:** Signout destroys session and redirects to landing
6. **AC6:** Regenerate route invalidates old key and generates new one
7. **AC7:** CSRF protection via state parameter (built into kv-oauth)

## Tasks / Subtasks

- [x] **Task 1: Configure Deno KV OAuth** (AC: #1, #7)

  - [x] 1.1 Add `jsr:@deno/kv-oauth` dependency to `deno.json`
  - [x] 1.2 Create `src/server/auth/oauth.ts` with GitHub OAuth helpers
  - [x] 1.3 Create `src/server/auth/session.ts` for session management

- [x] **Task 2: Create Fresh Auth Routes** (AC: #2, #3, #4, #5)

  - [x] 2.1 Create `src/web/routes/auth/` directory
  - [x] 2.2 Implement `signin.ts` → `GET /auth/signin`
  - [x] 2.3 Implement `callback.ts` → `GET /auth/callback`
  - [x] 2.4 Implement `signout.ts` → `GET /auth/signout`

- [x] **Task 3: Implement Callback User Flow** (AC: #3, #4)

  - [x] 3.1 Fetch GitHub user profile via API
  - [x] 3.2 Upsert user in `users` table via Drizzle
  - [x] 3.3 Generate API Key if first login (use existing `generateApiKey()`)
  - [x] 3.4 Create session in Deno KV with 30-day TTL

- [x] **Task 4: Implement API Key Regeneration** (AC: #6)

  - [x] 4.1 Create `src/web/routes/auth/regenerate.ts` → `POST /auth/regenerate`
  - [x] 4.2 Invalidate old key (update hash/prefix in DB)
  - [x] 4.3 Generate new key and return to user (show once)

- [x] **Task 5: Tests** (AC: all)
  - [x] 5.1 Unit tests for OAuth helpers (`tests/unit/server/auth/oauth_test.ts`)
  - [x] 5.2 Unit tests for session helpers (`tests/unit/server/auth/session_test.ts`)
  - [x] 5.3 Integration tests: mock GitHub OAuth flow
  - [x] 5.4 Integration tests: verify user creation and API Key generation

## Dev Notes

### Architecture: Fresh 2.x + Deno KV OAuth

**CRITICAL:** This story creates routes in Fresh 2.x (port 8080), NOT in the API Server (port 3003).

```
Fresh Dashboard (8080)        API Server (3003)
┌─────────────────────┐      ┌─────────────────────┐
│ src/web/routes/     │      │ gateway-server.ts   │
│ ├── auth/           │      │ (Story 9.3 adds     │
│ │   ├── signin.ts   │      │  API Key validation)│
│ │   ├── callback.ts │      │                     │
│ │   ├── signout.ts  │      │                     │
│ │   └── regenerate.ts      │                     │
│ ├── dashboard.tsx   │      └─────────────────────┘
│ └── index.tsx       │
└─────────────────────┘
```

### Deno KV OAuth Integration

The `@deno/kv-oauth` library provides:

- Built-in CSRF protection via state parameter
- PKCE flow support
- Session management with Deno KV

**OAuth configuration:**

```typescript
// src/server/auth/oauth.ts
import { createGitHubOAuthConfig, createHelpers } from "@deno/kv-oauth";

const oauthConfig = createGitHubOAuthConfig({
  scope: ["read:user", "user:email"],
});

export const { signIn, handleCallback, signOut, getSessionId } = createHelpers(oauthConfig);
```

**CRITICAL:** Import via `@deno/kv-oauth` (mapped in `deno.json`), NOT `jsr:@deno/kv-oauth` inline.

### Session Storage with Deno KV

```typescript
// src/server/auth/session.ts
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface Session {
  userId: string;
  username: string;
  avatarUrl?: string;
  createdAt: number;
}

export async function createSession(
  kv: Deno.Kv,
  sessionId: string,
  user: Session,
): Promise<void> {
  await kv.set(["sessions", sessionId], user, { expireIn: SESSION_TTL_MS });
}

export async function getSession(
  kv: Deno.Kv,
  sessionId: string,
): Promise<Session | null> {
  const result = await kv.get<Session>(["sessions", sessionId]);
  return result.value;
}

export async function destroySession(
  kv: Deno.Kv,
  sessionId: string,
): Promise<void> {
  await kv.delete(["sessions", sessionId]);
}
```

### Fresh Route Handlers Pattern

**CRITICAL:** Use `export const handler = { ... }` pattern (NOT `define.handlers`). See existing
routes in `src/web/routes/`.

**signin.ts:**

```typescript
// src/web/routes/auth/signin.ts
import { signIn } from "../../../server/auth/oauth.ts";

export const handler = {
  GET(ctx: any) {
    return signIn(ctx.req);
  },
};
```

**signout.ts:**

```typescript
// src/web/routes/auth/signout.ts
import { signOut } from "../../../server/auth/oauth.ts";

export const handler = {
  GET(ctx: any) {
    return signOut(ctx.req);
  },
};
```

**callback.ts (core logic):**

```typescript
// src/web/routes/auth/callback.ts
import { handleCallback } from "../../../server/auth/oauth.ts";
import { getDb } from "../../../server/auth/db.ts";
import { users } from "../../../db/schema/users.ts";
import { generateApiKey, hashApiKey } from "../../../lib/api-key.ts";
import { createSession, setFlashApiKey } from "../../../server/auth/session.ts";
import { eq } from "drizzle-orm";

export const handler = {
  async GET(ctx: any) {
    // 1. Handle OAuth callback - get tokens and session ID
    const { response, tokens, sessionId } = await handleCallback(ctx.req);

    // 2. Fetch GitHub user profile + email
    const [ghUser, ghEmail] = await Promise.all([
      fetchGitHubUser(tokens.accessToken),
      fetchGitHubPrimaryEmail(tokens.accessToken),
    ]);

    // 3. Upsert user in database
    const db = await getDb();
    let userRows = await db
      .select()
      .from(users)
      .where(eq(users.githubId, ghUser.id.toString()))
      .limit(1);

    let isNewUser = false;

    if (userRows.length === 0) {
      // First login: create user + generate API Key
      const { key, prefix } = generateApiKey();
      const keyHash = await hashApiKey(key);

      await db.insert(users).values({
        githubId: ghUser.id.toString(),
        username: ghUser.login,
        email: ghEmail, // Use fetched primary email
        avatarUrl: ghUser.avatar_url,
        apiKeyHash: keyHash,
        apiKeyPrefix: prefix,
        apiKeyCreatedAt: new Date(),
      });

      isNewUser = true;
      userRows = await db
        .select()
        .from(users)
        .where(eq(users.githubId, ghUser.id.toString()));

      // Store API key in flash session (NOT in URL for security)
      const kv = await Deno.openKv();
      await setFlashApiKey(kv, sessionId, key);
    }

    // 4. Create session in Deno KV
    const kv = await Deno.openKv();
    await createSession(kv, sessionId, {
      userId: userRows[0].id,
      username: userRows[0].username,
      avatarUrl: userRows[0].avatarUrl ?? undefined,
      createdAt: Date.now(),
    });

    // 5. Redirect to dashboard
    const redirectUrl = isNewUser ? "/dashboard?welcome=1" : "/dashboard";

    return new Response(null, {
      status: 302,
      headers: { ...response.headers, Location: redirectUrl },
    });
  },
};

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const resp = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!resp.ok) throw new Error("Failed to fetch GitHub user");
  return resp.json();
}

// Fetch primary verified email (user:email scope required)
async function fetchGitHubPrimaryEmail(
  accessToken: string,
): Promise<string | null> {
  const resp = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!resp.ok) return null;
  const emails: Array<{ email: string; primary: boolean; verified: boolean }> = await resp.json();
  const primary = emails.find((e) => e.primary && e.verified);
  return primary?.email ?? null;
}

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string;
}
```

**SECURITY:** API key stored in flash session (Deno KV with 5min TTL), NOT passed in URL query
string.

### Reuse from Story 9.1

**CRITICAL:** Use existing implementations from Story 9.1:

| Component               | Location                 | Usage                                    |
| ----------------------- | ------------------------ | ---------------------------------------- |
| `generateApiKey()`      | `src/lib/api-key.ts`     | Generate new API keys                    |
| `hashApiKey()`          | `src/lib/api-key.ts`     | Hash keys for storage                    |
| `verifyApiKey()`        | `src/lib/api-key.ts`     | Verify keys (not used here, used in 9.3) |
| `users` schema          | `src/db/schema/users.ts` | User table definition                    |
| `createDrizzleClient()` | `src/db/drizzle.ts`      | Database client                          |

### API Key Regeneration Flow

```typescript
// src/web/routes/auth/regenerate.ts
import { getDb } from "../../../server/auth/db.ts";
import { getSessionFromRequest } from "../../../server/auth/session.ts";
import { users } from "../../../db/schema/users.ts";
import { generateApiKey, hashApiKey } from "../../../lib/api-key.ts";
import { eq } from "drizzle-orm";

export const handler = {
  async POST(ctx: any) {
    // 1. Verify session exists
    const session = await getSessionFromRequest(ctx.req);
    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. Generate new API Key
    const { key, prefix } = generateApiKey();
    const keyHash = await hashApiKey(key);

    // 3. Update user in database (invalidates old key)
    const db = await getDb();
    await db
      .update(users)
      .set({
        apiKeyHash: keyHash,
        apiKeyPrefix: prefix,
        apiKeyCreatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, session.userId));

    // 4. Return new key (show ONCE)
    return new Response(
      JSON.stringify({
        key,
        prefix,
        message: "API Key regenerated. Save this key - it won't be shown again.",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  },
};
```

### Database Access Helper

```typescript
// src/server/auth/db.ts
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import {
  createDrizzleClient,
  runDrizzleMigrations,
  type DrizzleDB,
} from "../../db/drizzle.ts";
import { getCasys PMLDatabasePath } from "../../cli/utils.ts";

let db: DrizzleDB | null = null;
let pgliteInstance: PGlite | null = null;

/**
 * Get shared Drizzle database instance for auth operations
 * Lazily initializes on first call
 * Uses same DB path as API server for data consistency
 */
export async function getDb(): Promise<DrizzleDB> {
  if (!db) {
    // Initialize PGlite with vector extension (consistent with src/db/client.ts)
    pgliteInstance = new PGlite(getCasys PMLDatabasePath(), {
      extensions: { vector },
    });
    db = createDrizzleClient(pgliteInstance);
    await runDrizzleMigrations(db);
  }
  return db;
}

/**
 * Close database connection (for graceful shutdown)
 */
export async function closeDb(): Promise<void> {
  if (pgliteInstance) {
    await pgliteInstance.close();
    pgliteInstance = null;
    db = null;
  }
}
```

**NOTE:** Uses same DB path as API Server (`getCasys PMLDatabasePath()`) for data consistency
between ports 3003 and 8080.

### Extended Session Helpers

```typescript
// src/server/auth/session.ts - Additional helpers
const FLASH_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Store API key in flash session (shown once to user)
 */
export async function setFlashApiKey(
  kv: Deno.Kv,
  sessionId: string,
  apiKey: string,
): Promise<void> {
  await kv.set(["flash_api_key", sessionId], apiKey, {
    expireIn: FLASH_TTL_MS,
  });
}

/**
 * Get and consume flash API key (returns null if already consumed)
 */
export async function consumeFlashApiKey(
  kv: Deno.Kv,
  sessionId: string,
): Promise<string | null> {
  const result = await kv.get<string>(["flash_api_key", sessionId]);
  if (result.value) {
    await kv.delete(["flash_api_key", sessionId]);
  }
  return result.value;
}

/**
 * Get session from request cookie
 */
export async function getSessionFromRequest(
  req: Request,
): Promise<Session | null> {
  const { getSessionId } = await import("./oauth.ts");
  const sessionId = await getSessionId(req);
  if (!sessionId) return null;

  const kv = await Deno.openKv();
  return await getSession(kv, sessionId);
}
```

### Project Structure Notes

**Files to Create:**

```
src/
├── server/
│   └── auth/                    # NEW: Auth helpers
│       ├── oauth.ts             # OAuth configuration
│       ├── session.ts           # Session management + flash helpers
│       └── db.ts                # Shared Drizzle instance
└── web/
    └── routes/
        └── auth/                # NEW: Auth routes
            ├── signin.ts
            ├── callback.ts
            ├── signout.ts
            └── regenerate.ts
```

**Dependency to Add (`deno.json`):**

```json
{
  "imports": {
    "@deno/kv-oauth": "jsr:@deno/kv-oauth@^0.11.0"
  }
}
```

### Environment Variables (Cloud Mode)

```bash
# Required for OAuth to work
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
AUTH_REDIRECT_URL=http://localhost:8080/auth/callback
```

**GitHub OAuth App Setup:**

1. Go to GitHub → Settings → Developer settings → OAuth Apps
2. Create new OAuth App
3. Set callback URL: `http://localhost:8080/auth/callback` (dev)
4. Copy Client ID and Client Secret

### Security Requirements

- **Cookie flags:** HttpOnly, Secure (prod), SameSite=Lax
- **API Key:** Shown ONCE via flash session (5min TTL), never in URL, never retrievable after
- **CSRF:** Built into kv-oauth via state parameter
- **Session:** Stored in Deno KV with 30-day expiration
- **Argon2id:** Used for API Key hashing (from Story 9.1)
- **Rate limiting:** Auth routes (`/auth/*`) should have rate limiting to prevent brute force -
  reuse `src/lib/rate-limiter.ts` pattern (Story 9.5 will formalize)

### Testing Strategy

```typescript
// tests/unit/server/auth/oauth_test.ts
Deno.test("createOAuthHelpers - returns valid helpers", () => {
  // Verify all helper functions exist
  const helpers = createOAuthHelpers();
  assertExists(helpers.signIn);
  assertExists(helpers.handleCallback);
  assertExists(helpers.signOut);
  assertExists(helpers.getSessionId);
});

// tests/unit/server/auth/session_test.ts
Deno.test("createSession/getSession - roundtrip", async () => {
  const kv = await Deno.openKv(":memory:");
  const session = {
    userId: "test-id",
    username: "testuser",
    createdAt: Date.now(),
  };

  await createSession(kv, "session-123", session);
  const retrieved = await getSession(kv, "session-123");

  assertEquals(retrieved?.userId, session.userId);
  kv.close();
});

// tests/integration/auth/oauth_flow_test.ts
Deno.test("OAuth callback - creates user on first login", async () => {
  // Mock GitHub API response
  // Call callback endpoint with mock tokens
  // Verify user created in database
  // Verify API Key generated
  // Verify session created
});
```

### References

- **Tech-Spec:**
  [tech-spec-github-auth-multitenancy.md](tech-spec-github-auth-multitenancy.md#phase-2-routes--middleware-dual-server)
- **Epic Definition:** [docs/epics.md#story-92](../epics.md) - Story 9.2
- **Previous Story:**
  [9-1-infrastructure-auth-schema-helpers.md](9-1-infrastructure-auth-schema-helpers.md)
- **Deno KV OAuth Docs:** https://deno.land/x/deno_kv_oauth
- **Fresh 2.x Handlers:** https://fresh.deno.dev/docs/concepts/handlers

## Dev Agent Record

### Context Reference

Story context created by create-story workflow on 2025-12-08.

### Agent Model Used

Claude Sonnet 4 (Cascade)

### Debug Log References

- None required

### Completion Notes List

- Implemented lazy OAuth initialization to avoid requiring env vars at module load (enables testing)
- All 25 tests passing (16 unit + 4 integration + 5 API key tests)
- OAuth helpers use @deno/kv-oauth with built-in CSRF protection via state parameter
- Session management with 30-day TTL in Deno KV
- Flash API key pattern for secure one-time display (5-min TTL)
- Callback flow: fetches GitHub profile + primary email, upserts user, generates API key for new
  users
- API key regeneration invalidates old key by replacing hash/prefix

### Senior Developer Review (AI)

**Reviewer:** Erwan | **Date:** 2025-12-08 | **Outcome:** Approved with fixes

**Issues Fixed:**

- **H1/M4 (KV Connection Leak):** Created `src/server/auth/kv.ts` singleton to prevent connection
  leaks. All auth modules now use shared `getKv()` instead of `Deno.openKv()`.
- **H2 (Missing Error Handling):** Added try/catch in `callback.ts` with proper error redirect to
  `/auth/signin?error=callback_failed`.
- **L1 (Signout Error Handling):** Added try/catch in `signout.ts` with fallback redirect to landing
  page.
- **Test Coverage:** Added 3 new tests for KV singleton behavior (`kv_test.ts`).

**Notes:**

- OAuth unit tests remain existence-only checks (behavioral tests require env vars)
- All 33 tests passing after fixes (25 auth + 8 paths)

### Change Log

- 2025-12-08: Review #2 - Added paths.ts module for robust path resolution, +8 tests
- 2025-12-08: Code review fixes - KV singleton, error handling, +3 tests
- 2025-12-08: Initial implementation of GitHub OAuth auth routes (all 5 tasks completed)

### File List

**Created:**

- `src/server/auth/oauth.ts` - OAuth configuration with GitHub provider (lazy init)
- `src/server/auth/session.ts` - Session + flash API key helpers
- `src/server/auth/db.ts` - Shared Drizzle instance for auth
- `src/server/auth/kv.ts` - Shared Deno KV singleton (review fix)
- `src/web/routes/auth/signin.ts` - GET /auth/signin
- `src/web/routes/auth/callback.ts` - GET /auth/callback (core OAuth flow)
- `src/web/routes/auth/signout.ts` - GET /auth/signout
- `src/web/routes/auth/regenerate.ts` - POST /auth/regenerate
- `tests/unit/server/auth/oauth_test.ts` - 5 tests
- `tests/unit/server/auth/session_test.ts` - 6 tests
- `tests/unit/server/auth/db_test.ts` - 2 tests
- `tests/unit/server/auth/kv_test.ts` - 3 tests (review fix)
- `tests/integration/auth/oauth_flow_test.ts` - 4 integration tests
- `src/lib/paths.ts` - Centralized path resolution (review #2)
- `tests/unit/lib/paths_test.ts` - 8 tests (review #2)

**Modified:**

- `deno.json` - Added `"@deno/kv-oauth": "jsr:@deno/kv-oauth@^0.11.0"`, added `--env` flag to dev
  tasks
- `src/cli/utils.ts` - Use `resolvePath()` for DB path
- `src/db/drizzle.ts` - Use `resolvePath()` for migrations folder
