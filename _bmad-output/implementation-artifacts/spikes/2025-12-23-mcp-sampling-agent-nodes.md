# Spike: MCP Sampling with Tools - Nœuds Agent

**Date:** 2025-12-23 **Auteur:** Erwan + Claude **Status:** Exploration → Tech Spec créée
**Contexte:** Discussion sur les branches conditionnelles dans les DAGs et la possibilité de nœuds
"agent" **Supersedes:**
[spike-hybrid-dag-agent-delegation.md](./spike-hybrid-dag-agent-delegation.md) (2025-11-23) **Tech
Spec:** [tech-spec-mcp-agent-nodes.md](../tech-specs/tech-spec-mcp-agent-nodes.md)

---

## Résumé

Exploration de la spec MCP (novembre 2025) concernant le "sampling with tools" et son potentiel pour
créer des nœuds de type `agent` dans nos DAGs.

> **Note:** Ce spike reprend les concepts de design du spike de novembre 2025 (AgentDelegationTask,
> tool filtering, budget, GraphRAG integration) mais propose une implémentation basée sur le
> protocole MCP standard (sampling) plutôt qu'un spawn d'instances Claude custom.

### Avantage clé : Claude Code

Avec Claude Code, le sampling fonctionne **nativement sans configuration** car Claude Code EST déjà
un client MCP avec accès au LLM. Les utilisateurs Claude Code pourraient utiliser les agent nodes
directement, sans clé API à configurer.

---

## MCP Sampling - Qu'est-ce que c'est ?

Le **sampling** MCP permet à un **serveur** MCP de demander une complétion LLM au **client**.

```
┌────────────────┐                    ┌────────────────┐
│   MCP Client   │◄─── sampling/ ─────│   MCP Server   │
│  (contrôle LLM)│     createMessage  │   (ton tool)   │
└────────────────┘                    └────────────────┘
```

**Avant (2024):** Sampling simple - le serveur demande une réponse texte.

**Maintenant (2025-11-25, SEP-1577):** Sampling with tools - le serveur peut :

1. Demander une complétion avec `tools` disponibles
2. Recevoir des `ToolUseContent` en réponse
3. Exécuter ces tools
4. Renvoyer les résultats au LLM
5. **Boucle agentique côté serveur**

---

## Spec MCP - Types clés

```typescript
// sampling/createMessage avec tools
interface CreateMessageRequestParams {
  messages: SamplingMessage[];
  tools?: Tool[]; // ← Nouveau !
  toolChoice?: ToolChoice; // "auto" | "required" | "none"
  maxTokens: number;
}

// Réponse peut contenir des tool calls
type SamplingMessageContentBlock =
  | TextContent
  | ImageContent
  | ToolUseContent // ← LLM demande un tool
  | ToolResultContent; // ← Résultat du tool

interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
```

**Source:** [SEP-1577](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1577)

---

## Potentiel : Nœuds `agent`

### Actuellement dans nos DAGs

```typescript
type StaticStructureNode =
  | { type: "task"; tool: string } // MCP tool call
  | { type: "decision"; condition: string } // if/else (SWC)
  | { type: "capability"; capabilityId: string } // nested capability
  | { type: "fork" }
  | { type: "join" }; // parallel
```

### Avec sampling with tools

```typescript
// Nouveau type potentiel
| { type: "agent"; goal: string; tools: string[] }
```

Un nœud `agent` serait une **boîte noire intelligente** qui :

1. Reçoit un goal + context
2. Utilise sampling pour décider quoi faire
3. Appelle des tools selon les décisions LLM
4. Retourne un résultat

---

## Cas d'usage : Décisions basées sur résultats

```typescript
// L'agent principal génère :
const fileInfo = await mcp.filesystem.read_file({ path });

// Au lieu d'un if/else statique, délègue la décision :
const action = await mcp.agent.decide({
  goal: "Détermine la meilleure action pour ce fichier",
  context: { fileInfo },
  tools: ["filesystem:write_file", "filesystem:delete_file", "git:commit"],
});

// Le sub-agent utilise sampling pour :
// 1. Analyser fileInfo
// 2. Décider quelle action prendre
// 3. Exécuter l'action choisie
// 4. Retourner le résultat
```

### Différence avec une capability

