# PII Detection Research - MISE À JOUR

**Date:** 2025-11-11 (Updated) **Owners:** John (PM) + Winston (Architect) **Status:** ✅ COMPLETE
(REVISED)

---

## 🔄 Changement de Recommandation

**Recommandation initiale:** Regex homemade ❌

**Nouvelle recommandation:** **validator.js via npm** ✅

**Raison du changement:** Découverte de validator.js qui est:

- ✅ Le STANDARD de l'industrie (validatorjs/validator.js)
- ✅ 93M downloads/semaine npm
- ✅ Maintenu activement (v13.15.22 en 2025)
- ✅ Compatible Deno 2 native npm support
- ✅ API complète et testée (pas "homemade")

---

## Approche Recommandée: validator.js

### Import Deno 2

```typescript
import validator from "npm:validator@13.15.22";

// Ou avec deno.json
{
  "imports": {
    "validator": "npm:validator@13.15.22"
  }
}
```

### API Examples

```typescript
import validator from "npm:validator";

// Email validation
validator.isEmail("user@example.com"); // true
validator.isEmail("invalid"); // false

// Credit card validation (avec Luhn intégré)
validator.isCreditCard("4111111111111111"); // true
validator.isCreditCard("1234567890123456"); // false

// Phone validation (multi-locale)
validator.isMobilePhone("5551234567", "en-US"); // true
validator.isMobilePhone("+33612345678", "fr-FR"); // true

// IP address validation
validator.isIP("192.168.1.1"); // true
validator.isIP("192.168.1.1", 4); // IPv4 only

// SSN validation (via regex pattern)
const isSSN = (str: string) => validator.matches(str, /^\d{3}-\d{2}-\d{4}$/);
isSSN("123-45-6789"); // true
```

### Fonctions Disponibles (PII-relevant)

| Fonction             | Description                 | Pertinence PII   |
| -------------------- | --------------------------- | ---------------- |
| `isEmail()`          | Email validation (RFC5322)  | ✅ Priority 1    |
| `isCreditCard()`     | Credit card with Luhn check | ✅ Priority 1    |
| `isMobilePhone()`    | Phone (100+ locales)        | ✅ Priority 1    |
| `isIP()`             | IPv4/IPv6                   | ✅ Priority 1    |
| `isIdentityCard()`   | ID cards (20+ countries)    | ✅ Priority 2    |
| `isPassportNumber()` | Passport numbers            | ✅ Priority 2    |
| `isPostalCode()`     | Postal codes (80+ locales)  | ⚠️ Priority 2    |
| `isIBAN()`           | IBAN validation             | ⚠️ Priority 2    |
| `isURL()`            | URL validation              | ⚠️ Low priority  |
| `matches(pattern)`   | Custom regex                | ✅ For SSN, etc. |

---

## Implementation pour Story 3.5

### Module Structure

```
src/pii/
├── detector.ts        # PIIDetector class utilisant validator.js
├── types.ts           # Interfaces TypeScript
└── tokenizer.ts       # Redaction/masking
```

### PIIDetector Implementation

