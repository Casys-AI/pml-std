# ADR-053: SHGAT Subprocess Training with PER

**Status:** Accepted **Date:** 2025-12-27 **Related:**

- ADR-027 (Execute Code Graph Learning)
- ADR-041 (Hierarchical Trace Tracking)
- Story 10.7 (SHGAT Multi-Head Attention)
- Story 11.6 (Prioritized Experience Replay)

## Context

### Problème

L'entraînement SHGAT (SuperHyperGraph Attention Networks) bloquait le main event loop:

1. **Au démarrage** - Batch training sur les traces existantes (~30s pour 500 traces, 3 epochs)
2. **Après chaque exécution** - PER training incrémental (epochs=1)

Pendant l'entraînement, le serveur MCP ne répondait plus aux requêtes.

### Architecture SHGAT (V1 K-head)

```
Intent Embedding (1024d)
         │
         ▼
    projectIntent() → hiddenDim (64d)
         │
         ▼
    ┌─────────────────────────────────────────────────────────┐
    │              SHGAT V1 K-head Attention                  │
    │                                                         │
    │  1. Message Passing: V → E (tools → capabilities)       │
    │     E_propagated = forward()                            │
    │                                                         │
    │  2. K-head Scoring (per capability):                    │
    │     ┌─────────┬─────────┬─────────┐                    │
    │     │ HEAD 0  │ HEAD 1  │ HEAD 2  │  (K=3 heads)       │
    │     │         │         │         │                    │
    │     │ Q = W_q @ intent                                 │
    │     │ K = W_k @ E_propagated                           │
    │     │ score_h = sigmoid(Q·K / √d)                      │
    │     └────┬────┴────┬────┴────┬────┘                    │
    │          │         │         │                          │
    │          └─────────┼─────────┘                          │
    │                    ▼                                    │
    │          Fusion: avg(head_scores)                       │
    │                    │                                    │
    │                    ▼                                    │
    │          × reliabilityMult (successRate)                │
    │                    │                                    │
    │                    ▼                                    │
    │             Final Score                                 │
    └─────────────────────────────────────────────────────────┘
```

**Note importante:** Les heads n'ont pas de rôle fixe (semantic/structure/temporal). Chaque head
apprend ses propres patterns via les matrices W_q et W_k entraînées sur les traces épisodiques.
L'ancienne architecture avec features explicites (PageRank, Louvain, etc.) est dépréciée (V2/V3).

### Adaptive K (nombre de heads)

Le nombre de heads s'adapte **automatiquement** à la taille du graphe dans `createSHGATFromCapabilities()` :

| Taille graphe | Hierarchy | numHeads | hiddenDim |
|---------------|-----------|----------|-----------|
| < 50 nodes    | L0        | 4        | 64        |
| < 200 nodes   | L0        | 6        | 96        |
| < 500 nodes   | L0-L1     | 8        | 128       |
| < 1000 nodes  | L1+       | 12       | 192       |
| ≥ 1000 nodes  | L2+       | 14-16    | 224-256   |

```typescript
// shgat.ts - createSHGATFromCapabilities() appelle automatiquement:
const adaptiveConfig = getAdaptiveHeadsByGraphSize(allTools.size, capabilities.length, maxLevel);

// initialization/parameters.ts:456
export function getAdaptiveHeadsByGraphSize(numTools, numCapabilities, maxLevel) {
  const graphSize = numTools + numCapabilities;

  // Base sur taille du graphe
  let numHeads = graphSize < 50 ? 4 : graphSize < 200 ? 6 : graphSize < 500 ? 8 : graphSize < 1000 ? 12 : 16;

  // Bonus si hiérarchie profonde (meta-capabilities)
  if (maxLevel >= 3) numHeads = Math.min(16, numHeads + 2);
  else if (maxLevel >= 2) numHeads = Math.min(16, numHeads + 1);

  // hiddenDim = numHeads × headDim (headDim = 16 ou 32)
  const headDim = graphSize < 200 ? 16 : 32;
  return { numHeads, hiddenDim: numHeads * headDim, headDim };
}
```

**Note:** L'ancienne fonction `getAdaptiveConfig(traceCount)` est dépréciée car le traceCount
n'est pas disponible à l'init. `getAdaptiveHeadsByGraphSize()` est maintenant appelée automatiquement.

### V1 K-head Scoring Formula

