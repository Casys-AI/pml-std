/**
 * Structured Logging Module
 *
 * Provides structured logging with console and file output using Deno std/log.
 * Supports multiple log levels and logger instances for different modules.
 *
 * @module telemetry/logger
 */

import * as log from "@std/log";
import { FileHandler } from "@std/log/file-handler";
import type { LevelName, LogRecord } from "@std/log";
import { ensureDir } from "@std/fs";
import type { LoggerConfig } from "./types.ts";

/**
 * Default log file path
 */
const DEFAULT_LOG_FILE = `${
  Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "."
}/.pml/logs/pml.log`;

/**
 * Maximum log file size (10MB) before rotation
 */
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Check if log file needs rotation
 */
async function shouldRotateLog(filePath: string): Promise<boolean> {
  try {
    const fileInfo = await Deno.stat(filePath);
    return fileInfo.size >= MAX_LOG_FILE_SIZE;
  } catch {
    // File doesn't exist yet
    return false;
  }
}

/**
 * Rotate log file by renaming with timestamp
 */
async function rotateLogFile(filePath: string): Promise<void> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rotatedPath = filePath.replace(".log", `-${timestamp}.log`);
    await Deno.rename(filePath, rotatedPath);
    log.info(`Log file rotated: ${rotatedPath}`);
  } catch (error) {
    log.error(`Failed to rotate log file: ${error}`);
  }
}

/**
 * Custom file handler with log rotation support
 */
class RotatingFileHandler extends FileHandler {
  private filePath: string;

  constructor(
    levelName: LevelName,
    options: { filename: string; formatter?: (record: LogRecord) => string },
  ) {
    super(levelName, options);
    this.filePath = options.filename;
  }

  override async log(msg: string): Promise<void> {
    // Check if rotation is needed before writing
    if (await shouldRotateLog(this.filePath)) {
      await rotateLogFile(this.filePath);
    }
    await super.log(msg);
  }
}

/**
 * ANSI color codes for log levels
 */
const LEVEL_COLORS: Record<string, string> = {
  DEBUG: "\x1b[36m", // Cyan
  INFO: "\x1b[32m", // Green
  WARN: "\x1b[33m", // Yellow
  ERROR: "\x1b[31m", // Red
  CRITICAL: "\x1b[35m", // Magenta
};
const RESET = "\x1b[0m";

/**
 * Custom console handler that writes to stderr instead of stdout
 * Required for MCP servers: stdout must be reserved for JSON-RPC messages only
 */
class StderrHandler extends log.BaseHandler {
  private encoder = new TextEncoder();
  private useColors: boolean;

  constructor(
    levelName: LevelName,
    options: { formatter?: (record: LogRecord) => string; useColors?: boolean },
  ) {
    super(levelName, options);
    this.useColors = options.useColors ?? Deno.stderr.isTerminal();
  }

  override log(msg: string): void {
    Deno.stderr.writeSync(this.encoder.encode(msg + "\n"));
  }

  override format(record: LogRecord): string {
    const level = record.levelName.padEnd(7);
    const timestamp = record.datetime.toISOString();

    if (this.useColors) {
      const color = LEVEL_COLORS[record.levelName] || "";
      return `${color}[${level}]${RESET} ${timestamp} - ${record.msg}`;
    }
    return `[${level}] ${timestamp} - ${record.msg}`;
  }
}

/**
 * Initialize the logging system with console and file handlers
 *
 * Sets up multiple loggers:
 * - default: General application logging (DEBUG level, console + file)
 * - mcp: MCP server operations (INFO level, console + file)
 * - vector: Vector search operations (DEBUG level, file only)
 *
 * @param config Optional logger configuration
 */
export async function setupLogger(config?: LoggerConfig): Promise<void> {
  const logFilePath = config?.logFilePath || DEFAULT_LOG_FILE;

  // Ensure log directory exists
  const logDir = logFilePath.substring(0, logFilePath.lastIndexOf("/"));
  await ensureDir(logDir);

  // Check if rotation is needed before setup
  if (await shouldRotateLog(logFilePath)) {
    await rotateLogFile(logFilePath);
  }

  await log.setup({
    handlers: {
      // Use StderrHandler instead of ConsoleHandler to avoid polluting stdout
      // MCP protocol requires stdout to be reserved for JSON-RPC messages only
      console: new StderrHandler("DEBUG", {}),

      file: new RotatingFileHandler("INFO", {
        filename: logFilePath,
        formatter: (record: LogRecord) => {
          return JSON.stringify({
            level: record.levelName,
            timestamp: record.datetime.toISOString(),
            message: record.msg,
            ...record.args,
          });
        },
      }),
    },

    loggers: {
      default: {
        level: config?.level || "DEBUG",
        handlers: ["console", "file"],
      },

      // MCP server operations
      mcp: {
        level: "INFO",
        handlers: ["console", "file"],
      },

      // Vector search operations (verbose, file only)
      vector: {
        level: "DEBUG",
        handlers: ["file"],
      },

      // DAG event stream (Story 2.5-1)
      "event-stream": {
        level: "DEBUG",
        handlers: ["file"],
      },

      // DAG command queue (Story 2.5-1)
      "command-queue": {
        level: "DEBUG",
        handlers: ["file"],
      },

      // Controlled executor (Story 2.5-1)
      "controlled-executor": {
        level: "INFO",
        handlers: ["console", "file"],
      },
    },
  });

  log.info("Casys PML logging initialized", {
    logFile: logFilePath,
    level: config?.level || "DEBUG",
  });
}

/**
 * Get logger instance by name
 *
 * @param name Logger name (default, mcp, vector, event-stream, command-queue, controlled-executor)
 * @returns Logger instance
 */
export function getLogger(
  name: "default" | "mcp" | "vector" | "event-stream" | "command-queue" | "controlled-executor" | "dag-optimizer" | "trace-generator" =
    "default",
) {
  return log.getLogger(name);
}

/**
 * Log convenience functions for default logger
 */
export const logger = {
  debug: (msg: string, ...args: unknown[]) => log.debug(msg, ...args),
  info: (msg: string, ...args: unknown[]) => log.info(msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log.warn(msg, ...args),
  error: (msg: string, ...args: unknown[]) => log.error(msg, ...args),
};
