# Tech-Spec: Smithery MCP Loader

**Created:** 2025-12-12 **Status:** Ready for Development

## Overview

### Problem Statement

Actuellement, les serveurs MCP sont configurés manuellement dans un fichier local
(`config/.mcp-servers.json`). Pour ajouter un nouveau serveur Smithery, il faut :

1. Aller sur smithery.ai configurer le serveur
2. Copier la config dans le fichier local
3. Redémarrer la gateway

Cette approche crée une duplication et une désynchronisation entre Smithery et la config locale.

### Solution

Ajouter la possibilité de charger dynamiquement les serveurs MCP depuis Smithery en utilisant l'API
registry. La gateway PML chargera les serveurs depuis **deux sources** :

1. **Fichier local** (`config/.mcp-servers.json`) - pour les MCP locaux (playwright, etc.)
2. **Smithery API** - pour les MCP distants configurés dans le profil utilisateur

Les serveurs Smithery seront connectés via le SDK Smithery qui gère le transport HTTP Streamable.

### Scope

**In Scope:**

- Nouveau module `SmitheryLoader` pour charger les serveurs depuis l'API Smithery
- Nouveau client `SmitheryMCPClient` wrapper autour du SDK Smithery
- Mise à jour de `MCPServerDiscovery` pour merger les deux sources
- Mise à jour des types : `protocol: "stdio" | "http"` (remplace "sse" déprécié)
- Support environnements dev/prod avec variables d'environnement distinctes
- Variable d'environnement `SMITHERY_API_KEY` pour l'authentification
- **Sync des schémas Smithery dans la DB** (tool_schema + tool_embedding)
- **Flag `available` sur les tools** pour gérer la disponibilité sans suppression

**Out of Scope:**

- Interface utilisateur pour gérer les profils Smithery
- Gestion des profils multiples (on utilise le profil par défaut lié à la clé)
- Migration automatique des configs existantes
- Suppression automatique des tools (on les marque indisponibles à la place)

## Context for Development

### Codebase Patterns

| Pattern     | Exemple                                                         |
| ----------- | --------------------------------------------------------------- |
| Client MCP  | `src/mcp/client.ts` - MCPClient avec connect/listTools/callTool |
| Discovery   | `src/mcp/discovery.ts` - MCPServerDiscovery.loadConfig()        |
| Types       | `src/mcp/types.ts` - MCPServer, MCPConfig interfaces            |
| Entry point | `src/cli/commands/serve.ts` - orchestration au démarrage        |

### Files to Reference

```
src/mcp/
├── types.ts          # Mettre à jour protocol type
├── discovery.ts      # Ajouter source Smithery
├── client.ts         # Pattern pour nouveau SmitheryMCPClient
├── gateway-server.ts # Pas de modif majeure
├── schema-extractor.ts # Pattern pour extraction et stockage des schémas
└── mod.ts            # Exporter nouveaux modules

src/cli/
├── commands/serve.ts # Charger depuis les deux sources
└── auto-init.ts      # Pattern pour sync au démarrage (Task 8)

src/db/migrations/    # Nouvelle migration pour colonne 'available' (Task 8)

src/vector/
└── search.ts         # Filtrer tools indisponibles (Task 8)

src/graphrag/
└── graph-engine.ts   # Filtrer tools indisponibles dans suggestions (Task 8)

src/web/islands/
└── D3GraphVisualization.tsx  # Ne pas rendre les tools indisponibles (Task 8.6)
```

### Technical Decisions

1. **SDK Smithery vs HTTP natif** → Utiliser `@smithery/sdk` car il gère le transport Streamable
   HTTP et l'authentification OAuth
2. **Merge strategy** → Fichier local prioritaire en cas de conflit d'ID (permet override local)
3. **Lazy vs Eager loading** → Eager au démarrage (comme actuellement) pour découvrir tous les tools
4. **Error handling** → Si Smithery échoue, continuer avec les serveurs locaux (graceful
   degradation)
5. **Soft delete vs Hard delete** → Marquer `available = false` plutôt que supprimer les tools.
   Avantages:
   - Préserve l'historique des capabilities et edges du graph
   - Permet de réactiver un tool si le serveur revient
   - Évite les orphelins dans `tool_embedding` et `tool_dependency`
   - Filtre simple via `WHERE available = true` dans les requêtes

## Implementation Plan

### Tasks

- [ ] **Task 1: Mettre à jour les types MCP**
  - Fichier: `src/mcp/types.ts`
  - Changer `protocol: "stdio" | "sse"` → `protocol: "stdio" | "http"`
  - Ajouter `SmitheryServerConfig` interface pour les serveurs Smithery

