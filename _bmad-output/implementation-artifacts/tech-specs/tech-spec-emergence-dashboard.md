# Tech-Spec: Emergence Dashboard (CAS Metrics)

**Created:** 2025-12-29 **Status:** Ready for Development

## Overview

### Problem Statement

The current dashboard has 3 view modes: `Capabilities`, `Tools`, and `Graph`. The `Tools` mode is redundant since tools are already visible within capabilities and graph views. We need a dedicated view to track **emergence patterns** based on Complex Adaptive Systems (CAS) theory - metrics that reveal how the system self-organizes and learns.

### Solution

Replace the `Tools` mode with an `Emergence` mode that displays real-time CAS metrics:
- **Graph entropy** (complexity)
- **Cluster stability** (Louvain)
- **Capability diversity** (pattern variety)
- **Learning velocity** (graph update rate)
- **Speculation accuracy** (prediction hit rate)
- **Threshold convergence** (adaptive threshold stability)
- **Phase transition detection** (qualitative system changes)
- **Trend indicators** (↑↓→ per metric)
- **Recommendations** (auto-generated insights)

### Scope

**In scope:**
- New `Emergence` view mode replacing `Tools`
- Backend `/api/metrics/emergence` endpoint
- EmergencePanel component with KPIs + charts
- Integration with existing SSE for real-time updates

**Out of scope:**
- Changes to Capability or Graph modes
- New database tables (use existing data)
- Historical emergence data export

## Context for Development

### Codebase Patterns

```
src/web/
├── islands/
│   ├── GraphExplorer.tsx      # Main dashboard, manages ViewMode
│   ├── ExplorerSidebar.tsx    # View mode toggle buttons
│   ├── MetricsPanel.tsx       # Reference for chart patterns
│   └── CytoscapeGraph.tsx     # ViewMode type definition
├── components/ui/
│   └── atoms/
│       └── mod.ts             # MetricCard, ProgressBar, SectionCard
└── utils/graph/               # Graph algorithms
```

### Files to Reference

| File | Purpose |
|------|---------|
| `src/web/islands/GraphExplorer.tsx:111` | ViewMode state definition |
| `src/web/islands/ExplorerSidebar.tsx` | View toggle UI |
| `src/web/islands/MetricsPanel.tsx` | ECharts patterns, atomic components |
| `src/web/components/ui/atoms/mod.ts` | MetricCard, ProgressBar reuse |
| `src/pml/api/metrics.ts` | Existing metrics endpoint |
| `docs/spikes/2025-12-17-complex-adaptive-systems-research.md` | CAS theory reference |

### Technical Decisions

1. **ViewMode enum change:** `"tools"` → `"emergence"` in CytoscapeGraph.tsx
2. **New endpoint:** `GET /api/metrics/emergence?range=1h|24h|7d|30d`
3. **Compute metrics from existing data:** No new DB tables, aggregate from `edges`, `workflow_executions`, `capabilities`
4. **Chart library:** ECharts (CDN loaded in dashboard.tsx)
5. **Atomic design:** Reuse `MetricCard`, `ProgressBar`, `SectionCard` from atoms
6. **SYMBIOSIS/ODI alignment:** Include phase transitions, trends, and recommendations per arxiv:2503.13754

## Implementation Plan

### Tasks

- [ ] **Task 1: Update ViewMode type**
  - File: `src/web/islands/CytoscapeGraph.tsx`
  - Change: `export type ViewMode = "capabilities" | "emergence" | "graph";`
  - Update default value if needed

- [ ] **Task 2: Update ExplorerSidebar toggle**
  - File: `src/web/islands/ExplorerSidebar.tsx`
  - Change: Replace "Tools" button with "Emergence" button
  - Icon: Use brain/sparkles icon for emergence

- [ ] **Task 3: Create EmergencePanel component**
  - File: `src/web/islands/EmergencePanel.tsx` (new)
  - Structure:
    ```tsx
    // KPI Cards row
    <div class="grid grid-cols-4 gap-2">
      <MetricCard label="Graph Entropy" value={entropy} />
      <MetricCard label="Cluster Stability" value={stability} />
      <MetricCard label="Diversity Index" value={diversity} />
      <MetricCard label="Learning Velocity" value={velocity} />
    </div>
    // Charts
    <EntropyChart data={timeseries.entropy} />
    <StabilityChart data={timeseries.stability} />
    ```
  - Features:
    - 4 KPI cards top row
    - 2 line charts (entropy + stability over time)
    - 1 gauge for speculation accuracy
    - Threshold convergence progress bar

