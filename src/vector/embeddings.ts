/**
 * Embedding Generation Module
 *
 * Generates 1024-dimensional embeddings for tool schemas using BGE-M3
 * via @huggingface/transformers. Includes caching and progress tracking.
 *
 * @module vector/embeddings
 */

import { pipeline } from "@huggingface/transformers";
import * as log from "@std/log";
import type { PGliteClient } from "../db/client.ts";
import type { MCPTool } from "../mcp/types.ts";

/**
 * Tool schema from database
 */
export interface ToolSchema {
  tool_id: string;
  server_id: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  cached_at?: Date;
}

/**
 * Input for embedding generation
 */
export interface ToolEmbeddingInput {
  toolId: string;
  text: string;
  serverId: string;
  toolName: string;
}

/**
 * Result of embedding generation
 */
export interface EmbeddingGenerationResult {
  toolId: string;
  embedding: number[];
  generatedAt: Date;
  cachedFromPrevious: boolean;
}

/**
 * Statistics from batch embedding generation
 */
export interface EmbeddingStats {
  totalTools: number;
  newlyGenerated: number;
  cachedCount: number;
  duration: number;
}

/**
 * Interface for embedding models
 * Allows mocking in tests while maintaining type safety
 */
export interface EmbeddingModelInterface {
  load(): Promise<void>;
  encode(text: string): Promise<number[]>;
  isLoaded(): boolean;
  dispose(): Promise<void>;
}

/**
 * BGE-M3 Embedding Model
 *
 * Lazy-loads the model on first use and provides encoding functionality
 * for generating 1024-dimensional embeddings.
 */
export class EmbeddingModel {
  // deno-lint-ignore no-explicit-any
  private model: any = null;
  private loading: Promise<void> | null = null;

  /**
   * Load the BGE-M3 model
   * Downloads model weights (~400MB) on first run from HuggingFace Hub
   */
  async load(): Promise<void> {
    if (this.model) {
      return; // Already loaded
    }

    if (this.loading) {
      return this.loading; // Wait for ongoing load
    }

    this.loading = (async () => {
      try {
        log.info("🔄 Loading BGE-M3 model...");
        log.info("   This may take 60-90 seconds on first run (downloading model)");

        const startTime = performance.now();

        this.model = await pipeline(
          "feature-extraction",
          "Xenova/bge-m3",
        );

        const duration = ((performance.now() - startTime) / 1000).toFixed(1);
        log.info(`✓ Model loaded successfully in ${duration}s`);
      } catch (error) {
        log.error(`✗ Failed to load BGE model: ${error}`);
        throw new Error(`Model loading failed: ${error}`);
      }
    })();

    await this.loading;
    this.loading = null;
  }

  /**
   * Generate 1024-dimensional embedding for text
   *
   * @param text Input text (will be truncated to 512 tokens by BGE)
   * @returns 1024-dimensional normalized embedding vector
   */
  async encode(text: string): Promise<number[]> {
    if (!this.model) {
      await this.load();
    }

    if (!this.model) {
      throw new Error("Model not loaded");
    }

    try {
      const output = await this.model(text, {
        pooling: "mean",
        normalize: true,
      });

      // Convert to array and ensure it's 1024 dimensions
      const embedding = Array.from(output.data as Float32Array);

      if (embedding.length !== 1024) {
        throw new Error(
          `Expected 1024 dimensions, got ${embedding.length}`,
        );
      }

      return embedding;
    } catch (error) {
      log.error(`✗ Encoding failed for text: ${text.substring(0, 100)}...`);
      throw error;
    }
  }

  /**
   * Check if model is loaded and ready
   */
  isLoaded(): boolean {
    return this.model !== null;
  }

  /**
   * Dispose of the model and free resources
   * Call this when the model is no longer needed to prevent resource leaks
   */
  async dispose(): Promise<void> {
    if (!this.model) {
      return;
    }

    try {
      // Try various cleanup methods that might exist on the model
      if (typeof this.model.dispose === "function") {
        await this.model.dispose();
      } else if (typeof this.model.destroy === "function") {
        await this.model.destroy();
      } else if (typeof this.model.close === "function") {
        await this.model.close();
      } else if (this.model.model && typeof this.model.model.dispose === "function") {
        // Some pipelines have nested model objects
        await this.model.model.dispose();
      } else if (
        this.model.model && this.model.model.session &&
        typeof this.model.model.session.release === "function"
      ) {
        // ONNX runtime sessions have release() method
        await this.model.model.session.release();
      }
    } catch (error) {
      log.warn(`Failed to dispose embedding model: ${error}`);
    }

    this.model = null;
    this.loading = null;
  }
}

