# Story 10.7c: Thompson Sampling Integration

Status: done

> **Epic:** 10 - DAG Capability Learning & Unified APIs **Prerequisites:** Story 10.7 (pml_execute -
> DONE), Story 10.7b (SHGAT Persistence - DONE) **ADR:**
> [ADR-049](../adrs/ADR-049-intelligent-adaptive-thresholds.md) - Intelligent Adaptive Thresholds
> **Depends on:** ThompsonSampler (POC), AdaptiveThresholdManager, ControlledExecutor
> **Estimation:** 0.5-1 jour

---

## Story

As a decision system, I want to use Thompson Sampling for execution decisions, So that I balance
exploration (trying uncertain tools) and exploitation (using reliable tools).

---

## Context & Problem

**Le gap actuel:**

L'`AdaptiveThresholdManager` existant utilise un algorithme simple basé sur false positive/negative
rates. Il ajuste les seuils globalement, pas par tool.

| Aspect          | Avant (AdaptiveThresholdManager) | Après (Thompson Sampling)                                   |
| --------------- | -------------------------------- | ----------------------------------------------------------- |
| **Granularité** | Seuils globaux                   | Per-tool (`Beta(α,β)`)                                      |
| **Exploration** | Aucune                           | UCB bonus pour tools sous-explorés                          |
| **Risque**      | Non considéré                    | Basé sur `scope` (mcp-permissions.yaml)                     |
| **Mode**        | Un seul seuil                    | 3 modes: `active_search`/`passive_suggestion`/`speculation` |
| **Decay**       | Non                              | Oui (environnements non-stationnaires)                      |

**Solution : Thompson Sampling Integration**

Le module `ThompsonSampler` (708 LOC) est déjà implémenté dans
`src/graphrag/algorithms/thompson.ts`. Cette story **intègre** ce POC dans le flow de décision
AIL/HIL.

---

## Ce qui existe déjà

**ThompsonSampler POC (`src/graphrag/algorithms/thompson.ts`):**

```typescript
class ThompsonSampler {
  // Per-tool Bayesian learning
  getThreshold(toolId, riskCategory, mode, localAlpha): ThresholdResult;
  sampleThreshold(toolId): number;
  recordOutcome(toolId, success): void;
  getUCBBonus(toolId): number;
  getMean(toolId): number;
  getVariance(toolId): number;
  getConfidenceInterval(toolId): [number, number];
  sampleBeta(alpha, beta): number; // Joehnk's algorithm
}

// Factory functions
function createThompsonFromHistory(history): ThompsonSampler;
function createThompsonForMode(mode): ThompsonSampler;

// Risk classification (à remplacer par scope-based)
function classifyToolRisk(toolName, serverReadOnly?): RiskCategory; // DEPRECATED
function getRiskFromScope(scope: PermissionScope): RiskCategory; // NEW

// Decision functions
function makeDecision(sampler, toolId, score, risk, mode, localAlpha): boolean;
function makeBatchDecision(sampler, tools, mode, localAlpha): Map<string, boolean>;
```

**AdaptiveThresholdManager (`src/mcp/adaptive-threshold.ts`):**

```typescript
class AdaptiveThresholdManager {
  // Current implementation: sliding window + false positive/negative rates
  recordExecution(record: ExecutionRecord): void;
  getThresholds(): { explicitThreshold?; suggestionThreshold? };
  getMetrics(): SpeculativeMetrics;

  // PGlite persistence (Epic 4 Phase 1)
  loadThresholds(context?): Promise<StoredThreshold | null>;
  saveThresholds(context?): Promise<void>;
}
```

**ControlledExecutor (`src/dag/controlled-executor.ts`):**

- Utilise `adaptiveThresholdManager.getThresholds()` pour décisions per-layer
- Doit utiliser Thompson Sampling pour décisions per-tool

---

## Design Principles

1. **ThompsonSampler comme source primaire** - Remplace l'algorithme simple par Thompson
2. **AdaptiveThresholdManager comme wrapper** - Conserve l'interface existante, délègue à
   ThompsonSampler
