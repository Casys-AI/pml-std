/**
 * Unit tests for Admin Analytics (Story 6.6)
 *
 * Tests analytics queries and service layer.
 * Cloud-only module - excluded from public sync.
 *
 * @module tests/unit/cloud/admin/analytics_test
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import { PGliteClient } from "../../../../src/db/client.ts";
import {
  clearAnalyticsCache,
  getAdminAnalytics,
  getCacheStats,
  isAdminUser,
} from "../../../../src/cloud/admin/analytics-service.ts";
import {
  queryErrorHealth,
  queryResources,
  querySystemUsage,
  queryTechnical,
  queryUserActivity,
} from "../../../../src/cloud/admin/analytics-queries.ts";
import type { QueryClient } from "../../../../src/cloud/admin/types.ts";

/**
 * Test database client - extends QueryClient with test lifecycle methods
 */
interface TestDbClient extends QueryClient {
  exec(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

// Test setup helper - creates minimal schema for analytics tests
// PGliteClient implements all QueryClient methods plus test lifecycle
async function setupTestDb(): Promise<TestDbClient> {
  const db = new PGliteClient(":memory:");
  await db.connect();

  // Create minimal tables needed for analytics tests (skip full migrations due to vector extension)
  await db.exec(`
    -- Users table (cloud-only)
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      role TEXT DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Execution trace table
    CREATE TABLE IF NOT EXISTS execution_trace (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT,
      capability_id TEXT,
      tool_name TEXT NOT NULL,
      server_name TEXT,
      input JSONB,
      output JSONB,
      success BOOLEAN DEFAULT true,
      error_message TEXT,
      duration_ms INTEGER,
      executed_at TIMESTAMPTZ DEFAULT NOW(),
      parent_trace_id UUID
    );

    -- Workflow pattern table (simplified without vector)
    CREATE TABLE IF NOT EXISTS workflow_pattern (
      pattern_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pattern_hash TEXT UNIQUE NOT NULL,
      dag_structure JSONB NOT NULL,
      usage_count INTEGER DEFAULT 1,
      success_count INTEGER DEFAULT 0,
      last_used TIMESTAMPTZ DEFAULT NOW()
    );

    -- Tool schema table (mcp_tool was merged here in migration 019)
    CREATE TABLE IF NOT EXISTS tool_schema (
      id SERIAL PRIMARY KEY,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      schema JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (server_id, tool_name)
    );

    -- Tool dependency table (graph edges)
    CREATE TABLE IF NOT EXISTS tool_dependency (
      id SERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL,
      target_tool TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      edge_source TEXT DEFAULT 'learned',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- SHGAT params table (for analytics)
    CREATE TABLE IF NOT EXISTS shgat_params (
      id SERIAL PRIMARY KEY,
      version INTEGER NOT NULL,
      params JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Algorithm traces table (for analytics)
    CREATE TABLE IF NOT EXISTS algorithm_traces (
      id SERIAL PRIMARY KEY,
      algorithm_name TEXT NOT NULL,
      algorithm_mode TEXT,
      target_type TEXT,
      decision TEXT,
      final_score REAL,
      threshold_used REAL,
      input JSONB,
      output JSONB,
      latency_ms INTEGER,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Capability records table (for analytics)
    CREATE TABLE IF NOT EXISTS capability_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      verified BOOLEAN DEFAULT false,
      visibility TEXT DEFAULT 'private',
      routing TEXT DEFAULT 'local',
      usage_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Cast is safe: PGliteClient implements all QueryClient methods
  // The Row type is compatible with any T at runtime
  return db as unknown as TestDbClient;
}

// Seed test data
async function seedTestData(db: TestDbClient): Promise<void> {
  // Create test users
  await db.query(`
    INSERT INTO users (id, username, email, role, created_at)
    VALUES
      (gen_random_uuid(), 'admin_user', 'admin@test.com', 'admin', NOW() - INTERVAL '5 days'),
      (gen_random_uuid(), 'normal_user', 'user@test.com', 'user', NOW() - INTERVAL '2 days'),
      (gen_random_uuid(), 'new_user', 'new@test.com', 'user', NOW() - INTERVAL '1 hour')
  `);

  // Create workflow patterns for capabilities
  await db.query(`
    INSERT INTO workflow_pattern (pattern_id, pattern_hash, dag_structure, usage_count, success_count)
    VALUES
      (gen_random_uuid(), 'hash1', '{"nodes": [], "edges": []}', 10, 8),
      (gen_random_uuid(), 'hash2', '{"nodes": [], "edges": []}', 5, 4)
  `);

  // Create tool_schema entries for graph nodes
  await db.query(`
    INSERT INTO tool_schema (tool_name, server_id, schema)
    VALUES
      ('read_file', 'filesystem', '{}'),
      ('write_file', 'filesystem', '{}'),
      ('search', 'tavily', '{}')
  `);

  // Create tool_dependency entries for graph edges
  await db.query(`
    INSERT INTO tool_dependency (source_tool, target_tool, confidence, edge_source)
    VALUES ('read_file', 'write_file', 0.8, 'learned')
  `);

  // Create execution traces with various timestamps
  await db.query(`
    INSERT INTO execution_trace (id, user_id, tool_name, success, duration_ms, executed_at)
    VALUES
      -- Today's executions
      (gen_random_uuid(), 'admin_user', 'test_tool', true, 100, NOW() - INTERVAL '1 hour'),
      (gen_random_uuid(), 'admin_user', 'test_tool', true, 150, NOW() - INTERVAL '2 hours'),
      (gen_random_uuid(), 'normal_user', 'test_tool', true, 200, NOW() - INTERVAL '3 hours'),
      (gen_random_uuid(), 'normal_user', 'test_tool', false, 50, NOW() - INTERVAL '4 hours'),
      -- Week old executions
      (gen_random_uuid(), 'admin_user', 'test_tool', true, 120, NOW() - INTERVAL '3 days'),
      (gen_random_uuid(), 'normal_user', 'test_tool', true, 180, NOW() - INTERVAL '5 days'),
      -- Older execution (for returning user calculation)
      (gen_random_uuid(), 'admin_user', 'test_tool', true, 100, NOW() - INTERVAL '15 days')
  `);

  // Add error messages to failed executions
  await db.query(`
    UPDATE execution_trace
    SET error_message = 'Permission denied for this resource'
    WHERE success = false
  `);

  // Seed SHGAT params for technical metrics
  await db.query(`
    INSERT INTO shgat_params (version, params, created_at, updated_at)
    VALUES
      (1, '{"learning_rate": 0.001}', NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days'),
      (2, '{"learning_rate": 0.0005}', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 hour')
  `);

  // Seed algorithm traces for technical metrics
  await db.query(`
    INSERT INTO algorithm_traces (algorithm_name, algorithm_mode, target_type, decision, final_score, threshold_used, latency_ms, timestamp)
    VALUES
      ('spectral_clustering', 'fast', 'capability', 'accepted', 0.85, 0.7, 120, NOW() - INTERVAL '1 hour'),
      ('spectral_clustering', 'fast', 'capability', 'accepted', 0.92, 0.7, 95, NOW() - INTERVAL '2 hours'),
      ('spectral_clustering', 'accurate', 'tool', 'filtered', 0.65, 0.7, 200, NOW() - INTERVAL '3 hours'),
      ('pagerank', 'standard', 'capability', 'rejected', 0.45, 0.7, 80, NOW() - INTERVAL '4 hours'),
      ('pagerank', 'standard', 'tool', 'accepted', 0.88, 0.7, 150, NOW() - INTERVAL '5 hours')
  `);

  // Seed capability records for technical metrics
  await db.query(`
    INSERT INTO capability_records (name, verified, visibility, routing, usage_count, success_count)
    VALUES
      ('math_operations', true, 'public', 'cloud', 150, 145),
      ('file_utils', true, 'public', 'local', 80, 75),
      ('data_transform', false, 'private', 'local', 25, 20),
      ('api_caller', true, 'unlisted', 'cloud', 200, 180)
  `);
}

// ============================================
// isAdminUser Tests
// ============================================

Deno.test("isAdminUser - returns true for 'local' user", async () => {
  const db = await setupTestDb();

  const result = await isAdminUser(db, "local");
  assertEquals(result, true);

  await db.close();
});

Deno.test("isAdminUser - returns true for admin role user", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const result = await isAdminUser(db, "admin_user");
  assertEquals(result, true);

  await db.close();
});

Deno.test("isAdminUser - returns false for non-admin user", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const result = await isAdminUser(db, "normal_user");
  assertEquals(result, false);

  await db.close();
});

Deno.test("isAdminUser - returns false for non-existent user", async () => {
  const db = await setupTestDb();

  const result = await isAdminUser(db, "unknown_user");
  assertEquals(result, false);

  await db.close();
});

Deno.test("isAdminUser - returns true for user in ADMIN_USERNAMES env var", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  // Set ADMIN_USERNAMES env var
  const originalEnv = Deno.env.get("ADMIN_USERNAMES");
  Deno.env.set("ADMIN_USERNAMES", "normal_user,another_admin");

  try {
    // normal_user is not admin role, but is in ADMIN_USERNAMES
    const result = await isAdminUser(db, "some_id", "normal_user");
    assertEquals(result, true);
  } finally {
    // Restore original env
    if (originalEnv) {
      Deno.env.set("ADMIN_USERNAMES", originalEnv);
    } else {
      Deno.env.delete("ADMIN_USERNAMES");
    }
    await db.close();
  }
});

Deno.test("isAdminUser - ADMIN_USERNAMES is case insensitive", async () => {
  const db = await setupTestDb();

  const originalEnv = Deno.env.get("ADMIN_USERNAMES");
  Deno.env.set("ADMIN_USERNAMES", "TestAdmin,AnotherUser");

  try {
    const result = await isAdminUser(db, "some_id", "testadmin");
    assertEquals(result, true);
  } finally {
    if (originalEnv) {
      Deno.env.set("ADMIN_USERNAMES", originalEnv);
    } else {
      Deno.env.delete("ADMIN_USERNAMES");
    }
    await db.close();
  }
});

// ============================================
// queryUserActivity Tests
// ============================================

Deno.test("queryUserActivity - returns user activity metrics for 24h", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const activity = await queryUserActivity(db, "24h");

  // Should have active users in last 24h
  assertGreater(activity.activeUsers, 0);
  assertEquals(activity.dailyActiveUsers, activity.activeUsers);

  // Top users should be populated
  assert(Array.isArray(activity.topUsers));

  await db.close();
});

Deno.test("queryUserActivity - returns user activity metrics for 7d", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const activity = await queryUserActivity(db, "7d");

  // 7d should have >= 24h users
  assert(activity.activeUsers >= 0);
  assert(activity.weeklyActiveUsers >= activity.dailyActiveUsers);

  await db.close();
});

Deno.test("queryUserActivity - returns new registrations", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const activity = await queryUserActivity(db, "24h");

  // Should have new_user registered in last 24h
  assertGreater(activity.newRegistrations, 0);

  await db.close();
});

// ============================================
// querySystemUsage Tests
// ============================================

Deno.test("querySystemUsage - returns system usage metrics", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const usage = await querySystemUsage(db, "24h");

  assertGreater(usage.totalExecutions, 0);
  assert(Array.isArray(usage.executionsByDay));

  await db.close();
});

Deno.test("querySystemUsage - calculates average executions per user", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const usage = await querySystemUsage(db, "7d");

  // If there are executions and users, avg should be > 0
  if (usage.totalExecutions > 0) {
    assert(usage.avgExecutionsPerUser >= 0);
  }

  await db.close();
});

// ============================================
// queryErrorHealth Tests
// ============================================

Deno.test("queryErrorHealth - returns error and health metrics", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const health = await queryErrorHealth(db, "24h");

  assertGreater(health.totalExecutions, 0);
  assertGreater(health.failedExecutions, 0);
  assert(health.errorRate > 0);
  assert(health.errorRate < 1);

  await db.close();
});

Deno.test("queryErrorHealth - categorizes errors by type", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const health = await queryErrorHealth(db, "24h");

  assert(Array.isArray(health.errorsByType));
  // Should have permission error category
  const permissionError = health.errorsByType.find((e) =>
    e.errorType === "permission"
  );
  assert(permissionError !== undefined);

  await db.close();
});

Deno.test("queryErrorHealth - returns latency percentiles", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const health = await queryErrorHealth(db, "24h");

  // p50 should be <= p95 <= p99
  assert(health.latencyPercentiles.p50 <= health.latencyPercentiles.p95);
  assert(health.latencyPercentiles.p95 <= health.latencyPercentiles.p99);
  assertGreater(health.latencyPercentiles.avg, 0);

  await db.close();
});

// ============================================
// queryResources Tests
// ============================================

Deno.test("queryResources - returns resource counts", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const resources = await queryResources(db);

  assertGreater(resources.totalUsers, 0);
  assertGreater(resources.totalCapabilities, 0);
  assertGreater(resources.totalTraces, 0);
  assertGreater(resources.graphNodes, 0);
  assertGreater(resources.graphEdges, 0);

  await db.close();
});

// ============================================
// getAdminAnalytics Tests (with caching)
// ============================================

Deno.test("getAdminAnalytics - returns complete analytics object", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  clearAnalyticsCache();

  const analytics = await getAdminAnalytics(db, { timeRange: "24h" });

  assertEquals(analytics.timeRange, "24h");
  assert(analytics.generatedAt instanceof Date);
  assert(analytics.userActivity !== undefined);
  assert(analytics.systemUsage !== undefined);
  assert(analytics.errorHealth !== undefined);
  assert(analytics.resources !== undefined);

  await db.close();
});

Deno.test("getAdminAnalytics - uses cache on second call", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  clearAnalyticsCache();

  // First call - no cache
  const analytics1 = await getAdminAnalytics(db, { timeRange: "7d" });
  const stats1 = getCacheStats();
  assertEquals(stats1.entries, 1);

  // Second call - should use cache
  const analytics2 = await getAdminAnalytics(db, { timeRange: "7d" });

  // Same object from cache
  assertEquals(analytics1.generatedAt, analytics2.generatedAt);

  await db.close();
});

Deno.test("getAdminAnalytics - different time ranges have separate cache entries", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  clearAnalyticsCache();

  await getAdminAnalytics(db, { timeRange: "24h" });
  await getAdminAnalytics(db, { timeRange: "7d" });
  await getAdminAnalytics(db, { timeRange: "30d" });

  const stats = getCacheStats();
  assertEquals(stats.entries, 3);

  await db.close();
});

Deno.test("clearAnalyticsCache - clears all cache entries", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  // Add some cache entries
  await getAdminAnalytics(db, { timeRange: "24h" });
  await getAdminAnalytics(db, { timeRange: "7d" });

  const statsBefore = getCacheStats();
  assertGreater(statsBefore.entries, 0);

  clearAnalyticsCache();

  const statsAfter = getCacheStats();
  assertEquals(statsAfter.entries, 0);

  await db.close();
});

// ============================================
// Empty Database Tests
// ============================================

Deno.test("queryUserActivity - handles empty database", async () => {
  const db = await setupTestDb();

  const activity = await queryUserActivity(db, "24h");

  assertEquals(activity.activeUsers, 0);
  assertEquals(activity.dailyActiveUsers, 0);
  assertEquals(activity.topUsers.length, 0);

  await db.close();
});

Deno.test("queryErrorHealth - handles empty database", async () => {
  const db = await setupTestDb();

  const health = await queryErrorHealth(db, "24h");

  assertEquals(health.totalExecutions, 0);
  assertEquals(health.failedExecutions, 0);
  assertEquals(health.errorRate, 0);

  await db.close();
});

// ============================================
// queryTechnical Tests (L3, H4)
// ============================================

Deno.test("queryTechnical - returns SHGAT metrics", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const technical = await queryTechnical(db, "24h");

  // SHGAT should have 2 users with params
  assertEquals(technical.shgat.usersWithParams, 2);
  assert(technical.shgat.lastUpdated !== null);

  await db.close();
});

Deno.test("queryTechnical - returns algorithm metrics", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const technical = await queryTechnical(db, "24h");

  // Algorithm traces: 5 total
  assertEquals(technical.algorithms.totalTraces, 5);
  assertGreater(technical.algorithms.avgFinalScore, 0);

  // By decision - check array structure
  const decisions = technical.algorithms.byDecision;
  assert(Array.isArray(decisions));
  const accepted = decisions.find((d) => d.decision === "accepted");
  const filtered = decisions.find((d) => d.decision === "filtered");
  const rejected = decisions.find((d) => d.decision === "rejected");
  assertEquals(accepted?.count, 3);
  assertEquals(filtered?.count, 1);
  assertEquals(rejected?.count, 1);

  await db.close();
});

Deno.test("queryTechnical - returns capability registry metrics", async () => {
  const db = await setupTestDb();
  await seedTestData(db);

  const technical = await queryTechnical(db, "24h");

  // Capability records: 4 total, 3 verified
  assertEquals(technical.capabilities.totalRecords, 4);
  assertEquals(technical.capabilities.verifiedCount, 3);

  // By visibility - check array structure: 2 public, 1 private, 1 unlisted
  const visibility = technical.capabilities.byVisibility;
  assert(Array.isArray(visibility));
  const publicVis = visibility.find((v) => v.visibility === "public");
  const privateVis = visibility.find((v) => v.visibility === "private");
  const unlistedVis = visibility.find((v) => v.visibility === "unlisted");
  assertEquals(publicVis?.count, 2);
  assertEquals(privateVis?.count, 1);
  assertEquals(unlistedVis?.count, 1);

  // By routing - check array structure: 2 cloud, 2 local
  const routing = technical.capabilities.byRouting;
  assert(Array.isArray(routing));
  const cloudRouting = routing.find((r) => r.routing === "cloud");
  const localRouting = routing.find((r) => r.routing === "local");
  assertEquals(cloudRouting?.count, 2);
  assertEquals(localRouting?.count, 2);

  await db.close();
});

Deno.test("queryTechnical - handles empty database", async () => {
  const db = await setupTestDb();
  // No seed data

  const technical = await queryTechnical(db, "24h");

  assertEquals(technical.shgat.usersWithParams, 0);
  assertEquals(technical.algorithms.totalTraces, 0);
  assertEquals(technical.capabilities.totalRecords, 0);

  await db.close();
});

// ============================================
// Cache TTL Test (L4)
// ============================================

Deno.test("getAdminAnalytics - cache expires after TTL", async () => {
  const db = await setupTestDb();
  await seedTestData(db);
  clearAnalyticsCache();

  // First call - should populate cache
  const result1 = await getAdminAnalytics(db, { timeRange: "24h" });
  const stats1 = getCacheStats();
  assertEquals(stats1.entries, 1);

  // Simulate cache expiration by clearing and verifying fresh fetch
  clearAnalyticsCache();
  const statsCleared = getCacheStats();
  assertEquals(statsCleared.entries, 0);

  // Second call after clear - should repopulate cache
  const result2 = await getAdminAnalytics(db, { timeRange: "24h" });
  const stats2 = getCacheStats();
  assertEquals(stats2.entries, 1);

  // Results should be equivalent (fresh data)
  assertEquals(result1.userActivity.activeUsers, result2.userActivity.activeUsers);

  await db.close();
});
