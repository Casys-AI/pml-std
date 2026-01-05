# ADR-049: Intelligent Adaptive Thresholds with Local Alpha Integration

**Status:** Proposed **Date:** 2025-12-16 **Related:** ADR-008 (Episodic Memory), ADR-035
(Permission Sets), ADR-041 (Edge Tracking), ADR-042 (Capability Hyperedges), ADR-048 (Local Alpha)
**Supersedes:** `config/speculation_config.yaml` (configuration actuelle simplifiée)

## Context

### Configuration Actuelle: speculation_config.yaml

Le fichier `config/speculation_config.yaml` définit la configuration de spéculation actuelle (Story
3.5-2):

```yaml
enabled: true
confidence_threshold: 0.70 # Seuil global unique
max_concurrent_speculations: 3
speculation_timeout: 10000
adaptive:
  enabled: true
  min_threshold: 0.40
  max_threshold: 0.90
```

**Limitations de cette approche:**

- Un seul `confidence_threshold` global pour tous les tools
- Pas de distinction par niveau de risque (read vs delete)
- Ajustement adaptatif simple (EMA) sans apprentissage per-tool

Cette ADR propose de remplacer cette configuration par un système intelligent à 3 niveaux.

### Problème Identifié

Le système actuel d'**AdaptiveThresholdManager** (ADR-008) présente plusieurs limitations qui
réduisent son intelligence :

```
┌───────────────────────────────────────────────────────────────────────┐
│                    ÉTAT ACTUEL - PROBLÈMES                            │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  1. THRESHOLD GLOBAL                                                  │
│     read_file → 0.70   ←─┐                                           │
│     delete_file → 0.70  ←┼── Même threshold pour tous !              │
│     git_commit → 0.70  ←─┘                                           │
│                                                                       │
│  2. PAS D'INTÉGRATION AVEC LOCAL ALPHA (ADR-048)                     │
│     Local Alpha dit: "graph fiable pour tool1" → ignoré              │
│                                                                       │
│  3. AJUSTEMENT LINÉAIRE SIMPLE                                       │
│     threshold += 0.05  (oscillation, convergence lente)              │
│                                                                       │
│  4. CONTEXTE TROP GROSSIER                                           │
│     Hash = workflowType|domain|complexity (3 dimensions seulement)   │
│                                                                       │
│  5. MÉMOIRE ÉPISODIQUE SOUS-UTILISÉE                                 │
│     On stocke: speculation_start, task_complete, decisions           │
│     On utilise: seulement taux succès/échec global                   │
│                                                                       │
│  6. SEUIL D'OBSERVATION FIXE POUR EDGES                              │
│     OBSERVED_THRESHOLD = 3 (constant, indépendant du contexte)       │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Recherche: Algorithmes Adaptatifs

#### Thompson Sampling (Bandits Multi-Bras)

[Thompson Sampling](https://en.wikipedia.org/wiki/Thompson_sampling) est un algorithme bayésien qui:

- Maintient une distribution de probabilité **par action** (ici: par tool)
- Balance exploration/exploitation naturellement
- Converge vers l'optimal avec peu d'échantillons
- S'adapte aux changements (non-stationnaire)

**Avantage pour notre cas:** Chaque tool a son propre historique, pas de "moyenne" globale.

#### UCB (Upper Confidence Bound)

[UCB](https://www.geeksforgeeks.org/machine-learning/upper-confidence-bound-algorithm-in-reinforcement-learning/)
ajoute un bonus d'incertitude:

- Favorise les actions peu explorées
- Réduire l'incertitude progressivement
- Convergence garantie vers l'optimal

**Avantage pour notre cas:** Cold start tools reçoivent plus d'exploration.

#### Contextual Bandits

[Contextual Bandits](https://arxiv.org/abs/2312.14037) étendent les bandits avec du contexte:

- Le reward dépend du contexte (workflow type, tool utilisé, etc.)
- LinUCB: Linear UCB avec features contextuelles
- Personnalisation par situation

**Avantage pour notre cas:** Le threshold dépend du contexte local + alpha.

#### Adaptive Edge Weighting (GNN)

[HU-GNN](https://arxiv.org/html/2504.19820v2) propose:

- Uncertainty estimation multi-échelle (local, community, global)
- Down-weighting des edges à haute incertitude
- Propagation adaptative basée sur la confiance

**Avantage pour notre cas:** Les edges avec peu d'observations sont pondérés moins fortement.

---

## Options Considered

### Decision 1: Algorithme d'apprentissage pour Execution Threshold

#### Option 1A: EMA Global (Actuel)

```typescript
// Threshold unique pour tous les tools
if (falsePositiveRate > 0.2) {
  threshold += learningRate; // +0.05
}
```

**Score: 45/100**

| Critère      | Score   | Commentaire               |
| ------------ | ------- | ------------------------- |
| Simplicité   | 🟢 9/10 | Très simple à implémenter |
| Convergence  | 🟡 5/10 | Lente, peut osciller      |
| Granularité  | 🔴 2/10 | Global, pas per-tool      |
| Cold start   | 🔴 3/10 | Pas de gestion spécifique |
| Adaptabilité | 🟡 4/10 | Réactif mais lent         |

**Pros:**

- 🟢 Implémenté, fonctionne
- 🟢 Facile à débugger

**Cons:**

- 🔴 Pas de distinction par tool
- 🔴 `delete_file` et `read_file` ont le même threshold
- 🔴 Convergence lente (50+ samples)

---

#### Option 1B: UCB (Upper Confidence Bound)

```typescript
// Threshold = mean - exploration_bonus
threshold = mean_success_rate - sqrt(2 * ln(total) / n_tool);
```

**Score: 62/100**

| Critère      | Score   | Commentaire               |
| ------------ | ------- | ------------------------- |
| Simplicité   | 🟡 6/10 | Formule mathématique      |
| Convergence  | 🟢 7/10 | Garanties théoriques      |
| Granularité  | 🟢 7/10 | Per-tool possible         |
| Cold start   | 🟢 8/10 | Bonus exploration naturel |
| Adaptabilité | 🟡 5/10 | Assume stationnarité      |

**Pros:**

- 🟢 Exploration automatique des nouveaux tools
- 🟢 Convergence prouvée mathématiquement
- 🟢 Pas d'hyperparamètre de learning rate

**Cons:**

- 🔴 Assume environnement stationnaire
- 🔴 Pas de prise en compte du risque du tool
- 🟡 Peut sur-explorer

---

#### Option 1C: Thompson Sampling ⭐ RECOMMENDED

```typescript
// Distribution Beta par tool
tool.alpha += success ? 1 : 0;
tool.beta += success ? 0 : 1;
threshold = 1 - sampleBeta(alpha, beta);
```

**Score: 82/100**

| Critère      | Score   | Commentaire              |
| ------------ | ------- | ------------------------ |
| Simplicité   | 🟡 6/10 | Distribution Beta        |
| Convergence  | 🟢 8/10 | Rapide (10-20 samples)   |
| Granularité  | 🟢 9/10 | Per-tool natif           |
| Cold start   | 🟢 8/10 | Prior uniforme Beta(1,1) |
| Adaptabilité | 🟢 8/10 | Decay factor possible    |

**Pros:**

- 🟢 Chaque tool a sa propre distribution
- 🟢 Balance exploration/exploitation naturellement
- 🟢 Convergence rapide avec peu de données
- 🟢 Decay factor pour non-stationnarité
- 🟢 Interprétable (succès/échecs)

**Cons:**

- 🟡 Sampling stochastique (légère variance)
- 🟡 Nécessite stockage per-tool

**Verdict:** ⭐ **Option 1C - Thompson Sampling**

---

#### Option 1D: Contextual Bandits (LinUCB)

```typescript
// Features contextuelles → threshold
const features = [workflowType, localAlpha, toolRisk, ...];
threshold = linUCB.predict(features);
```

**Score: 75/100**

| Critère      | Score   | Commentaire               |
| ------------ | ------- | ------------------------- |
| Simplicité   | 🔴 3/10 | Modèle linéaire, features |
| Convergence  | 🟢 7/10 | Dépend des features       |
| Granularité  | 🟢 9/10 | Contextuel complet        |
| Cold start   | 🟢 8/10 | Généralisation features   |
| Adaptabilité | 🟢 8/10 | Contextuel par nature     |

**Pros:**

- 🟢 Prend en compte le contexte complet
- 🟢 Peut généraliser à de nouveaux tools similaires
- 🟢 State-of-the-art en recommendation

**Cons:**

- 🔴 Complexité d'implémentation
- 🔴 Feature engineering requis
- 🔴 Difficile à débugger

---

### Decision 2: Intégration du Local Alpha

#### Option 2A: Pas d'intégration (Actuel)

**Score: 30/100**

Le threshold ignore complètement le local alpha.

**Cons:**

- 🔴 Graph reliability ignorée
- 🔴 Incohérence avec ADR-048

---

#### Option 2B: Alpha comme multiplicateur

```typescript
threshold = baseThreshold * (1 + (localAlpha - 0.75) * 0.2);
```

**Score: 65/100**

| Critère    | Score   | Commentaire        |
| ---------- | ------- | ------------------ |
| Simplicité | 🟢 8/10 | Une multiplication |
| Impact     | 🟡 6/10 | ±10% variation     |
| Cohérence  | 🟢 7/10 | Utilise ADR-048    |

**Pros:**

- 🟢 Simple à implémenter
- 🟢 Effet modéré, pas de risque

**Cons:**

- 🟡 Effet peut-être trop faible
- 🟡 Pas de distinction par type d'alpha algo

---

#### Option 2C: Alpha comme terme additif ⭐ RECOMMENDED

```typescript
threshold = baseThreshold + thompsonAdj + (localAlpha - 0.75) * 0.10;
```

**Score: 78/100**

| Critère          | Score   | Commentaire                     |
| ---------------- | ------- | ------------------------------- |
| Simplicité       | 🟢 8/10 | Addition linéaire               |
| Impact           | 🟢 7/10 | ±2.5% (raisonnable)             |
| Cohérence        | 🟢 8/10 | Composable avec autres facteurs |
| Interprétabilité | 🟢 8/10 | Breakdown clair                 |

**Pros:**

- 🟢 Composable avec Thompson et episodic boost
- 🟢 Chaque facteur visible dans breakdown
- 🟢 Facile à tuner indépendamment

**Cons:**

- 🟡 Poids (0.10) à calibrer

**Verdict:** ⭐ **Option 2C - Alpha comme terme additif**

---

### Decision 3: Gestion du risque par tool

#### Option 3A: Pas de différenciation (Actuel)

**Score: 35/100**

Tous les tools ont le même threshold de base.

**Cons:**

- 🔴 `delete_file` traité comme `read_file`
- 🔴 Risque de dommages irréversibles

---

#### Option 3B: Catégories de risque fixes (pattern matching)

```typescript
const riskThresholds = {
  safe: 0.55, // read_file, list_dir
  moderate: 0.70, // write_file, git_commit
  dangerous: 0.85, // delete_file, drop_table
};
```

**Score: 65/100**

| Critère     | Score   | Commentaire                |
| ----------- | ------- | -------------------------- |
| Simplicité  | 🟢 9/10 | 3 catégories               |
| Sécurité    | 🟢 8/10 | Dangerous = threshold haut |
| Flexibilité | 🟡 5/10 | Pattern matching fragile   |
| Maintenance | 🟡 5/10 | `delete_draft` mal classé  |

**Cons:**

- 🟡 Pattern matching fragile (`soft_delete`, `remove_cache` mal classés)
- 🟡 Ne prend pas en compte le contexte du server

---

#### Option 3C: Risque appris automatiquement

```typescript
// Apprendre le risque depuis les outcomes
risk = learnRiskFromHistory(toolId, outcomes);
```

**Score: 50/100**

| Critère     | Score   | Commentaire          |
| ----------- | ------- | -------------------- |
| Simplicité  | 🔴 4/10 | ML supplémentaire    |
| Sécurité    | 🔴 3/10 | Cold start dangereux |
| Flexibilité | 🟢 9/10 | S'adapte             |
| Maintenance | 🟢 8/10 | Automatique          |

**Cons:**

- 🔴 Un tool dangereux peut causer des dégâts AVANT qu'on apprenne
- 🔴 Complexité supplémentaire

---

#### Option 3D: Intégration avec mcp-permissions.yaml (ADR-035) ⭐ RECOMMENDED

Utilise les permissions MCP comme **source de vérité** pour le niveau server, puis affine avec le
nom du tool.

```typescript
/**
 * Risk classification using mcp-permissions.yaml (ADR-035) + tool patterns
 *
 * Flow:
 * 1. Server isReadOnly? → safe
 * 2. Tool name has irreversible pattern? → dangerous
 * 3. Tool name has write pattern? → moderate
 * 4. Fallback based on permissionSet
 */

