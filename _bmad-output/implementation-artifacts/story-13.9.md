# Story 13.9: Routing Inheritance

**Epic:** 13 - Capability Naming & Curation **Story ID:** 13.9 **Status:** ready-for-dev **Estimated
Effort:** 3-4 heures **Depends On:** Story 13.8 (pml_registry)

---

## User Story

**As a** developer, **I want** capability routing automatically inherited from tools used, **So
that** local execution happens when any tool requires local access, without manual configuration.

---

## Context

Quand une capability est créée, on ne sait pas si elle doit tourner en local ou cloud. Mais on peut
l'inférer des tools utilisés :

- Si UN tool est local-only (filesystem, shell) → capability DOIT tourner en local
- Si TOUS les tools sont cloud → capability peut tourner dans le cloud

Cela évite la configuration manuelle du routing.

---

## Acceptance Criteria

1. **AC1: tools_used tracking** ✅ EXISTE DÉJÀ
   - `tools_used` array populé dans `workflow_pattern.dag_structure`

2. **AC2: Routing dans mcp-permissions.yaml**
   - Chaque MCP server a un champ `routing: local | cloud`
   - Exemple : `filesystem: { routing: local }`, `tavily: { routing: cloud }`

3. **AC3: Routing Resolution - Local Priority**
   - Si `tools_used` contient UN tool local → `routing = "local"`
   - Exemple : `["filesystem:read", "tavily:search"]` → `local` (filesystem est local)

4. **AC4: Routing Resolution - All Cloud**
   - Si TOUS les tools sont cloud → `routing = "cloud"`
   - Exemple : `["tavily:search", "github:list_issues"]` → `cloud`

5. **AC5: Explicit Override**
   - Si capability a `routing` explicite → respecter cette valeur
   - L'héritage ne s'applique que si routing non défini

6. **AC6: No Tools Used**
   - Si `tools_used` est vide (pure compute) → default `cloud`

7. **AC7: API Exposure** ✅ EXISTE DÉJÀ
   - `cap:lookup` retourne `routing` dans la réponse

---

## Out of Scope

