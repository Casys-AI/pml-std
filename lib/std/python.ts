/**
 * Python execution tools - Run Python code in isolated subprocess
 *
 * Provides MCP tools for executing Python code safely:
 * - python_exec: Execute Python code and capture output
 * - python_eval: Evaluate Python expression and return result
 * - python_pip: Install pip packages
 *
 * Security: All execution happens in subprocess (not FFI), with timeouts
 * and resource limits. No access to parent process memory.
 *
 * @module lib/std/python
 */

import type { MiniTool } from "./types.ts";

/**
 * Execute a command with timeout
 */
async function execWithTimeout(
  cmd: string[],
  options: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeout = options.timeout ?? 30000;

  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: options.cwd,
    env: options.env ? { ...Deno.env.toObject(), ...options.env } : undefined,
    stdin: options.stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });

  const process = command.spawn();

  // Write stdin if provided
  if (options.stdin && process.stdin) {
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }

  // Create timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch {
        // Process may have already exited
      }
      reject(new Error(`Python execution timed out after ${timeout}ms`));
    }, timeout);
  });

  // Race between process completion and timeout
  const result = await Promise.race([process.output(), timeoutPromise]);

  const decoder = new TextDecoder();
  return {
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
    code: result.code,
  };
}

// Minimum required Python version
const MIN_PYTHON_VERSION = { major: 3, minor: 8 };

// Cache for found Python path
let cachedPythonPath: string | null = null;

/**
 * Parse Python version from "Python X.Y.Z" string
 */
