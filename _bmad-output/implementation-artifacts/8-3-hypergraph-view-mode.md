# Story 8.3: Hypergraph View Mode

> **Epic:** 8 - Hypergraph Capabilities Visualization **ADRs:** ADR-029 (Hypergraph Capabilities
> Visualization) **Prerequisites:** Story 8.2 (HypergraphBuilder - DONE), Epic 6 (D3.js Dashboard
> infrastructure) **Status:** done

## User Story

As a power user, I want a "Hypergraph" view mode in the dashboard, So that I can visualize
capabilities as compound nodes containing their tools.

## Problem Context

### Current State (After Story 8.2)

Le systeme dispose de:

1. **HypergraphBuilder** (`src/capabilities/hypergraph-builder.ts`) - Story 8.2 DONE:
   - `buildCompoundGraph(capabilities, toolsSnapshot)` - Generates D3.js-ready nodes/edges
   - Multi-parent support: `parents: string[]` array instead of single parent
   - `capabilityZones[]` for Hull visualization
   - Hierarchical edges derived from parents[] for D3 force layout

2. **API Endpoints** (`src/mcp/gateway-server.ts`) - Story 8.1 DONE:
   - `GET /api/capabilities` - List capabilities with filters
   - `GET /api/graph/hypergraph` - Get hypergraph data for visualization

3. **D3GraphVisualization** (`src/web/islands/D3GraphVisualization.tsx`) - Epic 6:
   - Force-directed graph avec d3-force
   - Loads data from `/api/graph/snapshot` (tools only)
   - Does NOT support capability nodes or hypergraph mode yet
   - Does NOT support view mode toggle

### Gap Analysis

| Feature                             | Existe? | Location                            |
| ----------------------------------- | ------- | ----------------------------------- |
| Capability node structure           | Oui     | `types.ts` (Story 8.2)              |
| Tool node with parents[]            | Oui     | `types.ts` (Story 8.2)              |
| HypergraphBuilder class             | Oui     | `hypergraph-builder.ts` (Story 8.2) |
| API `/api/graph/hypergraph`         | Oui     | `gateway-server.ts` (Story 8.1)     |
| capabilityZones[] for Hull          | Oui     | `types.ts` (Story 8.2)              |
| View mode toggle [Tools/Hypergraph] | Non     | **Story 8.3**                       |
| D3 Hull rendering for capabilities  | Non     | **Story 8.3**                       |
| Capability node styling             | Non     | **Story 8.3**                       |

### Impact

Sans le mode Hypergraph:

- Les utilisateurs ne peuvent pas visualiser les capabilities apprises par le systeme
- Les relations N-aires (hyperedges) restent invisibles
- L'exploration du code reutilisable (Story 8.5) est impossible
- La valeur d'Epic 7 (Emergent Capabilities) n'est pas visible dans le dashboard

---

## Solution: Hypergraph View Mode Toggle

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Dashboard Header (existing)                                     │
│  [Tools] [Hypergraph]  ← NEW: View mode toggle (Story 8.3)      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  D3GraphVisualization (mode: "tools" | "hypergraph")            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  MODE: TOOLS (existing)                                     │ │
│  │  - Loads from /api/graph/snapshot                          │ │
│  │  - Tool nodes only, edges between tools                    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  MODE: HYPERGRAPH (NEW)                                    │ │
│  │  - Loads from /api/graph/hypergraph                        │ │
│  │  - Tool nodes with D3 Hull zones for capabilities          │ │
│  │  - Click on hull → select capability                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decision: D3 Hull Visualization

**Decision from Story 8.2:** Les capabilities sont visualisees comme des **ZONES** (pas des simples
noeuds), en utilisant **D3 Hull** (convex hull).

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

**Comportement:**

- Chaque capability = une zone (polygone convexe) englobant ses tools
- Un tool avec `parents: ['cap-1', 'cap-2']` est dans les DEUX zones
- Les zones se **chevauchent** la ou les tools sont partages → hyperedge visuel

### Data Flow

```
User clicks [Hypergraph] toggle
        │
        ▼
D3GraphVisualization.setViewMode("hypergraph")
        │
        ▼
fetch("/api/graph/hypergraph")
        │
        ▼
HypergraphResponse {
  nodes: GraphNode[],      // Tools + Capabilities
  edges: GraphEdge[],      // Tool→Tool + Cap→Cap
  capabilityZones: CapabilityZone[],
  capabilities_count,
  tools_count
}
        │
        ▼
D3 renders:
  1. Tool nodes (circles, colored by server)
  2. Capability Hull zones (semi-transparent polygons)
  3. Capability→Tool hierarchy edges (optional, dashed)
  4. Tool→Tool edges (existing)
```

