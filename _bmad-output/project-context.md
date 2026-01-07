---
project_name: "Procedural Memory Layer (PML)"
user_name: "Erwan"
date: "2025-12-21"
sections_completed: [
  "technology_stack",
  "language_rules",
  "framework_rules",
  "testing_rules",
  "code_quality",
  "workflow_rules",
  "critical_rules",
  "hypergraph_algorithms",
  "minitools",
  "adaptive_learning",
  "clean_architecture",
  "dependency_injection",
  "jsr_package_routing",
]
status: complete
last_scan: "exhaustive"
last_update: "2026-01-07"
rule_count: 215
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in
this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

### Runtime & Language

- **Deno 2.x** — Runtime principal (pas Node.js)
- **TypeScript** — Strict mode obligatoire

### Frontend

- **Fresh ^2.0.0** — Framework web Deno (SSR)
- **Preact ^10.27.0** — Bibliothèque UI (pas React)
- **@preact/signals ^2.5.1** — State management réactif
- **TailwindCSS ^4.1.10** — Styling (v4 syntax)
- **Vite ^7.1.3** — Build tool

### Backend & Data

- **PGlite 0.3.14** — PostgreSQL WASM (local-first, dev/embedded)
- **PostgreSQL 16+** — Via Docker pour production/cloud
- **Deno KV** — Key-value store pour sessions, cache, OAuth tokens
- **Drizzle ORM ^0.39.1** — TypeScript ORM
- **@huggingface/transformers 3.7.6** — Embeddings BGE-M3 locaux
- **Architecture Open Core** — Version cloud en préparation (multi-tenant ready)

### MCP & Graphes

- **@modelcontextprotocol/sdk ^1.15.1** — Protocole MCP (Anthropic)
- **@smithery/sdk ^2.1.0** — Registry MCP servers
- **Graphology ^0.25.4** — Structure de graphe
- **ml-matrix ^6.11.1** — Opérations matricielles (eigendecomposition)

### Graph Algorithms (Non-SHGAT)

> **Note:** Ces algos sont utilisés pour clustering, suggestions, local-alpha — **PAS** pour le
> scoring SHGAT K-head.

- **Spectral Clustering** — `src/graphrag/spectral-clustering.ts` — dag-suggester, clustering
- **PageRank** — `src/graphrag/graph-engine.ts` — Centralité, metrics
- **Adamic-Adar** — `src/graphrag/algorithms/adamic-adar.ts` — Suggestions, confidence scoring
- **Louvain** — via graphology-communities-louvain — Community detection
- **Heat Diffusion** — `src/graphrag/local-alpha.ts` — Local alpha adaptif (ADR-048)
- **Thompson Sampling** — `src/learning/thompson-threshold.ts` — Thresholds adaptatifs (ADR-049)
- **K-means++** — Clustering sur vecteurs propres
- **Dijkstra** — via graphology-shortest-path

### SHGAT Modular Architecture (`src/graphrag/algorithms/shgat/`)

