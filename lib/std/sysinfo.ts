/**
 * System info tools - disk, memory, user, hostname
 *
 * @module lib/std/tools/sysinfo
 */

import { type MiniTool, runCommand } from "./common.ts";

export const sysinfoTools: MiniTool[] = [
  {
    name: "env_get",
    description:
      "Get the value of an environment variable. Check PATH, HOME, USER, or any custom env var. Returns whether the variable exists and its value. Use for configuration reading, debugging environment issues, or accessing system settings. Keywords: environment variable, env var, getenv, PATH HOME USER, config value.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Variable name" },
      },
      required: ["name"],
    },
    handler: ({ name }) => {
      const value = Deno.env.get(name as string);
      return { name, value, exists: value !== undefined };
    },
  },
  {
    name: "env_list",
    description:
      "List all environment variables or filter by prefix. View complete environment configuration, debug shell settings, or find specific variables. Use for auditing environment, debugging path issues, or configuration management. Keywords: list env, all environment variables, printenv, show environment, filter env vars.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by name prefix" },
      },
    },
    handler: ({ filter }) => {
      const env = Deno.env.toObject();
      if (filter) {
        const prefix = filter as string;
        const filtered: Record<string, string> = {};
        for (const [k, v] of Object.entries(env)) {
          if (k.startsWith(prefix)) filtered[k] = v;
        }
        return { count: Object.keys(filtered).length, variables: filtered };
      }
      return { count: Object.keys(env).length, variables: env };
    },
  },
  {
    name: "chmod",
    description:
      "Change file or directory permissions using octal modes (755, 644) or symbolic notation (+x, u+rw). Set read, write, execute permissions for user, group, others. Essential for security, making scripts executable, or fixing permission errors. Keywords: chmod, file permissions, make executable, permission mode, rwx, access rights.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path" },
        mode: { type: "string", description: "Permission mode (e.g., 755, +x, u+rw)" },
        recursive: { type: "boolean", description: "Apply recursively" },
      },
      required: ["path", "mode"],
    },
    handler: async ({ path, mode, recursive }) => {
      const args = [];
      if (recursive) args.push("-R");
      args.push(mode as string, path as string);

      const result = await runCommand("chmod", args);
      if (result.code !== 0) {
        throw new Error(`chmod failed: ${result.stderr}`);
      }
      return { success: true, path, mode };
    },
  },
  {
    name: "chown",
    description:
      "Change file or directory ownership to different user and/or group. Transfer file ownership, fix permission issues, or set up correct access for services. Supports recursive operation for directories. Keywords: chown, change owner, file ownership, user group, owner permission, transfer ownership.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path" },
        owner: { type: "string", description: "Owner (user:group or just user)" },
        recursive: { type: "boolean", description: "Apply recursively" },
      },
      required: ["path", "owner"],
    },
    handler: async ({ path, owner, recursive }) => {
      const args = [];
      if (recursive) args.push("-R");
      args.push(owner as string, path as string);

      const result = await runCommand("chown", args);
      if (result.code !== 0) {
        throw new Error(`chown failed: ${result.stderr}`);
      }
      return { success: true, path, owner };
    },
  },
  {
    name: "df",
    description:
      "Show disk space usage for all mounted filesystems. View total size, used space, available space, and usage percentage per mount point. Essential for monitoring disk capacity, finding full disks, or capacity planning. Keywords: df, disk space, disk usage, free space, filesystem size, storage capacity, mount point.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to check (optional)" },
        human: { type: "boolean", description: "Human readable sizes (default: true)" },
      },
    },
    handler: async ({ path, human = true }) => {
      const args = [];
      if (human) args.push("-h");
      args.push("-P");
      if (path) args.push(path as string);

      const result = await runCommand("df", args);
      if (result.code !== 0) {
        throw new Error(`df failed: ${result.stderr}`);
      }

      const lines = result.stdout.trim().split("\n");
      const filesystems = lines.slice(1).map((line) => {
        const parts = line.split(/\s+/);
        return {
          filesystem: parts[0],
          size: parts[1],
          used: parts[2],
          available: parts[3],
          usePercent: parts[4],
          mountPoint: parts[5],
        };
      });

      return { filesystems };
    },
  },
  {
    name: "du",
    description:
      "Calculate disk usage of files and directories. Find what's consuming space, get folder sizes, or audit storage usage. Can show totals, limit depth, or include all subdirectories. Essential for cleaning up disk space. Keywords: du, directory size, folder size, disk usage, space consumed, file size, storage audit.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to check" },
        depth: { type: "number", description: "Max depth to report" },
        human: { type: "boolean", description: "Human readable sizes (default: true)" },
        summarize: { type: "boolean", description: "Show only total" },
      },
      required: ["path"],
    },
    handler: async ({ path, depth, human = true, summarize }) => {
      const args = [];
      if (human) args.push("-h");
      if (summarize) args.push("-s");
      else if (depth !== undefined) args.push("-d", String(depth));
      args.push(path as string);

      const result = await runCommand("du", args);
      if (result.code !== 0) {
        throw new Error(`du failed: ${result.stderr}`);
      }

      const lines = result.stdout.trim().split("\n");
      const items = lines.map((line) => {
        const [size, ...pathParts] = line.split("\t");
        return { size: size.trim(), path: pathParts.join("\t").trim() };
      });

      return { items };
    },
  },
  {
    name: "free",
    description:
      "Display system memory usage including RAM and swap. Shows total, used, free, cached, and available memory. Essential for performance monitoring, detecting memory pressure, or capacity planning. Keywords: free memory, RAM usage, memory available, swap usage, system memory, memory stats, memory monitoring.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        human: { type: "boolean", description: "Human readable sizes (default: true)" },
      },
    },
    handler: async ({ human = true }) => {
      const args = [];
      if (human) args.push("-h");

      const result = await runCommand("free", args);
      if (result.code !== 0) {
        throw new Error(`free failed: ${result.stderr}`);
      }

      const lines = result.stdout.trim().split("\n");
      const memLine = lines.find((l) => l.startsWith("Mem:"));
      const swapLine = lines.find((l) => l.startsWith("Swap:"));

      const parseLine = (line: string | undefined) => {
        if (!line) return null;
        const parts = line.split(/\s+/);
        return {
          total: parts[1],
          used: parts[2],
          free: parts[3],
          shared: parts[4],
          buffCache: parts[5],
          available: parts[6],
        };
      };

      return {
        memory: parseLine(memLine),
        swap: parseLine(swapLine),
      };
    },
  },
  {
    name: "whoami",
    description:
      "Get the current logged-in username. Quick way to identify which user account is running commands. Use for scripts, debugging permission issues, or verifying user context. Keywords: whoami, current user, username, logged in user, user identity.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const result = await runCommand("whoami", []);
      return { username: result.stdout.trim() };
    },
  },
  {
    name: "id",
    description:
      "Get user ID (UID), group ID (GID), and all group memberships for a user. Shows numeric IDs and names. Use for debugging permission issues, checking group membership, or security auditing. Keywords: user id, uid gid, group membership, user groups, user info, id command.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "User to check (default: current)" },
      },
    },
    handler: async ({ user }) => {
      const args = user ? [user as string] : [];
      const result = await runCommand("id", args);
      if (result.code !== 0) {
        throw new Error(`id failed: ${result.stderr}`);
      }

      const output = result.stdout.trim();
      const uidMatch = output.match(/uid=(\d+)\(([^)]+)\)/);
      const gidMatch = output.match(/gid=(\d+)\(([^)]+)\)/);
      const groupsMatch = output.match(/groups=(.+)/);

      return {
        uid: uidMatch ? parseInt(uidMatch[1]) : null,
        user: uidMatch ? uidMatch[2] : null,
        gid: gidMatch ? parseInt(gidMatch[1]) : null,
        group: gidMatch ? gidMatch[2] : null,
        groups: groupsMatch ? groupsMatch[1] : null,
      };
    },
  },
  {
    name: "hostname",
    description:
      "Get the system hostname or fully qualified domain name (FQDN). Identify the machine name in network context. Use for logging, debugging, or multi-server environments. Keywords: hostname, system name, machine name, FQDN, server name, host identity.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        fqdn: { type: "boolean", description: "Get fully qualified domain name" },
      },
    },
    handler: async ({ fqdn }) => {
      const args = fqdn ? ["-f"] : [];
      const result = await runCommand("hostname", args);
      return { hostname: result.stdout.trim() };
    },
  },
  {
    name: "uptime",
    description:
      "Get system uptime and load averages. Shows how long the system has been running and CPU load for 1, 5, and 15 minute intervals. Essential for monitoring server health and identifying overloaded systems. Keywords: uptime, system uptime, load average, how long running, server load, cpu load.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const result = await runCommand("uptime", ["-p"]);
      const uptime = result.stdout.trim();

      const loadResult = await runCommand("uptime", []);
      const loadMatch = loadResult.stdout.match(/load average: ([\d.]+), ([\d.]+), ([\d.]+)/);

      return {
        uptime,
        loadAverage: loadMatch
          ? {
            "1min": parseFloat(loadMatch[1]),
            "5min": parseFloat(loadMatch[2]),
            "15min": parseFloat(loadMatch[3]),
          }
          : null,
      };
    },
  },
  {
    name: "uname",
    description:
      "Get system kernel and OS information. Shows kernel name, hostname, kernel version, machine architecture (x86_64, arm64). Use for system identification, compatibility checks, or debugging. Keywords: uname, kernel version, os info, system architecture, linux version, machine type, platform info.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const result = await runCommand("uname", ["-a"]);
      const parts = result.stdout.trim().split(" ");

      return {
        full: result.stdout.trim(),
        kernel: parts[0],
        hostname: parts[1],
        kernelRelease: parts[2],
        kernelVersion: parts[3],
        machine: parts.find((p) => p.match(/x86_64|arm64|aarch64/)) || parts[parts.length - 1],
      };
    },
  },
];
