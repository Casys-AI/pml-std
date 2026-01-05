# Story 9.4: Landing Page & Dashboard UI (Auth Additions)

Status: done

## Story

As a new user, I want a landing page with GitHub sign-in and a dashboard showing my API key, So that
I can easily onboard and configure my MCP client.

## Acceptance Criteria

1. **AC1:** Landing page header shows "Sign in with GitHub" button in cloud mode
2. **AC2:** Landing page header shows "Local mode" badge when `!isCloudMode()`
3. **AC3:** Dashboard header displays user avatar + username with link to Settings
4. **AC4:** Settings page (`/dashboard/settings`) shows masked API key with Show/Copy buttons
5. **AC5:** Settings page shows MCP configuration snippet (HTTP transport for cloud, stdio for
   local)
6. **AC6:** MCP config uses `${PML_API_KEY}` env var expansion (API key never in clear text in JSON)
7. **AC7:** Settings page has "Regenerate API Key" button with confirmation modal
8. **AC8:** Settings page has "Delete Account" button with double confirmation
9. **AC9:** Delete flow anonymizes user data (`user_id` → `deleted-{uuid}`)
10. **AC10:** Conditional rendering based on `isCloudMode()` - local mode skips auth sections
11. **AC11:** E2E tests (optional) for Landing → Sign in → Dashboard flow

## Tasks / Subtasks

