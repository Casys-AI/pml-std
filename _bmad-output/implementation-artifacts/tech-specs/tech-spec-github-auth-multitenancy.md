# Tech-Spec: Authentification Hybride et Multi-Tenancy

**Créé:** 2025-12-07 **Mis à jour:** 2025-12-07 (Architecture dual-server documentée) **Statut:**
Ready for Development **Auteur:** Erwan + BMAD Party Mode (Winston, Amelia, Sally, Murat)

---

## Overview

### Problème

Le dashboard Casys PML est actuellement accessible sans authentification. Pour un produit destiné
aux développeurs, il faut :

- Tracker chaque utilisateur individuellement
- Appliquer le rate limiting par utilisateur (pas seulement par IP)
- Séparer les données utilisateur (historique DAGs, préférences) tout en gardant l'apprentissage
  global (embeddings/GraphRAG partagés)
- Supporter deux modes : **Cloud** (SaaS multi-tenant) et **Self-hosted** (offline, single-tenant)

### Solution

Implémenter un **modèle d'authentification hybride** :

| Mode            | Auth                   | Connectivité            | Multi-tenant      |
| --------------- | ---------------------- | ----------------------- | ----------------- |
| **Cloud**       | GitHub OAuth → API Key | Internet requis (setup) | Oui               |
| **Self-hosted** | Aucune (trusted)       | 100% offline            | Non (single-user) |

- **Mode Cloud** : API Key pour MCP Gateway, sessions Deno KV pour dashboard
- **Mode Self-hosted** : Pas d'auth, toutes les requêtes sont du user "local"
- **Users SQLite** pour persistance (cloud uniquement)
- **Isolation par `user_id`** sur les données personnelles (cloud uniquement)
- **Shared learning** : GraphRAG et embeddings restent globaux

### Scope

**In scope :**

- Mode Cloud : GitHub OAuth + génération API Key
- Mode Self-hosted : Aucune auth (trusted, single-user)
- Table `users` avec support API Key (cloud)
- Middleware auth (session OU API Key, bypass en local)
- Rate limiting par `user_id` (cloud) ou désactivé (local)
- Ownership tracking (`created_by`, `updated_by`) - cloud uniquement
- Session lifetime 30 jours
- Anonymisation à la suppression de compte

**Out of scope (MVP) :**

- Autres providers OAuth (Google, X) - ajoutables plus tard
- Scopes/permissions sur les API Keys
- Gestion de rôles (admin, etc.)
- Teams/organisations

---

## Architecture

### Modèle Auth Hybride

```
┌─────────────────────────────────────────────────────────────────┐
│                    AGENTCARDS AUTH MODEL                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│         Détection auto: GITHUB_CLIENT_ID défini ?               │
│                             │                                    │
│              ┌──────────────┴──────────────┐                    │
│              ▼                             ▼                     │
│     ┌─────────────────┐          ┌─────────────────┐           │
│     │  LOCAL MODE     │          │  CLOUD MODE     │           │
│     │  (self-hosted)  │          │  (SaaS)         │           │
│     └────────┬────────┘          └────────┬────────┘           │
│              │                             │                     │
│              ▼                             ▼                     │
│     ┌─────────────────┐          ┌─────────────────┐           │
│     │ NO AUTH         │          │ GitHub OAuth    │           │
│     │ All requests    │          │ → API Key       │           │
│     │ = user "local"  │          │ → user_id       │           │
│     └────────┬────────┘          └────────┬────────┘           │
│              │                             │                     │
│              ▼                             ▼                     │
│     ┌─────────────────┐          ┌─────────────────┐           │
│     │ MCP Gateway     │          │ MCP Gateway     │           │
│     │ Dashboard       │          │ Dashboard       │           │
│     │ (trusted)       │          │ (auth required) │           │
│     └─────────────────┘          └─────────────────┘           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Isolation des Données

```
┌─────────────────────────────────────────────────────────────┐
│                    DATA ISOLATION                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Données ISOLÉES par user_id:          Données GLOBALES:    │
│  ┌─────────────────────────┐          ┌─────────────────┐   │
│  │ • dag_executions        │          │ • mcp_tools     │   │
│  │ • execution_traces      │          │ • tool_graph    │   │
│  │ • user_preferences      │          │ • embeddings    │   │
│  │ • custom_tools (futur)  │          │ • usage_patterns│   │
│  └─────────────────────────┘          └─────────────────┘   │
│                                                              │
│  Chaque élément créé par un user:                           │
│  ├── created_by: user_id                                    │
│  └── updated_by: user_id                                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Contexte pour le Développement

### Stack Technique

