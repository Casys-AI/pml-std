# ADR-037: Deno KV as Cache Layer

**Status:** ❌ Rejected **Date:** 2025-12-05 | **Deciders:** Architecture Team

## Rejection Reason

**Overkill pour notre cas d'usage:**

- PGlite gère déjà la persistence des données importantes
- Les caches in-memory actuels suffisent (pas besoin de persistence cache)
- Ajoute une couche de complexité sans bénéfice clair
- Les restarts sont rares, reconstruire le cache n'est pas coûteux

Ce ADR est conservé comme référence si le besoin évolue (ex: scaling horizontal, session state
distribué).

---

## Context

Casys PML utilise plusieurs mécanismes de cache custom:

| Fichier                                   | Type          | Persistence | TTL       |
| ----------------------------------------- | ------------- | ----------- | --------- |
| `src/sandbox/cache.ts`                    | In-memory Map | ❌ Non      | ✅ Manual |
| `src/context/cache.ts`                    | In-memory Map | ❌ Non      | ✅ Manual |
| `src/speculation/speculative-executor.ts` | In-memory Map | ❌ Non      | ✅ Manual |
| `src/mcp/adaptive-threshold.ts`           | In-memory     | ❌ Non      | ❌ Non    |

**Problèmes actuels:**

1. **Perte au restart:** Tous les caches sont perdus quand le serveur redémarre
2. **Duplication de code:** Chaque module implémente sa propre logique de cache
3. **TTL manuel:** Gestion expiration à la main avec `Date.now()` checks
4. **Pas de limite mémoire:** Les caches peuvent grandir indéfiniment

**Storage principal:**

- PGlite avec pgvector pour les données persistantes et la recherche vectorielle
- Les caches sont complémentaires, pas un remplacement

**Opportunité:** `Deno.openKv()` offre un key-value store natif avec:

- Persistence automatique (SQLite backend)
- TTL natif via `expireIn`
- API simple et typée
- Zero configuration

## Decision

Introduire Deno KV comme layer de cache unifié, complémentaire à PGlite.

### Deno KV API

```typescript
// Ouverture (path optionnel, default = .deno-kv)
const kv = await Deno.openKv();
// Ou avec chemin custom
const kv = await Deno.openKv("./data/cache.db");

// Set avec TTL (expire dans 1 heure)
await kv.set(["cache", "capability", hash], capability, { expireIn: 3600_000 });

// Get
const result = await kv.get<Capability>(["cache", "capability", hash]);
if (result.value) {
  console.log("Cache hit:", result.value);
}

// Delete
await kv.delete(["cache", "capability", hash]);

// List par préfixe
const entries = kv.list<CacheEntry>({ prefix: ["cache", "capability"] });
for await (const entry of entries) {
  console.log(entry.key, entry.value);
}

// Atomic operations
await kv.atomic()
  .set(["counter"], 0)
  .set(["last_update"], Date.now())
  .commit();
```

### Architecture: PGlite + Deno KV

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Application Layer                            │
└─────────────────────────────────────────────────────────────────────┘
                    │                           │
                    ▼                           ▼
┌─────────────────────────────────┐  ┌─────────────────────────────────┐
│          Deno KV                 │  │          PGlite                  │
│     (Cache Layer - Fast)         │  │    (Primary Storage)             │
├─────────────────────────────────┤  ├─────────────────────────────────┤
│ • Execution result cache         │  │ • Capabilities (workflow_pattern)│
│ • Rate limiting counters         │  │ • Tool schemas                   │
│ • Session state                  │  │ • Episodic memory                │
│ • Frequent capability lookups    │  │ • Graph edges                    │
│ • MCP schema cache               │  │ • Vector embeddings (pgvector)   │
│                                  │  │                                  │
│ TTL: minutes to hours            │  │ Permanent storage                │
│ Size: Small (< 1MB values)       │  │ Size: Unlimited                  │
└─────────────────────────────────┘  └─────────────────────────────────┘
         │                                      │
         │ SQLite (auto)                        │ PGlite file
         ▼                                      ▼
    ./data/cache.db                      ./data/pml.db
```

### Use Cases

#### 1. Execution Result Cache (Replace `src/sandbox/cache.ts`)

```typescript
// src/cache/execution-cache.ts
import { getKV } from "./kv.ts";

interface ExecutionCacheEntry {
  result: unknown;
  toolsUsed: string[];
  durationMs: number;
  cachedAt: number;
}

export class ExecutionCache {
  private kv: Deno.Kv;
  private readonly TTL_MS = 30 * 60 * 1000; // 30 minutes

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  async get(codeHash: string): Promise<ExecutionCacheEntry | null> {
    const result = await this.kv.get<ExecutionCacheEntry>(["exec", codeHash]);
    return result.value;
  }

