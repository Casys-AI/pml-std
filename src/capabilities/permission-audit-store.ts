/**
 * Permission Audit Store (Story 7.7c - HIL Permission Escalation)
 *
 * Persists audit trail for all permission escalation decisions.
 * Every escalation request (approved or rejected) is logged for security audit.
 *
 * @module capabilities/permission-audit-store
 */

import type { DbClient } from "../db/types.ts";
import type { PermissionAuditLogEntry, PermissionSet } from "./types.ts";
import { getLogger } from "../telemetry/logger.ts";

const logger = getLogger("default");

/**
 * Input for logging a permission escalation decision
 */
export interface LogEscalationInput {
  /** UUID of the capability requesting escalation */
  capabilityId: string;
  /** Permission set before escalation */
  fromSet: PermissionSet;
  /** Permission set requested/granted */
  toSet: PermissionSet;
  /** Whether the escalation was approved */
  approved: boolean;
  /** Who approved (user_id or "system") */
  approvedBy?: string;
  /** Original error message that triggered escalation */
  reason?: string;
  /** Detected operation (e.g., "fetch", "read", "write") */
  detectedOperation?: string;
}

/**
 * Filters for querying audit log
 */
export interface AuditLogFilters {
  /** Filter by capability ID */
  capabilityId?: string;
  /** Filter by approval status */
  approved?: boolean;
  /** Filter by time range (start timestamp) */
  fromTimestamp?: Date;
  /** Filter by time range (end timestamp) */
  toTimestamp?: Date;
  /** Maximum results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * PermissionAuditStore - Persistence layer for permission escalation audit trail
 *
 * All escalation decisions (approved or rejected) are logged for:
 * - Security audit compliance
 * - Pattern analysis (which capabilities need escalations)
 * - Detecting potential misuse
 *
 * @example
 * ```typescript
 * const store = new PermissionAuditStore(db);
 *
 * // Log an approved escalation
 * await store.logEscalation({
 *   capabilityId: "cap-uuid",
 *   fromSet: "minimal",
 *   toSet: "network-api",
 *   approved: true,
 *   approvedBy: "user-123",
 *   reason: "PermissionDenied: Requires net access to api.example.com",
 *   detectedOperation: "net",
 * });
 *
 * // Query audit log
 * const logs = await store.getAuditLog({ capabilityId: "cap-uuid" });
 * ```
 */
export class PermissionAuditStore {
  constructor(private db: DbClient) {
    logger.debug("PermissionAuditStore initialized");
  }

  /**
   * Log a permission escalation decision
   *
   * @param input - Escalation details to log
   * @returns The created audit log entry
   */
  async logEscalation(input: LogEscalationInput): Promise<PermissionAuditLogEntry> {
    const id = crypto.randomUUID();
    const timestamp = Date.now();

    const {
      capabilityId,
      fromSet,
      toSet,
      approved,
      approvedBy,
      reason,
      detectedOperation,
    } = input;

    await this.db.query(
      `INSERT INTO permission_audit_log (
        id, timestamp, capability_id, from_set, to_set,
        approved, approved_by, reason, detected_operation
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        timestamp,
        capabilityId,
        fromSet,
        toSet,
        approved ? 1 : 0,
        approvedBy ?? null,
        reason ?? null,
        detectedOperation ?? null,
      ],
    );

    const entry: PermissionAuditLogEntry = {
      id,
      timestamp: new Date(timestamp),
      capabilityId,
      fromSet,
      toSet,
      approved,
      approvedBy,
      reason,
      detectedOperation,
    };

    logger.info("Permission escalation logged", {
      id,
      capabilityId,
      fromSet,
      toSet,
      approved,
      approvedBy,
    });

    return entry;
  }

  /**
   * Query the audit log with optional filters
   *
   * @param filters - Optional filters for the query
   * @returns Array of audit log entries
   */
  async getAuditLog(filters?: AuditLogFilters): Promise<PermissionAuditLogEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters?.capabilityId) {
      conditions.push(`capability_id = $${paramIndex++}`);
      params.push(filters.capabilityId);
    }

    if (filters?.approved !== undefined) {
      conditions.push(`approved = $${paramIndex++}`);
      params.push(filters.approved ? 1 : 0);
    }

    if (filters?.fromTimestamp) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(filters.fromTimestamp.getTime());
    }

    if (filters?.toTimestamp) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(filters.toTimestamp.getTime());
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = filters?.limit ? `LIMIT ${filters.limit}` : "";
    const offsetClause = filters?.offset ? `OFFSET ${filters.offset}` : "";

    const query = `
      SELECT * FROM permission_audit_log
      ${whereClause}
      ORDER BY timestamp DESC
      ${limitClause}
      ${offsetClause}
    `;

    const rows = await this.db.query(query, params);

    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Get audit log entries for a specific capability
   *
   * Convenience method for common use case.
   *
   * @param capabilityId - UUID of the capability
   * @param limit - Maximum results (default: 50)
   * @returns Array of audit log entries
   */
  async getAuditLogForCapability(
    capabilityId: string,
    limit = 50,
  ): Promise<PermissionAuditLogEntry[]> {
    return this.getAuditLog({ capabilityId, limit });
  }

  /**
   * Get count of escalations for a capability
   *
   * @param capabilityId - UUID of the capability
   * @returns Count of escalation requests (both approved and rejected)
   */
  async getEscalationCount(capabilityId: string): Promise<{
    total: number;
    approved: number;
    rejected: number;
  }> {
    const result = await this.db.queryOne(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as rejected
      FROM permission_audit_log
      WHERE capability_id = $1`,
      [capabilityId],
    );

    return {
      total: Number(result?.total ?? 0),
      approved: Number(result?.approved ?? 0),
      rejected: Number(result?.rejected ?? 0),
    };
  }

  /**
   * Get recent escalation statistics
   *
   * Useful for monitoring and alerting on unusual escalation patterns.
   *
   * @param hours - Time window in hours (default: 24)
   * @returns Escalation statistics
   */
  async getRecentStats(hours = 24): Promise<{
    totalRequests: number;
    approvedCount: number;
    rejectedCount: number;
    approvalRate: number;
    uniqueCapabilities: number;
  }> {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;

    const result = await this.db.queryOne(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as rejected,
        COUNT(DISTINCT capability_id) as unique_caps
      FROM permission_audit_log
      WHERE timestamp >= $1`,
      [cutoff],
    );

    const total = Number(result?.total ?? 0);
    const approved = Number(result?.approved ?? 0);

    return {
      totalRequests: total,
      approvedCount: approved,
      rejectedCount: Number(result?.rejected ?? 0),
      approvalRate: total > 0 ? approved / total : 0,
      uniqueCapabilities: Number(result?.unique_caps ?? 0),
    };
  }

  /**
   * Convert database row to PermissionAuditLogEntry
   */
  private rowToEntry(row: Record<string, unknown>): PermissionAuditLogEntry {
    return {
      id: row.id as string,
      timestamp: new Date(row.timestamp as number),
      capabilityId: row.capability_id as string,
      fromSet: row.from_set as PermissionSet,
      toSet: row.to_set as PermissionSet,
      approved: (row.approved as number) === 1,
      approvedBy: row.approved_by as string | undefined,
      reason: row.reason as string | undefined,
      detectedOperation: row.detected_operation as string | undefined,
    };
  }
}