const IRREVERSIBLE_PATTERNS = [
  "delete",
  "remove",
  "drop",
  "truncate",
  "reset_hard",
  "force_push",
  "format",
  "destroy",
  "wipe",
];

const WRITE_PATTERNS = [
  "write",
  "create",
  "update",
  "insert",
  "push",
  "commit",
  "set",
];

function getBaseRisk(server: string, toolName: string): "safe" | "moderate" | "dangerous" {
  const serverConfig = loadMcpPermissions()[server];
  const lowerToolName = toolName.toLowerCase();

  // 1. Server explicitly readonly → always safe
  if (serverConfig?.isReadOnly) {
    return "safe";
  }

  // 2. Irreversible action pattern → dangerous
  if (IRREVERSIBLE_PATTERNS.some((p) => lowerToolName.includes(p))) {
    return "dangerous";
  }

  // 3. Write action pattern → moderate
  if (WRITE_PATTERNS.some((p) => lowerToolName.includes(p))) {
    return "moderate";
  }

  // 4. Fallback based on permissionSet
  switch (serverConfig?.permissionSet) {
    case "minimal":
      return "safe";
    case "readonly":
      return "safe";
    case "trusted":
      return "dangerous"; // Manual verification only
    case "network-api":
      return "moderate";
    case "filesystem":
      return "moderate";
    case "mcp-standard":
      return "moderate";
    default:
      return "moderate"; // Conservative default
  }
}
```

**Score: 82/100**

| Critère     | Score   | Commentaire                         |
| ----------- | ------- | ----------------------------------- |
| Simplicité  | 🟢 7/10 | Layered approach                    |
| Sécurité    | 🟢 9/10 | isReadOnly = guaranteed safe        |
| Flexibilité | 🟢 8/10 | Server-level + tool-level           |
| Maintenance | 🟢 8/10 | Centralized in mcp-permissions.yaml |
| Cohérence   | 🟢 9/10 | Réutilise ADR-035                   |

**Pros:**

- 🟢 `isReadOnly: true` servers are **guaranteed safe** (memory, context7)
- 🟢 Leverages existing `mcp-permissions.yaml` (ADR-035)
- 🟢 Layered: server config → tool pattern → default
- 🟢 Single source of truth for MCP server capabilities
- 🟢 Easy to extend with `toolOverrides` if needed

**Cons:**

- 🟡 Still relies on pattern matching for tool names
- 🟡 Requires mcp-permissions.yaml to be kept up-to-date

**Example classifications:**

| Server       | Tool               | isReadOnly | Pattern | → Risk        |
| ------------ | ------------------ | ---------- | ------- | ------------- |
| `memory`     | `store`            | ✅ true    | -       | **safe**      |
| `context7`   | `query`            | ✅ true    | -       | **safe**      |
| `filesystem` | `read_file`        | ❌ false   | read    | **safe**      |
| `filesystem` | `write_file`       | ❌ false   | write   | **moderate**  |
| `filesystem` | `delete_file`      | ❌ false   | delete  | **dangerous** |
| `postgres`   | `query`            | ❌ false   | query   | **safe**      |
| `postgres`   | `drop_table`       | ❌ false   | drop    | **dangerous** |
| `github`     | `create_pr`        | ❌ false   | create  | **moderate**  |
| `docker`     | `remove_container` | ❌ false   | remove  | **dangerous** |

**Optional extension - toolOverrides in mcp-permissions.yaml:**

```yaml
filesystem:
  permissionSet: filesystem
  isReadOnly: false
  toolOverrides: # Explicit overrides for edge cases
    read_file: safe
    delete_file: dangerous
    soft_delete: moderate # Override pattern match
