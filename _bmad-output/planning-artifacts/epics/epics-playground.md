# Casys MCP Gateway Playground - Epic Breakdown

**Auteur:** BMad **Date:** 2025-11-28 **Niveau Projet:** 2 **Échelle Cible:** Playground éducatif

---

## Overview

Ce document détaille les epics et stories pour le playground pédagogique Casys MCP Gateway, tel que
défini dans le [PRD-playground.md](./PRD-playground.md).

**Epic Sequencing Principles:**

- Epic 1 établit l'infrastructure (doit être complété avant Epic 2)
- Les stories dans chaque epic sont séquentielles et construisent sur les précédentes
- Chaque story est dimensionnée pour une session de 2-4h

---

## Epic 1: Infrastructure Playground

**Goal:** Configurer l'environnement Codespace prêt à l'emploi avec devcontainer, MCP servers,
workflow templates, et helpers.

**Value:** Un développeur peut lancer le Codespace et avoir un environnement fonctionnel en < 5
minutes.

---

### Story 1.1: Devcontainer Configuration

**Status:** ✅ **DONE**

**As a** developer, **I want** to open the repo in GitHub Codespaces, **So that** I have a fully
configured environment without manual setup.

**Acceptance Criteria:**

1. ✅ `.devcontainer/playground/devcontainer.json` configure Deno 2.1.4
2. ✅ Extension Jupyter (ms-toolsai.jupyter) pré-installée
3. ✅ Extension Deno (denoland.vscode-deno) pré-installée
4. ✅ Ports 3000 (MCP Gateway) et 8888 (Jupyter Lab) exposés
5. ✅ Post-create script installe les dépendances (`post-create.sh`)
6. ✅ Dockerfile avec Deno + Jupyter + Python

**Prerequisites:** None

**Files:** `.devcontainer/playground/devcontainer.json`, `Dockerfile`, `post-create.sh`

---

### Story 1.2: MCP Servers Configuration

**As a** playground user, **I want** MCP servers pre-configured, **So that** I can run demos without
manual server setup.

**Acceptance Criteria:**

1. `playground/config/mcp-servers.json` contient 3 servers Tier 1:
   - `@modelcontextprotocol/server-filesystem`
   - `@modelcontextprotocol/server-memory`
   - `@modelcontextprotocol/server-sequential-thinking`
2. Paths configurés pour le workspace Codespace
3. Documentation inline expliquant chaque server

**Prerequisites:** Story 1.1

---

### Story 1.3: Workflow Templates Configuration

**As a** playground user, **I want** workflow templates pre-configured, **So that** I can see
GraphRAG patterns in action immediately.

**Acceptance Criteria:**

1. `playground/config/workflow-templates.yaml` contient 3+ workflows:
   - Parallélisation pure (3 outils indépendants)
   - Pattern récurrent (séquence filesystem → memory)
   - DAG multi-niveaux (dépendances entre niveaux)
2. Format compatible avec `pml workflows sync`
3. Commentaires expliquant chaque workflow

**Prerequisites:** Story 1.2

---

### Story 1.4: LLM API Key Setup Script

**Status:** ⚠️ **PARTIAL**

**As a** playground user, **I want** a simple way to configure my LLM API key, **So that** I don't
have to figure out the configuration myself.

**Ce qui existe:**

- ✅ `playground/.env.example` avec template des clés API
- ✅ `playground/lib/llm-provider.ts` avec auto-détection du provider (500+ lignes)
- ✅ Support OpenAI, Anthropic, Google via Vercel AI SDK

**Ce qui manque:**

- ❌ Script interactif `setup-api-key.ts` pour guider l'utilisateur

**Acceptance Criteria:**

1. ⚠️ `playground/scripts/setup-api-key.ts` script interactif (optionnel - .env.example suffit)
2. ✅ Détecte automatiquement le provider depuis le format de clé (`lib/llm-provider.ts`)
3. ⚠️ Crée/met à jour `.env` avec la bonne variable
4. ✅ Auto-détection provider dans `detectProvider()`
5. ✅ Gère les erreurs (clé invalide, format inconnu)

