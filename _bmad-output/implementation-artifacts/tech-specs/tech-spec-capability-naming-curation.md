# Tech Spec: Capability Naming & Curation System

Status: draft

> **Epic:** 12 - Advanced Capability Management (proposed) **Related:** Story 10.7 (pml_execute),
> Story 10.6 (pml_discover) **Author:** Erwan + BMad Master **Date:** 2025-12-22

---

## Problem Statement

### Le Gap Actuel

Quand `pml_discover` ou `pml_execute` retourne des capabilities, l'agent reçoit :

```typescript
{
  id: "abc123",           // ID opaque - pas mémorisable
  code_snippet: "...",    // Code complet - doit tout recopier
  score: 0.92
}
```

**Problèmes identifiés :**

| Problème              | Impact                                              |
| --------------------- | --------------------------------------------------- |
| Pas de nom callable   | L'agent ne peut pas dire "exécute read_json_config" |
| Doit recopier le code | Gaspillage de tokens, erreurs de copie              |
| Pas de paramétrage    | Impossible de réutiliser avec args différents       |
| Pas de composition    | Impossible de mixer des capabilities existantes     |

### Ce qui manque

1. **Noms stables** pour les capabilities (pas juste des IDs)
2. **Namespaces** pour organiser (`fs:`, `api:`, `db:`)
3. **Appel par nom** avec override d'arguments
4. **Curation automatique** pour maintenir la cohérence

---

## Capability DNS System

### Vision : Un vrai système DNS pour capabilities

Au lieu d'UUIDs opaques, un système de nommage hiérarchique complet avec métadonnées riches.

### Structure FQDN (Fully Qualified Domain Name)

```
<org>.<project>.<namespace>.<action>.<hash>
```

**Exemples :**

```
acme.webapp.fs.read_json.a7f3
acme.webapp.api.fetch_user.b8e2
acme.mobile.api.fetch_user.c9d1      # Même action, projet différent
stripe.billing.api.create_invoice.d0e2
marketplace.public.fs.read_json.x9z1  # Capability publique
```

### Hiérarchie

```
                 ┌─────────────────────────────────────┐
                 │           PML SaaS                   │
                 └─────────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
      [acme]                 [stripe]             [marketplace]
         │                       │                       │
   ┌─────┴─────┐           ┌─────┴─────┐                 │
   ▼           ▼           ▼           ▼                 ▼
[webapp]   [mobile]    [billing]   [api]            [public]
   │           │           │           │                 │
   ▼           ▼           ▼           ▼                 ▼
fs.read     api.fetch   api.create  db.query       fs.read_json
fs.write    api.post    api.update  db.insert      api.fetch
```

### Capability Record (comme DNS Record)

```typescript
interface CapabilityRecord {
  // === Identité (comme A record) ===
  fqdn: string; // "acme.webapp.fs.read_json.a7f3"
  display_name: string; // "fs:read_json"

  // === Créateur (comme WHOIS) ===
  created_by: string; // "erwan@acme.io"
  created_at: string; // "2025-12-22T14:30:00Z"

  // === Versioning (comme SOA) ===
  version: number; // 3
  version_tag?: string; // "v1.2.0" (semantic optional)
  updated_by: string; // "claude-agent-xyz"
  updated_at: string; // "2025-12-22T16:45:00Z"

  // === TTL & Cache (comme DNS TTL) ===
  ttl?: number; // Cache duration en secondes
  cache_policy: "none" | "memoize" | "persistent";

  // === Provenance (comme CNAME/alias) ===
  parent_id?: string; // Si fork d'une autre capability
  aliases: string[]; // Anciens noms
  forked_from?: string; // FQDN source si fork

  // === Trust (comme DNSSEC) ===
  verified: boolean; // Testé et validé
  signature?: string; // Hash du code signé

  // === Stats (comme DNS analytics) ===
  usage_count: number;
  success_rate: number;
  avg_latency_ms: number;

  // === Classification ===
  namespace: string; // "fs"
  tags: string[]; // ["io", "json", "read"]
  visibility: "private" | "project" | "org" | "public";
}
```

### Exemple de Record complet

```typescript
{
  fqdn: "acme.webapp.fs.read_json.a7f3",
  display_name: "fs:read_json",

  created_by: "erwan@acme.io",
  created_at: "2025-12-22T14:30:00Z",

  version: 3,
  version_tag: "v1.2.0",
  updated_by: "claude-opus-4",
  updated_at: "2025-12-22T16:45:00Z",

  ttl: 3600,
  cache_policy: "memoize",

  parent_id: null,
  aliases: ["fs:read_config", "fs:load_json"],
  forked_from: null,

  verified: true,
  signature: "sha256:e3b0c44...",

  usage_count: 1547,
  success_rate: 0.98,
  avg_latency_ms: 45,

  namespace: "fs",
  tags: ["io", "json", "read", "config"],
  visibility: "project"
}
```

### Versioning

