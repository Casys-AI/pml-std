/**
 * Path manipulation tools
 *
 * Cross-platform path operations without filesystem access.
 *
 * @module lib/std/path
 */

import type { MiniTool } from "./types.ts";
import process from "node:process";

// Platform detection (defaults to posix for most environments)
const isWindows = typeof Deno !== "undefined"
  ? Deno.build.os === "windows"
  : (typeof process !== "undefined" && process.platform === "win32");

const SEP = isWindows ? "\\" : "/";
const SEP_PATTERN = isWindows ? /[\\/]+/ : /\/+/;

export const pathTools: MiniTool[] = [
  {
    name: "path_join",
    description:
      "Join multiple path segments into single normalized path. Combine directory names, filenames, and relative paths safely. Handles leading/trailing slashes, empty segments. Use for building file paths, URL paths, or directory structures. Keywords: join path, combine path, path concat, merge paths, build path, path segments.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        segments: {
          type: "array",
          items: { type: "string" },
          description: "Path segments to join",
        },
        separator: { type: "string", description: "Path separator (default: auto-detect OS)" },
      },
      required: ["segments"],
    },
    handler: ({ segments, separator }) => {
      const sep = (separator as string) || SEP;
      const parts = (segments as string[])
        .filter((s) => s.length > 0)
        .flatMap((s) => s.split(SEP_PATTERN))
        .filter((s) => s.length > 0);

      // Preserve leading slash for absolute paths
      const leadingSlash = (segments as string[])[0]?.startsWith("/") ||
        (segments as string[])[0]?.startsWith("\\");

      let result = parts.join(sep);
      if (leadingSlash && !result.startsWith(sep)) {
        result = sep + result;
      }

      return result;
    },
  },
  {
    name: "path_normalize",
    description:
      "Normalize path by resolving . and .. segments and removing redundant separators. Clean up messy paths from user input or concatenation. Use for path sanitization, comparison, or display. Keywords: normalize path, clean path, resolve dots, canonicalize, path cleanup, simplify path.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to normalize" },
        separator: { type: "string", description: "Path separator (default: auto-detect OS)" },
      },
      required: ["path"],
    },
    handler: ({ path, separator }) => {
      const sep = (separator as string) || SEP;
      const p = path as string;

      // Handle empty path
      if (!p) return ".";

      // Check for absolute path
      const isAbsolute = p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p);

      // Split and filter
      const parts = p.split(SEP_PATTERN).filter((s) => s.length > 0 && s !== ".");

      // Resolve .. segments
      const stack: string[] = [];
      for (const part of parts) {
        if (part === "..") {
          if (stack.length > 0 && stack[stack.length - 1] !== "..") {
            stack.pop();
          } else if (!isAbsolute) {
            stack.push(part);
          }
        } else {
          stack.push(part);
        }
      }

      let result = stack.join(sep);

      // Handle Windows drive letters
      if (/^[a-zA-Z]:/.test(p)) {
        const drive = p.slice(0, 2);
        if (!result.startsWith(drive)) {
          result = drive + sep + result;
        }
      } else if (isAbsolute && !result.startsWith(sep)) {
        result = sep + result;
      }

      return result || ".";
    },
  },
  {
    name: "path_basename",
    description:
      "Extract filename from path, optionally removing extension. Get the last segment of a path for display or processing. Use for extracting filenames, getting file names without extension, or path parsing. Keywords: basename, filename, file name, extract name, path end, strip directory.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        ext: { type: "string", description: "Extension to remove (e.g., '.txt')" },
      },
      required: ["path"],
    },
    handler: ({ path, ext }) => {
      const p = path as string;
      const parts = p.split(SEP_PATTERN).filter((s) => s.length > 0);
      let name = parts[parts.length - 1] || "";

      if (ext && name.endsWith(ext as string)) {
        name = name.slice(0, -((ext as string).length));
      }

      return name;
    },
  },
  {
    name: "path_dirname",
    description:
      "Extract directory path from file path. Get parent directory by removing the last path segment. Use for navigating up directories, getting containing folder, or path manipulation. Keywords: dirname, directory name, parent path, folder path, strip filename, path parent.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
    handler: ({ path }) => {
      const p = path as string;
      const parts = p.split(SEP_PATTERN).filter((s) => s.length > 0);

      if (parts.length <= 1) {
        // Return root or current dir
        if (p.startsWith("/") || p.startsWith("\\")) return SEP;
        if (/^[a-zA-Z]:/.test(p)) return p.slice(0, 2) + SEP;
        return ".";
      }

      parts.pop();
      let result = parts.join(SEP);

      // Preserve leading slash for absolute paths
      if ((p.startsWith("/") || p.startsWith("\\")) && !result.startsWith(SEP)) {
        result = SEP + result;
      }

      // Preserve Windows drive letter
      if (/^[a-zA-Z]:/.test(p) && !result.match(/^[a-zA-Z]:/)) {
        result = p.slice(0, 2) + SEP + result;
      }

      return result;
    },
  },
  {
    name: "path_extname",
    description:
      "Extract file extension from path including the dot. Get .txt, .js, .tar.gz etc. from filename. Use for file type detection, filtering by extension, or format handling. Keywords: extname, file extension, extension, file type, suffix, get extension.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        full: {
          type: "boolean",
          description: "Return full extension like .tar.gz (default: false)",
        },
      },
      required: ["path"],
    },
    handler: ({ path, full = false }) => {
      const p = path as string;
      const parts = p.split(SEP_PATTERN);
      const filename = parts[parts.length - 1] || "";

      // Handle dotfiles
      if (filename.startsWith(".") && filename.indexOf(".", 1) === -1) {
        return "";
      }

      if (full) {
        // Return everything after first dot (for .tar.gz etc)
        const firstDot = filename.indexOf(".");
        if (firstDot > 0) {
          return filename.slice(firstDot);
        }
        return "";
      }

      // Return only last extension
      const lastDot = filename.lastIndexOf(".");
      if (lastDot > 0) {
        return filename.slice(lastDot);
      }
      return "";
    },
  },
  {
    name: "path_parse",
    description:
      "Parse path into components: root, dir, base, name, ext. Decompose any path into its constituent parts for analysis or manipulation. Use for path analysis, file info extraction, or path transformation. Keywords: parse path, path components, decompose path, path parts, split path, path info.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to parse" },
      },
      required: ["path"],
    },
    handler: ({ path }) => {
      const p = path as string;
      const parts = p.split(SEP_PATTERN).filter((s) => s.length > 0);
      const base = parts[parts.length - 1] || "";

      // Extract extension
      const lastDot = base.lastIndexOf(".");
      const ext = lastDot > 0 ? base.slice(lastDot) : "";
      const name = lastDot > 0 ? base.slice(0, lastDot) : base;

      // Determine root
      let root = "";
      if (p.startsWith("/") || p.startsWith("\\")) {
        root = SEP;
      } else if (/^[a-zA-Z]:/.test(p)) {
        root = p.slice(0, 3); // C:\
      }

      // Get dir
      let dir = "";
      if (parts.length > 1) {
        const dirParts = parts.slice(0, -1);
        dir = root + dirParts.join(SEP);
      } else if (root) {
        dir = root;
      }

      return { root, dir, base, name, ext };
    },
  },
  {
    name: "path_format",
    description:
      "Build path from components object (root, dir, base, name, ext). Reconstruct path from parsed components or create new paths programmatically. Use for path construction, modification, or rebuilding parsed paths. Keywords: format path, build path, construct path, assemble path, path from parts.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        pathObject: {
          type: "object",
          properties: {
            root: { type: "string" },
            dir: { type: "string" },
            base: { type: "string" },
            name: { type: "string" },
            ext: { type: "string" },
          },
          description: "Path components",
        },
      },
      required: ["pathObject"],
    },
    handler: ({ pathObject }) => {
      const obj = pathObject as {
        root?: string;
        dir?: string;
        base?: string;
        name?: string;
        ext?: string;
      };

      // base takes precedence over name + ext
      const base = obj.base || ((obj.name || "") + (obj.ext || ""));

      if (obj.dir) {
        return obj.dir + SEP + base;
      }

      return (obj.root || "") + base;
    },
  },
  {
    name: "path_relative",
    description:
      "Calculate relative path from one location to another. Determine how to navigate from source to target using .. and subdirectories. Use for creating relative links, path comparison, or navigation. Keywords: relative path, path from to, path difference, navigate path, .. path, relative link.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source path" },
        to: { type: "string", description: "Target path" },
      },
      required: ["from", "to"],
    },
    handler: ({ from, to }) => {
      const fromParts = (from as string).split(SEP_PATTERN).filter((s) => s.length > 0);
      const toParts = (to as string).split(SEP_PATTERN).filter((s) => s.length > 0);

      // Find common prefix
      let commonLength = 0;
      const minLength = Math.min(fromParts.length, toParts.length);
      for (let i = 0; i < minLength; i++) {
        if (fromParts[i] === toParts[i]) {
          commonLength++;
        } else {
          break;
        }
      }

      // Build relative path
      const upCount = fromParts.length - commonLength;
      const upParts = Array(upCount).fill("..");
      const downParts = toParts.slice(commonLength);

      const result = [...upParts, ...downParts].join(SEP);
      return result || ".";
    },
  },
  {
    name: "path_is_absolute",
    description:
      "Check if path is absolute (starts from root). Determine if path is absolute or relative for path resolution or validation. Use for path validation, security checks, or conditional processing. Keywords: is absolute, absolute path, root path, path type, check absolute, validate path.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to check" },
      },
      required: ["path"],
    },
    handler: ({ path }) => {
      const p = path as string;
      return {
        isAbsolute: p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(p),
        path: p,
      };
    },
  },
  {
    name: "path_resolve",
    description:
      "Resolve sequence of paths to absolute path. Process paths from right to left until absolute path is formed, similar to cd operations. Use for resolving relative paths, building absolute paths, or path normalization. Keywords: resolve path, absolute path, path resolution, full path, complete path, cwd resolve.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        segments: {
          type: "array",
          items: { type: "string" },
          description: "Path segments to resolve",
        },
        base: { type: "string", description: "Base directory (default: '/')" },
      },
      required: ["segments"],
    },
    handler: ({ segments, base = "/" }) => {
      let resolved = base as string;

      for (const segment of (segments as string[]).reverse()) {
        if (!segment) continue;

        // If absolute, use it as the new base
        if (segment.startsWith("/") || segment.startsWith("\\") || /^[a-zA-Z]:/.test(segment)) {
          resolved = segment;
        } else {
          // Relative - prepend to current resolved
          resolved = segment + SEP + resolved;
        }
      }

      // Normalize the result
      const parts = resolved.split(SEP_PATTERN).filter((s) => s.length > 0 && s !== ".");
      const stack: string[] = [];

      for (const part of parts) {
        if (part === "..") {
          stack.pop();
        } else {
          stack.push(part);
        }
      }

      let result = stack.join(SEP);
      if (resolved.startsWith("/") || resolved.startsWith("\\")) {
        result = SEP + result;
      }

      return result || SEP;
    },
  },
  {
    name: "path_split",
    description:
      "Split path into array of individual segments. Break path into directory and file components for iteration or analysis. Use for path traversal, breadcrumb generation, or segment processing. Keywords: split path, path segments, path parts, tokenize path, break path, path array.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to split" },
      },
      required: ["path"],
    },
    handler: ({ path }) => {
      const p = path as string;
      const segments = p.split(SEP_PATTERN).filter((s) => s.length > 0);

      return {
        segments,
        isAbsolute: p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p),
        count: segments.length,
      };
    },
  },
  {
    name: "path_common",
    description:
      "Find longest common path prefix among multiple paths. Determine shared directory ancestry for a set of paths. Use for finding common root, path grouping, or workspace detection. Keywords: common path, shared prefix, common ancestor, path intersection, common root, shared directory.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Paths to compare" },
      },
      required: ["paths"],
    },
    handler: ({ paths }) => {
      const pathList = paths as string[];
      if (pathList.length === 0) return "";
      if (pathList.length === 1) return pathList[0];

      // Split all paths
      const splitPaths = pathList.map((p) => p.split(SEP_PATTERN).filter((s) => s.length > 0));

      // Find minimum length
      const minLen = Math.min(...splitPaths.map((p) => p.length));

      // Find common prefix
      const common: string[] = [];
      for (let i = 0; i < minLen; i++) {
        const segment = splitPaths[0][i];
        if (splitPaths.every((p) => p[i] === segment)) {
          common.push(segment);
        } else {
          break;
        }
      }

      // Reconstruct path
      let result = common.join(SEP);
      const allAbsolute = pathList.every((p) => p.startsWith("/") || p.startsWith("\\"));
      if (allAbsolute && !result.startsWith(SEP)) {
        result = SEP + result;
      }

      return result;
    },
  },
  {
    name: "path_change_ext",
    description:
      "Change or add file extension to path. Replace existing extension or append new one to filename. Use for format conversion paths, output file naming, or extension manipulation. Keywords: change extension, replace ext, new extension, swap extension, modify extension, file extension.",
    category: "path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        newExt: { type: "string", description: "New extension (with or without dot)" },
      },
      required: ["path", "newExt"],
    },
    handler: ({ path, newExt }) => {
      const p = path as string;
      let ext = newExt as string;

      // Ensure extension starts with dot
      if (ext && !ext.startsWith(".")) {
        ext = "." + ext;
      }

      // Find and replace extension
      const parts = p.split(SEP_PATTERN);
      const filename = parts.pop() || "";

      const lastDot = filename.lastIndexOf(".");
      const baseName = lastDot > 0 ? filename.slice(0, lastDot) : filename;

      parts.push(baseName + ext);

      // Preserve path structure
      let result = parts.join(SEP);
      if (p.startsWith("/") || p.startsWith("\\")) {
        result = SEP + result;
      }

      return result;
    },
  },
];
