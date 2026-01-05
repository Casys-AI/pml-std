# ML Pipeline Architecture - Complete System

## Overview

Architecture complète pour un système de capability retrieval avec:
- **SHGAT** (Super Hypergraph Attention) pour le scoring
- **PER** (Prioritized Experience Replay) pour l'apprentissage
- **TD Learning** (Temporal Difference) pour les value estimates
- **Hybrid Embeddings** (BGE + Node2Vec) pour les représentations

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ML PIPELINE                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │   Feature    │───▶│   Training   │───▶│  Evaluation  │───▶│  Serving  │ │
│  │   Pipeline   │    │   Pipeline   │    │   Pipeline   │    │  Pipeline │ │
│  └──────────────┘    └──────────────┘    └──────────────┘    └───────────┘ │
│         │                   │                   │                  │        │
│         ▼                   ▼                   ▼                  ▼        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                        Feature Store (Redis/PG)                       │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│         │                   │                   │                  │        │
│         ▼                   ▼                   ▼                  ▼        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                     Experiment Tracking (MLflow/W&B)                  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Feature Pipeline

### 1.1 Embedding Generation

```typescript
interface EmbeddingPipeline {
  // Stage 1: BGE-M3 semantic embeddings (1024 dim)
  bgeEncoder: {
    model: "BAAI/bge-m3";
    input: "capability description + tool names";
    output: Float32Array[1024];
    cache: "embedding_cache table";
  };

  // Stage 2: Node2Vec graph embeddings (64 dim)
  node2vecEncoder: {
    graph: "capability <-> tool bipartite";
    walkLength: 15;
    walksPerNode: 40;
    windowSize: 5;
    output: Float32Array[64];
  };

  // Stage 3: Hybrid combination
  hybridCombiner: {
    bgeWeight: 0.3;
    n2vWeight: 0.7;
    normalize: true;
    output: Float32Array[1024];
  };
}
```

### 1.2 Feature Store Schema

```sql
-- Capability features (refreshed daily or on change)
CREATE TABLE capability_features (
  capability_id UUID PRIMARY KEY,

  -- Embeddings
  bge_embedding VECTOR(1024),
  n2v_embedding VECTOR(64),
  hybrid_embedding VECTOR(1024),

  -- Static features
  tool_count INT,
  avg_execution_time_ms FLOAT,
  success_rate FLOAT,

  -- Temporal features (rolling windows)
  usage_count_1d INT,
  usage_count_7d INT,
  usage_count_30d INT,

  -- Graph features
  pagerank_score FLOAT,
  clustering_coefficient FLOAT,

  -- Metadata
  feature_version INT,
  computed_at TIMESTAMPTZ,

  CONSTRAINT valid_embedding CHECK (vector_dims(hybrid_embedding) = 1024)
);

-- Intent features (computed at query time)
CREATE TABLE intent_features (
  intent_hash TEXT PRIMARY KEY,
  embedding VECTOR(1024),
  context_tools TEXT[],
  created_at TIMESTAMPTZ
);
```

### 1.3 Feature Validation

```typescript
interface FeatureValidator {
  // Schema validation
  checkDimensions(embedding: number[], expected: number): boolean;
  checkNormalized(embedding: number[], tolerance: 0.01): boolean;

  // Distribution validation
  checkNotCollapsed(embeddings: number[][], minVariance: 0.01): boolean;
  checkNoNaN(values: number[]): boolean;

  // Freshness validation
  checkStaleness(computedAt: Date, maxAgeHours: 24): boolean;
}
```

---

## 2. Training Pipeline

### 2.1 Experience Collection

```typescript
interface Experience {
  // State
  intentEmbedding: Float32Array;    // User intent
  contextTools: string[];            // Available tools
  candidateIds: string[];            // Candidate capabilities

  // Action
  selectedCapability: string;        // Chosen capability
  rank: number;                      // Position in ranking

  // Reward
  outcome: "success" | "failure" | "partial";
  executionTimeMs: number;
  userFeedback?: number;             // 1-5 rating

  // Metadata
  timestamp: Date;
  sessionId: string;
}
```

### 2.2 Prioritized Experience Replay (PER)