```
acme.webapp.fs.read_json.a7f3          # Latest (résolution par défaut)
acme.webapp.fs.read_json.a7f3@v1       # Version majeure
acme.webapp.fs.read_json.a7f3@v1.2.0   # Semantic version exacte
acme.webapp.fs.read_json.a7f3@2025-12-22  # Snapshot par date
```

### Query API (comme nslookup/dig)

```typescript
// Lookup simple (équivalent A record)
await pml.lookup("fs:read_json");
// → { fqdn: "acme.webapp.fs.read_json.a7f3", ... }

// Query par créateur
await pml.query({ created_by: "erwan@*" });

// Query par version
await pml.query({ version_tag: "v1.*" });

// Query par tags
await pml.query({ tags: ["json", "read"] });

// Query cross-org (capabilities publiques)
await pml.query({ visibility: "public", namespace: "fs" });

// Historique (comme DNS zone transfer)
await pml.history("fs:read_json");
// → [v3, v2, v1] avec diffs

// Whois
await pml.whois("acme.webapp.fs.read_json.a7f3");
// → { created_by, created_at, updated_by, usage_stats, ... }
```

### Résolution par scope (comme DNS resolver)

```typescript
// Session context
const session = { org: "acme", project: "webapp" };

// L'agent appelle (nom court)
await mcp.call("cap:fs:read_json", args);

// Gateway résout avec scope implicite :
// "fs:read_json"
//   → cherche "acme.webapp.fs.read_json.*"
//   → trouve "acme.webapp.fs.read_json.a7f3"
//   → exécute

// Appel cross-project (FQDN explicite)
await mcp.call("cap:acme.shared:fs:read_json", args);
```

### Fork & Merge

Pas besoin d'`import` - tout est accessible via FQDN. On garde `fork` et `merge` :

#### Fork (copier pour modifier)

```typescript
// Copier une capability publique pour la customiser
await mcp.call("dns:fork", {
  source: "marketplace.public.fs.read_json",
  name: "fs:read_json_custom",
});
// → Crée acme.webapp.fs.read_json_custom.x1y2
//   avec le code copié, modifiable localement
```

#### Merge (combiner plusieurs capabilities)

```typescript
// Combiner plusieurs capabilities en pipeline
await mcp.call("dns:merge", {
  sources: [
    "cap:fs:read_json",
    "cap:transform:validate_schema"
  ],
  name: "fs:read_validated_json",
  // Optionnel: code custom, sinon génération auto
  code?: "const data = await cap_fs_read_json(args); return cap_transform_validate(data);"
});
```

**Use case merge :**

```
cap:fs:read_json          →  lit fichier JSON
cap:transform:validate    →  valide contre schema
                          ↓
cap:fs:read_validated_json  →  lit ET valide (pipeline)
```

### Schéma DB enrichi

```sql
CREATE TABLE capability_records (
  -- Identity
  id TEXT PRIMARY KEY,              -- FQDN: "acme.webapp.fs.read_json.a7f3"
  display_name TEXT NOT NULL,

  -- Hierarchy
  org TEXT NOT NULL,
  project TEXT NOT NULL,
  namespace TEXT NOT NULL,
  action TEXT NOT NULL,
  hash TEXT NOT NULL,

  -- Creator (WHOIS)
  created_by TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Versioning (SOA)
  version INTEGER DEFAULT 1,
  version_tag TEXT,
  updated_by TEXT,
  updated_at TIMESTAMP,

  -- Cache (TTL)
  ttl INTEGER,
  cache_policy TEXT DEFAULT 'none',

  -- Provenance (CNAME)
  parent_id TEXT REFERENCES capability_records(id),
  forked_from TEXT,

  -- Trust (DNSSEC)
  verified BOOLEAN DEFAULT FALSE,
  signature TEXT,

  -- Stats
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  total_latency_ms BIGINT DEFAULT 0,

  -- Classification
  tags TEXT[],
  visibility TEXT DEFAULT 'private',

  -- Content
  code_snippet TEXT NOT NULL,
  parameters_schema JSONB,
  description TEXT,

  -- Indexes
  UNIQUE(org, project, namespace, action, hash)
);

-- Index pour résolution rapide par scope
CREATE INDEX idx_cap_org_project ON capability_records(org, project);
CREATE INDEX idx_cap_display_name ON capability_records(org, project, display_name);
CREATE INDEX idx_cap_namespace ON capability_records(namespace);
CREATE INDEX idx_cap_created_by ON capability_records(created_by);
CREATE INDEX idx_cap_tags ON capability_records USING GIN(tags);
CREATE INDEX idx_cap_visibility ON capability_records(visibility);

-- Table des alias (CNAME)
CREATE TABLE capability_aliases (
  alias TEXT NOT NULL,              -- "fs:read_config"
  org TEXT NOT NULL,
  project TEXT NOT NULL,
  target_fqdn TEXT NOT NULL,        -- "acme.webapp.fs.read_json.a7f3"
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org, project, alias),
  FOREIGN KEY (target_fqdn) REFERENCES capability_records(id)
);

-- Table d'historique des versions
CREATE TABLE capability_versions (
  id SERIAL PRIMARY KEY,
  capability_fqdn TEXT NOT NULL,
  version INTEGER NOT NULL,
  version_tag TEXT,
  code_snippet TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  change_summary TEXT,
  FOREIGN KEY (capability_fqdn) REFERENCES capability_records(id),
  UNIQUE(capability_fqdn, version)
);
```

