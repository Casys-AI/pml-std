/**
 * Package manager tools - npm, pip, apt, brew
 *
 * @module lib/std/tools/packages
 */

import { type MiniTool, runCommand } from "./common.ts";

export const packagesTools: MiniTool[] = [
  {
    name: "npm_run",
    description:
      "Run npm commands for Node.js package management. Install dependencies, run scripts (test, build, start), check outdated packages, audit security. Essential for JavaScript/TypeScript project management. Keywords: npm install, npm run, package.json, node modules, npm test build, js dependencies.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["install", "run", "test", "build", "list", "outdated", "update", "audit"],
          description: "npm command",
        },
        args: { type: "array", items: { type: "string" }, description: "Additional arguments" },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["command"],
    },
    handler: async ({ command, args = [], cwd }) => {
      const cmdArgs = [command as string, ...(args as string[])];
      const result = await runCommand("npm", cmdArgs, { cwd: cwd as string, timeout: 300000 });
      return {
        command: `npm ${cmdArgs.join(" ")}`,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.code === 0,
      };
    },
  },
  {
    name: "pip_run",
    description:
      "Run pip commands for Python package management. Install, uninstall, list, or freeze Python packages. Check installed versions, upgrade packages, or export requirements. Essential for Python project dependency management. Keywords: pip install, python packages, requirements.txt, pip freeze, python dependencies, pypi.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["install", "uninstall", "list", "freeze", "show", "search", "check"],
          description: "pip command",
        },
        packages: { type: "array", items: { type: "string" }, description: "Package names" },
        upgrade: { type: "boolean", description: "Upgrade packages" },
      },
      required: ["command"],
    },
    handler: async ({ command, packages = [], upgrade = false }) => {
      const args = [command as string];
      if (upgrade && command === "install") args.push("--upgrade");
      args.push(...(packages as string[]));

      const result = await runCommand("pip", args, { timeout: 300000 });
      return {
        command: `pip ${args.join(" ")}`,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.code === 0,
      };
    },
  },
  {
    name: "apt_install",
    description:
      "Install system packages on Debian/Ubuntu using apt package manager. Install software, libraries, development tools. Can optionally update package lists first. Use for system dependencies, build tools, or server software. Keywords: apt install, apt-get, debian packages, ubuntu install, system packages, linux software.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        packages: { type: "array", items: { type: "string" }, description: "Packages to install" },
        update: { type: "boolean", description: "Run apt update first" },
      },
      required: ["packages"],
    },
    handler: async ({ packages, update }) => {
      if (update) {
        await runCommand("apt", ["update"], { timeout: 120000 });
      }

      const result = await runCommand("apt", ["install", "-y", ...(packages as string[])], {
        timeout: 300000,
      });
      if (result.code !== 0) {
        throw new Error(`apt install failed: ${result.stderr}`);
      }
      return { success: true, packages, output: result.stdout };
    },
  },
  {
    name: "apt_search",
    description:
      "Search for available packages in Debian/Ubuntu repositories. Find package names, discover what software is available, check package descriptions. Use before installing to find the right package name. Keywords: apt search, find package, debian search, ubuntu packages, available software, apt cache.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    handler: async ({ query }) => {
      const result = await runCommand("apt", ["search", query as string]);
      return { output: result.stdout };
    },
  },
  {
    name: "brew_install",
    description:
      "Install packages on macOS using Homebrew package manager. Install CLI tools, libraries, or full applications (casks). The standard way to install software on Mac. Keywords: brew install, homebrew, macos packages, mac software, cask install, brew formula.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        packages: { type: "array", items: { type: "string" }, description: "Packages to install" },
        cask: { type: "boolean", description: "Install as cask" },
      },
      required: ["packages"],
    },
    handler: async ({ packages, cask }) => {
      const args = cask ? ["install", "--cask"] : ["install"];
      args.push(...(packages as string[]));

      const result = await runCommand("brew", args, { timeout: 300000 });
      if (result.code !== 0) {
        throw new Error(`brew install failed: ${result.stderr}`);
      }
      return { success: true, packages, output: result.stdout };
    },
  },
];
