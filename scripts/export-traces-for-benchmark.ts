#!/usr/bin/env -S deno run --allow-all
/**
 * Export Execution Traces for Benchmark Testing
 *
 * Exports traces from PostgreSQL to a JSON format compatible with
 * the SHGAT benchmark fixtures.
 *
 * Usage:
 *   deno run --allow-all scripts/export-traces-for-benchmark.ts [output-file]
 *
 * Environment:
 *   DATABASE_URL - PostgreSQL connection string (default: from .env)
 *
 * Output format:
 * {
 *   "metadata": { ... },
 *   "traces": [...],
 *   "capabilities": [...],
 *   "tools": [...],
 *   "trainingExamples": [...],
 *   "testQueries": [...]
 * }
 */

import { load } from "@std/dotenv";
import { getDb, isCloudMode } from "../src/db/mod.ts";
import { ExecutionTraceStore } from "../src/capabilities/execution-trace-store.ts";

// Load environment
await load({ export: true });

console.log(`🔌 Connecting to database (${isCloudMode() ? "PostgreSQL" : "PGlite"})...`);
const db = await getDb();
const traceStore = new ExecutionTraceStore(db);

// Get stats first
const stats = await traceStore.getStats();
console.log(`📊 Database stats:`);
console.log(`   Total traces: ${stats.totalTraces}`);
console.log(`   Successful: ${stats.successfulTraces}`);
console.log(`   Avg duration: ${stats.avgDurationMs.toFixed(0)}ms`);
console.log(`   Avg priority: ${stats.avgPriority.toFixed(3)}`);

if (stats.totalTraces === 0) {
  console.log("⚠️  No traces found in database. Nothing to export.");
  Deno.exit(0);
}

// Fetch all traces with embeddings
console.log("\n📥 Fetching traces...");
const allTraces = await traceStore.getHighPriorityTraces(1000);

// Filter traces with embeddings (required for SHGAT training)
const tracesWithEmbeddings = allTraces.filter((t) =>
  t.intentEmbedding && t.intentEmbedding.length > 0
);

console.log(`   Total fetched: ${allTraces.length}`);
console.log(`   With embeddings: ${tracesWithEmbeddings.length}`);

// Extract unique capabilities
const capabilityIds = new Set<string>();
for (const trace of tracesWithEmbeddings) {
  if (trace.capabilityId) {
    capabilityIds.add(trace.capabilityId);
  }
}

// Fetch capability details
console.log("\n📦 Fetching capabilities...");
const capabilities: Array<{
  id: string;
  embedding?: number[];
  toolsUsed: string[];
  successRate: number;
  description?: string;
}> = [];

for (const capId of capabilityIds) {
  const capResult = await db.query(
    `SELECT pattern_id, dag_structure, success_rate, description, intent_embedding
     FROM workflow_pattern WHERE pattern_id = $1`,
    [capId],
  );
  if (capResult.length > 0) {
    const row = capResult[0];
    // Extract tools from dag_structure JSONB
    let toolsUsed: string[] = [];
    if (row.dag_structure) {
      const dag = typeof row.dag_structure === "string"
        ? JSON.parse(row.dag_structure)
        : row.dag_structure;
      // Format 1: Direct tools_used array (code_execution type)
      if (dag.tools_used && Array.isArray(dag.tools_used)) {
        toolsUsed = dag.tools_used;
      } // Format 2: DAG with tasks array
      else if (dag.tasks && Array.isArray(dag.tasks)) {
        toolsUsed = dag.tasks.map((t: { tool?: string }) => t.tool).filter(Boolean);
      } // Format 3: Static structure with nodes
      else if (dag.nodes && Array.isArray(dag.nodes)) {
        toolsUsed = dag.nodes
          .filter((n: { type?: string }) => n.type === "task")
          .map((n: { tool?: string }) => n.tool)
          .filter(Boolean);
      }
    }
    // Parse intent_embedding (vector column)
    let embedding: number[] | undefined;
    if (row.intent_embedding) {
      if (Array.isArray(row.intent_embedding)) {
        embedding = row.intent_embedding as number[];
      } else if (typeof row.intent_embedding === "string") {
        const embStr = row.intent_embedding as string;
        const cleaned = embStr.replace(/^\[|\]$/g, "");
        embedding = cleaned.split(",").map(Number);
      }
    }
    capabilities.push({
      id: row.pattern_id as string,
      embedding,
      toolsUsed,
      successRate: (row.success_rate as number) || 0.5,
      description: row.description as string | undefined,
    });
  }
}

