/**
 * Unified Search Precision Benchmark
 *
 * Benchmarks for pml_discover (Story 10.6) - Active Search mode without context.
 * Uses REAL BGE-M3 embeddings for meaningful precision metrics.
 *
 * Formula for pml_discover: score = semantic × reliability
 *
 * NOTE: Alpha/graph is NOT used in pml_discover because there's no context.
 * - pml_discover → This benchmark (semantic × reliability)
 * - predictNextNode → Uses SHGAT + DR-DSP (stories 10.7a/b), NOT tested here
 *
 * See: Story 10.6 Dev Notes, ADR-050 Unified Search Simplification
 *
 * Run: deno run --allow-all tests/benchmarks/unified-search.bench.ts
 *
 * @module tests/benchmarks/unified-search
 */

import { assertGreater } from "@std/assert";
import {
  unifiedSearch,
  createMockGraph,
  createMockVectorSearch,
  type SearchableNode,
  type UnifiedVectorSearch,
} from "../../src/graphrag/algorithms/unified-search.ts";
import { EmbeddingModel } from "../../src/vector/embeddings.ts";
import { computeDiscoverScore } from "../../src/mcp/handlers/discover-handler.ts";

// NOTE: LocalAlphaCalculator and SpectralClusteringManager are NOT used by pml_discover
// They are only relevant for predictNextNode (SHGAT+DR-DSP mode) - see stories 10.7a/b

// ============================================================================
// Test Data Setup - Realistic E-commerce Tools & Capabilities
// ============================================================================

const nodes = new Map<string, SearchableNode>([
  // File operations
  ["fs:read", {
    id: "fs:read",
    type: "tool",
    name: "read file",
    description: "Read contents of a file from the filesystem",
    successRate: 0.95,
    serverId: "filesystem",
  }],
  ["fs:write", {
    id: "fs:write",
    type: "tool",
    name: "write file",
    description: "Write contents to a file on the filesystem",
    successRate: 0.92,
    serverId: "filesystem",
  }],
  ["fs:list", {
    id: "fs:list",
    type: "tool",
    name: "list directory",
    description: "List files and directories in a path",
    successRate: 0.98,
    serverId: "filesystem",
  }],
  // Database operations
  ["db:query", {
    id: "db:query",
    type: "tool",
    name: "database query",
    description: "Execute SQL query on the database",
    successRate: 0.90,
    serverId: "database",
  }],
  ["db:insert", {
    id: "db:insert",
    type: "tool",
    name: "database insert",
    description: "Insert a new record into database table",
    successRate: 0.88,
    serverId: "database",
  }],
  ["db:update", {
    id: "db:update",
    type: "tool",
    name: "database update",
    description: "Update existing records in database",
    successRate: 0.85,
    serverId: "database",
  }],
  // Git operations
  ["git:commit", {
    id: "git:commit",
    type: "tool",
    name: "git commit",
    description: "Commit staged changes to git repository with a message",
    successRate: 0.85,
    serverId: "git",
  }],
  ["git:push", {
    id: "git:push",
    type: "tool",
    name: "git push",
    description: "Push local commits to remote repository",
    successRate: 0.80,
    serverId: "git",
  }],
  ["git:status", {
    id: "git:status",
    type: "tool",
    name: "git status",
    description: "Show the working tree status and staged changes",
    successRate: 0.99,
    serverId: "git",
  }],
  // API operations
  ["api:get", {
    id: "api:get",
    type: "tool",
    name: "HTTP GET request",
    description: "Make a GET request to fetch data from an API endpoint",
    successRate: 0.92,
    serverId: "http",
  }],
  ["api:post", {
    id: "api:post",
    type: "tool",
    name: "HTTP POST request",
    description: "Make a POST request to send data to an API endpoint",
    successRate: 0.88,
    serverId: "http",
  }],
  // Capabilities
  ["cap:file-backup", {
    id: "cap:file-backup",
    type: "capability",
    name: "file backup workflow",
    description: "Backup files by reading, compressing and storing them safely",
    successRate: 0.90,
  }],
  ["cap:data-sync", {
    id: "cap:data-sync",
    type: "capability",
    name: "data synchronization",
    description: "Synchronize data between local database and remote API",
    successRate: 0.82,
  }],
  ["cap:code-deploy", {
    id: "cap:code-deploy",
    type: "capability",
    name: "code deployment",
    description: "Deploy code changes by committing and pushing to production",
    successRate: 0.78,
  }],
  ["cap:data-migration", {
    id: "cap:data-migration",
    type: "capability",
    name: "data migration",
    description: "Migrate data from one system to another with validation",
    successRate: 0.75,
  }],
  // Meta-capabilities (group of capabilities)
  ["meta:devops", {
    id: "meta:devops",
    type: "capability",  // Treated as capability in search
    name: "DevOps automation",
    description: "Complete DevOps workflow including code deployment, data migration, and system synchronization",
    successRate: 0.70,
  }],
  ["meta:data-ops", {
    id: "meta:data-ops",
    type: "capability",
    name: "Data operations suite",
    description: "Comprehensive data management including backup, sync, migration, and database operations",
    successRate: 0.72,
  }],
]);

