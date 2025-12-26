import { getDb, isCloudMode } from "../src/db/mod.ts";

console.log("Cloud mode:", isCloudMode());

const db = await getDb();

// Check all capabilities without filter
const caps = await db.query(`
  SELECT pattern_id, description,
         dag_structure::text as dag_text
  FROM workflow_pattern
  ORDER BY created_at DESC
  LIMIT 10
`);

console.log(`=== Found ${caps.length} capabilities ===`);
for (const cap of caps) {
  console.log("\n" + (cap.description || "no description") + " (" + cap.pattern_id + "):");
  const dagStr = String(cap.dag_text || "null");
  console.log("  dag: " + dagStr.substring(0, 200));

  // Check if tools_used is populated
  if (dagStr.includes("tools_used")) {
    const match = dagStr.match(/"tools_used":\s*\[([^\]]*)\]/);
    if (match) {
      console.log("  tools_used: [" + match[1] + "]");
    }
  }
}

await db.close();
