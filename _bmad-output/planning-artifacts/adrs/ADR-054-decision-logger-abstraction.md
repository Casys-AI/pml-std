# ADR-054: IDecisionLogger Abstraction for Algorithm Telemetry

**Status:** Accepted **Date:** 2025-12-31 **Related:**

- ADR-034 (Native OpenTelemetry Deno)
- ADR-039 (Algorithm Tracer Observability)
- Story 7.6 (Algorithm Observability)

## Context

### Problème

L'`AlgorithmTracer` existant (ADR-039) a des types stricts pour le logging en DB :

```typescript
// algorithm-tracer.ts
interface TraceInput {
  algorithmName: AlgorithmName;  // "SHGAT" | "DRDSP" | ...
  algorithmMode: AlgorithmMode;  // "active_search" | "passive_suggestion"
  signals: AlgorithmSignals;     // { graphDensity, spectralClusterMatch, ... }
  params: AlgorithmParams;       // { alpha, reliabilityFactor, structuralBoost }
  // ...
}
```

**Problèmes rencontrés :**

1. **Couplage fort** : Les use-cases (couche Application) dépendaient des types stricts de l'infrastructure
2. **Cast `as any`** : Pour passer l'AlgorithmTracer aux use-cases, on utilisait `as any`
3. **Pas d'OTEL** : Les traces allaient en DB mais pas vers les backends OTEL (Jaeger, Tempo)

### Architecture Clean

Les use-cases ne devraient pas connaître les détails de l'infrastructure de télémétrie :

```
┌─────────────────────────────────────────────────────────┐
│                Application Layer                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │           GetSuggestionUseCase                   │    │
│  │  - Ne connaît que IDecisionLogger (port)        │    │
│  │  - Types loose : algorithm: string, etc.        │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼ depends on abstraction
┌─────────────────────────────────────────────────────────┐
│                 Port (Interface)                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │              IDecisionLogger                     │    │
│  │  logDecision(decision: AlgorithmDecision): void │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                           │
         ┌─────────────────┴─────────────────┐
         ▼                                   ▼
┌─────────────────────────┐    ┌─────────────────────────┐
│   TelemetryAdapter      │    │   NoOpDecisionLogger    │
│  (Production)           │    │   (Tests)               │
│  - AlgorithmTracer (DB) │    │   - No-op               │
│  - OTEL spans           │    │                         │
└─────────────────────────┘    └─────────────────────────┘
```

## Decision

### 1. Interface Abstraite `IDecisionLogger`

```typescript
// src/telemetry/decision-logger.ts

interface AlgorithmDecision {
  algorithm: string;           // Loose type (not AlgorithmName)
  mode: string;                // Loose type (not AlgorithmMode)
  targetType: string;
  intent: string;
  finalScore: number;
  threshold: number;
  decision: "accepted" | "rejected";
  targetId?: string;
  correlationId?: string;
  signals?: Record<string, unknown>;  // Loose - any signals
  params?: Record<string, unknown>;   // Loose - any params
}

interface IDecisionLogger {
  logDecision(decision: AlgorithmDecision): void | Promise<string | void>;
}
```

### 2. Adapter `TelemetryAdapter`

Combine le logging DB (AlgorithmTracer) et les spans OTEL :

```typescript
class TelemetryAdapter implements IDecisionLogger {
  constructor(private readonly algorithmTracer?: AlgorithmTracer) {}

  async logDecision(decision: AlgorithmDecision): Promise<string | void> {
    // 1. OTEL span (fire-and-forget)
    if (isOtelEnabled()) {
      recordAlgorithmDecision(decision.algorithm, {
        "algorithm.name": decision.algorithm,
        "algorithm.mode": decision.mode,
        "algorithm.final_score": decision.finalScore,
        // ...
      });
    }

    // 2. DB logging via AlgorithmTracer
    if (this.algorithmTracer) {
      // Map loose types to strict types with defaults
      return await this.algorithmTracer.logTrace({
        algorithmName: decision.algorithm as AlgorithmName,
        signals: {
          graphDensity: decision.signals?.graphDensity ?? 0,
          spectralClusterMatch: decision.signals?.spectralClusterMatch ?? false,
          // ...
        },
        // ...
      });
    }
  }
}
```

### 3. OTEL Natif Deno

