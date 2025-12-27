/**
 * Formatting tools
 *
 * String and data formatting utilities.
 *
 * Inspired by:
 * - IT-Tools MCP: https://github.com/wrenchpilot/it-tools-mcp
 *
 * @module lib/std/format
 */

import * as yaml from "npm:yaml@2.3.4";
import * as toml from "jsr:@std/toml@1.0.1";
import type { MiniTool } from "./types.ts";

export const formatTools: MiniTool[] = [
  {
    name: "format_number",
    description:
      "Format numbers with locale-aware formatting. Display as currency ($1,234.56), percentage, or with units. Control decimal places and grouping. Keywords: number format, currency format, locale number, decimal places, thousand separator.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "Number to format" },
        locale: { type: "string", description: "Locale (e.g., 'en-US', 'fr-FR')" },
        style: {
          type: "string",
          enum: ["decimal", "currency", "percent", "unit"],
          description: "Format style",
        },
        currency: { type: "string", description: "Currency code (e.g., 'USD', 'EUR')" },
        unit: { type: "string", description: "Unit (e.g., 'kilometer', 'celsius')" },
        minimumFractionDigits: { type: "number", description: "Min decimal places" },
        maximumFractionDigits: { type: "number", description: "Max decimal places" },
      },
      required: ["value"],
    },
    handler: (
      {
        value,
        locale = "en-US",
        style,
        currency,
        unit,
        minimumFractionDigits,
        maximumFractionDigits,
      },
    ) => {
      const options: Intl.NumberFormatOptions = {};
      if (style) options.style = style as "decimal" | "currency" | "percent" | "unit";
      if (currency) options.currency = currency as string;
      if (unit) options.unit = unit as string;
      if (minimumFractionDigits !== undefined) {
        options.minimumFractionDigits = minimumFractionDigits as number;
      }
      if (maximumFractionDigits !== undefined) {
        options.maximumFractionDigits = maximumFractionDigits as number;
      }

      return new Intl.NumberFormat(locale as string, options).format(value as number);
    },
  },
  {
    name: "format_bytes",
    description:
      "Convert bytes to human-readable file sizes (KB, MB, GB, TB). Support binary (KiB, MiB) or decimal (KB, MB) units. Use for displaying file sizes, storage capacity, or bandwidth. Keywords: file size format, bytes to MB GB, human readable size, storage size.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        bytes: { type: "number", description: "Number of bytes" },
        decimals: { type: "number", description: "Decimal places (default: 2)" },
        binary: { type: "boolean", description: "Use binary units (KiB vs KB)" },
      },
      required: ["bytes"],
    },
    handler: ({ bytes, decimals = 2, binary = false }) => {
      const b = bytes as number;
      if (b === 0) return "0 Bytes";

      const k = binary ? 1024 : 1000;
      const units = binary
        ? ["Bytes", "KiB", "MiB", "GiB", "TiB", "PiB"]
        : ["Bytes", "KB", "MB", "GB", "TB", "PB"];

      const i = Math.floor(Math.log(b) / Math.log(k));
      const formatted = parseFloat((b / Math.pow(k, i)).toFixed(decimals as number));
      return `${formatted} ${units[i]}`;
    },
  },
  {
    name: "format_duration",
    description:
      "Convert milliseconds to human-readable duration. Output as short (5m 30s), long (5 minutes, 30 seconds), or clock format (5:30). Use for elapsed time, countdowns, or time tracking. Keywords: duration format, time format, milliseconds to time, elapsed time, countdown.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "number", description: "Duration in milliseconds" },
        format: {
          type: "string",
          enum: ["short", "long", "clock"],
          description: "Output format",
        },
      },
      required: ["ms"],
    },
    handler: ({ ms, format = "short" }) => {
      const milliseconds = ms as number;
      const seconds = Math.floor(milliseconds / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      const s = seconds % 60;
      const m = minutes % 60;
      const h = hours % 24;

      switch (format) {
        case "clock":
          if (days > 0) {
            return `${days}:${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${
              s.toString().padStart(2, "0")
            }`;
          }
          if (hours > 0) {
            return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
          }
          return `${m}:${s.toString().padStart(2, "0")}`;
        case "long":
          const parts = [];
          if (days) parts.push(`${days} day${days > 1 ? "s" : ""}`);
          if (h) parts.push(`${h} hour${h > 1 ? "s" : ""}`);
          if (m) parts.push(`${m} minute${m > 1 ? "s" : ""}`);
          if (s || parts.length === 0) parts.push(`${s} second${s !== 1 ? "s" : ""}`);
          return parts.join(", ");
        default: // short
          if (days) return `${days}d ${h}h`;
          if (hours) return `${h}h ${m}m`;
          if (minutes) return `${m}m ${s}s`;
          if (seconds) return `${s}s`;
          return `${milliseconds}ms`;
      }
    },
  },
  {
    name: "format_percent",
    description:
      "Format decimal number as percentage with locale formatting. Input 0.5 outputs '50%'. Control decimal precision. Use for displaying ratios, completion rates, or statistics. Keywords: percent format, percentage display, ratio to percent, decimal to percent.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "Value (0.5 = 50%)" },
        decimals: { type: "number", description: "Decimal places" },
        locale: { type: "string", description: "Locale" },
      },
      required: ["value"],
    },
    handler: ({ value, decimals = 0, locale = "en-US" }) =>
      new Intl.NumberFormat(locale as string, {
        style: "percent",
        minimumFractionDigits: decimals as number,
        maximumFractionDigits: decimals as number,
      }).format(value as number),
  },
  {
    name: "format_ordinal",
    description:
      "Convert number to ordinal format (1st, 2nd, 3rd, 4th). Handles special cases correctly. Use for rankings, positions, or ordered lists. Keywords: ordinal number, 1st 2nd 3rd, number suffix, position format.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "Number to format" },
      },
      required: ["value"],
    },
    handler: ({ value }) => {
      const n = value as number;
      const pr = new Intl.PluralRules("en-US", { type: "ordinal" });
      const suffixes: Record<string, string> = {
        one: "st",
        two: "nd",
        few: "rd",
        other: "th",
      };
      return `${n}${suffixes[pr.select(n)]}`;
    },
  },
  {
    name: "format_list",
    description:
      "Format array as grammatically correct list string. Support 'and' (conjunction), 'or' (disjunction), or unit formatting. Locale-aware for international use. Keywords: list format, array to string, comma separated, and or list, join with commas.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "Items to format" },
        style: {
          type: "string",
          enum: ["long", "short", "narrow"],
          description: "List style",
        },
        type: {
          type: "string",
          enum: ["conjunction", "disjunction", "unit"],
          description: "List type (and/or/unit)",
        },
        locale: { type: "string", description: "Locale" },
      },
      required: ["items"],
    },
    handler: ({ items, style = "long", type = "conjunction", locale = "en-US" }) =>
      new Intl.ListFormat(locale as string, {
        style: style as "long" | "short" | "narrow",
        type: type as "conjunction" | "disjunction" | "unit",
      }).format(items as string[]),
  },
  {
    name: "format_relative_time",
    description:
      "Format relative time in human terms (e.g., '2 days ago', 'in 3 hours'). Locale-aware formatting for internationalization. Use for activity feeds, timestamps, or schedules. Keywords: relative time, time ago, days ago, in hours, human readable time.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "Relative value (negative for past)" },
        unit: {
          type: "string",
          enum: ["second", "minute", "hour", "day", "week", "month", "year"],
          description: "Time unit",
        },
        style: {
          type: "string",
          enum: ["long", "short", "narrow"],
          description: "Output style",
        },
        locale: { type: "string", description: "Locale" },
      },
      required: ["value", "unit"],
    },
    handler: ({ value, unit, style = "long", locale = "en-US" }) =>
      new Intl.RelativeTimeFormat(locale as string, {
        style: style as "long" | "short" | "narrow",
      }).format(value as number, unit as Intl.RelativeTimeFormatUnit),
  },
  {
    name: "format_plural",
    description:
      "Select correct plural form based on count. Handles complex pluralization rules for different locales. Use for dynamic text like '1 item' vs '3 items'. Keywords: plural form, pluralize, singular plural, count based text, i18n plural.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Count" },
        forms: {
          type: "object",
          description: "Plural forms { one: 'item', other: 'items' }",
        },
        locale: { type: "string", description: "Locale" },
      },
      required: ["count", "forms"],
    },
    handler: ({ count, forms, locale = "en-US" }) => {
      const pr = new Intl.PluralRules(locale as string);
      const f = forms as Record<string, string>;
      const category = pr.select(count as number);
      return f[category] || f.other || Object.values(f)[0];
    },
  },
  {
    name: "format_truncate",
    description:
      "Truncate long text with ellipsis. Option to break at word boundaries. Customize ending string. Use for previews, excerpts, or UI text limits. Keywords: truncate text, ellipsis, shorten text, text preview, max length.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to truncate" },
        length: { type: "number", description: "Max length" },
        end: { type: "string", description: "End string (default: '...')" },
        wordBoundary: { type: "boolean", description: "Break at word boundary" },
      },
      required: ["text", "length"],
    },
    handler: ({ text, length, end = "...", wordBoundary = false }) => {
      const t = text as string;
      const l = length as number;
      const e = end as string;

      if (t.length <= l) return t;

      const trimmedLength = l - e.length;
      let trimmed = t.slice(0, trimmedLength);

      if (wordBoundary) {
        const lastSpace = trimmed.lastIndexOf(" ");
        if (lastSpace > trimmedLength / 2) {
          trimmed = trimmed.slice(0, lastSpace);
        }
      }

      return trimmed + e;
    },
  },
  // Inspired by IT-Tools MCP: https://github.com/wrenchpilot/it-tools-mcp
  {
    name: "format_yaml_to_json",
    description:
      "Convert YAML configuration to JSON format. Parse YAML syntax and output valid JSON. Use for config transformation or data interchange. Keywords: YAML to JSON, convert yaml, yaml parse, config convert.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        yaml: { type: "string", description: "YAML string to convert" },
        pretty: { type: "boolean", description: "Pretty print JSON (default: true)" },
      },
      required: ["yaml"],
    },
    handler: ({ yaml: yamlStr, pretty = true }) => {
      const parsed = yaml.parse(yamlStr as string);
      return pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed);
    },
  },
  {
    name: "format_json_to_yaml",
    description:
      "Convert JSON to YAML configuration format. Output human-readable YAML with configurable indentation. Use for config files or readable data. Keywords: JSON to YAML, convert json, yaml output, config format.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "string", description: "JSON string to convert" },
        indent: { type: "number", description: "Indentation spaces (default: 2)" },
      },
      required: ["json"],
    },
    handler: ({ json, indent = 2 }) => {
      const parsed = JSON.parse(json as string);
      return yaml.stringify(parsed, { indent: indent as number });
    },
  },
  {
    name: "format_markdown_to_html",
    description:
      "Convert Markdown text to HTML. Supports headers, bold, italic, code blocks, links, images, lists. Use for rendering markdown content in web pages. Keywords: markdown to HTML, md convert, render markdown, markdown parse.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "Markdown text" },
      },
      required: ["markdown"],
    },
    handler: ({ markdown }) => {
      let html = markdown as string;

      // Headers
      html = html.replace(/^###### (.+)$/gm, "<h6>$1</h6>");
      html = html.replace(/^##### (.+)$/gm, "<h5>$1</h5>");
      html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
      html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
      html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
      html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

      // Bold and italic
      html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
      html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
      html = html.replace(/___(.+?)___/g, "<strong><em>$1</em></strong>");
      html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
      html = html.replace(/_(.+?)_/g, "<em>$1</em>");

      // Code
      html = html.replace(
        /```(\w*)\n([\s\S]*?)```/g,
        '<pre><code class="language-$1">$2</code></pre>',
      );
      html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

      // Links and images
      html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
      html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

      // Lists
      html = html.replace(/^\* (.+)$/gm, "<li>$1</li>");
      html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
      html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

      // Horizontal rule
      html = html.replace(/^---$/gm, "<hr>");
      html = html.replace(/^\*\*\*$/gm, "<hr>");

      // Blockquotes
      html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");

      // Paragraphs (simple: wrap non-tag lines)
      html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, "<p>$1</p>");

      return html;
    },
  },
  {
    name: "format_html_to_markdown",
    description:
      "Convert HTML back to Markdown format. Transform tags to markdown syntax. Use for content extraction or documentation. Keywords: HTML to markdown, convert html, extract text, html parse.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "HTML text" },
      },
      required: ["html"],
    },
    handler: ({ html }) => {
      let md = html as string;

      // Headers
      md = md.replace(/<h1[^>]*>([^<]+)<\/h1>/gi, "# $1\n");
      md = md.replace(/<h2[^>]*>([^<]+)<\/h2>/gi, "## $1\n");
      md = md.replace(/<h3[^>]*>([^<]+)<\/h3>/gi, "### $1\n");
      md = md.replace(/<h4[^>]*>([^<]+)<\/h4>/gi, "#### $1\n");
      md = md.replace(/<h5[^>]*>([^<]+)<\/h5>/gi, "##### $1\n");
      md = md.replace(/<h6[^>]*>([^<]+)<\/h6>/gi, "###### $1\n");

      // Bold and italic
      md = md.replace(/<strong>([^<]+)<\/strong>/gi, "**$1**");
      md = md.replace(/<b>([^<]+)<\/b>/gi, "**$1**");
      md = md.replace(/<em>([^<]+)<\/em>/gi, "*$1*");
      md = md.replace(/<i>([^<]+)<\/i>/gi, "*$1*");

      // Code
      md = md.replace(/<pre><code[^>]*>([^<]+)<\/code><\/pre>/gi, "```\n$1```\n");
      md = md.replace(/<code>([^<]+)<\/code>/gi, "`$1`");

      // Links and images
      md = md.replace(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, "[$2]($1)");
      md = md.replace(/<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
      md = md.replace(/<img[^>]+alt="([^"]*)"[^>]*src="([^"]+)"[^>]*\/?>/gi, "![$1]($2)");

      // Lists
      md = md.replace(/<li>([^<]+)<\/li>/gi, "- $1\n");

      // Horizontal rule
      md = md.replace(/<hr\s*\/?>/gi, "---\n");

      // Blockquotes
      md = md.replace(/<blockquote>([^<]+)<\/blockquote>/gi, "> $1\n");

      // Paragraphs and breaks
      md = md.replace(/<p>([^<]+)<\/p>/gi, "$1\n\n");
      md = md.replace(/<br\s*\/?>/gi, "\n");

      // Remove remaining tags
      md = md.replace(/<[^>]+>/g, "");

      // Clean up whitespace
      md = md.replace(/\n{3,}/g, "\n\n").trim();

      return md;
    },
  },
  {
    name: "format_json_pretty",
    description:
      "Pretty print JSON with indentation or minify to single line. Make JSON readable or compact for storage. Configurable indent size. Keywords: pretty JSON, format JSON, minify JSON, JSON beautify, json indent.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "string", description: "JSON string" },
        minify: { type: "boolean", description: "Minify instead of prettify" },
        indent: { type: "number", description: "Indentation spaces (default: 2)" },
      },
      required: ["json"],
    },
    handler: ({ json, minify = false, indent = 2 }) => {
      const parsed = JSON.parse(json as string);
      return minify ? JSON.stringify(parsed) : JSON.stringify(parsed, null, indent as number);
    },
  },
  {
    name: "format_json_to_csv",
    description:
      "Convert JSON array to CSV spreadsheet format. Auto-generate headers from object keys. Handle escaping for special characters. Use for data export. Keywords: JSON to CSV, export CSV, convert to spreadsheet, data export.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "string", description: "JSON array string" },
        delimiter: { type: "string", description: "Column delimiter (default: ',')" },
        includeHeaders: { type: "boolean", description: "Include header row (default: true)" },
      },
      required: ["json"],
    },
    handler: ({ json, delimiter = ",", includeHeaders = true }) => {
      const data = JSON.parse(json as string);
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error("Input must be a non-empty JSON array");
      }

      const delim = delimiter as string;
      const escapeCell = (val: unknown): string => {
        const str = val === null || val === undefined ? "" : String(val);
        if (str.includes(delim) || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const headers = Object.keys(data[0]);
      const rows: string[] = [];

      if (includeHeaders) {
        rows.push(headers.map(escapeCell).join(delim));
      }

      for (const item of data) {
        const row = headers.map((h) => escapeCell((item as Record<string, unknown>)[h]));
        rows.push(row.join(delim));
      }

      return rows.join("\n");
    },
  },
  {
    name: "format_sql",
    description:
      "Format SQL queries for readability. Add newlines, indentation, and uppercase keywords. Make complex queries readable. Keywords: SQL format, beautify SQL, SQL pretty print, format query, SQL indent.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL query to format" },
        uppercase: { type: "boolean", description: "Uppercase keywords (default: true)" },
        indent: { type: "number", description: "Indentation spaces (default: 2)" },
      },
      required: ["sql"],
    },
    handler: ({ sql, uppercase = true, indent = 2 }) => {
      const keywords = [
        "SELECT",
        "FROM",
        "WHERE",
        "AND",
        "OR",
        "ORDER BY",
        "GROUP BY",
        "HAVING",
        "JOIN",
        "LEFT JOIN",
        "RIGHT JOIN",
        "INNER JOIN",
        "OUTER JOIN",
        "FULL JOIN",
        "ON",
        "AS",
        "INSERT INTO",
        "VALUES",
        "UPDATE",
        "SET",
        "DELETE FROM",
        "CREATE TABLE",
        "ALTER TABLE",
        "DROP TABLE",
        "CREATE INDEX",
        "DROP INDEX",
        "LIMIT",
        "OFFSET",
        "UNION",
        "UNION ALL",
        "DISTINCT",
        "COUNT",
        "SUM",
        "AVG",
        "MIN",
        "MAX",
        "CASE",
        "WHEN",
        "THEN",
        "ELSE",
        "END",
        "NULL",
        "NOT NULL",
        "PRIMARY KEY",
        "FOREIGN KEY",
        "REFERENCES",
        "IN",
        "LIKE",
        "BETWEEN",
        "IS",
      ];

      let formatted = sql as string;
      const indentStr = " ".repeat(indent as number);

      // Normalize whitespace
      formatted = formatted.replace(/\s+/g, " ").trim();

      // Add newlines before major keywords
      const majorKeywords = [
        "SELECT",
        "FROM",
        "WHERE",
        "ORDER BY",
        "GROUP BY",
        "HAVING",
        "JOIN",
        "LEFT JOIN",
        "RIGHT JOIN",
        "INNER JOIN",
        "OUTER JOIN",
        "LIMIT",
        "UNION",
        "INSERT INTO",
        "UPDATE",
        "DELETE FROM",
        "SET",
      ];

      for (const kw of majorKeywords) {
        const regex = new RegExp(`\\b${kw}\\b`, "gi");
        formatted = formatted.replace(regex, `\n${kw}`);
      }

      // Add newlines after commas in SELECT
      formatted = formatted.replace(/,\s*/g, ",\n" + indentStr);

      // Indent after major keywords
      const lines = formatted.split("\n").map((line) => line.trim()).filter(Boolean);
      const result: string[] = [];

      for (const line of lines) {
        const upperLine = line.toUpperCase();
        if (
          upperLine.startsWith("SELECT") || upperLine.startsWith("FROM") ||
          upperLine.startsWith("WHERE") || upperLine.startsWith("ORDER") ||
          upperLine.startsWith("GROUP") || upperLine.startsWith("HAVING") ||
          upperLine.startsWith("LIMIT")
        ) {
          result.push(line);
        } else if (upperLine.includes("JOIN")) {
          result.push(line);
        } else {
          result.push(indentStr + line);
        }
      }

      formatted = result.join("\n");

      // Uppercase keywords if requested
      if (uppercase) {
        for (const kw of keywords) {
          const regex = new RegExp(`\\b${kw}\\b`, "gi");
          formatted = formatted.replace(regex, kw);
        }
      }

      return formatted.trim();
    },
  },
  {
    name: "format_phone",
    description:
      "Format phone numbers to standard formats. Output international (+1 xxx), national ((xxx) xxx-xxxx), or E.164 format. Handle various input formats. Keywords: phone format, format telephone, E.164, international phone, phone number.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Phone number to format" },
        format: {
          type: "string",
          enum: ["international", "national", "e164"],
          description: "Output format (default: international)",
        },
        defaultCountry: { type: "string", description: "Default country code (default: US)" },
      },
      required: ["phone"],
    },
    handler: ({ phone, format = "international", defaultCountry = "US" }) => {
      // Remove all non-digit characters except leading +
      let cleaned = (phone as string).replace(/[^\d+]/g, "");

      // Extract country code if present
      let countryCode = "";
      let nationalNumber = cleaned;

      if (cleaned.startsWith("+")) {
        // Has country code
        if (cleaned.startsWith("+1")) {
          countryCode = "+1";
          nationalNumber = cleaned.slice(2);
        } else if (cleaned.length > 10) {
          // Assume 2-3 digit country code
          const ccLength = cleaned.length > 12 ? 3 : 2;
          countryCode = cleaned.slice(0, ccLength + 1);
          nationalNumber = cleaned.slice(ccLength + 1);
        }
      } else if (defaultCountry === "US" && cleaned.length === 10) {
        countryCode = "+1";
        nationalNumber = cleaned;
      } else if (cleaned.length === 11 && cleaned.startsWith("1")) {
        countryCode = "+1";
        nationalNumber = cleaned.slice(1);
      }

      // Format based on requested format
      switch (format) {
        case "e164":
          return countryCode + nationalNumber;
        case "national":
          if (nationalNumber.length === 10) {
            return `(${nationalNumber.slice(0, 3)}) ${nationalNumber.slice(3, 6)}-${
              nationalNumber.slice(6)
            }`;
          }
          return nationalNumber;
        case "international":
        default:
          if (nationalNumber.length === 10 && countryCode) {
            return `${countryCode} (${nationalNumber.slice(0, 3)}) ${nationalNumber.slice(3, 6)}-${
              nationalNumber.slice(6)
            }`;
          }
          return countryCode + " " + nationalNumber;
      }
    },
  },
  // TOML conversion tools - inspired by IT-Tools MCP
  {
    name: "format_toml_to_json",
    description:
      "Convert TOML configuration to JSON. Parse Cargo.toml, pyproject.toml, or other TOML files. Use for config processing or migration. Keywords: TOML to JSON, parse toml, convert toml, config convert.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        toml: { type: "string", description: "TOML string to convert" },
        pretty: { type: "boolean", description: "Pretty print JSON (default: true)" },
      },
      required: ["toml"],
    },
    handler: ({ toml: tomlStr, pretty = true }) => {
      const parsed = toml.parse(tomlStr as string);
      return pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed);
    },
  },
  {
    name: "format_json_to_toml",
    description:
      "Convert JSON to TOML configuration format. Generate valid TOML from JSON objects. Use for creating config files. Keywords: JSON to TOML, generate toml, create config, toml output.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "string", description: "JSON string to convert" },
      },
      required: ["json"],
    },
    handler: ({ json }) => {
      const parsed = JSON.parse(json as string);
      return toml.stringify(parsed);
    },
  },
  {
    name: "format_xml_escape",
    description:
      "Escape or unescape XML special characters. Convert < > & \" ' to XML entities. Essential for XML safety. Keywords: XML escape, XML entities, escape xml, sanitize xml, xml encode.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to escape/unescape" },
        action: {
          type: "string",
          enum: ["escape", "unescape"],
          description: "Action (default: escape)",
        },
      },
      required: ["text"],
    },
    handler: ({ text, action = "escape" }) => {
      const xmlEntities: Record<string, string> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      };

      if (action === "escape") {
        return (text as string).replace(/[&<>"']/g, (c) => xmlEntities[c] || c);
      }

      // Unescape
      const reverseEntities: Record<string, string> = {};
      for (const [char, entity] of Object.entries(xmlEntities)) {
        reverseEntities[entity] = char;
      }
      return (text as string).replace(
        /&(?:amp|lt|gt|quot|apos);/g,
        (entity) => reverseEntities[entity] || entity,
      );
    },
  },
  {
    name: "format_properties",
    description:
      "Parse or create Java-style .properties files. Convert between properties format and JSON. Use for Java config files or i18n. Keywords: properties file, java properties, config parse, key value file.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Properties string or JSON object string" },
        action: {
          type: "string",
          enum: ["parse", "stringify"],
          description: "Action: parse properties to JSON, or stringify JSON to properties",
        },
      },
      required: ["input", "action"],
    },
    handler: ({ input, action }) => {
      if (action === "parse") {
        const result: Record<string, string> = {};
        const lines = (input as string).split(/\r?\n/);

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
            continue;
          }

          const separatorIndex = trimmed.search(/[=:]/);
          if (separatorIndex === -1) continue;

          const key = trimmed.slice(0, separatorIndex).trim();
          const value = trimmed.slice(separatorIndex + 1).trim();
          result[key] = value;
        }

        return result;
      }

      // Stringify
      const obj = JSON.parse(input as string) as Record<string, unknown>;
      const lines: string[] = [];

      for (const [key, value] of Object.entries(obj)) {
        lines.push(`${key}=${String(value)}`);
      }

      return lines.join("\n");
    },
  },
  // Code formatters - inspired by IT-Tools MCP
  {
    name: "format_html",
    description:
      "Beautify or minify HTML code. Add proper indentation and formatting or compress for production. Keywords: HTML beautify, format HTML, minify HTML, HTML indent, pretty HTML.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "HTML code to format" },
        mode: {
          type: "string",
          enum: ["beautify", "minify"],
          description: "Format mode (default: beautify)",
        },
        indent: { type: "number", description: "Indentation spaces (default: 2)" },
      },
      required: ["html"],
    },
    handler: ({ html, mode = "beautify", indent = 2 }) => {
      const input = html as string;
      const indentStr = " ".repeat(indent as number);

      if (mode === "minify") {
        return input
          .replace(/<!--[\s\S]*?-->/g, "") // Remove comments
          .replace(/>\s+</g, "><") // Remove whitespace between tags
          .replace(/\s+/g, " ") // Collapse whitespace
          .trim();
      }

      // Beautify HTML
      let result = "";
      let level = 0;
      const selfClosing =
        /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

      // Simple tokenization
      const tokens: string[] = [];
      let current = "";

      for (const char of input) {
        if (char === "<") {
          if (current.trim()) tokens.push(current.trim());
          current = "<";
        } else if (char === ">") {
          current += ">";
          tokens.push(current);
          current = "";
        } else {
          current += char;
        }
      }
      if (current.trim()) tokens.push(current.trim());

      for (const token of tokens) {
        if (token.startsWith("</")) {
          // Closing tag
          level = Math.max(0, level - 1);
          result += indentStr.repeat(level) + token + "\n";
        } else if (token.startsWith("<")) {
          // Opening tag
          const tagMatch = token.match(/^<(\w+)/);
          const tagName = tagMatch ? tagMatch[1] : "";
          const isSelfClose = token.endsWith("/>") || selfClosing.test(tagName);

          result += indentStr.repeat(level) + token + "\n";

          if (!isSelfClose && !token.startsWith("<!") && !token.startsWith("<?")) {
            level++;
          }
        } else {
          // Text content
          result += indentStr.repeat(level) + token + "\n";
        }
      }

      return result.trim();
    },
  },
  {
    name: "format_javascript",
    description:
      "Beautify or minify JavaScript code. Add indentation and structure or compress for production. Basic formatting without AST parsing. Keywords: JS beautify, format JavaScript, minify JS, JS indent, prettify code.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code to format" },
        mode: {
          type: "string",
          enum: ["beautify", "minify"],
          description: "Format mode (default: beautify)",
        },
        indent: { type: "number", description: "Indentation spaces (default: 2)" },
      },
      required: ["code"],
    },
    handler: ({ code, mode = "beautify", indent = 2 }) => {
      const input = code as string;
      const indentStr = " ".repeat(indent as number);

      if (mode === "minify") {
        return input
          .replace(/\/\/[^\n]*/g, "") // Remove single-line comments
          .replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line comments
          .replace(/\s+/g, " ") // Collapse whitespace
          .replace(/\s*([{}()[\];,:])\s*/g, "$1") // Remove space around punctuation
          .replace(/;\s*}/g, "}") // Remove trailing semicolons before }
          .trim();
      }

      // Beautify - simple approach
      let result = "";
      let level = 0;
      let inString = false;
      let stringChar = "";
      let newLine = true;

      for (let i = 0; i < input.length; i++) {
        const char = input[i];
        const prev = input[i - 1] || "";

        // Handle strings
        if ((char === '"' || char === "'" || char === "`") && prev !== "\\") {
          if (!inString) {
            inString = true;
            stringChar = char;
          } else if (char === stringChar) {
            inString = false;
          }
          result += char;
          continue;
        }

        if (inString) {
          result += char;
          continue;
        }

        // Handle braces and indentation
        if (char === "{" || char === "[" || char === "(") {
          result += char + "\n";
          level++;
          newLine = true;
        } else if (char === "}" || char === "]" || char === ")") {
          level = Math.max(0, level - 1);
          result += "\n" + indentStr.repeat(level) + char;
          newLine = false;
        } else if (char === ";") {
          result += ";\n";
          newLine = true;
        } else if (char === ",") {
          result += ",\n";
          newLine = true;
        } else if (char === "\n" || char === "\r") {
          // Skip existing newlines
        } else if (/\s/.test(char)) {
          if (!newLine && result[result.length - 1] !== " ") {
            result += " ";
          }
        } else {
          if (newLine) {
            result += indentStr.repeat(level);
            newLine = false;
          }
          result += char;
        }
      }

      return result.replace(/\n\s*\n/g, "\n").trim();
    },
  },
  {
    name: "format_xml",
    description:
      "Beautify or minify XML documents. Add proper indentation or compress. Use for config files, data exchange, or SOAP messages. Keywords: XML beautify, format XML, minify XML, XML indent, pretty XML.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        xml: { type: "string", description: "XML code to format" },
        mode: {
          type: "string",
          enum: ["beautify", "minify"],
          description: "Format mode (default: beautify)",
        },
        indent: { type: "number", description: "Indentation spaces (default: 2)" },
      },
      required: ["xml"],
    },
    handler: ({ xml, mode = "beautify", indent = 2 }) => {
      const input = xml as string;
      const indentStr = " ".repeat(indent as number);

      if (mode === "minify") {
        return input
          .replace(/<!--[\s\S]*?-->/g, "") // Remove comments
          .replace(/>\s+</g, "><") // Remove whitespace between tags
          .replace(/\s+/g, " ") // Collapse whitespace
          .trim();
      }

      // Beautify XML
      let result = "";
      let level = 0;

      // Split by tags
      const parts = input.replace(/>\s*</g, ">\n<").split("\n");

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("</")) {
          // Closing tag
          level = Math.max(0, level - 1);
          result += indentStr.repeat(level) + trimmed + "\n";
        } else if (trimmed.startsWith("<?") || trimmed.startsWith("<!")) {
          // Declaration or comment
          result += indentStr.repeat(level) + trimmed + "\n";
        } else if (trimmed.endsWith("/>")) {
          // Self-closing tag
          result += indentStr.repeat(level) + trimmed + "\n";
        } else if (trimmed.startsWith("<") && trimmed.includes("</")) {
          // Tag with content on same line
          result += indentStr.repeat(level) + trimmed + "\n";
        } else if (trimmed.startsWith("<")) {
          // Opening tag
          result += indentStr.repeat(level) + trimmed + "\n";
          level++;
        } else {
          // Text content
          result += indentStr.repeat(level) + trimmed + "\n";
        }
      }

      return result.trim();
    },
  },
  {
    name: "format_yaml",
    description:
      "Format, validate, or reformat YAML documents. Check syntax validity and normalize indentation. Use for config file validation. Keywords: YAML format, validate YAML, YAML lint, format config, check yaml.",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        yamlInput: { type: "string", description: "YAML string to format" },
        indent: { type: "number", description: "Indentation spaces (default: 2)" },
        validate: { type: "boolean", description: "Only validate, don't format (default: false)" },
      },
      required: ["yamlInput"],
    },
    handler: ({ yamlInput, indent = 2, validate = false }) => {
      // Parse and re-stringify to format
      const parsed = yaml.parse(yamlInput as string);

      if (validate) {
        return {
          valid: true,
          message: "YAML is valid",
          structure: typeof parsed,
          topLevelKeys: parsed && typeof parsed === "object" ? Object.keys(parsed) : null,
        };
      }

      return yaml.stringify(parsed, { indent: indent as number });
    },
  },
];
