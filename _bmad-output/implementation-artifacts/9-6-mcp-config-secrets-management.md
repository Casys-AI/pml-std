# Story 9.6: MCP Config & Secrets Management

Status: backlog (DEFERRED - requires workspace refacto: open-core + SaaS repos)

## Story

En tant qu'utilisateur cloud, Je veux configurer mes clés API pour les MCPs tiers via le dashboard,
Afin de pouvoir utiliser des services comme Tavily, OpenAI ou GitHub avec mes propres identifiants
(BYOK - Bring Your Own Key).

## Acceptance Criteria

1. **AC1:** Table `user_secrets` créée pour stocker les clés chiffrées
   - Schema: `id, user_id, secret_name, ciphertext, iv, created_at, updated_at`
   - Chiffrement AES-256-GCM avec IV unique par secret
   - Unique constraint sur `(user_id, secret_name)`

2. **AC2:** Table `user_mcp_configs` créée pour les MCPs activés par utilisateur
   - Schema: `id, user_id, mcp_name, enabled, config_json, created_at, updated_at`
   - Permet d'activer/désactiver des MCPs par utilisateur
   - `config_json` pour options spécifiques au MCP

3. **AC3:** Encryption helpers créés dans `src/lib/secrets.ts`
   - `encryptSecret(plaintext: string)` → `{ ciphertext: string, iv: string }`
   - `decryptSecret(ciphertext: string, iv: string)` → `string`
   - Utilise `SECRETS_MASTER_KEY` (32 bytes base64) depuis l'environnement
   - Web Crypto API (AES-256-GCM) pour chiffrement/déchiffrement

4. **AC4:** API endpoints secrets créés
   - `GET /api/user/secrets` → Liste des secrets (names only, pas les valeurs)
   - `POST /api/user/secrets` → Ajouter/update un secret (upsert)
   - `DELETE /api/user/secrets/:name` → Supprimer un secret
   - Tous requièrent authentification (session ou API key)

5. **AC5:** API endpoints MCP configs créés
   - `GET /api/user/mcp-configs` → Liste des MCPs configurés
   - `POST /api/user/mcp-configs` → Activer/configurer un MCP
   - Retourne status: configured/not-configured pour chaque MCP

6. **AC6:** UI Settings → "API Keys" section ajoutée
   - Liste des MCPs disponibles avec statut (configured/not configured)
   - Champs pour entrer les clés API (masqués, type="password")
   - Toggle enable/disable par MCP
   - Indication "GitHub uses your OAuth login token" pour github MCP

7. **AC7:** MCP Gateway intégration complète
   - Load user's secret au moment de l'appel MCP
   - Decrypt → inject into MCP call → discard immédiatement
   - Never log decrypted keys (seulement secret_name et user_id)
   - Return 403 si user n'a pas configuré la clé requise

8. **AC8:** Tests de sécurité
   - Encryption/decryption roundtrip fonctionne
   - API endpoints requièrent auth
   - Secrets isolés par user_id (User A ne voit pas secrets User B)
   - Clés jamais loggées en clair

9. **AC9:** userId propagation complète (TODO de Story 9.5)
   - gateway-server.ts passe userId dans tous les handlers MCP
   - ControlledExecutor reçoit et stocke userId
   - workflow_execution INSERT utilise userId correct

## Tasks / Subtasks