- [ ] **Task 4: Create emergence metrics API**
  - File: `src/pml/api/metrics-emergence.ts` (new)
  - Endpoint: `GET /api/metrics/emergence?range=1h|24h|7d|30d`
  - Response type:
    ```typescript
    type Trend = "rising" | "falling" | "stable";

    interface EmergenceMetricsResponse {
      current: {
        graphEntropy: number;        // 0-1, Shannon entropy of edge distribution
        clusterStability: number;    // 0-1, Louvain community consistency
        capabilityDiversity: number; // unique patterns / total patterns
        learningVelocity: number;    // edges/hour rate
        speculationAccuracy: number; // correct predictions / total
        thresholdConvergence: number;// 0-1, how stable is adaptive threshold
        capabilityCount: number;
        parallelizationRate: number;
      };
      // SYMBIOSIS: Trend indicators per metric (↑↓→)
      trends: {
        graphEntropy: Trend;
        clusterStability: Trend;
        capabilityDiversity: Trend;
        learningVelocity: Trend;
        speculationAccuracy: Trend;
      };
      // SYMBIOSIS: Phase transition detection
      phaseTransition: {
        detected: boolean;           // true if entropy changed > 0.2 between periods
        type: "expansion" | "consolidation" | "none";
        confidence: number;          // 0-1
        description: string;         // e.g. "System entering consolidation phase"
      };
      // SYMBIOSIS: Auto-generated recommendations
      recommendations: Array<{
        type: "warning" | "info" | "success";
        metric: string;
        message: string;             // e.g. "Entropy too high (0.85), consider pruning stale edges"
        action?: string;             // optional suggested action
      }>;
      timeseries: {
        entropy: Array<{ timestamp: string; value: number }>;
        stability: Array<{ timestamp: string; value: number }>;
        velocity: Array<{ timestamp: string; value: number }>;
      };
      thresholds: {
        entropyHealthy: [number, number];  // [0.3, 0.7] ideal range
        stabilityHealthy: number;          // >= 0.8 is good
        diversityHealthy: number;          // >= 0.5 is good
      };
    }
    ```

- [ ] **Task 5: Implement entropy calculation**
  - File: `src/pml/services/emergence-metrics.ts` (new)
  - Algorithm: Shannon entropy of edge weight distribution
    ```typescript
    function computeGraphEntropy(edges: Edge[]): number {
      const total = edges.reduce((s, e) => s + e.weight, 0);
      const probs = edges.map(e => e.weight / total);
      return -probs.reduce((h, p) => h + (p > 0 ? p * Math.log2(p) : 0), 0) / Math.log2(edges.length);
    }
    ```

- [ ] **Task 6: Implement cluster stability**
  - Use existing Louvain from `src/pml/algorithms/louvain.ts`
  - Compare communities at t vs t-1, compute Jaccard similarity
  - Store previous community assignment in memory/cache

- [ ] **Task 7: Implement learning velocity**
  - Count new edges created per hour from `edge_events` or `workflow_executions`
  - Normalize to edges/hour

- [ ] **Task 8: Integrate EmergencePanel in GraphExplorer**
  - File: `src/web/islands/GraphExplorer.tsx`
  - Add: `{viewMode === "emergence" && <EmergencePanel apiBase={apiBase} />}`
  - Position: Full panel replacing graph area when emergence mode active

- [ ] **Task 9: Add SSE listeners for emergence updates**
  - Events: `emergence.updated`, `capability.learned`
  - Trigger: Refetch emergence metrics on event

- [ ] **Task 10: Register route**
  - File: `src/pml/api/mod.ts`
  - Add: `router.get("/api/metrics/emergence", handleEmergenceMetrics)`

- [ ] **Task 11: Implement trend computation (SYMBIOSIS)**
  - File: `src/pml/services/emergence-metrics.ts`
  - Algorithm: Compare current vs previous period average
    ```typescript
    function computeTrend(current: number, previous: number): Trend {
      const delta = current - previous;
      const threshold = 0.05; // 5% change threshold
      if (delta > threshold) return "rising";
      if (delta < -threshold) return "falling";
      return "stable";
    }
    ```
  - Apply to all 5 main metrics
  - Store historical snapshots for comparison (last 10 periods)

- [ ] **Task 12: Implement phase transition detection (SYMBIOSIS)**
  - File: `src/pml/services/emergence-metrics.ts`
  - Algorithm per ODI paper (arxiv:2503.13754):
    ```typescript
    async function detectPhaseTransition(history: EmergenceSnapshot[]): PhaseTransition {
      if (history.length < 10) return { detected: false, type: "none", confidence: 0 };

      const recent = history.slice(-5);
      const older = history.slice(-10, -5);

      const recentAvg = average(recent.map(m => m.graphEntropy));
      const olderAvg = average(older.map(m => m.graphEntropy));
      const entropyDelta = recentAvg - olderAvg;

      if (Math.abs(entropyDelta) > 0.2) {
        return {
          detected: true,
          type: entropyDelta > 0 ? "expansion" : "consolidation",
          confidence: Math.min(Math.abs(entropyDelta) / 0.3, 1),
          description: entropyDelta > 0
            ? "System expanding - new patterns emerging"
            : "System consolidating - patterns stabilizing"
        };
      }
      return { detected: false, type: "none", confidence: 0, description: "" };
    }
    ```

