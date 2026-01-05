# Modular Code Execution avec SWC

## Exemple : Pipeline de Transformation de Données

### Code Original (Agent)

```typescript
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const activeUsers = users.filter((u) => u.status === "active");
const userNames = activeUsers.map((u) => u.name);
const sortedNames = userNames.sort();
const uniqueNames = [...new Set(sortedNames)];
return uniqueNames;
```

### Décomposition en Tasks Modulaires

#### **Task 1 : MCP Database Query**

```typescript
{
  id: "task_n1",
  type: "mcp_tool",
  tool: "db:query",
  arguments: { sql: "SELECT * FROM users" },
  dependsOn: []
}
```

#### **Task 2 : Filter (Computation)**

```typescript
{
  id: "task_c1",
  type: "code_execution",
  code: `
    const users = deps.task_n1.output;
    return users.filter(u => u.status === 'active');
  `,
  metadata: { operation: "filter" },
  dependsOn: ["task_n1"],
  safe_to_fail: true
}
```

#### **Task 3 : Map (Computation)**

```typescript
{
  id: "task_c2",
  type: "code_execution",
  code: `
    const activeUsers = deps.task_c1.output;
    return activeUsers.map(u => u.name);
  `,
  metadata: { operation: "map" },
  dependsOn: ["task_c1"],
  safe_to_fail: true
}
```

#### **Task 4 : Sort (Computation)**

```typescript
{
  id: "task_c3",
  type: "code_execution",
  code: `
    const userNames = deps.task_c2.output;
    return userNames.sort();
  `,
  metadata: { operation: "sort" },
  dependsOn: ["task_c2"],
  safe_to_fail: true
}
```

#### **Task 5 : Deduplicate (Computation)**

```typescript
{
  id: "task_c4",
  type: "code_execution",
  code: `
    const sortedNames = deps.task_c3.output;
    return [...new Set(sortedNames)];
  `,
  metadata: { operation: "deduplicate" },
  dependsOn: ["task_c3"],
  safe_to_fail: true
}
```

## DAG Visuel

```
task_n1 (DB query)
    ↓
task_c1 (filter)
    ↓
task_c2 (map)
    ↓
task_c3 (sort)
    ↓
task_c4 (deduplicate)
    ↓
return
```

## Bénéfices

### 1. HIL Granulaire

Validation humaine possible après chaque étape :

- ✅ "Les users sont-ils corrects ?" (après task_n1)
- ✅ "Le filtre active est-il bon ?" (après task_c1)
- ✅ "Les noms mappés sont corrects ?" (après task_c2)

### 2. Checkpoints et Resume

```typescript
// Si erreur à task_c3, on peut reprendre depuis task_c2
const checkpoint = await checkpointManager.loadCheckpoint(workflowId);
// checkpoint.currentLayer = 3 (task_c3)
// checkpoint.results = { task_n1: {...}, task_c1: {...}, task_c2: {...} }
```

### 3. Parallélisation Automatique

Si le code a des branches indépendantes :

```typescript
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const activeUsers = users.filter(u => u.status === 'active');
const premiumUsers = users.filter(u => u.premium === true);

// DAG parallèle :
task_n1
  ├─→ task_c1 (filter active)
  └─→ task_c2 (filter premium)  // Exécution PARALLÈLE
```

### 4. Learning Patterns

Le GraphRAG peut apprendre des patterns réutilisables :

- "filter pattern" : Filtrage par statut
- "map pattern" : Extraction de propriété
- "deduplicate pattern" : Utilisation de Set

Ces patterns peuvent devenir des **capabilities** réutilisables.

## Challenges

### 1. Sérialisation

Les données doivent être JSON-serializable entre tasks.

❌ **Ne marche pas :**

```typescript
const fn = () => {/* closure */};
const result = data.map(fn); // fn pas sérialisable
```

✅ **Marche :**

```typescript
const result = data.map((u) => u.name); // Lambda sérialisable
```

### 2. Scope Variables

Les variables locales ne sont pas accessibles entre tasks.

❌ **Ne marche pas :**

```typescript
const multiplier = 2;
const result = data.map((x) => x * multiplier); // multiplier pas accessible
```

✅ **Solution :**

```typescript
// Task 1 : Passer multiplier via context
{
  code: "const multiplier = 2; return multiplier;";
}

// Task 2 : Recevoir via deps
{
  code: "const mult = deps.task_1.output; return data.map(x => x * mult);";
}
```

### 3. Side Effects

Les side effects doivent être isolés.

❌ **Ne marche pas :**

```typescript
let counter = 0;
data.forEach((x) => counter++); // Mutation externe
```

✅ **Solution :**

```typescript
return data.reduce((count, _) => count + 1, 0); // Pure function
```

## Stratégie de Découpage

### Niveau 1 : Statement Boundaries (Simple)

Découper au niveau des statements (lignes) :

```typescript
const a = 1; // task_1
const b = a + 2; // task_2 (dépend de task_1)
const c = b * 3; // task_3 (dépend de task_2)
```

**Avantage :** Simple à implémenter **Inconvénient :** Trop granulaire (trop de tasks)

### Niveau 2 : Operation Chains (Moyen)

Découper les chaînes d'opérations :

```typescript
const result = data
  .filter((x) => x.active) // task_1
  .map((x) => x.name) // task_2
  .sort(); // task_3
```

**Avantage :** Balance granularité/performance **Inconvénient :** Complexe à parser (CallExpression
chains)

### Niveau 3 : Logical Blocks (Complexe)

Découper par blocs logiques (heuristiques) :

```typescript
// Block 1 : Data fetch
const users = await mcp.db.query(...);
const orders = await mcp.db.query(...);

// Block 2 : Join operation
const enriched = users.map(u => ({
  ...u,
  orders: orders.filter(o => o.userId === u.id)
}));

// Block 3 : Aggregation
const stats = enriched.map(u => ({
  name: u.name,
  orderCount: u.orders.length
}));
```

**Avantage :** Optimal pour learning **Inconvénient :** Très complexe à implémenter (nécessite
heuristiques)

## Recommandation

**Niveau 2 (Operation Chains)** : Meilleur compromis.

### Implémentation Prioritaire

1. Détecter les **méthodes chainables** :
   - `.filter()`
   - `.map()`
   - `.reduce()`
   - `.sort()`
   - `.find()`
   - `.some()`, `.every()`

2. Créer un nœud `computation` par segment

3. Générer le code avec injection de dépendances

4. Convertir en tasks `code_execution` dans le DAG