```typescript
// shgat.ts:880 - computeHeadScoreV1()
private computeHeadScoreV1(intentProjected: number[], capEmbedding: number[], headIdx: number): number {
  const hp = this.params.headParams[headIdx];
  const Q = new Array(hiddenDim).fill(0);
  const K = new Array(hiddenDim).fill(0);

  // Projections apprises
  for (let i = 0; i < hiddenDim; i++) {
    for (let j = 0; j < inputDim; j++) {
      Q[i] += hp.W_q[i][j] * intentProjected[j];
      K[i] += hp.W_k[i][j] * capEmbedding[j];
    }
  }

  // Scaled dot-product attention (NOT cosine)
  return sigmoid(dot(Q, K) / sqrt(hiddenDim));
}
```

**Différence clé vs cosine:**
- Cosine: `dot(a, b) / (||a|| × ||b||)` - normalise par les normes
- V1 K-head: `sigmoid(Q·K / √d)` - projections apprises W_q/W_k + scaling par √dim

### PER (Prioritized Experience Replay)

Les traces d'exécution sont échantillonnées par priorité TD error:

```
priority = |predicted_score - actual_outcome|^α
```

- **α = 0.6** - Équilibre entre priorité et diversité
- **TD errors** - Retournés après chaque batch pour mettre à jour les priorités

## Decision

### Architecture: Subprocess Worker

L'entraînement SHGAT s'exécute dans un subprocess Deno séparé:

```
Main Process                    Subprocess
     │                              │
     │  stdin: JSON                 │
     │ ─────────────────────────►   │
     │  {capabilities, examples,    │
     │   config: {epochs, batch},   │
     │   existingParams}            │
     │                              │
     │                         ┌────┴────┐
     │                         │ SHGAT   │
     │                         │Training │
     │                         │ Loop    │
     │                         └────┬────┘
     │                              │
     │  stdout: JSON                │
     │ ◄─────────────────────────   │
     │  {success, finalLoss,        │
     │   finalAccuracy, params,     │
     │   tdErrors}                  │
     │                              │
```

### Fichiers

1. **`src/graphrag/algorithms/shgat/train-worker.ts`** - Worker subprocess:

```typescript
interface WorkerInput {
  capabilities: Array<{
    id: string;
    embedding: number[];
    toolsUsed: string[];
    successRate: number;
  }>;
  examples: TrainingExample[];
  config: { epochs: number; batchSize: number };
  existingParams?: Record<string, unknown>;
}

interface WorkerOutput {
  success: boolean;
  finalLoss?: number;
  finalAccuracy?: number;
  params?: Record<string, unknown>;
  tdErrors?: number[]; // Pour PER priority updates
}
```

2. **`src/graphrag/algorithms/shgat/spawn-training.ts`** - Spawning logic:

```typescript
export async function spawnSHGATTraining(opts: SpawnOptions): Promise<SpawnResult> {
  const process = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", workerPath],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Écrire input via stdin
  const encoder = new TextEncoder();
  const writer = process.stdin.getWriter();
  await writer.write(encoder.encode(JSON.stringify(input)));
  await writer.close();

  // Collecter stdout/stderr en parallèle (évite lock conflict)
  const [stdoutChunks, stderrChunks] = await Promise.all([
    collectStream(process.stdout),
    collectStream(process.stderr),
  ]);

  // Parser résultat
  return JSON.parse(decoder.decode(stdoutChunks));
}
```

3. **`src/graphrag/learning/per-training.ts`** - PER subprocess wrapper:

```typescript
export async function trainSHGATOnPathTracesSubprocess(
  shgat: SHGAT,
  traceStore: ExecutionTraceStore,
  embeddingProvider: EmbeddingProvider,
  options: SubprocessPEROptions,
): Promise<PERTrainingResult> {
  // 1. Sample traces by priority
  const traces = await traceStore.getTracesByPriority(options.maxTraces);

  // 2. Convert to TrainingExamples with embeddings
  const examples = await Promise.all(traces.map(async (t) => ({
    intentEmbedding: await embeddingProvider.encode(t.intentText),
    contextTools: t.executedPath,
    candidateId: t.capabilityId,
    outcome: t.success ? 1.0 : 0.0,
  })));

  // 3. Spawn subprocess training
  const result = await spawnSHGATTraining({
    capabilities,
    examples,
    epochs: options.epochs ?? 1,
    batchSize: options.batchSize ?? 16,
    existingParams: shgat.exportParams(),
  });

  // 4. Import trained params
  if (result.params) {
    shgat.importParams(result.params);
  }

  // 5. Update trace priorities with TD errors
  if (result.tdErrors) {
    await batchUpdatePrioritiesFromTDErrors(traceStore, traces, result.tdErrors);
  }

  return { loss: result.finalLoss, accuracy: result.finalAccuracy };
}
```

4. **`src/mcp/handlers/execute-handler.ts`** - PER après exécution:

```typescript
// Après chaque exécution réussie avec code
if (deps.shgat && deps.traceStore && deps.embeddingModel) {
  // Background PER training (non-blocking)
  runPERBatchTraining(deps).catch((err) => log.warn(`PER training failed: ${err}`));
}
```

