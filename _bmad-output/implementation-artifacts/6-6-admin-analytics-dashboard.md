# Story 6.6: Admin Analytics Dashboard

Status: done

<!-- Note: Cloud-only implementation. Code is excluded from public sync via src/cloud/ and src/web/. -->

## Story

As a platform admin, I want a technical analytics dashboard showing user activity, system health, and error rates, so that I can monitor platform usage and diagnose issues.

## Acceptance Criteria

1. **User Activity Metrics** (`/api/admin/analytics`):
   - Active users (daily/weekly/monthly - DAU, WAU, MAU)
   - New registrations over time
   - User retention (returning users)
   - Top users by usage (anonymized or by consent)

2. **System Usage Metrics**:
   - Total MCP calls (per day/week)
   - Capability executions count
   - DAG executions count
   - Average calls per user

3. **Error & Health Metrics**:
   - Error rate (% of failed executions)
   - Errors by type (timeout, permission, runtime)
   - Latency percentiles (p50, p95, p99)
   - Rate limit hits count

4. **Resource Metrics**:
   - Graph node/edge counts
   - Total users, capabilities, traces counts

5. **Admin-only Access**:
   - Route protected by admin role check
   - Returns 403 for non-admin users
   - Local mode: user "local" is always admin

6. **Dashboard UI** (`/dashboard/admin`):
   - Time range selector (24h, 7d, 30d)
   - Charts for trends (execution by day)
   - Tables for top users, errors by type
   - MetricCard components for key metrics

## Tasks / Subtasks

