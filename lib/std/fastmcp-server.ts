/**
 * FastMCP Server for lib/std MiniTools
 *
 * Wraps the existing MiniTools library in a FastMCP server.
 * Provides automatic JSON Schema → Zod conversion and type-safe execution.
 *
 * Usage:
 *   deno run --allow-all lib/std/fastmcp-server.ts --http --port=3005
 *   deno run --allow-all lib/std/fastmcp-server.ts  # stdio mode
 *
 * @module lib/std/fastmcp-server
 */

import { FastMCP } from "fastmcp";
import { z } from "zod";
import { allTools, toolsByCategory } from "./mod.ts";
import type { MiniTool } from "./types.ts";

/**
 * Convert JSON Schema to Zod schema
 *
 * FastMCP uses Zod for schema validation, but our MiniTools use JSON Schema.
 * This converts common JSON Schema patterns to Zod equivalents.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const type = schema.type as string | undefined;
  const required = (schema.required as string[]) || [];
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;

  // Handle object type (most common for tool inputs)
  if (type === "object" && properties) {
    const shape: Record<string, z.ZodType> = {};

    for (const [key, propSchema] of Object.entries(properties)) {
      let fieldSchema = convertProperty(propSchema);

      // Mark as optional if not in required array
      if (!required.includes(key)) {
        fieldSchema = fieldSchema.optional();
      }

      shape[key] = fieldSchema;
    }

    return z.object(shape);
  }

  // Fallback: accept any object
  return z.object({}).passthrough();
}

/**
 * Convert a single JSON Schema property to Zod
 */
function convertProperty(prop: Record<string, unknown>): z.ZodType {
  const type = prop.type as string | undefined;
  const description = prop.description as string | undefined;

  let schema: z.ZodType;

  switch (type) {
    case "string":
      schema = z.string();
      break;
    case "number":
    case "integer":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      if (items) {
        schema = z.array(convertProperty(items));
      } else {
        schema = z.array(z.unknown());
      }
      break;
    }
    case "object":
      schema = z.record(z.unknown());
      break;
    default:
      // No type specified - accept anything
      schema = z.unknown();
  }

  // Add description if present
  if (description) {
    schema = schema.describe(description);
  }

  return schema;
}

/**
 * Create FastMCP server with all MiniTools
 */
export function createStdLibServer(options?: {
  categories?: string[];
  name?: string;
  version?: `${number}.${number}.${number}`;
}): FastMCP {
  const server = new FastMCP({
    name: options?.name ?? "pml-std-lib",
    version: options?.version ?? "1.0.0" as const,
  });

  // Get tools based on categories filter
  let tools: MiniTool[];
  if (options?.categories && options.categories.length > 0) {
    tools = options.categories.flatMap((cat) => toolsByCategory[cat] || []);
  } else {
    tools = allTools;
  }

  // Register each MiniTool as a FastMCP tool
  for (const tool of tools) {
    try {
      const zodSchema = jsonSchemaToZod(tool.inputSchema);

      server.addTool({
        name: tool.name,
        description: tool.description,
        parameters: zodSchema as z.ZodObject<Record<string, z.ZodType>>,
        execute: async (args) => {
          try {
            const result = await tool.handler(args as Record<string, unknown>);
            return typeof result === "string" ? result : JSON.stringify(result, null, 2);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return JSON.stringify({ error: message }, null, 2);
          }
        },
      });
    } catch (error) {
      // Skip tools that fail to convert (complex schemas)
      console.error(`[FastMCP] Failed to register tool ${tool.name}:`, error);
    }
  }

  return server;
}

/**
 * Start the FastMCP server
 */
export async function startStdLibServer(options: {
  transport: "stdio" | "httpStream";
  port?: number;
  categories?: string[];
}): Promise<void> {
  const server = createStdLibServer({ categories: options.categories });

  console.error(`[FastMCP] Registered ${allTools.length} tools from lib/std`);

  if (options.transport === "stdio") {
    await server.start({ transportType: "stdio" });
  } else {
    await server.start({
      transportType: "httpStream",
      httpStream: { port: options.port ?? 3005 },
    });
  }
}

// CLI entry point
if (import.meta.main) {
  const args = Deno.args;

  // Parse transport type
  let transport: "stdio" | "httpStream" | "sse" = "stdio";
  if (args.includes("--http")) {
    transport = "httpStream";
  } else if (args.includes("--sse")) {
    transport = "sse";
  }

  // Parse port
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = portArg ? parseInt(portArg.split("=")[1]) : 3005;

  // Parse categories filter
  const categoriesArg = args.find((a) => a.startsWith("--categories="));
  const categories = categoriesArg ? categoriesArg.split("=")[1].split(",") : undefined;

  console.error(`[FastMCP] Starting std-lib server`);
  console.error(`  Transport: ${transport}`);
  if (transport !== "stdio") {
    console.error(`  Port: ${port}`);
  }
  if (categories) {
    console.error(`  Categories: ${categories.join(", ")}`);
  }

  startStdLibServer({ transport, port, categories });
}

export { allTools, toolsByCategory };
