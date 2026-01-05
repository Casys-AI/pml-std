# Permissions pour Opérations JS Pures

Stratégie de permissions pour les tasks d'opérations JavaScript pures (filter, map, reduce, +, -,
etc.) afin de bypasser les validations HIL inutiles.

## 🎯 **Problème**

Avec l'architecture two-level qui crée des tasks pour chaque opération, on risque de déclencher des
validations HIL sur des opérations purement computationnelles qui ne peuvent PAS avoir de side
effects.

### **Exemple**

```typescript
// Code agent :
const users = await mcp.db.query(...);
const active = users.filter(u => u.active);
const avg = active.reduce((s, u) => s + u.age, 0) / active.length;

// DAG généré :
task_n1: db:query (MCP)
task_c1: filter (JS pur)
task_c2: reduce (JS pur)
task_c3: length (JS pur)
task_c4: divide (JS pur)

// Sans optimisation :
// → Validation HIL sur TOUTES les layers ?
// → Inutile pour filter, reduce, length, divide
```

**Problème :** Les opérations JS pures NE PEUVENT PAS :

- Accéder au filesystem
- Faire des requêtes network
- Exécuter des processus
- Avoir des side effects externes

**Donc :** Aucune validation HIL nécessaire !

---

## ✅ **Solution : Auto-Classification des Opérations Pures**

### **Principe**

Les opérations JS pures sont **toujours safe** et doivent :

1. ✅ Avoir `permissionSet: "minimal"`
2. ✅ `isSafeToFail() = true`
3. ✅ Bypasser validation HIL automatiquement

### **Liste des Opérations Pures**

```typescript
/**
 * Opérations JavaScript purement computationnelles
 * Ces opérations NE PEUVENT PAS avoir de side effects externes
 */
const PURE_OPERATIONS = [
  // Array operations
  "code:filter",
  "code:map",
  "code:reduce",
  "code:flatMap",
  "code:find",
  "code:findIndex",
  "code:some",
  "code:every",
  "code:sort",
  "code:reverse",
  "code:slice",
  "code:concat",
  "code:join",
  "code:includes",

  // String operations
  "code:split",
  "code:replace",
  "code:replaceAll",
  "code:trim",
  "code:trimStart",
  "code:trimEnd",
  "code:toLowerCase",
  "code:toUpperCase",
  "code:substring",
  "code:substr",
  "code:slice",
  "code:match",
  "code:matchAll",
  "code:padStart",
  "code:padEnd",

  // Object operations
  "code:Object.keys",
  "code:Object.values",
  "code:Object.entries",
  "code:Object.fromEntries",
  "code:Object.assign",

  // Arithmétique
  "code:add",
  "code:subtract",
  "code:multiply",
  "code:divide",
  "code:modulo",
  "code:power",

  // Comparaison
  "code:equals",
  "code:not_equals",
  "code:greater_than",
  "code:less_than",
  "code:greater_or_equal",
  "code:less_or_equal",

  // Logique
  "code:and",
  "code:or",
  "code:not",

  // Math operations
  "code:Math.round",
  "code:Math.floor",
  "code:Math.ceil",
  "code:Math.abs",
  "code:Math.min",
  "code:Math.max",
  "code:Math.sqrt",
  "code:Math.pow",

  // Accès propriétés
  "code:get_property",
  "code:get_length",
  "code:array_access",

  // JSON (SAFE - pas d'I/O)
  "code:JSON.parse",
  "code:JSON.stringify",

  // Type conversions
  "code:Number",
  "code:String",
  "code:Boolean",
  "code:Array.from",
];

/**
 * Opérations ASYNC ou avec side effects potentiels
 * Ces opérations NÉCESSITENT validation
 */
const UNSAFE_OPERATIONS = [
  // Async operations
  "code:Promise.all",
  "code:Promise.race",
  "code:Promise.allSettled",
  "code:await",

  // Potentiellement unsafe
  "code:eval", // JAMAIS autoriser
  "code:Function", // JAMAIS autoriser
  "code:setTimeout", // Side effect
  "code:setInterval", // Side effect
  "code:fetch", // Network I/O
  "code:console.log", // Side effect (output)
];
```

---

## 🔧 **Implémentation**

### **1. Détection Automatique dans Static→DAG Converter**

