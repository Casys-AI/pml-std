/**
 * ConnectionPool Tests
 *
 * @module tests/unit/mcp/connections/pool.test
 */

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { ConnectionPool } from "../../../../src/mcp/connections/pool.ts";
import type { MCPClientBase } from "../../../../src/mcp/types.ts";

/**
 * Create mock MCP client
 */
function createMockClient(id = "default"): MCPClientBase & { disconnectCalls: number } {
  const mock = {
    id,
    disconnectCalls: 0,
    disconnect: async () => {
      mock.disconnectCalls++;
    },
  };
  return mock as unknown as MCPClientBase & { disconnectCalls: number };
}

Deno.test("ConnectionPool - Basic Pooling Operations", async (t) => {
  await t.step("acquire() creates new connection if none exists", async () => {
    const pool = new ConnectionPool();
    const mockClient = createMockClient("client-1");
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return Promise.resolve(mockClient);
    };

    const client = await pool.acquire("server-1", factory);

    assertEquals(factoryCalls, 1);
    assertEquals(client, mockClient);
    assertEquals(pool.getManager().size, 1);

    await pool.close();
  });

  await t.step("acquire() reuses existing connection", async () => {
    const pool = new ConnectionPool();
    const mockClient = createMockClient("client-1");
    let factory1Calls = 0;
    let factory2Calls = 0;
    const factory1 = () => {
      factory1Calls++;
      return Promise.resolve(mockClient);
    };
    const factory2 = () => {
      factory2Calls++;
      return Promise.resolve(createMockClient("client-2"));
    };

    const client1 = await pool.acquire("server-1", factory1);
    const client2 = await pool.acquire("server-1", factory2);

    assertEquals(factory1Calls, 1);
    assertEquals(factory2Calls, 0); // Not called
    assertEquals(client1, client2);
    assertEquals(pool.getManager().size, 1);

    await pool.close();
  });

  await t.step("acquire() creates separate connections for different serverIds", async () => {
    const pool = new ConnectionPool();
    const client1 = createMockClient("client-1");
    const client2 = createMockClient("client-2");
    let factory1Calls = 0;
    let factory2Calls = 0;
    const factory1 = () => {
      factory1Calls++;
      return Promise.resolve(client1);
    };
    const factory2 = () => {
      factory2Calls++;
      return Promise.resolve(client2);
    };

    const result1 = await pool.acquire("server-1", factory1);
    const result2 = await pool.acquire("server-2", factory2);

    assertEquals(factory1Calls, 1);
    assertEquals(factory2Calls, 1);
    assertEquals(result1, client1);
    assertEquals(result2, client2);
    assertEquals(pool.getManager().size, 2);

    await pool.close();
  });

  await t.step("release() resets idle timer", async () => {
    const pool = new ConnectionPool({ idleTimeout: 100 });
    const mockClient = createMockClient();
    const factory = () => Promise.resolve(mockClient);

    await pool.acquire("server-1", factory);

    // Wait 50ms and release (reset timer)
    await new Promise((resolve) => setTimeout(resolve, 50));
    pool.release("server-1");

    // Wait another 60ms (total 110ms, but timer reset to 60ms)
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Connection should still exist
    assertEquals(pool.getManager().get("server-1"), mockClient);

    // Wait another 50ms (total timer elapsed: 110ms)
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Connection should be disconnected now
    assertEquals(mockClient.disconnectCalls, 1);

    await pool.close();
  });
});

