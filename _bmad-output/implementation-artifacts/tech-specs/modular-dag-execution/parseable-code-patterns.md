# Patterns de Code Détectables pour Exécution Modulaire

Analyse de tous les patterns que l'agent pourrait écrire naturellement et qu'on pourrait détecter
via SWC pour créer des tasks DAG modulaires.

## ✅ Actuellement Détecté

| Pattern              | Exemple                           | Détection                                |
| -------------------- | --------------------------------- | ---------------------------------------- |
| **Appels MCP**       | `mcp.filesystem.read_file({...})` | ✅ MemberChain `mcp.server.tool`         |
| **Capabilities**     | `capabilities.summarize({...})`   | ✅ MemberChain `capabilities.name`       |
| **Conditions**       | `if (x > 0) { ... }`              | ✅ IfStatement, SwitchStatement, Ternary |
| **Parallélisme**     | `Promise.all([a, b, c])`          | ✅ Promise.all/allSettled                |
| **Map dans Promise** | `Promise.all(arr.map(fn))`        | ✅ Détecté pour parallélisme             |

## 🔍 À Ajouter : Array Operations (Priorité 1)

Ces opérations sont **très fréquentes** dans le code agent et **facilement chainables** :

### **1. Transformations**

```typescript
// .map() - Transformation élément par élément
const names = users.map((u) => u.name);
// → Nœud: { type: "computation", operation: "map", code: "u => u.name" }

// .filter() - Filtrage conditionnel
const active = users.filter((u) => u.status === "active");
// → Nœud: { type: "computation", operation: "filter", code: "u => u.status === 'active'" }

// .reduce() - Agrégation
const total = prices.reduce((sum, p) => sum + p, 0);
// → Nœud: { type: "computation", operation: "reduce", code: "(sum, p) => sum + p", initialValue: 0 }

// .flatMap() - Map + flatten
const allTags = posts.flatMap((p) => p.tags);
// → Nœud: { type: "computation", operation: "flatMap", code: "p => p.tags" }
```

### **2. Recherche/Test**

```typescript
// .find() - Premier élément matching
const admin = users.find((u) => u.role === "admin");
// → Nœud: { type: "computation", operation: "find", code: "u => u.role === 'admin'" }

// .findIndex() - Index du premier matching
const idx = users.findIndex((u) => u.id === targetId);
// → Nœud: { type: "computation", operation: "findIndex", code: "u => u.id === targetId" }

// .some() - Au moins un matching
const hasAdmin = users.some((u) => u.role === "admin");
// → Nœud: { type: "computation", operation: "some", code: "u => u.role === 'admin'" }

// .every() - Tous matching
const allActive = users.every((u) => u.active);
// → Nœud: { type: "computation", operation: "every", code: "u => u.active" }

// .includes() - Contient valeur
const hasJohn = names.includes("John");
// → Nœud: { type: "computation", operation: "includes", value: 'John' }
```

### **3. Tri/Organisation**

```typescript
// .sort() - Tri
const sorted = users.sort((a, b) => a.age - b.age);
// → Nœud: { type: "computation", operation: "sort", code: "(a, b) => a.age - b.age" }

// .reverse() - Inversion
const reversed = items.reverse();
// → Nœud: { type: "computation", operation: "reverse" }
```

### **4. Extraction/Manipulation**

```typescript
// .slice() - Extraction sous-array
const first10 = items.slice(0, 10);
// → Nœud: { type: "computation", operation: "slice", start: 0, end: 10 }

// .splice() - Modification (mutation!)
items.splice(2, 1);
// → Nœud: { type: "computation", operation: "splice", start: 2, deleteCount: 1 }
// ⚠️ Mutation - nécessite attention

// .concat() - Concaténation
const all = arr1.concat(arr2);
// → Nœud: { type: "computation", operation: "concat", arrays: ["arr2"] }

// .join() - Array → String
const csv = items.join(",");
// → Nœud: { type: "computation", operation: "join", separator: ',' }
```