```typescript
/**
 * Vérifie si une opération est purement computationnelle
 */
function isPureOperation(toolId: string): boolean {
  return PURE_OPERATIONS.includes(toolId);
}

/**
 * Convertit un nœud en task avec permissions automatiques
 */
function convertNodeToTask(node: StaticStructureNode): Task {
  if (node.type === "task" && node.tool.startsWith("code:")) {
    const isPure = isPureOperation(node.tool);

    return {
      id: `task_${node.id}`,
      type: "code_execution",
      tool: node.tool,
      code: generateOperationCode(node),
      arguments: {},
      dependsOn: inferDependencies(node),
      sandboxConfig: {
        permissionSet: "minimal", // ← TOUJOURS minimal pour opérations pures
        timeout: isPure ? 5000 : 30000, // Timeout plus court pour opérations pures
      },
      metadata: {
        pure: isPure, // ← Marquer comme pure
        safe: isPure, // ← Safe-to-fail
      },
    };
  }

  // MCP tool normal
  return convertMCPTask(node);
}
```

### **2. Extension de `isSafeToFail()`**

```typescript
// Dans src/dag/execution/task-router.ts

/**
 * Détermine si une task est safe-to-fail
 */
export function isSafeToFail(task: Task): boolean {
  // Code execution avec minimal permissions
  if (task.type === "code_execution") {
    const permSet = task.sandboxConfig?.permissionSet ?? "minimal";
    if (permSet !== "minimal") {
      return false;
    }

    // NOUVEAU : Opérations pures sont TOUJOURS safe
    if (task.metadata?.pure === true) {
      return true;
    }

    // NOUVEAU : Auto-détection via tool ID
    if (isPureOperation(task.tool)) {
      return true;
    }

    // Fallback : minimal permissions = safe
    return true;
  }

  // MCP tools ne sont jamais safe-to-fail
  return false;
}
```

### **3. Extension de `requiresValidation()`**

```typescript
// Dans src/mcp/handlers/workflow-execution-handler.ts

export async function requiresValidation(
  dag: DAGStructure,
  capabilityStore?: CapabilityStore,
): Promise<boolean> {
  for (const task of dag.tasks) {
    const taskType = getTaskType(task);

    if (taskType === "code_execution") {
      const permSet = task.sandboxConfig?.permissionSet ?? "minimal";

      // NOUVEAU : Opérations pures ne nécessitent JAMAIS validation
      if (task.metadata?.pure === true || isPureOperation(task.tool)) {
        log.debug(`Skipping validation for pure operation: ${task.tool}`);
        continue; // ← Pas de validation
      }

      // Code avec permissions élevées → validation
      if (permSet !== "minimal") {
        log.info(`Validation required: task ${task.id} has elevated permissions (${permSet})`);
        return true;
      }
    }

    // MCP tools : Vérifier mcp-permissions.yaml
    if (taskType === "mcp_tool") {
      const config = await getToolPermissionConfig(task.tool);
      if (config?.approvalMode === "hil") {
        log.info(`Validation required: tool ${task.tool} requires HIL approval`);
        return true;
      }
    }
  }

  return false; // Aucune validation nécessaire
}
```

### **4. Optimisation Layer-Level Validation**

```typescript
// Dans src/dag/controlled-executor.ts

/**
 * Vérifie si une layer contient des opérations qui nécessitent validation
 */
function layerRequiresValidation(layer: Task[]): boolean {
  for (const task of layer) {
    // Opération pure → skip
    if (task.metadata?.pure === true || isPureOperation(task.tool)) {
      continue;
    }

    // Code avec permissions élevées → validation
    if (task.type === "code_execution") {
      const permSet = task.sandboxConfig?.permissionSet ?? "minimal";
      if (permSet !== "minimal") {
        return true;
      }
    }

    // MCP tool avec HIL → validation
    if (task.type === "mcp_tool") {
      const config = getToolPermissionConfig(task.tool);
      if (config?.approvalMode === "hil") {
        return true;
      }
    }
  }

  return false; // Layer composée uniquement d'opérations pures
}

/**
 * Exécute les layers avec validation conditionnelle
 */
async function executeLayers() {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];

    // Vérifier si cette layer nécessite validation
    if (layerRequiresValidation(layer)) {
      log.info(`Layer ${i} requires validation (contains non-pure operations)`);
      await waitForHILApproval(layer);
    } else {
      log.debug(`Layer ${i} skipped validation (pure operations only)`);
    }

    // Exécuter la layer
    await executeLayer(layer);
  }
}
```

