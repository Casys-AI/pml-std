/**
 * Semantic Descriptions for Pure Code Operations
 *
 * These descriptions are used to generate embeddings for SHGAT learning.
 * Rich semantic descriptions enable similarity-based learning across operations.
 *
 * Phase 2a: Operation Embeddings
 * @module capabilities/operation-descriptions
 */

export interface OperationDescription {
  /** Tool ID (e.g., "code:filter") */
  toolId: string;

  /** Human-readable name */
  name: string;

  /** Rich semantic description for embedding generation */
  description: string;

  /** Category for grouping */
  category: "array" | "string" | "object" | "math" | "json" | "binary" | "logical" | "bitwise";
}

/**
 * Semantic descriptions for all pure code operations
 *
 * Descriptions focus on:
 * - **What** the operation does (transformation, filtering, aggregation)
 * - **How** it works (element-wise, conditional, accumulative)
 * - **Purpose** (common use cases)
 */
export const OPERATION_DESCRIPTIONS: OperationDescription[] = [
  // ============================================================================
  // Array Operations
  // ============================================================================
  {
    toolId: "code:filter",
    name: "filter",
    description:
      "Filter array elements by removing items that don't match a predicate condition. Returns new array with only elements where callback returns true. Common for data selection, conditional filtering, and subset extraction.",
    category: "array",
  },
  {
    toolId: "code:map",
    name: "map",
    description:
      "Transform each array element by applying a function. Returns new array with same length but transformed values. Common for data transformation, property extraction, and value conversion.",
    category: "array",
  },
  {
    toolId: "code:reduce",
    name: "reduce",
    description:
      "Aggregate array elements into a single value by iteratively applying a reducer function. Accumulates values from left to right. Common for summation, counting, object building, and data aggregation.",
    category: "array",
  },
  {
    toolId: "code:flatMap",
    name: "flatMap",
    description:
      "Map each element to an array then flatten the result by one level. Combines map and flat operations. Common for expanding nested structures and one-to-many transformations.",
    category: "array",
  },
  {
    toolId: "code:find",
    name: "find",
    description:
      "Find first array element that matches a predicate condition. Returns the element or undefined. Common for searching, lookups, and retrieving single matching items.",
    category: "array",
  },
  {
    toolId: "code:findIndex",
    name: "findIndex",
    description:
      "Find index of first array element matching a predicate. Returns numeric index or -1 if not found. Common for position lookup and conditional indexing.",
    category: "array",
  },
  {
    toolId: "code:some",
    name: "some",
    description:
      "Test if at least one array element matches a predicate. Returns boolean true if any element passes test. Common for existence checks and partial validation.",
    category: "array",
  },
  {
    toolId: "code:every",
    name: "every",
    description:
      "Test if all array elements match a predicate. Returns boolean true only if every element passes test. Common for full validation and universal conditions.",
    category: "array",
  },
  {
    toolId: "code:sort",
    name: "sort",
    description:
      "Sort array elements in place using comparison function. Reorders elements based on comparator. Common for ordering data, ranking, and organizing lists.",
    category: "array",
  },
  {
    toolId: "code:reverse",
    name: "reverse",
    description:
      "Reverse array element order in place. First element becomes last, last becomes first. Common for reversing sequences and inverting order.",
    category: "array",
  },
  {
    toolId: "code:slice",
    name: "slice",
    description:
      "Extract portion of array without modifying original. Returns new array with elements from start to end index. Common for pagination, chunking, and subsetting.",
    category: "array",
  },
  {
    toolId: "code:concat",
    name: "concat",
    description:
      "Combine multiple arrays into single new array. Merges elements from all input arrays. Common for joining datasets and array merging.",
    category: "array",
  },
  {
    toolId: "code:join",
    name: "join",
    description:
      "Convert array to string by concatenating elements with separator. Joins all elements into single string. Common for formatting output and string construction.",
    category: "array",
  },
  {
    toolId: "code:includes",
    name: "includes",
    description:
      "Check if array contains specific value. Returns boolean indicating presence. Common for membership testing and value checking.",
    category: "array",
  },
  {
    toolId: "code:indexOf",
    name: "indexOf",
    description:
      "Find first occurrence index of value in array. Returns numeric index or -1. Common for position lookup and duplicate detection.",
    category: "array",
  },
  {
    toolId: "code:lastIndexOf",
    name: "lastIndexOf",
    description:
      "Find last occurrence index of value in array. Searches from end backwards. Common for finding final occurrence and reverse search.",
    category: "array",
  },

  // ============================================================================
  // String Operations
  // ============================================================================
  {
    toolId: "code:split",
    name: "split",
    description:
      "Divide string into array of substrings using delimiter. Breaks text at separator. Common for parsing, tokenization, and text splitting.",
    category: "string",
  },
  {
    toolId: "code:replace",
    name: "replace",
    description:
      "Replace first occurrence of pattern in string. Substitutes match with replacement. Common for text modification and pattern substitution.",
    category: "string",
  },
  {
    toolId: "code:replaceAll",
    name: "replaceAll",
    description:
      "Replace all occurrences of pattern in string. Substitutes every match globally. Common for bulk text modification and global replacement.",
    category: "string",
  },
  {
    toolId: "code:trim",
    name: "trim",
    description:
      "Remove whitespace from both string ends. Strips leading and trailing spaces. Common for input sanitization and text cleaning.",
    category: "string",
  },
  {
    toolId: "code:trimStart",
    name: "trimStart",
    description:
      "Remove whitespace from string start. Strips only leading spaces. Common for left-aligned text processing.",
    category: "string",
  },
  {
    toolId: "code:trimEnd",
    name: "trimEnd",
    description:
      "Remove whitespace from string end. Strips only trailing spaces. Common for right-aligned text processing.",
    category: "string",
  },
  {
    toolId: "code:toLowerCase",
    name: "toLowerCase",
    description:
      "Convert string to lowercase letters. Transforms all uppercase to lowercase. Common for case-insensitive comparison and normalization.",
    category: "string",
  },
  {
    toolId: "code:toUpperCase",
    name: "toUpperCase",
    description:
      "Convert string to uppercase letters. Transforms all lowercase to uppercase. Common for capitalization and emphasis.",
    category: "string",
  },
  {
    toolId: "code:substring",
    name: "substring",
    description:
      "Extract portion of string between indices. Returns substring from start to end position. Common for text extraction and slicing.",
    category: "string",
  },
  {
    toolId: "code:substr",
    name: "substr",
    description:
      "Extract substring starting at index with specified length. Deprecated but still used. Common for legacy text extraction.",
    category: "string",
  },
  {
    toolId: "code:match",
    name: "match",
    description:
      "Match string against regular expression pattern. Returns array of matches or null. Common for pattern extraction and regex matching.",
    category: "string",
  },
  {
    toolId: "code:matchAll",
    name: "matchAll",
    description:
      "Match all occurrences of regex pattern globally. Returns iterator of all matches. Common for global pattern extraction.",
    category: "string",
  },

  // ============================================================================
  // Object Operations
  // ============================================================================
  {
    toolId: "code:Object.keys",
    name: "Object.keys",
    description:
      "Extract array of object property names. Returns all enumerable keys. Common for object iteration and property listing.",
    category: "object",
  },
  {
    toolId: "code:Object.values",
    name: "Object.values",
    description:
      "Extract array of object property values. Returns all enumerable values. Common for value extraction and data collection.",
    category: "object",
  },
  {
    toolId: "code:Object.entries",
    name: "Object.entries",
    description:
      "Convert object to array of key-value pairs. Returns entries as [key, value] tuples. Common for object transformation and iteration.",
    category: "object",
  },
  {
    toolId: "code:Object.fromEntries",
    name: "Object.fromEntries",
    description:
      "Create object from array of key-value pairs. Inverse of Object.entries. Common for object reconstruction and map conversion.",
    category: "object",
  },
  {
    toolId: "code:Object.assign",
    name: "Object.assign",
    description:
      "Merge multiple objects into target object. Copies properties from sources. Common for object merging and shallow cloning.",
    category: "object",
  },

  // ============================================================================
  // Math Operations
  // ============================================================================
  {
    toolId: "code:Math.max",
    name: "Math.max",
    description:
      "Find maximum value among numbers. Returns largest numeric value. Common for range calculation and peak detection.",
    category: "math",
  },
  {
    toolId: "code:Math.min",
    name: "Math.min",
    description:
      "Find minimum value among numbers. Returns smallest numeric value. Common for range calculation and valley detection.",
    category: "math",
  },
  {
    toolId: "code:Math.abs",
    name: "Math.abs",
    description:
      "Calculate absolute value of number. Removes sign to get magnitude. Common for distance calculation and magnitude comparison.",
    category: "math",
  },
  {
    toolId: "code:Math.floor",
    name: "Math.floor",
    description:
      "Round number down to nearest integer. Truncates decimal portion downward. Common for integer conversion and downward rounding.",
    category: "math",
  },
  {
    toolId: "code:Math.ceil",
    name: "Math.ceil",
    description:
      "Round number up to nearest integer. Truncates decimal portion upward. Common for ceiling calculation and upward rounding.",
    category: "math",
  },
  {
    toolId: "code:Math.round",
    name: "Math.round",
    description:
      "Round number to nearest integer. Uses standard rounding rules. Common for number approximation and rounding.",
    category: "math",
  },

  // ============================================================================
  // JSON Operations
  // ============================================================================
  {
    toolId: "code:JSON.parse",
    name: "JSON.parse",
    description:
      "Parse JSON string into JavaScript object. Deserializes JSON text. Common for data deserialization and API response parsing.",
    category: "json",
  },
  {
    toolId: "code:JSON.stringify",
    name: "JSON.stringify",
    description:
      "Convert JavaScript object to JSON string. Serializes object to text. Common for data serialization and API request formatting.",
    category: "json",
  },

  // ============================================================================
  // Binary Arithmetic Operators
  // ============================================================================
  {
    toolId: "code:add",
    name: "addition",
    description:
      "Add two numbers together. Arithmetic sum operation. Common for accumulation and numeric addition.",
    category: "binary",
  },
  {
    toolId: "code:subtract",
    name: "subtraction",
    description:
      "Subtract second number from first. Arithmetic difference operation. Common for delta calculation and reduction.",
    category: "binary",
  },
  {
    toolId: "code:multiply",
    name: "multiplication",
    description:
      "Multiply two numbers together. Arithmetic product operation. Common for scaling and repeated addition.",
    category: "binary",
  },
  {
    toolId: "code:divide",
    name: "division",
    description:
      "Divide first number by second. Arithmetic quotient operation. Common for ratio calculation and proportioning.",
    category: "binary",
  },
  {
    toolId: "code:modulo",
    name: "modulo",
    description:
      "Calculate remainder of division. Modulo operation for cyclic patterns. Common for cyclical logic and remainder calculation.",
    category: "binary",
  },
  {
    toolId: "code:power",
    name: "exponentiation",
    description:
      "Raise first number to power of second. Exponential operation. Common for power calculation and exponential growth.",
    category: "binary",
  },

  // ============================================================================
  // Binary Comparison Operators
  // ============================================================================
  {
    toolId: "code:equal",
    name: "equality comparison",
    description:
      "Compare two values for equality with type coercion. Loose equality check. Common for flexible comparison.",
    category: "logical",
  },
  {
    toolId: "code:strictEqual",
    name: "strict equality comparison",
    description:
      "Compare two values for equality without type coercion. Strict equality check. Common for precise comparison.",
    category: "logical",
  },
  {
    toolId: "code:notEqual",
    name: "inequality comparison",
    description:
      "Compare two values for inequality with type coercion. Loose inequality check. Common for difference detection.",
    category: "logical",
  },
  {
    toolId: "code:strictNotEqual",
    name: "strict inequality comparison",
    description:
      "Compare two values for inequality without type coercion. Strict inequality check. Common for precise difference detection.",
    category: "logical",
  },
  {
    toolId: "code:lessThan",
    name: "less than comparison",
    description:
      "Test if first value is less than second. Ordinal comparison. Common for sorting and range checking.",
    category: "logical",
  },
  {
    toolId: "code:lessThanOrEqual",
    name: "less than or equal comparison",
    description:
      "Test if first value is less than or equal to second. Inclusive lower bound. Common for range validation.",
    category: "logical",
  },
  {
    toolId: "code:greaterThan",
    name: "greater than comparison",
    description:
      "Test if first value is greater than second. Ordinal comparison. Common for threshold checking.",
    category: "logical",
  },
  {
    toolId: "code:greaterThanOrEqual",
    name: "greater than or equal comparison",
    description:
      "Test if first value is greater than or equal to second. Inclusive upper bound. Common for minimum validation.",
    category: "logical",
  },

  // ============================================================================
  // Logical Operators
  // ============================================================================
  {
    toolId: "code:and",
    name: "logical AND",
    description:
      "Logical AND operation between two boolean values. Returns true only if both are true. Common for condition combining.",
    category: "logical",
  },
  {
    toolId: "code:or",
    name: "logical OR",
    description:
      "Logical OR operation between two boolean values. Returns true if either is true. Common for alternative conditions.",
    category: "logical",
  },

  // ============================================================================
  // Bitwise Operators
  // ============================================================================
  {
    toolId: "code:bitwiseAnd",
    name: "bitwise AND",
    description:
      "Bitwise AND operation on integer bits. Performs AND on each bit pair. Common for bit masking and flags.",
    category: "bitwise",
  },
  {
    toolId: "code:bitwiseOr",
    name: "bitwise OR",
    description:
      "Bitwise OR operation on integer bits. Performs OR on each bit pair. Common for bit setting and flags.",
    category: "bitwise",
  },
  {
    toolId: "code:bitwiseXor",
    name: "bitwise XOR",
    description:
      "Bitwise XOR operation on integer bits. Performs exclusive OR on each bit pair. Common for bit toggling and encryption.",
    category: "bitwise",
  },
  {
    toolId: "code:leftShift",
    name: "left bit shift",
    description:
      "Shift bits left by specified positions. Multiplies by powers of 2. Common for bit manipulation and fast multiplication.",
    category: "bitwise",
  },
  {
    toolId: "code:rightShift",
    name: "right bit shift",
    description:
      "Shift bits right by specified positions preserving sign. Divides by powers of 2. Common for bit manipulation and fast division.",
    category: "bitwise",
  },
  {
    toolId: "code:unsignedRightShift",
    name: "unsigned right bit shift",
    description:
      "Shift bits right by specified positions without sign preservation. Zero-fill right shift. Common for unsigned bit operations.",
    category: "bitwise",
  },
];

/**
 * Get description for a code operation
 */
export function getOperationDescription(toolId: string): OperationDescription | undefined {
  return OPERATION_DESCRIPTIONS.find((op) => op.toolId === toolId);
}

/**
 * Get all operations in a category
 */
export function getOperationsByCategory(
  category: OperationDescription["category"],
): OperationDescription[] {
  return OPERATION_DESCRIPTIONS.filter((op) => op.category === category);
}

/**
 * Get category for a code operation
 *
 * @param toolId Tool identifier (e.g., "code:filter")
 * @returns Category (e.g., "array"), or undefined if not found
 */
export function getOperationCategory(toolId: string): OperationDescription["category"] | undefined {
  const op = getOperationDescription(toolId);
  return op?.category;
}
