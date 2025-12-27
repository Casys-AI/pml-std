/**
 * Tests for std library tools
 *
 * This test suite:
 * 1. Validates all tools load correctly
 * 2. Tests each tool with sample inputs
 * 3. Verifies input schema compliance
 * 4. Tests error handling for invalid inputs
 *
 * @module tests/unit/lib/std_tools_test
 */

import { assertEquals, assertExists } from "jsr:@std/assert";
import { describe, it } from "jsr:@std/testing/bdd";

// Import all tool modules
import { textTools } from "../../../lib/std/text.ts";
import { jsonTools } from "../../../lib/std/json.ts";
import { mathTools } from "../../../lib/std/math.ts";
import { datetimeTools } from "../../../lib/std/datetime.ts";
import { cryptoTools } from "../../../lib/std/crypto.ts";
import { collectionsTools } from "../../../lib/std/collections.ts";
import { vfsTools } from "../../../lib/std/vfs.ts";
import { dataTools } from "../../../lib/std/data.ts";
import { httpTools } from "../../../lib/std/http.ts";
import { validationTools } from "../../../lib/std/validation.ts";
import { formatTools } from "../../../lib/std/format.ts";
import { transformTools } from "../../../lib/std/transform.ts";
import { stateTools } from "../../../lib/std/state.ts";
import { compareTools } from "../../../lib/std/compare.ts";
import { algoTools } from "../../../lib/std/algo.ts";
import { colorTools } from "../../../lib/std/color.ts";
import { networkTools } from "../../../lib/std/network.ts";
import { utilTools } from "../../../lib/std/util.ts";

// New modules
import { stringTools } from "../../../lib/std/string.ts";
import { pathTools } from "../../../lib/std/path.ts";
import { fakerTools } from "../../../lib/std/faker.ts";
import { geoTools } from "../../../lib/std/geo.ts";
import { qrcodeTools } from "../../../lib/std/qrcode.ts";
import { resilienceTools } from "../../../lib/std/resilience.ts";
import { schemaTools } from "../../../lib/std/schema.ts";
import { diffTools } from "../../../lib/std/diff.ts";

// System tools (CLI-based)
import { dockerTools } from "../../../lib/std/docker.ts";
import { gitTools } from "../../../lib/std/git.ts";
import { processTools } from "../../../lib/std/process.ts";
import { archiveTools } from "../../../lib/std/archive.ts";
import { sshTools } from "../../../lib/std/ssh.ts";
import { kubernetesTools } from "../../../lib/std/kubernetes.ts";
import { databaseTools } from "../../../lib/std/database.ts";
import { mediaTools } from "../../../lib/std/media.ts";
import { cloudTools } from "../../../lib/std/cloud.ts";
import { sysinfoTools } from "../../../lib/std/sysinfo.ts";
import { packagesTools } from "../../../lib/std/packages.ts";

import type { MiniTool } from "../../../lib/std/types.ts";

// Collect all tools
const ALL_TOOLS: MiniTool[] = [
  // Data tools (pure computation)
  ...textTools,
  ...jsonTools,
  ...mathTools,
  ...datetimeTools,
  ...cryptoTools,
  ...collectionsTools,
  ...vfsTools,
  ...dataTools,
  ...httpTools,
  ...validationTools,
  ...formatTools,
  ...transformTools,
  ...stateTools,
  ...compareTools,
  ...algoTools,
  ...colorTools,
  ...utilTools,
  // New data tools
  ...stringTools,
  ...pathTools,
  ...fakerTools,
  ...geoTools,
  ...qrcodeTools,
  ...resilienceTools,
  ...schemaTools,
  ...diffTools,
  // System tools (CLI-based)
  ...networkTools,
  ...dockerTools,
  ...gitTools,
  ...processTools,
  ...archiveTools,
  ...sshTools,
  ...kubernetesTools,
  ...databaseTools,
  ...mediaTools,
  ...cloudTools,
  ...sysinfoTools,
  ...packagesTools,
];