```

**Verdict:** ⭐ **Option 3D - Integration with mcp-permissions.yaml (ADR-035)**

---

### Decision 4: Utilisation de la mémoire épisodique

#### Option 4A: Taux global seulement (Actuel)

**Score: 40/100**

Calcule le success rate global, ignore les situations similaires.

---

#### Option 4B: Boost par situations similaires ⭐ RECOMMENDED

```typescript
// Chercher situations similaires dans algorithm_traces
const similar = findSimilarTraces(toolId, localAlpha, workflowType);
const boost = calculateBoostFromHistory(similar);
```

**Score: 76/100**

| Critère          | Score   | Commentaire               |
| ---------------- | ------- | ------------------------- |
| Simplicité       | 🟡 6/10 | Query SQL multi-critères  |
| Valeur           | 🟢 8/10 | Contexte historique       |
| Performance      | 🟡 6/10 | Index requis              |
| Interprétabilité | 🟢 7/10 | "X situations similaires" |

**Pros:**

- 🟢 Utilise les données déjà collectées (algorithm_traces)
- 🟢 Boost conditionnel (seulement si historique pertinent)
- 🟢 Multi-dimensionnel (tool, alpha, workflow)

**Cons:**

- 🟡 Query peut être lente sans index
- 🟡 Définition de "similaire" à calibrer

**Verdict:** ⭐ **Option 4B - Boost par situations similaires**

---

#### Option 4C: Embedding similarity search

```typescript
// Vector search sur les contexts
const embedding = embedContext(currentContext);
const similar = vectorSearch(embedding, threshold: 0.8);
```

**Score: 70/100**

| Critère          | Score   | Commentaire           |
| ---------------- | ------- | --------------------- |
| Simplicité       | 🔴 3/10 | Embeddings, pgvector  |
| Valeur           | 🟢 8/10 | Similarité sémantique |
| Performance      | 🟡 5/10 | 50-100ms embedding    |
| Interprétabilité | 🔴 4/10 | "Black box"           |

**Cons:**

- 🔴 Overhead d'embedding (50-100ms)
- 🔴 Complexité d'infrastructure
- 🟡 Overkill pour notre cas

---

### Decision 5: Seuil d'observation pour edges

#### Option 5A: Fixe (Actuel)

```typescript
private static readonly OBSERVED_THRESHOLD = 3;
```

**Score: 50/100**

| Critère      | Score    | Commentaire        |
| ------------ | -------- | ------------------ |
| Simplicité   | 🟢 10/10 | Constante          |
| Adaptabilité | 🔴 2/10  | Aucune             |
| Cohérence    | 🔴 3/10  | Ignore local alpha |

---

#### Option 5B: Dynamique basé sur Local Alpha ⭐ RECOMMENDED

```typescript
threshold = 2 + ceil((avgAlpha - 0.5) * 6); // [2, 5]
```

**Score: 75/100**

| Critère      | Score   | Commentaire          |
| ------------ | ------- | -------------------- |
| Simplicité   | 🟢 8/10 | Formule simple       |
| Adaptabilité | 🟢 8/10 | Selon contexte local |
| Cohérence    | 🟢 8/10 | Utilise ADR-048      |

**Pros:**

- 🟢 Zone dense → 2 observations suffisent
- 🟢 Cold start → 5 observations requises
- 🟢 Cohérent avec la philosophie local alpha

**Cons:**

- 🟡 Calcul alpha à chaque edge update

**Verdict:** ⭐ **Option 5B - Dynamique basé sur Local Alpha**

---

### Decision 6: Stratégie algorithmique par mode (Pattern ADR-038)

#### Contexte des modes

| Mode                   | Caractéristique           | Coût False Positive   | Exploration utile ? |
| ---------------------- | ------------------------- | --------------------- | ------------------- |
| **Active Search**      | On cherche, user confirme | Faible (user filtre)  | Oui, découvrir      |
| **Passive Suggestion** | On suggère, user confirme | Moyen                 | Modéré              |
| **Speculation**        | On exécute directement    | Élevé (compute perdu) | Non, exploiter      |

---

#### Option 6A: Thompson partout (tuning par mode)

```typescript
const THOMPSON_CONFIG = {
  active_search: { prior: Beta(1, 1), useSampling: true, decay: 0.99 },
  passive_suggestion: { prior: Beta(2, 2), useSampling: true, decay: 0.98 },
  speculation: { prior: Beta(3, 1), useSampling: false, decay: 0.97 },
};
```

**Score: 80/100**

| Critère     | Score   | Commentaire                      |
| ----------- | ------- | -------------------------------- |
| Cohérence   | 🟢 9/10 | Un seul algo à maintenir         |
| Flexibilité | 🟢 8/10 | Tuning par mode                  |
| Complexité  | 🟢 8/10 | Paramètres différents, même code |

**Pros:**

- 🟢 Code unique, paramètres différents
- 🟢 Facile à maintenir

**Cons:**

- 🟡 Pas d'exploration UCB en Active Search
- 🟡 Prior conservateur en Speculation peut être trop strict

---

#### Option 6B: Algorithme différent par mode

```
Active Search    → UCB (exploration bonus)
Passive Suggest  → Thompson Sampling
Speculation      → Thompson (mean only) + Risk penalty
```

**Score: 75/100**

| Critère           | Score   | Commentaire           |
| ----------------- | ------- | --------------------- |
| Cohérence ADR-038 | 🟢 9/10 | Pattern identique     |
| Flexibilité       | 🟢 9/10 | Algo optimal par mode |
| Complexité        | 🔴 5/10 | 3 algos à maintenir   |

**Cons:**

- 🔴 3 algorithmes différents à implémenter
- 🔴 Comportements cold start différents

---

#### Option 6C: Hybride Thompson + UCB Bonus ⭐ RECOMMENDED

```typescript
function getThreshold(mode: Mode, toolId: string, localAlpha: number): number {
  const thompson = getThompsonState(toolId);
  const risk = getRiskCategory(toolId);
  const thompsonMean = thompson.alpha / (thompson.alpha + thompson.beta);

  switch (mode) {
    case "active_search":
      // UCB bonus pour exploration des nouveaux tools
      const ucbBonus = Math.sqrt(2 * Math.log(totalExec) / thompson.total);
      return clamp(riskBase[risk] - 0.10 - ucbBonus * 0.05 + alphaAdj, 0.40, 0.85);

    case "passive_suggestion":
      // Thompson sampling standard
      const sampled = sampleBeta(thompson.alpha, thompson.beta);
      return clamp(riskBase[risk] + (0.75 - sampled) * 0.10 + alphaAdj, 0.50, 0.90);

    case "speculation":
      // Thompson mean (pas de sampling) + conservative
      return clamp(riskBase[risk] + 0.05 + (0.75 - thompsonMean) * 0.15 + alphaAdj, 0.60, 0.95);
  }
}
```

**Score: 85/100**

| Critère     | Score   | Commentaire                       |
| ----------- | ------- | --------------------------------- |
| Cohérence   | 🟢 8/10 | Thompson comme colonne vertébrale |
| Flexibilité | 🟢 9/10 | Comportement optimal par mode     |
| Complexité  | 🟢 7/10 | Un algo + ajustements             |
| Cold start  | 🟢 8/10 | UCB bonus aide en Active Search   |

**Pros:**

- 🟢 Thompson reste la base (per-tool learning, convergence rapide)
- 🟢 UCB bonus en Active Search (exploration nouveaux tools)
- 🟢 Mean (pas sampling) en Speculation (stabilité, pas de variance)
- 🟢 Poids différents par mode (cohérent avec ADR-038)

**Cons:**

- 🟡 Légèrement plus complexe que Thompson pur

**Verdict:** ⭐ **Option 6C - Hybride Thompson + UCB Bonus**

---

### Matrice finale des algorithmes par mode (Pattern ADR-038)

```
┌─────────────────────────────────────────────────────────────────────────┐
│              THRESHOLD ALGORITHMS PAR MODE                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┬────────────────────┬────────────────────┐         │
│  │                  │ Active Search      │ Passive/Speculation│         │
│  ├──────────────────┼────────────────────┼────────────────────┤         │
│  │ Algo Base        │ Thompson + UCB     │ Thompson           │         │
│  │                  │ bonus exploration  │ (mean or sample)   │         │
│  ├──────────────────┼────────────────────┼────────────────────┤         │
│  │ Mode Adjust      │ risk - 0.10        │ Passive: 0         │         │
│  │                  │ (plus permissif)   │ Specul: +0.05      │         │
│  ├──────────────────┼────────────────────┼────────────────────┤         │
│  │ Thompson Usage   │ Mean + UCB bonus   │ Passive: Sampling  │         │
│  │                  │                    │ Specul: Mean only  │         │
│  ├──────────────────┼────────────────────┼────────────────────┤         │
│  │ Alpha Weight     │ 0.05× (faible)     │ 0.10× / 0.15×      │         │
│  ├──────────────────┼────────────────────┼────────────────────┤         │
│  │ Bounds           │ [0.40, 0.85]       │ [0.50, 0.95]       │         │
│  └──────────────────┴────────────────────┴────────────────────┘         │
│                                                                          │
│  Rationale:                                                             │
│  - Active Search: on CHERCHE → exploration, user confirme               │
│  - Passive: on SUGGÈRE → balance, user confirme                         │
│  - Speculation: on EXÉCUTE → exploitation, pas de variance              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Récapitulatif des Scores

