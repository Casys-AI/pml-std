# ADR-011: Sentry Integration for Error Tracking & Performance Monitoring

**Status:** ✅ Implemented **Date:** 2025-11-20 | **Deciders:** Development Team

---

## Context

### Current State

Casys PML est une gateway MCP qui orchestre plusieurs serveurs MCP (filesystem, playwright, tavily,
memory, exa) avec recherche sémantique, exécution de workflows DAG, et sandboxing de code.

**Système de logging actuel:**

- Utilise `@std/log` de Deno avec handlers console et fichier
- Logs structurés avec niveaux (DEBUG, INFO, WARN, ERROR)
- Pas de centralisation des erreurs
- Pas de monitoring de performance
- Pas de visibilité sur les erreurs en production

### Problèmes Identifiés

1. **Manque de visibilité sur les erreurs production**
   - Erreurs dispersées dans les logs
   - Difficile de corréler les erreurs entre composants
   - Pas d'alertes temps réel

2. **Performance monitoring absent**
   - Pas de métriques sur la latence des outils MCP
   - Pas de tracing des workflows DAG
   - Pas de visibilité sur les goulots d'étranglement

3. **Debugging difficile**
   - Pas de contexte riche pour les erreurs
   - Pas de breadcrumbs pour retracer les étapes
   - Pas de release tracking

4. **Multi-composants complexe**
   - 5+ serveurs MCP externes
   - DAG executor avec parallélisation
   - Sandbox d'exécution de code
   - Recherche vectorielle
   - GraphRAG engine
   - Besoin de tracer les erreurs across components

---

## Decision

**Nous adoptons Sentry comme solution d'observabilité pour Casys PML.**

### Ce que nous trackons

#### 1. Error Tracking

**Erreurs critiques:**

- `MCPServerError`: Connexions serveurs MCP échouées
- `DAGExecutionError`: Workflows qui plantent
- `SandboxExecutionError`: Crashes du sandbox
- `DatabaseError`: Erreurs PGlite
- `VectorSearchError`: Échecs de recherche sémantique
- `TimeoutError`: Timeouts serveurs ou sandbox

**Contexte capturé:**

- Stack traces complètes
- Server ID / Tool name
- DAG structure metadata
- Sandbox configuration
- User intent (si fourni, non-PII)

#### 2. Performance Monitoring

**Transactions principales:**

- `mcp.tools.list`: Latence de la recherche vectorielle
- `mcp.tools.call`: Exécution d'un outil individuel
- `mcp.execute_workflow`: Workflow DAG complet (end-to-end)
- `mcp.execute_code`: Exécution sandbox
- `vector.search`: Recherche sémantique
- `dag.layer.execute`: Exécution d'une couche parallèle

**Métriques collectées:**

- Latence (p50, p95, p99)
- Throughput (req/s)
- Error rate par transaction
- Distribution par serveur MCP

#### 3. Breadcrumbs

**Événements tracés:**

- Découverte et connexion des serveurs MCP
- Extraction des schémas d'outils
- Requêtes de recherche vectorielle
- Tri topologique du DAG
- Cache hits/misses (code execution, embeddings)
- Événements de détection PII
- Résultats health checks

### Architecture d'Intégration

```
┌─────────────────────────────────────────────────┐
│          Casys PML Gateway (main.ts)           │
│         ↓ Sentry.init() au démarrage            │
└─────────────────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
   ┌────▼────┐   ┌─────▼─────┐  ┌────▼────┐
   │ Gateway │   │    DAG    │  │ Sandbox │
   │ Server  │   │ Executor  │  │Executor │
   └────┬────┘   └─────┬─────┘  └────┬────┘
        │              │              │
        │  Transactions│              │
        │  Breadcrumbs │   Spans      │
        │  Errors      │   Metrics    │  Errors
        │              │              │  Context
        └──────────────┴──────────────┘
                       │
                  ┌────▼────┐
                  │ Sentry  │
                  │ Backend │
                  └─────────┘
```

### Configuration

**Variables d'environnement:**

```bash
SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
SENTRY_ENVIRONMENT=development|staging|production
SENTRY_RELEASE=<git-commit-hash>
SENTRY_TRACES_SAMPLE_RATE=0.1  # 10% des transactions
```

**Sampling strategy:**

- Erreurs: 100% (toujours capturées)
- Transactions en production: 10% (configurable)
- Transactions en dev: 100%
- Sampling custom par type de transaction (endpoints critiques à 100%)

