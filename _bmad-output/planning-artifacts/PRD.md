# Casys PML Product Requirements Document (PRD)

**Author:** BMad **Date:** 2025-11-03 (Updated: 2025-12-09 - Epic 9 added) **Project Level:** 3
**Target Scale:** Complex System - 11 epics, 55+ stories (baseline + adaptive features + emergent
capabilities + hypergraph viz + multi-tenancy)

> **Note:** Le business model a été raffiné dans le
> [Market Research Report](research/research-market-2025-11-11.md) (2025-11-11). Modèle confirmé:
> **Open Core Freemium** avec Free tier (3 servers) → Pro ($15/mo) → Team ($25/mo) → Enterprise
> (custom). Voir Section 9 ci-dessous pour détails complets.

---

## Goals and Background Context

### Goals

1. **Optimiser le contexte LLM** - Réduire la consommation de contexte par les tool schemas de
   30-50% à <5%, permettant aux développeurs de récupérer 90% de leur fenêtre conversationnelle
2. **Paralléliser l'exécution des workflows** - Réduire la latence des workflows multi-tools de 5x à
   1x via DAG execution, éliminant les temps d'attente cumulatifs
3. **Supporter 15+ MCP servers simultanément** - Permettre l'activation de 15+ MCP servers sans
   dégradation de performance, débloquant l'utilisation complète de l'écosystème MCP

### Background Context

L'écosystème Model Context Protocol (MCP) connaît une adoption explosive avec des centaines de
servers disponibles, mais se heurte à deux goulots d'étranglement critiques qui limitent
drastiquement son utilisation réelle.