- **Runtime:** Deno
- **API Server:** `Deno.serve()` natif (src/mcp/gateway-server.ts, port 3003)
- **Dashboard:** Fresh 2.x (src/web/, port 8080)
- **ORM:** Drizzle + SQLite
- **Auth lib:** Deno KV OAuth (`jsr:@deno/kv-oauth`)
- **Session store:** Deno KV (cloud) / fichier local (self-hosted)

### Architecture 2 Serveurs (IMPORTANT)

Casys PML utilise **deux serveurs distincts** qui nécessitent chacun leur propre mécanisme d'auth:

```
┌─────────────────────────────────────────────────────────────────┐
│                 ARCHITECTURE DUAL-SERVER                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────────────┐   ┌───────────────────────────┐ │
│  │  API Server (port 3003)   │   │  Fresh Dashboard (8080)   │ │
│  │  src/mcp/gateway-server.ts│   │  src/web/                 │ │
│  │                           │   │                           │ │
│  │  Deno.serve() natif       │   │  Fresh 2.x framework      │ │
│  │  • /mcp (MCP protocol)    │   │  • / (landing)            │ │
│  │  • /api/graph/*           │   │  • /dashboard             │ │
│  │  • /events/stream (SSE)   │   │  • /auth/* (OAuth flow)   │ │
│  │  • /health                │   │  • /settings              │ │
│  │                           │   │                           │ │
│  │  Auth: API Key (header)   │   │  Auth: Session (cookie)   │ │
│  │  x-api-key: ac_xxx        │   │  Set-Cookie: session=xxx  │ │
│  └───────────────────────────┘   └───────────────────────────┘ │
│              │                             │                     │
│              └──────────┬──────────────────┘                    │
│                         ▼                                        │
│              ┌─────────────────────────┐                        │
│              │  Shared Auth Module     │                        │
│              │  src/lib/auth.ts        │                        │
│              │  • isCloudMode()        │                        │
│              │  • validateApiKey()     │                        │
│              │  • validateSession()    │                        │
│              │  • getUserFromContext() │                        │
│              └─────────────────────────┘                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Implications:**

- L'auth API Key s'implémente dans `gateway-server.ts` (handler natif Deno)
- L'auth Session/OAuth s'implémente dans Fresh middleware (`_middleware.ts`)
- Le module `src/lib/auth.ts` est partagé par les deux serveurs

### Patterns du Codebase Existant

| Pattern          | Localisation                    | À réutiliser                      |
| ---------------- | ------------------------------- | --------------------------------- |
| Rate limiting    | `src/lib/rate-limiter.ts`       | Adapter pour `user_id`            |
| Execution traces | `security-architecture.md`      | Déjà un `user_session_id`         |
| Drizzle ORM      | `src/db/`                       | Suivre les conventions existantes |
| API routes       | `src/mcp/gateway-server.ts`     | Ajouter validation API Key        |
| Fresh routes     | `src/web/routes/`               | Landing, dashboard, auth OAuth    |
| Fresh middleware | `src/web/routes/_middleware.ts` | Session auth (à créer)            |

### Décisions Techniques

| Décision           | Choix                 | Justification                        |
| ------------------ | --------------------- | ------------------------------------ |
| Provider OAuth     | GitHub uniquement     | Public cible = développeurs          |
| Auth lib           | Deno KV OAuth         | Officiel Deno, PKCE auto, stable     |
| API Key format     | `ac_xxx` (cloud only) | Simple, identifiable                 |
| Mode local         | Pas d'auth            | Single-user, machine trusted         |
| Session storage    | Deno KV               | Intégration native                   |
| User storage       | SQLite (Drizzle)      | Cohérent avec le projet              |
| Session lifetime   | 30 jours              | Équilibre UX/sécurité                |
| Suppression compte | Anonymisation         | Garder les traces pour stats         |
| Scopes API Key     | Non (MVP)             | Full access, simplifier              |
| API Server auth    | Header `x-api-key`    | Standard REST, pas de cookie sur API |
| Dashboard auth     | Fresh middleware      | Cookie session, UX browser standard  |

---

## Plan d'Implémentation

### Schema Base de Données

```typescript
// src/db/schema/users.ts (CLOUD MODE UNIQUEMENT)
export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // UUID

  // GitHub OAuth
  github_id: text("github_id").unique(),
  username: text("username").notNull(),
  email: text("email"),
  avatar_url: text("avatar_url"),

  // API Key (pour MCP Gateway en mode cloud)
  api_key_hash: text("api_key_hash"), // argon2 hash
  api_key_prefix: text("api_key_prefix"), // "ac_" + 8 chars pour lookup
  api_key_created_at: integer("api_key_created_at", { mode: "timestamp" }),

  // Timestamps
  created_at: integer("created_at", { mode: "timestamp" }).default(sql`CURRENT_TIMESTAMP`),
  updated_at: integer("updated_at", { mode: "timestamp" }),
});