- **graph/** — Construction de graphe, matrices d'incidence
- **initialization/** — Initialisation des paramètres (W_q, W_k per head)
- **message-passing/** — Phases V→E, E→E, E→V pour n-SuperHyperGraph
- **scoring/** — K-head attention unifié (capabilities, tools, operations)
- **training/** — K-head trainer avec backprop sur W_q, W_k
- **utils/** — Softmax, cosine similarity, opérations matricielles
- **Production** — K-head: `score = sigmoid(Q·K/√d)`, fusion = moyenne

### MiniTools Library (`lib/std/`)

- **120+ outils internes** — Organisés en 30+ modules thématiques
- **MiniToolsClient** — Classe d'accès unifiée aux mini-tools
- **Catégories System** — docker, git, network, process, archive, ssh, kubernetes, database, media,
  cloud, sysinfo, packages, text
- **Catégories Data** — algo, collections, crypto, datetime, format, http, json, math, transform,
  validation, vfs
- **Nouveaux modules** — string, path, faker, color, geo, qrcode, resilience, schema, diff

### Compilation & Communication

- **SWC** — via Deno, compilation TS + parsing AST (remplace ts-morph)
- **Broadcast Channel** — Communication inter-workers (sandbox ↔ main)
- **SSE** — Server-Sent Events pour dashboard temps réel

### CLI & Utils

- **@cliffy/command 1.0.0-rc.8** — CLI framework
- **@std/assert, @std/dotenv, @std/fs, @std/yaml** — Deno std lib

### Configuration Files (`config/`)

- **dag-scoring.yaml** — Scoring, thresholds, weights, reliability (ADR-022, 026, 038, 048)
- **local-alpha.yaml** — Alpha adaptatif, cold start, heat diffusion (ADR-048)
- **spectral-clustering.yaml** — Clustering biparti, edge weights, PageRank (Story 7.4, ADR-042)
- **mcp-permissions.yaml** — Permissions et risk categories MCP servers (ADR-035)
- **workflow-templates.yaml** — Templates de workflows DAG
- **speculation_config.yaml** — Config spéculation legacy (supplanté par ADR-049)

### Version Constraints

- **Preact, pas React** — JSX doit utiliser `jsxImportSource: "preact"`
- **TailwindCSS v4** — Syntaxe différente de v3
- **PGlite 0.3.14** — Version spécifique pour compatibilité vector extension (dev/embedded)
- **PostgreSQL 16+ (Docker)** — Production, supporte pgvector nativement

---

## Critical Implementation Rules

### Language-Specific Rules (TypeScript/Deno)

#### Configuration TypeScript

- **Strict mode obligatoire** — `strict: true`, `noImplicitAny: true`
- **Pas de variables inutilisées** — `noUnusedLocals: true`, `noUnusedParameters: true`
- **JSX Preact** — `jsx: "react-jsx"`, `jsxImportSource: "preact"`

#### Imports & Modules

- **Imports JSR** — `@std/*` pour la bibliothèque standard Deno (ex: `@std/assert`)
- **Imports NPM** — Préfixe `npm:` pour packages npm (ex: `npm:graphology`)
- **Extensions obligatoires** — Toujours `.ts` dans les imports (ex: `./utils.ts`)
- **Pas de CommonJS** — Utiliser ESM uniquement (`import/export`)

#### Databases (Dual-Mode)

- **PGlite / PostgreSQL** — PGlite (dev/embedded) ou PostgreSQL Docker (prod) pour données
  persistantes (GraphRAG, capabilities, workflows)
- **Deno KV** — Key-value store pour sessions, cache, OAuth tokens
- **Architecture Open Core** — Version cloud en préparation, garder le code compatible multi-tenant

#### Async/Await Patterns

- **Toujours async/await** — Pas de `.then()/.catch()` chaînés
- **Top-level await supporté** — Deno supporte nativement
- **Gestion d'erreurs** — `try/catch` avec types d'erreur explicites

#### Naming Conventions

- **camelCase** pour variables, fonctions, propriétés d'objets
- **PascalCase** pour types, interfaces, classes
- **SCREAMING_SNAKE_CASE** pour constantes globales
- **kebab-case** pour noms de fichiers (ex: `health-checker.ts`)

#### Error Handling

- **Classes d'erreur custom** dans `src/errors/` — Utiliser `CAIError`, `ValidationError`, etc.
- **Pas de `any` dans les catch** — Typer les erreurs explicitement
- **Logging structuré** — Utiliser `src/telemetry/logger.ts`

### Framework-Specific Rules

#### Fresh 2.0 (SSR Framework)

- **Routes dans `src/web/routes/`** — Convention de fichiers pour routing
- **Middleware** — `_middleware.ts` pour auth et guards
- **Islands architecture** — Composants interactifs isolés pour hydratation partielle
- **API routes** — `routes/api/` pour endpoints REST

#### Preact (UI Library)

- **Pas de React** — Utiliser `preact` et `preact/hooks`, jamais `react`
- **Signals pour state** — `@preact/signals` au lieu de useState pour state global
- **JSX runtime** — Configuré via `jsxImportSource: "preact"` dans deno.json
- **Hooks identiques** — `useState`, `useEffect`, etc. fonctionnent comme React

#### MCP Gateway (Meta-Tools Pattern)

- **Meta-tools uniquement** — Exposer `pml:search_tools`, `pml:execute_dag`, etc.
- **Pas de proxy direct** — Ne jamais exposer les outils MCP sous-jacents directement
- **DAG workflows** — Orchestration parallèle avec résolution de dépendances
- **Intent-based execution** — Support des workflows par intention naturelle

#### GraphRAG Engine

- **Graphology** — Structure de graphe en mémoire
- **Adamic-Adar** — Algorithme pour recommandations d'outils
- **Louvain communities** — Clustering pour suggestions proactives
- **PageRank** — Sizing des nœuds dans la visualisation

#### Sandbox Execution

- **Worker isolé** — Code exécuté dans subprocess Deno
- **Permissions limitées** — Pas de réseau, pas de subprocess
- **PII detection** — Tokenisation automatique des données sensibles
- **MCP tool injection** — Outils injectés via intent discovery

#### MiniTools Pattern (`lib/std/`)

- **Import depuis lib/std/mod.ts** —
  `import { MiniToolsClient, getToolByName } from "../../lib/std/mod.ts"`
- **Client par catégorie** — `new MiniToolsClient({ categories: ["json", "crypto"] })`
- **Exécution typée** — `await client.execute("json_parse", { input: data })`
- **Format MCP** — `client.toMCPFormat()` pour exposition via gateway
- **Handler pattern** — Chaque tool a `name`, `description`, `inputSchema`, `handler`

#### Externalized Configuration (`config/`)

- **dag-scoring.yaml** — TOUTES les constantes de scoring externalisées
- **Pas de magic numbers** — Utiliser `DagScoringConfig.load()` pour accéder aux valeurs
- **Sections YAML** — `limits`, `weights`, `thresholds`, `caps`, `reliability`, `defaults`
- **Hot reload supporté** — Config rechargeable sans restart

#### Adaptive Learning (ADR-048, ADR-049)

- **Local Alpha** — Confiance locale par zone du graphe (0.5 dense → 1.0 cold start)
- **Thompson Sampling** — Distribution Beta(α,β) per-tool pour thresholds
- **Risk Categories** — `safe` (0.55), `moderate` (0.70), `dangerous` (0.85)
- **mcp-permissions.yaml** — Source de vérité pour classification risque

### Testing Rules

#### Test Framework

- **Deno.test natif** — Pas Jest, pas Vitest
- **@std/assert** — `assertEquals`, `assertThrows`, `assertRejects`, etc.
- **Async tests** — Support natif des tests async/await

#### Test Organization

- **Tests unitaires** — `tests/unit/` miroir de `src/`
- **Tests d'intégration** — `tests/integration/`
- **Nommage** — `*_test.ts` (underscore, pas hyphen)
- **Structure** — `Deno.test("description", async () => { ... })`

#### Test Patterns

- **Isolation** — Chaque test doit être indépendant
- **Mocks dans `tests/mocks/`** — Filesystem, database, API mocks disponibles
- **Cleanup** — Toujours nettoyer les ressources (DB, fichiers temp)
- **Assertions explicites** — Pas de tests sans assertions

#### Running Tests

- `deno task test` — Tous les tests
- `deno task test:unit` — Tests unitaires seulement
- `deno task test:integration` — Tests d'intégration
- **Flags requis** —
  `--allow-all --unstable-worker-options --unstable-broadcast-channel --unstable-kv`

#### Coverage Target

- **>80% coverage** — Objectif de couverture
- **Tests critiques obligatoires** — DAG executor, sandbox, MCP gateway

### Code Quality & Style Rules

#### Formatting (deno fmt)

- **Largeur ligne** — 100 caractères max
- **Indentation** — 2 espaces (pas de tabs)
- **Point-virgule** — Obligatoire
- **Commande** — `deno task fmt`

#### Linting (deno lint)

- **Rules** — Tag `recommended` activé
- **Exclusions** — `tests/integration/`, `tests/e2e/`, `tests/load/`, `tests/memory/`
- **Commande** — `deno task lint`

#### File Organization

- **src/** — Code source principal
- **src/dag/** — DAG executor et workflows
- **src/graphrag/** — GraphRAG engine
- **src/sandbox/** — Exécution sécurisée
- **src/mcp/** — Gateway MCP
- **src/web/** — Dashboard Fresh/Preact
- **src/db/** — Migrations et schémas Drizzle
- **src/telemetry/** — Logging et métriques
- **src/learning/** — Thompson Sampling, adaptive thresholds
- **lib/std/** — MiniTools library (120+ outils)
- **config/** — Configuration externalisée (YAML)

#### Documentation

- **JSDoc minimal** — Seulement pour exports publics complexes
- **Pas de commentaires évidents** — Le code doit être auto-explicatif
- **ADRs** — Décisions architecturales dans `docs/adrs/`
- **Stories** — Artifacts de sprint dans `docs/sprint-artifacts/`

#### Code Patterns

- **Single responsibility** — Une fonction = une tâche
- **Explicit returns** — Typage explicite des retours de fonctions
- **No magic strings** — Utiliser des constantes ou enums
- **Immutability preferred** — `const` par défaut, éviter mutations

### Architecture Patterns

#### Service Layer Separation (3-Tier)

Strict separation entre handlers (API), services (business logic), et repositories (data).

```
Handler (MCP/HTTP) → Service (Business Logic) → Repository (Data Access)
      ↓                      ↓                         ↓
  Validation          Orchestration              SQL/Queries
  Formatting          Domain Logic               Row Mapping
  Routing             Event Emission             Transactions
```

**Règles:**

- **Handlers** (`src/mcp/handlers/`): Validation input, appel services, formatage output
- **Services** (`src/*/`): Business logic, pas d'accès DB direct, utilise repositories
- **Repositories** (`*-store.ts`, `*-repository.ts`): Data access only, pas de business logic

#### Repository Pattern for Data Access

Toutes les opérations DB passent par des classes repository. Pas de SQL direct dans handlers ou
services.

**Règles:**

- **Repository files** en `*-store.ts` ou `*-repository.ts`
- **Single table/aggregate per repository**
- **Return domain objects**, pas raw rows
- **No business logic** dans repositories — pure CRUD + queries

```typescript
// GOOD - Service utilise repository
class CapabilityService {
  constructor(private store: CapabilityStore) {}
  async execute(name: string): Promise<Result> {
    const cap = await this.store.findByName(name);
    // business logic here
  }
}