**Prerequisites:** Story 1.1

**Files existants:** `playground/.env.example`, `playground/lib/llm-provider.ts`

---

### Story 1.5: Idempotent Init Helper

**As a** notebook author, **I want** a helper that ensures the playground is ready, **So that** each
notebook can be run independently.

**Acceptance Criteria:**

1. `playground/lib/init.ts` exporte `ensurePlaygroundReady(options?)`
2. Vérifie si déjà initialisé (PGlite DB, embeddings)
3. Si non initialisé → run full init (MCP connect, workflows sync)
4. Si déjà initialisé → skip (< 100ms)
5. Option `verbose: true` pour afficher le détail (utilisé dans notebook 00)
6. Retourne status `{ initialized: boolean, mcpServers: string[], workflowsLoaded: number }`

**Prerequisites:** Stories 1.2, 1.3, 1.4

---

### Story 1.6: Mermaid Rendering Helper

**Status:** ✅ **DONE**

**As a** notebook author, **I want** to render Mermaid diagrams in notebooks, **So that** I can
visualize DAGs and architectures.

**Acceptance Criteria:**

1. ✅ `playground/lib/viz.ts` exporte `displayMermaid(diagram: string)`
2. ✅ Rendu via Kroki API (encodage pako + base64url)
3. ✅ Support Deno.jupyter pour output SVG natif
4. ✅ Fonctions spécialisées : `displayDag()`, `displayLayers()`, `displayGraphrag()`,
   `displayTimeline()`, `displayEvolution()`, `displayWorkflowEdges()`
5. ✅ Générateurs Mermaid : `dagToMermaid()`, `layersToMermaid()`, `graphragToMermaid()`,
   `executionTimelineToMermaid()`, `workflowEdgesToMermaid()`

**Prerequisites:** Story 1.1

**Files:** `playground/lib/viz.ts` (539 lignes)

---

### Story 1.7: Metrics Visualization Helper

**As a** notebook author, **I want** to display metrics visually, **So that** users can see
performance gains clearly.

**Acceptance Criteria:**

1. `playground/lib/metrics.ts` exporte helpers:
   - `progressBar(current, total, label)` - ASCII progress bar
   - `compareMetrics(before, after, labels)` - Side-by-side comparison
   - `speedupChart(sequential, parallel)` - Visualize speedup
2. Output compatible Jupyter (texte formaté)
3. Couleurs ANSI optionnelles (détection terminal)

**Prerequisites:** Story 1.1

---

### Story 1.8: Playground README

**Status:** ⚠️ **PARTIAL** (à mettre à jour)

**As a** potential user, **I want** a clear README explaining the playground, **So that** I
understand what it does and how to start.

**Ce qui existe:**

- ✅ `playground/README.md` avec Quick Start et badge Codespaces
- ✅ Badge "Open in GitHub Codespaces" fonctionnel
- ✅ Liste des outils MCP disponibles
- ✅ Requirements et Environment Variables

**Ce qui manque:**

- ❌ Table des notebooks mise à jour (actuellement anciens notebooks 01-08)
- ❌ Section "What is this?" expliquant le problème MCP
- ❌ Nouvelle séquence 00-06

**Acceptance Criteria:**

1. ⚠️ `playground/README.md` avec sections:
   - ❌ What is this? (1 paragraphe sur le problème MCP)
   - ✅ Quick Start (Open in Codespace badge + 3 étapes)
   - ❌ Notebook Overview (table des 7 notebooks 00-06)
   - ❌ Troubleshooting (FAQ communes)
2. ✅ Badge "Open in GitHub Codespaces" fonctionnel
3. ⚠️ Screenshots/GIFs optionnels

**Prerequisites:** Stories 1.1-1.7

