# Story 13.4: Capability Curation System

Status: skipped

## Reason for Skip

**Decision (2025-12-26):** Le système de curation automatique LLM (suggestions de noms, confidence
scoring, batch processing) n'est pas nécessaire pour l'instant.

Les fonctionnalités essentielles (`cap:list`, `cap:rename`) sont mergées dans **Story 13.5:
Capability Management Tools**.

La curation automatique via LLM pourra être ajoutée plus tard si besoin.

## Original Scope (Deferred)

- Suggest Mode - LLM-based name suggestions
- Auto Mode - Auto-apply high-confidence names
- Heuristic namespace/action inference
- Confidence scoring (tools match, intent clarity, uniqueness)
- Batch processing

## See Instead

→ [Story 13.5: Capability Management Tools](./13-5-capability-management-tools.md)