| Decision                   | Option Choisie                            | Score  | Alternatives                                |
| -------------------------- | ----------------------------------------- | ------ | ------------------------------------------- |
| **D1: Algo apprentissage** | Thompson Sampling                         | 82/100 | EMA (45), UCB (62), LinUCB (75)             |
| **D2: Intégration Alpha**  | Terme additif                             | 78/100 | Aucune (30), Multiplicateur (65)            |
| **D3: Gestion risque**     | mcp-permissions.yaml + patterns (ADR-035) | 82/100 | Aucune (35), Pattern seul (65), Appris (50) |
| **D4: Mémoire épisodique** | Situations similaires                     | 76/100 | Global (40), Embeddings (70)                |
| **D5: Edge threshold**     | Dynamique alpha                           | 75/100 | Fixe (50)                                   |
| **D6: Stratégie par mode** | Hybride Thompson+UCB                      | 85/100 | Thompson tuné (80), Algo par mode (75)      |

**Score moyen solution proposée: 80/100**

---

## Decision

Implémenter un système de thresholds intelligent à **3 niveaux** :

### Architecture Proposée

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   INTELLIGENT ADAPTIVE THRESHOLDS                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │  NIVEAU 1        │    │  NIVEAU 2        │    │  NIVEAU 3        │  │
│  │  Edge Creation   │    │  Execution       │    │  Episodic        │  │
│  │  Threshold       │    │  Threshold       │    │  Memory Boost    │  │
│  └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘  │
│           │                       │                       │             │
│           ▼                       ▼                       ▼             │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      LOCAL ALPHA (ADR-048)                        │  │
│  │  - Embeddings Hybrides (Active Search)                           │  │
│  │  - Heat Diffusion (Passive Suggestion)                           │  │
│  │  - Bayesian Cold Start                                           │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      PER-TOOL THOMPSON SAMPLING                   │  │
│  │  tool1: Beta(α=8, β=2)  → 80% success → threshold: 0.62          │  │
│  │  tool2: Beta(α=3, β=7)  → 30% success → threshold: 0.85          │  │
│  │  tool3: Beta(α=1, β=1)  → unknown     → threshold: 0.75 (prior)  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Niveau 1: Adaptive Edge Creation Threshold

### Problème Actuel

```typescript
// Actuellement: seuil FIXE pour passer de inferred → observed
private static readonly OBSERVED_THRESHOLD = 3;
```

**Problème:** Un tool isolé (cold start, alpha=1.0) a le même seuil qu'un tool dans une zone dense
(alpha=0.5).

### Solution: Seuil Dynamique basé sur Local Alpha

