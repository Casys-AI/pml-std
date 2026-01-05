# Analyse Technique : Stratégie DAG et Parallélisation

**Date:** 2025-11-03 **Auteur:** BMad **Contexte:** Pre-implementation Story 2.1-2.2 **Objectif:**
Clarifier l'ambiguïté entre "DAG construit par Claude" vs "Auto-detection"

---

## 🔍 Problème Identifié

**Contradiction dans les documents :**

| Document                  | Ligne   | Citation                                                                                  | Implication                         |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| **brainstorming-session** | 117     | "DAG construit par Claude : Gateway = simple exécuteur parallèle"                         | Claude envoie le DAG explicitement  |
| **architecture.md**       | 189-191 | "Automatically detect dependencies... Need to infer which outputs feed into which inputs" | Gateway analyse et construit le DAG |

**Question critique :** Qui est responsable de construire le DAG ?

---

## 🎯 Options Stratégiques

### Option A : "Claude Construit le DAG" (Gateway Stupide)

**Workflow :**

```typescript
// Claude envoie :
{
  "workflow": {
    "tasks": [
      { "id": "task1", "tool": "filesystem:read", "args": {...}, "depends_on": [] },
      { "id": "task2", "tool": "json:parse", "args": {...}, "depends_on": ["task1"] },
      { "id": "task3", "tool": "github:create", "args": {...}, "depends_on": ["task2"] }
    ]
  }
}

// Gateway fait :
1. Parse DAG explicite
2. Topological sort
3. Execute avec Promise.all pour branches parallèles
4. Return results
```

**✅ Avantages :**

- Gateway ultra-simple (~100 LOC total)
- Zéro risque de faux positifs dependency detection
- Claude a contexte complet pour décider des dépendances
- Pas besoin de parsing complexe JSON Schema
- MVP peut être livré en 2-3 jours au lieu de 2 semaines

**❌ Inconvénients :**

- Claude doit explicitement structurer chaque workflow
- Friction UX : format spécifique requis
- Claude pourrait faire des erreurs de séquencing
- Pas "invisible" comme promis dans PRD

**🎯 Cas d'usage optimal :**

- Workflows complexes où seul Claude comprend la logique métier
- MVP rapide pour valider concept

---

### Option B : "Gateway Auto-Detect" (Gateway Intelligent)

**Workflow :**

```typescript
// Claude envoie (format MCP standard) :
{
  "tools": [
    { "name": "filesystem:read", "arguments": { "path": "config.json" } },
    { "name": "json:parse", "arguments": { "jsonString": "<output_of_task1>" } },
    { "name": "github:create", "arguments": { "data": "<output_of_task2>" } }
  ]
}

// Gateway fait :
1. Récupère schemas MCP de chaque tool
2. Analyse input/output schemas (JSON Schema)
3. Détecte dependencies via name/type matching
4. Construit DAG automatiquement
5. Topological sort
6. Execute avec Promise.all
7. Return results
```

**✅ Avantages :**

- UX transparente : Claude utilise format MCP standard
- Pas de friction cognitive pour l'utilisateur
- Gateway "intelligent" comme différenciateur compétitif
- Aligné avec vision PRD ("zero-config")

**❌ Inconvénients :**

- Complexité implémentation ~500 LOC (schemas parsing, matching)
- Risque de faux positifs (e.g., "data" match partout)
- Edge cases difficiles (ambiguous matches, types incompatibles)
- Timeline MVP : +1-2 semaines vs Option A
- Debugging difficile (pourquoi DAG détecté incorrectement ?)

**🎯 Cas d'usage optimal :**

- Workflows simples avec naming conventions claires
- Production-ready où UX frictionless est critique

---

### Option C : "Hybrid Explicit + Auto-Detect" (Pragmatique)

**Workflow :**

```typescript
// Claude peut envoyer soit :

// Format 1: Explicit DAG (opt-in)
{
  "workflow": { "tasks": [...] }  // Option A
}

// Format 2: Standard MCP (auto-detect)
{
  "tools": [...]  // Option B - gateway détecte
}

// Gateway fait :
if (request.workflow) {
  // Parse explicit DAG (simple)
} else {
  // Fallback: auto-detection avec heuristics conservatrices
}
```

