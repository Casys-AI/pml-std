/**
 * MCP Mini-Tools Library
 *
 * A collection of 94 lightweight utility tools implementing MCPClientBase.
 * Designed for playground demos and educational use - no external dependencies.
 *
 * Categories (15 total, 94 tools):
 * - text (8):       String manipulation (split, join, template, regex, case, trim, count, pad)
 * - json (5):       JSON operations (parse, stringify, query, merge, keys)
 * - math (5):       Calculations (eval, stats, round, random, percentage)
 * - datetime (5):   Date/time operations (now, format, parse, diff, add)
 * - crypto (5):     Hashing and encoding (hash, uuid, base64, hex, random_bytes)
 * - collections (7): Array operations (map, filter, sort, unique, group, flatten, chunk)
 * - fs (5):         Virtual filesystem (read, write, list, delete, exists)
 * - data (5):       Fake data generation (name, email, lorem, address, user)
 * - http (4):       URL building, parsing, headers, mock responses
 * - validation (4): Email, URL, JSON schema, pattern validation
 * - format (5):     Number formatting, bytes, duration, pluralize, slugify
 * - transform (6):  CSV parse/stringify, XML, markdown strip, object pick/omit
 * - state (6):      Key-value store with TTL, counters, arrays
 * - compare (5):    Diff, Levenshtein, similarity, fuzzy match, schema inference
 * - algo (19):      Algorithms (search, set ops, aggregation, sequences, numeric)
 *
 * @module lib/mcp-tools
 */

// ============================================================================
// Types (standalone - no external dependencies)
// ============================================================================

/** MCP Tool definition */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP Client interface */
export interface MCPClientBase {
  readonly serverId: string;
  readonly serverName: string;
  connect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  disconnect(): Promise<void>;
}

export type ToolCategory =
  | "text"
  | "json"
  | "math"
  | "datetime"
  | "crypto"
  | "collections"
  | "fs"
  | "data"
  | "http"
  | "validation"
  | "format"
  | "transform"
  | "state"
  | "compare"
  | "algo";

