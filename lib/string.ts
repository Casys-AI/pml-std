/**
 * String manipulation tools
 *
 * Case conversion, slugification, similarity, and text extraction.
 *
 * @module lib/std/string
 */

import type { MiniTool } from "./types.ts";

export const stringTools: MiniTool[] = [
  {
    name: "string_slugify",
    description:
      "Convert text to URL-friendly slug. Transforms titles, names, or any text into lowercase hyphenated format safe for URLs. Handles unicode, removes special characters, collapses whitespace. Use for URL generation, file naming, or ID creation. Keywords: slugify, URL slug, hyphenate, permalink, SEO URL, clean URL, kebab-case URL.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to slugify" },
        separator: { type: "string", description: "Word separator (default: '-')" },
        lowercase: { type: "boolean", description: "Convert to lowercase (default: true)" },
      },
      required: ["text"],
    },
    handler: ({ text, separator = "-", lowercase = true }) => {
      let result = text as string;

      // Normalize unicode characters
      result = result.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

      // Replace non-alphanumeric with separator
      result = result.replace(/[^a-zA-Z0-9]+/g, separator as string);

      // Remove leading/trailing separators
      result = result.replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "");

      if (lowercase) {
        result = result.toLowerCase();
      }

      return result;
    },
  },
  {
    name: "string_camel_case",
    description:
      "Convert text to camelCase format. Transform any string format (snake_case, kebab-case, spaces) to camelCase for JavaScript/TypeScript variables. Use for code generation, API response transformation, or naming conventions. Keywords: camelCase, convert case, variable naming, JS naming, lowerCamelCase.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert" },
      },
      required: ["text"],
    },
    handler: ({ text }) => {
      return (text as string)
        .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
        .replace(/^(.)/, (c) => c.toLowerCase());
    },
  },
  {
    name: "string_pascal_case",
    description:
      "Convert text to PascalCase format. Transform any string format to PascalCase for class names, type definitions, or component names. Use for code generation, type naming, or React components. Keywords: PascalCase, UpperCamelCase, class naming, type naming, convert case.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert" },
      },
      required: ["text"],
    },
    handler: ({ text }) => {
      return (text as string)
        .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
        .replace(/^(.)/, (c) => c.toUpperCase());
    },
  },
  {
    name: "string_snake_case",
    description:
      "Convert text to snake_case format. Transform any string format to lowercase underscore-separated words for Python variables, database columns, or config keys. Use for code generation, database naming, or API formatting. Keywords: snake_case, underscore case, Python naming, database column, convert case.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert" },
        uppercase: { type: "boolean", description: "Use UPPER_SNAKE_CASE (default: false)" },
      },
      required: ["text"],
    },
    handler: ({ text, uppercase = false }) => {
      let result = (text as string)
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/[-\s]+/g, "_")
        .toLowerCase();

      if (uppercase) {
        result = result.toUpperCase();
      }

      return result;
    },
  },
  {
    name: "string_kebab_case",
    description:
      "Convert text to kebab-case format. Transform any string format to lowercase hyphen-separated words for CSS classes, HTML attributes, or URL paths. Use for CSS naming, HTML attributes, or file naming. Keywords: kebab-case, hyphen case, CSS naming, HTML attribute, dash case, convert case.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert" },
      },
      required: ["text"],
    },
    handler: ({ text }) => {
      return (text as string)
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .replace(/[_\s]+/g, "-")
        .toLowerCase();
    },
  },
  {
    name: "string_constant_case",
    description:
      "Convert text to CONSTANT_CASE format. Transform any string format to uppercase underscore-separated words for constants, environment variables, or enum values. Use for constant naming, env vars, or config keys. Keywords: CONSTANT_CASE, SCREAMING_SNAKE_CASE, constant naming, env variable, uppercase underscore.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert" },
      },
      required: ["text"],
    },
    handler: ({ text }) => {
      return (text as string)
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/[-\s]+/g, "_")
        .toUpperCase();
    },
  },
  {
    name: "string_title_case",
    description:
      "Convert text to Title Case with proper capitalization. Capitalize first letter of each word, handle common articles and prepositions. Use for headings, titles, or display formatting. Keywords: Title Case, capitalize words, heading format, proper case, word capitalize.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert" },
        smartCase: {
          type: "boolean",
          description: "Lowercase articles/prepositions (default: true)",
        },
      },
      required: ["text"],
    },
    handler: ({ text, smartCase = true }) => {
      const lowercase = [
        "a",
        "an",
        "the",
        "and",
        "but",
        "or",
        "for",
        "nor",
        "on",
        "at",
        "to",
        "by",
        "of",
        "in",
      ];

      return (text as string)
        .toLowerCase()
        .split(/\s+/)
        .map((word, index) => {
          if (smartCase && index > 0 && lowercase.includes(word)) {
            return word;
          }
          return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(" ");
    },
  },
  {
    name: "string_levenshtein",
    description:
      "Calculate Levenshtein edit distance between two strings. Measure minimum single-character edits (insertions, deletions, substitutions) to transform one string into another. Use for fuzzy matching, spell checking, or similarity detection. Keywords: Levenshtein distance, edit distance, string similarity, fuzzy match, spell check, string diff.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        str1: { type: "string", description: "First string" },
        str2: { type: "string", description: "Second string" },
      },
      required: ["str1", "str2"],
    },
    handler: ({ str1, str2 }) => {
      const s1 = str1 as string;
      const s2 = str2 as string;
      const m = s1.length;
      const n = s2.length;

      // Create distance matrix
      const d: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

      // Initialize first column and row
      for (let i = 0; i <= m; i++) d[i][0] = i;
      for (let j = 0; j <= n; j++) d[0][j] = j;

      // Fill in the rest
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
          d[i][j] = Math.min(
            d[i - 1][j] + 1, // deletion
            d[i][j - 1] + 1, // insertion
            d[i - 1][j - 1] + cost, // substitution
          );
        }
      }

      const distance = d[m][n];
      const maxLen = Math.max(m, n);
      const similarity = maxLen === 0 ? 1 : 1 - distance / maxLen;

      return { distance, similarity: Math.round(similarity * 100) / 100 };
    },
  },
  {
    name: "string_jaro_winkler",
    description:
      "Calculate Jaro-Winkler similarity score between two strings. Measure string similarity with emphasis on matching prefixes, returns value between 0-1. Better for short strings and names than Levenshtein. Use for name matching, deduplication, or record linkage. Keywords: Jaro-Winkler, string similarity, name matching, fuzzy compare, record linkage, dedupe.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        str1: { type: "string", description: "First string" },
        str2: { type: "string", description: "Second string" },
      },
      required: ["str1", "str2"],
    },
    handler: ({ str1, str2 }) => {
      const s1 = str1 as string;
      const s2 = str2 as string;

      if (s1 === s2) return { similarity: 1, jaro: 1 };
      if (s1.length === 0 || s2.length === 0) return { similarity: 0, jaro: 0 };

      const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
      const s1Matches = new Array(s1.length).fill(false);
      const s2Matches = new Array(s2.length).fill(false);

      let matches = 0;
      let transpositions = 0;

      // Find matches
      for (let i = 0; i < s1.length; i++) {
        const start = Math.max(0, i - matchWindow);
        const end = Math.min(i + matchWindow + 1, s2.length);

        for (let j = start; j < end; j++) {
          if (s2Matches[j] || s1[i] !== s2[j]) continue;
          s1Matches[i] = true;
          s2Matches[j] = true;
          matches++;
          break;
        }
      }

      if (matches === 0) return { similarity: 0, jaro: 0 };

      // Count transpositions
      let k = 0;
      for (let i = 0; i < s1.length; i++) {
        if (!s1Matches[i]) continue;
        while (!s2Matches[k]) k++;
        if (s1[i] !== s2[k]) transpositions++;
        k++;
      }

      // Jaro similarity
      const jaro = (
        matches / s1.length +
        matches / s2.length +
        (matches - transpositions / 2) / matches
      ) / 3;

      // Winkler modification (prefix bonus)
      let prefix = 0;
      for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
        if (s1[i] === s2[i]) prefix++;
        else break;
      }

      const similarity = jaro + prefix * 0.1 * (1 - jaro);

      return {
        similarity: Math.round(similarity * 1000) / 1000,
        jaro: Math.round(jaro * 1000) / 1000,
      };
    },
  },
  {
    name: "string_extract_emails",
    description:
      "Extract all email addresses from text using regex. Find and return array of valid email addresses embedded in any text content. Use for data extraction, contact scraping, or text parsing. Keywords: extract emails, find emails, email regex, parse emails, scrape contacts, email pattern.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to search" },
        unique: { type: "boolean", description: "Return only unique emails (default: true)" },
      },
      required: ["text"],
    },
    handler: ({ text, unique = true }) => {
      const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const matches = (text as string).match(regex) || [];

      if (unique) {
        return [...new Set(matches)];
      }
      return matches;
    },
  },
  {
    name: "string_extract_urls",
    description:
      "Extract all URLs from text using regex. Find and return array of HTTP/HTTPS URLs embedded in any text content. Use for link extraction, web scraping, or content analysis. Keywords: extract URLs, find links, URL regex, parse URLs, scrape links, HTTP pattern.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to search" },
        unique: { type: "boolean", description: "Return only unique URLs (default: true)" },
        protocols: {
          type: "array",
          items: { type: "string" },
          description: "Protocols to match (default: ['http', 'https'])",
        },
      },
      required: ["text"],
    },
    handler: ({ text, unique = true, protocols = ["http", "https"] }) => {
      const protocolPattern = (protocols as string[]).join("|");
      const regex = new RegExp(`(${protocolPattern})://[^\\s<>"{}|\\\\^\\[\`]+`, "gi");
      const matches = (text as string).match(regex) || [];

      // Clean trailing punctuation
      const cleaned = matches.map((url) => url.replace(/[.,;:!?)]+$/, ""));

      if (unique) {
        return [...new Set(cleaned)];
      }
      return cleaned;
    },
  },
  {
    name: "string_extract_phones",
    description:
      "Extract phone numbers from text using pattern matching. Find various phone number formats including international, US, and local formats. Use for contact extraction, data parsing, or text analysis. Keywords: extract phones, find phone numbers, phone regex, parse phones, contact extraction.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to search" },
        unique: { type: "boolean", description: "Return only unique numbers (default: true)" },
      },
      required: ["text"],
    },
    handler: ({ text, unique = true }) => {
      // Match various phone formats
      const regex =
        /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}(?:[-.\s]?\d{2,4})?/g;
      const matches = (text as string).match(regex) || [];

      // Filter out likely non-phone matches (too short or too long)
      const filtered = matches.filter((m) => {
        const digits = m.replace(/\D/g, "");
        return digits.length >= 7 && digits.length <= 15;
      });

      if (unique) {
        return [...new Set(filtered)];
      }
      return filtered;
    },
  },
  {
    name: "string_extract_hashtags",
    description:
      "Extract hashtags from text. Find all #hashtag patterns in social media posts, comments, or any text. Use for social media analysis, content tagging, or trend detection. Keywords: extract hashtags, find hashtags, hashtag regex, parse tags, social media, Twitter tags.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to search" },
        unique: { type: "boolean", description: "Return only unique hashtags (default: true)" },
        withHash: { type: "boolean", description: "Include # symbol in results (default: true)" },
      },
      required: ["text"],
    },
    handler: ({ text, unique = true, withHash = true }) => {
      const regex = /#[a-zA-Z0-9_]+/g;
      const matches = (text as string).match(regex) || [];

      let results: string[] = [...matches];
      if (!withHash) {
        results = matches.map((h) => h.slice(1));
      }

      if (unique) {
        return [...new Set(results)];
      }
      return results;
    },
  },
  {
    name: "string_extract_mentions",
    description:
      "Extract @mentions from text. Find all @username patterns in social media posts, comments, or any text. Use for social media analysis, user tagging, or notification systems. Keywords: extract mentions, find mentions, @ symbol, parse usernames, social media, Twitter mentions.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to search" },
        unique: { type: "boolean", description: "Return only unique mentions (default: true)" },
        withAt: { type: "boolean", description: "Include @ symbol in results (default: true)" },
      },
      required: ["text"],
    },
    handler: ({ text, unique = true, withAt = true }) => {
      const regex = /@[a-zA-Z0-9_]+/g;
      const matches = (text as string).match(regex) || [];

      let results: string[] = [...matches];
      if (!withAt) {
        results = matches.map((m) => m.slice(1));
      }

      if (unique) {
        return [...new Set(results)];
      }
      return results;
    },
  },
  {
    name: "string_truncate",
    description:
      "Truncate string to specified length with customizable ellipsis. Shorten text for previews, summaries, or UI display while preserving word boundaries optionally. Use for text previews, UI truncation, or content summaries. Keywords: truncate string, shorten text, ellipsis, text preview, word boundary, clip text.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to truncate" },
        length: { type: "number", description: "Maximum length" },
        ellipsis: { type: "string", description: "Ellipsis string (default: '...')" },
        preserveWords: { type: "boolean", description: "Don't cut words (default: true)" },
      },
      required: ["text", "length"],
    },
    handler: ({ text, length, ellipsis = "...", preserveWords = true }) => {
      const t = text as string;
      const maxLen = length as number;
      const suffix = ellipsis as string;

      if (t.length <= maxLen) return t;

      const truncLen = maxLen - suffix.length;
      if (truncLen <= 0) return suffix.slice(0, maxLen);

      let result = t.slice(0, truncLen);

      if (preserveWords) {
        const lastSpace = result.lastIndexOf(" ");
        if (lastSpace > truncLen * 0.5) {
          result = result.slice(0, lastSpace);
        }
      }

      return result.trimEnd() + suffix;
    },
  },
  {
    name: "string_word_count",
    description:
      "Count words, characters, sentences, and paragraphs in text. Comprehensive text statistics for content analysis, word limits, or readability assessment. Use for content analysis, word counters, or text metrics. Keywords: word count, character count, text statistics, sentence count, paragraph count, text length.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to analyze" },
      },
      required: ["text"],
    },
    handler: ({ text }) => {
      const t = text as string;

      const words = t.trim().split(/\s+/).filter((w) => w.length > 0);
      const sentences = t.split(/[.!?]+/).filter((s) => s.trim().length > 0);
      const paragraphs = t.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

      return {
        characters: t.length,
        charactersNoSpaces: t.replace(/\s/g, "").length,
        words: words.length,
        sentences: sentences.length,
        paragraphs: paragraphs.length,
        avgWordLength: words.length > 0
          ? Math.round(words.reduce((sum, w) => sum + w.length, 0) / words.length * 10) / 10
          : 0,
      };
    },
  },
  {
    name: "string_reverse",
    description:
      "Reverse a string character by character. Handle unicode characters properly with grapheme support. Use for palindrome checking, text effects, or encoding. Keywords: reverse string, string reverse, flip text, mirror text, backwards text.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to reverse" },
      },
      required: ["text"],
    },
    handler: ({ text }) => {
      // Handle unicode properly using spread operator
      return [...(text as string)].reverse().join("");
    },
  },
  {
    name: "string_repeat",
    description:
      "Repeat a string multiple times with optional separator. Generate repeated patterns, padding, or separators. Use for text generation, padding, or pattern creation. Keywords: repeat string, string repeat, duplicate text, multiply string, pattern generate.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to repeat" },
        count: { type: "number", description: "Number of repetitions" },
        separator: { type: "string", description: "Separator between repetitions (default: '')" },
      },
      required: ["text", "count"],
    },
    handler: ({ text, count, separator = "" }) => {
      const t = text as string;
      const n = Math.max(0, Math.floor(count as number));
      const sep = separator as string;

      return Array(n).fill(t).join(sep);
    },
  },
  {
    name: "string_pad",
    description:
      "Pad string to target length with specified character. Add padding to start, end, or both sides for alignment or formatting. Use for text alignment, number formatting, or table display. Keywords: pad string, string padding, left pad, right pad, center align, text align.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to pad" },
        length: { type: "number", description: "Target length" },
        char: { type: "string", description: "Padding character (default: ' ')" },
        position: {
          type: "string",
          enum: ["start", "end", "both"],
          description: "Padding position (default: 'start')",
        },
      },
      required: ["text", "length"],
    },
    handler: ({ text, length, char = " ", position = "start" }) => {
      const t = text as string;
      const targetLen = length as number;
      const padChar = (char as string)[0] || " ";

      if (t.length >= targetLen) return t;

      const padLen = targetLen - t.length;

      switch (position) {
        case "end":
          return t + padChar.repeat(padLen);
        case "both": {
          const leftPad = Math.floor(padLen / 2);
          const rightPad = padLen - leftPad;
          return padChar.repeat(leftPad) + t + padChar.repeat(rightPad);
        }
        default: // start
          return padChar.repeat(padLen) + t;
      }
    },
  },
  {
    name: "string_escape_html",
    description:
      "Escape HTML special characters to prevent XSS. Convert <, >, &, \", ' to their HTML entity equivalents. Use for sanitizing user input, preventing XSS, or safe HTML rendering. Keywords: escape HTML, HTML entities, XSS prevention, sanitize HTML, encode HTML, security.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to escape" },
      },
      required: ["text"],
    },
    handler: ({ text }) => {
      const escapeMap: Record<string, string> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };

      return (text as string).replace(/[&<>"']/g, (char) => escapeMap[char]);
    },
  },
  {
    name: "string_unescape_html",
    description:
      "Unescape HTML entities back to characters. Convert HTML entities like &lt; &gt; &amp; back to their original characters. Use for decoding HTML content, parsing HTML text, or display. Keywords: unescape HTML, decode HTML, HTML entities, parse HTML, HTML decode.",
    category: "string",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to unescape" },
      },
      required: ["text"],
    },
    handler: ({ text }) => {
      const unescapeMap: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&#39;": "'",
        "&apos;": "'",
        "&#x27;": "'",
        "&#x2F;": "/",
        "&#47;": "/",
        "&nbsp;": " ",
      };

      return (text as string).replace(
        /&(?:amp|lt|gt|quot|apos|#39|#x27|#x2F|#47|nbsp);/g,
        (entity) => unescapeMap[entity] || entity,
      );
    },
  },
];
