/**
 * SSH tools - remote execution and file transfer
 *
 * @module lib/std/tools/ssh
 */

import { type MiniTool, runCommand } from "./common.ts";

export const sshTools: MiniTool[] = [
  {
    name: "ssh_exec",
    description:
      "Execute shell commands on remote servers via SSH. Run any command on remote hosts and capture output. Supports custom ports and identity files. Use for remote server management, automation, deployment scripts, or system administration. Keywords: ssh command, remote execution, run on server, SSH shell, remote shell, execute remotely.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Remote host (user@host)" },
        command: { type: "string", description: "Command to execute" },
        port: { type: "number", description: "SSH port (default: 22)" },
        identity: { type: "string", description: "Identity file path" },
        timeout: { type: "number", description: "Connection timeout in seconds" },
      },
      required: ["host", "command"],
    },
    handler: async ({ host, command, port, identity, timeout = 30 }) => {
      const args = ["-o", "StrictHostKeyChecking=no", "-o", `ConnectTimeout=${timeout}`];
      if (port) args.push("-p", String(port));
      if (identity) args.push("-i", identity as string);
      args.push(host as string, command as string);

      const result = await runCommand("ssh", args, { timeout: (timeout as number) * 1000 + 5000 });
      return {
        host,
        command,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.code === 0,
      };
    },
  },
  {
    name: "scp_copy",
    description:
      "Secure copy files between local and remote hosts over SSH. Transfer files to/from servers with encryption. Supports recursive directory copying and custom SSH ports. Use for deploying files, downloading from servers, or secure file transfers. Keywords: scp, secure copy, remote file transfer, upload to server, download from server, SSH file copy.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path (local or user@host:path)" },
        destination: { type: "string", description: "Destination path" },
        recursive: { type: "boolean", description: "Copy directories recursively" },
        port: { type: "number", description: "SSH port" },
        identity: { type: "string", description: "Identity file path" },
      },
      required: ["source", "destination"],
    },
    handler: async ({ source, destination, recursive = false, port, identity }) => {
      const args = ["-o", "StrictHostKeyChecking=no"];
      if (recursive) args.push("-r");
      if (port) args.push("-P", String(port));
      if (identity) args.push("-i", identity as string);
      args.push(source as string, destination as string);

      const result = await runCommand("scp", args, { timeout: 300000 });
      if (result.code !== 0) {
        throw new Error(`scp failed: ${result.stderr}`);
      }
      return { success: true, source, destination };
    },
  },
  {
    name: "rsync",
    description:
      "Efficiently synchronize files and directories locally or over SSH. Only transfers changed portions of files, ideal for backups and mirroring. Supports dry-run, delete mode, and exclude patterns. Keywords: rsync, file sync, incremental backup, mirror directory, synchronize folders, delta transfer, backup sync.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path" },
        destination: { type: "string", description: "Destination path" },
        delete: { type: "boolean", description: "Delete extraneous files from destination" },
        dryRun: { type: "boolean", description: "Dry run (show what would be done)" },
        exclude: { type: "array", items: { type: "string" }, description: "Patterns to exclude" },
      },
      required: ["source", "destination"],
    },
    handler: async ({ source, destination, delete: del = false, dryRun = false, exclude = [] }) => {
      const args = ["-avz", "--progress"];
      if (del) args.push("--delete");
      if (dryRun) args.push("--dry-run");
      for (const pattern of exclude as string[]) {
        args.push("--exclude", pattern);
      }
      args.push(source as string, destination as string);

      const result = await runCommand("rsync", args, { timeout: 600000 });
      if (result.code !== 0) {
        throw new Error(`rsync failed: ${result.stderr}`);
      }
      return { success: true, output: result.stdout, dryRun };
    },
  },
];