| Aspect      | Capability               | Agent Node               |
| ----------- | ------------------------ | ------------------------ |
| Décisions   | Statiques (code généré)  | Dynamiques (runtime LLM) |
| Visibilité  | Structure complète (SWC) | Boîte noire              |
| Contrôle    | Déterministe             | Probabiliste             |
| Traçabilité | Chaque tool tracé        | Agent + tools internes   |

---

## Architecture potentielle

```
┌─────────────────────────────────────────────────────────────────┐
│  Code généré :                                                   │
│  await mcp.agent.analyze({ goal: "...", context, tools })       │
└─────────────────────────────────────────────────────────────────┘
                              │
                    Worker → RPC → Main Process
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP Agent Server                                                │
│                                                                  │
│  loop {                                                          │
│    response = sampling/createMessage({                           │
│      messages: [...history],                                     │
│      tools: allowedTools,                                        │
│      toolChoice: "auto"                                          │
│    });                                                           │
│                                                                  │
│    if (response.stopReason === "toolUse") {                     │
│      result = executeTools(response.toolCalls);                  │
│      history.push(result);                                       │
│    } else {                                                      │
│      return response.content;                                    │
│    }                                                             │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Configuration LLM pour le Sampling

Le sampling nécessite un accès LLM. Trois modes selon l'environnement :

### Mode 1 : Claude Code (Natif)

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code = Claude + MCP Client intégré                       │
│                                                                  │
│  sampling/createMessage → Répondu directement par Claude         │
│                                                                  │
│  ✅ Zéro configuration                                           │
│  ✅ Pas de clé API à fournir                                     │
│  ✅ Fonctionne out-of-the-box                                    │
└─────────────────────────────────────────────────────────────────┘
```

### Mode 2 : Local / Self-hosted

L'utilisateur fournit sa clé API dans `mcp-servers.json` :

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

Providers supportés :

- `anthropic` - Claude API (clé utilisateur)
- `openai` - OpenAI API (clé utilisateur)
- `ollama` - Local LLM (gratuit, endpoint local)

```json
{
  "env": {
    "SAMPLING_PROVIDER": "ollama",
    "SAMPLING_ENDPOINT": "http://localhost:11434",
    "SAMPLING_MODEL": "llama3"
  }
}
```

### Mode 3 : Cloud (SaaS)

Même pattern que local - clé API dans la config :

```json
{
  "env": {
    "SAMPLING_PROVIDER": "anthropic",
    "SAMPLING_API_KEY": "sk-ant-..."
  }
}
```

**Évolution future :** Abonnement avec quota inclus (pas de clé à fournir).

### Résumé des modes

| Mode               | Config             | Qui paie           | Use case                 |
| ------------------ | ------------------ | ------------------ | ------------------------ |
| **Claude Code**    | Aucune             | Anthropic (inclus) | Utilisateurs Claude Code |
| **Local**          | `mcp-servers.json` | Utilisateur (BYOK) | Dev local, self-hosted   |
| **Cloud**          | `mcp-servers.json` | Utilisateur (BYOK) | Déploiement cloud        |
| **Cloud (future)** | Abonnement         | Subscription       | SaaS simplifié           |

---

## Questions ouvertes

1. **Configuration** - Comment configurer les tools autorisés pour un agent node ?
2. **Limites** - Max iterations ? Timeout ? Budget tokens ?
3. **Traçabilité** - Comment exposer les décisions internes du sub-agent ?
4. **Learning** - SHGAT peut-il apprendre sur des patterns de sub-agents ?
5. **HIL** - Human-in-the-loop pour les décisions du sub-agent ?

---

## Position actuelle

**Notre architecture** (code généré → SWC → Worker → RPC → MCP) est alignée avec les recommandations
Anthropic ("Code execution with MCP").

Les décisions (if/else) sont générées par l'agent principal dans le code.

Les nœuds `agent` seraient utiles pour :

- Décisions complexes basées sur résultats runtime
- Délégation de sous-tâches
- Réduction de la complexité du code généré

---

## Prochaines étapes (si exploration)

1. [ ] Prototype MCP server avec sampling
2. [ ] Tester la boucle agentique
3. [ ] Définir le schéma de configuration
4. [ ] Intégrer dans StaticStructureBuilder (nouveau type `agent`)
5. [ ] Adapter le traçage pour les sub-agents

---

## Références

- [MCP Spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [SEP-1577: Sampling With Tools](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1577)
- [Anthropic: Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