---

## 📊 **Exemple Concret**

### **Code Agent**

```typescript
const users = await mcp.db.query({ sql: "SELECT * FROM users" });
const active = users.filter((u) => u.active);
const totalAge = active.reduce((s, u) => s + u.age, 0);
const avgAge = totalAge / active.length;
const rounded = Math.round(avgAge);
await mcp.slack.send({ message: `Average age: ${rounded}` });
```

### **DAG Physique (2 layers)**

```typescript
// Layer 0 : MCP tools
{
  tasks: [
    {
      id: "task_n1",
      type: "mcp_tool",
      tool: "db:query",
      sandboxConfig: { permissionSet: "readonly" },
      // ⚠️ Nécessite validation (readonly permissions)
    },
  ];
}

// Layer 1 : Opérations pures + MCP send
{
  tasks: [
    // Fused computation (toutes opérations pures)
    {
      id: "task_fused",
      type: "code_execution",
      tool: "code:computation",
      sandboxConfig: { permissionSet: "minimal" },
      metadata: {
        pure: true, // ← Toutes les opérations fusionnées sont pures
        fusedFrom: ["task_c1", "task_c2", "task_c3", "task_c4", "task_c5"],
        logicalTools: [
          "code:filter", // ← Pure
          "code:reduce", // ← Pure
          "code:get_length", // ← Pure
          "code:divide", // ← Pure
          "code:Math.round", // ← Pure
        ],
      },
      // ✅ Pas de validation (pure)
    },

    // MCP send
    {
      id: "task_n2",
      type: "mcp_tool",
      tool: "slack:send",
      sandboxConfig: { permissionSet: "network-api" },
      // ⚠️ Nécessite validation (network access)
    },
  ];
}
```

### **Validation Flow**

```typescript
// Layer 0 :
layerRequiresValidation([task_n1]) → true (db:query avec readonly)
→ HIL validation requise
→ Humain approuve
→ Exécute

// Layer 1 :
layerRequiresValidation([task_fused, task_n2]) → true (slack:send avec network)
→ HIL validation requise (à cause de slack:send)
→ Mais task_fused est SKIPPÉ dans la vérification (pure)
→ Humain valide seulement slack:send
→ Exécute

// Résultat :
// - 2 validations HIL (db:query, slack:send)
// - 0 validation pour les opérations pures (filter, reduce, etc.)
```

### **Sans Optimisation (naïf)**

```typescript
// 7 layers séparées :
Layer 0: db:query           → Validation HIL
Layer 1: filter             → Validation HIL (inutile)
Layer 2: reduce             → Validation HIL (inutile)
Layer 3: length             → Validation HIL (inutile)
Layer 4: divide             → Validation HIL (inutile)
Layer 5: round              → Validation HIL (inutile)
Layer 6: slack:send         → Validation HIL

// → 7 validations (5 inutiles)
```

### **Avec Optimisation**

```typescript
// 2 layers :
Layer 0: db:query           → Validation HIL
Layer 1: fused + slack:send → Validation HIL (seulement pour slack:send)

// → 2 validations (0 inutile)
```

---

## 🔒 **Sécurité : Validation du Code Généré**

Pour s'assurer qu'une opération "pure" n'a pas été corrompue :

### **1. Validation Statique du Code**

```typescript
/**
 * Vérifie qu'une task marquée "pure" ne contient que du code safe
 */
function validatePureTask(task: Task): void {
  if (!task.metadata?.pure) {
    return; // Pas marquée pure, skip
  }

  if (!task.code) {
    throw new Error(`Pure task ${task.id} missing code`);
  }

  // Patterns interdits dans code pur
  const FORBIDDEN_PATTERNS = [
    /\bfetch\b/, // Network I/O
    /\bDeno\./, // Deno APIs (filesystem, network, etc.)
    /\bprocess\./, // Process APIs
    /\beval\b/, // Code injection
    /\bFunction\b/, // Code generation
    /\bsetTimeout\b/, // Side effects
    /\bsetInterval\b/, // Side effects
    /\bconsole\./, // Output (accepter seulement si debug)
    /\bimport\b/, // Dynamic imports
    /\brequire\b/, // CommonJS imports
  ];

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(task.code)) {
      throw new Error(
        `Pure task ${task.id} contains forbidden pattern: ${pattern.source}`,
      );
    }
  }
}
```