---

## Alternatives Considered

### Option 1: OpenTelemetry (OTEL)

**Avantages:**

- Standard industry
- Vendor-neutral
- Supporte traces + logs + metrics

**Inconvénients:**

- Setup plus complexe
- Nécessite un backend séparé (Jaeger, Tempo, etc.)
- Moins de features out-of-the-box
- UI moins polished que Sentry

**Verdict:** ❌ Trop de setup pour un gain limité

### Option 2: Seq / Loki

**Avantages:**

- Bon pour logs structurés
- Self-hosted possible
- Interface web décente

**Inconvénients:**

- Moins spécialisé pour error tracking
- Pas de release tracking
- Pas de performance monitoring natif
- Moins de features d'analyse

**Verdict:** ❌ Bon pour logs, pas pour errors/perf

### Option 3: Logs fichiers uniquement (@std/log)

**Avantages:**

- Déjà en place
- Zero dépendance externe
- Gratuit

**Inconvénients:**

- Pas de centralisation
- Pas d'alertes
- Pas de performance monitoring
- Difficile à analyser

**Verdict:** ❌ Insuffisant pour production

### Option 4: Sentry ✅

**Avantages:**

- SDK Deno officiel (`@sentry/deno`)
- Spécialisé error tracking + APM
- UI exceptionnelle pour explorer erreurs
- Release tracking
- Breadcrumbs natifs
- Source maps support
- Alerting intégré
- Pricing raisonnable (free tier généreux)

**Inconvénients:**

- Service externe (mais self-host possible)
- Dépendance vendor (mitigé par portabilité OTEL future)

**Verdict:** ✅ Meilleur ROI pour nos besoins

---

## Implementation Details

### Phase 1: Setup de base

**Fichier:** `src/telemetry/sentry.ts`

```typescript
import * as Sentry from "@sentry/deno";

export function initSentry() {
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) {
    log.info("Sentry disabled (no SENTRY_DSN)");
    return;
  }

  Sentry.init({
    dsn,
    environment: Deno.env.get("SENTRY_ENVIRONMENT") || "development",
    release: Deno.env.get("SENTRY_RELEASE") || getGitCommit(),
    tracesSampleRate: parseFloat(Deno.env.get("SENTRY_TRACES_SAMPLE_RATE") || "0.1"),

    // Désactiver integrations par défaut pour Deno.serve
    integrations: [],

    beforeSend(event) {
      // Filter PII if needed
      return event;
    },
  });
}

export function captureError(error: Error, context?: Record<string, unknown>) {
  Sentry.withScope((scope) => {
    if (context) {
      Object.entries(context).forEach(([key, value]) => {
        scope.setContext(key, value);
      });
    }
    Sentry.captureException(error);
  });
}

export function startTransaction(name: string, op: string) {
  return Sentry.startTransaction({ name, op });
}

export function addBreadcrumb(category: string, message: string, data?: Record<string, unknown>) {
  Sentry.addBreadcrumb({
    category,
    message,
    level: "info",
    data,
  });
}
```

### Phase 2: Intégration Gateway Server

**Fichier:** `src/mcp/gateway-server.ts`

**Points d'intégration:**

1. **tools/list handler** (ligne ~187)

```typescript
const transaction = startTransaction("mcp.tools.list", "mcp");
try {
  // existing logic
  transaction.finish();
} catch (error) {
  captureError(error, { handler: "tools/list" });
  transaction.finish();
  throw error;
}
```

2. **tools/call handler** (ligne ~213)

```typescript
const transaction = startTransaction("mcp.tools.call", "mcp");
transaction.setTag("tool", toolName);
transaction.setTag("server", serverId);
// ... existing logic
```

3. **execute_workflow handler** (ligne ~348)

```typescript
const transaction = startTransaction("mcp.execute_workflow", "workflow");
transaction.setData("tasks_count", workflow.tasks.length);
// ... track DAG execution
```

### Phase 3: Intégration DAG Executor

**Fichier:** `src/dag/executor.ts`

**Points d'intégration:**

1. **executeStream method** (ligne ~68)

```typescript
const span = transaction.startChild({
  op: "dag.execute",
  description: `Execute ${tasks.length} tasks`,
});
// ... execution logic
span.finish();
```

2. **Parallel layer execution** (ligne ~105)

