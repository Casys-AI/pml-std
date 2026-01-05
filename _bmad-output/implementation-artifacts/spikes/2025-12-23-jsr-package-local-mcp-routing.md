# Spike: Package JSR avec Routing Local/Cloud des MCPs

**Date:** 2025-12-23 **Status:** Draft **Author:** Erwan + Claude

---

## Contexte

### Problème

Quand un utilisateur utilise la gateway PML cloud (`pml.casys.ai`), les MCPs configurés sur le
serveur utilisent :

- Le filesystem du **serveur** (pas celui de l'utilisateur)
- Les clés API du **serveur** (pas celles de l'utilisateur)

### Solution proposée

Un package JSR léger (`jsr:@casys/pml`) qui :

1. S'installe localement chez l'utilisateur
2. Télécharge dynamiquement le code des MCPs depuis le serveur PML
3. Exécute les MCPs "locaux" (filesystem, shell) sur la machine de l'utilisateur
4. Forward les MCPs "cloud" (pml:search, GraphRAG) vers le serveur

---

## Architecture

```
Claude Code
    │ stdio
    ▼
jsr:@casys/pml (package léger, ~quelques KB)
    │
    ├─► MCPs "locaux" (routing: local)
    │     │
    │     │ import("https://pml.casys.ai/mcps/filesystem/mod.ts")
    │     │   → Code téléchargé + caché par Deno
    │     │   → Exécuté localement avec sandbox
    │     │   → Accès au workspace de l'utilisateur
    │     │
    │     ├─► filesystem:read  → --allow-read=${WORKSPACE}
    │     ├─► filesystem:write → --allow-write=${WORKSPACE}
    │     └─► shell:exec       → --allow-run (avec HIL)
    │
    └─► MCPs "cloud" (routing: cloud)
          │
          │ HTTP POST https://pml.casys.ai/rpc
          │
          ├─► pml:search (GraphRAG)
          ├─► pml:execute (DAG Engine)
          └─► tavily:search (BYOK via env local)
```

---

## Question ouverte : Définition du Workspace

### Comment définir le chemin du workspace ?

Le workspace détermine :

- Où `filesystem:read/write` peut accéder
- Le CWD pour `shell:exec`
- Les permissions sandbox Deno

### Options

| Option                  | Description                           | Avantages           | Inconvénients             |
| ----------------------- | ------------------------------------- | ------------------- | ------------------------- |
| **A. CWD**              | `Deno.cwd()` au lancement             | Simple, naturel     | Peut changer si mal lancé |
| **B. Config explicite** | `pml init --workspace=/path`          | Explicite, contrôlé | Config supplémentaire     |
| **C. Détection auto**   | Remonte jusqu'à `.git` ou `deno.json` | Intelligent         | Peut se tromper           |
| **D. Env var**          | `PML_WORKSPACE=/path`                 | Flexible            | Pas toujours défini       |
| **E. Paramètre MCP**    | Passé dans `.mcp.json`                | Standard MCP        | Verbeux                   |

### Recommandation : Option A + C (fallback)

```typescript
function resolveWorkspace(): string {
  // 1. Variable d'environnement (priorité max)
  const envWorkspace = Deno.env.get("PML_WORKSPACE");
  if (envWorkspace) return envWorkspace;

  // 2. Détection auto (remonte jusqu'à un marqueur de projet)
  const detected = findProjectRoot(Deno.cwd(), [
    ".git",
    "deno.json",
    "deno.jsonc",
    "package.json",
    ".pml.json", // Notre propre marqueur
  ]);
  if (detected) return detected;

  // 3. Fallback: CWD
  return Deno.cwd();
}
```

### Config `.pml.json` (optionnel)

```json
{
  "workspace": "/home/user/my-project",
  "apiKey": "${PML_API_KEY}",
  "cloudUrl": "https://pml.casys.ai",
  "localMcps": ["filesystem", "shell"],
  "env": {
    "TAVILY_API_KEY": "${TAVILY_API_KEY}"
  }
}
```

---

## Routing basé sur SWC + Config

### Extension de `mcp-permissions.yaml`

```yaml
# config/mcp-permissions.yaml

filesystem:
  scope: filesystem
  approvalMode: auto
  routing: local # ← NOUVEAU

shell:
  scope: filesystem
  approvalMode: hil
  routing: local

sqlite:
  scope: filesystem
  approvalMode: auto
  routing: local

tavily:
  scope: network-api
  approvalMode: auto
  routing: cloud

github:
  scope: network-api
  approvalMode: auto
  routing: cloud

pml:
  scope: mcp-standard
  approvalMode: auto
  routing: cloud
```

### Modification du `PermissionInferrer`

```typescript
// src/capabilities/permission-inferrer.ts

export type McpRouting = "local" | "cloud";

interface McpPermissionConfigExplicit {
  scope: PermissionScope;
  approvalMode?: ApprovalMode;
  routing?: McpRouting; // ← NOUVEAU
  isReadOnly?: boolean;
}

// Nouvelle fonction exportée
export function getToolRouting(toolPrefix: string): McpRouting {
  const cache = getMcpPermissions();
  return cache[toolPrefix]?.routing ?? "cloud"; // Default: cloud
}
```

### Utilisation dans l'exécution

```typescript
// src/dag/executor.ts (ou le package JSR)

async function executeToolCall(
  mcpName: string,
  toolName: string,
  args: unknown,
  workspace: string,
) {
  const routing = getToolRouting(mcpName);

  if (routing === "local") {
    // Import dynamique depuis le serveur PML
    const mod = await import(`https://pml.casys.ai/mcps/${mcpName}/mod.ts`);

    // Exécute avec sandbox Deno
    const permissions = inferPermissionsForTool(mcpName, toolName);
    return await executeInSandbox(mod, toolName, args, {
      workspace,
      permissions,
    });
  } else {
    // Forward au cloud RPC
    return await cloudRpc.callTool(`${mcpName}:${toolName}`, args);
  }
}
```

---

## Sandbox Deno pour MCPs locaux

### Permissions dynamiques

```typescript
function getDenoPermissions(
  mcpName: string,
  toolName: string,
  workspace: string,
): string[] {
  const perms: string[] = [];

  switch (mcpName) {
    case "filesystem":
      if (toolName.startsWith("read")) {
        perms.push(`--allow-read=${workspace}`);
      } else if (toolName.startsWith("write")) {
        perms.push(`--allow-read=${workspace}`);
        perms.push(`--allow-write=${workspace}`);
      }
      break;

    case "shell":
      perms.push(`--allow-run`);
      perms.push(`--allow-read=${workspace}`);
      break;

    case "fetch":
      perms.push(`--allow-net`);
      break;
  }

  return perms;
}
```

### Exécution sandboxée

```typescript
async function executeInSandbox(
  mod: McpModule,
  toolName: string,
  args: unknown,
  options: { workspace: string; permissions: string[] },
): Promise<ToolResult> {
  // Option 1: Worker avec permissions limitées
  const worker = new Worker(
    new URL("./sandbox-worker.ts", import.meta.url),
    {
      type: "module",
      deno: {
        permissions: {
          read: [options.workspace],
          write: [options.workspace],
          net: false,
          run: false,
        },
      },
    },
  );

  // Option 2: Subprocess Deno avec flags
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      ...options.permissions,
      "--no-prompt",
      "executor.ts",
      JSON.stringify({ toolName, args }),
    ],
    cwd: options.workspace,
  });

  return await cmd.output();
}
```

---

## Package JSR : Structure

```
packages/pml/
├── deno.json           # Config JSR
├── mod.ts              # Entry point
├── src/
│   ├── client.ts       # MCP stdio server
│   ├── router.ts       # Local/Cloud routing
│   ├── local/
│   │   ├── executor.ts # Exécution locale sandboxée
│   │   └── loader.ts   # Import dynamique des MCPs
│   ├── cloud/
│   │   └── rpc.ts      # Client RPC vers pml.casys.ai
│   └── workspace.ts    # Résolution du workspace
└── README.md
```

### `deno.json`

```json
{
  "name": "@casys/pml",
  "version": "0.1.0",
  "exports": "./mod.ts",
  "tasks": {
    "serve": "deno run -A mod.ts serve"
  },
  "publish": {
    "include": ["mod.ts", "src/**/*.ts", "README.md"]
  }
}
```

### `mod.ts` (entry point)

```typescript
import { MCPServer } from "./src/client.ts";
import { resolveWorkspace } from "./src/workspace.ts";

