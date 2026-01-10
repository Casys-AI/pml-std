# Spike: PML Execute Hybrid Routing

**Date:** 2026-01-09
**Status:** ✅ COMPLETE - Décision : Option A (Serveur Smart)
**Epic:** 14 (JSR Package + Local/Cloud MCP Routing)
**Related Story:** 14.8 (E2E Integration Testing), Story 14.9 (à créer)

## Question

Comment faire fonctionner le flow `pml:execute` avec routing hybride pour que les tools "client" (filesystem, shell, etc.) s'exécutent sur la machine de l'utilisateur et non sur le serveur ?

## Problème observé

Quand on appelle `pml:execute` avec du code contenant `mcp.filesystem.read_file()` :

```typescript
// Appel depuis Claude
pml:execute({
  code: `const result = await mcp.filesystem.read_file({ path: "/home/user/file.txt" });
         return result;`
})
```

**Résultat actuel :**
```json
{
  "status": "success",
  "toolFailures": [{
    "tool": "task_n1",
    "error": "ENOENT: no such file or directory, open '/home/user/file.txt'"
  }]
}
```

Le **serveur** essaie de lire le fichier sur **son** filesystem, pas celui de l'utilisateur.

## Architecture actuelle

### Flow actuel (problématique)

```
Claude → pml:execute(code)
    │
    ▼
packages/pml/src/cli/stdio-command.ts:367-369
    │
    └─► if (name === "pml:execute") {
          await forwardToCloud(...)  // ← FORWARD DIRECT
          return;
        }
    │
    ▼
src/mcp/handlers/code-execution-handler.ts
    │
    ├─► StaticStructureBuilder.buildStaticStructure(code)
    ├─► staticStructureToDag(structure)
    └─► createToolExecutorViaWorker({
          mcpClients: deps.mcpClients  // ← MCP CLIENTS DU SERVEUR
        })
    │
    ▼
Serveur exécute TOUT avec ses propres clients MCP
```

### Ce que les stories décrivent (flow attendu)

**Story 14.4 (Dynamic MCP Loader):**
```
PML package fetch capability depuis pml.casys.ai/mcp/{fqdn}
    │
    ▼
Package exécute localement via sandbox
    │
    ▼
mcp.* calls routés par le package :
  - stdio deps → subprocess local (StdioManager)
  - cloud routing → forward to pml.casys.ai
```

**Story 14.5 (Sandboxed Execution):**
```
Capability code (from registry)
    │
    ▼
┌─────────────────────────────────────┐
│  SANDBOX (Deno Worker)              │
│  - permissions: "none"              │
│  - Only exit: mcp.* RPC proxy       │
└─────────────────────────────────────┘
    │ RPC message
    ▼
Main Thread (PML) → StdioManager.call() → User's filesystem
```

### Le GAP

**Aucune story ne décrit le flow pour `pml:execute` avec code ad-hoc :**

1. Le serveur fait l'analyse statique (SWC → DAG) ✅
2. Le serveur exécute TOUT via ses propres mcpClients ❌
3. Le package ne sait pas qu'il devrait exécuter localement ❌

## Composants existants

### Côté serveur (analyse + exécution)

| Fichier | Rôle | Problème |
|---------|------|----------|
| `src/mcp/handlers/code-execution-handler.ts` | Analyse + exécute | Exécute TOUT, ne délègue pas |
| `src/capabilities/static-structure-builder.ts` | Analyse statique | ✅ OK |
| `src/dag/mod.ts` | DAG conversion | ✅ OK |
| `src/sandbox/executor.ts` | Sandbox serveur | Utilise mcpClients serveur |

### Côté package (devrait exécuter localement)

| Fichier | Rôle | Utilisé pour pml:execute ? |
|---------|------|---------------------------|
| `packages/pml/src/loader/capability-loader.ts` | Load + execute capabilities | ❌ Non, bypass |
| `packages/pml/src/sandbox/execution/worker-runner.ts` | Sandbox local | ❌ Non utilisé |
| `packages/pml/src/routing/resolver.ts` | `resolveToolRouting()` | ❌ Non appelé |
| `packages/pml/src/loader/stdio-manager.ts` | Subprocess MCP | ❌ Non utilisé |

### Routing config

```typescript
// packages/pml/src/routing/resolver.ts
const CLOUD_SERVERS = new Set([
  "memory", "tavily", "brave_search", "exa",
  "github", "slack", "api", "http", "fetch",
  "sequential-thinking", "context7", "magic",
  "json", "math", "datetime", "crypto",
  // ... autres tools cloud
  "pml",  // ← pml:* est routé vers cloud !
]);

// Default: tout ce qui n'est pas dans la liste → "client"
// Donc "filesystem", "shell" → client
```

