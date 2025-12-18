/**
 * Unit tests for Edge Weight Configuration Module
 *
 * Tests cover:
 * - Edge weight calculation with all edge types and sources
 * - Edge source determination based on observation count
 * - Initial weight calculation
 * - Constants validation
 * - Edge cases: invalid types, boundary values
 *
 * @module tests/unit/graphrag/algorithms/edge_weights_test
 */

import { assertEquals } from "@std/assert";
import {
  getEdgeWeight,
  determineEdgeSource,
  calculateInitialWeight,
  EDGE_TYPE_WEIGHTS,
  EDGE_SOURCE_MODIFIERS,
  OBSERVED_THRESHOLD,
} from "../../../../src/graphrag/algorithms/edge-weights.ts";

Deno.test("Edge Weights - EDGE_TYPE_WEIGHTS constant has all types", () => {
  assertEquals(EDGE_TYPE_WEIGHTS.dependency, 1.0);
  assertEquals(EDGE_TYPE_WEIGHTS.contains, 0.8);
  assertEquals(EDGE_TYPE_WEIGHTS.provides, 0.7); // Story 10.3: replaced alternative with provides
  assertEquals(EDGE_TYPE_WEIGHTS.sequence, 0.5);
});

Deno.test("Edge Weights - EDGE_SOURCE_MODIFIERS constant has all sources", () => {
  assertEquals(EDGE_SOURCE_MODIFIERS.observed, 1.0);
  assertEquals(EDGE_SOURCE_MODIFIERS.inferred, 0.7);
  assertEquals(EDGE_SOURCE_MODIFIERS.template, 0.5);
});

Deno.test("Edge Weights - OBSERVED_THRESHOLD is set correctly", () => {
  assertEquals(OBSERVED_THRESHOLD, 3);
});

Deno.test("Edge Weights - getEdgeWeight with dependency + observed (strongest)", () => {
  const weight = getEdgeWeight("dependency", "observed");
  assertEquals(weight, 1.0); // 1.0 × 1.0
});

Deno.test("Edge Weights - getEdgeWeight with dependency + inferred", () => {
  const weight = getEdgeWeight("dependency", "inferred");
  assertEquals(weight, 0.7); // 1.0 × 0.7
});

Deno.test("Edge Weights - getEdgeWeight with dependency + template", () => {
  const weight = getEdgeWeight("dependency", "template");
  assertEquals(weight, 0.5); // 1.0 × 0.5
});

Deno.test("Edge Weights - getEdgeWeight with contains + observed", () => {
  const weight = getEdgeWeight("contains", "observed");
  assertEquals(weight, 0.8); // 0.8 × 1.0
});

Deno.test("Edge Weights - getEdgeWeight with contains + inferred", () => {
  const weight = getEdgeWeight("contains", "inferred");
  // 0.8 × 0.7 = 0.56 (but floating point precision)
  assertEquals(Math.round(weight * 100) / 100, 0.56);
});

Deno.test("Edge Weights - getEdgeWeight with provides + observed", () => {
  const weight = getEdgeWeight("provides", "observed");
  assertEquals(weight, 0.7); // 0.7 × 1.0 (Story 10.3)
});

Deno.test("Edge Weights - getEdgeWeight with provides + inferred", () => {
  const weight = getEdgeWeight("provides", "inferred");
  assertEquals(Math.round(weight * 100) / 100, 0.49); // 0.7 × 0.7 (Story 10.3)
});

Deno.test("Edge Weights - getEdgeWeight with sequence + observed", () => {
  const weight = getEdgeWeight("sequence", "observed");
  assertEquals(weight, 0.5); // 0.5 × 1.0
});

Deno.test("Edge Weights - getEdgeWeight with sequence + inferred", () => {
  const weight = getEdgeWeight("sequence", "inferred");
  assertEquals(weight, 0.35); // 0.5 × 0.7
});

Deno.test("Edge Weights - getEdgeWeight with sequence + template (weakest)", () => {
  const weight = getEdgeWeight("sequence", "template");
  assertEquals(weight, 0.25); // 0.5 × 0.5
});

Deno.test("Edge Weights - getEdgeWeight with invalid edge type defaults to 0.5", () => {
  const weight = getEdgeWeight("invalid_type", "observed");
  assertEquals(weight, 0.5); // 0.5 × 1.0 (default type weight)
});

Deno.test("Edge Weights - getEdgeWeight with invalid edge source defaults to 0.7", () => {
  const weight = getEdgeWeight("dependency", "invalid_source");
  assertEquals(weight, 0.7); // 1.0 × 0.7 (default source modifier)
});

Deno.test("Edge Weights - getEdgeWeight with both invalid defaults", () => {
  const weight = getEdgeWeight("invalid_type", "invalid_source");
  assertEquals(weight, 0.35); // 0.5 × 0.7 (both defaults)
});

Deno.test("Edge Weights - determineEdgeSource upgrades inferred to observed at threshold", () => {
  const source = determineEdgeSource(3, "inferred");
  assertEquals(source, "observed");
});

Deno.test("Edge Weights - determineEdgeSource upgrades inferred to observed above threshold", () => {
  const source = determineEdgeSource(5, "inferred");
  assertEquals(source, "observed");
});

Deno.test("Edge Weights - determineEdgeSource keeps inferred below threshold", () => {
  const source = determineEdgeSource(2, "inferred");
  assertEquals(source, "inferred");
});

Deno.test("Edge Weights - determineEdgeSource keeps observed as observed", () => {
  const source = determineEdgeSource(10, "observed");
  assertEquals(source, "observed");
});

Deno.test("Edge Weights - determineEdgeSource keeps template as template", () => {
  const source = determineEdgeSource(5, "template");
  assertEquals(source, "template");
});

Deno.test("Edge Weights - determineEdgeSource at boundary (count = 2)", () => {
  const source = determineEdgeSource(2, "inferred");
  assertEquals(source, "inferred");
});

Deno.test("Edge Weights - determineEdgeSource at boundary (count = 3)", () => {
  const source = determineEdgeSource(3, "inferred");
  assertEquals(source, "observed");
});

Deno.test("Edge Weights - calculateInitialWeight with default inferred source", () => {
  const weight = calculateInitialWeight("dependency");
  assertEquals(weight, 0.7); // 1.0 × 0.7 (inferred)
});

Deno.test("Edge Weights - calculateInitialWeight with explicit observed source", () => {
  const weight = calculateInitialWeight("contains", "observed");
  assertEquals(weight, 0.8); // 0.8 × 1.0
});

Deno.test("Edge Weights - calculateInitialWeight with template source", () => {
  const weight = calculateInitialWeight("sequence", "template");
  assertEquals(weight, 0.25); // 0.5 × 0.5
});

Deno.test("Edge Weights - calculateInitialWeight for all edge types with inferred", () => {
  assertEquals(calculateInitialWeight("dependency"), 0.7);
  assertEquals(Math.round(calculateInitialWeight("contains") * 100) / 100, 0.56);
  assertEquals(Math.round(calculateInitialWeight("provides") * 100) / 100, 0.49); // Story 10.3
  assertEquals(calculateInitialWeight("sequence"), 0.35);
});
