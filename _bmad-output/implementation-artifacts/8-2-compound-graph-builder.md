# Story 8.2: Compound Graph Builder

> **Epic:** 8 - Hypergraph Capabilities Visualization **ADRs:** ADR-029 (Hypergraph Capabilities
> Visualization) **Prerequisites:** Story 8.1 (Capability Data API - DONE), Epic 6 (D3.js Dashboard
> infrastructure) **Status:** Done

## User Story

As a system architect, I want a HypergraphBuilder class that converts capabilities to D3.js graph
nodes with hyperedge support, So that the visualization can represent N-ary relationships correctly.

## Problem Context

### Current State (After Story 8.1)

Le systeme dispose de:

1. **CapabilityDataService** (`src/capabilities/data-service.ts`) - Story 8.1 DONE:
   - `listCapabilities(filters)` - Query capabilities with filters
   - `buildHypergraphData(options)` - Returns D3.js-ready nodes/edges
   - BUT: Logic is embedded in data-service.ts (~150 LOC in buildHypergraphData)

2. **D3GraphVisualization** (`src/web/islands/D3GraphVisualization.tsx`) - Epic 6:
   - Force-directed graph avec d3-force
   - Loads data from `/api/graph/snapshot` (tools only)
   - Does NOT support capability compound nodes or hypergraph mode

3. **Types** (`src/capabilities/types.ts`):
   - `CapabilityNode`, `ToolNode` - Node types defined
   - `CapabilityEdge`, `HierarchicalEdge` - Edge types defined
   - `GraphNode`, `GraphEdge` - Union types pour D3.js

### Gap Analysis

| Feature                     | Existe? | Location                         |
| --------------------------- | ------- | -------------------------------- |
| Capability node structure   | Oui     | `types.ts`                       |
| Tool node structure         | Oui     | `types.ts`                       |
| Hierarchical edges          | Oui     | `types.ts`                       |
| API `/api/graph/hypergraph` | Oui     | `gateway-server.ts`              |
| HypergraphBuilder class     | Non     | **A extraire/creer (Story 8.2)** |
| Shared tool handling        | Partiel | Needs refinement                 |

### Impact

Le buildHypergraphData() actuel dans data-service.ts:

- Mélange data fetching et graph building
- Crée des duplicate tool nodes quand un tool est dans plusieurs capabilities
- Ne gère pas correctement les hyperedges (tool → multiple capabilities)

Story 8.2 doit:

1. Extraire la logique en HypergraphBuilder class dedicee
2. Implementer le support correct des hyperedges D3.js
3. Gerer les tools partages entre capabilities

---

## Solution: HypergraphBuilder Class

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CapabilityDataService                                          │
│  - listCapabilities(filters) → CapabilityResponseInternal[]     │
│  - buildHypergraphData() → uses HypergraphBuilder               │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  HypergraphBuilder (NEW - Story 8.2)                            │
│  - buildCompoundGraph(capabilities, toolsSnapshot)              │
│  - Handles hyperedges (tool → multiple capabilities)            │
│  - Creates D3.js-ready { nodes, edges }                         │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  D3GraphVisualization (Story 8.3 - Frontend)                    │
│  - Toggle [Tools] [Capabilities] [Hypergraph]                   │
│  - Renders compound graph with d3-force                         │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decision: Hyperedge Handling

**Problem:** Un tool peut appartenir a plusieurs capabilities. Cytoscape compound nodes ne
supportaient qu'un seul parent.

**Solution D3.js:** Utiliser un **array `parents[]`** au lieu d'un single `parent` string.

**Implementation Choice:** **Option C - Multi-Parent Array**

```typescript
// AVANT (Cytoscape limitation - single parent)
{
  data: {
    id: 'filesystem:read',
    parent: 'cap-uuid-1',  // ❌ Only ONE parent allowed!
    type: 'tool'
  }
}

// APRÈS (D3.js freedom - multiple parents)
{
  data: {
    id: 'filesystem:read',
    parents: ['cap-uuid-1', 'cap-uuid-2'],  // ✅ Array = N parents!
    type: 'tool'
  }
}
```

**Avantages:**

- Relation hiérarchique directement dans le node (pas besoin de chercher dans les edges)
- Plus intuitif pour le dev et le debug
- `parents[]` = **source de vérité**, edges = **dérivés** pour D3 force layout
- Un seul tool node par tool (pas de duplication)
- Permet de construire facilement l'hypergraph (N-ary relationships)

