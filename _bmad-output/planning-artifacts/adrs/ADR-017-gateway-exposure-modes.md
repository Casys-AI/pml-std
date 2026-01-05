# ADR-017: Gateway Exposure Modes

**Status:** 📝 Draft **Date:** 2025-11-24 | **Deciders:** BMad | **Related:** ADR-013

---

## Context

### Problem Statement

Casys PML has an **architectural inconsistency** between documented vision and implementation
regarding how tools are exposed to Claude Code:

**PRD Vision (docs/PRD.md, line 7):**

> "Casys PML acts as a **transparent MCP gateway** that consolidates all your MCP servers into a
> single entry point"

**ADR-013 Reality (Accepted 2025-11-14):**

> "Meta-Tools Only with semantic discovery via `execute_workflow`"
>
> - Gateway exposes ONLY 2-3 meta-tools
> - Direct tool access NOT exposed in `tools/list`
> - Forces intent-based workflow pattern

**README Examples (Obsolete):**

```typescript
// Example implies direct tool access
await callTool("filesystem:read_file", { path: "/config.json" });
// ❌ Does NOT work - tool not in tools/list
```

### Impact

**1. User Friction:**

- Users expect transparent proxy (call any tool directly)
- Discover intent-based forced pattern (must use `execute_workflow`)
- Mental model change: tool calls → workflow intents
- Adoption barrier for users wanting "drop-in replacement"

**2. Documentation Drift:**

- README examples don't match reality
- PRD promises transparent gateway
- New users confused by discrepancy

**3. Competitive Positioning:**

- AIRIS, Smithery, Context Forge: Transparent proxies
- Casys PML: Meta-tools only (different paradigm)
- May limit addressable market to "advanced users"

### Discovery Source

Comprehensive audit (2025-11-24) identified this architectural drift as:

- **Severity:** MEDIUM (DX degradation)
- **Priority:** P1 (resolve before launch)
- **Impact:** Adoption friction, documentation inconsistency

---

## Decision Drivers

### Key Considerations

1. **Context Optimization Goal:** Maintain <5% context usage
2. **Backward Compatibility:** Don't break existing intent-based workflows
3. **User Experience:** Minimize adoption friction
4. **Competitive Differentiation:** GraphRAG + semantic discovery unique, but transparent proxy
   expected
5. **Implementation Complexity:** Solution must be feasible in Sprint 1 (1 week)

### Stakeholder Feedback

**Early Adopters (Hypothetical Beta Program):**

- Want transparent proxy for "simple" tool calls
- Appreciate intent-based for complex workflows
- Confused when direct tool access fails

**Power Users:**

- Prefer intent-based (less verbose)
- But want fallback to direct access for debugging

**Developers:**

- Need transparent proxy for migration from direct MCP
- Willing to learn intent-based after onboarding

---

## Options Considered

### Option A: Revert to Full Transparent Proxy

**Description:** Remove ADR-013 meta-tools restriction. Expose all underlying tools in `tools/list`.

**Implementation:**

```typescript
async handleListTools(request: unknown): Promise<ListToolsResult> {
  // Load ALL tools from all MCP servers
  const allTools = await this.loadAllTools();
  return { tools: allTools }; // 687 tools exposed
}
```

**Pros:**

- ✅ Matches PRD vision ("transparent gateway")
- ✅ Zero adoption friction (drop-in replacement)
- ✅ Aligns with competitors (AIRIS, Smithery)
- ✅ README examples work as-is

**Cons:**

- ❌ **Defeats context optimization goal** (30-50% context saturation)
- ❌ ADR-013 rationale invalid (44.5k tokens → 500 tokens lost)
- ❌ Loses semantic discovery competitive advantage
- ❌ GraphRAG underutilized (no intent-based workflows)

**Verdict:** ❌ **REJECTED** - Violates core value proposition (context optimization)

---

### Option B: Keep Meta-Tools Only (Status Quo + Documentation Fix)

**Description:** Maintain ADR-013 as-is. Update PRD, README to clarify meta-tools only paradigm.

**Implementation:**

````markdown
# README.md (Updated)

Casys PML uses **semantic intent-based workflows** instead of direct tool calls.

## ❌ OLD (Direct Tool Calls)

```typescript
await callTool("filesystem:read_file", { path: "/config.json" });
```
````

## ✅ NEW (Intent-Based Workflows)

```typescript
await executeWorkflow("Read the config.json file");
```

**Pros:**

- ✅ Maintains ADR-013 rationale (context optimization)
- ✅ Forces best practice (semantic discovery)
- ✅ Zero implementation effort (doc-only fix)
- ✅ Preserves competitive differentiation

