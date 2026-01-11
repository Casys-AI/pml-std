/**
 * Common utilities for system tools
 *
 * @module lib/std/tools/common
 */

import type { MiniTool } from "./types.ts";

export type { MiniTool };

/**
 * Run a command and return output
 */
export async function runCommand(
  cmd: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const command = new Deno.Command(cmd, {
      args,
      cwd: options?.cwd,
      stdout: "piped",
      stderr: "piped",
    });

    const timeoutMs = options?.timeout ?? 30000;
    const process = command.spawn();

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        try {
          process.kill("SIGTERM");
        } catch { /* ignore */ }
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // Race between command completion and timeout
    const output = await Promise.race([process.output(), timeoutPromise]);

    return {
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      code: output.code,
    };
  } catch (e) {
    if ((e as Error).message?.includes("timed out")) {
      throw e;
    }
    throw new Error(`Failed to execute ${cmd}: ${(e as Error).message}`);
  }
}