### **5. Chaînes d'Opérations (Très Important)**

```typescript
// Pipeline ETL typique
const result = data
  .filter((x) => x.active) // Task 1
  .map((x) => x.name.toUpperCase()) // Task 2
  .sort() // Task 3
  .slice(0, 10); // Task 4

// DAG généré :
// task_1 (filter) → task_2 (map) → task_3 (sort) → task_4 (slice)
// Dépendances automatiques : each → previous
```

## 🔍 À Ajouter : String Operations (Priorité 2)

Très fréquent pour manipulation de texte :

```typescript
// .split() - String → Array
const words = text.split(" ");
// → Nœud: { type: "computation", operation: "split", separator: ' ' }

// .replace() / .replaceAll() - Remplacement
const cleaned = text.replace(/\s+/g, " ");
// → Nœud: { type: "computation", operation: "replace", pattern: "/\\s+/g", replacement: ' ' }

// .trim() / .trimStart() / .trimEnd()
const trimmed = text.trim();
// → Nœud: { type: "computation", operation: "trim" }

// .toLowerCase() / .toUpperCase()
const lower = text.toLowerCase();
// → Nœud: { type: "computation", operation: "toLowerCase" }

// .substring() / .substr() / .slice()
const excerpt = text.substring(0, 100);
// → Nœud: { type: "computation", operation: "substring", start: 0, end: 100 }

// .match() / .matchAll()
const matches = text.match(/\d+/g);
// → Nœud: { type: "computation", operation: "match", pattern: "/\\d+/g" }

// Template literals (complexe)
const msg = `Hello ${user.name}`;
// → Nœud: { type: "computation", operation: "template", parts: ["Hello ", "user.name"] }
```

## 🔍 À Ajouter : Object Operations (Priorité 2)

```typescript
// Object.keys()
const keys = Object.keys(obj);
// → Nœud: { type: "computation", operation: "Object.keys" }

// Object.values()
const values = Object.values(obj);
// → Nœud: { type: "computation", operation: "Object.values" }

// Object.entries()
const entries = Object.entries(obj);
// → Nœud: { type: "computation", operation: "Object.entries" }

// Object.assign() / spread
const merged = { ...obj1, ...obj2 };
// → Nœud: { type: "computation", operation: "spread", sources: ["obj1", "obj2"] }

// Object.fromEntries()
const obj = Object.fromEntries(entries);
// → Nœud: { type: "computation", operation: "Object.fromEntries" }

// Destructuring
const { name, age } = user;
// → Nœud: { type: "computation", operation: "destructure", keys: ["name", "age"] }
```

## 🔍 À Ajouter : Aggregation/Math (Priorité 3)

```typescript
// Math.max() / Math.min()
const max = Math.max(...numbers);
// → Nœud: { type: "computation", operation: "Math.max" }

// Math.sum (via reduce)
const sum = numbers.reduce((a, b) => a + b, 0);
// → Nœud: { type: "computation", operation: "sum" }

// Math.avg (via reduce)
const avg = numbers.reduce((a, b) => a + b, 0) / numbers.length;
// → Nœud: { type: "computation", operation: "average" }

// Groupement (groupBy pattern)
const grouped = items.reduce((acc, item) => {
  (acc[item.category] ??= []).push(item);
  return acc;
}, {});
// → Nœud: { type: "computation", operation: "groupBy", key: "item.category" }
```

## 🔍 À Ajouter : Async Patterns (Priorité 1)

```typescript
// Promise.race()
const fastest = await Promise.race([fetch1(), fetch2()]);
// → Nœud: { type: "fork", strategy: "race" }

// Sequential awaits (déjà détecté implicitement via dependencies)
const a = await task1();
const b = await task2(a);
// → task_1 → task_2 (dependency auto)

// .then() chains
const result = fetch()
  .then(r => r.json())
  .then(d => d.filter(...));
// → task_1 (fetch) → task_2 (json) → task_3 (filter)
```

