# ADR-035: Permission Sets for Sandbox Security (Deno 2.5+)

**Status:** ✅ Accepted (Stories Created: 7.7a, 7.7b, 7.7c) **Date:** 2025-12-05 | **Updated:**
2025-12-16 | **Deciders:** Architecture Team

## Context

Casys PML exécute du code généré par LLM dans un sandbox Deno isolé:

- `src/sandbox/executor.ts` - Exécution dans subprocess Deno
- `src/sandbox/worker-bridge.ts` - Communication RPC avec le worker
- `src/sandbox/security-validator.ts` - Validation du code avant exécution
- ADR-032: Sandbox Worker RPC Bridge architecture

**Problème actuel:** Les permissions sont définies globalement pour tout le sandbox:

```typescript
// src/sandbox/executor.ts (actuel)
const command = new Deno.Command("deno", {
  args: [
    "run",
    "--allow-read", // Tout fichier
    "--allow-net", // Tout réseau
    "--allow-env", // Toutes variables
    // ... permissions larges
  ],
});
```

**Risques:**

- Une capability malveillante peut lire n'importe quel fichier
- Accès réseau non restreint
- Pas de différenciation entre capabilities "trusted" et "untrusted"

**Opportunité:** Deno 2.5 introduit les **Permission Sets** - permissions granulaires nommées.

## Decision

Adopter les Permission Sets de Deno 2.5 pour implémenter des profils de sécurité par capability.

### Permission Sets Deno 2.5

```json
// deno.json - définition des permission sets
{
  "permissions": {
    "minimal": {
      "read": false,
      "write": false,
      "net": false,
      "env": false,
      "run": false
    },
    "filesystem-readonly": {
      "read": ["./data", "/tmp"],
      "write": false,
      "net": false
    },
    "network-limited": {
      "read": false,
      "write": false,
      "net": ["api.example.com", "localhost:3000"]
    },
    "mcp-standard": {
      "read": ["./"],
      "write": ["./output", "/tmp"],
      "net": true,
      "env": ["HOME", "PATH"]
    }
  }
}
```

```bash
# Utilisation
deno run --permission-set=minimal script.ts
deno run --permission-set=filesystem-readonly script.ts
```

### Architecture Cible

```
┌─────────────────────────────────────────────────────────────────┐
│  Capability Storage (workflow_pattern table)                     │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ id: uuid                                                    │ │
│  │ code_snippet: "await mcp.fs.read(...)"                     │ │
│  │ permission_set: "filesystem-readonly"  ← NEW COLUMN        │ │
│  │ source: "emergent" | "manual"                              │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Sandbox Executor                                                │
│                                                                  │
│  1. Load capability from DB                                      │
│  2. Get permission_set (default: "minimal")                     │
│  3. Execute with restricted permissions                          │
│                                                                  │
│  const cmd = new Deno.Command("deno", {                         │
│    args: [                                                       │
│      "run",                                                      │
│      `--permission-set=${capability.permissionSet}`,            │
│      "sandbox-worker.ts"                                         │
│    ]                                                             │
│  });                                                             │
└─────────────────────────────────────────────────────────────────┘
```

### Permission Profiles

| Profile        | Read         | Write      | Net         | Env     | Use Case                     |
| -------------- | ------------ | ---------- | ----------- | ------- | ---------------------------- |
| `minimal`      | ❌           | ❌         | ❌          | ❌      | Pure computation, math       |
| `readonly`     | `["./data"]` | ❌         | ❌          | ❌      | Data analysis                |
| `filesystem`   | `["./"]`     | `["/tmp"]` | ❌          | ❌      | File processing              |
| `network-api`  | ❌           | ❌         | `["api.*"]` | ❌      | API calls only               |
| `mcp-standard` | ✅           | `["/tmp"]` | ✅          | Limited | Standard MCP tools           |
| `trusted`      | ✅           | ✅         | ✅          | ✅      | Manual/verified capabilities |

### Inférence Automatique des Permissions