```typescript
interface PERBuffer {
  capacity: 100_000;

  // Priority computation
  tdError: number;                   // |predicted - actual|
  priority: number;                  // (tdError + ε)^α

  // Hyperparameters
  alpha: 0.6;                        // Priority exponent
  beta: 0.4;                         // IS weight exponent (annealed to 1)
  betaIncrement: 0.001;
  epsilon: 0.01;                     // Small constant for stability

  // Sampling
  sample(batchSize: number): {
    experiences: Experience[];
    weights: number[];               // Importance sampling weights
    indices: number[];               // For priority update
  };

  // Update priorities after training step
  updatePriorities(indices: number[], tdErrors: number[]): void;
}
```

### 2.3 TD Learning

```typescript
interface TDLearner {
  // Value network (estimates Q(s,a))
  valueNetwork: {
    input: [intentEmbedding, capabilityEmbedding, contextFeatures];
    hidden: [256, 128, 64];
    output: number;  // Expected reward
  };

  // TD(λ) parameters
  gamma: 0.99;       // Discount factor
  lambda: 0.95;      // Eligibility trace decay
  learningRate: 0.001;

  // Update rule
  computeTDError(
    reward: number,
    currentValue: number,
    nextValue: number
  ): number {
    return reward + gamma * nextValue - currentValue;
  }

  // Eligibility traces for multi-step learning
  eligibilityTraces: Map<string, number>;
}
```

### 2.4 SHGAT Training Loop

```typescript
interface SHGATTrainer {
  // Model
  shgat: SHGAT;

  // Optimizers
  optimizer: Adam({ lr: 0.001, betas: [0.9, 0.999] });
  scheduler: CosineAnnealing({ T_max: 1000, eta_min: 1e-6 });

  // Training step
  async trainStep(batch: Experience[], weights: number[]): Promise<{
    loss: number;
    tdErrors: number[];
    metrics: TrainingMetrics;
  }> {
    // 1. Forward pass
    const predictions = await this.shgat.scoreAllCapabilities(batch);

    // 2. Compute TD targets
    const targets = this.computeTDTargets(batch);

    // 3. Weighted loss (importance sampling)
    const loss = this.weightedMSE(predictions, targets, weights);

    // 4. Backward pass
    await this.optimizer.step(loss);

    // 5. Return TD errors for PER update
    return {
      loss,
      tdErrors: predictions.map((p, i) => Math.abs(p - targets[i])),
      metrics: this.computeMetrics(predictions, batch),
    };
  }

  // Training loop
  async train(config: TrainingConfig): Promise<void> {
    for (let epoch = 0; epoch < config.epochs; epoch++) {
      for (let step = 0; step < config.stepsPerEpoch; step++) {
        // Sample from PER
        const { experiences, weights, indices } = this.perBuffer.sample(config.batchSize);

        // Train step
        const { loss, tdErrors, metrics } = await this.trainStep(experiences, weights);

        // Update PER priorities
        this.perBuffer.updatePriorities(indices, tdErrors);

        // Log to experiment tracker
        await this.logger.log({ epoch, step, loss, ...metrics });

        // Checkpoint
        if (step % config.checkpointFreq === 0) {
          await this.saveCheckpoint(epoch, step);
        }
      }

      // Evaluate on validation set
      const valMetrics = await this.evaluate(this.valDataset);
      await this.logger.logValidation(valMetrics);

      // Early stopping
      if (this.shouldStop(valMetrics)) break;
    }
  }
}
```

---

## 3. Evaluation Pipeline

### 3.1 Offline Metrics

```typescript
interface OfflineMetrics {
  // Ranking metrics
  mrr: number;           // Mean Reciprocal Rank
  hitAtK: {              // Hit rate at K
    hit1: number;
    hit3: number;
    hit5: number;
    hit10: number;
  };
  ndcg: number;          // Normalized Discounted Cumulative Gain
  map: number;           // Mean Average Precision

  // Calibration metrics
  expectedCalibrationError: number;  // Are confidence scores calibrated?
  brierScore: number;

  // Diversity metrics
  coverage: number;      // % of capabilities ever recommended
  giniCoefficient: number;  // Distribution of recommendations
}
```

### 3.2 Online Metrics (A/B Testing)

