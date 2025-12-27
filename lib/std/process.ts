/**
 * Process tools - process management and system info
 *
 * @module lib/std/tools/process
 */

import { type MiniTool, runCommand } from "./common.ts";

export const processTools: MiniTool[] = [
  {
    name: "ps_list",
    description:
      "List running processes with detailed resource usage. Shows CPU%, memory%, PID, user, and command for each process. Filter by name or user, sort by resource consumption. Use for finding resource-hungry processes, debugging, or monitoring system load. Keywords: ps aux, process list, running programs, CPU usage, memory usage, task manager, top processes.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by process name" },
        user: { type: "string", description: "Filter by user" },
        sort: { type: "string", enum: ["cpu", "mem", "pid", "time"], description: "Sort by field" },
        limit: { type: "number", description: "Limit number of results" },
      },
    },
    handler: async ({ filter, user, sort = "cpu", limit = 20 }) => {
      const sortField = { cpu: "-%cpu", mem: "-%mem", pid: "pid", time: "-time" }[sort as string] ||
        "-%cpu";
      const args = ["aux", "--sort", sortField];

      const result = await runCommand("ps", args);
      if (result.code !== 0) {
        throw new Error(`ps failed: ${result.stderr}`);
      }

      const lines = result.stdout.trim().split("\n");
      let processes = lines.slice(1).map((line) => {
        const parts = line.split(/\s+/);
        return {
          user: parts[0],
          pid: parseInt(parts[1], 10),
          cpu: parseFloat(parts[2]),
          mem: parseFloat(parts[3]),
          vsz: parseInt(parts[4], 10),
          rss: parseInt(parts[5], 10),
          tty: parts[6],
          stat: parts[7],
          start: parts[8],
          time: parts[9],
          command: parts.slice(10).join(" "),
        };
      });

      if (filter) {
        const f = (filter as string).toLowerCase();
        processes = processes.filter((p) => p.command.toLowerCase().includes(f));
      }
      if (user) {
        processes = processes.filter((p) => p.user === user);
      }

      processes = processes.slice(0, limit as number);

      return { processes, count: processes.length };
    },
  },
  {
    name: "which_command",
    description:
      "Find the full path of an executable command. Checks if a command exists and returns its location in PATH. Use to verify command availability, find binary locations, or debug PATH issues. Keywords: which, command path, binary location, executable path, find command, PATH lookup.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to find" },
      },
      required: ["command"],
    },
    handler: async ({ command }) => {
      const result = await runCommand("which", [command as string]);
      return {
        command,
        found: result.code === 0,
        path: result.stdout.trim() || null,
      };
    },
  },
  {
    name: "kill_process",
    description:
      "Terminate a process by PID or name using signals. Send SIGTERM for graceful shutdown or SIGKILL to force stop. Use to stop hung processes, restart services, or clean up runaway programs. Keywords: kill process, stop program, pkill, terminate, SIGTERM, SIGKILL, force quit, end task.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "number", description: "Process ID" },
        name: { type: "string", description: "Process name (uses pkill)" },
        signal: { type: "string", description: "Signal (default: TERM)" },
        force: { type: "boolean", description: "Use SIGKILL" },
      },
    },
    handler: async ({ pid, name, signal, force }) => {
      const sig = force ? "KILL" : (signal || "TERM");

      if (pid) {
        const result = await runCommand("kill", [`-${sig}`, String(pid)]);
        if (result.code !== 0) {
          throw new Error(`kill failed: ${result.stderr}`);
        }
        return { success: true, pid, signal: sig };
      } else if (name) {
        const result = await runCommand("pkill", [`-${sig}`, name as string]);
        return { success: result.code === 0, name, signal: sig };
      } else {
        throw new Error("Either pid or name required");
      }
    },
  },
  {
    name: "lsof",
    description:
      "List open files, network connections, and ports in use. Find which process is using a specific port, file, or show all connections for a PID. Essential for debugging port conflicts, finding file locks, or auditing network activity. Keywords: lsof, open files, port in use, file handles, network connections, who is using port, file locks.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "List processes using this port" },
        path: { type: "string", description: "List processes using this file" },
        pid: { type: "number", description: "List files open by this PID" },
      },
    },
    handler: async ({ port, path, pid }) => {
      const args: string[] = [];
      if (port) args.push("-i", `:${port}`);
      else if (path) args.push(path as string);
      else if (pid) args.push("-p", String(pid));
      else args.push("-i");

      const result = await runCommand("lsof", args);

      const lines = result.stdout.trim().split("\n");
      if (lines.length < 2) return { processes: [] };

      const processes = lines.slice(1).map((line) => {
        const parts = line.split(/\s+/);
        return {
          command: parts[0],
          pid: parseInt(parts[1]),
          user: parts[2],
          fd: parts[3],
          type: parts[4],
          name: parts.slice(8).join(" "),
        };
      });

      return { processes };
    },
  },
  {
    name: "which",
    description:
      "Find the location of a command in PATH. Shows the full path to an executable, optionally listing all matches. Use to check if a tool is installed, find where binaries are located, or resolve command conflicts. Keywords: which command, find binary, command location, executable path, PATH search.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to find" },
        all: { type: "boolean", description: "Show all matches" },
      },
      required: ["command"],
    },
    handler: async ({ command, all }) => {
      const args = all ? ["-a", command as string] : [command as string];
      const result = await runCommand("which", args);

      if (result.code !== 0) {
        return { found: false, command };
      }

      const paths = result.stdout.trim().split("\n").filter((p) => p);
      return {
        found: true,
        command,
        path: paths[0],
        allPaths: all ? paths : undefined,
      };
    },
  },
];