Utilise le support OTEL natif de Deno 2.2+ (ADR-034) :

```typescript
// src/telemetry/otel.ts
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("pml.algorithms", "1.0.0");

export function recordAlgorithmDecision(
  name: string,
  attributes: AlgorithmSpanAttributes,
  success: boolean = true,
): void {
  const span = tracer.startSpan(`algorithm.${name}`, { attributes });
  span.setStatus({ code: success ? SpanStatusCode.OK : SpanStatusCode.ERROR });
  span.end();
}
```

### 4. Activation

```bash
# deno.json tasks incluent --unstable-otel
OTEL_DENO=true deno task dev

# Traces exportées vers localhost:4318 (Jaeger)
# UI: http://localhost:16686
```

## Implementation

### Fichiers Créés

| Fichier | Description |
|---------|-------------|
| `src/telemetry/otel.ts` | Support OTEL natif Deno |
| `src/telemetry/decision-logger.ts` | Interface + Adapter |
| `src/application/use-cases/capabilities/get-suggestion.ts` | Use-case refactorisé |
| `src/mcp/handlers/suggestion-handler.ts` | Thin handler |

### Fichiers Modifiés

| Fichier | Changement |
|---------|------------|
| `deno.json` | Ajout `--unstable-otel` aux tasks |
| `docker-compose.yml` | Ajout service Jaeger |
| `src/telemetry/mod.ts` | Exports nouveaux modules |
| `src/mcp/handlers/discover-handler.ts` | Ajout tracing HybridSearch/CapabilityMatcher |
| `src/mcp/handlers/execute-handler.ts` | `buildSuggestionDeps()` adapter |
| `src/mcp/gateway-server.ts` | Import TelemetryAdapter |

### Usage dans les Handlers

```typescript
// discover-handler.ts
decisionLogger?.logDecision({
  algorithm: "HybridSearch",
  mode: "active_search",
  targetType: "tool",
  intent,
  finalScore: unifiedScore,
  threshold: minScore,
  decision: unifiedScore >= minScore ? "accepted" : "rejected",
  targetId: result.toolId,
  signals: { semanticScore: result.semanticScore },
});
```

## Consequences

### Positives

- **Clean Architecture** : Use-cases découplés de l'infrastructure
- **Plus de `as any`** : Types propres avec interface abstraite
- **Double logging** : DB (analyse) + OTEL (tracing distribué)
- **Testable** : `NoOpDecisionLogger` pour les tests
- **Extensible** : Facile d'ajouter d'autres backends

### Negatives

- **Mapping types** : L'adapter doit mapper loose → strict avec defaults
- **Overhead** : Double écriture (DB + OTEL) mais fire-and-forget pour OTEL

### Visualisation Jaeger

```
┌─────────────────────────────────────────────────────────────┐
│  Jaeger UI (http://localhost:16686)                         │
│                                                              │
│  Service: pml.algorithms                                     │
│                                                              │
│  ├─ algorithm.SHGAT ─────────────────────── 2.3ms           │
│  │   └─ algorithm.name: SHGAT                               │
│  │   └─ algorithm.mode: active_search                       │
│  │   └─ algorithm.final_score: 0.85                         │
│  │   └─ algorithm.decision: accepted                        │
│  │                                                           │
│  ├─ algorithm.DRDSP ─────────────────────── 1.1ms           │
│  │   └─ algorithm.name: DRDSP                               │
│  │   └─ algorithm.mode: passive_suggestion                  │
│  │   └─ algorithm.final_score: 0.72                         │
│  │                                                           │
│  └─ algorithm.HybridSearch ──────────────── 0.5ms           │
│       └─ algorithm.target_type: tool                        │
│       └─ algorithm.target_id: fs:read_file                  │
└─────────────────────────────────────────────────────────────┘
```

## References

- [Deno OTEL Documentation](https://docs.deno.com/runtime/fundamentals/open_telemetry/)
- [OpenTelemetry API](https://opentelemetry.io/docs/languages/js/)
- [Clean Architecture - Ports & Adapters](https://alistair.cockburn.us/hexagonal-architecture/)
- `src/telemetry/algorithm-tracer.ts` - Implementation existante
- ADR-034 - Native OpenTelemetry Integration
- ADR-039 - Algorithm Tracer Observability
