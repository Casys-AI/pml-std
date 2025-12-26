/**
 * Telemetry Service
 *
 * Provides opt-in telemetry tracking with local storage only.
 * NO sensitive data (queries, schemas) is collected.
 * All metrics stored locally in PGlite database.
 *
 * @module telemetry/telemetry
 */

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { ensureDir } from "@std/fs";
import * as log from "@std/log";
import type { DbClient } from "../db/types.ts";
import type { TelemetryConfig } from "./types.ts";

/**
 * Default config file path
 */
const DEFAULT_CONFIG_PATH = `${
  Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "."
}/.pml/config.yaml`;

/**
 * Telemetry Service
 *
 * Handles telemetry tracking with opt-in consent.
 * Default: disabled (privacy-first)
 */
export class TelemetryService {
  private enabled: boolean = false;
  private db: DbClient;
  private configPath: string;

  constructor(db: DbClient, configPath?: string) {
    this.db = db;
    this.configPath = configPath || DEFAULT_CONFIG_PATH;
    this.enabled = false; // Default to disabled
  }

  /**
   * Initialize telemetry service by loading preference from config
   */
  async initialize(): Promise<void> {
    this.enabled = await this.loadTelemetryPreference();
  }

  /**
   * Check if this is the first run (config file doesn't exist)
   */
  async isFirstRun(): Promise<boolean> {
    try {
      await Deno.stat(this.configPath);
      return false;
    } catch {
      // Config file doesn't exist
      return true;
    }
  }

  /**
   * Track a telemetry metric
   *
   * Only records if telemetry is enabled. All data stored locally.
   *
   * @param metricName Name of the metric
   * @param value Numeric value
   * @param metadata Optional additional context
   */
  async track(
    metricName: string,
    value: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.enabled) {
      return; // Telemetry disabled, skip tracking
    }

    try {
      await this.db.query(
        `INSERT INTO metrics (metric_name, value, metadata, timestamp)
         VALUES ($1, $2, $3::jsonb, NOW())`,
        [metricName, value, metadata || {}], // postgres.js/pglite auto-serializes to JSONB
      );

      log.debug(`Tracked metric: ${metricName} = ${value}`, metadata);
    } catch (error) {
      log.error(`Failed to track metric ${metricName}: ${error}`);
      // Don't throw - metric tracking failure shouldn't break the application
    }
  }

  /**
   * Load telemetry preference from config file
   *
   * @returns true if telemetry is enabled, false otherwise (default)
   */
  private async loadTelemetryPreference(): Promise<boolean> {
    try {
      const configText = await Deno.readTextFile(this.configPath);
      const config = parseYaml(configText) as Record<string, unknown>;

      // Check if telemetry config exists
      if (config.telemetry && typeof config.telemetry === "object") {
        const telemetryConfig = config.telemetry as TelemetryConfig;
        return telemetryConfig.enabled ?? false;
      }

      return false; // Default to disabled
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        log.debug("Config file not found, telemetry disabled by default");
      } else {
        log.error(`Failed to load telemetry preference: ${error}`);
      }
      return false; // Default to disabled on error
    }
  }

  /**
   * Prompt user for telemetry consent (first run only)
   *
   * Displays privacy information and asks for consent.
   * Saves the user's choice to config file.
   */
  async promptConsent(): Promise<void> {
    console.log("\n📊 Telemetry & Analytics");
    console.log("─────────────────────────");
    console.log("Casys PML can collect anonymous usage metrics to improve the product.");
    console.log("Metrics include: context usage %, query latency, tool counts.");
    console.log("NO sensitive data (queries, schemas, outputs) is collected.\n");

    const response = prompt("Enable telemetry? (y/N):", "N");
    this.enabled = response?.toLowerCase() === "y";

    await this.saveTelemetryPreference(this.enabled);

    if (this.enabled) {
      console.log("✓ Telemetry enabled. Thank you!\n");
    } else {
      console.log("✓ Telemetry disabled. You can enable it later with --telemetry\n");
    }
  }

  /**
   * Save telemetry preference to config file
   *
   * @param enabled Whether telemetry should be enabled
   */
  async saveTelemetryPreference(enabled: boolean): Promise<void> {
    try {
      // Ensure config directory exists
      const configDir = this.configPath.substring(0, this.configPath.lastIndexOf("/"));
      await ensureDir(configDir);

      // Load existing config or create new one
      let config: Record<string, unknown> = {};
      try {
        const configText = await Deno.readTextFile(this.configPath);
        config = parseYaml(configText) as Record<string, unknown>;
      } catch {
        // Config doesn't exist yet, use empty object
      }

      // Update telemetry setting
      config.telemetry = { enabled };

      // Write config back
      await Deno.writeTextFile(this.configPath, stringifyYaml(config));

      log.info(`Telemetry preference saved: ${enabled}`);
    } catch (error) {
      log.error(`Failed to save telemetry preference: ${error}`);
      throw error;
    }
  }

  /**
   * Check if telemetry is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable or disable telemetry
   *
   * @param enabled Whether to enable telemetry
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await this.saveTelemetryPreference(enabled);
  }
}