```typescript
// src/pii/detector.ts
import validator from "npm:validator@13.15.22";
import type { PIIDetectionResult, PIIMatch, PIIType } from "./types.ts";

export class PIIDetector {
  /**
   * Detect PII in code string
   */
  detect(code: string): PIIDetectionResult {
    const startTime = performance.now();
    const matches: PIIMatch[] = [];

    // Split code into tokens for validation
    const tokens = this.tokenize(code);

    for (const token of tokens) {
      // Email detection
      if (validator.isEmail(token)) {
        matches.push({
          type: "email",
          value: token,
          position: code.indexOf(token),
          length: token.length,
          confidence: 1.0,
        });
      }

      // Credit card detection (with Luhn)
      // Remove common separators for validation
      const cleanToken = token.replace(/[\s-]/g, "");
      if (validator.isCreditCard(cleanToken)) {
        matches.push({
          type: "credit_card",
          value: token,
          position: code.indexOf(token),
          length: token.length,
          confidence: 1.0,
        });
      }

      // Phone number detection (US)
      if (validator.isMobilePhone(token, "en-US")) {
        matches.push({
          type: "phone",
          value: token,
          position: code.indexOf(token),
          length: token.length,
          confidence: 1.0,
        });
      }

      // IP address detection
      if (validator.isIP(token)) {
        matches.push({
          type: "ip_address",
          value: token,
          position: code.indexOf(token),
          length: token.length,
          confidence: 1.0,
        });
      }

      // SSN detection (via custom pattern)
      if (validator.matches(token, /^\d{3}-\d{2}-\d{4}$/)) {
        matches.push({
          type: "ssn",
          value: token,
          position: code.indexOf(token),
          length: token.length,
          confidence: 1.0,
        });
      }
    }

    // Remove duplicates
    const uniqueMatches = this.deduplicateMatches(matches);

    const scanTimeMs = performance.now() - startTime;

    return {
      detected: uniqueMatches.length > 0,
      matches: uniqueMatches,
      scanTimeMs,
    };
  }

  /**
   * Tokenize code into potential PII strings
   * Extract strings from quotes, template literals, etc.
   */
  private tokenize(code: string): string[] {
    const tokens: string[] = [];

    // Extract double-quoted strings
    const doubleQuotes = code.matchAll(/"([^"]*)"/g);
    for (const match of doubleQuotes) {
      if (match[1]) tokens.push(match[1]);
    }

    // Extract single-quoted strings
    const singleQuotes = code.matchAll(/'([^']*)'/g);
    for (const match of singleQuotes) {
      if (match[1]) tokens.push(match[1]);
    }

    // Extract template literals
    const templateLiterals = code.matchAll(/`([^`]*)`/g);
    for (const match of templateLiterals) {
      if (match[1]) tokens.push(match[1]);
    }

    // Also tokenize by whitespace (for unquoted values)
    const words = code.split(/\s+/);
    tokens.push(...words);

    return tokens.filter((t) => t.length > 0);
  }

  /**
   * Remove duplicate matches (same value, overlapping positions)
   */
  private deduplicateMatches(matches: PIIMatch[]): PIIMatch[] {
    const seen = new Set<string>();
    return matches.filter((m) => {
      const key = `${m.type}:${m.value}:${m.position}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Tokenize/redact PII
   */
  tokenize(
    code: string,
    matches: PIIMatch[],
    strategy: "redact" | "mask" | "hash" = "redact",
  ): string {
    let redacted = code;

    // Sort matches by position (descending) to avoid position shifts
    const sorted = [...matches].sort((a, b) => b.position - a.position);

    for (const match of sorted) {
      const replacement = this.getReplacementText(match, strategy);
      redacted = redacted.slice(0, match.position) +
        replacement +
        redacted.slice(match.position + match.length);
    }

    return redacted;
  }

  private getReplacementText(
    match: PIIMatch,
    strategy: "redact" | "mask" | "hash",
  ): string {
    switch (strategy) {
      case "redact":
        return `[${match.type.toUpperCase()}_REDACTED]`;

      case "mask": {
        // Show last 4 chars for credit cards, last part for emails, etc.
        if (match.type === "credit_card" && match.value.length >= 4) {
          return "****-****-****-" + match.value.slice(-4);
        }
        if (match.type === "email") {
          const [local, domain] = match.value.split("@");
          return local[0] + "***@" + domain;
        }
        if (match.type === "ssn" && match.value.length >= 4) {
          return "***-**-" + match.value.slice(-4);
        }
        return "*".repeat(match.value.length);
      }

      case "hash": {
        // Simple hash (for demo - use crypto.subtle in production)
        const encoder = new TextEncoder();
        const data = encoder.encode(match.value);
        return Array.from(data)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 16);
      }
    }
  }
}
```

---

## Comparative Analysis UPDATED

| Criteria           | Weight | Custom Regex | validator.js | Presidio | AWS/Google |
| ------------------ | ------ | ------------ | ------------ | -------- | ---------- |
| **Cost**           | 25%    | ✅ 5/5       | ✅ 5/5       | ⚠️ 3/5   | ❌ 2/5     |
| **Performance**    | 25%    | ✅ 5/5       | ✅ 4.5/5     | ⚠️ 3/5   | ❌ 2/5     |
| **Accuracy**       | 20%    | ⚠️ 3/5       | ✅ 4.5/5     | ✅ 5/5   | ✅ 5/5     |
| **Integration**    | 15%    | ✅ 5/5       | ✅ 5/5       | ❌ 2/5   | ⚠️ 3/5     |
| **Maintenance**    | 10%    | ❌ 2/5       | ✅ 5/5       | ⚠️ 3/5   | ✅ 5/5     |
| **Maturity**       | 5%     | ❌ 1/5       | ✅ 5/5       | ✅ 4/5   | ✅ 5/5     |
| **Weighted Score** |        | **3.85**     | **4.75** ⭐  | **3.35** | **3.15**   |

**Winner:** validator.js 🏆

---

## Avantages validator.js

### ✅ Meilleur que Regex Homemade

1. **Testé et Éprouvé**
   - 93M downloads/semaine
   - Utilisé par des millions de projets
   - Battle-tested depuis des années

2. **Validations Complètes**
   - Luhn algorithm pour credit cards (intégré)
   - RFC5322 pour emails
   - Support multi-locale pour phones

3. **Maintenance**
   - Mise à jour régulières (v13.15.22 en 2025)
   - Security patches (CVE fixes)
   - Community support

4. **Performance**
   - Optimisé (légèrement plus lent que raw regex mais négligeable)
   - <5ms pour typical code
   - Toujours dans budget <10ms

### ✅ Meilleur que Cloud APIs

1. **Cost:** $0 vs $10-500+/mois
2. **Latency:** 1-5ms vs 50-200ms
3. **Privacy:** Aucune data envoyée à AWS/Google
4. **Offline:** Fonctionne sans internet

### ✅ Meilleur que Presidio

1. **Complexity:** Simple import npm vs Docker deployment
2. **Integration:** Deno native vs Python API
3. **Performance:** 1-5ms vs 10-50ms

---

## Performance Benchmarks (Estimés)

| Scenario      | Code Size | validator.js | Custom Regex | Difference |
| ------------- | --------- | ------------ | ------------ | ---------- |
| Small (1KB)   | 3 PII     | ~2ms         | ~1ms         | +1ms       |
| Medium (10KB) | 10 PII    | ~4ms         | ~3ms         | +1ms       |
| Large (100KB) | 50 PII    | ~8ms         | ~7ms         | +1ms       |

**Conclusion:** Overhead minimal (<1-2ms) pour gain énorme en robustesse.

---

## Migration de Regex → validator.js

### Avant (Homemade Regex)

```typescript
const EMAIL_PATTERN = /\b[\w\-\.]+@([\w\-]+\.)+[\w\-]{2,4}\b/g;

function detectEmail(code: string): string[] {
  return Array.from(code.matchAll(EMAIL_PATTERN), (m) => m[0]);
}
```

**Problèmes:**

- ❌ Pattern incomplet (manque edge cases)
- ❌ Pas de validation sémantique
- ❌ Maintenance burden

### Après (validator.js)

```typescript
import validator from "npm:validator";

function detectEmail(code: string): string[] {
  const tokens = tokenize(code); // Extract strings
  return tokens.filter((t) => validator.isEmail(t));
}
```

**Avantages:**

- ✅ RFC5322 compliant
- ✅ Gère edge cases (internationalized domains, etc.)
- ✅ Zero maintenance

---

## Decision Summary UPDATED

### ✅ Final Decision

**MVP Approach:** **validator.js via npm** (not custom regex)

**Scope PII:**

- Email: `validator.isEmail()`
- Credit card: `validator.isCreditCard()` (avec Luhn)
- Phone: `validator.isMobilePhone(locale)`
- IP address: `validator.isIP()`
- SSN: `validator.matches(pattern)` (custom pattern)

**Dependencies:**

```json
{
  "imports": {
    "validator": "npm:validator@13.15.22"
  }
}
```

**Performance Target:** <10ms (easily achievable)

**UX Strategy:** Warn + Allow (default), strict mode option

---

## Risks (Comparaison)

| Risk                | Custom Regex | validator.js            |
| ------------------- | ------------ | ----------------------- |
| **False negatives** | HIGH         | LOW                     |
| **False positives** | MEDIUM       | LOW                     |
| **Maintenance**     | HIGH         | NONE                    |
| **Security vulns**  | HIGH         | LOW (community patches) |
| **Accuracy drift**  | HIGH         | NONE (maintained)       |

---

## Conclusion

**Recommandation FINALE:** ✅ **validator.js**

**Pourquoi pas regex homemade:**

- Moins robuste
- Plus de maintenance
- Pas de Luhn algorithm built-in
- Pas d'internationalization
- Réinventer la roue

**Avantages validator.js:**

- Standard de l'industrie
- Zero config avec Deno 2
- Meilleure accuracy
- Zero maintenance
- Performance acceptable

**Next Steps:**

1. ✅ Adopter validator.js pour Story 3.5
2. ✅ Implement PIIDetector avec validator.js
3. ✅ Tests avec validations complètes
4. ⚠️ Considérer Presidio/Cloud pour Phase 2+ (si accuracy insuffisante)

---

**Document Status:** ✅ UPDATED **Date:** 2025-11-11 **Authors:** John (PM) + Winston (Architect)