**✅ Avantages :**

- Best of both worlds : simplicité + UX frictionless
- Claude peut choisir explicit pour workflows complexes
- Auto-detect pour workflows simples/évidents
- Évolutif : start explicit, learn patterns, improve auto-detect

**❌ Inconvénients :**

- Deux code paths à maintenir
- Documentation plus complexe
- Risque confusion utilisateur sur format à utiliser

**🎯 Cas d'usage optimal :**

- MVP qui veut valider les deux approches
- Production avec learning loop

---

## 📊 Analyse Comparative

| Critère                | Option A (Claude DAG) | Option B (Auto-Detect) | Option C (Hybrid)   |
| ---------------------- | --------------------- | ---------------------- | ------------------- |
| **Complexité implem.** | ⭐⭐⭐⭐⭐ (100 LOC)  | ⭐⭐ (500 LOC)         | ⭐⭐⭐ (300 LOC)    |
| **Timeline MVP**       | 2-3 jours             | 1-2 semaines           | 1 semaine           |
| **UX Frictionless**    | ❌ Format custom      | ✅ MCP standard        | ⚠️ Deux formats     |
| **Risk Faux Positifs** | ✅ Zéro               | ❌ Moyen-High          | ⚠️ Moyen (fallback) |
| **Debuggability**      | ✅ Transparent        | ❌ Black box           | ⚠️ Dépend format    |
| **Différenciation**    | ❌ Basique            | ✅ Intelligent         | ⚠️ Opportuniste     |
| **Alignment PRD**      | ⚠️ Partiel            | ✅ Total               | ✅ Total            |

---

## 🔬 Deep Dive : Auto-Detection Challenges

### Challenge 1 : Name Matching Ambiguïté

**Exemple problématique :**

```typescript
Tool A: filesystem:read
  output: { content: string, metadata: object }

Tool B: database:insert
  input: { content: string, metadata: object }

Tool C: email:send
  input: { content: string, metadata: object }
```

**Problème :** B et C ont même signature. Comment savoir si A→B ou A→C ?

**Solutions possibles :**

1. **Conservative :** Assume A→B ET A→C (séquentiel) → Perte parallelization
2. **Optimistic :** Assume indépendant → Risque erreur runtime
3. **Type semantics :** Check description fields pour intent
4. **Ask Claude :** Return ambiguity error, force explicit

**Recommandation actuelle (Architecture line 256) :** Conservative approach

---

### Challenge 2 : Type Compatibility False Positives

**Exemple :**

```typescript
Tool A: api:fetch → output: { data: object }
Tool B: logger:log → input: { message: string }
```

**Question :** Est-ce que `object` peut feed `string` ?

- Si oui → Potentiel error runtime
- Si non → Miss valid dependency (JSON.stringify possible)

**Solution actuelle :** Type exact matching uniquement (string→string, object→object)

---

### Challenge 3 : Output Référencing Syntax

**Claude doit référencer outputs. Comment ?**

**Option 1 : Template syntax**

```json
{
  "arguments": {
    "jsonString": "{{task1.output.content}}"
  }
}
```

**Option 2 : Special markers**

```json
{
  "arguments": {
    "jsonString": "$OUTPUT[task1].content"
  }
}
```

**Option 3 : Inference from schema matching**

```json
{
  "arguments": {
    "jsonString": "<needs_input_from_previous_task>"
  }
}
```

**Question :** Est-ce que MCP protocol supporte template syntax nativement ?

---

## 🎓 Leçons de LLMCompiler

**LLMCompiler approach (référence brainstorming line 125) :**

1. **LLM génère plan explicite** avec dépendances :
   ```python
   task1 = fetch_data()
   task2 = parse_data(task1.result)
   task3 = process_data(task2.result)
   ```

2. **Planner extrait DAG** du code généré (AST parsing)

3. **Executor** run DAG avec parallelization

**Key Insight :** LLMCompiler fait explicit planning, PUIS parse DAG. C'est un hybrid !

