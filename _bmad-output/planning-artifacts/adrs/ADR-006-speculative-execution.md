# ADR-006: Speculative Execution as Default Mode

**Status:** accepted **Date:** 2025-11-03 **Implementation:** partial (Epic 4)

## Decision

Make speculative execution the default mode for high-confidence workflows (>0.85), not an optional
feature.

## Context

User insight: "et donc les algo graph aident la gateway a performer l action avant meme l appel de
claude non ? cetait l idee" (so the graph algorithms help the gateway perform the action even before
Claude's call, right? That was the idea)

User confirmation: "Ouai on peut essayer sans speculative mais on va pas se mentir, speculative c
est THE feature" (Yeah we can try without speculative but let's be honest, speculative IS THE
feature)

## Rationale

- **THE feature** - core differentiator of Casys PML
- 0ms perceived latency (results ready when user confirms)
- Even with Claude confirmation dialogs, provides instant results vs 2-5s wait
- Context savings ($5-10/day) >> waste from occasional misspeculation ($0.50)
- GraphRAG provides confidence scores for safe speculation
- Multiple safety guardrails prevent dangerous operations

## Safety Measures

- **Never speculate on:** delete, deploy, payment, send_email operations
- **Cost limits:** <$0.10 per speculative execution
- **Resource limits:** <5s execution time
- **Confidence threshold:** >0.85 minimum (adaptive learning from user feedback)

## Consequences

### Positive

- Dramatic improvement in perceived performance
- Results ready before user confirms
- Competitive differentiator

### Negative

- Requires adaptive threshold learning (start conservative at 0.92)
- Need comprehensive safety checks for dangerous operations
- Metrics tracking for success/acceptance/waste rates
- Occasional wasted computation on rejected speculations

## Design Philosophy

> Optimistic execution with smart safeguards > Conservative suggestion-only mode

## Implementation Status

- ✅ Confidence scoring implemented
- ✅ Safety checks for dangerous operations
- 🔄 Adaptive threshold learning (Epic 4)
- 🔄 Full speculative execution pipeline (Epic 4)