// BAD - Handler fait du SQL direct
async function handleExecute(args, deps) {
  const rows = await deps.db.query("SELECT * FROM..."); // ❌
}
```

#### Interface-First Design

Définir interfaces avant implémentations, surtout pour les boundaries cross-module.

**Règles:**

- **Interfaces** dans `types.ts` ou `interfaces.ts` dédié
- **Implementations** importent interfaces, pas classes concrètes
- **Tests** peuvent mocker les interfaces facilement

```typescript
// src/mcp/capability-server/interfaces.ts
export interface CapabilityExecutor {
  execute(name: string, args: Record<string, unknown>): Promise<ExecuteResult>;
}

// src/mcp/capability-server/server.ts - utilise l'interface
export class CapabilityMCPServer {
  constructor(private executor: CapabilityExecutor) {}
}
```

#### Constructor Injection (Max 5 Dependencies)

Injection de dépendances via constructeur avec limite stricte.

**Règles:**

- **JAMAIS plus de 5 paramètres** dans un constructeur
- Si plus → refactoriser en services composés
- **JAMAIS créer services avec `new`** dans le code métier — utiliser composition

```typescript
// BAD - 10 paramètres = God class
constructor(db, vectorSearch, graphEngine, dagSuggester, executor, mcpClients,
            capabilityStore, thresholdManager, config, embeddingModel) {}