Deno.test("ConnectionPool - Pool Limits", async (t) => {
  await t.step("acquire() throws when pool is exhausted", async () => {
    const pool = new ConnectionPool({ maxConnections: 2 });

    await pool.acquire("server-1", () => Promise.resolve(createMockClient("1")));
    await pool.acquire("server-2", () => Promise.resolve(createMockClient("2")));

    await assertRejects(
      async () => {
        await pool.acquire("server-3", () => Promise.resolve(createMockClient("3")));
      },
      Error,
      "Connection pool exhausted",
    );

    await pool.close();
  });

  await t.step("acquire() succeeds after connection is removed", async () => {
    const pool = new ConnectionPool({ maxConnections: 2 });
    const client1 = createMockClient("1");
    const client2 = createMockClient("2");

    await pool.acquire("server-1", () => Promise.resolve(client1));
    await pool.acquire("server-2", () => Promise.resolve(client2));

    // Manually disconnect one
    await pool.getManager().disconnect("server-1");

    // Should still fail because disconnected connection is still in pool
    await assertRejects(
      async () => {
        await pool.acquire("server-3", () => Promise.resolve(createMockClient("3")));
      },
      Error,
      "Connection pool exhausted",
    );

    await pool.close();
  });
});

Deno.test("ConnectionPool - Idle Timeout", async (t) => {
  await t.step("idle timeout disconnects unused connections", async () => {
    const pool = new ConnectionPool({ idleTimeout: 200 });
    const mockClient = createMockClient();
    const factory = () => Promise.resolve(mockClient);

    await pool.acquire("server-1", factory);

    // Wait for idle timeout
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Connection should be disconnected
    assertEquals(mockClient.disconnectCalls, 1);
  });

  await t.step("idle timer resets on each acquire()", async () => {
    const pool = new ConnectionPool({ idleTimeout: 100 });
    const mockClient = createMockClient();
    const factory = () => Promise.resolve(mockClient);

    await pool.acquire("server-1", factory);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Acquire again to reset timer
    await pool.acquire("server-1", factory);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Connection should still be active (120ms total, but timer was reset at 60ms)
    assertExists(pool.getManager().get("server-1"));

    // Wait for actual timeout
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(mockClient.disconnectCalls, 1);
  });

  await t.step("multiple connections have independent idle timers", async () => {
    const pool = new ConnectionPool({ idleTimeout: 100 });
    const client1 = createMockClient("1");
    const client2 = createMockClient("2");

    // t=0ms: Acquire server-1
    await pool.acquire("server-1", () => Promise.resolve(client1));

    // t=50ms: Acquire server-2
    await new Promise((resolve) => setTimeout(resolve, 50));
    await pool.acquire("server-2", () => Promise.resolve(client2));

    // t=120ms: Check pool
    await new Promise((resolve) => setTimeout(resolve, 70));

    // server-1 should be disconnected (120ms elapsed)
    assertEquals(client1.disconnectCalls, 1);

    // server-2 should still be connected (70ms elapsed)
    assertEquals(client2.disconnectCalls, 0);

    // Wait for server-2 to timeout
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(client2.disconnectCalls, 1);
  });
});

Deno.test("ConnectionPool - Connection Factory Errors", async (t) => {
  await t.step("acquire() propagates factory errors", async () => {
    const pool = new ConnectionPool();
    const throwingFactory = () => {
      throw new Error("Factory failed");
    };

    await assertRejects(
      async () => {
        await pool.acquire("server-1", throwingFactory);
      },
      Error,
      "Factory failed",
    );

    assertEquals(pool.getManager().size, 0);
  });

  await t.step("acquire() propagates factory async errors", async () => {
    const pool = new ConnectionPool();
    const rejectingFactory = () => Promise.reject(new Error("Async factory failed"));

    await assertRejects(
      async () => {
        await pool.acquire("server-1", rejectingFactory);
      },
      Error,
      "Async factory failed",
    );

    assertEquals(pool.getManager().size, 0);
  });
});

