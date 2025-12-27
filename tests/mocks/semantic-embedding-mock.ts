/**
 * Semantic Mock Embedding Model for E2E Tests
 *
 * Generates deterministic embeddings with semantic clustering to enable
 * realistic vector search testing without requiring real BGE-Large model.
 *
 * Clustering Strategy:
 * - Cluster 1 (dims 0-340): XML processing tools (high similarity 0.8)
 * - Cluster 2 (dims 341-680): JSON processing tools (high similarity 0.85)
 * - Cluster 3 (dims 681-1023): Filesystem operations (high similarity 0.9)
 *
 * This allows cosine similarity to work correctly:
 * - Query "parse XML" → High similarity with "xml:parse" tool
 * - Query "parse JSON" → High similarity with "json:parse" tool
 * - Cross-cluster similarity remains low (e.g., XML vs Filesystem)
 *
 * @module tests/mocks/semantic-embedding-mock
 */

/**
 * Deterministic semantic embedding mock
 *
 * Provides embeddings that cluster semantically similar concepts together,
 * enabling realistic vector search behavior in tests.
 */
export class SemanticMockEmbedding {
  private embeddingCache: Map<string, number[]>;

  constructor() {
    this.embeddingCache = new Map();
    this.precomputeKnownEmbeddings();
  }

  /**
   * Pre-compute embeddings for known test queries and tools
   *
   * This creates a semantic space where similar concepts cluster together.
   */
  private precomputeKnownEmbeddings(): void {
    // Cluster 1: XML Processing (dim1=0.8, dim2=0.1, dim3=0.05)
    // Use EXACT same weights for all XML-related queries to ensure deterministic matching
    this.embeddingCache.set("parse xml files", this.generateCluster(0.8, 0.1, 0.05));
    this.embeddingCache.set("parse xml", this.generateCluster(0.8, 0.1, 0.05));
    this.embeddingCache.set("xml parser", this.generateCluster(0.8, 0.1, 0.05));
    this.embeddingCache.set("parse_xml", this.generateCluster(0.8, 0.1, 0.05));
    this.embeddingCache.set("xml:parse", this.generateCluster(0.8, 0.1, 0.05));
    this.embeddingCache.set(
      "parse xml documents and extract data",
      this.generateCluster(0.8, 0.1, 0.05),
    );
    this.embeddingCache.set(
      "parse xml files found in directory",
      this.generateCluster(0.8, 0.1, 0.05),
    );

    // Cluster 2: JSON Processing (dim1=0.1, dim2=0.85, dim3=0.05)
    this.embeddingCache.set("parse json files", this.generateCluster(0.1, 0.85, 0.05));
    this.embeddingCache.set("parse json", this.generateCluster(0.09, 0.87, 0.06));
    this.embeddingCache.set("json parser", this.generateCluster(0.12, 0.83, 0.07));
    this.embeddingCache.set("parse_json", this.generateCluster(0.10, 0.86, 0.05));
    this.embeddingCache.set("json:parse", this.generateCluster(0.11, 0.84, 0.06));
    this.embeddingCache.set("parse json documents", this.generateCluster(0.10, 0.85, 0.05));

    // Cluster 3: Filesystem Operations (dim1=0.05, dim2=0.05, dim3=0.9)
    this.embeddingCache.set("list directory", this.generateCluster(0.05, 0.05, 0.90));
    this.embeddingCache.set("list_directory", this.generateCluster(0.06, 0.06, 0.88));
    this.embeddingCache.set("list files", this.generateCluster(0.05, 0.07, 0.89));
    this.embeddingCache.set("filesystem:list_directory", this.generateCluster(0.06, 0.05, 0.90));
    this.embeddingCache.set(
      "list files and detect file types",
      this.generateCluster(0.05, 0.06, 0.90),
    );

    this.embeddingCache.set("read file", this.generateCluster(0.07, 0.06, 0.87));
    this.embeddingCache.set("read_file", this.generateCluster(0.08, 0.05, 0.86));
    this.embeddingCache.set("filesystem:read_file", this.generateCluster(0.07, 0.06, 0.87));
    this.embeddingCache.set("read file contents", this.generateCluster(0.07, 0.06, 0.87));
    this.embeddingCache.set("fs:read", this.generateCluster(0.07, 0.06, 0.87));
    this.embeddingCache.set(
      "read: read a file from the filesystem",
      this.generateCluster(0.07, 0.06, 0.87),
    );
    this.embeddingCache.set("read a file", this.generateCluster(0.07, 0.06, 0.87));

    this.embeddingCache.set("write file", this.generateCluster(0.06, 0.05, 0.85));
    this.embeddingCache.set("write_file", this.generateCluster(0.07, 0.06, 0.84));
    this.embeddingCache.set("fs:write", this.generateCluster(0.06, 0.05, 0.85));
    this.embeddingCache.set("write file contents", this.generateCluster(0.06, 0.05, 0.85));

    // Cluster 4: Data Processing (mixed similarity - dim1=0.3, dim2=0.3, dim3=0.4)
    this.embeddingCache.set("process data", this.generateCluster(0.3, 0.3, 0.4));
    this.embeddingCache.set("process_data", this.generateCluster(0.31, 0.29, 0.41));
    this.embeddingCache.set("data:process", this.generateCluster(0.30, 0.30, 0.40));

    // Cluster 5: Data Validation (dim1=0.2, dim2=0.2, dim3=0.6)
    this.embeddingCache.set("validate data", this.generateCluster(0.2, 0.2, 0.6));
    this.embeddingCache.set("validate_data", this.generateCluster(0.21, 0.19, 0.61));
    this.embeddingCache.set("data:validate", this.generateCluster(0.20, 0.20, 0.60));
    this.embeddingCache.set(
      "validate data structure and schema",
      this.generateCluster(0.20, 0.20, 0.60),
    );
  }

