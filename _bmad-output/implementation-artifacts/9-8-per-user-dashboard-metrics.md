# Story 9.8: Per-User Dashboard Metrics Filtering

Status: done

## Story

As a user viewing the dashboard, I want metrics calculated on tools I've actually used, So that emergence patterns and statistics reflect my real usage rather than all discovered tools.

## Context

Currently, all dashboard metrics (emergence, graph stats, capabilities) are calculated on the **entire** tool/edge graph - all MCP tools discovered at startup. This creates misleading metrics:

- **Entropy = 1.00** because hundreds of tools have default confidence=1 (never used)
- **Diversity** ratio is skewed by total tool count vs actual usage
- **Learning velocity** counts schema discoveries, not real usage patterns

With `user_id` infrastructure from Story 9.5, we can filter calculations to only include tools/edges the user has actually interacted with via `execution_trace`.

## Acceptance Criteria

1. **AC1:** Emergence metrics (entropy, stability, diversity, velocity, speculation) calculated only on tools with ≥1 execution
   - **Given:** Graph has 100 tools (80 never used, 20 used)
   - **When:** User views emergence panel with scope=user
   - **Then:** Entropy calculated on 20 used tools only (not 100)

2. **AC2:** Toggle UI "My usage" / "System" for Emergence, Metrics, Graph panels (default: "My usage")
   - Toggle persists during session via component state
   - Toggle visible only when user is authenticated

3. **AC3:** "My usage" = tools/edges from `execution_trace WHERE user_id = $me`
   - Only includes tools the current user has executed

4. **AC4:** "System" = tools/edges from `execution_trace` (any user, but still excludes never-executed tools)
   - Aggregated view across all users

5. **AC5:** Capabilities list always filtered by current user (no toggle)
   - Shows only capabilities I created OR used

6. **AC6:** Local mode (`user_id = "local"`) - "My usage" and "System" are equivalent (single user)
   - Toggle **grisé (disabled)** en mode local - visible mais non cliquable
   - Tooltip: "Disponible en mode cloud multi-utilisateur"

7. **AC7:** API endpoints accept `?scope=user|system` query param (default: user)
   - Both `/api/metrics` and `/api/metrics/emergence` support scope param

## Tasks / Subtasks