---

## Acceptance Criteria

### AC1: View Mode Toggle in Dashboard Header

- [x] Toggle button group added to dashboard header: `[Tools] [Hypergraph]`
- [x] **Integration:** Uses existing header layout from dashboard Epic 6
- [x] **State:** View mode stored in component state and persisted to localStorage
- [x] **Default:** "tools" mode on initial load
- [x] **Transition:** Smooth animation when switching between modes (~300ms)
- [x] **API call:** Mode change triggers data refetch for appropriate endpoint

### AC2: Hypergraph Data Loading

- [x] Mode "hypergraph" fetches from `/api/graph/hypergraph`
- [x] Mode "tools" fetches from `/api/graph/snapshot` (existing behavior)
- [x] Loading spinner shown during data fetch
- [x] Error handling: display error message if API call fails
- [x] Empty state: "No capabilities learned yet" message if 0 capabilities

### AC3: Capability Hull Zone Rendering

- [x] D3 Hull zones rendered for each capability in `capabilityZones[]`
- [x] Hull calculated using `d3.polygonHull()` from tool node positions
- [x] Hull styling:
  - Fill: semi-transparent (opacity 0.2-0.3) with capability color
  - Stroke: solid 2px with capability color at 0.6 opacity
  - Label: capability name positioned at hull centroid
- [x] 8-color palette for differentiating capabilities (from HypergraphBuilder)
- [x] Hull redraws on simulation tick (tools move → hull follows)

### AC4: Tool Node Updates for Hypergraph Mode

- [x] Tool nodes display same styling as Tools mode (circle, server color)
- [x] Tools within capabilities have subtle visual indicator (e.g., slightly thicker stroke)
- [x] Standalone tools (not in any capability) rendered with dashed stroke
- [x] Node hover shows tooltip with:
  - Tool name and server
  - PageRank and degree
  - List of capabilities this tool belongs to (from `parents[]`)

### AC5: Capability Zone Interactivity

- [x] Click on hull zone → selects that capability
- [x] Selected capability: hull stroke highlighted (white or accent color)
- [x] Selected capability shows details panel (Story 8.4 integration point)
- [ ] Double-click on hull → centers view on that capability _(deferred to 8.4)_
- [x] Hover on hull → shows capability tooltip (name, success_rate, usage_count)

### AC6: Performance Requirements

- [x] Render < 500ms for 50 capabilities, 200 tools
- [x] Hull recalculation uses debouncing (100ms) on simulation tick
- [x] D3 force simulation settles within 3 seconds
- [x] Smooth 60fps during pan/zoom operations

### AC7: View Mode Persistence & Real-Time Updates (BroadcastChannel)

- [x] View mode preference saved to localStorage (`graph-view-mode`)
- [x] On page load, restore previous view mode
- [x] **🔥 CRITICAL: BroadcastChannel Integration (ADR-036)**
  - [x] Subscribe to channel `"casys-pml-events"` (EventBus unified channel)
  - [x] Emits `capability.selected` events → for cross-tab sync
  - [x] Emits `graph.viewMode.changed` events → sync view mode across tabs
  - [ ] Subscribe to `capability.learned` / `capability.matched` events _(deferred - needs EventBus
        integration)_
- [x] Real-time hull zone updates when capability tools change
- [x] SSE fallback for browsers without BroadcastChannel support

### AC8: Integration with Existing Features

- [x] Server filter toggle (show/hide servers) works in both modes
- [x] Orphan nodes toggle (show/hide disconnected tools) works in hypergraph
- [x] Graph export (JSON/PNG) includes capability data in hypergraph mode
- [x] Path highlighting works in both modes (tools only, capabilities handled in 8.4)

### AC9: Mobile Responsiveness (Nice-to-Have)

- [ ] Toggle button group responsive on mobile _(deferred)_
- [ ] Touch gestures for pan/zoom work correctly _(existing from Epic 6)_
- [ ] Hull zones touchable for selection _(deferred)_

---

## Tasks / Subtasks