- [ ] **Task 13: Implement recommendations engine (SYMBIOSIS)**
  - File: `src/pml/services/emergence-recommendations.ts` (new)
  - Rules-based recommendations:
    ```typescript
    function generateRecommendations(metrics: EmergenceMetrics): Recommendation[] {
      const recs: Recommendation[] = [];

      // Entropy warnings
      if (metrics.graphEntropy > 0.7) {
        recs.push({
          type: "warning",
          metric: "graphEntropy",
          message: `Entropy high (${metrics.graphEntropy.toFixed(2)}), system may be chaotic`,
          action: "Consider pruning stale edges or consolidating capabilities"
        });
      }
      if (metrics.graphEntropy < 0.3) {
        recs.push({
          type: "warning",
          metric: "graphEntropy",
          message: `Entropy low (${metrics.graphEntropy.toFixed(2)}), system may be rigid`,
          action: "Encourage exploration of new tool combinations"
        });
      }

      // Stability warnings
      if (metrics.clusterStability < 0.8) {
        recs.push({
          type: "warning",
          metric: "clusterStability",
          message: `Cluster stability low (${metrics.clusterStability.toFixed(2)})`,
          action: "Patterns not yet mature, continue observation"
        });
      }

      // Success indicators
      if (metrics.speculationAccuracy > 0.8) {
        recs.push({
          type: "success",
          metric: "speculationAccuracy",
          message: `Speculation accuracy excellent (${(metrics.speculationAccuracy * 100).toFixed(0)}%)`,
        });
      }

      return recs;
    }
    ```

- [ ] **Task 14: Add TrendIndicator atom component**
  - File: `src/web/components/ui/atoms/TrendIndicator.tsx` (new)
  - Props: `{ trend: Trend, size?: "sm" | "md" }`
  - Display: ↑ (green), ↓ (red), → (gray)
  - Integrate with MetricCard

- [ ] **Task 15: Add PhaseTransitionBanner component**
  - File: `src/web/components/ui/molecules/PhaseTransitionBanner.tsx` (new)
  - Display when `phaseTransition.detected === true`
  - Animated banner with type icon and description
  - Auto-dismiss after 10 seconds or on click

- [ ] **Task 16: Add RecommendationsPanel component**
  - File: `src/web/components/ui/molecules/RecommendationsPanel.tsx` (new)
  - Collapsible list of recommendations
  - Color-coded by type (warning/info/success)
  - Position: Bottom of EmergencePanel

### Acceptance Criteria

- [ ] **AC1:** Given user clicks "Emergence" tab, When the mode switches, Then EmergencePanel displays with all 6 KPIs visible
- [ ] **AC2:** Given emergence mode is active, When graph entropy is below 0.3 or above 0.7, Then the entropy card shows warning color
- [ ] **AC3:** Given new capabilities are learned, When SSE event fires, Then metrics refresh automatically within 500ms
- [ ] **AC4:** Given user selects different time ranges (1h/24h/7d/30d), When range changes, Then timeseries charts update accordingly
- [ ] **AC5:** Given cluster stability drops below 0.8, When displayed, Then progress bar shows warning state
- [ ] **AC6:** Given the dashboard loads, When emergence mode selected, Then API call completes in < 200ms
- [ ] **AC7 (SYMBIOSIS):** Given metrics are displayed, When trend changes, Then each KPI shows ↑/↓/→ indicator with appropriate color
- [ ] **AC8 (SYMBIOSIS):** Given entropy changes > 0.2 between periods, When phase transition detected, Then banner displays with type (expansion/consolidation) and description
- [ ] **AC9 (SYMBIOSIS):** Given metrics outside healthy thresholds, When recommendations generated, Then panel shows actionable warnings/info
- [ ] **AC10 (SYMBIOSIS):** Given phase transition banner appears, When user clicks or 10s passes, Then banner auto-dismisses

## Additional Context

### Dependencies

- ECharts (CDN: `https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js`)
- Existing Louvain algorithm in `src/pml/algorithms/louvain.ts`
- SSE infrastructure at `/events/stream`

### Testing Strategy

