# Tech-Spec: Séparation Code Cloud vers Repo Privé

**Created:** 2025-12-09 **Status:** Ready for Development **Author:** Erwan + Claude

## Overview

### Problem Statement

Le code d'authentification cloud (GitHub OAuth, API keys, multi-tenancy) est actuellement dans le
repo public `casys-pml`. Cela permet à n'importe qui de :

1. Fork le repo
2. Ajouter `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`
3. Déployer sa propre version "enterprise" gratuitement

De plus, le code de gestion des secrets utilisateurs (Story 9.6 - BYOK) présente des risques de
sécurité s'il est exposé publiquement.

### Solution

Créer un repo privé `casys-cloud` séparé qui :

- Contient tout le code auth/secrets/multi-tenant
- Importe le core public via chemins relatifs
- Est le seul repo déployé sur la plateforme SaaS

Le repo public `casys-pml` reste fonctionnel en mode local (sans auth).

### Scope

**In Scope:**

- Création du repo `casys-cloud` avec structure de base
- Déplacement des fichiers auth existants (Epic 9.1-9.4)
- Création d'interfaces/hooks dans le core pour l'intégration
- Adaptation du gateway-server et middleware pour utiliser les hooks
- Tests pour les deux modes (local sans cloud, cloud avec)

**Out of Scope:**

- Story 9.5 (Rate Limiting) - sera implémentée directement dans casys-cloud
- Story 9.6 (Secrets Management) - sera implémentée directement dans casys-cloud
- CI/CD pour le repo privé (future task)
- Migration des données existantes (pas de données en prod encore)

## Context for Development

### Codebase Patterns

**Import style:** Chemins relatifs depuis deno.json imports map

```typescript
import { something } from "../lib/something.ts";
```

**Auth pattern actuel:**

- `isCloudMode()` check `GITHUB_CLIENT_ID` env var
- `validateRequest()` retourne `{ user_id: string }` ou `null`
- Mode local bypass tout avec `user_id = "local"`

**Fresh routes:** Convention `src/web/routes/[path]/[file].ts(x)`

### Files to Reference

**À déplacer vers casys-cloud:**

```
src/lib/auth.ts                          → casys-cloud/src/lib/auth.ts
src/lib/api-key.ts                       → casys-cloud/src/lib/api-key.ts
src/server/auth/                         → casys-cloud/src/server/auth/
src/db/schema/users.ts                   → casys-cloud/src/db/schema/users.ts
src/web/routes/auth/                     → casys-cloud/src/web/routes/auth/
src/web/routes/dashboard/settings.tsx    → casys-cloud/src/web/routes/dashboard/settings.tsx
src/web/routes/api/user/                 → casys-cloud/src/web/routes/api/user/
tests/unit/lib/auth_test.ts              → casys-cloud/tests/
tests/unit/lib/api-key_test.ts           → casys-cloud/tests/
tests/unit/server/auth/                  → casys-cloud/tests/
tests/integration/auth/                  → casys-cloud/tests/
```

**À modifier dans casys-pml:**

```
src/mcp/gateway-server.ts    # Utiliser auth hooks au lieu d'import direct
src/web/routes/_middleware.ts # Utiliser auth hooks
src/web/dev.ts               # Utiliser auth hooks
```

**À créer dans casys-pml:**

```
src/lib/auth-hooks.ts        # Interface + default local provider
```

### Technical Decisions

| Decision         | Choice                                    | Rationale                             |
| ---------------- | ----------------------------------------- | ------------------------------------- |
| Import method    | Chemins relatifs (`../casys-pml/...`)     | Simple, pas de publish nécessaire     |
| Auth abstraction | Hooks/Provider pattern                    | Permet injection du cloud provider    |
| Workspace        | Repos côte-à-côte dans `CascadeProjects/` | Un seul VS Code workspace             |
| Default mode     | Local (no auth)                           | Le core fonctionne sans le repo cloud |