/**
 * Convert tool schema to text for embedding generation
 *
 * Concatenates: name + description + parameter names + parameter descriptions
 * This provides semantic context for the embedding model.
 *
 * **Important:** BGE-M3 truncates at 512 tokens (~2000 chars).
 * Excessively long inputs will be silently truncated, potentially affecting embedding quality.
 *
 * @param schema Tool schema (from database or MCP)
 * @returns Concatenated text string
 */
export function schemaToText(schema: ToolSchema | MCPTool): string {
  const parts: string[] = [];

  // Add tool name
  if ("name" in schema && schema.name) {
    parts.push(schema.name);
  }

  // Add description
  if (schema.description) {
    parts.push(schema.description);
  }

  // Extract and add input parameters
  const inputSchema = "inputSchema" in schema ? schema.inputSchema : schema.input_schema || {};
  if (typeof inputSchema === "object" && inputSchema !== null) {
    const properties = (inputSchema as any).properties || {};

    for (const [paramName, paramDef] of Object.entries(properties)) {
      if (typeof paramDef === "object" && paramDef !== null) {
        const def = paramDef as Record<string, unknown>;
        const description = def.description as string || "";
        parts.push(`${paramName}: ${description}`);
      }
    }
  }

  // Join with separator for better readability
  const text = parts.filter(Boolean).join(" | ");

  // Validate text length (BGE truncates at 512 tokens ≈ 2000 chars)
  const MAX_RECOMMENDED_LENGTH = 2000; // ~512 tokens
  if (text.length > MAX_RECOMMENDED_LENGTH) {
    const toolName = ("name" in schema && schema.name) || "unknown";
    log.warn(
      `⚠️  Schema text for tool "${toolName}" exceeds recommended length (${text.length} chars > ${MAX_RECOMMENDED_LENGTH} chars)`,
    );
    log.warn(
      `   BGE model will truncate to ~512 tokens, which may affect embedding quality`,
    );
  }

  return text;
}

/**
 * Simple progress tracker for console output
 */
class ProgressTracker {
  private current = 0;
  private total: number;
  private lastPercent = -1;
  private startTime = performance.now();

  constructor(total: number) {
    this.total = total;
  }

  increment(): void {
    this.current++;
    const percent = Math.floor((this.current / this.total) * 100);

    // Only update display every 5% or at completion
    if (percent !== this.lastPercent && (percent % 5 === 0 || this.current === this.total)) {
      const elapsed = ((performance.now() - this.startTime) / 1000).toFixed(1);
      const bar = "█".repeat(Math.floor(percent / 5)) + "░".repeat(20 - Math.floor(percent / 5));

      console.log(
        `  [${bar}] ${percent}% (${this.current}/${this.total}) - ${elapsed}s elapsed`,
      );

      this.lastPercent = percent;
    }
  }

  finish(): number {
    return (performance.now() - this.startTime) / 1000;
  }
}

/**
 * Generate embeddings for all tool schemas in the database
 *
 * Features:
 * - Lazy model loading
 * - Caching (skips if embedding exists)
 * - Progress bar during generation
 * - Batch transaction for performance
 *
 * @param db PGlite database client
 * @param model Embedding model (will be loaded if needed)
 * @returns Statistics about generation
 */