// GOOD - Services composés (max 5)
constructor(
  private toolRouter: ToolRouter,
  private algorithmManager: AlgorithmManager,
  private healthService: HealthService,
) {}
```

#### Feature Module Pattern (Vertical Slices)

Grouper fonctionnalités par feature, pas par layer technique.

**Structure recommandée:**

```
src/
  capabilities/           # Feature: Capability Management
    mod.ts               # Public API exports
    types.ts             # Domain types
    capability-store.ts  # Repository
    capability-service.ts # Business logic

  mcp/
    capability-server/   # Feature: Capability MCP Server
      mod.ts             # Public exports
      interfaces.ts      # Contracts
      server.ts          # Main class
      handlers/          # MCP handlers
```

**Règles:**

- Chaque feature folder est self-contained
- `mod.ts` exporte API publique uniquement
- Communication cross-feature via interfaces

### Clean Architecture & Dependency Injection (Epic 14 Refactor)

#### Structure 3 Couches

```
src/
├── domain/
│   └── interfaces/          # Contrats purs (I*Repository, I*Executor)
│
├── application/
│   └── use-cases/           # Business operations
│       ├── shared/          # UseCaseResult<T>, UseCaseError
│       ├── code/            # ExecuteCodeUseCase
│       ├── capabilities/    # SearchCapabilitiesUseCase, GetSuggestionUseCase
│       ├── workflows/       # AbortWorkflowUseCase, ReplanWorkflowUseCase
│       └── discover/        # DiscoverCapabilities, DiscoverTools
│
├── infrastructure/
│   ├── di/
│   │   ├── container.ts     # DI container (diod)
│   │   ├── bootstrap.ts     # Production wiring
│   │   ├── testing.ts       # Test mocks
│   │   └── adapters/        # Wrap implementations
│   │
│   └── patterns/            # Builder, Factory, Visitor, Strategy, Template Method
```

#### Dependency Injection (diod)

- **Abstract class tokens** — Interfaces TS effacées au runtime, utiliser abstract classes
- **Container singleton** — `buildContainer()` construit une fois, injecte partout
- **Adapters pattern** — Wrap des implémentations existantes dans `di/adapters/`
- **Bootstrap** — `bootstrapDI()` pour wiring production
- **Testing** — `buildTestContainer()` + `createMock*()` helpers

**Tokens DI Disponibles:**

| Token | Interface | Description |
|-------|-----------|-------------|
| `CapabilityRepository` | `ICapabilityRepository` | Stockage capabilities |
| `DAGExecutor` | `IDAGExecutor` | Exécution DAG |
| `GraphEngine` | `IGraphEngine` | GraphRAG engine |
| `MCPClientRegistry` | `IMCPClientRegistry` | Registry clients MCP |
| `StreamOrchestrator` | `IStreamOrchestrator` | Orchestration streaming |
| `DecisionStrategy` | `IDecisionStrategy` | Stratégie AIL/HIL |

#### Use Cases Pattern

- **Request/Result typés** — `UseCaseResult<T>` avec `success`, `data?`, `error?`
- **Transport-agnostic** — Pas de dépendance HTTP/MCP
- **Interface-based deps** — Toutes deps via interfaces (`ISandboxExecutor`, `IToolDiscovery`)
- **Nommage** — `XxxUseCase` avec méthode `execute(request): Promise<UseCaseResult<T>>`
- **Jamais throw** — Retourner `{ success: false, error: { code, message } }`

```typescript
// Pattern canonical
class ExecuteCodeUseCase {
  constructor(deps: ExecuteCodeDependencies) {}