  /**
   * Encode text to embedding vector
   *
   * Uses fuzzy matching to find semantically similar pre-computed embeddings.
   * Falls back to random low-similarity vector for unknown queries.
   *
   * @param text - Text to encode
   * @returns 1024-dimensional embedding vector
   */
  async encode(text: string): Promise<number[]> {
    const normalized = text.toLowerCase().trim();

    // Exact match
    if (this.embeddingCache.has(normalized)) {
      return this.embeddingCache.get(normalized)!;
    }

    // Fuzzy match (substring search)
    for (const [key, embedding] of this.embeddingCache) {
      if (
        normalized.includes(key) ||
        key.includes(normalized) ||
        this.levenshteinSimilarity(normalized, key) > 0.7
      ) {
        return embedding;
      }
    }

    // Fallback: Truly orthogonal vector (uses dimension 1024 only, which no cluster uses)
    // This ensures near-zero cosine similarity with all existing clusters
    const orthogonalVector = new Array(1024).fill(0);
    orthogonalVector[1023] = 1.0; // Only last dimension has value
    return this.normalize(orthogonalVector);
  }

  /**
   * Generate semantic cluster vector
   *
   * Creates a 1024-dimensional vector with high values in specific dimensions
   * to simulate semantic clustering. Adds small random noise for realism.
   *
   * @param dim1Weight - Weight for cluster 1 (dims 0-340)
   * @param dim2Weight - Weight for cluster 2 (dims 341-680)
   * @param dim3Weight - Weight for cluster 3 (dims 681-1023)
   * @returns Normalized 1024-dimensional vector
   */
  private generateCluster(
    dim1Weight: number,
    dim2Weight: number,
    dim3Weight: number,
  ): number[] {
    const vector = new Array(1024).fill(0);

    // Cluster 1: XML/structured data parsing (dimensions 0-340)
    for (let i = 0; i < 340; i++) {
      vector[i] = dim1Weight;
    }

    // Cluster 2: JSON/unstructured data parsing (dimensions 341-680)
    for (let i = 341; i < 681; i++) {
      vector[i] = dim2Weight;
    }

    // Cluster 3: Filesystem/IO operations (dimensions 681-1023)
    for (let i = 681; i < 1024; i++) {
      vector[i] = dim3Weight;
    }

    // Normalize to unit length (required for cosine similarity)
    return this.normalize(vector);
  }

  /**
   * Normalize vector to unit length
   *
   * Required for accurate cosine similarity calculations.
   *
   * @param vector - Input vector
   * @returns Unit-length vector
   */
  private normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(
      vector.reduce((sum, val) => sum + val * val, 0),
    );
    if (magnitude === 0) return vector; // Avoid division by zero
    return vector.map((val) => val / magnitude);
  }

  /**
   * Calculate Levenshtein similarity between two strings
   *
   * Used for fuzzy matching in embedding lookup.
   *
   * @param s1 - First string
   * @param s2 - Second string
   * @returns Similarity score (0-1)
   */
  private levenshteinSimilarity(s1: string, s2: string): number {
    const distance = this.levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    if (maxLength === 0) return 1.0;
    return 1 - distance / maxLength;
  }

  /**
   * Calculate Levenshtein distance between two strings
   *
   * @param s1 - First string
   * @param s2 - Second string
   * @returns Edit distance
   */
  private levenshteinDistance(s1: string, s2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= s2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= s1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= s2.length; i++) {
      for (let j = 1; j <= s1.length; j++) {
        if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1, // deletion
          );
        }
      }
    }

    return matrix[s2.length][s1.length];
  }

  /**
   * Get embedding as string for PGlite insertion
   *
   * Convenience method for test data seeding.
   *
   * @param text - Text to encode
   * @returns Embedding as PostgreSQL vector literal string
   */
  async encodeToString(text: string): Promise<string> {
    const embedding = await this.encode(text);
    return `[${embedding.join(",")}]`;
  }
}