---

## PML Standard Library (`lib/std/mcp/`)

### Architecture : Un seul serveur stdlib

```
lib/
└── std/
    └── mcp/
        ├── mod.ts           # PmlStdServer (serveur unique)
        ├── cap.ts           # Module cap:* (capabilities)
        ├── dns.ts           # Module dns:* (registry)
        ├── meta.ts          # Module meta:* (introspection)
        └── learn.ts         # Module learn:* (apprentissage)
```

### Serveur unique `pml-std`

```typescript
// lib/std/mcp/mod.ts
import { CapModule } from "./cap.ts";
import { DnsModule } from "./dns.ts";
import { MetaModule } from "./meta.ts";
import { LearnModule } from "./learn.ts";

export class PmlStdServer implements MCPServer {
  readonly serverId = "pml-std";

  private cap: CapModule;
  private dns: DnsModule;
  private meta: MetaModule;
  private learn: LearnModule;

  async listTools(): Promise<Tool[]> {
    return [
      ...this.cap.listTools(), // cap:*
      ...this.dns.listTools(), // dns:*
      ...this.meta.listTools(), // meta:*
      ...this.learn.listTools(), // learn:*
    ];
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    const [prefix] = name.split(":");
    switch (prefix) {
      case "cap":
        return this.cap.call(name, args);
      case "dns":
        return this.dns.call(name, args);
      case "meta":
        return this.meta.call(name, args);
      case "learn":
        return this.learn.call(name, args);
      default:
        throw new Error(`Unknown prefix: ${prefix}`);
    }
  }
}
```

### Tools exposés par `pml-std`

```typescript
const tools = await mcp.listTools();
// [
//   // === cap:* (capabilities dynamiques) ===
//   "cap:fs:read_json",
//   "cap:api:fetch_user",
//   "cap:transform:csv_to_json",
//
//   // === dns:* (registry & mutations) ===
//   "dns:lookup",      // Résoudre un nom → FQDN
//   "dns:query",       // Recherche avancée
//   "dns:whois",       // Métadonnées complètes
//   "dns:history",     // Historique versions
//   "dns:fork",        // Copier pour modifier
//   "dns:merge",       // Combiner capabilities
//   "dns:rename",      // Renommer (alias auto)
//   "dns:tag",         // Modifier tags
//
//   // === meta:* (introspection) ===
//   "meta:tools",      // Lister tous les tools
//   "meta:servers",    // Lister les serveurs
//   "meta:stats",      // Statistiques usage
//
//   // === learn:* (apprentissage) ===
//   "learn:save",      // Sauvegarder capability
//   "learn:curate",    // Curation noms/tags
//   "learn:feedback",  // Feedback success/failure
// ]
```

### Intégration dans Gateway

```typescript
// src/mcp/gateway-server.ts
import { PmlStdServer } from "lib/std/mcp/mod.ts";

export class GatewayServer {
  private stdlib: PmlStdServer;
  private realServers: Map<string, MCPServer>;

  async initialize() {
    // Real servers (stdio/sse)
    await this.loadRealServers();

    // Stdlib (in-process)
    this.stdlib = new PmlStdServer({
      capabilityStore: this.capabilityStore,
      db: this.db,
    });
  }

  async handleListTools(): Promise<Tool[]> {
    return [
      ...await this.collectRealServerTools(),
      ...await this.stdlib.listTools(),
    ];
  }

  async handleCallTool(name: string, args: unknown): Promise<ToolResult> {
    // Route to stdlib if prefix matches
    if (["cap", "dns", "meta", "learn"].some((p) => name.startsWith(`${p}:`))) {
      return this.stdlib.callTool(name, args);
    }
    // Route to real server
    return this.routeToRealServer(name, args);
  }
}
```

---

## Proposed Solution

### Architecture en 2 temps

```
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 1: Création rapide (pas de friction)                         │
└─────────────────────────────────────────────────────────────────────┘
                              │
     pml_execute({ intent, code })
                              │
                              ▼
     Capability créée avec nom AUTO-GÉNÉRÉ
     → "cap_a7f3" ou "unnamed_read_parse_001"
                              │
                              │
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 2: Curation (agent ou batch)                                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
     pml_curate_capabilities({ strategy: "auto" })
                              │
                              ▼
     Agent analyse les capabilities :
     - Détecte patterns / clusters
     - Propose noms avec namespaces
     - Renomme en batch
                              │
                              ▼
     "cap_a7f3" → "fs:read_json"
     "cap_b8e2" → "fs:write_json"
     "cap_c9d1" → "api:fetch_user"
```

### Naming Convention

```
<namespace>:<action>_<target>[_<variant>]
```

**Exemples :**

