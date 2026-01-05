# Architecture Overview - Casys PML

_Generated: 2025-12-31_

## Executive Summary

**Casys PML (Procedural Memory Layer)** est une couche mémoire pour agents IA qui capture les workflows et les cristallise en compétences réutilisables.

### Problèmes Résolus

1. **Context Saturation** — Les schémas d'outils consomment 30-50% de la fenêtre de contexte LLM
2. **Sequential Latency** — Les workflows multi-outils s'exécutent séquentiellement

### Solution

PML expose des meta-tools intelligents au lieu de proxier tous les outils :

| Tool | Description |
|------|-------------|
| `pml_discover` | Recherche hybride sémantique + graph |
| `pml_execute` | Exécution de workflows (intent ou DAG explicite) |

**Résultat** : Utilisation du contexte < 5%. Tâches indépendantes en parallèle.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                     PRESENTATION LAYER                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Fresh Web  │  │  CLI (pml)  │  │  MCP API    │              │
│  │  Dashboard  │  │  Cliffy     │  │  Hono       │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                     APPLICATION LAYER                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Use Cases                             │    │
│  │  - DiscoverCapabilities  - ExecuteWorkflow               │    │
│  │  - CreateCapability      - SearchTools                   │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                      DOMAIN LAYER                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Capability  │  │  Workflow   │  │    Tool     │              │
│  │   Entity    │  │   Entity    │  │   Entity    │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                 Domain Services                          │    │
│  │  - CapabilityMatcher  - DAGBuilder  - SecurityValidator │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                   INFRASTRUCTURE LAYER                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Database   │  │    MCP      │  │  External   │              │
│  │  PGlite/PG  │  │  Clients    │  │   APIs      │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Subsystems

### 1. MCP Gateway

Point d'entrée principal pour les agents LLM.

```
┌─────────────────────────────────────────────────────────────────┐
│                       MCP Gateway                                │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                      Handlers                            │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │    │
│  │  │ Discover │  │ Execute  │  │ Workflow │               │    │
│  │  │ Handler  │  │ Handler  │  │ Handler  │               │    │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘               │    │
│  └───────┼─────────────┼─────────────┼─────────────────────┘    │
│          │             │             │                           │
│  ┌───────▼─────────────▼─────────────▼─────────────────────┐    │
│  │                  Connection Pool                         │    │
│  │   stdio → MCP Clients (filesystem, memory, etc.)        │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

**Responsabilités:**
- Routage des requêtes MCP
- Gestion des connexions aux MCP servers
- Agrégation des résultats

### 2. GraphRAG Engine

Moteur de recherche hybride sémantique + graph.

```
┌─────────────────────────────────────────────────────────────────┐
│                      GraphRAG Engine                             │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Algorithms                            │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │    │
│  │  │  SHGAT   │  │  DR-DSP  │  │ Thompson │  │ Louvain  │ │    │
│  │  │ K-heads  │  │ Hyperpath│  │ Sampling │  │ Clusters │ │    │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│  ┌───────────────────────────▼─────────────────────────────┐    │
│  │                   Graph Store                            │    │
│  │   Graphology (in-memory) + PostgreSQL (persistence)     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

**Algorithmes Clés:**

| Algorithme | Purpose | ADR |
|------------|---------|-----|
| **SHGAT** | Spectral Hypergraph Attention Network (scoring) | ADR-042 |
| **DR-DSP** | Directed Hypergraph Shortest Path (pathfinding) | ADR-038 |
| **Thompson** | Adaptive thresholds via Thompson Sampling | ADR-043 |
| **Louvain** | Community detection for tool clustering | - |
| **Adamic-Adar** | Link prediction / similarity | - |

### 3. DAG Execution Engine

Exécution parallèle de workflows avec checkpoints.