## Pre-mortem: Risques Identifiés et Préventions

_Analyse des scénarios d'échec potentiels (juin 2026) et actions préventives_

| Risque                | Scénario d'échec                                                     | Prévention                                                                       | Priorité |
| --------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------- |
| **Imports fragiles**  | Refactors dans core cassent cloud à cause des imports `../` profonds | Créer `mod.ts` comme API publique stable, cloud importe uniquement depuis mod.ts | HIGH     |
| **Fresh routing**     | Impossible de merger les routes auth dans le Fresh app existant      | Tester le mounting de routes externes AVANT de commencer (Task 0)                | HIGH     |
| **Context switch**    | Productivité chute à cause du jonglage deux repos/terminaux          | Préparer VS Code workspace multi-root + script `dev-all.sh`                      | MEDIUM   |
| **Tests intégration** | CI ne peut pas tester le flow complet OAuth→Dashboard                | CI de casys-cloud clone casys-pml, tests E2E cross-repo                          | MEDIUM   |
| **Historique git**    | Quelqu'un récupère le code auth depuis l'historique git              | Décision : purger avec BFG ou accepter (protection future seulement)             | LOW      |

## Implementation Plan

### Tasks

- [ ] **Task 0 (SPIKE):** Valider l'architecture Fresh multi-repo
  - Tester si Fresh supporte le mounting de routes depuis un autre dossier
  - Si non : évaluer alternatives (reverse proxy, Fresh app séparé, monorepo packages/)
  - **BLOQUANT** : Ne pas continuer si pas de solution viable

- [ ] **Task 1:** Créer structure `casys-cloud/`
  - `mkdir -p casys-cloud/src/{lib,server/auth,db/schema,web/routes}`
  - Créer `deno.json` avec imports vers `../casys-pml/`
  - Init git repo privé

- [ ] **Task 2:** Créer `auth-hooks.ts` + `mod.ts` dans casys-pml
  - Interface `AuthProvider` avec `isCloudMode()`, `validateRequest()`, `logAuthMode()`
  - Default provider pour mode local (toujours `user_id = "local"`)
  - Export `setAuthProvider()` pour injection
  - Export `getAuthProvider()` pour usage
  - **Créer `mod.ts`** comme API publique stable (casys-cloud importe UNIQUEMENT depuis mod.ts)

- [ ] **Task 3:** Adapter gateway-server.ts
  - Remplacer `import { validateRequest } from "../lib/auth.ts"`
  - Par `import { getAuthProvider } from "../lib/auth-hooks.ts"`
  - Utiliser `getAuthProvider().validateRequest(req)`

- [ ] **Task 4:** Adapter _middleware.ts et dev.ts
  - Même pattern que Task 3
  - `getAuthProvider().isCloudMode()`

- [ ] **Task 5:** Déplacer fichiers auth vers casys-cloud
  - Copier tous les fichiers listés ci-dessus
  - Adapter les imports pour pointer vers `../casys-pml/`
  - Supprimer du repo public

- [ ] **Task 6:** Créer main.ts dans casys-cloud
  ```typescript
  // casys-cloud/src/main.ts
  import { setAuthProvider } from "../casys-pml/src/lib/auth-hooks.ts";
  import { cloudAuthProvider } from "./lib/auth.ts";

  // Inject cloud auth provider
  setAuthProvider(cloudAuthProvider);

  // Start gateway with cloud features
  import "../casys-pml/src/main.ts";
  ```

- [ ] **Task 7:** Créer les routes Fresh cloud
  - `casys-cloud/src/web/routes/` avec les routes auth
  - Mount dans le Fresh app du core

- [ ] **Task 8:** Tests
  - Vérifier que casys-pml fonctionne seul (mode local)
  - Vérifier que casys-cloud avec injection fonctionne (mode cloud)
  - Migrer les tests auth vers casys-cloud

