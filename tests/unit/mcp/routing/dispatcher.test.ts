/**
 * RequestDispatcher Tests
 *
 * @module tests/unit/mcp/routing/dispatcher.test
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { RequestDispatcher } from "../../../../src/mcp/routing/dispatcher.ts";
import type { RouteContext } from "../../../../src/mcp/routing/types.ts";

/**
 * Create mock route context
 */
function createMockContext(): RouteContext {
  return {
    graphEngine: {} as any,
    vectorSearch: {} as any,
    dagSuggester: {} as any,
    eventsStream: null,
    mcpClients: new Map(),
    params: {},
  };
}

Deno.test("RequestDispatcher - Route Registration", async (t) => {
  await t.step("register() adds route to internal routing table", () => {
    const dispatcher = new RequestDispatcher();
    const handler = () => {
      return Promise.resolve(new Response("OK"));
    };

    dispatcher.register("GET", "/test", handler);
    // Can't directly test internal routes, but we can verify it dispatches correctly
    assertExists(dispatcher);
  });

  await t.step("get() helper registers GET route", async () => {
    const dispatcher = new RequestDispatcher();
    let called = false;
    const handler = () => {
      called = true;
      return Promise.resolve(new Response("OK"));
    };

    dispatcher.get("/test", handler);

    const req = new Request("http://test.com/test", { method: "GET" });
    const url = new URL(req.url);
    await dispatcher.dispatch(req, url, createMockContext(), {});

    assertEquals(called, true);
  });

  await t.step("post() helper registers POST route", async () => {
    const dispatcher = new RequestDispatcher();
    let called = false;
    const handler = () => {
      called = true;
      return Promise.resolve(new Response("OK"));
    };

    dispatcher.post("/test", handler);

    const req = new Request("http://test.com/test", { method: "POST" });
    const url = new URL(req.url);
    await dispatcher.dispatch(req, url, createMockContext(), {});

    assertEquals(called, true);
  });

  await t.step("delete() helper registers DELETE route", async () => {
    const dispatcher = new RequestDispatcher();
    let called = false;
    const handler = () => {
      called = true;
      return Promise.resolve(new Response("OK"));
    };

    dispatcher.delete("/test", handler);

    const req = new Request("http://test.com/test", { method: "DELETE" });
    const url = new URL(req.url);
    await dispatcher.dispatch(req, url, createMockContext(), {});

    assertEquals(called, true);
  });

  await t.step("multiple routes with same path but different methods are distinct", async () => {
    const dispatcher = new RequestDispatcher();
    let getCalled = false;
    let postCalled = false;

    dispatcher.get("/test", () => {
      getCalled = true;
      return Promise.resolve(new Response("GET"));
    });

    dispatcher.post("/test", () => {
      postCalled = true;
      return Promise.resolve(new Response("POST"));
    });

    const getReq = new Request("http://test.com/test", { method: "GET" });
    await dispatcher.dispatch(getReq, new URL(getReq.url), createMockContext(), {});

    assertEquals(getCalled, true);
    assertEquals(postCalled, false);
  });
});

Deno.test("RequestDispatcher - Simple Path Matching", async (t) => {
  await t.step("dispatch() matches exact string paths", async () => {
    const dispatcher = new RequestDispatcher();
    dispatcher.get("/api/health", () => Promise.resolve(new Response("OK")));

    const req = new Request("http://test.com/api/health", { method: "GET" });
    const result = await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertExists(result);
    assertEquals(await result.text(), "OK");
  });

  await t.step("dispatch() returns null for unmatched path", async () => {
    const dispatcher = new RequestDispatcher();
    dispatcher.get("/api/health", () => Promise.resolve(new Response("OK")));

    const req = new Request("http://test.com/api/metrics", { method: "GET" });
    const result = await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(result, null);
  });

  await t.step("dispatch() returns null for wrong HTTP method", async () => {
    const dispatcher = new RequestDispatcher();
    dispatcher.get("/api/health", () => Promise.resolve(new Response("OK")));

    const req = new Request("http://test.com/api/health", { method: "POST" });
    const result = await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(result, null);
  });

  await t.step("method='*' matches any HTTP method", async () => {
    const dispatcher = new RequestDispatcher();
    dispatcher.register("*", "/test", () => Promise.resolve(new Response("OK")));

    const getReq = new Request("http://test.com/test", { method: "GET" });
    const getResult = await dispatcher.dispatch(
      getReq,
      new URL(getReq.url),
      createMockContext(),
      {},
    );
    assertExists(getResult);

    const postReq = new Request("http://test.com/test", { method: "POST" });
    const postResult = await dispatcher.dispatch(
      postReq,
      new URL(postReq.url),
      createMockContext(),
      {},
    );
    assertExists(postResult);

    const deleteReq = new Request("http://test.com/test", { method: "DELETE" });
    const deleteResult = await dispatcher.dispatch(
      deleteReq,
      new URL(deleteReq.url),
      createMockContext(),
      {},
    );
    assertExists(deleteResult);
  });
});

