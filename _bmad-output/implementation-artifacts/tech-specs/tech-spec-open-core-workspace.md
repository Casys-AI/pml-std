# Tech-Spec: Architecture Open Core — Monorepo Privé + Sync Public

**Created:** 2025-12-10 **Status:** Completed **Completed:** 2025-12-15 **Author:** Erwan + BMad
Master

---

## Overview

### Problem Statement

Casys PML doit adopter un modèle **Open Core** :

- **Core** (AGPL) : Moteur PML open-source, self-hostable
- **Cloud** (Propriétaire) : SaaS multi-tenant avec features premium

Le challenge : développer les deux dans un workflow unifié compatible avec Claude Code, sans perdre
l'historique git ni casser le code existant.

### Solution

**Monorepo privé + synchronisation automatique vers repo public**

```
casys-pml-cloud (PRIVÉ - repo de dev principal)
├── src/
│   ├── core/           ← Code AGPL (sync → repo public)
│   ├── cloud/          ← Code SaaS propriétaire
│   └── shared/         ← Types partagés (sync → repo public)
├── packages/
│   └── mcp-connector/  ← Package client (npm public)
├── docs/               ← Docs (sync → repo public)
└── .github/workflows/
    └── sync-to-public.yml
```

### Scope

**In scope :**

- Migration des remotes git (origin → privé, public → ancien)
- Réorganisation structure `src/core/` vs `src/cloud/`
- GitHub Action de synchronisation automatique
- Séparation des features Core vs Cloud

**Out of scope (Phase 2+) :**

- Billing / Stripe integration
- Package npm `@casys/mcp-connector`
- CI/CD production cloud

---

## Context for Development

### Repositories

| Repo                       | Visibilité | Contenu             | License      |
| -------------------------- | ---------- | ------------------- | ------------ |
| `Casys-AI/casys-pml`       | Public     | Core + docs + BMAD  | AGPL-3.0     |
| `Casys-AI/casys-pml-cloud` | Privé      | Tout (core + cloud) | Propriétaire |

### Current State Analysis

Code "cloud" déjà implémenté dans le repo actuel :

| Fichier                      | Status    | Destination                   |
| ---------------------------- | --------- | ----------------------------- |
| `src/lib/auth.ts`            | ✅ Existe | Core (mode detection)         |
| `src/db/schema/users.ts`     | ✅ Existe | Core (schema basique)         |
| `src/server/auth/oauth.ts`   | ✅ Existe | Core (GitHub OAuth)           |
| `src/lib/api-key.ts`         | ✅ Existe | Core                          |
| `src/web/routes/api/user/*`  | ✅ Existe | Core                          |
| `src/mcp/smithery-client.ts` | 🚧 WIP    | Cloud (`src/cloud/smithery/`) |

### Feature Separation

| Feature                        | Core (Public) | Cloud (Privé) |
| ------------------------------ | ------------- | ------------- |
| DAG Executor                   | ✅            | ✅            |
| GraphRAG Engine                | ✅            | ✅            |
| Sandbox Execution              | ✅            | ✅            |
| MCP Gateway                    | ✅            | ✅            |
| Mode Detection (`isCloudMode`) | ✅            | ✅            |
| GitHub OAuth (basique)         | ✅            | ✅            |
| API Key Auth                   | ✅            | ✅            |
| Multi-tenant Isolation         | ✅            | ✅            |
| **BYOK** (Bring Your Own Key)  | ❌            | ✅            |
| **User Analytics/Tracking**    | ❌            | ✅            |
| **MCP Connector Package**      | ❌            | ✅            |
| **Billing / Subscriptions**    | ❌            | ✅            |
| **Advanced Rate Limiting**     | ❌            | ✅            |
| **SSO Enterprise**             | ❌            | ✅            |
| **Smithery MCP Gateway**       | ❌            | ✅            |

### Codebase Patterns

- **Mode detection** : `isCloudMode()` dans `src/lib/auth.ts`
- **Conditional imports** : À implémenter pour features cloud-only
- **Feature flags** : Via env vars (`ENABLE_BYOK=true`)

---

## Implementation Plan

### Phase 1: Migration Git (Zero Code Change)

**Objectif :** Changer les remotes sans toucher au code

#### Task 1.1: Créer le repo privé

```bash
# Sur GitHub: créer Casys-AI/casys-pml-cloud (privé)
```

#### Task 1.2: Migrer les remotes

```bash
# Dans le repo local
git remote rename origin public
git remote add origin git@github.com:Casys-AI/casys-pml-cloud.git
git push -u origin main --all
git push origin --tags
```

#### Task 1.3: Vérifier que tout fonctionne

```bash
git remote -v
# origin  → casys-pml-cloud (privé)
# public  → casys-pml (public)
```

### Phase 2: GitHub Action Sync

**Objectif :** Synchronisation automatique vers le repo public

#### Task 2.1: Créer le workflow de sync