**Cons:**

- ❌ Adoption friction remains (paradigm shift required)
- ❌ Migration from direct MCP harder
- ❌ Debugging difficult (can't call specific tool for testing)
- ❌ Competitive disadvantage vs transparent proxies

**Verdict:** ⚠️ **FALLBACK** - Low effort, but friction remains

---

### Option C: Hybrid Mode (Configurable Exposure) ✅ RECOMMENDED

**Description:** Support BOTH transparent proxy AND meta-tools via configuration. Default to
meta-tools (ADR-013), allow opt-in to hybrid/full proxy.

**Implementation:**

#### 1. Configuration Extension

```typescript
// src/mcp/types.ts
export interface GatewayConfig {
  name: string;
  version: string;

  /**
   * Tool exposure mode
   * - "meta_only": Expose only meta-tools (execute_workflow, search_tools) [DEFAULT]
   * - "semantic": Expose meta-tools + semantic-filtered underlying tools
   * - "hybrid": Expose both meta-tools AND selected underlying tools
   * - "full_proxy": Expose ALL underlying tools (transparent proxy mode)
   */
  tools_exposure: "meta_only" | "semantic" | "hybrid" | "full_proxy";

  hybrid?: {
    expose_meta_tools: boolean; // Default: true
    expose_underlying_tools: boolean; // Default: true
    apply_semantic_filter: boolean; // Default: true (filter by relevance)
    max_underlying_tools: number; // Default: 50 (cap for context)
    semantic_threshold: number; // Default: 0.6 (relevance cutoff)
    whitelisted_tools?: string[]; // Explicitly include tools
    blacklisted_tools?: string[]; // Explicitly exclude tools
  };
}
```

#### 2. Dynamic List Tools Handler

```typescript
// src/mcp/gateway-server.ts
async handleListTools(request: ListToolsRequest): Promise<ListToolsResult> {
  const mode = this.config.tools_exposure ?? "meta_only";

  switch (mode) {
    case "meta_only":
      // ADR-013: Only meta-tools
      return { tools: this.metaTools };

    case "semantic": {
      // Meta-tools + semantic-filtered underlying tools
      const query = request.params?.query || ""; // Intent/context hint
      const filteredTools = query
        ? await this.getSemanticFilteredTools(query, this.config.hybrid?.max_underlying_tools ?? 50)
        : [];
      return { tools: [...this.metaTools, ...filteredTools] };
    }

    case "hybrid": {
      // Configurable hybrid mode
      const metaTools = this.config.hybrid?.expose_meta_tools !== false
        ? this.metaTools
        : [];

      const underlyingTools = this.config.hybrid?.expose_underlying_tools
        ? await this.getHybridUnderlyingTools(
            request.params?.query,
            this.config.hybrid
          )
        : [];

      return { tools: [...metaTools, ...underlyingTools] };
    }

    case "full_proxy":
      // Transparent proxy: ALL tools
      const allTools = await this.loadAllTools();
      return { tools: allTools };

    default:
      // Fallback to meta_only
      log.warn(`Unknown tools_exposure mode: ${mode}, defaulting to meta_only`);
      return { tools: this.metaTools };
  }
}

private async getHybridUnderlyingTools(
  query: string | undefined,
  config: GatewayConfig["hybrid"]
): Promise<MCPTool[]> {
  let tools: MCPTool[] = [];

  // 1. Whitelist (explicitly included tools)
  if (config?.whitelisted_tools) {
    const whitelisted = await this.loadToolsByIds(config.whitelisted_tools);
    tools.push(...whitelisted);
  }

  // 2. Semantic filter (if query provided and enabled)
  if (query && config?.apply_semantic_filter) {
    const semanticTools = await this.vectorSearch.searchTools(
      query,
      config.max_underlying_tools ?? 50,
      config.semantic_threshold ?? 0.6
    );
    tools.push(...semanticTools);
  } else if (!config?.apply_semantic_filter) {
    // No semantic filter: Load all tools (up to max)
    const allTools = await this.loadAllTools();
    tools.push(...allTools.slice(0, config?.max_underlying_tools ?? 50));
  }

  // 3. Blacklist (exclude explicitly blocked tools)
  if (config?.blacklisted_tools) {
    tools = tools.filter(t => !config.blacklisted_tools!.includes(t.name));
  }

  // 4. Deduplicate
  const uniqueTools = new Map<string, MCPTool>();
  for (const tool of tools) {
    uniqueTools.set(tool.name, tool);
  }

  return Array.from(uniqueTools.values());
}
```

#### 3. Configuration Presets

```yaml
# config/gateway-presets.yaml

# Preset 1: Meta-Only (ADR-013, Default)
meta_only:
  tools_exposure: "meta_only"
  # Context: ~500 tokens (2-3 meta-tools)
  # Use case: Advanced users, intent-based workflows

# Preset 2: Hybrid Balanced
hybrid_balanced:
  tools_exposure: "hybrid"
  hybrid:
    expose_meta_tools: true
    expose_underlying_tools: true
    apply_semantic_filter: true
    max_underlying_tools: 20
    semantic_threshold: 0.7
  # Context: ~3-5k tokens (balanced)
  # Use case: Power users, mixed workflows

# Preset 3: Hybrid Permissive
hybrid_permissive:
  tools_exposure: "hybrid"
  hybrid:
    expose_meta_tools: true
    expose_underlying_tools: true
    apply_semantic_filter: true
    max_underlying_tools: 50
    semantic_threshold: 0.5
  # Context: ~8-10k tokens (more tools)
  # Use case: Developers, testing/debugging

# Preset 4: Full Proxy (Migration Mode)
full_proxy:
  tools_exposure: "full_proxy"
  # Context: 30-50% saturation (687 tools)
  # Use case: Migration from direct MCP, legacy workflows
```

#### 4. Migration Path

````markdown
## Migration Guide: Direct MCP → Casys PML

### Phase 1: Full Proxy (Week 1-2)

Start with transparent proxy to minimize disruption:

```yaml
# ~/.pml/config.yaml
gateway:
  tools_exposure: "full_proxy"
```
````

All existing tool calls work unchanged.

### Phase 2: Hybrid Permissive (Week 3-4)

Introduce semantic filtering:

```yaml
gateway:
  tools_exposure: "hybrid"
  hybrid:
    max_underlying_tools: 50
    semantic_threshold: 0.5
```

Context usage reduced 50%, most tools still accessible.

### Phase 3: Hybrid Balanced (Month 2)

Tighten semantic filter:

```yaml
gateway:
  tools_exposure: "hybrid"
  hybrid:
    max_underlying_tools: 20
    semantic_threshold: 0.7
```

Context usage <10%, learn intent-based patterns.

### Phase 4: Meta-Only (Month 3+)

Full intent-based workflows:

```yaml
gateway:
  tools_exposure: "meta_only"
```

Context usage <5%, maximum efficiency.

````
**Pros:**
- ✅ **Satisfies both paradigms** (transparent proxy + intent-based)
- ✅ **Smooth migration path** (full_proxy → hybrid → meta_only)
- ✅ **Configurable per use case** (debugging, production, migration)
- ✅ **Preserves ADR-013 benefits** (meta_only still default)
- ✅ **Reduces adoption friction** (users choose their comfort level)
- ✅ **Aligns PRD + Implementation** (both are valid modes)

**Cons:**
- ⚠️ Implementation complexity (1 week vs doc-only)
- ⚠️ Configuration surface area increases (more options = more complexity)
- ⚠️ Need to document trade-offs clearly (context vs convenience)

**Verdict:** ✅ **RECOMMENDED** - Best balance of flexibility, adoption, and vision

---

### Option D: Semantic Automatic Filtering

**Description:**
Always expose underlying tools, but apply semantic filtering based on conversation context automatically.

**Implementation:**
```typescript
async handleListTools(request: ListToolsRequest): Promise<ListToolsResult> {
  // Extract intent from recent conversation context
  const contextHint = this.extractIntentFromContext();

  // Semantic search for relevant tools
  const relevantTools = await this.vectorSearch.searchTools(
    contextHint,
    30, // Top 30 tools
    0.6  // Relevance threshold
  );

  return { tools: [...this.metaTools, ...relevantTools] };
}
````

**Pros:**

- ✅ Automatic context optimization (no user config)
- ✅ Exposes underlying tools (satisfies PRD)
- ✅ Semantic discovery always active

**Cons:**

- ❌ Context extraction unreliable (conversation may be vague)
- ❌ Non-deterministic (tool list changes based on context)
- ❌ Debugging difficult (which tools available?)
- ❌ Complex implementation (conversation analysis)

**Verdict:** ❌ **REJECTED** - Too magical, unpredictable

---

## Decision

**ACCEPT Option C: Hybrid Mode (Configurable Exposure)**

### Rationale

1. **Flexibility:** Supports all use cases (migration, debugging, production)
2. **Backward Compatible:** ADR-013 meta_only remains default
3. **Reduces Friction:** Users choose paradigm (proxy vs intent)
4. **Aligns Vision:** PRD transparent proxy is a valid mode
5. **Competitive:** Unique among gateways (configurable paradigm)

### Default Configuration

```yaml
# ~/.pml/config.yaml (default)
gateway:
  tools_exposure: "meta_only" # ADR-013 preserved as default
```

Users opt-in to hybrid/full_proxy as needed.

---

## Consequences

### Positive

1. **Adoption Acceleration:**
   - Migration users start with full_proxy → smooth onboarding
   - Gradual learning curve (proxy → hybrid → meta_only)
   - Debugging easier (full_proxy for testing)

2. **Documentation Clarity:**
   - PRD vision valid (transparent proxy is a mode)
   - README examples work (in full_proxy mode)
   - Clear migration guide (4 phases)

3. **Competitive Positioning:**
   - "Only gateway with configurable paradigm"
   - Appeals to both direct-tool users AND intent-based power users
   - Lowers barrier to entry

4. **Flexibility:**
   - Per-project configuration (dev vs prod)
   - Whitelisting for security (restrict dangerous tools)
   - Semantic filtering for context optimization

### Negative

1. **Implementation Effort:**
   - 1 week Sprint 1 (vs doc-only fix)
   - Testing matrix increases (4 modes × multiple scenarios)
   - Configuration validation required

2. **Documentation Burden:**
   - Must explain trade-offs (context vs convenience)
   - Migration guide required
   - Preset configurations to simplify choice

3. **Potential Confusion:**
   - More options = decision paralysis for some users
   - Need clear recommendations (start with full_proxy for migration)

### Mitigation

1. **Smart Defaults:**
   - meta_only default (ADR-013 preserved)
   - Presets with clear names (migration, balanced, advanced)
   - CLI wizard: `pml config --wizard`

2. **Documentation:**
   - Decision tree: "Which mode is right for me?"
   - Video tutorial: Migration path walkthrough
   - Performance comparison table (context usage per mode)

3. **Observability:**
   - Log current mode on startup
   - Warning if full_proxy used (context saturation risk)
   - Metrics: Track mode adoption (telemetry)

---

## Implementation Plan

### Sprint 1 (1 week)

**Day 1-2: Core Implementation**

- Add `tools_exposure` config field
- Implement mode switcher in `handleListTools()`
- Add `getHybridUnderlyingTools()` helper

**Day 3: Presets & Validation**

- Create `config/gateway-presets.yaml`
- Add config validation (Zod schema)
- CLI: `pml config --preset hybrid_balanced`

**Day 4-5: Testing & Documentation**

- Integration tests (4 modes × 3 scenarios)
- Update README with mode comparison table
- Create migration guide
- Update architecture.md

**Effort:** 5 days (1 week Sprint 1)

### Sprint 2 (ongoing)

**Telemetry & Analytics:**

- Track mode usage (anonymous)
- Context usage per mode (validate optimization)
- Conversion tracking (full_proxy → meta_only journey)

**UX Improvements:**

- CLI wizard: `pml config --wizard`
- Config validation warnings
- Performance dashboard (context usage real-time)

---

## Alternatives Rejected

**Option A (Full Transparent Proxy):** Violates context optimization goal **Option B (Meta-Tools
Only):** High adoption friction **Option D (Automatic Filtering):** Too magical, unpredictable

---

## References

- **ADR-013:** Meta-Tools Only Gateway (2025-11-14)
- **PRD.md:** Product Requirements (Transparent Gateway vision)
- **Comprehensive Audit:** 2025-11-24 (Identified architectural drift)
- **Epic 2.5:** Adaptive DAG Feedback Loops (Command handlers context)

---

## Review & Approval

**Status:** Proposed (Awaiting Review) **Proposer:** Mary (Business Analyst) **Date:** 2025-11-24
**Next Step:** BMad review & decision (Approve/Reject/Request Changes)

**Implementation Target:** Sprint 1 (Week starting 2025-11-25)

---

**Appendix: Context Usage Comparison**

| Mode                | Tools Exposed | Context Tokens  | Use Case                     |
| ------------------- | ------------- | --------------- | ---------------------------- |
| meta_only           | 2-3           | ~500 (0.5%)     | Production, advanced users   |
| semantic            | 2-30          | ~3-5k (3-5%)    | Balanced, auto-optimization  |
| hybrid (balanced)   | 2-20          | ~3-5k (3-5%)    | Power users, mixed workflows |
| hybrid (permissive) | 2-50          | ~8-10k (8-10%)  | Development, testing         |
| full_proxy          | 687           | ~44.5k (30-50%) | Migration, legacy            |

**Recommendation:** Start with full_proxy (migration), transition to hybrid_balanced (week 3),
optimize to meta_only (month 2+).