```typescript
// src/capabilities/permission-inferrer.ts
import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";

interface InferredPermissions {
  permissionSet: string;
  confidence: number;
  detectedPatterns: string[];
}

export async function inferPermissions(code: string): Promise<InferredPermissions> {
  const ast = await parse(code, { syntax: "typescript" });
  const patterns: string[] = [];

  // Detect MCP tool usage patterns
  const usesFilesystem = detectPattern(ast, "mcp.filesystem") ||
    detectPattern(ast, "mcp.fs");
  const usesNetwork = detectPattern(ast, "fetch") ||
    detectPattern(ast, "mcp.api");
  const usesEnv = detectPattern(ast, "Deno.env") ||
    detectPattern(ast, "process.env");

  if (usesFilesystem) patterns.push("filesystem");
  if (usesNetwork) patterns.push("network");
  if (usesEnv) patterns.push("env");

  // Determine permission set
  let permissionSet = "minimal";
  if (patterns.length === 0) {
    permissionSet = "minimal";
  } else if (patterns.includes("filesystem") && !patterns.includes("network")) {
    permissionSet = "filesystem";
  } else if (patterns.includes("network") && !patterns.includes("filesystem")) {
    permissionSet = "network-api";
  } else {
    permissionSet = "mcp-standard";
  }

  return {
    permissionSet,
    confidence: patterns.length > 0 ? 0.8 : 0.95,
    detectedPatterns: patterns,
  };
}
```

### Intégration avec Story 7.2b (Schema Inference)

```typescript
// src/capabilities/capability-store.ts - Extended
import { inferPermissions } from "./permission-inferrer.ts";
import { inferSchema } from "./schema-inferrer.ts";

async saveCapability(input: SaveCapabilityInput): Promise<Capability> {
  // Existing: Schema inference (Story 7.2b)
  const parametersSchema = await inferSchema(input.code);

  // NEW: Permission inference (ADR-035)
  const { permissionSet, confidence } = await inferPermissions(input.code);

  // Store with both
  await this.db.query(`
    INSERT INTO workflow_pattern (
      code_snippet,
      parameters_schema,
      permission_set,        -- NEW
      permission_confidence  -- NEW
    ) VALUES ($1, $2, $3, $4)
  `, [input.code, parametersSchema, permissionSet, confidence]);
}
```

### Migration DB

```sql
-- Migration 017: Add permission columns (Story 7.7a)
ALTER TABLE workflow_pattern
ADD COLUMN IF NOT EXISTS permission_set VARCHAR(50) DEFAULT 'minimal',
ADD COLUMN IF NOT EXISTS permission_confidence REAL DEFAULT 0.0;

-- Index for permission-based queries
CREATE INDEX IF NOT EXISTS idx_workflow_pattern_permission
ON workflow_pattern(permission_set);
```

### Sandbox Executor Changes

```typescript
// src/sandbox/executor.ts - Updated
export class SandboxExecutor {
  async execute(
    code: string,
    context: ExecutionContext,
    permissionSet: string = "minimal"  // NEW parameter
  ): Promise<ExecutionResult> {

    const args = [
      "run",
      "--no-prompt",  // Never prompt for permissions
    ];

    // Deno 2.5+: Use permission sets
    if (this.supportsPermissionSets()) {
      args.push(`--permission-set=${permissionSet}`);
    } else {
      // Fallback for older Deno: use explicit flags
      args.push(...this.permissionSetToFlags(permissionSet));
    }

    args.push("sandbox-worker.ts");

    const command = new Deno.Command("deno", { args, ... });
    // ...
  }

  private permissionSetToFlags(set: string): string[] {
    const profiles: Record<string, string[]> = {
      "minimal": [],
      "readonly": ["--allow-read=./data"],
      "filesystem": ["--allow-read", "--allow-write=/tmp"],
      "network-api": ["--allow-net"],
      "mcp-standard": ["--allow-read", "--allow-write=/tmp", "--allow-net"],
      "trusted": ["--allow-all"],
    };
    return profiles[set] ?? [];
  }
}
```

