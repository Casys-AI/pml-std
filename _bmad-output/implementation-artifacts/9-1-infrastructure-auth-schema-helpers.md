# Story 9.1: Infrastructure Auth - Schema & Helpers

Status: done

## Story

As a system supporting multi-tenant authentication, I want a users table and API key helpers, So
that I can persist user data and securely manage API keys.

## Acceptance Criteria

1. **AC1:** Drizzle ORM integrated with existing PGlite client
2. **AC2:** `users` table schema defined with Drizzle (`src/db/schema/users.ts`)
3. **AC3:** Drizzle migration creates `users` table in PGlite
4. **AC4:** API Key helpers (`src/lib/api-key.ts`) implement `generateApiKey()`, `hashApiKey()`,
   `verifyApiKey()`, `getApiKeyPrefix()`
5. **AC5:** API Key format is `ac_` + 24 random chars (crypto-safe)
6. **AC6:** Argon2 hashing via `@ts-rex/argon2` for secure key storage
7. **AC7:** Unit tests validate schema, API Key format, hash/verify roundtrip

## Tasks / Subtasks

- [x] **Task 1: Setup Drizzle ORM** (AC: #1)

  - [x] 1.1 Add `drizzle-orm` to `deno.json` imports
  - [x] 1.2 Create `src/db/drizzle.ts` - Drizzle client wrapper for PGlite
  - [x] 1.3 Configure `drizzle.config.ts` for migrations

- [x] **Task 2: Create Users Schema with Drizzle** (AC: #2, #3)

  - [x] 2.1 Create `src/db/schema/` directory
  - [x] 2.2 Create `src/db/schema/users.ts` with Drizzle schema
  - [x] 2.3 Create `src/db/schema/index.ts` barrel export
  - [x] 2.4 Generate and run Drizzle migration

- [x] **Task 3: Create API Key Helpers** (AC: #4, #5, #6)

  - [x] 3.1 Create `src/lib/` directory
  - [x] 3.2 Create `src/lib/api-key.ts` with 4 functions
  - [x] 3.3 Add `@ts-rex/argon2` dependency to `deno.json`

- [x] **Task 4: Tests** (AC: #7)
  - [x] 4.1 Write unit tests `tests/unit/lib/api-key_test.ts`
  - [x] 4.2 Write integration tests `tests/unit/db/drizzle_test.ts`
  - [x] 4.3 Test full roundtrip: generate → hash → verify

## Dev Notes

### Architecture Decision: Drizzle ORM + PGlite (Hybrid Approach)

**Decision:** Adopt Drizzle ORM for Epic 9+ tables while keeping existing manual migrations intact.

**Benefits:**

- Type-safe schema definitions
- Auto-generated migrations
- Ergonomic query API (`db.select().from(users)`)
- Official PGlite support: https://orm.drizzle.team/docs/connect-pglite

**Coexistence Strategy:**

- **Existing tables** (migrations 001-011): Keep manual migrations in `src/db/migrations/`
- **New tables** (Epic 9+): Use Drizzle schema in `src/db/schema/`
- Both use the same PGlite instance

---

### Task 1: Drizzle Setup

#### 1.1 Dependencies (`deno.json`)

```json
{
  "imports": {
    "drizzle-orm": "npm:drizzle-orm@latest",
    "drizzle-orm/pglite": "npm:drizzle-orm@latest/pglite",
    "drizzle-orm/pglite/migrator": "npm:drizzle-orm@latest/pglite/migrator",
    "drizzle-kit": "npm:drizzle-kit@latest",
    "@ts-rex/argon2": "npm:@ts-rex/argon2@latest"
  }
}
```

#### 1.2 Drizzle Client (`src/db/drizzle.ts`)

```typescript
/**
 * Drizzle ORM Client for PGlite
 *
 * Wraps the existing PGlite instance with Drizzle ORM.
 * Used for Epic 9+ tables (users, sessions, etc.)
 * Coexists with manual migrations for legacy tables.
 *
 * @module db/drizzle
 */

import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema/index.ts";

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Create Drizzle ORM instance from existing PGlite client
 */
export function createDrizzleClient(pglite: PGlite): DrizzleDB {
  return drizzle(pglite, { schema });
}

/**
 * Run Drizzle migrations
 * Safe to run multiple times (idempotent)
 */
export async function runDrizzleMigrations(db: DrizzleDB): Promise<void> {
  await migrate(db, { migrationsFolder: "./drizzle" });
}
```

- [x] **Task 1: Configuration**
  - [x] Add dependencies to `deno.json`
  - [x] Create `drizzle.config.ts`
- [x] **Task 2: Shared Utilities**
  - [x] Create `src/lib/api-key.ts` (generate, hash, verify, prefix)
  - [x] Use Argon2id for hashing
- [x] **Task 3: Database Layer (Drizzle)**
  - [x] Create `src/db/drizzle.ts` (client wrapper)
  - [x] Create `src/db/schema/users.ts` (Users table)
  - [x] Create `src/db/schema/index.ts` (exports)
- [x] **Task 4: Tests**
  - [x] Unit tests for API key utilities
  - [x] Integration tests for Drizzle client (using PGlite memory)

## File List

### Created

- `drizzle.config.ts`
- `src/db/drizzle.ts`
- `src/db/schema/index.ts`
- `src/db/schema/users.ts`
- `src/lib/api-key.ts`
- `tests/unit/db/drizzle_test.ts`
- `tests/unit/lib/api-key_test.ts`
- `drizzle/0000_free_lila_cheney.sql` (generated migration)

### Modified

- `deno.json`

## Dev Agent Record

### Context Reference

Story context created by create-story workflow on 2025-12-07. Updated 2025-12-07: Switched from
manual migrations to Drizzle ORM (hybrid approach).

### Agent Model Used

claude-opus-4-5-20251101 (Claude Opus 4.5) Antigravity (2025-12-08) - Implementation

### Debug Log References

- Fixed `@ts-rex/argon2` verify argument order (expects `password, hash`).

### Completion Notes List

- **ARCHITECTURE DECISION:** Use Drizzle ORM for Epic 9+ tables, keep existing manual migrations
- Drizzle migrations generated in `./drizzle/`
- All tests passed (7/7)
- Code review fixes applied 2025-12-08: Added `runDrizzleMigrations()` function, fixed lint, updated
  tests

## Senior Developer Review (AI)

**Date:** 2025-12-08\
**Reviewer:** Cascade\
**Verdict:** ✅ APPROVED

### Issues Found & Fixed

| Severity | Issue                                   | Status   |
| -------- | --------------------------------------- | -------- |
| HIGH     | Missing `runDrizzleMigrations` function | ✅ Fixed |
| MEDIUM   | Test schema duplication (manual SQL)    | ✅ Fixed |
| MEDIUM   | Lint violation (`no-explicit-any`)      | ✅ Fixed |
| MEDIUM   | Story file structure corruption         | ✅ Fixed |
| LOW      | Schema design vs implementation delta   | ✅ Fixed |
| LOW      | Missing JSDoc module comment            | ✅ Fixed |

### Verification

- **Tests:** 7/7 passing
- **Lint:** Clean
- **Type Check:** Clean
- **All 7 ACs:** Validated

### Change Log

- Added `runDrizzleMigrations()` to `src/db/drizzle.ts`
- Updated tests to use `runDrizzleMigrations()` instead of manual SQL
- Added lint ignore with justification comment
- Cleaned up duplicate Dev Agent Record section
- Added JSDoc module comment to `src/db/schema/users.ts`
- Added missing schema fields: `avatarUrl`, `apiKeyCreatedAt`
- Added `withTimezone: true` to timestamp fields

---

## Design Reference

### Task 3: API Key Helpers

#### 3.2 API Key Helpers (`src/lib/api-key.ts`)

```typescript
/**
 * API Key Helpers
 *
 * Secure generation and verification of API keys.
 * Format: ac_XXXXXXXXXXXXXXXXXXXXXXXX (ac_ + 24 alphanumeric chars)
 *
 * Security:
 * - Keys are hashed with Argon2id before storage
 * - Only prefix (11 chars) stored for lookup
 * - Full key shown ONCE to user, never retrievable
 *
 * @module lib/api-key
 */

import { hash, verify } from "@ts-rex/argon2";

const API_KEY_PREFIX = "ac_";
const API_KEY_LENGTH = 24;
const LOOKUP_PREFIX_LENGTH = 11; // "ac_" + 8 chars

/**
 * Generate a new API key
 * @returns Object with full key (show once) and prefix (store for lookup)
 */
export function generateApiKey(): { key: string; prefix: string } {
  // Generate 24 random alphanumeric characters
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomPart = Array.from(
    crypto.getRandomValues(new Uint8Array(API_KEY_LENGTH)),
    (byte) => chars[byte % chars.length],
  ).join("");

  const key = `${API_KEY_PREFIX}${randomPart}`;
  const prefix = key.substring(0, LOOKUP_PREFIX_LENGTH);

  return { key, prefix };
}

/**
 * Hash API key for secure storage
 * Uses Argon2id (memory-hard, side-channel resistant)
 *
 * @param key Full API key (ac_xxx)
 * @returns Argon2 hash string
 */
export async function hashApiKey(key: string): Promise<string> {
  return await hash(key);
}

/**
 * Verify API key against stored hash
 *
 * @param key Full API key to verify
 * @param hashedKey Stored Argon2 hash
 * @returns true if match, false otherwise
 */
export async function verifyApiKey(
  key: string,
  hashedKey: string,
): Promise<boolean> {
  try {
    return await verify(hashedKey, key);
  } catch {
    return false;
  }
}

/**
 * Extract lookup prefix from API key
 * Used for O(1) database lookup before expensive hash verification
 *
 * @param key Full API key
 * @returns First 11 characters (e.g., "ac_a1b2c3d4")
 */
export function getApiKeyPrefix(key: string): string {
  return key.substring(0, LOOKUP_PREFIX_LENGTH);
}
```

---

### Task 4: Tests

#### 4.1 API Key Tests (`tests/unit/lib/api-key_test.ts`)

```typescript
import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  generateApiKey,
  getApiKeyPrefix,
  hashApiKey,
  verifyApiKey,
} from "../../../src/lib/api-key.ts";

Deno.test("generateApiKey - format correct", () => {
  const { key, prefix } = generateApiKey();

  // Key format: ac_ + 24 alphanumeric chars
  assertMatch(key, /^ac_[a-zA-Z0-9]{24}$/);

  // Prefix is first 11 chars
  assertEquals(prefix.length, 11);
  assertEquals(prefix, key.substring(0, 11));
  assertMatch(prefix, /^ac_[a-zA-Z0-9]{8}$/);
});

Deno.test("generateApiKey - unique each time", () => {
  const key1 = generateApiKey();
  const key2 = generateApiKey();

  assertNotEquals(key1.key, key2.key);
  assertNotEquals(key1.prefix, key2.prefix);
});

Deno.test("hashApiKey/verifyApiKey - roundtrip success", async () => {
  const { key } = generateApiKey();
  const hashedKey = await hashApiKey(key);

  // Hash is different from original
  assertNotEquals(hashedKey, key);

  // Verify succeeds with correct key
  assertEquals(await verifyApiKey(key, hashedKey), true);
});

Deno.test("hashApiKey/verifyApiKey - wrong key fails", async () => {
  const { key } = generateApiKey();
  const hashedKey = await hashApiKey(key);

  // Verify fails with wrong key
  assertEquals(
    await verifyApiKey("ac_wrongkey12345678901234", hashedKey),
    false,
  );
});

Deno.test("getApiKeyPrefix - extraction", () => {
  const prefix = getApiKeyPrefix("ac_a1b2c3d4e5f6g7h8i9j0k1l2");
  assertEquals(prefix, "ac_a1b2c3d4");
  assertEquals(prefix.length, 11);
});
```

#### 4.2 Drizzle Integration Tests (`tests/unit/db/drizzle_test.ts`)

```typescript
import { assertEquals, assertExists } from "@std/assert";
import { PGlite } from "@electric-sql/pglite";
import { createDrizzleClient, runDrizzleMigrations } from "../../../src/db/drizzle.ts";
import { users } from "../../../src/db/schema/users.ts";
import { eq } from "drizzle-orm";

Deno.test("Drizzle + PGlite - create and query user", async () => {
  // Create in-memory PGlite
  const pglite = new PGlite("memory://");
  const db = createDrizzleClient(pglite);

  // Run migrations
  await runDrizzleMigrations(db);

  // Insert user
  const newUser = {
    id: crypto.randomUUID(),
    username: "testuser",
    githubId: "12345",
    email: "test@example.com",
  };

  await db.insert(users).values(newUser);

  // Query user
  const result = await db.select().from(users).where(eq(users.id, newUser.id));

  assertEquals(result.length, 1);
  assertEquals(result[0].username, "testuser");
  assertEquals(result[0].githubId, "12345");
  assertExists(result[0].createdAt);

  // Cleanup
  await pglite.close();
});

Deno.test("Drizzle + PGlite - API key prefix lookup", async () => {
  const pglite = new PGlite("memory://");
  const db = createDrizzleClient(pglite);
  await runDrizzleMigrations(db);

  // Insert user with API key
  const newUser = {
    id: crypto.randomUUID(),
    username: "apiuser",
    apiKeyHash: "hashed_key_here",
    apiKeyPrefix: "ac_testpref",
  };

  await db.insert(users).values(newUser);

  // Lookup by prefix
  const result = await db
    .select()
    .from(users)
    .where(eq(users.apiKeyPrefix, "ac_testpref"));

  assertEquals(result.length, 1);
  assertEquals(result[0].username, "apiuser");

  await pglite.close();
});
```

---

### Project Structure After Implementation

```
src/
├── db/
│   ├── client.ts              # Existing PGlite client (unchanged)
│   ├── drizzle.ts             # NEW: Drizzle wrapper for PGlite
│   ├── migrations.ts          # Existing manual migrations (unchanged)
│   ├── migrations/            # Existing manual migrations (unchanged)
│   │   ├── 001_...
│   │   └── 011_capability_storage_migration.ts
│   └── schema/                # NEW: Drizzle schemas
│       ├── index.ts           # Barrel export
│       └── users.ts           # Users table schema
├── lib/                       # NEW: Shared utilities
│   └── api-key.ts             # API key helpers
└── ...

drizzle/                       # NEW: Drizzle migrations output
├── 0000_xxx.sql
└── meta/

tests/
└── unit/
    ├── db/
    │   └── drizzle_test.ts    # NEW: Drizzle integration tests
    └── lib/
        └── api-key_test.ts    # NEW: API key unit tests
```

---

### Security Requirements

- **API Key NEVER logged in plaintext** - only hash and prefix
- **Argon2id** used (memory-hard, side-channel resistant)
- **Prefix-based lookup** prevents timing attacks on full key comparison
- **Key shown ONCE** to user (after OAuth callback), never retrievable again

---

### References

- **Drizzle + PGlite:** https://orm.drizzle.team/docs/connect-pglite
- **Drizzle Get Started:** https://orm.drizzle.team/docs/get-started/pglite-new
- **Tech-Spec:** [tech-spec-github-auth-multitenancy.md](tech-spec-github-auth-multitenancy.md)
- **Epic Definition:** [docs/epics.md#epic-9](../epics.md) - Story 9.1
