/**
 * State/KV store tools
 *
 * In-memory key-value store for agent state management.
 *
 * @module lib/std/state
 */

import type { MiniTool } from "./types.ts";

// In-memory state storage
const stateStorage = new Map<string, {
  value: unknown;
  createdAt: Date;
  updatedAt: Date;
  ttl?: number;
  expiresAt?: Date;
}>();

// Cleanup expired entries periodically
setInterval(() => {
  const now = new Date();
  for (const [key, entry] of stateStorage.entries()) {
    if (entry.expiresAt && entry.expiresAt < now) {
      stateStorage.delete(key);
    }
  }
}, 60000); // Every minute

export const stateTools: MiniTool[] = [
  {
    name: "state_set",
    description: "Set a value in the state store",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to set" },
        value: { description: "Value to store" },
        ttl: { type: "number", description: "Time-to-live in seconds (optional)" },
      },
      required: ["key", "value"],
    },
    handler: ({ key, value, ttl }) => {
      const now = new Date();
      const entry = {
        value,
        createdAt: stateStorage.get(key as string)?.createdAt || now,
        updatedAt: now,
        ttl: ttl as number | undefined,
        expiresAt: ttl ? new Date(now.getTime() + (ttl as number) * 1000) : undefined,
      };
      stateStorage.set(key as string, entry);
      return { success: true, key, expiresAt: entry.expiresAt?.toISOString() };
    },
  },
  {
    name: "state_get",
    description: "Get a value from the state store",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to get" },
        default: { description: "Default value if key not found" },
      },
      required: ["key"],
    },
    handler: ({ key, default: defaultValue }) => {
      const entry = stateStorage.get(key as string);

      // Check if expired
      if (entry?.expiresAt && entry.expiresAt < new Date()) {
        stateStorage.delete(key as string);
        return { value: defaultValue, found: false, expired: true };
      }

      if (!entry) {
        return { value: defaultValue, found: false };
      }

      return {
        value: entry.value,
        found: true,
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
        expiresAt: entry.expiresAt?.toISOString(),
      };
    },
  },
  {
    name: "state_delete",
    description: "Delete a key from the state store",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to delete" },
      },
      required: ["key"],
    },
    handler: ({ key }) => {
      const existed = stateStorage.delete(key as string);
      return { success: existed, deleted: key };
    },
  },
  {
    name: "state_has",
    description: "Check if a key exists in the state store",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to check" },
      },
      required: ["key"],
    },
    handler: ({ key }) => {
      const entry = stateStorage.get(key as string);
      if (entry?.expiresAt && entry.expiresAt < new Date()) {
        stateStorage.delete(key as string);
        return { exists: false, expired: true };
      }
      return { exists: stateStorage.has(key as string) };
    },
  },
  {
    name: "state_keys",
    description: "List all keys in the state store",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to filter keys" },
      },
    },
    handler: ({ pattern }) => {
      const now = new Date();
      let keys: string[] = [];

      for (const [key, entry] of stateStorage.entries()) {
        if (entry.expiresAt && entry.expiresAt < now) {
          stateStorage.delete(key);
          continue;
        }
        keys.push(key);
      }

      if (pattern) {
        const regex = new RegExp(
          "^" + (pattern as string).replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") +
            "$",
        );
        keys = keys.filter((k) => regex.test(k));
      }

      return keys;
    },
  },
  {
    name: "state_clear",
    description: "Clear all or matching keys from the state store",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match (clears all if omitted)" },
      },
    },
    handler: ({ pattern }) => {
      if (!pattern) {
        const count = stateStorage.size;
        stateStorage.clear();
        return { cleared: count };
      }

      const regex = new RegExp(
        "^" + (pattern as string).replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") +
          "$",
      );
      let count = 0;
      for (const key of stateStorage.keys()) {
        if (regex.test(key)) {
          stateStorage.delete(key);
          count++;
        }
      }
      return { cleared: count, pattern };
    },
  },
  {
    name: "state_increment",
    description: "Increment a numeric value (creates if not exists)",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to increment" },
        amount: { type: "number", description: "Amount to add (default: 1)" },
      },
      required: ["key"],
    },
    handler: ({ key, amount = 1 }) => {
      const k = key as string;
      const entry = stateStorage.get(k);
      const currentValue = typeof entry?.value === "number" ? entry.value : 0;
      const newValue = currentValue + (amount as number);

      const now = new Date();
      stateStorage.set(k, {
        value: newValue,
        createdAt: entry?.createdAt || now,
        updatedAt: now,
      });

      return { value: newValue, previous: currentValue };
    },
  },
  {
    name: "state_append",
    description: "Append to an array value (creates if not exists)",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key of array" },
        value: { description: "Value to append" },
        maxLength: { type: "number", description: "Max array length (removes oldest)" },
      },
      required: ["key", "value"],
    },
    handler: ({ key, value, maxLength }) => {
      const k = key as string;
      const maxLen = maxLength as number | undefined;
      const entry = stateStorage.get(k);
      const currentArray = Array.isArray(entry?.value) ? entry.value : [];
      currentArray.push(value);

      if (maxLen && currentArray.length > maxLen) {
        currentArray.splice(0, currentArray.length - maxLen);
      }

      const now = new Date();
      stateStorage.set(k, {
        value: currentArray,
        createdAt: entry?.createdAt || now,
        updatedAt: now,
      });

      return { length: currentArray.length };
    },
  },
  {
    name: "state_merge",
    description: "Merge object into existing value",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to merge into" },
        value: { type: "object", description: "Object to merge" },
        deep: { type: "boolean", description: "Deep merge (default: false)" },
      },
      required: ["key", "value"],
    },
    handler: ({ key, value, deep = false }) => {
      const k = key as string;
      const entry = stateStorage.get(k);
      const current = (typeof entry?.value === "object" && entry.value !== null) ? entry.value : {};

      const deepMerge = (
        target: Record<string, unknown>,
        source: Record<string, unknown>,
      ): Record<string, unknown> => {
        const result = { ...target };
        for (const [key, val] of Object.entries(source)) {
          if (
            deep && val && typeof val === "object" && !Array.isArray(val) &&
            result[key] && typeof result[key] === "object" && !Array.isArray(result[key])
          ) {
            result[key] = deepMerge(
              result[key] as Record<string, unknown>,
              val as Record<string, unknown>,
            );
          } else {
            result[key] = val;
          }
        }
        return result;
      };

      const merged = deepMerge(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      );
      const now = new Date();
      stateStorage.set(k, {
        value: merged,
        createdAt: entry?.createdAt || now,
        updatedAt: now,
      });

      return { value: merged };
    },
  },
  {
    name: "state_stats",
    description: "Get state store statistics",
    category: "state",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: () => {
      const now = new Date();
      let totalSize = 0;
      let expiredCount = 0;
      let withTTL = 0;

      for (const [key, entry] of stateStorage.entries()) {
        if (entry.expiresAt && entry.expiresAt < now) {
          expiredCount++;
          stateStorage.delete(key);
          continue;
        }
        if (entry.ttl) withTTL++;
        totalSize += JSON.stringify(entry.value).length;
      }

      return {
        count: stateStorage.size,
        withTTL,
        expiredAndCleaned: expiredCount,
        approximateSizeBytes: totalSize,
      };
    },
  },
];
