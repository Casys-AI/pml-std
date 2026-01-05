## Epic 8: Hypergraph Capabilities Visualization

> **ADR:** ADR-029 (Hypergraph Capabilities Visualization) **Depends on:** Epic 6 (Dashboard), Epic
> 7 (Capabilities Storage) **Status:** Proposed (2025-12-04)

**Expanded Goal (2-3 sentences):**

Visualiser les capabilities comme **hyperedges** (relations N-aires entre tools) via D3.js
force-directed graph, permettant aux utilisateurs de voir, explorer et réutiliser le code appris par
le système. Une capability n'est pas une relation binaire mais une relation N-aire connectant
plusieurs tools ensemble, nécessitant une approche de visualisation différente du graph classique.

> **Note (Dec 2024):** Migré de Cytoscape.js vers D3.js car les compound nodes Cytoscape ne
> supportent pas plusieurs parents (un tool partagé entre capabilities). Voir ADR-029.

**Value Delivery:**

À la fin de cet epic, un développeur peut:

- Voir visuellement quelles capabilities ont été apprises par le système
- Explorer les relations hypergraph entre tools et capabilities
- Visualiser le code_snippet de chaque capability avec syntax highlighting
- Copier et réutiliser le code prouvé directement depuis le dashboard
- Filtrer et rechercher les capabilities par intent, success_rate, usage

**Décision Architecturale (ADR-029):** D3.js Force-Directed Graph

- Capability = node (violet)
- Tools = nodes connectés via edges (hyperedges supportés)
- Click capability → Code Panel avec syntax highlighting
- Toggle button: [Tools] [Capabilities] [Hypergraph]

> **Migration:** Originalement prévu avec Cytoscape.js compound graphs, mais migré vers D3.js pour
> supporter les hyperedges (un tool peut appartenir à plusieurs capabilities).

**Estimation:** 5 stories, ~1-2 semaines

---

### Story Breakdown - Epic 8

**Story 8.1: Capability Data API**

As a dashboard developer, I want API endpoints to fetch capabilities and hypergraph data, So that
the frontend can visualize the learned capabilities.

**Acceptance Criteria:**

1. Endpoint `GET /api/capabilities` créé
   - Response: `{ capabilities: Capability[], total: number }`
   - Capability includes: id, name, description, code_snippet, tools_used[], success_rate,
     usage_count, community_id
2. Query parameters supportés:
   - `?community_id=N` - Filter by Louvain community
   - `?min_success_rate=0.7` - Filter by quality
   - `?min_usage=2` - Filter by usage
   - `?limit=50&offset=0` - Pagination
3. Endpoint `GET /api/graph/hypergraph` créé
   - Response: `{ nodes: GraphNode[], edges: GraphEdge[], capabilities_count, tools_count }`
   - Nodes include both tools and capabilities with `type` field
4. Join sur `workflow_pattern` et `tool_schemas` pour récupérer metadata
5. Intent preview: premiers 100 caractères de l'intent embedding description
6. Tests HTTP: verify JSON structure, filters work correctly
7. OpenAPI documentation for both endpoints

**Prerequisites:** Epic 7 Story 7.2 (workflow_pattern table with code_snippet)

---

**Story 8.2: Compound Graph Builder**

As a system architect, I want a HypergraphBuilder class that converts capabilities to D3.js graph
nodes with hyperedge support, So that the visualization can represent N-ary relationships correctly.

**Acceptance Criteria:**

1. `HypergraphBuilder` class créée (`src/visualization/hypergraph-builder.ts`)
2. Method `buildCompoundGraph(capabilities: Capability[], tools: Tool[])` → GraphElements
3. Capability node structure:
   ```javascript
   {
     data: {
       id: 'cap-uuid-1',
       type: 'capability',
       label: 'Create Issue from File',
       code_snippet: 'await mcp.github...',
       success_rate: 0.95,
       usage_count: 12
     }
   }
   ```
4. Tool child node structure:
   ```javascript
   {
     data: {
       id: 'filesystem:read',
       parent: 'cap-uuid-1',  // Links to capability
       type: 'tool',
       server: 'filesystem'
     }
   }
   ```
5. Handle tools belonging to multiple capabilities (create separate instances with unique IDs)
6. Edge creation between tools within same capability (optional, can be toggled)
7. Include edges between capabilities if they share tools (cross-capability links)
8. Unit tests: verify compound structure correct for various capability configurations

**Prerequisites:** Story 8.1 (API endpoints ready)

---

**Story 8.3: Hypergraph View Mode**

As a power user, I want a "Hypergraph" view mode in the dashboard, So that I can visualize
capabilities as compound nodes containing their tools.

> **IMPORTANT:** Cette story DOIT intégrer le mode hypergraph dans le dashboard EXISTANT (Epic 6).
> Pas de nouvelle page - c'est un toggle de vue dans le même dashboard. **Requiert:** Consultation
> avec UX Designer agent avant implémentation pour valider l'intégration UI.

**Acceptance Criteria:**

1. Toggle button group in dashboard header: `[Tools] [Capabilities] [Hypergraph]`
   - **Intégration:** Utilise le header existant du dashboard Epic 6
   - **Transition:** Smooth animation entre les vues, même container graph
2. Hypergraph view uses `fcose` or `cola` layout (compound-aware)
3. Capability node styling:
   - Background: violet/purple (`#8b5cf6`)
   - Border: rounded rectangle
   - Label: capability name or intent preview
   - Expandable: click to show/hide children
4. Tool node styling: same as existing (colored by server)
5. Layout options:
   - Expand all capabilities (default)
   - Collapse all (show only capability nodes)
   - Mixed (user can expand/collapse individually)
