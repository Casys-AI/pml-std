/**
 * HTTP helper tools
 *
 * Uses native fetch API for HTTP operations.
 *
 * @module lib/std/http
 */

import type { MiniTool } from "./types.ts";

export const httpTools: MiniTool[] = [
  {
    name: "http_get",
    description:
      "Make HTTP GET request to fetch data from a URL. Retrieve API responses, download web content, or check endpoints. Supports custom headers and response types (json, text, blob). Use for REST API calls, data fetching, or web scraping. Keywords: HTTP GET, fetch API, REST GET, download URL, API request, web fetch.",
    category: "http",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        headers: { type: "object", description: "Request headers" },
        responseType: {
          type: "string",
          enum: ["json", "text", "blob"],
          description: "Expected response type (default: json)",
        },
      },
      required: ["url"],
    },
    handler: async ({ url, headers, responseType = "json" }) => {
      try {
        const response = await fetch(url as string, {
          method: "GET",
          headers: headers as HeadersInit | undefined,
        });

        const result = {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          ok: response.ok,
          data: null as unknown,
        };

        switch (responseType) {
          case "text":
            result.data = await response.text();
            break;
          case "blob":
            result.data = `[Blob: ${(await response.blob()).size} bytes]`;
            break;
          default:
            result.data = await response.json();
        }
        return result;
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  },
  {
    name: "http_post",
    description:
      "Make HTTP POST request to send data to a server. Submit forms, create resources, or authenticate with APIs. Supports JSON, form-urlencoded, and plain text body formats. Use for REST API calls, form submissions, or data creation. Keywords: HTTP POST, send data, API post, submit form, create resource, REST POST.",
    category: "http",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to post to" },
        body: { description: "Request body (will be JSON stringified if object)" },
        headers: { type: "object", description: "Request headers" },
        contentType: {
          type: "string",
          enum: ["json", "form", "text"],
          description: "Content type (default: json)",
        },
      },
      required: ["url"],
    },
    handler: async ({ url, body, headers = {}, contentType = "json" }) => {
      try {
        const hdrs = { ...(headers as Record<string, string>) };
        let bodyStr: string | undefined;

        switch (contentType) {
          case "form":
            hdrs["Content-Type"] = "application/x-www-form-urlencoded";
            bodyStr = new URLSearchParams(body as Record<string, string>).toString();
            break;
          case "text":
            hdrs["Content-Type"] = "text/plain";
            bodyStr = String(body);
            break;
          default:
            hdrs["Content-Type"] = "application/json";
            bodyStr = JSON.stringify(body);
        }

        const response = await fetch(url as string, {
          method: "POST",
          headers: hdrs,
          body: bodyStr,
        });

        return {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          data: await response.json().catch(() => response.text()),
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  },
  {
    name: "http_request",
    description:
      "Make HTTP request with any method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS). Full control over request configuration including headers and body. Use for REST APIs, custom HTTP operations, or when GET/POST shortcuts are insufficient. Keywords: HTTP request, fetch, PUT PATCH DELETE, REST API, custom request, HTTP method.",
    category: "http",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL" },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
          description: "HTTP method",
        },
        headers: { type: "object", description: "Request headers" },
        body: { description: "Request body" },
      },
      required: ["url", "method"],
    },
    handler: async ({ url, method, headers, body }) => {
      try {
        const options: RequestInit = {
          method: method as string,
          headers: headers as HeadersInit | undefined,
        };

        if (body && method !== "GET" && method !== "HEAD") {
          options.body = typeof body === "string" ? body : JSON.stringify(body);
          if (typeof body !== "string") {
            options.headers = {
              ...options.headers,
              "Content-Type": "application/json",
            };
          }
        }

        const response = await fetch(url as string, options);
        const text = await response.text();
        let data: unknown = text;
        try {
          data = JSON.parse(text);
        } catch {
          // Keep as text
        }

        return {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers: Object.fromEntries(response.headers.entries()),
          data,
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  },
  {
    name: "http_build_url",
    description:
      "Build URL by combining base URL with query parameters. Construct API URLs dynamically, add search params, or prepare request URLs. Properly encodes parameter values. Use for URL construction, API calls with filters, or pagination. Keywords: build URL, query params, URL encode, add parameters, construct URL, querystring.",
    category: "http",
    inputSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", description: "Base URL" },
        params: { type: "object", description: "Query parameters" },
      },
      required: ["baseUrl"],
    },
    handler: ({ baseUrl, params }) => {
      const url = new URL(baseUrl as string);
      if (params) {
        for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
          if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
          }
        }
      }
      return url.toString();
    },
  },
  {
    name: "http_parse_url",
    description:
      "Parse URL into its components (protocol, host, port, path, query params, hash). Extract parts of a URL for analysis or manipulation. Use for URL validation, extracting domains, or parsing API endpoints. Keywords: parse URL, URL components, extract domain, URL parts, hostname, query params.",
    category: "http",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to parse" },
      },
      required: ["url"],
    },
    handler: ({ url }) => {
      try {
        const parsed = new URL(url as string);
        return {
          href: parsed.href,
          protocol: parsed.protocol,
          host: parsed.host,
          hostname: parsed.hostname,
          port: parsed.port || null,
          pathname: parsed.pathname,
          search: parsed.search,
          hash: parsed.hash,
          params: Object.fromEntries(parsed.searchParams.entries()),
          origin: parsed.origin,
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  },
  {
    name: "http_encode_uri",
    description:
      "Encode or decode URI components and full URIs. Handle special characters in URLs, prepare strings for URL inclusion, or decode URL-encoded text. Use for URL safety, encoding query values, or decoding received URLs. Keywords: URL encode, URI encode, encodeURIComponent, decode URL, percent encoding, escape URL.",
    category: "http",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to encode/decode" },
        action: { type: "string", enum: ["encode", "decode"], description: "Action" },
        type: {
          type: "string",
          enum: ["component", "full"],
          description: "URI component or full URI (default: component)",
        },
      },
      required: ["text", "action"],
    },
    handler: ({ text, action, type = "component" }) => {
      const t = text as string;
      if (action === "encode") {
        return type === "full" ? encodeURI(t) : encodeURIComponent(t);
      }
      return type === "full" ? decodeURI(t) : decodeURIComponent(t);
    },
  },
];
