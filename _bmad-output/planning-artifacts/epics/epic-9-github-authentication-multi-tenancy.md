## Epic 9: GitHub Authentication & Multi-Tenancy

> **Tech-Spec:**
> [tech-spec-github-auth-multitenancy.md](./sprint-artifacts/tech-spec-github-auth-multitenancy.md)
> **Status:** Proposed (2025-12-07) **Author:** Erwan + BMAD Party Mode

**Expanded Goal (2-3 sentences):**

Implémenter un modèle d'authentification hybride supportant deux modes d'utilisation : **Cloud
(SaaS)** avec GitHub OAuth et API Keys pour le multi-tenant, et **Self-hosted** sans
authentification pour une utilisation locale offline single-user. Ce système permet de tracker les
utilisateurs individuellement, d'appliquer le rate limiting par user_id, et d'isoler les données
personnelles tout en gardant l'apprentissage GraphRAG global partagé.

**Value Delivery:**

À la fin de cet epic, Casys PML:

- **Supporte deux modes** : Cloud (GitHub OAuth + API Key) et Self-hosted (zero-auth)
- **Isole les données** : dag_executions par user_id, GraphRAG reste global
- **Génère des API Keys** : Format `ac_xxx` pour accès MCP Gateway
- **Protège les routes** : Dashboard et API authentifiés en mode cloud
- **Simplifie le self-hosted** : Aucune configuration requise, user_id="local" automatique

**Architecture Réelle (2 Serveurs):**

```
┌─────────────────────────────────────────────────────────────────┐
│ AGENTCARDS - DUAL SERVER ARCHITECTURE │
├─────────────────────────────────────────────────────────────────┤
│ │
│ ┌───────────────────────────┐ ┌───────────────────────────┐ │
│ │ API Server (port 3003) │ │ Fresh Dashboard (8080) │ │
│ │ src/mcp/gateway-server.ts│ │ src/web/ │ │
│ │ │ │ │ │
│ │ Deno.serve() natif │ │ Fresh 2.x │ │
│ │ • /mcp (MCP protocol) │ │ • / (landing) │ │
│ │ • /api/graph/_ │ │ • /dashboard │ │
│ │ • /events/stream (SSE) │ │ • /auth/_ (OAuth) │ │
│ │ • /health │ │ • /blog/\* │ │
│ │ │ │ │ │
│ │ Auth: API Key header │ │ Auth: Session (cookie) │ │
│ └───────────────────────────┘ └───────────────────────────┘ │
│ │ │ │
│ └──────────┬──────────────────┘ │
│ ▼ │
│ ┌─────────────────────────┐ │
│ │ Shared Auth Module │ │
│ │ src/lib/auth.ts │ │
│ │ • isCloudMode() │ │
│ │ • validateApiKey() │ │
│ │ • validateSession() │ │
│ └─────────────────────────┘ │
│ │
└─────────────────────────────────────────────────────────────────┘
```

**Mode Detection (les 2 serveurs):**

```
GITHUB_CLIENT_ID défini ?
│
┌───┴───┐
▼ ▼
NON OUI
│ │
▼ ▼
LOCAL CLOUD
MODE MODE
│ │
▼ ▼
user_id Require
="local" API Key
ou Session
```

**Isolation des Données (Cloud Mode):**

| Données ISOLÉES par user_id | Données GLOBALES |
| --------------------------- | ---------------- |
| dag_executions              | mcp_tools        |
| execution_traces            | tool_graph       |
| user_preferences            | embeddings       |
| (future) custom_tools       | usage_patterns   |

**Estimation:** 7 stories, ~2 semaines

---

### Story Breakdown - Epic 9

**Story 9.1: Infrastructure Auth - Schema & Helpers**

As a system supporting multi-tenant authentication, I want a users table and API key helpers, So
that I can persist user data and securely manage API keys.

**Acceptance Criteria:**

1. Migration Drizzle créée: table `users` (`src/db/schema/users.ts`)
   ```typescript
   export const users = sqliteTable("users", {
     id: text("id").primaryKey(), // UUID
     github_id: text("github_id").unique(),
     username: text("username").notNull(),
     email: text("email"),
     avatar_url: text("avatar_url"),
     api_key_hash: text("api_key_hash"), // argon2 hash
     api_key_prefix: text("api_key_prefix"), // "ac_" + 8 chars
     api_key_created_at: integer("api_key_created_at", { mode: "timestamp" }),
     created_at: integer("created_at", { mode: "timestamp" }).default(sql`CURRENT_TIMESTAMP`),
     updated_at: integer("updated_at", { mode: "timestamp" }),
   });
   ```