// Graph connections - Dense graph to enable pattern correlation
// Each node should have 3+ neighbors for meaningful graph relationships
const graph = createMockGraph([
  // ==========================================================================
  // File Operations Cluster (dense intra-cluster connections)
  // ==========================================================================
  { from: "fs:read", to: "fs:write", weight: 0.9 },
  { from: "fs:read", to: "fs:list", weight: 0.85 },
  { from: "fs:write", to: "fs:list", weight: 0.7 },
  { from: "fs:list", to: "fs:read", weight: 0.8 },  // Bidirectional

  // ==========================================================================
  // Database Operations Cluster
  // ==========================================================================
  { from: "db:query", to: "db:update", weight: 0.85 },
  { from: "db:query", to: "db:insert", weight: 0.8 },
  { from: "db:insert", to: "db:update", weight: 0.75 },
  { from: "db:update", to: "db:query", weight: 0.7 },  // Bidirectional

  // ==========================================================================
  // Git Operations Cluster
  // ==========================================================================
  { from: "git:status", to: "git:commit", weight: 0.95 },
  { from: "git:commit", to: "git:push", weight: 0.9 },
  { from: "git:status", to: "git:push", weight: 0.6 },  // Sometimes skip commit
  { from: "git:push", to: "git:status", weight: 0.5 },  // Check after push

  // ==========================================================================
  // API Operations Cluster
  // ==========================================================================
  { from: "api:get", to: "api:post", weight: 0.7 },
  { from: "api:post", to: "api:get", weight: 0.6 },  // Often paired

  // ==========================================================================
  // Cross-Domain Edges (realistic workflows)
  // ==========================================================================
  // File → DB (reading config, exporting data)
  { from: "fs:read", to: "db:query", weight: 0.5 },
  { from: "db:query", to: "fs:write", weight: 0.5 },

  // API → DB (fetch and store)
  { from: "api:get", to: "db:insert", weight: 0.8 },
  { from: "db:query", to: "api:post", weight: 0.7 },
  { from: "api:get", to: "db:update", weight: 0.6 },

  // Git → File (common dev workflow)
  { from: "git:status", to: "fs:read", weight: 0.4 },
  { from: "fs:write", to: "git:commit", weight: 0.5 },

  // ==========================================================================
  // Capability → Tool Edges (contains relationship)
  // ==========================================================================
  { from: "cap:file-backup", to: "fs:read", weight: 1.0 },
  { from: "cap:file-backup", to: "fs:write", weight: 1.0 },
  { from: "cap:file-backup", to: "fs:list", weight: 0.8 },

  { from: "cap:data-sync", to: "api:get", weight: 1.0 },
  { from: "cap:data-sync", to: "db:insert", weight: 1.0 },
  { from: "cap:data-sync", to: "db:update", weight: 0.8 },

  { from: "cap:code-deploy", to: "git:commit", weight: 1.0 },
  { from: "cap:code-deploy", to: "git:push", weight: 1.0 },
  { from: "cap:code-deploy", to: "git:status", weight: 0.9 },

  { from: "cap:data-migration", to: "db:query", weight: 1.0 },
  { from: "cap:data-migration", to: "api:post", weight: 1.0 },
  { from: "cap:data-migration", to: "db:insert", weight: 0.9 },
  { from: "cap:data-migration", to: "api:get", weight: 0.8 },

  // ==========================================================================
  // Capability → Capability Edges (workflow dependencies)
  // ==========================================================================
  { from: "cap:file-backup", to: "cap:data-sync", weight: 0.6 },  // Backup before sync
  { from: "cap:data-sync", to: "cap:data-migration", weight: 0.7 },  // Sync enables migration
  { from: "cap:code-deploy", to: "cap:data-migration", weight: 0.5 },  // Deploy may need migration

  // ==========================================================================
  // Meta-Capability → Capability/Tool Edges
  // ==========================================================================
  { from: "meta:devops", to: "cap:code-deploy", weight: 1.0 },
  { from: "meta:devops", to: "cap:data-migration", weight: 1.0 },
  { from: "meta:devops", to: "cap:data-sync", weight: 0.9 },
  { from: "meta:devops", to: "git:status", weight: 0.7 },
  { from: "meta:devops", to: "git:push", weight: 0.7 },

  { from: "meta:data-ops", to: "cap:file-backup", weight: 1.0 },
  { from: "meta:data-ops", to: "cap:data-sync", weight: 1.0 },
  { from: "meta:data-ops", to: "cap:data-migration", weight: 1.0 },
  { from: "meta:data-ops", to: "db:query", weight: 0.9 },
  { from: "meta:data-ops", to: "db:insert", weight: 0.9 },
  { from: "meta:data-ops", to: "fs:read", weight: 0.8 },
]);

