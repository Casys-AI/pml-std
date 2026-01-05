# ADR-040: Multi-tenant MCP & Secrets Management

**Status:** Accepted **Date:** 2025-12-09 **Authors:** Erwan, Claude **Epic:** 9 (GitHub
Authentication & Multi-Tenancy)

## Context

Casys PML supports two deployment modes:

- **Self-hosted (Local):** Single-user, offline, no authentication
- **Cloud (SaaS):** Multi-tenant, GitHub OAuth, API keys

In cloud mode, users need to:

1. Access MCP servers (filesystem, github, tavily, etc.)
2. Configure their own API keys for third-party services (BYOK)
3. Have their execution data isolated while sharing tool discovery

Key questions addressed:

- How do users configure MCPs in cloud mode?
- Where are user API keys stored?
- What is shared vs isolated between users?

## Decision

### 1. MCP Configuration Model

**Cloud mode uses a PML-managed MCP catalog, not user-defined servers.**

```
┌─────────────────────────────────────────────────────────────────┐
│  User's .mcp config (SIMPLE - one entry only)                   │
├─────────────────────────────────────────────────────────────────┤
│  {                                                              │
│    "mcpServers": {                                              │
│      "mcp-gateway": {                                           │
│        "type": "http",                                          │
│        "url": "https://pml.casys.ai/mcp",              │
│        "headers": { "x-api-key": "${PML_API_KEY}" }             │
│      }                                                          │
│    }                                                            │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

**Rationale:**

- Users cannot add custom MCP servers via their local config file
- All MCP management happens through the PML Dashboard
- PML controls the catalog of available MCPs (security, quality)
- Custom MCPs deferred to future iteration

### 2. MCP Categories

| Category    | Examples                        | API Key Source            |
| ----------- | ------------------------------- | ------------------------- |
| **Managed** | filesystem, memory, fetch       | None (PML provides)       |
| **OAuth**   | github                          | User's GitHub login token |
| **BYOK**    | tavily, brave, openai, airtable | User provides their key   |

### 3. BYOK (Bring Your Own Key)

Users configure their API keys via Dashboard Settings:

```
┌─────────────────────────────────────────────────────────────────┐
│  Settings → API Keys                                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  GitHub       [Connected via OAuth ✓]                           │
│  Tavily       [Enter API Key: ___________]                      │
│  Brave        [Enter API Key: ___________]                      │
│  OpenAI       [Enter API Key: ___________]                      │
│  Airtable     [Enter API Key: ___________]                      │
│                                                                  │
│  ⚠️ Keys are encrypted (AES-256-GCM) and only decrypted         │
│     server-side when calling the MCP.                           │
└─────────────────────────────────────────────────────────────────┘
```

### 4. Secrets Storage (AES-256-GCM)

**MVP approach: Symmetric encryption with master key**

```typescript
// Encryption
const iv = crypto.getRandomValues(new Uint8Array(12)); // Unique per secret
const encrypted = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  masterKey,
  new TextEncoder().encode(plaintext),
);

// Storage
user_secrets: {
  id,
    user_id,
    secret_name,
    ciphertext, // AES-256-GCM encrypted
    iv, // Unique initialization vector
    created_at,
    updated_at;
}
```

**Security rules:**

- `SECRETS_MASTER_KEY` stored in Deno Deploy secrets (never in code)
- Unique IV per secret (via `crypto.getRandomValues`)
- Decrypt only at MCP call time, discard immediately after
- Never log decrypted keys
- Audit log all secret access

**Future (Production):** Migrate to envelope encryption with AWS KMS / GCP Cloud KMS.

### 5. Data Isolation Model

```
┌─────────────────────────────────────────────────────────────────┐
│                         PML Platform                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  GLOBAL (shared across all users)                               │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ • mcp_tools (tool schemas from all MCPs)                   │ │
│  │ • tool_graph (GraphRAG relations)                          │ │
│  │ • embeddings (semantic search vectors)                     │ │
│  │ • capabilities (learned patterns - anonymized)             │ │
│  │                                                            │ │
│  │ → "All the tools in the world" - network effect            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  PRIVATE (isolated by user_id)                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ • dag_executions (my executions)                           │ │
│  │ • execution_traces (my logs)                               │ │
│  │ • user_secrets (my encrypted API keys)                     │ │
│  │ • user_mcp_configs (my enabled MCPs)                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Rationale:**

