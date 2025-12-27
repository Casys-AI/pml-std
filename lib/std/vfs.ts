/**
 * Virtual Filesystem (VFS) tools
 *
 * In-memory file operations for sandboxed environments.
 *
 * @module lib/std/vfs
 */

import type { MiniTool } from "./types.ts";

// In-memory virtual filesystem storage
const vfsStorage = new Map<string, { content: string; createdAt: Date; updatedAt: Date }>();

export const vfsTools: MiniTool[] = [
  {
    name: "vfs_write",
    description:
      "Write content to a virtual file in memory. Create or overwrite files in sandboxed storage with optional append mode. Use for temporary storage, testing, or environments without filesystem access. Keywords: virtual file, in-memory write, sandbox file, temp storage, create file, append file.",
    category: "vfs",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Virtual file path" },
        content: { type: "string", description: "Content to write" },
        append: { type: "boolean", description: "Append instead of overwrite (default: false)" },
      },
      required: ["path", "content"],
    },
    handler: ({ path, content, append = false }) => {
      const p = path as string;
      const c = content as string;
      const now = new Date();

      if (append && vfsStorage.has(p)) {
        const existing = vfsStorage.get(p)!;
        vfsStorage.set(p, {
          content: existing.content + c,
          createdAt: existing.createdAt,
          updatedAt: now,
        });
      } else {
        vfsStorage.set(p, {
          content: c,
          createdAt: vfsStorage.get(p)?.createdAt || now,
          updatedAt: now,
        });
      }
      return { success: true, path: p, size: vfsStorage.get(p)!.content.length };
    },
  },
  {
    name: "vfs_read",
    description:
      "Read content from a virtual file in memory. Retrieve previously stored data from sandboxed storage. Returns content and file size if exists. Use for accessing temp data, reading cached content, or sandbox testing. Keywords: virtual file read, in-memory read, get file, sandbox read, temp file, retrieve content.",
    category: "vfs",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Virtual file path" },
      },
      required: ["path"],
    },
    handler: ({ path }) => {
      const p = path as string;
      const file = vfsStorage.get(p);
      if (!file) {
        return { error: `File not found: ${p}`, exists: false };
      }
      return { content: file.content, exists: true, size: file.content.length };
    },
  },
  {
    name: "vfs_delete",
    description:
      "Delete a virtual file from memory storage. Remove files from sandboxed filesystem permanently. Returns success status indicating if file existed. Use for cleanup, freeing memory, or resetting state. Keywords: virtual file delete, remove file, sandbox delete, clear temp, file cleanup, unlink.",
    category: "vfs",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Virtual file path" },
      },
      required: ["path"],
    },
    handler: ({ path }) => {
      const p = path as string;
      const existed = vfsStorage.delete(p);
      return { success: existed, deleted: p };
    },
  },
  {
    name: "vfs_list",
    description:
      "List virtual files in memory with optional glob pattern filtering. Shows file paths, sizes, and timestamps. Use for directory listing, finding files, or inventory of virtual storage. Keywords: list files, virtual directory, glob pattern, file listing, sandbox ls, enumerate files.",
    category: "vfs",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g., '*.txt', 'dir/*')" },
      },
    },
    handler: ({ pattern }) => {
      const files = Array.from(vfsStorage.entries()).map(([path, meta]) => ({
        path,
        size: meta.content.length,
        createdAt: meta.createdAt.toISOString(),
        updatedAt: meta.updatedAt.toISOString(),
      }));

      if (!pattern) return files;

      // Simple glob matching
      const p = pattern as string;
      const regex = new RegExp(
        "^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      );
      return files.filter((f) => regex.test(f.path));
    },
  },
  {
    name: "vfs_exists",
    description:
      "Check if a virtual file exists in memory storage. Quick existence check without reading content. Use for conditional logic, validation before read, or file guards. Keywords: file exists, check file, virtual exists, sandbox stat, file test, path exists.",
    category: "vfs",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Virtual file path" },
      },
      required: ["path"],
    },
    handler: ({ path }) => ({
      exists: vfsStorage.has(path as string),
      path,
    }),
  },
  {
    name: "vfs_copy",
    description:
      "Copy a virtual file to a new path in memory storage. Duplicate file content to another location without modifying source. Use for backups, file duplication, or creating variations. Keywords: copy file, duplicate, virtual copy, sandbox cp, file clone, replicate.",
    category: "vfs",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path" },
        destination: { type: "string", description: "Destination path" },
      },
      required: ["source", "destination"],
    },
    handler: ({ source, destination }) => {
      const src = source as string;
      const dest = destination as string;
      const file = vfsStorage.get(src);
      if (!file) {
        return { error: `Source not found: ${src}`, success: false };
      }
      const now = new Date();
      vfsStorage.set(dest, {
        content: file.content,
        createdAt: now,
        updatedAt: now,
      });
      return { success: true, source: src, destination: dest };
    },
  },
  {
    name: "vfs_move",
    description:
      "Move or rename a virtual file in memory storage. Relocate file to new path, removing from original location. Use for file reorganization, renaming, or path changes. Keywords: move file, rename file, virtual mv, sandbox move, relocate, file rename.",
    category: "vfs",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path" },
        destination: { type: "string", description: "Destination path" },
      },
      required: ["source", "destination"],
    },
    handler: ({ source, destination }) => {
      const src = source as string;
      const dest = destination as string;
      const file = vfsStorage.get(src);
      if (!file) {
        return { error: `Source not found: ${src}`, success: false };
      }
      vfsStorage.set(dest, file);
      vfsStorage.delete(src);
      return { success: true, source: src, destination: dest };
    },
  },
  {
    name: "vfs_clear",
    description:
      "Clear all virtual files or files matching a pattern from memory. Bulk delete with optional glob filtering. Returns count of cleared files. Use for cleanup, resetting storage, or selective purge. Keywords: clear files, bulk delete, virtual clear, sandbox reset, purge files, wipe storage.",
    category: "vfs",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match (clears all if omitted)" },
      },
    },
    handler: ({ pattern }) => {
      if (!pattern) {
        const count = vfsStorage.size;
        vfsStorage.clear();
        return { cleared: count };
      }
      const p = pattern as string;
      const regex = new RegExp(
        "^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      );
      let count = 0;
      for (const path of vfsStorage.keys()) {
        if (regex.test(path)) {
          vfsStorage.delete(path);
          count++;
        }
      }
      return { cleared: count, pattern: p };
    },
  },
];
