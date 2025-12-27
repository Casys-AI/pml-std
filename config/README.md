# Configuration Casys PML

Ce dossier contient les fichiers de configuration versionnés pour Casys PML.

## Structure

```
config/
├── workflow-templates.yaml    # Templates GraphRAG pour bootstrap
├── speculation_config.yaml    # Configuration spéculation
├── mcp-permissions.yaml       # Métadonnées permissions MCP tools
└── README.md                  # Ce fichier

# À la racine du projet :
.mcp-servers.example.json      # Template config MCP (versionné)
.mcp-servers.json              # Config MCP locale (gitignored)
.mcp.json                      # Config Claude Code
```

## MCP Permissions (`mcp-permissions.yaml`)

**Important:** Ce fichier contient des **métadonnées**, pas des permissions sandbox. Le Worker Deno
exécute toujours avec `permissions: "none"`. Les MCP servers tournent comme des processus séparés
avec leurs propres droits.

### Utilité

1. **Détection de validation** - Déclenche `per_layer_validation` si nécessaire
2. **Audit/Logging** - Documente le scope revendiqué par chaque outil

### Format

```yaml
# Format simple
github:
  scope: network-api # minimal|readonly|filesystem|network-api|mcp-standard
  approvalMode: auto # auto = fonctionne, hil = validation requise

# Format legacy (rétrocompatible)
filesystem:
  permissionSet: filesystem
  isReadOnly: false
```

### Validation Rules

La validation per-layer est déclenchée si :

- **Outil inconnu** (pas dans ce fichier)
- **`approvalMode: hil`** explicite
- **`code_execution`** avec permissions non-minimales

## Configuration MCP

### Setup Initial

```bash
# Copier le template
cp .mcp-servers.example.json .mcp-servers.json
```

### `.mcp-servers.example.json` (template)

Template avec chemin relatif `.` - fonctionne partout (local + Codespace) :

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

### `.mcp.json` (Claude Code)

Configure Casys PML gateway comme serveur MCP pour Claude Code :

```json
{
  "mcpServers": {
    "pml": {
      "command": "deno",
      "args": ["run", "--allow-all", "src/main.ts", "serve", "--config", ".mcp-servers.json"]
    }
  }
}
```

---

## Serveurs MCP Tier 1

### 1. Filesystem Server

**Package**: `@modelcontextprotocol/server-filesystem`

**Objectif**: Parallélisation lecture/écriture fichiers

**Outils**:

- `read_multiple_files` - Lecture parallèle
- `read_text_file` - Lecture avec head/tail
- `list_directory` - Lister contenu
- `write_file` - Écriture fichiers

**Pattern DAG**:

```
[Parallèle] read_multiple_files([package.json, README.md])
     ↓
[Séquentiel] Synthèse des résultats
```

### 2. Memory Server

**Package**: `@modelcontextprotocol/server-memory`

**Objectif**: Knowledge graph local pour GraphRAG

**Outils**:

- `create_entities` - Créer entités
- `create_relations` - Créer relations
- `read_graph` - Lire le graphe
- `search_nodes` - Recherche sémantique

### 3. Sequential Thinking Server

**Package**: `@modelcontextprotocol/server-sequential-thinking`

**Objectif**: Branchement DAG pour résolution de problèmes

**Outils**:

- `sequentialthinking` - Pensée structurée avec branchement

**Pattern branchement**:

```
Pensée 1 → Pensée 2
              ├─ Branche A (database)
              └─ Branche B (frontend)
```

---

## Workflow Templates

### `workflow-templates.yaml`

Définit les patterns GraphRAG pour bootstrap :

1. **Parallel Pattern** - Exécution parallèle d'outils indépendants
2. **Sequential Pattern** - Pipeline filesystem → memory
3. **Multi-level DAG** - Fan-out → parallel → fan-in

**Sync vers DB**:

```bash
deno task cli workflows sync
```

---

## Références

- [PRD Playground](../docs/PRD-playground.md)
- [Documentation MCP](https://modelcontextprotocol.io/docs)
