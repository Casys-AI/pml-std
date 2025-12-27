/**
 * Text diff and comparison tools
 *
 * Compare text, generate diffs, and apply patches.
 *
 * @module lib/std/diff
 */

import type { MiniTool } from "./types.ts";

// Change types
type ChangeType = "equal" | "insert" | "delete" | "replace";

interface Change {
  type: ChangeType;
  value: string;
  oldValue?: string;
  lineNumber?: number;
  oldLineNumber?: number;
}

// Longest Common Subsequence for diff
const lcs = <T>(a: T[], b: T[]): T[] => {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const result: T[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
};

export const diffTools: MiniTool[] = [
  {
    name: "diff_lines",
    description:
      "Compare two texts line by line and generate diff. Show added, removed, and unchanged lines with line numbers. Use for code review, version comparison, or change tracking. Keywords: line diff, text compare, code diff, version diff, compare lines, git diff.",
    category: "diff",
    inputSchema: {
      type: "object",
      properties: {
        oldText: { type: "string", description: "Original text" },
        newText: { type: "string", description: "Modified text" },
        contextLines: { type: "number", description: "Context lines around changes (default: 3)" },
      },
      required: ["oldText", "newText"],
    },
    handler: ({ oldText, newText, contextLines = 3 }) => {
      const oldLines = (oldText as string).split("\n");
      const newLines = (newText as string).split("\n");
      const context = contextLines as number;

      // Find LCS of lines
      const common = lcs(oldLines, newLines);

      // Build diff
      const changes: Change[] = [];
      let oi = 0, ni = 0, ci = 0;

      while (oi < oldLines.length || ni < newLines.length) {
        if (
          ci < common.length && oi < oldLines.length && oldLines[oi] === common[ci] &&
          ni < newLines.length && newLines[ni] === common[ci]
        ) {
          changes.push({
            type: "equal",
            value: common[ci],
            lineNumber: ni + 1,
            oldLineNumber: oi + 1,
          });
          oi++;
          ni++;
          ci++;
        } else if (ci < common.length && ni < newLines.length && newLines[ni] === common[ci]) {
          changes.push({
            type: "delete",
            value: oldLines[oi],
            oldLineNumber: oi + 1,
          });
          oi++;
        } else if (ci < common.length && oi < oldLines.length && oldLines[oi] === common[ci]) {
          changes.push({
            type: "insert",
            value: newLines[ni],
            lineNumber: ni + 1,
          });
          ni++;
        } else if (oi < oldLines.length && ni < newLines.length) {
          changes.push({
            type: "delete",
            value: oldLines[oi],
            oldLineNumber: oi + 1,
          });
          changes.push({
            type: "insert",
            value: newLines[ni],
            lineNumber: ni + 1,
          });
          oi++;
          ni++;
        } else if (oi < oldLines.length) {
          changes.push({
            type: "delete",
            value: oldLines[oi],
            oldLineNumber: oi + 1,
          });
          oi++;
        } else if (ni < newLines.length) {
          changes.push({
            type: "insert",
            value: newLines[ni],
            lineNumber: ni + 1,
          });
          ni++;
        }
      }

      // Generate unified diff format
      const unifiedLines: string[] = [];
      let hasChanges = false;

      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        const isChange = change.type !== "equal";

        if (isChange) {
          hasChanges = true;

          // Add context before
          for (let c = Math.max(0, i - context); c < i; c++) {
            if (changes[c].type === "equal") {
              unifiedLines.push(` ${changes[c].value}`);
            }
          }

          // Add the change
          if (change.type === "delete") {
            unifiedLines.push(`-${change.value}`);
          } else if (change.type === "insert") {
            unifiedLines.push(`+${change.value}`);
          }

          // Look ahead for context after
          let contextAfter = 0;
          for (let c = i + 1; c < changes.length && contextAfter < context; c++) {
            if (changes[c].type === "equal") {
              contextAfter++;
            } else {
              break;
            }
          }
        }
      }

      // Statistics
      const stats = {
        totalLines: Math.max(oldLines.length, newLines.length),
        additions: changes.filter((c) => c.type === "insert").length,
        deletions: changes.filter((c) => c.type === "delete").length,
        unchanged: changes.filter((c) => c.type === "equal").length,
      };

      return {
        changes: changes.filter((c) => c.type !== "equal" || context > 0),
        unified: hasChanges ? unifiedLines.join("\n") : "(no changes)",
        stats,
        identical: !hasChanges,
      };
    },
  },
  {
    name: "diff_words",
    description:
      "Compare two texts word by word. Show added and removed words inline for fine-grained comparison. Use for document editing, proofreading, or detailed change review. Keywords: word diff, inline diff, word compare, fine diff, text changes, edit distance.",
    category: "diff",
    inputSchema: {
      type: "object",
      properties: {
        oldText: { type: "string", description: "Original text" },
        newText: { type: "string", description: "Modified text" },
      },
      required: ["oldText", "newText"],
    },
    handler: ({ oldText, newText }) => {
      // Tokenize by words while preserving whitespace
      const tokenize = (text: string): string[] => {
        const tokens: string[] = [];
        let current = "";
        let inWord = false;

        for (const char of text) {
          const isWordChar = /\w/.test(char);
          if (isWordChar !== inWord) {
            if (current) tokens.push(current);
            current = char;
            inWord = isWordChar;
          } else {
            current += char;
          }
        }
        if (current) tokens.push(current);

        return tokens;
      };

      const oldTokens = tokenize(oldText as string);
      const newTokens = tokenize(newText as string);

      // Find LCS
      const common = lcs(oldTokens, newTokens);

      // Build word diff
      const changes: Change[] = [];
      let oi = 0, ni = 0, ci = 0;

      while (oi < oldTokens.length || ni < newTokens.length) {
        if (
          ci < common.length &&
          oi < oldTokens.length && oldTokens[oi] === common[ci] &&
          ni < newTokens.length && newTokens[ni] === common[ci]
        ) {
          changes.push({ type: "equal", value: common[ci] });
          oi++;
          ni++;
          ci++;
        } else if (ci < common.length && ni < newTokens.length && newTokens[ni] === common[ci]) {
          changes.push({ type: "delete", value: oldTokens[oi] });
          oi++;
        } else if (ci < common.length && oi < oldTokens.length && oldTokens[oi] === common[ci]) {
          changes.push({ type: "insert", value: newTokens[ni] });
          ni++;
        } else {
          if (oi < oldTokens.length) {
            changes.push({ type: "delete", value: oldTokens[oi] });
            oi++;
          }
          if (ni < newTokens.length) {
            changes.push({ type: "insert", value: newTokens[ni] });
            ni++;
          }
        }
      }

      // Generate marked output
      let marked = "";
      for (const change of changes) {
        if (change.type === "equal") {
          marked += change.value;
        } else if (change.type === "delete") {
          marked += `[-${change.value}-]`;
        } else if (change.type === "insert") {
          marked += `[+${change.value}+]`;
        }
      }

      return {
        changes: changes.filter((c) => c.type !== "equal"),
        marked,
        stats: {
          wordsAdded: changes.filter((c) => c.type === "insert" && /\w/.test(c.value)).length,
          wordsRemoved: changes.filter((c) => c.type === "delete" && /\w/.test(c.value)).length,
          wordsUnchanged: changes.filter((c) => c.type === "equal" && /\w/.test(c.value)).length,
        },
        identical: changes.every((c) => c.type === "equal"),
      };
    },
  },
  {
    name: "diff_chars",
    description:
      "Compare two texts character by character. Show exact character-level differences for precise comparison. Use for debugging, password comparison hints, or precise editing. Keywords: char diff, character compare, exact diff, byte compare, precise diff.",
    category: "diff",
    inputSchema: {
      type: "object",
      properties: {
        oldText: { type: "string", description: "Original text" },
        newText: { type: "string", description: "Modified text" },
        maxLength: { type: "number", description: "Max length to compare (default: 1000)" },
      },
      required: ["oldText", "newText"],
    },
    handler: ({ oldText, newText, maxLength = 1000 }) => {
      const old = (oldText as string).slice(0, maxLength as number);
      const new_ = (newText as string).slice(0, maxLength as number);

      const oldChars = [...old];
      const newChars = [...new_];

      // Find LCS
      const common = lcs(oldChars, newChars);

      // Build diff
      const changes: Change[] = [];
      let oi = 0, ni = 0, ci = 0;

      while (oi < oldChars.length || ni < newChars.length) {
        if (
          ci < common.length &&
          oi < oldChars.length && oldChars[oi] === common[ci] &&
          ni < newChars.length && newChars[ni] === common[ci]
        ) {
          changes.push({ type: "equal", value: common[ci] });
          oi++;
          ni++;
          ci++;
        } else if (ci < common.length && ni < newChars.length && newChars[ni] === common[ci]) {
          changes.push({ type: "delete", value: oldChars[oi] });
          oi++;
        } else if (ci < common.length && oi < oldChars.length && oldChars[oi] === common[ci]) {
          changes.push({ type: "insert", value: newChars[ni] });
          ni++;
        } else {
          if (oi < oldChars.length) {
            changes.push({ type: "delete", value: oldChars[oi] });
            oi++;
          }
          if (ni < newChars.length) {
            changes.push({ type: "insert", value: newChars[ni] });
            ni++;
          }
        }
      }

      // Compact consecutive same-type changes
      const compacted: Change[] = [];
      for (const change of changes) {
        const last = compacted[compacted.length - 1];
        if (last && last.type === change.type) {
          last.value += change.value;
        } else {
          compacted.push({ ...change });
        }
      }

      return {
        changes: compacted,
        stats: {
          charsAdded: changes.filter((c) => c.type === "insert").length,
          charsRemoved: changes.filter((c) => c.type === "delete").length,
          charsUnchanged: changes.filter((c) => c.type === "equal").length,
        },
        identical: changes.every((c) => c.type === "equal"),
        truncated: (oldText as string).length > (maxLength as number) ||
          (newText as string).length > (maxLength as number),
      };
    },
  },
  {
    name: "diff_unified",
    description:
      "Generate unified diff format output. Create standard diff format compatible with patch command. Use for generating patches, version control, or standard diff output. Keywords: unified diff, patch format, git diff format, standard diff, diff output, create patch.",
    category: "diff",
    inputSchema: {
      type: "object",
      properties: {
        oldText: { type: "string", description: "Original text" },
        newText: { type: "string", description: "Modified text" },
        oldFile: { type: "string", description: "Old file name (default: 'a')" },
        newFile: { type: "string", description: "New file name (default: 'b')" },
        contextLines: { type: "number", description: "Context lines (default: 3)" },
      },
      required: ["oldText", "newText"],
    },
    handler: ({ oldText, newText, oldFile = "a", newFile = "b", contextLines = 3 }) => {
      const oldLines = (oldText as string).split("\n");
      const newLines = (newText as string).split("\n");
      const context = contextLines as number;

      // Find LCS
      const common = lcs(oldLines, newLines);

      // Build changes
      type LineDiff = {
        type: "equal" | "delete" | "insert";
        line: string;
        oldNum?: number;
        newNum?: number;
      };
      const diffs: LineDiff[] = [];
      let oi = 0, ni = 0, ci = 0;

      while (oi < oldLines.length || ni < newLines.length) {
        if (
          ci < common.length &&
          oi < oldLines.length && oldLines[oi] === common[ci] &&
          ni < newLines.length && newLines[ni] === common[ci]
        ) {
          diffs.push({ type: "equal", line: oldLines[oi], oldNum: oi + 1, newNum: ni + 1 });
          oi++;
          ni++;
          ci++;
        } else if (ci < common.length && ni < newLines.length && newLines[ni] === common[ci]) {
          diffs.push({ type: "delete", line: oldLines[oi], oldNum: oi + 1 });
          oi++;
        } else if (ci < common.length && oi < oldLines.length && oldLines[oi] === common[ci]) {
          diffs.push({ type: "insert", line: newLines[ni], newNum: ni + 1 });
          ni++;
        } else {
          if (oi < oldLines.length) {
            diffs.push({ type: "delete", line: oldLines[oi], oldNum: oi + 1 });
            oi++;
          }
          if (ni < newLines.length) {
            diffs.push({ type: "insert", line: newLines[ni], newNum: ni + 1 });
            ni++;
          }
        }
      }

      // Generate unified format
      const output: string[] = [
        `--- ${oldFile}`,
        `+++ ${newFile}`,
      ];

      // Find hunks
      let hunkStart = -1;
      for (let i = 0; i < diffs.length; i++) {
        if (diffs[i].type !== "equal") {
          if (hunkStart === -1) {
            hunkStart = Math.max(0, i - context);
          }
        } else if (hunkStart !== -1) {
          // Check if we should end the hunk
          let moreChanges = false;
          for (let j = i + 1; j < Math.min(i + 1 + context * 2, diffs.length); j++) {
            if (diffs[j].type !== "equal") {
              moreChanges = true;
              break;
            }
          }

          if (!moreChanges && i - hunkStart > context) {
            // Output hunk
            const hunkEnd = Math.min(i + context, diffs.length);
            const hunk = diffs.slice(hunkStart, hunkEnd);

            const oldStart = hunk.find((d) => d.oldNum)?.oldNum || 1;
            const newStart = hunk.find((d) => d.newNum)?.newNum || 1;
            const oldCount = hunk.filter((d) => d.type !== "insert").length;
            const newCount = hunk.filter((d) => d.type !== "delete").length;

            output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

            for (const diff of hunk) {
              const prefix = diff.type === "delete" ? "-" : diff.type === "insert" ? "+" : " ";
              output.push(prefix + diff.line);
            }

            hunkStart = -1;
          }
        }
      }

      // Handle remaining hunk
      if (hunkStart !== -1) {
        const hunk = diffs.slice(hunkStart);
        const oldStart = hunk.find((d) => d.oldNum)?.oldNum || 1;
        const newStart = hunk.find((d) => d.newNum)?.newNum || 1;
        const oldCount = hunk.filter((d) => d.type !== "insert").length;
        const newCount = hunk.filter((d) => d.type !== "delete").length;

        output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

        for (const diff of hunk) {
          const prefix = diff.type === "delete" ? "-" : diff.type === "insert" ? "+" : " ";
          output.push(prefix + diff.line);
        }
      }

      const hasChanges = diffs.some((d) => d.type !== "equal");

      return {
        unified: hasChanges ? output.join("\n") : "",
        hasChanges,
        stats: {
          additions: diffs.filter((d) => d.type === "insert").length,
          deletions: diffs.filter((d) => d.type === "delete").length,
        },
      };
    },
  },
  {
    name: "diff_apply_patch",
    description:
      "Apply a unified diff patch to text. Transform original text using patch additions and deletions. Use for applying patches, version merging, or automated updates. Keywords: apply patch, patch text, merge diff, apply changes, unified patch, diff apply.",
    category: "diff",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Original text to patch" },
        patch: { type: "string", description: "Unified diff patch" },
      },
      required: ["text", "patch"],
    },
    handler: ({ text, patch }) => {
      const lines = (text as string).split("\n");
      const patchLines = (patch as string).split("\n");

      // Parse patch
      const hunks: Array<{
        oldStart: number;
        oldCount: number;
        newStart: number;
        newCount: number;
        changes: Array<{ type: string; line: string }>;
      }> = [];

      let currentHunk: typeof hunks[0] | null = null;

      for (const line of patchLines) {
        if (line.startsWith("@@")) {
          // Parse hunk header
          const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
          if (match) {
            currentHunk = {
              oldStart: parseInt(match[1], 10),
              oldCount: parseInt(match[2] || "1", 10),
              newStart: parseInt(match[3], 10),
              newCount: parseInt(match[4] || "1", 10),
              changes: [],
            };
            hunks.push(currentHunk);
          }
        } else if (
          currentHunk && (line.startsWith("-") || line.startsWith("+") || line.startsWith(" "))
        ) {
          currentHunk.changes.push({
            type: line[0] === "-" ? "delete" : line[0] === "+" ? "insert" : "context",
            line: line.slice(1),
          });
        }
      }

      // Apply hunks in reverse order to preserve line numbers
      const result = [...lines];
      let offset = 0;

      for (const hunk of hunks) {
        const startLine = hunk.oldStart - 1 + offset;
        let deleteCount = 0;
        const insertLines: string[] = [];

        for (const change of hunk.changes) {
          if (change.type === "delete") {
            deleteCount++;
          } else if (change.type === "insert") {
            insertLines.push(change.line);
          }
        }

        result.splice(startLine, deleteCount, ...insertLines);
        offset += insertLines.length - deleteCount;
      }

      return {
        result: result.join("\n"),
        hunksApplied: hunks.length,
        linesAdded: hunks.reduce(
          (sum, h) => sum + h.changes.filter((c) => c.type === "insert").length,
          0,
        ),
        linesRemoved: hunks.reduce(
          (sum, h) => sum + h.changes.filter((c) => c.type === "delete").length,
          0,
        ),
      };
    },
  },
  {
    name: "diff_similarity",
    description:
      "Calculate text similarity score between two strings. Get percentage similarity using various algorithms. Use for duplicate detection, fuzzy matching, or content comparison. Keywords: text similarity, similarity score, compare percentage, fuzzy compare, content similarity, match score.",
    category: "diff",
    inputSchema: {
      type: "object",
      properties: {
        text1: { type: "string", description: "First text" },
        text2: { type: "string", description: "Second text" },
        method: {
          type: "string",
          enum: ["lcs", "jaccard", "cosine"],
          description: "Similarity method (default: lcs)",
        },
      },
      required: ["text1", "text2"],
    },
    handler: ({ text1, text2, method = "lcs" }) => {
      const t1 = text1 as string;
      const t2 = text2 as string;

      if (t1 === t2) return { similarity: 100, method, identical: true };
      if (!t1 || !t2) return { similarity: 0, method, identical: false };

      let similarity: number;

      switch (method) {
        case "jaccard": {
          // Word-based Jaccard similarity
          const words1 = new Set(t1.toLowerCase().split(/\s+/));
          const words2 = new Set(t2.toLowerCase().split(/\s+/));
          const intersection = new Set([...words1].filter((w) => words2.has(w)));
          const union = new Set([...words1, ...words2]);
          similarity = (intersection.size / union.size) * 100;
          break;
        }

        case "cosine": {
          // Word frequency cosine similarity
          const words1 = t1.toLowerCase().split(/\s+/);
          const words2 = t2.toLowerCase().split(/\s+/);

          const freq1: Record<string, number> = {};
          const freq2: Record<string, number> = {};

          words1.forEach((w) => freq1[w] = (freq1[w] || 0) + 1);
          words2.forEach((w) => freq2[w] = (freq2[w] || 0) + 1);

          const allWords = new Set([...Object.keys(freq1), ...Object.keys(freq2)]);

          let dotProduct = 0;
          let norm1 = 0;
          let norm2 = 0;

          for (const word of allWords) {
            const f1 = freq1[word] || 0;
            const f2 = freq2[word] || 0;
            dotProduct += f1 * f2;
            norm1 += f1 * f1;
            norm2 += f2 * f2;
          }

          similarity = (dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2))) * 100;
          break;
        }

        default: {
          // LCS-based similarity
          const chars1 = [...t1];
          const chars2 = [...t2];
          const common = lcs(chars1, chars2);
          similarity = (common.length * 2 / (chars1.length + chars2.length)) * 100;
        }
      }

      return {
        similarity: Math.round(similarity * 100) / 100,
        method,
        identical: false,
        lengths: {
          text1: t1.length,
          text2: t2.length,
          difference: Math.abs(t1.length - t2.length),
        },
      };
    },
  },
  {
    name: "diff_highlight",
    description:
      "Generate HTML-highlighted diff output. Create visual diff with colored additions/deletions for web display. Use for code review UIs, document comparison, or change visualization. Keywords: HTML diff, visual diff, highlight changes, colored diff, web diff, diff display.",
    category: "diff",
    inputSchema: {
      type: "object",
      properties: {
        oldText: { type: "string", description: "Original text" },
        newText: { type: "string", description: "Modified text" },
        mode: {
          type: "string",
          enum: ["inline", "sideBySide"],
          description: "Display mode (default: inline)",
        },
      },
      required: ["oldText", "newText"],
    },
    handler: ({ oldText, newText, mode = "inline" }) => {
      const oldLines = (oldText as string).split("\n");
      const newLines = (newText as string).split("\n");

      const common = lcs(oldLines, newLines);

      type LineDiff = { type: "equal" | "delete" | "insert"; oldLine?: string; newLine?: string };
      const diffs: LineDiff[] = [];
      let oi = 0, ni = 0, ci = 0;

      while (oi < oldLines.length || ni < newLines.length) {
        if (
          ci < common.length &&
          oi < oldLines.length && oldLines[oi] === common[ci] &&
          ni < newLines.length && newLines[ni] === common[ci]
        ) {
          diffs.push({ type: "equal", oldLine: oldLines[oi], newLine: newLines[ni] });
          oi++;
          ni++;
          ci++;
        } else if (ci < common.length && ni < newLines.length && newLines[ni] === common[ci]) {
          diffs.push({ type: "delete", oldLine: oldLines[oi] });
          oi++;
        } else if (ci < common.length && oi < oldLines.length && oldLines[oi] === common[ci]) {
          diffs.push({ type: "insert", newLine: newLines[ni] });
          ni++;
        } else {
          if (oi < oldLines.length) {
            diffs.push({ type: "delete", oldLine: oldLines[oi] });
            oi++;
          }
          if (ni < newLines.length) {
            diffs.push({ type: "insert", newLine: newLines[ni] });
            ni++;
          }
        }
      }

      // Escape HTML
      const escape = (s: string) =>
        s
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

      if (mode === "sideBySide") {
        const rows = diffs.map((d) => {
          const oldCell = d.oldLine !== undefined
            ? `<td class="${d.type === "delete" ? "del" : ""}">${escape(d.oldLine)}</td>`
            : "<td></td>";
          const newCell = d.newLine !== undefined
            ? `<td class="${d.type === "insert" ? "ins" : ""}">${escape(d.newLine)}</td>`
            : "<td></td>";
          return `<tr>${oldCell}${newCell}</tr>`;
        });

        return {
          html: `<table class="diff side-by-side"><tbody>${rows.join("")}</tbody></table>`,
          css: `.diff td.del { background: #ffeef0; } .diff td.ins { background: #e6ffec; }`,
          mode: "sideBySide",
        };
      }

      // Inline mode
      const lines = diffs.map((d) => {
        if (d.type === "delete") {
          return `<div class="del">- ${escape(d.oldLine || "")}</div>`;
        } else if (d.type === "insert") {
          return `<div class="ins">+ ${escape(d.newLine || "")}</div>`;
        } else {
          return `<div class="ctx">  ${escape(d.oldLine || d.newLine || "")}</div>`;
        }
      });

      return {
        html: `<div class="diff inline">${lines.join("")}</div>`,
        css:
          `.diff .del { background: #ffeef0; color: #b31d28; } .diff .ins { background: #e6ffec; color: #22863a; } .diff .ctx { color: #444; }`,
        mode: "inline",
      };
    },
  },
];