export async function generateEmbeddings(
  db: PGliteClient,
  model: EmbeddingModel,
): Promise<EmbeddingStats> {
  log.info("🔄 Starting embedding generation...");

  const startTime = performance.now();
  let newlyGenerated = 0;
  let cachedCount = 0;
  let totalTools = 0;

  try {
    // Ensure model is loaded
    await model.load();

    // 1. Fetch all tool schemas from database
    const schemasResult = await db.query(
      `SELECT tool_id, server_id, name, description, input_schema, output_schema, cached_at
       FROM tool_schema
       ORDER BY server_id, name`,
    );

    if (schemasResult.length === 0) {
      log.warn("No tool schemas found in database");
      return {
        totalTools: 0,
        newlyGenerated: 0,
        cachedCount: 0,
        duration: 0,
      };
    }

    totalTools = schemasResult.length;
    log.info(`Found ${totalTools} tool schemas to process`);

    // 2. Initialize progress tracker
    const progress = new ProgressTracker(totalTools);

    // 3. Process schemas in batches for better performance
    const BATCH_SIZE = 20; // Process 20 tools per transaction
    const batches: typeof schemasResult[] = [];

    // Split into batches
    for (let i = 0; i < schemasResult.length; i += BATCH_SIZE) {
      batches.push(schemasResult.slice(i, i + BATCH_SIZE));
    }

    log.info(`Processing ${batches.length} batches of up to ${BATCH_SIZE} tools each`);

    // Process each batch in a transaction
    for (const batch of batches) {
      try {
        await db.transaction(async (tx) => {
          for (const row of batch) {
            try {
              const schema: ToolSchema = {
                tool_id: row.tool_id as string,
                server_id: row.server_id as string,
                name: row.name as string,
                description: row.description as string || "",
                input_schema: (typeof row.input_schema === "string"
                  ? JSON.parse(row.input_schema)
                  : row.input_schema) as Record<string, unknown>,
                output_schema: row.output_schema
                  ? (typeof row.output_schema === "string"
                    ? JSON.parse(row.output_schema)
                    : row.output_schema) as Record<string, unknown>
                  : undefined,
              };

              // 3a. Check if embedding already exists (AC6: caching)
              const existing = await tx.query(
                "SELECT tool_id, created_at FROM tool_embedding WHERE tool_id = $1",
                [schema.tool_id],
              );

              if (existing.length > 0) {
                // Cache hit - skip generation
                cachedCount++;
                progress.increment();
                continue;
              }

              // 3b. Generate new embedding
              const text = schemaToText(schema);
              const embedding = await model.encode(text);

              // 3c. Store in database with ON CONFLICT for upsert
              // Include full schema in metadata for pml_discover response
              await tx.query(
                `INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding, metadata, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (tool_id) DO UPDATE
                 SET embedding = EXCLUDED.embedding,
                     metadata = EXCLUDED.metadata,
                     created_at = NOW()`,
                [
                  schema.tool_id,
                  schema.server_id,
                  schema.name,
                  `[${embedding.join(",")}]`,
                  JSON.stringify({
                    description: schema.description,
                    schema: {
                      inputSchema: schema.input_schema,
                      outputSchema: schema.output_schema,
                    },
                    generated_at: new Date().toISOString(),
                  }),
                ],
              );

              // Track metric for getPeriodStats().newNodesAdded
              await tx.query(
                `INSERT INTO metrics (metric_name, value, metadata, timestamp)
                 VALUES ('tool_embedded', 1, $1, NOW())`,
                [JSON.stringify({ tool_id: schema.tool_id })],
              );

              newlyGenerated++;
              progress.increment();
            } catch (error) {
              // Log individual tool failure but continue processing
              log.error(`✗ Failed to process tool ${row.tool_id as string}: ${error}`);
              progress.increment();
              // Continue with next tool
            }
          }
        });
      } catch (error) {
        // Log batch failure but continue with next batch
        log.error(`✗ Failed to process batch: ${error}`);
        // Progress already incremented for failed tools in the batch
      }
    }

    const duration = progress.finish();

    log.info(`✓ Embedding generation complete in ${duration.toFixed(1)}s`);
    log.info(`  - New embeddings: ${newlyGenerated}`);
    log.info(`  - Cached: ${cachedCount}`);
    log.info(`  - Total: ${totalTools}`);

    return {
      totalTools,
      newlyGenerated,
      cachedCount,
      duration,
    };
  } catch (error) {
    // Top-level error handling for database/model failures
    const duration = (performance.now() - startTime) / 1000;
    log.error(`✗ Embedding generation failed after ${duration.toFixed(1)}s: ${error}`);
    log.error(`  - Partial results: ${newlyGenerated} generated, ${cachedCount} cached`);

    // Return partial results to allow graceful degradation
    return {
      totalTools,
      newlyGenerated,
      cachedCount,
      duration,
    };
  }
}

/**
 * Generate embedding for a single tool (useful for incremental updates)
 *
 * @param db Database client
 * @param model Embedding model
 * @param toolId Tool ID to generate embedding for
 * @returns Generation result
 */
export async function generateEmbeddingForTool(
  db: PGliteClient,
  model: EmbeddingModel,
  toolId: string,
): Promise<EmbeddingGenerationResult> {
  await model.load();

  // Fetch tool schema
  const row = await db.queryOne(
    "SELECT tool_id, server_id, name, description, input_schema FROM tool_schema WHERE tool_id = $1",
    [toolId],
  );

  if (!row) {
    throw new Error(`Tool schema not found: ${toolId}`);
  }

  const schema: ToolSchema = {
    tool_id: row.tool_id as string,
    server_id: row.server_id as string,
    name: row.name as string,
    description: row.description as string || "",
    input_schema:
      (typeof row.input_schema === "string"
        ? JSON.parse(row.input_schema)
        : row.input_schema) as Record<string, unknown>,
  };

  // Generate embedding
  const text = schemaToText(schema);
  const embedding = await model.encode(text);

  // Store in database
  await db.query(
    `INSERT INTO tool_embedding (tool_id, server_id, tool_name, embedding, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (tool_id) DO UPDATE
     SET embedding = EXCLUDED.embedding,
         metadata = EXCLUDED.metadata,
         created_at = NOW()`,
    [
      schema.tool_id,
      schema.server_id,
      schema.name,
      `[${embedding.join(",")}]`,
      JSON.stringify({
        schema_hash: text.substring(0, 100),
        generated_at: new Date().toISOString(),
      }),
    ],
  );

  return {
    toolId: schema.tool_id,
    embedding,
    generatedAt: new Date(),
    cachedFromPrevious: false,
  };
}