- [x] **Task 1: Landing Page Auth Additions** (AC: #1, #2, #10)

  - [x] 1.1 Add "Sign in with GitHub" button to header (cloud mode only)
  - [x] 1.2 Add "Local mode" badge to header when `!isCloudMode()`
  - [x] 1.3 Use `isCloudMode()` from `src/lib/auth.ts` for conditional rendering
  - [x] 1.4 Style consistent with existing design system (accent color, fonts)

- [x] **Task 2: Dashboard Header Auth** (AC: #3, #10)

  - [x] 2.1 Add header bar with user avatar + username
  - [x] 2.2 Add Settings link/icon in header
  - [x] 2.3 Access user from Fresh context `ctx.state.user`
  - [x] 2.4 Local mode: show "Local User" with default avatar

- [x] **Task 3: Settings Page (NEW)** (AC: #4, #5, #6, #7, #8, #9, #10)

  - [x] 3.1 Create `src/web/routes/dashboard/settings.tsx`
  - [x] 3.2 Create API Key section with masked display (cloud mode only)
  - [x] 3.3 Implement "Show" button (reveals flash key if available)
  - [x] 3.4 Implement "Copy" button with toast notification
  - [x] 3.5 Create MCP Gateway Configuration section:
    - [x] 3.5.1 Cloud mode: HTTP transport config with `${PML_API_KEY}` env var
    - [x] 3.5.2 Local mode: stdio transport config (no API key)
    - [x] 3.5.3 Add setup instructions (export PML_API_KEY, copy to .mcp.json)
  - [x] 3.6 Implement "Copy Config" button
  - [x] 3.7 Create "Regenerate API Key" button with confirmation modal (cloud only)
  - [x] 3.8 Create "Delete Account" button with double confirmation (cloud only)
  - [x] 3.9 Implement delete flow (anonymization)

- [x] **Task 4: API Routes for Settings** (AC: #6, #7, #8)

  - [x] 4.1 Create `src/web/routes/api/user/api-key.ts` - GET current key prefix
  - [x] 4.2 Modify `src/web/routes/auth/regenerate.ts` to store key in flash session (for Settings
        page display)
  - [x] 4.3 Create `src/web/routes/api/user/delete.ts` - DELETE account

- [x] **Task 5: Tests** (AC: #11)
  - [x] 5.1 Unit tests for conditional rendering logic
  - [x] 5.2 Integration tests for Settings page API routes
  - [ ] 5.3 E2E tests (optional) with Playwright

## Dev Notes

### Architecture: Fresh 2.x with Auth State

The middleware (`src/web/routes/_middleware.ts`) already injects `AuthState` into Fresh context:

```typescript
export interface AuthState {
  user: {
    id: string;
    username: string;
    avatarUrl?: string;
  } | null;
  isCloudMode: boolean;
}
```

**Access in components:**

```typescript
// In route handler
export const handler = {
  GET(ctx: FreshContext<AuthState>) {
    const { user, isCloudMode } = ctx.state;
    return page({ user, isCloudMode });
  },
};

// In component
export default function Page({
  data,
}: {
  data: { user: User; isCloudMode: boolean };
}) {
  // ...
}
```

### Existing Design System

**CSS Variables (from `src/web/routes/index.tsx`):**

```css
--bg: #08080a;
--bg-elevated: #0f0f12;
--bg-card: #141418;
--accent: #ffb86f;
--accent-dim: rgba(255, 184, 111, 0.1);
--accent-medium: rgba(255, 184, 111, 0.2);
--text: #f0ede8;
--text-muted: #a8a29e;
--text-dim: #6b6560;
--border: rgba(255, 184, 111, 0.08);
--font-display: "Instrument Serif", Georgia, serif;
--font-sans: "Geist", -apple-system, system-ui, sans-serif;
--font-mono: "Geist Mono", monospace;
```

**Button Styles (existing):**

```css
.btn-primary {
  background: var(--accent);
  color: var(--bg);
  border: none;
}
.btn-ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
}
```

### API Key Display Logic

**CRITICAL:** The full API key is NEVER stored - only the hash. For display:

1. **First login (flash session):** Full key available via `consumeFlashApiKey()` for 5 minutes
2. **After flash expires:** Only prefix (`ac_xxxxxxxx`) is retrievable from DB
3. **Regenerate:** Creates new key, stores in flash session, user sees it once

```typescript
// src/server/auth/session.ts
export async function consumeFlashApiKey(
  kv: Deno.Kv,
  sessionId: string,
): Promise<string | null>;
export async function setFlashApiKey(
  kv: Deno.Kv,
  sessionId: string,
  apiKey: string,
): Promise<void>;
```

### Settings Page Structure

```
/dashboard/settings (Cloud Mode)
├── Section: Your API Key
│   ├── Masked display: ac_••••••••••••••••
│   ├── [Show] button → reveals for 5s (only if flash key available)
│   ├── [Copy] button → clipboard + toast
│   └── Note: "Clé visible une seule fois. Régénérez si perdue."
│
├── Section: MCP Gateway Configuration
│   ├── Tab: "Claude Code / Windsurf" (default)
│   │   ├── JSON code block: { "mcpServers": { "mcp-gateway": { ... } } }
│   │   ├── [Copy Config] button
│   │   └── Instructions: "1. Copier dans .mcp.json 2. export PML_API_KEY=..."
│   └── Tab: "Claude Desktop" (coming soon badge)
│
├── Section: Danger Zone
│   ├── [Regenerate API Key] → confirmation modal
│   └── [Delete Account] → double confirmation modal
│
└── Footer: "Running in cloud mode"

/dashboard/settings (Local Mode)
├── Section: MCP Gateway Configuration
│   ├── JSON code block: { "mcpServers": { "mcp-gateway": { "type": "stdio", ... } } }
│   ├── [Copy Config] button
│   └── Note: "Aucune API key requise en mode local"
│
└── Footer: "Running in local mode - no authentication required"
```

### MCP Gateway Configuration

**IMPORTANT:** PML utilise un transport **HTTP** en mode cloud (avec API key) et **stdio** en mode
local.

#### Mode Cloud (HTTP Transport) - Settings Page Display

La clé API est passée via variable d'environnement pour la sécurité (jamais en clair dans le JSON) :

```json
{
  "mcpServers": {
    "mcp-gateway": {
      "type": "http",
      "url": "https://pml.casys.ai/mcp",
      "headers": {
        "x-api-key": "${PML_API_KEY}"
      }
    }
  }
}
```

**Instructions à afficher à l'utilisateur :**

1. Copier la configuration ci-dessus dans `.mcp.json` (project scope) ou `~/.claude.json` (user
   scope)
2. Définir la variable d'environnement : `export PML_API_KEY="ac_xxx"`
3. Ou ajouter via CLI :
   `claude mcp add --transport http mcp-gateway https://pml.casys.ai/mcp --header "x-api-key: ${PML_API_KEY}"`

**Pourquoi HTTP et pas stdio en cloud ?**

- Le serveur est hébergé centralement (`pml.casys.ai`)
- stdio nécessiterait d'installer le CLI localement (friction)
- HTTP permet un onboarding instantané (zero install)

#### Mode Local (stdio Transport)

En mode local/self-hosted, aucune API key n'est nécessaire :

```json
{
  "mcpServers": {
    "mcp-gateway": {
      "type": "stdio",
      "command": "deno",
      "args": ["task", "mcp"],
      "cwd": "/path/to/casys-pml"
    }
  }
}
```

**Ou via CLI :**

```bash
claude mcp add --transport stdio mcp-gateway -- deno task mcp
```

#### Sécurité API Key

- **Ne JAMAIS hardcoder** la clé dans le JSON (utiliser `${PML_API_KEY}`)
- La variable d'environnement est expandue par Claude Code au runtime
- `.mcp.json` peut être committé en git (pas de secrets)
- L'utilisateur définit `PML_API_KEY` dans son shell profile (`.bashrc`, `.zshrc`)

### Delete Account Flow

1. User clicks "Delete Account"
2. First modal: "Are you sure? This will anonymize all your data."
3. Second modal: "Type DELETE to confirm"
4. Backend:
   ```sql
   -- NOTE: workflow_execution n'a pas encore de user_id (Story 9.5 ajoutera ce champ)
   -- Pour MVP, on supprime juste l'utilisateur
   DELETE FROM users WHERE id = ?;
   ```
5. Destroy session, redirect to landing page

### Project Structure Notes

**Files to Create:**

```
src/web/
├── routes/
│   ├── dashboard/
│   │   └── settings.tsx        # NEW: Settings page
│   └── api/
│       └── user/
│           ├── api-key.ts      # NEW: GET API key prefix
│           └── delete.ts       # NEW: DELETE account
└── components/
    └── AuthHeader.tsx          # NEW: Reusable auth header (optional)
```

**Files to Modify:**

```
src/web/routes/
├── index.tsx                   # ADD: ~30 lines for auth header
└── dashboard.tsx               # ADD: ~50 lines for user header
```

### Reuse from Previous Stories

| Component              | Location                            | Usage                                 |
| ---------------------- | ----------------------------------- | ------------------------------------- |
| `isCloudMode()`        | `src/lib/auth.ts`                   | Conditional rendering                 |
| `AuthState`            | `src/web/routes/_middleware.ts`     | User context                          |
| `consumeFlashApiKey()` | `src/server/auth/session.ts`        | One-time key display                  |
| `setFlashApiKey()`     | `src/server/auth/session.ts`        | Store key after regenerate            |
| `regenerate.ts`        | `src/web/routes/auth/regenerate.ts` | **MODIFY:** Add flash session storage |
| CSS variables          | `src/web/routes/index.tsx`          | Design tokens                         |
| Button styles          | `src/web/routes/index.tsx`          | `.btn-primary`, `.btn-ghost`          |

### Security Requirements

- **API Key never logged** - only prefix shown in UI
- **Flash session** - full key available only 5 minutes after generation
- **Delete confirmation** - requires typing "DELETE" to prevent accidents
- **Session destruction** - on account deletion, all sessions invalidated
- **CSRF protection** - POST requests use Fresh's built-in protection

### References

- **Tech-Spec:**
  [tech-spec-github-auth-multitenancy.md](tech-spec-github-auth-multitenancy.md#phase-4-ui-onboarding)
- **Epic Definition:** [docs/epics.md#story-94](../epics.md) - Story 9.4
- **Previous Story:** [9-3-auth-middleware-mode-detection.md](9-3-auth-middleware-mode-detection.md)
- **Auth Module:** [src/lib/auth.ts](../../src/lib/auth.ts)
- **Session Module:** [src/server/auth/session.ts](../../src/server/auth/session.ts)
- **Landing Page:** [src/web/routes/index.tsx](../../src/web/routes/index.tsx)
- **Dashboard:** [src/web/routes/dashboard.tsx](../../src/web/routes/dashboard.tsx)
- **MCP Docs (Claude Code):** [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp) -
  HTTP/SSE/stdio transports, env var expansion
- **MCP Spec:**
  [modelcontextprotocol.io/docs](https://modelcontextprotocol.io/docs/learn/architecture)

### Git Intelligence (Recent Commits)

Story 9.3 completed 2025-12-08:

- Created `src/lib/auth.ts` with `isCloudMode()`, `validateRequest()`
- Created `src/web/routes/_middleware.ts` with `AuthState`
- Created `src/web/route-guards.ts` for route classification
- 37 tests passing

### Implementation Hints

**1. Landing Page Header (Task 1):**

```tsx
// In header nav, after existing links:
{
  data.isCloudMode
    ? (
      <a href="/auth/signin" class="btn btn-primary btn-sm">
        <GitHubIcon /> Sign in with GitHub
      </a>
    )
    : <span class="badge badge-local">Local Mode</span>;
}
```

**2. Dashboard Header (Task 2):**

```tsx
// Add at top of dashboard, after "Back to PML" link:
<div class="dashboard-header">
  <div class="user-info">
    <img src={user.avatarUrl || "/default-avatar.svg"} class="avatar" />
    <span class="username">{user.username}</span>
  </div>
  <a href="/dashboard/settings" class="settings-link">
    <SettingsIcon />
  </a>
</div>;
```

**3. Settings Page Handler (Task 3):**

```tsx
export const handler = {
  async GET(ctx: FreshContext<AuthState>) {
    const { user, isCloudMode } = ctx.state;
    if (!user) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/auth/signin" },
      });
    }

    // Get API key prefix from DB (not full key)
    const db = await getDb();
    const userRecord = await db
      .select({ prefix: users.apiKeyPrefix })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const apiKeyPrefix = userRecord[0]?.prefix ?? null;

    // Check for flash API key (shown once after login/regenerate)
    const { getSessionId } = await import("../../../server/auth/oauth.ts");
    const { getKv } = await import("../../../server/auth/kv.ts");
    const sessionId = await getSessionId(ctx.req);
    const kv = await getKv();
    const flashApiKey = sessionId ? await consumeFlashApiKey(kv, sessionId) : null;

    return page({ user, isCloudMode, apiKeyPrefix, flashApiKey });
  },
};
```

**4. Delete Account API (Task 4):**

```typescript
// src/web/routes/api/user/delete.ts
export const handler = {
  async DELETE(ctx: FreshContext<AuthState>) {
    const { user } = ctx.state;
    if (!user || user.id === "local") {
      return new Response(
        JSON.stringify({ error: "Cannot delete local user" }),
        { status: 400 },
      );
    }

    const db = await getDb();
    const deletedId = `deleted-${crypto.randomUUID()}`;

    // NOTE: Data isolation (Story 9.5) will add user_id to workflow_execution
    // For now, we just delete the user record
    // Future: await db.update(workflowExecution).set({ userId: deletedId }).where(eq(...));

    // Delete user
    await db.delete(users).where(eq(users.id, user.id));

    // Destroy session
    const { getSessionId } = await import("../../../server/auth/oauth.ts");
    const { getKv } = await import("../../../server/auth/kv.ts");
    const { destroySession } = await import("../../../server/auth/session.ts");
    const sessionId = await getSessionId(ctx.req);
    const kv = await getKv();
    if (sessionId) await destroySession(kv, sessionId);

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  },
};
```

## Dev Agent Record

### Context Reference

Story context created by create-story workflow on 2025-12-08.

### Agent Model Used

Claude Sonnet 4 (Cascade)

### Debug Log References

N/A - No issues encountered.

### Completion Notes List

- ✅ Task 1: Added auth buttons to landing page header (Sign in with GitHub / Local mode badge)
- ✅ Task 2: Added dashboard header bar with user info and settings link
- ✅ Task 3: Created Settings page with API key management, MCP config display, danger zone
- ✅ Task 4: Created API routes for user/api-key and user/delete, updated regenerate.ts with flash
  session
- ✅ Task 5: 23 tests passing (16 unit + 7 integration)
- ⏭️ E2E tests marked optional, not implemented

### File List

**New Files:**

- `src/web/routes/dashboard/settings.tsx` - Settings page with API key, MCP config, danger zone
- `src/web/islands/SettingsIsland.tsx` - Interactive API key management island
- `src/web/routes/api/user/api-key.ts` - GET API key prefix endpoint
- `src/web/routes/api/user/delete.ts` - DELETE account endpoint
- `tests/unit/web/settings_test.ts` - 16 unit tests for conditional rendering
- `tests/integration/auth/settings_api_test.ts` - 7 integration tests for API routes

**Modified Files:**

- `src/web/routes/index.tsx` - Added auth header (Sign in / Local mode badge)
- `src/web/routes/dashboard.tsx` - Added header bar with user info + settings link
- `src/web/routes/_middleware.ts` - Fixed import to use "fresh" alias
- `src/web/routes/auth/regenerate.ts` - Added flash session storage for API key

## Change Log

- 2025-12-08: Story 9.4 drafted with comprehensive context for auth UI additions
- 2025-12-08: **Validated** - MCP config updated: HTTP transport for cloud (with `${PML_API_KEY}`
  env var), stdio for local. Server name: `mcp-gateway`. URL: `https://pml.casys.ai/mcp`. Security:
  API key never in clear text in JSON.
- 2025-12-08: **Adversarial Review** - Fixed: AC references in Tasks, replaced non-existent
  `dag_executions` with `workflow_execution` (note: user_id field deferred to Story 9.5), added
  missing imports for session/kv in Implementation Hints, clarified regenerate.ts needs flash
  session modification.
- 2025-12-08: **Implementation Complete** - All 5 tasks completed. 23 tests passing (16 unit + 7
  integration). AC #1-#10 validated. E2E tests (AC #11) optional, not implemented.
- 2025-12-09: **Code Review (Adversarial)** - Found 9 issues (3 HIGH, 4 MEDIUM, 2 LOW). All fixed:
  - **H1 FIXED:** Flash API key was consumed immediately on page visit (now uses `peekFlashApiKey` -
    key stays available for 5 min TTL)
  - **H2 FIXED:** Delete account backend now validates `{ confirmation: "DELETE" }` in body (AC #8
    double confirmation)
  - **H3 FIXED:** ConfigCopyButton now has self-contained inline styles
  - **M3 FIXED:** Removed alert() for key display, now reloads page with flash session
  - **L1 FIXED:** crossorigin → crossOrigin (JSX camelCase)
  - Tests updated: 24 tests passing (16 unit + 9 integration). All ACs validated.