  async execute(request: ExecuteCodeRequest): Promise<UseCaseResult<ExecuteCodeResult>> {
    if (!request.code) {
      return { success: false, error: { code: "MISSING_CODE", message: "..." } };
    }
    // orchestration logic
    return { success: true, data: result };
  }
}
```

#### Design Patterns Implémentés (`infrastructure/patterns/`)

| Pattern | Module | Usage |
|---------|--------|-------|
| **Builder** | `patterns/builder/` | `GatewayBuilder` construction fluente |
| **Factory** | `patterns/factory/` | `GatewayFactory` création centralisée |
| **Visitor** | `patterns/visitor/` | `ASTVisitor` traversée SWC |
| **Strategy** | `patterns/strategy/` | `DecisionStrategy` AIL/HIL |
| **Template Method** | `patterns/template-method/` | `LayerExecutionTemplate` |

#### Règles DI Critiques

- **JAMAIS `new Service()` direct** — Via container ou factory
- **Abstract class = Token** — `container.get(CapabilityRepository)` pas `I*`
- **Handlers → Use Cases** — Les handlers MCP/HTTP délèguent aux use cases
- **Interfaces dans domain/** — Implémentations dans modules concrets

### JSR Package & MCP Routing (Epic 14)

#### Terminologie Routing

- **client** — Exécution sur machine utilisateur (filesystem, docker, ssh, git)
- **server** — Exécution sur pml.casys.ai (json, math, tavily, pml:*)
- **Config source** — `config/mcp-routing.json` (jamais de fallback hardcodé)
- **Default** — `"client"` pour outils inconnus (sécurité)

#### Modes de Distribution

| Mode | Description | Status |
|------|-------------|--------|
| **A (Toolkit)** | Meta-tools uniquement (`pml stdio`) | ✅ Ready |
| **B (Standalone)** | Capability directe (`pml add/run namespace.action`) | ✅ Ready |
| **C (Hybrid)** | Meta-tools + curated caps dynamiques | ⚠️ BLOQUÉ (#4118) |

#### HIL Approval Flow (Stdio Mode)

- **Retourner `approval_required: true`** + `workflow_id` — Pas `await hilCallback()`
- **Jamais bloquer stdin** — stdin = JSON-RPC, pas user input
- **Claude UI** — User voit [Continue] [Always] [Abort]
- **Continuation** — Via `continue_workflow: { workflow_id, approved, always }`
- **Expiration** — 5 minutes timeout sur workflows en attente

#### Naming Convention

| Context | Format | Example |
|---------|--------|---------|
| FQDN (registry) | dots | `casys.pml.filesystem.read_file` |
| Tool name (Claude) | colon | `filesystem:read_file` |
| Code TS | dots + prefix | `mcp.filesystem.read_file()` |

#### BYOK (Bring Your Own Key)

- **Local execution** — Clés lues depuis `.env` (TAVILY_API_KEY, etc.)
- **Cloud execution** — Clés stockées dans profil pml.casys.ai/settings
- **One-shot usage** — Clés jamais stockées en logs côté cloud

### Development Workflow Rules

#### Git Conventions

- **Branch main** — Branche principale de production
- **Commits atomiques** — Un commit = une unité logique de changement
- **Messages descriptifs** — Préfixe type: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`

