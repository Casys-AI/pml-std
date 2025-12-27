/**
 * Server-Sent Events (SSE) Stream Manager for System Events
 * Story 6.1: Real-time Events Stream (SSE)
 * Story 6.5: EventBus Integration (ADR-036)
 *
 * Manages long-lived SSE connections for real-time system monitoring.
 * Broadcasts all events from unified EventBus to connected clients with heartbeat support.
 */

import type { EventType, PmlEvent } from "../events/types.ts";
import { eventBus } from "../events/mod.ts";
import * as log from "@std/log";

/**
 * Configuration for EventsStreamManager
 */
export interface EventsStreamConfig {
  /** Maximum concurrent client connections (default: 100) */
  maxClients: number;
  /** Heartbeat interval in milliseconds (default: 30000 = 30s) */
  heartbeatIntervalMs: number;
  /** Allowed CORS origins (supports wildcards) */
  corsOrigins: string[];
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: EventsStreamConfig = {
  maxClients: 100,
  heartbeatIntervalMs: 30_000,
  corsOrigins: [
    "http://localhost:*", // Allow any localhost port (dev)
    "http://127.0.0.1:*",
  ],
};

/**
 * Client connection with optional filters
 */
interface ClientConnection {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  filters: string[]; // Event type prefixes to include (empty = all events)
}

/**
 * Manages SSE connections for system events
 * Story 6.5: Subscribes to unified EventBus (ADR-036)
 */
export class EventsStreamManager {
  private clients: Map<string, ClientConnection> = new Map();
  private startTime = Date.now();
  private heartbeatInterval?: number;
  private encoder = new TextEncoder();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private config: EventsStreamConfig = DEFAULT_CONFIG,
  ) {
    // Story 6.5: Subscribe to EventBus instead of GraphRAGEngine
    this.unsubscribe = eventBus.on("*", (event) => {
      this.broadcastEvent(event);
    });

    // Start heartbeat
    this.startHeartbeat();

    log.info(
      `EventsStreamManager initialized with EventBus (max clients: ${config.maxClients}, heartbeat: ${config.heartbeatIntervalMs}ms)`,
    );
  }