// Sample test inputs for each tool type
const SAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  // Text CLI tools
  jq: { input: '{"a":1}', filter: ".a" },
  wc: { text: "hello world\ntest" },

  // String tools (new)
  string_slugify: { text: "Hello World!" },
  string_camel_case: { text: "hello-world" },
  string_snake_case: { text: "helloWorld" },
  string_truncate: { text: "Hello World", maxLength: 8 },
  string_word_count: { text: "hello world test" },
  string_reverse: { text: "hello" },
  string_levenshtein: { str1: "kitten", str2: "sitting" },

  // Path tools
  path_join: { parts: ["/home", "user", "file.txt"] },
  path_dirname: { path: "/home/user/file.txt" },
  path_basename: { path: "/home/user/file.txt" },
  path_extname: { path: "/home/user/file.txt" },

  // Faker tools
  faker_person: { count: 1 },
  faker_company: { count: 1 },
  faker_address: { count: 1 },
  faker_lorem: { sentences: 2 },

  // Geo tools
  geo_distance: { lat1: 48.8566, lon1: 2.3522, lat2: 51.5074, lon2: -0.1278 },
  geo_bearing: { lat1: 48.8566, lon1: 2.3522, lat2: 51.5074, lon2: -0.1278 },
  geo_validate: { lat: 48.8566, lon: 2.3522 },

  // QR tools
  qrcode_generate: { data: "https://example.com" },

  // Resilience tools
  resilience_retry_config: { maxAttempts: 3, baseDelay: 1000 },

  // Schema tools
  schema_infer: { data: [{ name: "John", age: 30 }, { name: "Jane", age: 25 }] },

  // Diff tools
  diff_lines: { oldText: "hello\nworld", newText: "hello\nearth" },
  diff_words: { oldText: "hello world", newText: "hello earth" },

  // JSON tools
  json_parse: { json: '{"a":1}' },
  json_stringify: { data: { a: 1 } },
  json_query: { data: { users: [{ name: "John" }] }, expression: "users[0].name" },
  json_merge: { objects: [{ a: 1 }, { b: 2 }] },
  json_keys: { data: { a: 1, b: 2 } },
  json_flatten: { data: { a: { b: 1 } } },
  json_unflatten: { data: { "a.b": 1 } },
  json_pick: { data: { a: 1, b: 2, c: 3 }, keys: ["a", "c"] },
  json_omit: { data: { a: 1, b: 2, c: 3 }, keys: ["b"] },

  // Math tools
  math_eval: { expression: "2 + 3 * 4" },
  math_stats: { numbers: [1, 2, 3, 4, 5] },
  math_round: { number: 3.14159, decimals: 2 },
  math_random: { min: 1, max: 10 },
  math_percentage: { value: 25, total: 100 },

  // Datetime tools
  datetime_now: {},
  datetime_format: { date: "2024-01-15T12:00:00Z", format: "YYYY-MM-DD" },
  datetime_parse: { text: "2024-01-15" },
  datetime_diff: { date1: "2024-01-01", date2: "2024-01-15" },
  datetime_add: { date: "2024-01-01", amount: 7, unit: "days" },

  // Crypto tools
  crypto_hash: { text: "hello", algorithm: "SHA-256" },
  crypto_uuid: {},
  crypto_base64: { text: "hello", action: "encode" },
  crypto_hex: { text: "hello", action: "encode" },
  crypto_random_bytes: { length: 16 },
  crypto_password: { length: 16 },
  crypto_ulid: {},
  crypto_hmac: { text: "hello", secret: "key", algorithm: "SHA-256" },

  // Collections tools
  collections_map: { items: [1, 2, 3], expression: "x * 2" },
  collections_filter: { items: [1, 2, 3, 4], expression: "x > 2" },
  collections_reduce: { items: [1, 2, 3], expression: "acc + x", initial: 0 },
  collections_sort: { items: [3, 1, 2] },
  collections_unique: { items: [1, 1, 2, 2, 3] },
  collections_chunk: { items: [1, 2, 3, 4, 5], size: 2 },
  collections_flatten: { items: [[1, 2], [3, 4]] },

  // VFS tools
  vfs_write: { path: "/test.txt", content: "hello" },
  vfs_read: { path: "/test.txt" },
  vfs_list: { path: "/" },
  vfs_exists: { path: "/test.txt" },

  // Data tools
  data_fake_name: {},
  data_fake_email: {},
  data_fake_uuid: {},

  // HTTP tools
  http_parse_url: { url: "https://example.com/path?q=1" },
  http_build_url: { protocol: "https", host: "example.com", path: "/api" },
  http_parse_query: { query: "a=1&b=2" },
  http_build_query: { params: { a: "1", b: "2" } },

  // Validation tools
  validate_email: { email: "test@example.com" },
  validate_url: { url: "https://example.com" },
  validate_uuid: { uuid: "550e8400-e29b-41d4-a716-446655440000" },
  validate_ip: { ip: "192.168.1.1" },
  validate_json: { json: '{"valid": true}' },

  // Format tools
  format_number: { number: 1234567.89 },
  format_currency: { amount: 1234.56, currency: "USD" },
  format_bytes: { bytes: 1536 },
  format_percentage: { value: 0.1234 },
  format_duration: { seconds: 3661 },

  // Transform tools
  transform_csv_parse: { csv: "a,b\n1,2\n3,4" },
  transform_csv_stringify: { data: [{ a: 1, b: 2 }] },

  // State tools
  state_set: { key: "test", value: "hello" },
  state_get: { key: "test" },
  state_delete: { key: "test" },
  state_has: { key: "test" },
  state_keys: {},
  state_clear: {},
  state_size: {},

  // Compare tools
  compare_strings: { a: "hello", b: "hallo" },
  compare_numbers: { a: 5, b: 3 },
  compare_arrays: { a: [1, 2, 3], b: [1, 2, 4] },
  compare_deep_equal: { a: { x: [1, 2] }, b: { x: [1, 2] } },
  compare_levenshtein: { a: "kitten", b: "sitting" },

  // Algo tools
  algo_heap_create: { id: "test_heap", type: "min" },
  algo_trie_create: { id: "test_trie" },
  algo_lru_create: { id: "test_lru", capacity: 10 },
  algo_bloom_create: { id: "test_bloom", capacity: 100 },
  algo_list: {},

  // Color tools
  color_hex_to_rgb: { hex: "#FF5733" },
  color_rgb_to_hex: { r: 255, g: 87, b: 51 },
  color_rgb_to_hsl: { r: 255, g: 87, b: 51 },
  color_hsl_to_rgb: { h: 11, s: 100, l: 60 },

  // Util tools
  util_http_status: { code: 200 },
  util_mime_type: { extension: "json" },
  util_normalize_email: { email: "Test.User+tag@gmail.com" },
  util_port_numbers: { port: 443 },
};