```typescript
/**
 * Calculate adaptive observation threshold based on local alpha
 *
 * High alpha (sparse neighborhood) → need MORE observations to trust
 * Low alpha (dense neighborhood) → fewer observations sufficient
 *
 * Formula: threshold = 2 + ceil((alpha - 0.5) * 6)
 * - alpha=0.5 → 2 observations (dense, trustworthy)
 * - alpha=0.75 → 4 observations (medium)
 * - alpha=1.0 → 5 observations (sparse, need more proof)
 */
function getAdaptiveObservationThreshold(
  fromToolId: string,
  toToolId: string,
  localAlphaCalculator: LocalAlphaCalculator,
): number {
  const fromAlpha = localAlphaCalculator.getLocalAlpha("passive", fromToolId, "tool", []);
  const toAlpha = localAlphaCalculator.getLocalAlpha("passive", toToolId, "tool", []);
  const avgAlpha = (fromAlpha + toAlpha) / 2;

  // Dynamic threshold: 2-5 based on alpha
  return 2 + Math.ceil((avgAlpha - 0.5) * 6);
}
```

### Modification de GraphRAGEngine

```typescript
// src/graphrag/graph-engine.ts

private async createOrUpdateEdge(
  fromId: string,
  toId: string,
  edgeType: "contains" | "sequence" | "dependency",
): Promise<"created" | "updated" | "none"> {
  // NEW: Dynamic observation threshold
  const observationThreshold = this.localAlphaCalculator
    ? this.getAdaptiveObservationThreshold(fromId, toId)
    : GraphRAGEngine.OBSERVED_THRESHOLD; // Fallback to static

  if (this.graph.hasEdge(fromId, toId)) {
    const edge = this.graph.getEdgeAttributes(fromId, toId);
    const newCount = (edge.count as number) + 1;

    // Use dynamic threshold instead of static
    let newSource = edge.edge_source as string || "inferred";
    if (newCount >= observationThreshold && newSource === "inferred") {
      newSource = "observed";
    }
    // ...
  }
}
```

---

## Niveau 2: Per-Tool Thompson Sampling Threshold

### Problème Actuel

```typescript
// Actuellement: threshold GLOBAL avec EMA
if (falsePositiveRate > 0.2) {
  threshold += this.config.learningRate; // +0.05 pour TOUS les tools
}
```

### Solution: Distribution Beta par Tool

Chaque tool maintient une distribution Beta(α, β) de succès:

- **α** = nombre de succès + 1 (prior)
- **β** = nombre d'échecs + 1 (prior)

```typescript
/**
 * Per-tool threshold using Thompson Sampling
 *
 * References:
 * - https://en.wikipedia.org/wiki/Thompson_sampling
 * - https://arxiv.org/abs/2312.14037 (Neural Contextual Bandits)
 */
interface ToolThompsonState {
  toolId: string;
  alpha: number; // Successes + 1
  beta: number; // Failures + 1
  lastUpdated: Date;
}

class ThompsonThresholdManager {
  private toolStates: Map<string, ToolThompsonState> = new Map();

  // Prior: Beta(1, 1) = uniform distribution
  private readonly PRIOR_ALPHA = 1;
  private readonly PRIOR_BETA = 1;

  /**
   * Get execution threshold for a tool using Thompson Sampling
   *
   * @param toolId - Tool identifier
   * @param localAlpha - Local alpha from ADR-048 (0.5-1.0)
   * @param riskCategory - Tool risk level
   * @returns Threshold in [0.4, 0.9]
   */
  getThreshold(
    toolId: string,
    localAlpha: number,
    riskCategory: "safe" | "moderate" | "dangerous",
  ): number {
    const state = this.getOrCreateState(toolId);

    // Sample from Beta distribution
    const successRate = this.sampleBeta(state.alpha, state.beta);

    // Base threshold by risk category
    const riskThresholds = {
      safe: 0.55, // read_file, list_dir
      moderate: 0.70, // write_file, git_commit
      dangerous: 0.85, // delete_file, rm -rf
    };
    const baseThreshold = riskThresholds[riskCategory];

    // Adjust based on sampled success rate
    // High success rate → lower threshold (more confident)
    // Low success rate → higher threshold (need more caution)
    const successAdjustment = (0.75 - successRate) * 0.15; // ±0.075

    // Adjust based on local alpha
    // High alpha → graph unreliable → higher threshold
    // Low alpha → graph reliable → lower threshold
    const alphaAdjustment = (localAlpha - 0.75) * 0.10; // ±0.025

    const finalThreshold = Math.max(
      0.40,
      Math.min(0.90, baseThreshold + successAdjustment + alphaAdjustment),
    );

    return finalThreshold;
  }

  /**
   * Update tool state after execution
   */
  recordOutcome(toolId: string, success: boolean): void {
    const state = this.getOrCreateState(toolId);

    if (success) {
      state.alpha += 1;
    } else {
      state.beta += 1;
    }
    state.lastUpdated = new Date();

    // Decay old observations (non-stationary)
    this.applyDecay(state);

    this.toolStates.set(toolId, state);
  }

  /**
   * Sample from Beta distribution (Thompson Sampling core)
   */
  private sampleBeta(alpha: number, beta: number): number {
    // Use approximation: mean with noise based on variance
    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
    const stdDev = Math.sqrt(variance);

    // Sample from normal approximation (good enough for alpha+beta > 10)
    const sample = mean + this.gaussianRandom() * stdDev;
    return Math.max(0, Math.min(1, sample));
  }

  /**
   * Apply decay to handle non-stationary environments
   * (tool behavior may change over time)
   */
  private applyDecay(state: ToolThompsonState): void {
    const DECAY_FACTOR = 0.99; // 1% decay per observation

    // Keep prior contribution
    state.alpha = Math.max(this.PRIOR_ALPHA, state.alpha * DECAY_FACTOR);
    state.beta = Math.max(this.PRIOR_BETA, state.beta * DECAY_FACTOR);
  }

  private gaussianRandom(): number {
    // Box-Muller transform
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  private getOrCreateState(toolId: string): ToolThompsonState {
    if (!this.toolStates.has(toolId)) {
      this.toolStates.set(toolId, {
        toolId,
        alpha: this.PRIOR_ALPHA,
        beta: this.PRIOR_BETA,
        lastUpdated: new Date(),
      });
    }
    return this.toolStates.get(toolId)!;
  }
}
```

### Visualisation Thompson Sampling

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   THOMPSON SAMPLING PER TOOL                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  read_file: Beta(45, 5)                                                 │
│  ├── Mean: 90% success                                                  │
│  ├── Sampled: 0.88                                                      │
│  ├── Base threshold (safe): 0.55                                        │
│  ├── Success adjustment: -0.02                                          │
│  ├── Alpha adjustment: 0.00                                             │
│  └── Final threshold: 0.53  ✓ Speculate often                           │
│                                                                          │
│  delete_file: Beta(3, 7)                                                │
│  ├── Mean: 30% success                                                  │
│  ├── Sampled: 0.35                                                      │
│  ├── Base threshold (dangerous): 0.85                                   │
│  ├── Success adjustment: +0.06                                          │
│  ├── Alpha adjustment: +0.02                                            │
│  └── Final threshold: 0.90  ✗ Always ask human                          │
│                                                                          │
│  new_tool_xyz: Beta(1, 1)  [Cold Start]                                 │
│  ├── Mean: 50% (unknown)                                                │
│  ├── Sampled: 0.60 (high variance)                                      │
│  ├── Base threshold (moderate): 0.70                                    │
│  ├── Success adjustment: +0.02                                          │
│  ├── Alpha adjustment: +0.03 (cold start alpha=1.0)                     │
│  └── Final threshold: 0.75  △ Explore cautiously                        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Niveau 3: Episodic Memory-Enhanced Boost