- [ ] **Task 2: Créer SmitheryLoader**
  - Nouveau fichier: `src/mcp/smithery-loader.ts`
  - Classe `SmitheryLoader` avec méthode `loadServers(apiKey: string): Promise<MCPServer[]>`
  - Appeler `GET https://registry.smithery.ai/servers` avec Bearer token
  - Parser la réponse et convertir en `MCPServer[]`

- [ ] **Task 3: Créer SmitheryMCPClient**
  - Nouveau fichier: `src/mcp/smithery-client.ts`
  - Wrapper autour de `@smithery/sdk` (`createTransport`)
  - Même interface que `MCPClient` (connect, listTools, callTool, close)
  - Gère la connexion HTTP Streamable vers `server.smithery.ai`

- [ ] **Task 4: Mettre à jour MCPServerDiscovery**
  - Fichier: `src/mcp/discovery.ts`
  - Ajouter méthode `loadFromSmithery(apiKey: string)`
  - Modifier `discoverServers()` pour merger les deux sources
  - Local servers prioritaires (override)

- [ ] **Task 5: Mettre à jour serve.ts**
  - Fichier: `src/cli/commands/serve.ts`
  - Lire `SMITHERY_API_KEY` depuis env
  - Si présent, charger aussi depuis Smithery
  - Logger les sources chargées

- [ ] **Task 6: Ajouter dépendance SDK Smithery**
  - Ajouter `@smithery/sdk` et `@modelcontextprotocol/sdk` dans deno.json imports

- [ ] **Task 7: Tests**
  - Tests unitaires pour SmitheryLoader (mock API)
  - Tests unitaires pour SmitheryMCPClient (mock transport)
  - Test d'intégration avec serveur Smithery réel (optionnel, nécessite clé)

- [ ] **Task 8: Sync des schémas Smithery dans la DB**
  - **Objectif:** Les tools Smithery doivent être découvrables via `pml_search_tools` et suggérés
    par le DAGSuggester
  - **8.1 Ajouter colonne `available` à `tool_schema`**
    - Fichier: `src/db/migrations/` (nouvelle migration)
    - `ALTER TABLE tool_schema ADD COLUMN available BOOLEAN DEFAULT true`
    - Les tools indisponibles ne sont pas supprimés, juste marqués `available = false`
  - **8.2 Modifier `autoInitIfConfigChanged` ou créer `syncSmitheryTools()`**
    - Fichier: `src/cli/auto-init.ts` ou nouveau `src/mcp/smithery-sync.ts`
    - Après connexion des SmitheryMCPClients, appeler `listTools()` sur chaque client
    - Upsert dans `tool_schema` avec `server_id` préfixé `smithery:`
    - Marquer `available = true` pour les tools présents
    - Marquer `available = false` pour les tools `smithery:*` absents du profil actuel
  - **8.3 Générer embeddings pour les nouveaux tools Smithery**
    - Appeler `generateEmbeddings()` après le sync
    - Les tools avec `available = false` gardent leurs embeddings (historique)
  - **8.4 Filtrer les tools indisponibles dans les recherches**
    - Fichier: `src/vector/search.ts` et `src/graphrag/graph-engine.ts`
    - Ajouter `WHERE available = true` dans les requêtes de recherche
    - Le DAGSuggester ne doit pas proposer de tools indisponibles
  - **8.5 Détection des changements Smithery**
    - Option A: Toujours re-sync au démarrage (simple, ~100ms overhead)
    - Option B: Hasher la liste des `qualifiedName` retournés par l'API et comparer
    - Recommandation: Option A pour MVP, Option B en optimisation future
  - **8.6 Visualisation D3: gestion des tools indisponibles**
    - Fichier: `src/web/islands/D3GraphVisualization.tsx`
    - Options d'affichage:
      - **Option A (recommandée):** Ne pas afficher les nodes `available = false` ni leurs edges
      - **Option B:** Afficher en grisé/opacité réduite (effet "fantôme")
    - L'API `/api/graph/tools` doit filtrer ou marquer les tools indisponibles
    - Les edges vers/depuis un tool indisponible doivent être retirés du rendu
    - Impact sur le layout: recalculer les positions sans les nodes manquants

### Acceptance Criteria

- [ ] **AC 1:** Given `SMITHERY_API_KEY` is set, When gateway starts, Then servers from Smithery
      profile are loaded alongside local servers
- [ ] **AC 2:** Given `SMITHERY_API_KEY` is NOT set, When gateway starts, Then only local servers
      are loaded (comportement actuel)
- [ ] **AC 3:** Given a server exists dans les deux sources avec le même ID, When loading, Then la
      config locale est prioritaire
- [ ] **AC 4:** Given Smithery API is unreachable, When gateway starts, Then local servers are still
      loaded and warning is logged
- [ ] **AC 5:** Given a Smithery server is loaded, When calling a tool, Then the request goes
      through Smithery SDK HTTP transport
- [ ] **AC 6:** Given Smithery tools are loaded, When gateway starts, Then their schemas are stored
      in `tool_schema` with `server_id` prefixed `smithery:`
