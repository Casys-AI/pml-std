/**
 * Schema inference and generation tools
 *
 * Infer JSON schemas from data, generate TypeScript types, and analyze data structures.
 * Note: For schema validation, see validation.ts (validate_schema)
 *
 * @module lib/std/schema
 */

import type { MiniTool } from "./types.ts";

// JSON Schema type
interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
  nullable?: boolean;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  additionalProperties?: boolean | JSONSchema;
}

// Infer type from value
const inferType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

// Detect common formats
const detectFormat = (value: string): string | undefined => {
  // ISO date
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/.test(value)) return "date-time";
  // Email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "email";
  // URI
  if (/^https?:\/\//.test(value)) return "uri";
  // UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "uuid";
  // IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return "ipv4";
  return undefined;
};

export const schemaTools: MiniTool[] = [
  {
    name: "schema_infer",
    description:
      "Infer JSON Schema from sample data. Analyze data structure to generate a JSON Schema definition with types, required fields, and formats. Use for API documentation, data validation setup, or schema generation. Keywords: infer schema, JSON schema, generate schema, data schema, type inference, schema from data.",
    category: "schema",
    inputSchema: {
      type: "object",
      properties: {
        data: { description: "Sample data to analyze (object or array)" },
        detectFormats: {
          type: "boolean",
          description: "Detect string formats like email, uri, date (default: true)",
        },
        includeExamples: {
          type: "boolean",
          description: "Include example values (default: false)",
        },
      },
      required: ["data"],
    },
    handler: ({ data, detectFormats = true, includeExamples = false }) => {
      const infer = (value: unknown, path: string[] = []): JSONSchema => {
        const type = inferType(value);

        switch (type) {
          case "null":
            return { type: "null" };

          case "boolean":
            return { type: "boolean" };

          case "number": {
            const schema: JSONSchema = {
              type: Number.isInteger(value as number) ? "integer" : "number",
            };
            return schema;
          }

          case "string": {
            const schema: JSONSchema = { type: "string" };
            if (detectFormats) {
              const format = detectFormat(value as string);
              if (format) schema.format = format;
            }
            return schema;
          }

          case "array": {
            const arr = value as unknown[];
            if (arr.length === 0) {
              return { type: "array", items: {} };
            }

            // Infer items type from all elements
            const itemSchemas = arr.map((item, i) => infer(item, [...path, `[${i}]`]));

            // Try to merge schemas
            const types = new Set(itemSchemas.map((s) => JSON.stringify(s)));
            if (types.size === 1) {
              return { type: "array", items: itemSchemas[0] };
            }

            // Mixed types - use anyOf
            return {
              type: "array",
              items: { anyOf: [...types].map((t) => JSON.parse(t)) },
            };
          }

          case "object": {
            const obj = value as Record<string, unknown>;
            const properties: Record<string, JSONSchema> = {};
            const required: string[] = [];

            for (const [key, val] of Object.entries(obj)) {
              properties[key] = infer(val, [...path, key]);
              if (val !== undefined && val !== null) {
                required.push(key);
              }
            }

            const schema: JSONSchema = { type: "object", properties };
            if (required.length > 0) {
              schema.required = required;
            }
            return schema;
          }

          default:
            return {};
        }
      };

      const schema = infer(data);

      // Add meta
      const result: Record<string, unknown> = {
        $schema: "http://json-schema.org/draft-07/schema#",
        ...schema,
      };

      if (includeExamples) {
        result.examples = [data];
      }

      return result;
    },
  },
  {
    name: "schema_to_typescript",
    description:
      "Generate TypeScript type/interface from JSON Schema or data. Convert schema definitions to TypeScript for type-safe code. Use for API client generation, type definitions, or codegen. Keywords: TypeScript types, schema to type, generate interface, type codegen, JSON to TypeScript.",
    category: "schema",
    inputSchema: {
      type: "object",
      properties: {
        schema: { description: "JSON Schema or sample data object" },
        name: { type: "string", description: "Type/interface name (default: 'Generated')" },
        useInterface: { type: "boolean", description: "Use interface vs type (default: true)" },
        exportType: { type: "boolean", description: "Add export keyword (default: true)" },
      },
      required: ["schema"],
    },
    handler: ({ schema, name = "Generated", useInterface = true, exportType = true }) => {
      // If schema is data, infer schema first
      let jsonSchema: JSONSchema;
      if ((schema as JSONSchema).type || (schema as JSONSchema).properties) {
        jsonSchema = schema as JSONSchema;
      } else {
        // Infer from data
        const inferType = (value: unknown): JSONSchema => {
          if (value === null) return { type: "null" };
          if (Array.isArray(value)) {
            return {
              type: "array",
              items: value.length > 0 ? inferType(value[0]) : {},
            };
          }
          if (typeof value === "object") {
            const props: Record<string, JSONSchema> = {};
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
              props[k] = inferType(v);
            }
            return { type: "object", properties: props };
          }
          return { type: typeof value };
        };
        jsonSchema = inferType(schema);
      }

      const indent = "  ";

      const schemaToTS = (s: JSONSchema, level: number = 0): string => {
        const pad = indent.repeat(level);

        if (!s.type && s.properties) {
          s.type = "object";
        }

        if (s.enum) {
          return s.enum.map((v) => JSON.stringify(v)).join(" | ");
        }

        if (s.const !== undefined) {
          return JSON.stringify(s.const);
        }

        if (s.anyOf || s.oneOf) {
          const variants = s.anyOf || s.oneOf;
          return variants!.map((v) => schemaToTS(v, level)).join(" | ");
        }

        if (s.allOf) {
          return s.allOf.map((v) => schemaToTS(v, level)).join(" & ");
        }

        const type = Array.isArray(s.type) ? s.type[0] : s.type;

        switch (type) {
          case "string":
            return "string";
          case "number":
          case "integer":
            return "number";
          case "boolean":
            return "boolean";
          case "null":
            return "null";
          case "array": {
            const items = s.items ? schemaToTS(s.items, level) : "unknown";
            return `${items}[]`;
          }
          case "object": {
            if (!s.properties) {
              return "Record<string, unknown>";
            }

            const required = new Set(s.required || []);
            const lines: string[] = ["{"];

            for (const [key, propSchema] of Object.entries(s.properties)) {
              const optional = !required.has(key) ? "?" : "";
              const propType = schemaToTS(propSchema, level + 1);
              const safeName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
              lines.push(`${pad}${indent}${safeName}${optional}: ${propType};`);
            }

            lines.push(`${pad}}`);
            return lines.join("\n");
          }
          default:
            return "unknown";
        }
      };

      const typeBody = schemaToTS(jsonSchema);
      const keyword = useInterface ? "interface" : "type";
      const prefix = exportType ? "export " : "";
      const assignment = useInterface ? "" : " =";

      const result = `${prefix}${keyword} ${name}${assignment} ${typeBody}`;

      return {
        typescript: result,
        name,
        format: useInterface ? "interface" : "type",
      };
    },
  },
  {
    name: "schema_merge",
    description:
      "Merge multiple JSON Schemas into one combined schema. Combine schemas from different data samples to create a comprehensive type. Use for evolving APIs, data aggregation, or schema unification. Keywords: merge schema, combine schemas, union schema, aggregate types, schema union.",
    category: "schema",
    inputSchema: {
      type: "object",
      properties: {
        schemas: { type: "array", description: "Array of JSON Schemas to merge" },
        strategy: {
          type: "string",
          enum: ["union", "intersection"],
          description: "Merge strategy (default: union)",
        },
      },
      required: ["schemas"],
    },
    handler: ({ schemas, strategy = "union" }) => {
      const schemaList = schemas as JSONSchema[];

      if (schemaList.length === 0) return {};
      if (schemaList.length === 1) return schemaList[0];

      const mergeTwo = (a: JSONSchema, b: JSONSchema): JSONSchema => {
        // Different types
        if (a.type !== b.type) {
          const types = new Set([
            ...(Array.isArray(a.type) ? a.type : [a.type]),
            ...(Array.isArray(b.type) ? b.type : [b.type]),
          ].filter((t): t is string => typeof t === "string"));
          return { type: types.size === 1 ? [...types][0] : [...types] };
        }

        // Same type
        if (a.type === "object" && b.type === "object") {
          const allKeys = new Set([
            ...Object.keys(a.properties || {}),
            ...Object.keys(b.properties || {}),
          ]);

          const properties: Record<string, JSONSchema> = {};
          const required: string[] = [];

          for (const key of allKeys) {
            const propA = a.properties?.[key];
            const propB = b.properties?.[key];

            if (propA && propB) {
              properties[key] = mergeTwo(propA, propB);
              if (strategy === "intersection") {
                if (a.required?.includes(key) && b.required?.includes(key)) {
                  required.push(key);
                }
              } else {
                if (a.required?.includes(key) || b.required?.includes(key)) {
                  required.push(key);
                }
              }
            } else if (strategy === "union") {
              properties[key] = propA || propB!;
              // Not required if missing from one schema
            } else {
              // Intersection - only include if in both
              if (propA && propB) {
                properties[key] = mergeTwo(propA, propB);
              }
            }
          }

          return {
            type: "object",
            properties,
            ...(required.length > 0 ? { required } : {}),
          };
        }

        if (a.type === "array" && b.type === "array") {
          return {
            type: "array",
            items: a.items && b.items ? mergeTwo(a.items, b.items) : a.items || b.items,
          };
        }

        // Same primitive type
        return a;
      };

      const merged = schemaList.reduce((acc, s) => mergeTwo(acc, s));

      return {
        ...merged,
        $schema: "http://json-schema.org/draft-07/schema#",
      };
    },
  },
  {
    name: "schema_diff",
    description:
      "Compare two JSON Schemas and show differences. Identify added, removed, or changed properties and types. Use for schema versioning, API evolution, or migration planning. Keywords: schema diff, compare schemas, schema changes, type diff, API changes, version diff.",
    category: "schema",
    inputSchema: {
      type: "object",
      properties: {
        schema1: { description: "First schema (old/base)" },
        schema2: { description: "Second schema (new/updated)" },
      },
      required: ["schema1", "schema2"],
    },
    handler: ({ schema1, schema2 }) => {
      const s1 = schema1 as JSONSchema;
      const s2 = schema2 as JSONSchema;

      type Diff = {
        path: string;
        type: "added" | "removed" | "changed" | "type_changed";
        oldValue?: unknown;
        newValue?: unknown;
      };

      const diffs: Diff[] = [];

      const compare = (a: JSONSchema | undefined, b: JSONSchema | undefined, path: string) => {
        if (!a && b) {
          diffs.push({ path, type: "added", newValue: b });
          return;
        }
        if (a && !b) {
          diffs.push({ path, type: "removed", oldValue: a });
          return;
        }
        if (!a || !b) return;

        // Compare types
        if (a.type !== b.type) {
          diffs.push({
            path: `${path}.type`,
            type: "type_changed",
            oldValue: a.type,
            newValue: b.type,
          });
        }

        // Compare required
        const reqA = new Set(a.required || []);
        const reqB = new Set(b.required || []);
        for (const r of reqA) {
          if (!reqB.has(r)) {
            diffs.push({ path: `${path}.required`, type: "removed", oldValue: r });
          }
        }
        for (const r of reqB) {
          if (!reqA.has(r)) {
            diffs.push({ path: `${path}.required`, type: "added", newValue: r });
          }
        }

        // Compare properties
        if (a.properties || b.properties) {
          const allKeys = new Set([
            ...Object.keys(a.properties || {}),
            ...Object.keys(b.properties || {}),
          ]);

          for (const key of allKeys) {
            compare(
              a.properties?.[key],
              b.properties?.[key],
              `${path}.properties.${key}`,
            );
          }
        }

        // Compare items
        if (a.items || b.items) {
          compare(a.items, b.items, `${path}.items`);
        }

        // Compare format
        if (a.format !== b.format) {
          diffs.push({
            path: `${path}.format`,
            type: "changed",
            oldValue: a.format,
            newValue: b.format,
          });
        }
      };

      compare(s1, s2, "");

      return {
        identical: diffs.length === 0,
        diffCount: diffs.length,
        diffs,
        summary: {
          added: diffs.filter((d) => d.type === "added").length,
          removed: diffs.filter((d) => d.type === "removed").length,
          changed: diffs.filter((d) => d.type === "changed" || d.type === "type_changed").length,
        },
      };
    },
  },
  {
    name: "schema_analyze",
    description:
      "Analyze JSON data structure and provide statistics. Get depth, property counts, type distribution, and complexity metrics. Use for data exploration, documentation, or optimization. Keywords: analyze data, data stats, structure analysis, type distribution, complexity, data profiling.",
    category: "schema",
    inputSchema: {
      type: "object",
      properties: {
        data: { description: "Data to analyze" },
      },
      required: ["data"],
    },
    handler: ({ data }) => {
      let maxDepth = 0;
      let totalProperties = 0;
      let totalArrayItems = 0;
      let totalValues = 0;
      const typeCounts: Record<string, number> = {};
      const formats: Record<string, number> = {};

      const analyze = (value: unknown, depth: number = 0) => {
        maxDepth = Math.max(maxDepth, depth);
        totalValues++;

        const type = inferType(value);
        typeCounts[type] = (typeCounts[type] || 0) + 1;

        if (type === "string") {
          const format = detectFormat(value as string);
          if (format) {
            formats[format] = (formats[format] || 0) + 1;
          }
        }

        if (type === "array") {
          const arr = value as unknown[];
          totalArrayItems += arr.length;
          arr.forEach((item) => analyze(item, depth + 1));
        }

        if (type === "object") {
          const obj = value as Record<string, unknown>;
          const keys = Object.keys(obj);
          totalProperties += keys.length;
          keys.forEach((key) => analyze(obj[key], depth + 1));
        }
      };

      analyze(data);

      // Calculate complexity score (0-100)
      const complexity = Math.min(
        100,
        Math.round(
          (maxDepth * 10) +
            (totalProperties * 2) +
            (Object.keys(typeCounts).length * 5) +
            (totalArrayItems > 10 ? 10 : totalArrayItems),
        ),
      );

      return {
        maxDepth,
        totalValues,
        totalProperties,
        totalArrayItems,
        typeDistribution: typeCounts,
        detectedFormats: Object.keys(formats).length > 0 ? formats : null,
        complexity,
        complexityLevel: complexity < 20
          ? "simple"
          : complexity < 50
          ? "moderate"
          : complexity < 80
          ? "complex"
          : "very complex",
      };
    },
  },
  {
    name: "schema_sample",
    description:
      "Generate sample data from JSON Schema. Create example values that conform to schema definition. Use for API mocking, test data, or documentation examples. Keywords: sample data, mock data, schema example, generate sample, test data, fixture.",
    category: "schema",
    inputSchema: {
      type: "object",
      properties: {
        schema: { description: "JSON Schema to generate sample from" },
        seed: { type: "number", description: "Random seed for reproducibility" },
      },
      required: ["schema"],
    },
    handler: ({ schema, seed }) => {
      let rng = seed ? (seed as number) : Date.now();
      const random = () => {
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        return rng / 0x7fffffff;
      };

      const generate = (s: JSONSchema): unknown => {
        if (s.const !== undefined) return s.const;
        if (s.enum) return s.enum[Math.floor(random() * s.enum.length)];
        if ("default" in s && s.default !== undefined) return s.default;

        if (s.anyOf) return generate(s.anyOf[Math.floor(random() * s.anyOf.length)]);
        if (s.oneOf) return generate(s.oneOf[Math.floor(random() * s.oneOf.length)]);

        const type = Array.isArray(s.type) ? s.type[0] : s.type;

        switch (type) {
          case "string": {
            if (s.format === "email") return "user@example.com";
            if (s.format === "uri") return "https://example.com";
            if (s.format === "uuid") return "550e8400-e29b-41d4-a716-446655440000";
            if (s.format === "date-time") return new Date().toISOString();
            if (s.format === "date") return new Date().toISOString().split("T")[0];
            if (s.pattern) return `pattern-match-${Math.floor(random() * 1000)}`;

            const minLen = s.minLength || 1;
            const maxLen = s.maxLength || 20;
            const len = minLen + Math.floor(random() * (maxLen - minLen));
            return "sample".repeat(Math.ceil(len / 6)).slice(0, len);
          }

          case "number":
          case "integer": {
            const min = s.minimum ?? 0;
            const max = s.maximum ?? 100;
            const value = min + random() * (max - min);
            return type === "integer" ? Math.floor(value) : Math.round(value * 100) / 100;
          }

          case "boolean":
            return random() > 0.5;

          case "null":
            return null;

          case "array": {
            const count = 2;
            if (!s.items) return [];
            return Array(count).fill(null).map(() => generate(s.items!));
          }

          case "object": {
            const result: Record<string, unknown> = {};
            if (s.properties) {
              const required = new Set(s.required || []);
              for (const [key, propSchema] of Object.entries(s.properties)) {
                if (required.has(key) || random() > 0.3) {
                  result[key] = generate(propSchema);
                }
              }
            }
            return result;
          }

          default:
            return null;
        }
      };

      return {
        sample: generate(schema as JSONSchema),
        seed: seed || rng,
      };
    },
  },
];