const workspace = resolveWorkspace();
const apiKey = Deno.env.get("PML_API_KEY");

if (!apiKey) {
  console.error("PML_API_KEY required. Get one at https://pml.casys.ai");
  Deno.exit(1);
}

const server = new MCPServer({
  workspace,
  apiKey,
  cloudUrl: Deno.env.get("PML_CLOUD_URL") ?? "https://pml.casys.ai",
});

// Expose via stdio pour Claude Code
await server.serve();
```

---

## Installation & Usage

### Pour l'utilisateur

```bash
# 1. Installer le package
deno install -A -n pml jsr:@casys/pml

# 2. Configurer
cd mon-projet
pml init
# → Entre ton API key: ac_xxx
# → Génère .mcp.json

# 3. C'est tout ! Claude Code utilise PML
```

### `.mcp.json` généré

```json
{
  "mcpServers": {
    "pml": {
      "command": "pml",
      "args": ["serve"],
      "env": {
        "PML_API_KEY": "ac_xxx",
        "PML_WORKSPACE": "/home/user/mon-projet"
      }
    }
  }
}
```

---

## MCPs servis depuis le cloud

### Endpoint `/mcps/{name}/mod.ts`

Le serveur PML expose le code des MCPs :

```
GET https://pml.casys.ai/mcps/filesystem/mod.ts
GET https://pml.casys.ai/mcps/shell/mod.ts
GET https://pml.casys.ai/mcps/fetch/mod.ts
```

Ces fichiers sont :

- Du code TypeScript/Deno standard
- Exécutés localement chez l'utilisateur
- Mis en cache par Deno (pas de re-téléchargement)

### Exemple : `filesystem/mod.ts`

```typescript
// https://pml.casys.ai/mcps/filesystem/mod.ts

