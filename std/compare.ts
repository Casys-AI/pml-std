/**
 * Comparison and diff tools
 *
 * Uses diff for text and jsondiffpatch for JSON comparisons.
 *
 * @module lib/std/compare
 */

import * as Diff from "diff";
import { create, type Delta } from "jsondiffpatch";
import type { MiniTool } from "./types.ts";

const jsonDiffer = create({
  arrays: {
    detectMove: true,
  },
});

export const compareTools: MiniTool[] = [
  {
    name: "diff_text",
    description: "Compare two text strings and show differences",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        oldText: { type: "string", description: "Original text" },
        newText: { type: "string", description: "New text" },
        format: {
          type: "string",
          enum: ["unified", "patch", "chars", "words", "lines", "sentences"],
          description: "Diff format (default: unified)",
        },
        context: { type: "number", description: "Context lines for unified/patch (default: 3)" },
      },
      required: ["oldText", "newText"],
    },
    handler: ({ oldText, newText, format = "unified", context = 3 }) => {
      const old = oldText as string;
      const newStr = newText as string;
      const ctx = context as number;

      switch (format) {
        case "chars":
          return Diff.diffChars(old, newStr);
        case "words":
          return Diff.diffWords(old, newStr);
        case "lines":
          return Diff.diffLines(old, newStr);
        case "sentences":
          return Diff.diffSentences(old, newStr);
        case "patch":
          return Diff.createPatch("file", old, newStr, "old", "new", { context: ctx });
        default: // unified
          return Diff.createTwoFilesPatch("old", "new", old, newStr, "", "", { context: ctx });
      }
    },
  },
  {
    name: "diff_json",
    description: "Compare two JSON objects and show structural differences",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        oldJson: { description: "Original JSON (object or string)" },
        newJson: { description: "New JSON (object or string)" },
      },
      required: ["oldJson", "newJson"],
    },
    handler: ({ oldJson, newJson }) => {
      const old = typeof oldJson === "string" ? JSON.parse(oldJson as string) : oldJson;
      const newObj = typeof newJson === "string" ? JSON.parse(newJson as string) : newJson;

      const delta = jsonDiffer.diff(old, newObj);

      if (!delta) {
        return { identical: true, delta: null };
      }

      return { identical: false, delta };
    },
  },
  {
    name: "diff_arrays",
    description: "Compare two arrays and find added/removed/common elements",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        oldArray: { type: "array", description: "Original array" },
        newArray: { type: "array", description: "New array" },
      },
      required: ["oldArray", "newArray"],
    },
    handler: ({ oldArray, newArray }) => {
      const old = oldArray as unknown[];
      const newArr = newArray as unknown[];

      const oldSet = new Set(old.map((x) => JSON.stringify(x)));
      const newSet = new Set(newArr.map((x) => JSON.stringify(x)));

      const added: unknown[] = [];
      const removed: unknown[] = [];
      const common: unknown[] = [];

      for (const item of old) {
        const key = JSON.stringify(item);
        if (newSet.has(key)) {
          common.push(item);
        } else {
          removed.push(item);
        }
      }

      for (const item of newArr) {
        const key = JSON.stringify(item);
        if (!oldSet.has(key)) {
          added.push(item);
        }
      }

      return { added, removed, common };
    },
  },
  {
    name: "diff_apply",
    description: "Apply a patch/delta to text or JSON",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        original: { description: "Original content (text or JSON)" },
        patch: { description: "Patch to apply" },
        type: { type: "string", enum: ["text", "json"], description: "Content type" },
      },
      required: ["original", "patch", "type"],
    },
    handler: ({ original, patch, type }) => {
      if (type === "json") {
        const obj = typeof original === "string" ? JSON.parse(original as string) : original;
        return jsonDiffer.patch(structuredClone(obj), patch as Delta);
      }

      // Text patch
      const result = Diff.applyPatch(original as string, patch as string);
      if (result === false) {
        return { error: "Failed to apply patch" };
      }
      return result;
    },
  },
  {
    name: "compare_semantic",
    description: "Compare values with semantic understanding (numbers, dates, etc.)",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        a: { description: "First value" },
        b: { description: "Second value" },
        type: {
          type: "string",
          enum: ["auto", "number", "string", "date", "version"],
          description: "Comparison type",
        },
        tolerance: { type: "number", description: "Tolerance for numeric comparison" },
      },
      required: ["a", "b"],
    },
    handler: ({ a, b, type = "auto", tolerance = 0 }) => {
      const detectType = (val: unknown): string => {
        if (typeof val === "number") return "number";
        if (typeof val === "string") {
          if (/^\d+\.\d+\.\d+/.test(val)) return "version";
          if (!isNaN(Date.parse(val))) return "date";
        }
        return "string";
      };

      const compareType = type === "auto" ? detectType(a) : type;

      switch (compareType) {
        case "number": {
          const numA = Number(a);
          const numB = Number(b);
          const diff = Math.abs(numA - numB);
          return {
            equal: diff <= (tolerance as number),
            difference: numA - numB,
            percentDiff: numB !== 0 ? ((numA - numB) / numB) * 100 : null,
          };
        }
        case "date": {
          const dateA = new Date(a as string | number);
          const dateB = new Date(b as string | number);
          const diffMs = dateA.getTime() - dateB.getTime();
          return {
            equal: diffMs === 0,
            differenceMs: diffMs,
            differenceDays: diffMs / (1000 * 60 * 60 * 24),
            aBefore: diffMs < 0,
            aAfter: diffMs > 0,
          };
        }
        case "version": {
          const parseVersion = (v: string) => v.split(".").map(Number);
          const vA = parseVersion(String(a));
          const vB = parseVersion(String(b));

          for (let i = 0; i < Math.max(vA.length, vB.length); i++) {
            const partA = vA[i] || 0;
            const partB = vB[i] || 0;
            if (partA > partB) return { comparison: 1, aIsNewer: true };
            if (partA < partB) return { comparison: -1, bIsNewer: true };
          }
          return { comparison: 0, equal: true };
        }
        default: {
          const strA = String(a);
          const strB = String(b);
          return {
            equal: strA === strB,
            caseSensitive: strA === strB,
            caseInsensitive: strA.toLowerCase() === strB.toLowerCase(),
            levenshtein: levenshteinDistance(strA, strB),
          };
        }
      }
    },
  },
  {
    name: "compare_deep_equal",
    description: "Deep equality check for objects/arrays",
    category: "compare",
    inputSchema: {
      type: "object",
      properties: {
        a: { description: "First value" },
        b: { description: "Second value" },
        strict: { type: "boolean", description: "Strict mode (type coercion off)" },
      },
      required: ["a", "b"],
    },
    handler: ({ a, b, strict = true }) => {
      const deepEqual = (x: unknown, y: unknown): boolean => {
        if (x === y) return true;

        if (!strict) {
          // deno-lint-ignore eqeqeq
          if (x == y) return true;
        }

        if (typeof x !== typeof y) return false;
        if (x === null || y === null) return x === y;
        if (typeof x !== "object") return false;

        if (Array.isArray(x) !== Array.isArray(y)) return false;

        if (Array.isArray(x) && Array.isArray(y)) {
          if (x.length !== y.length) return false;
          return x.every((val, i) => deepEqual(val, y[i]));
        }

        const keysX = Object.keys(x as object);
        const keysY = Object.keys(y as object);
        if (keysX.length !== keysY.length) return false;

        return keysX.every((key) =>
          deepEqual((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key])
        );
      };

      return { equal: deepEqual(a, b) };
    },
  },
];

// Helper function for Levenshtein distance
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