- [ ] **AC 7:** Given Smithery tools are in DB, When calling `pml_search_tools("airtable")`, Then
      Smithery tools matching the query are returned
- [ ] **AC 8:** Given a Smithery server is removed from profile, When gateway restarts, Then its
      tools are marked `available = false` (not deleted)
- [ ] **AC 9:** Given tools have `available = false`, When searching or suggesting DAGs, Then these
      tools are excluded from results
- [ ] **AC 10:** Given a previously unavailable tool becomes available again, When gateway restarts,
      Then its `available` flag is set back to `true`
- [ ] **AC 11:** Given tools have `available = false`, When viewing the D3 graph, Then these tools
      and their edges are not rendered

## Additional Context

### Dependencies

| Dépendance                  | Version | Usage                     |
| --------------------------- | ------- | ------------------------- |
| `@smithery/sdk`             | latest  | Transport HTTP Streamable |
| `@modelcontextprotocol/sdk` | ^1.15.1 | Client MCP standard       |

### Testing Strategy

1. **Unit tests** avec mocks pour l'API Smithery
2. **Integration test** optionnel avec vraie clé (skip en CI si pas de secret)
3. **Manual testing** avec le profil Smithery d'Erwan

### Environment Configuration (Dev/Prod)

Le système supporte des environnements distincts avec des clés Smithery différentes :

| Variable                 | Description                            | Exemple                      |
| ------------------------ | -------------------------------------- | ---------------------------- |
| `SMITHERY_API_KEY`       | Clé API Smithery (utilisée par défaut) | `5a44e00e-...`               |
| `NODE_ENV` ou `DENO_ENV` | Environnement actuel                   | `development` / `production` |

**Comportement par environnement :**

```
┌─────────────────────────────────────────────────────────────┐
│  DEV (localhost)                                            │
│  ├── SMITHERY_API_KEY → profil dev Smithery                 │
│  ├── Fichier: config/.mcp-servers.json                      │
│  └── Logs: verbose                                          │
├─────────────────────────────────────────────────────────────┤
│  PROD (deployed)                                            │
│  ├── SMITHERY_API_KEY → profil prod Smithery                │
│  ├── Fichier: config/.mcp-servers.json (ou env override)    │
│  └── Logs: info level                                       │
└─────────────────────────────────────────────────────────────┘
```

**Configuration recommandée :**

```bash
# .env.development
SMITHERY_API_KEY=dev-key-xxx
MCP_CONFIG_PATH=config/.mcp-servers.json

# .env.production
SMITHERY_API_KEY=prod-key-yyy
MCP_CONFIG_PATH=/etc/pml/mcp-servers.json
```

**Note:** La clé Smithery détermine le profil chargé. Un profil dev peut avoir des serveurs de test,
un profil prod les vrais services.

### Notes

- L'API Smithery retourne uniquement les serveurs du profil lié à la clé API
- Le SDK Smithery gère automatiquement le renouvellement des tokens OAuth
- Les serveurs Smithery utilisent le transport HTTP Streamable (spec MCP 2025-03-26)
- SSE est déprécié depuis mars 2025, ne pas l'implémenter
- Chaque environnement (dev/prod) peut avoir sa propre clé Smithery avec un profil distinct

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code                                                │
│       │                                                     │
│       ▼ HTTP Streamable (POST /mcp)                         │
├─────────────────────────────────────────────────────────────┤
│  PML Gateway (localhost:3003)                               │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ MCPServerDiscovery                                      ││
│  │   ├── loadConfig() → fichier local                      ││
│  │   └── loadFromSmithery(key) → API registry              ││
│  └─────────────────────────────────────────────────────────┘│
│       │                                                     │
│       ├──► MCPClient (stdio) ──► playwright, filesystem     │
│       │                                                     │
│       └──► SmitheryMCPClient (http) ──► server.smithery.ai  │
│                                         ├── airtable        │
│                                         ├── notion          │
│                                         └── gmail...        │
└─────────────────────────────────────────────────────────────┘
```

### API Reference

**Smithery Registry API:**

```http
GET https://registry.smithery.ai/servers
Authorization: Bearer {SMITHERY_API_KEY}

Response:
{
  "servers": [
    {
      "qualifiedName": "@domdomegg/airtable-mcp-server",
      "displayName": "Airtable",
      "remote": true,
      ...
    }
  ]
}
```

**Smithery SDK Usage:**

```typescript
import { createTransport } from "@smithery/sdk/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const transport = createTransport(
  "https://server.smithery.ai/@domdomegg/airtable-mcp-server",
  { airtableApiKey: "..." }, // config from profile
  SMITHERY_API_KEY,
);

const client = new Client({ name: "pml-gateway", version: "1.0.0" });
await client.connect(transport);
const tools = await client.listTools();
```