**Différence avec Casys PML :**

- LLMCompiler : Python code → AST → DAG
- Casys PML Option A : JSON explicit → parse → DAG
- Casys PML Option B : MCP calls → schema inference → DAG

**Conclusion :** LLMCompiler penche vers **explicit** (Option A) mais avec inference layer.

---

## 💡 Recommandations

### Pour MVP (Epic 2 Stories 2.1-2.2)

**🏆 RECOMMANDATION : Option A (Claude Construit DAG Explicite)**

**Justification :**

1. **Time-to-market critique :**
   - MVP livrable en 2-3 jours vs 1-2 semaines
   - Epic 2 déjà dense (7 stories), réduire risk

2. **Validation hypothesis :**
   - Besoin valider que parallélisation apporte vraiment valeur (3-5x speedup)
   - Explicit DAG permet benchmarks propres
   - Auto-detect ajoute variable (faux positifs masquent vrais gains)

3. **User feedback critical :**
   - Format explicit permet mesurer friction UX
   - Si users disent "c'est chiant", on sait que auto-detect justifié
   - Si users OK, on économise 500 LOC complexity

4. **Alignement ADR-002 :**
   - "Zero external deps" → Custom DAG simple
   - Explicit approach = 100 LOC custom, très maintainable

5. **Debugging :**
   - Production : explicit DAG = logs clairs
   - Auto-detect = "why this dependency detected?" → nightmare support

**Trade-off accepté :**

- Friction UX temporary (MVP)
- Format custom documenté dans README

---

### Évolution Post-MVP (v1.1+)

**Roadmap progressive :**

**Phase 1 (MVP) :** Explicit DAG

- Claude envoie format structuré
- Gateway = executor simple

**Phase 2 (v1.1) :** Hybrid opt-in auto-detect

- Fallback auto-detect pour workflows simples
- Explicit pour workflows complexes
- Collect metrics : % auto-detect success rate

**Phase 3 (v1.2) :** LLM-assisted dependency detection

- Si auto-detect ambiguïté, query embedding model
- Semantic similarity entre output description et input description
- Example : "file content" (output) match "text to parse" (input)

**Phase 4 (v2.0) :** Speculative execution

- Predict next tools based on workflow history
- Pre-fetch schemas optimistically

---

## 📝 Format Explicit DAG Proposé

### Structure JSON

```typescript
interface WorkflowRequest {
  workflow: {
    tasks: Task[];
  };
}

interface Task {
  id: string; // Unique task ID (e.g., "task1")
  tool: string; // MCP tool name (e.g., "filesystem:read")
  arguments: Record<string, unknown>; // Tool arguments
  depends_on: string[]; // Task IDs this task depends on ([] = no deps)
}

interface WorkflowResponse {
  results: TaskResult[];
  execution_time_ms: number;
  parallelization_speedup: number; // e.g., 3.2x
}

interface TaskResult {
  task_id: string;
  status: "success" | "error";
  output?: unknown;
  error?: string;
  execution_time_ms: number;
}
```

### Exemple Concret

**Workflow : Read → Parse → Create GitHub Issue**

```json
{
  "workflow": {
    "tasks": [
      {
        "id": "read_config",
        "tool": "filesystem:read",
        "arguments": { "path": "/config.json" },
        "depends_on": []
      },
      {
        "id": "parse_json",
        "tool": "json:parse",
        "arguments": { "jsonString": "$OUTPUT[read_config]" },
        "depends_on": ["read_config"]
      },
      {
        "id": "create_issue",
        "tool": "github:create_issue",
        "arguments": {
          "title": "Config Update",
          "body": "$OUTPUT[parse_json].description"
        },
        "depends_on": ["parse_json"]
      }
    ]
  }
}
```

**Exécution :**

1. DAG detect : read_config → parse_json → create_issue (sequential)
2. Aucune parallelization possible
3. Execute séquentiellement, return results

**Exemple parallelizable :**