### Security Escalation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Capability Execution Request                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Check stored permission_set                                     │
│                                                                  │
│  if (capability.source === "manual") {                          │
│    // User verified → use stored permissions                     │
│    return capability.permissionSet;                              │
│  }                                                               │
│                                                                  │
│  if (capability.permissionConfidence < 0.7) {                   │
│    // Low confidence → use minimal                               │
│    return "minimal";                                             │
│  }                                                               │
│                                                                  │
│  return capability.permissionSet;                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Execute with determined permission set                          │
│                                                                  │
│  If execution fails with PermissionDenied:                       │
│    → Log failure, suggest permission escalation                  │
│    → User can manually approve higher permissions                │
└─────────────────────────────────────────────────────────────────┘
```

### HIL (Human-in-the-Loop) for Escalation

```typescript
// Integration with existing HIL from DAG executor
interface PermissionEscalationRequest {
  capabilityId: string;
  currentSet: string;
  requestedSet: string;
  reason: string; // e.g., "PermissionDenied: read access to /etc/hosts"
}

// In controlled-executor.ts
if (result.error?.includes("PermissionDenied")) {
  await this.requestHILApproval({
    type: "permission_escalation",
    payload: {
      capabilityId: capability.id,
      currentSet: capability.permissionSet,
      requestedSet: suggestEscalation(result.error),
      reason: result.error,
    },
  });
}
```

## Consequences

### Positives

- **Defense in depth:** Chaque capability a le minimum de permissions nécessaires
- **Audit trail:** Permission set stocké en DB, traçable
- **Automatic inference:** Pas de configuration manuelle pour la plupart des capabilities
- **Gradual trust:** Les capabilities "emergent" démarrent en `minimal`, escaladent si nécessaire
- **Standard Deno:** Utilise les mécanismes natifs, pas de hack custom

### Negatives

- Requiert Deno 2.5+ (prévu Q2 2025)
- Complexité additionnelle dans le flow d'exécution
- Faux positifs possibles (capability bloquée à tort)

### Risks

| Risk                               | Probability | Impact | Mitigation                              |
| ---------------------------------- | ----------- | ------ | --------------------------------------- |
| Deno 2.5 delayed                   | Medium      | High   | Implement fallback with explicit flags  |
| Over-restriction breaks valid code | Medium      | Medium | Start permissive, tighten based on data |
| Permission inference incorrect     | Low         | Medium | Confidence threshold + HIL fallback     |

## Implementation

### Stories Créées (Epic 7)

> **Référence:** Voir `docs/epics.md` - Stories 7.7a, 7.7b, 7.7c

| Story    | Titre                                                                   | Estimation | Prérequis        |
| -------- | ----------------------------------------------------------------------- | ---------- | ---------------- |
| **7.7a** | Permission Inference - Analyse Automatique des Permissions              | 1-2j       | Story 7.2b (SWC) |
| **7.7b** | Sandbox Permission Integration - Exécution avec Permissions Granulaires | 1-2j       | Story 7.7a       |
| **7.7c** | HIL Permission Escalation - Escalade avec Approbation Humaine           | 1-1.5j     | Story 7.7b       |

**Estimation totale:** 3.5-5.5 jours (après Story 7.2b)

**Prerequisites:**

- Story 7.2b (SWC parsing disponible)
- Deno 2.5 release (ou fallback implémenté via 7.7b)

## References

- [Deno 2.5 Release Notes](https://deno.com/blog) (à venir)
- [Deno Permissions Documentation](https://docs.deno.com/runtime/fundamentals/permissions/)
- [ADR-032: Sandbox Worker RPC Bridge](./accepted/ADR-032-sandbox-worker-rpc-bridge.md)
- [OWASP Principle of Least Privilege](https://owasp.org/www-community/Principle_of_Least_Privilege)
- `src/sandbox/` - Current sandbox implementation
- `src/capabilities/` - Capability storage system