### Problème Actuel

La mémoire épisodique stocke des événements mais ne les utilise que pour calculer un taux de succès
global.

### Solution: Similar Situation Retrieval

```typescript
/**
 * Enhanced episodic boost using similar situations
 *
 * Queries episodic memory for situations similar to current context,
 * then adjusts confidence based on historical outcomes.
 */
class EpisodicBoostCalculator {
  constructor(
    private episodicMemory: EpisodicMemoryStore,
    private db: PGliteClient,
  ) {}

  /**
   * Calculate episodic boost for a prediction
   *
   * @param toolId - Tool being considered
   * @param context - Current workflow context
   * @param localAlpha - Local alpha from ADR-048
   * @returns Boost value in [-0.10, +0.15]
   */
  async calculateBoost(
    toolId: string,
    context: ThresholdContext,
    localAlpha: number,
  ): Promise<{
    boost: number;
    confidence: number;
    matchedSituations: number;
    reasoning: string;
  }> {
    // 1. Query similar situations from algorithm_traces
    const similarTraces = await this.findSimilarTraces(toolId, context, localAlpha);

    if (similarTraces.length < 3) {
      return {
        boost: 0,
        confidence: 0,
        matchedSituations: 0,
        reasoning: "Insufficient historical data",
      };
    }

    // 2. Calculate success rate in similar situations
    const successCount =
      similarTraces.filter((t) => t.decision === "accepted" && t.final_score > 0.7).length;
    const successRate = successCount / similarTraces.length;

    // 3. Calculate confidence based on sample size
    const sampleConfidence = Math.min(1.0, similarTraces.length / 20);

    // 4. Calculate boost
    // Success rate > 70% → positive boost
    // Success rate < 50% → negative boost
    let boost = 0;
    if (successRate > 0.70) {
      boost = (successRate - 0.70) * 0.5 * sampleConfidence; // Max +0.15
    } else if (successRate < 0.50) {
      boost = (successRate - 0.50) * 0.4 * sampleConfidence; // Max -0.10
    }

    return {
      boost,
      confidence: sampleConfidence,
      matchedSituations: similarTraces.length,
      reasoning: `Found ${similarTraces.length} similar situations with ${
        (successRate * 100).toFixed(0)
      }% success rate`,
    };
  }

  /**
   * Find similar historical traces using multiple dimensions
   */
  private async findSimilarTraces(
    toolId: string,
    context: ThresholdContext,
    localAlpha: number,
  ): Promise<AlgorithmTrace[]> {
    // Multi-dimensional similarity search
    const result = await this.db.query(
      `
      SELECT *
      FROM algorithm_traces
      WHERE
        -- Same tool or similar tools in same community
        (
          (signals->>'targetToolId')::text = $1
          OR (signals->>'community')::text = (
            SELECT (signals->>'community')::text
            FROM algorithm_traces
            WHERE (signals->>'targetToolId')::text = $1
            LIMIT 1
          )
        )
        -- Similar alpha (within 0.1)
        AND ABS((params->>'alpha')::float - $2) < 0.1
        -- Same workflow type if specified
        AND ($3 IS NULL OR (signals->>'workflowType')::text = $3)
        -- Recent (last 30 days)
        AND timestamp > NOW() - INTERVAL '30 days'
      ORDER BY
        -- Prioritize exact tool matches
        CASE WHEN (signals->>'targetToolId')::text = $1 THEN 0 ELSE 1 END,
        -- Then by alpha similarity
        ABS((params->>'alpha')::float - $2),
        -- Then by recency
        timestamp DESC
      LIMIT 50
    `,
      [toolId, localAlpha, context.workflowType || null],
    );

    return result;
  }
}
```

---

## Integration: Combined Threshold Calculation

```typescript
/**
 * Intelligent Adaptive Threshold Manager
 *
 * Combines all three levels:
 * 1. Per-tool Thompson Sampling
 * 2. Local Alpha adjustment
 * 3. Episodic memory boost
 */
class IntelligentThresholdManager {
  constructor(
    private thompsonManager: ThompsonThresholdManager,
    private localAlphaCalculator: LocalAlphaCalculator,
    private episodicBoost: EpisodicBoostCalculator,
    private toolRiskRegistry: ToolRiskRegistry,
  ) {}

  /**
   * Get intelligent threshold for tool execution
   */
  async getThreshold(
    toolId: string,
    contextTools: string[],
    workflowContext: ThresholdContext,
  ): Promise<{
    threshold: number;
    breakdown: ThresholdBreakdown;
  }> {
    // 1. Get local alpha for this tool
    const alphaResult = this.localAlphaCalculator.getLocalAlphaWithBreakdown(
      "passive",
      toolId,
      "tool",
      contextTools,
    );

    // 2. Get tool risk category
    const riskCategory = this.toolRiskRegistry.getRiskCategory(toolId);

    // 3. Get Thompson-based threshold
    const thompsonThreshold = this.thompsonManager.getThreshold(
      toolId,
      alphaResult.alpha,
      riskCategory,
    );

    // 4. Get episodic boost
    const episodicResult = await this.episodicBoost.calculateBoost(
      toolId,
      workflowContext,
      alphaResult.alpha,
    );

    // 5. Combine: threshold - boost (boost lowers threshold if positive)
    const finalThreshold = Math.max(0.40, Math.min(0.90, thompsonThreshold - episodicResult.boost));

    return {
      threshold: finalThreshold,
      breakdown: {
        baseThreshold: this.getRiskBaseThreshold(riskCategory),
        thompsonAdjustment: thompsonThreshold - this.getRiskBaseThreshold(riskCategory),
        localAlpha: alphaResult.alpha,
        alphaAlgorithm: alphaResult.algorithm,
        coldStart: alphaResult.coldStart,
        episodicBoost: episodicResult.boost,
        episodicConfidence: episodicResult.confidence,
        episodicMatches: episodicResult.matchedSituations,
        finalThreshold,
      },
    };
  }

  /**
   * Record execution outcome for learning
   */
  async recordOutcome(
    toolId: string,
    success: boolean,
    confidence: number,
    context: ThresholdContext,
  ): Promise<void> {
    // Update Thompson state
    this.thompsonManager.recordOutcome(toolId, success);

    // The episodic memory is already captured via algorithm_traces
    // (fire-and-forget in DAGSuggester)
  }

  private getRiskBaseThreshold(risk: "safe" | "moderate" | "dangerous"): number {
    const thresholds = { safe: 0.55, moderate: 0.70, dangerous: 0.85 };
    return thresholds[risk];
  }
}
```

---

## Tool Risk Registry

Uses `config/mcp-permissions.yaml` (ADR-035) as the source of truth for server capabilities,
combined with tool name pattern matching.

