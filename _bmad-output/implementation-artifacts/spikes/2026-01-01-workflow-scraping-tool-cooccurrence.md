# Spike: Workflow Scraping & Tool Co-occurrence for DR-DSP

**Date:** 2026-01-01
**Updated:** 2026-01-04
**Status:** MVP Implemented
**Related:** DR-DSP, SHGAT, pml:discover, pml:execute

## Context

### Current Architecture Gap

| API | Returns | Actionable |
|-----|---------|------------|
| `pml:discover` | tools + capabilities | Tools = informational only |
| `pml:execute` | capabilities only | Cannot suggest tools |
| `DAGSuggester` | capabilities only | Via CapabilityMatcher |

**Problem:** DR-DSP needs hyperedges to find paths. Without capabilities, no paths exist. Cold-start problem: new system has no capabilities → no suggestions.

### DR-DSP Hyperedge Structure

```typescript
interface Hyperedge {
  id: string;
  sources: string[];  // Input tools
  targets: string[];  // Output tools
  weight: number;     // Lower = better
}
```

**Key insight:** A simple edge `A → B` is a valid hyperedge with `sources: [A], targets: [B]`. DR-DSP doesn't require multi-node hyperedges.

## Proposal: Prior Patterns from Workflow Scraping

### Data Sources

| Source | Type | Accessibility |
|--------|------|---------------|
| **n8n** | Open source | Templates publicly available, API accessible |
| **Make** (Integromat) | Commercial | Template gallery, some public |
| **Zapier** | Commercial | Restrictive ToS, limited access |
| **Pipedream** | Open source | Good API access |
| **Activepieces** | Open source | Full access |

### What to Extract

```typescript
interface ScrapedWorkflow {
  source: "n8n" | "make" | "zapier" | "pipedream";
  nodes: Array<{
    service: string;    // "Google Sheets"
    action: string;     // "Read Row"
  }>;
  edges: Array<{
    from: number;       // node index
    to: number;
  }>;
  popularity?: number;  // downloads, uses
  isOfficial: boolean;
  lastUpdated: Date;
}
```

### Mapping to MCP Tools

```
Zapier "Google Sheets → Read Row"
   ↓ mapping (embedding similarity or manual)
MCP "mcp__google__sheets_read"
```

**Challenge:** Mapping confidence varies. Need to track:
- Exact match (manual mapping) → confidence 1.0
- Embedding similarity > 0.9 → confidence 0.8
- Fuzzy match → confidence 0.5

## Weight Calculation

### Option 1: Frequency-based (Simple)

```typescript
weight = BASE_PENALTY / Math.log(frequency + 1)

// Examples:
// sheets→slack (freq: 847) → weight = 0.68
// obscure→tool (freq: 3)   → weight = 3.3
```

### Option 2: Multi-factor (Complete)

```typescript
function calculateWeight(pattern: ScrapedPattern): number {
  const BASE_PENALTY = 2.0;  // Non-tested locally

  const freqBoost = Math.log10(pattern.frequency + 1);
  const trust = pattern.isOfficial ? 1.0 : 0.7;
  const recency = Math.exp(-0.1 * monthsOld(pattern.lastSeen));
  const mappingConf = pattern.mappingConfidence;

  return BASE_PENALTY / (freqBoost * trust * recency * mappingConf);
}
```

### Option 3: Bucket (MVP)

```typescript
function bucketWeight(frequency: number): number {
  if (frequency >= 100) return 0.5;  // Very common
  if (frequency >= 10)  return 1.0;  // Common
  return 2.0;                         // Rare
}
```

## Integration with DR-DSP

### New Function: `injectPriorPatterns`

```typescript
// In dr-dsp.ts
export function injectPriorPatterns(
  drdsp: DRDSP,
  patterns: PriorPattern[],
): void {
  for (const pattern of patterns) {
    drdsp.addHyperedge({
      id: `prior:${pattern.from}-${pattern.to}`,
      sources: [pattern.from],
      targets: [pattern.to],
      weight: pattern.weight,
      metadata: {
        origin: pattern.source,
        frequency: pattern.frequency,
        isPrior: true,  // Flag to distinguish from real capabilities
      },
    });
  }
}
```

### Storage Options

| Option | Pros | Cons |
|--------|------|------|
| **JSON file** | Simple, versionable | No dynamic updates |
| **DB table `workflow_pattern`** | Queryable, updatable | More complexity |
| **In-memory only** | Fast | Lost on restart |

**Recommendation:** Start with JSON file, migrate to DB if needed.

```typescript
// workflow-patterns.json
{
  "version": "1.0",
  "scraped_at": "2026-01-01",
  "patterns": [
    {
      "from": "google:sheets_read",
      "to": "slack:post_message",
      "weight": 0.5,
      "frequency": 847,
      "source": "n8n",
      "isOfficial": true
    }
  ]
}
```

## V-V Co-occurrence Matrix (Tool-Tool)

### Current State