```
┌─────────────────────────────────────────────────────────────────┐
│                    DAG Execution Engine                          │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              ControlledExecutor                          │    │
│  │                                                          │    │
│  │  Layer 0    Layer 1    Layer 2    Layer 3               │    │
│  │  ┌─────┐   ┌─────┐    ┌─────┐    ┌─────┐               │    │
│  │  │ T1  │   │ T2  │    │ T4  │    │ T5  │               │    │
│  │  └──┬──┘   │ T3  │    └──┬──┘    └─────┘               │    │
│  │     │      └──┬──┘       │                              │    │
│  │     │         │          │                              │    │
│  │  ───┴─────────┴──────────┴───────────────► Time         │    │
│  │                                                          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│  ┌───────────────────────────▼─────────────────────────────┐    │
│  │                 DAG Optimizer                            │    │
│  │   Task Fusion | Sequential → Parallel | Checkpoint      │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

**Features:**
- Exécution par couches (layer-based parallelism)
- Optimisation par fusion de tâches séquentielles
- Checkpointing pour reprise
- Per-layer validation (Human-in-the-Loop)

### 4. Sandbox System

Exécution sécurisée de code utilisateur.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Sandbox System                              │
│                                                                  │
│  ┌─────────────────┐              ┌─────────────────────────┐   │
│  │   Main Thread   │              │    Sandbox Worker       │   │
│  │                 │    RPC       │    (Deno subprocess)    │   │
│  │  WorkerBridge   │◄────────────►│                         │   │
│  │                 │              │  ┌─────────────────┐    │   │
│  │  - callTool()   │              │  │ Security Layer  │    │   │
│  │  - execute()    │              │  │ - PII Detection │    │   │
│  │                 │              │  │ - Resource Limit│    │   │
│  └─────────────────┘              │  └─────────────────┘    │   │
│                                   └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Security Features:**
- Zero-permission par défaut
- PII detection automatique
- Resource limits (CPU, memory, time)
- Isolated subprocess (no shared state)

### 5. Capability System

Stockage et matching de capabilities apprises.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Capability System                            │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                  CapabilityStore                         │    │
│  │                                                          │    │
│  │  ┌──────────────┐    ┌──────────────┐                   │    │
│  │  │ workflow_    │    │ capability_  │                   │    │
│  │  │ pattern      │───▶│ records      │                   │    │
│  │  │ (code, DAG)  │    │ (naming,FQDN)│                   │    │
│  │  └──────────────┘    └──────────────┘                   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│  ┌───────────────────────────▼─────────────────────────────┐    │
│  │              StaticStructureBuilder                      │    │
│  │   SWC AST Analysis → Static DAG Structure               │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

**Naming Convention (FQDN):**
```
<org>.<project>.<namespace>.<action>.<hash>
└─────────────────────────────────────────┘
        local.default.fs.read_json.a7f3
```

---

## Data Flow

### Discovery Flow

```
User Intent: "read JSON config files"
           │
           ▼
    ┌─────────────┐
    │ pml_discover│
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │ VectorSearch│ ─── BGE-M3 Embeddings (1024-dim)
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │  GraphRAG   │ ─── SHGAT scoring + DR-DSP pathfinding
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │  Results    │ ─── Unified score = semantic × reliability
    └─────────────┘
```

### Execution Flow

```
pml_execute({ intent, code })
           │
           ▼
    ┌─────────────┐
    │ Static      │ ─── SWC AST analysis
    │ Analysis    │
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │ DAG         │ ─── Build logical DAG
    │ Conversion  │
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │ DAG         │ ─── Fuse sequential tasks
    │ Optimizer   │
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │ Controlled  │ ─── Execute layers in parallel
    │ Executor    │
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │ Capability  │ ─── Save with trace data
    │ Store       │
    └─────────────┘
```

---

## Database Schema (Simplified)

```sql
-- Core capability storage
workflow_pattern (
  pattern_id UUID PRIMARY KEY,
  code_snippet TEXT,
  code_hash VARCHAR(64) UNIQUE,
  dag_structure JSONB,
  intent_embedding VECTOR(1024),
  success_rate FLOAT,
  usage_count INT
)

-- Naming and FQDN
capability_records (
  id VARCHAR(255) PRIMARY KEY,  -- FQDN
  org VARCHAR(100),
  project VARCHAR(100),
  namespace VARCHAR(100),
  action VARCHAR(100),
  workflow_pattern_id UUID REFERENCES workflow_pattern,
  hash VARCHAR(8)
)

-- Execution traces (for learning)
execution_trace (
  id SERIAL PRIMARY KEY,
  workflow_pattern_id UUID,
  executed_path TEXT[],
  task_results JSONB,
  intent_embedding VECTOR(1024),
  success BOOLEAN,
  duration_ms INT
)

-- Tool graph
tool_dependency (
  source_tool VARCHAR(255),
  target_tool VARCHAR(255),
  edge_type VARCHAR(50),
  weight FLOAT,
  PRIMARY KEY (source_tool, target_tool, edge_type)
)
```

---

## Key Design Decisions

| ADR | Decision | Rationale |
|-----|----------|-----------|
| ADR-035 | Sandbox via Deno subprocess | Zero-permission security by default |
| ADR-036 | BroadcastChannel for events | Cross-worker/cross-tab communication |
| ADR-038 | DR-DSP for hypergraph pathfinding | Better than Dijkstra for tool sequences |
| ADR-042 | SHGAT for capability scoring | K-head attention beats single score |
| ADR-043 | Thompson Sampling thresholds | Adaptive per-tool confidence |

---

## Ports & Services

| Service | Port | Protocol |
|---------|------|----------|
| MCP API | 3003 | HTTP/JSON-RPC |
| Fresh Dashboard | 8081 | HTTP |
| PostgreSQL | 5432 | PostgreSQL |
| Grafana | 3000 | HTTP |
| Prometheus | 9091 | HTTP |
| Loki | 3100 | HTTP |
| OTEL Collector | 4318 | OTLP/HTTP |

---

## Scalability Considerations

### Current (Single Instance)

- PGlite embedded for local development
- PostgreSQL for production
- In-memory graph (Graphology)
- Single-process event bus

### Future (Multi-Instance)

- PostgreSQL with read replicas
- Redis for distributed events
- Vector index in PostgreSQL (pgvector)
- Horizontal scaling via load balancer
