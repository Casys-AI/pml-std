/**
 * Seed Operation Embeddings Script
 *
 * Generates and inserts embeddings for all 62 pure code operations
 * into the tool_embedding table for SHGAT semantic learning.
 *
 * Usage:
 *   deno run --allow-all scripts/seed-operation-embeddings.ts
 *
 * Phase 2a: Operation Embeddings for Uniform Graph Structure
 */

import { setupDatabase } from "../src/db/mod.ts";
import { EmbeddingModel } from "../src/vector/embeddings.ts";
import { OPERATION_DESCRIPTIONS } from "../src/capabilities/operation-descriptions.ts";
import * as log from "@std/log";

async function seedOperationEmbeddings() {
  log.info("🌱 Seeding operation embeddings for SHGAT learning");

  // 1. Setup database
  log.info("📊 Connecting to database...");
  const db = await setupDatabase();

  // 2. Load embedding model
  log.info("🤖 Loading BGE-M3 embedding model...");
  const embeddingModel = new EmbeddingModel();
  await embeddingModel.load();
  log.info("✅ Model loaded successfully");

  // 3. Generate and insert embeddings
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  log.info(`📝 Processing ${OPERATION_DESCRIPTIONS.length} code operations...`);

  for (const operation of OPERATION_DESCRIPTIONS) {
    try {
      // Generate embedding from rich semantic description
      log.debug(`  Generating embedding for ${operation.toolId}...`);
      const embedding = await embeddingModel.encode(operation.description);

      // Check if already exists
      const existing = await db.query(
        `SELECT tool_id FROM tool_embedding WHERE tool_id = $1`,
        [operation.toolId],
      );

      if (existing.length > 0) {
        // Update existing
        await db.query(
          `UPDATE tool_embedding
           SET embedding = $1::vector,
               tool_name = $2,
               metadata = $3::jsonb,
               created_at = NOW()
           WHERE tool_id = $4`,
          [
            `[${embedding.join(",")}]`,
            operation.name,
            JSON.stringify({
              description: operation.description,
              category: operation.category,
              source: "pure_operations",
            }),
            operation.toolId,
          ],
        );
        updated++;
        log.info(`  ↻ Updated ${operation.toolId}`);
      } else {
        // Insert new
        await db.query(
          `INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding, metadata, created_at)
           VALUES ($1, $2, $3, $4::vector, $5::jsonb, NOW())`,
          [
            operation.toolId,
            "code", // Server ID for code operations
            operation.name,
            `[${embedding.join(",")}]`,
            JSON.stringify({
              description: operation.description,
              category: operation.category,
              source: "pure_operations",
            }),
          ],
        );
        inserted++;
        log.info(`  ✓ Inserted ${operation.toolId}`);
      }
    } catch (error) {
      log.error(`  ✗ Failed to process ${operation.toolId}: ${error}`);
      skipped++;
    }
  }

  // 4. Verify results
  const totalInDB = await db.query(
    `SELECT COUNT(*) as count FROM tool_embedding WHERE tool_id LIKE 'code:%'`,
  );
  const count = totalInDB[0]?.count as number;

  log.info("\n📊 Seeding Summary:");
  log.info(`  ✅ Inserted: ${inserted}`);
  log.info(`  ↻ Updated: ${updated}`);
  log.info(`  ✗ Skipped: ${skipped}`);
  log.info(`  📈 Total code operations in DB: ${count}`);

  // 5. Test semantic similarity
  log.info("\n🔍 Testing semantic similarity...");
  const filterOp = OPERATION_DESCRIPTIONS.find((op) => op.toolId === "code:filter");
  const findOp = OPERATION_DESCRIPTIONS.find((op) => op.toolId === "code:find");

  if (filterOp && findOp) {
    const filterEmbedding = await embeddingModel.encode(filterOp.description);
    const findEmbedding = await embeddingModel.encode(findOp.description);

    // Cosine similarity
    const dotProduct = filterEmbedding.reduce((sum, val, i) => sum + val * findEmbedding[i], 0);
    const magFilter = Math.sqrt(filterEmbedding.reduce((sum, val) => sum + val * val, 0));
    const magFind = Math.sqrt(findEmbedding.reduce((sum, val) => sum + val * val, 0));
    const similarity = dotProduct / (magFilter * magFind);

    log.info(`  Similarity(filter, find) = ${similarity.toFixed(4)}`);
    log.info(`  Expected: High similarity (both are selection operations)`);
  }

  // 6. Cleanup
  await db.close();
  await embeddingModel.dispose();

  log.info("\n✅ Operation embeddings seeded successfully!");
  log.info("   SHGAT can now use semantic similarity for code operations");
}

// Run if called directly
if (import.meta.main) {
  await seedOperationEmbeddings();
}

export { seedOperationEmbeddings };