```yaml
# .github/workflows/sync-to-public.yml
name: Sync to Public Repo

on:
  push:
    branches: [main]
    paths:
      - "src/core/**"
      - "src/shared/**"
      - "docs/**"
      - ".bmad/**"
      - "README.md"
      - "LICENSE"
      - "deno.json"
      - "tests/**"

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Sync to public repo
        uses: cpina/github-action-push-to-another-repository@main
        env:
          SSH_DEPLOY_KEY: ${{ secrets.PUBLIC_REPO_DEPLOY_KEY }}
        with:
          source-directory: "."
          destination-github-username: "Casys-AI"
          destination-repository-name: "casys-pml"
          target-branch: main
          exclude: |
            src/cloud/
            packages/mcp-connector/
            .github/workflows/sync-to-public.yml
            .env*
            secrets/
```

#### Task 2.2: Configurer les secrets GitHub

- Générer SSH deploy key pour le repo public
- Ajouter comme secret `PUBLIC_REPO_DEPLOY_KEY` dans le repo privé

### Phase 3: Réorganisation Structure (Optionnel)

**Objectif :** Séparer clairement le code Core vs Cloud

#### Task 3.1: Créer la structure cloud

```bash
mkdir -p src/cloud
mkdir -p packages/mcp-connector
```

#### Task 3.2: Déplacer le code cloud-only

```
src/cloud/
├── byok/           ← Bring Your Own Key
│   ├── key-vault.ts
│   └── providers/
├── analytics/      ← User tracking
│   ├── events.ts
│   └── metrics.ts
├── smithery/       ← Smithery MCP Gateway (HTTP)
│   ├── client.ts   ← (migré depuis src/mcp/smithery-client.ts)
│   └── types.ts
├── billing/        ← Subscriptions (futur)
└── enterprise/     ← SSO, etc. (futur)
```

#### Task 3.3: Configurer les imports conditionnels

```typescript
// src/lib/features.ts
export async function loadCloudFeatures() {
  if (!isCloudMode()) return null;

  // Dynamic import pour éviter bundling en mode core
  const byok = await import("../cloud/byok/mod.ts");
  const analytics = await import("../cloud/analytics/mod.ts");

  return { byok, analytics };
}
```

### Phase 4: MCP Connector Package (Futur)

**Objectif :** Package npm pour connecter MCP locaux au cloud

```
packages/mcp-connector/
├── package.json
├── src/
│   ├── client.ts      ← WebSocket client
│   ├── auth.ts        ← API Key auth
│   └── sync.ts        ← File sync logic
└── README.md
```

---

## Acceptance Criteria

### Phase 1: Migration Git

- [x] **AC 1.1:** Le repo privé `casys-pml-cloud` existe et contient tout le code
- [x] **AC 1.2:** `git remote -v` montre origin=privé, public=public
- [x] **AC 1.3:** `git push origin main` pousse vers le privé
- [x] **AC 1.4:** L'historique git complet est préservé

### Phase 2: Sync Automatique

- [x] **AC 2.1:** Push sur `src/core/**` déclenche le sync vers public
- [x] **AC 2.2:** Les fichiers `src/cloud/**` ne sont JAMAIS sync vers public
- [x] **AC 2.3:** Les secrets et .env ne sont pas sync

### Phase 3: Réorganisation

- [x] **AC 3.1:** Smithery reste dans `src/mcp/` (code visible, protégé par API key)
- [x] **AC 3.2:** `deno check` passe sans erreur
- [x] **AC 3.3:** `deno task test` passe (14/14 tests smithery)
- [ ] **AC 3.4:** `src/cloud/` réservé pour futures features premium (BYOK, billing) - À créer quand
      nécessaire

---

## Additional Context

### Risques

| Risque                        | Impact   | Mitigation                                                        |
| ----------------------------- | -------- | ----------------------------------------------------------------- |
| Sync accidentel de code cloud | Critique | `.github/workflows/sync-to-public.yml` avec exclusions explicites |
| Perte d'historique git        | Moyen    | Backup avant migration                                            |
| Imports cassés après réorg    | Moyen    | Phase 3 optionnelle, faire après stabilisation                    |

### Rollback Plan

```bash
# Si problème, revenir à l'ancien setup
git remote remove origin
git remote rename public origin
```

### Workflow Claude Code

Après migration, le workflow quotidien :

1. Dev dans `casys-pml-cloud` (privé)
2. Claude Code voit **tout** le code (core + cloud)
3. Push sur main → sync auto vers public (sauf cloud/)
4. Contributors externes → PR sur repo public → merge dans privé

### Alternatives Considérées

| Option             | Avantages          | Inconvénients                    | Verdict   |
| ------------------ | ------------------ | -------------------------------- | --------- |
| Fork privé         | Simple             | Deux repos à gérer, merge manuel | ❌        |
| Git subtree        | Standard           | Complexe, risque d'erreur        | ❌        |
| Monorepo + sync CI | Un workspace, auto | Setup initial                    | ✅ Choisi |

---

## Notes

- Le code auth actuel (`src/lib/auth.ts`, `src/server/auth/oauth.ts`) reste dans Core car il gère le
  mode local
- La logique `isCloudMode()` est essentielle pour le dual-mode
- BMAD reste dans le repo (outil de dev, pas le produit)
- Les docs restent publiques pour la communauté

---

_Tech-spec créée via BMAD Quick-Flow_