  async set(codeHash: string, entry: ExecutionCacheEntry): Promise<void> {
    await this.kv.set(["exec", codeHash], entry, { expireIn: this.TTL_MS });
  }

  async invalidate(codeHash: string): Promise<void> {
    await this.kv.delete(["exec", codeHash]);
  }

  async invalidateAll(): Promise<void> {
    const entries = this.kv.list({ prefix: ["exec"] });
    for await (const entry of entries) {
      await this.kv.delete(entry.key);
    }
  }
}
```

#### 2. Rate Limiting (Replace `src/utils/rate-limiter.ts`)

```typescript
// src/cache/rate-limiter.ts
export class KVRateLimiter {
  private kv: Deno.Kv;
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(kv: Deno.Kv, windowMs = 60_000, maxRequests = 100) {
    this.kv = kv;
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  async isAllowed(key: string): Promise<boolean> {
    const kvKey = ["rate", key];
    const result = await this.kv.get<number>(kvKey);
    const current = result.value ?? 0;

    if (current >= this.maxRequests) {
      return false;
    }

    // Atomic increment with TTL
    await this.kv.atomic()
      .check(result) // Optimistic locking
      .set(kvKey, current + 1, { expireIn: this.windowMs })
      .commit();

    return true;
  }

  async getRemaining(key: string): Promise<number> {
    const result = await this.kv.get<number>(["rate", key]);
    return this.maxRequests - (result.value ?? 0);
  }
}
```

#### 3. Capability Lookup Cache (Hot cache for frequent lookups)

```typescript
// src/cache/capability-cache.ts
export class CapabilityCache {
  private kv: Deno.Kv;
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  async getByHash(codeHash: string): Promise<Capability | null> {
    // Try cache first
    const cached = await this.kv.get<Capability>(["cap", "hash", codeHash]);
    if (cached.value) {
      return cached.value;
    }
    return null;
  }

  async cacheCapability(capability: Capability): Promise<void> {
    await this.kv.set(
      ["cap", "hash", capability.codeHash],
      capability,
      { expireIn: this.TTL_MS },
    );
  }

  // Cache invalidation when capability is updated
  async invalidate(codeHash: string): Promise<void> {
    await this.kv.delete(["cap", "hash", codeHash]);
  }
}
```

#### 4. MCP Schema Cache (Avoid re-extracting schemas)

```typescript
// src/cache/schema-cache.ts
export class SchemaCache {
  private kv: Deno.Kv;
  private readonly TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  async getToolSchema(serverId: string, toolId: string): Promise<JSONSchema | null> {
    const cached = await this.kv.get<JSONSchema>(["schema", serverId, toolId]);
    return cached.value;
  }

  async cacheToolSchema(serverId: string, toolId: string, schema: JSONSchema): Promise<void> {
    await this.kv.set(
      ["schema", serverId, toolId],
      schema,
      { expireIn: this.TTL_MS },
    );
  }
}
```

#### 5. Session State (For stateful workflows)

```typescript
// src/cache/session-cache.ts
interface SessionState {
  workflowId: string;
  currentLayer: number;
  completedTasks: string[];
  variables: Record<string, unknown>;
  lastActivity: number;
}

export class SessionCache {
  private kv: Deno.Kv;
  private readonly TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  async getSession(sessionId: string): Promise<SessionState | null> {
    const result = await this.kv.get<SessionState>(["session", sessionId]);
    return result.value;
  }

  async saveSession(sessionId: string, state: SessionState): Promise<void> {
    await this.kv.set(["session", sessionId], state, { expireIn: this.TTL_MS });
  }

  async touchSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      await this.saveSession(sessionId, session);
    }
  }
}
```

### KV Singleton

```typescript
// src/cache/kv.ts
let kvInstance: Deno.Kv | null = null;

export async function getKV(): Promise<Deno.Kv> {
  if (!kvInstance) {
    const dbPath = Deno.env.get("CAI_CACHE_PATH") ?? "./data/cache.db";
    kvInstance = await Deno.openKv(dbPath);
  }
  return kvInstance;
}

export async function closeKV(): Promise<void> {
  if (kvInstance) {
    kvInstance.close();
    kvInstance = null;
  }
}
```

### Cache Hierarchy

```typescript
// src/cache/cache-manager.ts
import { getKV } from "./kv.ts";
import { ExecutionCache } from "./execution-cache.ts";
import { CapabilityCache } from "./capability-cache.ts";
import { SchemaCache } from "./schema-cache.ts";
import { SessionCache } from "./session-cache.ts";
import { KVRateLimiter } from "./rate-limiter.ts";