- ❌ Routing dynamique au runtime (on calcule à la création/update)
- ❌ UI pour visualiser le routing
- ❌ Override via API (pour l'instant, seulement via DB)

---

## Tasks / Subtasks

### Phase 1: Mise à jour mcp-permissions.yaml (30min)

- [ ] **Task 1: Ajouter routing à chaque MCP server** (AC: #2)
  ```yaml
  filesystem:
    permissionSet: filesystem
    isReadOnly: false
    routing: local # NOUVEAU

  tavily:
    permissionSet: network-api
    isReadOnly: false
    routing: cloud # NOUVEAU
  ```
  - [ ] filesystem → local
  - [ ] fs → local
  - [ ] sqlite → local
  - [ ] shell (si existant) → local
  - [ ] github → cloud
  - [ ] tavily → cloud
  - [ ] slack → cloud
  - [ ] Tous les autres servers...

### Phase 2: Parser le routing (1h)

- [ ] **Task 2: Mettre à jour permission-inferrer.ts** (AC: #2)
  - [ ] Ajouter `routing?: "local" | "cloud"` au type `PermissionConfig`
  - [ ] Parser le champ `routing` depuis le YAML
  - [ ] Default à `cloud` si non spécifié

- [ ] **Task 3: Créer getMcpRouting()** (AC: #2)
  ```typescript
  export function getMcpRouting(serverId: string): "local" | "cloud" {
    const config = getToolPermissionConfig(serverId);
    return config?.routing ?? "cloud";
  }
  ```

### Phase 3: Routing Resolution (1.5h)

- [ ] **Task 4: Créer resolveCapabilityRouting()** (AC: #3, #4, #5, #6)
  ```typescript
  export function resolveCapabilityRouting(
    toolsUsed: string[],
    explicitRouting?: "local" | "cloud",
  ): "local" | "cloud" {
    // AC5: Explicit override
    if (explicitRouting) return explicitRouting;

    // AC6: No tools → cloud
    if (toolsUsed.length === 0) return "cloud";

    // AC3/AC4: Check each tool
    for (const toolId of toolsUsed) {
      const serverId = toolId.split(":")[0];
      if (getMcpRouting(serverId) === "local") {
        return "local"; // AC3: One local → all local
      }
    }
    return "cloud"; // AC4: All cloud
  }
  ```

- [ ] **Task 5: Intégrer dans capability-store.ts** (AC: #3, #4)
  - [ ] Appeler `resolveCapabilityRouting()` lors de `saveCapability()`
  - [ ] Passer le routing calculé au `CapabilityRegistry.create()`

- [ ] **Task 6: Intégrer dans capability-registry.ts** (AC: #3, #4)
  - [ ] Accepter `routing` dans `CreateCapabilityRecordInput`
  - [ ] Stocker dans `pml_registry`

### Phase 4: Tests (1h)

- [ ] **Task 7: Tests unitaires resolveCapabilityRouting()** (AC: #3, #4, #5, #6)
  - [ ] Test: `["filesystem:read"]` → `local`
  - [ ] Test: `["tavily:search"]` → `cloud`
  - [ ] Test: `["filesystem:read", "tavily:search"]` → `local`
  - [ ] Test: `[]` → `cloud`
  - [ ] Test: explicit `local` override → `local`
  - [ ] Test: explicit `cloud` override → `cloud`

- [ ] **Task 8: Test d'intégration** (AC: #3, #4)
  - [ ] Créer capability avec `mcp.filesystem.read_file()`
  - [ ] Vérifier `routing = "local"` dans DB
  - [ ] Créer capability avec `mcp.tavily.search()`
  - [ ] Vérifier `routing = "cloud"` dans DB

---

## Files to Update

```
config/mcp-permissions.yaml          # Ajouter routing à chaque server
src/capabilities/permission-inferrer.ts  # Parser routing, getMcpRouting()
src/capabilities/routing-resolver.ts     # NOUVEAU: resolveCapabilityRouting()
src/capabilities/capability-store.ts     # Appeler resolveCapabilityRouting()
src/capabilities/capability-registry.ts  # Accepter routing dans create()
tests/unit/capabilities/routing-resolver_test.ts  # NOUVEAU
```

---

## Technical Notes

### Routing des MCP servers connus

| Server       | Routing | Raison                 |
| ------------ | ------- | ---------------------- |
| filesystem   | local   | Accès fichiers locaux  |
| fs           | local   | Alias filesystem       |
| sqlite       | local   | DB locale              |
| shell        | local   | Exécution shell locale |
| git          | local   | Repo local             |
| ---          | ---     | ---                    |
| github       | cloud   | API GitHub             |
| tavily       | cloud   | API Tavily             |
| slack        | cloud   | API Slack              |
| postgres     | cloud   | DB distante            |
| brave_search | cloud   | API Brave              |

### Exemple de flow

```
1. pml:execute({ code: "await mcp.filesystem.read_file({path: 'x.json'})" })

2. Exécution réussie, tools_used = ["filesystem:read_file"]

3. saveCapability() appelle resolveCapabilityRouting(["filesystem:read_file"])
   → getMcpRouting("filesystem") → "local"
   → return "local"

4. CapabilityRegistry.create({ ..., routing: "local" })

5. Stocké dans pml_registry avec routing = "local"

6. cap:lookup("fs:read_json") → { routing: "local", ... }
```

---

## Definition of Done

- [ ] `routing` ajouté à tous les servers dans mcp-permissions.yaml
- [ ] `getMcpRouting()` fonctionne
- [ ] `resolveCapabilityRouting()` implémenté et testé
- [ ] Nouvelles capabilities ont le bon routing auto-calculé
- [ ] `deno task test` passe
- [ ] `deno task check` passe