| Component | What we have | What's missing |
|-----------|--------------|----------------|
| **BGE** | Semantic embeddings (1024D) | ✅ Done |
| **Spectral** | Cluster ID only (`spectralCluster: number`) | Not a real embedding |
| **Node2Vec** | Benchmarked (+757% MRR) | ❌ Not implemented |
| **V-V matrix** | None | No tool co-occurrence data |

### What Scraped Patterns Provide

The scraped workflows build a **V-V co-occurrence matrix**:

```typescript
// Tool-Tool adjacency matrix from patterns
type CooccurrenceMatrix = Map<string, Map<string, number>>;

// Example:
// cooccurrence["sheets:read"]["slack:post"] = 847
// cooccurrence["sheets:read"]["notion:create"] = 234
// cooccurrence["github:issue"]["slack:post"] = 156

function buildCooccurrenceMatrix(patterns: ScrapedPattern[]): CooccurrenceMatrix {
  const matrix = new Map<string, Map<string, number>>();

  for (const pattern of patterns) {
    if (!matrix.has(pattern.from)) {
      matrix.set(pattern.from, new Map());
    }
    const current = matrix.get(pattern.from)!.get(pattern.to) ?? 0;
    matrix.get(pattern.from)!.set(pattern.to, current + pattern.frequency);
  }

  return matrix;
}
```

### Usage of V-V Matrix

#### 1. DR-DSP Pathfinding (Immediate)
```typescript
// Convert co-occurrence to edges
for (const [from, targets] of cooccurrence) {
  for (const [to, count] of targets) {
    drdsp.addHyperedge({
      id: `prior:${from}-${to}`,
      sources: [from],
      targets: [to],
      weight: 1 / Math.log(count + 1),
    });
  }
}
```

#### 2. Direct Scoring Signal (Short-term, no Node2Vec)
```typescript
// In SHGAT scoring, use co-occurrence as structural signal
function getStructuralSimilarity(toolA: string, toolB: string): number {
  const count = cooccurrence.get(toolA)?.get(toolB) ?? 0;
  return Math.min(1.0, count / 100);  // Normalize
}
```

#### 3. Node2Vec Training (Future)
```typescript
// When Node2Vec is implemented
const adjacencyMatrix = cooccurrenceToAdjacency(cooccurrence);
const node2vecEmbeddings = trainNode2Vec(adjacencyMatrix, {
  dimensions: 128,
  walkLength: 80,
  numWalks: 10,
  p: 1,  // Return parameter
  q: 1,  // In-out parameter
});
// → Each tool gets a 128D structural embedding
```

### Benchmark Reference (from spike 2026-01-01-node2vec)

| Method | MRR | Improvement |
|--------|-----|-------------|
| BGE only | 0.041 | baseline |
| BGE + Node2Vec | 0.355 | **+757%** |
| BGE + Spectral | < 0.355 | worse than Node2Vec |

Node2Vec captures **local co-occurrence patterns** (random walks) which is exactly what scraped workflows provide.

## SHGAT Integration

Prior patterns can inform SHGAT K-head attention:

1. **V-V co-occurrence matrix** from scraped patterns
2. **Direct signal** (short-term): use co-occurrence counts in scoring
3. **Node2Vec embeddings** (future): structural embeddings for tools
4. **Pre-train attention weights** on common sequences

```typescript
// Short-term: inject co-occurrence as feature
interface ToolFeatures {
  semanticEmbedding: number[];  // BGE (1024D)
  cooccurrenceVector: number[]; // From V-V matrix (sparse)
}

// Future: full Node2Vec embeddings
interface ToolFeatures {
  semanticEmbedding: number[];  // BGE (1024D)
  structuralEmbedding: number[]; // Node2Vec (128D)
}
```

## Benefits

1. **Cold-start solution:** New users get useful suggestions immediately
2. **DR-DSP pathfinding:** Has edges to traverse even without local capabilities
3. **SHGAT pre-training:** Attention heads start with real-world patterns
4. **Graceful degradation:** Prior patterns used when no local capability matches

## Concerns & Mitigations

| Concern | Mitigation |
|---------|------------|
| Stale patterns | Recency decay in weight calculation |
| Bad mappings | Confidence factor, manual curation for top patterns |
| Legal (ToS) | Focus on open source (n8n, Pipedream, Activepieces) |
| Pollution | Flag `isPrior: true`, lower priority than local capabilities |

## Implementation (2026-01-04)

### Files Created

```
src/graphrag/workflow-patterns/
├── types.ts          # Type definitions (N8nWorkflow, ScrapedPattern, PriorPattern, etc.)
├── n8n-scraper.ts    # Fetches workflows from n8n API, extracts edges
├── tool-mapper.ts    # Maps n8n node types → MCP tool IDs
├── pattern-store.ts  # Persists patterns to JSON
└── mod.ts            # Public exports

src/cli/commands/workflows.ts  # Added 'scrape' subcommand
config/workflow-patterns.json  # Output file (generated)
```

### n8n API Structure