````
2. API Key helpers créés (`src/lib/api-key.ts`):
   - `generateApiKey()` → `{ key: "ac_xxx", prefix: "ac_xxxxxxxx" }`
   - `hashApiKey(key)` → argon2 hash
   - `verifyApiKey(key, hash)` → boolean
   - `getApiKeyPrefix(key)` → first 11 chars for lookup
3. Format API Key: `ac_` + 24 random chars (crypto.randomUUID style)
4. Dépendance ajoutée: `@ts-rex/argon2` pour hashing
5. Migration idempotente (peut être rejouée)
6. Tests unitaires:
   - generateApiKey() format correct (`ac_` + 24 chars)
   - hashApiKey/verifyApiKey roundtrip
   - getApiKeyPrefix extraction correcte

**Technical Notes:**

- Utiliser Drizzle ORM conventions existantes (`src/db/`)
- API Key jamais loggée en clair, toujours hashée

**Prerequisites:** None (première story de l'epic)

**Estimation:** 0.5-1 jour

---

**Story 9.2: GitHub OAuth & Auth Routes**

As a cloud user, I want to authenticate via GitHub OAuth, So that I can access the dashboard and get my API key.

**Acceptance Criteria:**

1. Deno KV OAuth configuré (`src/server/auth/oauth.ts`)
   - Provider: GitHub uniquement
   - Scope: `read:user`, `user:email`
   - Utilise `jsr:@deno/kv-oauth` (officiel Deno)
2. Routes auth Fresh créées (`src/web/routes/auth/`):
   - `signin.ts` → `GET /auth/signin` → Redirect vers GitHub OAuth
   - `callback.ts` → `GET /auth/callback` → Handle OAuth callback, create/update user, generate API Key
   - `signout.ts` → `GET /auth/signout` → Destroy session, redirect to landing
   - `regenerate.ts` → `POST /auth/regenerate` → Invalidate old key, generate new one
3. Callback flow:
   - Fetch GitHub user profile (username, email, avatar)
   - Upsert user in `users` table
   - Generate API Key si première connexion
   - Create session in Deno KV (30 days TTL)
   - Redirect to `/dashboard`
4. Session storage: Deno KV avec TTL 30 jours
5. CSRF protection via state parameter (built into kv-oauth)
6. Tests:
   - Mock GitHub OAuth flow
   - Verify user created on first login
   - Verify API Key generated
   - Verify session created with correct TTL

**Technical Notes:**

- Variables env requises (cloud): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AUTH_REDIRECT_URL`
- Cookie flags: HttpOnly, Secure (prod), SameSite=Lax

**Prerequisites:** Story 9.1 (users table ready)

**Estimation:** 1-1.5 jours

---

**Story 9.3: Auth Middleware & Mode Detection (Dual-Server)**

As a system administrator, I want automatic mode detection based on environment, So that self-hosted deployments work without any auth configuration.

**Acceptance Criteria:**

1. Mode detection + validation helpers créés (`src/lib/auth.ts` - shared module):

   ```typescript
   // Mode detection
   export const isCloudMode = () => !!Deno.env.get("GITHUB_CLIENT_ID");
   export const getDefaultUserId = () => (isCloudMode() ? null : "local");

   // API Server helper (encapsule toute la logique)
   export async function validateRequest(
     req: Request
   ): Promise<{ user_id: string } | null> {
     if (!isCloudMode()) return { user_id: "local" };

     const apiKey = req.headers.get("x-api-key");
     if (!apiKey) return null;

     return await validateApiKey(apiKey); // lookup prefix + verify hash
   }
   ```

2. **Fresh Dashboard auth (port 8080)** - `src/web/routes/_middleware.ts`:
   - **Cloud mode:** Vérifie session cookie via Deno KV
   - **Local mode:** Bypass auth, inject `user_id = "local"`
   - Injecte `user` dans Fresh context: `ctx.state.user = user`
   - Protected: `/dashboard/*`, `/settings/*`
   - Redirects non-auth to `/auth/signin`
3. **API Server auth (port 3003)** - `src/mcp/gateway-server.ts`:
   - Utilise `validateRequest()` du module partagé (pas de logique inline)
   - Return 401 JSON si invalide: `{ error: "Unauthorized" }`
   - Protected: `/mcp`, `/api/graph/*`, `/events/stream`
   - Ajout ~15 lignes au début du handler:
   ```typescript
   // Dans Deno.serve handler, après CORS preflight:
   const PUBLIC_ROUTES = ["/health"];
   if (!PUBLIC_ROUTES.includes(url.pathname)) {
     const auth = await validateRequest(req);
     if (!auth) {
       return new Response(JSON.stringify({ error: "Unauthorized" }), {
         status: 401,
         headers: { "Content-Type": "application/json", ...corsHeaders },
       });
     }
     // TODO: propager auth.user_id dans le contexte d'exécution
   }
   ```
4. Routes protégées (résumé):
   | Route | Server | Auth Cloud | Auth Local |
   |-------|--------|------------|------------|
   | `/dashboard/*` | Fresh (8080) | Session cookie | Bypass |
   | `/settings/*` | Fresh (8080) | Session cookie | Bypass |
   | `/mcp` | API (3003) | API Key header | Bypass |
   | `/api/graph/*` | API (3003) | API Key header | Bypass |
   | `/events/stream` | API (3003) | API Key header | Bypass |
5. Tests:
   - Mode detection avec/sans GITHUB_CLIENT_ID (deux serveurs)
   - Fresh middleware: session validation, redirect, bypass local
   - gateway-server.ts: API Key validation, 401 response, bypass local
   - Shared `isCloudMode()` cohérent entre les deux serveurs

**Technical Notes:**

- **IMPORTANT:** Auth implémentée à DEUX endroits (Fresh middleware + gateway-server.ts handler)
- En mode local, TOUTES les requêtes passent avec `user_id = "local"`
- Log niveau INFO du mode détecté au démarrage (chaque serveur)

**Prerequisites:** Story 9.2 (OAuth routes ready)

**Estimation:** 1.5 jours

---

**Story 9.4: Landing Page & Dashboard UI (Auth Additions)**

As a new user, I want a landing page with GitHub sign-in and a dashboard showing my API key, So that I can easily onboard and configure my MCP client.

**État Actuel (déjà implémenté):**

- Landing page (`src/web/routes/index.tsx`, 60KB) - Design complet avec animations, dark theme
- Dashboard (`src/web/routes/dashboard.tsx`) - GraphExplorer + MetricsPanel fonctionnels
- Design system établi: `--accent: #FFB86F`, dark theme, fonts Geist/Instrument Serif

**Acceptance Criteria:**

1. **Landing page - Ajouts auth** (`src/web/routes/index.tsx`):
   - Header: Bouton "Sign in with GitHub" (cloud mode) - ~30 lignes
   - Header: Badge "Local mode" si `!isCloudMode()` - conditional
   - Design cohérent avec le style existant (couleurs, fonts)
2. **Dashboard - Header auth** (`src/web/routes/dashboard.tsx`):
   - Ajouter header bar avec avatar + username GitHub
   - Lien vers Settings
   - ~50 lignes à ajouter au composant existant
3. **Settings page (NOUVELLE)** (`src/web/routes/dashboard/settings.tsx`):
   - Section "Your API Key":
     - Key masquée: `ac_live_••••••••`
     - Bouton "Show" pour révéler temporairement (5s)
     - Bouton "Copy" avec toast confirmation
   - Section "MCP Configuration":
     ```json
     {
       "pml": {
         "command": "pml",
         "args": ["serve"],
         "env": { "CAI_API_KEY": "ac_xxx" }
       }
     }
     ```
     - Bouton "Copy Config"
   - Bouton "Regenerate API Key" avec confirmation modal
   - Bouton "Delete Account" avec double confirmation
   - Delete flow: anonymise données (`user_id` → `deleted-{uuid}`)
4. Conditional rendering basé sur `isCloudMode()`:
   - Cloud: affiche auth UI complète
   - Local: skip auth sections, affiche "Running in local mode"
5. Tests E2E (Playwright optionnel):
   - Landing → Sign in → Dashboard flow
   - Copy API Key functionality
   - Regenerate API Key flow

**Technical Notes:**

- **NE PAS refaire le design** - ajouter uniquement les éléments auth
- Réutiliser les CSS variables existantes (`var(--accent)`, `var(--bg)`, etc.)
- Dark mode déjà supporté dans le dashboard existant

**Prerequisites:** Story 9.3 (middleware protecting routes)

**Estimation:** 1.5-2 jours (principalement Settings page)

---

**Story 9.5: Rate Limiting & Data Isolation**

As a system ensuring fair usage, I want rate limiting per user_id and data isolation, So that cloud users have individual quotas and can't see each other's data.

**Acceptance Criteria:**

1. Rate limiter adapté (`src/lib/rate-limiter.ts`):
   - Cloud mode: clé = `user_id`
   - Local mode: rate limiting désactivé OU clé = IP (configurable)
   - Method: `getRateLimitKey(c: Context)` → string
2. Migration: FK `user_id` sur `dag_executions`:
   ```typescript
   export const dagExecutions = sqliteTable("dag_executions", {
     // ... existing fields ...
     user_id: text("user_id"), // "local" ou UUID
     created_by: text("created_by"),
     updated_by: text("updated_by"),
   });
   ```
3. Queries filtrées par `user_id`:
   - `GET /api/executions` → `WHERE user_id = ?`
   - Dashboard metrics → filtrées par user
4. Ownership tracking:
   - `created_by` set on INSERT
   - `updated_by` set on UPDATE
5. Anonymisation à la suppression:
   ```sql
   UPDATE dag_executions SET user_id = 'deleted-{uuid}' WHERE user_id = ?;
   DELETE FROM users WHERE id = ?;
   ```
6. Tests:
   - User A ne voit pas les DAGs de User B
   - Rate limit appliqué par user_id (cloud)
   - Anonymisation correcte à la suppression
   - Mode local: pas de filtering, tout visible

**Technical Notes:**

- GraphRAG et embeddings restent GLOBAUX (shared learning)
- Index sur `user_id` pour performance queries

**Prerequisites:** Story 9.4 (UI ready for testing)

**Estimation:** 1-1.5 jours

---

**Story 9.6: MCP Config & Secrets Management**

As a cloud user, I want to configure my API keys for third-party MCPs via the dashboard, So that I can use services like Tavily or OpenAI with my own credentials (BYOK).

**Acceptance Criteria:**

1. `user_secrets` table pour stocker les clés chiffrées:
   ```typescript
   export const userSecrets = sqliteTable("user_secrets", {
     id: text("id").primaryKey(),
     userId: text("user_id").references(() => users.id).notNull(),
     secretName: text("secret_name").notNull(),   // "TAVILY_API_KEY"
     ciphertext: text("ciphertext").notNull(),    // AES-256-GCM encrypted
     iv: text("iv").notNull(),                    // Unique IV per secret
     createdAt: integer("created_at"),
     updatedAt: integer("updated_at"),
   });
   ```
2. `user_mcp_configs` table pour les MCPs activés par user:
   ```typescript
   export const userMcpConfigs = sqliteTable("user_mcp_configs", {
     id: text("id").primaryKey(),
     userId: text("user_id").references(() => users.id).notNull(),
     mcpName: text("mcp_name").notNull(),        // "tavily", "github", etc.
     enabled: integer("enabled").default(1),
     configJson: text("config_json"),
     createdAt: integer("created_at"),
     updatedAt: integer("updated_at"),
   });
   ```
3. Encryption helpers (`src/lib/secrets.ts`):
   - `encryptSecret(plaintext)` → `{ ciphertext, iv }`
   - `decryptSecret(ciphertext, iv)` → `plaintext`
   - AES-256-GCM with `SECRETS_MASTER_KEY` from env
4. API endpoints:
   - `GET /api/user/secrets` → liste des secrets (names only, pas les valeurs)
   - `POST /api/user/secrets` → ajouter/update un secret
   - `DELETE /api/user/secrets/:name` → supprimer un secret
   - `GET /api/user/mcp-configs` → MCPs activés
   - `POST /api/user/mcp-configs` → enable/disable MCP
5. UI Settings → "API Keys" section:
   - Liste des MCPs disponibles avec statut (configured/not configured)
   - Champs pour entrer les clés API (masqués)
   - GitHub utilise le token OAuth du login
6. MCP Gateway integration:
   - Load user's secret at call time
   - Decrypt → inject into MCP call → discard from memory
   - Never log decrypted keys
7. Tests:
   - Encryption/decryption roundtrip
   - API endpoints require auth
   - Secrets isolated by user_id
   - MCP call uses correct user key

**Technical Notes:**

- `SECRETS_MASTER_KEY` (32 bytes base64) in Deno Deploy secrets
- Future: migrate to KMS envelope encryption for production
- MCP catalog managed by PML (no custom MCPs for MVP)
- See ADR-040 for full architecture

**TODO from Story 9.5 - Cloud userId Propagation:**
- **Context:** Story 9.5 implemented DB infrastructure (user_id column, migration 013) but deferred cloud mode userId tracking
- **Blocker:** Private methods in executor don't have access to authResult
- **Solution:** Since Story 9.6 modifies gateway for secrets injection, add userId propagation:
  1. `gateway-server.ts`: Pass `userId: authResult.user_id` to DAGExecutor.execute()
  2. `controlled-executor.ts`: Accept userId in ExecuteOptions, use in recordExecution()
  3. `graph-engine.ts`: Already supports execution.userId (Story 9.5 Task 4)
- **Benefit:** Single refactoring for secrets + userId tracking (same code path)
- **Files:** gateway-server.ts, controlled-executor.ts (already modified for secrets in 9.6)

**Prerequisites:** Story 9.5 (user_id FK exists)

**Estimation:** 2.5-3 jours (includes userId propagation from 9.5)

---

**Story 9.7: SHGAT Prediction Visibility Filtering**

As a cloud user, I want SHGAT predictions to respect capability visibility rules, So that I only see suggestions for capabilities I have access to.

**Context:**

Le SHGAT est entraîné sur les traces agrégées de tous les utilisateurs (apprentissage global partagé).
Cependant, les **prédictions** doivent être filtrées selon les règles de visibilité des capabilities :

- `visibility = 'public'` → visible par tous
- `visibility = 'org'` → visible si `user.org == capability.org`
- `visibility = 'project'` → visible si `user.project == capability.project`
- `visibility = 'private'` → visible seulement par `capability.created_by`

**Acceptance Criteria:**

1. **Prediction filtering** (`src/graphrag/prediction/`):
   ```typescript
   interface PredictionContext {
     userId: string;
     userOrg: string;
     userProject?: string;
   }

   function filterPredictionsByVisibility(
     predictions: PredictedNode[],
     context: PredictionContext
   ): PredictedNode[] {
     return predictions.filter(p => canUserSeeCapability(p, context));
   }
   ```

2. **Visibility check helper** (`src/capabilities/visibility.ts`):
   ```typescript
   function canUserSeeCapability(
     capability: { visibility: string; org: string; project: string; createdBy: string },
     user: { id: string; org: string; project?: string }
   ): boolean {
     switch (capability.visibility) {
       case 'public': return true;
       case 'org': return capability.org === user.org;
       case 'project': return capability.project === user.project;
       case 'private': return capability.createdBy === user.id;
       default: return false;
     }
   }
   ```

3. **DAG Suggester integration** (`src/graphrag/dag-suggester.ts`):
   - Accept `userId` in suggestion context
   - Filter capability predictions before returning
   - MCP servers (public) always visible

4. **Trace isolation** (`execution_trace` table):
   - User can only see their own traces: `WHERE user_id = $me`
   - SHGAT training uses all traces (anonymized aggregation)
   - Trace stats for predictions use only user's traces

5. **Local mode behavior**:
   - `user_id = "local"` sees everything (single user)
   - No visibility filtering applied

6. **Tests:**
   - User A cannot see User B's private capabilities in predictions
   - Org capabilities visible to org members only
   - Public capabilities visible to everyone
   - Local mode bypasses filtering

**Technical Notes:**

- SHGAT model weights remain GLOBAL (shared learning benefit)
- Only the **output predictions** are filtered per user
- Performance: filter after scoring (not during graph traversal)
- Consider caching visibility decisions per user session

**Prerequisites:** Story 9.5 (user_id FK), Story 13.8 (pml_registry with visibility)

**Estimation:** 1-1.5 jours

---

### Epic 9 Acceptance Criteria Summary

**Cloud Mode (GitHub OAuth):**

| AC  | Description                                            | Story    |
| --- | ------------------------------------------------------ | -------- |
| AC1 | Non-auth user → redirect to landing with GitHub button | 9.3, 9.4 |
| AC2 | OAuth complete → user created + API Key generated      | 9.2      |
| AC3 | Dashboard shows masked API Key + MCP config            | 9.4      |
| AC4 | Regenerate API Key → old key invalidated               | 9.2, 9.4 |

**Self-hosted Mode (Local):**

| AC  | Description                                | Story |
| --- | ------------------------------------------ | ----- |
| AC5 | No GITHUB_CLIENT_ID → local mode activated | 9.3   |
| AC6 | Local mode → user_id="local" auto-injected | 9.3   |

**Multi-tenant & Isolation:**

| AC   | Description                                        | Story    |
| ---- | -------------------------------------------------- | -------- |
| AC7  | User A can't see User B's DAGs                     | 9.5      |
| AC8  | Rate limiting by user_id (cloud)                   | 9.5      |
| AC9  | Account deletion → data anonymized                 | 9.4, 9.5 |
| AC16 | SHGAT predictions filtered by capability visibility | 9.7      |
| AC17 | Users only see traces they own                     | 9.7      |

**MCP Config & Secrets (BYOK):**

| AC   | Description                              | Story |
| ---- | ---------------------------------------- | ----- |
| AC12 | User can configure API keys via Settings | 9.6   |
| AC13 | Keys encrypted at rest (AES-256-GCM)     | 9.6   |
| AC14 | MCP Gateway injects user's key at call   | 9.6   |
| AC15 | Secrets isolated by user_id              | 9.6   |

**MCP Gateway:**

| AC   | Description                                 | Story |
| ---- | ------------------------------------------- | ----- |
| AC10 | Valid API Key → user_id injected in context | 9.3   |
| AC11 | Invalid/missing API Key → 401 error         | 9.3   |

---

### Epic 9 Environment Variables

```bash
# Cloud mode - Required
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
AUTH_REDIRECT_URL=http://localhost:8000/auth/callback

# Secrets encryption (Story 9.6) - Required for BYOK
SECRETS_MASTER_KEY=xxx  # 32 bytes, base64 encoded

# Self-hosted mode - Nothing required!
# If GITHUB_CLIENT_ID is not set → local mode automatic
```

---

### Epic 9 Dependencies

| Package              | Version  | Usage                    |
| -------------------- | -------- | ------------------------ |
| `jsr:@deno/kv-oauth` | latest   | GitHub OAuth             |
| `@ts-rex/argon2`     | latest   | Hash API Keys            |
| Drizzle ORM          | existing | Users schema             |
| Fresh 2.x            | existing | Routes + middleware + UI |

---

### Epic 9 FR Coverage

| FR   | Description                            | Story    |
| ---- | -------------------------------------- | -------- |
| FR1  | Détection automatique mode Cloud/Local | 9.3      |
| FR2  | GitHub OAuth authentication            | 9.2      |
| FR3  | User creation with GitHub profile      | 9.2      |
| FR4  | API Key generation/management          | 9.1, 9.2 |
| FR5  | Sessions 30 days (Deno KV)             | 9.2      |
| FR6  | Auth bypass mode local                 | 9.3      |
| FR7  | Rate limiting par user_id              | 9.5      |
| FR8  | Data isolation multi-tenant            | 9.5      |
| FR9  | Ownership tracking                     | 9.5      |
| FR10 | Landing page GitHub sign-in            | 9.4      |
| FR11 | Dashboard API Key display              | 9.4      |
| FR12 | API Key regeneration                   | 9.2, 9.4 |
| FR13 | Account deletion/anonymization         | 9.4, 9.5 |
| FR14 | MCP Gateway API Key validation         | 9.3      |
| FR15 | Protected routes dashboard/API         | 9.3      |
| FR16 | BYOK - User API keys for MCPs          | 9.6      |
| FR17 | Secrets encryption (AES-256-GCM)       | 9.6      |
| FR18 | MCP config via Dashboard               | 9.6      |
| FR19 | MCP Gateway key injection              | 9.6      |
| FR20 | SHGAT prediction visibility filtering  | 9.7      |
| FR21 | Trace isolation by user_id             | 9.7      |

---
````
