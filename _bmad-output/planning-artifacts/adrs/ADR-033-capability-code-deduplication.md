# ADR-033: Capability Code Deduplication Strategy

**Status:** 📝 Draft **Date:** 2025-12-05 | **Requires:** Research

> ADR exploratoire - recherche approfondie nécessaire avant décision.

## Context

### Problème Identifié (Code Review Story 7.2a)

La déduplication actuelle des capabilities utilise un hash SHA-256 du code normalisé :

```typescript
// Normalisation actuelle (hash.ts)
function normalizeCode(code: string): string {
  return code.trim().replace(/\s+/g, " ");
}
```

Cette approche détecte uniquement les **duplicatas syntaxiques exacts** (après normalisation
whitespace).

### Cas Non Détectés

```typescript
// ❌ HASH DIFFÉRENT - renommage de variables
"const result = await tools.search({q: 'test'});";
"const data = await tools.search({q: 'test'});";

// ❌ HASH DIFFÉRENT - commentaires
"const x = 1;";
"const x = 1; // valeur initiale";

// ❌ HASH DIFFÉRENT - ordre des propriétés
"tools.fetch({url: 'x', method: 'GET'})";
"tools.fetch({method: 'GET', url: 'x'})";

// ❌ HASH DIFFÉRENT - sémantiquement équivalent
"const x = 1 + 2;";
"const x = 3;";
```

### Impact

- **Pollution de la base** : N capabilities "différentes" qui font la même chose
- **Suggestions moins pertinentes** (Story 7.4) : dilution du signal
- **Consommation ressources** : embeddings générés pour chaque variante

## Lien avec Story 7.2b (SWC)

Story 7.2b introduit `SWC` pour l'inférence de schéma :

```typescript
// Extrait de ADR-028
// SWC parse AST → trouve args.filePath, args.debug
// → Génère JSON Schema directement
```

**Question clé** : Si on parse déjà l'AST pour extraire le schéma, peut-on réutiliser cette analyse
pour une meilleure déduplication ?

### Hypothèse à Valider

```
Code TypeScript
     │
     ▼
┌─────────────────────────────────────────┐
│  SWC AST Parser (Story 7.2b)            │
├─────────────────────────────────────────┤
│  Output 1: parameters_schema (JSON)     │ ← Objectif actuel 7.2b
│  Output 2: normalized_ast_hash (?)      │ ← Extension potentielle
│  Output 3: canonical_code_repr (?)      │ ← Extension potentielle
└─────────────────────────────────────────┘
```

## Options Explorées (Non Décidées)

### Option A : Hash Simple (Status Quo)

```typescript
// Actuel - normalisation whitespace uniquement
const hash = await hashCode(code.trim().replace(/\s+/g, " "));
```

| Avantage           | Inconvénient                            |
| ------------------ | --------------------------------------- |
| Simple, performant | Faux négatifs (variantes non détectées) |
| Déterministe       | Pas de détection sémantique             |
| Aucune dépendance  | Pollution base à long terme             |

### Option B : AST Normalization via SWC

```typescript
// Hypothétique - nécessite recherche
import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";

function normalizeAST(code: string): string {
  const ast = await parse(code, { syntax: "typescript" });

  // 1. Renommer toutes les variables locales en $1, $2, $3...
  // 2. Trier les propriétés d'objets alphabétiquement
  // 3. Supprimer les commentaires
  // 4. Générer une représentation canonique

  return canonicalRepresentation;
}
```

| Avantage                       | Inconvénient              |
| ------------------------------ | ------------------------- |
| Détecte renommage variables    | Complexité implémentation |
| Détecte réordonnancement props | Performance (parse AST)   |
| Synergie avec 7.2b             | Cas edge (macros, eval)   |
| SWC 20x plus rapide            |                           |
| Deno natif                     |                           |

**Questions ouvertes :**

- Quel overhead de performance pour parser chaque code ?
- Comment gérer le code invalide syntaxiquement ?

### Option C : Approche Hybride (Hash + Embedding Similarity)

