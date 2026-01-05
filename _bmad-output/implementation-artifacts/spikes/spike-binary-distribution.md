# Spike: Distribution de la Version Compilée avec Dépendances Natives

**Date:** 2025-11-21 **Auteur:** Équipe Casys PML **Status:** Exploration

## Problème

`deno compile` **fonctionne** (la compilation réussit sans erreur), mais le binaire compilé **échoue
à l'exécution** à cause des dépendances natives manquantes ou incompatibles.

### Pourquoi la compilation fonctionne ?

`deno compile` n'a **pas besoin** des bibliothèques natives (`.so`) au moment de la compilation. Il
compile les modules npm dans le binaire, mais les bibliothèques natives sont chargées
**dynamiquement à l'exécution**.

### Erreurs rencontrées à l'exécution

Les utilisateurs rencontrent des erreurs au **démarrage du binaire** :

```
error: libonnxruntime.so.1: cannot open shared object file: No such file or directory
error: libvips-cpp.so.8.17.2: cannot open shared object file: No such file or directory
```

**Cas observé** : Même si libvips est installé (`libvips-cpp.so.42`), Sharp cherche une version
spécifique (`libvips-cpp.so.8.17.2`), causant un conflit de versions.

### Dépendances natives requises

1. **ONNX Runtime** (`libonnxruntime.so.1`) - Nécessaire pour Transformers.js (embeddings
   BGE-Large-EN-v1.5)
