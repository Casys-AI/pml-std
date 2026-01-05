# Security Architecture

## Threat Model

### Assets à Protéger

| Asset                       | Criticité | Menaces Principales                 |
| --------------------------- | --------- | ----------------------------------- |
| Code utilisateur (sandbox)  | Haute     | Injection, escalation de privilèges |
| Données MCP (fichiers, API) | Haute     | Accès non autorisé, exfiltration    |
| Base de données PGlite      | Moyenne   | Corruption, injection SQL           |
| Configuration MCP           | Moyenne   | Manipulation, secrets exposés       |
| Embeddings/GraphRAG         | Basse     | Empoisonnement du modèle            |

### Vecteurs d'Attaque et Mitigations

```
┌─────────────────────────────────────────────────────────────┐
│                    THREAT MODEL                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [Attaquant]                                                │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │ Code Inject │    │ MCP Abuse   │    │ Data Exfil  │     │
│  │ (sandbox)   │    │ (tool call) │    │ (context)   │     │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘     │
│         │                  │                  │             │
│         ▼                  ▼                  ▼             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              SECURITY CONTROLS                       │   │
│  │  • Deno permissions sandbox                          │   │
│  │  • Worker RPC isolation (no direct MCP access)       │   │
│  │  • Input validation (JSON Schema)                    │   │
│  │  • PII tokenization                                  │   │
│  │  • Parameterized SQL queries                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Sandbox Isolation (Epic 3 + 7)

### Modèle de Permissions Deno

```typescript
// Worker RPC Bridge (ADR-032)
new Worker(workerScript, {
  type: "module",
  deno: {
    permissions: "none", // Aucune permission par défaut
  },
});
```

**Permissions refusées dans le sandbox :**

- `--allow-read` - Pas d'accès fichiers (sauf contexte injecté)
- `--allow-write` - Pas d'écriture
- `--allow-net` - Pas de réseau
- `--allow-run` - Pas de subprocess
- `--allow-env` - Pas de variables d'environnement
- `--allow-ffi` - Pas de FFI

### Communication Worker ↔ Main Process

```
Main Process (permissions complètes)     Worker (permissions: "none")
┌────────────────────────────────┐      ┌────────────────────────────┐
│ MCPClients                     │      │ Tool Proxies (__rpcCall)   │
│ WorkerBridge                   │◄────►│ User Code Execution        │
│   - traces[] (audit log)       │      │ Aucun accès direct MCP     │
│   - callTool() validation      │      │                            │
└────────────────────────────────┘      └────────────────────────────┘
         postMessage RPC                       Isolation totale
```

**Contrôles RPC :**

- Validation des noms de tools (whitelist)
- Validation des arguments (JSON Schema)
- Timeout par appel (30s défaut)
- Rate limiting (configurable)

---

## Data Protection

### PII Tokenization

```typescript
// Détection automatique avant exécution sandbox
const piiPatterns = {
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  PHONE: /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  SSN: /\d{3}-\d{2}-\d{4}/g,
  CREDIT_CARD: /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/g,
  API_KEY: /(sk-|pk_|api[_-]?key)[a-zA-Z0-9]{20,}/gi,
};

// Résultat: alice@secret.com → [EMAIL_1]
```

### Database Security (PGlite)

| Menace              | Mitigation                                  |
| ------------------- | ------------------------------------------- |
| SQL Injection       | Requêtes paramétrées uniquement             |
| Data corruption     | Transactions ACID, WAL mode                 |
| Unauthorized access | Fichier local, permissions OS               |
| Backup exposure     | Pas de secrets dans la DB (tools seulement) |

```sql
-- Exemple de requête paramétrée
SELECT * FROM mcp_tools WHERE server_name = $1 AND tool_name = $2
-- Jamais: SELECT * FROM mcp_tools WHERE name = '${userInput}'
```

---

## Input Validation

### CLI Arguments (cliffy)

```typescript
// Validation stricte des entrées CLI
const command = new Command()
  .option("--config <path:file>", "Config file path") // Validé comme fichier
  .option("--port <port:integer>", "Server port", { default: 3001 })
  .option("--timeout <ms:integer>", "Timeout", { default: 30000 });
