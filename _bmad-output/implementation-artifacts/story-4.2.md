# Story 4.2: Adaptive Threshold Learning (Sliding Window + FP/FN Detection)

**Status:** review **Epic:** 4 - Episodic Memory & Adaptive Learning **Implementation Date:**
2025-11-05 (Epic 1) **Discovery Date:** 2025-11-24 (Epic 3 retrospective)

## Code Audit Summary

Cette story a été implémentée durant Epic 1 (2025-11-05) mais non documentée. Découverte durant la
rétrospective Epic 3 via audit du code existant.

**Fichiers implémentés:**

- `src/mcp/adaptive-threshold.ts` (195 LOC) - Implementation core
- `src/mcp/gateway-handler.ts` (lignes 22, 67, 82, 107-109, 152-158, 291-321) - Integration
- `tests/unit/mcp/adaptive_threshold_test.ts` (168 LOC) - 8 tests unitaires ✅
- `src/graphrag/types.ts` (lignes 144-161) - Types `ExecutionRecord`, `SpeculativeMetrics`

## User Story

As an AI agent, I want the system to learn optimal confidence thresholds from execution feedback so
that I can reduce unnecessary manual confirmations while avoiding failed speculative executions.

## Implementation Réelle

### 1. AdaptiveThresholdManager Class

**Fichier:** `src/mcp/adaptive-threshold.ts`

**Configuration:**

```typescript
interface AdaptiveConfig {
  initialExplicitThreshold: 0.50;
  initialSuggestionThreshold: 0.70;
  learningRate: 0.05; // 5% adjustment
  minThreshold: 0.40;
  maxThreshold: 0.90;
  windowSize: 50; // Sliding window size
}
```

**Méthodes implémentées:**

1. `recordExecution(record: ExecutionRecord): void` - Enregistre une exécution
   - Ajoute à l'historique
   - Garde seulement les 50 dernières (sliding window)
   - Ajuste thresholds tous les 10 exécutions (si ≥20 samples)

2. `private adjustThresholds(): void` - Ajuste les thresholds
   - Analyse les 20 dernières exécutions
   - Calcule False Positive Rate (exécutions spéculatives échouées)
   - Calcule False Negative Rate (confirmations manuelles réussies avec haute confiance)
   - Si FP rate > 20% → Augmente threshold (plus conservateur)
   - Si FN rate > 30% → Diminue threshold (plus agressif)
   - Respecte bounds [0.40, 0.90]

3. `getThresholds()` - Retourne thresholds actuels (adaptatifs ou initiaux)

4. `getMetrics(): SpeculativeMetrics` - Retourne métriques de performance
   - Total speculative attempts
   - Success/failure counts
   - Average execution time
   - Average confidence
   - Wasted compute cost
   - Saved latency

5. `reset(): void` - Reset pour testing

### 2. Integration avec GatewayHandler

**Fichier:** `src/mcp/gateway-handler.ts`

**Ligne 22:** Import

```typescript
import { AdaptiveThresholdManager } from "./adaptive-threshold.ts";
```

**Ligne 67:** Propriété privée

```typescript
private adaptiveManager: AdaptiveThresholdManager;
```

**Ligne 82:** Initialisation dans constructeur

```typescript
this.adaptiveManager = new AdaptiveThresholdManager();
```

**Lignes 107-109:** Utilisation des thresholds adaptatifs

```typescript
const adaptiveThresholds = this.adaptiveManager.getThresholds();
const explicitThreshold = adaptiveThresholds.explicitThreshold ?? this.config.explicitThreshold;
const suggestionThreshold = adaptiveThresholds.suggestionThreshold ??
  this.config.suggestionThreshold;
```

**Lignes 143-158:** Exécution spéculative + recording

```typescript
if (this.config.enableSpeculative) {
  log.info(`Speculative execution triggered (confidence: ${suggestion.confidence.toFixed(2)})`);

  const results = await this.executeDAG(suggestion.dagStructure);
  const executionTime = performance.now() - startTime;

  const success = results.every((r) => r.success);
  this.adaptiveManager.recordExecution({
    confidence: suggestion.confidence,
    mode: "speculative",
    success,
    executionTime,
    timestamp: Date.now(),
  });
}
```

**Lignes 291-299:** Recording du feedback utilisateur

```typescript
recordUserFeedback(confidence: number, accepted: boolean): void {
  this.adaptiveManager.recordExecution({
    confidence,
    mode: "suggestion",
    success: true,
    userAccepted: accepted,
    timestamp: Date.now(),
  });
}
```

**Lignes 306-312:** Méthode publique getAdaptiveThresholds()