**Files existants:** `playground/README.md`

---

## Epic 2: Notebooks Pédagogiques

**Goal:** Créer la séquence de notebooks propre (00-06) avec progression claire et checkpoints.

**Value:** Un développeur comprend le paradigme Casys PML (exécution de code → capability learning →
réutilisation) en ~2h de travail interactif.

---

### Story 2.1: Notebook 00 - Introduction

**As a** new user, **I want** an introduction notebook, **So that** I understand what I'm about to
learn and verify my environment.

**Acceptance Criteria:**

1. Learning Objectives (5 bullet points)
2. Architecture Overview (diagramme Mermaid)
3. Environment Check (exécute `ensurePlaygroundReady({ verbose: true })`)
4. Notebook Roadmap (table des 6 notebooks suivants)
5. Quick Start cell (vérifie Deno, imports, API key)

**Prerequisites:** Epic 1 complete

---

### Story 2.2: Notebook 01 - The Problem

**As a** user, **I want** to see the MCP problems demonstrated, **So that** I understand why the
gateway exists.

**Acceptance Criteria:**

1. Context Explosion Demo:
   - Simule 8 MCP servers avec token counts réalistes
   - Affiche "45.4% consumed before you start"
   - Calcule le gaspillage (tokens chargés vs utilisés)
2. Latency Demo:
   - Workflow 5 étapes séquentiel vs parallèle
   - Mesure temps réel (pas simulé)
   - Affiche speedup (ex: "1.4x faster")
3. Checkpoint: Quiz 3 questions sur les problèmes identifiés

**Prerequisites:** Story 2.1

---

### Story 2.3: Notebook 02 - Context Optimization

**As a** user, **I want** to see how vector search reduces context, **So that** I understand the
first solution mechanism.

**Acceptance Criteria:**

1. Explication: Comment fonctionne l'embedding et la recherche vectorielle
2. Demo Live:
   - Charge les 3 MCP servers (filesystem, memory, sequential-thinking)
   - Montre tous les outils disponibles (~25 outils)
   - Query "read a file" → retourne top 3 outils pertinents
   - Affiche réduction: "25 tools → 3 tools = 88% reduction"
3. Métriques: Tokens avant/après avec `compareMetrics()`
4. Checkpoint: Exercice "trouver les bons outils pour X"

**Prerequisites:** Story 2.2

---

### Story 2.4: Notebook 03 - DAG Execution

**As a** user, **I want** to see DAG parallelization in action, **So that** I understand how
workflows are optimized.

**Acceptance Criteria:**

1. Explication: DAG, dépendances, niveaux d'exécution
2. Demo Live:
   - Workflow avec branches parallèles (filesystem + memory + time simulé)
   - Visualisation DAG avec Mermaid
   - Exécution séquentielle (mesure temps)
   - Exécution parallèle (mesure temps)
   - Affiche speedup avec `speedupChart()`
3. Interactive: User peut modifier le workflow et re-exécuter
4. Checkpoint: Dessiner le DAG d'un workflow donné

**Prerequisites:** Story 2.3

---

### Story 2.5: Notebook 04 - Code Execution & Worker RPC

**As a** user, **I want** to see how code executes with MCP tool access, **So that** I understand
how the Worker RPC Bridge enables safe tool usage from sandbox.

**Acceptance Criteria:**

1. Explication: Worker RPC Bridge architecture (ADR-032)
2. Demo Live:
   - Exécute code TypeScript qui appelle des MCP tools via RPC
   - Montre le tracing natif (tool_start, tool_end events)
   - Tente une opération interdite → erreur claire
3. Use Case: Code qui lit un fichier via MCP et le traite
4. Checkpoint: Écrire du code appelant 2 MCP tools

**Prerequisites:** Story 2.4

---

### Story 2.6: Notebook 05 - Capability Learning

**As a** user, **I want** to see how capabilities emerge from code execution, **So that** I
understand the procedural memory system.