3. **Backward compatibility** - `getThresholds()` continue de fonctionner
4. **Risk via scope** - `mcp-permissions.yaml` → `scope` → `RiskCategory`
5. **HIL bypass** - `approvalMode: hil` déclenche per-layer validation, pas Thompson
6. **Pas de migration** - Les anciennes données ne sont pas migrées (fresh start)

---

## Acceptance Criteria

### AC1: Intégration ThompsonSampler dans AdaptiveThresholdManager

- [x] `AdaptiveThresholdManager` crée un `ThompsonSampler` en interne
- [x] `getThreshold(toolId, mode)` délègue à `ThompsonSampler.getThreshold()`
- [x] `recordExecution()` appelle `ThompsonSampler.recordOutcome()`
- [x] Constructor prend `thompsonConfig` optionnel

### AC2: Risk Classification basée sur scope

- [x] Charger `mcp-permissions.yaml` au démarrage
- [x] Mapper `scope` → `RiskCategory` :
  - `minimal` / `readonly` → `safe`
  - `filesystem` / `network-api` → `moderate`
  - `mcp-standard` → `dangerous`
- [x] **Note:** `approvalMode: hil` déclenche déjà per-layer validation (bypass Thompson)

### AC3: Mode-specific thresholds

- [x] `getThreshold()` accepte `mode: ThresholdMode` (active_search, passive_suggestion)
- [x] Mode `active_search` → seuil plus bas, UCB bonus appliqué
- [x] Mode `passive_suggestion` → seuil standard (default)
- [x] Mode `speculation` → **DEFERRED to Story 12.1** (speculative execution)
- [x] **Note:** `per_layer_validation: true` bypass Thompson → HIL direct

### AC4: UCB Exploration Bonus

- [x] `getThreshold()` en mode `active_search` inclut UCB bonus
- [x] Bonus élevé pour tools sous-explorés (encourage exploration)
- [x] Bonus diminue avec l'expérience

### AC5: Smart HIL - Arrêt avant tool risqué (pas tout le DAG)

- [x] Modifier `workflow-execution-handler.ts` - added `smartHILCheck()` function
- [x] Nouveau status `decision_required` avec détails du tool en attente
- [x] `smartHILCheck()` returns detailed breakdown per tool
- [x] Response inclut thresholdBreakdown avec tool details

### AC6: ControlledExecutor utilise seuils Thompson

- [x] `getThresholdForTool(toolId, mode)` pour décision per-tool
- [x] Score SHGAT vs threshold Thompson → execute ou decision_required
- [x] Mode déterminé par context (speculation si review, active_search si exploration)

### AC6b: Capabilities héritent du risk des tools

- [x] `calculateCapabilityRisk(toolsUsed)` calcule le max des risks des `toolsUsed`
- [x] Hierarchy: `dangerous` > `moderate` > `safe`
- [x] Risk calculé dynamiquement in `rowToCapability()` - no DB migration needed
- [x] Added `riskCategory` field to Capability interface

### AC7: Tests unitaires

- [x] Test: Thompson threshold valid range
- [x] Test: UCB bonus élevé pour tool jamais utilisé
- [x] Test: Scope classification: `minimal` → safe, `mcp-standard` → dangerous
- [x] Test: Mode `active_search` → seuil plus bas que `passive_suggestion`
- [x] Test: recordOutcome met à jour Beta(α,β)
- [x] Test: Tools unknown → requiresHIL returns true
- [x] Test: Confidence interval narrows with samples
- [x] Test: Reset clears Thompson sampler

### AC8: Pas de migration de données

- [x] Thompson démarre avec prior uniforme `Beta(1,1)` pour tous les tools
- [x] Les anciennes données `adaptive_thresholds` ne sont pas migrées
- [x] riskCategory computed dynamically, no DB migration needed

---

## Tasks / Subtasks

