# Casys MCP Gateway Playground - Product Requirements Document (PRD)

**Auteur:** BMad **Date:** 2025-11-28 **Niveau Projet:** 2 **Échelle Cible:** Playground éducatif

---

## Goals et Background Context

### Goals

- **Démontrer le problème MCP de manière tangible** - Permettre aux utilisateurs de voir et mesurer
  eux-mêmes le context explosion (~45% de la fenêtre) et le latency cost via des notebooks
  exécutables avec de vrais appels

- **Enseigner la solution Casys MCP Gateway étape par étape** - Guider progressivement à travers :
  context optimization → DAG execution → sandbox → capability learning → emergent reuse, avec des
  exemples concrets et interactifs

- **Fournir un environnement LLM-agnostic prêt à l'emploi** - Un Codespace GitHub où tout fonctionne
  out-of-the-box avec le provider de son choix (OpenAI, Anthropic, Google via Vercel AI SDK), en
  mode stdio ou HTTP

### Background Context

Le Model Context Protocol (MCP) révolutionne la façon dont les agents IA interagissent avec les
outils externes. Cependant, l'adoption à grande échelle se heurte à deux problèmes fondamentaux :
l'explosion du contexte (30-50% de la fenêtre consommée par les schémas d'outils) et la latence
séquentielle des appels.

**Le paradigme Casys PML :** Plutôt que d'orchestrer des appels MCP individuels, Claude **compose du
code TypeScript** qui est ensuite **exécuté par Casys PML** dans un Worker sandbox sécurisé. Ce code
appelle les MCP tools via un RPC Bridge. Le système **apprend** de chaque exécution réussie,
cristallisant des "capabilities" réutilisables. Résultat : Claude devient un compositeur de code de
haut niveau, Casys PML gère l'exécution sécurisée et l'apprentissage.

Casys MCP Gateway est LLM-agnostic (Claude, GPT-4, Gemini via Vercel AI SDK) et résout les problèmes
MCP via : recherche vectorielle (context <5%), Worker RPC Bridge (exécution sécurisée avec tracing),
et capability learning (réutilisation de code prouvé).

Ce playground rend ces concepts accessibles avec de vrais serveurs MCP, de vrais appels, des
métriques réelles. La gateway supporte stdio et HTTP pour différents cas d'usage.

---

## Requirements

### Functional Requirements

**Environnement & Setup**

- **FR001:** Le playground doit s'exécuter dans un GitHub Codespace avec une configuration
  devcontainer prête à l'emploi
- **FR002:** L'initialisation doit supporter la commande `pml init` pour configurer automatiquement
  la gateway
- **FR003:** La gateway doit pouvoir démarrer en mode stdio (`pml serve`) ou HTTP
  (`pml serve --port 3000`)

**Multi-LLM Support**

- **FR004:** L'utilisateur doit pouvoir choisir son provider LLM (OpenAI, Anthropic, Google) via
  variable d'environnement ou config
- **FR005:** Le système doit auto-détecter le provider depuis le format de la clé API

**Notebooks Pédagogiques**

- **FR006:** Chaque notebook doit être exécutable de bout en bout dans l'ordre séquentiel (00 → 01 →
  02...)
- **FR007:** Les notebooks doivent afficher des métriques visuelles (tokens consommés, latence,
  speedup)
- **FR008:** Les notebooks doivent pouvoir afficher des diagrammes Mermaid (via Kroki ou rendu natif
  Jupyter)
- **FR009:** Les cellules de code doivent clairement distinguer les exemples exécutables des
  illustrations

**Concepts Démontrés**

- **FR010:** Le notebook "Context Optimization" doit démontrer la réduction de contexte de ~45% à
  <5%
- **FR011:** Le notebook "DAG Execution" doit visualiser le graphe de dépendances et le speedup
  obtenu
- **FR012:** Le notebook "Sandbox" doit exécuter du code TypeScript isolé via Worker RPC Bridge et
  montrer les contrôles de sécurité avec tracing natif des tool calls
- **FR013:** Le notebook "Capability Learning" doit montrer comment les capabilities émergent de
  l'exécution de code (eager learning, search_capabilities tool)