```typescript
for (const layer of layers) {
  const layerSpan = transaction.startChild({
    op: "dag.layer.execute",
    description: `Layer ${layerIndex} (${layer.length} tasks)`,
  });
  // ... parallel execution
  layerSpan.finish();
}
```

### Phase 4: Intégration Sandbox

**Fichier:** `src/sandbox/executor.ts`

**Points d'intégration:**

1. **execute method** (ligne ~83)

```typescript
const span = startTransaction("sandbox.execute", "code_execution");
span.setData("code_length", code.length);
span.setTag("cache_hit", cacheHit);
// ... execution
span.finish();
```

2. **Error capture avec context**

```typescript
catch (error) {
  captureError(error, {
    code_snippet: code.substring(0, 200), // First 200 chars only
    timeout: this.timeout,
    context_keys: Object.keys(context)
  });
  throw error;
}
```

---

## Consequences

### Positives

✅ **Visibilité production:** Erreurs centralisées avec contexte riche ✅ **Performance insights:**
Identifier bottlenecks dans workflows ✅ **Debugging rapide:** Breadcrumbs montrent le chemin vers
l'erreur ✅ **Release tracking:** Corréler bugs avec déploiements ✅ **Alerting:** Notifications sur
erreurs critiques ✅ **Metrics:** Dashboard pour latence, throughput, error rate

### Négatives

⚠️ **Dépendance externe:** Service tiers (mitigé: self-host possible) ⚠️ **Coût:** Après free tier
(mitigé: pricing raisonnable) ⚠️ **Network dependency:** Nécessite `--allow-net` pour
`*.ingest.sentry.io` ⚠️ **Learning curve:** Équipe doit apprendre Sentry UI

### Neutres

🔄 **Migration future:** OTEL export possible si changement de vendor 🔄 **PII concerns:** Besoin de
filtrer données sensibles (déjà en place avec PII detector) 🔄 **Sampling:** Besoin d'ajuster le
sampling rate selon volume

---

## Rollout Plan

### Phase 1: MVP (1-2 heures)

- ✅ Install @sentry/deno
- ✅ Create sentry.ts module
- ✅ Integrate in gateway-server.ts (error tracking only)
- ✅ Add SENTRY_DSN to .env.example

### Phase 2: Performance Monitoring (2-3 heures)

- 📊 Add transactions for MCP requests
- 📊 Add spans for DAG execution
- 📊 Add breadcrumbs for MCP operations

### Phase 3: Full Integration (3-4 heures)

- 🔧 Integrate sandbox executor
- 🔧 Integrate MCP clients
- 🔧 Add release tracking
- 🔧 Configure sampling strategy

### Phase 4: Production Hardening (2-3 heures)

- 🧪 Add integration tests
- 📝 Update documentation
- ⚙️ Configure alerts
- 🎯 Fine-tune sampling rates

**Total estimated time:** 8-12 hours

---

## Success Metrics

**After 1 month:**

- [ ] 100% des erreurs production capturées
- [ ] P95 latency < 500ms pour tools/list
- [ ] P95 latency < 2s pour workflow execution
- [ ] Error rate < 1% sur tous les endpoints
- [ ] 0 erreurs non-détectées découvertes manuellement

**After 3 months:**

- [ ] Performance improvements basés sur insights Sentry
- [ ] Alerting configuré pour erreurs critiques
- [ ] Release correlation pour tous les bugs
- [ ] Sampling optimisé pour coût/visibilité

---

## References

- [Sentry Deno SDK Documentation](https://docs.sentry.io/platforms/javascript/guides/deno/)
- [Sentry Performance Monitoring](https://docs.sentry.io/product/performance/)
- [Best Practices for Error Tracking](https://docs.sentry.io/platforms/javascript/best-practices/)
- Casys PML ADR-010: Hybrid DAG Architecture
- Casys PML Epic 3: Code Execution & Sandbox

---

## Notes

**Security considerations:**

- Filter PII avant envoi à Sentry (utiliser PII detector existant)
- Ne pas logger code complet du sandbox (max 200 chars)
- Sanitize user intent si contient données sensibles

**Performance considerations:**

- Async error sending (non-blocking)
- Sampling configuré à 10% en production
- Breadcrumbs limités à 100 par transaction

**Compatibility:**

- Deno 2.5+ required
- Compatible avec tous les MCP servers
- Fonctionne en mode stdio (pas besoin HTTP server)