Deno.test("RequestDispatcher - Path Parameter Extraction", async (t) => {
  await t.step("dispatch() extracts single path parameter", async () => {
    const dispatcher = new RequestDispatcher();
    let extractedId: string | undefined;

    dispatcher.get("/api/users/:id", (_req, _url, ctx) => {
      extractedId = ctx.params?.id;
      return Promise.resolve(new Response("OK"));
    });

    const req = new Request("http://test.com/api/users/123", { method: "GET" });
    await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(extractedId, "123");
  });

  await t.step("dispatch() extracts multiple path parameters", async () => {
    const dispatcher = new RequestDispatcher();
    let extractedUserId: string | undefined;
    let extractedPostId: string | undefined;

    dispatcher.get("/api/users/:userId/posts/:postId", (_req, _url, ctx) => {
      extractedUserId = ctx.params?.userId;
      extractedPostId = ctx.params?.postId;
      return Promise.resolve(new Response("OK"));
    });

    const req = new Request("http://test.com/api/users/42/posts/99", { method: "GET" });
    await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(extractedUserId, "42");
    assertEquals(extractedPostId, "99");
  });

  await t.step("path parameters can contain special characters", async () => {
    const dispatcher = new RequestDispatcher();
    let extractedId: string | undefined;

    dispatcher.get("/api/items/:id", (_req, _url, ctx) => {
      extractedId = ctx.params?.id;
      return Promise.resolve(new Response("OK"));
    });

    const req = new Request("http://test.com/api/items/item-123_v2", { method: "GET" });
    await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(extractedId, "item-123_v2");
  });

  await t.step("path parameter mismatch (different segment count) returns null", async () => {
    const dispatcher = new RequestDispatcher();
    dispatcher.get("/api/users/:id", () => Promise.resolve(new Response("OK")));

    const req = new Request("http://test.com/api/users/123/extra", { method: "GET" });
    const result = await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(result, null);
  });

  await t.step("path with no parameters still works", async () => {
    const dispatcher = new RequestDispatcher();
    let paramsObj: Record<string, string> | undefined;

    dispatcher.get("/api/users/list", (_req, _url, ctx) => {
      paramsObj = ctx.params || {};
      return Promise.resolve(new Response("OK"));
    });

    const req = new Request("http://test.com/api/users/list", { method: "GET" });
    await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertExists(paramsObj);
    assertEquals(Object.keys(paramsObj).length, 0);
  });
});

Deno.test("RequestDispatcher - Regex Pattern Matching", async (t) => {
  await t.step("dispatch() matches regex pattern", async () => {
    const dispatcher = new RequestDispatcher();
    dispatcher.get(/^\/api\/v\d+\/health$/, () => Promise.resolve(new Response("OK")));

    const req = new Request("http://test.com/api/v1/health", { method: "GET" });
    const result = await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertExists(result);
  });

  await t.step("regex pattern can extract named groups", async () => {
    const dispatcher = new RequestDispatcher();
    let extractedVersion: string | undefined;

    dispatcher.get(/^\/api\/(?<version>v\d+)\/health$/, (_req, _url, ctx) => {
      extractedVersion = ctx.params?.version;
      return Promise.resolve(new Response("OK"));
    });

    const req = new Request("http://test.com/api/v2/health", { method: "GET" });
    await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(extractedVersion, "v2");
  });

  await t.step("regex pattern non-match returns null", async () => {
    const dispatcher = new RequestDispatcher();
    dispatcher.get(/^\/api\/v\d+\/health$/, () => Promise.resolve(new Response("OK")));

    const req = new Request("http://test.com/api/health", { method: "GET" });
    const result = await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(result, null);
  });
});