```typescript
import { parse } from "yaml";
import { readFileSync } from "fs";

/**
 * Registry of tool risk categories using mcp-permissions.yaml (ADR-035)
 *
 * Risk determines base threshold:
 * - safe: Low impact, reversible (read_file, list_dir)
 * - moderate: Medium impact (write_file, git_commit)
 * - dangerous: High impact, irreversible (delete_file, rm, DROP TABLE)
 *
 * Classification flow:
 * 1. Server isReadOnly? → safe
 * 2. Tool name has irreversible pattern? → dangerous
 * 3. Tool name has write pattern? → moderate
 * 4. Fallback based on permissionSet
 */

interface McpServerConfig {
  permissionSet: "minimal" | "readonly" | "filesystem" | "network-api" | "mcp-standard" | "trusted";
  isReadOnly: boolean;
  toolOverrides?: Record<string, "safe" | "moderate" | "dangerous">;
}

type McpPermissions = Record<string, McpServerConfig>;

// Cached config
let mcpPermissionsCache: McpPermissions | null = null;

function loadMcpPermissions(): McpPermissions {
  if (mcpPermissionsCache) return mcpPermissionsCache;

  const configPath = "config/mcp-permissions.yaml";
  const content = readFileSync(configPath, "utf-8");
  mcpPermissionsCache = parse(content) as McpPermissions;
  return mcpPermissionsCache;
}

const IRREVERSIBLE_PATTERNS = [
  "delete",
  "remove",
  "drop",
  "truncate",
  "reset_hard",
  "force_push",
  "format",
  "destroy",
  "wipe",
];

const WRITE_PATTERNS = [
  "write",
  "create",
  "update",
  "insert",
  "push",
  "commit",
  "set",
];

const READ_PATTERNS = [
  "read",
  "get",
  "list",
  "search",
  "fetch",
  "query",
  "find",
];

function classifyToolRisk(
  server: string,
  toolName: string,
): "safe" | "moderate" | "dangerous" {
  const permissions = loadMcpPermissions();
  const serverConfig = permissions[server];
  const lowerToolName = toolName.toLowerCase();

  // 1. Check for explicit tool override
  if (serverConfig?.toolOverrides?.[toolName]) {
    return serverConfig.toolOverrides[toolName];
  }

  // 2. Server explicitly readonly → always safe
  if (serverConfig?.isReadOnly) {
    return "safe";
  }

  // 3. Irreversible action pattern → dangerous
  if (IRREVERSIBLE_PATTERNS.some((p) => lowerToolName.includes(p))) {
    return "dangerous";
  }

  // 4. Read action pattern → safe (even on write-capable servers)
  if (READ_PATTERNS.some((p) => lowerToolName.includes(p))) {
    return "safe";
  }

  // 5. Write action pattern → moderate
  if (WRITE_PATTERNS.some((p) => lowerToolName.includes(p))) {
    return "moderate";
  }

  // 6. Fallback based on permissionSet
  switch (serverConfig?.permissionSet) {
    case "minimal":
      return "safe";
    case "readonly":
      return "safe";
    case "trusted":
      return "dangerous"; // Manual verification only
    default:
      return "moderate"; // Conservative default
  }
}

// Convenience function for full tool ID (server:tool format)
function classifyToolRiskById(toolId: string): "safe" | "moderate" | "dangerous" {
  const [server, ...toolParts] = toolId.split(":");
  const toolName = toolParts.join(":") || server; // Handle tools without server prefix
  return classifyToolRisk(server, toolName);
}
```

### Risk Thresholds

```typescript
const RISK_BASE_THRESHOLDS = {
  safe: 0.55, // read_file, list_dir, query
  moderate: 0.70, // write_file, git_commit, create_pr
  dangerous: 0.85, // delete_file, drop_table, force_push
};
```

---

## Extension: Capability Thresholds (Hypergraph Integration)

Le système de thresholds s'étend aux **Capabilities** en utilisant les relations Cap→Cap (ADR-042).

### Capability vs Tool Thresholds

| Aspect             | Tools                       | Capabilities                                         |
| ------------------ | --------------------------- | ---------------------------------------------------- |
| **Thompson State** | Per-tool `Beta(α,β)`        | Per-capability `Beta(α,β)`                           |
| **Risk Category**  | Pattern matching sur nom    | **Transitive Reliability** (ADR-042) + max tool risk |
| **Local Alpha**    | Heat Diffusion              | Heat Diffusion Hiérarchique + Cap→Cap edges          |
| **Episodic Boost** | `algorithm_traces` par tool | `algorithm_traces` par capability                    |

### Capability Risk Calculation

```typescript
/**
 * Risk category for Capabilities using hypergraph structure (ADR-042)
 *
 * Risk is determined by:
 * 1. Transitive reliability through dependency chain
 * 2. Maximum risk of contained tools
 */
async function getCapabilityRiskCategory(
  capId: string,
  capabilityStore: CapabilityStore,
  toolRiskRegistry: ToolRiskRegistry,
): Promise<"safe" | "moderate" | "dangerous"> {
  // 1. Transitive reliability from ADR-042 §3
  const transitiveReliability = await computeTransitiveReliability(capId);

  // 2. Aggregate risk from contained tools
  const tools = await capabilityStore.getTools(capId);
  const toolRisks = tools.map((t) => toolRiskRegistry.getRiskCategory(t.id));
  const maxToolRisk = toolRisks.reduce(
    (max, r) => RISK_LEVELS[r] > RISK_LEVELS[max] ? r : max,
    "safe" as const,
  );

  // Decision matrix
  if (maxToolRisk === "dangerous" || transitiveReliability < 0.5) {
    return "dangerous"; // Contains dangerous tool OR unreliable chain
  }
  if (maxToolRisk === "moderate" || transitiveReliability < 0.8) {
    return "moderate";
  }
  return "safe";
}

const RISK_LEVELS = { safe: 0, moderate: 1, dangerous: 2 };
```

### Capability Alpha (Heat Diffusion with Cap→Cap)

ADR-048's Heat Diffusion Hiérarchique is enhanced for Capabilities:

```typescript
// computeHierarchyPropagation() enhanced for Cap→Cap edges
case 'capability':
  // 1. Standard: meta-capability parent heat
  const metaParent = getParent(nodeId, 'meta');
  const metaHeat = metaParent
    ? computeHierarchicalHeat(metaParent, 'meta') * 0.7
    : 0;

  // 2. NEW: Dependency edges heat (ADR-042)
  const deps = await capabilityStore.getDependencies(nodeId, 'to');
  const depHeat = deps
    .filter(d => d.edgeType === 'dependency' || d.edgeType === 'contains')
    .reduce((sum, d) =>
      sum + computeHierarchicalHeat(d.fromCapabilityId, 'capability') * d.confidenceScore,
      0
    ) / Math.max(1, deps.length);

  // Combine: hierarchy (40%) + dependencies (30%) + intrinsic (30%)
  return 0.4 * metaHeat + 0.3 * depHeat + 0.3 * intrinsicHeat;
```

**Impact:** Capabilities with many dependency edges receive more structural confidence → lower alpha
→ graph is more trusted for decisions.

---

## Database Schema Changes

### New Table: tool_thompson_states