## Options d'implémentation

### Option A: Serveur retourne le DAG analysé, package exécute

**Flow:**
```
Package → pml:execute(code) → Serveur (mode analyse)
    │
    ▼
Serveur analyse (SWC → DAG)
    │
    ▼
Serveur vérifie routing de chaque tool dans le DAG
    │
    ├─► Si TOUS "server" → exécute et retourne résultat
    │
    └─► Si AU MOINS UN "client" → retourne:
        {
          "status": "execute_locally",
          "dag": { tasks: [...] },
          "tools_used": ["filesystem:read_file", "tavily:search"],
          "client_tools": ["filesystem:read_file"],
          "static_structure": {...}
        }
    │
    ▼
Package reçoit → exécute via CapabilityLoader/SandboxWorker
    │
    ▼
Pour tools "server" dans le DAG → forward au serveur
```

**Avantages:**
- Le package a le contrôle de l'exécution
- HIL fonctionne naturellement (permissions package)
- Réutilise le sandbox local (Story 14.5)

**Inconvénients:**
- Nécessite modifier le serveur (nouveau mode)
- Nécessite modifier le package (logique post-analyse)
- Complexité accrue pour les DAGs mixtes (client + server)

**Effort estimé:** 3-5 jours

---

### Option B: Serveur délègue les tools "client" via callback

**Flow:**
```
Package → pml:execute(code) → Serveur exécute
    │
    ▼
Serveur analyse + commence exécution
    │
    ├─► Tool "server" (json:parse) → exécute localement
    │
    └─► Tool "client" (filesystem:read_file) → retourne:
        {
          "status": "delegate_tool",
          "workflow_id": "xxx",
          "tool": "filesystem:read_file",
          "args": { "path": "/home/user/file.txt" }
        }
    │
    ▼
Package exécute le tool localement (avec HIL si nécessaire)
    │
    ▼
Package → continue_workflow({ workflow_id, result: {...} }) → Serveur
    │
    ▼
Serveur continue l'exécution avec le résultat
```

**Avantages:**
- Le serveur garde le contrôle du flow
- Chaque tool est délégué individuellement
- Pattern similaire au HIL existant

**Inconvénients:**
- Beaucoup d'aller-retours réseau
- Latence élevée pour DAGs avec plusieurs tools client
- Complexité du state management côté serveur

**Effort estimé:** 5-7 jours

---

### Option C: Package analyse et exécute tout localement

**Flow:**
```
Package → pml:execute(code)
    │
    ▼
Package envoie le code au serveur pour ANALYSE SEULEMENT
    │
    ▼
Serveur retourne: { dag, static_structure, tools_used }
    │
    ▼
Package exécute TOUT le DAG localement
    │
    ├─► Tools "client" → sandbox local + StdioManager
    │
    └─► Tools "server" → forward au serveur (HTTP call)
```

**Avantages:**
- Le package est l'orchestrateur unique
- Pas de state management complexe côté serveur
- Cohérent avec Story 14.4/14.5

**Inconvénients:**
- Nécessite un endpoint serveur "analyse seulement"
- Le package doit implémenter l'exécution de DAG
- Les tools "server" ont une latence supplémentaire

**Effort estimé:** 4-6 jours

---

### Option D: Interdire les tools "client" dans pml:execute

**Flow:**
```
Package → pml:execute(code avec filesystem:read_file)
    │
    ▼
Serveur analyse → détecte tool "client"
    │
    ▼
Serveur retourne erreur:
{
  "status": "error",
  "error": "CLIENT_TOOL_NOT_ALLOWED",
  "message": "pml:execute ne supporte pas les tools client (filesystem:read_file). Utilisez l'appel direct: filesystem:read_file({...})"
}
```

**Avantages:**
- Simple à implémenter
- Pas de changement architectural
- Force l'utilisation correcte

**Inconvénients:**
- Limite l'utilité de pml:execute
- Mauvaise UX pour l'utilisateur

**Effort estimé:** 0.5 jour

## Investigation (2026-01-09)

### Q1: Le package peut-il exécuter du code arbitraire ? ✅ OUI

Le `CapabilityLoader` a déjà tout le nécessaire :

```typescript
// packages/pml/src/loader/capability-loader.ts:712-740
private async routeMcpCall(meta, namespace, action, args) {
  // 1. Check stdio deps → subprocess local
  const dep = meta.mcpDeps?.find((d) => d.name === namespace);
  if (dep && dep.type === "stdio") {
    return this.callStdio(dep, namespace, action, args);
  }

  // 2. Check routing configuration
  const routing = resolveToolRouting(toolId);

  if (routing === "server") {
    return this.callCloud(toolId, args);  // → HTTP to pml.casys.ai
  }

  // 3. Local capability (recursive)
  return this.call(toolId, args);
}
```

