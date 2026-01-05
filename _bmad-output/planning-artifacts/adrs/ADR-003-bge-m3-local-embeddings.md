# ADR-003: BGE-M3 for Local Embeddings

**Status:** accepted **Date:** 2025-11-03 **Implementation:** done

## Decision

Use BGE-M3 (Xenova/bge-m3) via @huggingface/transformers for local embedding inference.

## Context

The system requires semantic embeddings for tool discovery and similarity search. Options include
cloud APIs (OpenAI, Cohere) or local inference.

## Rationale

- 1024-dim embeddings (good quality/size trade-off)
- Local inference = no API calls, no API keys, privacy preserved
- Deno compatible via npm: prefix
- Multi-lingual support (M3 = Multi-lingual, Multi-granularity, Multi-task)
- SOTA open model for semantic search
- Zero usage costs

## Consequences

### Positive

- No API costs (vs OpenAI embeddings API at $0.0001/1K tokens)
- Privacy preserved - data never leaves machine
- Works offline
- Multi-lingual support out of the box

### Negative

- 4GB RAM requirement (model in memory)
- ~60s initial embedding generation for 200 tools
- First load downloads model (~350MB)

## Implementation

```typescript
import { pipeline } from "@huggingface/transformers";

const embedder = await pipeline("feature-extraction", "Xenova/bge-m3");
const embedding = await embedder(text, { pooling: "mean", normalize: true });
```

## Alternatives Considered

| Alternative           | Reason Rejected                                 |
| --------------------- | ----------------------------------------------- |
| OpenAI Embeddings     | Requires API key, costs money, privacy concerns |
| Cohere Embed          | Same as OpenAI                                  |
| sentence-transformers | Python-only, requires separate runtime          |