  /**
   * Handle incoming SSE connection request
   * Story 6.5 AC#12: Support optional ?filter= query param
   *
   * @param request - HTTP request
   * @returns SSE response stream or 503 if too many clients
   */
  handleRequest(request: Request): Response {
    // Check client limit
    if (this.clients.size >= this.config.maxClients) {
      log.warn(
        `SSE connection rejected: max clients reached (${this.config.maxClients})`,
      );
      return new Response(
        JSON.stringify({
          error: "Too many clients",
          max: this.config.maxClients,
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Story 6.5 AC#12: Parse optional filter param
    const url = new URL(request.url);
    const filterParam = url.searchParams.get("filter");
    const filters = filterParam
      ? filterParam.split(",").map((f) => f.trim()).filter((f) => f.length > 0)
      : [];

    // Create transform stream for SSE
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    const clientId = crypto.randomUUID();

    // Register client with filters
    this.clients.set(clientId, { writer, filters });
    log.info(
      `SSE client connected (${this.clients.size}/${this.config.maxClients})${
        filters.length > 0 ? ` filters: [${filters.join(", ")}]` : ""
      }`,
    );

    // Remove client on connection close/abort
    request.signal.addEventListener("abort", () => {
      this.clients.delete(clientId);
      writer.close().catch(() => {});
      log.info(
        `SSE client disconnected (${this.clients.size}/${this.config.maxClients})`,
      );
    });

    // Send initial connected event
    const connectedEvent: PmlEvent<"system.startup"> = {
      type: "system.startup",
      timestamp: Date.now(),
      source: "events-stream",
      payload: {
        client_id: clientId,
        connected_clients: this.clients.size,
        filters: filters.length > 0 ? filters : ["*"],
      },
    };
    this.sendToClient(writer, connectedEvent).catch((err) => {
      log.error(`Failed to send connected event: ${err}`);
    });

    // Get CORS headers
    const origin = request.headers.get("Origin") || "*";
    const corsHeaders = this.getCorsHeaders(origin);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no", // Disable nginx buffering
        ...corsHeaders,
      },
    });
  }

  /**
   * Check if event matches client filters
   * Story 6.5 AC#12: Filter syntax ?filter=algorithm.*,dag.*
   *
   * @param eventType - Event type to check
   * @param filters - Client filter prefixes
   * @returns True if event should be sent to client
   */
  private matchesFilters(eventType: EventType, filters: string[]): boolean {
    // Empty filters = receive all events
    if (filters.length === 0) return true;

    // Check if event type starts with any filter prefix
    return filters.some((filter) => {
      if (filter.endsWith(".*")) {
        // Wildcard match: "algorithm.*" matches "algorithm.scored"
        const prefix = filter.slice(0, -2);
        return eventType.startsWith(prefix);
      }
      // Exact match
      return eventType === filter;
    });
  }

  /**
   * Broadcast event to all connected clients
   * Story 6.5: Broadcasts PmlEvent from EventBus
   *
   * @param event - Event to broadcast
   */
  private async broadcastEvent(event: PmlEvent): Promise<void> {
    const deadClients: string[] = [];

    // Send to all clients (with filter check)
    for (const [clientId, client] of this.clients) {
      // Story 6.5 AC#12: Check if event matches client filters
      if (!this.matchesFilters(event.type, client.filters)) {
        continue; // Skip this client
      }

      try {
        await this.sendToClient(client.writer, event);
      } catch (error) {
        log.debug(`Client send failed, marking for removal: ${error}`);
        deadClients.push(clientId);
      }
    }

    // Clean up dead clients
    for (const clientId of deadClients) {
      const client = this.clients.get(clientId);
      this.clients.delete(clientId);
      if (client) {
        try {
          await client.writer.close();
        } catch {
          // Ignore close errors
        }
      }
    }

    if (deadClients.length > 0) {
      log.info(
        `Removed ${deadClients.length} dead clients (${this.clients.size} remaining)`,
      );
    }
  }

  /**
   * Send event to a single client
   *
   * @param writer - Stream writer for the client
   * @param event - Event to send
   */
  private async sendToClient(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    event: PmlEvent,
  ): Promise<void> {
    // SSE format: event: {type}\ndata: {JSON}\n\n
    const sseData = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    // Debug logging for zone events
    if (event.type.startsWith("capability.zone")) {
      log.info(
        `[SSE-DEBUG] Sending ${event.type} to client, payload keys: ${
          Object.keys(event.payload || {}).join(", ")
        }`,
      );
    }
    await writer.write(this.encoder.encode(sseData));
  }

  /**
   * Start heartbeat interval to keep connections alive
   * Story 6.5: Uses EventBus heartbeat event
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      // Emit heartbeat via EventBus (will be picked up by our subscription)
      eventBus.emit({
        type: "heartbeat",
        source: "events-stream",
        payload: {
          connected_clients: this.clients.size,
          uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
        },
      });
    }, this.config.heartbeatIntervalMs);

    log.debug(
      `Heartbeat started (interval: ${this.config.heartbeatIntervalMs}ms)`,
    );
  }

  /**
   * Get CORS headers based on origin
   *
   * @param origin - Request origin
   * @returns CORS headers object
   */
  private getCorsHeaders(origin: string): Record<string, string> {
    const isAllowed = this.config.corsOrigins.some((pattern) => {
      if (pattern.includes("*")) {
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        return regex.test(origin);
      }
      return pattern === origin;
    });

    if (isAllowed || origin === "*") {
      return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
    }

    return {};
  }

  /**
   * Get current stream stats
   *
   * @returns Stats object with client count and uptime
   */
  getStats(): { connectedClients: number; uptimeSeconds: number } {
    return {
      connectedClients: this.clients.size,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  /**
   * Cleanup on shutdown
   * Closes all client connections and stops heartbeat
   */
  close(): void {
    log.info("Shutting down EventsStreamManager...");

    // Stop heartbeat
    if (this.heartbeatInterval !== undefined) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    // Unsubscribe from EventBus
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Close all client connections
    for (const [_, client] of this.clients) {
      client.writer.close().catch(() => {});
    }
    this.clients.clear();

    log.info("EventsStreamManager shutdown complete");
  }
}