```

### MCP Protocol Validation

```typescript
// Validation des réponses MCP contre JSON Schema
const toolSchema = {
  type: "object",
  required: ["name", "description", "inputSchema"],
  properties: {
    name: { type: "string", pattern: "^[a-z_][a-z0-9_]*$" },
    description: { type: "string", maxLength: 1000 },
    inputSchema: { type: "object" },
  },
};
```

### Code Execution Validation

```typescript
// Avant exécution sandbox
function validateCodeInput(input: ExecuteCodeInput): void {
  if (!input.code || input.code.trim().length === 0) {
    throw new ValidationError("Code cannot be empty");
  }
  if (input.code.length > 100 * 1024) { // 100KB max
    throw new ValidationError("Code exceeds maximum size");
  }
  // Vérification patterns dangereux
  const dangerousPatterns = [
    /Deno\.(run|Command)/, // Subprocess
    /import\s+.*from\s+["']http/, // Remote imports
    /eval\s*\(/, // eval()
    /new\s+Function\s*\(/, // Function constructor
  ];
  for (const pattern of dangerousPatterns) {
    if (pattern.test(input.code)) {
      throw new SecurityError(`Dangerous pattern detected: ${pattern}`);
    }
  }
}
```

---

## Network Security

### Transport MCP

| Mode     | Exposition         | Use Case                  |
| -------- | ------------------ | ------------------------- |
| stdio    | Aucune (local IPC) | Claude Desktop, CLI       |
| HTTP/SSE | localhost:3001     | Dashboard, debugging      |
| HTTPS    | Configurable       | Future: remote deployment |

### Dashboard (Epic 6)

```typescript
// CORS strict pour le dashboard
const corsHeaders = {
  "Access-Control-Allow-Origin": "http://localhost:8080",
  "Access-Control-Allow-Methods": "GET, POST",
  "Access-Control-Allow-Headers": "Content-Type",
};
```

---

## Audit & Logging

### Traces d'Exécution

```typescript
interface ExecutionTrace {
  timestamp: Date;
  operation: "tool_call" | "code_execution" | "dag_step";
  server: string;
  tool: string;
  args_hash: string; // Hash des arguments (pas les valeurs)
  result_type: "success" | "error" | "timeout";
  duration_ms: number;
  user_session_id: string;
}
```

### Événements Audités

| Événement              | Niveau | Données Logged                   |
| ---------------------- | ------ | -------------------------------- |
| Tool call              | INFO   | server, tool, duration           |
| Code execution         | INFO   | code_hash, duration              |
| Security violation     | WARN   | pattern, source                  |
| Sandbox escape attempt | ERROR  | full context                     |
| PII detected           | DEBUG  | count par type (pas les valeurs) |

---

## Secure Defaults

| Configuration               | Valeur par Défaut | Raison                        |
| --------------------------- | ----------------- | ----------------------------- |
| `piiProtection`             | `true`            | Protection par défaut         |
| `sandbox.permissions`       | `"none"`          | Principe du moindre privilège |
| `network.cors`              | `localhost` only  | Pas d'accès externe           |
| `telemetry`                 | `opt-in`          | Respect vie privée            |
| `speculation.dangerous_ops` | `disabled`        | Sécurité avant performance    |

---

## Dangerous Operations Blocklist

Les opérations suivantes ne sont **jamais** exécutées en mode spéculatif :

```typescript
const DANGEROUS_OPS = [
  /delete/i,
  /remove/i,
  /destroy/i,
  /drop/i,
  /deploy/i,
  /publish/i,
  /send_email/i,
  /payment/i,
  /transfer/i,
  /execute_sql/i, // Raw SQL
];
```

---

_Références :_

- [ADR-032: Sandbox Worker RPC Bridge](./architecture-decision-records-adrs.md#adr-032-sandbox-worker-rpc-bridge)
- [Pattern 5: Agent Code Execution](./pattern-5-agent-code-execution-local-processing-epic-3.md)
- [Pattern 6: Worker RPC Bridge](./pattern-6-worker-rpc-bridge-emergent-capabilities-epic-7.md)