| Capability             | Namespace   | Name                    |
| ---------------------- | ----------- | ----------------------- |
| Lire un fichier JSON   | `fs`        | `fs:read_json`          |
| Écrire un fichier JSON | `fs`        | `fs:write_json`         |
| Fetch API utilisateur  | `api`       | `api:fetch_user`        |
| Fetch API avec auth    | `api`       | `api:fetch_user_auth`   |
| Query SQL simple       | `db`        | `db:query_simple`       |
| Transform data         | `transform` | `transform:json_to_csv` |

**Namespaces proposés :**

| Namespace   | Domaine               |
| ----------- | --------------------- |
| `fs`        | Filesystem operations |
| `api`       | HTTP/REST calls       |
| `db`        | Database queries      |
| `transform` | Data transformation   |
| `git`       | Git operations        |
| `shell`     | Shell commands        |
| `ai`        | AI/LLM calls          |
| `util`      | Utilities             |

---

## Virtual MCP Server for Capabilities

### Pourquoi un serveur MCP virtuel ?

Pour que les capabilities soient des **citoyens MCP de première classe**, elles doivent passer par
le même flow que les tools normaux :

| Aspect      | Sans serveur virtuel          | Avec serveur virtuel           |
| ----------- | ----------------------------- | ------------------------------ |
| Découverte  | `pml_discover` séparé         | Apparaît dans `tools/list`     |
| Appel       | `pml_execute({ capability })` | `mcp.call("cap:fs:read_json")` |
| RPC         | Flow custom                   | Même flow que tous les tools   |
| Permissions | Système séparé                | Même système de permissions    |
| Tracking    | Custom                        | `tool_usage` automatique       |
| Métriques   | Custom                        | Observabilité unifiée          |

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  MCP Gateway                                                         │
└─────────────────────────────────────────────────────────────────────┘
        │
        ├── filesystem (serveur réel - stdio/sse)
        │     └── fs:read, fs:write, fs:list
        │
        ├── github (serveur réel - stdio/sse)
        │     └── github:create_issue, github:list_prs
        │
        └── pml-capabilities (serveur VIRTUEL - in-process)
              │
              ├── cap:fs:read_json         ← Généré dynamiquement
              ├── cap:fs:write_json
              ├── cap:api:fetch_user
              └── cap:transform:csv_to_json
```

### Implémentation du serveur virtuel

```typescript
// src/mcp/servers/capability-server.ts

import { MCPServer, Tool, ToolResult } from "../types.ts";
import { CapabilityStore } from "../../capabilities/capability-store.ts";
import { WorkerBridge } from "../../dag/worker-bridge.ts";

/**
 * Virtual MCP Server that exposes named capabilities as tools.
 *
 * Unlike real MCP servers (stdio/sse), this runs in-process
 * and generates tools dynamically from the CapabilityStore.
 */
export class CapabilityMCPServer implements MCPServer {
  readonly serverId = "pml-capabilities";
  readonly isVirtual = true;

  constructor(
    private capabilityStore: CapabilityStore,
    private workerBridge: WorkerBridge,
  ) {}

  /**
   * List all named capabilities as MCP tools.
   * Called by Gateway on tools/list request.
   */
  async listTools(): Promise<Tool[]> {
    const capabilities = await this.capabilityStore.listNamed();

    return capabilities.map((cap) => ({
      name: `cap:${cap.name}`, // ex: "cap:fs:read_json"
      description: cap.description ?? `Capability: ${cap.name}`,
      inputSchema: cap.parametersSchema ?? {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    }));
  }

  /**
   * Execute a capability by name.
   * Called by Gateway on tools/call request.
   */
  async callTool(name: string, args: unknown): Promise<ToolResult> {
    // "cap:fs:read_json" → "fs:read_json"
    const capName = name.replace(/^cap:/, "");

    const capability = await this.capabilityStore.getByName(capName);
    if (!capability) {
      return {
        isError: true,
        content: [{ type: "text", text: `Capability not found: ${capName}` }],
      };
    }

    // Inject args into code context
    const result = await this.workerBridge.execute({
      code: capability.codeSnippet,
      context: args as Record<string, unknown>,
      permissions: capability.permissionSet ?? "minimal",
    });

    // Update usage stats
    await this.capabilityStore.recordUsage(capability.id, result.success);

    return {
      isError: !result.success,
      content: [{
        type: "text",
        text: JSON.stringify(result.value ?? result.error),
      }],
    };
  }
}
```

### Intégration dans le Gateway

```typescript
// src/mcp/gateway-server.ts

import { CapabilityMCPServer } from "./servers/capability-server.ts";

export class GatewayServer {
  private capabilityServer: CapabilityMCPServer;
  private realServers: Map<string, MCPServer>;

  async initialize() {
    // ... init real servers ...

    // Init virtual capability server
    this.capabilityServer = new CapabilityMCPServer(
      this.capabilityStore,
      this.workerBridge,
    );
  }