```json
{
  "workflow": {
    "tasks": [
      {
        "id": "read_config",
        "tool": "filesystem:read",
        "arguments": { "path": "/config.json" },
        "depends_on": []
      },
      {
        "id": "read_package",
        "tool": "filesystem:read",
        "arguments": { "path": "/package.json" },
        "depends_on": []
      },
      {
        "id": "read_readme",
        "tool": "filesystem:read",
        "arguments": { "path": "/README.md" },
        "depends_on": []
      }
    ]
  }
}
```

**Exécution :**

1. DAG detect : 3 tasks indépendants
2. **Promise.all([task1, task2, task3])** → parallel
3. Latency = max(t1, t2, t3) au lieu de t1+t2+t3
4. Speedup = 3x si tasks durée identique

---

## 🚨 Impacts sur Stories Epic 2

### Story 2.1 : DAG Builder

**Modifications requises si Option A choisie :**

**AC Original :**

```
2. Parsing des tool input/output schemas (JSON Schema format)
3. Dependency detection: tool B depends on tool A si output_A matches input_B
```

**AC Révisé (Option A) :**

```
2. Parsing du workflow JSON avec tasks explicites et depends_on
3. Validation des dépendances (vérifier task IDs existent dans depends_on)
```

**Simplification :**

- ❌ Remove : JSON Schema parsing (500 LOC)
- ❌ Remove : Name/type matching logic
- ✅ Keep : Topological sort (50 LOC)
- ✅ Keep : Cycle detection
- ✅ Add : Workflow JSON parsing (<50 LOC)

**Nouvelle estimation effort :** 2-3 heures au lieu de 6-8 heures

---

### Story 2.2 : Parallel Executor

**Modifications requises :**

**AC Original :**

```
2. DAG traversal avec identification des nodes exécutables en parallèle
```

**AC Maintenu (identique) :**

- Topological sort donne layers
- Layer 0 = no deps → Promise.all
- Layer 1 = depends Layer 0 → await Layer 0, then Promise.all Layer 1
- etc.

**Aucune modification** - logique executor identique

---

## 🔄 Decision Matrix

| Si...                              | Alors choisir... | Parce que...                 |
| ---------------------------------- | ---------------- | ---------------------------- |
| **MVP doit sortir <2 semaines**    | Option A         | Time-to-market critical      |
| **UX frictionless non-négociable** | Option B         | PRD promise                  |
| **Besoin valider hypothesis**      | Option A         | Pure parallelization gains   |
| **Production-ready dès MVP**       | Option C         | Fallback safety net          |
| **Learning loop important**        | Option C         | Collect auto-detect metrics  |
| **Resources limited**              | Option A         | Simplicity = maintainability |

---

## ✅ Proposition Finale

### Decision : **Option A pour MVP**

**Modifié Stories 2.1 (DAG Builder) :**

- Remplacer "JSON Schema parsing" → "Workflow JSON parsing"
- Simplifier AC#2-3

**Conserver Stories 2.2-2.7 :** Aucun changement

**Roadmap Evolution :**

- v1.0 (MVP) : Explicit DAG
- v1.1 : Hybrid (explicit + auto-detect opt-in)
- v1.2 : LLM-assisted semantic matching
- v2.0 : Speculative execution

**Documentation :**

- README : Workflow JSON format examples
- Architecture : Update Pattern 1 avec explicit approach

---

## 📎 Annexes

### Référence : MCP Protocol Support

**Question ouverte :** Est-ce que MCP protocol a native support pour workflow/DAG ?

**Action item :** Check MCP spec officielle

- Si oui → Use native format
- Si non → Define custom format (proposé ci-dessus)

### Alternative : GraphQL-style Approach

**Inspiré par GraphQL resolvers :**

```json
{
  "query": {
    "createIssue": {
      "title": "Config Update",
      "body": {
        "parseJson": {
          "jsonString": {
            "readFile": {
              "path": "/config.json"
            }
          }
        }
      }
    }
  }
}
```

**Avantage :** Nested structure = dependencies implicites **Inconvénient :** Complexité parsing, pas
standard MCP

---

**Status :** 🟡 PENDING DECISION **Next Step :** Review avec équipe, choisir option, update epics.md
si nécessaire
