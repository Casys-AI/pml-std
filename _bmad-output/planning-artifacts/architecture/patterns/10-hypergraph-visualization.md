# Pattern 7: Hypergraph Capabilities Visualization (Epic 8)

**Status:** ✅ IMPLEMENTED (December 2024)

**Problem:** Capabilities are N-ary relationships (connecting multiple tools), not binary edges.
Standard graph visualization fails to represent this accurately.

**Solution: D3.js Force-Directed Graph (ADR-029)**

> **Note:** Originally planned with Cytoscape.js compound graphs, but migrated to D3.js because
> Cytoscape compound nodes don't support multiple parents (a tool shared across capabilities).

```
┌─────────────────────────────────────────────────────────────────┐
│  Dashboard Header                                               │
│  [Tools] [Capabilities] [Hypergraph]  ← View mode toggle       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────────────┐                              │
│   │  Cap: Create Issue from File │ ← D3.js node (violet)       │
│   │  success: 95% | usage: 12   │                              │
│   │  ┌───────┐  ┌────────────┐ │                              │
│   │  │fs:read│  │gh:issue    │ │ ← Child nodes (tools)        │
│   │  └───────┘  └────────────┘ │                              │
│   └─────────────────────────────┘                              │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Code Panel (on capability click)                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  const content = await mcp.filesystem.read("config.json");│  │
│  │  const data = JSON.parse(content);                        │  │
│  │  await mcp.github.createIssue({ title: data.title });     │  │
│  │                                                           │  │
│  │  [Copy Code] [Try This]                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Key Components (Epic 8):**

| Component            | File                                         | Purpose                         |
| -------------------- | -------------------------------------------- | ------------------------------- |
| D3GraphVisualization | `src/web/islands/D3GraphVisualization.tsx`   | Force-directed graph with D3.js |
| Capability Data API  | `GET /api/capabilities`                      | Fetch capabilities with filters |
| Hypergraph API       | `GET /api/graph/hypergraph`                  | Graph-ready data                |
| GraphLegendPanel     | `src/web/components/ui/GraphLegendPanel.tsx` | Edge type legend                |

**D3.js Graph Structure:**

```javascript
// Nodes array
[
  // Capability node
  {
    id: "cap-uuid-1",
    type: "capability",
    label: "Create Issue from File",
    code_snippet: "await mcp.github...",
    success_rate: 0.95,
    usage_count: 12,
  },
  // Tool node (can link to multiple capabilities via edges)
  {
    id: "filesystem:read",
    type: "tool",
    server: "filesystem",
    pagerank: 0.15,
    degree: 5,
  },
] // Links array (hyperedges - tool can have multiple capability parents)
  [
    { source: "cap-uuid-1", target: "filesystem:read", edge_type: "hierarchy" },
      { source: "cap-uuid-2", target: "filesystem:read", edge_type: "hierarchy" }
    // ^ Same tool in multiple capabilities - not possible with Cytoscape compound nodes
  ];
```

**Why D3.js over Cytoscape.js:**

| Aspect           | Cytoscape.js     | D3.js        |
| ---------------- | ---------------- | ------------ |
| Multiple parents | ❌ Not supported | ✅ Via edges |
| Rendering        | Canvas           | SVG          |
| Zoom/Pan         | Built-in         | d3-zoom      |
| Layout           | cose, dagre      | d3-force     |

---

## Capability-to-Capability Hyperedges (ADR-042)

Au-delà des relations Tool↔Capability, le système apprend des **relations entre capabilities** :

### Edge Types

| Edge Type     | Signification             | Exemple                                 |
| ------------- | ------------------------- | --------------------------------------- |
| `contains`    | A inclut B (composition)  | "Deploy App" contains "Build App"       |
| `sequence`    | A puis B (ordre temporel) | "Lint Code" → "Run Tests"               |
| `dependency`  | A dépend de B (DAG)       | "Create PR" depends on "Commit Changes" |
| `alternative` | A et B interchangeables   | "Use npm" alt "Use yarn"                |

### Impact sur les Algorithmes

```typescript
// Spectral Clustering enrichi avec Cap↔Cap edges
const capDeps = await db.query(`
  SELECT from_capability_id, to_capability_id, confidence_score, edge_type
  FROM capability_dependency
  WHERE confidence_score > 0.3
`);

// Capabilities fortement liées → même cluster spectral
```

### Visualisation des Hyperedges

```javascript
// Links array étendu avec Cap→Cap
[
  // Tool → Capability (hierarchy)
  { source: "cap-uuid-1", target: "filesystem:read", edge_type: "hierarchy" },

  // Capability → Capability (learned relations)
  { source: "cap-uuid-1", target: "cap-uuid-2", edge_type: "sequence" },
  { source: "cap-uuid-3", target: "cap-uuid-4", edge_type: "alternative" },
];
```

### Edge Type Visual Encoding

| Edge Type              | Color  | Dash Pattern |
| ---------------------- | ------ | ------------ |
| `hierarchy` (Tool→Cap) | Gray   | Solid        |
| `dependency`           | Red    | Solid        |
| `sequence`             | Blue   | Dashed       |
| `alternative`          | Green  | Dotted       |
| `contains`             | Purple | Solid thick  |

---

**Affects Epics:** Epic 8 (Stories 8.1-8.5)

**References:**

- ADR-029: Hypergraph Capabilities Visualization (includes migration notes)
- ADR-042: Capability-to-Capability Hyperedges
- Epic 6: Real-time Graph Monitoring (base dashboard)

**Design Philosophy:** Visualize the learned capabilities as first-class entities, enabling
developers to explore, understand, and reuse the system's accumulated knowledge.

---