- [ ] **Task 1: Migration - Tables secrets et mcp_configs** (AC: #1, #2)
  - [ ] 1.1 Créer migration `014_user_secrets_mcp_configs.ts`
  - [ ] 1.2 Table `user_secrets` avec schema complet
  - [ ] 1.3 Table `user_mcp_configs` avec schema complet
  - [ ] 1.4 Index sur `(user_id, secret_name)` et `(user_id, mcp_name)`
  - [ ] 1.5 FK reference vers `users.id` pour les deux tables
  - [ ] 1.6 Migration idempotente (peut être rejouée)
  - [ ] 1.7 Tests: tables créées, indexes existent, contraintes FK

- [ ] **Task 2: Encryption Helpers** (AC: #3, #8)
  - [ ] 2.1 Créer `src/lib/secrets.ts`
  - [ ] 2.2 Implémenter `getSecretsMasterKey()` - charge depuis env, valide format
  - [ ] 2.3 Implémenter `encryptSecret(plaintext)` → `{ ciphertext, iv }`
  - [ ] 2.4 Implémenter `decryptSecret(ciphertext, iv)` → `plaintext`
  - [ ] 2.5 Utiliser Web Crypto API `crypto.subtle.encrypt/decrypt`
  - [ ] 2.6 Erreur claire si `SECRETS_MASTER_KEY` manquant ou invalide
  - [ ] 2.7 Tests unitaires: roundtrip, IV unique par appel, erreurs

- [ ] **Task 3: Drizzle Schema pour nouvelles tables** (AC: #1, #2)
  - [ ] 3.1 Créer `src/db/schema/user-secrets.ts`
  - [ ] 3.2 Créer `src/db/schema/user-mcp-configs.ts`
  - [ ] 3.3 Exporter depuis `src/db/schema/index.ts`
  - [ ] 3.4 Types TypeScript générés automatiquement

- [ ] **Task 4: API Routes - Secrets** (AC: #4, #8)
  - [ ] 4.1 Créer `src/web/routes/api/user/secrets/index.ts` (GET list, POST upsert)
  - [ ] 4.2 Créer `src/web/routes/api/user/secrets/[name].ts` (DELETE)
  - [ ] 4.3 GET: retourne `{ secrets: [{ name, createdAt, updatedAt }] }` (jamais les valeurs!)
  - [ ] 4.4 POST body: `{ name: string, value: string }` → encrypt → store
  - [ ] 4.5 DELETE: supprime le secret par name
  - [ ] 4.6 Toutes requièrent auth (vérifier `ctx.state.user`)
  - [ ] 4.7 Isolation: WHERE user_id = current_user
  - [ ] 4.8 Tests: CRUD complet, isolation multi-tenant

- [ ] **Task 5: API Routes - MCP Configs** (AC: #5)
  - [ ] 5.1 Créer `src/web/routes/api/user/mcp-configs.ts`
  - [ ] 5.2 GET: liste tous les MCPs du catalog avec status user
  - [ ] 5.3 POST body: `{ mcpName: string, enabled: boolean, config?: object }`
  - [ ] 5.4 Response: `{ mcps: [{ name, description, enabled, hasSecret, category }] }`
  - [ ] 5.5 Categories: "managed", "oauth", "byok"
  - [ ] 5.6 Tests: enable/disable MCP, status correct

- [ ] **Task 6: MCP Catalog Definition** (AC: #5, #6)
  - [ ] 6.1 Créer `src/mcp/catalog.ts` avec MCPs supportés
  - [ ] 6.2 Structure: `{ name, description, category, requiredSecrets[], configSchema? }`
  - [ ] 6.3 MCPs initiaux:
    - Managed: filesystem, memory, fetch (pas de secret)
    - OAuth: github (utilise token OAuth login)
    - BYOK: tavily, brave, openai, airtable

- [ ] **Task 7: UI Settings - API Keys Section** (AC: #6)
  - [ ] 7.1 Ajouter section "API Keys" dans `settings.tsx`
  - [ ] 7.2 Créer island `src/web/islands/ApiKeysIsland.tsx`
  - [ ] 7.3 Fetch MCPs disponibles via GET /api/user/mcp-configs
  - [ ] 7.4 Afficher liste avec status (configured/not)
  - [ ] 7.5 Input masqué pour saisie nouvelle clé
  - [ ] 7.6 Bouton save → POST /api/user/secrets
  - [ ] 7.7 Toggle enable/disable par MCP
  - [ ] 7.8 Note GitHub: "Uses your OAuth login token"
  - [ ] 7.9 Design cohérent avec style existant (CSS variables)

- [ ] **Task 8: Gateway Integration - Secret Injection** (AC: #7, #9)
  - [ ] 8.1 Modifier `gateway-server.ts` pour injecter secrets dans MCP calls
  - [ ] 8.2 Créer helper `loadUserSecret(userId, secretName)` → decrypt + return
  - [ ] 8.3 Avant appel MCP: check si secret requis → load → inject
  - [ ] 8.4 Après appel: discard secret de la mémoire
  - [ ] 8.5 Si secret manquant: return 403 `{ error: "Missing API key for {mcpName}" }`
  - [ ] 8.6 Never log decrypted secrets
  - [ ] 8.7 Propager userId complet (from Story 9.5 TODO):
    - [ ] 8.7a handleJsonRpcRequest → handleCallTool → handleWorkflowExecution
    - [ ] 8.7b executeWithPerLayerValidation → ControlledExecutor({ userId })
    - [ ] 8.7c controlled-executor.ts: store and use userId in execution record

- [ ] **Task 9: Tests d'Intégration** (AC: #8)
  - [ ] 9.1 Tests encryption: roundtrip, unique IV, errors
  - [ ] 9.2 Tests API secrets: CRUD, isolation multi-tenant
  - [ ] 9.3 Tests MCP configs: enable/disable, list with status
  - [ ] 9.4 Tests gateway injection: secret loaded and used correctly
  - [ ] 9.5 Tests sécurité: auth required, secrets isolated, no plaintext logs
  - [ ] 9.6 Tests error cases: missing key, invalid key, expired session

## Dev Notes

### Architecture: BYOK (Bring Your Own Key)

ADR-040 définit le modèle BYOK pour les MCPs tiers:

```
┌─────────────────────────────────────────────────────────────────┐
│  User's .mcp config (SIMPLE - one entry only)                   │
├─────────────────────────────────────────────────────────────────┤
│  {                                                              │
│    "mcpServers": {                                              │
│      "mcp-gateway": {                                           │
│        "type": "http",                                          │
│        "url": "https://pml.casys.ai/mcp",              │
│        "headers": { "x-api-key": "${CAI_API_KEY}" }             │
│      }                                                          │
│    }                                                            │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘

User ne configure qu'UN seul MCP (mcp-gateway).
Les API keys pour Tavily, OpenAI, etc. sont stockées dans PML.
```

### MCP Categories (ADR-040)

| Category    | Examples                        | API Key Source             |
| ----------- | ------------------------------- | -------------------------- |
| **Managed** | filesystem, memory, fetch       | None (PML provides)        |
| **OAuth**   | github                          | User's GitHub login token  |
| **BYOK**    | tavily, brave, openai, airtable | User provides via Settings |

### Database Schema

```typescript
// src/db/schema/user-secrets.ts
export const userSecrets = pgTable("user_secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  secretName: text("secret_name").notNull(), // "TAVILY_API_KEY"
  ciphertext: text("ciphertext").notNull(), // AES-256-GCM encrypted
  iv: text("iv").notNull(), // base64 encoded IV
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// src/db/schema/user-mcp-configs.ts
export const userMcpConfigs = pgTable("user_mcp_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  mcpName: text("mcp_name").notNull(), // "tavily", "github", etc.
  enabled: boolean("enabled").default(true),
  configJson: text("config_json"), // MCP-specific options
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Unique constraints
// CREATE UNIQUE INDEX idx_user_secrets_name ON user_secrets(user_id, secret_name);
// CREATE UNIQUE INDEX idx_user_mcp_configs_name ON user_mcp_configs(user_id, mcp_name);
```

### Encryption (AES-256-GCM)

```typescript
// src/lib/secrets.ts
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

/**
 * Load master key from environment
 * Format: 32 bytes base64 encoded
 */
function getMasterKey(): CryptoKey {
  const keyB64 = Deno.env.get("SECRETS_MASTER_KEY");
  if (!keyB64) {
    throw new Error("SECRETS_MASTER_KEY environment variable not set");
  }

  const keyBytes = decodeBase64(keyB64);
  if (keyBytes.length !== 32) {
    throw new Error("SECRETS_MASTER_KEY must be 32 bytes (256 bits)");
  }

  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a secret value
 * @returns { ciphertext: base64, iv: base64 }
 */
export async function encryptSecret(
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await getMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    ciphertext: encodeBase64(new Uint8Array(encrypted)),
    iv: encodeBase64(iv),
  };
}

/**
 * Decrypt a secret value
 */
export async function decryptSecret(
  ciphertext: string,
  iv: string,
): Promise<string> {
  const key = await getMasterKey();

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(iv) },
    key,
    decodeBase64(ciphertext),
  );

  return new TextDecoder().decode(decrypted);
}
```

### MCP Catalog Structure

```typescript
// src/mcp/catalog.ts
export interface MCPDefinition {
  name: string;
  description: string;
  category: "managed" | "oauth" | "byok";
  requiredSecrets: string[]; // e.g., ["TAVILY_API_KEY"]
  configSchema?: object; // JSON Schema for additional config
}

export const MCP_CATALOG: MCPDefinition[] = [
  // Managed (no secrets needed)
  {
    name: "filesystem",
    description: "Read/write local files",
    category: "managed",
    requiredSecrets: [],
  },
  {
    name: "memory",
    description: "In-memory key-value store",
    category: "managed",
    requiredSecrets: [],
  },
  {
    name: "fetch",
    description: "HTTP requests",
    category: "managed",
    requiredSecrets: [],
  },

  // OAuth (uses GitHub login token)
  {
    name: "github",
    description: "GitHub API access",
    category: "oauth",
    requiredSecrets: [], // Uses OAuth token from login
  },

  // BYOK (user provides key)
  {
    name: "tavily",
    description: "Web search API",
    category: "byok",
    requiredSecrets: ["TAVILY_API_KEY"],
  },
  {
    name: "brave",
    description: "Brave Search API",
    category: "byok",
    requiredSecrets: ["BRAVE_API_KEY"],
  },
  {
    name: "openai",
    description: "OpenAI API for embeddings",
    category: "byok",
    requiredSecrets: ["OPENAI_API_KEY"],
  },
  {
    name: "airtable",
    description: "Airtable database access",
    category: "byok",
    requiredSecrets: ["AIRTABLE_API_KEY"],
  },
];
```

### Gateway Secret Injection Flow

```typescript
// Dans gateway-server.ts - handleCallTool()

async function handleCallTool(
  params: CallToolParams,
  userId: string,
): Promise<ToolResult> {
  const { name: toolName, arguments: args } = params;

  // 1. Find which MCP server provides this tool
  const mcpServer = findMcpServerForTool(toolName);
  if (!mcpServer) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // 2. Check if this MCP requires a secret
  const mcpDef = MCP_CATALOG.find((m) => m.name === mcpServer);
  if (mcpDef && mcpDef.requiredSecrets.length > 0) {
    // 3. Load user's secret for this MCP
    const secretName = mcpDef.requiredSecrets[0]; // e.g., "TAVILY_API_KEY"

    const secret = await loadUserSecret(userId, secretName);
    if (!secret) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Missing API key: ${secretName}. Configure it in Settings → API Keys.`,
        }],
      };
    }

    // 4. Inject secret into MCP client config (temporarily)
    const mcpClient = this.mcpClients.get(mcpServer);
    mcpClient.setApiKey(secret); // Temporary for this call

    try {
      // 5. Execute tool call
      const result = await mcpClient.callTool(toolName, args);
      return result;
    } finally {
      // 6. Clear secret from memory
      mcpClient.clearApiKey();
    }
  }

  // MCP doesn't require secret, proceed normally
  return await this.mcpClients.get(mcpServer).callTool(toolName, args);
}

async function loadUserSecret(
  userId: string,
  secretName: string,
): Promise<string | null> {
  const db = await getDb();
  const result = await db
    .select({ ciphertext: userSecrets.ciphertext, iv: userSecrets.iv })
    .from(userSecrets)
    .where(and(
      eq(userSecrets.userId, userId),
      eq(userSecrets.secretName, secretName),
    ))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  // Decrypt and return
  return await decryptSecret(result[0].ciphertext, result[0].iv);
}
```

### UI Settings - API Keys Section

Ajouter après la section "MCP Gateway Configuration" dans `settings.tsx`:

```tsx
{/* API Keys Section (Cloud Mode Only) */}
{
  isCloudMode && (
    <section class="settings-section">
      <h2 class="section-title">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 2a10 10 0 0 1 10 10c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2z" />
          <path d="M12 6v6l4 2" />
        </svg>
        API Keys for MCP Services
      </h2>
      <div class="section-content">
        <p class="config-description">
          Configure your API keys for third-party MCP services. Keys are encrypted and securely
          stored.
        </p>
        <ApiKeysIsland userId={user.id} />
      </div>
    </section>
  );
}
```

### Environment Variables

```bash
# Cloud mode - Required for secrets encryption
SECRETS_MASTER_KEY=xxx  # 32 bytes, base64 encoded

# Generate a new master key:
# deno eval "console.log(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))))"

# Or using openssl:
# openssl rand -base64 32
```

### Security Considerations

**Secrets stockés (cloud):**

- Chiffrés AES-256-GCM avec IV unique par secret
- Master key dans Deno Deploy secrets (jamais dans le code)
- Déchiffrement uniquement au moment de l'appel MCP
- Clés supprimées de la mémoire immédiatement après usage

**Logging (CRITICAL):**

```typescript
// ❌ NEVER DO THIS
log.info(`Calling Tavily with key: ${apiKey}`);

// ✅ CORRECT
log.info(`Calling Tavily for user ${userId}`);
log.debug(`Secret ${secretName} loaded successfully`);
```

**Isolation:**

- `user_secrets` filtré par `user_id` (jamais cross-tenant)
- API endpoints vérifient `ctx.state.user.id === record.userId`

### Project Structure Notes

**Fichiers à créer:**

```
src/
├── lib/
│   └── secrets.ts                    # Encryption helpers
├── db/
│   ├── schema/
│   │   ├── user-secrets.ts           # Drizzle schema
│   │   └── user-mcp-configs.ts       # Drizzle schema
│   └── migrations/
│       └── 014_user_secrets_mcp_configs.ts
├── mcp/
│   └── catalog.ts                    # MCP definitions
└── web/
    ├── routes/
    │   └── api/
    │       └── user/
    │           ├── secrets/
    │           │   ├── index.ts      # GET, POST
    │           │   └── [name].ts     # DELETE
    │           └── mcp-configs.ts    # GET, POST
    └── islands/
        └── ApiKeysIsland.tsx         # Interactive UI
tests/
├── unit/
│   └── lib/
│       └── secrets_test.ts           # Encryption tests
└── integration/
    └── auth/
        ├── secrets_api_test.ts       # API tests
        └── mcp_injection_test.ts     # Gateway tests
```

**Fichiers à modifier:**

```
src/
├── web/
│   └── routes/
│       └── dashboard/
│           └── settings.tsx          # Add API Keys section
├── mcp/
│   └── gateway-server.ts             # Secret injection + userId threading
├── dag/
│   ├── types.ts                      # userId in ExecutorConfig (done in 9.5)
│   └── controlled-executor.ts        # Store userId (done in 9.5)
└── db/
    └── schema/
        └── index.ts                  # Export new schemas
    └── migrations.ts                 # Register migration 014
```

### Git Intelligence (Recent Commits)

Story 9.5 completed 2025-12-10:

- Full userId propagation from HTTP auth to workflow_execution INSERT
- 27 tests passing (14 isolation + 7 gateway + 6 controlled-executor)
- Rate limiting implemented (100 req/min MCP, 200 req/min API)
- Data isolation complete (cloud mode)

Commit `970be2f`:

```
feat(auth): Propagate userId from HTTP auth to workflow_execution INSERT (Story 9.5)
```

### Implementation Hints

**1. Master Key Generation (Development):**

```bash
# Generate a development master key
deno eval "console.log(crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + String.fromCharCode(b), ''))" | base64
```

**2. Migration Test Pattern:**

```typescript
// tests/integration/db/migration_014_test.ts
Deno.test("Migration 014 - creates user_secrets table", async () => {
  const db = await getTestDb();
  await runMigration(db, 14);

  // Verify table exists
  const result = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'user_secrets'
  `);
  assertEquals(result.rows.length, 1);

  // Verify unique index
  const indexResult = await db.query(`
    SELECT indexname FROM pg_indexes
    WHERE indexname = 'idx_user_secrets_name'
  `);
  assertEquals(indexResult.rows.length, 1);
});
```

**3. Encryption Roundtrip Test:**

```typescript
// tests/unit/lib/secrets_test.ts
Deno.test("encryptSecret/decryptSecret - roundtrip", async () => {
  Deno.env.set("SECRETS_MASTER_KEY", generateTestKey());

  const plaintext = "sk-test-api-key-12345";
  const { ciphertext, iv } = await encryptSecret(plaintext);

  // Ciphertext should be different from plaintext
  assertNotEquals(ciphertext, plaintext);

  // IV should be 16 chars (12 bytes base64)
  assertEquals(iv.length, 16);

  // Decryption should return original
  const decrypted = await decryptSecret(ciphertext, iv);
  assertEquals(decrypted, plaintext);

  Deno.env.delete("SECRETS_MASTER_KEY");
});

Deno.test("encryptSecret - unique IV per call", async () => {
  Deno.env.set("SECRETS_MASTER_KEY", generateTestKey());

  const result1 = await encryptSecret("test");
  const result2 = await encryptSecret("test");

  // Same plaintext should produce different ciphertext (different IV)
  assertNotEquals(result1.ciphertext, result2.ciphertext);
  assertNotEquals(result1.iv, result2.iv);

  Deno.env.delete("SECRETS_MASTER_KEY");
});
```

**4. API Route Pattern:**

```typescript
// src/web/routes/api/user/secrets/index.ts
import { Handlers } from "fresh";
import type { AuthState } from "../../../_middleware.ts";
import { getDb } from "../../../../server/auth/db.ts";
import { userSecrets } from "../../../../db/schema/user-secrets.ts";
import { encryptSecret } from "../../../../lib/secrets.ts";
import { and, eq } from "drizzle-orm";

export const handler: Handlers<unknown, AuthState> = {
  // GET /api/user/secrets - List secret names (not values!)
  async GET(req, ctx) {
    const { user } = ctx.state;
    if (!user || user.id === "local") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const db = await getDb();
    const secrets = await db
      .select({
        name: userSecrets.secretName,
        createdAt: userSecrets.createdAt,
        updatedAt: userSecrets.updatedAt,
      })
      .from(userSecrets)
      .where(eq(userSecrets.userId, user.id));

    return Response.json({ secrets });
  },

  // POST /api/user/secrets - Create or update a secret
  async POST(req, ctx) {
    const { user } = ctx.state;
    if (!user || user.id === "local") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const { name, value } = await req.json();
    if (!name || !value) {
      return new Response(JSON.stringify({ error: "name and value required" }), { status: 400 });
    }

    // Encrypt the secret
    const { ciphertext, iv } = await encryptSecret(value);

    // Upsert
    const db = await getDb();
    await db
      .insert(userSecrets)
      .values({
        userId: user.id,
        secretName: name,
        ciphertext,
        iv,
      })
      .onConflictDoUpdate({
        target: [userSecrets.userId, userSecrets.secretName],
        set: { ciphertext, iv, updatedAt: new Date() },
      });

    return Response.json({ success: true });
  },
};
```

### References

- **ADR-040:**
  [Multi-tenant MCP & Secrets Management](../adrs/ADR-040-multi-tenant-mcp-secrets-management.md)
- **Tech-Spec:** [tech-spec-github-auth-multitenancy.md](tech-spec-github-auth-multitenancy.md)
- **Previous Story:** [9-5-rate-limiting-data-isolation.md](9-5-rate-limiting-data-isolation.md)
- **Epic Definition:** [docs/epics.md#story-96](../epics.md) - Story 9.6
- **Auth Module:** [src/lib/auth.ts](../../src/lib/auth.ts)
- **Gateway Server:** [src/mcp/gateway-server.ts](../../src/mcp/gateway-server.ts)
- **Settings Page:**
  [src/web/routes/dashboard/settings.tsx](../../src/web/routes/dashboard/settings.tsx)
- **Web Crypto API:**
  [MDN SubtleCrypto.encrypt](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)

## Dev Agent Record

### Context Reference

Story context created by create-story workflow on 2025-12-10.

### Agent Model Used

Claude Opus 4.5

### Debug Log References

N/A - Story not yet implemented.

### Completion Notes List

Story ready for implementation.

### File List

**New Files (to be created):**

- `src/lib/secrets.ts` - Encryption helpers (encryptSecret, decryptSecret)
- `src/db/schema/user-secrets.ts` - Drizzle schema for user_secrets
- `src/db/schema/user-mcp-configs.ts` - Drizzle schema for user_mcp_configs
- `src/db/migrations/014_user_secrets_mcp_configs.ts` - Migration
- `src/mcp/catalog.ts` - MCP catalog definitions
- `src/web/routes/api/user/secrets/index.ts` - GET, POST endpoints
- `src/web/routes/api/user/secrets/[name].ts` - DELETE endpoint
- `src/web/routes/api/user/mcp-configs.ts` - GET, POST endpoints
- `src/web/islands/ApiKeysIsland.tsx` - Interactive API keys UI
- `tests/unit/lib/secrets_test.ts` - Encryption unit tests
- `tests/integration/auth/secrets_api_test.ts` - API integration tests
- `tests/integration/auth/mcp_injection_test.ts` - Gateway injection tests

**Modified Files:**

- `src/web/routes/dashboard/settings.tsx` - Add API Keys section
- `src/mcp/gateway-server.ts` - Secret injection in MCP calls
- `src/db/schema/index.ts` - Export new schemas
- `src/db/migrations.ts` - Register migration 014

## Research Notes (2025-12-10)

### Problème: MCPs locaux en mode Cloud

**Constat:** Comment accéder aux MCPs qui ont besoin du filesystem local (filesystem, sqlite,
puppeteer) depuis un serveur cloud distant?

**Recherche Smithery:** Smithery utilise 2 modes:

1. **Local Distribution** - User installe via `npx`, MCP tourne localement
2. **Hosted (Remote)** - MCP tourne sur serveurs Smithery

→ Tous les services du marché (Smithery, Cloudflare Tunnel, VS Code Remote, Tailscale) nécessitent
un composant local à installer.

**Conclusion:** Il est **physiquement impossible** d'accéder au filesystem local sans un agent
local. C'est une contrainte technique fondamentale.

### Solution proposée: Local Agent Bridge

```
┌─────────────────────────────────────────────────────────────────┐
│                        User's Machine                            │
├─────────────────────────────────────────────────────────────────┤
│  Claude Code                    PML Local Agent                  │
│  ┌──────────────┐              ┌──────────────────────┐         │
│  │ Calls tools  │──────────────│ npx @pml/agent       │         │
│  └──────────────┘              │ • Spawns local MCPs  │         │
│                                │ • filesystem, sqlite │         │
│                                │ • WebSocket tunnel   │         │
│                                └──────────┬───────────┘         │
└───────────────────────────────────────────┼──────────────────────┘
                                            │ WSS (tunnel sécurisé)
                                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PML Cloud Gateway                           │
│  • Route MCPs cloud (tavily, github) directement                │
│  • Route MCPs locaux via agent tunnel                           │
└─────────────────────────────────────────────────────────────────┘
```

### Décision: Open Core Model

| Tier                      | MCPs                               | Agent Local           |
| ------------------------- | ---------------------------------- | --------------------- |
| **Self-hosted (gratuit)** | Tous                               | N/A (tout local)      |
| **Cloud Free**            | Cloud-only (tavily, github, brave) | Non                   |
| **Cloud Pro**             | Tous via bridge                    | Oui (feature payante) |

**Le Local Agent Bridge = feature premium** car:

- Complexité technique (WebSocket tunnel, auth, routing)
- Valeur business claire (best of both worlds)
- Support/maintenance

### Impact Architecture

Cette story (9.6) doit attendre la refacto workspace:

- `pml-core` → open source (ce repo)
- `pml-cloud` → SaaS privé (auth cloud, local agent, billing)

Le Local Agent sera développé dans `pml-cloud`.

## Change Log

- 2025-12-10: Story 9.6 drafted with comprehensive context for MCP Config & Secrets Management
- 2025-12-10: **DEFERRED** - Research on local MCPs problem documented. Requires workspace refacto
  (open-core + SaaS split) before implementation. Local Agent Bridge identified as premium feature.
