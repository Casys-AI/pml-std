/**
 * Agent tools - LLM-powered decision and analysis via MCP Sampling
 *
 * Ces outils utilisent MCP Sampling pour déléguer des tâches à un LLM.
 * En Claude Code, le sampling est natif (zéro config).
 * En local/cloud, nécessite SAMPLING_PROVIDER + SAMPLING_API_KEY.
 *
 * @module lib/std/agent
 */

import type { MiniTool } from "./types.ts";

// =============================================================================
// Sampling Client Interface
// =============================================================================

/**
 * Interface pour le client de sampling MCP
 * Sera injecté par le serveur MCP au runtime
 *
 * Per MCP Spec (SEP-1577 - Nov 2025):
 * - Server sends sampling/createMessage with optional tools
 * - Client handles LLM call AND tool execution (agentic loop)
 * - Client returns final result after loop completes
 *
 * This means tool calls during sampling ARE traced by the client's RPC!
 */
interface SamplingClient {
  createMessage(params: {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    /** Tools available for the agent to use. Client handles execution. */
    tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    /** "auto" = LLM decides, "required" = must use tool, "none" = no tools */
    toolChoice?: "auto" | "required" | "none";
    maxTokens?: number;
    /** Hint for client: max agentic loop iterations */
    maxIterations?: number;
    /** Tool name patterns to filter (e.g., ['git_*', 'vfs_*']) */
    allowedToolPatterns?: string[];
  }): Promise<{
    content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
    stopReason: "end_turn" | "tool_use" | "max_tokens";
  }>;
}

// Global sampling client - set by mcp-tools-server.ts at init
let _samplingClient: SamplingClient | null = null;

/**
 * Set the sampling client (called by mcp-tools-server.ts)
 */
export function setSamplingClient(client: SamplingClient): void {
  _samplingClient = client;
}

/**
 * Get the sampling client, throw if not available
 */
function getSamplingClient(): SamplingClient {
  if (!_samplingClient) {
    throw new Error(
      "Sampling client not available. " +
        "Configure SAMPLING_PROVIDER in mcp-servers.json or use Claude Code.",
    );
  }
  return _samplingClient;
}

// =============================================================================
// Agentic Loop Implementation
// =============================================================================

/**
 * PML API base URL - configurable via environment variable
 */
const PML_API_URL = typeof Deno !== "undefined"
  ? Deno.env.get("PML_API_URL") || "http://localhost:3003"
  : "http://localhost:3003";

/**
 * PML tool definition for agent agentic loop
 *
 * This is the ONLY tool exposed to the LLM during agent_delegate calls.
 * The LLM describes what it wants to do, and PML handles discovery + execution.
 */
const pmlExecuteTool = {
  name: "pml_execute",
  description:
    "Execute any task using PML. Describe what you want to accomplish in natural language. " +
    "PML will discover the right tools and execute them. You can also provide explicit code.",
  input_schema: {
    type: "object" as const,
    properties: {
      intent: {
        type: "string",
        description: "Natural language description of what to do. Required.",
      },
      code: {
        type: "string",
        description:
          "Optional: explicit mcp.* code. Example: 'return await mcp.filesystem.read_file({path: \"config.json\"});'",
      },
    },
    required: ["intent"],
  },
};

/**
 * Execute a tool via PML API
 *
 * Requires PML_API_KEY env var for authentication in cloud mode.
 * In local mode (no GITHUB_CLIENT_ID), auth is bypassed.
 */