#### Development Commands

- `deno task dev` — Serveur API (port 3003)
- `deno task dev:fresh` — Dashboard Vite (port 8081)
- `deno task check` — Type checking
- `deno task fmt && deno task lint` — Avant commit

#### Production Deployment

- **Systemd services** — `casys-dashboard`, `casys-api`
- `deno task prod:start` — Démarrer les services
- `deno task deploy:all` — Pull, build, restart

#### CLI Usage

- `deno task cli init` — Initialisation (discover MCPs, embeddings)
- `deno task cli status` — Vérification santé
- `deno task cli workflows` — Gestion des workflows

#### ADR Process

- **Nouvelle décision** — Créer `docs/adrs/ADR-XXX-description.md`
- **Numérotation séquentielle** — Incrémenter depuis le dernier ADR
- **Format** — Context, Decision, Consequences

#### Sprint Artifacts

- **Stories** — `docs/sprint-artifacts/story-X.Y.md`
- **Tech specs** — `docs/sprint-artifacts/tech-spec-*.md`
- **Rétrospectives** — `docs/retrospectives/`

### Critical Don't-Miss Rules

#### ⚠️ Anti-Patterns à Éviter

- **JAMAIS React** — Utiliser Preact uniquement, imports `preact` pas `react`
- **JAMAIS CommonJS** — Pas de `require()`, ESM uniquement
- **JAMAIS node_modules direct** — Préfixe `npm:` obligatoire
- **JAMAIS snake_case** — camelCase pour propriétés (refactoring récent)
- **JAMAIS proxy MCP direct** — Exposer meta-tools, pas les outils sous-jacents
- **JAMAIS magic numbers** — Utiliser `config/*.yaml` et `DagScoringConfig.load()`
- **JAMAIS hardcode thresholds** — Tous externalisés dans `dag-scoring.yaml` ou `local-alpha.yaml`

#### 🔒 Sécurité

- **Sandbox isolation** — Code utilisateur dans worker isolé
- **PII detection** — Activer tokenisation par défaut
- **Pas de secrets en code** — Utiliser `.env` et `@std/dotenv`
- **Permissions Deno explicites** — `--allow-read`, `--allow-net`, etc.

