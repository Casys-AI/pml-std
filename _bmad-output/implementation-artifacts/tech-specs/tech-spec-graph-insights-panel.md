# Tech Spec: Graph Insights Panel

## Overview

Refactor the GraphInsightsPanel (formerly RelatedToolsSidebar) to display multiple graph/hypergraph
algorithms with a tabbed interface. The panel opens when clicking any node (tool, capability,
meta-capability) in graph mode.

## Goals

1. **Tabbed UI** - 2 horizontal tabs: Structure vs Behavior
2. **Multi-algorithm support** - Show different algorithms per tab
3. **Multi-node-type support** - Works for tools, capabilities, and meta-capabilities
4. **Extensible** - Easy to add hypergraph algorithms later

## Architecture

### Tab Structure

```
┌─────────────────────────────────────┐
│  Graph Insights          [X]        │
├─────────────────────────────────────┤
│  [Selected Node Info]               │
│  🔧 mcp__filesystem__read_file      │
│  Tool | filesystem | PR: 0.042      │
├─────────────────────────────────────┤
│  [ Structure ]  [ Behavior ]        │  ← Tabs
├─────────────────────────────────────┤
│  ┌─ Community (Louvain) ──────────┐ │
│  │ #12 members in cluster         │ │
│  │ • tool_a (PR: 0.05)           │ │
│  │ • tool_b (PR: 0.03)           │ │
│  └────────────────────────────────┘ │
│  ┌─ PageRank Neighbors ───────────┐ │
│  │ Direct connections by importance│ │
│  │ • tool_c (PR: 0.08) ━━━━━━━   │ │
│  └────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### Tab Contents

| Tab           | Section            | Algorithm               | Data Source                         |
| ------------- | ------------------ | ----------------------- | ----------------------------------- |
| **Structure** | Community          | Louvain                 | `/api/graph/snapshot` (communityId) |
| **Structure** | PageRank Neighbors | Direct edges + PageRank | `/api/graph/snapshot`               |
| **Behavior**  | Similar Nodes      | Adamic-Adar             | `/api/graph/related`                |
| **Behavior**  | Sequences          | Co-occurrence patterns  | Future: traces analysis             |

### API Requirements

**Existing endpoints (no changes needed):**

- `GET /api/graph/related?tool_id=X` - Adamic-Adar similarity
- `GET /api/graph/snapshot` - Full graph with pagerank, communityId

**New endpoint needed:**

- `GET /api/graph/community?node_id=X` - Members of same Louvain community

### Component Changes

**GraphInsightsPanel.tsx:**

```typescript
interface GraphInsightsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  selectedNode: SelectedNodeInfo | null;
  // Tab-based data
  structureData: {
    community: CommunityData | null;
    neighbors: NeighborData[];
  };
  behaviorData: {
    similarNodes: RelatedItem[];
    sequences: SequenceData[]; // Future
  };
  isLoading: boolean;
  activeTab: "structure" | "behavior";
  onTabChange: (tab: "structure" | "behavior") => void;
  // ... existing props
}

interface CommunityData {
  communityId: number;
  memberCount: number;
  members: Array<{
    id: string;
    name: string;
    type: NodeType;
    pagerank: number;
  }>;
}