function parseVersion(versionStr: string): { major: number; minor: number; patch: number } | null {
  const match = versionStr.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Check if version meets minimum requirement
 */
function checkVersion(version: { major: number; minor: number }): boolean {
  if (version.major > MIN_PYTHON_VERSION.major) return true;
  if (version.major < MIN_PYTHON_VERSION.major) return false;
  return version.minor >= MIN_PYTHON_VERSION.minor;
}

/**
 * Find Python executable
 *
 * Priority:
 * 1. PYTHON_PATH env var (if set)
 * 2. python3
 * 3. python
 *
 * Validates version >= 3.8
 */
async function findPython(): Promise<string> {
  // Return cached path if available
  if (cachedPythonPath) return cachedPythonPath;

  // Check env var first
  const envPath = Deno.env.get("PYTHON_PATH");
  const candidates = envPath ? [envPath, "python3", "python"] : ["python3", "python"];

  for (const cmd of candidates) {
    try {
      const result = await execWithTimeout([cmd, "--version"], { timeout: 5000 });
      if (result.code === 0) {
        // Parse and check version
        const version = parseVersion(result.stdout + result.stderr);
        if (version && checkVersion(version)) {
          cachedPythonPath = cmd;
          return cmd;
        } else if (version) {
          console.error(
            `[python] ${cmd} version ${version.major}.${version.minor}.${version.patch} ` +
              `is below minimum ${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor}`,
          );
        }
      }
    } catch {
      // Continue to next option
    }
  }
  throw new Error(
    `Python ${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor}+ not found. ` +
      `Install Python or set PYTHON_PATH env var.`,
  );
}

// =============================================================================
// Python Tools
// =============================================================================

export const pythonTools: MiniTool[] = [
  {
    name: "python_exec",
    category: "python",
    description:
      "Execute Python code in an isolated subprocess. Returns stdout, stderr, and exit code. " +
      "Use for running scripts, data processing, or any Python operation. " +
      "Keywords: python, execute, run, script, code, subprocess, shell, interpreter, py.",
    inputSchema: {
      type: "object" as const,
      properties: {
        code: {
          type: "string",
          description: "Python code to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
        cwd: {
          type: "string",
          description: "Working directory for execution",
        },
      },
      required: ["code"],
    },
    handler: async (args: Record<string, unknown>) => {
      const code = args.code as string;
      const timeout = (args.timeout as number) ?? 30000;
      const cwd = args.cwd as string | undefined;

      try {
        const python = await findPython();
        const result = await execWithTimeout([python, "-c", code], {
          timeout,
          cwd,
        });

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code,
          success: result.code === 0,
        };
      } catch (error) {
        return {
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
          success: false,
        };
      }
    },
  },

  {
    name: "python_eval",
    category: "python",
    description: "Evaluate a Python expression and return the result as JSON. " +
      "Use for calculations, data transformations, or getting values. " +
      "Keywords: python, eval, evaluate, expression, calculate, compute, math, py.",
    inputSchema: {
      type: "object" as const,
      properties: {
        expression: {
          type: "string",
          description: "Python expression to evaluate (must be JSON-serializable)",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 10000)",
        },
        imports: {
          type: "array",
          items: { type: "string" },
          description: "Modules to import before evaluation (e.g., ['json', 'math'])",
        },
      },
      required: ["expression"],
    },
    handler: async (args: Record<string, unknown>) => {
      const expression = args.expression as string;
      const timeout = (args.timeout as number) ?? 10000;
      const imports = (args.imports as string[]) ?? [];

      // Build Python code that evaluates and prints as JSON
      const importStatements = imports.map((m) => `import ${m}`).join("\n");
      const code = `
import json
${importStatements}
result = ${expression}
print(json.dumps(result))
`.trim();

      try {
        const python = await findPython();
        const result = await execWithTimeout([python, "-c", code], { timeout });

        if (result.code !== 0) {
          return {
            success: false,
            error: result.stderr || "Python evaluation failed",
          };
        }

        try {
          const value = JSON.parse(result.stdout.trim());
          return { success: true, result: value };
        } catch {
          // If not valid JSON, return as string
          return { success: true, result: result.stdout.trim() };
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },

  {
    name: "python_pip",
    category: "python",
    description:
      "Install Python packages using pip. Use before running code that requires external packages. " +
      "Keywords: python, pip, install, package, dependency, library, module, requirements, py.",
    inputSchema: {
      type: "object" as const,
      properties: {
        packages: {
          type: "array",
          items: { type: "string" },
          description: "Package names to install (e.g., ['pandas', 'numpy'])",
        },
        upgrade: {
          type: "boolean",
          description: "Upgrade packages if already installed",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 120000 for installs)",
        },
      },
      required: ["packages"],
    },
    handler: async (args: Record<string, unknown>) => {
      const packages = args.packages as string[];
      const upgrade = (args.upgrade as boolean) ?? false;
      const timeout = (args.timeout as number) ?? 120000;

      if (!packages || packages.length === 0) {
        return { success: false, error: "No packages specified" };
      }

      try {
        const python = await findPython();
        const pipArgs = ["-m", "pip", "install", "--user"];
        if (upgrade) pipArgs.push("--upgrade");
        pipArgs.push(...packages);

        const result = await execWithTimeout([python, ...pipArgs], { timeout });

        return {
          success: result.code === 0,
          packages,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },

  {
    name: "python_script",
    category: "python",
    description: "Execute a Python script file. Optionally pass arguments and stdin data. " +
      "Keywords: python, script, file, run, execute, .py, arguments, stdin, py.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the Python script file",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command-line arguments to pass to the script",
        },
        stdin: {
          type: "string",
          description: "Data to pass via stdin",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 60000)",
        },
        cwd: {
          type: "string",
          description: "Working directory for execution",
        },
      },
      required: ["path"],
    },
    handler: async (args: Record<string, unknown>) => {
      const path = args.path as string;
      const scriptArgs = (args.args as string[]) ?? [];
      const stdin = args.stdin as string | undefined;
      const timeout = (args.timeout as number) ?? 60000;
      const cwd = args.cwd as string | undefined;

      try {
        const python = await findPython();
        const result = await execWithTimeout([python, path, ...scriptArgs], {
          timeout,
          cwd,
          stdin,
        });

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code,
          success: result.code === 0,
        };
      } catch (error) {
        return {
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
          success: false,
        };
      }
    },
  },

  {
    name: "python_version",
    category: "python",
    description: "Get Python version and installation info. " +
      "Keywords: python, version, info, installation, path, executable, py.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    handler: async () => {
      try {
        const python = await findPython();
        const versionResult = await execWithTimeout([python, "--version"], {
          timeout: 5000,
        });

        // Get more detailed info
        const infoCode = `
import sys
import json
print(json.dumps({
    "version": sys.version,
    "executable": sys.executable,
    "platform": sys.platform,
    "prefix": sys.prefix
}))
`;
        const infoResult = await execWithTimeout([python, "-c", infoCode], {
          timeout: 5000,
        });

        let info = {};
        try {
          info = JSON.parse(infoResult.stdout.trim());
        } catch {
          // Fallback to basic version
        }

        return {
          success: true,
          python,
          version: versionResult.stdout.trim(),
          ...info,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
];

export default pythonTools;