```typescript
interface OnlineMetrics {
  // Primary metrics
  successRate: number;
  avgExecutionTime: number;
  userSatisfaction: number;

  // Guardrail metrics
  p99Latency: number;
  errorRate: number;
  fallbackRate: number;

  // Statistical significance
  pValue: number;
  confidenceInterval: [number, number];
  sampleSize: number;
  requiredSampleSize: number;
}
```

### 3.3 Evaluation Framework

```typescript
interface EvaluationFramework {
  // Holdout evaluation
  async evaluateHoldout(
    model: SHGAT,
    testSet: Experience[],
  ): Promise<OfflineMetrics>;

  // Cross-validation
  async crossValidate(
    modelFactory: () => SHGAT,
    dataset: Experience[],
    folds: 5,
  ): Promise<{ mean: OfflineMetrics; std: OfflineMetrics }>;

  // Temporal validation (no future leakage)
  async temporalValidation(
    model: SHGAT,
    dataset: Experience[],
    trainWindow: "30d",
    testWindow: "7d",
  ): Promise<OfflineMetrics[]>;

  // Counterfactual evaluation
  async counterfactualEval(
    model: SHGAT,
    logs: Experience[],
    propensityModel: PropensityModel,
  ): Promise<OfflineMetrics>;
}
```

---

## 4. Serving Pipeline

### 4.1 Inference Service

```typescript
interface InferenceService {
  // Model management
  currentModel: SHGAT;
  shadowModel?: SHGAT;  // For A/B testing

  // Feature retrieval
  featureStore: FeatureStore;
  embeddingCache: LRUCache<string, Float32Array>;

  // Inference
  async rank(
    intent: string,
    contextTools: string[],
    candidateIds: string[],
    options?: { topK?: number; minScore?: number },
  ): Promise<RankingResult> {
    // 1. Get intent embedding (cache or compute)
    const intentEmb = await this.getIntentEmbedding(intent);

    // 2. Get candidate features from feature store
    const candidates = await this.featureStore.getBatch(candidateIds);

    // 3. Score with SHGAT
    const scores = await this.currentModel.scoreAllCapabilities(intentEmb, candidates);

    // 4. Apply business rules (filtering, boosting)
    const filtered = this.applyBusinessRules(scores, options);

    // 5. Return top-K
    return {
      rankings: filtered.slice(0, options?.topK ?? 10),
      latencyMs: performance.now() - start,
      modelVersion: this.currentModel.version,
    };
  }
}
```

### 4.2 Model Versioning

```typescript
interface ModelRegistry {
  // Model storage
  models: Map<string, {
    weights: ArrayBuffer;
    config: SHGATConfig;
    metrics: OfflineMetrics;
    trainedAt: Date;
    promotedAt?: Date;
  }>;

  // Lifecycle
  async register(model: SHGAT, metrics: OfflineMetrics): Promise<string>;
  async promote(modelId: string, stage: "staging" | "production"): Promise<void>;
  async rollback(toModelId: string): Promise<void>;

  // Canary deployment
  async canaryDeploy(
    newModelId: string,
    trafficPercent: number,
    duration: string,
  ): Promise<CanaryResult>;
}
```

### 4.3 Caching Strategy

```typescript
interface CachingStrategy {
  // L1: In-memory LRU (hot embeddings)
  l1Cache: {
    type: "LRU";
    maxSize: 10_000;
    ttl: "1h";
  };

  // L2: Redis (warm embeddings)
  l2Cache: {
    type: "Redis";
    maxSize: 100_000;
    ttl: "24h";
  };

  // L3: Feature store (cold, computed on demand)
  l3Store: {
    type: "PostgreSQL";
    recomputeThreshold: "7d";
  };
}
```

---

## 5. MLOps Infrastructure

### 5.1 Experiment Tracking

```typescript
interface ExperimentTracker {
  // Experiment definition
  experiment: {
    name: string;
    hypothesis: string;
    parameters: Record<string, unknown>;
    metrics: string[];
  };

  // Run tracking
  run: {
    id: string;
    startedAt: Date;
    status: "running" | "completed" | "failed";
    artifacts: string[];
  };

  // Logging
  logMetrics(metrics: Record<string, number>): void;
  logParams(params: Record<string, unknown>): void;
  logArtifact(name: string, data: ArrayBuffer): void;

  // Comparison
  compareRuns(runIds: string[]): ComparisonReport;
}
```