  async handleListTools(): Promise<Tool[]> {
    const tools: Tool[] = [];

    // Collect from real servers
    for (const server of this.realServers.values()) {
      tools.push(...await server.listTools());
    }

    // Add virtual capability tools
    tools.push(...await this.capabilityServer.listTools());

    return tools;
  }

  async handleCallTool(name: string, args: unknown): Promise<ToolResult> {
    // Route to capability server if cap:* prefix
    if (name.startsWith("cap:")) {
      return this.capabilityServer.callTool(name, args);
    }

    // Route to real server
    const server = this.findServerForTool(name);
    return server.callTool(name, args);
  }
}
```

### Flow complet pour l'agent

```typescript
// 1. L'agent fait tools/list
const tools = await mcp.listTools();
// → [
//     { name: "fs:read", ... },           // Real server
//     { name: "github:create_issue", ... }, // Real server
//     { name: "cap:fs:read_json", ... },  // Virtual capability!
//     { name: "cap:api:fetch_user", ... }, // Virtual capability!
//   ]

// 2. L'agent appelle une capability comme un tool normal
const result = await mcp.call("cap:fs:read_json", {
  path: "config.json",
});
// → Passe par Gateway → CapabilityMCPServer → WorkerBridge → Result

// 3. Tracking automatique dans tool_usage table
// → tool_id: "cap:fs:read_json", success: true, duration_ms: 45
```

### Résolution transparente : la magie du RPC

L'agent appelle **toujours par nom**. Le système résout vers l'ID stable en interne. C'est
transparent.

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Agent     │  ──────▶│   Gateway   │  ──────▶│  Capability │
│             │   RPC   │   (résout)  │   ID    │   Store     │
└─────────────┘         └─────────────┘         └─────────────┘
      │                        │                       │
      │  "cap:fs:read_json"    │   "abc123"            │
      │                        │                       │
```

**L'agent n'a jamais besoin de connaître l'ID.** C'est un détail d'implémentation.

#### Principe (comme DNS)

| Analogie     | Nom                | Résolution interne |
| ------------ | ------------------ | ------------------ |
| DNS          | `google.com`       | `142.250.x.x`      |
| Capabilities | `cap:fs:read_json` | `abc123`           |

L'appelant utilise le nom, le système gère la stabilité.

#### Format des tools exposés

```typescript
// Dans tools/list - simple et clean
{
  name: "cap:fs:read_json",      // L'agent appelle ça
  description: "Lit et parse un fichier JSON",
  inputSchema: { ... }
}
// Pas besoin d'exposer l'ID - c'est interne
```

#### Résolution dans CapabilityMCPServer

```typescript
async callTool(name: string, args: unknown): Promise<ToolResult> {
  // "cap:fs:read_json" → "fs:read_json"
  const displayName = name.replace("cap:", "");

  // 1. Chercher par nom actuel
  let capability = await this.capabilityStore.getByName(displayName);

  // 2. Fallback: chercher dans les alias (anciens noms)
  if (!capability) {
    capability = await this.capabilityStore.getByAlias(displayName);
    if (capability) {
      log.warn(`Using deprecated alias "${displayName}" → "${capability.name}"`);
    }
  }

  if (!capability) {
    return { isError: true, content: [{ type: "text", text: `Capability not found: ${displayName}` }] };
  }

  // Exécute par ID interne (jamais exposé à l'agent)
  return await this.executeCapability(capability.id, args);
}
```

#### Table d'alias pour migration douce

```sql
-- Quand on renomme, l'ancien nom devient un alias automatiquement
CREATE TABLE capability_aliases (
  alias TEXT PRIMARY KEY,           -- ex: "fs:read_config" (ancien nom)
  capability_id TEXT NOT NULL,      -- ex: "abc123" (ID stable interne)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (capability_id) REFERENCES workflow_pattern(pattern_id)
);
```

#### Flow de renommage

```typescript
await capabilityStore.rename(capabilityId, "fs:parse_json");

// Automatiquement:
// 1. Récupère ancien nom "fs:read_json"
// 2. Update workflow_pattern.name = "fs:parse_json"
// 3. Insert alias: "fs:read_json" → capabilityId
// 4. Notify: tools/list_changed
```

**Résultat :**

- Nouveau nom : `cap:fs:parse_json` (apparaît dans tools/list)
- Ancien nom : `cap:fs:read_json` (fonctionne toujours via alias)
- L'agent n'a rien à changer, ses appels continuent de marcher

### Refresh dynamique des tools

Quand une capability est nommée/renommée, le Gateway doit notifier les clients :

```typescript
// Après rename d'une capability
await this.capabilityStore.rename(id, "fs:read_json");

// Notifier les clients MCP connectés
await this.gateway.sendNotification("tools/list_changed", {});

// Les clients (Claude, etc.) refont tools/list et voient le nouveau tool
```

### Avantages de cette architecture

| Avantage                 | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| **Unified UX**           | L'agent voit tools réels + capabilities dans la même liste |
| **Zero friction**        | Pas besoin d'API spéciale, juste `mcp.call()`              |
| **Permissions unifiées** | Même système que les autres tools                          |
| **Tracking automatique** | `tool_usage` table capture tout                            |
| **Observabilité**        | Métriques, logs, traces unifiés                            |
| **Extensible**           | Facile d'ajouter d'autres serveurs virtuels                |

---

## API Design

### 1. Création avec nom optionnel

```typescript
pml_execute({
  intent: string,
  code: string,

  // NOUVEAU: nom optionnel (sinon auto-généré)
  name?: string,  // ex: "fs:read_json"
})

// Response inclut le nom assigné
{
  status: "success",
  capabilityId: "abc123",
  capabilityName: "fs:read_json",  // NOUVEAU
  result: ...
}
```

### 2. Appel par nom avec args

```typescript
pml_execute({
  intent: string,

  // NOUVEAU: appeler une capability existante
  capability: string,              // ex: "fs:read_json"
  args?: Record<string, unknown>,  // override arguments
})

// Exemple
pml_execute({
  intent: "lire le fichier settings.json",
  capability: "fs:read_json",
  args: { path: "settings.json" }
})
```

### 3. Tool de curation

```typescript
pml_curate_capabilities({
  // Mode de curation
  strategy: "suggest" | "auto" | "apply",

  // Filtres optionnels
  filter?: {
    unnamed_only?: boolean,    // default: true
    namespace?: string,        // ex: "fs"
    min_usage?: number,        // capabilities utilisées X+ fois
  },

  // Pour mode "apply"
  renames?: Array<{
    id: string,
    name: string
  }>
})
```

**Modes :**

| Mode      | Description                                  |
| --------- | -------------------------------------------- |
| `suggest` | Retourne suggestions de noms (LLM-generated) |
| `auto`    | Applique automatiquement les suggestions     |
| `apply`   | Applique les renames fournis manuellement    |

### 4. Lister les capabilities nommées

```typescript
pml_list_capabilities({
  namespace?: string,     // filtrer par namespace
  named_only?: boolean,   // exclure les unnamed
  sort_by?: "name" | "usage" | "created"
})

// Response
{
  capabilities: [
    {
      id: "abc123",
      name: "fs:read_json",
      description: "Lit et parse un fichier JSON",
      usage_count: 42,
      success_rate: 0.95,
      parameters: ["path"]
    },
    ...
  ]
}
```

---

## Curation Agent Design

### Stratégie de naming automatique

```typescript
async function suggestCapabilityNames(
  capabilities: Capability[],
): Promise<NameSuggestion[]> {
  // 1. Cluster par tools utilisés
  const clusters = clusterByToolsUsed(capabilities);

  // 2. Pour chaque cluster, déterminer namespace
  for (const cluster of clusters) {
    const namespace = inferNamespace(cluster.primaryTools);
    // fs:* si tools sont filesystem
    // api:* si tools sont http/fetch
    // etc.
  }

  // 3. Générer noms via LLM ou heuristiques
  const suggestions = await generateNames(clusters);

  // 4. Détecter collisions
  const deduped = resolveCollisions(suggestions);

  return deduped;
}
```

### Heuristiques de namespace

```typescript
const NAMESPACE_RULES = [
  { tools: ["fs:read", "fs:write", "fs:list"], namespace: "fs" },
  { tools: ["http:fetch", "http:post", "http:get"], namespace: "api" },
  { tools: ["db:query", "db:execute", "sql:*"], namespace: "db" },
  { tools: ["git:*"], namespace: "git" },
  { tools: ["shell:exec", "bash:*"], namespace: "shell" },
];

function inferNamespace(tools: string[]): string {
  for (const rule of NAMESPACE_RULES) {
    if (tools.some((t) => matchesPattern(t, rule.tools))) {
      return rule.namespace;
    }
  }
  return "util"; // default
}
```

### Génération de noms (LLM)

```typescript
const prompt = `
Given this capability:
- Tools used: ${capability.toolsUsed.join(", ")}
- Intent: ${capability.description}
- Code snippet: ${capability.codeSnippet.slice(0, 200)}...

Suggest a short, descriptive name following this pattern:
<namespace>:<action>_<target>

Examples:
- fs:read_json
- api:fetch_user
- transform:csv_to_json

Respond with just the name, nothing else.
`;
```

---

## Database Schema Changes

```sql
-- Ajouter colonne name à workflow_pattern
ALTER TABLE workflow_pattern
ADD COLUMN name TEXT UNIQUE;

-- Index pour lookup par nom
CREATE UNIQUE INDEX idx_capability_name ON workflow_pattern(name)
WHERE name IS NOT NULL;

-- Table d'historique des renames
CREATE TABLE capability_rename_history (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  old_name TEXT,
  new_name TEXT NOT NULL,
  renamed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  renamed_by TEXT,  -- 'auto' | 'user' | 'agent'
  FOREIGN KEY (capability_id) REFERENCES workflow_pattern(pattern_id)
);
```

---

## Acceptance Criteria

### AC1: Création avec nom optionnel

- [ ] `pml_execute` accepte paramètre `name` optionnel
- [ ] Si `name` fourni, valider format `namespace:action_target`
- [ ] Si collision, retourner erreur
- [ ] Response inclut `capabilityName`

### AC2: Appel par nom

- [ ] `pml_execute` accepte paramètre `capability` (nom)
- [ ] Lookup capability par nom
- [ ] Merge args avec paramètres par défaut
- [ ] Exécute le code de la capability

### AC3: Auto-génération de noms

- [ ] Capabilities créées sans nom reçoivent nom temporaire `unnamed_<hash>`
- [ ] Trigger curation après N capabilities unnamed (configurable)

### AC4: Tool pml_curate_capabilities

- [ ] Mode `suggest` : retourne suggestions via LLM + heuristiques
- [ ] Mode `auto` : applique suggestions automatiquement
- [ ] Mode `apply` : applique renames fournis
- [ ] Validation des noms (format, unicité)

### AC5: Tool pml_list_capabilities

- [ ] Liste toutes les capabilities avec leurs noms
- [ ] Filtrage par namespace
- [ ] Tri par usage/date/nom

### AC6: Intégration pml_discover

- [ ] `pml_discover` retourne le `name` des capabilities
- [ ] L'agent peut utiliser le nom pour appeler directement

### AC7: Virtual MCP Server (CapabilityMCPServer)

- [ ] Créer `src/mcp/servers/capability-server.ts`
- [ ] Implémenter `listTools()` → retourne capabilities nommées comme tools
- [ ] Implémenter `callTool()` → exécute capability via WorkerBridge
- [ ] Préfixe `cap:` pour distinguer des tools réels
- [ ] Intégrer dans `GatewayServer.handleListTools()`
- [ ] Intégrer dans `GatewayServer.handleCallTool()`

### AC8: Dynamic tools/list refresh

- [ ] Notification `tools/list_changed` quand capability nommée/renommée
- [ ] Clients MCP reçoivent la notification et refont `tools/list`
- [ ] Capabilities nouvellement nommées apparaissent immédiatement

### AC9: Tracking unifié

- [ ] Appels via `cap:*` trackés dans `tool_usage` table
- [ ] Métriques unifiées avec les tools réels
- [ ] `server_id = "pml-capabilities"` pour filtrage

### AC10: Résolution transparente (RPC magic)

- [ ] Agent appelle par nom : `cap:fs:read_json`
- [ ] Gateway résout nom → FQDN interne (transparent)
- [ ] Fallback alias si nom renommé
- [ ] Table `capability_aliases` créée automatiquement au rename
- [ ] Warning log quand alias utilisé
- [ ] FQDN jamais exposé à l'agent (détail d'implémentation)