// ============================================================================
// Ground Truth: HARD/Ambiguous Queries
// ============================================================================

interface QueryTest {
  query: string;
  expectedTop1: string;
  expectedTop3: string[];
  context?: string[];
  difficulty: "easy" | "medium" | "hard";
}

const queryTests: QueryTest[] = [
  // ==========================================================================
  // AGENT-STYLE QUERIES (realistic LLM-generated tool requests)
  // ==========================================================================

  // FILE OPERATIONS
  {
    query: "read file contents from filesystem",
    expectedTop1: "fs:read",
    expectedTop3: ["fs:read", "fs:list", "fs:write"],
    difficulty: "easy",
  },
  {
    query: "write data to file on disk",
    expectedTop1: "fs:write",
    expectedTop3: ["fs:write", "fs:read", "fs:list"],
    difficulty: "easy",
  },
  {
    query: "list files in directory",
    expectedTop1: "fs:list",
    expectedTop3: ["fs:list", "fs:read", "fs:write"],
    difficulty: "easy",
  },

  // DATABASE OPERATIONS
  {
    query: "execute SQL query on database",
    expectedTop1: "db:query",
    expectedTop3: ["db:query", "db:insert", "db:update"],
    difficulty: "easy",
  },
  {
    query: "insert new record into database table",
    expectedTop1: "db:insert",
    expectedTop3: ["db:insert", "db:update", "db:query"],
    difficulty: "easy",
  },
  {
    query: "update existing database records",
    expectedTop1: "db:update",
    expectedTop3: ["db:update", "db:insert", "db:query"],
    difficulty: "easy",
  },

  // GIT OPERATIONS
  {
    query: "commit staged changes to git repository",
    expectedTop1: "git:commit",
    expectedTop3: ["git:commit", "git:status", "git:push"],
    difficulty: "easy",
  },
  {
    query: "push commits to remote repository",
    expectedTop1: "git:push",
    expectedTop3: ["git:push", "git:commit", "cap:code-deploy"],
    difficulty: "easy",
  },
  {
    query: "show git working tree status",
    expectedTop1: "git:status",
    expectedTop3: ["git:status", "git:commit", "fs:list"],
    difficulty: "easy",
  },

  // API OPERATIONS
  {
    query: "make HTTP GET request to API endpoint",
    expectedTop1: "api:get",
    expectedTop3: ["api:get", "api:post", "cap:data-sync"],
    difficulty: "easy",
  },
  {
    query: "send POST request with data to API",
    expectedTop1: "api:post",
    expectedTop3: ["api:post", "api:get", "db:insert"],
    difficulty: "easy",
  },

  // CAPABILITIES - More complex, workflow-level
  {
    query: "backup files by reading and storing safely",
    expectedTop1: "cap:file-backup",
    expectedTop3: ["cap:file-backup", "fs:read", "fs:write"],
    difficulty: "medium",
  },
  {
    query: "synchronize data between database and remote API",
    expectedTop1: "cap:data-sync",
    expectedTop3: ["cap:data-sync", "api:get", "db:insert"],
    difficulty: "medium",
  },
  {
    query: "deploy code changes to production",
    expectedTop1: "cap:code-deploy",
    expectedTop3: ["cap:code-deploy", "git:push", "git:commit"],
    difficulty: "medium",
  },
  {
    query: "migrate data from old system to new system",
    expectedTop1: "cap:data-migration",
    expectedTop3: ["cap:data-migration", "cap:data-sync", "db:query"],
    difficulty: "medium",
  },

  // CONTEXT-DEPENDENT (agent might say this after previous action)
  {
    query: "push the committed changes to remote",
    expectedTop1: "git:push",
    expectedTop3: ["git:push", "git:commit", "cap:code-deploy"],
    context: ["git:commit"],
    difficulty: "medium",
  },
  {
    query: "insert fetched data into database",
    expectedTop1: "db:insert",
    expectedTop3: ["db:insert", "db:update", "api:get"],
    context: ["api:get"],
    difficulty: "medium",
  },

  // ==========================================================================
  // COMPLEX WORKFLOW QUERIES (should match capabilities)
  // ==========================================================================

  // File backup workflow
  {
    query: "I need to read all important files, compress them, and store them in a safe backup location",
    expectedTop1: "cap:file-backup",
    expectedTop3: ["cap:file-backup", "fs:read", "fs:write"],
    difficulty: "hard",
  },
  {
    query: "create a backup of the project files before making changes",
    expectedTop1: "cap:file-backup",
    expectedTop3: ["cap:file-backup", "fs:read", "fs:write"],
    difficulty: "hard",
  },

  // Data sync workflow
  {
    query: "fetch customer data from the remote API and update our local database with the latest records",
    expectedTop1: "cap:data-sync",
    expectedTop3: ["cap:data-sync", "api:get", "db:insert"],
    difficulty: "hard",
  },
  {
    query: "synchronize our local database records with the remote server to keep data consistent",
    expectedTop1: "cap:data-sync",
    expectedTop3: ["cap:data-sync", "api:get", "db:insert"],
    difficulty: "hard",
  },

  // Code deployment workflow
  {
    query: "commit all the code changes, push to remote repository, and deploy to production environment",
    expectedTop1: "cap:code-deploy",
    expectedTop3: ["cap:code-deploy", "git:push", "git:commit"],
    difficulty: "hard",
  },
  {
    query: "release the new feature by pushing code changes and deploying to users",
    expectedTop1: "cap:code-deploy",
    expectedTop3: ["cap:code-deploy", "git:push", "git:commit"],
    difficulty: "hard",
  },

  // Data migration workflow
  {
    query: "extract data from the legacy database, transform it, and load into the new system via API",
    expectedTop1: "cap:data-migration",
    expectedTop3: ["cap:data-migration", "db:query", "api:post"],
    difficulty: "hard",
  },
  {
    query: "migrate all user records from the old database to the new platform with validation",
    expectedTop1: "cap:data-migration",
    expectedTop3: ["cap:data-migration", "db:query", "api:post"],
    difficulty: "hard",
  },

  // Multi-step workflow descriptions
  {
    query: "first check git status, then commit changes, and finally push to remote",
    expectedTop1: "cap:code-deploy",
    expectedTop3: ["cap:code-deploy", "git:status", "git:commit"],
    context: ["git:status"],
    difficulty: "hard",
  },
  {
    query: "query the database for outdated records, then send them to the remote API for processing",
    expectedTop1: "cap:data-migration",
    expectedTop3: ["cap:data-migration", "db:query", "api:post"],
    difficulty: "hard",
  },

  // ==========================================================================
  // META-CAPABILITY QUERIES (should match meta-level groupings)
  // ==========================================================================
  {
    query: "I need a complete DevOps automation workflow for deployment and data management",
    expectedTop1: "meta:devops",
    expectedTop3: ["meta:devops", "cap:code-deploy", "cap:data-migration"],
    difficulty: "hard",
  },
  {
    query: "set up full DevOps pipeline including code deployment and system synchronization",
    expectedTop1: "meta:devops",
    expectedTop3: ["meta:devops", "cap:code-deploy", "cap:data-sync"],
    difficulty: "hard",
  },
  {
    query: "comprehensive data operations including backup, sync, and database management",
    expectedTop1: "meta:data-ops",
    expectedTop3: ["meta:data-ops", "cap:file-backup", "cap:data-sync"],
    difficulty: "hard",
  },
  {
    query: "full data management suite for backup, migration, and synchronization",
    expectedTop1: "meta:data-ops",
    expectedTop3: ["meta:data-ops", "cap:data-migration", "cap:data-sync"],
    difficulty: "hard",
  },
];

