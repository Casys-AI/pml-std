# ADR-052: Dynamic Capability Routing via MCP Proxy

**Status:** Accepted **Date:** 2025-12-27 **Related:**

- ADR-032 (Worker RPC Bridge)
- ADR-036 (BroadcastChannel Tracing)
- ADR-041 (Hierarchical Trace Tracking)
- Story 13.2 (FQDN Registry)

## Context

### Problème

Les capabilities apprises sont stockées avec un format `namespace:action` (ex: `math:sum`, `fs:ls`).
L'utilisateur veut pouvoir appeler ces capabilities comme des outils MCP normaux:

```typescript
// Appel d'une capability comme un MCP tool
const result = await mcp.math.sum();
```

Mais le Worker sandbox ne connaît que les serveurs MCP réels (filesystem, playwright, etc.). Quand
le code appelle `mcp.math.sum()`, le Worker envoie un RPC au Bridge qui cherche un client MCP
"math" - qui n'existe pas.

### Solution précédente (échouée)

Ajouter un Proxy catch-all dans `sandbox-worker.ts` qui route tous les serveurs inconnus vers le
Bridge:

```typescript
// PROBLÈME: Route TOUT serveur inconnu, pas seulement les capabilities
return new Proxy({}, {
  get(_target, toolName: string) {
    return (args) => __rpcCall(serverName, toolName, args);
  },
});
```

**Problèmes:**

1. Pas de validation - n'importe quel appel est accepté
2. Pas de schema - le Worker ne connaît pas les paramètres attendus
3. Timeout de 30s si la capability n'existe pas

## Decision

### Architecture: Résolution dynamique à l'analyse statique

Au lieu de router aveuglément au runtime, on résout les capabilities **pendant l'analyse statique**
du code:

```
Code: "mcp.math.sum()"
         │
         ▼
Static Analysis → découvre "math:sum"
         │
         ▼
buildToolDefinitionsFromStaticStructure():
  1. mcpClients.get("math") → null
  2. capabilityRegistry.resolveByName("math:sum") → trouvé!
  3. Crée ToolDefinition {
       server: "math",
       name: "sum",
       isCapability: true,
       capabilityFqdn: "local.default.math.sum.4ebd"
     }
         │
         ▼
Worker reçoit ToolDefinition → crée proxy math.sum
         │
         ▼
Worker appelle mcp.math.sum() → RPC vers Bridge
         │
         ▼
Bridge.handleRPCCall():
  1. mcpClients.get("math") → null
  2. capabilityRegistry.resolveByName("math:sum") → trouvé!
  3. Crée NOUVEAU WorkerBridge (évite bug de ré-entrance)
  4. Execute capability code
  5. Retourne résultat
```

### Fichiers modifiés

1. **`src/sandbox/types.ts`** - Extension de `ToolDefinition`:

```typescript
export interface ToolDefinition {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // NEW: Capability routing
  isCapability?: boolean;
  capabilityFqdn?: string;
}
```

2. **`src/mcp/handlers/shared/tool-definitions.ts`** - Résolution dynamique:

```typescript
export interface ToolDefinitionDeps {
  mcpClients: Map<string, MCPClientBase>;
  capabilityRegistry?: CapabilityRegistry; // NEW
  capabilityStore?: CapabilityStore; // NEW
  scope?: Scope; // NEW
}

// Dans buildToolDefinitionsFromStaticStructure:
if (!client && deps.capabilityRegistry) {
  const record = await deps.capabilityRegistry.resolveByName(
    `${serverId}:${toolName}`,
    scope,
  );
  if (record) {
    toolDefs.push({
      server: serverId,
      name: toolName,
      isCapability: true,
      capabilityFqdn: record.id,
      // ... schema from workflow_pattern
    });
  }
}
```

3. **`src/dag/execution/workerbridge-executor.ts`** - Propagation du registry:

```typescript
export interface WorkerBridgeExecutorConfig {
  // ... existing fields
  capabilityRegistry?: WorkerBridgeConfig["capabilityRegistry"]; // NEW
}
```

4. **`src/sandbox/worker-bridge.ts`** - Fix du bug de ré-entrance:

```typescript
// AVANT (bug): this.execute() écrase this.worker
const capResult = await this.execute(pattern.codeSnippet, []);

// APRÈS: Nouveau WorkerBridge isolé
const capBridge = new WorkerBridge(this.mcpClients, {
  timeout: this.config.timeout,
  capabilityStore: this.capabilityStore,
  // PAS de capabilityRegistry → évite récursion infinie
});
try {
  const capResult = await capBridge.execute(pattern.codeSnippet, []);
} finally {
  capBridge.cleanup();
}
```

## Bug de ré-entrance découvert

### Le problème

Quand `handleRPCCall` appelait `this.execute()` pour exécuter une capability:

```
Worker1 exécute mcp.math.sum()
    │
    ▼
handleRPCCall() → this.execute(capabilityCode)
    │
    ▼
this.worker = Worker2  ← ÉCRASE Worker1!
this.completionPromise = Promise2  ← ÉCRASE Promise1!
    │
    ▼
Worker1 attend une réponse RPC qui n'arrivera jamais → TIMEOUT 30s
```

### La solution

Créer un **nouveau** `WorkerBridge` pour l'exécution de la capability:

```typescript
const capBridge = new WorkerBridge(this.mcpClients, config);
try {
  const result = await capBridge.execute(code);
  this.worker?.postMessage(response); // Worker1 reçoit sa réponse
} finally {
  capBridge.cleanup();
}
```

## Consequences

### Positives

1. **Transparence** - Les capabilities s'appellent comme des MCP tools
2. **Validation** - Seules les capabilities découvertes à l'analyse statique sont routées
3. **Schema** - Le Worker connaît les paramètres attendus (via workflow_pattern)
4. **Composabilité** - Une capability peut appeler des MCP tools (mais pas d'autres capabilities
   pour éviter la récursion)

### Négatives

1. **Overhead** - Création d'un nouveau WorkerBridge par appel de capability
2. **Pas de récursion** - Une capability ne peut pas appeler une autre capability
   (capabilityRegistry non propagé)

### Limitations actuelles

1. **Capabilities imbriquées** - Non supporté (évite récursion infinie)
2. **Capabilities dynamiques** - Seules celles découvertes à l'analyse statique sont disponibles

## Test

```typescript
// Capability "math:sum" avec code: "return [1,2,3,4,5].reduce((a,n) => a+n, 0);"
pml_execute({
  intent: "calculate sum",
  code: "return await mcp.math.sum()",
});
// → { result: 15 }
```