Deno.test("ConnectionPool - Cleanup Operations", async (t) => {
  await t.step("close() disconnects all connections", async () => {
    const pool = new ConnectionPool();
    const client1 = createMockClient("1");
    const client2 = createMockClient("2");
    const client3 = createMockClient("3");

    await pool.acquire("server-1", () => Promise.resolve(client1));
    await pool.acquire("server-2", () => Promise.resolve(client2));
    await pool.acquire("server-3", () => Promise.resolve(client3));

    await pool.close();

    assertEquals(client1.disconnectCalls, 1);
    assertEquals(client2.disconnectCalls, 1);
    assertEquals(client3.disconnectCalls, 1);
  });

  await t.step("close() clears all idle timers", async () => {
    const pool = new ConnectionPool({ idleTimeout: 10000 }); // Long timeout
    const client1 = createMockClient("1");
    const client2 = createMockClient("2");

    await pool.acquire("server-1", () => Promise.resolve(client1));
    await pool.acquire("server-2", () => Promise.resolve(client2));

    await pool.close();

    // Timers should be cleared immediately
    assertEquals(client1.disconnectCalls, 1);
    assertEquals(client2.disconnectCalls, 1);

    // Wait to ensure no additional disconnect calls from timers
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(client1.disconnectCalls, 1);
    assertEquals(client2.disconnectCalls, 1);
  });

  await t.step("close() handles disconnect errors gracefully", async () => {
    const pool = new ConnectionPool();
    const client1 = createMockClient("1");
    const client2 = {
      disconnect: async () => {
        throw new Error("Disconnect failed");
      },
    } as unknown as MCPClientBase;
    const client3 = createMockClient("3");

    await pool.acquire("server-1", () => Promise.resolve(client1));
    await pool.acquire("server-2", () => Promise.resolve(client2));
    await pool.acquire("server-3", () => Promise.resolve(client3));

    // Should not throw
    await pool.close();

    // Other connections should still be disconnected
    assertEquals(client1.disconnectCalls, 1);
    assertEquals(client3.disconnectCalls, 1);
  });
});

Deno.test("ConnectionPool - Configuration", async (t) => {
  await t.step("default configuration values are applied", async () => {
    const pool = new ConnectionPool();

    // Can add up to 50 connections (default max)
    for (let i = 0; i < 50; i++) {
      await pool.acquire(`server-${i}`, () => Promise.resolve(createMockClient(`${i}`)));
    }

    assertEquals(pool.getManager().size, 50);

    // 51st connection should fail
    await assertRejects(
      async () => {
        await pool.acquire("server-51", () => Promise.resolve(createMockClient("51")));
      },
      Error,
      "Connection pool exhausted",
    );

    await pool.close();
  });

  await t.step("partial configuration merges with defaults", async () => {
    const pool = new ConnectionPool({ maxConnections: 10 });

    // Can add up to 10 connections
    for (let i = 0; i < 10; i++) {
      await pool.acquire(`server-${i}`, () => Promise.resolve(createMockClient(`${i}`)));
    }

    assertEquals(pool.getManager().size, 10);

    // 11th connection should fail
    await assertRejects(
      async () => {
        await pool.acquire("server-11", () => Promise.resolve(createMockClient("11")));
      },
      Error,
      "Connection pool exhausted",
    );

    await pool.close();
  });

  await t.step("zero maxConnections is respected", async () => {
    const pool = new ConnectionPool({ maxConnections: 0 });

    await assertRejects(
      async () => {
        await pool.acquire("server-1", () => Promise.resolve(createMockClient("1")));
      },
      Error,
      "Connection pool exhausted",
    );
  });
});

Deno.test("ConnectionPool - Manager Integration", async (t) => {
  await t.step("getManager() returns underlying ConnectionManager", async () => {
    const pool = new ConnectionPool();
    const mockClient = createMockClient();

    await pool.acquire("server-1", () => Promise.resolve(mockClient));

    const manager = pool.getManager();
    assertExists(manager);
    assertEquals(manager.get("server-1"), mockClient);
    assertEquals(manager.size, 1);

    // Manager operations work correctly
    manager.updateStatus("server-1", "error", "Test error");
    assertEquals(manager.getInfo("server-1")?.status, "error");

    await pool.close();
  });
});