console.log(`   Found: ${capabilities.length} capabilities`);

// Extract unique tools
const toolIds = new Set<string>();
for (const cap of capabilities) {
  for (const tool of cap.toolsUsed) {
    toolIds.add(tool);
  }
}
for (const trace of tracesWithEmbeddings) {
  for (const task of trace.taskResults) {
    if (task.tool) {
      toolIds.add(task.tool);
    }
  }
}

console.log(`   Found: ${toolIds.size} unique tools`);

// Build training examples from traces
console.log("\n🎓 Building training examples...");
const trainingExamples: Array<{
  intentEmbedding: number[];
  contextTools: string[];
  candidateId: string;
  outcome: number;
}> = [];

for (const trace of tracesWithEmbeddings) {
  if (!trace.capabilityId) continue;

  // Extract context tools from task results
  const contextTools = trace.taskResults
    .slice(0, 3)
    .map((t) => t.tool)
    .filter(Boolean);

  trainingExamples.push({
    intentEmbedding: trace.intentEmbedding!,
    contextTools,
    candidateId: trace.capabilityId,
    outcome: trace.success ? 1 : 0,
  });
}

console.log(`   Generated: ${trainingExamples.length} training examples`);

// Build test queries (use most recent traces with varied intents)
console.log("\n📝 Building test queries...");
const testQueries: Array<{
  intent: string;
  intentEmbedding: number[];
  expectedCapability: string;
  difficulty: string;
}> = [];

// Take last 20% as test set
const testCount = Math.max(5, Math.floor(tracesWithEmbeddings.length * 0.2));
const testTraces = tracesWithEmbeddings
  .filter((t) => t.capabilityId && t.intentText)
  .slice(-testCount);

for (const trace of testTraces) {
  testQueries.push({
    intent: trace.intentText!,
    intentEmbedding: trace.intentEmbedding!,
    expectedCapability: trace.capabilityId!,
    difficulty: trace.success ? "easy" : "hard",
  });
}

console.log(`   Generated: ${testQueries.length} test queries`);

// Build output structure
const output = {
  metadata: {
    exportedAt: new Date().toISOString(),
    source: "PostgreSQL execution_trace",
    stats: {
      totalTraces: allTraces.length,
      tracesWithEmbeddings: tracesWithEmbeddings.length,
      capabilities: capabilities.length,
      tools: toolIds.size,
      trainingExamples: trainingExamples.length,
      testQueries: testQueries.length,
    },
  },
  nodes: {
    capabilities: capabilities.map((c) => ({
      id: c.id,
      embedding: c.embedding,
      toolsUsed: c.toolsUsed,
      successRate: c.successRate,
      description: c.description,
    })),
    tools: Array.from(toolIds).map((id) => ({
      id,
      // Note: tool embeddings need to be generated separately
    })),
  },
  episodicEvents: trainingExamples.map((ex, i) => ({
    intent: `trace_${i}`,
    intentEmbedding: ex.intentEmbedding,
    contextTools: ex.contextTools,
    selectedCapability: ex.candidateId,
    outcome: ex.outcome === 1 ? "success" : "failure",
  })),
  testQueries,
};

// Write output
const outputFile = Deno.args[0] || "tests/benchmarks/fixtures/scenarios/production-traces.json";
console.log(`\n💾 Writing to ${outputFile}...`);

await Deno.writeTextFile(outputFile, JSON.stringify(output, null, 2));

console.log(`\n✅ Export complete!`);
console.log(`   File: ${outputFile}`);
console.log(
  `   Size: ${(new TextEncoder().encode(JSON.stringify(output)).length / 1024).toFixed(1)} KB`,
);

// Close database connection
await db.close();