- [x] **Task 1: Étendre AdaptiveThresholdManager** (AC: #1, #2)
  - [x] 1.1 Ajouter `ThompsonSampler` comme champ privé
  - [x] 1.2 Modifier constructor pour créer ThompsonSampler
  - [x] 1.3 Ajouter `getThresholdForTool(toolId, mode)` method
  - [x] 1.4 Modifier `recordExecution()` pour appeler `recordOutcome()`
  - [x] 1.5 Ajouter `getToolRiskCategory(toolId)` helper

- [x] **Task 2: Intégrer Risk Classification via scope** (AC: #2)
  - [x] 2.1 Créer `getRiskFromScope(scope): RiskCategory` helper
  - [x] 2.2 Charger `mcp-permissions.yaml` via `getToolPermissionConfig()`
  - [x] 2.3 Extraire `scope` et mapper vers risk
  - [x] 2.4 Default `moderate` pour tools inconnus (conservative)

- [x] **Task 3: Implémenter Smart HIL** (AC: #5)
  - [x] 3.1 Créer `smartHILCheck(dag, thresholdManager, confidence, mode)`
  - [x] 3.2 Returns detailed breakdown per tool with thresholds
  - [x] 3.3 Export `smartHILCheck` from workflow-execution-handler.ts

- [x] **Task 4: Intégrer Thompson dans décisions** (AC: #6)
  - [x] 4.1 Import `smartHILCheck` in execute-handler.ts
  - [x] 4.2 Add `updateThompsonSampling()` function
  - [x] 4.3 Call updateThompsonSampling after execution

- [x] **Task 4b: Capabilities héritent risk des tools** (AC: #6b)
  - [x] 4b.1 Créer `calculateCapabilityRisk(toolsUsed): RiskCategory`
  - [x] 4b.2 No DB migration - riskCategory computed dynamically
  - [x] 4b.3 Added `riskCategory` to Capability interface
  - [x] 4b.4 Modifier `rowToCapability()` pour calculer `riskCategory`

- [x] **Task 5: Tests unitaires** (AC: #7)
  - [x] 5.1 Extended `tests/unit/mcp/adaptive_threshold_test.ts`
  - [x] 5.2 13 new tests for Thompson integration
  - [x] 5.3 Tests pour UCB bonus
  - [x] 5.4 Tests pour scope → risk classification
  - [x] 5.5 Tests pour requiresHIL

- [x] **Task 6: Validation** (AC: #8)
  - [x] 6.1 Run `deno check` - all modified files pass
  - [x] 6.2 Run tests - 25/25 pass
  - [x] 6.3 Backward compatibility verified

---

## Dev Notes

### Architecture Integration - Smart HIL

```
┌─────────────────────────────────────────────────────────────────┐
│  pml:execute - Mode Direct                                        │
│       │                                                           │
│       ▼                                                           │
│  findFirstRiskyLayer(dag) → layer_index ou null                   │
│       │                                                           │
│  ┌────┴────────────────────────────────────────────────────────┐ │
│  │ Aucun tool risqué?                                           │ │
│  └────┬────────────────────────────────────────────────────────┘ │
│      OUI                         NON                              │
│       │                           │                               │
│       ▼                           ▼                               │
│  Execute tout              Execute layers 0..(N-1)                │
│  status: "success"               │                                │
│                                  ▼                                │
│                           Stop avant layer N                      │
│                           status: "decision_required"             │
│                           {                                       │
│                             executed_layers: [...],               │
│                             pending_layer: N,                     │
│                             pending_tool: "std:systemctl",        │
│                             risk: "unknown",                      │
│                             options: ["approve", "skip", "abort"] │
│                           }                                       │
└─────────────────────────────────────────────────────────────────┘

Risk Check per Tool:
┌─────────────────────────────────────────────────────────────────┐
│  getToolPermissionConfig(toolPrefix)                              │
│       │                                                           │
│  ┌────┴────────┐                                                  │
│  │ Config?     │                                                  │
│  └────┬────────┘                                                  │
│    null        found                                              │
│     │            │                                                │
│     ▼            ▼                                                │
│  UNKNOWN     ┌──────────┐                                         │
│  → RISKY     │approvalMode?                                       │
│              └────┬─────┘                                         │
│              hil  │  auto                                         │
│               │   │   │                                           │
│               ▼   │   ▼                                           │
│            RISKY  │  Thompson.getThreshold(scope) vs score        │
│                   │       │                                       │
│                   │  ┌────┴────┐                                  │
│                   │  score >= threshold?                          │
│                   │  └────┬────┘                                  │
│                   │  OUI  │  NON                                  │
│                   │   │   │   │                                   │
│                   │   ▼   │   ▼                                   │
│                   │  SAFE │  RISKY                                │
│                   └───────┴───────                                │
└─────────────────────────────────────────────────────────────────┘
```

### Mode Selection Logic

```typescript
function determineMode(context: ExecutionContext): ThresholdMode {
  // NOTE: perLayerValidation bypasses Thompson entirely → HIL flow
  // NOTE: speculation mode deferred to Story 12.1

  if (context.activeSearch) {
    return "active_search"; // Exploration, UCB bonus, lower threshold
  }
  return "passive_suggestion"; // Default, standard threshold
}
```

**Bypass Thompson (HIL direct):**

- `per_layer_validation: true` → pas de Thompson, HIL flow
- `approvalMode: hil` → pas de Thompson, HIL flow
- Tool inconnu → pas de Thompson, HIL flow

### Risk Category via Scope (mcp-permissions.yaml)

```typescript
function getRiskFromScope(scope: PermissionScope): RiskCategory {
  switch (scope) {
    case "minimal":
    case "readonly":
      return "safe"; // seuil 0.55

    case "filesystem":
    case "network-api":
      return "moderate"; // seuil 0.70

    case "mcp-standard":
    default:
      return "dangerous"; // seuil 0.85
  }
}
```

**Important:** `approvalMode: hil` bypass Thompson (per-layer HIL déjà en place)

### Example: Smart HIL in Action

```
DAG: [filesystem:read] → [json:parse] → [std:systemctl] → [filesystem:write]
      Layer 0 (auto)     Layer 1 (auto)   Layer 2 (unknown)   Layer 3 (auto)
```

**Comportement Smart HIL :**

1. Execute Layer 0 (`filesystem:read`) ✅
2. Execute Layer 1 (`json:parse`) ✅
3. **Stop avant Layer 2** (`std:systemctl` = unknown → RISKY)
4. Return `status: "decision_required"`

```json
{
  "status": "decision_required",
  "executed_layers": [
    { "layer": 0, "tool": "filesystem:read", "result": "..." },
    { "layer": 1, "tool": "json:parse", "result": "..." }
  ],
  "pending_layer": 2,
  "pending_tool": {
    "name": "std:systemctl",
    "risk": "unknown",
    "reason": "Tool not in mcp-permissions.yaml"
  },
  "options": ["approve", "skip", "abort"]
}
```

### Thompson Threshold Examples

| Tool            | Scope        | Risk      | Score | Threshold | Decision                 |
| --------------- | ------------ | --------- | ----- | --------- | ------------------------ |
| `json:parse`    | minimal      | safe      | 0.80  | 0.55      | ✅ Execute               |
| `git:commit`    | filesystem   | moderate  | 0.65  | 0.70      | ❌ decision_required     |
| `git:commit`    | filesystem   | moderate  | 0.75  | 0.70      | ✅ Execute               |
| `docker:run`    | mcp-standard | dangerous | 0.80  | 0.85      | ❌ decision_required     |
| `std:systemctl` | (unknown)    | —         | —     | —         | ❌ HIL (bypass Thompson) |
| `ssh:exec`      | hil          | —         | —     | —         | ❌ HIL (bypass Thompson) |

### Backward Compatibility

```typescript
// Old code continues to work
const thresholds = manager.getThresholds();
const canExecute = score >= thresholds.suggestionThreshold;

// New code uses per-tool thresholds
const result = manager.getThresholdForTool("fs:read", "passive_suggestion");
const canExecute = score >= result.threshold;
```

### Files to Modify

| File                                          | Changes                         | LOC  |
| --------------------------------------------- | ------------------------------- | ---- |
| `src/mcp/adaptive-threshold.ts`               | Add ThompsonSampler integration | ~80  |
| `src/dag/controlled-executor.ts`              | Use per-tool thresholds         | ~30  |
| `tests/unit/mcp/thompson_integration_test.ts` | New test file                   | ~150 |

### Files to Reference

| File                                                   | Purpose                       |
| ------------------------------------------------------ | ----------------------------- |
| `src/graphrag/algorithms/thompson.ts`                  | ThompsonSampler POC (708 LOC) |
| `config/mcp-permissions.yaml`                          | Risk categories per server    |
| `docs/adrs/ADR-049-intelligent-adaptive-thresholds.md` | Design rationale              |

---

## References

- [Source: src/graphrag/algorithms/thompson.ts](../../src/graphrag/algorithms/thompson.ts) -
  Thompson Sampling POC
- [Source: src/mcp/adaptive-threshold.ts](../../src/mcp/adaptive-threshold.ts) - Current threshold
  manager
- [Source: src/dag/controlled-executor.ts](../../src/dag/controlled-executor.ts) - DAG executor
- [Config: config/mcp-permissions.yaml](../../config/mcp-permissions.yaml) - Server permissions
- [ADR-049](../adrs/ADR-049-intelligent-adaptive-thresholds.md) - Threshold design
- [Epic 10](../epics/epic-10-dag-capability-learning-unified-apis.md) - Parent epic
- [Story 10.7](./10-7-pml-execute-api.md) - pml_execute (prerequisite)
- [Project Context](../project-context.md) - Architecture patterns

---

## Previous Story Intelligence (10.7)

From Story 10.7 (pml_execute - completed 2025-12-23):

- **SHGAT scoring** integrated for capability matching
- **DR-DSP** for hypergraph pathfinding
- **Mode Direct** vs **Mode Suggestion** patterns
- **ControlledExecutor** used for all DAG execution
- **execute-handler.ts** patterns for mode detection
- **Tests** in `tests/unit/mcp/handlers/execute_handler_test.ts`

### Patterns to reuse:

```typescript
// From execute-handler.ts - mode detection
const mode = code ? "direct" : "suggestion";

// From execute-handler.ts - threshold check
const thresholds = deps.adaptiveThresholdManager?.getThresholds();
const canSpeculate = bestCapability.score >= (thresholds?.suggestionThreshold ?? 0.7);
```

---

## Git Intelligence

Recent commits (2025-12-23):

```
18c1fd2 fix(10.7): code review fixes - E2E test and sprint status sync
3f9c345 Update configuration files and introduce capability naming curation system
```

Patterns observed:

- Commit format: `feat(story-X.Y): description`
- Test-first approach for algorithm changes
- Story files include Dev Agent Record section

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- Tests: 25/25 passing in adaptive_threshold_test.ts
- Type check: All modified files pass deno check

### Completion Notes List

1. Extended AdaptiveThresholdManager with ThompsonSampler integration
2. Added getThresholdForTool(), recordToolOutcome(), requiresHIL(), getToolRiskCategory()
3. Added getRiskFromScope() and calculateCapabilityRisk() functions
4. Added smartHILCheck() function in workflow-execution-handler.ts
5. Added updateThompsonSampling() function in execute-handler.ts (exported)
6. Added riskCategory field to Capability interface (computed dynamically, no DB migration)
7. Extended ExecutionRecord with toolId field for per-tool Thompson updates
8. 13 new tests for Thompson integration in adaptive_threshold_test.ts
9. Re-exported Thompson types from adaptive-threshold.ts for external consumers
10. **[Code Review Fix]** Thompson update now called in ALL execution paths (workflow + direct)
11. **[Code Review Fix]** Added adaptiveThresholdManager to WorkflowHandlerDependencies

### File List

| File                                             | Changes                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `src/mcp/adaptive-threshold.ts`                  | +244 LOC - Thompson integration, getRiskFromScope, calculateCapabilityRisk |
| `src/mcp/handlers/workflow-execution-handler.ts` | +101 LOC - smartHILCheck + Thompson update after execution                 |
| `src/mcp/handlers/execute-handler.ts`            | +77 LOC - updateThompsonSampling (exported)                                |
| `src/mcp/handlers/workflow-handler-types.ts`     | +3 LOC - adaptiveThresholdManager in deps                                  |
| `src/mcp/gateway-server.ts`                      | +1 LOC - pass adaptiveThresholdManager to workflow deps                    |
| `src/capabilities/capability-store.ts`           | +4 LOC - riskCategory in rowToCapability                                   |
| `src/capabilities/types.ts`                      | +9 LOC - riskCategory field in Capability                                  |
| `src/graphrag/types.ts`                          | +4 LOC - toolId in ExecutionRecord                                         |
| `tests/unit/mcp/adaptive_threshold_test.ts`      | +146 LOC - 13 new Thompson tests                                           |