interface NeighborData {
  id: string;
  name: string;
  type: NodeType;
  pagerank: number;
  edgeWeight: number;
  edgeType: "observed" | "inferred";
}
```

**GraphExplorer.tsx:**

- Manage `activeTab` state
- Fetch community data when node selected
- Extract neighbors from graph snapshot

## Implementation Phases

### Phase 1: Tabbed UI (DONE)

- [x] Rename RelatedToolsSidebar → GraphInsightsPanel
- [x] Add horizontal tab component (Structure / Behavior)
- [x] Move Adamic-Adar to "Behavior" tab (renamed to "Similar Nodes")
- [x] Create empty "Structure" tab with placeholder message

### Phase 2: Structure Tab Content (DONE)

- [x] Add `/api/graph/community` endpoint
- [x] Add `/api/graph/neighbors` endpoint
- [x] Fetch community + neighbors data in parallel on node select
- [x] Display "Community #N" section with members sorted by PageRank
- [x] Display "Top Neighbors" section with direct connections

### Phase 2.5: Hover Preview (DONE)

- [x] Add `onItemHover(id: string | null, type: NodeType)` callback to GraphInsightsPanel
- [x] On item mouseenter → call onItemHover with item id
- [x] On item mouseleave → call onItemHover(null) to restore selected node highlight
- [x] In CytoscapeGraph: handle temporary highlight vs locked selection (`previewNodeId` prop)
- [x] Visual feedback: different highlight style for preview (green dashed) vs selected (amber
      solid)

### Phase 2.6: Pin System (Accumulate Results) (DONE)

- [x] Click on algorithm badge to pin/unpin (replaces "+" button on header)
- [x] State: `pinnedSets: Array<{ id, sourceNodeName, algorithm, color, nodeIds }>`
- [x] Color palette: 5 distinct colors (PIN_COLORS in GraphInsightsPanel)
- [x] Pinned items persist in graph with their assigned color
- [x] "Clear all" button to reset pins
- [x] Pinned sets legend shown in panel footer
- [x] Visual: pinned nodes get colored border/glow in CytoscapeGraph

### Phase 3: Graph Visualization (DONE)

- [x] Add `communityId` to ToolNode interface
- [x] Parse `community_id` from hypergraph API for tools
- [x] Create COMMUNITY_COLORS palette (12 distinct colors)
- [x] Update renderGraphMode to color tool nodes by community
- [x] Highlight community on hover in panel (same behavior as graph hover, section-specific color)

### Phase 4: Unified Insights View

Remplace les sections séparées par une **liste unifiée avec badges d'algorithmes**.

**Concept:**

```
┌─────────────────────────────────────────┐
│  Graph Insights              [X]        │
├─────────────────────────────────────────┤
│  [Selected Node Info]                   │
├─────────────────────────────────────────┤
│  [ Graph ]  [ Hypergraph ]    ← Tabs    │
├─────────────────────────────────────────┤
│  Cap A  [Spectral][Hyperedge] ━━━ 0.92  │
│  Cap B  [SHGAT][Co-occur]     ━━  0.75  │
│  Tool X [Louvain][Adamic]     ━   0.68  │
│         ↑ hover = preview tous les      │
│           nodes de cet algo             │
└─────────────────────────────────────────┘
```

**Tabs par type de graphe:**

| Tab            | Algorithmes disponibles                                                |
| -------------- | ---------------------------------------------------------------------- |
| **Graph**      | Louvain, PageRank neighbors, Adamic-Adar                               |
| **Hypergraph** | Spectral clustering, Hyperedge overlap, SHGAT attention, Co-occurrence |

**Algorithmes par type de node:**

| Node Type  | Graph Algos                    | Hypergraph Algos                          |
| ---------- | ------------------------------ | ----------------------------------------- |
| Tool       | Louvain, PageRank, Adamic-Adar | -                                         |
| Capability | -                              | Spectral, Hyperedge, SHGAT, Co-occurrence |
| Meta-cap   | -                              | Spectral, Hyperedge, SHGAT                |

**Liste unifiée:**

- Tous les résultats dédupliqués par node ID
- Chaque item affiche des badges pour les algos qui l'ont trouvé
- Score = max des scores des différents algos
- Trié par score décroissant

**Interactions hover/click:**

- **Hover item** → preview ce node + ses edges
- **Hover badge algo** → visualisation Cytoscape spécifique à l'algo
- **Click item** → select ce node, ouvre son panel
- **Click badge** → filter la liste pour n'afficher que cet algo

**Visualisations Cytoscape par algo:**

Chaque algo a sa propre visualisation adaptée à ce qu'il représente:

| Algo              | Visualisation         | Description                                              |
| ----------------- | --------------------- | -------------------------------------------------------- |
| **Louvain**       | Zone/Hull             | Polygone convexe autour du cluster community             |
| **Spectral**      | Zone/Hull             | Polygone autour du cluster spectral (couleur différente) |
| **PageRank**      | Highlight nodes+edges | Nodes connectés + edges mis en évidence                  |
| **Adamic-Adar**   | Highlight nodes+edges | Nodes similaires + edges mis en évidence                 |
| **Hyperedge**     | Zone partagée         | Zone montrant les tools partagés entre capabilities      |
| **SHGAT**         | Edge weights          | Épaisseur des edges proportionnelle au score d'attention |
| **Co-occurrence** | Animated paths        | Animation des séquences d'exécution (flow)               |

**Badges dans la liste:**

- Icônes/formes au lieu de couleurs: `[◆ Spectral][◇ Hyperedge]`
- Les couleurs restent pour la sémantique (layers, servers, communities)

**API Endpoints:**

- `GET /api/graph/insights?node_id=X` → unified results with algo tags
- Response:

```typescript
{
  items: [{
    id: string,
    name: string,
    type: NodeType,
    algos: [{
      name: string,        // "louvain", "spectral", etc.
      score: number,
      icon: string,        // "◆", "◇", "○", etc.
      vizType: string,     // "hull", "highlight", "edges", "animated-path"
      nodeIds?: string[],  // nodes concernés par cet algo
    }],
    maxScore: number
  }]
}
```

**Implementation:**

Phase 4.1 - Backend:

- [x] Create unified `/api/graph/insights` endpoint
- [x] Implement co-occurrence analysis from execution traces
- [x] Deduplicate results by node ID, aggregate algo data
- [ ] Implement spectral clustering on cap-cap similarity matrix (using pagerank proximity as proxy)
- [ ] Integrate SHGAT attention scores from existing model

Phase 4.2 - Frontend UI:

- [x] Update GraphInsightsPanel with unified list + badge icons
- [x] Add hover handlers for items (preview node)
- [x] Add hover handlers for badges (trigger algo-specific viz)
- [ ] Add click handlers for badges (filter mode)

Phase 4.3 - Cytoscape Visualizations:

- [x] Hull/zone infrastructure (convex-hull.ts with Graham scan, animation, merging)
- [ ] Hull/zone rendering for Louvain clusters
- [ ] Hull/zone rendering for Spectral clusters
- [ ] Hyperedge zone (shared tools between caps)
- [ ] Edge weight visualization for SHGAT attention
- [ ] Animated path rendering for Co-occurrence flows

## Files Modified

1. `src/web/islands/GraphInsightsPanel.tsx` - Unified list UI, algo badges, hover/click handlers
2. `src/web/islands/GraphExplorer.tsx` - Tab state (Graph/Hypergraph), unified API fetch
3. `src/mcp/routing/handlers/graph.ts` - `/api/graph/community`, `/api/graph/neighbors`,
   `/api/graph/insights`
4. `src/web/islands/CytoscapeGraph.tsx` - Community colors, multi-node preview for algo hover
5. `src/graphrag/algorithms/spectral-clustering.ts` - New: Spectral clustering implementation
6. `src/graphrag/algorithms/co-occurrence.ts` - New: Trace co-occurrence analysis

## Testing

**Phase 3 (done):**

- Click tool node → Panel opens with algo sections
- Hover item in sidebar → preview node + edges with section color
- Preview overlays on existing highlight

**Phase 4 (unified view):**

- Click tool → Graph tab shows Louvain, PageRank, Adamic-Adar results
- Click capability → Hypergraph tab shows Spectral, Hyperedge, SHGAT, Co-occur
- Hover item → preview that node
- Hover badge → preview ALL nodes from that algo
- Click badge → filter list to show only that algo
- Badges have distinct colors per algo