#### 🎯 Patterns Critiques

- **camelCase everywhere** — Events, state, API responses (refactoring récent appliqué)
- **Async/await obligatoire** — Pas de callbacks ou .then() chains
- **Extensions .ts dans imports** — Deno requiert extensions explicites
- **Type safety** — `strict: true`, pas de `any` sauf cas documenté

#### 🗄️ Base de Données

- **PGlite / PostgreSQL Docker** — PGlite (dev), PostgreSQL 16+ Docker (prod)
- **Deno KV pour sessions** — OAuth, cache, tokens
- **Migrations Drizzle** — `src/db/migrations/` numérotées séquentiellement
- **Multi-tenant ready** — Préparer pour version cloud

#### 📊 Observabilité

- **Sentry pour erreurs** — Si `SENTRY_DSN` configuré
- **Logger structuré** — `src/telemetry/logger.ts`
- **SSE events** — Real-time updates via `src/server/events-stream.ts`
- **Métriques** — Success rate, latency, graph density trackés

#### 🔄 DAG Execution

- **AIL (Agent-in-the-Loop)** — Décisions automatiques avec validation par layer
- **HIL (Human-in-the-Loop)** — Checkpoints d'approbation **PRE-EXECUTION** (pas après)
- **Checkpoint/Resume** — Workflows interruptibles avec persistence d'état
- **$OUTPUT resolution** — Référencer outputs des tasks précédentes
- **Two-Level DAG (Phase 2a)** — Logical DAG (SHGAT learning) + Physical DAG (fused execution)
- **Sequential Fusion** — Tasks pures sans MCP calls fusionnées automatiquement
- **Option B Nested Ops** — `executable: false` pour opérations inside callbacks (.map, .filter)

#### 🛠️ MiniTools (`lib/std/`)

- **Import centralisé** — `import { ... } from "../../lib/std/mod.ts"`
- **MiniToolsClient** — Classe standard pour accès aux 120+ outils
- **Handler pattern** — `{ name, description, inputSchema, handler }`
- **Categories filtering** — `new MiniToolsClient({ categories: ["json", "crypto"] })`

#### ⚙️ Configuration Externalisée

- **DagScoringConfig** — `import { DagScoringConfig } from "./dag-scoring-config.ts"`
- **LocalAlphaConfig** — `import { LocalAlphaConfig } from "./local-alpha-config.ts"`
- **Sections YAML** — `limits`, `weights`, `thresholds`, `caps`, `reliability`, `defaults`
- **Schémas JSON** — `*.schema.json` pour validation (yaml-language-server)

#### 📈 Adaptive Learning (ADR-048, ADR-049, ADR-053)

- **Local Alpha** — `alpha ∈ [0.5, 1.0]` — 0.5 = trust graph, 1.0 = semantic only
- **Heat Diffusion** — Propagation de confiance par connectivité graphe
- **Cold Start** — Bayesian prior `Beta(1,1)` → target après `threshold` observations
- **Thompson Sampling** — Distribution `Beta(α,β)` per-tool pour thresholds adaptatifs
- **Risk Categories** — `safe` (0.55), `moderate` (0.70), `dangerous` (0.85) via
  `mcp-permissions.yaml`
- **SHGAT Subprocess Training** — Entraînement non-bloquant via subprocess Deno
- **PER (Prioritized Experience Replay)** — TD errors pour échantillonnage prioritaire

#### 🔀 Dynamic Capability Routing (ADR-052)

- **Résolution statique** — Capabilities découvertes à l'analyse SWC, pas au runtime
- **Proxy transparent** — `mcp.math.sum()` route vers capability `math:sum`
- **Isolation ré-entrance** — Nouveau WorkerBridge par appel de capability

---

## Usage Guidelines

**For AI Agents:**

- Read this file before implementing any code
- Follow ALL rules exactly as documented
- When in doubt, prefer the more restrictive option
- Reference ADRs for architectural decisions rationale

**For Humans:**

- Keep this file lean and focused on agent needs
- Update when technology stack changes
- Review after each epic completion
- Remove rules that become obvious over time

---

_Last Updated: 2026-01-07_