### Modes d'entraînement

| Mode         | Epochs | Traces  | Trigger                |
| ------------ | ------ | ------- | ---------------------- |
| **Batch**    | 3-5    | 500 max | Démarrage serveur      |
| **Live/PER** | 1      | 50 max  | Après chaque exécution |

Les deux modes utilisent PER + TD errors - la seule différence est le nombre d'epochs.

### Skip batch training si params récents

```typescript
// gateway-server.ts
const ONE_HOUR_MS = 60 * 60 * 1000;
const paramsAreRecent = paramsLoaded && paramsUpdatedAt &&
  (Date.now() - paramsUpdatedAt.getTime()) < ONE_HOUR_MS;

if (!paramsAreRecent) {
  // Batch training en background
  this.trainSHGATOnTraces(capabilities);
} else {
  log.info("Skipping batch training - params are recent");
}
```

## Bug fixes

### 1. Stderr lock conflict

**Problème:** `process.stderr.getReader()` puis `process.output()` = "Cannot collect output:
'stderr' is locked"

**Solution:** Collecter stdout et stderr manuellement en parallèle:

```typescript
const stdoutPromise = collectStream(process.stdout);
const stderrPromise = collectStream(process.stderr);
await Promise.all([stdoutPromise, stderrPromise]);
```

### 2. Empty toolsUsed

**Problème:** `toolsUsed: []` passé au worker = SHGAT ne peut pas enregistrer les tools = crash
silencieux

**Solution:** Collecter les tools depuis les examples:

```typescript
const allToolsFromExamples = new Set<string>();
for (const ex of examples) {
  for (const tool of ex.contextTools) {
    allToolsFromExamples.add(tool);
  }
}
// Premier capability reçoit tous les tools
capabilities[0].toolsUsed = [...allToolsFromExamples];
```

### 3. TraceStore manquant

**Problème:** `traceStore` absent de `getExecuteDeps()` = PER jamais déclenché

**Solution:** Ajouter le getter dans CapabilityStore et le passer:

```typescript
// capability-store.ts
getTraceStore(): ExecutionTraceStore | undefined {
  return this.traceStore;
}

// gateway-server.ts
private getExecuteDeps(): ExecuteDependencies {
  return {
    // ...
    traceStore: this.capabilityStore?.getTraceStore(),
  };
}
```

### 4. Migration manquante

**Problème:** Le fichier SQL `010_shgat_params.sql` existait mais n'était pas enregistré dans le
migration runner = table jamais créée = params jamais sauvegardés = batch training à chaque
démarrage

**Solution:** Créer migration TypeScript `027_shgat_params.ts`:

```typescript
export function createSHGATParamsMigration(): Migration {
  return {
    version: 27,
    name: "shgat_params",
    up: async (db) => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS shgat_params (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id TEXT NOT NULL DEFAULT 'local' UNIQUE,
          params JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    },
    // ...
  };
}
```

## Consequences

### Positives

1. **Non-blocking** - Le main thread reste réactif pendant l'entraînement
2. **Isolation** - Crash du worker n'affecte pas le serveur
3. **PER unifié** - Batch et live utilisent le même algorithme
4. **TD errors** - Priorités mises à jour après chaque entraînement

### Négatives

1. **Overhead** - Spawn d'un subprocess (~50-100ms)
2. **Sérialisation** - Capabilities et examples passés via JSON stdin
3. **Mémoire** - Deux copies des embeddings (main + worker)

### Métriques

- **Batch training (500 traces, 3 epochs):** ~30s en subprocess vs ~30s en main (même durée, mais
  non-bloquant)
- **Live PER (50 traces, 1 epoch):** ~2-3s en subprocess
- **Spawn overhead:** ~50-100ms

## Test

```bash
# Démarrer le serveur PML
deno task serve

# Observer les logs au démarrage
# [Gateway] Starting background SHGAT training...
# [SHGAT Worker] Epoch 0: loss=0.1234, acc=0.85
# [SHGAT Worker] Epoch 1: loss=0.0987, acc=0.88
# [SHGAT Worker] Epoch 2: loss=0.0765, acc=0.91
# [Gateway] SHGAT training complete: loss=0.0765, accuracy=0.91

# Exécuter une capability
pml:execute({
  intent: "list files",
  code: "return await mcp.filesystem.fast_list_directory({path: '.'})"
})

# Observer les logs PER après exécution
# [PER] Starting subprocess training on 12 traces
# [SHGAT Worker] Epoch 0: loss=0.0654, acc=0.92
# [PER] Training complete, updated 12 trace priorities
```
