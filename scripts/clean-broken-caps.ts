/**
 * Clean up capabilities with empty tools_used (created before JSONB fix)
 */
import { getDb } from "../src/db/mod.ts";

const db = await getDb();

// Find capabilities with empty tools_used
const broken = await db.query(`
  SELECT pattern_id, description, created_at
  FROM workflow_pattern
  WHERE dag_structure->>'tools_used' = '[]'
     OR dag_structure->>'tools_used' IS NULL
`);

console.log(`Found ${broken.length} capabilities with empty tools_used`);

if (broken.length > 0) {
  console.log("\nCapabilities to delete:");
  for (const cap of broken) {
    console.log(`  - ${cap.description} (${cap.pattern_id})`);
  }

  // Delete them
  const result = await db.query(`
    DELETE FROM workflow_pattern
    WHERE dag_structure->>'tools_used' = '[]'
       OR dag_structure->>'tools_used' IS NULL
    RETURNING pattern_id
  `);

  console.log(`\n✓ Deleted ${result.length} broken capabilities`);
}

// Show remaining
const remaining = await db.query(`
  SELECT pattern_id, description,
         dag_structure->>'tools_used' as tools
  FROM workflow_pattern
  LIMIT 5
`);

console.log(`\nRemaining capabilities: ${remaining.length}`);
for (const cap of remaining) {
  console.log(`  - ${cap.description}: ${cap.tools}`);
}

await db.close();
