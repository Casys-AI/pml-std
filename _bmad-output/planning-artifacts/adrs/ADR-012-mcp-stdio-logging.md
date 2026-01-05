# ADR-012: MCP STDIO Logging Strategy

**Status:** ✅ Implemented **Date:** 2025-11-21 | **Deciders:** Équipe Casys PML

## Context

Casys PML fonctionne comme un serveur MCP (Model Context Protocol) utilisant le transport stdio.
Dans ce mode :

- **stdout** est réservé exclusivement aux messages JSON-RPC
- Toute autre sortie sur stdout corrompt le protocole et casse la communication avec Claude Code

### Problème observé

Les logs console (avec codes ANSI couleur) polluaient stdout, causant des erreurs :

```
Connection error: JSON Parse error: Unexpected identifier "DEBUG"
Connection error: JSON Parse error: Unrecognized token '\u001b'
```

Le token `\u001b` est un code d'échappement ANSI pour les couleurs.

## Decision

### Règle fondamentale

**Tous les logs doivent aller sur stderr, jamais sur stdout.**

### Implémentation

1. **Logger principal (`src/telemetry/logger.ts`)**
   - Remplacer `ConsoleHandler` (stdout) par `StderrHandler` (stderr)
   - Le FileHandler reste inchangé

2. **Console.log dans le code**
   - Commandes CLI (`init`, `status`, etc.) : `console.log` OK (pas en mode MCP)
   - Code exécuté pendant `serve` : Utiliser le logger ou `console.error`

3. **Nouveau handler personnalisé**

```typescript
class StderrHandler extends log.BaseHandler {
  private encoder = new TextEncoder();

  override log(msg: string): void {
    Deno.stderr.writeSync(this.encoder.encode(msg + "\n"));
  }
}
```

## Consequences

### Positives

- ✅ Protocole MCP fonctionne correctement
- ✅ Logs toujours visibles dans le terminal (via stderr)
- ✅ Fichier de log toujours écrit
- ✅ Compatible avec la spec MCP officielle

### Négatives

- ⚠️ Les `console.log` dans le code serveur doivent être audités
- ⚠️ Nouveau pattern à respecter pour les futurs développements

## Alternatives considérées

### Option 1 : Désactiver les logs console en mode serve

- ❌ Rejetée : Perte de visibilité pour le debug

### Option 2 : Flag --quiet

- ❌ Rejetée : Complexité supplémentaire, pas nécessaire

### Option 3 : Logs uniquement dans fichier

- ❌ Rejetée : Moins pratique pour le développement

## Références

- [MCP STDIO Transport Documentation](https://modelcontextprotocol.io/docs/develop/build-server)
- [Understanding MCP Stdio transport](https://medium.com/@laurentkubaski/understanding-mcp-stdio-transport-protocol-ae3d5daf64db)

> "A critical rule: MCP servers must only write JSON-RPC messages to stdout. All logs and debugging
> output should go to stderr instead."

## Compliance Checklist

- [x] Logger principal redirigé vers stderr
- [x] Audit des `console.log` dans `src/health/health-checker.ts` → convertis en `console.error`
- [x] Audit des `console.log` dans `src/main.ts` → OK (commandes CLI uniquement, pas `serve`)
- [ ] Test de non-régression avec Claude Code