async function executePmlTool(input: {
  intent: string;
  code?: string;
}): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    // Build headers with optional API key
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiKey = typeof Deno !== "undefined" ? Deno.env.get("PML_API_KEY") : undefined;
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const response = await fetch(`${PML_API_URL}/api/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "pml:execute",
          arguments: { intent: input.intent, code: input.code },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `PML API error: ${response.status} ${errorText}` };
    }

    const data = await response.json();
    if (data.error) {
      return { success: false, error: data.error.message || JSON.stringify(data.error) };
    }

    const result = data.result;
    if (result?.content?.[0]?.text) {
      try {
        return { success: true, result: JSON.parse(result.content[0].text) };
      } catch {
        return { success: true, result: result.content[0].text };
      }
    }
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Anthropic agentic loop implementation
 */
async function runAnthropicAgenticLoop(params: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  maxIterations: number;
  apiKey: string;
  model: string;
}): Promise<{
  content: Array<{ type: string; text?: string }>;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}> {
  type ContentBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
  type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
  type MessageContent = string | Array<ContentBlock | ToolResultBlock>;

  const messages: Array<{ role: "user" | "assistant"; content: MessageContent }> = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  for (let iteration = 0; iteration < params.maxIterations; iteration++) {
    console.error(`[agent] Anthropic agentic loop iteration ${iteration + 1}/${params.maxIterations}`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": params.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens,
        messages,
        tools: [pmlExecuteTool],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    const stopReason = data.stop_reason as "end_turn" | "tool_use" | "max_tokens";
    const content = data.content as ContentBlock[];

    if (stopReason !== "tool_use") {
      console.error(`[agent] Anthropic loop ended: ${stopReason}`);
      return { content, stopReason: stopReason === "end_turn" ? "end_turn" : "max_tokens" };
    }

    const toolCalls = content.filter((c): c is ContentBlock & { type: "tool_use" } => c.type === "tool_use");
    if (toolCalls.length === 0) {
      return { content, stopReason: "tool_use" };
    }

    messages.push({ role: "assistant", content });

    const toolResults: ToolResultBlock[] = [];
    for (const toolCall of toolCalls) {
      console.error(`[agent] Executing: ${toolCall.name}`, toolCall.input);
      if (toolCall.name === "pml_execute") {
        const pmlResult = await executePmlTool(toolCall.input as { intent: string; code?: string });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: JSON.stringify(pmlResult),
          is_error: !pmlResult.success,
        });
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }),
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  console.error("[agent] Anthropic loop: max iterations reached");
  return {
    content: [{ type: "text", text: "Max iterations reached without completing the task." }],
    stopReason: "max_tokens",
  };
}

/**
 * OpenAI agentic loop implementation
 */
async function runOpenAIAgenticLoop(params: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  maxIterations: number;
  apiKey: string;
  model: string;
}): Promise<{
  content: Array<{ type: string; text?: string }>;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}> {
  // OpenAI message format
  type OpenAIMessage =
    | { role: "user" | "assistant" | "system"; content: string }
    | { role: "assistant"; content: string | null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
    | { role: "tool"; tool_call_id: string; content: string };

  const messages: OpenAIMessage[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // OpenAI tool format
  const tools = [{
    type: "function" as const,
    function: {
      name: pmlExecuteTool.name,
      description: pmlExecuteTool.description,
      parameters: pmlExecuteTool.input_schema,
    },
  }];

  for (let iteration = 0; iteration < params.maxIterations; iteration++) {
    console.error(`[agent] OpenAI agentic loop iteration ${iteration + 1}/${params.maxIterations}`);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens,
        messages,
        tools,
        tool_choice: "auto",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    const choice = data.choices[0];
    const finishReason = choice.finish_reason;
    const message = choice.message;

    // No tool calls - return the result
    if (finishReason !== "tool_calls" || !message.tool_calls || message.tool_calls.length === 0) {
      console.error(`[agent] OpenAI loop ended: ${finishReason}`);
      return {
        content: [{ type: "text", text: message.content || "" }],
        stopReason: finishReason === "stop" ? "end_turn" : "max_tokens",
      };
    }

    // Add assistant message with tool calls
    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls,
    });

    // Execute each tool call
    for (const toolCall of message.tool_calls) {
      const functionName = toolCall.function.name;
      let functionArgs: Record<string, unknown>;

      try {
        functionArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        functionArgs = { intent: toolCall.function.arguments };
      }

      console.error(`[agent] Executing: ${functionName}`, functionArgs);

      if (functionName === "pml_execute") {
        const pmlResult = await executePmlTool(functionArgs as { intent: string; code?: string });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(pmlResult),
        });
      } else {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: `Unknown tool: ${functionName}` }),
        });
      }
    }
  }

  console.error("[agent] OpenAI loop: max iterations reached");
  return {
    content: [{ type: "text", text: "Max iterations reached without completing the task." }],
    stopReason: "max_tokens",
  };
}

/**
 * Create an agentic sampling client that implements the full agentic loop
 *
 * Supports both Anthropic and OpenAI APIs.
 * The client handles tool execution via PML recursive calls.
 */
export function createAgenticSamplingClient(): SamplingClient {
  return {
    async createMessage(params) {
      const anthropicKey = typeof Deno !== "undefined" ? Deno.env.get("ANTHROPIC_API_KEY") : undefined;
      const openaiKey = typeof Deno !== "undefined" ? Deno.env.get("OPENAI_API_KEY") : undefined;

      const maxTokens = params.maxTokens || 4096;
      const maxIterations = params.maxIterations || 5;
      const enableTools = params.toolChoice !== "none";

      // If no tools requested, just do a simple call
      if (!enableTools) {
        if (anthropicKey) {
          const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": anthropicKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-20250514",
              max_tokens: maxTokens,
              messages: params.messages,
            }),
          });
          if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);
          const data = await response.json();
          return { content: data.content, stopReason: data.stop_reason === "end_turn" ? "end_turn" : "max_tokens" };
        }
        if (openaiKey) {
          const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey}` },
            body: JSON.stringify({
              model: Deno.env.get("OPENAI_MODEL") || "gpt-4.1",
              max_tokens: maxTokens,
              messages: params.messages,
            }),
          });
          if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
          const data = await response.json();
          return {
            content: [{ type: "text", text: data.choices[0].message.content }],
            stopReason: data.choices[0].finish_reason === "stop" ? "end_turn" : "max_tokens",
          };
        }
        throw new Error("No LLM API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
      }

      // Tools requested - run agentic loop
      if (anthropicKey) {
        return runAnthropicAgenticLoop({
          messages: params.messages,
          maxTokens,
          maxIterations,
          apiKey: anthropicKey,
          model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-20250514",
        });
      }

      if (openaiKey) {
        return runOpenAIAgenticLoop({
          messages: params.messages,
          maxTokens,
          maxIterations,
          apiKey: openaiKey,
          model: Deno.env.get("OPENAI_MODEL") || "gpt-4.1",
        });
      }

      throw new Error("No LLM API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
    },
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract text from sampling response
 */