export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "read_file":
      const content = await Deno.readTextFile(args.path as string);
      return { content: [{ type: "text", text: content }] };

    case "write_file":
      await Deno.writeTextFile(args.path as string, args.content as string);
      return { content: [{ type: "text", text: "File written" }] };

    case "list_directory":
      const entries = [];
      for await (const entry of Deno.readDir(args.path as string)) {
        entries.push(entry.name);
      }
      return { content: [{ type: "text", text: entries.join("\n") }] };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

---

## Prochaines étapes

1. [ ] Valider l'approche workspace (Option A+C)
2. [ ] Ajouter champ `routing` à `mcp-permissions.yaml`
3. [ ] Modifier `PermissionInferrer` pour exposer le routing
4. [ ] Créer le package JSR `@casys/pml` (structure minimale)
5. [ ] Implémenter le loader dynamique (`import()` depuis URL)
6. [ ] Implémenter la sandbox Deno pour MCPs locaux
7. [ ] Exposer les MCPs sur `/mcps/{name}/mod.ts` côté serveur
8. [ ] Tests E2E : package local → cloud → exécution locale

---

## Questions ouvertes

1. **Versioning des MCPs distants** : Comment gérer les versions ?
   - `https://pml.casys.ai/mcps/filesystem/mod.ts?v=1.2.0`
   - Ou laisser Deno gérer le cache + lock file ?

2. **Hot reload** : Si on update un MCP côté serveur, comment invalider le cache Deno des users ?

3. **MCPs tiers** : L'utilisateur peut-il ajouter ses propres MCPs locaux non-PML ?

4. **Fallback offline** : Que faire si le cloud est injoignable ? Cache local des MCPs ?

---

## Références

- [ADR-040: Multi-tenant MCP & Secrets Management](../adrs/ADR-040-multi-tenant-mcp-secrets-management.md)
- [Tech-spec: Open Core Workspace](../tech-specs/tech-spec-open-core-workspace.md)
- [SWC Static Structure Detection](../architecture/swc-static-structure-detection.md)
- [Permission Inferrer](../../src/capabilities/permission-inferrer.ts)
- [Deno Permissions](https://docs.deno.com/runtime/fundamentals/security/)
