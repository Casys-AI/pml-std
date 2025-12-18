import { extract } from "@std/front-matter/yaml";
import { render } from "@deno/gfm";
import { join } from "@std/path";
import { deflate } from "pako";

// Import Prism language support for syntax highlighting
import "npm:prismjs@1.29.0/components/prism-typescript.js";
import "npm:prismjs@1.29.0/components/prism-javascript.js";
import "npm:prismjs@1.29.0/components/prism-bash.js";
import "npm:prismjs@1.29.0/components/prism-json.js";
import "npm:prismjs@1.29.0/components/prism-yaml.js";
import "npm:prismjs@1.29.0/components/prism-jsx.js";
import "npm:prismjs@1.29.0/components/prism-tsx.js";

export interface PostFrontmatter {
  title: string;
  slug: string;
  date: string;
  category: string;
  tags: string[];
  snippet: string;
  format?: string;
  language?: string;
  author?: string;
}

export interface Post {
  slug: string;
  title: string;
  date: Date;
  category: string;
  tags: string[];
  snippet: string;
  author: string;
  content: string;
  html: string;
}

// Use working directory for production compatibility
// Note: When running via Vite, cwd is already "src/web"
const POSTS_DIR = Deno.cwd().endsWith("src/web")
  ? join(Deno.cwd(), "posts")
  : join(Deno.cwd(), "src/web/posts");

export async function getPosts(): Promise<Post[]> {
  const posts: Post[] = [];

  for await (const entry of Deno.readDir(POSTS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      const post = await getPostByFilename(entry.name);
      if (post) {
        posts.push(post);
      }
    }
  }

  // Sort by date descending (newest first)
  posts.sort((a, b) => b.date.getTime() - a.date.getTime());

  return posts;
}

export async function getPost(slug: string): Promise<Post | null> {
  // Optimized: read file directly instead of listing all posts
  try {
    // Try reading with slug as filename
    const possiblePaths = [
      join(POSTS_DIR, `${slug}.md`),
      // Try with date prefix (common pattern: YYYY-MM-DD-slug.md)
    ];

    // Also check for files that end with the slug
    for await (const entry of Deno.readDir(POSTS_DIR)) {
      if (entry.isFile && entry.name.endsWith(`${slug}.md`)) {
        possiblePaths.push(join(POSTS_DIR, entry.name));
      }
    }

    // Try each path
    for (const path of possiblePaths) {
      try {
        const content = await Deno.readTextFile(path);
        const filename = path.split("/").pop() || "";
        return await getPostByFilename(filename, content);
      } catch {
        // File doesn't exist, try next path
        continue;
      }
    }

    return null;
  } catch (error) {
    console.error(`Error reading post ${slug}:`, error);
    return null;
  }
}