## 🔍 À Ajouter : JSON/Serialization (Priorité 2)

```typescript
// JSON.parse()
const obj = JSON.parse(jsonString);
// → Nœud: { type: "computation", operation: "JSON.parse" }

// JSON.stringify()
const json = JSON.stringify(obj, null, 2);
// → Nœud: { type: "computation", operation: "JSON.stringify", indent: 2 }
```

## 🔍 À Ajouter : Loops (Priorité 3 - Complexe)

```typescript
// for...of (itération)
for (const user of users) {
  await mcp.db.insert({ user });
}
// → fork (parallel) avec N tasks : mcp.db.insert pour chaque user

// for...in (keys)
for (const key in obj) {
  console.log(key, obj[key]);
}
// → fork avec Object.keys() + tasks par key

// .forEach() (side effects)
users.forEach((u) => console.log(u.name));
// → map (si pure) ou tasks séquentielles (si side effects)

// while (complexe - dépend de condition dynamique)
while (hasMore) {
  const batch = await fetchNext();
  hasMore = batch.length > 0;
}
// → Difficile à DAGifier (condition dynamique)
// → Fallback à task unique "code_execution"
```

## 🔍 À Ajouter : Error Handling (Priorité 2)

```typescript
// try/catch
try {
  const result = await riskyOperation();
} catch (error) {
  console.error(error);
}
// → Nœud: { type: "try_catch", task: "riskyOperation", errorHandler: "..." }
// → Permet safe-to-fail automatique

// Optional chaining
const name = user?.profile?.name;
// → Nœud: { type: "computation", operation: "optional_chain", path: "user.profile.name" }

// Nullish coalescing
const port = config.port ?? 3000;
// → Nœud: { type: "computation", operation: "nullish_coalesce", fallback: 3000 }
```

## 🎯 Stratégie de Détection Recommandée

### **Phase 1 : Array Operations (Quick Win)**

Priorité immédiate car :

- ✅ Très fréquent dans code agent
- ✅ Facilement chainable (DAG naturel)
- ✅ Parsing simple (CallExpression sur MemberExpression)
- ✅ Sérialisation simple (lambdas pures)

**Méthodes à détecter :**

- `.filter()`, `.map()`, `.reduce()`, `.flatMap()`
- `.find()`, `.findIndex()`, `.some()`, `.every()`
- `.sort()`, `.reverse()`
- `.slice()`, `.concat()`, `.join()`

### **Phase 2 : Async Patterns + String Ops**

- `Promise.race()`
- `.then()` chains
- String manipulations (`.split()`, `.replace()`, etc.)

### **Phase 3 : Objects + JSON**

- `Object.keys/values/entries()`
- `JSON.parse/stringify()`

### **Phase 4 : Advanced (Plus tard)**

- Loops (for...of avec side effects)
- Error handling (try/catch → safe-to-fail)
- Math/Aggregations

## 🛠️ Implémentation SWC

Pour détecter ces patterns, ajouter dans `handleCallExpression()` :