export interface MiniTool {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

// ============================================================================
// Tool Definitions
// ============================================================================

const MINI_TOOLS: MiniTool[] = [
  // -------------------------------------------------------------------------
  // TEXT TOOLS
  // -------------------------------------------------------------------------
  {
    name: "text_split",
    description: "Split a string by delimiter into an array",
    category: "text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to split" },
        delimiter: { type: "string", description: "Delimiter (default: ',')" },
      },
      required: ["text"],
    },
    handler: ({ text, delimiter = "," }) =>
      (text as string).split(delimiter as string),
  },
  {
    name: "text_join",
    description: "Join an array of strings with a delimiter",
    category: "text",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "Items to join" },
        delimiter: { type: "string", description: "Delimiter (default: ',')" },
      },
      required: ["items"],
    },
    handler: ({ items, delimiter = "," }) =>
      (items as string[]).join(delimiter as string),
  },
  {
    name: "text_template",
    description: "Replace {{placeholders}} in a template string",
    category: "text",
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string", description: "Template with {{placeholders}}" },
        values: { type: "object", description: "Key-value pairs for replacement" },
      },
      required: ["template", "values"],
    },
    handler: ({ template, values }) => {
      let result = template as string;
      for (const [key, value] of Object.entries(values as Record<string, string>)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
      }
      return result;
    },
  },
  {
    name: "text_case",
    description: "Convert text case (upper, lower, title, camel, snake, kebab)",
    category: "text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert" },
        case: {
          type: "string",
          enum: ["upper", "lower", "title", "camel", "snake", "kebab"],
          description: "Target case",
        },
      },
      required: ["text", "case"],
    },
    handler: ({ text, case: targetCase }) => {
      const s = text as string;
      switch (targetCase) {
        case "upper":
          return s.toUpperCase();
        case "lower":
          return s.toLowerCase();
        case "title":
          return s.replace(/\b\w/g, (c) => c.toUpperCase());
        case "camel":
          return s.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""));
        case "snake":
          return s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()).replace(/^_/, "").replace(/[-\s]+/g, "_");
        case "kebab":
          return s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()).replace(/^-/, "").replace(/[_\s]+/g, "-");
        default:
          return s;
      }
    },
  },
  {
    name: "text_regex",
    description: "Match or replace using regular expression",
    category: "text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Input text" },
        pattern: { type: "string", description: "Regex pattern" },
        replacement: { type: "string", description: "Replacement (if replacing)" },
        flags: { type: "string", description: "Regex flags (default: 'g')" },
      },
      required: ["text", "pattern"],
    },
    handler: ({ text, pattern, replacement, flags = "g" }) => {
      const regex = new RegExp(pattern as string, flags as string);
      if (replacement !== undefined) {
        return (text as string).replace(regex, replacement as string);
      }
      return (text as string).match(regex) || [];
    },
  },
  {
    name: "text_trim",
    description: "Trim whitespace from text (start, end, or both)",
    category: "text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to trim" },
        side: { type: "string", enum: ["both", "start", "end"], description: "Side to trim" },
      },
      required: ["text"],
    },
    handler: ({ text, side = "both" }) => {
      const s = text as string;
      switch (side) {
        case "start":
          return s.trimStart();
        case "end":
          return s.trimEnd();
        default:
          return s.trim();
      }
    },
  },
  {
    name: "text_count",
    description: "Count words, characters, or lines in text",
    category: "text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Input text" },
        unit: { type: "string", enum: ["words", "chars", "lines"], description: "What to count" },
      },
      required: ["text"],
    },
    handler: ({ text, unit = "words" }) => {
      const s = text as string;
      switch (unit) {
        case "chars":
          return s.length;
        case "lines":
          return s.split("\n").length;
        default:
          return s.trim().split(/\s+/).filter(Boolean).length;
      }
    },
  },
  {
    name: "text_pad",
    description: "Pad text to a specified length",
    category: "text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to pad" },
        length: { type: "number", description: "Target length" },
        char: { type: "string", description: "Padding character (default: ' ')" },
        side: { type: "string", enum: ["start", "end", "both"], description: "Side to pad" },
      },
      required: ["text", "length"],
    },
    handler: ({ text, length, char = " ", side = "end" }) => {
      const s = text as string;
      const len = length as number;
      const c = (char as string)[0] || " ";
      switch (side) {
        case "start":
          return s.padStart(len, c);
        case "both": {
          const totalPad = len - s.length;
          const padStart = Math.floor(totalPad / 2);
          return s.padStart(s.length + padStart, c).padEnd(len, c);
        }
        default:
          return s.padEnd(len, c);
      }
    },
  },

  // -------------------------------------------------------------------------
  // JSON TOOLS
  // -------------------------------------------------------------------------
  {
    name: "json_parse",
    description: "Parse JSON string into object",
    category: "json",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "string", description: "JSON string to parse" },
      },
      required: ["json"],
    },
    handler: ({ json }) => JSON.parse(json as string),
  },
  {
    name: "json_stringify",
    description: "Convert object to JSON string",
    category: "json",
    inputSchema: {
      type: "object",
      properties: {
        data: { description: "Data to stringify" },
        pretty: { type: "boolean", description: "Pretty print (default: false)" },
      },
      required: ["data"],
    },
    handler: ({ data, pretty = false }) =>
      JSON.stringify(data, null, pretty ? 2 : 0),
  },
  {
    name: "json_query",
    description: "Extract value from object using dot notation path (e.g., 'user.name')",
    category: "json",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "object", description: "Object to query" },
        path: { type: "string", description: "Dot notation path (e.g., 'user.address.city')" },
      },
      required: ["data", "path"],
    },
    handler: ({ data, path }) => {
      const parts = (path as string).split(".");
      let result: unknown = data;
      for (const part of parts) {
        if (result === null || result === undefined) return undefined;
        result = (result as Record<string, unknown>)[part];
      }
      return result;
    },
  },
  {
    name: "json_merge",
    description: "Deep merge multiple objects",
    category: "json",
    inputSchema: {
      type: "object",
      properties: {
        objects: { type: "array", items: { type: "object" }, description: "Objects to merge" },
      },
      required: ["objects"],
    },
    handler: ({ objects }) => {
      const deepMerge = (target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> => {
        const result = { ...target };
        for (const key of Object.keys(source)) {
          if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
            result[key] = deepMerge(
              (result[key] as Record<string, unknown>) || {},
              source[key] as Record<string, unknown>
            );
          } else {
            result[key] = source[key];
          }
        }
        return result;
      };
      return (objects as Record<string, unknown>[]).reduce(
        (acc, obj) => deepMerge(acc, obj),
        {} as Record<string, unknown>
      );
    },
  },
  {
    name: "json_keys",
    description: "Get all keys from an object (optionally nested)",
    category: "json",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "object", description: "Object to get keys from" },
        nested: { type: "boolean", description: "Include nested keys with dot notation" },
      },
      required: ["data"],
    },
    handler: ({ data, nested = false }) => {
      if (!nested) return Object.keys(data as Record<string, unknown>);
      const keys: string[] = [];
      const walk = (obj: Record<string, unknown>, prefix = "") => {
        for (const key of Object.keys(obj)) {
          const path = prefix ? `${prefix}.${key}` : key;
          keys.push(path);
          if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            walk(obj[key] as Record<string, unknown>, path);
          }
        }
      };
      walk(data as Record<string, unknown>);
      return keys;
    },
  },

  // -------------------------------------------------------------------------
  // MATH TOOLS
  // -------------------------------------------------------------------------
  {
    name: "math_eval",
    description: "Evaluate a simple math expression (supports +, -, *, /, %, ^)",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Math expression (e.g., '2 + 3 * 4')" },
      },
      required: ["expression"],
    },
    handler: ({ expression }) => {
      // Simple safe eval for basic math
      const sanitized = (expression as string).replace(/[^0-9+\-*/%^(). ]/g, "");
      const withPow = sanitized.replace(/\^/g, "**");
      // Use Function instead of eval for slightly better isolation
      return new Function(`return ${withPow}`)();
    },
  },
  {
    name: "math_stats",
    description: "Calculate statistics (min, max, sum, avg, median) for an array of numbers",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        numbers: { type: "array", items: { type: "number" }, description: "Array of numbers" },
      },
      required: ["numbers"],
    },
    handler: ({ numbers }) => {
      const nums = numbers as number[];
      if (nums.length === 0) return { min: 0, max: 0, sum: 0, avg: 0, median: 0, count: 0 };
      const sorted = [...nums].sort((a, b) => a - b);
      const sum = nums.reduce((a, b) => a + b, 0);
      const median =
        sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];
      return {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        sum,
        avg: sum / nums.length,
        median,
        count: nums.length,
      };
    },
  },
  {
    name: "math_round",
    description: "Round a number to specified decimal places",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "number", description: "Number to round" },
        decimals: { type: "number", description: "Decimal places (default: 0)" },
        mode: { type: "string", enum: ["round", "floor", "ceil"], description: "Rounding mode" },
      },
      required: ["number"],
    },
    handler: ({ number, decimals = 0, mode = "round" }) => {
      const factor = Math.pow(10, decimals as number);
      const n = (number as number) * factor;
      let result: number;
      switch (mode) {
        case "floor":
          result = Math.floor(n);
          break;
        case "ceil":
          result = Math.ceil(n);
          break;
        default:
          result = Math.round(n);
      }
      return result / factor;
    },
  },
  {
    name: "math_random",
    description: "Generate random number(s) within a range",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        min: { type: "number", description: "Minimum value (default: 0)" },
        max: { type: "number", description: "Maximum value (default: 100)" },
        count: { type: "number", description: "How many numbers (default: 1)" },
        integer: { type: "boolean", description: "Integer only (default: true)" },
      },
    },
    handler: ({ min = 0, max = 100, count = 1, integer = true }) => {
      const generate = () => {
        const n = Math.random() * ((max as number) - (min as number)) + (min as number);
        return integer ? Math.floor(n) : n;
      };
      const cnt = count as number;
      return cnt === 1 ? generate() : Array.from({ length: cnt }, generate);
    },
  },
  {
    name: "math_percentage",
    description: "Calculate percentage (value/total * 100) or value from percentage",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "The value" },
        total: { type: "number", description: "The total (for calculating %)" },
        percentage: { type: "number", description: "Percentage (for calculating value)" },
      },
    },
    handler: ({ value, total, percentage }) => {
      if (percentage !== undefined && total !== undefined) {
        return ((percentage as number) / 100) * (total as number);
      }
      if (value !== undefined && total !== undefined) {
        return ((value as number) / (total as number)) * 100;
      }
      throw new Error("Provide (value, total) or (percentage, total)");
    },
  },

  // -------------------------------------------------------------------------
  // DATETIME TOOLS
  // -------------------------------------------------------------------------
  {
    name: "datetime_now",
    description: "Get current date/time in various formats",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["iso", "unix", "date", "time", "full"],
          description: "Output format",
        },
        timezone: { type: "string", description: "Timezone (e.g., 'America/New_York')" },
      },
    },
    handler: ({ format = "iso", timezone }) => {
      const now = new Date();
      const options: Intl.DateTimeFormatOptions = timezone ? { timeZone: timezone as string } : {};
      switch (format) {
        case "unix":
          return Math.floor(now.getTime() / 1000);
        case "date":
          return now.toLocaleDateString("en-CA", options); // YYYY-MM-DD
        case "time":
          return now.toLocaleTimeString("en-US", { ...options, hour12: false });
        case "full":
          return now.toLocaleString("en-US", options);
        default:
          return now.toISOString();
      }
    },
  },
  {
    name: "datetime_format",
    description: "Format a date using pattern (YYYY, MM, DD, HH, mm, ss)",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date string or timestamp" },
        pattern: { type: "string", description: "Format pattern (e.g., 'YYYY-MM-DD HH:mm')" },
      },
      required: ["date", "pattern"],
    },
    handler: ({ date, pattern }) => {
      const d = new Date(date as string);
      const pad = (n: number) => n.toString().padStart(2, "0");
      return (pattern as string)
        .replace("YYYY", d.getFullYear().toString())
        .replace("MM", pad(d.getMonth() + 1))
        .replace("DD", pad(d.getDate()))
        .replace("HH", pad(d.getHours()))
        .replace("mm", pad(d.getMinutes()))
        .replace("ss", pad(d.getSeconds()));
    },
  },
  {
    name: "datetime_diff",
    description: "Calculate difference between two dates",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date" },
        to: { type: "string", description: "End date (default: now)" },
        unit: {
          type: "string",
          enum: ["seconds", "minutes", "hours", "days", "weeks"],
          description: "Unit for result",
        },
      },
      required: ["from"],
    },
    handler: ({ from, to, unit = "days" }) => {
      const fromDate = new Date(from as string);
      const toDate = to ? new Date(to as string) : new Date();
      const diffMs = toDate.getTime() - fromDate.getTime();
      const divisors = {
        seconds: 1000,
        minutes: 1000 * 60,
        hours: 1000 * 60 * 60,
        days: 1000 * 60 * 60 * 24,
        weeks: 1000 * 60 * 60 * 24 * 7,
      };
      return Math.floor(diffMs / divisors[unit as keyof typeof divisors]);
    },
  },
  {
    name: "datetime_add",
    description: "Add/subtract time from a date",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Base date (default: now)" },
        amount: { type: "number", description: "Amount to add (negative to subtract)" },
        unit: {
          type: "string",
          enum: ["seconds", "minutes", "hours", "days", "weeks", "months", "years"],
          description: "Unit",
        },
      },
      required: ["amount", "unit"],
    },
    handler: ({ date, amount, unit }) => {
      const d = date ? new Date(date as string) : new Date();
      const amt = amount as number;
      switch (unit) {
        case "seconds":
          d.setSeconds(d.getSeconds() + amt);
          break;
        case "minutes":
          d.setMinutes(d.getMinutes() + amt);
          break;
        case "hours":
          d.setHours(d.getHours() + amt);
          break;
        case "days":
          d.setDate(d.getDate() + amt);
          break;
        case "weeks":
          d.setDate(d.getDate() + amt * 7);
          break;
        case "months":
          d.setMonth(d.getMonth() + amt);
          break;
        case "years":
          d.setFullYear(d.getFullYear() + amt);
          break;
      }
      return d.toISOString();
    },
  },
  {
    name: "datetime_parse",
    description: "Parse a date string and return components",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date string to parse" },
      },
      required: ["date"],
    },
    handler: ({ date }) => {
      const d = new Date(date as string);
      return {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        hour: d.getHours(),
        minute: d.getMinutes(),
        second: d.getSeconds(),
        dayOfWeek: d.getDay(),
        dayName: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()],
        iso: d.toISOString(),
        unix: Math.floor(d.getTime() / 1000),
      };
    },
  },

  // -------------------------------------------------------------------------
  // CRYPTO TOOLS
  // -------------------------------------------------------------------------
  {
    name: "crypto_hash",
    description: "Generate hash of text (SHA-256, SHA-1, MD5)",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to hash" },
        algorithm: {
          type: "string",
          enum: ["SHA-256", "SHA-1", "SHA-384", "SHA-512"],
          description: "Hash algorithm",
        },
      },
      required: ["text"],
    },
    handler: async ({ text, algorithm = "SHA-256" }) => {
      const encoder = new TextEncoder();
      const data = encoder.encode(text as string);
      const hashBuffer = await crypto.subtle.digest(algorithm as string, data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    },
  },
  {
    name: "crypto_uuid",
    description: "Generate UUID(s)",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many UUIDs (default: 1)" },
      },
    },
    handler: ({ count = 1 }) => {
      const cnt = count as number;
      const uuids = Array.from({ length: cnt }, () => crypto.randomUUID());
      return cnt === 1 ? uuids[0] : uuids;
    },
  },
  {
    name: "crypto_base64",
    description: "Encode or decode Base64",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to encode/decode" },
        action: { type: "string", enum: ["encode", "decode"], description: "Action" },
      },
      required: ["text", "action"],
    },
    handler: ({ text, action }) => {
      if (action === "encode") {
        return btoa(text as string);
      }
      return atob(text as string);
    },
  },
  {
    name: "crypto_hex",
    description: "Encode or decode hexadecimal",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to encode/decode" },
        action: { type: "string", enum: ["encode", "decode"], description: "Action" },
      },
      required: ["text", "action"],
    },
    handler: ({ text, action }) => {
      if (action === "encode") {
        return Array.from(new TextEncoder().encode(text as string))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      const hex = text as string;
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
      }
      return new TextDecoder().decode(bytes);
    },
  },
  {
    name: "crypto_random_bytes",
    description: "Generate random bytes as hex string",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        length: { type: "number", description: "Number of bytes (default: 16)" },
      },
    },
    handler: ({ length = 16 }) => {
      const bytes = crypto.getRandomValues(new Uint8Array(length as number));
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    },
  },

  // -------------------------------------------------------------------------
  // COLLECTIONS TOOLS
  // -------------------------------------------------------------------------
  {
    name: "array_map",
    description: "Transform each element using a simple expression",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to transform" },
        expression: { type: "string", description: "Expression using 'x' (e.g., 'x * 2', 'x.name')" },
      },
      required: ["items", "expression"],
    },
    handler: ({ items, expression }) => {
      const expr = expression as string;
      const fn = new Function("x", `return ${expr}`);
      return (items as unknown[]).map((x) => fn(x));
    },
  },
  {
    name: "array_filter",
    description: "Filter elements using a condition expression",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to filter" },
        condition: { type: "string", description: "Condition using 'x' (e.g., 'x > 10', 'x.active')" },
      },
      required: ["items", "condition"],
    },
    handler: ({ items, condition }) => {
      const fn = new Function("x", `return ${condition}`);
      return (items as unknown[]).filter((x) => fn(x));
    },
  },
  {
    name: "array_sort",
    description: "Sort array (optionally by a key for objects)",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to sort" },
        key: { type: "string", description: "Key to sort by (for objects)" },
        order: { type: "string", enum: ["asc", "desc"], description: "Sort order" },
      },
      required: ["items"],
    },
    handler: ({ items, key, order = "asc" }) => {
      const arr = [...(items as unknown[])];
      arr.sort((a, b) => {
        const aVal = key ? (a as Record<string, unknown>)[key as string] : a;
        const bVal = key ? (b as Record<string, unknown>)[key as string] : b;
        if (aVal < bVal) return order === "asc" ? -1 : 1;
        if (aVal > bVal) return order === "asc" ? 1 : -1;
        return 0;
      });
      return arr;
    },
  },
  {
    name: "array_unique",
    description: "Remove duplicate values from array",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to deduplicate" },
        key: { type: "string", description: "Key to compare (for objects)" },
      },
      required: ["items"],
    },
    handler: ({ items, key }) => {
      const arr = items as unknown[];
      if (!key) {
        return [...new Set(arr)];
      }
      const seen = new Set();
      return arr.filter((item) => {
        const val = (item as Record<string, unknown>)[key as string];
        if (seen.has(val)) return false;
        seen.add(val);
        return true;
      });
    },
  },
  {
    name: "array_group",
    description: "Group array elements by a key",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to group" },
        key: { type: "string", description: "Key to group by" },
      },
      required: ["items", "key"],
    },
    handler: ({ items, key }) => {
      const result: Record<string, unknown[]> = {};
      for (const item of items as Record<string, unknown>[]) {
        const groupKey = String(item[key as string]);
        if (!result[groupKey]) result[groupKey] = [];
        result[groupKey].push(item);
      }
      return result;
    },
  },
  {
    name: "array_flatten",
    description: "Flatten nested arrays",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Nested array to flatten" },
        depth: { type: "number", description: "Depth to flatten (default: 1)" },
      },
      required: ["items"],
    },
    handler: ({ items, depth = 1 }) => (items as unknown[]).flat(depth as number),
  },
  {
    name: "array_chunk",
    description: "Split array into chunks of specified size",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to chunk" },
        size: { type: "number", description: "Chunk size" },
      },
      required: ["items", "size"],
    },
    handler: ({ items, size }) => {
      const arr = items as unknown[];
      const chunks: unknown[][] = [];
      for (let i = 0; i < arr.length; i += size as number) {
        chunks.push(arr.slice(i, i + (size as number)));
      }
      return chunks;
    },
  },

  // -------------------------------------------------------------------------
  // VIRTUAL FILESYSTEM TOOLS
  // -------------------------------------------------------------------------
  {
    name: "fs_read",
    description: "Read file from virtual filesystem",
    category: "fs",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
    handler: ({ path }) => {
      const content = virtualFs.get(path as string);
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    },
  },
  {
    name: "fs_write",
    description: "Write file to virtual filesystem",
    category: "fs",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
    handler: ({ path, content }) => {
      virtualFs.set(path as string, content as string);
      return { success: true, path, size: (content as string).length };
    },
  },
  {
    name: "fs_list",
    description: "List files in virtual filesystem (optionally filtered by prefix)",
    category: "fs",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Path prefix filter" },
      },
    },
    handler: ({ prefix }) => {
      const files = Array.from(virtualFs.keys());
      if (prefix) {
        return files.filter((f) => f.startsWith(prefix as string));
      }
      return files;
    },
  },
  {
    name: "fs_delete",
    description: "Delete file from virtual filesystem",
    category: "fs",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
    handler: ({ path }) => {
      const existed = virtualFs.delete(path as string);
      return { success: existed, path };
    },
  },
  {
    name: "fs_exists",
    description: "Check if file exists in virtual filesystem",
    category: "fs",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
    handler: ({ path }) => virtualFs.has(path as string),
  },

  // -------------------------------------------------------------------------
  // DATA GENERATION TOOLS
  // -------------------------------------------------------------------------
  {
    name: "data_fake_name",
    description: "Generate fake person name(s)",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many names (default: 1)" },
        gender: { type: "string", enum: ["male", "female", "any"], description: "Gender" },
      },
    },
    handler: ({ count = 1, gender = "any" }) => {
      const maleFirst = ["James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles"];
      const femaleFirst = ["Mary", "Patricia", "Jennifer", "Linda", "Barbara", "Elizabeth", "Susan", "Jessica", "Sarah", "Karen"];
      const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"];

      const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
      const generate = () => {
        const g = gender === "any" ? (Math.random() > 0.5 ? "male" : "female") : gender;
        const first = pick(g === "male" ? maleFirst : femaleFirst);
        return `${first} ${pick(lastNames)}`;
      };
      const cnt = count as number;
      return cnt === 1 ? generate() : Array.from({ length: cnt }, generate);
    },
  },
  {
    name: "data_fake_email",
    description: "Generate fake email address(es)",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many emails (default: 1)" },
        domain: { type: "string", description: "Email domain (default: random)" },
      },
    },
    handler: ({ count = 1, domain }) => {
      const domains = ["gmail.com", "yahoo.com", "outlook.com", "example.com", "test.org"];
      const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
      const generate = () => {
        const user = `user${Math.floor(Math.random() * 10000)}`;
        const d = (domain as string) || pick(domains);
        return `${user}@${d}`;
      };
      const cnt = count as number;
      return cnt === 1 ? generate() : Array.from({ length: cnt }, generate);
    },
  },
  {
    name: "data_lorem",
    description: "Generate Lorem Ipsum text",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of units (default: 1)" },
        unit: { type: "string", enum: ["words", "sentences", "paragraphs"], description: "Unit type" },
      },
    },
    handler: ({ count = 5, unit = "sentences" }) => {
      const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat".split(" ");
      const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
      const cnt = count as number;

      if (unit === "words") {
        return Array.from({ length: cnt }, () => pick(words)).join(" ");
      }

      const sentence = () => {
        const len = 5 + Math.floor(Math.random() * 10);
        const s = Array.from({ length: len }, () => pick(words)).join(" ");
        return s.charAt(0).toUpperCase() + s.slice(1) + ".";
      };

      if (unit === "sentences") {
        return Array.from({ length: cnt }, sentence).join(" ");
      }

      // paragraphs
      const paragraph = () => Array.from({ length: 3 + Math.floor(Math.random() * 3) }, sentence).join(" ");
      return Array.from({ length: cnt }, paragraph).join("\n\n");
    },
  },
  {
    name: "data_fake_address",
    description: "Generate fake address",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many addresses (default: 1)" },
      },
    },
    handler: ({ count = 1 }) => {
      const streets = ["Main St", "Oak Ave", "Maple Dr", "Cedar Ln", "Pine Rd", "Elm St", "Park Blvd", "Lake View"];
      const cities = ["Springfield", "Riverside", "Greenville", "Fairview", "Madison", "Georgetown", "Clinton", "Arlington"];
      const states = ["CA", "TX", "NY", "FL", "IL", "PA", "OH", "GA"];
      const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
      const generate = () => ({
        street: `${100 + Math.floor(Math.random() * 9900)} ${pick(streets)}`,
        city: pick(cities),
        state: pick(states),
        zip: String(10000 + Math.floor(Math.random() * 89999)),
      });
      const cnt = count as number;
      return cnt === 1 ? generate() : Array.from({ length: cnt }, generate);
    },
  },
  {
    name: "data_fake_user",
    description: "Generate fake user object (name, email, id, created)",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many users (default: 1)" },
      },
    },
    handler: ({ count = 1 }) => {
      const firstNames = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda"];
      const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis"];
      const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
      const generate = () => {
        const first = pick(firstNames);
        const last = pick(lastNames);
        const id = crypto.randomUUID().slice(0, 8);
        return {
          id,
          name: `${first} ${last}`,
          email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
          createdAt: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString(),
        };
      };
      const cnt = count as number;
      return cnt === 1 ? generate() : Array.from({ length: cnt }, generate);
    },
  },

  // -------------------------------------------------------------------------
  // HTTP TOOLS (simulated - useful for teaching API patterns)
  // -------------------------------------------------------------------------
  {
    name: "http_build_url",
    description: "Build URL with query parameters",
    category: "http",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: "Base URL" },
        path: { type: "string", description: "Path to append" },
        params: { type: "object", description: "Query parameters" },
      },
      required: ["base"],
    },
    handler: ({ base, path, params }) => {
      let url = base as string;
      if (path) url = url.replace(/\/$/, "") + "/" + (path as string).replace(/^\//, "");
      if (params && Object.keys(params as Record<string, unknown>).length > 0) {
        const queryStr = Object.entries(params as Record<string, unknown>)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&");
        url += "?" + queryStr;
      }
      return url;
    },
  },
  {
    name: "http_parse_url",
    description: "Parse URL into components",
    category: "http",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to parse" },
      },
      required: ["url"],
    },
    handler: ({ url }) => {
      const parsed = new URL(url as string);
      const params: Record<string, string> = {};
      parsed.searchParams.forEach((v, k) => params[k] = v);
      return {
        protocol: parsed.protocol,
        host: parsed.host,
        hostname: parsed.hostname,
        port: parsed.port,
        pathname: parsed.pathname,
        search: parsed.search,
        hash: parsed.hash,
        params,
      };
    },
  },
  {
    name: "http_headers",
    description: "Build HTTP headers object from common presets",
    category: "http",
    inputSchema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          enum: ["json", "form", "text", "bearer"],
          description: "Header preset",
        },
        token: { type: "string", description: "Bearer token (for bearer preset)" },
        custom: { type: "object", description: "Custom headers to merge" },
      },
    },
    handler: ({ preset = "json", token, custom }) => {
      const headers: Record<string, string> = {};
      switch (preset) {
        case "json":
          headers["Content-Type"] = "application/json";
          headers["Accept"] = "application/json";
          break;
        case "form":
          headers["Content-Type"] = "application/x-www-form-urlencoded";
          break;
        case "text":
          headers["Content-Type"] = "text/plain";
          break;
        case "bearer":
          if (token) headers["Authorization"] = `Bearer ${token}`;
          break;
      }
      return { ...headers, ...(custom as Record<string, string> || {}) };
    },
  },
  {
    name: "http_mock_response",
    description: "Generate mock HTTP response for testing",
    category: "http",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "number", description: "HTTP status code (default: 200)" },
        body: { description: "Response body" },
        delay: { type: "number", description: "Simulated delay ms (default: 0)" },
      },
    },
    handler: async ({ status = 200, body, delay = 0 }) => {
      if (delay) await new Promise((r) => setTimeout(r, delay as number));
      const statusTexts: Record<number, string> = {
        200: "OK", 201: "Created", 204: "No Content",
        400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
        500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
      };
      return {
        status,
        statusText: statusTexts[status as number] || "Unknown",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": crypto.randomUUID().slice(0, 8),
        },
      };
    },
  },

  // -------------------------------------------------------------------------
  // VALIDATION TOOLS
  // -------------------------------------------------------------------------
  {
    name: "validate_email",
    description: "Validate email address format",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email to validate" },
      },
      required: ["email"],
    },
    handler: ({ email }) => {
      const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const e = email as string;
      return {
        valid: pattern.test(e),
        email: e,
        domain: e.includes("@") ? e.split("@")[1] : null,
      };
    },
  },
  {
    name: "validate_url",
    description: "Validate URL format",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to validate" },
        protocols: { type: "array", items: { type: "string" }, description: "Allowed protocols" },
      },
      required: ["url"],
    },
    handler: ({ url, protocols }) => {
      try {
        const parsed = new URL(url as string);
        const allowedProtocols = protocols as string[] || ["http:", "https:"];
        const protocolValid = allowedProtocols.includes(parsed.protocol);
        return {
          valid: protocolValid,
          url: url as string,
          protocol: parsed.protocol,
          host: parsed.host,
        };
      } catch {
        return { valid: false, url: url as string, error: "Invalid URL format" };
      }
    },
  },
  {
    name: "validate_json_schema",
    description: "Validate data against a simple JSON schema",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        data: { description: "Data to validate" },
        schema: {
          type: "object",
          description: "Schema with 'type' and optional 'properties', 'required'",
        },
      },
      required: ["data", "schema"],
    },
    handler: ({ data, schema }) => {
      const errors: string[] = [];
      const s = schema as { type?: string; properties?: Record<string, { type: string }>; required?: string[] };

      // Type check
      if (s.type) {
        const actualType = Array.isArray(data) ? "array" : typeof data;
        if (actualType !== s.type) {
          errors.push(`Expected type '${s.type}', got '${actualType}'`);
        }
      }

      // Required fields
      if (s.required && typeof data === "object" && data !== null) {
        for (const field of s.required) {
          if (!(field in (data as Record<string, unknown>))) {
            errors.push(`Missing required field: '${field}'`);
          }
        }
      }

      // Property types
      if (s.properties && typeof data === "object" && data !== null) {
        for (const [key, propSchema] of Object.entries(s.properties)) {
          const val = (data as Record<string, unknown>)[key];
          if (val !== undefined && typeof val !== propSchema.type) {
            errors.push(`Field '${key}': expected ${propSchema.type}, got ${typeof val}`);
          }
        }
      }

      return { valid: errors.length === 0, errors };
    },
  },
  {
    name: "validate_pattern",
    description: "Validate string against common patterns (phone, zipcode, creditcard, etc.)",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string", description: "Value to validate" },
        pattern: {
          type: "string",
          enum: ["phone", "zipcode_us", "creditcard", "ipv4", "ipv6", "uuid", "slug"],
          description: "Pattern type",
        },
      },
      required: ["value", "pattern"],
    },
    handler: ({ value, pattern }) => {
      const patterns: Record<string, RegExp> = {
        phone: /^\+?[\d\s\-()]{10,}$/,
        zipcode_us: /^\d{5}(-\d{4})?$/,
        creditcard: /^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}$/,
        ipv4: /^(\d{1,3}\.){3}\d{1,3}$/,
        ipv6: /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/,
        uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        slug: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      };
      const regex = patterns[pattern as string];
      return {
        valid: regex ? regex.test(value as string) : false,
        value,
        pattern,
      };
    },
  },

  // -------------------------------------------------------------------------
  // FORMAT TOOLS
  // -------------------------------------------------------------------------
  {
    name: "format_number",
    description: "Format number with locale, decimals, currency",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "number", description: "Number to format" },
        locale: { type: "string", description: "Locale (e.g., 'en-US', 'fr-FR')" },
        style: { type: "string", enum: ["decimal", "currency", "percent"], description: "Format style" },
        currency: { type: "string", description: "Currency code for currency style (e.g., 'USD')" },
        decimals: { type: "number", description: "Decimal places" },
      },
      required: ["number"],
    },
    handler: ({ number, locale = "en-US", style = "decimal", currency = "USD", decimals }) => {
      const options: Intl.NumberFormatOptions = { style: style as string };
      if (style === "currency") options.currency = currency as string;
      if (decimals !== undefined) {
        options.minimumFractionDigits = decimals as number;
        options.maximumFractionDigits = decimals as number;
      }
      return new Intl.NumberFormat(locale as string, options).format(number as number);
    },
  },
  {
    name: "format_bytes",
    description: "Format bytes to human readable (KB, MB, GB)",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        bytes: { type: "number", description: "Bytes to format" },
        decimals: { type: "number", description: "Decimal places (default: 2)" },
      },
      required: ["bytes"],
    },
    handler: ({ bytes, decimals = 2 }) => {
      const b = bytes as number;
      if (b === 0) return "0 Bytes";
      const k = 1024;
      const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB"];
      const i = Math.floor(Math.log(b) / Math.log(k));
      return `${parseFloat((b / Math.pow(k, i)).toFixed(decimals as number))} ${sizes[i]}`;
    },
  },
  {
    name: "format_duration",
    description: "Format milliseconds to human readable duration",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "number", description: "Milliseconds" },
        format: { type: "string", enum: ["long", "short", "compact"], description: "Format style" },
      },
      required: ["ms"],
    },
    handler: ({ ms, format = "long" }) => {
      const milliseconds = ms as number;
      const seconds = Math.floor(milliseconds / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (format === "compact") {
        if (days > 0) return `${days}d`;
        if (hours > 0) return `${hours}h`;
        if (minutes > 0) return `${minutes}m`;
        if (seconds > 0) return `${seconds}s`;
        return `${milliseconds}ms`;
      }

      const parts: string[] = [];
      if (days > 0) parts.push(`${days} day${days > 1 ? "s" : ""}`);
      if (hours % 24 > 0) parts.push(`${hours % 24} hour${hours % 24 > 1 ? "s" : ""}`);
      if (minutes % 60 > 0) parts.push(`${minutes % 60} minute${minutes % 60 > 1 ? "s" : ""}`);
      if (seconds % 60 > 0) parts.push(`${seconds % 60} second${seconds % 60 > 1 ? "s" : ""}`);

      if (parts.length === 0) return `${milliseconds}ms`;

      if (format === "short") {
        return parts.slice(0, 2).join(" ");
      }
      return parts.join(" ");
    },
  },
  {
    name: "format_pluralize",
    description: "Pluralize a word based on count",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "Word to pluralize" },
        count: { type: "number", description: "Count" },
        plural: { type: "string", description: "Custom plural form" },
        includeCount: { type: "boolean", description: "Include count in output" },
      },
      required: ["word", "count"],
    },
    handler: ({ word, count, plural, includeCount = true }) => {
      const w = word as string;
      const c = count as number;
      const p = (plural as string) || w + "s";
      const result = c === 1 ? w : p;
      return includeCount ? `${c} ${result}` : result;
    },
  },
  {
    name: "format_slugify",
    description: "Convert text to URL-safe slug",
    category: "format",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to slugify" },
        separator: { type: "string", description: "Separator (default: '-')" },
      },
      required: ["text"],
    },
    handler: ({ text, separator = "-" }) => {
      return (text as string)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
        .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
        .trim()
        .replace(/\s+/g, separator as string) // Replace spaces
        .replace(new RegExp(`${separator}+`, "g"), separator as string); // Remove duplicate separators
    },
  },

  // -------------------------------------------------------------------------
  // TRANSFORM TOOLS
  // -------------------------------------------------------------------------
  {
    name: "transform_csv_parse",
    description: "Parse CSV string into array of objects",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        csv: { type: "string", description: "CSV string" },
        delimiter: { type: "string", description: "Delimiter (default: ',')" },
        hasHeader: { type: "boolean", description: "First row is header (default: true)" },
      },
      required: ["csv"],
    },
    handler: ({ csv, delimiter = ",", hasHeader = true }) => {
      const lines = (csv as string).trim().split("\n");
      if (lines.length === 0) return [];

      const parseRow = (line: string) => {
        const result: string[] = [];
        let current = "";
        let inQuotes = false;
        for (const char of line) {
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === delimiter && !inQuotes) {
            result.push(current.trim());
            current = "";
          } else {
            current += char;
          }
        }
        result.push(current.trim());
        return result;
      };

      if (!hasHeader) {
        return lines.map(parseRow);
      }

      const headers = parseRow(lines[0]);
      return lines.slice(1).map((line) => {
        const values = parseRow(line);
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => (obj[h] = values[i] || ""));
        return obj;
      });
    },
  },
  {
    name: "transform_csv_stringify",
    description: "Convert array of objects to CSV string",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "array", description: "Array of objects" },
        columns: { type: "array", items: { type: "string" }, description: "Columns to include" },
        delimiter: { type: "string", description: "Delimiter (default: ',')" },
      },
      required: ["data"],
    },
    handler: ({ data, columns, delimiter = "," }) => {
      const arr = data as Record<string, unknown>[];
      if (arr.length === 0) return "";

      const cols = (columns as string[]) || Object.keys(arr[0]);
      const escape = (val: unknown) => {
        const str = String(val ?? "");
        return str.includes(delimiter as string) || str.includes('"') || str.includes("\n")
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      };

      const header = cols.join(delimiter as string);
      const rows = arr.map((obj) => cols.map((c) => escape(obj[c])).join(delimiter as string));
      return [header, ...rows].join("\n");
    },
  },
  {
    name: "transform_xml_simple",
    description: "Convert simple object to XML string",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "object", description: "Object to convert" },
        root: { type: "string", description: "Root element name (default: 'root')" },
        indent: { type: "boolean", description: "Pretty print (default: true)" },
      },
      required: ["data"],
    },
    handler: ({ data, root = "root", indent = true }) => {
      const toXml = (obj: unknown, name: string, level: number): string => {
        const pad = indent ? "  ".repeat(level) : "";
        const nl = indent ? "\n" : "";

        if (obj === null || obj === undefined) {
          return `${pad}<${name}/>${nl}`;
        }
        if (typeof obj !== "object") {
          return `${pad}<${name}>${String(obj)}</${name}>${nl}`;
        }
        if (Array.isArray(obj)) {
          return obj.map((item) => toXml(item, name, level)).join("");
        }

        const entries = Object.entries(obj as Record<string, unknown>);
        const children = entries.map(([k, v]) => toXml(v, k, level + 1)).join("");
        return `${pad}<${name}>${nl}${children}${pad}</${name}>${nl}`;
      };

      return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(data, root as string, 0)}`;
    },
  },
  {
    name: "transform_markdown_strip",
    description: "Strip markdown formatting to plain text",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "Markdown text" },
      },
      required: ["markdown"],
    },
    handler: ({ markdown }) => {
      return (markdown as string)
        .replace(/#{1,6}\s*/g, "") // Headers
        .replace(/\*\*([^*]+)\*\*/g, "$1") // Bold
        .replace(/\*([^*]+)\*/g, "$1") // Italic
        .replace(/__([^_]+)__/g, "$1") // Bold alt
        .replace(/_([^_]+)_/g, "$1") // Italic alt
        .replace(/`{3}[\s\S]*?`{3}/g, "") // Code blocks
        .replace(/`([^`]+)`/g, "$1") // Inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Links
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1") // Images
        .replace(/^\s*[-*+]\s+/gm, "") // Unordered lists
        .replace(/^\s*\d+\.\s+/gm, "") // Ordered lists
        .replace(/^\s*>/gm, "") // Blockquotes
        .replace(/---+/g, "") // Horizontal rules
        .replace(/\n{3,}/g, "\n\n") // Multiple newlines
        .trim();
    },
  },
  {
    name: "transform_object_pick",
    description: "Pick specific keys from an object",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "object", description: "Source object" },
        keys: { type: "array", items: { type: "string" }, description: "Keys to pick" },
      },
      required: ["data", "keys"],
    },
    handler: ({ data, keys }) => {
      const result: Record<string, unknown> = {};
      for (const key of keys as string[]) {
        if (key in (data as Record<string, unknown>)) {
          result[key] = (data as Record<string, unknown>)[key];
        }
      }
      return result;
    },
  },
  {
    name: "transform_object_omit",
    description: "Omit specific keys from an object",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "object", description: "Source object" },
        keys: { type: "array", items: { type: "string" }, description: "Keys to omit" },
      },
      required: ["data", "keys"],
    },
    handler: ({ data, keys }) => {
      const keysSet = new Set(keys as string[]);
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (!keysSet.has(k)) result[k] = v;
      }
      return result;
    },
  },

  // -------------------------------------------------------------------------
  // STATE TOOLS (useful for multi-step workflows)
  // -------------------------------------------------------------------------
  {
    name: "state_set",
    description: "Store a value in state (key-value store)",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key" },
        value: { description: "Value to store" },
        ttl: { type: "number", description: "Time-to-live in seconds (optional)" },
      },
      required: ["key", "value"],
    },
    handler: ({ key, value, ttl }) => {
      const entry: StateEntry = { value, createdAt: Date.now() };
      if (ttl) entry.expiresAt = Date.now() + (ttl as number) * 1000;
      stateStore.set(key as string, entry);
      return { success: true, key };
    },
  },
  {
    name: "state_get",
    description: "Retrieve a value from state",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key" },
        defaultValue: { description: "Default if not found" },
      },
      required: ["key"],
    },
    handler: ({ key, defaultValue }) => {
      const entry = stateStore.get(key as string);
      if (!entry) return defaultValue ?? null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        stateStore.delete(key as string);
        return defaultValue ?? null;
      }
      return entry.value;
    },
  },
  {
    name: "state_delete",
    description: "Delete a value from state",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to delete" },
      },
      required: ["key"],
    },
    handler: ({ key }) => {
      const existed = stateStore.delete(key as string);
      return { success: existed, key };
    },
  },
  {
    name: "state_list",
    description: "List all keys in state",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Filter by key prefix" },
      },
    },
    handler: ({ prefix }) => {
      const keys = Array.from(stateStore.keys());
      if (prefix) return keys.filter((k) => k.startsWith(prefix as string));
      return keys;
    },
  },
  {
    name: "state_counter",
    description: "Increment/decrement a counter in state",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Counter key" },
        delta: { type: "number", description: "Amount to add (default: 1, negative to subtract)" },
        initial: { type: "number", description: "Initial value if counter doesn't exist" },
      },
      required: ["key"],
    },
    handler: ({ key, delta = 1, initial = 0 }) => {
      const k = key as string;
      const entry = stateStore.get(k);
      const current = (entry?.value as number) ?? (initial as number);
      const newValue = current + (delta as number);
      stateStore.set(k, { value: newValue, createdAt: Date.now() });
      return { key: k, value: newValue, previous: current };
    },
  },
  {
    name: "state_push",
    description: "Push value to an array in state (creates if doesn't exist)",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Array key" },
        value: { description: "Value to push" },
        maxLength: { type: "number", description: "Max array length (removes oldest if exceeded)" },
      },
      required: ["key", "value"],
    },
    handler: ({ key, value, maxLength }) => {
      const k = key as string;
      const entry = stateStore.get(k);
      const arr = Array.isArray(entry?.value) ? [...(entry.value as unknown[])] : [];
      arr.push(value);
      if (maxLength && arr.length > (maxLength as number)) {
        arr.shift();
      }
      stateStore.set(k, { value: arr, createdAt: Date.now() });
      return { key: k, length: arr.length };
    },
  },

  // -------------------------------------------------------------------------
  // COMPARE TOOLS (reasoning about data - diff, similarity, fuzzy matching)
  // -------------------------------------------------------------------------
  {
    name: "compare_diff",
    description: "Compare two values and return differences (works with strings, arrays, objects)",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        a: { description: "First value" },
        b: { description: "Second value" },
        mode: {
          type: "string",
          enum: ["simple", "detailed"],
          description: "Output mode (default: simple)",
        },
      },
      required: ["a", "b"],
    },
    handler: ({ a, b, mode = "simple" }) => {
      // String diff
      if (typeof a === "string" && typeof b === "string") {
        const linesA = (a as string).split("\n");
        const linesB = (b as string).split("\n");
        const added: string[] = [];
        const removed: string[] = [];
        const unchanged: string[] = [];

        const setA = new Set(linesA);
        const setB = new Set(linesB);

        for (const line of linesA) {
          if (!setB.has(line)) removed.push(line);
          else unchanged.push(line);
        }
        for (const line of linesB) {
          if (!setA.has(line)) added.push(line);
        }

        return mode === "detailed"
          ? { added, removed, unchanged, totalChanges: added.length + removed.length }
          : { added: added.length, removed: removed.length, unchanged: unchanged.length };
      }

      // Array diff
      if (Array.isArray(a) && Array.isArray(b)) {
        const setA = new Set((a as unknown[]).map((x) => JSON.stringify(x)));
        const setB = new Set((b as unknown[]).map((x) => JSON.stringify(x)));

        const added = (b as unknown[]).filter((x) => !setA.has(JSON.stringify(x)));
        const removed = (a as unknown[]).filter((x) => !setB.has(JSON.stringify(x)));

        return mode === "detailed"
          ? { added, removed, totalChanges: added.length + removed.length }
          : { added: added.length, removed: removed.length };
      }

      // Object diff
      if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
        const objA = a as Record<string, unknown>;
        const objB = b as Record<string, unknown>;
        const allKeys = new Set([...Object.keys(objA), ...Object.keys(objB)]);

        const added: Record<string, unknown> = {};
        const removed: Record<string, unknown> = {};
        const changed: Record<string, { from: unknown; to: unknown }> = {};
        const unchanged: string[] = [];

        for (const key of allKeys) {
          const inA = key in objA;
          const inB = key in objB;

          if (!inA && inB) {
            added[key] = objB[key];
          } else if (inA && !inB) {
            removed[key] = objA[key];
          } else if (JSON.stringify(objA[key]) !== JSON.stringify(objB[key])) {
            changed[key] = { from: objA[key], to: objB[key] };
          } else {
            unchanged.push(key);
          }
        }

        return mode === "detailed"
          ? { added, removed, changed, unchanged }
          : {
              added: Object.keys(added).length,
              removed: Object.keys(removed).length,
              changed: Object.keys(changed).length,
              unchanged: unchanged.length,
            };
      }

      // Primitive comparison
      return { equal: a === b, a, b };
    },
  },
  {
    name: "compare_levenshtein",
    description: "Calculate Levenshtein edit distance between two strings",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "First string" },
        b: { type: "string", description: "Second string" },
        normalize: { type: "boolean", description: "Return normalized similarity (0-1) instead of distance" },
      },
      required: ["a", "b"],
    },
    handler: ({ a, b, normalize = false }) => {
      const strA = a as string;
      const strB = b as string;

      if (strA === strB) return normalize ? { similarity: 1, distance: 0 } : { distance: 0 };
      if (strA.length === 0) return normalize ? { similarity: 0, distance: strB.length } : { distance: strB.length };
      if (strB.length === 0) return normalize ? { similarity: 0, distance: strA.length } : { distance: strA.length };

      // Wagner-Fischer algorithm
      const matrix: number[][] = [];

      for (let i = 0; i <= strA.length; i++) {
        matrix[i] = [i];
      }
      for (let j = 0; j <= strB.length; j++) {
        matrix[0][j] = j;
      }

      for (let i = 1; i <= strA.length; i++) {
        for (let j = 1; j <= strB.length; j++) {
          const cost = strA[i - 1] === strB[j - 1] ? 0 : 1;
          matrix[i][j] = Math.min(
            matrix[i - 1][j] + 1, // deletion
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j - 1] + cost // substitution
          );
        }
      }

      const distance = matrix[strA.length][strB.length];
      const maxLen = Math.max(strA.length, strB.length);
      const similarity = 1 - distance / maxLen;

      return normalize ? { similarity: Math.round(similarity * 1000) / 1000, distance } : { distance };
    },
  },
  {
    name: "compare_similarity",
    description: "Calculate similarity between two strings using multiple algorithms",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "First string" },
        b: { type: "string", description: "Second string" },
        algorithm: {
          type: "string",
          enum: ["jaccard", "dice", "cosine", "overlap"],
          description: "Similarity algorithm (default: jaccard)",
        },
        tokenize: {
          type: "string",
          enum: ["chars", "words", "ngrams"],
          description: "How to tokenize (default: words)",
        },
        ngramSize: { type: "number", description: "N-gram size if tokenize=ngrams (default: 2)" },
      },
      required: ["a", "b"],
    },
    handler: ({ a, b, algorithm = "jaccard", tokenize = "words", ngramSize = 2 }) => {
      const strA = (a as string).toLowerCase();
      const strB = (b as string).toLowerCase();

      // Tokenize
      let tokensA: string[];
      let tokensB: string[];

      switch (tokenize) {
        case "chars":
          tokensA = strA.split("");
          tokensB = strB.split("");
          break;
        case "ngrams": {
          const n = ngramSize as number;
          tokensA = [];
          tokensB = [];
          for (let i = 0; i <= strA.length - n; i++) tokensA.push(strA.slice(i, i + n));
          for (let i = 0; i <= strB.length - n; i++) tokensB.push(strB.slice(i, i + n));
          break;
        }
        default: // words
          tokensA = strA.split(/\s+/).filter(Boolean);
          tokensB = strB.split(/\s+/).filter(Boolean);
      }

      const setA = new Set(tokensA);
      const setB = new Set(tokensB);
      const intersection = new Set([...setA].filter((x) => setB.has(x)));
      const union = new Set([...setA, ...setB]);

      let similarity: number;

      switch (algorithm) {
        case "dice":
          similarity = (2 * intersection.size) / (setA.size + setB.size);
          break;
        case "overlap":
          similarity = intersection.size / Math.min(setA.size, setB.size);
          break;
        case "cosine": {
          // Simple cosine using term frequency
          const allTerms = [...union];
          const vecA = allTerms.map((t) => tokensA.filter((x) => x === t).length);
          const vecB = allTerms.map((t) => tokensB.filter((x) => x === t).length);
          const dot = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
          const magA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
          const magB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
          similarity = magA && magB ? dot / (magA * magB) : 0;
          break;
        }
        default: // jaccard
          similarity = union.size ? intersection.size / union.size : 0;
      }

      return {
        similarity: Math.round(similarity * 1000) / 1000,
        algorithm,
        tokenize,
        tokensA: tokensA.length,
        tokensB: tokensB.length,
      };
    },
  },
  {
    name: "compare_fuzzy_match",
    description: "Find best fuzzy matches for a query in a list of candidates",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        candidates: { type: "array", items: { type: "string" }, description: "List of candidates to match against" },
        limit: { type: "number", description: "Max results (default: 5)" },
        threshold: { type: "number", description: "Min similarity 0-1 (default: 0.3)" },
        key: { type: "string", description: "If candidates are objects, key to match on" },
      },
      required: ["query", "candidates"],
    },
    handler: ({ query, candidates, limit = 5, threshold = 0.3, key }) => {
      const q = (query as string).toLowerCase();
      const items = candidates as Array<string | Record<string, unknown>>;

      const scored = items.map((item, index) => {
        const text = key
          ? String((item as Record<string, unknown>)[key as string] ?? "")
          : String(item);
        const t = text.toLowerCase();

        // Combined scoring: substring bonus + Levenshtein-based similarity
        let score = 0;

        // Exact match bonus
        if (t === q) score = 1;
        // Contains query bonus
        else if (t.includes(q)) score = 0.8 + (q.length / t.length) * 0.2;
        // Starts with query bonus
        else if (t.startsWith(q)) score = 0.9;
        else {
          // Levenshtein similarity
          const maxLen = Math.max(q.length, t.length);
          if (maxLen > 0) {
            // Simplified Levenshtein for performance
            let distance = 0;
            const len = Math.min(q.length, t.length);
            for (let i = 0; i < len; i++) {
              if (q[i] !== t[i]) distance++;
            }
            distance += Math.abs(q.length - t.length);
            score = 1 - distance / maxLen;
          }
        }

        return { item, text, score, index };
      });

      return scored
        .filter((s) => s.score >= (threshold as number))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit as number)
        .map((s) => ({
          match: s.item,
          text: s.text,
          score: Math.round(s.score * 1000) / 1000,
          index: s.index,
        }));
    },
  },
  {
    name: "compare_schema_infer",
    description: "Infer JSON schema from sample data",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        data: { description: "Sample data to analyze" },
        deep: { type: "boolean", description: "Analyze nested objects (default: true)" },
      },
      required: ["data"],
    },
    handler: ({ data, deep = true }) => {
      const inferType = (value: unknown, depth: number): Record<string, unknown> => {
        if (value === null) return { type: "null" };
        if (value === undefined) return { type: "undefined" };

        const type = typeof value;

        if (type === "string") return { type: "string", example: (value as string).slice(0, 50) };
        if (type === "number") return { type: Number.isInteger(value) ? "integer" : "number", example: value };
        if (type === "boolean") return { type: "boolean", example: value };

        if (Array.isArray(value)) {
          if (value.length === 0) return { type: "array", items: { type: "unknown" } };
          // Infer from first item
          const itemSchema = deep && depth < 5 ? inferType(value[0], depth + 1) : { type: typeof value[0] };
          return { type: "array", items: itemSchema, length: value.length };
        }

        if (type === "object") {
          const obj = value as Record<string, unknown>;
          const properties: Record<string, unknown> = {};
          const required: string[] = [];

          for (const [k, v] of Object.entries(obj)) {
            properties[k] = deep && depth < 5 ? inferType(v, depth + 1) : { type: typeof v };
            if (v !== null && v !== undefined) required.push(k);
          }

          return { type: "object", properties, required };
        }

        return { type };
      };

      const schema = inferType(data, 0);
      return { schema, dataType: Array.isArray(data) ? "array" : typeof data };
    },
  },

  // -------------------------------------------------------------------------
  // ALGO TOOLS (algorithms, data processing, search, aggregation)
  // -------------------------------------------------------------------------

  // === Search ===
  {
    name: "algo_binary_search",
    description: "Binary search in a sorted array. Returns index or -1 if not found",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Sorted array to search" },
        target: { description: "Value to find" },
        key: { type: "string", description: "Key to compare (for objects)" },
      },
      required: ["items", "target"],
    },
    handler: ({ items, target, key }) => {
      const arr = items as unknown[];
      let left = 0;
      let right = arr.length - 1;

      const getValue = (item: unknown) =>
        key ? (item as Record<string, unknown>)[key as string] : item;

      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const midVal = getValue(arr[mid]);

        if (midVal === target) return { found: true, index: mid, value: arr[mid] };
        if (midVal < (target as unknown)) left = mid + 1;
        else right = mid - 1;
      }

      return { found: false, index: -1, insertionPoint: left };
    },
  },
  {
    name: "algo_find_index",
    description: "Find first index where condition is true (like Array.findIndex but with expression)",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to search" },
        condition: { type: "string", description: "Condition expression using 'x' and 'i' (index)" },
        fromIndex: { type: "number", description: "Start index (default: 0)" },
      },
      required: ["items", "condition"],
    },
    handler: ({ items, condition, fromIndex = 0 }) => {
      const arr = items as unknown[];
      const fn = new Function("x", "i", `return ${condition}`);
      for (let i = fromIndex as number; i < arr.length; i++) {
        if (fn(arr[i], i)) return { found: true, index: i, value: arr[i] };
      }
      return { found: false, index: -1 };
    },
  },
  {
    name: "algo_find_all",
    description: "Find all items and indices matching a condition",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to search" },
        condition: { type: "string", description: "Condition expression using 'x' and 'i' (index)" },
      },
      required: ["items", "condition"],
    },
    handler: ({ items, condition }) => {
      const arr = items as unknown[];
      const fn = new Function("x", "i", `return ${condition}`);
      const results: Array<{ index: number; value: unknown }> = [];
      for (let i = 0; i < arr.length; i++) {
        if (fn(arr[i], i)) results.push({ index: i, value: arr[i] });
      }
      return { count: results.length, matches: results };
    },
  },

  // === Set Operations ===
  {
    name: "algo_union",
    description: "Union of multiple arrays (all unique elements)",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        arrays: { type: "array", items: { type: "array" }, description: "Arrays to union" },
        key: { type: "string", description: "Key for uniqueness (for objects)" },
      },
      required: ["arrays"],
    },
    handler: ({ arrays, key }) => {
      const arrs = arrays as unknown[][];
      if (!key) {
        const set = new Set<unknown>();
        for (const arr of arrs) {
          for (const item of arr) set.add(item);
        }
        return Array.from(set);
      }
      // Object uniqueness by key
      const seen = new Map<unknown, unknown>();
      for (const arr of arrs) {
        for (const item of arr) {
          const k = (item as Record<string, unknown>)[key as string];
          if (!seen.has(k)) seen.set(k, item);
        }
      }
      return Array.from(seen.values());
    },
  },
  {
    name: "algo_intersect",
    description: "Intersection of multiple arrays (elements in all arrays)",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        arrays: { type: "array", items: { type: "array" }, description: "Arrays to intersect" },
        key: { type: "string", description: "Key for comparison (for objects)" },
      },
      required: ["arrays"],
    },
    handler: ({ arrays, key }) => {
      const arrs = arrays as unknown[][];
      if (arrs.length === 0) return [];
      if (arrs.length === 1) return arrs[0];

      const getKey = (item: unknown) =>
        key ? (item as Record<string, unknown>)[key as string] : item;

      // Count occurrences across arrays
      const counts = new Map<unknown, number>();
      for (const arr of arrs) {
        const seen = new Set<unknown>();
        for (const item of arr) {
          const k = getKey(item);
          if (!seen.has(k)) {
            seen.add(k);
            counts.set(k, (counts.get(k) || 0) + 1);
          }
        }
      }

      // Keep items that appear in all arrays
      const result: unknown[] = [];
      const added = new Set<unknown>();
      for (const item of arrs[0]) {
        const k = getKey(item);
        if (counts.get(k) === arrs.length && !added.has(k)) {
          result.push(item);
          added.add(k);
        }
      }
      return result;
    },
  },
  {
    name: "algo_difference",
    description: "Difference between arrays (elements in first but not in others)",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "array", description: "Base array" },
        subtract: { type: "array", items: { type: "array" }, description: "Arrays to subtract" },
        key: { type: "string", description: "Key for comparison (for objects)" },
      },
      required: ["base", "subtract"],
    },
    handler: ({ base, subtract, key }) => {
      const baseArr = base as unknown[];
      const subtractArrs = subtract as unknown[][];

      const getKey = (item: unknown) =>
        key ? (item as Record<string, unknown>)[key as string] : item;

      const excludeSet = new Set<unknown>();
      for (const arr of subtractArrs) {
        for (const item of arr) {
          excludeSet.add(getKey(item));
        }
      }

      return baseArr.filter((item) => !excludeSet.has(getKey(item)));
    },
  },
  {
    name: "algo_is_subset",
    description: "Check if array A is a subset of array B",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        subset: { type: "array", description: "Potential subset array" },
        superset: { type: "array", description: "Potential superset array" },
        key: { type: "string", description: "Key for comparison (for objects)" },
      },
      required: ["subset", "superset"],
    },
    handler: ({ subset, superset, key }) => {
      const subArr = subset as unknown[];
      const superArr = superset as unknown[];

      const getKey = (item: unknown) =>
        key ? (item as Record<string, unknown>)[key as string] : item;

      const superSet = new Set(superArr.map(getKey));
      const isSubset = subArr.every((item) => superSet.has(getKey(item)));

      return {
        isSubset,
        subsetSize: subArr.length,
        supersetSize: superArr.length,
        missing: isSubset ? [] : subArr.filter((item) => !superSet.has(getKey(item))),
      };
    },
  },

  // === Aggregation ===
  {
    name: "algo_group_aggregate",
    description: "Group by key and apply aggregation (sum, count, avg, min, max)",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array of objects" },
        groupBy: { type: "string", description: "Key to group by" },
        aggregate: {
          type: "object",
          description: "Aggregations: { outputKey: { field: 'fieldName', op: 'sum'|'count'|'avg'|'min'|'max' } }",
        },
      },
      required: ["items", "groupBy", "aggregate"],
    },
    handler: ({ items, groupBy, aggregate }) => {
      const arr = items as Record<string, unknown>[];
      const agg = aggregate as Record<string, { field: string; op: string }>;

      const groups = new Map<unknown, Record<string, unknown>[]>();
      for (const item of arr) {
        const key = item[groupBy as string];
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(item);
      }

      const result: Record<string, unknown>[] = [];
      for (const [key, groupItems] of groups) {
        const row: Record<string, unknown> = { [groupBy as string]: key };

        for (const [outKey, { field, op }] of Object.entries(agg)) {
          const values = groupItems.map((item) => item[field] as number).filter((v) => typeof v === "number");

          switch (op) {
            case "sum":
              row[outKey] = values.reduce((a, b) => a + b, 0);
              break;
            case "count":
              row[outKey] = groupItems.length;
              break;
            case "avg":
              row[outKey] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
              break;
            case "min":
              row[outKey] = values.length ? Math.min(...values) : null;
              break;
            case "max":
              row[outKey] = values.length ? Math.max(...values) : null;
              break;
          }
        }
        result.push(row);
      }

      return result;
    },
  },
  {
    name: "algo_running_total",
    description: "Calculate running total (cumulative sum) of values",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array of numbers or objects" },
        key: { type: "string", description: "Key to sum (for objects)" },
        outputKey: { type: "string", description: "Key for running total in output (default: '_runningTotal')" },
      },
      required: ["items"],
    },
    handler: ({ items, key, outputKey = "_runningTotal" }) => {
      const arr = items as unknown[];
      let total = 0;

      return arr.map((item) => {
        const value = key ? (item as Record<string, unknown>)[key as string] as number : item as number;
        total += typeof value === "number" ? value : 0;

        if (typeof item === "object" && item !== null) {
          return { ...(item as Record<string, unknown>), [outputKey as string]: total };
        }
        return { value: item, [outputKey as string]: total };
      });
    },
  },
  {
    name: "algo_moving_average",
    description: "Calculate moving average with a sliding window",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array of numbers or objects" },
        windowSize: { type: "number", description: "Size of sliding window" },
        key: { type: "string", description: "Key to average (for objects)" },
      },
      required: ["items", "windowSize"],
    },
    handler: ({ items, windowSize, key }) => {
      const arr = items as unknown[];
      const size = windowSize as number;
      const result: Array<{ value: unknown; movingAvg: number | null; windowValues: number[] }> = [];

      for (let i = 0; i < arr.length; i++) {
        const windowStart = Math.max(0, i - size + 1);
        const windowValues: number[] = [];

        for (let j = windowStart; j <= i; j++) {
          const val = key
            ? (arr[j] as Record<string, unknown>)[key as string] as number
            : arr[j] as number;
          if (typeof val === "number") windowValues.push(val);
        }

        const movingAvg = windowValues.length >= size
          ? windowValues.reduce((a, b) => a + b, 0) / windowValues.length
          : null;

        result.push({
          value: arr[i],
          movingAvg: movingAvg !== null ? Math.round(movingAvg * 1000) / 1000 : null,
          windowValues,
        });
      }

      return result;
    },
  },
  {
    name: "algo_top_n",
    description: "Get top N items by a numeric field",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to search" },
        n: { type: "number", description: "Number of items to return" },
        key: { type: "string", description: "Key to sort by (for objects)" },
        order: { type: "string", enum: ["desc", "asc"], description: "Sort order (default: desc for top)" },
      },
      required: ["items", "n"],
    },
    handler: ({ items, n, key, order = "desc" }) => {
      const arr = [...(items as unknown[])];

      arr.sort((a, b) => {
        const aVal = key ? (a as Record<string, unknown>)[key as string] : a;
        const bVal = key ? (b as Record<string, unknown>)[key as string] : b;
        const cmp = (aVal as number) - (bVal as number);
        return order === "desc" ? -cmp : cmp;
      });

      return arr.slice(0, n as number);
    },
  },

  // === Sequences ===
  {
    name: "algo_zip",
    description: "Zip multiple arrays together into array of tuples",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        arrays: { type: "array", items: { type: "array" }, description: "Arrays to zip" },
        fill: { description: "Value to fill for shorter arrays (default: undefined)" },
      },
      required: ["arrays"],
    },
    handler: ({ arrays, fill }) => {
      const arrs = arrays as unknown[][];
      if (arrs.length === 0) return [];

      const maxLen = Math.max(...arrs.map((a) => a.length));
      const result: unknown[][] = [];

      for (let i = 0; i < maxLen; i++) {
        result.push(arrs.map((arr) => (i < arr.length ? arr[i] : fill)));
      }

      return result;
    },
  },
  {
    name: "algo_partition",
    description: "Partition array into two arrays based on a condition",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to partition" },
        condition: { type: "string", description: "Condition expression using 'x' and 'i'" },
      },
      required: ["items", "condition"],
    },
    handler: ({ items, condition }) => {
      const arr = items as unknown[];
      const fn = new Function("x", "i", `return ${condition}`);
      const pass: unknown[] = [];
      const fail: unknown[] = [];

      arr.forEach((item, i) => {
        if (fn(item, i)) pass.push(item);
        else fail.push(item);
      });

      return { pass, fail, passCount: pass.length, failCount: fail.length };
    },
  },
  {
    name: "algo_interleave",
    description: "Interleave multiple arrays (a1, b1, c1, a2, b2, c2, ...)",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        arrays: { type: "array", items: { type: "array" }, description: "Arrays to interleave" },
      },
      required: ["arrays"],
    },
    handler: ({ arrays }) => {
      const arrs = arrays as unknown[][];
      if (arrs.length === 0) return [];

      const maxLen = Math.max(...arrs.map((a) => a.length));
      const result: unknown[] = [];

      for (let i = 0; i < maxLen; i++) {
        for (const arr of arrs) {
          if (i < arr.length) result.push(arr[i]);
        }
      }

      return result;
    },
  },
  {
    name: "algo_transpose",
    description: "Transpose a 2D array (rows become columns)",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        matrix: { type: "array", items: { type: "array" }, description: "2D array to transpose" },
      },
      required: ["matrix"],
    },
    handler: ({ matrix }) => {
      const mat = matrix as unknown[][];
      if (mat.length === 0) return [];
      if (mat[0].length === 0) return [];

      const rows = mat.length;
      const cols = Math.max(...mat.map((r) => r.length));
      const result: unknown[][] = [];

      for (let c = 0; c < cols; c++) {
        const row: unknown[] = [];
        for (let r = 0; r < rows; r++) {
          row.push(mat[r][c]);
        }
        result.push(row);
      }

      return result;
    },
  },

  // === Numeric ===
  {
    name: "algo_clamp",
    description: "Clamp value(s) between min and max",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        value: { description: "Single number or array of numbers" },
        min: { type: "number", description: "Minimum value" },
        max: { type: "number", description: "Maximum value" },
      },
      required: ["value", "min", "max"],
    },
    handler: ({ value, min, max }) => {
      const clamp = (n: number) => Math.min(Math.max(n, min as number), max as number);

      if (Array.isArray(value)) {
        return (value as number[]).map(clamp);
      }
      return clamp(value as number);
    },
  },
  {
    name: "algo_normalize",
    description: "Normalize array values to 0-1 range (min-max normalization)",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "number" }, description: "Array of numbers" },
        targetMin: { type: "number", description: "Target range min (default: 0)" },
        targetMax: { type: "number", description: "Target range max (default: 1)" },
      },
      required: ["items"],
    },
    handler: ({ items, targetMin = 0, targetMax = 1 }) => {
      const arr = items as number[];
      if (arr.length === 0) return [];

      const min = Math.min(...arr);
      const max = Math.max(...arr);
      const range = max - min;

      if (range === 0) {
        return arr.map(() => (targetMin as number + targetMax as number) / 2);
      }

      const tMin = targetMin as number;
      const tMax = targetMax as number;
      const tRange = tMax - tMin;

      return arr.map((v) => {
        const normalized = (v - min) / range;
        return Math.round((tMin + normalized * tRange) * 1000) / 1000;
      });
    },
  },
  {
    name: "algo_interpolate",
    description: "Linear interpolation between two values",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "number", description: "Start value" },
        to: { type: "number", description: "End value" },
        t: { type: "number", description: "Interpolation factor (0-1) or array of factors" },
      },
      required: ["from", "to", "t"],
    },
    handler: ({ from, to, t }) => {
      const a = from as number;
      const b = to as number;

      const lerp = (factor: number) => a + (b - a) * factor;

      if (Array.isArray(t)) {
        return (t as number[]).map((factor) => Math.round(lerp(factor) * 1000) / 1000);
      }
      return Math.round(lerp(t as number) * 1000) / 1000;
    },
  },
  {
    name: "algo_round_to",
    description: "Round number(s) to nearest multiple",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        value: { description: "Single number or array of numbers" },
        multiple: { type: "number", description: "Round to nearest multiple of this (e.g., 5, 10, 0.25)" },
        mode: { type: "string", enum: ["round", "floor", "ceil"], description: "Rounding mode" },
      },
      required: ["value", "multiple"],
    },
    handler: ({ value, multiple, mode = "round" }) => {
      const m = multiple as number;

      const roundTo = (n: number) => {
        switch (mode) {
          case "floor":
            return Math.floor(n / m) * m;
          case "ceil":
            return Math.ceil(n / m) * m;
          default:
            return Math.round(n / m) * m;
        }
      };

      if (Array.isArray(value)) {
        return (value as number[]).map(roundTo);
      }
      return roundTo(value as number);
    },
  },
];