**Le sandbox (`SandboxWorker`) intercepte les `mcp.*` calls et les route via `routeMcpCall()`** → le routing hybride fonctionne déjà pour les capabilities !

---

### Q2: Le routing cache existe-t-il ? ❌ NON

```bash
cat ~/.pml/routing-cache.json
# → NO ROUTING CACHE
```

Le routing n'est pas synchronisé au startup. Le package utilise les defaults :
- Liste hardcodée `CLOUD_SERVERS` dans `packages/pml/src/routing/resolver.ts`
- Tout ce qui n'est pas dans la liste → "client"
- `filesystem`, `shell` → client (correct)

---

### Q3: Le serveur utilise-t-il le routing config ? ❌ NON

```bash
grep -r "routing" src/mcp/handlers/code-execution-handler.ts
# → No routing check, no resolveToolRouting call
```

Le serveur exécute tout avec ses propres `mcpClients` sans vérifier si le tool est "client" ou "server".

---

### Q4: Quel est le GAP exact ?

**Le problème n'est pas le routing dans le package** - il fonctionne correctement pour les capabilities.

**Le problème est que `pml:execute` bypass TOUT et forward au serveur :**

```typescript
// packages/pml/src/cli/stdio-command.ts:367-369
if (name === "pml:execute") {
  await forwardToCloud(...);  // ← BYPASS COMPLET
  return;
}
```

**Solution simple : Utiliser le sandbox du package pour `pml:execute` aussi !**

## Décision : Option A (Serveur Smart)

Le serveur décide intelligemment s'il exécute ou délègue au package.

### Flow décidé

```
Package reçoit pml:execute(code)
    │
    ▼
Package forward au serveur (comme maintenant)
    │
    ▼
Serveur analyse (SWC → StaticStructure → DAG)
    │
    ▼
Serveur vérifie routing de CHAQUE tool dans le DAG
    │
    ├─► Si TOUS "server" (tavily, json, math...)
    │       │
    │       ▼
    │   Serveur exécute normalement
    │   Retourne résultat au package
    │
    └─► Si AU MOINS UN "client" (filesystem, shell...)
            │
            ▼
        Serveur retourne au package :
        {
          "status": "execute_locally",
          "code": "...",
          "dag": { tasks: [...] },
          "tools_used": ["filesystem:read_file", "tavily:search"],
          "client_tools": ["filesystem:read_file"],
          "static_structure": {...}
        }
            │
            ▼
        Package exécute via SandboxWorker existant
            │
            ▼
        mcp.* calls → routeMcpCall() → routing hybride
          ├─► "client" → exécution locale
          └─► "server" → HTTP forward au cloud
```

### Travail à faire

**Côté serveur (`src/mcp/handlers/code-execution-handler.ts`) :**
1. Après analyse SWC → DAG, vérifier routing de chaque tool
2. Utiliser `resolveToolRouting()` de `src/capabilities/routing-resolver.ts`
3. Si au moins un tool "client" → retourner `execute_locally` response
4. Si tous "server" → exécuter comme maintenant

**Côté package (`packages/pml/src/cli/stdio-command.ts`) :**
1. Modifier le handler de `pml:execute` pour détecter `execute_locally`
2. Si `execute_locally` → exécuter via `SandboxWorker` existant
3. Réutiliser `routeMcpCall()` du `CapabilityLoader` pour le routing

### Effort estimé

- Modification serveur `code-execution-handler.ts` : 1 jour
- Modification package `stdio-command.ts` : 1 jour
- Tests E2E (routing hybride) : 1 jour
- **Total : 3 jours**

### Avantages Option A vs C

| Aspect | Option A (choisie) | Option C |
|--------|-------------------|----------|
| DAG 100% server | Exécuté sur serveur (rapide) | Exécuté sur package + forwards HTTP (lent) |
| DAG avec client tools | Délégué au package | Délégué au package |
| Latence | Optimale | +1 round-trip pour tools server |
| Complexité serveur | +1 check routing | Aucun changement |

### Risques

1. **Routing config sync** : Le serveur doit avoir accès à `mcp-routing.json`
2. **Permissions package** : Le package doit vérifier les permissions avant d'exécuter (HIL)
3. **API Keys** : Les tools "server" forwardés depuis le package ont besoin de BYOK
4. **Static analysis limitations** : Si SWC ne détecte pas tous les tools
5. **Clients sans package** : Web app et API directe ne peuvent pas exécuter localement

## Compatibilité avec clients sans package