2. **libvips** (`libvips-cpp.so`) - Nécessaire pour Sharp (dépendance de Transformers.js pour
   traitement d'images)

### Pourquoi ces dépendances ?

- **Transformers.js** utilise ONNX Runtime pour l'inférence des modèles ML
- **Sharp** est une dépendance de Transformers.js (même si on ne fait que du texte, pas d'images)

## Options explorées

### Option 1: Script d'installation avec dépendances système

**Approche:**

- Fournir un script `install.sh` qui installe les dépendances système
- L'utilisateur exécute le script avant d'utiliser le binaire compilé

**Avantages:**

- ✅ Binaire standalone une fois les deps installées
- ✅ Performance optimale (binaire compilé)
- ✅ Simple pour l'utilisateur final

**Inconvénients:**

- ❌ Nécessite `sudo` (certains environnements ne le permettent pas)
- ❌ Spécifique à Linux (apt-get)
- ❌ Taille de téléchargement: ~200MB (ONNX Runtime ~150MB + libvips ~50MB)

**Implémentation:**

```bash
#!/bin/bash
# install.sh
sudo apt-get install -y libvips-dev
wget https://github.com/microsoft/onnxruntime/releases/download/v1.21.0/onnxruntime-linux-x64-1.21.0.tgz
# ... extraction et installation
```

---

### Option 2: Distribution avec `deno run` (pas de compilation)

**Approche:**

- Ne pas utiliser `deno compile`
- Distribuer le code source + instructions pour `deno run`
- Deno gère automatiquement les dépendances npm

**Avantages:**

- ✅ Aucun problème de bibliothèques natives
- ✅ Deno télécharge/cache automatiquement les dépendances npm
- ✅ Fonctionne sur tous les OS supportés par Deno
- ✅ Pas besoin de `sudo`

**Inconvénients:**

- ❌ Deno doit être installé
- ❌ Premier démarrage plus lent (téléchargement des deps)
- ❌ Pas de "vrai" binaire standalone

**Implémentation:**

```json
// .mcp.json
{
  "mcpServers": {
    "pml": {
      "command": "deno",
      "args": ["run", "--allow-all", "/path/to/src/main.ts", "serve"]
    }
  }
}
```

---

### Option 3: Container Docker

**Approche:**

- Distribuer une image Docker avec toutes les dépendances
- L'utilisateur exécute Casys PML via Docker

**Avantages:**

- ✅ Tout est embarqué (deps système + binaire)
- ✅ Reproductible sur tous les systèmes
- ✅ Isolation complète

**Inconvénients:**

- ❌ Nécessite Docker
- ❌ Taille de l'image: ~500MB-1GB
- ❌ Complexité pour MCP stdio (Docker <-> Claude Code)
- ❌ Overhead de performance

**Implémentation:**

```dockerfile
FROM denoland/deno:latest
RUN apt-get update && apt-get install -y libvips-dev
# ... installation ONNX Runtime
COPY . /app
RUN deno task build
ENTRYPOINT ["/app/pml"]
```

---

### Option 4: Binaire statique avec bibliothèques embarquées

**Approche:**

- Compiler ONNX Runtime et libvips en statique
- Les lier directement dans le binaire Deno

**Avantages:**

- ✅ Vrai binaire standalone (aucune dépendance externe)
- ✅ Expérience utilisateur optimale

**Inconvénients:**

- ❌ Très complexe (modification du build de Deno)
- ❌ Non supporté officiellement par Deno
- ❌ Taille du binaire: 3GB+ → 3.5GB+
- ❌ Maintenance difficile

---

### Option 5: Lazy loading des modèles ML

**Approche:**

- Ne charger Transformers.js/ONNX que si nécessaire
- Fournir une option `--no-embeddings` pour skip les ML models
- Utiliser une API externe pour embeddings (fallback)

**Avantages:**

- ✅ Utilisateurs sans ML peuvent utiliser le binaire compilé
- ✅ Flexibilité: local ML OU API externe

**Inconvénients:**

- ❌ Code plus complexe (lazy loading)
- ❌ Transformers.js s'importe au top-level (difficile à lazy load)
- ❌ Utilisateurs avec ML ont toujours besoin des deps

---

### Option 6: Remplacer Transformers.js par une alternative

**Approche:**

- Utiliser une bibliothèque d'embeddings sans dépendances natives
- Ou appeler une API externe (OpenAI, Cohere, etc.)

**Avantages:**

- ✅ Aucune dépendance native
- ✅ Binaire compilé fonctionne out-of-the-box

**Inconvénients:**

- ❌ Perte de "100% local" (valeur clé du produit)
- ❌ Nécessite API key + coûts pour utilisateurs
- ❌ Latence réseau

---

## Analyse comparative

| Critère                   | Option 1<br>Script install | Option 2<br>deno run | Option 3<br>Docker | Option 4<br>Static | Option 5<br>Lazy | Option 6<br>API |
| ------------------------- | -------------------------- | -------------------- | ------------------ | ------------------ | ---------------- | --------------- |
| **Facilité installation** | ⭐⭐⭐                     | ⭐⭐⭐⭐⭐           | ⭐⭐               | ⭐⭐⭐⭐⭐         | ⭐⭐⭐           | ⭐⭐⭐⭐⭐      |
| **Aucune dépendance**     | ❌                         | ✅ (sauf Deno)       | ❌ (Docker)        | ✅                 | ❌               | ✅              |
| **100% Local**            | ✅                         | ✅                   | ✅                 | ✅                 | ✅               | ❌              |
| **Performance**           | ⭐⭐⭐⭐⭐                 | ⭐⭐⭐⭐             | ⭐⭐⭐             | ⭐⭐⭐⭐⭐         | ⭐⭐⭐⭐         | ⭐⭐            |
| **Maintenance**           | ⭐⭐⭐                     | ⭐⭐⭐⭐⭐           | ⭐⭐⭐             | ⭐                 | ⭐⭐             | ⭐⭐⭐⭐        |
| **Taille distribution**   | 200MB                      | ~5MB (source)        | ~1GB               | ~3.5GB             | 200MB            | ~5MB            |
| **Multi-plateforme**      | ❌ (Linux only)            | ✅                   | ✅                 | ⚠️ (par arch)      | ⚠️               | ✅              |

## Recommandation

### Court terme (MVP): **Option 2 - `deno run`**

**Pourquoi:**

- ✅ Fonctionne immédiatement sans problème
- ✅ Pas de complexité d'installation
- ✅ Garde le principe "100% local"
- ✅ Compatible tous OS

**Documentation utilisateur:**

#### Configuration recommandée : Global + Workspace

**1. Configuration globale (`~/.config/claude/mcp_config.json`)** - Casys PML disponible partout :

```json
{
  "mcpServers": {
    "pml": {
      "command": "deno",
      "args": [
        "run",
        "--allow-all",
        "/chemin/absolu/vers/pml/src/main.ts",
        "serve",
        "--config",
        "/chemin/absolu/vers/pml/.mcp-servers.json"
      ]
    }
  }
}
```

**2. Permissions MCP (`~/.claude/settings.json`)** - Ajouter dans la liste `allow` :

```json
{
  "permissions": {
    "allow": [
      "mcp__cai__*"
    ]
  }
}
```

**3. Configuration workspace (`.mcp.json`)** - Optionnel, pour override projet-spécifique :

```json
{
  "mcpServers": {
    "pml": {
      "command": "deno",
      "args": [
        "run",
        "--allow-all",
        "./src/main.ts",
        "serve",
        "--config",
        "./.mcp-servers.json"
      ]
    }
  }
}
```

**Note importante** :

- Utiliser des chemins **absolus** dans la config globale
- Utiliser des chemins **relatifs** dans la config workspace (pour portabilité)
- La config workspace override la config globale si présente

### Moyen terme: **Option 1 - Script d'installation + binaire compilé**

Une fois le produit stabilisé, fournir un installeur pour Linux:

```bash
# Installation one-liner
curl -fsSL https://pml.dev/install.sh | bash

# Utilisation
pml init
pml serve
```

Le script:

1. Détecte l'OS/arch
2. Installe les dépendances système (ONNX, libvips)
3. Télécharge le binaire compilé
4. Configure le PATH

**Plateformes supportées (v1.0):**

- Ubuntu/Debian 20.04+
- macOS (Homebrew pour deps)
- Windows (WSL2 + script)

### Long terme: Explorer **Option 5 - Lazy loading**

Permettre aux utilisateurs de choisir:

- `pml serve` → Utilise embeddings locaux (nécessite deps)
- `pml serve --embeddings-api openai` → API externe (pas de deps)

## Actions nécessaires

### Immédiat

- [ ] Mettre à jour README avec instructions `deno run`
- [ ] Mettre à jour `.mcp.json` exemple dans README
- [ ] Documenter les dépendances natives dans section "Troubleshooting"
- [ ] Supprimer `deno task build` du README (ou le marquer "Advanced")

### À faire (avant v1.0)

- [ ] Créer `install.sh` pour Linux
- [ ] Tester sur Ubuntu 20.04, 22.04, 24.04
- [ ] Créer `install.sh` pour macOS (Homebrew)
- [ ] Documenter les versions de deps requises
- [ ] Ajouter CI check pour dépendances natives
- [ ] Créer page "Installation" dans docs/

### Optionnel (post-v1.0)

- [ ] Explorer lazy loading de Transformers.js
- [ ] Investiguer alternatives à Transformers.js (TensorFlow.js Lite ?)
- [ ] Support Windows natif (pas WSL)
- [ ] Image Docker officielle (pour serveurs)

## Conclusion

**Décision:** Utiliser `deno run` comme méthode principale de distribution pour le MVP, avec un plan
de migration vers binaire compilé + installeur pour v1.0.

Cette approche équilibre:

- Simplicité pour les utilisateurs (installation rapide)
- Maintenabilité (pas de build system complexe)
- Principe "100% local" (pas de dépendance cloud)
- Expérience développeur (Deno gère tout)

Le binaire compilé reste une **optimisation future**, pas un blocker pour le lancement.

## Note importante : Compilation vs Exécution

⚠️ **La compilation fonctionne toujours** (`deno task build` réussit sans erreur), mais
**l'exécution du binaire échoue** si les bibliothèques natives ne sont pas installées ou si les
versions ne correspondent pas.

### Pourquoi la compilation réussit mais l'exécution échoue ?

`deno compile` compile le code TypeScript et les modules npm dans un binaire standalone, mais les
**bibliothèques natives** (`.so`) ne sont **pas incluses** dans le binaire. Elles sont chargées
dynamiquement à l'exécution.

**Au moment de la compilation :**

- Deno n'a besoin que du code source des modules npm
- Aucune bibliothèque native requise
- La compilation réussit même si libvips/ONNX Runtime ne sont pas installés

**Au moment de l'exécution :**

- Le binaire essaie de charger `libvips-cpp.so.8.17.2` et `libonnxruntime.so.1`
- Si absentes ou mauvaise version → erreur au démarrage

### Exemple concret observé

```bash
# Compilation (fonctionne)
$ deno task build
✓ Compilation réussie (2.8GB binaire généré)

# Exécution (échoue)
$ ./pml serve
❌ Error: libvips-cpp.so.8.17.2: cannot open shared object file

# Exécution (échoue aussi)
$ ./pml init
❌ Error: libvips-cpp.so.8.17.2: cannot open shared object file
```

**Cause :** Sharp (dépendance de Transformers.js) cherche libvips 8.17, mais le système a libvips
8.12.

### Toutes les commandes sont affectées

Le problème affecte **toutes** les commandes du binaire compilé :

- `./pml init` → ❌ Échoue
- `./pml serve` → ❌ Échoue
- `./pml --help` → ❌ Échoue même

Car Transformers.js/Sharp s'importent au niveau du module (top-level import).

### Solution actuelle

**Utiliser `deno run` au lieu du binaire compilé :**

```bash
# ✅ Fonctionne
deno run --allow-all src/main.ts init
deno run --allow-all src/main.ts serve

# Configuration .mcp.json
{
  "mcpServers": {
    "pml": {
      "command": "deno",
      "args": [
        "run",
        "--allow-all",
        "/chemin/absolu/vers/pml/src/main.ts",
        "serve",
        "--config",
        "/chemin/absolu/vers/pml/.mcp-servers.json"
      ]
    }
  }
}
```

Cette solution évite complètement le problème car Deno gère les dépendances natives automatiquement.