Premièrement, la **"taxe invisible" du contexte** : 30-50% de la context window LLM est consommée
uniquement par les schemas des tools MCP avant toute interaction utile, forçant les développeurs à
s'auto-limiter à 7-8 servers maximum au lieu des 15-20+ qu'ils souhaiteraient utiliser.
Deuxièmement, **l'inefficacité des appels séquentiels** : les workflows multi-tools s'exécutent sans
parallélisation, créant une latence cumulative pénible (5 tools = 5x le temps d'attente).

**Le marché des gateways MCP est encombré** avec de nombreuses tentatives de solutions : AIRIS,
Smithery, Unla, Context Forge, agentgateway, mcp-gateway-registry, lazy gateway, et d'autres.
Cependant, **aucune ne résout de manière satisfaisante les deux problèmes simultanément** :

- Certains promettent le lazy loading mais l'implémentation est défaillante ou incomplète
- D'autres se concentrent uniquement sur l'orchestration sans optimiser le contexte
- La majorité reste en approche "all-at-once" qui sature la context window
- Aucune ne combine vector search sémantique ET DAG execution de manière production-ready

Casys PML se différencie par une approche **PGlite-first, zero-config, et double optimisation** :
vector search sémantique pour le chargement on-demand granulaire (<5% de contexte) ET DAG execution
pour la parallélisation intelligente (latence 5x → 1x). L'architecture edge-ready et le focus DX
irréprochable (NPS >75 target) visent à devenir la solution de référence là où d'autres ont échoué
sur l'exécution.

---

## Requirements

### Functional Requirements

**Context Optimization**

- **FR001:** Le système doit générer des embeddings vectoriels pour tous les tool schemas MCP
  disponibles
- **FR002:** Le système doit effectuer une recherche sémantique pour identifier les top-k tools
  pertinents (k=3-10) basé sur l'intent utilisateur
- **FR003:** Le système doit charger les tool schemas on-demand uniquement pour les tools identifiés
  comme pertinents
- **FR004:** Le système doit maintenir la consommation de contexte par les tool schemas en-dessous
  de 5% de la context window totale

**DAG Execution & Orchestration**

- **FR005:** Le système doit analyser les dépendances input/output entre tools pour construire un
  graphe de dépendances (DAG)
- **FR006:** Le système doit identifier automatiquement les tools exécutables en parallèle vs
  séquentiellement
- **FR007:** Le système doit exécuter simultanément les branches indépendantes du DAG
- **FR008:** Le système doit streamer les résultats via SSE dès leur disponibilité pour feedback
  progressif

**MCP Server Management**

- **FR009:** Le système doit auto-découvrir les MCP servers disponibles (stdio et SSE) sans
  configuration manuelle
- **FR010:** Le système doit effectuer des health checks automatiques sur les MCP servers au
  démarrage
- **FR011:** Le système doit supporter 15+ MCP servers actifs simultanément sans dégradation de
  performance

**Storage & Persistence**

- **FR012:** Le système doit stocker tous les embeddings, schemas, et metadata dans un fichier
  PGlite unique portable
- **FR013:** Le système doit cacher les tool schemas pour éviter les rechargements répétitifs

**Observability**

- **FR014:** Le système doit tracker les métriques de consommation de contexte et latence
  d'exécution (opt-in)
- **FR015:** Le système doit générer des logs structurés pour debugging et monitoring

**Migration & Setup**

- **FR016:** Le système doit pouvoir lire le mcp.json existant de Claude Code et générer
  automatiquement la configuration Casys PML correspondante

**Code Execution & Sandbox**

- **FR017:** Le système doit permettre l'exécution de code TypeScript généré par les agents dans un
  environnement Deno sandbox isolé avec permissions explicites
- **FR018:** Le système doit supporter les **branches DAG safe-to-fail** : tâches sandbox pouvant
  échouer sans compromettre le workflow global, permettant resilient workflows, graceful
  degradation, et retry safety
- **FR019:** Le système doit injecter les MCP tools pertinents dans le contexte d'exécution sandbox
  via vector search, permettant aux agents d'appeler les tools directement depuis le code TypeScript

**Authentication & Multi-Tenancy**

- **FR020:** Le système doit supporter deux modes de déploiement : Local (zero-auth,
  user_id="local") et Cloud (GitHub OAuth + API Key)
- **FR021:** Le système doit permettre l'authentification via GitHub OAuth en mode Cloud avec
  session management sécurisé (Deno KV, 7 jours expiry)
- **FR022:** Le système doit générer des API Keys uniques (cai_sk_*) pour accès programmatique au
  MCP Gateway en mode Cloud
- **FR023:** Le système doit permettre aux utilisateurs de configurer leurs propres clés API (BYOK)
  pour les MCPs tiers, stockées avec chiffrement AES-256-GCM
- **FR024:** Le système doit isoler les données d'exécution par user_id tout en partageant les tool
  schemas et le graphe de relations (network effect)
- **FR025:** Le système doit appliquer un rate limiting par utilisateur en mode Cloud (100 req/min
  default, configurable)

### Non-Functional Requirements

- **NFR001: Performance** - Le système doit exécuter un workflow typique de 5 tools avec une latence
  P95 <3 secondes (amélioration 5x vs exécution séquentielle baseline)

- **NFR002: Usability (Zero-Config)** - Le système doit permettre à un utilisateur de passer de
  l'installation initiale au premier workflow parallélisé fonctionnel en moins de 10 minutes sans
  configuration manuelle

- **NFR003: Reliability** - Le système doit maintenir un taux de succès >99% pour l'exécution des
  workflows (pas de bugs critiques bloquants comme observés chez les compétiteurs)

---

## User Journeys

### Journey 1: Premier Workflow Parallélisé avec Casys PML

**Acteur:** Alex, Power User développeur (utilise Claude Code 10h/jour, 15 MCP servers installés)

**Objectif:** Passer d'une configuration MCP saturant le contexte à Casys PML avec context optimisé
et workflows parallélisés

**Étapes:**

**1. Setup Casys PML** (3-5 min)

- Alex exécute `pml init` dans son terminal
- Casys PML lit automatiquement le `mcp.json` existant de Claude Code
- Détecte les 15 MCP servers configurés (GitHub, Filesystem, Database, Playwright, Serena, etc.)
- Génère `~/.pml/config.yaml` avec la configuration migrée
- Génère les embeddings vectoriels pour tous les tools (~60s via BGE-Large-EN-v1.5)
- Stocke tout dans `.pml.db` (PGlite portable)
- ✅ Console: "15 MCP servers migrés et indexés avec succès"

**2. Migration Config Claude Code** (2 min)

- Casys PML affiche les instructions de migration
- Alex édite son `claude_desktop_config.json` (mcp.json)
- **Retire** les 15 entrées MCP servers individuelles
- **Ajoute** uniquement la gateway Casys PML:
  ```json
  {
    "mcpServers": {
      "pml": {
        "command": "pml",
        "args": ["serve"]
      }
    }
  }
  ```
- Redémarre Claude Code
- Claude voit maintenant un seul MCP server au lieu de 15

**3. Premier Workflow - Context Libéré** (1-2 min)

- Alex fait une requête cross-MCP: "Lis config.json, parse-le, et crée un ticket GitHub avec les
  infos"
- Casys PML intercepte la requête depuis Claude
- **Vector search:** Identifie 3 tools pertinents (filesystem:read, json:parse, github:create_issue)
- **Context optimization:** Charge uniquement ces 3 schemas (~2% du contexte vs 45% avant)
- **DAG execution:** Détecte dépendances séquentielles (read → parse → create)
- Exécute le workflow, résultats streamés via SSE
- Console Casys PML: "Context usage: 2.3% | Workflow completed in 4.2s"

**4. "Aha Moment" - Parallélisation (<10 min total)**

- Alex teste un workflow parallélisable: "Lis 3 fichiers différents: config.json, package.json,
  README.md"
- Casys PML détecte que les 3 lectures sont indépendantes
- **DAG execution:** Exécute les 3 filesystem:read en parallèle (Promise.all)
- Latence: 1.8s au lieu de 5.4s (3x amélioration mesurée)
- 💡 **Réalisation:** "Je peux activer tous mes MCP servers ET avoir des workflows ultra-rapides!"

**5. Utilisation Continue**

- Alex continue à utiliser Claude Code normalement
- Casys PML tourne en arrière-plan (daemon transparent)
- Tous les 15 MCP servers fonctionnent via la gateway
- Accès filesystem local préservé (pas de problèmes Docker)
- Métriques opt-in trackées: context moyen 3.8%, workflows 4.2x plus rapides

**Points de Validation:**

- ✅ Installation + migration <10 minutes (NFR002)
- ✅ Context <5% maintenu (FR004, NFR001)
- ✅ 15+ MCP servers supportés simultanément (FR011)
- ✅ Workflows parallélisés fonctionnels (FR007)
- ✅ Aucun bug bloquant, expérience fluide (NFR003)

---

## UX Design Principles

Pour un outil backend comme Casys PML, l'UX se concentre sur la **Developer Experience (DX)**.
Principes clés:

**1. Transparence et Feedback**

- Messages console clairs et informatifs à chaque étape
- Progress bars pour opérations longues (génération embeddings)
- Logs structurés avec niveaux appropriés (error, warn, info, debug)
- Métriques visibles (context usage %, latency) après chaque workflow

**2. Zero-Friction Setup**

- Installation en une commande (`pml init`)
- Auto-discovery et migration automatique du mcp.json existant
- Configuration par défaut sensible (pas de fichiers à éditer manuellement)
- Messages d'erreur avec suggestions de résolution

**3. Fail-Safe et Debuggable**

- Erreurs explicites avec context (quel MCP server, quelle opération)
- Rollback automatique si migration échoue
- Mode verbose optionnel (`--verbose`) pour troubleshooting
- Logs persistés dans fichier pour analyse post-mortem

**4. Performance Observable**

- Métriques temps réel streamées dans console
- Comparaison before/after (context: 45% → 3%)
- Dashboard CLI optionnel (`pml status`) pour vue d'ensemble

---

## User Interface Design Goals

Pas d'interface graphique MVP, mais output console optimisé:

**1. Console Output Structurée**

- Couleurs pour statut (vert=success, rouge=error, jaune=warning)
- Tableaux formatés pour métriques (context usage, latency)
- ASCII art minimal pour branding (logo Casys PML au démarrage)

**2. Logging Levels**

- Default: Info (setup steps, workflow results)
- Quiet mode (`--quiet`): Errors only
- Verbose mode (`--verbose`): Debug traces

**3. Interactive Prompts (si nécessaire)**

- Confirmation avant migration destructive
- Opt-in pour telemetry (explicit consent)

---

## Epic List

### Epic 1: Project Foundation & Context Optimization Engine

**Objectif:** Établir l'infrastructure projet et implémenter le système de context optimization via
vector search sémantique

**Livrables clés:**

- Repository configuré avec CI/CD et structure Deno
- PGlite + pgvector fonctionnel avec embeddings storage
- Vector search sémantique opérationnel (<100ms queries)
- On-demand schema loading via MCP protocol
- Migration tool (`pml init`) fonctionnel

**Estimation:** 7-8 stories

---

### Epic 2: DAG Execution & Production Readiness

**Objectif:** Implémenter la parallélisation des workflows via DAG execution et préparer le système
pour production

**Livrables clés:**

- Dependency graph construction automatique
- Parallel executor avec SSE streaming
- Gateway MCP intégré avec Claude Code
- Health checks et observability
- Tests end-to-end et production hardening

**Note architecturale:** Le **DAG** (instance de workflow spécifique) est distinct du **GraphRAG**
(Epic 1 - base de connaissances globale). GraphRAG stocke tous les tools et patterns historiques ;
le DAG Suggester interroge GraphRAG pour prédire quel DAG construire pour une tâche donnée ; le DAG
Executor exécute ce DAG (possiblement spéculativement). Le speculative execution n'est possible que
grâce à cette architecture : GraphRAG (la connaissance) → DAG Suggester (l'intelligence) → DAG (le
plan d'exécution).

**Estimation:** 6-7 stories

---

### Epic 2.5: Adaptive DAG Feedback Loops (Foundation)

> **⚠️ UPDATE 2025-11-24:**
>
> - **ADR-018**: Story 2.5-4 scope reduced (16h → 4h) - Command Handlers Minimalism
> - **ADR-019**: AIL/HIL implementation clarified - Two-Level Architecture (Gateway HTTP + Agent
>   Delegation), not SSE streaming

**Objectif:** Établir la fondation pour workflows adaptatifs avec feedback loops Agent-in-the-Loop
(AIL) et Human-in-the-Loop (HIL), préparant l'intégration avec Epic 3 (Sandbox)

**Architecture 3-Loop Learning (Phase 1 - Foundation):**

**Loop 1 (Execution - Real-time):**

- Event stream observable pour monitoring en temps réel
- Command queue pour contrôle dynamique (agent + humain)
- State management avec checkpoints et resume
- **Fréquence:** Milliseconds (pendant l'exécution)

**Loop 2 (Adaptation - Runtime):**

- Agent-in-the-Loop (AIL): Décisions autonomes via HTTP response pattern (ADR-019 Level 1)
  - Pre-execution confidence check (<0.6 → AIL required)
  - Per-layer validation (HTTP response with partial results)
- Human-in-the-Loop (HIL): Validation humaine pour opérations critiques (CRUCIAL pour Epic 3)
- DAG re-planning dynamique via GraphRAG queries
- **Fréquence:** Seconds à minutes (entre layers)
- **Note:** Story 2.5-3 SSE pattern incompatible with MCP (see ADR-019)

**Loop 3 (Meta-Learning - Basic):**

- GraphRAG updates from execution patterns (co-occurrence, preferences)
- Learning baseline pour futures optimisations
- **Fréquence:** Per-workflow

**Livrables clés (ADR-007 - Phase 1):**

- ControlledExecutor extends ParallelExecutor avec event stream + commands
- Checkpoint/resume infrastructure (PGlite persistence)
- AIL/HIL integration avec multi-turn conversations (Story 2.5-3 - SSE pattern, needs Gateway HTTP
  refactor per ADR-019)
- DAG replanning via DAGSuggester.replanDAG() (PRIMARY mechanism per ADR-018)
- Command infrastructure hardening (Story 2.5-4): Race condition fix, error handling (4h per
  ADR-018)
  - Deferred handlers: inject_tasks, skip_layer, modify_args, checkpoint_response (YAGNI until
    proven need)
- GraphRAG feedback loop (updateFromExecution)
- Un seul agent en conversation continue (pas de filtering contexte)

**Déféré à Epics suivants:**

- **Epic 3.5 (Speculation):** Speculative execution avec sandbox isolation (safe!)

  - DAGSuggester.predictNextNodes()
  - Confidence-based speculation
  - THE feature avec sécurité garantie

- **Epic 4 (ADR-008):** Episodic Memory + Adaptive Thresholds
  - Episodic memory storage (hybrid JSONB + typed columns)
  - Adaptive threshold learning (EMA algorithm, 0.92 → 0.70-0.95)
  - State pruning strategy
  - Loop 3 avancé avec données réelles de production

**Estimation:**

- Stories 2.5-1 to 2.5-4: 19-22h / 4 stories (Story 2.5-4 reduced 16h→4h per ADR-018)

**Rationale de deferral:**

- Epic 2.5 = Foundation focused (Loop 1-2 + Loop 3 basique)
- Speculation SANS sandbox = risqué (side-effects non isolés)
- Speculation AVEC sandbox (Epic 3.5) = THE feature safe
- ADR-008 bénéficiera de données réelles après Epic 2.5 + Epic 3
- Epics digestibles (7-10h chacun vs 18.5h monolithique)

**Value Proposition (Epic 2.5):**

- **Foundation critique pour Epic 3** (HIL pour approval code sandbox)
- **Human oversight** pour opérations critiques (safety)
- **Progressive discovery** workflows adaptables runtime
- **AIL decisions** agent peut replanifier basé sur découvertes
- **Checkpoint/resume** workflows interruptibles et résilients

**Architectural Insight:**

- **Loop 1** fournit l'observabilité et le contrôle (event stream, checkpoints)
- **Loop 2** permet l'adaptation intelligente (AIL/HIL, replanning) - unique à Casys PML vs CoALA
- **Loop 3 basique** commence l'apprentissage (GraphRAG updates)
- Epic 3.5 ajoutera speculation WITH sandbox (0ms latency safe)
- Epic 4 ajoutera episodic memory + adaptive learning (self-improving)

**Prerequisites:** Epic 1 (GraphRAG foundation), Epic 2 (DAG execution baseline)

**Related Decisions:**

- ADR-007 (✅ Approved v2.0 - 2025-11-14)
- ADR-008 (⏳ Proposed - Deferred to Epic 4)
- ADR-017 (✅ Proposed - Gateway Exposure Modes, resolves transparency vs meta-tools tension)

---

### Epic 3: Agent Code Execution & Local Processing

**Objectif:** Implémenter un sandbox d'exécution sécurisé pour permettre aux agents d'écrire et
exécuter du code TypeScript localement, traitant les large datasets avant injection dans le contexte
LLM

**Livrables clés:**

- Deno sandbox executor avec isolation et sécurité
- MCP tools injection dans code context (vector search-guided)
- Local data processing pipeline (filtrage/agrégation pré-contexte)
- Nouveau tool MCP `pml:execute_code`
- PII detection et tokenization automatique
- Code execution caching et optimizations
- Documentation et tests E2E complets

**Estimation:** 8 stories (3.1 à 3.8)

**Value Proposition:** Réduction additionnelle de contexte (<5% → <1% pour large datasets),
protection automatique des données sensibles, et traitement local des données volumineuses (1MB+ →
<1KB dans contexte)

**Architectural Benefit (Foundation pour Epic 3.5):** L'isolation du sandbox permet de créer des
**branches DAG safe-to-fail** : des tâches qui peuvent échouer sans compromettre le workflow global.
Contrairement aux appels MCP (effets de bord possibles comme création de fichiers ou issues GitHub),
le code sandbox est **idempotent et isolé**.

Cette propriété débloque la **vraie puissance du speculative execution** (Epic 3.5) : avec les MCP
tools directs, l'exécution spéculative serait risquée (prédiction incorrecte = side effect
indésirable), mais avec le sandbox isolation, Epic 3.5 pourra :

- **Prédire et exécuter** plusieurs approches simultanément sans risque
- **Échouer gracieusement** si les prédictions sont incorrectes (pas de corruption)
- **Retry en toute sécurité** sans duplication d'effets
- **Rollback natif** grâce à l'isolation complète

**Prerequisites:** Epic 1 (GraphRAG foundation), Epic 2 (DAG execution), Epic 2.5 (AIL/HIL
foundation)

---

### Epic 3.5: Speculative Execution with Sandbox Isolation

**Objectif:** Implémenter speculation WITH sandbox pour THE feature - 0ms perceived latency avec
sécurité garantie

**Livrables clés:**

- DAGSuggester.predictNextNodes() avec GraphRAG community detection
- Confidence-based speculation (threshold 0.7+)
- Sandbox isolation pour toutes les speculations
- Rollback automatique des prédictions incorrectes
- Metrics tracking (hit rate, net benefit, waste)

**Estimation:** 1-2 stories, 3-4h

**Value Proposition:**

- **0ms perceived latency** via speculation (23-30% speedup)
- **Safe speculation** grâce à sandbox isolation (zero side-effects)
- **THE feature** différenciateur d'Casys PML
- **Graceful fallback** si prédiction incorrecte

**Pourquoi après Epic 3 ?**

- Speculation SANS sandbox = risqué (side-effects non contrôlés)
- Speculation AVEC sandbox = safe (isolation + rollback natif)
- Epic 2.5 (HIL) permet human override si needed
- Foundation complète : Loop 1-2 + Sandbox + GraphRAG

**Prerequisites:** Epic 2.5 (Foundation), Epic 3 (Sandbox)

---

### Epic 4: Episodic Memory & Adaptive Learning (ADR-008)

**Objectif:** Étendre Loop 3 (Meta-Learning) avec mémoire épisodique et seuils adaptatifs pour
système auto-améliorant

**Status:** 🟡 IN PROGRESS (Phase 1 Done 2025-11-25)

**Livrables clés (ADR-008):**

- **Story 4.1 (Split en 2 phases):**
  - ✅ **Phase 1 (Storage Foundation):** DONE 2025-11-25
    - Migration 007: tables `episodic_events` + `adaptive_thresholds`
    - `EpisodicMemoryStore` class (280 LOC, 9 tests)
    - Threshold persistence via PGlite (+100 LOC)
  - 🔴 **Phase 2 (Loop Integrations):** Backlog (after Epic 2.5/3.5)
    - ControlledExecutor auto-capture
    - DAGSuggester context boost
- **Story 4.2:** ✅ DONE (Sliding Window + FP/FN Detection, now with persistence)
  - **Implementation Reality (2025-11-05):** Sliding Window algorithm (50 executions)
  - **Update (2025-11-25):** Now persists to PGlite via Story 4.1c

**Estimation:** Phase 1: ~2.5h ✅ | Phase 2: ~2h (after dependencies)

**Value Proposition:**

- **Self-improving system** via adaptive thresholds (85% success rate target)
- **Historical context** améliore prédictions (episodic memory)
- **Optimal thresholds** appris par type de workflow
- **Loop 3 complet** avec apprentissage continu
- ✅ **Persistence:** Thresholds survive server restarts (Phase 1)

**Phase 2 Prerequisites:** Epic 2.5-4 (CommandQueue), Epic 3.5 (DAGSuggester speculation)

**Related Decisions:** ADR-008 (Partially Implemented)

---

### Epic 5: Intelligent Tool Discovery & Graph-Based Recommendations

**Objectif:** Améliorer la découverte d'outils en combinant recherche sémantique (Epic 1) et
recommandations basées sur les patterns d'usage réels via graph traversal

**Livrables clés:**

- **Story 5.1:** `search_tools` MCP tool - Hybrid semantic + graph search with Adamic-Adar
  relatedness
  - ~~Dynamic alpha balancing (ADR-015): `α = max(0.5, 1.0 - density × 2)`~~ → **Superseded by
    ADR-048: Local Adaptive Alpha** (per-tool alpha via Heat Diffusion / Embeddings Hybrides)
  - Graph methods: `getNeighbors()`, `computeAdamicAdar()`, `computeGraphRelatedness()`
  - No strict confidence threshold (returns top-K results, letting agent decide)
  - **Complementary to Story 4.2:** Improves search quality (confidence boost) vs threshold
    adaptation
- **Story 5.2:** Workflow templates & graph bootstrap - Cold start solution with predefined patterns

**Estimation:** 2 stories, ~4-6h

**Value Proposition:**

- **Better tool discovery** via graph-based recommendations (fixes threshold failures like
  "screenshot" = 0.48)
- **Hybrid scoring** balances semantic relevance + usage patterns
- **Cold start solution** via workflow templates (works even without historical data)
- **Adaptive weighting** based on graph density (more semantic when sparse, more graph when dense)

**Architectural Insight (ADR-015 → ADR-048):**

- Increases search scores via graph boost (0.48 → 0.64), reducing threshold failures
- Works alongside Story 4.2: Better scores (5.1) + Adaptive thresholds (4.2) = Fewer manual
  confirmations
- **Evolution:** ADR-048 replaced global alpha with per-tool Local Alpha for more precise weighting

**Prerequisites:** Epic 3 (Sandbox for safe speculation context)

**Status:** Completed (Story 5.1 in review, 2025-11-20)

---

### Epic 6: Real-time Graph Monitoring & Observability

**Objectif:** Fournir visibilité complète sur l'état du graphe de dépendances en temps réel via
dashboard interactif pour debugging et compréhension

**Livrables clés:**

- **Story 6.1:** Real-time events stream (SSE) - `GET /events/stream` endpoint
- **Story 6.2:** Interactive graph visualization - Force-directed graph avec D3.js/Cytoscape.js
- **Story 6.3:** Live metrics & analytics panel - Edge count, density, PageRank top 10, communities
- **Story 6.4:** Graph explorer & search interface - Interactive search, path finding, Adamic-Adar
  viz

**Estimation:** 4 stories, ~8-12h

**Value Proposition:**

- **Observable learning** - See how graph evolves in real-time
- **Debug recommendations** - Understand why tools are suggested together
- **Performance insights** - Monitor PageRank, communities, edge creation patterns
- **Interactive exploration** - Search, filter, find paths between tools

**Prerequisites:** Epic 5 (search_tools functional with graph methods)

**Status:** Stories 6.1-6.4 drafted (2025-11-20)

---

### Epic 7: Emergent Capabilities & Learning System

> **ADRs:** ADR-027 (Execute Code Graph Learning), ADR-028 (Emergent Capabilities System), ADR-032
> (Sandbox Worker RPC Bridge) **Research:** docs/research/research-technical-2025-12-03.md

**Objectif:** Transformer Casys PML en système où les capabilities **émergent de l'usage** plutôt
que d'être pré-définies. Claude devient un **orchestrateur de haut niveau** qui délègue l'exécution
à Casys PML, récupérant des capabilities apprises et des suggestions proactives basées sur les
patterns d'exécution réels.

**Architecture 3 Couches (ADR-032 - Worker RPC Bridge):**

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: ORCHESTRATION (Claude)                            │
│  • Reçoit l'intent utilisateur                              │
│  • Query: "Capability existante?" → YES: execute cached     │
│  • NO: génère code → execute → learn                        │
│  • NE VOIT PAS: données brutes, traces, détails exécution   │
└─────────────────────────────────────────────────────────────┘
                          ▲ IPC: result + suggestions
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: CAPABILITY ENGINE + RPC BRIDGE                     │
│  • CapabilityMatcher: intent → capability matching          │
│  • WorkerBridge: routes RPC calls to MCPClients             │
│  • Native Tracing: ALL tool calls traced in bridge          │
│  • SuggestionEngine: Spectral Clustering + Tools Overlap    │
│  • GraphRAGEngine: PageRank, communities, edges             │
└─────────────────────────────────────────────────────────────┘
                          ▲ postMessage RPC (tool calls)
┌─────────────────────────────────────────────────────────────┐
│  LAYER 3: EXECUTION (Deno Worker, permissions: "none")      │
│  • Tool proxies: mcp.server.tool() → RPC call to bridge     │
│  • Capability code: inline functions (no RPC overhead)      │
│  • Isolation complète, pas de discovery runtime             │
└─────────────────────────────────────────────────────────────┘
```

**Livrables clés:**

**Phase 1 - Worker RPC Bridge (ADR-032):**

- Deno Worker avec `permissions: "none"` pour isolation
- RPC Bridge dans main process route les appels vers MCPClients
- Tracing natif dans le bridge (pas de parsing stdout)
- Appel `graphEngine.updateFromExecution()` avec tools réels

**Phase 2 - Capability Storage:**

- Migration 011: Extension table `workflow_pattern` (code_snippet, parameters, success_rate)
- Store code_snippet dans `workflow_execution`
- Pattern detection query (count >= 3, success_rate > 0.7)

**Phase 3 - Capability Matching:**

- `CapabilityMatcher` class avec vector search sur intent_embedding
- Nouveau tool MCP `search_capabilities`
- Execute capability code si match > 0.85

**Phase 4 - Suggestion Engine:**

- `SuggestionEngine` class utilisant Spectral Clustering (Hypergraph)
- Tools Overlap pour related capabilities
- Out-neighbors pour "next likely tool" (Recency/Cooc)
- Suggestions incluses dans response `execute_code`

**Phase 5 - Auto-promotion & Cache:**

- Background job: pattern detection → capability promotion
- Cache multi-niveaux: Execution → Capability → Intent similarity
- Invalidation sur tool schema change ou failures répétés

**Phase 6 - Algorithm Observability (ADR-039):**

- Trace chaque décision de scoring (Active Search / Passive Suggestion)
- Collecte metrics: success_rate, click_rate, spectral_relevance
- Dashboard pour valider les poids des algorithmes

**Estimation:** 9 stories (7.1 à 7.6), ~3-4 semaines

**Value Proposition:**

- **Différenciation unique** - Aucun concurrent (Docker MCP, Anthropic PTC) n'offre le learning
- **Performance** - Skip génération Claude si capability existe (~2-5s saved)
- **UX proactive** - Suggestions réduisent friction cognitive
- **Self-improving** - Système apprend continuellement de chaque exécution
- **Code reuse** - Capabilities cristallisées réutilisables

**Capability Lifecycle (Eager Learning + Lazy Suggestions):**

```
Execute & Learn (exec 1) → Capability Matching → Lazy Suggestions → Optional Pruning
         │                        │                    │                  │
  UPSERT immédiat          Match intent > 0.85   Filter: usage >= 2   Cleanup unused
  usage_count++            success_rate > 0.7    OU success > 0.9     after 30 days
```

**Philosophy:**

- **Eager Learning:** Stocke dès la 1ère exécution réussie (storage is cheap)
- **Lazy Suggestions:** Ne suggère que les capabilities validées par usage ou qualité

**Comparaison Marché:**

| Critère     | Docker MCP | Anthropic PTC | **Casys PML Epic 7**       |
| ----------- | ---------- | ------------- | -------------------------- |
| Learning    | ❌         | ❌            | ✅ GraphRAG + Capabilities |
| Suggestions | ❌         | ❌            | ✅ Louvain/Adamic-Adar     |
| Code Reuse  | ❌         | ❌            | ✅ Capability cache        |
| Sécurité    | Container  | Sandbox       | Sandbox + scope fixe       |

**Prerequisites:** Epic 3 (Sandbox), Epic 5 (search_tools), Epic 6 (observability)

**Status:** Proposed (ADR-027, ADR-028)

---

### Epic 8: Hypergraph Capabilities Visualization

> **ADR:** ADR-029 (Hypergraph Capabilities Visualization) **Depends on:** Epic 6 (Dashboard), Epic
> 7 (Capabilities Storage)

**Objectif:** Visualiser les capabilities comme **hyperedges** (relations N-aires entre tools) via
Cytoscape.js compound graphs, permettant aux utilisateurs de voir, explorer et réutiliser le code
appris par le système.

**Le Problème:** Une capability n'est pas une relation binaire (A → B) mais une relation N-aire
connectant plusieurs tools:

```
┌─────────────────────────────────┐
│  Capability "Create Issue"      │
│  Connecte: fs, json, github     │
│  Code: await mcp.github...      │
└─────────────────────────────────┘
```

**Décision Architecturale (ADR-029):** Cytoscape.js Compound Graphs

- Capability = parent node (violet, expandable)
- Tools = child nodes (colored by server)
- Click capability → Code Panel avec syntax highlighting

**Livrables clés:**

- **Story 8.1:** Capability Data API (`/api/capabilities`, `/api/graph/hypergraph`)
- **Story 8.2:** Compound Graph Builder (HypergraphBuilder class)
- **Story 8.3:** Hypergraph View Mode (toggle dans dashboard header)
- **Story 8.4:** Code Panel Integration (syntax highlighting, copy button)
- **Story 8.5:** Capability Explorer (search, filter, "try this capability")

**Estimation:** 5 stories, ~1-2 semaines

**Value Proposition:**

- **Visualisation claire** de ce que le système a appris
- **Debug facile** : "pourquoi cette capability a été suggérée?"
- **Code réutilisable** visible et copiable directement
- **Builds on existing** infrastructure (Cytoscape.js)

**UI Preview:**

```
┌─────────────────────────────────────────┐
│  Dashboard: [Tools] [Capabilities] [Hypergraph]
├─────────────────────────────────────────┤
│  ┌─────────────────────────┐            │
│  │  Cap: Create Issue      │            │
│  │  ┌─────┐  ┌─────┐      │            │
│  │  │ fs  │  │ gh  │      │            │
│  │  └─────┘  └─────┘      │            │
│  └─────────────────────────┘            │
├─────────────────────────────────────────┤
│  Code Panel:                            │
│  const content = await mcp.fs.read(...);│
│  await mcp.github.createIssue({...});   │
│  Success: 95% | Usage: 12               │
└─────────────────────────────────────────┘
```

**Status:** Proposed (ADR-029)

---

### Epic 9: GitHub Authentication & Multi-Tenancy

> **ADRs:** ADR-040 (Multi-tenant MCP & Secrets Management) **Tech-Spec:**
> tech-spec-github-auth-multitenancy.md

**Objectif:** Implémenter un modèle d'authentification hybride permettant deux modes de déploiement
: **Self-hosted (Local)** pour développeurs individuels (zero-auth) et **Cloud (SaaS)** pour la
plateforme publique (GitHub OAuth + API Key).

**Architecture Dual-Mode:**

```
┌─────────────────────────────────────────────────────────────────┐
│  LOCAL MODE (Self-hosted)                                        │
│  • Zero authentication - user_id = "local"                       │
│  • SQLite database, no cloud dependency                          │
│  • Full MCP access via local .mcp config                         │
│  • Détection: !GITHUB_CLIENT_ID in env                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  CLOUD MODE (SaaS)                                               │
│  • GitHub OAuth for authentication                               │
│  • API Key for programmatic access (MCP Gateway)                 │
│  • BYOK (Bring Your Own Key) for third-party MCPs               │
│  • PML-managed MCP catalog (no custom servers MVP)               │
│  • Secrets encrypted AES-256-GCM (master key in Deno Deploy)    │
└─────────────────────────────────────────────────────────────────┘
```

**Data Isolation Model:**

- **GLOBAL (shared):** mcp_tools, tool_graph, embeddings, capabilities (network effect)
- **PRIVATE (per user_id):** dag_executions, execution_traces, user_secrets, user_mcp_configs

**Livrables clés:**

- **Story 9.1:** Infrastructure - Auth schema, helpers, Drizzle migrations
- **Story 9.2:** GitHub OAuth flow - `/auth/github`, `/auth/callback`, session management
- **Story 9.3:** Auth middleware - Route protection, mode detection, API key validation
- **Story 9.4:** Landing page & Dashboard UI - Auth-aware components, Settings page
- **Story 9.5:** Rate limiting & Data isolation - User-scoped queries, rate limiter per user
- **Story 9.6:** MCP Config & Secrets Management - BYOK dashboard, AES-256-GCM encryption

**Estimation:** 6 stories, ~1-2 semaines

**Value Proposition:**

- **Dual deployment** - Open source self-hosted + SaaS with same codebase
- **GitHub OAuth** - Familiar auth flow for developers
- **BYOK security** - Users control their API keys, encrypted at rest
- **Network effect** - Tool graph enriched by all users, execution data private
- **Zero-config local** - No auth overhead for self-hosted users

**MCP Categories (Cloud Mode):**

| Category    | Examples                        | API Key Source          |
| ----------- | ------------------------------- | ----------------------- |
| **Managed** | filesystem, memory, fetch       | None (PML provides)     |
| **OAuth**   | github                          | User's GitHub token     |
| **BYOK**    | tavily, brave, openai, airtable | User provides their key |

**Prerequisites:** Epic 6 (Dashboard foundation), Epic 7 (Capabilities for user-scoped learning)

**Status:** 🟡 IN PROGRESS (Stories 9.1-9.4 done, 9.5-9.6 backlog)

**Related Decisions:** ADR-040 (Multi-tenant MCP & Secrets Management)

---

**Séquence Planifiée vs Réelle:**

**Planifiée initialement:**

- Epic 1 → Epic 2 → Epic 2.5 → Epic 3 → Epic 3.5 → Epic 4 → Epic 5 → Epic 6

**Séquence RÉELLE (avec rationale):**

- Epic 1 → Epic 2 (Production ready baseline) ✅ DONE
- Epic 2.5 → Foundation adaptive (Loop 1-2 + Loop 3 basic) ✅ DONE
- Epic 3 → Sandbox isolation ✅ DONE
- **Epic 5 → Tool Discovery (MOVED FORWARD)** ✅ DONE
  - **Rationale:** Epic 3.5 speculation requires `search_tools` for DAGSuggester workflow template
    discovery
  - `DAGSuggester.suggestDAG()` needs semantic search to find relevant templates from GraphRAG
  - Epic 5 is a **dependency** for Epic 3.5, not a post-feature enhancement
- Epic 3.5 → Speculation WITH sandbox (THE feature safe) ✅ DONE
- Epic 4 → Episodic memory + Adaptive learning (self-improving) ✅ DONE
- Epic 6 → Real-time monitoring & observability - 🟡 IN PROGRESS (story 6-4 in review)
- **Epic 7 → Emergent Capabilities & Learning System** - 📋 PROPOSED
  - **Rationale:** ADR-027/028 définissent un nouveau paradigme où Claude devient orchestrateur
  - Débloque learning continu + suggestions proactives (différenciateur unique)
  - Builds on Epic 3 (sandbox), Epic 5 (search_tools), Epic 6 (observability)
- **Epic 8 → Hypergraph Capabilities Visualization** - 📋 PROPOSED
  - **Rationale:** ADR-029 - Visualiser les capabilities comme hyperedges (relations N-aires)
  - Cytoscape.js compound graphs pour représentation intuitive
  - Builds on Epic 6 (dashboard), Epic 7 (capabilities storage)
- **Epic 9 → GitHub Authentication & Multi-Tenancy** - 🟡 IN PROGRESS
  - **Rationale:** ADR-040 - Modèle hybride Local/Cloud pour dual deployment
  - Débloque SaaS public avec GitHub OAuth + BYOK pour API keys tiers
  - Builds on Epic 6 (dashboard), enables Epic 7+ user-scoped learning

> **Note:** Detailed epic breakdown with full story specifications is available in
> [epics.md](./epics.md)

---

## Out of Scope

### Fonctionnalités Déférées Post-MVP

**1. Speculation déplacée IN-SCOPE (Epic 3.5)**

- ~~Rationale: Besoin validation empirique que ça fonctionne réellement (>70% hit rate)~~
- **UPDATE 2025-11-14:** Speculation est maintenant IN-SCOPE dans Epic 3.5 (après sandbox)
- **Rationale:** Speculation WITH sandbox = THE feature safe (isolation + rollback)
- Timeline: Epic 3.5 (après Epic 3 Sandbox)

**2. Plugin System pour API Translation**

- Rationale: Pas de cas d'usage bloquants sans plugins day-1
- Timeline: v1.1 si demand utilisateur

**3. Visual Observability Dashboard**

- Rationale: Telemetry backend + logs CLI suffisent pour MVP
- Timeline: v1.2+ si friction analysis manuelle trop lourde

**4. Edge Deployment (Deno Deploy/Cloudflare Workers)**

- Rationale: Local-first simplifie debugging MVP, architecture edge-ready dès le début
- Timeline: v1.1 si demand production deployment

**5. Docker/Container Deployment**

- Rationale: Problèmes npx + filesystem volumes observés avec AIRIS
- Timeline: Post-MVP si résolution des problèmes d'architecture

**6. Advanced Caching (Event-Based Invalidation)**

- Rationale: TTL-based cache suffit MVP
- Timeline: v2+ si usage stats montrent besoin

### Fonctionnalités Non-MVP

**7. Multi-Tenancy & Team Features** ✅ MOVED IN-SCOPE (Epic 9)

- ~~Pas de support teams/organisations MVP~~
- **UPDATE 2025-12-09:** Multi-tenancy maintenant IN-SCOPE via Epic 9
- GitHub OAuth + API Key + BYOK pour mode Cloud
- Voir ADR-040 pour architecture complète

**8. Enterprise Features**

- SSO, audit logs, SLA guarantees
- Timeline: Conditional on enterprise demand

**9. Business Model & Monetization**

- **Open Core Freemium** (aligné avec research report)
- **Free Tier MVP:** Core features open-source, 3 MCP servers limit (conversion funnel)
- **Pro Tier:** $15/mo - Unlimited servers, DAG execution, priority support (Phase 1: Mois 3-6)
- **Team Tier:** $25/user/mo - Shared configs, team dashboard, analytics (Phase 2: Mois 7-18)
- **Enterprise Tier:** $50-75/user/mo + $10K platform fee - SSO, RBAC, SOC2, SLAs (Phase 3: Mois
  19-36)
- **Rationale:** Sustainable freemium comble gap entre "100% free" (Smithery/Unla) et
  "enterprise-only" (Kong/IBM)
- **Target:** $5M ARR dans 3 ans (realistic scenario, voir research report pour détails)

**10. Support Protocols Non-MCP**

- Uniquement MCP stdio/SSE supportés
- Pas de REST, GraphQL, ou autres protocols custom