### Problème

Sans le package, les clients (web app, API directe) ne peuvent pas gérer `execute_locally` :

```
Web App → pml:execute({ code: "mcp.filesystem.read_file(...)" })
    │
    ▼
Server retourne: { status: "execute_locally", ... }
    │
    ▼
Web App reçoit... et ne sait pas quoi faire ❌
```

### Solution : Header `X-PML-Client`

Le package s'identifie via un header HTTP :

```typescript
// Package (forwardToCloud)
headers: {
  "Content-Type": "application/json",
  "x-api-key": apiKey,
  "X-PML-Client": "package",  // ← NOUVEAU
}
```

Le serveur vérifie ce header avant de retourner `execute_locally` :

```typescript
// Serveur (code-execution-handler.ts)
const isPackageClient = request.headers?.get("X-PML-Client") === "package";

if (routing === "client") {
  if (isPackageClient) {
    // Package peut gérer → déléguer
    return { status: "execute_locally", code, dag, ... };
  } else {
    // Web app / API directe → erreur explicative
    return formatMCPToolError(
      "Client tools (filesystem, shell, etc.) require the PML package for local execution. " +
      "Install with: deno install -Agf jsr:@anthropic/pml",
      {
        error_code: "CLIENT_TOOLS_REQUIRE_PACKAGE",
        client_tools: toolsUsed.filter(t => getToolRouting(t) === "client"),
        install_command: "deno install -Agf jsr:@anthropic/pml",
      }
    );
  }
}
```

### Comportement par type de client

| Client | Header | Tools "client" | Résultat |
|--------|--------|----------------|----------|
| Package (Claude Code) | `X-PML-Client: package` | ✅ | `execute_locally` → exécution locale |
| Web App | ❌ absent | ❌ | Erreur explicative |
| API directe | ❌ absent | ❌ | Erreur explicative |
| Package (Claude Code) | `X-PML-Client: package` | Tools "server" only | Exécution serveur normale |

### Avantages

1. **Rétrocompatibilité** : Les clients existants reçoivent une erreur claire au lieu d'un `execute_locally` incompréhensible
2. **Message actionable** : L'erreur indique comment installer le package
3. **Pas de breaking change** : Le comportement sans package passe de "erreur cryptique ENOENT" à "erreur explicative"

## Clarification : Tout passe par MCP (pas d'API séparée)

**Question :** Doit-on passer par une API HTTP séparée ?
**Réponse :** Non ! Tout reste dans le flow MCP existant.

Le flow actuel :
```
Claude → MCP call pml:execute(code) → Package (stdio JSON-RPC)
    │
    ▼
Package → forwardToCloud() → HTTP POST au serveur
    │
    ▼
Serveur → traite et retourne réponse JSON
    │
    ▼
Package → renvoie via MCP JSON-RPC → Claude
```

Avec Option A, on modifie juste ce que le package fait **après** avoir reçu la réponse :

```typescript
// packages/pml/src/cli/stdio-command.ts (modifié)
if (name === "pml:execute") {
  const response = await forwardToCloud(id, name, args || {}, cloudUrl);

  if (response.status === "execute_locally") {
    // ← NOUVEAU : Exécuter localement via SandboxWorker
    const result = await executeLocally(response.code, response.dag);
    sendMcpResponse(id, result);
  } else {
    // Comme avant : forward le résultat
    sendMcpResponse(id, response);
  }
  return;
}
```

**Le HTTP est juste le transport interne** entre package et serveur cloud - ça existe déjà.
**Claude voit uniquement la réponse MCP finale** - aucun changement de son point de vue.

## Implémentation détaillée (Investigation 2026-01-09)

### Composants existants identifiés

| Composant | Fichier | Fonction clé | Statut |
|-----------|---------|--------------|--------|
| **Server routing** | `src/capabilities/routing-resolver.ts` | `resolveRouting(toolsUsed)` | ✅ Existe, pas utilisé par execute |
| **Server config** | `config/mcp-routing.json` | Liste client/server tools | ✅ Complet |
| **Package routing** | `packages/pml/src/routing/resolver.ts` | `resolveToolRouting(tool)` | ✅ Utilisé pour capabilities |
| **Package sandbox** | `packages/pml/src/loader/capability-loader.ts` | `executeInSandbox()` | ✅ Fonctionne pour capabilities |
| **Package forward** | `packages/pml/src/cli/stdio-command.ts:367` | `forwardToCloud()` | ❌ Bypass tout |

### Changement 1 : Serveur (`src/mcp/handlers/code-execution-handler.ts`)

Après la ligne 219 (après `optimizedDAG` est construit), ajouter le routing check :

