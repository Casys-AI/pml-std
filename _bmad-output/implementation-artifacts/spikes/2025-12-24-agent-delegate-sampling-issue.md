# Spike: agent_delegate et MCP Sampling - Problème de Support Client

**Date**: 2025-12-24 **Status**: Investigation terminée **Auteur**: Claude + User

## Contexte

Test de `agent_delegate` via PML en mode stdio. L'outil est implémenté dans `lib/std/agent.ts` et
utilise le protocole MCP `sampling/createMessage` pour déléguer des tâches à un LLM.

## Problème Identifié

```
Erreur: MCP error -32601: Method not found
```

### Chaîne d'exécution

```
pml:execute({ code: "mcp.std.agent_delegate({...})" })
  → WorkerBridge.handleRPCCall()
    → MCPClient.callTool("agent_delegate", args)
      → lib/mcp-tools-server.ts handler
        → samplingClient.createMessage()
          → Envoie "sampling/createMessage" à PML (parent)
            → samplingRelay.handleChildRequest()
              → ❌ createMessageFn is null!
```

### Cause Racine

Dans `src/mcp/gateway-server.ts:193-205`:

```typescript
private setupSamplingRelay(): void {
  // @ts-ignore - createMessage exists on Server when client supports sampling
  if (typeof this.server.createMessage === "function") {
    samplingRelay.setCreateMessageFn(
      (request) => this.server.createMessage(request),
    );
    log.info("[Gateway] Sampling relay configured with SDK createMessage");
  } else {
    log.warn("[Gateway] SDK server.createMessage not available - sampling relay disabled");
  }
  // ...
}
```

**`this.server.createMessage` n'existe que si le client MCP (Claude Code) déclare supporter la
capability `sampling` lors du handshake MCP.**

Claude Code **ne supporte pas** `sampling/createMessage` (feature MCP de Nov 2025, SEP-1577).

## Impact

| Mode  | Transport            | Sampling Support       | Status                          |
| ----- | -------------------- | ---------------------- | ------------------------------- |
| stdio | Claude Code → PML    | `server.createMessage` | ❌ Non supporté par Claude Code |
| HTTP  | Navigateur/API → PML | Nécessite BYOK         | ❌ Pas de fallback implémenté   |

**Conclusion**: `agent_delegate` et tous les outils `agent_*` ne fonctionnent dans aucun mode
actuellement.

## Architecture Existante

### Implémentation des outils agent (lib/std/agent.ts)

8 outils implémentés:

- `agent_delegate` - Délégation de sous-tâche avec tools
- `agent_decide` - Décision booléenne ou choix multiple
- `agent_analyze` - Analyse de données structurée
- `agent_extract` - Extraction de données selon un schéma
- `agent_classify` - Classification dans des catégories
- `agent_summarize` - Résumé de contenu
- `agent_generate` - Génération de contenu (code, texte, etc.)
- `agent_compare` - Comparaison et ranking d'options

Tous utilisent `getSamplingClient()` qui appelle `sampling/createMessage`.

### Sampling Relay (src/mcp/sampling/)

Le relay est implémenté et fonctionnel:

- `SamplingRelay` reçoit les requêtes des child servers
- Forward vers `createMessageFn` (si configuré)
- Retourne la réponse au child

Le problème est que `createMessageFn` n'est jamais configuré car `server.createMessage` n'existe
pas.

## Solutions Proposées

### Option 1: BYOK Fallback (Recommandée)

Ajouter un fallback dans `setupSamplingRelay()` qui utilise l'API Anthropic directement:

```typescript
private setupSamplingRelay(): void {
  if (typeof this.server.createMessage === "function") {
    // SDK path (quand le client supporte sampling)
    samplingRelay.setCreateMessageFn((request) => this.server.createMessage(request));
    log.info("[Gateway] Sampling relay: SDK mode");
  } else {
    // BYOK fallback
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (apiKey) {
      samplingRelay.setCreateMessageFn((request) => callAnthropicAPI(apiKey, request));
      log.info("[Gateway] Sampling relay: BYOK mode (Anthropic API)");
    } else {
      log.warn("[Gateway] Sampling relay disabled - set ANTHROPIC_API_KEY for BYOK");
    }
  }
  // ... configure child handlers
}
```

**Avantages**:

- Fonctionne immédiatement avec `ANTHROPIC_API_KEY` dans `.env`
- Compatible stdio et HTTP
- Code BYOK existe déjà dans `playground/lib/llm-provider.ts`

**Inconvénients**:

- Coût API Anthropic
- Latence supplémentaire (appel API externe)

### Option 2: Attendre Claude Code

Attendre que Claude Code implémente `sampling/createMessage`.

**Avantages**: Zéro travail côté PML

**Inconvénients**: Délai inconnu, bloque la feature

### Option 3: Prompt Engineering Workaround

Remplacer `agent_delegate` par un pattern où l'agent principal (Claude Code) gère la boucle:

```typescript
// Au lieu de:
await mcp.std.agent_delegate({ goal: "...", allowedTools: [...] })

// Faire:
// 1. Retourner les tools disponibles
// 2. Laisser Claude Code décider et appeler
// 3. Boucler jusqu'à completion
```

**Avantages**: Utilise les capacités natives de Claude Code

**Inconvénients**:

- Change l'API
- Moins d'encapsulation
- Plus de tokens consommés

## Recommandation

**Implémenter Option 1 (BYOK Fallback)** car:

1. Permet de tester `agent_delegate` immédiatement
2. Nécessaire de toute façon pour le mode cloud/HTTP
3. Code LLM provider existe déjà
4. Backward compatible (utilisera SDK si disponible)

## Fichiers Concernés

- `src/mcp/gateway-server.ts` - Ajouter fallback BYOK dans `setupSamplingRelay()`
- `src/mcp/sampling/sampling-relay.ts` - Déjà prêt
- `lib/std/agent.ts` - Déjà prêt
- `playground/lib/llm-provider.ts` - À déplacer vers `src/` et enrichir

## Tests Effectués

```typescript
// Via pml_execute
const result = await mcp.std.agent_delegate({
  goal: "Analyze the project structure",
  allowedTools: ["filesystem_*"],
  maxIterations: 3,
});
// → MCP error -32601: Method not found
```

## Références

- [Tech Spec: MCP Agent Nodes](../tech-specs/tech-spec-mcp-agent-nodes.md)
- [Spike: MCP Sampling Agent Nodes](./2025-12-23-mcp-sampling-agent-nodes.md)
- [MCP Spec SEP-1577](https://spec.modelcontextprotocol.io) - Sampling avec tools (Nov 2025)
