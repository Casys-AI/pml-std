/**
 * Mock Embedding Model for Testing
 *
 * Provides a lightweight, deterministic replacement for EmbeddingModel
 * that doesn't require loading the heavy ONNX runtime.
 *
 * Returns consistent embeddings based on text hash for reproducible tests.
 *
 * @module tests/fixtures/mock-embedding-model
 */

import type { EmbeddingModelInterface } from "../../src/vector/embeddings.ts";

/**
 * MockEmbeddingModel - Drop-in replacement for EmbeddingModel in tests
 *
 * Implements EmbeddingModelInterface for type safety:
 * - Loads instantly (no ONNX)
 * - Returns deterministic embeddings (hash-based)
 * - Zero external dependencies
 */
export class MockEmbeddingModel implements EmbeddingModelInterface {
  // deno-lint-ignore no-explicit-any
  private model: any = null; // Compatibility with EmbeddingModel
  private loading: Promise<void> | null = null; // Compatibility with EmbeddingModel
  private loaded = false;

  /**
   * Mock load - instant, no network/disk I/O
   */
  async load(): Promise<void> {
    if (this.model) {
      return; // Already loaded
    }

    if (this.loading) {
      return this.loading; // Wait for ongoing load
    }

    this.loading = (async () => {
      // Instant load, no ONNX runtime
      this.model = {}; // Dummy model object
      this.loaded = true;
    })();

    await this.loading;
    this.loading = null;
  }

  /**
   * Generate deterministic 1024-dimensional embedding with semantic similarity
   *
   * Uses TF-IDF-inspired approach:
   * - Tokenizes text into words (lowercase, alphanumeric)
   * - Each word maps to specific dimensions via stable hash
   * - Word frequency determines magnitude
   * - Normalized for cosine similarity
   *
   * Texts with similar words will have high cosine similarity.
   *
   * @param text Input text
   * @returns 1024-dimensional vector with values in [-1, 1]
   */
  async encode(text: string): Promise<number[]> {
    if (!this.loaded) {
      await this.load();
    }

    // Common stop words to filter out (improves semantic similarity)
    const stopWords = new Set([
      "a",
      "an",
      "and",
      "are",
      "as",
      "at",
      "be",
      "by",
      "for",
      "from",
      "has",
      "he",
      "in",
      "is",
      "it",
      "its",
      "of",
      "on",
      "that",
      "the",
      "to",
      "was",
      "will",
      "with",
    ]);

    // Tokenize: lowercase, split on non-alphanumeric, filter empty and stop words
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0 && !stopWords.has(t));

    // Count term frequencies
    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    // Initialize embedding vector (1024 dimensions)
    const embedding = new Array(1024).fill(0);

    // Map each word to dimensions and add its TF score
    for (const [word, freq] of termFreq.entries()) {
      // Stable hash for word -> dimension mapping
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash) + word.charCodeAt(i);
        hash = hash & hash; // 32-bit
      }

      // Map to 30 dimensions per word for very high overlap on matching words
      // Use positive values only to avoid negative dot products that reduce similarity
      const numDims = 30;
      for (let i = 0; i < numDims; i++) {
        const dimIndex = Math.abs((hash + i * 1000) % 1024);
        // All positive contributions - matching words will always increase similarity
        embedding[dimIndex] += freq;
      }
    }

    // Normalize to unit length for cosine similarity
    const magnitude = Math.sqrt(
      embedding.reduce((sum, val) => sum + val * val, 0),
    );

    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  /**
   * Check if model is loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Dispose of resources (no-op for mock)
   */
  async dispose(): Promise<void> {
    this.model = null;
    this.loading = null;
    this.loaded = false;
  }
}