```typescript
import { resolveRouting, getToolRouting } from "../../capabilities/routing-resolver.ts";

// Dans tryDagExecution(), après ligne 219 :
const toolsUsed = optimizedDAG.tasks.map((t) => t.tool);
const routing = resolveRouting(toolsUsed);

if (routing === "client") {
  // Au moins un tool "client" - déléguer au package
  log.info("[Story 14.9] DAG contains client tools, delegating to package", {
    clientTools: toolsUsed.filter(t => getToolRouting(t) === "client"),
    allTools: toolsUsed,
  });

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "execute_locally",
        code: request.code,
        dag: { tasks: optimizedDAG.tasks },
        tools_used: toolsUsed,
        client_tools: toolsUsed.filter(t => getToolRouting(t) === "client"),
        static_structure: staticStructure,
      }, null, 2)
    }]
  };
}

// Continuer avec l'exécution serveur normale...
```

### Changement 2 : Package (`packages/pml/src/cli/stdio-command.ts`)

Modifier `forwardToCloud()` pour retourner la réponse au lieu de l'envoyer directement :

```typescript
// Avant (ligne 315-353)
async function forwardToCloud(...): Promise<void> {
  // ...
  sendResponse(result);  // ← Envoie directement
}

// Après
async function forwardToCloud(...): Promise<unknown> {
  // ...
  return result;  // ← Retourne pour inspection
}
```

Modifier le handler de `pml:execute` (lignes 367-370) :

```typescript
if (name === "pml:execute") {
  const response = await forwardToCloud(id, name, args || {}, cloudUrl);

  // Extraire le contenu de la réponse MCP
  const content = response?.result?.content?.[0]?.text;
  if (content) {
    try {
      const parsed = JSON.parse(content);

      if (parsed.status === "execute_locally") {
        // Exécuter localement via SandboxWorker
        const result = await executeLocalCode(
          loader,
          parsed.code,
          parsed.dag,
          cloudUrl,
        );
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2),
            }]
          }
        });
        return;
      }
    } catch {
      // Parse error - forward as-is
    }
  }

  // Réponse normale du serveur
  sendResponse(response);
  return;
}
```

### Changement 3 : Package - Nouvelle fonction `executeLocalCode()`

Ajouter dans `stdio-command.ts` ou créer un module dédié :

```typescript
/**
 * Execute code locally when server detects client tools.
 * Uses CapabilityLoader's sandbox + hybrid routing.
 */
async function executeLocalCode(
  loader: CapabilityLoader | null,
  code: string,
  dag: { tasks: Array<{ tool: string; arguments: unknown }> },
  cloudUrl: string,
): Promise<{
  status: string;
  result: unknown;
  tool_failures?: Array<{ tool: string; error: string }>;
}> {
  if (!loader) {
    return {
      status: "error",
      result: null,
      tool_failures: [{ tool: "sandbox", error: "CapabilityLoader not initialized" }]
    };
  }

  // Créer un SandboxWorker avec routing hybride
  const { SandboxWorker } = await import("../sandbox/mod.ts");

  const sandbox = new SandboxWorker({
    onRpc: async (toolId: string, args: unknown) => {
      // Router via CapabilityLoader (qui fait le routing hybride)
      const routing = resolveToolRouting(toolId);

      if (routing === "client") {
        // Exécution locale via loader
        return await loader.call(toolId, args);
      } else {
        // Forward au cloud
        return await callCloudTool(toolId, args, cloudUrl);
      }
    }
  });

  try {
    const result = await sandbox.execute(code, {});

    return {
      status: result.success ? "success" : "error",
      result: result.value,
      tool_failures: result.success ? undefined : [{
        tool: "sandbox",
        error: result.error?.message ?? "Unknown error"
      }]
    };
  } finally {
    sandbox.shutdown();
  }
}
```

### Diagramme du flow complet

```
Claude → pml:execute({ code: "mcp.filesystem.read_file(...)" })
    │
    ▼
Package (stdio-command.ts)
    │
    ├─► forwardToCloud() → HTTP POST to server
    │
    ▼
Server (code-execution-handler.ts)
    │
    ├─► StaticStructureBuilder.buildStaticStructure(code)
    ├─► staticStructureToDag(structure)
    ├─► optimizeDAG(logicalDAG)
    │
    ├─► resolveRouting(toolsUsed) → "client" (filesystem is client tool)
    │
    └─► return { status: "execute_locally", code, dag, ... }
    │
    ▼
Package receives response
    │
    ├─► parsed.status === "execute_locally" ?
    │       │
    │       ▼
    │   executeLocalCode(loader, code, dag)
    │       │
    │       ├─► SandboxWorker.execute(code)
    │       │       │
    │       │       └─► mcp.filesystem.read_file() → onRpc callback
    │       │               │
    │       │               ├─► resolveToolRouting("filesystem:read_file") → "client"
    │       │               └─► loader.call() → local execution ✅
    │       │
    │       └─► return result
    │
    └─► sendResponse({ result }) → Claude
```

