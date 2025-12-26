/**
 * Schema Inferrer (Epic 7 - Story 7.2b)
 *
 * Automatically infers parameter schemas from TypeScript code using SWC AST parser.
 * Analyzes `args.xxx` accesses and destructuring to build JSON Schema for capability parameters.
 *
 * @module capabilities/schema-inferrer
 */

import { parse } from "https://deno.land/x/swc@0.2.1/mod.ts";
import type { DbClient } from "../db/types.ts";
import type { JSONSchema } from "./types.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Property discovered in args access
 */
interface ArgsProperty {
  name: string;
  inferredType: "string" | "number" | "boolean" | "array" | "object" | "unknown";
  source: "mcp_tool" | "operation" | "comparison" | "destructure" | "unknown";
  isOptional: boolean;
}

/**
 * SchemaInferrer - Infers parameter schemas from TypeScript code
 *
 * Uses SWC (Rust-based parser) to analyze code and detect args usage patterns.
 * Infers types from:
 * 1. MCP tool parameter schemas (database lookup)
 * 2. Operations/comparisons (e.g., args.count > 0 → number)
 * 3. Property access (e.g., args.items.length → array)
 *
 * @example
 * ```typescript
 * const inferrer = new SchemaInferrer(db);
 * const schema = await inferrer.inferSchema(`
 *   const content = await mcp.filesystem.read({ path: args.filePath });
 *   if (args.debug) console.log(content);
 * `);
 * // Returns:
 * // {
 * //   "$schema": "http://json-schema.org/draft-07/schema#",
 * //   "type": "object",
 * //   "properties": {
 * //     "filePath": { "type": "string" },
 * //     "debug": { "type": "boolean" }
 * //   },
 * //   "required": ["filePath"]
 * // }
 * ```
 */
export class SchemaInferrer {
  constructor(private db: DbClient) {
    logger.debug("SchemaInferrer initialized");
  }

