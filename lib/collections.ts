/**
 * Collection/array manipulation tools
 *
 * Uses lodash-es for robust implementations.
 *
 * @module lib/std/collections
 */

import {
  chunk,
  compact,
  countBy,
  difference,
  drop,
  dropRight,
  filter,
  flatten,
  flattenDeep,
  groupBy,
  intersection,
  keyBy,
  map,
  orderBy,
  partition,
  sample,
  sampleSize,
  shuffle,
  sortBy,
  take,
  takeRight,
  union,
  uniq,
  uniqBy,
  zip,
  zipObject,
} from "lodash-es";
import type { MiniTool } from "./types.ts";

export const collectionsTools: MiniTool[] = [
  {
    name: "array_map",
    description:
      "Transform array by extracting a property from each object. Pluck values using dot notation paths (e.g., 'user.name'). Use to extract specific fields from array of objects. Keywords: array map, pluck property, extract field, lodash map.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to transform" },
        path: {
          type: "string",
          description: "Property path to extract (e.g., 'name', 'user.email')",
        },
      },
      required: ["items", "path"],
    },
    handler: ({ items, path }) => map(items as unknown[], path as string),
  },
  {
    name: "array_filter",
    description:
      "Filter array elements that match specific property values. Select objects where properties equal given values (e.g., {active: true}). Use for querying and filtering datasets. Keywords: array filter, find matching, select where, filter by property.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to filter" },
        predicate: {
          type: "object",
          description: "Object with properties to match (e.g., { active: true })",
        },
      },
      required: ["items", "predicate"],
    },
    handler: ({ items, predicate }) => filter(items as unknown[], predicate as object),
  },
  {
    name: "array_sort",
    description:
      "Sort array by one or more property keys with ascending/descending order. Multi-key sorting for complex ordering needs. Use for ordering data by multiple criteria. Keywords: array sort, order by, sort by key, ascending descending, multi-key sort.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to sort" },
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Keys to sort by (e.g., ['name', 'age'])",
        },
        orders: {
          type: "array",
          items: { type: "string", enum: ["asc", "desc"] },
          description: "Sort orders for each key",
        },
      },
      required: ["items"],
    },
    handler: ({ items, keys, orders }) => {
      if (!keys) return sortBy(items as unknown[]);
      return orderBy(
        items as unknown[],
        keys as string[],
        (orders as ("asc" | "desc")[]) || [],
      );
    },
  },
  {
    name: "array_unique",
    description:
      "Remove duplicate values from array. For objects, can dedupe by specific key. Use for data cleaning, eliminating redundant entries. Keywords: array unique, dedupe, remove duplicates, distinct values, uniq by.",
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
      if (!key) return uniq(items as unknown[]);
      return uniqBy(items as unknown[], key as string);
    },
  },
  {
    name: "array_group",
    description:
      "Group array elements into object by property value. Create buckets based on a key (e.g., group users by role). Use for categorization, aggregation prep, or data organization. Keywords: group by, categorize, bucket by key, aggregate grouping.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to group" },
        key: { type: "string", description: "Key to group by" },
      },
      required: ["items", "key"],
    },
    handler: ({ items, key }) => groupBy(items as unknown[], key as string),
  },
  {
    name: "array_flatten",
    description:
      "Flatten nested arrays into single-level array. Option for shallow (one level) or deep (recursive) flattening. Use to simplify nested structures or merge array of arrays. Keywords: flatten array, unnest, deep flatten, merge nested arrays.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Nested array to flatten" },
        deep: { type: "boolean", description: "Flatten recursively (default: false)" },
      },
      required: ["items"],
    },
    handler: ({ items, deep = false }) =>
      deep ? flattenDeep(items as unknown[]) : flatten(items as unknown[]),
  },
  {
    name: "array_chunk",
    description:
      "Split array into smaller arrays of specified size. Use for pagination, batch processing, or breaking large datasets into manageable pieces. Keywords: chunk array, split into batches, paginate, batch array, partition size.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to chunk" },
        size: { type: "number", description: "Chunk size" },
      },
      required: ["items", "size"],
    },
    handler: ({ items, size }) => chunk(items as unknown[], size as number),
  },
  {
    name: "array_compact",
    description:
      "Remove all falsy values from array (null, undefined, 0, '', false, NaN). Clean up arrays with empty or invalid entries. Use for data sanitization. Keywords: compact array, remove falsy, clean nulls, filter empty, remove undefined.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to compact" },
      },
      required: ["items"],
    },
    handler: ({ items }) => compact(items as unknown[]),
  },
  {
    name: "array_difference",
    description:
      "Get values present in first array but not in second. Find what's missing or removed between two sets. Use for change detection, finding deletions. Keywords: array difference, set subtract, find missing, exclude values, not in array.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Primary array" },
        exclude: { type: "array", description: "Values to exclude" },
      },
      required: ["items", "exclude"],
    },
    handler: ({ items, exclude }) => difference(items as unknown[], exclude as unknown[]),
  },
  {
    name: "array_intersection",
    description:
      "Find values that exist in ALL given arrays. Get common elements across multiple sets. Use for finding shared items, overlap detection. Keywords: array intersection, common elements, shared values, find overlap, set intersection.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        arrays: { type: "array", items: { type: "array" }, description: "Arrays to intersect" },
      },
      required: ["arrays"],
    },
    handler: ({ arrays }) => {
      const arrs = arrays as unknown[][];
      return arrs.reduce((acc, arr) => intersection(acc, arr), arrs[0] || []);
    },
  },
  {
    name: "array_union",
    description:
      "Merge multiple arrays into one with duplicates removed. Combine sets keeping unique values only. Use for merging datasets without redundancy. Keywords: array union, merge unique, combine arrays, set union, dedupe merge.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        arrays: { type: "array", items: { type: "array" }, description: "Arrays to combine" },
      },
      required: ["arrays"],
    },
    handler: ({ arrays }) => {
      const arrs = arrays as unknown[][];
      return arrs.reduce((acc, arr) => union(acc, arr), []);
    },
  },
  {
    name: "array_keyby",
    description:
      "Convert array of objects to object keyed by a property. Transform list to lookup dictionary (e.g., users by ID). Use for fast lookups, indexing data. Keywords: key by, index by, array to object, create dictionary, lookup table.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array of objects" },
        key: { type: "string", description: "Property to use as key" },
      },
      required: ["items", "key"],
    },
    handler: ({ items, key }) => keyBy(items as unknown[], key as string),
  },
  {
    name: "array_partition",
    description:
      "Split array into two groups: elements matching predicate and those that don't. Separate data into truthy/falsy buckets. Use for binary categorization. Keywords: partition array, split by condition, separate groups, filter both, binary split.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to partition" },
        predicate: { type: "object", description: "Properties to match for truthy group" },
      },
      required: ["items", "predicate"],
    },
    handler: ({ items, predicate }) => {
      const [truthy, falsy] = partition(items as unknown[], predicate as object);
      return { truthy, falsy };
    },
  },
  {
    name: "array_shuffle",
    description:
      "Randomly reorder array elements using Fisher-Yates shuffle. Create random permutation of items. Use for randomizing lists, card games, random selection order. Keywords: shuffle array, randomize order, random permutation, mix up array.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to shuffle" },
      },
      required: ["items"],
    },
    handler: ({ items }) => shuffle(items as unknown[]),
  },
  {
    name: "array_sample",
    description:
      "Get one or more random elements from array without replacement. Sample random items for testing, previews, or randomization. Keywords: random sample, pick random, random element, sample from array, random selection.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to sample from" },
        count: { type: "number", description: "Number of samples (default: 1)" },
      },
      required: ["items"],
    },
    handler: ({ items, count = 1 }) => {
      if (count === 1) return sample(items as unknown[]);
      return sampleSize(items as unknown[], count as number);
    },
  },
  {
    name: "array_take",
    description:
      "Get first N or last N elements from array. Slice beginning or end of array. Use for pagination, previews, or limiting results. Keywords: take first, take last, head tail, array slice, limit results, top N.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array" },
        count: { type: "number", description: "Number of elements" },
        from: { type: "string", enum: ["start", "end"], description: "Where to take from" },
      },
      required: ["items", "count"],
    },
    handler: ({ items, count, from = "start" }) =>
      from === "end"
        ? takeRight(items as unknown[], count as number)
        : take(items as unknown[], count as number),
  },
  {
    name: "array_drop",
    description:
      "Remove first N or last N elements from array. Skip elements from beginning or end. Use for pagination offsets, removing headers/footers. Keywords: drop first, drop last, skip elements, remove from start, offset array.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array" },
        count: { type: "number", description: "Number of elements to drop" },
        from: { type: "string", enum: ["start", "end"], description: "Where to drop from" },
      },
      required: ["items", "count"],
    },
    handler: ({ items, count, from = "start" }) =>
      from === "end"
        ? dropRight(items as unknown[], count as number)
        : drop(items as unknown[], count as number),
  },
  {
    name: "array_zip",
    description:
      "Combine multiple arrays element-wise into array of tuples. Pair up corresponding elements from parallel arrays. Use for combining related data streams. Keywords: zip arrays, pair elements, combine parallel, interleave arrays, tuple array.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        arrays: { type: "array", items: { type: "array" }, description: "Arrays to zip" },
      },
      required: ["arrays"],
    },
    handler: ({ arrays }) => zip(...(arrays as unknown[][])),
  },
  {
    name: "array_zip_object",
    description:
      "Create object from separate arrays of keys and values. Pair up keys array with values array into single object. Use for constructing objects from CSV headers/rows. Keywords: zip object, keys values to object, create from arrays, combine key value.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string" }, description: "Array of keys" },
        values: { type: "array", description: "Array of values" },
      },
      required: ["keys", "values"],
    },
    handler: ({ keys, values }) => zipObject(keys as string[], values as unknown[]),
  },
  {
    name: "array_count_by",
    description:
      "Count occurrences of each unique value for a property. Group and count elements by key. Use for frequency analysis, histograms, or distribution stats. Keywords: count by, frequency count, group count, histogram, occurrence count.",
    category: "collections",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", description: "Array to count" },
        key: { type: "string", description: "Property to count by" },
      },
      required: ["items", "key"],
    },
    handler: ({ items, key }) => countBy(items as unknown[], key as string),
  },
];