// ============================================================================
// State Store (for state_* tools)
// ============================================================================

interface StateEntry {
  value: unknown;
  createdAt: number;
  expiresAt?: number;
}

/**
 * In-memory key-value store for state_* tools
 */
const stateStore = new Map<string, StateEntry>();

/**
 * Reset state store (useful between demos)
 */
export function resetStateStore(): void {
  stateStore.clear();
}

/**
 * Get state store snapshot (for inspection)
 */
export function getStateStoreSnapshot(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of stateStore) {
    // Skip expired entries
    if (entry.expiresAt && Date.now() > entry.expiresAt) continue;
    result[key] = entry.value;
  }
  return result;
}

// ============================================================================
// Virtual Filesystem State
// ============================================================================

/**
 * In-memory virtual filesystem for fs_* tools
 */
const virtualFs = new Map<string, string>();

/**
 * Reset virtual filesystem (useful between demos)
 */
export function resetVirtualFs(): void {
  virtualFs.clear();
}

/**
 * Get virtual filesystem contents (for inspection)
 */
export function getVirtualFsSnapshot(): Record<string, string> {
  return Object.fromEntries(virtualFs);
}

// ============================================================================
// MCP Client Implementation
// ============================================================================

/**
 * MCP Client providing all mini-tools
 *
 * Implements MCPClientBase interface for use with WorkerBridge.
 */