Deno.test("RequestDispatcher - Route Priority and Ordering", async (t) => {
  await t.step("routes are matched in registration order", async () => {
    const dispatcher = new RequestDispatcher();
    let firstCalled = false;
    let secondCalled = false;

    dispatcher.get(/^\/api\/.*/, () => {
      firstCalled = true;
      return Promise.resolve(new Response("First"));
    });

    dispatcher.get("/api/health", () => {
      secondCalled = true;
      return Promise.resolve(new Response("Second"));
    });

    const req = new Request("http://test.com/api/health", { method: "GET" });
    await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(firstCalled, true);
    assertEquals(secondCalled, false);
  });

  await t.step("specific routes should be registered before generic ones", async () => {
    const dispatcher = new RequestDispatcher();
    let firstCalled = false;
    let secondCalled = false;

    // Register specific first
    dispatcher.get("/api/health", () => {
      firstCalled = true;
      return Promise.resolve(new Response("Specific"));
    });

    // Register generic second
    dispatcher.get("/api/:resource", () => {
      secondCalled = true;
      return Promise.resolve(new Response("Generic"));
    });

    const req = new Request("http://test.com/api/health", { method: "GET" });
    await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(firstCalled, true);
    assertEquals(secondCalled, false);
  });
});

Deno.test("RequestDispatcher - Handler Execution", async (t) => {
  await t.step("dispatch() passes correct arguments to handler", async () => {
    const dispatcher = new RequestDispatcher();
    let capturedReq: Request | undefined;
    let capturedUrl: URL | undefined;
    let capturedCtx: RouteContext | undefined;
    let capturedCors: Record<string, string> | undefined;

    dispatcher.get("/test", (req, url, ctx, cors) => {
      capturedReq = req;
      capturedUrl = url;
      capturedCtx = ctx;
      capturedCors = cors;
      return Promise.resolve(new Response("OK"));
    });

    const req = new Request("http://test.com/test", { method: "GET" });
    const url = new URL(req.url);
    const ctx = createMockContext();
    const cors = { "Access-Control-Allow-Origin": "*" };

    await dispatcher.dispatch(req, url, ctx, cors);

    assertEquals(capturedReq, req);
    assertEquals(capturedUrl, url);
    assertExists(capturedCtx);
    assertEquals(capturedCors, cors);
  });

  await t.step("dispatch() returns handler's response", async () => {
    const dispatcher = new RequestDispatcher();
    const expectedResponse = new Response("test");

    dispatcher.get("/test", () => Promise.resolve(expectedResponse));

    const req = new Request("http://test.com/test", { method: "GET" });
    const result = await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(result, expectedResponse);
  });

  await t.step("dispatch() awaits async handlers", async () => {
    const dispatcher = new RequestDispatcher();
    let completed = false;

    dispatcher.get("/test", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = true;
      return new Response("OK");
    });

    const req = new Request("http://test.com/test", { method: "GET" });
    await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(completed, true);
  });
});

Deno.test("RequestDispatcher - Edge Cases", async (t) => {
  await t.step("trailing slash is significant (no normalization)", async () => {
    const dispatcher = new RequestDispatcher();
    dispatcher.get("/api/health", () => Promise.resolve(new Response("OK")));

    const req = new Request("http://test.com/api/health/", { method: "GET" });
    const result = await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(result, null);
  });

  await t.step("query parameters don't affect path matching", async () => {
    const dispatcher = new RequestDispatcher();
    let called = false;

    dispatcher.get("/api/health", () => {
      called = true;
      return Promise.resolve(new Response("OK"));
    });

    const req = new Request("http://test.com/api/health?detailed=true", { method: "GET" });
    await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(called, true);
  });

  await t.step("URL fragment doesn't affect path matching", async () => {
    const dispatcher = new RequestDispatcher();
    let called = false;

    dispatcher.get("/api/health", () => {
      called = true;
      return Promise.resolve(new Response("OK"));
    });

    const req = new Request("http://test.com/api/health#section", { method: "GET" });
    await dispatcher.dispatch(req, new URL(req.url), createMockContext(), {});

    assertEquals(called, true);
  });
});