**Key discovery:** The API has nested structure:
```typescript
// GET /templates/workflows/{id}
{
  workflow: {           // Metadata (id, name, description, totalViews)
    workflow: {         // Actual n8n workflow JSON
      nodes: [...],
      connections: {...}
    }
  }
}
```

### MCP Tool Mapping

Maps n8n nodes to **real MCP tool IDs** from official servers:

| n8n Node | MCP Server | Tools |
|----------|------------|-------|
| `n8n-nodes-base.readWriteFile` | `@modelcontextprotocol/server-filesystem` | `read_text_file`, `write_file`, `list_directory` |
| `n8n-nodes-base.httpRequest` | `@modelcontextprotocol/server-fetch` | `fetch` |
| `n8n-nodes-base.git` | `@modelcontextprotocol/server-git` | `git_status`, `git_commit`, `git_log` |
| `n8n-nodes-base.slack` | `@anthropic/slack-mcp` | `slack_post_message`, `slack_get_channel_history` |
| `n8n-nodes-base.github` | `@anthropic/github-mcp` | `github_create_issue`, `github_get_file_contents` |

### CLI Command

```bash
# Quick test (5 workflows)
deno task cli workflows scrape --limit 5

# Full scrape with options
deno task cli workflows scrape \
  --limit 100 \
  --min-views 1000 \
  --delay 200 \
  --output config/workflow-patterns.json
```

### Test Results

**Initial test (5 workflows):**
```
Workflows: 5 → Edges: 77 → Patterns: 39 → Mapped: 24 (61.5%)
```

**Full scrape (499 workflows):**
```
Workflows: 499
Raw patterns: 1827
Mapped (prior patterns): 294 (16%)
```

**Top patterns by frequency:**
| From | To | Frequency |
|------|-----|-----------|
| `openai:chat` | `sequential-thinking:sequential_thinking` | 249 |
| `fetch:fetch` | `fetch:fetch` | 202 |
| `memory:create_entities` | `sequential-thinking:sequential_thinking` | 129 |
| `transform:set` | `fetch:fetch` | 116 |
| `fetch:fetch` | `code:execute` | 80 |
| `google:chat` | `sequential-thinking:sequential_thinking` | 78 |
| `code:execute` | `fetch:fetch` | 78 |

### Weight Calculation (Implemented)

```typescript
function calculateWeight(frequency: number, mappingConfidence: number): number {
  const BASE_PENALTY = 2.0;
  const freqBoost = Math.log10(frequency + 1);
  return BASE_PENALTY / (freqBoost * mappingConfidence);
}
```

### Mapping Strategy: Pure Operations vs MCP Tools

**Decision:** Prioritize `code:*` pure operations for data transformation nodes.

| n8n Node Type | Mapping Target | Rationale |
|---------------|----------------|-----------|
| Code (JS) | `code:map` | Data transformation |
| Set | `code:Object.assign` | Object manipulation |
| Filter | `code:filter` | Array filtering |
| Merge | `code:concat` | Array concatenation |
| Sort | `code:sort` | Array sorting |
| JSON parse | `code:JSON.parse` | JSON operations |
| LLM nodes | `sampling:createMessage` | MCP sampling |
| HTTP nodes | `http:http_*` | MCP tools |
| Connectors | `github:*`, `slack:*` | MCP tools |

**Benefits:**
- Pure operations are traced automatically in sandbox
- No external dependencies for data transformations
- Deterministic, cacheable results
- MCP tools reserved for actual side effects (I/O, network)

### Known Limitations

1. **Triggers:** `chatTrigger`, `telegramTrigger`, `webhookTrigger` - not mappable (input sources)
2. **Wait/Delay:** `n8n-nodes-base.wait` - timer, not a tool operation
3. **Third-party nodes:** `@blotato/*` and custom community nodes - skip
4. **Smithery:** Connection issues prevent dynamic tool discovery (see spike 2026-01-04-smithery-connection-investigation.md)

## Next Steps

1. [x] Prototype n8n template scraper
2. [x] Build tool name mapping (n8n names → MCP tool IDs)
3. [ ] Implement `injectPriorPatterns()` in DR-DSP
4. [x] Create `workflow-patterns.json` with patterns
5. [ ] Build V-V co-occurrence matrix from patterns
6. [ ] Add co-occurrence signal to SHGAT scoring (short-term, pre-Node2Vec)
7. [ ] Implement Node2Vec on V-V matrix (future)
8. [ ] Evaluate impact on pathfinding quality
9. [x] Add mappings for pure operations (code:*) - filter, map, Object.assign, JSON.parse, etc.
10. [x] Scale scrape to 100 workflows (99 done, 679 patterns, 306 mapped = 45.1% coverage)

## Open Questions

1. Should prior patterns eventually "graduate" to real capabilities after local execution?
2. How to handle pattern conflicts (different sources, different weights)?
3. Should we expose pattern origin in `pml:discover` results?
4. Should `pml:execute` suggest tools (not just capabilities) when using prior patterns?
5. How to combine local execution co-occurrence with scraped co-occurrence?