```sql
-- Migration: 016_tool_thompson_states.sql

CREATE TABLE tool_thompson_states (
  tool_id TEXT PRIMARY KEY,
  alpha REAL NOT NULL DEFAULT 1.0,      -- Successes + prior
  beta REAL NOT NULL DEFAULT 1.0,       -- Failures + prior
  total_executions INTEGER DEFAULT 0,
  last_success TIMESTAMPTZ,
  last_failure TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_alpha CHECK (alpha >= 1.0),
  CONSTRAINT valid_beta CHECK (beta >= 1.0)
);

CREATE INDEX idx_thompson_updated ON tool_thompson_states(updated_at DESC);

-- Tool risk overrides (for explicit categorization)
CREATE TABLE tool_risk_overrides (
  tool_id TEXT PRIMARY KEY,
  risk_category TEXT NOT NULL CHECK (risk_category IN ('safe', 'moderate', 'dangerous')),
  reason TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Implementation Plan

### Phase 1: Per-Tool Thompson Sampling (Priority: High)

| Task                                      | Effort   | Files                                  |
| ----------------------------------------- | -------- | -------------------------------------- |
| Create `ThompsonThresholdManager` class   | 3h       | `src/learning/thompson-threshold.ts`   |
| Add migration for `tool_thompson_states`  | 0.5h     | `src/db/migrations/016_*.ts`           |
| Integrate into `AdaptiveThresholdManager` | 2h       | `src/mcp/adaptive-threshold.ts`        |
| Unit tests for Thompson sampling          | 2h       | `tests/unit/learning/thompson_test.ts` |
| **Total Phase 1**                         | **7.5h** |                                        |

### Phase 2: Local Alpha Integration (Priority: High)

| Task                                        | Effort   | Files                                 |
| ------------------------------------------- | -------- | ------------------------------------- |
| Connect `LocalAlphaCalculator` to threshold | 1h       | `src/mcp/adaptive-threshold.ts`       |
| Add `ToolRiskRegistry`                      | 1h       | `src/learning/tool-risk.ts`           |
| Update threshold calculation formula        | 1h       | `src/mcp/adaptive-threshold.ts`       |
| Integration tests                           | 1.5h     | `tests/integration/threshold_test.ts` |
| **Total Phase 2**                           | **4.5h** |                                       |

### Phase 3: Episodic Memory Enhancement (Priority: Medium)

| Task                                       | Effort   | Files                                        |
| ------------------------------------------ | -------- | -------------------------------------------- |
| Create `EpisodicBoostCalculator`           | 2h       | `src/learning/episodic-boost.ts`             |
| Add similarity query to `algorithm_traces` | 1h       | `src/graphrag/algorithm-tracer.ts`           |
| Integrate boost into threshold             | 1h       | `src/mcp/adaptive-threshold.ts`              |
| Tests for episodic boost                   | 1.5h     | `tests/unit/learning/episodic_boost_test.ts` |
| **Total Phase 3**                          | **5.5h** |                                              |

### Phase 4: Adaptive Edge Threshold (Priority: Low)

| Task                                    | Effort   | Files                                        |
| --------------------------------------- | -------- | -------------------------------------------- |
| Add `getAdaptiveObservationThreshold()` | 1h       | `src/graphrag/graph-engine.ts`               |
| Modify `createOrUpdateEdge()`           | 0.5h     | `src/graphrag/graph-engine.ts`               |
| Tests for dynamic edge threshold        | 1h       | `tests/unit/graphrag/edge_threshold_test.ts` |
| **Total Phase 4**                       | **2.5h** |                                              |

### Total Estimated Effort

```
Phase 1 (Thompson):    7.5h
Phase 2 (Alpha):       4.5h
Phase 3 (Episodic):    5.5h
Phase 4 (Edges):       2.5h
─────────────────────────────
Total:                20.0h (~3 days)
```

---

## Consequences

### Positives

- ✅ **Per-tool learning**: Each tool converges to its optimal threshold
- ✅ **Local Alpha integrated**: Graph reliability affects threshold
- ✅ **Risk-aware**: Dangerous operations require higher confidence
- ✅ **Cold start handled**: Thompson prior + Bayesian alpha
- ✅ **Episodic boost**: Similar past situations inform decisions
- ✅ **Non-stationary**: Decay factor adapts to changing tool behavior
- ✅ **Observable**: Full breakdown of threshold calculation

### Negatives

- ⚠️ **Complexity increase**: 3 layers vs 1 (EMA only)
- ⚠️ **More state to persist**: Per-tool Thompson states
- ⚠️ **Tuning required**: Risk categories, decay factor, boost weights

### Risks

| Risk                   | Probability | Impact | Mitigation             |
| ---------------------- | ----------- | ------ | ---------------------- |
| Thompson divergence    | Low         | Medium | Decay factor, bounds   |
| Episodic query slow    | Medium      | Low    | Index, limit, cache    |
| Risk misclassification | Medium      | High   | Override table, review |

---

## Success Metrics

### Must-Have

- ✅ Per-tool thresholds converge within 20 executions
- ✅ Dangerous tools always have threshold ≥ 0.80
- ✅ Safe tools can have threshold as low as 0.45
- ✅ Cold start tools start at 0.75 (moderate)

### Performance Targets

| Metric                        | Current | Target        |
| ----------------------------- | ------- | ------------- |
| Speculation success rate      | 70%     | 85%           |
| False positive rate           | 20%     | 10%           |
| Convergence time (per tool)   | N/A     | 20 executions |
| Threshold calculation latency | N/A     | <5ms          |

### Learning Quality

| Metric                                | Target |
| ------------------------------------- | ------ |
| Thompson variance after 50 executions | <0.05  |
| Episodic boost hit rate               | >40%   |
| Risk classification accuracy          | >95%   |

---

## References

### Academic / Industry

- [Thompson Sampling](https://en.wikipedia.org/wiki/Thompson_sampling) - Wikipedia
- [UCB Algorithm](https://www.geeksforgeeks.org/machine-learning/upper-confidence-bound-algorithm-in-reinforcement-learning/) -
  GeeksforGeeks
- [Neural Contextual Bandits](https://arxiv.org/abs/2312.14037) - arXiv 2023
- [Contextual Bandits for Personalization](https://arxiv.org/abs/2003.00359) - arXiv 2020
- [Adaptive Edge Weighting](https://link.springer.com/article/10.1007/s10994-016-5607-3) - Machine
  Learning Journal
- [HU-GNN: Hierarchical Uncertainty-Aware GNN](https://arxiv.org/html/2504.19820v2) - arXiv 2025

### Internal ADRs

- ADR-008: Episodic Memory & Adaptive Thresholds
- ADR-035: Permission Sets & Sandbox Security (mcp-permissions.yaml)
- ADR-041: Hierarchical Trace Tracking
- ADR-048: Local Adaptive Alpha

---

## Appendix: Mathematical Formulas

### Thompson Sampling Posterior

Given:

- α = successes + 1 (prior)
- β = failures + 1 (prior)

Success rate estimate:

```
E[θ] = α / (α + β)
Var[θ] = αβ / ((α + β)² (α + β + 1))
```

### Threshold Formula

```
threshold = base(risk) + thompson_adj + alpha_adj - episodic_boost

Where:
  base(risk) ∈ {0.55, 0.70, 0.85}
  thompson_adj = (0.75 - sampled_rate) × 0.15
  alpha_adj = (local_alpha - 0.75) × 0.10
  episodic_boost ∈ [-0.10, +0.15]
```

### Adaptive Edge Threshold

```
observation_threshold = 2 + ceil((avg_alpha - 0.5) × 6)

Where:
  avg_alpha = (alpha_from + alpha_to) / 2
  Result ∈ [2, 5]
```