### **2. Runtime Enforcement**

Le Worker a déjà `permissions: "none"`, donc même si code corrompu :

```typescript
// Code corrompu tenté :
const result = await fetch("https://evil.com");
//                    ↑ PermissionDenied (Worker permissions: "none")

// Ou :
const file = Deno.readTextFileSync("/etc/passwd");
//           ↑ PermissionDenied (Worker permissions: "none")
```

**Donc :** Double sécurité

1. Validation statique du code généré
2. Runtime enforcement via Worker permissions

---

## 📋 **Metadata `pure` vs Detection via `tool` ID**

Deux approches complémentaires :

### **Approche 1 : Metadata Explicite**

```typescript
{
  id: "task_c1",
  tool: "code:filter",
  metadata: {
    pure: true  // ← Explicite
  }
}
```

**Avantage :** Clair et explicite **Inconvénient :** Doit être set partout

### **Approche 2 : Detection via Tool ID**

```typescript
function isPureOperation(toolId: string): boolean {
  return PURE_OPERATIONS.includes(toolId);
}

// Usage :
if (isPureOperation(task.tool)) {
  // C'est pur
}
```

**Avantage :** Automatique, pas de metadata à set **Inconvénient :** Dépend de la convention de
nommage

### **Recommandation : Combiner les Deux**

```typescript
function isPureTask(task: Task): boolean {
  // 1. Check metadata explicite
  if (task.metadata?.pure !== undefined) {
    return task.metadata.pure;
  }

  // 2. Fallback : Detection via tool ID
  return isPureOperation(task.tool);
}
```

---

## ✅ **Bénéfices**

| Aspect              | Sans Optimisation               | Avec Optimisation                     |
| ------------------- | ------------------------------- | ------------------------------------- |
| **Validations HIL** | N validations (toutes layers)   | 2-3 validations (MCP seulement)       |
| **UX**              | Validations inutiles ennuyantes | Validation seulement sur side effects |
| **Performance**     | Latence élevée (attente humain) | Latence réduite                       |
| **Sécurité**        | Identique (permissions minimal) | Identique + validation code           |
| **Auto-learning**   | Patterns complets appris        | Patterns complets appris              |

---

## 🎯 **Plan d'Implémentation**

### **Phase 1 : Liste des Opérations Pures (1 jour)**

1. Définir `PURE_OPERATIONS` constante
2. Définir `UNSAFE_OPERATIONS` constante
3. Implémenter `isPureOperation()`

### **Phase 2 : Auto-Classification (1 jour)**

1. Modifier `convertNodeToTask()` pour set `metadata.pure`
2. Implémenter `validatePureTask()` (validation statique)
3. Tests unitaires

### **Phase 3 : Bypass Validation (1 jour)**

1. Modifier `isSafeToFail()` pour détecter opérations pures
2. Modifier `requiresValidation()` pour skip opérations pures
3. Modifier `layerRequiresValidation()` dans ControlledExecutor

### **Phase 4 : Tests E2E (1 jour)**

1. Test : DAG avec uniquement opérations pures → 0 validation
2. Test : DAG mixte (pures + MCP) → validation seulement sur MCP
3. Test : Code corrompu dans opération pure → Erreur de validation

**Total : 4 jours**

---

## 🔍 **Configuration Utilisateur**

```typescript
// Configuration DAG :
{
  permissions: {
    autoclassifyPureOperations: true,  // Défaut : true
    validatePureCode: true,             // Validation statique (défaut : true)
    strictMode: false                   // Si true, rejette code non-pur (défaut : false)
  }
}
```

---

## ✅ **Conclusion**

**Les opérations JS pures doivent bypasser les validations HIL.**

**Solution :**

1. ✅ Auto-classification via `PURE_OPERATIONS` list
2. ✅ `permissionSet: "minimal"` toujours
3. ✅ `metadata.pure: true` pour skip validation
4. ✅ Validation statique du code pour sécurité
5. ✅ Runtime enforcement via Worker `permissions: "none"`

**Résultat :**

- Validation HIL seulement sur MCP tools et code avec permissions élevées
- Opérations pures (filter, map, +, -, etc.) exécutées sans validation
- Sécurité maintenue via double vérification (static + runtime)
- UX améliorée (moins de validations inutiles)
