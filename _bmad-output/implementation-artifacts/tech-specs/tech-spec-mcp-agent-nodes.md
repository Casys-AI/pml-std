# Tech Spec: MCP Agent Nodes via Sampling

**Date**: 2025-12-23 **Status**: Draft **Priority**: Medium **Spike**:
[2025-12-23-mcp-sampling-agent-nodes.md](../spikes/2025-12-23-mcp-sampling-agent-nodes.md)

## Objectif

Ajouter un type de nœud `agent` dans les DAGs qui peut faire des décisions runtime via MCP sampling.

## Contexte

La spec MCP de novembre 2025 (SEP-1577) permet aux serveurs MCP de faire des boucles agentiques via
`sampling/createMessage` avec tools.

## Scope

### In Scope

- Tool `agent_delegate` dans `lib/std/agent.ts`
- Handler de sampling dans le MCP client (gateway)
- Configuration LLM via env vars
- Traçage des appels sampling

### Out of Scope

- Branches conditionnelles dans le code généré (sujet séparé)
- Agent pool / réutilisation d'instances
- GraphRAG learning sur patterns d'agents (v2)

## Architecture

**Point clé:** Per MCP spec (SEP-1577), le **CLIENT** gère la boucle agentique, pas le serveur. Cela
garantit que les tool calls sont tracés via le RPC normal du client.

```
┌─────────────────────────────────────────────────────────────────┐
│  Code généré par l'agent :                                       │
│  await mcp.std.agent_delegate({ goal, context, allowedTools })  │
└─────────────────────────────────────────────────────────────────┘
                              │
                    Worker RPC → Main Process (tracé ✓)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  lib/mcp-tools-server.ts                                         │
│                                                                  │
│  tools/call "agent_delegate" →                                   │
│    sampling/createMessage({                                      │
│      messages: [{ role: "user", content: goal + context }],     │
│      allowedToolPatterns: ["git_*", "vfs_*"],                   │
│      maxIterations: 5                                            │
│    })                                                            │
│                                                                  │
│  ⚠️ Serveur ne boucle PAS - une seule requête sampling          │
└─────────────────────────────────────────────────────────────────┘
                              │
                    sampling/createMessage
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP Client (Gateway / Claude Code)                              │
│                                                                  │
│  loop {  ← CLIENT gère la boucle agentique                      │
│    response = LLM.createMessage(messages, tools)                │
│    if (tool_use) {                                               │
│      results = executeTool(...)  ← Tracé via RPC normal! ✓     │
│      messages.push(results)                                      │
│    } else {                                                      │
│      return response  ← Résultat final au serveur               │
│    }                                                             │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Traçage garanti

Parce que le CLIENT gère la boucle et l'exécution des tools :

- Chaque tool call passe par le RPC normal du client
- WorkerBridge/Gateway voit tous les appels
- Les traces incluent tous les tools utilisés par l'agent
- Pas de "boîte noire" - visibilité complète

## Implémentation

### 1. Nouveau tool : `lib/std/agent.ts` ✅ IMPLÉMENTÉ

```typescript
import { type MiniTool } from "./types.ts";

// Le serveur ne boucle PAS - le client gère l'agentic loop
export const agentTools: MiniTool[] = [
  {
    name: "agent_delegate",
    description: "Delegate a sub-task to an autonomous agent...",
    category: "agent",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the agent should accomplish" },
        context: { type: "object", description: "Context data for the agent" },
        allowedTools: { type: "array", items: { type: "string" }, description: "Tool patterns" },
        maxIterations: { type: "number", description: "Max iterations (hint for client)" },
      },
      required: ["goal"],
    },
    handler: async ({ goal, context, allowedTools, maxIterations = 5 }) => {
      const client = getSamplingClient();

      // UNE seule requête - le CLIENT gère la boucle agentique
      const response = await client.createMessage({
        messages: [{ role: "user", content: buildPrompt(goal, context) }],
        toolChoice: "auto",
        maxTokens: 4096,
        maxIterations: maxIterations as number, // Hint pour le client
        allowedToolPatterns: allowedTools as string[], // Filtre pour le client
      });

      // Le client retourne le résultat FINAL après avoir terminé la boucle
      return {
        success: response.stopReason === "end_turn",
        result: extractText(response.content),
        stopReason: response.stopReason,
      };
    },
  },
  // + 7 autres tools: agent_decide, agent_analyze, agent_extract,
  //   agent_classify, agent_summarize, agent_generate, agent_compare
];
```

**8 tools implémentés dans `lib/std/agent.ts`:**

- `agent_delegate` - Délégation de sous-tâche avec tools
- `agent_decide` - Décision booléenne ou choix multiple
- `agent_analyze` - Analyse de données structurée
- `agent_extract` - Extraction de données selon un schéma
- `agent_classify` - Classification dans des catégories
- `agent_summarize` - Résumé de contenu
- `agent_generate` - Génération de contenu (code, texte, etc.)
- `agent_compare` - Comparaison et ranking d'options

### 2. Export dans `lib/std/mod.ts` ✅ IMPLÉMENTÉ

```typescript
// Agent tools (MCP Sampling)
export { agentTools, setSamplingClient } from "./agent.ts";
import { agentTools } from "./agent.ts";

// Dans systemTools
export const systemTools = [
  ...existingTools,
  ...agentTools, // ✅ Ajouté
];

// Dans toolsByCategory
export const toolsByCategory = {
  ...existing,
  agent: agentTools, // ✅ Ajouté
};
```

### 3. Type `agent` dans `lib/std/types.ts` ✅ IMPLÉMENTÉ

```typescript
export type ToolCategory =
  | "text" | "json" | ...
  | "agent";  // ✅ Ajouté