### AC11: Capability DNS System

- [ ] Structure FQDN : `<org>.<project>.<namespace>.<action>.<hash>`
- [ ] Table `capability_records` avec métadonnées complètes
- [ ] Champs créateur : `created_by`, `created_at`
- [ ] Champs versioning : `version`, `version_tag`, `updated_by`, `updated_at`
- [ ] Champs trust : `verified`, `signature`
- [ ] Champs visibility : `private | project | org | public`

### AC12: Query API (DNS-like)

- [ ] `pml.lookup(name)` → résolution simple
- [ ] `pml.query({ created_by, tags, visibility, ... })` → recherche avancée
- [ ] `pml.history(name)` → historique des versions
- [ ] `pml.whois(fqdn)` → métadonnées complètes

### AC13: Versioning

- [ ] Table `capability_versions` pour historique
- [ ] Support `@v1`, `@v1.2.0`, `@2025-12-22` dans les appels
- [ ] Résolution `@latest` par défaut

### AC14: Fork & Merge (future - Epic 13+)

- [ ] `dns:fork` - copier une capability pour la modifier
- [ ] `dns:merge` - combiner plusieurs capabilities en pipeline
- [ ] Visibility `public` pour marketplace
- [ ] `forked_from` tracking dans capability_records

### AC15: PML Standard Library (`lib/std/mcp/`)