```typescript
getAdaptiveThresholds(): { explicitThreshold: number; suggestionThreshold: number } {
  const thresholds = this.adaptiveManager.getThresholds();
  return {
    explicitThreshold: thresholds.explicitThreshold ?? this.config.explicitThreshold,
    suggestionThreshold: thresholds.suggestionThreshold ?? this.config.suggestionThreshold,
  };
}
```

**Lignes 319-321:** Méthode publique getMetrics()

```typescript
getMetrics() {
  return this.adaptiveManager.getMetrics();
}
```

**Note:** `getAdaptiveThresholds()` et `getMetrics()` sont des méthodes publiques mais **PAS
exposées via MCP** (pas de tool MCP correspondant dans gateway-server.ts).

### 3. Types Définis

**Fichier:** `src/graphrag/types.ts`

**Lignes 144-151:** ExecutionRecord

```typescript
export interface ExecutionRecord {
  confidence: number;
  mode: "explicit" | "suggestion" | "speculative";
  success: boolean;
  userAccepted?: boolean;
  executionTime?: number;
  timestamp: number;
}
```

**Lignes 156-164:** SpeculativeMetrics

```typescript
export interface SpeculativeMetrics {
  totalSpeculativeAttempts: number;
  successfulExecutions: number;
  failedExecutions: number;
  avgExecutionTime: number;
  avgConfidence: number;
  wastedComputeCost: number;
  savedLatency: number;
}
```

### 4. Tests Unitaires

**Fichier:** `tests/unit/mcp/adaptive_threshold_test.ts` **Status:** 8/8 tests passing ✅

1. ✅ Initializes with default thresholds (0.50, 0.70)
2. ✅ Initializes with custom thresholds
3. ✅ Records execution history
4. ✅ Increases threshold after false positives
5. ✅ Decreases threshold after false negatives
6. ✅ Respects min (0.40) and max (0.90) thresholds
7. ✅ Calculates accurate metrics
8. ✅ Reset clears history

## Algorithm: Sliding Window + FP/FN Detection

**Window Size:** 50 executions **Analysis Window:** Last 20 executions **Update Frequency:** Every
10 executions (after ≥20 samples) **Learning Rate:** 5% per adjustment

**Decision Logic:**

- **FP Rate > 20%**: Increase threshold by `learningRate × fpRate`
- **FN Rate > 30%**: Decrease threshold by `learningRate × fnRate`
- **Bounds**: [0.40, 0.90]

**False Positive:** Speculative execution failed (confidence was too high, should have asked user)
**False Negative:** User accepted suggestion with high confidence (confidence was borderline, should
have executed speculatively)

## Scope Limitations (Ce qui n'existe PAS)

1. ❌ Pas d'exposition MCP des métriques (aucun MCP tool pour consulter les stats)
2. ❌ Pas de persistence sur disque (thresholds perdus au redémarrage du serveur)
   - ✅ Les thresholds persistent en mémoire au-delà des 50 exécutions (sliding window appliqué à
     l'historique seulement)
   - ❌ Pas de sauvegarde en base de données ou fichier
3. ❌ Pas d'API REST pour monitorer l'apprentissage en temps réel
4. ❌ Pas de dashboard de visualisation
5. ❌ `recordUserFeedback()` existe mais n'est jamais appelé (pas d'intégration client)

## Files Modified

- ✅ `src/mcp/adaptive-threshold.ts` - Core implementation (195 LOC)
- ✅ `src/mcp/gateway-handler.ts` - Integration (import, init, usage)
- ✅ `tests/unit/mcp/adaptive_threshold_test.ts` - Unit tests (168 LOC, 8 tests)
- ✅ `src/graphrag/types.ts` - Type definitions
- ✅ `src/mcp/index.ts` - Export AdaptiveThresholdManager

## Validation

**Implementation Date:** 2025-11-05 (git log confirms) **Integration Status:** ✅ Operational (used
in gateway-handler.ts ligne 107) **Test Status:** ✅ 8/8 passing **Production Status:** ✅ Active
(enableSpeculative defaults to true)

## Relationship to Other Stories

**Story 4.2 vs Story 5.1 (ADR-015):** Complémentaires, pas doublons.

- Story 5.1: Améliore **search quality** via graph boost
- Story 4.2: Améliore **threshold adaptation** via feedback learning

Les deux réduisent "too many manual confirmations" mais via mécanismes différents.

## Note PRD

**PRD Original:** Spécifiait EMA (Exponential Moving Average) **Implementation Réelle:** Sliding
Window + FP/FN detection **Rationale:** Sliding Window permet d'oublier les vieux échecs (hard
cutoff) contrairement à EMA qui retient toute l'histoire.

---

**Implementation:** 2025-11-05 (Epic 1) **Documentation:** 2025-11-24 (Epic 3 retrospective) **Story
Status:** Completed, code operational, ready for review