```typescript
// Hypothétique - nécessite recherche
async function findDuplicates(code: string): Promise<Capability[]> {
  const hash = await hashCode(code);

  // 1. Fast path: exact match
  const exact = await store.findByCodeHash(hash);
  if (exact) return [exact];

  // 2. Slow path: embedding similarity
  const embedding = await embedCode(code);  // Embed le code, pas l'intent
  const similar = await store.searchByCodeEmbedding(embedding, threshold: 0.95);

  return similar;
}
```

| Avantage                      | Inconvénient                       |
| ----------------------------- | ---------------------------------- |
| Détecte similarité sémantique | Coût embedding × 2 (code + intent) |
| Pas de parsing AST            | Faux positifs possibles            |
| Progressif (fast → slow path) | Threshold difficile à calibrer     |

**Questions ouvertes :**

- Faut-il un embedding séparé pour le code vs l'intent ?
- Quel modèle d'embedding pour du code TypeScript ?
- Comment merger les capabilities détectées comme similaires ?

### Option D : Déduplication Lazy (Pruning Post-Hoc)

```typescript
// Story 7.5b - pruning
async function pruneCapabilities(): Promise<void> {
  // Batch job périodique
  const all = await store.getAllCapabilities();

  for (const group of clusterBySimilarity(all)) {
    if (group.length > 1) {
      // Garder celle avec le meilleur success_rate
      const best = maxBy(group, (c) => c.successRate * c.usageCount);
      await store.mergeInto(best, group.filter((c) => c !== best));
    }
  }
}
```

| Avantage                     | Inconvénient                       |
| ---------------------------- | ---------------------------------- |
| Pas d'overhead à l'insertion | Pollution temporaire               |
| Peut utiliser ML clustering  | Complexité merge (préserver stats) |
| Exécution en background      | Latence avant cleanup              |

## Recherche Requise

Avant de prendre une décision, les points suivants doivent être investigués :

### 1. Performance SWC

- [ ] Benchmark : temps de parsing pour snippets typiques (10-100 LOC)
- [ ] Memory footprint du parser WASM
- [ ] Possibilité de réutiliser le parsing entre 7.2b (schema) et dedup

### 2. Qualité de la Normalisation AST

- [ ] POC : normaliser 10 paires de code "sémantiquement équivalent"
- [ ] Taux de faux positifs / faux négatifs
- [ ] Edge cases : async/await, destructuring, spread operators

### 3. Embedding Code vs Intent

- [ ] Tester embedding du code avec BGE-M3 (modèle actuel)
- [ ] Comparer avec modèles spécialisés code (CodeBERT, UniXcoder)
- [ ] Évaluer si un seul embedding (intent) suffit

### 4. Synergie avec Story 7.2b

- [ ] Identifier le point d'intégration dans le flow SWC
- [ ] Estimer le surcoût d'ajouter la normalisation
- [ ] Définir le format de sortie (hash AST ? représentation canonique ?)

## Décision

**⏸️ Aucune décision active.**

Ce ADR documente le problème et les options. Une décision sera prise après :

1. Implémentation de Story 7.2b (SWC disponible)
2. Spike de recherche sur les options B et C
3. Mesure de l'ampleur réelle du problème en production

## Stories Impactées

| Story                   | Impact                                       |
| ----------------------- | -------------------------------------------- |
| 7.2b (Schema Inference) | Potentielle extension pour normalisation AST |
| 7.4 (Suggestion Engine) | Qualité des suggestions dépend de la dédup   |
| 7.5b (Pruning)          | Pourrait inclure dedup post-hoc (Option D)   |

## Références

- [Story 7.2a: Capability Storage](../stories/7-2a-capability-storage-migration-eager-learning.md) -
  Implémentation actuelle
- [ADR-028: Emergent Capabilities](ADR-028-emergent-capabilities-system.md) - Architecture globale
- [SWC Documentation](https://swc.rs/) - Rust-based TypeScript AST parser (Deno native)
- Code Review 2025-12-05 - Identification initiale du problème