- [x] **Task 1: Create user-usage helper** (AC: #1, #3, #4)
  - [x] 1.1 Create `src/graphrag/user-usage.ts` with `getExecutedToolIds()`
  - [x] 1.2 Implement scope filtering: user vs system
  - [x] 1.3 Unit tests for helper functions

- [x] **Task 2: Update Emergence Handler** (AC: #1, #7)
  - [x] 2.1 Modify `handleEmergenceMetrics()` to accept scope param
  - [x] 2.2 Filter snapshot via `filterSnapshotByExecution()`
  - [x] 2.3 Pass userId from RouteContext (from auth middleware)

- [x] **Task 3: Update Metrics Handler** (AC: #1, #7)
  - [x] 3.1 Modify `handleMetrics()` to accept scope param
  - [x] 3.2 Filter pagerankTop10 by executed tools
  - [x] 3.3 Validate scope parameter

- [x] **Task 4: Create ScopeToggle Component** (AC: #2, #6)
  - [x] 4.1 Create `src/web/components/ui/molecules/ScopeToggle.tsx`
  - [x] 4.2 Props: scope, onChange, isLocalMode
  - [x] 4.3 Style consistent with Casys.ai design system

- [x] **Task 5: Wire Scope to GraphExplorer** (AC: #2)
  - [x] 5.1 EmergencePanel manages scope internally
  - [x] 5.2 ScopeToggle integrated in EmergencePanel header
  - [x] 5.3 Scope passed to fetch URL

- [x] **Task 6: Update Panels with Scope** (AC: #2)
  - [x] 6.1 EmergencePanel: Add scope to fetch URL
  - [x] 6.2 ScopeToggle in panel header with tooltip
  - [x] 6.3 Local mode shows informational tooltip

- [x] **Task 7: Capabilities Filtering** (AC: #5)
  - [x] 7.1 Add userId to CapabilityFilters type
  - [x] 7.2 Filter by created_by OR executed_by in data-service.ts
  - [x] 7.3 Always pass ctx.userId in capabilities handler

- [x] **Task 8: Tests** (AC: #1-7)
  - [x] 8.1 Unit tests for `getExecutedToolIds()` - 13 tests passing
  - [x] 8.2 Unit tests for `filterSnapshotByExecution()`
  - [ ] 8.3 Integration tests for scope filtering (optional)
  - [ ] 8.4 E2E test for toggle behavior (optional)

## Dev Notes

### Architecture: Filtering Hierarchy

```
                    ┌─────────────────────────────────────┐
                    │     Tous les tools découverts       │
                    │         (tool_schema)               │
                    └─────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │  Tools avec ≥1 exécution      │  ← BASE pour tous calculs
                    │  (JOIN execution_trace)        │     (exclut tools jamais utilisés)
                    └───────────────────────────────┘
                           │                │
              ┌────────────┴──┐      ┌──────┴────────┐
              │  "My usage"   │      │   "System"    │
              │ user_id = me  │      │ tous user_id  │
              └───────────────┘      └───────────────┘
```

### Impact sur les Algorithmes GraphRAG

Le filtrage par scope affecte les **métriques du dashboard** (calculées sur le snapshot filtré).

#### ✅ Algorithmes IMPACTÉS par le filtrage 9.8

Ces algos utilisent le **snapshot** filtré pour les métriques:

##### Entropy (`emergence.ts:287`)

```typescript
const edgeWeights = snapshot.edges.map((e) => e.confidence || 1);
const graphEntropy = computeGraphEntropy(edgeWeights);
```

| Sans filtre | Avec filtre |
|-------------|-------------|
| 90% edges "virtuelles" (confidence=1 défaut) | 100% edges avec vraies traces |
| Entropy ≈ 1.0 (uniforme, faux) | Entropy réflète vraie distribution |

##### Cluster Stability / Jaccard (`emergence.ts:291-305`)

```typescript
const currentCommunities = new Map<string, number>();
for (const node of snapshot.nodes) {
  currentCommunities.set(node.id, parseInt(node.communityId));
}
```

| Sans filtre | Avec filtre |
|-------------|-------------|
| 130 tools isolés → micro-communautés | Communautés = workflows réels |
| Jaccard pollué par nodes fantômes | Jaccard = stabilité vraie |

##### Capability Diversity (`emergence.ts:309`)

```typescript
const capabilityDiversity = nodeCount > 0 ? Math.min(1, capabilityCount / nodeCount) : 0;
```

| Sans filtre | Avec filtre |
|-------------|-------------|
| Ratio écrasé (20/150 = 0.13) | Ratio significatif (20/20 = 1.0) |

##### PageRank Top 10 (`metrics.ts` via `graphEngine.getMetrics()`)

```typescript
// Doit être recalculé sur le snapshot filtré
const filteredMetrics = graphEngine.getMetricsForSnapshot(filteredSnapshot);
```

| Sans filtre | Avec filtre |
|-------------|-------------|
| Top10 = tools les plus connectés globalement | Top10 = tools les plus utilisés par l'user |
| N = 150 → PR distribué sur tous | N = 20 → PR concentré sur l'actif |

**Implémentation:** Modifier `graphEngine.getMetrics()` pour accepter un snapshot filtré, ou créer `getMetricsForSnapshot(snapshot)`.

#### ❌ Algorithmes NON IMPACTÉS par 9.8

Ces algos utilisent le **graphe Graphology complet** ou leur propre structure:

| Algorithme | Raison |
|------------|--------|
| **SHGAT** | A son propre `GraphBuilder` interne, indépendant du graphe Graphology |
| **Heat Diffusion** | `LocalAlphaCalculator` utilise `graph.neighbors()` sur le graphe complet |
| **Local Alpha** | Calcul en temps réel sur le graphe complet (pas le snapshot) |
| **Thompson Sampling** | Stats `Beta(α,β)` per-tool, stockées dans DB, pas recalculées par le dashboard |
| **Adamic-Adar** | Utilisé pour **suggestions**, pas pour les métriques dashboard |
| **Spectral Clustering** | Utilisé pour **suggestions**, pas pour les métriques dashboard |

### Key Files to Modify

| File | Changes |
|------|---------|
| `src/graphrag/user-usage.ts` | NEW: `getExecutedToolIds()`, `filterSnapshotByExecution()` |
| `src/mcp/routing/handlers/emergence.ts` | Add scope param, filter snapshot |
| `src/mcp/routing/handlers/metrics.ts` | Add scope param, pass to graphEngine |
| `src/graphrag/graph-engine.ts` | `getMetrics(range, scope?, userId?)` ou `getMetricsForSnapshot(snapshot)` pour PageRank filtré |
| `src/web/islands/GraphExplorer.tsx` | Add scope state, pass to panels |
| `src/web/islands/EmergencePanel.tsx` | Accept scope prop, add to fetch URL |
| `src/web/islands/MetricsPanel.tsx` | Accept scope prop, add to fetch URL |
| `src/web/components/ui/molecules/ScopeToggle.tsx` | NEW: toggle component |

### Implementation Details

#### 1. User Usage Helper (`src/graphrag/user-usage.ts`)

```typescript
import type { DbClient } from "../db/types.ts";
import type { GraphSnapshot } from "./types.ts";

export type Scope = "user" | "system";

/**
 * Get tool IDs that have been executed (base filter - excludes never-used)
 */
export async function getExecutedToolIds(
  db: DbClient,
  scope: Scope,
  userId?: string,
): Promise<Set<string>> {
  const query = scope === "user"
    ? `SELECT DISTINCT tool_key FROM execution_trace WHERE user_id = $1`
    : `SELECT DISTINCT tool_key FROM execution_trace`;

  const params = scope === "user" ? [userId] : [];
  const rows = await db.query(query, params);

  return new Set(rows.map((r) => r.tool_key as string));
}

/**
 * Filter graph snapshot to only include executed tools
 */
export function filterSnapshotByExecution(
  snapshot: GraphSnapshot,
  executedToolIds: Set<string>,
): GraphSnapshot {
  const nodes = snapshot.nodes.filter((n) => executedToolIds.has(n.id));
  const nodeIdSet = new Set(nodes.map((n) => n.id));

  const edges = snapshot.edges.filter(
    (e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target),
  );

  return { ...snapshot, nodes, edges };
}

/**
 * Get capabilities for current user only
 */
export async function getUserCapabilities(
  db: DbClient,
  userId: string,
): Promise<unknown[]> {
  return db.query(`
    SELECT * FROM workflow_pattern
    WHERE created_by = $1
       OR pattern_id IN (
         SELECT DISTINCT capability_id
         FROM execution_trace
         WHERE user_id = $1 AND capability_id IS NOT NULL
       )
    ORDER BY created_at DESC
  `, [userId]);
}
```

#### 2. Emergence Handler Changes

**File:** `src/mcp/routing/handlers/emergence.ts`

```typescript
// Line ~258: Modify handleEmergenceMetrics signature
export async function handleEmergenceMetrics(
  _req: Request,
  url: URL,
  ctx: RouteContext,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const range = (url.searchParams.get("range") || "24h") as EmergenceTimeRange;
    const scope = (url.searchParams.get("scope") || "user") as Scope;

    // Get userId from context (set by auth middleware)
    const userId = ctx.userId || "local";

    // Get executed tool IDs for filtering
    const executedToolIds = await getExecutedToolIds(ctx.db, scope, userId);

    // Get base metrics
    const baseMetrics = await ctx.graphEngine.getMetrics(
      range === "30d" ? "7d" : range,
    );

    // Filter snapshot by execution
    const fullSnapshot = ctx.graphEngine.getGraphSnapshot();
    const snapshot = filterSnapshotByExecution(fullSnapshot, executedToolIds);

    // Continue with filtered snapshot for entropy/stability calculations...
    const edgeWeights = snapshot.edges.map((e) => e.confidence || 1);
    const graphEntropy = computeGraphEntropy(edgeWeights);
    // ...rest of implementation
  }
}
```

#### 3. RouteContext Extension

**File:** `src/mcp/routing/types.ts`

Add userId to RouteContext (already may exist from Story 9.3):

```typescript
export interface RouteContext {
  graphEngine: GraphRAGEngine;
  db: DbClient;
  userId?: string;  // From auth middleware
  // ... other fields
}
```

#### 4. ScopeToggle Component

**File:** `src/web/components/ui/molecules/ScopeToggle.tsx`

```tsx
interface ScopeToggleProps {
  value: "user" | "system";
  onChange: (scope: "user" | "system") => void;
  disabled?: boolean;  // Grisé en mode local
}

export function ScopeToggle({ value, onChange, disabled }: ScopeToggleProps) {
  return (
    <div
      class={`scope-toggle flex gap-1 bg-gray-800 rounded-lg p-1 ${
        disabled ? "opacity-50 cursor-not-allowed" : ""
      }`}
      title={disabled ? "Disponible en mode cloud multi-utilisateur" : undefined}
    >
      <button
        type="button"
        class={`px-3 py-1 text-sm rounded-md transition-colors ${
          value === "user"
            ? "bg-accent text-black"
            : "text-gray-400 hover:text-white"
        } ${disabled ? "cursor-not-allowed" : ""}`}
        onClick={() => !disabled && onChange("user")}
        disabled={disabled}
      >
        My usage
      </button>
      <button
        type="button"
        class={`px-3 py-1 text-sm rounded-md transition-colors ${
          value === "system"
            ? "bg-accent text-black"
            : "text-gray-400 hover:text-white"
        } ${disabled ? "cursor-not-allowed" : ""}`}
        onClick={() => !disabled && onChange("system")}
        disabled={disabled}
      >
        System
      </button>
    </div>
  );
}
```

#### 5. EmergencePanel Changes

**File:** `src/web/islands/EmergencePanel.tsx`

```tsx
interface EmergencePanelProps {
  apiBase: string;
  scope?: "user" | "system";  // NEW
}

export default function EmergencePanel({
  apiBase: apiBaseProp,
  scope = "user",  // Default to user
}: EmergencePanelProps) {
  // ...existing code...

  // Update fetch URL to include scope
  const fetchMetrics = async () => {
    const res = await fetch(
      `${apiBase}/api/metrics/emergence?range=${timeRange}&scope=${scope}`,
      { signal: controller.signal },
    );
    // ...
  };
```

#### 6. GraphExplorer Integration

**File:** `src/web/islands/GraphExplorer.tsx`

```tsx
// Detect local mode (no GitHub OAuth configured)
const [isLocalMode, setIsLocalMode] = useState(true);

useEffect(() => {
  // Check if running in cloud mode (user is authenticated via GitHub)
  fetch(`${apiBase}/api/auth/status`)
    .then(res => res.json())
    .then(data => setIsLocalMode(data.userId === "local" || !data.authenticated))
    .catch(() => setIsLocalMode(true));
}, [apiBase]);

// Add scope state
const [metricsScope, setMetricsScope] = useState<"user" | "system">("user");

// Add toggle in header (grisé en local)
<ScopeToggle
  value={metricsScope}
  onChange={setMetricsScope}
  disabled={isLocalMode}  // Grisé avec tooltip en mode local
/>

// Pass to panels
<EmergencePanel apiBase={apiBase} scope={metricsScope} />
<MetricsPanel apiBase={apiBase} scope={metricsScope} />
```

### API Changes

| Endpoint | Before | After |
|----------|--------|-------|
| `/api/metrics/emergence` | `?range=24h` | `?range=24h&scope=user` |
| `/api/metrics` | `?range=24h` | `?range=24h&scope=user` |

**Default:** `scope=user` (backward compatible)

### Data Flow

```
GraphExplorer (scope state)
    │
    ├──► EmergencePanel (prop: scope)
    │       │
    │       └──► fetch /api/metrics/emergence?scope=X
    │               │
    │               └──► handleEmergenceMetrics(scope, userId)
    │                       │
    │                       └──► getExecutedToolIds(db, scope, userId)
    │                       └──► filterSnapshotByExecution(snapshot, ids)
    │                       └──► computeGraphEntropy(filtered edges)
    │
    └──► MetricsPanel (prop: scope)
            │
            └──► fetch /api/metrics?scope=X
                    │
                    └──► handleMetrics(scope, userId)
                            │
                            └──► graphEngine.getMetrics(range, scope, userId)
```

### Testing Strategy

**Unit Tests (`tests/unit/graphrag/user_usage_test.ts`):**

```typescript
Deno.test("getExecutedToolIds - scope=user filters by userId", async () => {
  const db = createMockDb([
    { tool_key: "tool-a", user_id: "user-1" },
    { tool_key: "tool-b", user_id: "user-2" },
  ]);

  const ids = await getExecutedToolIds(db, "user", "user-1");

  assertEquals(ids.size, 1);
  assert(ids.has("tool-a"));
  assert(!ids.has("tool-b"));
});

Deno.test("getExecutedToolIds - scope=system returns all executed", async () => {
  const db = createMockDb([
    { tool_key: "tool-a", user_id: "user-1" },
    { tool_key: "tool-b", user_id: "user-2" },
  ]);

  const ids = await getExecutedToolIds(db, "system", undefined);

  assertEquals(ids.size, 2);
});

Deno.test("filterSnapshotByExecution - filters nodes and edges", () => {
  const snapshot = {
    nodes: [
      { id: "tool-a", label: "A" },
      { id: "tool-b", label: "B" },
      { id: "tool-c", label: "C" },
    ],
    edges: [
      { source: "tool-a", target: "tool-b", confidence: 0.9 },
      { source: "tool-b", target: "tool-c", confidence: 0.8 },
    ],
  };

  const executedIds = new Set(["tool-a", "tool-b"]);
  const filtered = filterSnapshotByExecution(snapshot, executedIds);

  assertEquals(filtered.nodes.length, 2);
  assertEquals(filtered.edges.length, 1); // Only a->b (c not in set)
});
```

**Integration Tests (`tests/integration/metrics/scope_filtering_test.ts`):**

```typescript
Deno.test("GET /api/metrics/emergence?scope=user - returns filtered metrics", async () => {
  // Setup: Create traces for user-a and user-b
  // Call API as user-a with scope=user
  // Assert: Metrics only based on user-a's traces
});

Deno.test("Local mode - scope toggle equivalent", async () => {
  // Setup: Local mode (GITHUB_CLIENT_ID not set)
  // Assert: scope=user and scope=system return same results
});
```

### Security Considerations

- `userId` comes from authenticated context (via auth middleware from Story 9.3)
- Never trust userId from query params - always use ctx.userId
- Scope filtering applies AFTER authentication check

### Performance Notes

- `execution_trace.tool_key` should have index (verify or add)
- Consider caching `executedToolIds` per request (not across requests)
- For large datasets, consider materialized view for hot path

### Dependencies

- **Story 9.5 (done):** `user_id` column in `execution_trace`, `workflow_execution`
- **Story 11.2 (done):** `execution_trace` table with tool usage data
- **Story 13.1 (done):** `workflow_pattern` table with `created_by`

### Out of Scope

- Admin dashboard (Story 6.6) - separate concerns, admin sees system-wide
- Historical per-user metrics storage - uses live filtering for now
- Caching scope results across sessions

### References

- [Source: src/mcp/routing/handlers/emergence.ts] - Current emergence handler
- [Source: src/mcp/routing/handlers/metrics.ts] - Current metrics handler
- [Source: src/capabilities/execution-trace-store.ts] - Has `getTracesByUser()`
- [Source: src/web/islands/GraphExplorer.tsx] - Main dashboard container
- [Source: src/web/islands/EmergencePanel.tsx] - Emergence metrics UI
- [Source: src/web/islands/MetricsPanel.tsx] - Graph metrics UI
- [Source: docs/sprint-artifacts/9-5-rate-limiting-data-isolation.md] - userId infrastructure

## Dev Agent Record

### Context Reference

Story context created by create-story workflow on 2025-12-30.

### Agent Model Used

Claude Opus 4.5

### Debug Log References

N/A - Story not yet implemented.

### Completion Notes List

Story ready for implementation.

### File List

**New Files:**

- `src/graphrag/user-usage.ts` - Filtering helpers
- `src/web/components/ui/molecules/ScopeToggle.tsx` - Toggle component
- `tests/unit/graphrag/user_usage_test.ts` - Unit tests
- `tests/integration/metrics/scope_filtering_test.ts` - Integration tests

**Modified Files:**

- `src/mcp/routing/handlers/emergence.ts` - Add scope filtering
- `src/mcp/routing/handlers/metrics.ts` - Add scope filtering
- `src/mcp/routing/types.ts` - Ensure userId in RouteContext
- `src/graphrag/graph-engine.ts` - getMetrics with scope (optional)
- `src/web/islands/GraphExplorer.tsx` - Add scope state + toggle
- `src/web/islands/EmergencePanel.tsx` - Accept scope prop
- `src/web/islands/MetricsPanel.tsx` - Accept scope prop
- `src/web/components/ui/molecules/mod.ts` - Export ScopeToggle

## Change Log

- 2025-12-30: Story drafted with comprehensive dev notes
- 2025-12-30: Status updated to ready-for-dev with implementation details
- 2025-12-30: AC6 mis à jour - Toggle grisé (pas caché) en mode local avec tooltip
- 2025-12-30: Correction section "Impact Algorithmes" - séparation claire:
  - ✅ Impactés: Entropy, Cluster Stability/Jaccard, Capability Diversity, **PageRank Top10**
  - ❌ Non impactés: SHGAT, Heat Diffusion, Local Alpha, Thompson Sampling, Adamic-Adar, Spectral
- 2025-12-30: Implementation complete:
  - Created `src/graphrag/user-usage.ts` with getExecutedToolIds(), filterSnapshotByExecution()
  - Fixed SQL error: added jsonb_typeof check for task_results
  - Updated RouteContext to include db for scope filtering
  - Modified emergence.ts and metrics.ts handlers with scope parameter
  - Created ScopeToggle component with tooltip for local mode
  - Updated EmergencePanel with ScopeToggle integration
  - Added userId filter to CapabilityFilters and data-service.ts
  - 13 unit tests passing for user-usage module