- [x] Task 1: Create cloud admin module types (AC: #1, #2, #3, #4)
  - [x] Define TimeRange, AdminAnalytics interfaces
  - [x] Define UserActivityMetrics, SystemUsageMetrics, ErrorHealthMetrics, ResourceMetrics
  - [x] Create src/cloud/admin/types.ts

- [x] Task 2: Implement analytics SQL queries (AC: #1, #2, #3, #4)
  - [x] queryUserActivity: DAU, WAU, MAU, new registrations, returning users, top users
  - [x] querySystemUsage: total executions, capability executions, unique capabilities, by day
  - [x] queryErrorHealth: error rate, errors by type (ILIKE patterns), latency percentiles (PERCENTILE_CONT)
  - [x] queryResources: users, capabilities, traces, graph nodes/edges
  - [x] Create src/cloud/admin/analytics-queries.ts

- [x] Task 3: Create analytics service with caching (AC: #5)
  - [x] isAdminUser: check role or "local" user
  - [x] getAdminAnalytics: parallel query execution
  - [x] Cache with 2-minute TTL
  - [x] Create src/cloud/admin/analytics-service.ts

- [x] Task 4: Create REST API endpoint (AC: #1, #2, #3, #4, #5)
  - [x] GET /api/admin/analytics?timeRange=24h|7d|30d
  - [x] Admin role validation (403 for non-admins)
  - [x] Create src/web/routes/api/admin/analytics.ts

- [x] Task 5: Create dashboard page and island (AC: #6)
  - [x] SSR page at /dashboard/admin with auth check
  - [x] AdminDashboardIsland with time range selector
  - [x] MetricCard components for all metrics
  - [x] Simple bar chart for daily executions
  - [x] Create src/web/routes/dashboard/admin.tsx
  - [x] Create src/web/islands/AdminDashboardIsland.tsx

- [x] Task 6: Add unit tests
  - [x] Tests for isAdminUser (local, admin role, non-admin, unknown)
  - [x] Tests for all query functions
  - [x] Tests for caching behavior
  - [x] Tests for empty database handling
  - [x] Create tests/unit/cloud/admin/analytics_test.ts

- [x] Task 7: Add getRawDb() to auth/db.ts
  - [x] Expose raw SQL query interface for analytics

### Review Follow-ups (User)

These items were identified during code review and deferred for later:

- [x] [L1] Update story status from "ready-for-dev" to "done" when complete
- [x] [L2] Consistent query param naming: API now uses `?range=` (fixed in analytics.ts)
- [x] [L3] Import `queryTechnical` in tests/unit/cloud/admin/analytics_test.ts
- [x] [L4] Add test for cache TTL expiration (verify cache expires after 2 minutes)
- [x] [H4] Add tests for `queryTechnical` (SHGAT metrics, algorithm metrics, capability registry metrics, empty DB handling)
- [x] [M1] Remove unused `isCloudMode` variable in analytics.ts:23 (already removed)

## Dev Notes

### Architecture

This is a **cloud-only** feature. Files are excluded from the public sync via:
- `src/cloud/` - excluded in sync-to-public.yml
- `src/web/` - excluded in sync-to-public.yml

### Technical Decisions

1. **Raw SQL over ORM**: Analytics queries use raw SQL via `getRawDb()` because:
   - Complex aggregations (PERCENTILE_CONT, COUNT DISTINCT, GROUP BY DATE)
   - Drizzle ORM doesn't support all PostgreSQL aggregation functions
   - Performance: single round-trip for complex queries

2. **Caching**: 2-minute TTL in-memory cache to reduce database load for frequent dashboard refreshes.

3. **Error Classification**: Errors are categorized by pattern matching on error_message:
   - timeout: ILIKE '%timeout%'
   - permission: ILIKE '%permission%' OR '%denied%'
   - rate_limit: ILIKE '%rate%limit%'
   - not_found: ILIKE '%not found%'
   - runtime: default

4. **Admin Detection** (priority order):
   - Local mode: user "local" is always admin
   - Cloud mode: `ADMIN_USERNAMES` env var (comma-separated list)
   - Cloud mode: check `users.role = 'admin'` in database

5. **Dual Database Support**:
   - `getRawDb()` uses DbClient from `db/mod.ts`
   - Works with both PGlite (local) and PostgreSQL (cloud)

6. **Technical Metrics** (for ops, not marketing):
   - SHGAT: trained status, users with params, last updated
   - Algorithm Decisions: total traces, avg score/threshold, accept rate, by mode/decision
   - Capability Registry: total records, verified, usage stats, by visibility/routing

### Project Structure Notes

```
src/cloud/admin/
├── mod.ts                 # Export public API
├── analytics-service.ts   # Service layer with caching
├── analytics-queries.ts   # SQL aggregation queries
└── types.ts               # TypeScript interfaces

src/web/routes/
├── api/admin/
│   └── analytics.ts       # REST endpoint
└── dashboard/
    └── admin.tsx          # Fresh page

src/web/islands/
└── AdminDashboardIsland.tsx  # Interactive component

tests/unit/cloud/admin/
└── analytics_test.ts      # Unit tests (17 tests)
```

### References

- [Source: docs/epics/completed-epics-1-6.md#Story 6.6]
- [Source: sync-to-public.yml - exclusion patterns]
- [Source: src/server/auth/db.ts - getRawDb() added]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - implementation straightforward

### Completion Notes List

- All files created and functional
- Tests written (19 test cases - added ADMIN_USERNAMES tests)
- Added to deno.json test:unit:fast task
- Committed: feat(admin): implement Story 6.6 Admin Analytics Dashboard
- Improved: getRawDb() now works with PGlite AND PostgreSQL
- Added: ADMIN_USERNAMES env var for cloud admin config
- Added: Technical/ML metrics section (SHGAT, Algorithm Decisions, Capability Registry)

**Code Review Fixes Applied:**
- [H1] SQL queries now use buildTimeFilter() for safe interval interpolation
- [H2] Rate limit hits now tracked via error_message pattern matching
- [H3] Added dagExecutions metric to SystemUsageMetrics
- [H5] Added tests for ADMIN_USERNAMES env var (including case insensitivity)
- [H6] AdminPageData.analytics now allows null, with proper error handling
- [M2] Replaced CDN Tailwind with local /styles.css
- [M3] Added log.warn() on admin access denial (security audit)
- [M4] getCacheKey() now includes all options (timeRange, topUsersLimit, includeTopUsers)

### Emergence Metrics Refactoring (2025-12-30)

**Problem Identified**: The EmergencePanel graphs show entropy values always ~1.0 because:
- Shannon entropy normalized by log2(N) approaches 1.0 for large graphs
- With 131+ edges, any reasonable weight distribution gives entropy ~0.99

**Solution Implemented**: Tensor Entropy (spike in `src/graphrag/algorithms/tensor-entropy.ts`)
- Von Neumann entropy via Laplacian spectrum (Chen & Rajapakse 2020)
- Structural entropy (Li Angsheng approximation) - O(n) complexity
- Multi-order hyperedge support (capabilities as order-3+ hyperedges)

**Dashboard Graphs to Replace**:
1. **Graph Entropy chart** - Currently shows flat line at ~1.0
   - Replace with: Von Neumann entropy (already integrated in emergence.ts)
   - Add: Size-adjusted thresholds for health classification

2. **Cluster Stability chart** - Uses Jaccard similarity (correct implementation)
   - Keep as-is, but add historical persistence for meaningful trends

3. **Velocity timeseries** - Currently mock data
   - Fixed: Now queries execution_trace for real data

4. **Stability timeseries** - Uses algorithm_traces acceptance rate
   - Keep but validate data quality

**Next Steps for Full Fix**:
- [x] Implement size-adjusted entropy thresholds (tensor-entropy.ts:315)
- [x] Add semantic entropy (embedding space diversity) (emergence.ts:566)
- [x] Persist entropy history to database for trends (entropy_history table + saveEntropySnapshot)
- [x] Update EmergencePanel UI to show new metrics (Structural/Semantic/Dual + time axis fix)

**References**:
- [Chen & Rajapakse 2020](https://ieeexplore.ieee.org/document/9119161/) - Tensor Entropy for Hypergraphs
- [arxiv:2503.18852](https://arxiv.org/html/2503.18852) - Structural + Semantic dual entropy
- [Li Angsheng AAAI 2024](https://ojs.aaai.org/index.php/AAAI/article/view/28679) - Structural Entropy

### File List

- src/cloud/admin/types.ts (~180 lines - added TechnicalMetrics)
- src/cloud/admin/analytics-queries.ts (~510 lines - added queryTechnical)
- src/cloud/admin/analytics-service.ts (~145 lines - added technical metrics)
- src/cloud/admin/mod.ts (~45 lines - added exports)
- src/server/auth/db.ts (modified - getRawDb uses DbClient from db/mod.ts)
- src/web/routes/api/admin/analytics.ts (~87 lines)
- src/web/routes/dashboard/admin.tsx (~134 lines)
- src/web/islands/AdminDashboardIsland.tsx (~507 lines - added Technical section)
- tests/unit/cloud/admin/analytics_test.ts (~384 lines)
- deno.json (modified - added tests/unit/cloud/)
- docs/epics/completed-epics-1-6.md (modified - Story 6.6 details)