**Acceptance Criteria:**

1. **Explication Théorique:**
   - Les 3 types de mémoire humaine (sémantique, épisodique, **procédurale**)
   - Analogie: "Apprendre à faire du vélo" vs "savoir que Paris est la capitale"
   - Diagramme Mermaid: Code exécuté → Succès → Capability stockée

2. **Demo Live - Eager Learning:**
   - Exécute du code avec intent → capability créée immédiatement (1ère exécution)
   - Montre le storage: code_snippet, intent_embedding, usage_count, success_rate
   - Query via `search_capabilities` → retrouve la capability par intent similaire

3. **Demo Live - Reliability Tracking:**
   - Exécute une capability plusieurs fois (mix succès/échecs)
   - Montre l'évolution du success_rate
   - Explique: "Le système privilégie les capabilities fiables"

4. **Visualisation:** Table des capabilities avec stats (usage_count, success_rate, last_used)

5. **Checkpoint:** Quiz "Qu'est-ce qui différencie la mémoire procédurale des autres?"

**Prerequisites:** Story 2.5

**Alignement Paper:** Section 3.2 Capability Learning (Eager storage), Métriques Success Rate

---

### Story 2.7: Notebook 06 - Emergent Capability Reuse

**As a** user, **I want** to see how capabilities compose and adapt, **So that** I understand how
the system gets smarter over time.

**Acceptance Criteria:**

1. **Explication Théorique:**
   - Capability Matching: skip Claude regeneration, exécution directe
   - Modèle SECI (Nonaka & Takeuchi): Tools → Capabilities → **Méta-Capabilities**
   - Diagramme Mermaid: hiérarchie de composition récursive

2. **Demo Live - Capability Matching & Latency Savings:**
   - Match intent → retrieve cached capability
   - Exécute sans régénération Claude
   - Affiche métriques: "2.3s → 0.1s = 95% latency reduction"

3. **Demo Live - Composition Hiérarchique (SECI):**
   - Capability A qui contient Capability B
   - Visualise les relations "contains" / "dependency"
   - Exemple: `setup-environment` = `parse-config` + `validate-schema`

4. **Demo Live - Transitive Reliability:**
   - Chaîne A → B → C: si B = 80%, A hérite d'une pénalité
   - Formule: `reliability = min(own_rate, deps_rates)`
   - Graphe coloré par fiabilité (Mermaid)

5. **Demo Live - Adaptive Thresholds (simulation accélérée):**
   - Crée un AdaptiveThresholdManager avec windowSize=10 (mode démo)
   - Simule 15 exécutions avec ~30% échecs
   - Montre le threshold qui monte: 0.70 → 0.78
   - Explique: "En prod, ça prend ~50 exécutions, ici on accélère"

6. **Demo Live - Suggestion Engine:**
   - Suggestions proactives basées sur le contexte
   - Affiche le score de confiance de chaque suggestion

7. **Métriques Benchmark (alignées avec le paper):**
   - Reuse Rate: % d'exécutions réutilisant une capability (target >40%)
   - Latency Reduction: temps gagné vs vanilla (target >50%)
   - Success Rate: % d'exécutions réussies (target >85%)
   - Context Savings: tokens économisés (target >30%)

8. **Checkpoint:** Dessiner la hiérarchie de composition d'un workflow donné

9. **Next Steps:** Liens vers documentation, contribution, paper scientifique

**Prerequisites:** Story 2.6

**Alignement Paper:** Section 1.2 Combinaison récursive (SECI), Section 3.5 Transitive Reliability,
Section 4.3 Métriques benchmark, Adaptive Thresholds (EMA)

---

### Story 2.8: Cleanup Old Notebooks

**As a** maintainer, **I want** to clean up the old notebooks, **So that** the playground is
organized and not confusing.

**Acceptance Criteria:**