### Tests requis

1. **Test E2E : Code avec tools 100% server**
   ```typescript
   pml:execute({ code: "await mcp.json.parse({ data: '{}' })" })
   // → Exécuté sur serveur, résultat normal
   ```

2. **Test E2E : Code avec tools 100% client**
   ```typescript
   pml:execute({ code: "await mcp.filesystem.read_file({ path: '/tmp/test.txt' })" })
   // → status: "execute_locally" → package exécute → résultat
   ```

3. **Test E2E : Code mixte (client + server)**
   ```typescript
   pml:execute({
     code: `
       const content = await mcp.filesystem.read_file({ path: '/tmp/data.json' });
       const parsed = await mcp.json.parse({ data: content });
       return parsed;
     `
   })
   // → status: "execute_locally" (car filesystem est client)
   // → Package exécute tout :
   //   - filesystem.read_file → local
   //   - json.parse → forward to cloud (via routing)
   ```

4. **Test HIL : Permissions et API keys**
   - Vérifier que les permissions du package s'appliquent
   - Vérifier que l'installation des dépendances demande approbation

## Évolutions futures

### 1. MCP Streamable HTTP (au lieu de HTTP simple)

**Situation actuelle :**
```
Package → HTTP POST /mcp → Server
       ← HTTP Response    ←
```

Simple request/response, pas de streaming, pas de protocol negotiation.

**Évolution possible :**
```
Package → MCP Streamable HTTP → Server
       ← SSE stream (progress, result) ←
```