function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

/**
 * Try to parse JSON from text, return text if parsing fails
 */
function tryParseJSON(text: string): unknown {
  // Try to find JSON in markdown code blocks
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    return text;
  }
}

// =============================================================================
// Agent Tools
// =============================================================================

export const agentTools: MiniTool[] = [
  // -------------------------------------------------------------------------
  // agent_delegate - Full agentic loop with tool access
  // -------------------------------------------------------------------------
  // NOTE: Per MCP spec (SEP-1577), when tools are provided in sampling request,
  // the CLIENT handles tool execution (traced via RPC). The server just sends
  // the request and receives the final result.
  //
  // In Claude Code: Native support, tools executed by Claude Code (traced)
  // In Local/Cloud: Client must implement tool execution handler
  // -------------------------------------------------------------------------
  {
    name: "agent_delegate",
    description:
      "Delegate a complex sub-task to an autonomous agent. The agent can make multiple decisions and call tools to accomplish the goal. Use for multi-step tasks requiring reasoning and tool use. The MCP client handles the agentic loop and tool execution. Keywords: agent, delegate, autonomous, sub-task, agentic, loop, multi-step, spawn, subprocess, llm, ai, assistant, worker, task, orchestrate, subagent.",
    category: "agent" as any,
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "What the agent should accomplish",
        },
        context: {
          type: "object",
          description: "Context data for the agent",
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            "Tool name patterns the agent can use (e.g., ['git_*', 'vfs_*']). The client will filter available tools.",
        },
        maxIterations: {
          type: "number",
          description: "Maximum agentic loop iterations (default: 5). Passed to client as hint.",
        },
      },
      required: ["goal"],
    },
    handler: async ({ goal, context, allowedTools, maxIterations = 5 }) => {
      const client = getSamplingClient();

      // Build the prompt with goal and context
      const systemPrompt = `You are an autonomous agent. Your goal: ${goal}

${context ? `Context:\n${JSON.stringify(context, null, 2)}` : ""}

${
        allowedTools
          ? `You may use these tools: ${(allowedTools as string[]).join(", ")}`
          : "You may use any available tools."
      }

Work step by step. When you have completed the goal, provide your final answer.`;

      // Per MCP spec: Send sampling request with tools parameter
      // The CLIENT handles the agentic loop:
      // 1. Client calls LLM with tools
      // 2. If tool_use → Client executes tools (traced!) → continues
      // 3. Repeat until end_turn or max iterations
      // 4. Client returns final result
      const response = await client.createMessage({
        messages: [{ role: "user", content: systemPrompt }],
        toolChoice: "auto",
        maxTokens: 4096,
        // Pass hints to client for agentic loop control
        maxIterations: maxIterations as number,
        allowedToolPatterns: allowedTools as string[] | undefined,
      });

      // Client returns final result after completing agentic loop
      return {
        success: response.stopReason === "end_turn",
        result: extractText(response.content),
        stopReason: response.stopReason,
      };
    },
  },

  // -------------------------------------------------------------------------
  // agent_decide - Make a single decision
  // -------------------------------------------------------------------------
  {
    name: "agent_decide",
    description:
      "Ask an LLM to make a decision based on context. Returns a boolean or choice from options. Use for conditional branching based on complex criteria that can't be expressed in simple code. Keywords: agent, decide, decision, condition, evaluate, branch, if-else, choose, llm, ai, boolean, yes-no, choice, select, pick.",
    category: "agent" as any,
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The decision question (e.g., 'Should we retry this operation?')",
        },
        context: {
          type: "object",
          description: "Context data to help make the decision",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Possible choices (if not provided, returns true/false)",
        },
      },
      required: ["question"],
    },
    handler: async ({ question, context, options }) => {
      const client = getSamplingClient();

      const optionsText = options
        ? `Choose ONE of: ${(options as string[]).join(", ")}`
        : "Answer with: true or false";

      const prompt = `${question}

${context ? `Context:\n${JSON.stringify(context, null, 2)}` : ""}

${optionsText}

Respond with ONLY your choice, no explanation.`;

      const response = await client.createMessage({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 100,
      });

      const answer = extractText(response.content).trim().toLowerCase();

      if (options) {
        // Find matching option
        const match = (options as string[]).find(
          (opt) => answer.includes(opt.toLowerCase()),
        );
        return {
          decision: match || answer,
          question: question as string,
        };
      } else {
        // Boolean decision
        const isTrue = answer.includes("true") || answer.includes("yes") || answer === "1";
        return {
          decision: isTrue,
          question: question as string,
        };
      }
    },
  },

  // -------------------------------------------------------------------------
  // agent_analyze - Analyze data and return insights
  // -------------------------------------------------------------------------
  {
    name: "agent_analyze",
    description:
      "Analyze data or content and return structured insights. Use for understanding patterns, identifying issues, or generating reports. Keywords: agent, analyze, analysis, insights, patterns, review, examine, assess, llm, ai, understand, inspect, audit, report.",
    category: "agent" as any,
    inputSchema: {
      type: "object",
      properties: {
        data: {
          type: ["string", "object", "array"],
          description: "The data to analyze",
        },
        focus: {
          type: "string",
          description: "What aspect to focus on (e.g., 'security issues', 'performance')",
        },
        format: {
          type: "string",
          enum: ["text", "json", "markdown"],
          description: "Output format (default: json)",
        },
      },
      required: ["data"],
    },
    handler: async ({ data, focus, format = "json" }) => {
      const client = getSamplingClient();

      const dataStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);

      const prompt = `Analyze the following data${focus ? ` focusing on: ${focus}` : ""}:

${dataStr}

Provide your analysis in ${format} format.${
        format === "json" ? " Return valid JSON with keys: summary, findings, recommendations" : ""
      }`;

      const response = await client.createMessage({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 2048,
      });

      const text = extractText(response.content);

      if (format === "json") {
        return tryParseJSON(text);
      }
      return { analysis: text };
    },
  },

  // -------------------------------------------------------------------------
  // agent_extract - Extract structured data from unstructured content
  // -------------------------------------------------------------------------
  {
    name: "agent_extract",
    description:
      "Extract structured data from unstructured text or content. Define a schema and the LLM will populate it. Keywords: agent, extract, parse, structure, schema, entities, fields, data, llm, ai, scrape, ner, named-entity, json, populate.",
    category: "agent" as any,
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The unstructured content to extract from",
        },
        schema: {
          type: "object",
          description: "JSON schema describing the data to extract",
        },
        examples: {
          type: "array",
          items: { type: "object" },
          description: "Optional examples of expected output",
        },
      },
      required: ["content", "schema"],
    },
    handler: async ({ content, schema, examples }) => {
      const client = getSamplingClient();

      let prompt = `Extract data from the following content according to the schema:

Content:
${content}

Schema:
${JSON.stringify(schema, null, 2)}`;

      if (examples) {
        prompt += `\n\nExamples of expected output:\n${JSON.stringify(examples, null, 2)}`;
      }

      prompt += "\n\nRespond with ONLY valid JSON matching the schema.";

      const response = await client.createMessage({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 2048,
      });

      return tryParseJSON(extractText(response.content));
    },
  },

  // -------------------------------------------------------------------------
  // agent_classify - Classify content into categories
  // -------------------------------------------------------------------------
  {
    name: "agent_classify",
    description:
      "Classify content into predefined categories. Returns the category and confidence. Keywords: agent, classify, categorize, label, tag, type, sentiment, intent, llm, ai, category, bucket, sort, triage.",
    category: "agent" as any,
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The content to classify",
        },
        categories: {
          type: "array",
          items: { type: "string" },
          description: "List of possible categories",
        },
        multiLabel: {
          type: "boolean",
          description: "Allow multiple categories (default: false)",
        },
      },
      required: ["content", "categories"],
    },
    handler: async ({ content, categories, multiLabel = false }) => {
      const client = getSamplingClient();

      const prompt = `Classify the following content into ${
        multiLabel ? "one or more of" : "exactly one of"
      } these categories: ${(categories as string[]).join(", ")}

Content:
${content}

Respond with JSON: { "categories": [...], "confidence": 0.0-1.0, "reasoning": "..." }`;

      const response = await client.createMessage({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 500,
      });

      return tryParseJSON(extractText(response.content));
    },
  },

  // -------------------------------------------------------------------------
  // agent_summarize - Summarize content
  // -------------------------------------------------------------------------
  {
    name: "agent_summarize",
    description:
      "Summarize long content into a shorter form. Control length and style. Keywords: agent, summarize, summary, condense, brief, tldr, abstract, digest, llm, ai, shorten, compress, synopsis.",
    category: "agent" as any,
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The content to summarize",
        },
        maxLength: {
          type: "number",
          description: "Maximum length in words (default: 100)",
        },
        style: {
          type: "string",
          enum: ["bullet", "paragraph", "technical", "simple"],
          description: "Summary style (default: paragraph)",
        },
        focus: {
          type: "string",
          description: "Aspect to focus on in the summary",
        },
      },
      required: ["content"],
    },
    handler: async ({ content, maxLength = 100, style = "paragraph", focus }) => {
      const client = getSamplingClient();

      const styleInstr = {
        bullet: "Use bullet points",
        paragraph: "Write as a paragraph",
        technical: "Use technical language",
        simple: "Use simple, everyday language",
      }[style as string] || "Write as a paragraph";

      const prompt =
        `Summarize the following content in ${maxLength} words or less. ${styleInstr}.${
          focus ? ` Focus on: ${focus}` : ""
        }

Content:
${content}`;

      const response = await client.createMessage({
        messages: [{ role: "user", content: prompt }],
        maxTokens: Math.ceil((maxLength as number) * 2),
      });

      return {
        summary: extractText(response.content),
        style,
        maxLength,
      };
    },
  },

  // -------------------------------------------------------------------------
  // agent_generate - Generate content (code, text, etc.)
  // -------------------------------------------------------------------------
  {
    name: "agent_generate",
    description:
      "Generate content based on instructions. Can generate code, text, documentation, etc. Keywords: agent, generate, create, write, compose, produce, synthesize, llm, ai, content, text, code, docs, author.",
    category: "agent" as any,
    inputSchema: {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          description: "What to generate",
        },
        type: {
          type: "string",
          enum: ["code", "text", "markdown", "json", "yaml"],
          description: "Type of content to generate (default: text)",
        },
        context: {
          type: "object",
          description: "Additional context for generation",
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Constraints or requirements",
        },
      },
      required: ["instructions"],
    },
    handler: async ({ instructions, type = "text", context, constraints }) => {
      const client = getSamplingClient();

      let prompt = `${instructions}`;

      if (context) {
        prompt += `\n\nContext:\n${JSON.stringify(context, null, 2)}`;
      }

      if (constraints) {
        prompt += `\n\nConstraints:\n- ${(constraints as string[]).join("\n- ")}`;
      }

      prompt += `\n\nGenerate ${type} content.${
        type === "code" ? " Include only the code, no explanations." : ""
      }`;

      const response = await client.createMessage({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 4096,
      });

      const text = extractText(response.content);

      // Try to extract code from markdown code blocks
      if (type === "code") {
        const codeMatch = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
        return {
          content: codeMatch ? codeMatch[1].trim() : text,
          type,
        };
      }

      if (type === "json" || type === "yaml") {
        return {
          content: type === "json" ? tryParseJSON(text) : text,
          type,
        };
      }

      return { content: text, type };
    },
  },

  // -------------------------------------------------------------------------
  // agent_compare - Compare items and determine winner/ranking
  // -------------------------------------------------------------------------
  {
    name: "agent_compare",
    description:
      "Compare multiple items and rank them or pick the best. Use for selecting between options based on criteria. Keywords: agent, compare, rank, best, winner, evaluate, choose, select, llm, ai, versus, pros-cons, tradeoff, decision.",
    category: "agent" as any,
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: ["string", "object"] },
          description: "Items to compare",
        },
        criteria: {
          type: "array",
          items: { type: "string" },
          description: "Criteria for comparison",
        },
        mode: {
          type: "string",
          enum: ["best", "rank", "pros-cons"],
          description: "Comparison mode (default: best)",
        },
      },
      required: ["items"],
    },
    handler: async ({ items, criteria, mode = "best" }) => {
      const client = getSamplingClient();

      const itemsStr = (items as unknown[]).map((item, i) =>
        `${i + 1}. ${typeof item === "string" ? item : JSON.stringify(item)}`
      ).join("\n");

      const criteriaStr = criteria
        ? `Criteria: ${(criteria as string[]).join(", ")}`
        : "Use your best judgment";

      const modeInstr = {
        best: "Pick the single best option and explain why.",
        rank: "Rank all options from best to worst.",
        "pros-cons": "List pros and cons for each option.",
      }[mode as string];

      const prompt = `Compare these items:

${itemsStr}

${criteriaStr}

${modeInstr}

Respond with JSON: { "result": ..., "reasoning": "..." }`;

      const response = await client.createMessage({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 1500,
      });

      return tryParseJSON(extractText(response.content));
    },
  },
];