1. Archive les anciens notebooks dans `playground/notebooks/archive/`
2. Supprime les doublons (01-sandbox-basics vs 01-the-problem, etc.)
3. Renomme les fichiers si nécessaire pour la séquence 00-06
4. Met à jour les liens internes entre notebooks
5. Vérifie que tous les imports fonctionnent

**Prerequisites:** Stories 2.1-2.7

---

## Epic 3: Connexion au Vrai Système

**Goal:** Remplacer toutes les simulations des notebooks 04-06 par le vrai code du projet.

**Value:** Un développeur qui fait le playground teste vraiment le système PML, pas des mocks.
Crédibilité maximale pour le paper de recherche.

**Context:** Découvert lors de la rétrospective Epic 2 (2025-12-15) - les notebooks utilisent des
`SimulatedCapabilityStore`, `SimulatedWorkerBridge`, etc. au lieu du vrai code dans `src/`.

---

### Story 3.1: Helper Capabilities pour Notebooks

**As a** notebook author, **I want** a helper that exposes the real CapabilityStore, **So that**
notebooks can use the production code instead of simulations.

**Acceptance Criteria:**

1. `playground/lib/capabilities.ts` exporte:
   - `getCapabilityStore()` - retourne le vrai CapabilityStore connecté à PGlite
   - `getCapabilityMatcher()` - retourne le vrai CapabilityMatcher
   - `getAdaptiveThresholdManager()` - retourne le vrai AdaptiveThresholdManager
2. Initialisation lazy (créé au premier appel, réutilisé ensuite)
3. Utilise PGlite in-memory pour les notebooks (pas besoin de persistence)
4. Mock minimal pour embeddings si nécessaire (ou vrai modèle si disponible)
5. Fonction `resetPlaygroundState()` pour réinitialiser entre les démos

**Prerequisites:** Epic 1 complete

**Files:** `playground/lib/capabilities.ts`

---

### Story 3.2: WorkerBridge Helper pour Notebooks

**As a** notebook author, **I want** a helper that exposes the real WorkerBridge with MCP client
mocks, **So that** notebooks can execute code in the real sandbox with tool tracing.

**Acceptance Criteria:**

1. `playground/lib/capabilities.ts` exporte `getWorkerBridge(mcpClients?)`
2. Crée des mock MCP clients minimaux pour filesystem et memory
3. Le WorkerBridge utilise le vrai sandbox Deno Worker
4. Les traces sont de vraies TraceEvent du système
5. Helper `requireApiKey()` qui vérifie la présence d'une clé API (obligatoire pour Wow Moment)
6. Ajout au `resetPlaygroundState()` pour cleanup

**Prerequisites:** Story 3.1

**Files:** `playground/lib/capabilities.ts`

---

### Story 3.3: Refaire Notebook 04 avec Vrai WorkerBridge

**As a** user, **I want** notebook 04 to use the real Worker RPC Bridge, **So that** I see the
actual production code in action.

**Acceptance Criteria:**

1. Remplacer `SimulatedWorkerBridge` par import du helper 3.2
2. Utiliser les mock MCP clients du helper (pas besoin de vrais serveurs)
3. Les traces capturées sont de vraies traces du système
4. La démo de sécurité utilise le vrai sandbox Deno Worker
5. Tous les outputs restent pédagogiques et clairs

**Prerequisites:** Stories 3.1, 3.2

**Files:** `playground/notebooks/04-code-execution.ipynb`

---

### Story 3.4: Refaire Notebook 05 avec Vrai CapabilityStore

**As a** user, **I want** notebook 05 to use the real CapabilityStore, **So that** I see
capabilities vraiment persistées et recherchées.

**Acceptance Criteria:**

1. Remplacer `SimulatedCapabilityStore` par `getCapabilityStore()` du helper
2. Les capabilities sont vraiment stockées dans PGlite (vérifiable via query)
3. La recherche par intent utilise les vrais embeddings (ou mock réaliste)
4. Le tracking de reliability utilise le vrai mécanisme
5. Afficher les vraies stats de la DB (count, success_rate, etc.)
6. `resetPlaygroundState()` appelé en début de notebook pour état propre