export class CacheManager {
  public execution: ExecutionCache;
  public capability: CapabilityCache;
  public schema: SchemaCache;
  public session: SessionCache;
  public rateLimiter: KVRateLimiter;

  private constructor(kv: Deno.Kv) {
    this.execution = new ExecutionCache(kv);
    this.capability = new CapabilityCache(kv);
    this.schema = new SchemaCache(kv);
    this.session = new SessionCache(kv);
    this.rateLimiter = new KVRateLimiter(kv);
  }

  static async create(): Promise<CacheManager> {
    const kv = await getKV();
    return new CacheManager(kv);
  }

  async clearAll(): Promise<void> {
    const kv = await getKV();
    const entries = kv.list({ prefix: [] });
    for await (const entry of entries) {
      await kv.delete(entry.key);
    }
  }
}

// Usage
const cache = await CacheManager.create();
const result = await cache.execution.get(codeHash);
```

### Monitoring & Metrics

```typescript
// src/cache/cache-metrics.ts
import { getKV } from "./kv.ts";

export async function getCacheStats(): Promise<CacheStats> {
  const kv = await getKV();
  const stats: CacheStats = {
    execution: 0,
    capability: 0,
    schema: 0,
    session: 0,
    rate: 0,
  };

  // Count entries by prefix
  for await (const entry of kv.list({ prefix: ["exec"] })) {
    stats.execution++;
  }
  for await (const entry of kv.list({ prefix: ["cap"] })) {
    stats.capability++;
  }
  // ... etc

  return stats;
}

interface CacheStats {
  execution: number;
  capability: number;
  schema: number;
  session: number;
  rate: number;
}
```

## Consequences

### Positives

- **Persistence:** Cache survit aux restarts
- **TTL natif:** `expireIn` gère l'expiration automatiquement
- **Zero config:** Pas de Redis/Memcached à déployer
- **Type-safe:** API TypeScript native
- **Atomic ops:** Transactions pour les opérations critiques
- **Unified API:** Un seul pattern pour tous les caches

### Negatives

- **Dépendance Deno:** Pas portable vers Node.js
- **Pas de clustering:** Chaque instance a son propre KV
- **Disk I/O:** Plus lent qu'un cache purement in-memory
- **Size limits:** Values < 64KB recommandé

### Trade-offs vs Alternatives

| Feature         | Deno KV   | Redis         | In-Memory Map |
| --------------- | --------- | ------------- | ------------- |
| **Setup**       | Zero      | Server needed | Zero          |
| **Persistence** | ✅ Yes    | ✅ Yes        | ❌ No         |
| **TTL**         | ✅ Native | ✅ Native     | ❌ Manual     |
| **Clustering**  | ❌ No     | ✅ Yes        | ❌ No         |
| **Performance** | Fast      | Fastest       | Fastest       |
| **Deno Native** | ✅ Yes    | ❌ No         | ✅ Yes        |

### When to Use What

| Use Case               | Storage           |
| ---------------------- | ----------------- |
| Vector search          | PGlite (pgvector) |
| Relational data        | PGlite            |
| Permanent capabilities | PGlite            |
| Execution result cache | Deno KV           |
| Rate limiting          | Deno KV           |
| Session state          | Deno KV           |
| Schema cache           | Deno KV           |

## Implementation

### Story Proposée

**Story: Unified Cache Layer with Deno KV**

1. Créer `src/cache/kv.ts` - singleton KV
2. Créer `src/cache/execution-cache.ts` - remplace `src/sandbox/cache.ts`
3. Créer `src/cache/rate-limiter.ts` - remplace `src/utils/rate-limiter.ts`
4. Créer `src/cache/capability-cache.ts` - hot cache pour lookups
5. Créer `src/cache/schema-cache.ts` - cache MCP schemas
6. Créer `src/cache/cache-manager.ts` - façade unifiée
7. Créer `src/cache/cache-metrics.ts` - monitoring
8. Migration: Remplacer les anciens caches par le nouveau
9. Tests: persistence across restart, TTL expiration, atomic ops

**Estimation:** 2-3 jours

**Prerequisites:** None (API native Deno stable)

## References

- [Deno KV Documentation](https://docs.deno.com/deploy/kv/manual/)
- [Deno KV API Reference](https://deno.land/api?s=Deno.Kv)
- `src/sandbox/cache.ts` - Current execution cache
- `src/context/cache.ts` - Current context cache
- `src/utils/rate-limiter.ts` - Current rate limiter
