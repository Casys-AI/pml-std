# Tech Spec: STD Server Concurrency Fix

**Date**: 2025-12-19 **Status**: Done **Priority**: Medium

## Problem

Le serveur MCP std (`lib/mcp-tools-server.ts`) est séquentiel (boucle `while(true)`) mais le client
MCP envoie les requêtes en parallèle (mode multiplexé par défaut).

Quand le DAG executor appelle plusieurs outils std en parallèle:

1. Client envoie N requêtes simultanément
2. Serveur les traite une par une
3. Les N-1 dernières timeout côté client (30s) avant d'être traitées

## Bug corrigé (buffer)

Le buffer stdin était local à `readMessage()`, causant une perte de messages quand plusieurs
arrivaient ensemble. Fix appliqué: buffer persistant au niveau module.

```typescript
// Persistent buffer for stdin parsing
const decoder = new TextDecoder();
let stdinBuffer = "";
```

## Solutions analysées

| Option                             | Effort | Local     | Multi-tenant       | Retenue |
| ---------------------------------- | ------ | --------- | ------------------ | ------- |
| **1. useMutex côté client**        | Faible | OK        | ❌ Bloquant global | Non     |
| **2. Réduire over-generation DAG** | Faible | Partiel   | Partiel            | Non     |
| **3. Serveur concurrent**          | Moyen  | ✅ Rapide | ✅ Scale           | **Oui** |
| **4. Async request batching**      | Moyen  | OK        | OK                 | Non     |

### Pourquoi pas useMutex ?

Le mutex est implémenté **côté client** (`src/mcp/client.ts`). Il sérialise les appels avant envoi
au serveur.

Problème : si la gateway utilise un client MCP partagé avec `useMutex: true`, **toutes les requêtes
de tous les utilisateurs** passent par le même mutex → goulot d'étranglement.

```
Gateway (singleton)
    └── mcpClients: Map<string, MCPClientBase>  ← PARTAGÉE
           └── "std" client (useMutex: true)    ← 1 SEUL MUTEX GLOBAL
```

## Solution retenue : Serveur concurrent

Rendre le serveur std capable de traiter plusieurs requêtes en parallèle, sans changer le client.

### Avant (séquentiel)

```typescript
// lib/mcp-tools-server.ts - main()
while (true) {
  const request = await readMessage(reader);
  if (!request) break;
  const response = await server.handleRequest(request); // BLOQUANT
  await writeMessage(response);
}
```

```
Timeline:
req1 ████████░░░░░░░░░░░░ 50ms
req2 ░░░░░░░░████████░░░░ 50ms (attend req1)
req3 ░░░░░░░░░░░░░░░░████ 50ms (attend req2)
Total: 150ms
```

### Après (concurrent)

```typescript
// lib/mcp-tools-server.ts - main()
const MAX_CONCURRENT = 10;
let inFlight = 0;
const writeQueue: JsonRpcResponse[] = [];
let writing = false;

async function flushWriteQueue() {
  if (writing) return;
  writing = true;
  while (writeQueue.length > 0) {
    const response = writeQueue.shift()!;
    await writeMessage(response);
  }
  writing = false;
}

while (true) {
  const request = await readMessage(reader);
  if (!request) break;

  // Fire and forget - traitement parallèle
  (async () => {
    while (inFlight >= MAX_CONCURRENT) {
      await new Promise((r) => setTimeout(r, 10));
    }
    inFlight++;
    try {
      const response = await server.handleRequest(request);
      writeQueue.push(response);
      flushWriteQueue();
    } finally {
      inFlight--;
    }
  })();
}
```

```
Timeline:
req1 ████████░░░░░░░░░░░░ 50ms
req2 ████████░░░░░░░░░░░░ 50ms (parallèle)
req3 ████████░░░░░░░░░░░░ 50ms (parallèle)
Total: ~50ms
```

### Garanties

| Aspect                   | Garantie                                          |
| ------------------------ | ------------------------------------------------- |
| **Ordre des réponses**   | Non garanti, mais OK car JSON-RPC utilise des IDs |
| **Atomicité écriture**   | Oui - writeQueue + flag `writing`                 |
| **Backpressure**         | Oui - MAX_CONCURRENT limite les requêtes en vol   |
| **Compatibilité client** | 100% - aucun changement requis                    |

## Fichiers à modifier

| Fichier                   | Modification                      |
| ------------------------- | --------------------------------- |
| `lib/mcp-tools-server.ts` | Implémenter la boucle concurrente |

## Tests

1. **Test unitaire** : Envoyer 10 requêtes simultanées, vérifier qu'elles complètent toutes en < 2x
   temps d'une requête
2. **Test intégration** : DAG avec 5 outils std en parallèle, pas de timeout
3. **Test charge** : 50 requêtes simultanées, vérifier MAX_CONCURRENT respecté

## Risques

| Risque                        | Mitigation                                   |
| ----------------------------- | -------------------------------------------- |
| Race condition sur writeQueue | Flag `writing` empêche flush concurrent      |
| Memory si trop de requêtes    | MAX_CONCURRENT = 10 limite la charge         |
| Ordre des réponses            | JSON-RPC IDs permettent au client de matcher |