- **FR014:** Le notebook "Emergent Reuse" doit démontrer la réutilisation de capabilities prouvées
  et les suggestions du Suggestion Engine

**MCP Servers & Workflow Templates**

- **FR015:** Le playground doit inclure 3 MCP servers Tier 1 sans clé API :
  - `@modelcontextprotocol/server-filesystem` - parallélisation lecture fichiers
  - `@modelcontextprotocol/server-memory` - knowledge graph local
  - `@modelcontextprotocol/server-sequential-thinking` - branchement DAG
- **FR016:** Le playground doit inclure des workflow templates pré-configurés démontrant :
  - Parallélisation pure (3 outils indépendants)
  - Pattern récurrent GraphRAG (séquence apprise)
  - DAG multi-niveaux (dépendances entre niveaux)
- **FR017:** Le notebook GraphRAG doit démontrer le chargement de workflow templates via
  `pml workflows sync`

**Progression & Checkpoints**

- **FR018:** Chaque notebook doit se terminer par un checkpoint de validation (quiz ou exercice)

### Non-Functional Requirements

- **NFR001:** **Temps de setup < 5 minutes** - Un utilisateur doit pouvoir lancer le Codespace et
  exécuter le premier notebook en moins de 5 minutes (incluant le téléchargement des modèles
  d'embedding)

- **NFR002:** **Compatibilité Jupyter** - Les notebooks doivent fonctionner avec le kernel Deno dans
  VS Code (extension Jupyter) sans configuration supplémentaire

- **NFR003:** **Documentation inline** - Chaque cellule de code doit être auto-explicative avec des
  commentaires clairs, sans nécessiter de documentation externe

---

## User Journeys

### Journey Principal : "Comprendre et adopter Casys MCP Gateway"

**Persona:** Dev curieux qui a entendu parler de MCP mais galère avec le context explosion

```
┌─────────────────────────────────────────────────────────────────┐
│  1. DÉCOUVERTE                                                  │
│     • Trouve le repo via recherche "MCP context optimization"   │
│     • Lit le README qui promet "45% → <5% context usage"        │
│     • Clique "Open in Codespace"                                │
└─────────────────────────┬───────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. SETUP (< 5 min)                                             │
│     • Codespace démarre avec Deno + Jupyter pré-configurés      │
│     • Configure sa clé API (OPENAI/ANTHROPIC/GOOGLE_API_KEY)    │
│     • Ouvre 00-introduction.ipynb                               │
└─────────────────────────┬───────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. PRISE DE CONSCIENCE (notebook 01)                           │
│     • Exécute les cellules qui calculent le context explosion   │
│     • Voit "45.4% consumed before you start" → "Ah ouais..."    │
│     • Mesure la latence séquentielle vs parallèle               │
└─────────────────────────┬───────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. APPRENTISSAGE PROGRESSIF (notebooks 02-05)                  │
│     • Context Optimization : voit la recherche vectorielle      │
│     • DAG Execution : visualise le graphe, mesure le speedup    │
│     • Sandbox : exécute du code isolé, teste les limites        │
│     • GraphRAG : observe l'apprentissage de patterns            │
└─────────────────────────┬───────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. VALIDATION                                                  │
│     • Complète les checkpoints de chaque notebook               │
│     • Comprend comment intégrer la gateway dans ses projets     │
│     • Star le repo, rejoint la communauté                       │
└─────────────────────────────────────────────────────────────────┘
```

**Points de friction potentiels:**

- Config clé API → Résolu par auto-détection du provider
- Téléchargement modèles embedding → Message de progression clair
- Notebook qui plante → Chaque notebook est indépendant après 00

---

## UX Design Principles

1. **Progressive Disclosure** - Chaque notebook révèle un concept à la fois, pas de surcharge
   cognitive
2. **Show, Don't Tell** - Les métriques et visualisations parlent d'elles-mêmes avant l'explication
3. **Fail-Safe** - Si une cellule échoue, le message d'erreur guide vers la solution

---

## User Interface Design Goals

- **Interface:** VS Code + Jupyter (pas de custom UI)
- **Visualisations:**
  - Métriques en ASCII art pour compatibilité universelle
  - Diagrammes Mermaid via Kroki pour les DAGs et architectures
  - Barres de progression pour les opérations longues (embedding loading)
- **Structure des notebooks:**
  ```
  # Titre + Learning Objectives
  ## Section 1 - Explication courte
  [Code exécutable]
  [Output avec métriques]
  ## Section 2 - ...
  ## Checkpoint - Validation
  ## Next - Lien vers notebook suivant
  ```

---

## Epic List

| Epic       | Titre                     | Goal                                                                                                                | Stories estimées |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **Epic 1** | Infrastructure Playground | Configurer l'environnement Codespace prêt à l'emploi avec devcontainer, MCP servers, workflow templates, et helpers | ~8 stories       |
| **Epic 2** | Notebooks Pédagogiques    | Créer la séquence de notebooks propre (00-06) en nettoyant le chaos actuel, avec progression claire et checkpoints  | ~8 stories       |

### Détail des Epics

**Epic 1: Infrastructure Playground**

- Devcontainer avec Deno + Jupyter + extensions VS Code
- Config MCP pré-faite avec 3 servers Tier 1 (filesystem, memory, sequential-thinking)
- Workflow templates pré-configurés (`playground/config/workflow-templates.yaml`)
- Script de setup qui détecte/configure la clé API LLM
- Helper d'init idempotent (`ensurePlaygroundReady()`)
- Helper pour rendu Mermaid (Kroki ou natif)
- Helper pour métriques visuelles (ASCII bars, tables)
- README playground avec "Open in Codespace" badge

**Epic 2: Notebooks Pédagogiques**

- 00-introduction : Vue d'ensemble, vérification environnement
- 01-the-problem : Démonstration context explosion + latency
- 02-context-optimization : Vector search, chargement à la demande
- 03-dag-execution : Parallélisation, visualisation graphe
- 04-sandbox-security : Worker RPC Bridge, exécution isolée avec tracing natif des tool calls
- 05-capability-learning : Comment les capabilities émergent de l'exécution (eager learning)
- 06-emergent-reuse : Réutilisation de code prouvé, Suggestion Engine, capability injection
- Nettoyage des anciens notebooks (archivage ou suppression)

> **Note:** Detailed epic breakdown with full story specifications is available in
> [epics-playground.md](./epics-playground.md)

---

## Out of Scope

**Fonctionnalités exclues:**

- **Repo séparé** - Pour l'instant, reste dans Casys PML (migration JSR plus tard)
- **UI web custom** - Pas de dashboard ou interface au-delà de Jupyter
- **Notebooks avancés (07+)** - Speculative execution avancée, adaptive workflows → phase 2
- **Tests automatisés des notebooks** - Validation manuelle pour le MVP
- **Internationalisation** - Notebooks en anglais uniquement (audience dev internationale)

**MCP Servers inclus (Tier 1 - sans clé API):**

- `@modelcontextprotocol/server-filesystem` - Parallélisation fichiers
- `@modelcontextprotocol/server-memory` - Knowledge graph local
- `@modelcontextprotocol/server-sequential-thinking` - Branchement DAG

**MCP Servers exclus du MVP (Tier 2-3 - optionnels):**

- `mcp-server-git` - Pourrait être ajouté si utile
- `mcp-server-time` - Démos simples mais pas essentielles
- `mcp-server-sqlite` - Persistance avancée
- `mcp-server-fetch` - I/O bound, nécessite URLs externes
- `@zrald/graph-rag-mcp-server` - GraphRAG natif, overkill pour pédagogie
- **MCP servers avec clé API** - GitHub, Slack, etc. (l'utilisateur peut les ajouter)

**Authentification:**

- Clé API LLM en variable d'environnement uniquement (pas de système auth complexe)

**Hors périmètre technique:**

- **Support Python** - Deno/TypeScript uniquement
- **Jupyter Lab standalone** - Focus sur VS Code Jupyter extension
- **Offline mode** - Nécessite connexion pour LLM et potentiellement Kroki

**Inclus mais pas documenté en détail:**

- **Workflow Templates (5.2)** - Le notebook GraphRAG montrera comment définir des templates YAML et
  les charger via `pml workflows sync`