6. Performance: render <500ms for 50 capabilities, 200 tools
7. Smooth transitions between view modes
8. Persist view mode preference in localStorage
9. Mobile responsive (optional, nice-to-have)

**Prerequisites:** Story 8.2 (HypergraphBuilder ready)

**UX Design Considerations (à valider avec UX Designer):**

- Comment cohabitent les 3 vues dans le même espace?
- Le graph container reste le même, seules les données changent
- Les filtres existants (Epic 6) s'appliquent-ils au mode Hypergraph?
- Position du Code Panel: sidebar droite ou modal?

---

**Story 8.4: Code Panel Integration**

As a developer, I want to see the code_snippet when I click on a capability, So that I can
understand what the capability does and copy the code.

**Acceptance Criteria:**

1. Code Panel component créé (sidebar or modal)
2. Appears on capability node click
3. Syntax highlighting using Prism.js or highlight.js (TypeScript syntax)
4. Code panel contents:
   - Capability name (editable if manual)
   - Intent/description
   - `code_snippet` with syntax highlighting
   - Stats: success_rate %, usage_count, last_used date
   - Tools used: list with server icons
5. Actions:
   - "Copy Code" button → clipboard with toast notification
   - "Try This" button → opens capability in execute_code context (future)
   - "Edit Name" → allows user to rename capability
6. Keyboard shortcuts:
   - `Esc` to close panel
   - `Cmd/Ctrl+C` to copy code when panel focused
7. Dark mode support (match dashboard theme)
8. Responsive: panel doesn't overflow on small screens

**Prerequisites:** Story 8.3 (Hypergraph view mode)

---

**Story 8.5: Capability Explorer**

As a user looking for reusable capabilities, I want to search and filter capabilities, So that I can
find relevant code patterns quickly.

**Acceptance Criteria:**

1. Search bar in Hypergraph view: search by name, description, or intent
2. Autocomplete suggestions while typing
3. Filter controls:
   - Success rate slider: 0% - 100%
   - Minimum usage count input
   - Community dropdown (Louvain clusters)
   - Date range: capabilities created/used in last X days
4. Sort options:
   - By usage_count (most used first)
   - By success_rate (highest quality first)
   - By last_used (recent first)
   - By created_at (newest first)
5. Results highlight:
   - Matching capabilities highlighted in graph
   - Non-matching capabilities dimmed (0.3 opacity)
6. "Try This Capability" action:
   - Pre-fills `execute_code` with capability code
   - Opens in new conversation or copies to clipboard
7. Export capabilities:
   - "Export Selected" → JSON file with code_snippets
   - "Export All" → Full capability dump
8. Bulk actions (optional):
   - Delete unused capabilities
   - Merge similar capabilities
9. Keyboard navigation: arrow keys to navigate results

**Prerequisites:** Story 8.4 (Code Panel working)

---

### Epic 8 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  PGlite                                                         │
│  ┌─────────────────┐      ┌─────────────────────┐              │
│  │ workflow_pattern│      │  tool_schemas       │              │
│  │ - code_snippet  │      │  - tool_id          │              │
│  │ - tools_used[]  │      │  - server           │              │
│  │ - intent_embed  │      │                     │              │
│  └────────┬────────┘      └──────────┬──────────┘              │
└───────────┼─────────────────────────┼───────────────────────────┘
            │                          │
            ▼                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  HypergraphBuilder                                              │
│  - buildCompoundGraph(capabilities, tools)                      │
│  - Returns D3.js graph elements with hyperedge support          │
└────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│  D3.js Force-Directed Graph (existing dashboard)                │
│  - d3-force layout with zoom/pan (d3-zoom)                     │
│  - Capability nodes: violet                                     │
│  - Tool nodes: colored by server (existing)                    │
│  - Hyperedges: tool can link to multiple capabilities          │
│  - Click capability → CodePanel with syntax highlighting       │
└─────────────────────────────────────────────────────────────────┘
```

---

### Epic 8 UI Preview

```
┌─────────────────────────────────────────────────────────────────┐
│  Dashboard Header                                               │
│  [Tools] [Capabilities] [Hypergraph]  ← View mode toggle       │
│  Search: [____________] Filters: [Success ≥ 70%] [Usage ≥ 2]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Graph Area                             │  │
│  │                                                           │  │
│  │   ┌─────────────────────────────┐                        │  │
│  │   │  Cap: Create Issue from File │ ← Compound node        │  │
│  │   │  success: 95% | usage: 12   │                        │  │
│  │   │  ┌───────┐  ┌────────────┐ │                        │  │
│  │   │  │fs:read│  │gh:issue    │ │                        │  │
│  │   │  └───────┘  └────────────┘ │                        │  │
│  │   └─────────────────────────────┘                        │  │
│  │                                                           │  │
│  │   ┌─────────────────────────────┐                        │  │
│  │   │  Cap: Parse Config          │                        │  │
│  │   │  ┌───────┐  ┌────────────┐ │                        │  │
│  │   │  │fs:read│  │json:parse  │ │                        │  │
│  │   │  └───────┘  └────────────┘ │                        │  │
│  │   └─────────────────────────────┘                        │  │
│  │                                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Code Panel (on capability click)                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Capability: Create Issue from File                       │  │
│  │  Tools: filesystem:read, github:create_issue              │  │
│  │                                                           │  │
│  │  const content = await mcp.filesystem.read("config.json");│  │
│  │  const data = JSON.parse(content);                        │  │
│  │  await mcp.github.createIssue({                           │  │
│  │    title: data.title,                                     │  │
│  │    body: data.description                                 │  │
│  │  });                                                      │  │
│  │                                                           │  │
│  │  [Copy Code] [Try This]                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│  Success: 95% | Usage: 12 | Last used: 2h ago                  │
└─────────────────────────────────────────────────────────────────┘

---
```