### 5.2 Monitoring & Alerts

```typescript
interface MonitoringConfig {
  // Model performance
  metrics: {
    // Prediction quality
    "model.mrr": { threshold: 0.1, alert: "critical" };
    "model.hit_at_3": { threshold: 0.2, alert: "warning" };

    // Latency
    "inference.p50_ms": { threshold: 50, alert: "warning" };
    "inference.p99_ms": { threshold: 200, alert: "critical" };

    // Errors
    "inference.error_rate": { threshold: 0.01, alert: "critical" };
  };

  // Data quality
  dataQuality: {
    "embedding.variance": { min: 0.01, alert: "critical" };  // Score collapse
    "feature.staleness_hours": { max: 48, alert: "warning" };
    "feature.missing_rate": { max: 0.05, alert: "warning" };
  };

  // Drift detection
  drift: {
    "embedding.distribution_shift": { method: "KS-test", pValue: 0.01 };
    "prediction.distribution_shift": { method: "PSI", threshold: 0.2 };
  };
}
```

### 5.3 CI/CD for ML

```yaml
# .github/workflows/ml-pipeline.yml
name: ML Pipeline

on:
  push:
    paths: ["src/graphrag/**", "src/ml/**"]
  schedule:
    - cron: "0 2 * * *"  # Daily retraining

jobs:
  validate-data:
    runs-on: ubuntu-latest
    steps:
      - name: Validate feature store
      - name: Check data freshness
      - name: Detect distribution shift

  train:
    needs: validate-data
    runs-on: gpu-runner
    steps:
      - name: Load training data
      - name: Train SHGAT
      - name: Evaluate on holdout
      - name: Register model

  evaluate:
    needs: train
    steps:
      - name: Run offline evaluation
      - name: Compare with baseline
      - name: Generate report

  deploy:
    needs: evaluate
    if: ${{ needs.evaluate.outputs.improved }}
    steps:
      - name: Canary deploy (10%)
      - name: Monitor for 1h
      - name: Full rollout or rollback
```

---

## 6. Implementation Roadmap

### Phase 1: Foundation (2-3 weeks)
- [ ] Feature store schema + migrations
- [ ] Embedding pipeline (BGE + Node2Vec)
- [ ] Basic training loop
- [ ] Offline evaluation framework

### Phase 2: Training Infrastructure (2-3 weeks)
- [ ] PER buffer implementation
- [ ] TD learning integration
- [ ] SHGAT training with backprop
- [ ] Experiment tracking (MLflow/W&B)

### Phase 3: Serving (1-2 weeks)
- [ ] Inference service
- [ ] Model registry
- [ ] Caching layers
- [ ] Latency optimization

### Phase 4: MLOps (2-3 weeks)
- [ ] Monitoring dashboards
- [ ] Drift detection
- [ ] CI/CD pipeline
- [ ] A/B testing framework

### Phase 5: Optimization (ongoing)
- [ ] Hyperparameter tuning
- [ ] Model architecture search
- [ ] Feature engineering experiments
- [ ] Online learning

---

## 7. Technology Stack

| Component | Recommended | Alternative |
|-----------|-------------|-------------|
| Feature Store | PostgreSQL + pgvector | Redis + RediSearch |
| Embeddings | HuggingFace Transformers | OpenAI API |
| Training | Deno + ONNX Runtime | Python + PyTorch |
| Experiment Tracking | MLflow | Weights & Biases |
| Model Registry | MLflow | Custom + S3 |
| Serving | Deno Deploy | Docker + K8s |
| Monitoring | Grafana + Prometheus | Datadog |
| CI/CD | GitHub Actions | GitLab CI |

---

## 8. Key Metrics to Track

### Business Metrics
- Task success rate
- Time to completion
- User satisfaction (NPS)

### Model Metrics
- MRR, Hit@K, NDCG
- Inference latency (p50, p99)
- Model freshness

### System Metrics
- Feature store latency
- Cache hit rate
- Error rate
