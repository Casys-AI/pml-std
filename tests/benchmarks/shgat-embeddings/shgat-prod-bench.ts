import { loadScenario } from "../fixtures/scenario-loader.ts";
import {
  createSHGATFromCapabilities,
  trainSHGATOnEpisodes,
} from "../../../src/graphrag/algorithms/shgat.ts";

console.log("📥 Loading production traces...");
const scenario = await loadScenario("production-traces");

console.log(`\n📊 Production Data Stats:`);
console.log(`   Capabilities: ${scenario.nodes.capabilities.length}`);
console.log(`   Tools: ${scenario.nodes.tools.length}`);
console.log(`   Episodic Events: ${scenario.episodicEvents?.length || 0}`);
console.log(`   Test Queries: ${scenario.testQueries?.length || 0}`);

// Filter capabilities with embeddings
const capsWithEmbeddings = scenario.nodes.capabilities.filter((c: { embedding?: number[] }) => c.embedding && c.embedding.length > 0);
console.log(`   Caps with embeddings: ${capsWithEmbeddings.length}`);

if (capsWithEmbeddings.length < 5) {
  console.log("⚠️  Not enough capabilities with embeddings for meaningful benchmark");
  Deno.exit(0);
}

// Create SHGAT model
console.log("\n🧠 Creating SHGAT model...");
const caps = capsWithEmbeddings.map((c: { id: string; embedding: number[]; toolsUsed?: string[]; successRate?: number }) => ({
  id: c.id,
  embedding: c.embedding,
  toolsUsed: c.toolsUsed || [],
  successRate: c.successRate || 0.5,
  parents: [] as string[],
  children: [] as string[],
}));

const toolEmbeddings = new Map<string, number[]>();

// Note: Don't override hiddenDim - let adaptive config set it correctly for preserveDim mode
const shgat = createSHGATFromCapabilities(caps, toolEmbeddings);
console.log(`   Registered: ${caps.length} capabilities`);

// Build training examples from episodic events
interface EpisodicEvent {
  intentEmbedding?: number[];
  contextTools?: string[];
  selectedCapability: string;
  outcome: string;
}

const trainingExamples = (scenario.episodicEvents || [])
  .filter((e: EpisodicEvent) => e.intentEmbedding && e.intentEmbedding.length > 0)
  .map((e: EpisodicEvent) => ({
    intentEmbedding: e.intentEmbedding!,
    contextTools: e.contextTools || [],
    candidateId: e.selectedCapability,
    outcome: e.outcome === "success" ? 1 : 0,
  }));

console.log(`   Training examples: ${trainingExamples.length}`);

// Train
if (trainingExamples.length > 0) {
  console.log("\n🎓 Training SHGAT...");
  const trainResult = trainSHGATOnEpisodes(shgat, trainingExamples.slice(0, 200), {
    epochs: 10,
    learningRate: 0.01,
  });
  console.log(`   Training complete (${trainingExamples.length} examples)`);
}

// Evaluate on test queries
console.log("\n📈 Evaluating on test queries...");

interface TestQuery {
  intentEmbedding?: number[];
  expectedCapability: string;
}

const testQueries: TestQuery[] = scenario.testQueries || [];

// Build index-to-ID mapping
const idxToId = new Map<number, string>();
caps.forEach((c, i) => idxToId.set(i, c.id));

let hits1 = 0, hits3 = 0;
let mrrSum = 0;
let evaluated = 0;

for (const query of testQueries) {
  if (!query.intentEmbedding || query.intentEmbedding.length === 0) continue;

  const scores = shgat.scoreAllCapabilities(query.intentEmbedding);
  // Map numeric indices back to capability IDs
  const sorted = [...scores.entries()]
    .map(([idx, score]) => [idxToId.get(idx as number) || String(idx), score] as [string, number])
    .sort((a, b) => b[1] - a[1]);

  const idx = sorted.findIndex(([id]) => id === query.expectedCapability);
  const rank = idx >= 0 ? idx + 1 : 0; // 0 = not found

  if (rank === 1) hits1++;
  if (rank > 0 && rank <= 3) hits3++;
  if (rank > 0) mrrSum += 1 / rank;
  evaluated++;

  // Debug first few
  if (evaluated <= 3) {
    const topIds = sorted.slice(0, 3).map(([id]) => id.slice(0, 8));
    console.log(`   Query ${evaluated}: expected=${query.expectedCapability.slice(0,8)}... rank=${rank}`);
    console.log(`      Top 3: ${topIds.join(", ")}`);
  }
}

console.log(`\n=== Production Traces Benchmark ===`);
console.log(`Test queries: ${evaluated}`);
console.log(`MRR: ${(mrrSum / evaluated).toFixed(3)}`);
console.log(`Hit@1: ${(hits1 / evaluated * 100).toFixed(1)}%`);
console.log(`Hit@3: ${(hits3 / evaluated * 100).toFixed(1)}%`);
