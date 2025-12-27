/**
 * Git tools - repository management
 *
 * @module lib/std/tools/git
 */

import { type MiniTool, runCommand } from "./common.ts";

export const gitTools: MiniTool[] = [
  {
    name: "git_status",
    description:
      "Get git repository status showing working directory state. Shows current branch, tracked/untracked files, staged changes, and upstream tracking info. Use to check what files are modified, staged for commit, or need attention before committing. Keywords: git status, working tree, staged files, uncommitted changes, modified files.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Repository path" },
        short: { type: "boolean", description: "Short format output" },
      },
    },
    handler: async ({ cwd, short = false }) => {
      const args = ["status"];
      if (short) args.push("-s");
      args.push("--porcelain=v2", "--branch");

      const result = await runCommand("git", args, { cwd: cwd as string });
      if (result.code !== 0) {
        throw new Error(`git status failed: ${result.stderr}`);
      }

      const lines = result.stdout.trim().split("\n");
      const branch = lines.find((l) => l.startsWith("# branch.head"))?.split(" ")[2] || "unknown";
      const upstream = lines.find((l) => l.startsWith("# branch.upstream"))?.split(" ")[2];
      const changes = lines.filter((l) => !l.startsWith("#"));

      return {
        branch,
        upstream,
        clean: changes.length === 0,
        changes: changes.length,
        files: changes.map((line) => {
          const parts = line.split(" ");
          return { status: parts[0], path: parts[parts.length - 1] };
        }),
      };
    },
  },
  {
    name: "git_log",
    description:
      "Get git commit history with author, date, and message details. View recent commits, filter by author or date range, track project evolution. Use to review changes, find specific commits, audit code history, or understand what was changed and when. Keywords: commit history, git log, revision history, changelog, commit messages, author commits.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Repository path" },
        count: { type: "number", description: "Number of commits (default: 10)" },
        oneline: { type: "boolean", description: "One line per commit" },
        author: { type: "string", description: "Filter by author" },
        since: { type: "string", description: "Show commits since date (e.g., '1 week ago')" },
      },
    },
    handler: async ({ cwd, count = 10, oneline = true, author, since }) => {
      const args = ["log", `-${count}`];
      if (oneline) {
        args.push("--format=%H|%an|%ae|%at|%s");
      }
      if (author) args.push(`--author=${author}`);
      if (since) args.push(`--since=${since}`);

      const result = await runCommand("git", args, { cwd: cwd as string });
      if (result.code !== 0) {
        throw new Error(`git log failed: ${result.stderr}`);
      }

      if (oneline) {
        const commits = result.stdout.trim().split("\n").filter(Boolean).map((line) => {
          const [hash, author, email, timestamp, ...messageParts] = line.split("|");
          return {
            hash,
            author,
            email,
            date: new Date(parseInt(timestamp) * 1000).toISOString(),
            message: messageParts.join("|"),
          };
        });
        return { commits, count: commits.length };
      }
      return result.stdout;
    },
  },
  {
    name: "git_diff",
    description:
      "Show git diff between commits, branches, or working directory changes. View line-by-line differences, staged vs unstaged changes, or file-specific diffs. Use to review code changes before committing, compare versions, or understand what was modified. Keywords: git diff, code changes, line differences, compare files, staged changes, patch.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Repository path" },
        staged: { type: "boolean", description: "Show staged changes only" },
        file: { type: "string", description: "Specific file to diff" },
        stat: { type: "boolean", description: "Show diffstat only" },
      },
    },
    handler: async ({ cwd, staged = false, file, stat = false }) => {
      const args = ["diff"];
      if (staged) args.push("--staged");
      if (stat) args.push("--stat");
      if (file) args.push(file as string);

      const result = await runCommand("git", args, { cwd: cwd as string });
      if (result.code !== 0) {
        throw new Error(`git diff failed: ${result.stderr}`);
      }
      return { diff: result.stdout, hasChanges: result.stdout.length > 0 };
    },
  },
  {
    name: "git_branch",
    description:
      "List git branches showing local and remote branches. Shows current branch, upstream tracking, and all available branches. Use to see available branches, check current branch, find feature branches, or verify remote tracking. Keywords: git branch, branch list, current branch, remote branches, feature branches, branch management.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Repository path" },
        all: { type: "boolean", description: "Show all branches including remote" },
        current: { type: "boolean", description: "Show current branch only" },
      },
    },
    handler: async ({ cwd, all = false, current = false }) => {
      if (current) {
        const result = await runCommand("git", ["branch", "--show-current"], {
          cwd: cwd as string,
        });
        return { current: result.stdout.trim() };
      }

      const args = ["branch", "--format=%(refname:short)|%(upstream:short)|%(HEAD)"];
      if (all) args.push("-a");

      const result = await runCommand("git", args, { cwd: cwd as string });
      if (result.code !== 0) {
        throw new Error(`git branch failed: ${result.stderr}`);
      }

      const branches = result.stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [name, upstream, head] = line.split("|");
        return { name, upstream: upstream || null, current: head === "*" };
      });

      return {
        branches,
        current: branches.find((b) => b.current)?.name,
        count: branches.length,
      };
    },
  },
];
