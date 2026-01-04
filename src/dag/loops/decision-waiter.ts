/**
 * Decision Waiter Module
 *
 * Handles waiting for AIL/HIL decision commands via CommandQueue.
 * Provides non-blocking polling with configurable timeout.
 *
 * @module dag/loops/decision-waiter
 */

import type { CommandQueue } from "../command-queue.ts";
import { getLogger } from "../../telemetry/logger.ts";

const log = getLogger("default");

/**
 * Command received from the queue
 */
export interface DecisionCommand {
  type: string;
  approved?: boolean;
  feedback?: string;
  reason?: string;
  new_requirement?: string;
  available_context?: unknown;
}

/**
 * Type guard to validate DecisionCommand structure
 *
 * @param cmd - Unknown command to validate
 * @returns true if cmd is a valid DecisionCommand
 */
export function isDecisionCommand(cmd: unknown): cmd is DecisionCommand {
  if (typeof cmd !== "object" || cmd === null) return false;
  const obj = cmd as Record<string, unknown>;
  // Required: type must be a string
  if (typeof obj.type !== "string") return false;
  // Optional fields type validation
  if (obj.approved !== undefined && typeof obj.approved !== "boolean") return false;
  if (obj.feedback !== undefined && typeof obj.feedback !== "string") return false;
  if (obj.reason !== undefined && typeof obj.reason !== "string") return false;
  if (obj.new_requirement !== undefined && typeof obj.new_requirement !== "string") return false;
  return true;
}

/**
 * Wait for a decision command from the queue
 *
 * Uses proper Promise-based waiting (no CPU-burning polling).
 * Leverages CommandQueue.waitForCommand() which internally uses
 * AsyncQueue.dequeue() with Promise.race() for timeout.
 *
 * @param commandQueue - CommandQueue to wait on
 * @param decisionType - "AIL" or "HIL" for logging
 * @param timeout - Timeout in ms (default: 5 minutes)
 * @returns Command from queue or null if timeout
 */
export async function waitForDecisionCommand(
  commandQueue: CommandQueue,
  decisionType: "AIL" | "HIL",
  timeout: number = 300000, // 5 minutes
): Promise<DecisionCommand | null> {
  log.debug(`[DEBUG] waitForDecisionCommand: waiting`, { decisionType, timeout });
  const cmd = await commandQueue.waitForCommand(timeout);
  log.debug(`[DEBUG] waitForDecisionCommand: got result`, {
    hasCommand: cmd !== null,
    cmdType: (cmd as { type?: string })?.type ?? "null",
  });

  if (cmd === null) {
    log.warn(`${decisionType} decision timeout after ${timeout}ms`);
    return null;
  }

  // Validate command structure
  if (isDecisionCommand(cmd)) {
    return cmd;
  }

  log.warn(`Invalid ${decisionType} command received: ${JSON.stringify(cmd)}`);
  return null;
}