**Prerequisites:** Story 3.1

**Files:** `playground/notebooks/05-capability-learning.ipynb`

---

### Story 3.5: Refaire Notebook 06 avec Vrai Matcher et Thresholds

**As a** user, **I want** notebook 06 to use the real Matcher and AdaptiveThresholdManager, **So
that** I see le vrai système de matching et d'adaptation.

**Acceptance Criteria:**

1. Remplacer `SimulatedCapabilityStore` par `getCapabilityStore()`
2. Remplacer `SimulatedCapabilityMatcher` par `getCapabilityMatcher()`
3. Remplacer `SimulatedAdaptiveThresholdManager` par `getAdaptiveThresholdManager()`
4. Remplacer `SimulatedDependency` par vraies dépendances via `CapabilityStore.addDependency()`
5. Le scoring utilise le vrai algorithme (semantic + reliability + transitive)
6. Les thresholds adaptatifs montrent le vrai EMA
7. Les métriques benchmark reflètent de vraies exécutions
8. Conserver le "Wow Moment" avec timing réel (API key requise)

**Prerequisites:** Stories 3.1, 3.2 (WorkerBridge pour Wow Moment), 3.4

**Files:** `playground/notebooks/06-emergent-reuse.ipynb`

---

### Story 3.6: Tests d'Intégration Notebooks

**As a** maintainer, **I want** integration tests for notebooks, **So that** we catch regressions
when the real system changes.

**Acceptance Criteria:**

1. Script `playground/scripts/test-notebooks.ts` qui exécute les notebooks 04-06
2. Vérifie que chaque notebook s'exécute sans erreur
3. Vérifie que les outputs attendus sont présents
4. Peut être lancé via `deno task test:notebooks`
5. Intégré dans CI (optionnel mais recommandé)
6. Gère le contexte partagé entre cellules (sans friction pour utilisateurs)

**Prerequisites:** Stories 3.3, 3.4, 3.5

**Files:** `playground/scripts/test-notebooks.ts`, `deno.json`

---

## Story Guidelines Reference

**Story Format:**

```
**Story [EPIC.N]: [Story Title]**

As a [user type],
I want [goal/desire],
So that [benefit/value].

**Acceptance Criteria:**
1. [Specific testable criterion]
2. [Another specific criterion]
3. [etc.]

**Prerequisites:** [Dependencies on previous stories, if any]
```

**Story Requirements:**

- **Vertical slices** - Complete, testable functionality delivery
- **Sequential ordering** - Logical progression within epic
- **No forward dependencies** - Only depend on previous work
- **AI-agent sized** - Completable in 2-4 hour focused session
- **Value-focused** - Integrate technical enablers into value-delivering stories

---

## Summary

| Epic                   | Stories        | Status                 |
| ---------------------- | -------------- | ---------------------- |
| Epic 1: Infrastructure | 8 stories      | ✅ **8/8 DONE**        |
| Epic 2: Notebooks      | 8 stories      | ✅ **8/8 DONE**        |
| Epic 3: Vrai Système   | 5 stories      | ⬜ **0/5 BACKLOG**     |
| **Total**              | **21 stories** | **16 done, 5 backlog** |

### Epic 1 Status Detail ✅ COMPLETE

| Story                  | Status  | Notes                                            |
| ---------------------- | ------- | ------------------------------------------------ |
| 1.1 Devcontainer       | ✅ done | Complet avec Dockerfile, post-create.sh          |
| 1.2 MCP Config         | ✅ done | `playground/config/mcp-servers.json` créé        |
| 1.3 Workflow Templates | ✅ done | `playground/config/workflow-templates.yaml` créé |
| 1.4 API Key Setup      | ✅ done | .env.example + llm-provider.ts complets          |
| 1.5 Init Helper        | ✅ done | `ensurePlaygroundReady()` implémenté             |
| 1.6 Mermaid Helper     | ✅ done | `lib/viz.ts` complet (539 lignes)                |
| 1.7 Metrics Helper     | ✅ done | progressBar, speedupChart implémentés            |
| 1.8 README             | ✅ done | README mis à jour avec nouvelle séquence         |