- [ ] **Task 9:** Developer Experience Setup
  - Créer `casys.code-workspace` (VS Code multi-root workspace)
  - Créer `dev-all.sh` script qui lance les deux serveurs
  - Documenter le setup dans README de casys-cloud

- [ ] **Task 10:** Nettoyage
  - Supprimer les fichiers auth du repo public
  - Mettre à jour .gitignore si nécessaire
  - Décider : purger historique git (BFG) ou non
  - Commit final sur les deux repos

### Acceptance Criteria

- [ ] **AC1:** `casys-pml` démarre sans erreur sans le repo cloud présent
  - `deno task dev` fonctionne
  - Mode local automatique (`user_id = "local"`)
  - Dashboard accessible sans auth

- [ ] **AC2:** `casys-cloud` démarre et injecte l'auth provider
  - `deno task dev` depuis casys-cloud fonctionne
  - Mode cloud activé (require `GITHUB_CLIENT_ID`)
  - OAuth flow fonctionne

- [ ] **AC3:** Aucun code auth dans le repo public
  - Pas de `src/lib/auth.ts` (remplacé par `auth-hooks.ts`)
  - Pas de `src/server/auth/`
  - Pas de `src/web/routes/auth/`
  - Pas de `src/db/schema/users.ts`

- [ ] **AC4:** Tests passent dans les deux repos
  - `deno task test` dans casys-pml (tests core)
  - `deno task test` dans casys-cloud (tests auth)

- [ ] **AC5:** Imports via mod.ts uniquement
  - casys-cloud importe depuis `../casys-pml/mod.ts`
  - Aucun import direct vers `../casys-pml/src/` (sauf mod.ts)

- [ ] **AC6:** Developer Experience opérationnelle
  - `casys.code-workspace` ouvre les deux repos
  - `./dev-all.sh` lance gateway + dashboard avec auth

## Additional Context

### Dependencies

**casys-pml (public):**

- Aucune nouvelle dépendance
- Retrait de `@ts-rex/argon2` et `@deno/kv-oauth` (moved to cloud)

**casys-cloud (private):**

- `@ts-rex/argon2` - Hash API keys
- `@deno/kv-oauth` - GitHub OAuth
- `drizzle-orm` - Database (already in core)

### Testing Strategy

1. **Unit tests core:** Vérifier que auth-hooks retourne le default provider
2. **Unit tests cloud:** Tester auth.ts, api-key.ts, session.ts (existants)
3. **Integration:** Tester le flow complet OAuth dans casys-cloud
4. **E2E:** Tester dashboard login flow (optionnel)

### File Structure finale

```
CascadeProjects/
├── casys-pml/              # PUBLIC
│   ├── src/
│   │   ├── lib/
│   │   │   └── auth-hooks.ts        # Interface + default local provider
│   │   ├── mcp/
│   │   │   └── gateway-server.ts    # Uses getAuthProvider()
│   │   └── web/
│   │       └── routes/
│   │           └── _middleware.ts   # Uses getAuthProvider()
│   └── deno.json
│
└── casys-cloud/                     # PRIVATE
    ├── src/
    │   ├── lib/
    │   │   ├── auth.ts              # Cloud auth implementation
    │   │   └── api-key.ts           # API key management
    │   ├── server/auth/
    │   │   ├── db.ts
    │   │   ├── kv.ts
    │   │   ├── oauth.ts
    │   │   └── session.ts
    │   ├── db/schema/
    │   │   └── users.ts
    │   ├── web/routes/
    │   │   ├── auth/
    │   │   ├── dashboard/settings.tsx
    │   │   └── api/user/
    │   └── main.ts                  # Entry point - injects cloud provider
    ├── tests/
    └── deno.json
```

### Notes

- Le repo cloud n'est jamais publié sur JSR/npm
- Les deux repos peuvent être ouverts dans le même VS Code workspace
- Pour dev cloud: `cd casys-cloud && deno task dev`
- Pour dev local only: `cd casys-pml && deno task dev`