- [ ] Créer `lib/std/mcp/mod.ts` avec `PmlStdServer`
- [ ] Module `cap.ts` - exécution capabilities dynamiques
- [ ] Module `dns.ts` - registry (lookup, query, whois, history, fork, merge, rename, tag)
- [ ] Module `meta.ts` - introspection (tools, servers, stats)
- [ ] Module `learn.ts` - apprentissage (save, curate, feedback)
- [ ] Intégration dans GatewayServer
- [ ] Routing par préfixe (`cap:`, `dns:`, `meta:`, `learn:`)

---

## Migration Path

### Phase 1: Backward Compatible

- `name` est optionnel
- Anciennes capabilities sans nom continuent de fonctionner
- `pml_execute({ capabilityId })` reste supporté

### Phase 2: Encourage Naming

- Warnings pour capabilities unnamed très utilisées
- Dashboard affiche "unnamed capabilities" count
- Suggestion automatique dans UI

### Phase 3: Naming Required (future)

- Nouvelles capabilities requièrent un nom
- Migration tool pour nommer les anciennes

---

## Open Questions

1. **Collision de noms** : Que faire si `fs:read_json` existe déjà ?
   - Option A: Erreur
   - Option B: Auto-suffix (`fs:read_json_2`)
   - Option C: Versionning (`fs:read_json@v2`)