- Tool schemas are not sensitive - sharing enriches the graph for everyone
- User A adding Airtable MCP → tools visible to all users
- User B can see Airtable tools but cannot execute (no key configured)
- Execution data is private (personal workflows, results, traces)

### 6. Database Schema

```typescript
// user_mcp_configs - Which MCPs the user has enabled
export const userMcpConfigs = sqliteTable("user_mcp_configs", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id).notNull(),
  mcpName: text("mcp_name").notNull(), // "tavily", "github", etc.
  enabled: integer("enabled").default(1),
  configJson: text("config_json"), // MCP-specific options
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});

// user_secrets - Encrypted API keys
export const userSecrets = sqliteTable("user_secrets", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id).notNull(),
  secretName: text("secret_name").notNull(), // "TAVILY_API_KEY"
  ciphertext: text("ciphertext").notNull(), // AES-256-GCM encrypted
  iv: text("iv").notNull(), // Initialization vector
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});

// Unique constraint: one secret per name per user
// Index on (user_id, secret_name) for fast lookup
```

### 7. MCP Execution Flow

```
1. User calls tool (e.g., tavily_search) via MCP Gateway
        │
        ▼
2. Gateway authenticates user (x-api-key header)
        │
        ▼
3. Gateway checks: Does user have Tavily enabled?
   SELECT * FROM user_mcp_configs
   WHERE user_id = ? AND mcp_name = 'tavily' AND enabled = 1
        │
        ▼
4. Gateway loads user's Tavily API key
   SELECT ciphertext, iv FROM user_secrets
   WHERE user_id = ? AND secret_name = 'TAVILY_API_KEY'
        │
        ▼
5. Decrypt key in memory (AES-256-GCM)
        │
        ▼
6. Call Tavily MCP with decrypted key
        │
        ▼
7. Return result to user
        │
        ▼
8. Discard decrypted key from memory
```

### 8. Repository Strategy

**Decision: Mono-repo (open source) for MVP**

```
github.com/casys-ai/pml/     # Public - MIT/Apache 2.0
├── src/
│   ├── core/           # GraphRAG, embeddings
│   ├── mcp/            # Gateway, MCP management
│   ├── server/         # API server, auth
│   ├── web/            # Dashboard (including landing page)
│   └── db/             # Drizzle schema
└── LICENSE
```

**Rationale:**

- Simplicity for MVP - single codebase
- Landing page in open source is acceptable (brand value is in the service)
- True differentiation: managed infra, global GraphRAG, support
- Future: Split to dual-repo if premium features needed

## Alternatives Considered

### Smithery Integration

**Rejected.** Smithery does not provide a single API key for all MCPs. Each MCP has its own URL and
OAuth flow. Integration would add complexity without simplifying user experience.

### Custom MCPs (User-defined servers)

**Deferred.** For MVP, users choose from PML catalog only. Custom MCPs require:

- Security review process
- Sandboxed execution
- Support complexity

Can be added in future iteration.

### Envelope Encryption (KMS)

**Deferred to production.** MVP uses AES-256-GCM with master key in environment. Production should
use AWS KMS or GCP Cloud KMS for:

- Master key never exposed
- Automatic key rotation
- Audit logs

## Consequences

### Positive

- Simple user experience: Dashboard-only MCP config
- Security: Keys encrypted at rest, decrypted only at call time
- Network effect: More users = more tools in global graph
- Flexibility: BYOK allows users to use their own quotas

### Negative

- No custom MCPs in MVP (users limited to PML catalog)
- Master key is single point of failure (mitigated by KMS in prod)
- Users must trust PML with encrypted keys

### Risks

- Master key compromise → all secrets exposed
  - Mitigation: KMS in production, key rotation, monitoring
- MCP catalog doesn't have tool user needs
  - Mitigation: Fast catalog expansion based on requests

## Related

- **ADR-009:** JSON Config Format
- **Epic 9:** GitHub Authentication & Multi-Tenancy
- **Story 9.5:** Rate Limiting & Data Isolation (will include secrets)
- **Tech Spec:** tech-spec-github-auth-multitenancy.md
