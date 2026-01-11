/**
 * Resilience and reliability pattern tools
 *
 * Retry strategies, rate limiting, backoff calculations, and circuit breaker patterns.
 *
 * @module lib/std/resilience
 */

import type { MiniTool } from "./types.ts";

export const resilienceTools: MiniTool[] = [
  {
    name: "resilience_exponential_backoff",
    description:
      "Calculate exponential backoff delay for retries. Get wait time before retry attempt with optional jitter. Prevents thundering herd and cascading failures. Use for API retries, connection attempts, or queue processing. Keywords: exponential backoff, retry delay, backoff jitter, retry strategy, wait time, throttle.",
    category: "resilience",
    inputSchema: {
      type: "object",
      properties: {
        attempt: { type: "number", description: "Current attempt number (0-based)" },
        baseDelayMs: { type: "number", description: "Base delay in milliseconds (default: 1000)" },
        maxDelayMs: {
          type: "number",
          description: "Maximum delay cap in milliseconds (default: 30000)",
        },
        multiplier: { type: "number", description: "Exponential multiplier (default: 2)" },
        jitter: { type: "boolean", description: "Add random jitter (default: true)" },
        jitterFactor: { type: "number", description: "Jitter factor 0-1 (default: 0.5)" },
      },
      required: ["attempt"],
    },
    handler: (
      {
        attempt,
        baseDelayMs = 1000,
        maxDelayMs = 30000,
        multiplier = 2,
        jitter = true,
        jitterFactor = 0.5,
      },
    ) => {
      const base = baseDelayMs as number;
      const max = maxDelayMs as number;
      const mult = multiplier as number;
      const att = attempt as number;

      // Calculate exponential delay
      let delay = base * Math.pow(mult, att);

      // Cap at maximum
      delay = Math.min(delay, max);

      // Add jitter if enabled
      let finalDelay = delay;
      if (jitter) {
        const jitterAmount = delay * (jitterFactor as number);
        finalDelay = delay - jitterAmount / 2 + Math.random() * jitterAmount;
      }

      finalDelay = Math.round(finalDelay);

      return {
        delay: finalDelay,
        delaySeconds: Math.round(finalDelay / 100) / 10,
        attempt: att,
        cappedAtMax: delay >= max,
        formula: `${base} * ${mult}^${att} = ${Math.round(base * Math.pow(mult, att))}ms`,
      };
    },
  },
  {
    name: "resilience_retry_schedule",
    description:
      "Generate complete retry schedule with delays. Plan all retry attempts upfront with total time estimation. Visualize backoff pattern before implementation. Use for retry planning, SLA estimation, or debugging. Keywords: retry schedule, backoff plan, retry timing, delay sequence, attempt schedule.",
    category: "resilience",
    inputSchema: {
      type: "object",
      properties: {
        maxAttempts: { type: "number", description: "Maximum number of attempts (default: 5)" },
        baseDelayMs: { type: "number", description: "Base delay in milliseconds (default: 1000)" },
        maxDelayMs: { type: "number", description: "Maximum delay cap (default: 30000)" },
        strategy: {
          type: "string",
          enum: ["exponential", "linear", "constant", "fibonacci"],
          description: "Backoff strategy (default: exponential)",
        },
      },
    },
    handler: (
      { maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 30000, strategy = "exponential" },
    ) => {
      const max = maxAttempts as number;
      const base = baseDelayMs as number;
      const cap = maxDelayMs as number;

      const schedule: Array<{ attempt: number; delay: number; cumulative: number }> = [];
      let cumulative = 0;

      // Fibonacci sequence for that strategy
      const fib = [1, 1];
      for (let i = 2; i < max; i++) {
        fib.push(fib[i - 1] + fib[i - 2]);
      }

      for (let i = 0; i < max; i++) {
        let delay: number;

        switch (strategy) {
          case "linear":
            delay = base * (i + 1);
            break;
          case "constant":
            delay = base;
            break;
          case "fibonacci":
            delay = base * fib[i];
            break;
          default: // exponential
            delay = base * Math.pow(2, i);
        }

        delay = Math.min(delay, cap);
        cumulative += i === 0 ? 0 : delay;

        schedule.push({
          attempt: i + 1,
          delay: Math.round(delay),
          cumulative: Math.round(cumulative),
        });
      }

      const totalTime = schedule[schedule.length - 1]?.cumulative || 0;

      return {
        strategy,
        maxAttempts: max,
        schedule,
        totalTimeMs: totalTime,
        totalTimeSeconds: Math.round(totalTime / 100) / 10,
        totalTimeMinutes: Math.round(totalTime / 6000) / 10,
      };
    },
  },
  {
    name: "resilience_rate_limit_check",
    description:
      "Check if request is within rate limit using token bucket. Track requests against limits with burst capacity. Returns whether request is allowed and tokens remaining. Use for API rate limiting, request throttling, or quota management. Keywords: rate limit, token bucket, throttle, request quota, API limit, burst capacity.",
    category: "resilience",
    inputSchema: {
      type: "object",
      properties: {
        currentTokens: { type: "number", description: "Current token count" },
        maxTokens: { type: "number", description: "Maximum bucket capacity" },
        refillRate: { type: "number", description: "Tokens added per interval" },
        refillIntervalMs: { type: "number", description: "Refill interval in milliseconds" },
        lastRefillTime: { type: "number", description: "Last refill timestamp (ms since epoch)" },
        tokensRequired: {
          type: "number",
          description: "Tokens needed for this request (default: 1)",
        },
      },
      required: ["currentTokens", "maxTokens", "refillRate", "refillIntervalMs", "lastRefillTime"],
    },
    handler: (
      {
        currentTokens,
        maxTokens,
        refillRate,
        refillIntervalMs,
        lastRefillTime,
        tokensRequired = 1,
      },
    ) => {
      const now = Date.now();
      const elapsed = now - (lastRefillTime as number);
      const intervalsElapsed = Math.floor(elapsed / (refillIntervalMs as number));

      // Calculate refilled tokens
      const tokensToAdd = intervalsElapsed * (refillRate as number);
      const newTokens = Math.min((currentTokens as number) + tokensToAdd, maxTokens as number);

      // Check if request is allowed
      const required = tokensRequired as number;
      const allowed = newTokens >= required;

      // Calculate new state
      const tokensAfter = allowed ? newTokens - required : newTokens;
      const newRefillTime = (lastRefillTime as number) +
        intervalsElapsed * (refillIntervalMs as number);

      // Calculate wait time if not allowed
      let waitTimeMs = 0;
      if (!allowed) {
        const tokensNeeded = required - newTokens;
        const intervalsNeeded = Math.ceil(tokensNeeded / (refillRate as number));
        waitTimeMs = intervalsNeeded * (refillIntervalMs as number) -
          (elapsed % (refillIntervalMs as number));
      }

      return {
        allowed,
        tokensRemaining: Math.floor(tokensAfter),
        tokensBefore: Math.floor(newTokens),
        tokensRequired: required,
        waitTimeMs: allowed ? 0 : Math.ceil(waitTimeMs),
        waitTimeSeconds: allowed ? 0 : Math.ceil(waitTimeMs / 1000),
        newRefillTime,
        capacityPercent: Math.round((tokensAfter / (maxTokens as number)) * 100),
      };
    },
  },
  {
    name: "resilience_circuit_breaker_state",
    description:
      "Calculate circuit breaker state from failure metrics. Determine if circuit should be open, closed, or half-open based on failure rate. Prevents cascading failures by stopping requests to failing services. Use for service resilience, fault tolerance, or microservices. Keywords: circuit breaker, failure rate, service health, fault tolerance, trip threshold, half-open.",
    category: "resilience",
    inputSchema: {
      type: "object",
      properties: {
        totalRequests: { type: "number", description: "Total requests in window" },
        failedRequests: { type: "number", description: "Failed requests in window" },
        failureThreshold: {
          type: "number",
          description: "Failure rate threshold (0-1, default: 0.5)",
        },
        minimumRequests: {
          type: "number",
          description: "Minimum requests before evaluation (default: 10)",
        },
        lastStateChange: { type: "number", description: "Timestamp of last state change" },
        currentState: {
          type: "string",
          enum: ["closed", "open", "half-open"],
          description: "Current circuit state",
        },
        openDurationMs: {
          type: "number",
          description: "How long circuit stays open (default: 30000)",
        },
      },
      required: ["totalRequests", "failedRequests"],
    },
    handler: (
      {
        totalRequests,
        failedRequests,
        failureThreshold = 0.5,
        minimumRequests = 10,
        lastStateChange,
        currentState = "closed",
        openDurationMs = 30000,
      },
    ) => {
      const total = totalRequests as number;
      const failed = failedRequests as number;
      const threshold = failureThreshold as number;
      const minimum = minimumRequests as number;
      const state = currentState as string;
      const openDuration = openDurationMs as number;

      const failureRate = total > 0 ? failed / total : 0;
      const now = Date.now();

      let newState = state;
      let shouldAllowRequest = true;
      let reason = "";

      if (state === "closed") {
        if (total >= minimum && failureRate >= threshold) {
          newState = "open";
          shouldAllowRequest = false;
          reason = `Failure rate ${(failureRate * 100).toFixed(1)}% exceeded threshold ${
            (threshold * 100).toFixed(1)
          }%`;
        } else {
          reason = total < minimum
            ? `Not enough requests (${total}/${minimum}) to evaluate`
            : `Failure rate ${(failureRate * 100).toFixed(1)}% below threshold`;
        }
      } else if (state === "open") {
        const elapsed = lastStateChange ? now - (lastStateChange as number) : 0;
        if (elapsed >= openDuration) {
          newState = "half-open";
          shouldAllowRequest = true;
          reason = `Open duration ${openDuration}ms elapsed, testing with probe request`;
        } else {
          shouldAllowRequest = false;
          reason = `Circuit open, ${Math.ceil((openDuration - elapsed) / 1000)}s until half-open`;
        }
      } else if (state === "half-open") {
        // In half-open, allow limited requests to test
        shouldAllowRequest = true;
        reason = "Testing service availability";
      }

      return {
        previousState: state,
        newState,
        shouldAllowRequest,
        reason,
        metrics: {
          totalRequests: total,
          failedRequests: failed,
          failureRate: Math.round(failureRate * 1000) / 10, // Percentage
          successRate: Math.round((1 - failureRate) * 1000) / 10,
        },
        thresholds: {
          failureThreshold: threshold * 100,
          minimumRequests: minimum,
          openDurationMs: openDuration,
        },
        stateChangeTime: newState !== state ? now : lastStateChange,
      };
    },
  },
  {
    name: "resilience_sliding_window",
    description:
      "Calculate metrics over a sliding time window. Track request counts, error rates, and latencies within rolling window. Use for rate limiting, health monitoring, or SLA tracking. Keywords: sliding window, rolling window, time window, request metrics, window counter, rate calculation.",
    category: "resilience",
    inputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timestamp: { type: "number" },
              success: { type: "boolean" },
              latencyMs: { type: "number" },
            },
          },
          description: "Array of events with timestamp, success, and optional latency",
        },
        windowSizeMs: {
          type: "number",
          description: "Window size in milliseconds (default: 60000)",
        },
        currentTime: { type: "number", description: "Current timestamp (default: now)" },
      },
      required: ["events"],
    },
    handler: ({ events, windowSizeMs = 60000, currentTime }) => {
      const now = (currentTime as number) || Date.now();
      const windowStart = now - (windowSizeMs as number);

      const evts = events as Array<{ timestamp: number; success: boolean; latencyMs?: number }>;

      // Filter events within window
      const inWindow = evts.filter((e) => e.timestamp >= windowStart && e.timestamp <= now);
      const successful = inWindow.filter((e) => e.success);
      const failed = inWindow.filter((e) => !e.success);

      // Calculate latency stats
      const latencies = inWindow.filter((e) => e.latencyMs !== undefined).map((e) => e.latencyMs!);
      let avgLatency = 0;
      let p50 = 0;
      let p95 = 0;
      let p99 = 0;

      if (latencies.length > 0) {
        latencies.sort((a, b) => a - b);
        avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
        p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
        p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
      }

      const totalInWindow = inWindow.length;
      const successRate = totalInWindow > 0 ? successful.length / totalInWindow : 1;
      const requestsPerSecond = totalInWindow / ((windowSizeMs as number) / 1000);

      return {
        windowSizeMs: windowSizeMs as number,
        windowStart,
        windowEnd: now,
        totalEvents: evts.length,
        eventsInWindow: totalInWindow,
        successful: successful.length,
        failed: failed.length,
        successRate: Math.round(successRate * 1000) / 10,
        errorRate: Math.round((1 - successRate) * 1000) / 10,
        requestsPerSecond: Math.round(requestsPerSecond * 100) / 100,
        latency: latencies.length > 0
          ? {
            avg: Math.round(avgLatency),
            p50: Math.round(p50),
            p95: Math.round(p95),
            p99: Math.round(p99),
            min: Math.round(Math.min(...latencies)),
            max: Math.round(Math.max(...latencies)),
          }
          : null,
      };
    },
  },
  {
    name: "resilience_deadline",
    description:
      "Calculate remaining time until deadline. Check if deadline has passed and compute time remaining or overdue. Use for timeout management, SLA tracking, or task scheduling. Keywords: deadline, timeout, time remaining, SLA, due time, expiration.",
    category: "resilience",
    inputSchema: {
      type: "object",
      properties: {
        deadline: { type: "number", description: "Deadline timestamp (ms since epoch)" },
        currentTime: { type: "number", description: "Current time (default: now)" },
        warnThresholdMs: {
          type: "number",
          description: "Warning threshold before deadline (default: 5000)",
        },
      },
      required: ["deadline"],
    },
    handler: ({ deadline, currentTime, warnThresholdMs = 5000 }) => {
      const now = (currentTime as number) || Date.now();
      const dl = deadline as number;
      const warn = warnThresholdMs as number;

      const remaining = dl - now;
      const expired = remaining <= 0;
      const warning = !expired && remaining <= warn;

      return {
        deadline: dl,
        currentTime: now,
        remaining: Math.abs(remaining),
        remainingSeconds: Math.round(Math.abs(remaining) / 100) / 10,
        expired,
        warning,
        status: expired ? "expired" : warning ? "warning" : "ok",
        deadlineDate: new Date(dl).toISOString(),
        overdueBy: expired ? Math.abs(remaining) : 0,
      };
    },
  },
  {
    name: "resilience_bulkhead",
    description:
      "Check bulkhead pattern capacity for request isolation. Limit concurrent requests to protect resources and prevent cascading failures. Use for resource protection, connection pooling, or thread limiting. Keywords: bulkhead, concurrency limit, isolation, resource pool, connection limit, capacity.",
    category: "resilience",
    inputSchema: {
      type: "object",
      properties: {
        currentConcurrent: { type: "number", description: "Current concurrent requests" },
        maxConcurrent: { type: "number", description: "Maximum concurrent capacity" },
        queueSize: { type: "number", description: "Current queue size" },
        maxQueueSize: { type: "number", description: "Maximum queue capacity" },
      },
      required: ["currentConcurrent", "maxConcurrent"],
    },
    handler: ({ currentConcurrent, maxConcurrent, queueSize = 0, maxQueueSize = 0 }) => {
      const current = currentConcurrent as number;
      const max = maxConcurrent as number;
      const queue = queueSize as number;
      const maxQueue = maxQueueSize as number;

      const available = max - current;
      const canProcess = available > 0;
      const canQueue = !canProcess && maxQueue > 0 && queue < maxQueue;

      let action: string;
      if (canProcess) {
        action = "process";
      } else if (canQueue) {
        action = "queue";
      } else {
        action = "reject";
      }

      return {
        canProcess,
        canQueue,
        action,
        capacity: {
          current,
          max,
          available,
          utilizationPercent: Math.round((current / max) * 100),
        },
        queue: maxQueue > 0
          ? {
            current: queue,
            max: maxQueue,
            available: maxQueue - queue,
            utilizationPercent: Math.round((queue / maxQueue) * 100),
          }
          : null,
      };
    },
  },
  {
    name: "resilience_health_score",
    description:
      "Calculate composite health score from multiple metrics. Combine error rate, latency, and availability into single 0-100 score. Use for dashboards, alerting, or service discovery. Keywords: health score, service health, composite metric, availability, SLI, health check.",
    category: "resilience",
    inputSchema: {
      type: "object",
      properties: {
        errorRate: { type: "number", description: "Error rate 0-1 (0 = no errors)" },
        latencyMs: { type: "number", description: "Average latency in milliseconds" },
        targetLatencyMs: { type: "number", description: "Target latency SLO (default: 200)" },
        availability: { type: "number", description: "Availability 0-1 (default: 1)" },
        weights: {
          type: "object",
          properties: {
            errors: { type: "number" },
            latency: { type: "number" },
            availability: { type: "number" },
          },
          description: "Weights for each metric (default: equal)",
        },
      },
      required: ["errorRate", "latencyMs"],
    },
    handler: ({ errorRate, latencyMs, targetLatencyMs = 200, availability = 1, weights }) => {
      const err = errorRate as number;
      const lat = latencyMs as number;
      const target = targetLatencyMs as number;
      const avail = availability as number;

      const w = (weights as { errors?: number; latency?: number; availability?: number }) || {};
      const errWeight = w.errors ?? 1;
      const latWeight = w.latency ?? 1;
      const availWeight = w.availability ?? 1;
      const totalWeight = errWeight + latWeight + availWeight;

      // Calculate individual scores (0-100)
      const errorScore = (1 - Math.min(err, 1)) * 100;
      const latencyScore = Math.max(0, (1 - (lat / target) + 1) / 2) * 100; // 100 at target, 50 at 2x target
      const availScore = avail * 100;

      // Weighted average
      const score = Math.round(
        (errorScore * errWeight + latencyScore * latWeight + availScore * availWeight) /
          totalWeight,
      );

      // Determine status
      let status: string;
      if (score >= 90) status = "healthy";
      else if (score >= 70) status = "degraded";
      else if (score >= 50) status = "unhealthy";
      else status = "critical";

      return {
        score,
        status,
        components: {
          errors: {
            score: Math.round(errorScore),
            weight: errWeight,
            value: `${(err * 100).toFixed(1)}%`,
          },
          latency: {
            score: Math.round(latencyScore),
            weight: latWeight,
            value: `${lat}ms`,
            target: `${target}ms`,
          },
          availability: {
            score: Math.round(availScore),
            weight: availWeight,
            value: `${(avail * 100).toFixed(1)}%`,
          },
        },
        thresholds: {
          healthy: "≥90",
          degraded: "70-89",
          unhealthy: "50-69",
          critical: "<50",
        },
      };
    },
  },
];
