# Spike: Smithery Registry Integration

**Type:** Technical Research Spike **Epic:** Future (Epic 5 - Ecosystem Integration) **Estimated
Duration:** 4-6 hours **Status:** 🔬 In Progress **Created:** 2025-11-20

---

## Objective

**Research and validate the technical feasibility of integrating Smithery Registry API** to enable:

1. Auto-discovery of MCP servers from Smithery marketplace
2. Simplified authentication via Smithery gateway
3. Unified experience: Smithery (discovery/auth) + Casys PML (intelligence/optimization)

---

## Success Criteria

**This spike is successful if we can answer:**

1. ✅/❌ Can we query Smithery Registry API programmatically?
2. ✅/❌ Can we extract MCP server schemas from Smithery responses?
3. ✅/❌ Can we connect to Smithery-hosted MCP servers via their gateway?
4. ✅/❌ Is the integration effort reasonable (< 1 epic)?
5. ✅/❌ Does it provide significant value vs. manual MCP config?

**Deliverable:** Go/No-Go recommendation with effort estimate

---

## Research Questions

### 1. Smithery Registry API Capabilities

**Questions:**

- What's the API rate limit?
- What server metadata is returned? (name, description, schema, tools, etc.)
- Can we filter by category/tags?
- Is there a webhook for registry updates?

**Method:** API documentation review + test queries

### 2. MCP Server Discovery & Schema Extraction

**Questions:**

- Do registry responses include full MCP tool schemas?
- Or do we need to connect to each server to fetch schemas?
- How are tool versions tracked?
- Can we diff schemas for cache invalidation?

**Method:** Query a few verified servers and inspect responses

### 3. Authentication & Connection Flow

**Questions:**

- How does Smithery handle OAuth/API keys for hosted servers?
- Can we proxy through Smithery gateway or must we connect directly?
- What's the connection URL format? (HTTP/WebSocket/stdio?)
- Do we need separate auth for each server or unified token?

**Method:** Test connection to a Smithery-hosted server

### 4. Integration Architecture Options

**Option A: Registry Sync (Read-Only)**

```
Smithery Registry → Casys PML PGlite → Discovery
```

- Periodic fetch (cron job)
- Store in tool_schema table
- User still configures auth separately

**Option B: Full Gateway Proxy**

```
Casys PML → Smithery Gateway → MCP Servers
```

- Smithery handles all auth
- Casys PML adds intelligence layer
- Unified connection flow

**Option C: Hybrid (Best of Both)**

```
Registry: Smithery (discovery)
Connection: Direct (stdio/HTTP) OR Smithery Gateway (hosted)
Intelligence: Casys PML (context optimization + DAG)
```

**Question:** Which architecture is feasible and optimal?

### 5. Value Proposition Analysis

**What does Smithery add?**

- ✅ 1000+ MCP servers (vs. manual config)
- ✅ OAuth/API key management (vs. user setup)
- ✅ Hosted infrastructure (vs. local-only)
- ✅ Community verification/ratings

**What does Casys PML add on top?**

- ✅ Context optimization (lazy loading, vector search)
- ✅ DAG execution (multi-tool workflows)
- ✅ Speculative execution (performance)
- ✅ Code execution sandbox (local processing)
- ✅ Cache intelligence (Story 3.7)

**Question:** Is this a compelling differentiation?

---

## Technical Investigation Plan

### Phase 1: API Exploration (1-2h)

**Tasks:**

