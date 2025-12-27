import { assertEquals, assertExists } from "@std/assert";
import { PGlite } from "@electric-sql/pglite";
import { createDrizzleClient, runDrizzleMigrations } from "../../../src/db/drizzle.ts";
import { users } from "../../../src/db/schema/users.ts";
import { eq } from "drizzle-orm";

Deno.test("Drizzle + PGlite - create and query user", async () => {
  // Create in-memory PGlite
  const pglite = new PGlite(`memory://${crypto.randomUUID()}`);
  const db = createDrizzleClient(pglite);

  // Run Drizzle migrations (uses generated SQL from ./drizzle/)
  await runDrizzleMigrations(db);

  // Insert user
  const newUser = {
    id: crypto.randomUUID(),
    username: "testuser",
    githubId: "12345",
    email: "test@example.com",
    role: "user",
    apiKeyHash: null,
    apiKeyPrefix: null,
  };

  // We need to suppress TS error for missing default fields if we don't provide them,
  // but Drizzle's inferInsert should handle optional fields.
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
  const pglite = new PGlite(`memory://${crypto.randomUUID()}`);
  const db = createDrizzleClient(pglite);

  // Run Drizzle migrations (uses generated SQL from ./drizzle/)
  await runDrizzleMigrations(db);

  // Insert user with API key
  const newUser = {
    id: crypto.randomUUID(),
    username: "apiuser",
    apiKeyHash: "hashed_key_here",
    apiKeyPrefix: "ac_testpref",
    role: "user",
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