**Avantages :**
- Streaming des résultats (progress updates pendant l'exécution)
- Protocol negotiation (version, capabilities)
- Standardisé MCP (cohérent avec Claude ↔ Package)
- Meilleure gestion des timeouts et cancellation

**Inconvénients :**
- Plus complexe à implémenter
- Nécessite refactor côté serveur (SSE endpoint)

**Quand le faire :**
- Si on veut du streaming de progress pour les longues exécutions
- Si on veut un protocol plus robuste

**Effort estimé :** ~3-5 jours

---

### 2. Full local parsing (zero round-trip)

**Situation actuelle (Option A) :**
```
Package → HTTP → Server (parse) → HTTP → Package (execute)
                   ↑
            100-200ms latence
```

**Évolution possible :**
```
Package (parse + execute localement)
       ↓
Server (sync capabilities, learning)
```

**Avantages :**
- Zero latence pour tools 100% client
- Mode offline possible
- Moins de dépendance au serveur

**Inconvénients :**
- Dupliquer SWC/DAG dans le package
- Plus de code à maintenir
- Le package fait déjà 3.9 Go (donc size n'est pas un problème)

**Quand le faire :**
- Si la latence 100-200ms devient un problème
- Si on veut supporter le mode offline
- Si on veut réduire la charge serveur

**Effort estimé :** ~1-2 semaines

---

### 3. Bidirectional MCP (Server → Package callbacks)

Pour les workflows complexes où le serveur a besoin de callback vers le package :

```
Package ←→ MCP bidirectionnel ←→ Server
```

**Use cases :**
- Server demande au package d'exécuter un tool client mid-workflow
- Streaming de résultats intermédiaires
- Annulation de workflows en cours

**Effort estimé :** ~2 semaines

## Findings de l'implémentation (2026-01-09)

### Bugs corrigés

#### 1. `approval_required` lancé comme Error (CRITIQUE)

**Fichier:** `packages/pml/src/cli/stdio-command.ts`

**Problème:** Dans `executeLocalCode()`, quand un tool retournait `approval_required` (HIL), le code lançait une erreur au lieu de propager la réponse à Claude:

```typescript
// AVANT (buggy)
if (CapabilityLoader.isApprovalRequired(callResult)) {
  throw new Error(`Tool ${toolId} requires approval - not supported in hybrid execution`);
}
```

**Fix:** Créer un type de retour approprié et propager l'approval:

```typescript
// Type pour les résultats d'exécution locale
type LocalExecutionResult =
  | { status: "success"; result: unknown }
  | { status: "error"; error: string }
  | { status: "approval_required"; approval: ApprovalRequired; toolId: string };

// Dans clientToolHandler
if (CapabilityLoader.isApprovalRequired(callResult)) {
  state.pendingApproval = { approval: callResult, toolId };
  throw new Error(`__APPROVAL_REQUIRED__:${toolId}`);
}
```

---

#### 2. FQDN incorrect (std au lieu de filesystem)

**Fichier:** `src/mcp/registry/mcp-registry.service.ts:355`

**Problème:** `enrichRow()` parsait `name` pour dériver server/tool, mais `name="read_file"` n'a pas de colon donc defaultait à `"std"`:

```typescript
// AVANT (buggy)
const [server, tool] = row.name.includes(":") ? row.name.split(":") : ["std", row.name];
// → filesystem:read_file → FQDN pml.mcp.std.read_file ❌
```

**Fix:** Utiliser `row.server_id` en priorité:

```typescript
// APRÈS (correct)
if (row.server_id) {
  server = row.server_id;
  tool = row.name.includes(":") ? row.name.split(":")[1] : row.name;
} else if (row.name.includes(":")) {
  [server, tool] = row.name.split(":");
} else {
  server = "std";
  tool = row.name;
}
// → filesystem:read_file → FQDN pml.mcp.filesystem.read_file ✅
```

---

#### 3. `validateMetadata()` rejetait type stdio/http

**Fichier:** `packages/pml/src/loader/registry-client.ts:87-103`

**Problème:** Validation n'acceptait que `type: "deno"`, mais le registry retourne `type: "stdio"` pour filesystem:

```typescript
// AVANT (buggy)
if (obj.type !== "deno") {
  throw new LoaderError("Invalid type: expected 'deno'");
}
if (typeof obj.codeUrl !== "string") {  // Requis pour tous
  throw new LoaderError("Missing required field: codeUrl");
}
```

**Fix:** Accepter tous les types et rendre codeUrl optionnel:

```typescript
// APRÈS (correct)
const validTypes = ["deno", "stdio", "http"];
if (!validTypes.includes(obj.type as string)) {
  throw new LoaderError(`Invalid type: expected one of ${validTypes.join(", ")}`);
}

// codeUrl requis SEULEMENT pour deno
if (obj.type === "deno" && !obj.codeUrl) {
  throw new LoaderError("Missing codeUrl (required for deno type)");
}
```

---

#### 4. Routing "local" non reconnu

**Fichier:** `packages/pml/src/loader/registry-client.ts`

**Problème:** La DB a `routing: "local"` mais le code attendait `"client"/"server"`.

**Fix:** Normaliser "local" → "client":

```typescript
const routing = obj.routing === "local" ? "client" : obj.routing;
if (routing !== "client" && routing !== "server") {
  throw new LoaderError(`Invalid routing: expected "client" or "server"`);
}
```

---

### Types de MCP (Clarification)

La spec originale parlait principalement de `type: "deno"`, mais il y a 3 types:

| Type | Description | codeUrl | install | Exemples |
|------|-------------|---------|---------|----------|
| `deno` | Capability avec code TypeScript | ✅ Requis | ❌ | Capabilities custom |
| `stdio` | MCP server externe via subprocess | ❌ | ✅ Requis | filesystem, shell, git |
| `http` | Proxy vers endpoint HTTP | ❌ | ❌ | tavily, memory (cloud) |

**Le registry retourne:**
- Pour `stdio`: `{ type: "stdio", install: { command, args, envRequired }, routing: "client" }`
- Pour `http`: `{ type: "http", proxyTo: "https://...", routing: "server" }`
- Pour `deno`: `{ type: "deno", codeUrl: "...", routing: "client"|"server" }`

---

### Schéma DB vs Types (mcpDeps vs install)

**Confusion clarifiée:**

- **`mcpDeps`** = dépendances déclarées dans le code d'une capability (pour deno type)
- **`install`** = info d'installation du MCP lui-même (pour stdio type)

Exemple pour `pml.mcp.filesystem.read_file`:
```json
{
  "fqdn": "pml.mcp.filesystem.read_file.7b92",
  "type": "stdio",
  "routing": "client",
  "install": {
    "command": "npx",
    "args": ["-y", "@anthropic-ai/mcp-server-filesystem"],
    "envRequired": []
  }
}
```

---

### tools_used et client_tools dans execute_locally

Le serveur retourne ces champs dans la réponse `execute_locally`:
```json
{
  "status": "execute_locally",
  "code": "...",
  "dag": { "tasks": [...] },
  "tools_used": ["filesystem:read_file", "tavily:search"],
  "client_tools": ["filesystem:read_file"]
}
```

**Usage:**
- `client_tools`: Utilisé par le package pour logging et identification des tools à exécuter localement
- `tools_used`: Info complète pour debug

Le package utilise `parseExecuteLocallyResponse()` pour extraire ces champs (ligne 480 stdio-command.ts).

---

### ~~http type dans le lockfile~~ (REMOVED)

Le lockfile supportait `type: "deno" | "stdio" | "http"` mais **http n'est jamais utilisé**:

1. Les tools http ont `routing: "server"` par défaut
2. Le package forward directement au cloud (ligne 685 stdio-command.ts)
3. Pas de `loader.call()` → pas de `fetchWithIntegrity()` → pas d'écriture lockfile

**Cleanup effectué:**
- `lockfile/types.ts`: `type: "deno" | "stdio"` (supprimé http)
- `lockfile/lockfile-manager.ts`: signatures mises à jour
- `registry-client.ts`: utilise `metadata.type` au lieu de hardcoder "deno"

Le tracking d'usage des tools http se fait côté serveur (logs, traces), pas dans le lockfile client.

---

## Per-project State (Implémenté 2026-01-09)

### Changement architectural

**Avant:** État global dans `~/.pml/`
```
~/.pml/
├── mcp.lock      # Lockfile global
├── deps.json     # Dépendances globales
└── routing-cache.json
```

**Après:** État par projet dans `${workspace}/.pml/`
```
${workspace}/
├── .pml.json     # Config (permissions, cloud URL)
└── .pml/
    ├── mcp.lock    # Lockfile per-project
    ├── deps.json   # Dépendances per-project
    └── client-id   # Session client ID
```

### Fichiers modifiés

| Fichier | Changement |
|---------|------------|
| `packages/pml/src/lockfile/types.ts` | Ajout option `workspace` dans `LockfileManagerOptions` |
| `packages/pml/src/lockfile/lockfile-manager.ts` | Utilise `${workspace}/.pml/mcp.lock` |
| `packages/pml/src/loader/dep-state.ts` | Nouveau type `DepStateOptions`, utilise `${workspace}/.pml/deps.json` |
| `packages/pml/src/loader/capability-loader.ts` | Passe workspace à `createDepState()` |
| `packages/pml/src/cli/stdio-command.ts` | Passe `{ workspace }` à `LockfileManager` |
| `packages/pml/src/cli/serve-command.ts` | Idem |
| `packages/pml/src/session/client.ts` | Client ID dans `.pml/client-id` (était `.pml-client-id`) |
| `packages/pml/src/init/mod.ts` | Ajoute `.pml.json` et `.pml/` au `.gitignore` du projet |

### Raison du changement

1. **Cohérence** avec les permissions qui sont déjà per-project (`.pml.json`)
2. **Isolation** entre projets (un projet ne voit pas les MCPs d'un autre)
3. **Portabilité** (clone le repo, tu as le lockfile)
4. **Sécurité** (pas de fuite d'info entre projets)

### Init met à jour .gitignore

`pml init` ajoute automatiquement au `.gitignore` du projet:
```gitignore
# PML (per-project config and state)
.pml.json
.pml/
```

---

## État des tests (2026-01-09)

### ✅ Sandbox avec tools std
```bash
pml:execute({ code: "await mcp.std.git_status({ repo_path: '...' })" })
# → status: "success", result: { branch: "main", ... }
```

### ✅ Création .pml/ per-project
```
.pml/
├── mcp.lock    # Créé
├── client-id   # Créé
└── deps.json   # Créé quand un MCP stdio est installé
```

### ⏳ HIL avec approval_required
- Le flow est implémenté mais pas testé E2E
- Raison: filesystem MCP conflit avec le gateway (même machine)
- Solution: tester avec un MCP qui n'est pas utilisé par le gateway

### ⏳ Continue workflow
- Implémenté mais dépend du test HIL

---

## Prochaines étapes

1. ✅ Investigation terminée
2. ✅ Décision prise : **Option A**
3. ✅ Clarification : tout via MCP, pas d'API séparée
4. ✅ Implémentation détaillée documentée
5. ✅ Bugs corrigés (voir section Findings)
6. ✅ Per-project state implémenté
7. ✅ Sandbox fonctionne avec tools std
8. ⏳ Tests HIL (approval flow) - à tester sur env séparé

## Références

- [Epic 14](../epics/epic-14-jsr-package-local-cloud-mcp-routing.md)
- [Story 14.4 - Dynamic MCP Loader](../../implementation-artifacts/14-4-dynamic-mcp-loader-registry.md)
- [Story 14.5 - Sandboxed Execution](../../implementation-artifacts/14-5-sandboxed-local-mcp-execution.md)
- [Story 14.3 - Routing Config](../../implementation-artifacts/14-3-routing-config-permission-inferrer.md)
- `packages/pml/src/cli/stdio-command.ts` - Entry point
- `src/mcp/handlers/code-execution-handler.ts` - Server execution