2. **Scope des noms** : Global ou par user/project ?
   - Option A: Global (simple)
   - Option B: Per-project namespace prefix

3. **Suppression** : Que faire si on supprime une capability nommée ?
   - Option A: Libérer le nom
   - Option B: Garder le nom réservé X jours

4. **LLM pour naming** : Quel modèle utiliser ?
   - Option A: Haiku (rapide, cheap)
   - Option B: Sonnet (meilleure qualité)
   - Option C: Heuristiques uniquement (pas de LLM)

---

## Estimation

### Phase 1 : Core (MVP)

| Task                                  | Effort        |
| ------------------------------------- | ------------- |
| Schema migration (capability_records) | 1 jour        |
| FQDN generation & resolution          | 1 jour        |
| pml_execute name param                | 1 jour        |
| pml_execute capability call           | 1 jour        |
| CapabilityMCPServer                   | 2 jours       |
| Gateway integration                   | 1 jour        |
| tools/list_changed notifications      | 0.5 jour      |
| Résolution transparente + alias       | 0.5 jour      |
| Tests Phase 1                         | 1.5 jour      |
| **Total Phase 1**                     | **9.5 jours** |

### Phase 2 : Curation & Query

| Task                             | Effort      |
| -------------------------------- | ----------- |
| pml_curate_capabilities          | 2 jours     |
| pml_list_capabilities            | 0.5 jour    |
| Curation agent (LLM)             | 2 jours     |
| Query API (lookup, query, whois) | 1.5 jour    |
| Tests Phase 2                    | 1 jour      |
| **Total Phase 2**                | **7 jours** |

### Phase 3 : Versioning & History

| Task                              | Effort      |
| --------------------------------- | ----------- |
| Table capability_versions         | 0.5 jour    |
| Version resolution (@v1, @latest) | 1 jour      |
| pml.history() API                 | 1 jour      |
| Tests Phase 3                     | 0.5 jour    |
| **Total Phase 3**                 | **3 jours** |

### Phase 4 : Fork & Merge (Epic 13+)

| Task                          | Effort      |
| ----------------------------- | ----------- |
| Visibility levels             | 1 jour      |
| dns:fork                      | 1 jour      |
| dns:merge (+ code generation) | 2 jours     |
| Marketplace integration       | 2 jours     |
| Tests Phase 4                 | 1 jour      |
| **Total Phase 4**             | **7 jours** |

### Phase 5 : PML Stdlib (`lib/std/mcp/`)

| Task                      | Effort      |
| ------------------------- | ----------- |
| PmlStdServer architecture | 0.5 jour    |
| Module cap.ts             | 1 jour      |
| Module dns.ts             | 1.5 jour    |
| Module meta.ts            | 0.5 jour    |
| Module learn.ts           | 1 jour      |
| Gateway integration       | 0.5 jour    |
| Tests Phase 5             | 1 jour      |
| **Total Phase 5**         | **6 jours** |

### Résumé

| Phase       | Scope                 | Effort         |
| ----------- | --------------------- | -------------- |
| **Phase 1** | Core MVP              | 9.5 jours      |
| **Phase 2** | Curation & Query      | 7 jours        |
| **Phase 3** | Versioning            | 3 jours        |
| **Phase 4** | Fork & Merge          | 7 jours        |
| **Phase 5** | Stdlib `lib/std/mcp/` | 6 jours        |
| **Total**   | Complet               | **32.5 jours** |

### Files to Create

| File                             | Description                             |
| -------------------------------- | --------------------------------------- |
| `lib/std/mcp/mod.ts`             | PmlStdServer (serveur unique stdlib)    |
| `lib/std/mcp/cap.ts`             | Module cap:* (capabilities)             |
| `lib/std/mcp/dns.ts`             | Module dns:* (registry)                 |
| `lib/std/mcp/meta.ts`            | Module meta:* (introspection)           |
| `lib/std/mcp/learn.ts`           | Module learn:* (apprentissage)          |
| `lib/std/mcp/types.ts`           | Types partagés (CapabilityRecord, etc.) |
| `src/capabilities/fqdn.ts`       | FQDN generation & parsing               |
| `tests/unit/lib/std/mcp_test.ts` | Unit tests stdlib                       |

### Files to Modify

| File                                   | Changes                                      |
| -------------------------------------- | -------------------------------------------- |
| `src/mcp/gateway-server.ts`            | Integrate CapabilityMCPServer                |
| `src/mcp/handlers/execute-handler.ts`  | Add `name`, `capability`, `args` params      |
| `src/capabilities/capability-store.ts` | Add `getByName()`, `rename()`, `listNamed()` |
| `src/db/migrations/`                   | Add name column migration                    |

---

## References

- Story 10.7: pml_execute API
- Story 10.6: pml_discover API
- ADR-050: Unified Search Simplification