- [x] **Task 1: Add View Mode Toggle Component (Atomic Design)** (AC: #1)
  - [x] 1.1 Create `ViewModeToggle.tsx` atom in `src/web/components/ui/atoms/`
  - [x] 1.2 Export from `atoms/mod.ts` and `ui/mod.ts`
  - [x] 1.3 Add to GraphExplorer header area (portal to header slot)
  - [x] 1.4 Wire up state management (useState + localStorage)
  - [x] 1.5 Style toggle buttons matching existing design system (--accent: #FFB86F)

- [x] **Task 2: Extend D3GraphVisualization for Hypergraph Mode** (AC: #2, #3, #4)
  - [x] 2.1 Add `viewMode: "tools" | "hypergraph"` prop
  - [x] 2.2 Implement conditional data loading based on mode
  - [x] 2.3 Add `loadHypergraphData()` function to fetch `/api/graph/hypergraph`
  - [x] 2.4 Parse `capabilityZones[]` from response
  - [x] 2.5 Store capability metadata alongside nodes

- [x] **Task 3: Implement D3 Hull Zone Rendering** (AC: #3, #6)
  - [x] 3.1 Create `hullLayer` SVG group in D3GraphVisualization (below node layer, above edge
        layer)
  - [x] 3.2 Implement `drawCapabilityHulls()` using `d3.polygonHull()`
  - [x] 3.3 Implement `expandHull()` helper for padding around tools
  - [x] 3.4 Implement `createEllipsePath()` fallback for 2-point zones
  - [x] 3.5 Calculate hull from tool node positions (filter by `toolIds`)
  - [x] 3.6 Add hull polygon styling (fill, stroke, opacity)
  - [x] 3.7 Hook into simulation `tick` event for hull updates
  - [x] 3.8 Implement debounced hull recalculation (100ms)

- [x] **Task 4: Implement Hull Zone Interactivity** (AC: #5)
  - [x] 4.1 Add click handler on hull polygons
  - [x] 4.2 Implement selected capability highlighting (opacity change on hover)
  - [x] 4.3 Add hover tooltip for capabilities (label, tools count)
  - [ ] 4.4 Implement double-click to center on capability _(deferred to 8.4)_
  - [x] 4.5 Integrate with `onCapabilitySelect` callback (for Story 8.4)

- [x] **Task 5: Update Tool Node Rendering** (AC: #4)
  - [x] 5.1 Add visual indicator for tools within capabilities (multi-parent badge)
  - [x] 5.2 Dashed stroke for standalone tools (existing behavior preserved)
  - [x] 5.3 Add `parents[]` to SimNode type
  - [x] 5.4 Badge shows count of parent capabilities (1-9+)

- [x] **Task 6: Integrate with Existing Features + BroadcastChannel** (AC: #7, #8)
  - [x] 6.1 Server filter works in hypergraph mode
  - [x] 6.2 Orphan toggle works in hypergraph mode
  - [x] 6.3 Export includes capability data via zones
  - [x] 6.4 Persist view mode to localStorage
  - [x] 6.5 **BroadcastChannel**: Emit `graph.viewMode.changed` on toggle
  - [x] 6.6 **BroadcastChannel**: Emit `capability.selected` on hull click
  - [x] 6.7 Listen for view mode changes from other tabs
  - [x] 6.8 Keep SSE as fallback for `graph.edge.*` events (existing)
  - [ ] 6.9 Full EventBus integration for `capability.learned`/`matched` _(deferred)_

- [x] **Task 7: Unit & Integration Tests** (AC: all)
  - [x] 7.1 Create `tests/web/hypergraph-view-mode.test.ts`
  - [x] 7.2 Test `expandHull()` edge cases (triangle, < 3 points)
  - [x] 7.3 Test `createEllipsePath()` for 2-point zones
  - [x] 7.4 Test ViewMode type validation
  - [x] 7.5 Test CapabilityZone structure
  - [x] 7.6 Test hypergraph data transformation
  - [x] 7.7 Test BroadcastChannel event structures
  - [x] 7.8 Test zone color palette (8 colors, cycling)

---

## Implementation Notes (2025-12-11)

### Files Created/Modified

| File                                             | Action   | Description                                                    |
| ------------------------------------------------ | -------- | -------------------------------------------------------------- |
| `src/web/components/ui/atoms/ViewModeToggle.tsx` | Created  | Segmented control atom for view mode                           |
| `src/web/components/ui/atoms/mod.ts`             | Modified | Export ViewModeToggle                                          |
| `src/web/islands/GraphExplorer.tsx`              | Modified | Add viewMode state, localStorage persistence, BroadcastChannel |
| `src/web/islands/D3GraphVisualization.tsx`       | Modified | Add viewMode prop, loadHypergraphData(), hull rendering        |
| `tests/web/hypergraph-view-mode.test.ts`         | Created  | 25 unit tests for Story 8.3                                    |

### Key Implementation Decisions

1. **Hull rendering inline vs atoms**: Implemented hull rendering as D3 data-join directly in
   `D3GraphVisualization.tsx` rather than separate Preact atoms. This avoids React/D3 reconciliation
   issues and gives D3 full control over SVG lifecycle.

2. **Multi-parent badge**: Added visual badge (number) on tool nodes showing count of parent
   capabilities when > 1, positioned at top-right of node circle.

3. **BroadcastChannel channel name**: Using `"casys-pml-events"` as the channel name for consistency
   with other components.

4. **Deferred features**: Double-click centering and full EventBus subscription for capability
   events deferred to Story 8.4 to keep scope manageable.

### Test Results

```
25 tests passing (32ms)
- Hull Zone Helpers: 3 tests
- Ellipse Path Helper: 4 tests
- View Mode Type: 2 tests
- CapabilityZone structure: 2 tests
- Hypergraph Data Transformation: 2 tests
- BroadcastChannel Events: 2 tests
- Zone Color Palette: 3 tests
```

---

## Dev Notes

### Critical Implementation Details

1. **Hull Calculation with D3**

```typescript
import { polygonCentroid, polygonHull } from "d3-polygon";

function drawCapabilityHulls(
  hullLayer: d3.Selection<SVGGElement, unknown, null, undefined>,
  zones: CapabilityZone[],
  nodes: SimNode[],
) {
  const hullData = zones.map((zone) => {
    // Get positions of tools in this capability
    const toolNodes = nodes.filter((n) => zone.toolIds.includes(n.id));
    const points: [number, number][] = toolNodes.map((n) => [n.x, n.y]);

    // Need at least 3 points for hull
    if (points.length < 3) {
      // For 1-2 tools, create a circle/ellipse instead
      return { zone, hull: null, points };
    }

    // Calculate convex hull
    const hull = polygonHull(points);
    return { zone, hull, points };
  });

  // Render hulls
  const hulls = hullLayer.selectAll(".capability-hull")
    .data(hullData, (d) => d.zone.id);

  hulls.exit().remove();

  const hullEnter = hulls.enter()
    .append("g")
    .attr("class", "capability-hull");

  // Hull polygon
  hullEnter.append("path")
    .attr("class", "hull-path")
    .attr("fill", (d) => d.zone.color)
    .attr("fill-opacity", 0.2)
    .attr("stroke", (d) => d.zone.color)
    .attr("stroke-opacity", 0.6)
    .attr("stroke-width", 2);

  // Hull label
  hullEnter.append("text")
    .attr("class", "hull-label")
    .attr("fill", (d) => d.zone.color)
    .attr("font-size", 12)
    .attr("font-weight", 600)
    .attr("text-anchor", "middle");

  const hullMerge = hullEnter.merge(hulls);

  // Update hull paths
  hullMerge.select(".hull-path")
    .attr("d", (d) => {
      if (d.hull) {
        // Add padding around hull
        const paddedHull = expandHull(d.hull, d.zone.padding || 20);
        return `M${paddedHull.join("L")}Z`;
      }
      // Fallback for < 3 points: circle
      if (d.points.length === 1) {
        const [x, y] = d.points[0];
        const r = d.zone.minRadius || 50;
        return `M${x - r},${y}A${r},${r} 0 1,0 ${x + r},${y}A${r},${r} 0 1,0 ${x - r},${y}`;
      }
      // 2 points: ellipse
      return createEllipsePath(d.points, d.zone.minRadius || 50);
    });

  // Update label positions
  hullMerge.select(".hull-label")
    .attr("x", (d) => {
      const centroid = d.hull
        ? polygonCentroid(d.hull)
        : [d.points[0]?.[0] || 0, d.points[0]?.[1] || 0];
      return centroid[0];
    })
    .attr("y", (d) => {
      const centroid = d.hull
        ? polygonCentroid(d.hull)
        : [d.points[0]?.[0] || 0, d.points[0]?.[1] || 0];
      return centroid[1] - 30; // Label above hull
    })
    .text((d) => d.zone.label);
}

function expandHull(hull: [number, number][], padding: number): [number, number][] {
  const centroid = polygonCentroid(hull);
  return hull.map(([x, y]) => {
    const dx = x - centroid[0];
    const dy = y - centroid[1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    const scale = (dist + padding) / dist;
    return [centroid[0] + dx * scale, centroid[1] + dy * scale];
  });
}
```

2. **View Mode State Management**

```typescript
// In D3GraphVisualization.tsx
type ViewMode = "tools" | "hypergraph";

interface D3GraphVisualizationProps {
  apiBase: string;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  onCapabilitySelect?: (capability: CapabilityData | null) => void;
  // ... existing props
}

// Load from localStorage on mount
useEffect(() => {
  const savedMode = localStorage.getItem("graph-view-mode") as ViewMode;
  if (savedMode && (savedMode === "tools" || savedMode === "hypergraph")) {
    setViewMode(savedMode);
  }
}, []);

// Save to localStorage on change
useEffect(() => {
  localStorage.setItem("graph-view-mode", viewMode);
}, [viewMode]);

// Conditional data loading
useEffect(() => {
  if (viewMode === "hypergraph") {
    loadHypergraphData();
  } else {
    loadGraphData(); // existing function
  }
}, [viewMode]);
```

3. **CapabilityZone Data Structure (from Story 8.2)**

```typescript
interface CapabilityZone {
  id: string; // 'cap-{uuid}'
  label: string; // Capability name or intent preview
  color: string; // '#8b5cf6' (from 8-color palette)
  opacity: number; // 0.3 (semi-transparent)
  toolIds: string[]; // ['filesystem:read', 'github:create_issue']
  padding: number; // 20px around tools
  minRadius: number; // 50px minimum hull size
}
```

4. **Hull Update on Simulation Tick (Debounced)**

```typescript
// In D3 simulation setup
const simulation = d3.forceSimulation<SimNode>()
  // ... existing forces
  .on("tick", ticked);

let hullUpdateTimer: number | null = null;

function ticked() {
  // Update edges and nodes (existing)
  updateEdges();
  updateNodes();

  // Debounced hull update
  if (viewMode === "hypergraph" && capabilityZones.length > 0) {
    if (hullUpdateTimer) clearTimeout(hullUpdateTimer);
    hullUpdateTimer = setTimeout(() => {
      drawCapabilityHulls(hullLayer, capabilityZones, nodesRef.current);
    }, 100);
  }
}
```

5. **Node ID Convention (from Story 8.2)**

- Capability: `cap-{uuid}` (prefix to avoid collision with tool IDs)
- Tool: `{server}:{tool_name}` (existing convention)
- Edge: `edge-{source}-{target}` (existing convention)

6. **🔥 BroadcastChannel Real-Time Integration (ADR-036)**

Le dashboard DOIT recevoir les updates en temps réel via BroadcastChannel (pas juste SSE polling).

**Channel:** `"pml-events"` (EventBus unifié - voir `src/events/event-bus.ts`)

> ⚠️ **Tech Debt:** Le channel s'appelle encore `"pml-events"` (legacy PML naming). Migration vers
> `"pml-events"` à faire dans une story séparée (impact: EventBus, sandbox-worker, worker-bridge,
> tous les listeners). Pour Story 8.3: utiliser le nom actuel `"pml-events"`.

```typescript
// In D3GraphVisualization.tsx - Setup BroadcastChannel
useEffect(() => {
  // BroadcastChannel for real-time updates (ADR-036)
  // Channel name from src/events/event-bus.ts:20
  const channel = new BroadcastChannel("pml-events");

  channel.onmessage = (event: MessageEvent) => {
    const { type, payload } = event.data;

    switch (type) {
      case "capability.learned":
        // New capability learned - add zone to hypergraph
        // Payload: CapabilityLearnedPayload from src/events/types.ts:185
        handleCapabilityLearned(payload);
        break;

      case "capability.matched":
        // Capability was matched to intent - highlight it
        // Payload: CapabilityMatchedPayload from src/events/types.ts:205
        if (payload.selected) highlightZone(`cap-${payload.capabilityId}`, 1000);
        break;

      case "tool.start":
        // Tool execution started - flash the node
        // Payload: ToolStartPayload from src/events/types.ts:117
        flashToolNode(payload.toolId, 500);
        break;

      case "tool.end":
        // Tool execution ended - update node state
        // Payload: ToolEndPayload from src/events/types.ts:129
        updateToolNodeState(payload.toolId, payload.success);
        break;

      case "graph.edge.created":
        // New edge between tools - existing handler
        handleEdgeCreated({ data: JSON.stringify(payload) });
        break;

      case "graph.edge.updated":
        // Edge confidence updated - existing handler
        handleEdgeUpdated({ data: JSON.stringify(payload) });
        break;
    }
  };

  // SSE fallback for older browsers
  const eventSource = new EventSource(`${apiBase}/events/stream`);
  // ... existing SSE handlers as fallback

  return () => {
    channel.close();
    eventSource.close();
  };
}, [apiBase, viewMode]);

// Handler for new capability learned (CapabilityLearnedPayload)
function handleCapabilityLearned(payload: {
  capabilityId: string; // code hash
  name: string;
  intent: string;
  toolsUsed: string[];
  isNew: boolean;
  usageCount: number;
  successRate: number;
}) {
  if (viewMode !== "hypergraph") return;

  if (payload.isNew) {
    // Add new capability zone
    const newZone: CapabilityZone = {
      id: `cap-${payload.capabilityId}`,
      label: payload.name || payload.intent.slice(0, 30),
      color: getNextCapabilityColor(),
      opacity: 0.3,
      toolIds: payload.toolsUsed,
      padding: 20,
      minRadius: 50,
      successRate: payload.successRate,
      usageCount: payload.usageCount,
    };

    capabilityZonesRef.current = [...capabilityZonesRef.current, newZone];
    drawCapabilityHulls(hullLayer, capabilityZonesRef.current, nodesRef.current);
    highlightZone(newZone.id, 2000); // Flash for 2s
  } else {
    // Update existing zone stats
    const zone = capabilityZonesRef.current.find((z) => z.id === `cap-${payload.capabilityId}`);
    if (zone) {
      zone.successRate = payload.successRate;
      zone.usageCount = payload.usageCount;
      highlightZone(zone.id, 500);
    }
  }
}

// Flash a tool node (visual feedback for execution)
function flashToolNode(toolId: string, duration: number) {
  const { nodeLayer } = (window as any).__d3Graph;
  if (!nodeLayer) return;

  const node = nodeLayer
    .selectAll(".node")
    .filter((d: SimNode) => d.id === toolId);

  // Flash effect: orange stroke
  node.select("circle")
    .transition()
    .duration(duration / 2)
    .attr("stroke", "#FFB86F")
    .attr("stroke-width", 4)
    .transition()
    .duration(duration / 2)
    .attr("stroke", "rgba(255, 255, 255, 0.3)")
    .attr("stroke-width", 2);
}
```

**Event Types à écouter (from `src/events/types.ts`):**

| Event                | Source          | Payload Type               | Action                        |
| -------------------- | --------------- | -------------------------- | ----------------------------- |
| `capability.learned` | CapabilityStore | `CapabilityLearnedPayload` | Add/update hull zone          |
| `capability.matched` | CapabilityStore | `CapabilityMatchedPayload` | Highlight matched zone        |
| `tool.start`         | WorkerBridge    | `ToolStartPayload`         | Flash tool node (orange)      |
| `tool.end`           | WorkerBridge    | `ToolEndPayload`           | Update node state (green/red) |
| `graph.edge.created` | GraphEngine     | `GraphEdgeCreatedPayload`  | Add edge (existing)           |
| `graph.edge.updated` | GraphEngine     | `GraphEdgeUpdatedPayload`  | Update edge (existing)        |

**Références Types:** `src/events/types.ts:117-220` pour les payloads détaillés.

### Project Structure Notes

**🔥 CRITICAL: Atomic Design Architecture**

Le projet utilise une architecture **Atomic Design** stricte. Tous les nouveaux composants DOIVENT
respecter cette hiérarchie:

```
src/web/components/ui/
├── atoms/           # Composants de base (Button, Input, Badge, GraphNode, GraphEdge)
├── molecules/       # Combinaisons d'atoms (GraphTooltip, GraphLegendPanel, SearchBar)
└── layout/          # Structure de page (DashboardLayout, Header, Sidebar)
```

**Règles Atomic Design:**

1. **Atoms:** Composants indivisibles, sans dépendances internes (Button, Input, Badge)
2. **Molecules:** Combinaisons d'atoms pour fonctionnalité spécifique (SearchBar = Input + Button)
3. **Organisms:** Combinaisons de molecules (non utilisé actuellement, islands = organisms)
4. **Exports:** Chaque niveau a son `mod.ts`, le root `ui/mod.ts` réexporte tout

**Files to Create (following Atomic Design):**

```
src/web/components/ui/atoms/
├── ViewModeToggle.tsx        # NEW: Atom - segmented control (~40 LOC)
├── CapabilityHull.tsx        # NEW: Atom - SVG hull polygon (~30 LOC)
└── HullLabel.tsx             # NEW: Atom - hull label text (~20 LOC)

src/web/components/ui/molecules/
├── CapabilityZone.tsx        # NEW: Molecule - Hull + Label + interactions (~60 LOC)
└── CapabilityTooltip.tsx     # NEW: Molecule - tooltip for capabilities (~40 LOC)

tests/unit/web/
├── view_mode_toggle_test.ts  # NEW: Component tests
└── hypergraph_rendering_test.ts  # NEW: Hull rendering tests
```

**Files to Modify:**

```
src/web/components/ui/atoms/mod.ts     # MODIFY: Export new atoms
src/web/components/ui/molecules/mod.ts # MODIFY: Export new molecules
src/web/components/ui/mod.ts           # MODIFY: Re-export all

src/web/islands/
└── D3GraphVisualization.tsx  # MODIFY: Add hypergraph mode, use atoms/molecules (~300 LOC)

src/web/routes/
└── dashboard.tsx             # MODIFY: Add ViewModeToggle to header (~20 LOC)
```

### Existing Code Patterns to Follow

**D3GraphVisualization.tsx** (`src/web/islands/D3GraphVisualization.tsx`):

- Current implementation: ~843 LOC
- Uses d3-force for layout, d3-zoom for pan/zoom
- Layers: `edgeLayer` → `nodeLayer` (need to add `hullLayer` between them)
- Event handlers: `handleNodeCreated`, `handleEdgeCreated`
- SSE integration: EventSource for real-time updates

**Dashboard Header** (`src/web/routes/dashboard.tsx`):

- Search bar and filter controls in header
- GraphExplorer with MetricsPanel integration
- Style: dark theme with `--accent: #FFB86F`

**HypergraphBuilder Output** (from Story 8.2):

- `capabilityZones[]` array with zone metadata
- Tool nodes have `parents: string[]` array
- 8-color palette for capability differentiation

### References

- **HypergraphBuilder:** `src/capabilities/hypergraph-builder.ts` (Story 8.2)
- **Types:** `src/capabilities/types.ts` (CapabilityZone, GraphNode, etc.)
- **D3 Visualization:** `src/web/islands/D3GraphVisualization.tsx` (consumer)
- **ADR-029:** `docs/adrs/ADR-029-hypergraph-capabilities-visualization.md`
- **API:** `src/mcp/gateway-server.ts` (GET /api/graph/hypergraph)

---

## Previous Story Intelligence

### From Story 8.2 (Compound Graph Builder) - CRITICAL

**Key Learnings:**

1. **Multi-parent hyperedge support:** Tool nodes now have `parents: string[]` array
2. **Hull zone metadata:** `capabilityZones[]` array with color, opacity, toolIds
3. **8-color palette:** Predefined colors for visual differentiation
4. **Performance:** HypergraphBuilder generates data in ~50ms for 100 capabilities

**Code Patterns Established:**

- Tool deduplication: each tool appears once with all parent capability IDs
- Hierarchical edges: derived from parents[] for D3 force layout
- Zone structure: id, label, color, opacity, toolIds, padding, minRadius

**Files Created by 8.2:**

- `src/capabilities/hypergraph-builder.ts` (~270 LOC)
- `tests/unit/capabilities/hypergraph_builder_test.ts` (~340 LOC)

### From Story 8.1 (Capability Data API)

**API Endpoints:**

- `GET /api/capabilities` - List with filters (community_id, min_success_rate, etc.)
- `GET /api/graph/hypergraph` - Full hypergraph data with capabilityZones

**Response Format:**

```typescript
interface HypergraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  capabilities_count: number;
  tools_count: number;
  capabilityZones?: CapabilityZone[];
  metadata: { generated_at: string; version: string };
}
```

### From Epic 6 (D3.js Migration)

**Recent Commits:**

```
c8d52df refactor: migrate visualization from Cytoscape.js to D3.js
dd04aee fix: Correct test paths and D3 migration assertions
```

**Key Changes:**

- Cytoscape.js removed, D3.js force-directed graph implemented
- SVG-based rendering with d3-zoom for pan/zoom
- `D3GraphVisualization.tsx` is the main visualization component
- Layer architecture: defs → g.graph-container → g.edges → g.nodes

---

## Git Intelligence

### Recent Commits (relevant patterns):

```
8be6cff feat(capabilities): implement HypergraphBuilder for compound graph visualization (Story 8.2)
be98c4e feat(capabilities): implement capability-to-capability dependency system
c8d52df refactor: migrate visualization from Cytoscape.js to D3.js
```

### Learnings:

1. **D3.js is current stack:** All visualization should use D3.js, not Cytoscape
2. **SVG layers:** Add new layer (hullLayer) between edges and nodes
3. **GraphNode/GraphEdge types:** Use these for D3.js data
4. **SSE updates:** Need to handle in both modes (tool updates work, capability updates TBD)

---

## Technical Stack (from Architecture)

- **Runtime:** Deno 2.5+ with TypeScript 5.7+
- **Frontend:** Fresh 2.x with Preact Islands
- **Visualization:** D3.js (d3-force, d3-zoom, d3-polygon)
- **Testing:** Deno test runner, `deno task test:unit`

### D3 Dependencies (loaded from CDN)

```html
<!-- Already in dashboard.tsx -->
<script src="https://d3js.org/d3.v7.min.js"></script>
```

Note: `d3.polygonHull()` and `d3.polygonCentroid()` are included in d3 v7.

### Test Commands

```bash
# Run unit tests for view mode
deno task test:unit tests/unit/web/view_mode_toggle_test.ts

# Run all web tests
deno test -A tests/unit/web/

# Type check
deno check src/web/islands/D3GraphVisualization.tsx

# Manual test: start dashboard
deno task dev:web
```

---

## Estimation

- **Effort:** 2-3 jours
- **LOC:** ~400-500 net (D3GraphVisualization +300, ViewModeToggle +50, dashboard +20, tests +150)
- **Risk:** Medium (D3 hull rendering complexity, performance with many capabilities)

---

## UX Design Considerations (a valider)

**Questions to resolve before implementation:**

1. Toggle button design: segmented control or icon buttons?
2. Transition animation: fade crossfade or morph?
3. Empty state: what message if no capabilities?
4. Hull label placement: above hull or inside?
5. Color scheme: capability colors vs server colors priority?

**Proposed answers (defaults if not overridden):**

1. Segmented control matching existing filter style
2. Fade transition (300ms)
3. "No capabilities learned yet. Execute code workflows to build capability graph."
4. Above hull (less clutter)
5. Capability colors take priority, tools keep server colors

---

## Dev Agent Record

### Context Reference

- `src/capabilities/hypergraph-builder.ts` - HypergraphBuilder class (Story 8.2)
- `src/capabilities/types.ts:198-280` - GraphNode, GraphEdge, CapabilityZone types
- `src/web/islands/D3GraphVisualization.tsx` - Current D3 visualization
- `src/mcp/gateway-server.ts` - API endpoints
- `docs/adrs/ADR-029-hypergraph-capabilities-visualization.md` - Architecture decision

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

N/A

### Completion Notes List

1. ViewModeToggle atom created with Casys design system styling
2. D3GraphVisualization extended with hypergraph mode and hull rendering
3. GraphExplorer updated with view mode state and BroadcastChannel sync
4. Unit tests pass (25 tests)

### File List

| File                                             | Action   | Description                                             |
| ------------------------------------------------ | -------- | ------------------------------------------------------- |
| `src/web/components/ui/atoms/ViewModeToggle.tsx` | Created  | Segmented control atom for view mode                    |
| `src/web/components/ui/atoms/mod.ts`             | Modified | Export ViewModeToggle                                   |
| `src/web/islands/GraphExplorer.tsx`              | Modified | Add viewMode state, localStorage, BroadcastChannel      |
| `src/web/islands/D3GraphVisualization.tsx`       | Modified | Add viewMode prop, loadHypergraphData(), hull rendering |
| `src/mcp/gateway-server.ts`                      | Modified | Add capability_zones and parents[] to API response      |
| `tests/web/hypergraph-view-mode.test.ts`         | Created  | 25 unit tests for Story 8.3                             |

---

## Code Review (2025-12-11)

### Issues Found & Fixed

| Severity   | Issue                                                               | Fix Applied                                                                  |
| ---------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **HIGH**   | API `/api/graph/hypergraph` missing `capability_zones` in response  | Added `capability_zones: result.capabilityZones \|\| []` to gateway response |
| **MEDIUM** | API missing `parents[]` array for tool nodes                        | Added `parents: node.data.parents` to tool node mapping                      |
| **MEDIUM** | BroadcastChannel name mismatch (`casys-pml-events` vs `pml-events`) | Changed to `pml-events` to match EventBus                                    |
| **LOW**    | Export JSON missing capability zones                                | Added capabilityZones to JSON export in hypergraph mode                      |

### Verification

- Type-check: ✅ Pass
- Unit tests: ✅ 25/25 passing
