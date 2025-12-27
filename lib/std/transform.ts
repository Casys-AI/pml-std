/**
 * Data transformation tools
 *
 * Uses papaparse for CSV operations.
 *
 * @module lib/std/transform
 */

import Papa from "papaparse";
import type { MiniTool } from "./types.ts";

export const transformTools: MiniTool[] = [
  {
    name: "transform_csv_parse",
    description:
      "Parse CSV string into array of objects with automatic type conversion. Supports custom delimiters, header detection, and empty line handling. Use for importing spreadsheet data, processing exports, or data ingestion. Keywords: parse CSV, CSV to JSON, read CSV, import spreadsheet, CSV parser, comma separated.",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        csv: { type: "string", description: "CSV string to parse" },
        header: { type: "boolean", description: "First row is header (default: true)" },
        delimiter: { type: "string", description: "Field delimiter (default: ',')" },
        skipEmptyLines: { type: "boolean", description: "Skip empty lines (default: true)" },
        dynamicTyping: { type: "boolean", description: "Convert numbers/booleans (default: true)" },
      },
      required: ["csv"],
    },
    handler: (
      { csv, header = true, delimiter = ",", skipEmptyLines = true, dynamicTyping = true },
    ) => {
      const result = Papa.parse(csv as string, {
        header: header as boolean,
        delimiter: delimiter as string,
        skipEmptyLines: skipEmptyLines as boolean,
        dynamicTyping: dynamicTyping as boolean,
      });

      return {
        data: result.data,
        meta: result.meta,
        errors: result.errors.length > 0 ? result.errors : undefined,
      };
    },
  },
  {
    name: "transform_csv_stringify",
    description:
      "Convert array of objects to CSV string with configurable options. Control headers, delimiters, column selection, and quoting. Use for data export, report generation, or spreadsheet creation. Keywords: to CSV, export CSV, array to CSV, generate CSV, create spreadsheet, CSV writer.",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "array", description: "Array of objects to convert" },
        header: { type: "boolean", description: "Include header row (default: true)" },
        delimiter: { type: "string", description: "Field delimiter (default: ',')" },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "Columns to include (default: all)",
        },
        quotes: { type: "boolean", description: "Quote all fields (default: false)" },
      },
      required: ["data"],
    },
    handler: ({ data, header = true, delimiter = ",", columns, quotes = false }) => {
      const result = Papa.unparse(data as unknown[], {
        header: header as boolean,
        delimiter: delimiter as string,
        columns: columns as string[] | undefined,
        quotes: quotes as boolean,
      });
      return result;
    },
  },
  {
    name: "transform_json_to_csv",
    description:
      "Convert JSON array to CSV with optional nested object flattening. Transforms complex JSON data into flat CSV format. Use for exporting API data, generating reports, or data interchange. Keywords: JSON to CSV, export JSON, flatten to CSV, convert JSON, data export, JSON CSV.",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        json: { description: "JSON array or string" },
        flatten: { type: "boolean", description: "Flatten nested objects (default: true)" },
        delimiter: { type: "string", description: "CSV delimiter" },
      },
      required: ["json"],
    },
    handler: ({ json, flatten = true, delimiter = "," }) => {
      let data = typeof json === "string" ? JSON.parse(json as string) : json;

      if (flatten) {
        const flattenObject = (
          obj: Record<string, unknown>,
          prefix = "",
        ): Record<string, unknown> => {
          const result: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(obj)) {
            const newKey = prefix ? `${prefix}.${key}` : key;
            if (value && typeof value === "object" && !Array.isArray(value)) {
              Object.assign(result, flattenObject(value as Record<string, unknown>, newKey));
            } else {
              result[newKey] = Array.isArray(value) ? JSON.stringify(value) : value;
            }
          }
          return result;
        };

        data = (data as unknown[]).map((item) =>
          typeof item === "object" && item !== null
            ? flattenObject(item as Record<string, unknown>)
            : item
        );
      }

      return Papa.unparse(data as unknown[], { delimiter: delimiter as string });
    },
  },
  {
    name: "transform_csv_to_json",
    description:
      "Convert CSV to JSON array with automatic type detection (numbers, booleans). Parse spreadsheet data into structured objects. Use for data import, processing CSV files, or ETL pipelines. Keywords: CSV to JSON, parse CSV, import CSV, CSV parser, spreadsheet to JSON, data import.",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        csv: { type: "string", description: "CSV string" },
        header: { type: "boolean", description: "First row is header (default: true)" },
      },
      required: ["csv"],
    },
    handler: ({ csv, header = true }) => {
      const result = Papa.parse(csv as string, {
        header: header as boolean,
        dynamicTyping: true,
        skipEmptyLines: true,
      });
      return result.data;
    },
  },
  {
    name: "transform_xml_to_json",
    description:
      "Convert XML to JSON object structure. Parse XML elements, attributes, and text content into nested objects. Handles basic XML structures for data extraction. Use for API integration, config parsing, or legacy data. Keywords: XML to JSON, parse XML, XML parser, convert XML, read XML, XML object.",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        xml: { type: "string", description: "XML string to convert" },
      },
      required: ["xml"],
    },
    handler: ({ xml }) => {
      // Simple XML parser for basic cases
      const parseNode = (xmlStr: string): unknown => {
        const tagMatch = xmlStr.match(/^<(\w+)([^>]*)>([\s\S]*)<\/\1>$/);
        if (!tagMatch) {
          return xmlStr.trim();
        }

        const [, tagName, attrs, content] = tagMatch;
        const result: Record<string, unknown> = {};

        // Parse attributes
        const attrRegex = /(\w+)="([^"]*)"/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attrs)) !== null) {
          result[`@${attrMatch[1]}`] = attrMatch[2];
        }

        // Parse children
        const childRegex = /<(\w+)[^>]*>[\s\S]*?<\/\1>|<(\w+)[^/]*\/>/g;
        const children: string[] = [];
        let childMatch;
        while ((childMatch = childRegex.exec(content)) !== null) {
          children.push(childMatch[0]);
        }

        if (children.length === 0) {
          result["#text"] = content.trim();
        } else {
          for (const child of children) {
            const childTagMatch = child.match(/^<(\w+)/);
            if (childTagMatch) {
              const childTag = childTagMatch[1];
              const parsed = parseNode(child);
              if (result[childTag]) {
                if (!Array.isArray(result[childTag])) {
                  result[childTag] = [result[childTag]];
                }
                (result[childTag] as unknown[]).push(parsed);
              } else {
                result[childTag] = parsed;
              }
            }
          }
        }

        return { [tagName]: result };
      };

      try {
        return parseNode(xml as string);
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  },
  {
    name: "transform_json_to_xml",
    description:
      "Convert JSON object to XML string with proper formatting. Handles nested objects, arrays, and attributes (@-prefixed keys). Configurable root element and indentation. Use for API output, config generation, or data export. Keywords: JSON to XML, generate XML, create XML, convert to XML, XML output, build XML.",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        json: { description: "JSON object or string" },
        rootName: { type: "string", description: "Root element name (default: 'root')" },
        indent: { type: "number", description: "Indentation spaces (default: 2)" },
      },
      required: ["json"],
    },
    handler: ({ json, rootName = "root", indent = 2 }) => {
      const data = typeof json === "string" ? JSON.parse(json as string) : json;
      const spaces = " ".repeat(indent as number);

      const toXml = (obj: unknown, name: string, level: number): string => {
        const prefix = spaces.repeat(level);

        if (obj === null || obj === undefined) {
          return `${prefix}<${name}/>\n`;
        }

        if (Array.isArray(obj)) {
          return obj.map((item) => toXml(item, name, level)).join("");
        }

        if (typeof obj === "object") {
          const attrs: string[] = [];
          const children: string[] = [];

          for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
            if (key.startsWith("@")) {
              attrs.push(`${key.slice(1)}="${value}"`);
            } else if (key === "#text") {
              children.push(String(value));
            } else {
              children.push(toXml(value, key, level + 1));
            }
          }

          const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";

          if (children.length === 0) {
            return `${prefix}<${name}${attrStr}/>\n`;
          }

          const hasOnlyText = children.length === 1 && !children[0].includes("<");
          if (hasOnlyText) {
            return `${prefix}<${name}${attrStr}>${children[0]}</${name}>\n`;
          }

          return `${prefix}<${name}${attrStr}>\n${children.join("")}${prefix}</${name}>\n`;
        }

        return `${prefix}<${name}>${obj}</${name}>\n`;
      };

      return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(data, rootName as string, 0)}`;
    },
  },
  {
    name: "transform_base64",
    description:
      "Encode or decode base64 strings. Convert binary data or text to base64 for transmission, or decode base64 back to original. Use for data URI creation, API payloads, or embedded content. Keywords: base64 encode, base64 decode, btoa atob, binary to text, encode string, data URI.",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "Data to encode/decode" },
        action: { type: "string", enum: ["encode", "decode"], description: "Action" },
      },
      required: ["data", "action"],
    },
    handler: ({ data, action }) => {
      if (action === "encode") {
        return btoa(data as string);
      }
      return atob(data as string);
    },
  },
  {
    name: "transform_template",
    description:
      "Simple template string replacement using {{placeholder}} syntax. Replace placeholders with values from a data object. Use for email templates, dynamic content, or string interpolation. Keywords: template replace, string interpolation, placeholder, mustache, variable substitution, template engine.",
    category: "transform",
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string", description: "Template with {{placeholders}}" },
        data: { type: "object", description: "Data object for replacements" },
      },
      required: ["template", "data"],
    },
    handler: ({ template, data }) => {
      let result = template as string;
      const d = data as Record<string, unknown>;
      for (const [key, value] of Object.entries(d)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
      }
      return result;
    },
  },
];
