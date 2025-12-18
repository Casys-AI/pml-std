// @ts-nocheck
import { HttpError, page } from "fresh";
import { Head } from "fresh/runtime";
import { PRISM_THEME_CSS } from "../../utils/prism-theme.ts";
import { formatDate, getPost, type Post } from "../../utils/posts.ts";
import ArchitectureDiagram from "../../components/ArchitectureDiagram.tsx";
import MobileMenu from "../../islands/MobileMenu.tsx";

export const handler = {
  async GET(ctx: any) {
    try {
      const slug = ctx.params.slug;
      const post = await getPost(slug);

      if (!post) {
        throw new HttpError(404, "Post not found");
      }

      return page({ post });
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      console.error(`Error loading post ${ctx.params.slug}:`, error);
      throw new HttpError(500, "Internal server error");
    }
  },
};

export default function BlogPost({ data }: { data: { post: Post } }) {
  const { post } = data;

  return (
    <>
      <Head>
        <title>{post.title} - Casys PML Blog</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="description" content={post.snippet} />
        <meta property="og:title" content={post.title} />
        <meta property="og:description" content={post.snippet} />
        <meta property="og:type" content="article" />
        <meta property="article:published_time" content={post.date.toISOString()} />
        <meta property="article:author" content={post.author} />
        {post.tags.map((tag) => <meta property="article:tag" content={tag} key={tag} />)}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <style dangerouslySetInnerHTML={{ __html: PRISM_THEME_CSS }} />
      </Head>

      <div class="page">
        {/* Reading progress bar */}
        <div class="reading-progress" id="reading-progress"></div>

        <header class="header">
          <div class="header-inner">
            <a href="/" class="logo">
              <span class="logo-mark">Casys PML</span>
              <span class="logo-text">Procedural Memory Layer</span>
            </a>
            <nav class="nav">
              <a href="/" class="nav-link">Home</a>
              <a href="/docs" class="nav-link">Docs</a>
              <a href="/blog" class="nav-link nav-link-active">Blog</a>
              <MobileMenu />
            </nav>
          </div>
        </header>

        <main class="article-main">
          <article class="article">
            <header class="article-header">
              <a href="/blog" class="back-link">← Back to Blog</a>
              <div class="article-meta">
                <span class="article-category">{post.category}</span>
                <time class="article-date">{formatDate(post.date)}</time>
                <span class="article-author">by {post.author}</span>
              </div>
              <h1 class="article-title">{post.title}</h1>
              <p class="article-snippet">{post.snippet}</p>
              <div class="article-tags">
                {post.tags.map((tag) => <span class="article-tag" key={tag}>#{tag}</span>)}
              </div>
            </header>

            <div class="markdown-body article-content">
              {post.html.split("<!-- component: ArchitectureDiagram -->").map((
                part,
                index,
                array,
              ) => (
                <>
                  <div dangerouslySetInnerHTML={{ __html: part }} />
                  {index < array.length - 1 && (
                    <div
                      style={{
                        height: "400px",
                        margin: "2rem 0",
                        border: "1px solid var(--border)",
                        borderRadius: "12px",
                        background: "var(--bg-card)",
                        overflow: "hidden",
                      }}
                    >
                      <ArchitectureDiagram />
                    </div>
                  )}
                </>
              ))}
            </div>

            <footer class="article-footer">
              <div class="share-section">
                <span class="share-label">Share this article:</span>
                <div class="share-links">
                  <a
                    href={`https://twitter.com/intent/tweet?text=${
                      encodeURIComponent(post.title)
                    }&url=${encodeURIComponent(`https://pml.casys.ai/blog/${post.slug}`)}`}
                    target="_blank"
                    rel="noopener"
                    class="share-link"
                  >
                    Twitter
                  </a>
                  <a
                    href={`https://www.linkedin.com/sharing/share-offsite/?url=${
                      encodeURIComponent(`https://pml.casys.ai/blog/${post.slug}`)
                    }`}
                    target="_blank"
                    rel="noopener"
                    class="share-link"
                  >
                    LinkedIn
                  </a>
                </div>
              </div>
              <a href="/blog" class="back-link">← Back to all posts</a>
            </footer>
          </article>
        </main>

        <footer class="footer">
          <div class="footer-inner">
            <div class="footer-brand">
              <span class="logo-mark">Casys PML</span>
              <span class="footer-tagline">Procedural Memory Layer</span>
            </div>
            <div class="footer-links">
              <a href="https://casys.ai" target="_blank" rel="noopener">Casys.ai</a>
              <a
                href="https://github.com/Casys-AI/casys-pml"
                target="_blank"
                rel="noopener"
              >
                GitHub
              </a>
              <a href="/dashboard">Dashboard</a>
            </div>
          </div>
        </footer>

        <style>
          {`
          :root {
            --bg: #08080a;
            --bg-elevated: #0f0f12;
            --bg-card: #141418;
            --accent: #FFB86F;
            --accent-dim: rgba(255, 184, 111, 0.1);
            --accent-medium: rgba(255, 184, 111, 0.2);
            --purple: #a78bfa;
            --text: #f0ede8;
            --text-muted: #a8a29e;
            --text-dim: #6b6560;
            --border: rgba(255, 184, 111, 0.08);
            --border-strong: rgba(255, 184, 111, 0.15);
            --font-display: 'Instrument Serif', Georgia, serif;
            --font-sans: 'Geist', -apple-system, system-ui, sans-serif;
            --font-mono: 'Geist Mono', monospace;
          }

          * { margin: 0; padding: 0; box-sizing: border-box; }

          .page {
            min-height: 100vh;
            background: var(--bg);
            color: var(--text);
            font-family: var(--font-sans);
            display: flex;
            flex-direction: column;
          }

          /* Reading Progress */
          .reading-progress {
            position: fixed;
            top: 0;
            left: 0;
            height: 3px;
            background: linear-gradient(90deg, var(--accent), var(--purple));
            width: 0%;
            z-index: 1000;
            transition: width 0.1s ease-out;
          }

          /* Header */
          .header {
            position: sticky;
            top: 0;
            z-index: 100;
            padding: 1rem 2rem;
            background: rgba(8, 8, 10, 0.9);
            backdrop-filter: blur(20px);
            border-bottom: 1px solid var(--border);
          }

          .header-inner {
            max-width: 1200px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          .logo {
            display: flex;
            align-items: center;
            gap: 1rem;
            text-decoration: none;
          }

          .logo-mark {
            font-family: var(--font-display);
            font-size: 1.5rem;
            color: var(--accent);
          }

          .logo-text {
            font-size: 0.75rem;
            color: var(--text-dim);
            letter-spacing: 0.1em;
            text-transform: uppercase;
          }

          .nav {
            display: flex;
            align-items: center;
            gap: 2rem;
          }

          .nav-link {
            color: var(--text-muted);
            text-decoration: none;
            font-size: 0.875rem;
            font-weight: 500;
            transition: color 0.2s;
          }

          .nav-link:hover, .nav-link-active {
            color: var(--accent);
          }

          /* Article Main */
          .article-main {
            flex: 1;
            padding: 4rem 2rem;
          }

          .article {
            max-width: 720px;
            margin: 0 auto;
          }

          .back-link {
            display: inline-block;
            color: var(--text-muted);
            text-decoration: none;
            font-size: 0.875rem;
            margin-bottom: 2rem;
            transition: color 0.2s;
          }

          .back-link:hover {
            color: var(--accent);
          }

          .article-header {
            margin-bottom: 3rem;
            padding-bottom: 2rem;
            border-bottom: 1px solid var(--border);
          }

          .article-meta {
            display: flex;
            align-items: center;
            gap: 1rem;
            margin-bottom: 1.5rem;
            flex-wrap: wrap;
          }

          .article-category {
            font-family: var(--font-mono);
            font-size: 0.7rem;
            color: var(--accent);
            text-transform: uppercase;
            letter-spacing: 0.1em;
            padding: 0.25rem 0.75rem;
            background: var(--accent-dim);
            border-radius: 4px;
          }

          .article-date, .article-author {
            font-size: 0.875rem;
            color: var(--text-dim);
          }

          .article-title {
            font-family: var(--font-display);
            font-size: 2.5rem;
            font-weight: 400;
            line-height: 1.2;
            margin-bottom: 1rem;
          }

          .article-snippet {
            font-size: 1.25rem;
            color: var(--text-muted);
            line-height: 1.6;
            margin-bottom: 1.5rem;
          }

          .article-tags {
            display: flex;
            gap: 0.75rem;
            flex-wrap: wrap;
          }

          .article-tag {
            font-family: var(--font-mono);
            font-size: 0.8rem;
            color: var(--text-dim);
          }

          /* Article Content - GFM Override */
          .article-content.markdown-body {
            background: transparent !important;
            color: var(--text) !important;
            font-family: var(--font-sans);
            font-size: 1.125rem;
            line-height: 1.9;
            max-width: 70ch;
            opacity: 0;
            animation: fadeIn 0.6s ease-out 0.2s forwards;
          }

          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }

          .markdown-body h1,
          .markdown-body h2,
          .markdown-body h3,
          .markdown-body h4 {
            font-family: var(--font-display);
            font-weight: 400;
            color: var(--text);
            margin-top: 2.5rem;
            margin-bottom: 1rem;
            border-bottom: none;
          }

          .markdown-body h2 {
            font-size: 1.75rem;
          }

          .markdown-body h3 {
            font-size: 1.375rem;
          }

          .markdown-body p {
            margin-bottom: 1.5rem;
            color: var(--text-muted);
          }

          .markdown-body a {
            color: var(--accent);
          }

          .markdown-body strong {
            color: var(--text);
            font-weight: 600;
          }

          /* Inline code */
          .markdown-body code:not(pre code) {
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            padding: 0.2em 0.4em;
            border-radius: 4px;
            font-family: var(--font-mono);
            font-size: 0.875em;
            color: #ce9178;
          }

          /* Code blocks - Container styling with VS Code Dark+ */
          .markdown-body pre,
          .markdown-body pre[class*="language-"],
          .markdown-body .highlight {
            background: #1a1a1d !important;
            border: 1px solid rgba(255, 184, 111, 0.6) !important;
            border-radius: 8px;
            padding: 1.25rem !important;
            overflow-x: auto;
            margin: 1.5rem 0 !important;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
          }

          .markdown-body .highlight {
            padding: 0 !important;
          }

          .markdown-body .highlight pre {
            margin: 0 !important;
            border: none !important;
            box-shadow: none !important;
          }

          .markdown-body pre:hover,
          .markdown-body .highlight:hover {
            border-color: var(--accent);
            transition: border-color 0.3s;
          }

          .markdown-body pre code,
          .markdown-body pre[class*="language-"] code {
            background: transparent !important;
            border: none !important;
            padding: 0 !important;
            font-size: 12px !important;
            line-height: 1.7 !important;
            color: #d4d4d4 !important;
            font-family: 'Geist Mono', 'Consolas', 'Monaco', monospace !important;
          }

          .markdown-body blockquote {
            border-left: 3px solid var(--accent);
            padding-left: 1.5rem;
            margin: 1.5rem 0;
            color: var(--text-muted);
            font-style: italic;
          }

          .markdown-body ul,
          .markdown-body ol {
            margin: 1.5rem 0;
            padding-left: 2rem;
            color: var(--text-muted);
          }

          .markdown-body li {
            margin-bottom: 0.5rem;
          }

          .markdown-body hr {
            border: none;
            border-top: 1px solid var(--border);
            margin: 3rem 0;
          }

          /* ═══════════════════════════════════════════════════════════════
             DETAILS/SUMMARY - Collapsible sections with clear affordance
             ═══════════════════════════════════════════════════════════════ */
          .markdown-body details {
            margin: 1.5rem 0;
            background: var(--bg-elevated);
            border: 1px solid var(--border-strong);
            border-radius: 8px;
            overflow: hidden;
            transition: border-color 0.2s ease;
          }

          .markdown-body details:hover {
            border-color: rgba(255, 184, 111, 0.4);
          }

          .markdown-body details[open] {
            border-color: var(--accent);
            box-shadow: 0 2px 12px rgba(255, 184, 111, 0.1);
          }

          .markdown-body summary {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 1rem 1.25rem;
            cursor: pointer;
            font-weight: 500;
            color: var(--text);
            background: linear-gradient(
              180deg,
              rgba(255, 184, 111, 0.08) 0%,
              rgba(255, 184, 111, 0.03) 100%
            );
            border-bottom: 1px solid transparent;
            transition: all 0.2s ease;
            list-style: none;
          }

          .markdown-body summary::-webkit-details-marker {
            display: none;
          }

          /* Chevron indicator */
          .markdown-body summary::before {
            content: "▶";
            font-size: 0.65rem;
            color: var(--accent);
            transition: transform 0.2s ease;
            flex-shrink: 0;
          }

          .markdown-body details[open] summary::before {
            transform: rotate(90deg);
          }

          .markdown-body summary:hover {
            background: linear-gradient(
              180deg,
              rgba(255, 184, 111, 0.12) 0%,
              rgba(255, 184, 111, 0.06) 100%
            );
          }

          .markdown-body details[open] summary {
            border-bottom: 1px solid var(--border);
          }

          /* Content area */
          .markdown-body details > *:not(summary) {
            padding: 0 1.25rem;
          }

          .markdown-body details > *:last-child {
            padding-bottom: 1.25rem;
          }

          .markdown-body details > p:first-of-type {
            padding-top: 1rem;
          }

          /* Click hint on hover */
          .markdown-body summary::after {
            content: "cliquer pour ouvrir";
            margin-left: auto;
            font-size: 0.7rem;
            font-weight: 400;
            color: var(--text-dim);
            opacity: 0;
            transition: opacity 0.2s ease;
            font-family: var(--font-mono);
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }

          .markdown-body summary:hover::after {
            opacity: 1;
          }

          .markdown-body details[open] summary::after {
            content: "";
          }

          /* ═══════════════════════════════════════════════════════════════
             MERMAID DIAGRAMS - Parchment container for dark mode readability
             ═══════════════════════════════════════════════════════════════ */
          /* Target all diagram images directly via src (Kroki URLs) */
          .markdown-body img[src*="kroki.io"],
          .markdown-body img[alt*="Diagram"],
          .markdown-body img[alt*="Mermaid"],
          .markdown-body img[alt*="Excalidraw"] {
            display: block;
            max-width: 100%;
            height: auto;
            margin: 2.5rem auto;
            padding: 2rem;
            background: linear-gradient(
              135deg,
              #faf8f5 0%,
              #f5f0e8 50%,
              #faf6f0 100%
            );
            border-radius: 12px;
            border: 1px solid rgba(255, 184, 111, 0.3);
            box-shadow:
              0 4px 24px rgba(0, 0, 0, 0.4),
              0 1px 3px rgba(255, 184, 111, 0.1),
              inset 0 1px 0 rgba(255, 255, 255, 0.5);
          }

          /* Container styles for diagram-container class (legacy support) */
          .markdown-body .diagram-container {
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 2.5rem 0;
            padding: 2rem;
            background: linear-gradient(
              135deg,
              #faf8f5 0%,
              #f5f0e8 50%,
              #faf6f0 100%
            );
            border-radius: 12px;
            border: 1px solid rgba(255, 184, 111, 0.3);
            box-shadow:
              0 4px 24px rgba(0, 0, 0, 0.4),
              0 1px 3px rgba(255, 184, 111, 0.1),
              inset 0 1px 0 rgba(255, 255, 255, 0.5);
          }

          .markdown-body .diagram-container img {
            max-width: 100%;
            height: auto;
            padding: 0;
            margin: 0;
            background: transparent;
            border: none;
            box-shadow: none;
          }

          /* ═══════════════════════════════════════════════════════════════
             TABLES - Editorial refined style with accent borders
             ═══════════════════════════════════════════════════════════════ */
          .markdown-body table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            margin: 2rem 0;
            font-size: 0.9375rem;
            background: var(--bg-elevated);
            border-radius: 8px;
            overflow: hidden;
            border: 1px solid var(--border-strong);
            box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
          }

          .markdown-body thead {
            background: linear-gradient(
              180deg,
              rgba(255, 184, 111, 0.12) 0%,
              rgba(255, 184, 111, 0.06) 100%
            );
          }

          .markdown-body th {
            font-family: var(--font-mono);
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--accent);
            padding: 1rem 1.25rem;
            text-align: left;
            border-bottom: 2px solid rgba(255, 184, 111, 0.25);
            white-space: nowrap;
          }

          .markdown-body td {
            padding: 0.875rem 1.25rem;
            color: var(--text-muted);
            border-bottom: 1px solid var(--border);
            vertical-align: top;
            line-height: 1.6;
          }

          .markdown-body tbody tr:last-child td {
            border-bottom: none;
          }

          /* Alternating row colors for readability */
          .markdown-body tbody tr:nth-child(even) {
            background: rgba(255, 255, 255, 0.02);
          }

          /* Hover effect */
          .markdown-body tbody tr {
            transition: background 0.15s ease;
          }

          .markdown-body tbody tr:hover {
            background: rgba(255, 184, 111, 0.05);
          }

          /* First column emphasis for definition tables */
          .markdown-body td:first-child {
            color: var(--text);
            font-weight: 500;
          }

          /* Code in tables */
          .markdown-body td code,
          .markdown-body th code {
            font-size: 0.8125rem;
            padding: 0.15em 0.4em;
          }

          /* Article Footer */
          .article-footer {
            margin-top: 3rem;
            padding-top: 2rem;
            border-top: 1px solid var(--border);
          }

          .share-section {
            margin-bottom: 2rem;
          }

          .share-label {
            display: block;
            font-size: 0.875rem;
            color: var(--text-dim);
            margin-bottom: 0.75rem;
          }

          .share-links {
            display: flex;
            gap: 1rem;
          }

          .share-link {
            padding: 0.5rem 1rem;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text-muted);
            text-decoration: none;
            font-size: 0.875rem;
            transition: all 0.2s;
          }

          .share-link:hover {
            border-color: var(--accent);
            color: var(--accent);
          }

          /* Footer */
          .footer {
            padding: 2rem;
            border-top: 1px solid var(--border);
          }

          .footer-inner {
            max-width: 1200px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          .footer-brand {
            display: flex;
            align-items: center;
            gap: 1rem;
          }

          .footer-tagline {
            font-size: 0.75rem;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 0.1em;
          }

          .footer-links {
            display: flex;
            gap: 2rem;
          }

          .footer-links a {
            color: var(--text-muted);
            text-decoration: none;
            font-size: 0.875rem;
          }

          .footer-links a:hover {
            color: var(--accent);
          }

          @media (max-width: 768px) {
            .header { padding: 1rem; }
            .logo-text { display: none; }
            .nav { gap: 0.75rem; }
            /* Hide desktop nav on mobile - MobileMenu handles navigation */
            .nav-link { display: none; }
            .article-main { padding: 2rem 1rem; }
            .article-title { font-size: 1.75rem; }
            .article-snippet { font-size: 1rem; }
            .article-meta { gap: 0.5rem; }
            .footer-inner { flex-direction: column; gap: 1.5rem; text-align: center; }

            /* Code blocks mobile */
            .markdown-body pre,
            .markdown-body pre[class*="language-"],
            .markdown-body .highlight {
              padding: 0.75rem !important;
              margin-left: -1rem !important;
              margin-right: -1rem !important;
              border-radius: 0 !important;
              border-left: none !important;
              border-right: none !important;
            }

            .markdown-body pre code,
            .markdown-body pre[class*="language-"] code {
              font-size: 11px !important;
              -webkit-overflow-scrolling: touch;
            }

            /* Details mobile */
            .markdown-body details {
              margin: 1rem -1rem;
              border-radius: 0;
              border-left: none;
              border-right: none;
            }

            .markdown-body summary::after {
              display: none;
            }

            /* Diagrams mobile */
            .markdown-body img[src*="kroki.io"],
            .markdown-body img[alt*="Diagram"],
            .markdown-body img[alt*="Mermaid"],
            .markdown-body img[alt*="Excalidraw"],
            .markdown-body .diagram-container {
              margin: 1.5rem -1rem;
              padding: 1.25rem;
              border-radius: 0;
              border-left: none;
              border-right: none;
            }

            /* Tables mobile - horizontal scroll */
            .markdown-body table {
              display: block;
              overflow-x: auto;
              -webkit-overflow-scrolling: touch;
              margin: 1.5rem -1rem;
              border-radius: 0;
              border-left: none;
              border-right: none;
            }

            .markdown-body th,
            .markdown-body td {
              padding: 0.75rem 1rem;
              font-size: 0.875rem;
            }

            .markdown-body th {
              font-size: 0.7rem;
            }
          }
        `}
        </style>

        <script
          type="module"
          dangerouslySetInnerHTML={{
            __html: `
              // Reading progress bar
              window.addEventListener('scroll', () => {
                const article = document.querySelector('.article-content');
                if (!article) return;

                const articleTop = article.offsetTop;
                const articleHeight = article.offsetHeight;
                const scrollPosition = window.scrollY;
                const windowHeight = window.innerHeight;

                const progress = Math.min(
                  100,
                  Math.max(0, ((scrollPosition - articleTop + windowHeight) / articleHeight) * 100)
                );

                const progressBar = document.getElementById('reading-progress');
                if (progressBar) {
                  progressBar.style.width = progress + '%';
                }
              });
            `,
          }}
        />
      </div>
    </>
  );
}