### Epic 2 Status Detail ✅ COMPLETE

> Updated 2025-12-15: All stories complete, retrospective done

| Story           | Status  | Notes                                             |
| --------------- | ------- | ------------------------------------------------- |
| 2.1 Notebook 00 | ✅ done | Introduction complète                             |
| 2.2 Notebook 01 | ✅ done | The Problem (context explosion + latency)         |
| 2.3 Notebook 02 | ✅ done | Context Optimization (vector search)              |
| 2.4 Notebook 03 | ✅ done | DAG Execution + transition to PML                 |
| 2.5 Notebook 04 | ✅ done | Code Execution & Worker RPC + trace→learning link |
| 2.6 Notebook 05 | ✅ done | Capability Learning (eager + reliability)         |
| 2.7 Notebook 06 | ✅ done | Emergent Reuse (SECI + adaptive + wow moment)     |
| 2.8 Cleanup     | ✅ done | Old notebooks cleaned up                          |

### Epic 3 Status Detail ⬜ BACKLOG

> Created 2025-12-15: Issue discovered during Epic 2 retrospective - notebooks use simulations
> instead of real system

| Story                   | Status     | Notes                                              |
| ----------------------- | ---------- | -------------------------------------------------- |
| 3.1 Helper Capabilities | ⬜ backlog | `lib/capabilities.ts` - expose real system         |
| 3.2 Notebook 04         | ⬜ backlog | Real WorkerBridge instead of SimulatedWorkerBridge |
| 3.3 Notebook 05         | ⬜ backlog | Real CapabilityStore instead of Simulated          |
| 3.4 Notebook 06         | ⬜ backlog | Real Matcher + AdaptiveThreshold                   |
| 3.5 Integration Tests   | ⬜ backlog | `test-notebooks.ts` script                         |

### Bonus Already Implemented

- `playground/lib/llm-provider.ts` - Multi-LLM support (OpenAI, Anthropic, Google)
- `playground/server.ts` - Serveur MCP HTTP complet

---

## Epic 2 Retrospective Learnings (2025-12-15)

**See full retrospective:** `docs/sprint-artifacts/playground/epic-2-retro-2025-12-15.md`

### Key Insights

1. **DAG is the means, not the end** - DAG execution enables structured tracing which feeds
   Capability Learning
2. **Simulations work for pedagogy** - But at least one real demo would increase credibility
3. **The "wow moment" matters** - Before/after comparison added to notebook 06 (5x speedup demo)
4. **Transitions were missing** - Added explicit connections from notebooks 03-04 to the Learning
   system

### Improvements Applied (Post-Retro)

| # | Action                                                     | Status  |
| - | ---------------------------------------------------------- | ------- |
| 1 | Added "Why This Matters for PML" section to notebook 03    | ✅ Done |
| 2 | Added "From Traces to Capabilities" diagram to notebook 04 | ✅ Done |
| 3 | Added "Wow Moment" before/after demo to notebook 06        | ✅ Done |

### Future Improvements

| # | Action                                   | Status        | Notes                               |
| - | ---------------------------------------- | ------------- | ----------------------------------- |
| 1 | Replace all simulations with real system | 🟡 **Epic 3** | See stories 3.1-3.5 above           |
| 2 | External user testing                    | ⬜ Backlog    | Validate assumptions with real devs |

---

**Next Steps:**

1. 🟡 **Epic 3** - Connexion au Vrai Système (5 stories)
2. ⬜ External user testing après Epic 3

**For implementation:** Use the `create-story` workflow to generate individual story implementation
plans from this epic breakdown.