// ============================================================================
// Create Real Vector Search with BGE-M3
// ============================================================================

interface VectorSearchWithEmbeddings {
  vectorSearch: UnifiedVectorSearch;
  nodeEmbeddings: Map<string, number[]>;
}

async function createRealVectorSearch(
  embedder: EmbeddingModel,
  nodeMap: Map<string, SearchableNode>,
): Promise<VectorSearchWithEmbeddings> {
  // Pre-compute embeddings for all nodes
  const nodeEmbeddings = new Map<string, number[]>();

  for (const [id, node] of nodeMap) {
    const text = `${node.name}: ${node.description}`;
    const embedding = await embedder.encode(text);
    nodeEmbeddings.set(id, embedding);
  }

  const vectorSearch: UnifiedVectorSearch = {
    search: async (query: string, limit: number, minScore: number) => {
      const queryEmbedding = await embedder.encode(query);

      // Compute cosine similarity with all nodes
      const results: Array<{ nodeId: string; score: number }> = [];

      for (const [id, embedding] of nodeEmbeddings) {
        const score = cosineSimilarity(queryEmbedding, embedding);
        if (score >= minScore) {
          results.push({ nodeId: id, score });
        }
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    },
  };

  return { vectorSearch, nodeEmbeddings };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================================
// Precision Metrics
// ============================================================================

interface PrecisionResult {
  hit1: number;
  hit3: number;
  hit5: number;
  mrr: number;
  byDifficulty: Record<string, { hit1: number; hit5: number; count: number }>;
  queryResults: Array<{
    query: string;
    expected: string;
    actual: string;
    rank: number;
    correct: boolean;
    difficulty: string;
  }>;
}

/**
 * Measure precision for pml_discover scoring.
 *
 * Pure semantic matching - pml_discover doesn't use graph context.
 * Formula: score = semantic × reliability (via computeDiscoverScore)
 */
async function measurePrecision(
  vectorSearch: UnifiedVectorSearch,
): Promise<PrecisionResult> {
  let hit1 = 0;
  let hit3 = 0;
  let hit5 = 0;
  let mrrSum = 0;
  const byDifficulty: Record<string, { hit1: number; hit5: number; count: number }> = {
    easy: { hit1: 0, hit5: 0, count: 0 },
    medium: { hit1: 0, hit5: 0, count: 0 },
    hard: { hit1: 0, hit5: 0, count: 0 },
  };
  const queryResults: PrecisionResult["queryResults"] = [];

  for (const test of queryTests) {
    // pml_discover: pure semantic matching
    const results = await unifiedSearch(
      vectorSearch,
      graph,
      nodes,
      test.query,
      {
        contextNodes: test.context || [],
        limit: 10,
      },
    );

    const rankedIds = results.map((r) => r.nodeId);
    const rank = rankedIds.indexOf(test.expectedTop1) + 1;

    // Initialize difficulty bucket if not exists
    if (!byDifficulty[test.difficulty]) {
      byDifficulty[test.difficulty] = { hit1: 0, hit5: 0, count: 0 };
    }

    if (rank === 1) {
      hit1++;
      byDifficulty[test.difficulty].hit1++;
    }
    if (rank >= 1 && rank <= 3) hit3++;
    if (rank >= 1 && rank <= 5) {
      hit5++;
      byDifficulty[test.difficulty].hit5++;
    }
    if (rank > 0) mrrSum += 1 / rank;

    byDifficulty[test.difficulty].count++;

    queryResults.push({
      query: test.query,
      expected: test.expectedTop1,
      actual: rankedIds[0] || "none",
      rank: rank || -1,
      correct: rank === 1,
      difficulty: test.difficulty,
    });
  }

  const n = queryTests.length;
  return {
    hit1: hit1 / n,
    hit3: hit3 / n,
    hit5: hit5 / n,
    mrr: mrrSum / n,
    byDifficulty,
    queryResults,
  };
}

// ============================================================================
// Main Benchmark
// ============================================================================

/**
 * Main benchmark for pml_discover precision.
 *
 * Tests semantic search with reliability scoring (the actual formula used by pml_discover).
 * Graph context is NOT used in pml_discover - it's only for predictNextNode (SHGAT+DR-DSP).
 */
async function runBenchmark() {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║   pml_discover Precision Benchmark (Real BGE-M3 Embeddings) ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log("Formula: score = semantic × reliability (Story 10.6)");
  console.log("NOTE: Alpha/graph NOT used in pml_discover (no context)\n");

  console.log("🔄 Loading BGE-M3 model (may take 60-90s first time)...");
  const startLoad = performance.now();

  const embedder = new EmbeddingModel();
  await embedder.load();

  console.log(`✓ Model loaded in ${((performance.now() - startLoad) / 1000).toFixed(1)}s\n`);

  try {
    console.log("📊 Pre-computing embeddings for nodes...");
    const { vectorSearch } = await createRealVectorSearch(embedder, nodes);
    console.log(`✓ ${nodes.size} node embeddings computed\n`);

    // ========================================================================
    // Test pml_discover precision (pure semantic × reliability)
    // ========================================================================
    console.log("🔍 Testing pml_discover precision (semantic × reliability)...\n");

    const precision = await measurePrecision(vectorSearch);

    // Print summary
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║                    PRECISION RESULTS                     ║");
    console.log("╠══════════════════════════════════════════════════════════╣");
    console.log(`║ Hit@1:  ${(precision.hit1 * 100).toFixed(1).padStart(5)}%                                        ║`);
    console.log(`║ Hit@3:  ${(precision.hit3 * 100).toFixed(1).padStart(5)}%                                        ║`);
    console.log(`║ Hit@5:  ${(precision.hit5 * 100).toFixed(1).padStart(5)}%                                        ║`);
    console.log(`║ MRR:    ${precision.mrr.toFixed(3).padStart(6)}                                        ║`);
    console.log("╚══════════════════════════════════════════════════════════╝\n");

    // Print detailed results by difficulty
    console.log("📋 Detailed Results:");
    console.log("─".repeat(70));

    for (const difficulty of ["easy", "medium", "hard"]) {
      const tests = precision.queryResults.filter((r) => r.difficulty === difficulty);
      if (tests.length === 0) continue;
      const stats = precision.byDifficulty[difficulty];
      console.log(`\n[${difficulty.toUpperCase()}] Hit@1: ${stats.hit1}/${stats.count}, Hit@5: ${stats.hit5}/${stats.count}`);
      for (const r of tests) {
        const icon = r.correct ? "✅" : r.rank > 0 && r.rank <= 5 ? "🔶" : "❌";
        console.log(`${icon} "${r.query.substring(0, 50)}${r.query.length > 50 ? "..." : ""}"`);
        console.log(`   Expected: ${r.expected} | Got: ${r.actual} | Rank: ${r.rank}`);
      }
    }
    console.log("\n" + "─".repeat(70) + "\n");

    // Assertions
    console.log("🧪 Running assertions...");
    assertGreater(precision.hit1, 0.55, "Hit@1 should be > 55%");
    console.log("   ✓ Hit@1 > 55%");
    assertGreater(precision.hit5, 0.85, "Hit@5 should be > 85% (production threshold)");
    console.log("   ✓ Hit@5 > 85%");
    assertGreater(precision.mrr, 0.7, "MRR should be > 0.7");
    console.log("   ✓ MRR > 0.7");

    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║                    BENCHMARK PASSED                        ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");

  } finally {
    console.log("🧹 Disposing embedding model...");
    await embedder.dispose();
  }
}

// ============================================================================
// Run
// ============================================================================

if (import.meta.main) {
  await runBenchmark();
}

// Also export for Deno.bench latency tests (with mock, not real embeddings)
export { queryTests, nodes, graph };

// ============================================================================
// Deno.bench Latency Benchmarks (using mocks for fast execution)
//
// pml_discover formula: score = semantic × reliability
// Pure semantic matching, no graph context.
// ============================================================================

// Pre-compute mock vector search for benchmarks
const mockVectorSearch = createMockVectorSearch(nodes);

Deno.bench({
  name: "unifiedSearch - single query (mock embeddings)",
  async fn() {
    await unifiedSearch(
      mockVectorSearch,
      graph,
      nodes,
      "read a file from disk",
      { limit: 10, minScore: 0.3 },
    );
  },
});

Deno.bench({
  name: "unifiedSearch - capability lookup",
  async fn() {
    await unifiedSearch(
      mockVectorSearch,
      graph,
      nodes,
      "backup and sync data",
      { limit: 5, minScore: 0.3 },
    );
  },
});

Deno.bench({
  name: "unifiedSearch - large limit",
  async fn() {
    await unifiedSearch(
      mockVectorSearch,
      graph,
      nodes,
      "database operations",
      { limit: 50, minScore: 0.1 },
    );
  },
});

// Test computeDiscoverScore from discover-handler (simplified formula)
Deno.bench({
  name: "computeDiscoverScore - simplified formula (semantic × reliability)",
  fn() {
    // Simulate scoring 10 results with different success rates
    for (let i = 0; i < 10; i++) {
      computeDiscoverScore(0.85 + i * 0.01, 0.8 + i * 0.02);
    }
  },
});

Deno.bench({
  name: "computeDiscoverScore - with penalty (low successRate)",
  fn() {
    // Success rate < 0.5 triggers penalty factor 0.1
    computeDiscoverScore(0.9, 0.3);
  },
});

Deno.bench({
  name: "computeDiscoverScore - with boost (high successRate)",
  fn() {
    // Success rate > 0.9 triggers boost factor 1.2
    computeDiscoverScore(0.9, 0.95);
  },
});