- [ ] Get Smithery API token (https://smithery.ai/account/api-keys)
- [ ] Test registry search endpoint:
  ```bash
  curl -X GET "https://registry.smithery.ai/servers?q=is:verified&pageSize=10" \
    -H "Authorization: Bearer TOKEN"
  ```
- [ ] Inspect response format:
  - Server metadata structure
  - Tool schema availability
  - Connection details (URL, transport type)
- [ ] Test server info endpoint for specific server:
  ```bash
  curl -X GET "https://registry.smithery.ai/servers/mem0ai/mem0" \
    -H "Authorization: Bearer TOKEN"
  ```
- [ ] Document response schemas in this spike

### Phase 2: Connection Test (1-2h)

**Tasks:**

- [ ] Pick 2-3 verified Smithery servers (e.g., mem0, exa, github)
- [ ] Test connection flow:
  - Hosted servers (via Smithery gateway)
  - Local servers (via CLI if needed)
- [ ] Extract tool schemas from connected servers
- [ ] Compare with PGlite schema format
- [ ] Test if tool invocation works through Smithery

### Phase 3: Integration POC (2h)

**Tasks:**

- [ ] Create minimal TypeScript POC:
  ```typescript
  // 1. Fetch servers from Smithery
  const servers = await smitheryRegistry.search({ q: "is:verified" });

  // 2. Store in PGlite
  await db.insertServers(servers);

  // 3. Connect to a server
  const client = await smithery.connect(servers[0]);

  // 4. Proxy through Casys PML gateway
  const tools = await client.listTools();
  ```
- [ ] Measure integration effort (LOC, complexity)
- [ ] Identify technical blockers (if any)

### Phase 4: Architecture Decision (1h)

**Tasks:**

- [ ] Compare Option A vs. B vs. C (see above)
- [ ] Estimate effort for each option (story points)
- [ ] Assess risks (API changes, rate limits, auth complexity)
- [ ] Recommend architecture with rationale

---

## Findings

### API Exploration Results ✅ COMPLETED

**Date:** 2025-11-20 **Time Spent:** 1h **Status:** ✅ SUCCESS

#### 1. Registry Search API

**Endpoint Tested:**

```bash
curl -X GET "https://registry.smithery.ai/servers?q=is:verified&page=1&pageSize=10" \
  -H "Authorization: Bearer a20e744f-6904-462c-9583-835e783f2e86" \
  -H "Accept: application/json"
```

**Response Structure:**

```json
{
  "servers": [
    {
      "qualifiedName": "exa",
      "displayName": "Exa Search",
      "description": "Fast, intelligent web search...",
      "iconUrl": "https://...",
      "verified": true,
      "useCount": 703815,
      "remote": true,
      "createdAt": "2024-12-13T15:46:50.750Z",
      "homepage": "https://smithery.ai/server/exa"
    }
  ],
  "pagination": {
    "currentPage": 1,
    "pageSize": 10,
    "totalPages": 18,
    "totalCount": 176
  }
}
```

**Key Findings:**

- ✅ **176 verified servers** available in registry
- ✅ **18 pages** of results (good pagination)
- ✅ **useCount metrics** available (703K uses for Exa!)
- ✅ **Filters work:** `is:verified`, `q=github`, etc.

#### 2. Server Details API

**Endpoint Tested:**

```bash
curl -X GET "https://registry.smithery.ai/servers/exa" \
  -H "Authorization: Bearer TOKEN"
```

**Response Includes:**

```json
{
  "qualifiedName": "exa",
  "displayName": "Exa Search",
  "deploymentUrl": "https://server.smithery.ai/exa",  // ← Critical!
  "remote": true,
  "tools": [
    {
      "name": "web_search_exa",
      "description": "Search the web using Exa AI...",
      "inputSchema": {
        "type": "object",
        "$schema": "http://json-schema.org/draft-07/schema#",
        "required": ["query"],
        "properties": {
          "query": { "type": "string", "description": "..." },
          "type": { "enum": ["auto", "fast", "deep"], ... },
          "numResults": { "type": "number", ... }
        }
      },
      "annotations": {
        "readOnlyHint": true,
        "idempotentHint": true,
        "destructiveHint": false
      }
    }
  ]
}
```

**Critical Discoveries:**

- ✅ **Full MCP tool schemas included!** (inputSchema with JSON Schema Draft 7)
- ✅ **Deployment URL provided:** `https://server.smithery.ai/{serverId}`
- ✅ **Tool annotations included:** read-only, idempotent, destructive hints
- ✅ **Multiple tools per server:** Exa has 2 tools (web_search, get_code_context)

#### 3. Authentication Flow Discovery

**From Smithery docs research:**

**User Setup Flow:**

1. User visits smithery.ai
2. Configures API keys (Gmail, GitHub, etc.) on Smithery
3. Smithery hosts the server: `https://server.smithery.ai/{serverId}/mcp`
4. User copies URL to client (Claude Desktop, etc.)

**OAuth 2.1 + PKCE Flow:**

1. Client connects to `https://server.smithery.ai/exa/mcp`
2. Server returns 401 with `WWW-Authenticate` header
3. Client redirects user to Smithery OAuth page
4. User logs in, authorizes client
5. Smithery issues access token (JWT with `aud`, `scope`, `sub`)
6. Client stores token, reconnects
7. Subsequent requests: `Authorization: Bearer <token>`

**Token Management:**

- Tokens are **short-lived** (5-15 min recommended)
- MCP SDK handles **automatic refresh**
- Tokens scoped per server (audience claim)

#### 4. Key Architecture Insights

**Smithery's Value Proposition:**

- ✅ **Hosting:** User doesn't run server locally
- ✅ **Auth Management:** Smithery manages OAuth flows
- ✅ **API Key Storage:** User configs keys once on Smithery
- ✅ **Simple URL:** Just copy-paste URL to client

**The Critical Question:**

- ❓ **Can Casys PML act as OAuth client for Smithery?**
- ❓ **Or does user need separate Smithery account + Casys PML setup?**
- ❓ **Is HTTP/OAuth simpler than stdio for end users?**

**Comparison:**

| Approach            | User Setup                                  | Complexity  | Deps              |
| ------------------- | ------------------------------------------- | ----------- | ----------------- |
| **Stdio (current)** | Config `mcp.json`, run locally              | Medium      | None              |
| **Smithery HTTP**   | Config keys on Smithery, OAuth in Casys PML | Medium-High | Smithery API      |
| **Hybrid**          | User chooses (stdio OR Smithery)            | High        | Optional Smithery |

### Connection Test Results ⏸️ PAUSED

**Status:** Not tested yet - blocked by architecture decision

**Reason:** Need to answer critical questions first:

1. Can Casys PML implement OAuth 2.1 client for Smithery?
2. Is HTTP transport worth the complexity vs. stdio?
3. Does this provide real value to users?

**Next Steps if Go:**

- Implement OAuth 2.1 + PKCE flow in Casys PML
- Add HTTP/SSE transport layer (currently only stdio)
- Test full connection flow with real Smithery servers
- Measure latency vs. stdio

**Estimated Effort if Go:** 6-10h (OAuth + HTTP transport + testing)

### Integration POC Results ⏸️ PAUSED

**Status:** Not implemented - pending architecture decision

**Estimated Complexity:**

- **Registry Sync:** ~100-150 LOC (fetch + parse + store)
- **HTTP Transport:** ~300-500 LOC (new transport layer)
- **OAuth Client:** ~400-600 LOC (PKCE flow + token management)
- **Total:** ~800-1250 LOC

**Dependencies:**

- `@smithery/registry` (optional, could use raw fetch)
- OAuth 2.1 library (e.g., `oauth4webapi`)
- HTTP/SSE client library

**Technical Blockers Identified:**

- ❌ **HTTP transport not implemented** (only stdio currently)
- ❌ **OAuth flow complex** for CLI tool (browser redirect required)
- ❌ **Token storage** (where to persist securely?)
- ⚠️ **User must still config keys on Smithery** (not truly "simpler")

---

## Architecture Recommendation

### Chosen Architecture: **⏸️ DECISION DEFERRED**

**Status:** Insufficient data to make Go/No-Go decision

**What We Know:**

- ✅ Smithery Registry API works perfectly
- ✅ Full tool schemas available via API
- ✅ 176+ verified servers ready to use
- ✅ OAuth 2.1 + PKCE auth flow documented

**What We Don't Know:**

- ❓ Can Casys PML act as Smithery OAuth client?
- ❓ How complex is HTTP/SSE transport implementation?
- ❓ Does Smithery hosting provide **real** value vs. stdio?
- ❓ Will users actually use this vs. local config?

**Effort Estimate (if Go):**

- **Phase 1: HTTP Transport** (~4-6h) - Add HTTP/SSE client support
- **Phase 2: OAuth Client** (~4-6h) - Implement PKCE flow + token management
- **Phase 3: Registry Sync** (~2-3h) - Fetch + store Smithery servers
- **Phase 4: Testing** (~2-3h) - E2E tests with real Smithery servers
- **Total:** ~12-18h (1.5-2 epics)

**Implementation Plan (if Go):**

1. Epic 5.1: "HTTP/SSE Transport Layer" (4-6h)
2. Epic 5.2: "Smithery OAuth Integration" (4-6h)
3. Epic 5.3: "Registry Discovery UI" (4-6h)

---

## Decision: Go / No-Go

### Recommendation: **⏸️ DEFERRED - Need More Data**

**Current Status:** Phase 1 (API Exploration) ✅ Complete, Phase 2 (Connection Test) ⏸️ Paused

#### Arguments FOR Going Ahead

**Pros:**

- ✅ **176+ servers available** - Huge ecosystem access
- ✅ **Smithery handles hosting** - User doesn't run processes locally
- ✅ **API keys managed on Smithery** - Centralized credential management
- ✅ **OAuth simplifies auth** - No manual token juggling
- ✅ **Discovery UX** - Browse/search servers in Casys PML UI
- ✅ **Differentiation** - Smithery (hosting) + Casys PML (intelligence)

**User Experience Win:**

```
Current (stdio):
1. Find MCP server on GitHub
2. Install dependencies locally
3. Configure mcp.json
4. Manage API keys in env vars
5. Run server process

With Smithery:
1. Browse servers in Casys PML
2. Click "Connect" → Redirect to Smithery
3. Configure API keys once on Smithery
4. Done - server hosted remotely
```

#### Arguments AGAINST Going Ahead

**Cons:**

- ❌ **High complexity:** HTTP transport + OAuth + token management (~12-18h)
- ❌ **External dependency:** Reliance on Smithery availability
- ❌ **User still configs keys:** Not truly "zero config"
- ❌ **OAuth in CLI is awkward:** Browser redirects from terminal
- ❌ **Latency concern:** HTTP roundtrip vs. local stdio
- ❌ **Premature optimization:** Focus on core features first (Epic 3, 3.5, 4)
- ⚠️ **Unknown demand:** Will users actually prefer hosted vs. local?

**Technical Blockers:**

- HTTP/SSE transport not implemented (only stdio)
- OAuth flow complex for CLI (needs browser redirect handling)
- Token persistence strategy unclear
- Testing requires real Smithery account + servers

#### Critical Unknowns

**Must Answer Before Go:**

1. **Can we test connection to Smithery server?** (Phase 2)
   - Setup: Create Smithery account, configure a server
   - Test: Connect via HTTP, call a tool
   - Measure: Latency vs. stdio

2. **Is OAuth flow feasible in CLI?**
   - Research: How do other CLI tools handle OAuth? (gh, gcloud)
   - Prototype: Minimal OAuth flow with localhost callback

3. **What's the actual user demand?**
   - Survey: Ask Casys PML users if they want Smithery integration
   - Alternative: Focus on better stdio discovery first

#### Recommended Next Steps

**Option A: Continue Spike (4-6h more)**

- Complete Phase 2: Connection Test
- Build minimal OAuth prototype
- Measure actual latency and UX
- **Then** make final Go/No-Go

**Option B: Defer to Future**

- Archive spike as "Promising but Premature"
- Focus on Epic 3, 3.5, 4 (core features)
- Revisit after MVP launch
- Gather user feedback first

**Option C: Partial Integration (Low Effort)**

- Just implement Registry Sync (~2-3h)
- Show Smithery servers in "Discover" UI
- Link to Smithery for setup (external)
- No OAuth, no HTTP transport

### Final Recommendation: **Option B - Defer to Future**

**Rationale:**

1. **Core features not done yet:** Epic 3, 3.5, 4 are higher priority
2. **High effort:** 12-18h is significant (almost 2 epics)
3. **Uncertain ROI:** Unknown if users will prefer hosted vs. local
4. **External dependency risk:** Reliance on Smithery availability/pricing
5. **Better alternative exists:** Improve stdio discovery first (lower effort, no deps)

**Better Investment (2-3h):**

- Story: "MCP Auto-Discovery Improvements"
  - Auto-scan `~/.config/mcp/`
  - Detect Claude Desktop config
  - Suggest popular servers with install guides
  - Document best practices

**Revisit Smithery After:**

- Epic 3, 3.5, 4 complete (core features shipped)
- MVP launched with real users
- User feedback indicates demand for hosted servers
- HTTP transport needed for other reasons

---

## References

- [Smithery Registry API Docs](https://smithery.ai/docs/use/registry)
- [Smithery SDK - GitHub](https://github.com/smithery-ai/sdk)
- [@smithery/registry - NPM](https://www.npmjs.com/package/@smithery/registry)
- [Casys PML Research - Market Analysis](../research/research-market-2025-11-11.md#compétiteur-1--smithery-community-platform)
- [Casys PML PRD - Competitive Analysis](../PRD.md)

---

## Notes & Observations

### 2025-11-20: Spike Created

- Objective: Research Smithery integration feasibility
- Plan: 4-6h investigation (API + Connection + POC + Decision)
- Expected outcome: Go/No-Go with effort estimate

### 2025-11-20: Phase 1 Complete ✅

**Time Spent:** 1h **Status:** API exploration successful

**Key Findings:**

- Smithery Registry API works perfectly (176 verified servers)
- Full tool schemas available in responses
- HTTP deployment URLs provided
- OAuth 2.1 + PKCE auth required

**Decision:** Deferred to future - focus on core features first (Epic 3, 3.5, 4)

---

## Timeboxing

**Total Time Budget:** 6 hours max **Time Spent:** 1h (Phase 1 only) **Remaining:** 5h (not used -
spike paused)

**Status:** ⏸️ **PAUSED AT PHASE 1**

- Reason: Sufficient data for defer decision
- No need to continue to Phase 2 at this time
- Can resume if prioritized later