```

### 4. Sampling handler (gateway) ⏳ TODO

Le MCP Client (Gateway ou Claude Code) doit implémenter le handler pour `sampling/createMessage`.

**Responsabilités du client:**

1. Recevoir la requête sampling du serveur
2. Filtrer les tools selon `allowedToolPatterns`
3. Gérer la boucle agentique (LLM → tool_use → execute → repeat)
4. Tracer chaque tool call via le RPC normal
5. Retourner le résultat final au serveur

```typescript
// Dans le client MCP (Gateway / mcp-tools-server.ts)
async handleSamplingRequest(params: CreateMessageParams): Promise<CreateMessageResult> {
  const tools = this.filterToolsByPatterns(params.allowedToolPatterns);
  let iterations = 0;
  const maxIterations = params.maxIterations || 5;

  while (iterations < maxIterations) {
    const response = await this.llm.createMessage({
      messages: params.messages,
      tools,
      maxTokens: params.maxTokens,
    });

    if (response.stopReason === "end_turn") {
      return response;
    }

    if (response.stopReason === "tool_use") {
      // Exécuter les tools - PASSENT PAR LE RPC NORMAL = TRACÉS ✓
      const results = await this.executeToolCalls(response.content);
      params.messages.push({ role: "assistant", content: response.content });
      params.messages.push({ role: "user", content: results });
    }

    iterations++;
  }

  return { stopReason: "max_tokens", content: [] };
}
```

## Configuration

### Claude Code (natif)

Aucune configuration. Le sampling est géré par Claude Code lui-même.

### Local / Cloud (BYOK)

Variables d'environnement dans `mcp-servers.json` :

```json
{
  "mcpServers": {
    "std": {
      "command": "deno",
      "args": ["run", "--allow-all", "lib/mcp-tools-server.ts"],
      "env": {
        "SAMPLING_PROVIDER": "anthropic",
        "SAMPLING_API_KEY": "sk-ant-...",
        "SAMPLING_MODEL": "claude-sonnet-4-20250514"
      }
    }
  }
}
```

| Variable            | Valeurs                                   | Description                 |
| ------------------- | ----------------------------------------- | --------------------------- |
| `SAMPLING_PROVIDER` | `native`, `anthropic`, `openai`, `ollama` | Provider LLM                |
| `SAMPLING_API_KEY`  | string                                    | Clé API (anthropic, openai) |
| `SAMPLING_ENDPOINT` | URL                                       | Endpoint custom (ollama)    |
| `SAMPLING_MODEL`    | string                                    | Modèle à utiliser           |

## Traçage

Les appels sampling doivent être tracés comme les autres tools :

```typescript
// Chaque itération de la boucle agentique
{
  type: "agent_iteration",
  traceId: "...",
  iteration: 1,
  toolCalls: ["git_status", "vfs_read"],
  durationMs: 2500,
}

// Résultat final
{
  type: "agent_complete",
  traceId: "...",
  totalIterations: 3,
  success: true,
  durationMs: 8500,
}
```

## Limites et sécurité

| Limite          | Défaut | Description                   |
| --------------- | ------ | ----------------------------- |
| `maxIterations` | 5      | Prévient les boucles infinies |
| `timeout`       | 60s    | Timeout global pour l'agent   |
| `allowedTools`  | tous   | Whitelist de tools autorisés  |

## Tests

```typescript
// tests/unit/lib/agent_test.ts
Deno.test("agent_delegate - simple goal", async () => {
  // Mock sampling client
  const mockSampling = createMockSamplingClient([
    { stopReason: "end_turn", content: [{ type: "text", text: "Done" }] },
  ]);

  const result = await agentTools[0].handler({
    goal: "Say hello",
    context: {},
  });

  assertEquals(result, { text: "Done" });
});

Deno.test("agent_delegate - with tool calls", async () => {
  const mockSampling = createMockSamplingClient([
    { stopReason: "tool_use", content: [{ type: "tool_use", name: "git_status" }] },
    { stopReason: "end_turn", content: [{ type: "text", text: "Status checked" }] },
  ]);

  const result = await agentTools[0].handler({
    goal: "Check git status",
    allowedTools: ["git_*"],
  });

  assertEquals(result, { text: "Status checked" });
  assertEquals(mockSampling.calls.length, 2);
});

Deno.test("agent_delegate - max iterations", async () => {
  const mockSampling = createMockSamplingClient([
    // Always returns tool_use, never ends
    ...Array(10).fill({ stopReason: "tool_use", content: [] }),
  ]);

  await assertRejects(
    () => agentTools[0].handler({ goal: "Loop forever", maxIterations: 3 }),
    Error,
    "exceeded max iterations",
  );
});
```

## Tâches

1. [ ] Créer `lib/std/agent.ts` avec `agent_delegate` tool
2. [ ] Exporter dans `lib/std/mod.ts`
3. [ ] Créer `src/mcp/sampling-handler.ts`
4. [ ] Intégrer dans `lib/mcp-tools-server.ts`
5. [ ] Ajouter traçage des itérations
6. [ ] Tests unitaires
7. [ ] Documentation

## Estimation

| Tâche               | Effort   |
| ------------------- | -------- |
| Tool agent_delegate | 0.5j     |
| Sampling handler    | 1j       |
| Intégration serveur | 0.5j     |
| Tests               | 0.5j     |
| **Total**           | **2.5j** |