```typescript
private handleCallExpression(n: Record<string, unknown>, ...): boolean {
  const callee = n.callee as Record<string, unknown> | undefined;
  if (!callee) return false;

  // Existing: mcp.*, capabilities.*, Promise.all
  // ...

  // NEW: Array operations
  if (callee.type === "MemberExpression") {
    const chain = this.extractMemberChain(callee);
    const methodName = chain[chain.length - 1];

    // Array operations
    const arrayOps = [
      'filter', 'map', 'reduce', 'flatMap',
      'find', 'findIndex', 'some', 'every',
      'sort', 'reverse', 'slice', 'concat', 'join'
    ];

    if (arrayOps.includes(methodName)) {
      const nodeId = this.generateNodeId("computation");
      nodes.push({
        id: nodeId,
        type: "computation",
        operation: methodName,
        code: this.extractCallbackCode(n), // Extract lambda
        position,
        parentScope
      });
      return true; // Handled
    }

    // String operations
    const stringOps = [
      'split', 'replace', 'replaceAll', 'trim', 'toLowerCase', 'toUpperCase',
      'substring', 'substr', 'slice', 'match', 'matchAll'
    ];

    if (stringOps.includes(methodName)) {
      const nodeId = this.generateNodeId("computation");
      nodes.push({
        id: nodeId,
        type: "computation",
        operation: methodName,
        code: this.extractMethodArgs(n),
        position,
        parentScope
      });
      return true;
    }

    // Object operations (Object.keys, etc.)
    if (chain[0] === "Object" && ['keys', 'values', 'entries', 'fromEntries', 'assign'].includes(chain[1])) {
      const nodeId = this.generateNodeId("computation");
      nodes.push({
        id: nodeId,
        type: "computation",
        operation: `Object.${chain[1]}`,
        position,
        parentScope
      });
      return true;
    }

    // Math operations
    if (chain[0] === "Math" && ['max', 'min', 'abs', 'floor', 'ceil', 'round'].includes(chain[1])) {
      const nodeId = this.generateNodeId("computation");
      nodes.push({
        id: nodeId,
        type: "computation",
        operation: `Math.${chain[1]}`,
        position,
        parentScope
      });
      return true;
    }

    // JSON operations
    if (chain[0] === "JSON" && ['parse', 'stringify'].includes(chain[1])) {
      const nodeId = this.generateNodeId("computation");
      nodes.push({
        id: nodeId,
        type: "computation",
        operation: `JSON.${chain[1]}`,
        position,
        parentScope
      });
      return true;
    }
  }

  return false;
}
```

## 📊 Bénéfices de la Détection Étendue

### **1. DAG Automatique Ultra-Granulaire**

```typescript
// Code agent :
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const active = users.filter((u) => u.active);
const names = active.map((u) => u.name.toUpperCase());
const sorted = names.sort();
const top10 = sorted.slice(0, 10);
const csv = top10.join(",");

// DAG auto-généré (6 tasks) :
task_1: mcp.db.query;
task_2: filter;
task_3: map;
task_4: sort;
task_5: slice;
task_6: join;

// Chaque task peut :
// - Avoir son checkpoint
// - Être validée par HIL
// - Être apprise comme pattern
// - S'exécuter en parallèle si indépendante
```

### **2. Parallélisation Automatique Intelligente**

```typescript
// Code agent :
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const activeUsers = users.filter(u => u.active);
const premiumUsers = users.filter(u => u.premium);
const adminUsers = users.filter(u => u.role === 'admin');

// DAG parallèle auto :
task_1: mcp.db.query
  ├─→ task_2: filter (active)     ┐
  ├─→ task_3: filter (premium)    ├─ PARALLÈLE
  └─→ task_4: filter (admin)      ┘
```

### **3. Pattern Learning pour Capabilities**

Le GraphRAG peut apprendre :

- **"ETL pipeline pattern"** : query → filter → map → sort
- **"Data validation pattern"** : .every() checks
- **"Aggregation pattern"** : .reduce() + Math operations
- **"Search pattern"** : .filter() + .find()

Ces patterns deviennent des **capabilities réutilisables**.

### **4. HIL Intelligent**

Validation humaine seulement sur les opérations critiques :

- ✅ `.filter()` sur données sensibles
- ✅ `.map()` qui transforme données personnelles
- ❌ `.join()` ou `.slice()` (pas sensible)

## ⚠️ Challenges

1. **Sérialisation lambdas** : Les callbacks doivent être sérialisables
2. **Side effects** : `.forEach()` avec mutations est problématique
3. **Contexte scope** : Variables externes aux lambdas
4. **Performance** : Trop de tasks = overhead (besoin seuil minimum)

## 🎯 Recommandation Immédiate

**Commencer par Array Operations (Phase 1)** :

- Impact immédiat sur 80% du code agent
- Parsing simple
- Bénéfices clairs (granularité, parallélisme, learning)
- Quick win (~2-3 jours d'implémentation)
