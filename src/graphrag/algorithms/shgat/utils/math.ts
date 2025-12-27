/**
 * Mathematical utilities for SHGAT
 *
 * Pure functions extracted from SHGAT class for better testability and reusability.
 *
 * @module graphrag/algorithms/shgat/utils/math
 */

/**
 * Matrix multiplication with transpose: A · B^T
 *
 * @param A - Matrix A [m][k]
 * @param B - Matrix B [n][k] (will be transposed)
 * @returns Result matrix [m][n]
 */
export function matmulTranspose(A: number[][], B: number[][]): number[][] {
  return A.map((row) =>
    B.map((bRow) => row.reduce((sum, val, i) => sum + val * (bRow[i] || 0), 0))
  );
}

/**
 * Leaky ReLU activation
 *
 * f(x) = x if x > 0, else slope * x
 *
 * @param x - Input value
 * @param slope - Negative slope (default 0.2)
 * @returns Activated value
 */
export function leakyRelu(x: number, slope: number = 0.2): number {
  return x > 0 ? x : slope * x;
}

/**
 * Exponential Linear Unit (ELU) activation
 *
 * f(x) = x if x ≥ 0, else α(e^x - 1)
 *
 * @param x - Input value
 * @param alpha - Scale parameter (default 1.0)
 * @returns Activated value
 */
export function elu(x: number, alpha: number = 1.0): number {
  return x >= 0 ? x : alpha * (Math.exp(x) - 1);
}

/**
 * Sigmoid activation
 *
 * f(x) = 1 / (1 + e^(-x))
 *
 * @param x - Input value
 * @returns Value in range (0, 1)
 */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Softmax function (numerically stable)
 *
 * Subtracts max value before exp to prevent overflow.
 *
 * @param values - Input values
 * @returns Normalized probabilities summing to 1
 */
export function softmax(values: number[]): number[] {
  if (values.length === 0) return [];

  const maxVal = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - maxVal));
  const sum = exps.reduce((a, b) => a + b, 0);

  return sum > 0 ? exps.map((e) => e / sum) : new Array(values.length).fill(1 / values.length);
}

/**
 * Dot product of two vectors
 *
 * @param a - Vector a
 * @param b - Vector b
 * @returns Scalar dot product
 */
export function dot(a: number[], b: number[]): number {
  return a.reduce((sum, val, i) => sum + val * (b[i] || 0), 0);
}

/**
 * Cosine similarity between two vectors
 *
 * sim(a, b) = (a · b) / (||a|| × ||b||)
 *
 * @param a - Vector a
 * @param b - Vector b
 * @returns Similarity in range [-1, 1]
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = dot(a, b);
  const normA = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const normB = Math.sqrt(b.reduce((s, x) => s + x * x, 0));

  return normA * normB > 0 ? dotProduct / (normA * normB) : 0;
}

/**
 * Binary cross-entropy loss
 *
 * BCE(p, y) = -y log(p) - (1-y) log(1-p)
 *
 * @param pred - Predicted probability [0, 1]
 * @param label - True label (0 or 1)
 * @returns Loss value
 */
export function binaryCrossEntropy(pred: number, label: number): number {
  const eps = 1e-7;
  const p = Math.max(eps, Math.min(1 - eps, pred));
  return -label * Math.log(p) - (1 - label) * Math.log(1 - p);
}

/**
 * Mean pooling of embeddings
 *
 * Averages embeddings element-wise. Returns zero vector if input is empty.
 *
 * @param embeddings - Array of embeddings
 * @param dim - Target dimension
 * @returns Mean-pooled embedding
 */
export function meanPool(embeddings: number[][], dim: number): number[] {
  if (embeddings.length === 0) {
    return new Array(dim).fill(0);
  }

  const result = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < Math.min(dim, emb.length); i++) {
      result[i] += emb[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    result[i] /= embeddings.length;
  }

  return result;
}

/**
 * Concatenate multi-head outputs
 *
 * @param heads - Embeddings per head [numHeads][numNodes][headDim]
 * @returns Concatenated embeddings [numNodes][numHeads * headDim]
 */
export function concatHeads(heads: number[][][]): number[][] {
  if (heads.length === 0 || heads[0].length === 0) {
    return [];
  }

  const numNodes = heads[0].length;
  return Array.from({ length: numNodes }, (_, i) => heads.flatMap((head) => head[i]));
}

/**
 * Apply dropout to matrix (for training)
 *
 * Randomly zero out elements with probability `dropoutRate`.
 * Scales remaining elements by 1/(1-dropoutRate) to maintain expected value.
 *
 * @param matrix - Input matrix
 * @param dropoutRate - Dropout probability [0, 1]
 * @returns Matrix with dropout applied
 */
export function applyDropout(matrix: number[][], dropoutRate: number): number[][] {
  if (dropoutRate === 0) return matrix;

  const keepProb = 1 - dropoutRate;
  return matrix.map((row) => row.map((x) => (Math.random() < keepProb ? x / keepProb : 0)));
}

/**
 * Normalize vector to unit length
 *
 * @param vector - Input vector
 * @returns Normalized vector (or zero vector if input norm is 0)
 */
export function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? vector.map((x) => x / norm) : new Array(vector.length).fill(0);
}