// Ajouter FK sur tables existantes (cloud mode)
// En mode local, user_id = "local" (pas de FK, juste une string)
export const dagExecutions = sqliteTable("dag_executions", {
  // ... champs existants ...
  user_id: text("user_id"), // "local" ou UUID d'un user cloud
  created_by: text("created_by"),
});
```

### Format API Key (Cloud uniquement)

```
ac_7f3d8a2b1c4e5f6g7h8i9j0k
│  └─ random 24 chars (crypto.randomUUID style)
└─ prefix: "pml"

Exemple: ac_a1b2c3d4e5f6g7h8i9j0k1l2
```

### Tasks

#### Phase 1: Infrastructure Auth

- [ ] **Task 1.1:** Schema Drizzle `users` table
  - Fichier: `src/db/schema/users.ts`
  - Migration: `src/db/migrations/`

- [ ] **Task 1.2:** Helpers API Key
  - Fichier: `src/lib/api-key.ts`
  - Fonctions: `generateApiKey()`, `hashApiKey()`, `verifyApiKey()`, `getApiKeyPrefix()`

- [ ] **Task 1.3:** Configurer Deno KV OAuth (GitHub)
  - Fichier: `src/lib/oauth.ts`
  - Scope: `read:user`, `user:email`

#### Phase 2: Routes & Middleware (Dual-Server)

**Dashboard (Fresh - port 8080):**

- [ ] **Task 2.1:** Routes OAuth Fresh
  - Fichier: `src/web/routes/auth/signin.tsx`
  - Fichier: `src/web/routes/auth/callback.tsx`
  - Fichier: `src/web/routes/auth/signout.tsx`
  - Routes: `GET /auth/signin`, `GET /auth/callback`, `GET /auth/signout`

- [ ] **Task 2.2:** Fresh middleware session auth
  - Fichier: `src/web/routes/_middleware.ts`
  - Vérifie: Cookie session via Deno KV
  - Injecte: `user` dans Fresh context
  - Protected: `/dashboard/*`, `/settings/*`

**API Server (Deno.serve natif - port 3003):**

- [ ] **Task 2.3:** API Key validation dans gateway-server.ts
  - Fichier: `src/mcp/gateway-server.ts` (modifier handler existant, ~15 lignes)
  - Utilise: `validateRequest(req)` du module `src/lib/auth.ts`
  - Pattern: ajout au début du handler après CORS preflight
  - Protected: `/mcp`, `/api/graph/*`, `/events/stream`
  - Public: `/health` (pas d'auth requise)

- [ ] **Task 2.4:** Route régénération API Key (Fresh)
  - Fichier: `src/web/routes/api/regenerate-key.tsx`
  - POST `/api/regenerate-key` (requiert session active)

#### Phase 3: Mode Detection

- [ ] **Task 3.1:** Détection automatique du mode
  - Fichier: `src/lib/mode.ts`
  - Logic: `GITHUB_CLIENT_ID` défini → cloud, sinon → local
  - Export: `isCloudMode()`, `getDefaultUserId()`

- [ ] **Task 3.2:** Bypass auth en mode local
  - Middleware: skip auth si `!isCloudMode()`
  - Injecter `user_id = "local"` automatiquement

#### Phase 4: UI & Onboarding

- [ ] **Task 4.1:** Landing page (Fresh)
  - Fichier: `src/web/routes/index.tsx`
  - Bouton: "Sign in with GitHub"
  - Design: Simple, centré

- [ ] **Task 4.2:** Dashboard - Affichage API Key
  - Section: "Ta clé API" avec copier/régénérer
  - Snippet: Config MCP prête à copier

- [ ] **Task 4.3:** Settings - Gestion compte
  - Régénérer API Key
  - Supprimer compte (anonymisation)

#### Phase 5: Intégration & Tests

- [ ] **Task 5.1:** Adapter rate limiter
  - Fichier: `src/lib/rate-limiter.ts`
  - Clé: `user_id` si auth, sinon IP

- [ ] **Task 5.2:** FK `user_id` sur dag_executions
  - Migration Drizzle
  - Update queries

- [ ] **Task 5.3:** Tests auth flow
  - Mock GitHub OAuth
  - Tests API Key validation
  - Tests isolation multi-tenant

---

## Critères d'Acceptation

### Cloud Mode (GitHub OAuth)

- [ ] **AC 1:** Given un utilisateur non authentifié, When il accède à `/dashboard`, Then il est
      redirigé vers la landing avec bouton GitHub
- [ ] **AC 2:** Given un clic sur "Sign in with GitHub", When OAuth complète, Then un user est créé
      avec une API Key générée
- [ ] **AC 3:** Given un utilisateur authentifié sur le dashboard, When il voit sa page profil, Then
      son API Key (masquée) et la config MCP sont affichées
- [ ] **AC 4:** Given un utilisateur qui régénère son API Key, When il confirme, Then l'ancienne key
      est invalidée et une nouvelle est générée

### Self-hosted Mode (Local)

- [ ] **AC 5:** Given Casys PML lancé sans `GITHUB_CLIENT_ID`, When il démarre, Then le mode local
      est activé (pas d'auth requise)
- [ ] **AC 6:** Given le mode local, When une requête arrive, Then `user_id = "local"` est injecté
      automatiquement

### Multi-tenant & Isolation

- [ ] **AC 7:** Given un utilisateur A et B en mode cloud, When A exécute des DAGs, Then B ne voit
      pas les DAGs de A
- [ ] **AC 8:** Given le rate limiter, When un user authentifié fait des requêtes, Then le limiting
      est basé sur son `user_id`
- [ ] **AC 9:** Given une suppression de compte, When l'utilisateur confirme, Then ses données sont
      anonymisées (user_id → "deleted-xxx")

### MCP Gateway

- [ ] **AC 10:** Given une requête MCP avec API Key valide, When le Gateway la reçoit, Then le
      `user_id` est injecté dans le contexte d'exécution
- [ ] **AC 11:** Given une requête MCP sans API Key ou invalide, When le Gateway la reçoit, Then une
      erreur 401 est retournée

---

## Contexte Additionnel

### Dépendances

| Package              | Version  | Usage                         |
| -------------------- | -------- | ----------------------------- |
| `jsr:@deno/kv-oauth` | latest   | OAuth GitHub                  |
| `@ts-rex/argon2`     | latest   | Hash API Keys                 |
| Drizzle ORM          | existant | Schema users                  |
| Fresh 2.x            | existant | Dashboard UI + auth routes    |
| Deno.serve           | natif    | API Server (pas de framework) |

### Variables d'Environnement

```bash
# .env - Cloud mode uniquement
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
AUTH_REDIRECT_URL=http://localhost:8000/auth/callback

# Self-hosted: RIEN à configurer !
# Si GITHUB_CLIENT_ID n'est pas défini → mode local automatique
```

### Stratégie de Tests

```typescript
// Tests unitaires
- generateApiKey() format correct
- hashApiKey() / verifyApiKey() roundtrip
- Session helpers (create, validate, destroy)
- User CRUD operations
- isCloudMode() detection

// Tests d'intégration - Fresh Dashboard (port 8080)
- OAuth flow complet (mock GitHub)
- Fresh middleware session validation
- Cookie session lifecycle
- Protected routes redirect

// Tests d'intégration - API Server (port 3003)
- API Key validation (header x-api-key)
- API Key auth bypass (local mode)
- user_id injection dans execution context
- 401 response sans API Key valide

// Tests dual-server
- Mode detection cohérent (deux serveurs)
- Shared auth module (src/lib/auth.ts)
- Isolation données entre users (cloud)

// Tests sécurité
- CSRF protection (state parameter)
- API Key non loggée en clair
- Cookie flags (HttpOnly, Secure, SameSite)
```

### UX Flows

**Cloud - Premier login :**

```
Landing → "Sign in with GitHub" → OAuth → Dashboard
                                            │
                                            ▼
                                   ┌────────────────────┐
                                   │ Bienvenue @user!   │
                                   │                    │
                                   │ Ta clé API:        │
                                   │ ac_live_••••••     │
                                   │ [Copier]           │
                                   │                    │
                                   │ Config MCP:        │
                                   │ ┌────────────────┐ │
                                   │ │ {...}          │ │
                                   │ └────────────────┘ │
                                   │ [Copier config]    │
                                   └────────────────────┘
```

**Self-hosted - Aucun setup requis :**

```bash
# Clone et lance, c'est tout !
$ git clone github.com/xxx/pml && cd pml
$ deno task start

# Config MCP simplifiée (pas d'API Key nécessaire)
{
  "pml": {
    "command": "deno",
    "args": ["task", "mcp"]
  }
}
```

### Notes Importantes

- **Lucia deprecated Mars 2025** - Deno KV OAuth est le remplacement
- **API Key = secret** - Jamais loggée, toujours hashée en DB
- **Extensibilité** - Ajouter Google/autres providers = nouvelle config OAuth
- **Scopes API Key** - Prévu pour post-MVP (read-only, execute-only, etc.)
- **Architecture dual-server** - Auth implémentée à DEUX endroits (Fresh + gateway-server.ts)
- **Module auth partagé** - `src/lib/auth.ts` réutilisé par les deux serveurs

---

_Tech-spec finalisée via BMAD Quick-Flow avec Party Mode_ _Mise à jour 2025-12-07: Documentation
architecture dual-server (Fresh + Deno.serve natif)_