// Helper to create Kroki URL
function createKrokiUrl(type: string, source: string): string {
  const data = new TextEncoder().encode(source);
  const compressed = deflate(data, { level: 9 });
  // Convert to base64url
  const result = btoa(Array.from(compressed, (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `https://kroki.io/${type}/svg/${result}`;
}

// Cache for external excalidraw files
const excalidrawCache = new Map<string, string>();

// Helper to get project root directory
function getProjectRoot(): string {
  const cwd = Deno.cwd();
  const root = cwd.endsWith("src/web") ? join(cwd, "../..") : cwd;
  return root;
}

// Load external excalidraw file and create Kroki URL
async function loadExcalidrawFile(filePath: string): Promise<string | null> {
  try {
    // Check cache first
    if (excalidrawCache.has(filePath)) {
      console.log(`[loadExcalidrawFile] Cache hit for: ${filePath}`);
      return excalidrawCache.get(filePath)!;
    }

    const root = getProjectRoot();
    const fullPath = join(root, filePath);
    console.log(
      `[loadExcalidrawFile] Loading from: ${fullPath} (cwd: ${Deno.cwd()}, root: ${root})`,
    );

    const content = await Deno.readTextFile(fullPath);
    console.log(`[loadExcalidrawFile] File loaded, size: ${content.length} bytes`);

    const url = createKrokiUrl("excalidraw", content);
    console.log(`[loadExcalidrawFile] Kroki URL generated, length: ${url.length}`);

    // Cache the result
    excalidrawCache.set(filePath, url);
    return url;
  } catch (error) {
    console.error(`[loadExcalidrawFile] Error loading ${filePath}:`, error);
    return null;
  }
}

// Pre-process markdown to replace excalidraw: references before GFM rendering
async function preprocessMarkdown(markdown: string): Promise<string> {
  // Match markdown image syntax: ![alt](excalidraw:path/to/file.excalidraw)
  const excalidrawRefRegex = /!\[([^\]]*)\]\(excalidraw:([^)]+)\)/g;
  const matches = [...markdown.matchAll(excalidrawRefRegex)];

  console.log(`[preprocessMarkdown] Found ${matches.length} excalidraw references`);

  for (const match of matches) {
    const [fullMatch, alt, filePath] = match;
    console.log(`[preprocessMarkdown] Processing: ${filePath}`);
    const url = await loadExcalidrawFile(filePath);
    if (url) {
      // Replace with simple markdown image
      const replacement = `![${alt || "Excalidraw Diagram"}](${url})`;
      markdown = markdown.replace(fullMatch, replacement);
      console.log(`[preprocessMarkdown] Replaced with image`);
    } else {
      console.error(`[preprocessMarkdown] Failed to load: ${filePath}`);
    }
  }

  // Match mermaid code blocks: ```mermaid\n...\n```
  const mermaidRegex = /```mermaid\s*\n([\s\S]*?)```/g;
  const mermaidMatches = [...markdown.matchAll(mermaidRegex)];

  console.log(`[preprocessMarkdown] Found ${mermaidMatches.length} mermaid diagrams`);

  for (const match of mermaidMatches) {
    const [fullMatch, code] = match;
    // Inject dark theme if no theme is already defined
    let mermaidCode = code.trim();
    if (!mermaidCode.includes("%%{init:") && !mermaidCode.includes("%%{ init:")) {
      mermaidCode = `%%{init: {'theme': 'dark'}}%%\n${mermaidCode}`;
    }
    const url = createKrokiUrl("mermaid", mermaidCode);
    // Replace with simple markdown image (scroll wrapper added post-GFM in processContent)
    const replacement = `![Mermaid Diagram](${url})`;
    markdown = markdown.replace(fullMatch, replacement);
    console.log(`[preprocessMarkdown] Replaced mermaid with image (dark theme injected)`);
  }

  return markdown;
}

async function processContent(html: string): Promise<string> {
  // Replace mermaid code blocks with Kroki images (fallback if preprocessMarkdown didn't catch them)
  let result = html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_match, code) => {
      // Unescape HTML entities
      let unescaped = code
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();

      // Inject dark theme if no theme is already defined
      if (!unescaped.includes("%%{init:") && !unescaped.includes("%%{ init:")) {
        unescaped = `%%{init: {'theme': 'dark'}}%%\n${unescaped}`;
      }

      const url = createKrokiUrl("mermaid", unescaped);
      return `<img src="${url}" alt="Mermaid Diagram" loading="lazy" />`;
    },
  );

  // Replace excalidraw code blocks with Kroki images
  // Match both plain <pre><code> and <pre><code class="language-excalidraw">
  // We detect Excalidraw blocks by checking if the content starts with Excalidraw JSON structure
  result = result.replace(
    /<pre><code(?:\s+class="[^"]*")?\s*>([\s\S]*?)<\/code><\/pre>/g,
    (match, code) => {
      // Unescape HTML entities
      const unescaped = code
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();

      // Check if this is an Excalidraw diagram (starts with { and contains "type": "excalidraw")
      if (unescaped.startsWith("{") && unescaped.includes('"type": "excalidraw"')) {
        try {
          const url = createKrokiUrl("excalidraw", unescaped);
          return `<img src="${url}" alt="Excalidraw Diagram" loading="lazy" />`;
        } catch (error) {
          console.error("Error creating Excalidraw diagram:", error);
          return match;
        }
      }

      // Not an Excalidraw diagram, return original
      return match;
    },
  );

  // Wrap all kroki.io images with scrollable container for mobile responsiveness
  // This runs AFTER GFM rendering, so custom HTML won't be stripped
  result = result.replace(
    /<img\s+([^>]*src="https:\/\/kroki\.io\/[^"]*"[^>]*)>/g,
    (_match, attrs) => {
      return `<div class="diagram-scroll"><img ${attrs} /></div>`;
    },
  );

  return result;
}

async function getPostByFilename(filename: string, content?: string): Promise<Post | null> {
  try {
    // If content not provided, read from file
    if (!content) {
      const filePath = join(POSTS_DIR, filename);
      content = await Deno.readTextFile(filePath);
    }

    const { attrs, body } = extract<PostFrontmatter>(content);

    // Validation: Check required fields
    if (!attrs.title || !attrs.date) {
      console.error(`Post ${filename}: Missing required frontmatter (title or date)`);
      return null;
    }

    // Validation: Check date is valid
    const postDate = new Date(attrs.date);
    if (isNaN(postDate.getTime())) {
      console.error(`Post ${filename}: Invalid date format: ${attrs.date}`);
      return null;
    }

    // Validation: Slug should be URL-safe
    const slug = attrs.slug || filename.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
    if (!/^[a-z0-9-]+$/.test(slug)) {
      console.warn(`Post ${filename}: Slug contains non-URL-safe characters: ${slug}`);
    }

    // Pre-process markdown for excalidraw references
    const processedBody = await preprocessMarkdown(body);

    // Render markdown to HTML with GFM (includes sanitization)
    let html = render(processedBody);

    // Process HTML for diagrams (mermaid and inline excalidraw)
    html = await processContent(html);

    return {
      slug,
      title: attrs.title,
      date: postDate,
      category: attrs.category || "general",
      tags: Array.isArray(attrs.tags) ? attrs.tags : [],
      snippet: attrs.snippet || "",
      author: attrs.author || "Casys Team",
      content: body,
      html,
    };
  } catch (error) {
    console.error(`Error parsing post ${filename}:`, error);
    return null;
  }
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