### Visualisation: D3 Hull (Zones qui se chevauchent)

**Décision:** Les capabilities sont visualisées comme des **ZONES** (pas des simples noeuds), en
utilisant **D3 Hull** (convex hull).

```
┌────────────────────────┐
│     Capability 1       │
│   ┌────────────────────┼───────────────┐
│   │                    │               │
│   │  ○ tool-A          │   ○ tool-C    │  Capability 2
│   │  ○ tool-B          │               │
│   │         ○ tool-shared              │
│   │        (zone overlap)              │
└───┼────────────────────┘               │
    │                    ○ tool-D        │
    └────────────────────────────────────┘
```

**Pourquoi Hull et pas Voronoi:**

| Critère                          | Hull ✅           | Voronoi ❌                 |
| -------------------------------- | ----------------- | -------------------------- |
| Zones qui se chevauchent         | OUI               | NON (partitionne l'espace) |
| Grouper tools par capability     | OUI               | NON                        |
| Tool dans plusieurs capabilities | Visible (overlap) | Impossible                 |

**Comportement:**

- Chaque capability = une zone (polygone convexe) englobant ses tools
- Un tool avec `parents: ['cap-1', 'cap-2']` est dans les DEUX zones
- Les zones se **chevauchent** là où les tools sont partagés → hyperedge visuel

### Edge Types Clarification

| Edge Type    | Tool → Tool      | Cap → Tool               | Cap → Cap                |
| ------------ | ---------------- | ------------------------ | ------------------------ |
| `sequence`   | ✅ A puis B      | ❌ N/A                   | ✅ Cap A puis Cap B      |
| `dependency` | ✅ A dépend de B | ❌ N/A                   | ✅ Cap A dépend de Cap B |
| `contains`   | ❌ Pas de sens   | ❌ **Remplacé par Hull** | ✅ Cap composite         |

**Important:** L'edge `contains` pour Cap → Tool est **remplacé par les Hull zones**.

- Avant: edge vert "contains" entre capability et tool
- Maintenant: le tool est **visuellement DANS** la zone Hull de la capability
- Pas besoin d'edge explicite pour cette relation parent/child

### Current Code Analysis: Edge Persistence

**État actuel du code (`graph-engine.ts`):**

| Composant                       | Location | Comportement                                  |
| ------------------------------- | -------- | --------------------------------------------- |
| `createOrUpdateEdge()`          | :817-886 | Crée edges dans graphology (mémoire)          |
| `persistEdgesToDB()`            | :960-987 | Persiste TOUS edges vers `tool_dependency`    |
| `persistCapabilityDependency()` | :899-950 | Persiste cap→cap vers `capability_dependency` |

**Tables de persistance:**

```sql
-- tool_dependency: stocke tool→tool ET cap→tool edges actuellement!
tool_dependency (
  from_tool_id,    -- peut être un tool ou capability:uuid
  to_tool_id,      -- peut être un tool ou capability:uuid
  edge_type,       -- 'contains', 'sequence', 'dependency'
  edge_source      -- 'template', 'inferred', 'observed'
)

-- capability_dependency: stocke uniquement cap→cap edges
capability_dependency (
  from_capability_id,
  to_capability_id,
  edge_type,
  edge_source
)
```

**Impact Hull Visualization:**

Avec l'approche Hull, les edges **cap→tool "contains"** stockés dans `tool_dependency`:

1. Ne sont plus utiles pour la visualisation (relation = visuelle via Hull)
2. Peuvent être ignorés lors du rendu D3.js
3. Option: les supprimer de `tool_dependency` ou filtrer lors du query

**Décision de migration (FUTURE):**

- Phase 1 (Story 8.2): Ignorer cap→tool edges lors du rendu, utiliser Hull
- Phase 2 (optional): Nettoyer `tool_dependency` des cap→tool edges

---

## Acceptance Criteria

### AC1: HypergraphBuilder Class Created

- [x] Fichier `src/capabilities/hypergraph-builder.ts` cree (~270 LOC)
- [x] Class avec methodes instance-based selon pattern projet
- [x] Export from `src/capabilities/mod.ts`

### AC2: buildCompoundGraph Method Implemented

- [x] Method
      `buildCompoundGraph(capabilities: CapabilityResponseInternal[], toolsSnapshot: GraphSnapshot)`
      → `HypergraphResult`
- [x] Retourne structure D3.js-ready avec nodes et edges
- [x] Accepte GraphSnapshot optionnel pour enrichir tool metadata (pagerank, degree)

### AC3: Capability Node Structure Correct

- [x] Capability node structure:

```javascript
{
  data: {
    id: 'cap-{uuid}',
    type: 'capability',
    label: 'Create Issue from File',
    code_snippet: 'await mcp.github...',
    success_rate: 0.95,
    usage_count: 12,
    tools_count: 3
  }
}
```

### AC4: Tool Node Structure Correct (Multi-Parent Array)

- [x] Tool node structure with `parents[]` array:

```javascript
{
  data: {
    id: 'filesystem:read',
    type: 'tool',
    server: 'filesystem',
    label: 'read',
    pagerank: 0.15,
    degree: 5,
    parents: ['cap-uuid-1', 'cap-uuid-2']  // Array of capability IDs
  }
}
```

- [x] Standalone tools (not in any capability) have `parents: []` (empty array)

### AC5: Hyperedge Support (Tool → Multiple Capabilities)

- [x] Tool nodes created ONCE per unique tool ID (no duplicates)
- [x] `parents[]` array populated with ALL capability IDs that use this tool
- [x] Hierarchical edges ALSO created (derived from parents[]) for D3 force layout
- [x] Edge structure (generated from parents[]):

```javascript
{
  data: {
    id: 'edge-cap-{uuid}-{toolId}',
    source: 'cap-{uuid}',
    target: 'filesystem:read',
    edgeType: 'hierarchy',
    edgeSource: 'observed',
    observedCount: 12
  }
}
```

### AC6: Cross-Capability Edges (Two Sources)

**A. Shared Tools Links (inferred)**

- [x] Edge creation between capabilities that share tools
- [x] sharedTools count calculated correctly

```javascript
{
  data: {
    id: 'edge-cap-{uuid1}-cap-{uuid2}-shared',
    source: 'cap-{uuid1}',
    target: 'cap-{uuid2}',
    sharedTools: 2,
    edgeType: 'capability_link',
    edgeSource: 'inferred'
  }
}
```

**B. Capability Dependencies (from DB)**

- [x] Query `capability_dependency` table for edges between capabilities
- [x] Support edge_type: `contains`, `sequence`, `dependency`
- [x] Support edge_source: `template`, `inferred`, `observed`

```javascript
{
  data: {
    id: 'edge-cap-{uuid1}-cap-{uuid2}-dep',
    source: 'cap-{uuid1}',
    target: 'cap-{uuid2}',
    edgeType: 'sequence',        // or 'contains', 'dependency'
    edgeSource: 'observed',      // or 'template', 'inferred'
    confidence: 0.85,
    observedCount: 5
  }
}
```

### AC7: D3 Hull Zone Data Structure

- [x] HypergraphBuilder generates hull-ready data for each capability zone
- [x] Output includes toolIds for hull calculation (positions are D3-generated)
- [x] Capability zone metadata: color, opacity, label position
- [x] **Hull size adapts dynamically:**
  - Plus de tools → hull plus grand
  - Tools éloignés → hull s'étend pour tous les englober
  - Padding autour des tools (ex: 20px) pour lisibilité
  - Minimum size même pour 1-2 tools (éviter hull trop petit)

```javascript
{
  capabilityZones: [
    {
      id: "cap-uuid-1",
      label: "Create Issue from File",
      color: "#8b5cf6", // violet
      opacity: 0.3, // semi-transparent pour voir overlaps
      toolIds: ["filesystem:read", "github:create_issue"],
      padding: 20, // px around tools
      minRadius: 50, // minimum hull size
      // Tool positions calculated by D3 force, hull drawn around them
    },
  ];
}
```

### AC8: Integration with CapabilityDataService

- [x] `CapabilityDataService.buildHypergraphData()` utilise `HypergraphBuilder`
- [x] Pas de duplication de logique
- [x] Backward compatibility maintenue (API response format unchanged)

### AC9: Update ToolNode Type in types.ts

- [x] Change `parent?: string` to `parents: string[]` in ToolNode interface
- [x] Update existing tests that check `parent` field to use `parents[]`
- [x] Ensure backward compatibility in API response mapping

### AC10: Unit Tests

- [x] Test: verify compound structure correct for single capability
- [x] Test: verify tool deduplication across multiple capabilities (same tool, multiple parents)
- [x] Test: verify `parents[]` array contains ALL capability IDs for shared tools
- [x] Test: verify hierarchical edges created correctly (one per parent)
- [x] Test: verify capability_link edges for shared tools
- [x] Test: empty capabilities array handled gracefully
- [x] Test: capability with 0 tools handled correctly
- [x] Test: standalone tools have `parents: []` (empty array)

---

## Tasks / Subtasks

- [x] **Task 1: Create HypergraphBuilder Class** (AC: #1)
  - [x] 1.1 Create `src/capabilities/hypergraph-builder.ts`
  - [x] 1.2 Define `HypergraphResult` interface (or reuse existing types)
  - [x] 1.3 Export from `src/capabilities/mod.ts`

- [x] **Task 2: Implement buildCompoundGraph Method** (AC: #2, #3, #4)
  - [x] 2.1 Create method signature with proper types
  - [x] 2.2 Generate capability nodes with all required fields
  - [x] 2.3 Generate tool nodes (deduplicated)
  - [x] 2.4 Enrich tool nodes with pagerank/degree from GraphSnapshot

- [x] **Task 3: Implement Hyperedge Logic** (AC: #5, #6)
  - [x] 3.1 Populate `parents[]` array for each tool (accumulate capability IDs)
  - [x] 3.2 Generate hierarchical edges FROM `parents[]` (one edge per parent)
  - [x] 3.3 Create capability_link edges for shared tools
  - [x] 3.4 Calculate sharedTools count from tools appearing in multiple `parents[]`

- [x] **Task 4: Refactor CapabilityDataService** (AC: #8)
  - [x] 4.1 Extract graph building logic from buildHypergraphData()
  - [x] 4.2 Integrate HypergraphBuilder
  - [x] 4.3 Ensure API response format unchanged
  - [x] 4.4 **FIX BUG:** Remove duplicate graphSnapshot fetch - now fetched once and passed to
        builder

- [x] **Task 5: Update Types** (AC: #9)
  - [x] 5.1 Change `parent?: string` to `parents: string[]` in ToolNode interface
        (`src/capabilities/types.ts`)
  - [x] 5.2 Update existing test assertions from `.parent` to `.parents[]`
  - [x] 5.3 Verify API response mapping handles new array field

- [x] **Task 6: Implement Hull Zone Data** (AC: #7)
  - [x] 6.1 Add `capabilityZones[]` to HypergraphResponse
  - [x] 6.2 Generate zone metadata (color, opacity, toolIds)
  - [x] 6.3 Add padding and minRadius config for hull sizing

- [x] **Task 7: Unit Tests** (AC: #10)
  - [x] 7.1 Create `tests/unit/capabilities/hypergraph_builder_test.ts`
  - [x] 7.2 Test single capability graph structure
  - [x] 7.3 Test multi-capability with shared tools (verify `parents[]` has multiple entries)
  - [x] 7.4 Test edge generation from `parents[]`
  - [x] 7.5 Test Hull zone generation (capabilityZones[])
  - [x] 7.6 Test edge cases (empty, no tools, standalone tools)

---

## Dev Notes

### Critical Implementation Details

1. **Tool Deduplication Pattern (Multi-Parent)**

```typescript
// Track tools with their parent capabilities
const toolNodes = new Map<string, ToolNode>();

for (const cap of capabilities) {
  const capId = `cap-${cap.id}`;

  for (const toolId of cap.toolsUsed) {
    if (!toolNodes.has(toolId)) {
      // First occurrence - create node with parents array
      toolNodes.set(toolId, createToolNode(toolId, toolsSnapshot, [capId]));
    } else {
      // Tool already exists - add this capability to parents[]
      const existingNode = toolNodes.get(toolId)!;
      existingNode.data.parents.push(capId);
    }
    // Always create edge for D3 force layout
    edges.push(createHierarchicalEdge(capId, toolId));
  }
}
```

2. **Shared Tools Calculation**

```typescript
// Calculate shared tools between capabilities
const capabilityToolsMap = new Map<string, Set<string>>();

// Build map first
for (const cap of capabilities) {
  capabilityToolsMap.set(`cap-${cap.id}`, new Set(cap.toolsUsed));
}

// Then find intersections
for (let i = 0; i < capIds.length; i++) {
  for (let j = i + 1; j < capIds.length; j++) {
    const tools1 = capabilityToolsMap.get(capIds[i])!;
    const tools2 = capabilityToolsMap.get(capIds[j])!;
    const sharedTools = [...tools1].filter((t) => tools2.has(t)).length;
    if (sharedTools > 0) {
      edges.push(createCapabilityLinkEdge(capIds[i], capIds[j], sharedTools));
    }
  }
}
```

3. **Node ID Convention**

- Capability: `cap-{uuid}` (prefix to avoid collision with tool IDs)
- Tool: `{server}:{tool_name}` (existing convention)
- Edge: `edge-{source}-{target}` (existing convention)

4. **GraphSnapshot Integration**

Le HypergraphBuilder recoit un optional GraphSnapshot pour enrichir les tool nodes:

- pagerank: importance score from GraphRAG
- degree: connection count in tool graph

```typescript
function enrichToolNode(toolId: string, snapshot?: GraphSnapshot): ToolNodeData {
  const snapshotNode = snapshot?.nodes.find((n) => n.id === toolId);
  return {
    id: toolId,
    type: "tool",
    server: toolId.split(":")[0],
    label: toolId.split(":").slice(1).join(":"),
    pagerank: snapshotNode?.pagerank ?? 0,
    degree: snapshotNode?.degree ?? 0,
  };
}
```

### Project Structure Notes

**Files to Create:**

```
src/capabilities/
└── hypergraph-builder.ts  # NEW: HypergraphBuilder class (~120-150 LOC)

tests/unit/capabilities/
└── hypergraph_builder_test.ts  # NEW: Unit tests
```

**Files to Modify:**

```
src/capabilities/
├── mod.ts              # MODIFY: Export HypergraphBuilder
└── data-service.ts     # MODIFY: Use HypergraphBuilder (~-50 LOC refactored)
```

### Existing Code Patterns to Follow

**CapabilityDataService.buildHypergraphData()** (`src/capabilities/data-service.ts:232-414`):

- Current implementation has graph building logic mixed with data fetching
- Extract to HypergraphBuilder, keep data fetching in service
- Pattern: service calls builder, builder returns pure graph data

**Type definitions** (`src/capabilities/types.ts:198-280`):

- `CapabilityNode`, `ToolNode` - Use these interfaces
- `CapabilityEdge`, `HierarchicalEdge` - Edge types
- `GraphNode`, `GraphEdge` - Union types for D3.js

**Test pattern** (`tests/unit/capabilities/data_service_test.ts`):

- Shared DB setup pattern
- Mock capabilities creation
- Structure assertion patterns

### References

- **Current implementation:** `src/capabilities/data-service.ts:232-414` (buildHypergraphData)
- **Types:** `src/capabilities/types.ts` (GraphNode, GraphEdge, etc.)
- **D3 Visualization:** `src/web/islands/D3GraphVisualization.tsx` (consumer of graph data)
- **ADR-029:** `docs/adrs/ADR-029-hypergraph-capabilities-visualization.md`
- **Story 8.1:** `docs/sprint-artifacts/8-1-capability-data-api.md` (predecessor)

---

## Previous Story Intelligence

### From Story 8.1 (Capability Data API) - CRITICAL

**Key Learnings:**

1. **Tool multi-membership issue identified:** Issue #25 documented that Cytoscape compound graphs
   don't support multiple parents. Decision: Use edges instead of parent relationships (implemented
   in Story 8.2)
2. **Performance fix #24:** `getGraphSnapshot()` called once before loops, not N×M times
3. **camelCase→snake_case mapping:** Internal uses camelCase, API boundary converts to snake_case
4. **Community ID filtering:** Migration 015 added community_id column for Louvain clustering

**Code Patterns Established:**

- Shared DB test pattern (following dag_suggester_test.ts)
- Intent preview truncation: SQL-based (97 chars + '...')
- Sort field mapping: internal camelCase → DB snake_case

**Files Created by 8.1:**

- `src/capabilities/data-service.ts` - CapabilityDataService (370 LOC)
- `src/db/migrations/015_capability_community_id.ts` - Migration
- `tests/unit/capabilities/data_service_test.ts` - Unit tests (12 passing)

**Modified by 8.1:**

- `src/capabilities/types.ts` - Added 9 new API response types
- `src/capabilities/mod.ts` - Export CapabilityDataService
- `src/mcp/gateway-server.ts` - Added 2 API routes

### From Epic 6 (D3.js Migration)

**Recent Commits:**

```
c8d52df refactor: migrate visualization from Cytoscape.js to D3.js
dd04aee fix: Correct test paths and D3 migration assertions
```

**Key Changes:**

- Cytoscape.js removed, D3.js force-directed graph implemented
- `D3GraphVisualization.tsx` is the new visualization component
- Type aliases `CytoscapeNode/CytoscapeEdge` kept for backward compat

---

## Git Intelligence

### Recent Commits (relevant patterns):

```
c8d52df refactor: migrate visualization from Cytoscape.js to D3.js
dd04aee fix: Correct test paths and D3 migration assertions
3077189 chore: Rebrand from Casys Intelligence to Casys PML
```

### Learnings:

1. **D3.js is current stack:** All new visualization should use D3.js, not Cytoscape
2. **Type aliases maintained:** CytoscapeNode/CytoscapeEdge kept for compatibility but deprecated
3. **GraphNode/GraphEdge preferred:** Use new type aliases for D3.js

---

## Technical Stack (from Architecture)

- **Runtime:** Deno 2.5+ with TypeScript 5.7+
- **Database:** PGlite 0.3.11 with pgvector
- **Frontend:** Fresh 2.x with Preact Islands
- **Visualization:** D3.js (migrated from Cytoscape.js)
- **Testing:** Deno test runner, `deno task test:unit`

### Test Commands

```bash
# Run unit tests for HypergraphBuilder
deno task test:unit tests/unit/capabilities/hypergraph_builder_test.ts

# Run all capability tests
deno test -A tests/unit/capabilities/

# Type check
deno check src/capabilities/hypergraph-builder.ts
```

---

## Estimation

- **Effort:** 1-1.5 jours
- **LOC:** ~150-200 net (HypergraphBuilder ~120, tests ~100, refactor data-service ~-50)
- **Risk:** Low (extraction de logique existante, patterns bien etablis)

---

## Dev Agent Record

### Context Reference

- `src/capabilities/data-service.ts:232-414` - Current buildHypergraphData implementation
- `src/capabilities/types.ts:198-280` - GraphNode, GraphEdge types
- `src/web/islands/D3GraphVisualization.tsx` - D3.js visualization (consumer)
- `docs/adrs/ADR-029-hypergraph-capabilities-visualization.md` - Architecture decision
- `docs/sprint-artifacts/8-1-capability-data-api.md` - Predecessor story with learnings

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- Type check passed for all new files
- All 16 HypergraphBuilder unit tests passing
- All 12 CapabilityDataService tests passing (1 updated for parents[] array)
- Total: 28+ tests related to this story passing

### Completion Notes List

1. **HypergraphBuilder class created** (~270 LOC) with:
   - `buildCompoundGraph()` - Main method for graph construction
   - `addCapabilityDependencyEdges()` - Add DB-sourced edges
   - `addStandaloneTools()` - Add tools not in capabilities
   - `createToolNode()` - Helper for tool node creation with snapshot enrichment

2. **Multi-parent hyperedge support implemented**:
   - Tool nodes now have `parents: string[]` instead of `parent?: string`
   - Each tool appears ONCE in graph, with all parent capability IDs in array
   - Hierarchical edges derived from parents[] for D3 force layout

3. **Hull zone metadata generated**:
   - `capabilityZones[]` array in response
   - Each zone: id, label, color, opacity, toolIds, padding, minRadius
   - 8-color palette for visual differentiation

4. **CapabilityDataService refactored**:
   - `buildHypergraphData()` now uses HypergraphBuilder
   - Reduced ~150 LOC to ~60 LOC (delegation pattern)
   - Graph snapshot fetched once and passed to builder

5. **Type system updated**:
   - ToolNode interface: `parent?: string` deprecated, `parents?: string[]` added
   - CapabilityZone interface added to types.ts
   - HypergraphResponseInternal extended with `capabilityZones?`

### File List

**Created:**

- `src/capabilities/hypergraph-builder.ts` (~270 LOC)
- `tests/unit/capabilities/hypergraph_builder_test.ts` (~340 LOC)

**Modified:**

- `src/capabilities/types.ts` - Added CapabilityZone, updated ToolNode with parents[]
- `src/capabilities/data-service.ts` - Refactored to use HypergraphBuilder
- `src/capabilities/mod.ts` - Export HypergraphBuilder and new types
- `tests/unit/capabilities/data_service_test.ts` - Updated test for parents[] array

### Change Log

| Date       | Change                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| 2025-12-11 | Story 8.2 implementation complete - HypergraphBuilder class with hyperedge support         |
| 2025-12-11 | Code review fixes: parents required (not optional), backward compat parent field, +2 tests |