  /**
   * Infer parameter schema from TypeScript code
   *
   * @param code TypeScript code to analyze
   * @returns JSON Schema describing expected parameters
   */
  async inferSchema(code: string): Promise<JSONSchema> {
    try {
      // Wrap code in function if not already (for valid parsing)
      const wrappedCode = this.wrapCodeIfNeeded(code);

      // Parse with SWC
      const ast = await parse(wrappedCode, {
        syntax: "typescript",
        comments: false,
        script: true,
      });

      logger.debug("Code parsed successfully", {
        codeLength: code.length,
      });

      // Find all args accesses
      const argsProps = this.findArgsAccesses(ast);

      logger.debug("Args properties detected", {
        count: argsProps.length,
        properties: argsProps.map((p) => p.name),
      });

      // Infer types for each property
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];

      for (const prop of argsProps) {
        const type = await this.inferType(prop, ast);
        properties[prop.name] = type;

        // Mark as required if not optional
        if (!prop.isOptional) {
          required.push(prop.name);
        }
      }

      const schema: JSONSchema = {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties,
      };

      if (required.length > 0) {
        schema.required = required;
      }

      logger.debug("Schema inferred", {
        propertyCount: Object.keys(properties).length,
        requiredCount: required.length,
      });

      return schema;
    } catch (error) {
      // Non-critical: return empty schema on parse errors
      logger.warn("Schema inference failed, returning empty schema", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {},
      };
    }
  }

  /**
   * Wrap code in function if needed for valid parsing
   */
  private wrapCodeIfNeeded(code: string): string {
    // Check if code already contains function/class/export declarations
    if (
      code.includes("function ") ||
      code.includes("class ") ||
      code.includes("export ")
    ) {
      return code;
    }

    // Wrap in async function for valid parsing
    return `async function _agentCardsWrapper() {\n${code}\n}`;
  }

  /**
   * Find all args accesses in the AST
   */
  private findArgsAccesses(
    node: unknown,
    props: Map<string, ArgsProperty> = new Map(),
  ): ArgsProperty[] {
    if (!node || typeof node !== "object") {
      return Array.from(props.values());
    }

    const n = node as Record<string, unknown>;

    // MemberExpression: args.xxx
    if (n.type === "MemberExpression") {
      this.handleMemberExpression(n, props);
    }

    // OptionalChainingExpression: args?.xxx
    if (n.type === "OptionalChainingExpression") {
      this.handleOptionalChaining(n, props);
    }

    // VariableDeclarator: const { a, b } = args
    if (n.type === "VariableDeclarator") {
      this.handleVariableDeclarator(n, props);
    }

    // Recurse through AST
    for (const key of Object.keys(n)) {
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          this.findArgsAccesses(item, props);
        }
      } else if (typeof val === "object" && val !== null) {
        this.findArgsAccesses(val, props);
      }
    }

    return Array.from(props.values());
  }

  /**
   * Handle MemberExpression: args.xxx
   */
  private handleMemberExpression(
    n: Record<string, unknown>,
    props: Map<string, ArgsProperty>,
  ): void {
    const obj = n.object as Record<string, unknown> | undefined;
    const prop = n.property as Record<string, unknown> | undefined;

    // Direct access: args.xxx
    if (
      obj?.type === "Identifier" &&
      obj?.value === "args" &&
      prop?.type === "Identifier" &&
      typeof prop?.value === "string"
    ) {
      const propName = prop.value;
      if (!props.has(propName)) {
        props.set(propName, {
          name: propName,
          inferredType: "unknown",
          source: "unknown",
          isOptional: false,
        });
      }
    }

    // Nested access: args.config.timeout → mark 'config' as object
    if (
      obj?.type === "MemberExpression" &&
      prop?.type === "Identifier" &&
      typeof prop?.value === "string"
    ) {
      const innerObj = (obj as Record<string, unknown>).object as
        | Record<string, unknown>
        | undefined;
      const innerProp = (obj as Record<string, unknown>).property as
        | Record<string, unknown>
        | undefined;

      if (
        innerObj?.type === "Identifier" &&
        innerObj?.value === "args" &&
        innerProp?.type === "Identifier" &&
        typeof innerProp?.value === "string"
      ) {
        const propName = innerProp.value;
        if (!props.has(propName)) {
          props.set(propName, {
            name: propName,
            inferredType: "object",
            source: "operation",
            isOptional: false,
          });
        } else {
          // Update existing to object if not already inferred
          const existing = props.get(propName)!;
          if (existing.inferredType === "unknown") {
            existing.inferredType = "object";
            existing.source = "operation";
          }
        }
      }
    }
  }

  /**
   * Handle OptionalChainingExpression: args?.xxx or args.config?.timeout
   */
  private handleOptionalChaining(
    n: Record<string, unknown>,
    props: Map<string, ArgsProperty>,
  ): void {
    const base = n.base as Record<string, unknown> | undefined;

    if (base?.type === "MemberExpression") {
      const obj = (base as Record<string, unknown>).object as
        | Record<string, unknown>
        | undefined;
      const prop = (base as Record<string, unknown>).property as
        | Record<string, unknown>
        | undefined;

      // Direct optional: args?.xxx
      if (
        obj?.type === "Identifier" &&
        obj?.value === "args" &&
        prop?.type === "Identifier" &&
        typeof prop?.value === "string"
      ) {
        const propName = prop.value;
        if (!props.has(propName)) {
          props.set(propName, {
            name: propName,
            inferredType: "unknown",
            source: "unknown",
            isOptional: true, // Optional chaining = optional property
          });
        } else {
          // Mark existing as optional
          props.get(propName)!.isOptional = true;
        }
      }

      // Nested optional: args.config?.timeout
      // The object is another MemberExpression: args.config
      if (obj?.type === "MemberExpression") {
        const innerObj = (obj as Record<string, unknown>).object as
          | Record<string, unknown>
          | undefined;
        const innerProp = (obj as Record<string, unknown>).property as
          | Record<string, unknown>
          | undefined;

        if (
          innerObj?.type === "Identifier" &&
          innerObj?.value === "args" &&
          innerProp?.type === "Identifier" &&
          typeof innerProp?.value === "string"
        ) {
          const propName = innerProp.value;
          if (!props.has(propName)) {
            props.set(propName, {
              name: propName,
              inferredType: "object", // Nested access means it's an object
              source: "operation",
              isOptional: true, // Because of ?.
            });
          } else {
            // Mark existing as optional
            props.get(propName)!.isOptional = true;
          }
        }
      }
    }
  }

  /**
   * Handle VariableDeclarator: const { a, b } = args
   */
  private handleVariableDeclarator(
    n: Record<string, unknown>,
    props: Map<string, ArgsProperty>,
  ): void {
    const id = n.id as Record<string, unknown> | undefined;
    const init = n.init as Record<string, unknown> | undefined;

    // Check if destructuring from args
    if (
      id?.type === "ObjectPattern" &&
      init?.type === "Identifier" &&
      init?.value === "args"
    ) {
      const objProps = (id.properties || []) as Array<Record<string, unknown>>;

      for (const p of objProps) {
        const key = p.key as Record<string, unknown> | undefined;
        if (key?.type === "Identifier" && typeof key?.value === "string") {
          const propName = key.value;
          if (!props.has(propName)) {
            props.set(propName, {
              name: propName,
              inferredType: "unknown",
              source: "destructure",
              isOptional: false,
            });
          }
        }
      }
    }
  }

  /**
   * Infer type for a property
   */
  private async inferType(
    prop: ArgsProperty,
    ast: unknown,
  ): Promise<JSONSchema> {
    // 1. Try to infer from MCP tool call
    const mcpType = await this.inferFromMCPCall(prop.name, ast);
    if (mcpType) {
      logger.debug("Type inferred from MCP tool", {
        property: prop.name,
        type: mcpType.type,
      });
      return mcpType;
    }

    // 2. Try to infer from operations/comparisons
    const opType = this.inferFromOperations(prop.name, ast);
    if (opType) {
      logger.debug("Type inferred from operations", {
        property: prop.name,
        type: opType.type,
      });
      return opType;
    }

    // 3. Use property's inferred type if available
    if (prop.inferredType !== "unknown") {
      return { type: prop.inferredType };
    }

    // 4. Fallback to empty schema (accepts any type)
    // Note: JSON Schema spec doesn't have "unknown" type
    // Empty schema {} means "no constraints" (accepts anything)
    logger.debug("Type inference fallback to unconstrained schema", {
      property: prop.name,
    });
    return {};
  }

  /**
   * Infer type from MCP tool call parameters
   *
   * Example: fs.read({ path: args.filePath }) → infer filePath: string from tool schema
   */
  private async inferFromMCPCall(
    propName: string,
    ast: unknown,
  ): Promise<JSONSchema | null> {
    // Find CallExpression where args.propName is passed to MCP tool
    const callSites = this.findCallSitesForProperty(propName, ast);

    for (const callSite of callSites) {
      // Extract tool name from call (e.g., "mcp.filesystem.read" → "filesystem_read")
      const toolName = this.extractToolName(callSite);
      if (!toolName) continue;

      // Query database for tool schema
      try {
        const result = await this.db.query(
          `SELECT input_schema FROM tool_schema WHERE tool_id = $1`,
          [toolName],
        );

        if (result.length > 0) {
          const inputSchema = result[0].input_schema as Record<string, unknown>;
          const properties = inputSchema.properties as
            | Record<string, unknown>
            | undefined;

          if (properties) {
            // Find the parameter that matches our property
            const paramName = this.findMatchingParameter(propName, callSite);
            if (paramName && properties[paramName]) {
              const paramSchema = properties[paramName] as Record<string, unknown>;
              return {
                type: paramSchema.type as string,
                description: paramSchema.description as string | undefined,
              };
            }
          }
        }
      } catch (error) {
        logger.warn("Failed to query tool schema", {
          toolName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  /**
   * Find all call sites where a property is used
   */
  private findCallSitesForProperty(
    propName: string,
    node: unknown,
    callSites: Record<string, unknown>[] = [],
  ): Record<string, unknown>[] {
    if (!node || typeof node !== "object") {
      return callSites;
    }

    const n = node as Record<string, unknown>;

    // Look for CallExpression with ObjectExpression argument containing args.propName
    if (n.type === "CallExpression") {
      const args = (n.arguments || []) as Array<Record<string, unknown>>;

      for (const arg of args) {
        if (arg.type === "ObjectExpression") {
          const props = (arg.properties || []) as Array<Record<string, unknown>>;

          for (const p of props) {
            const value = p.value as Record<string, unknown> | undefined;

            // Check if value is args.propName
            if (
              value?.type === "MemberExpression" &&
              (value.object as Record<string, unknown>)?.type === "Identifier" &&
              (value.object as Record<string, unknown>)?.value === "args" &&
              (value.property as Record<string, unknown>)?.type === "Identifier" &&
              (value.property as Record<string, unknown>)?.value === propName
            ) {
              callSites.push(n);
            }
          }
        }
      }
    }

    // Recurse
    for (const key of Object.keys(n)) {
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          this.findCallSitesForProperty(propName, item, callSites);
        }
      } else if (typeof val === "object" && val !== null) {
        this.findCallSitesForProperty(propName, val, callSites);
      }
    }

    return callSites;
  }

  /**
   * Extract tool name from CallExpression
   *
   * Example: mcp.filesystem.read → "filesystem_read"
   */
  private extractToolName(callSite: Record<string, unknown>): string | null {
    const callee = callSite.callee as Record<string, unknown> | undefined;

    if (!callee) return null;

    // Handle MemberExpression: mcp.filesystem.read
    if (callee.type === "MemberExpression") {
      const parts: string[] = [];
      let current: Record<string, unknown> | undefined = callee;

      while (current?.type === "MemberExpression") {
        const prop = current.property as Record<string, unknown> | undefined;
        if (prop?.type === "Identifier" && typeof prop?.value === "string") {
          parts.unshift(prop.value);
        }
        current = current.object as Record<string, unknown> | undefined;
      }

      // Filter out "mcp" prefix if present
      const filtered = parts.filter((p) => p !== "mcp");
      return filtered.join("_");
    }

    return null;
  }

  /**
   * Find matching parameter name in call site
   */
  private findMatchingParameter(
    propName: string,
    callSite: Record<string, unknown>,
  ): string | null {
    const args = (callSite.arguments || []) as Array<Record<string, unknown>>;

    for (const arg of args) {
      if (arg.type === "ObjectExpression") {
        const props = (arg.properties || []) as Array<Record<string, unknown>>;

        for (const p of props) {
          const value = p.value as Record<string, unknown> | undefined;
          const key = p.key as Record<string, unknown> | undefined;

          // Check if value is args.propName
          if (
            value?.type === "MemberExpression" &&
            (value.object as Record<string, unknown>)?.type === "Identifier" &&
            (value.object as Record<string, unknown>)?.value === "args" &&
            (value.property as Record<string, unknown>)?.type === "Identifier" &&
            (value.property as Record<string, unknown>)?.value === propName
          ) {
            // Return the parameter name from the key
            if (key?.type === "Identifier" && typeof key?.value === "string") {
              return key.value;
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Infer type from operations and comparisons
   */
  private inferFromOperations(
    propName: string,
    node: unknown,
  ): JSONSchema | null {
    const usages = this.findPropertyUsages(propName, node);

    for (const usage of usages) {
      // Boolean comparison: args.enabled === true
      if (
        usage.type === "BinaryExpression" &&
        (usage.operator === "===" || usage.operator === "!==")
      ) {
        const right = usage.right as Record<string, unknown> | undefined;
        if (
          right?.type === "BooleanLiteral" ||
          (right?.type === "Identifier" &&
            (right.value === "true" || right.value === "false"))
        ) {
          return { type: "boolean" };
        }
      }

      // Numeric comparison: args.count > 0
      if (
        usage.type === "BinaryExpression" &&
        (usage.operator === ">" ||
          usage.operator === "<" ||
          usage.operator === ">=" ||
          usage.operator === "<=")
      ) {
        return { type: "number" };
      }

      // Array property access: args.items.length
      if (usage.type === "MemberExpression") {
        const prop = usage.property as Record<string, unknown> | undefined;
        if (prop?.type === "Identifier" && prop?.value === "length") {
          return { type: "array" };
        }

        // String methods: args.name.toLowerCase()
        if (
          prop?.type === "Identifier" &&
          typeof prop?.value === "string" &&
          [
            "toLowerCase",
            "toUpperCase",
            "trim",
            "split",
            "substring",
            "charAt",
          ].includes(prop.value)
        ) {
          return { type: "string" };
        }
      }
    }

    return null;
  }

  /**
   * Find all usages of a property
   */
  private findPropertyUsages(
    propName: string,
    node: unknown,
    usages: Record<string, unknown>[] = [],
  ): Record<string, unknown>[] {
    if (!node || typeof node !== "object") {
      return usages;
    }

    const n = node as Record<string, unknown>;

    // Look for any node that contains args.propName
    if (n.type === "BinaryExpression" || n.type === "MemberExpression") {
      const containsProperty = this.containsArgsProperty(propName, n);
      if (containsProperty) {
        usages.push(n);
      }
    }

    // Recurse
    for (const key of Object.keys(n)) {
      const val = n[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          this.findPropertyUsages(propName, item, usages);
        }
      } else if (typeof val === "object" && val !== null) {
        this.findPropertyUsages(propName, val, usages);
      }
    }

    return usages;
  }

  /**
   * Check if node contains args.propName
   */
  private containsArgsProperty(
    propName: string,
    node: Record<string, unknown>,
  ): boolean {
    if (node.type === "MemberExpression") {
      const obj = node.object as Record<string, unknown> | undefined;
      const prop = node.property as Record<string, unknown> | undefined;

      if (
        obj?.type === "Identifier" &&
        obj?.value === "args" &&
        prop?.type === "Identifier" &&
        prop?.value === propName
      ) {
        return true;
      }

      // Check nested
      if (obj?.type === "MemberExpression") {
        return this.containsArgsProperty(propName, obj);
      }
    }

    // Check left and right for BinaryExpression
    if (node.type === "BinaryExpression") {
      const left = node.left as Record<string, unknown> | undefined;
      const right = node.right as Record<string, unknown> | undefined;

      if (left && this.containsArgsProperty(propName, left)) {
        return true;
      }
      if (right && this.containsArgsProperty(propName, right)) {
        return true;
      }
    }

    return false;
  }
}