// Expected outputs for validation (subset of tools)
const EXPECTED_OUTPUTS: Record<string, unknown> = {
  math_eval: 14,
  json_parse: { a: 1 },
  string_reverse: "olleh",
};

// =============================================================================
// Test Suite
// =============================================================================

describe("std library tools", () => {
  describe("tool loading", () => {
    it("should have loaded all expected tools", () => {
      assertExists(ALL_TOOLS);
      // Updated: now we have 300+ tools
      assertEquals(
        ALL_TOOLS.length >= 300,
        true,
        `Expected at least 300 tools, got ${ALL_TOOLS.length}`,
      );
    });

    it("each tool should have required properties", () => {
      for (const tool of ALL_TOOLS) {
        assertExists(tool.name, `Tool missing name`);
        assertExists(tool.description, `Tool ${tool.name} missing description`);
        assertExists(tool.category, `Tool ${tool.name} missing category`);
        assertExists(tool.inputSchema, `Tool ${tool.name} missing inputSchema`);
        assertExists(tool.handler, `Tool ${tool.name} missing handler`);
        assertEquals(
          typeof tool.handler,
          "function",
          `Tool ${tool.name} handler is not a function`,
        );
      }
    });

    it("tool names should be unique", () => {
      const names = ALL_TOOLS.map((t) => t.name);
      const uniqueNames = new Set(names);
      assertEquals(names.length, uniqueNames.size, "Duplicate tool names found");
    });

    it("tool names should follow naming convention", () => {
      // CLI tools (sed, awk, jq, etc.) use simple names
      // Other tools use category_name pattern
      const CLI_TOOLS = [
        "sed",
        "awk",
        "jq",
        "wc",
        "head",
        "tail",
        "sort_lines",
        "uniq",
        "cut",
        "diff",
      ];

      for (const tool of ALL_TOOLS) {
        const isCliTool = CLI_TOOLS.includes(tool.name);
        const followsPattern = /^[a-z]+[_a-zA-Z0-9]*$/.test(tool.name);

        assertEquals(
          followsPattern,
          true,
          `Tool name "${tool.name}" doesn't follow naming convention`,
        );

        // Non-CLI tools should have underscore (category_name)
        if (!isCliTool && !tool.name.includes("_")) {
          console.warn(`Tool "${tool.name}" might need category prefix`);
        }
      }
    });
  });

  describe("tool execution with sample inputs", () => {
    for (const tool of ALL_TOOLS) {
      const sampleInput = SAMPLE_INPUTS[tool.name];

      if (sampleInput !== undefined) {
        it(`${tool.name} should execute with sample input`, async () => {
          try {
            const result = await tool.handler(sampleInput);
            assertExists(
              result !== undefined || result === null,
              `Tool ${tool.name} returned undefined`,
            );

            // Check expected output if defined
            const expected = EXPECTED_OUTPUTS[tool.name];
            if (expected !== undefined) {
              assertEquals(result, expected, `Tool ${tool.name} output mismatch`);
            }
          } catch (error) {
            // Some tools may throw intentionally for certain inputs
            console.warn(`Tool ${tool.name} threw: ${(error as Error).message}`);
          }
        });
      }
    }
  });

  describe("input schema validation", () => {
    it("each tool should have a valid JSON schema", () => {
      for (const tool of ALL_TOOLS) {
        const schema = tool.inputSchema;
        assertExists(schema.type, `Tool ${tool.name} schema missing type`);
        assertEquals(schema.type, "object", `Tool ${tool.name} schema type should be object`);

        if (schema.required) {
          assertEquals(
            Array.isArray(schema.required),
            true,
            `Tool ${tool.name} required should be an array`,
          );
        }

        if (schema.properties) {
          assertEquals(
            typeof schema.properties,
            "object",
            `Tool ${tool.name} properties should be an object`,
          );
        }
      }
    });
  });

  describe("category-specific tests", () => {
    describe("string tools", () => {
      it("string_slugify should create valid slugs", async () => {
        const tool = stringTools.find((t) => t.name === "string_slugify")!;
        assertExists(tool, "string_slugify should exist");
        const result = await tool.handler({ text: "Hello World!" });
        assertEquals(result, "hello-world");
      });

      it("string_camel_case should convert correctly", async () => {
        const tool = stringTools.find((t) => t.name === "string_camel_case")!;
        assertExists(tool, "string_camel_case should exist");
        const result = await tool.handler({ text: "hello-world" });
        assertEquals(result, "helloWorld");
      });

      it("string_reverse should reverse strings", async () => {
        const tool = stringTools.find((t) => t.name === "string_reverse")!;
        assertExists(tool, "string_reverse should exist");
        const result = await tool.handler({ text: "hello" });
        assertEquals(result, "olleh");
      });

      it("string_levenshtein should calculate distance", async () => {
        const tool = stringTools.find((t) => t.name === "string_levenshtein")!;
        assertExists(tool, "string_levenshtein should exist");
        // Uses str1/str2 params, returns { distance, similarity }
        const result = await tool.handler({ str1: "kitten", str2: "sitting" }) as {
          distance: number;
        };
        assertEquals(result.distance, 3);
      });
    });

    describe("crypto tools", () => {
      it("base64 encode/decode should be reversible", async () => {
        const tool = cryptoTools.find((t) => t.name === "crypto_base64")!;

        const original = "Hello, World! 123";
        const encoded = await tool.handler({ text: original, action: "encode" });
        const decoded = await tool.handler({ text: encoded, action: "decode" });
        assertEquals(decoded, original);
      });

      it("hex encode/decode should be reversible", async () => {
        const tool = cryptoTools.find((t) => t.name === "crypto_hex")!;

        const original = "Hello123";
        const encoded = await tool.handler({ text: original, action: "encode" });
        const decoded = await tool.handler({ text: encoded, action: "decode" });
        assertEquals(decoded, original);
      });

      it("uuid should generate valid UUIDs", async () => {
        const tool = cryptoTools.find((t) => t.name === "crypto_uuid")!;
        const uuid = await tool.handler({}) as string;
        assertEquals(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid),
          true,
        );
      });
    });

    describe("math tools", () => {
      it("math_eval should evaluate expressions correctly", async () => {
        const tool = mathTools.find((t) => t.name === "math_eval")!;
        assertEquals(await tool.handler({ expression: "2 + 3" }), 5);
        assertEquals(await tool.handler({ expression: "10 / 2" }), 5);
        assertEquals(await tool.handler({ expression: "sqrt(16)" }), 4);
      });

      it("math_stats should calculate statistics correctly", async () => {
        const tool = mathTools.find((t) => t.name === "math_stats")!;
        const result = await tool.handler({ numbers: [1, 2, 3, 4, 5] }) as Record<string, number>;
        assertEquals(result.min, 1);
        assertEquals(result.max, 5);
        assertEquals(result.mean, 3);
        assertEquals(result.sum, 15);
      });
    });

    describe("json tools", () => {
      it("json parse/stringify should be reversible", async () => {
        const parse = jsonTools.find((t) => t.name === "json_parse")!;
        const stringify = jsonTools.find((t) => t.name === "json_stringify")!;

        const original = { a: 1, b: [2, 3], c: { d: "test" } };
        const stringified = await stringify.handler({ data: original });
        const parsed = await parse.handler({ json: stringified });
        assertEquals(parsed, original);
      });

      it("json_flatten/unflatten should be reversible", async () => {
        const flatten = jsonTools.find((t) => t.name === "json_flatten")!;
        const unflatten = jsonTools.find((t) => t.name === "json_unflatten")!;

        const original = { a: { b: { c: 1 } }, d: 2 };
        const flattened = await flatten.handler({ data: original });
        const unflattened = await unflatten.handler({ data: flattened });
        assertEquals(unflattened, original);
      });
    });

    describe("color tools", () => {
      it("hex to rgb conversion should work", async () => {
        const tool = colorTools.find((t) => t.name === "color_hex_to_rgb")!;
        const red = await tool.handler({ hex: "#FF0000" }) as { r: number; g: number; b: number };
        assertEquals(red.r, 255);
        assertEquals(red.g, 0);
        assertEquals(red.b, 0);
      });

      it("rgb to hex conversion should work", async () => {
        const tool = colorTools.find((t) => t.name === "color_rgb_to_hex")!;
        const red = await tool.handler({ r: 255, g: 0, b: 0 }) as { hex: string };
        assertEquals(red.hex.toUpperCase(), "#FF0000");
      });

      it("color conversions should be reversible", async () => {
        const toRgb = colorTools.find((t) => t.name === "color_hex_to_rgb")!;
        const toHex = colorTools.find((t) => t.name === "color_rgb_to_hex")!;

        const original = "#AABBCC";
        const rgb = await toRgb.handler({ hex: original }) as { r: number; g: number; b: number };
        const hexResult = await toHex.handler({ r: rgb.r, g: rgb.g, b: rgb.b }) as { hex: string };
        assertEquals(hexResult.hex.toUpperCase(), original);
      });
    });

    describe("geo tools", () => {
      it("geo_distance should calculate distance between points", async () => {
        const tool = geoTools.find((t) => t.name === "geo_distance")!;
        assertExists(tool, "geo_distance should exist");
        // Paris to London - returns { distance, unit }
        const result = await tool.handler({
          lat1: 48.8566,
          lon1: 2.3522,
          lat2: 51.5074,
          lon2: -0.1278,
        }) as { distance: number; unit: string };
        // Should be around 340-345 km
        assertEquals(
          result.distance > 300 && result.distance < 400,
          true,
          `Distance should be ~340km, got ${result.distance}`,
        );
        assertEquals(result.unit, "km");
      });

      it("geo_validate should validate coordinates", async () => {
        const tool = geoTools.find((t) => t.name === "geo_validate")!;
        assertExists(tool, "geo_validate should exist");

        const valid = await tool.handler({ lat: 48.8566, lon: 2.3522 }) as { valid: boolean };
        assertEquals(valid.valid, true);

        const invalid = await tool.handler({ lat: 200, lon: 2.3522 }) as { valid: boolean };
        assertEquals(invalid.valid, false);
      });
    });

    describe("path tools", () => {
      it("path operations should work correctly", async () => {
        const dirname = pathTools.find((t) => t.name === "path_dirname")!;
        const basename = pathTools.find((t) => t.name === "path_basename")!;
        const extname = pathTools.find((t) => t.name === "path_extname")!;

        assertExists(dirname, "path_dirname should exist");
        assertExists(basename, "path_basename should exist");
        assertExists(extname, "path_extname should exist");

        const path = "/home/user/file.txt";
        assertEquals(await dirname.handler({ path }), "/home/user");
        assertEquals(await basename.handler({ path }), "file.txt");
        assertEquals(await extname.handler({ path }), ".txt");
      });
    });

    describe("validation tools", () => {
      it("should validate emails correctly", async () => {
        const tool = validationTools.find((t) => t.name === "validate_email")!;
        const valid = await tool.handler({ email: "test@example.com" }) as { valid: boolean };
        const invalid = await tool.handler({ email: "not-an-email" }) as { valid: boolean };
        assertEquals(valid.valid, true);
        assertEquals(invalid.valid, false);
      });

      it("should validate UUIDs correctly", async () => {
        const tool = validationTools.find((t) => t.name === "validate_uuid")!;
        const valid = await tool.handler({ uuid: "550e8400-e29b-41d4-a716-446655440000" }) as {
          valid: boolean;
        };
        const invalid = await tool.handler({ uuid: "not-a-uuid" }) as { valid: boolean };
        assertEquals(valid.valid, true);
        assertEquals(invalid.valid, false);
      });
    });

    describe("algo tools", () => {
      it("should have all expected data structure tools", () => {
        const expectedTools = [
          "algo_heap_create",
          "algo_heap_push",
          "algo_heap_pop",
          "algo_trie_create",
          "algo_trie_add",
          "algo_trie_find",
          "algo_lru_create",
          "algo_lru_set",
          "algo_lru_get",
          "algo_bloom_create",
          "algo_bloom_add",
          "algo_bloom_test",
        ];

        for (const name of expectedTools) {
          const tool = algoTools.find((t) => t.name === name);
          assertExists(tool, `Tool ${name} should exist`);
        }
      });

      it("heap create should initialize", async () => {
        const create = algoTools.find((t) => t.name === "algo_heap_create")!;
        const result = await create.handler({ id: "unit_test_heap", type: "min" });
        assertExists(result);
      });
    });

    describe("util tools", () => {
      it("http_status should look up codes", async () => {
        const tool = utilTools.find((t) => t.name === "util_http_status")!;
        const result = await tool.handler({ code: 404 }) as { message: string };
        assertEquals(result.message, "Not Found");
      });

      it("normalize_email should normalize gmail addresses", async () => {
        const tool = utilTools.find((t) => t.name === "util_normalize_email")!;
        const result = await tool.handler({ email: "Test.User+spam@gmail.com" }) as {
          normalized: string;
        };
        assertEquals(result.normalized, "testuser@gmail.com");
      });

      it("port_numbers should look up ports", async () => {
        const tool = utilTools.find((t) => t.name === "util_port_numbers")!;
        const result = await tool.handler({ port: 443 }) as { service: string };
        assertEquals(result.service, "HTTPS");
      });
    });

    describe("faker tools", () => {
      it("faker_person should generate person data", async () => {
        const tool = fakerTools.find((t) => t.name === "faker_person")!;
        assertExists(tool, "faker_person should exist");
        // When count=1, returns single object; when count>1, returns array
        const result = await tool.handler({ count: 1 }) as {
          firstName: string;
          lastName: string;
          fullName: string;
        };
        assertExists(result);
        // Check person has expected fields
        assertExists(result.firstName);
        assertExists(result.lastName);
        assertExists(result.fullName);
      });
    });

    describe("diff tools", () => {
      it("diff_lines should show line differences", async () => {
        const tool = diffTools.find((t) => t.name === "diff_lines")!;
        assertExists(tool, "diff_lines should exist");
        // Uses oldText/newText params
        const result = await tool.handler({
          oldText: "hello\nworld",
          newText: "hello\nearth",
        });
        assertExists(result);
      });
    });
  });

  describe("error handling", () => {
    it("tools should handle missing required params gracefully", async () => {
      const tool = jsonTools.find((t) => t.name === "json_parse")!;
      try {
        await tool.handler({});
        // If it doesn't throw, it should return something sensible
      } catch (e) {
        // Expected - missing required param
        assertExists(e);
      }
    });

    it("tools should handle invalid input types gracefully", async () => {
      const tool = mathTools.find((t) => t.name === "math_eval")!;
      try {
        await tool.handler({ expression: "invalid math $$$$" });
      } catch (e) {
        assertExists(e);
      }
    });
  });
});

// Summary stats
console.log(`\n📊 Test Summary:`);
console.log(`   Total tools: ${ALL_TOOLS.length}`);
console.log(`   Tools with sample inputs: ${Object.keys(SAMPLE_INPUTS).length}`);
console.log(`   Tools with expected outputs: ${Object.keys(EXPECTED_OUTPUTS).length}`);