export class MiniToolsClient implements MCPClientBase {
  readonly serverId = "mini-tools";
  readonly serverName = "Mini-Tools Library";

  private readonly toolsByName: Map<string, MiniTool>;

  constructor(private readonly enabledCategories?: ToolCategory[]) {
    this.toolsByName = new Map();
    for (const tool of MINI_TOOLS) {
      if (!enabledCategories || enabledCategories.includes(tool.category)) {
        this.toolsByName.set(tool.name, tool);
      }
    }
  }

  async connect(): Promise<void> {
    // No-op: tools are available immediately
  }

  async listTools(): Promise<MCPTool[]> {
    return Array.from(this.toolsByName.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.toolsByName.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    return await tool.handler(args);
  }

  async disconnect(): Promise<void> {
    // No-op
  }

  async close(): Promise<void> {
    // No-op
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(category: ToolCategory): MCPTool[] {
    return Array.from(this.toolsByName.values())
      .filter((tool) => tool.category === category)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }

  /**
   * Get all available categories
   */
  getCategories(): ToolCategory[] {
    const categories = new Set<ToolCategory>();
    for (const tool of this.toolsByName.values()) {
      categories.add(tool.category);
    }
    return Array.from(categories);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a MiniToolsClient with all tools
 */
export function createMiniToolsClient(): MiniToolsClient {
  return new MiniToolsClient();
}

/**
 * Create a MiniToolsClient with specific categories only
 */
export function createMiniToolsClientForCategories(
  categories: ToolCategory[]
): MiniToolsClient {
  return new MiniToolsClient(categories);
}

/**
 * Get default MCP clients map for WorkerBridge
 *
 * Returns a Map containing the MiniToolsClient ready for use.
 */
export function getDefaultMCPClients(): Map<string, MCPClientBase> {
  const clients = new Map<string, MCPClientBase>();
  clients.set("mini-tools", new MiniToolsClient());
  return clients;
}

// ============================================================================
// Tool Discovery
// ============================================================================

/**
 * Get total count of available tools
 */
export function getToolCount(): number {
  return MINI_TOOLS.length;
}

/**
 * Get all tool names
 */
export function getAllToolNames(): string[] {
  return MINI_TOOLS.map((t) => t.name);
}

/**
 * Get tool names by category
 */
export function getToolNamesByCategory(category: ToolCategory): string[] {
  return MINI_TOOLS.filter((t) => t.category === category).map((t) => t.name);
}

/**
 * List all tools with descriptions (for documentation)
 */
export function listAllTools(): Array<{ name: string; category: ToolCategory; description: string }> {
  return MINI_TOOLS.map((t) => ({
    name: t.name,
    category: t.category,
    description: t.description,
  }));
}

// ============================================================================
// CLI / Demo
// ============================================================================

if (import.meta.main) {
  console.log("🛠️  MCP Mini-Tools Library\n");

  const client = createMiniToolsClient();
  const tools = await client.listTools();

  console.log(`Total tools: ${tools.length}\n`);

  // Group by category
  const byCategory = new Map<string, MCPTool[]>();
  for (const tool of tools) {
    const category = MINI_TOOLS.find((t) => t.name === tool.name)?.category ?? "unknown";
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(tool);
  }

  for (const [category, categoryTools] of byCategory) {
    console.log(`\n📁 ${category.toUpperCase()} (${categoryTools.length} tools)`);
    for (const tool of categoryTools) {
      console.log(`   • ${tool.name}: ${tool.description}`);
    }
  }

  // Demo some tools
  console.log("\n\n🎯 Demo:\n");

  const demos = [
    { tool: "text_template", args: { template: "Hello, {{name}}!", values: { name: "World" } } },
    { tool: "math_stats", args: { numbers: [1, 2, 3, 4, 5, 10, 20] } },
    { tool: "datetime_now", args: { format: "full" } },
    { tool: "crypto_uuid", args: { count: 3 } },
    { tool: "data_fake_user", args: { count: 2 } },
  ];

  for (const demo of demos) {
    const result = await client.callTool(demo.tool, demo.args);
    console.log(`${demo.tool}(${JSON.stringify(demo.args)}):`);
    console.log(`  → ${JSON.stringify(result)}\n`);
  }
}
