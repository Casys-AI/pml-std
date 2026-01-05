# ADR-043: All Tools Must Succeed for Capability Save

**Status:** Accepted **Date:** 2025-12-13 **Related:** ADR-027 (Execute Code Graph Learning),
ADR-041 (Hierarchical Traces), Story 7.2a

## Context

Lors de l'exécution de code via PML (`execute_code`), le système utilise **eager learning** pour
sauvegarder les capabilities après chaque exécution réussie (Story 7.2a).

Cependant, un workflow peut utiliser plusieurs MCP tools, et certains peuvent échouer (serveur non
connecté, timeout, erreur d'API) pendant que d'autres réussissent.

### Problème observé

Un workflow appelant 4 tools (Gmail, Google Maps, Memory, Notion) a été sauvegardé avec seulement 2
tools dans `tools_used` car :

1. `gmail:get_profile` → erreur "MCP server not connected"
2. `google_maps:text_search` → erreur "MCP server not connected"
3. `memory:search_nodes` → succès ✓
4. `notion:notion-get-user` → erreur "server undefined"

Le code actuel (`getToolsCalled()`) ne gardait que les tools avec `success: true`, créant une
capability **incohérente** :

- Le `code_snippet` stocké contient les 4 appels tools
- Le `tools_used` ne contient qu'un sous-ensemble
- Le graph hypergraphe ne montre que les tools "réussis" comme enfants de la capability

## Problem

Cette incohérence crée plusieurs problèmes :

| Impact                  | Description                                               |
| ----------------------- | --------------------------------------------------------- |
| **Visualisation graph** | La capability montre 1-2 tools au lieu de 4 dans le graph |
| **Semantic matching**   | La recherche par tools overlap rate mal le workflow       |
| **Reproductibilité**    | Réexécuter le code ne produit pas les mêmes résultats     |
| **Debugging**           | Difficile de comprendre pourquoi un workflow échoue       |

## Decision

### Règle : All-or-Nothing pour les Capabilities

Une capability n'est sauvegardée **que si TOUS les tools appelés ont réussi**.

```typescript
// worker-bridge.ts

// Nouveau helper
hasAnyToolFailed(): boolean {
  for (const trace of this.traces) {
    if (trace.type === "tool_end" && !trace.success) {
      return true;
    }
  }
  return false;
}

// Condition modifiée
const hasToolFailures = this.hasAnyToolFailed();
if (result.success && this.capabilityStore && this.lastIntent && !hasToolFailures) {
  await this.capabilityStore.saveCapability({
    code: this.lastExecutedCode,
    intent: this.lastIntent,
    toolsUsed: this.getToolsCalled(),
    // ...
  });
} else if (hasToolFailures) {
  logger.info("Capability not saved due to tool failures", {
    failedTools: [...],
  });
}
```

### Comportement résultant

| Scénario                       | Résultat                                              |
| ------------------------------ | ----------------------------------------------------- |
| Tous les tools réussissent     | Capability sauvegardée avec tous les tools            |
| Un ou plusieurs tools échouent | Capability **non sauvegardée**, log informatif        |
| Code sans tools MCP            | Capability sauvegardée (executor.ts, `toolsUsed: []`) |

### Logging

Quand une capability n'est pas sauvegardée à cause d'échecs tools :

```json
{
  "level": "info",
  "message": "Capability not saved due to tool failures",
  "intent": "Call Gmail, Google Maps, Memory...",
  "failedTools": ["gmail:get_profile", "google_maps:text_search", "notion:notion-get-user"]
}
```

## Consequences

### Positives

1. **Cohérence garantie** : `code_snippet` et `tools_used` sont toujours synchronisés
2. **Graph propre** : Plus de capabilities avec des tools "fantômes"
3. **Matching précis** : Le scoring par tools overlap est fiable
4. **Debugging facilité** : Les logs indiquent exactement quels tools ont échoué

### Négatives

1. **Moins de capabilities** : Les workflows partiellement fonctionnels ne sont plus sauvegardés
2. **Retry nécessaire** : L'utilisateur doit réexécuter quand tous les servers sont connectés

### Mitigation

- Les traces d'exécution sont toujours stockées (pour debugging)
- GraphRAG peut toujours apprendre des patterns tool→tool même si la capability n'est pas
  sauvegardée
- Un futur flag `--allow-partial` pourrait permettre de sauvegarder les capabilities partielles (non
  implémenté)

## Files Changed

- `src/sandbox/worker-bridge.ts`:
  - Ajout de `hasAnyToolFailed()` method
  - Modification de la condition de sauvegarde capability

- `src/mcp/gateway-server.ts`:
  - Extraction des tools échoués depuis les traces
  - Ajout de `tool_failures` dans la réponse `pml:execute_code`

- `src/mcp/types.ts`:
  - Ajout du champ `tool_failures` à `CodeExecutionResponse`

### Surfacing Tool Failures to Agent

Même si le code JavaScript "réussit" (grâce aux try/catch), les échecs de tools sont maintenant
explicitement surfacés dans la réponse:

```json
{
  "result": { ... },
  "metrics": { ... },
  "tool_failures": [
    { "tool": "gmail:get_profile", "error": "MCP server not connected" },
    { "tool": "notion:notion-get-user", "error": "Server undefined" }
  ]
}
```

L'agent voit ainsi clairement quels tools ont échoué, même si `result` contient des données
partielles.

## Test Cases

```typescript
// Test: Capability NOT saved when tool fails
it("should not save capability when any tool fails", async () => {
  const bridge = new WorkerBridge(/* with capabilityStore */);

  // Execute code that calls 2 tools, 1 fails
  await bridge.executeCode(
    `
    await mcp.memory.search_nodes({ query: "test" }); // succeeds
    await mcp.gmail.get_profile({}); // fails - not connected
  `,
    { intent: "test workflow" },
  );

  // Verify capability was NOT saved
  expect(capabilityStore.saveCapability).not.toHaveBeenCalled();
});

// Test: Capability saved when all tools succeed
it("should save capability when all tools succeed", async () => {
  // ... setup all tools to succeed
  await bridge.executeCode(
    `
    await mcp.memory.search_nodes({ query: "test" });
    await mcp.memory.create_entities({ entities: [...] });
  `,
    { intent: "memory workflow" },
  );

  expect(capabilityStore.saveCapability).toHaveBeenCalledWith(
    expect.objectContaining({
      toolsUsed: ["memory:search_nodes", "memory:create_entities"],
    }),
  );
});
```