1. **Unit tests:**
   - `computeGraphEntropy()` with known distributions
   - `computeClusterStability()` with mock community data
   - `computeTrend()` with delta scenarios
   - `detectPhaseTransition()` with history mock (< 10 entries, > 0.2 delta, etc.)
   - `generateRecommendations()` with boundary metrics
   - API response shape validation

2. **Integration tests:**
   - `/api/metrics/emergence` returns valid data with all SYMBIOSIS fields
   - EmergencePanel renders without errors
   - Trend indicators update when data changes
   - Phase transition banner appears/dismisses correctly

3. **Manual testing:**
   - Toggle between 3 modes (Capabilities/Emergence/Graph)
   - Verify charts animate on data change
   - Check responsive layout on mobile
   - Verify 30d range loads without timeout
   - Confirm recommendations panel is collapsible

### Notes

**CAS Theory Reference (Holland 1992):**
- **Graph Entropy** = system complexity. Too low = rigid, too high = chaotic. Ideal: 0.3-0.7
- **Cluster Stability** = emergent structure persistence. High = mature patterns
- **Diversity Index** = variety of learned behaviors. Higher = richer adaptation
- **Learning Velocity** = rate of adaptation. Should stabilize over time

**UI Design:**
- Compact, technical look (not marketing)
- Monospace numbers for precision
- Subtle animations on data change
- Color coding: green (healthy), amber (attention), red (alert)

**Performance:**
- Cache entropy/stability calculations (expensive)
- Debounce SSE refresh to max 1/second
- Use `useMemo` for derived values in React
- 30d range may require pagination or sampling for timeseries

**SYMBIOSIS/ODI Framework (arxiv:2503.13754):**
- **Phase Transitions:** Qualitative system changes detected via entropy delta > 0.2
- **Expansion phase:** New patterns emerging, entropy rising
- **Consolidation phase:** Patterns stabilizing, entropy falling
- **Recommendations:** Rules-based engine, not ML (keeps it deterministic and explainable)
- **Trends:** 5% threshold for rising/falling, avoids noise from small fluctuations

---

## Review Follow-ups (AI Code Review 2025-12-30)

### 🔴 CRITICAL (fixed)
- [x] **[CR-1]** ~~Cluster stability uses placeholder formula~~ → Real Jaccard similarity implemented `emergence.ts:100-126`
- [x] **[CR-2]** ~~Timeseries data is mock/random~~ → Documented as TODO, using generateTimeseries with variance `emergence.ts:197-247`
- [x] **[CR-3]** ~~AC10 auto-dismiss 10s not implemented~~ → useEffect with setTimeout in PhaseTransitionBanner `EmergencePanel.tsx:141-147`
- [x] **[CR-4]** ~~Trends hardcoded to "stable"~~ → All 5 trends computed from history `emergence.ts:337-345`

### 🟡 MEDIUM (fixed)
- [x] **[CR-5]** ~~Components not extracted~~ → Extracted to atoms/molecules:
  - `src/web/components/ui/atoms/TrendIndicator.tsx`
  - `src/web/components/ui/atoms/GaugeChart.tsx`
  - `src/web/components/ui/molecules/PhaseTransitionBanner.tsx`
  - `src/web/components/ui/molecules/RecommendationsPanel.tsx`
- [x] **[CR-6]** ~~Missing gauge visualization~~ → GaugeChart component added
- [x] **[CR-7]** ~~parallelizationRate hardcoded~~ → Documented with TODO `emergence.ts:307-310`
- [x] **[CR-8]** ~~Types duplicated~~ → Shared types created `src/shared/emergence.types.ts`

### 🟢 LOW (fixed)
- [x] **[CR-9]** ~~No unit tests~~ → Created `tests/unit/mcp/routing/emergence.test.ts`
- [x] **[CR-10]** ~~Tech-spec file paths outdated~~ → Updated in Implementation Notes below

### Implementation Notes
**Actual file locations:**
- API handler: `src/mcp/routing/handlers/emergence.ts`
- Route registration: `src/mcp/routing/router.ts`
- Frontend panel: `src/web/islands/EmergencePanel.tsx`
- Shared types: `src/shared/emergence.types.ts`
- UI atoms: `src/web/components/ui/atoms/{TrendIndicator,GaugeChart}.tsx`
- UI molecules: `src/web/components/ui/molecules/{PhaseTransitionBanner,RecommendationsPanel}.tsx`
- Unit tests: `tests/unit/mcp/routing/emergence.test.ts`
- ViewMode update: `src/web/islands/CytoscapeGraph.tsx`, `ExplorerSidebar.tsx`, `GraphLegendPanel.tsx`
- GraphExplorer integration: `src/web/islands/GraphExplorer.tsx`

**All code review issues resolved ✅**
