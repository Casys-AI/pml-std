/**
 * Algorithm and data structure tools
 *
 * Uses mnemonist for advanced data structures.
 *
 * @module lib/std/algo
 */

import {
  BiMap,
  BloomFilter,
  CircularBuffer,
  DefaultMap,
  FibonacciHeap,
  Heap,
  LinkedList,
  LRUCache,
  LRUMap,
  MaxHeap,
  MinHeap,
  MultiSet,
  Queue,
  Stack,
  StaticDisjointSet,
  SuffixArray,
  Trie,
} from "mnemonist";
import type { MiniTool } from "./types.ts";

// Instances for stateful operations
const instances = new Map<string, unknown>();

export const algoTools: MiniTool[] = [
  // Priority Queue / Heap operations
  {
    name: "algo_heap_create",
    description:
      "Create a min-heap or max-heap data structure (priority queue). Efficiently get minimum/maximum element. Use for task scheduling, event processing, dijkstra's algorithm, or top-K problems. Keywords: heap, priority queue, min heap, max heap, priority scheduling.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique identifier for this heap" },
        type: { type: "string", enum: ["min", "max"], description: "Heap type" },
        items: { type: "array", description: "Initial items" },
      },
      required: ["id", "type"],
    },
    handler: ({ id, type, items }) => {
      const heap = type === "min" ? new MinHeap<unknown>() : new MaxHeap<unknown>();
      if (items) {
        for (const item of items as unknown[]) {
          heap.push(item);
        }
      }
      instances.set(id as string, heap);
      return { created: id, size: heap.size };
    },
  },
  {
    name: "algo_heap_push",
    description:
      "Add items to an existing heap/priority queue. Maintains heap property automatically. Use to insert new elements for processing in priority order. Keywords: heap push, enqueue priority, add to heap.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Heap ID" },
        items: { type: "array", description: "Items to push" },
      },
      required: ["id", "items"],
    },
    handler: ({ id, items }) => {
      const heap = instances.get(id as string) as Heap<unknown>;
      if (!heap) return { error: "Heap not found" };
      for (const item of items as unknown[]) {
        heap.push(item);
      }
      return { size: heap.size };
    },
  },
  {
    name: "algo_heap_pop",
    description:
      "Remove and return the top element (min or max) from heap. Extract highest/lowest priority item. Use to process elements in order or get next scheduled task. Keywords: heap pop, dequeue, extract min max, get priority item.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Heap ID" },
        count: { type: "number", description: "Number of items to pop (default: 1)" },
      },
      required: ["id"],
    },
    handler: ({ id, count = 1 }) => {
      const heap = instances.get(id as string) as Heap<unknown>;
      if (!heap) return { error: "Heap not found" };
      const items: unknown[] = [];
      for (let i = 0; i < (count as number) && heap.size > 0; i++) {
        items.push(heap.pop());
      }
      return { items, remaining: heap.size };
    },
  },

  // Trie operations
  {
    name: "algo_trie_create",
    description:
      "Create a trie (prefix tree) for efficient string operations. Store words for fast prefix search, autocomplete, or spell checking. O(k) lookup where k is word length. Keywords: trie, prefix tree, autocomplete, word search, dictionary structure.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique identifier" },
        words: { type: "array", items: { type: "string" }, description: "Initial words" },
      },
      required: ["id"],
    },
    handler: ({ id, words }) => {
      const trie = new Trie<string>();
      if (words) {
        for (const word of words as string[]) {
          trie.add(word);
        }
      }
      instances.set(id as string, trie);
      return { created: id, size: trie.size };
    },
  },
  {
    name: "algo_trie_add",
    description:
      "Add words to an existing trie. Build up your prefix tree with new entries. Use for growing dictionaries or adding searchable terms. Keywords: trie insert, add word, dictionary add.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Trie ID" },
        words: { type: "array", items: { type: "string" }, description: "Words to add" },
      },
      required: ["id", "words"],
    },
    handler: ({ id, words }) => {
      const trie = instances.get(id as string) as Trie<string>;
      if (!trie) return { error: "Trie not found" };
      for (const word of words as string[]) {
        trie.add(word);
      }
      return { size: trie.size };
    },
  },
  {
    name: "algo_trie_find",
    description:
      "Find all words matching a prefix in trie. Power autocomplete suggestions, search-as-you-type, or prefix matching. Returns all words starting with the given prefix. Keywords: trie search, prefix match, autocomplete, find by prefix.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Trie ID" },
        prefix: { type: "string", description: "Prefix to search" },
      },
      required: ["id", "prefix"],
    },
    handler: ({ id, prefix }) => {
      const trie = instances.get(id as string) as Trie<string>;
      if (!trie) return { error: "Trie not found" };
      return { matches: trie.find(prefix as string) };
    },
  },

  // LRU Cache operations
  {
    name: "algo_lru_create",
    description:
      "Create an LRU (Least Recently Used) cache with fixed capacity. Automatically evicts oldest unused entries when full. Essential for caching, memoization, or memory-bounded storage. Keywords: LRU cache, least recently used, cache eviction, memoization cache.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique identifier" },
        capacity: { type: "number", description: "Max items (default: 100)" },
      },
      required: ["id"],
    },
    handler: ({ id, capacity = 100 }) => {
      const lru = new LRUCache<string, unknown>(capacity as number);
      instances.set(id as string, lru);
      return { created: id, capacity };
    },
  },
  {
    name: "algo_lru_set",
    description:
      "Store a key-value pair in LRU cache. Entry becomes most recently used. May evict oldest entry if at capacity. Keywords: cache set, store in cache, LRU put.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "LRU ID" },
        key: { type: "string", description: "Key" },
        value: { description: "Value" },
      },
      required: ["id", "key", "value"],
    },
    handler: ({ id, key, value }) => {
      const lru = instances.get(id as string) as LRUCache<string, unknown>;
      if (!lru) return { error: "LRU cache not found" };
      lru.set(key as string, value);
      return { size: lru.size };
    },
  },
  {
    name: "algo_lru_get",
    description:
      "Retrieve value from LRU cache by key. Marks entry as recently used. Returns undefined if not found or evicted. Keywords: cache get, retrieve from cache, LRU lookup.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "LRU ID" },
        key: { type: "string", description: "Key" },
      },
      required: ["id", "key"],
    },
    handler: ({ id, key }) => {
      const lru = instances.get(id as string) as LRUCache<string, unknown>;
      if (!lru) return { error: "LRU cache not found" };
      const value = lru.get(key as string);
      return { value, found: value !== undefined };
    },
  },

  // Bloom Filter operations
  {
    name: "algo_bloom_create",
    description:
      "Create a Bloom filter for memory-efficient probabilistic set membership. May have false positives but never false negatives. Ideal for checking if element was definitely NOT seen. Keywords: bloom filter, probabilistic set, membership test, space efficient.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique identifier" },
        capacity: { type: "number", description: "Expected items (default: 1000)" },
      },
      required: ["id"],
    },
    handler: ({ id, capacity = 1000 }) => {
      const bloom = new BloomFilter(capacity as number);
      instances.set(id as string, bloom);
      return { created: id, capacity };
    },
  },
  {
    name: "algo_bloom_add",
    description:
      "Add items to Bloom filter. Elements cannot be removed. Use for tracking seen items, duplicate detection, or cache existence checks. Keywords: bloom add, mark as seen, bloom insert.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Bloom filter ID" },
        items: { type: "array", items: { type: "string" }, description: "Items to add" },
      },
      required: ["id", "items"],
    },
    handler: ({ id, items }) => {
      const bloom = instances.get(id as string) as BloomFilter;
      if (!bloom) return { error: "Bloom filter not found" };
      for (const item of items as string[]) {
        bloom.add(item);
      }
      return { success: true };
    },
  },
  {
    name: "algo_bloom_test",
    description:
      "Test if item might exist in Bloom filter. Returns true if 'possibly in set', false if 'definitely not in set'. Use for quick negative checks before expensive lookups. Keywords: bloom test, check membership, exists check.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Bloom filter ID" },
        item: { type: "string", description: "Item to test" },
      },
      required: ["id", "item"],
    },
    handler: ({ id, item }) => {
      const bloom = instances.get(id as string) as BloomFilter;
      if (!bloom) return { error: "Bloom filter not found" };
      return { mightExist: bloom.test(item as string) };
    },
  },

  // Circular Buffer operations
  {
    name: "algo_circular_create",
    description:
      "Create a circular/ring buffer with fixed capacity. New items overwrite oldest when full. Perfect for sliding windows, recent history, or bounded logging. Keywords: circular buffer, ring buffer, bounded queue, sliding window.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique identifier" },
        capacity: { type: "number", description: "Buffer capacity" },
      },
      required: ["id", "capacity"],
    },
    handler: ({ id, capacity }) => {
      const buffer = new CircularBuffer<unknown>(Array, capacity as number);
      instances.set(id as string, buffer);
      return { created: id, capacity };
    },
  },
  {
    name: "algo_circular_push",
    description:
      "Add items to circular buffer. Overwrites oldest entries when at capacity. Use for streaming data or fixed-size history. Keywords: ring buffer push, circular add, append to ring.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Buffer ID" },
        items: { type: "array", description: "Items to push" },
      },
      required: ["id", "items"],
    },
    handler: ({ id, items }) => {
      const buffer = instances.get(id as string) as CircularBuffer<unknown>;
      if (!buffer) return { error: "Buffer not found" };
      for (const item of items as unknown[]) {
        buffer.push(item);
      }
      return { size: buffer.size };
    },
  },
  {
    name: "algo_circular_toArray",
    description:
      "Export circular buffer contents as array in insertion order. Get current state of ring buffer. Use for inspection, serialization, or processing. Keywords: ring buffer export, get buffer contents, circular to array.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Buffer ID" },
      },
      required: ["id"],
    },
    handler: ({ id }) => {
      const buffer = instances.get(id as string) as CircularBuffer<unknown>;
      if (!buffer) return { error: "Buffer not found" };
      return { items: buffer.toArray(), size: buffer.size };
    },
  },

  // Disjoint Set (Union-Find) operations
  {
    name: "algo_unionfind_create",
    description:
      "Create a Union-Find (disjoint set) data structure. Track connected components, detect cycles in graphs. Essential for Kruskal's algorithm, network connectivity, or clustering. Keywords: union find, disjoint set, connected components, cycle detection.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique identifier" },
        size: { type: "number", description: "Number of elements" },
      },
      required: ["id", "size"],
    },
    handler: ({ id, size }) => {
      const ds = new StaticDisjointSet(size as number);
      instances.set(id as string, ds);
      return { created: id, size };
    },
  },
  {
    name: "algo_unionfind_union",
    description:
      "Merge two elements into the same set/component. Connect nodes in a graph. Use for building connected components or grouping related items. Keywords: union operation, merge sets, connect nodes.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Disjoint set ID" },
        a: { type: "number", description: "First element" },
        b: { type: "number", description: "Second element" },
      },
      required: ["id", "a", "b"],
    },
    handler: ({ id, a, b }) => {
      const ds = instances.get(id as string) as StaticDisjointSet;
      if (!ds) return { error: "Disjoint set not found" };
      ds.union(a as number, b as number);
      return { dimension: ds.dimension };
    },
  },
  {
    name: "algo_unionfind_connected",
    description:
      "Check if two elements belong to the same set/component. Test connectivity between nodes. Use for graph connectivity queries or equivalence class checks. Keywords: find connected, same component, connectivity test.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Disjoint set ID" },
        a: { type: "number", description: "First element" },
        b: { type: "number", description: "Second element" },
      },
      required: ["id", "a", "b"],
    },
    handler: ({ id, a, b }) => {
      const ds = instances.get(id as string) as StaticDisjointSet;
      if (!ds) return { error: "Disjoint set not found" };
      return { connected: ds.connected(a as number, b as number) };
    },
  },

  // General instance management
  {
    name: "algo_delete",
    description:
      "Delete an algorithm data structure instance by ID. Free memory when done with a heap, trie, cache, or other structure. Use for cleanup or resource management. Keywords: delete structure, remove instance, cleanup memory.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Instance ID to delete" },
      },
      required: ["id"],
    },
    handler: ({ id }) => {
      const deleted = instances.delete(id as string);
      return { deleted };
    },
  },
  {
    name: "algo_list",
    description:
      "List all active algorithm data structure instances. See what heaps, tries, caches, and other structures are currently allocated. Use for debugging or inventory. Keywords: list instances, show structures, active data structures.",
    category: "algo",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: () => {
      return { instances: Array.from(instances.keys()) };
    },
  },
];

// Re-export unused imports for potential future use
export {
  BiMap,
  DefaultMap,
  FibonacciHeap,
  LinkedList,
  LRUMap,
  MultiSet,
  Queue,
  Stack,
  SuffixArray,
};
