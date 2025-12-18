// @ts-nocheck: Large landing page with complex inline styles
import { page } from "fresh";
import type { FreshContext } from "fresh";
import { Head } from "fresh/runtime";
import { formatDate, getPosts, type Post } from "../utils/posts.ts";
import type { AuthState } from "./_middleware.ts";

import {
  CapabilitiesIllustration,
  HILIllustration,
  HypergraphIllustration,
  SandboxIllustration,
  SearchIllustration,
  StructuralEmergenceIllustration,
  ThreeLoopIllustration,
} from "../components/FeatureIllustrations.tsx";
import { HeroRepl } from "../islands/HeroRepl.tsx";
import MobileMenu from "../islands/MobileMenu.tsx";

// Feature flag - set to true to show auth UI (Sign in, Dashboard links)
const SHOW_AUTH = false;

interface LandingPageData {
  latestPosts: Post[];
  isCloudMode: boolean;
  user: AuthState["user"];
}

export const handler = {
  async GET(ctx: FreshContext<AuthState>) {
    try {
      const posts = await getPosts();
      const latestPosts = posts.slice(0, 3);
      return page({
        latestPosts,
        isCloudMode: ctx.state.isCloudMode,
        user: ctx.state.user,
      });
    } catch (error) {
      console.error("Error loading posts for landing page:", error);
      // Return empty array on error - landing page should still work
      return page({
        latestPosts: [],
        isCloudMode: ctx.state.isCloudMode,
        user: ctx.state.user,
      });
    }
  },
};

export default function LandingPage({ data }: { data: LandingPageData }) {
  const { latestPosts, isCloudMode, user } = data;

  return (
    <>
      <Head>
        <title>Casys PML - Procedural Memory Layer</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta
          name="description"
          content="An open-source Procedural Memory Layer for AI agents. Casys PML captures emergent workflows and crystallizes them into reusable skills. RAG gave agents knowledge. PML gives them skills."
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </Head>

      <div class="page">
        {/* Animated Network Background */}
        <div class="network-bg">
          <svg class="network-svg" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">
            <defs>
              <radialGradient id="node-pulse" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="#FFB86F" stop-opacity="0.8" />
                <stop offset="100%" stop-color="#FFB86F" stop-opacity="0" />
              </radialGradient>
              <filter id="glow">
                <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Network connections - animated */}
            <g class="connections" stroke="#FFB86F" stroke-width="1" fill="none" opacity="0.15">
              <path d="M100,200 Q300,100 500,200 T900,150" class="path-1" />
              <path d="M200,400 Q400,300 600,400 T1000,350" class="path-2" />
              <path d="M0,600 Q200,500 400,600 T800,550" class="path-3" />
              <path d="M300,100 L500,300 L700,200 L900,400" class="path-4" />
              <path d="M100,500 L300,350 L500,500 L700,350 L900,500" class="path-5" />
            </g>

            {/* Floating nodes */}
            <g class="nodes">
              <circle cx="200" cy="200" r="4" fill="#FFB86F" opacity="0.6" class="node-float-1" />
              <circle cx="500" cy="300" r="6" fill="#FFB86F" opacity="0.8" class="node-float-2" />
              <circle cx="800" cy="200" r="3" fill="#FFB86F" opacity="0.5" class="node-float-3" />
              <circle cx="300" cy="500" r="5" fill="#FFB86F" opacity="0.7" class="node-float-4" />
              <circle cx="700" cy="450" r="4" fill="#FFB86F" opacity="0.6" class="node-float-5" />
              <circle cx="1000" cy="300" r="5" fill="#FFB86F" opacity="0.4" class="node-float-6" />
            </g>

            {/* Data packets traveling along paths */}
            <circle r="3" fill="#FFB86F" filter="url(#glow)">
              <animateMotion
                dur="8s"
                repeatCount="indefinite"
                path="M100,200 Q300,100 500,200 T900,150"
              />
            </circle>
            <circle r="2" fill="#FFB86F" filter="url(#glow)">
              <animateMotion
                dur="10s"
                repeatCount="indefinite"
                path="M200,400 Q400,300 600,400 T1000,350"
              />
            </circle>
            <circle r="2.5" fill="#FFB86F" filter="url(#glow)">
              <animateMotion
                dur="12s"
                repeatCount="indefinite"
                path="M0,600 Q200,500 400,600 T800,550"
              />
            </circle>
          </svg>
        </div>

        {/* Navigation */}
        <header class="header">
          <div class="header-inner">
            <a href="/" class="logo">
              <span class="logo-mark">Casys PML</span>
              <span class="logo-text">Procedural Memory Layer</span>
            </a>
            <nav class="nav">
              <a href="#problem" class="nav-link">Why</a>
              <a href="#how" class="nav-link">How</a>
              <a href="#tech" class="nav-link">Tech</a>
              <a href="/docs" class="nav-link">Docs</a>
              <a href="/blog" class="nav-link">Blog</a>
              {SHOW_AUTH && !isCloudMode && <a href="/dashboard" class="nav-link">Dashboard</a>}
              <a
                href="https://github.com/Casys-AI/casys-pml"
                class="nav-link nav-link-github"
                target="_blank"
                rel="noopener"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
              </a>
              {/* Auth section: Sign in or Local mode badge */}
              {SHOW_AUTH && (isCloudMode
                ? (
                  user
                    ? (
                      <a href="/dashboard/settings" class="nav-user">
                        <img
                          src={user.avatarUrl || "/default-avatar.svg"}
                          alt={user.username}
                          class="nav-avatar"
                        />
                        <span class="nav-username">{user.username}</span>
                      </a>
                    )
                    : (
                      <a href="/auth/signin" class="btn btn-signin">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                        </svg>
                        Sign in with GitHub
                      </a>
                    )
                )
                : (
                  <span class="badge-local">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                    Local Mode
                  </span>
                ))}
              {/* Mobile Menu - hamburger + drawer */}
              <MobileMenu />
            </nav>
          </div>
        </header>

        {
          /* ═══════════════════════════════════════════════════════════════════
            HERO - The Core Promise
        ═══════════════════════════════════════════════════════════════════ */
        }
        <main class="hero">
          <div class="hero-grid">
            <div class="hero-content">
              <p class="hero-eyebrow">Open-Source Procedural Memory Layer</p>
              <h1 class="hero-title">
                An agent discovered a pattern.<br />
                <span class="hero-title-accent">Then another agent used it.</span>
              </h1>
              <p class="hero-desc">
                Casys PML captures emergent workflows — tool combinations that agents discover through
                execution, not design. These patterns crystallize into reusable skills.
                RAG gave agents knowledge. PML gives them skills.
              </p>
              <div class="hero-actions">
                <a href="#how" class="btn btn-primary">
                  See How It Works
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path d="M12 5v14M5 12l7 7 7-7" />
                  </svg>
                </a>
                <a
                  href="https://github.com/Casys-AI/casys-pml"
                  class="btn btn-ghost"
                  target="_blank"
                  rel="noopener"
                >
                  View on GitHub
                </a>
              </div>
            </div>

            {/* Interactive REPL - Learning Loop Demo */}
            <div class="hero-repl-wrapper">
              <HeroRepl />
            </div>
          </div>
        </main>

        {
          /* ═══════════════════════════════════════════════════════════════════
            THE PROBLEM
        ═══════════════════════════════════════════════════════════════════ */
        }
        <section id="problem" class="section-problem">
          <div class="container">
            <div class="problem-grid">
              <div class="problem-content">
                <span class="section-label">The Observation</span>
                <h2 class="problem-title">
                  Agents discover patterns.<br />
                  <span class="problem-highlight">Then they're lost.</span>
                </h2>
                <p class="problem-desc">
                  When AI agents solve problems, they often find clever ways to combine tools. But
                  these discoveries vanish when the session ends.
                </p>
                <p class="problem-desc">
                  What if we could capture these emergent patterns? What if agents could learn from
                  each other's discoveries?
                </p>
              </div>
              <div class="problem-visual">
                <div class="amnesia-diagram">
                  <div class="session session-1">
                    <span class="session-label">Session 1</span>
                    <div class="session-discovery">discovers pattern A</div>
                  </div>
                  <div class="amnesia-arrow">
                    <span>forgotten</span>
                    <svg width="40" height="40" viewBox="0 0 40 40">
                      <path
                        d="M10 20 L30 20 M25 15 L30 20 L25 25"
                        stroke="#f87171"
                        stroke-width="2"
                        fill="none"
                      />
                    </svg>
                  </div>
                  <div class="session session-2">
                    <span class="session-label">Session 2</span>
                    <div class="session-discovery">re-discovers pattern A</div>
                  </div>
                  <div class="amnesia-arrow">
                    <span>forgotten</span>
                    <svg width="40" height="40" viewBox="0 0 40 40">
                      <path
                        d="M10 20 L30 20 M25 15 L30 20 L25 25"
                        stroke="#f87171"
                        stroke-width="2"
                        fill="none"
                      />
                    </svg>
                  </div>
                  <div class="session session-3">
                    <span class="session-label">Session 3</span>
                    <div class="session-discovery">re-discovers pattern A</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {
          /* ═══════════════════════════════════════════════════════════════════
            THE SOLUTION - Two Levels of Emergence
        ═══════════════════════════════════════════════════════════════════ */
        }
        <section id="how" class="section-solution">
          <div class="container">
            <div class="section-header">
              <span class="section-label">The Solution</span>
              <h2 class="section-title">Two Levels of Emergence</h2>
              <p class="section-desc">
                Casys PML tracks how agents combine MCPs — both planned and improvised.<br />
                Patterns that work get promoted to explicit capabilities.
              </p>
            </div>

            <div class="emergence-grid">
              {/* Level 1: Structural */}
              <div class="emergence-card">
                <div class="emergence-icon">
                  <svg viewBox="0 0 48 48" fill="none">
                    <path d="M8 24h8M32 24h8M24 8v8M24 32v8" stroke="#FFB86F" stroke-width="2" />
                    <rect
                      x="16"
                      y="16"
                      width="16"
                      height="16"
                      rx="2"
                      stroke="#FFB86F"
                      stroke-width="2"
                    />
                    <circle cx="8" cy="24" r="3" fill="#FFB86F" />
                    <circle cx="40" cy="24" r="3" fill="#FFB86F" />
                    <circle cx="24" cy="8" r="3" fill="#FFB86F" />
                    <circle cx="24" cy="40" r="3" fill="#FFB86F" />
                  </svg>
                </div>
                <span class="emergence-level">Level 1</span>
                <h3 class="emergence-title">Structural Emergence</h3>
                <p class="emergence-desc">
                  The orchestrator analyzes intent and builds optimal DAGs. Routes calls
                  intelligently, parallelizes where possible.
                  <strong>Relationships emerge from planning.</strong>
                </p>
                <div class="emergence-visual">
                  <StructuralEmergenceIllustration />
                </div>
              </div>

              {/* Level 2: Behavioral */}
              <div class="emergence-card emergence-card-accent">
                <div class="emergence-icon">
                  <svg viewBox="0 0 48 48" fill="none">
                    <path d="M12 36 L24 12 L36 36" stroke="#a78bfa" stroke-width="2" fill="none" />
                    <circle cx="24" cy="12" r="4" stroke="#a78bfa" stroke-width="2" />
                    <circle cx="12" cy="36" r="4" stroke="#a78bfa" stroke-width="2" />
                    <circle cx="36" cy="36" r="4" stroke="#a78bfa" stroke-width="2" />
                    <path
                      d="M18 28 Q24 20 30 28"
                      stroke="#a78bfa"
                      stroke-width="2"
                      stroke-dasharray="3 3"
                    />
                  </svg>
                </div>
                <span class="emergence-level">Level 2</span>
                <h3 class="emergence-title">Behavioral Emergence</h3>
                <p class="emergence-desc">
                  Agents generate code that combines MCPs in improvised ways. Novel combinations
                  that no one designed upfront.
                  <strong>Capabilities emerge from execution.</strong>
                </p>
                <div class="emergence-visual">
                  <CapabilitiesIllustration />
                </div>
              </div>
            </div>

            {/* The Learning Loop */}
            <div class="learning-loop">
              <div class="loop-visual">
                <ThreeLoopIllustration />
              </div>
              <div class="loop-content">
                <h3 class="loop-title">The Three Loops</h3>
                <div class="loop-item">
                  <span class="loop-badge loop-execution">Adaptation</span>
                  <p>Execution → DAG. Immediate correction.</p>
                </div>
                <div class="loop-item">
                  <span class="loop-badge loop-adaptation">Speculation</span>
                  <p>Execution → Patterns. Rule optimization.</p>
                </div>
                <div class="loop-item">
                  <span class="loop-badge loop-meta">Crystallization</span>
                  <p>Execution → Capabilities. Context evolution.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {
          /* ═══════════════════════════════════════════════════════════════════
            THE COLLECTIVE QUESTION
        ═══════════════════════════════════════════════════════════════════ */
        }
        <section id="collective" class="section-moat">
          <div class="container">
            <div class="section-header">
              <span class="section-label">The Collective</span>
              <h2 class="section-title">Patterns that propagate</h2>
              <p class="section-desc">
                When one agent discovers a useful combination, it becomes available to all.
              </p>
            </div>

            <div class="propagation-flow">
              <div class="flow-step">
                <div class="flow-icon">
                  <svg viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="8" stroke="#FFB86F" stroke-width="2" />
                    <path d="M20 8v6M20 26v6M8 20h6M26 20h6" stroke="#FFB86F" stroke-width="2" />
                  </svg>
                </div>
                <h4>Discovery</h4>
                <p>Agent A combines tools in a new way to solve a task</p>
              </div>
              <div class="flow-arrow">
                <svg viewBox="0 0 40 20" fill="none">
                  <path d="M5 10h25M25 5l5 5-5 5" stroke="#FFB86F" stroke-width="2" />
                </svg>
              </div>
              <div class="flow-step">
                <div class="flow-icon">
                  <svg viewBox="0 0 40 40" fill="none">
                    <rect
                      x="8"
                      y="12"
                      width="24"
                      height="16"
                      rx="2"
                      stroke="#FFB86F"
                      stroke-width="2"
                    />
                    <path d="M12 8h16M14 4h12" stroke="#FFB86F" stroke-width="2" opacity="0.5" />
                  </svg>
                </div>
                <h4>Capture</h4>
                <p>The pattern is extracted and stored in the SuperHyperGraph</p>
              </div>
              <div class="flow-arrow">
                <svg viewBox="0 0 40 20" fill="none">
                  <path d="M5 10h25M25 5l5 5-5 5" stroke="#FFB86F" stroke-width="2" />
                </svg>
              </div>
              <div class="flow-step flow-step-highlight">
                <div class="flow-icon">
                  <svg viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="14" r="6" stroke="#FFB86F" stroke-width="2" />
                    <circle cx="12" cy="28" r="5" stroke="#FFB86F" stroke-width="2" />
                    <circle cx="28" cy="28" r="5" stroke="#FFB86F" stroke-width="2" />
                    <path
                      d="M17 18l-3 6M23 18l3 6M15 28h10"
                      stroke="#FFB86F"
                      stroke-width="1.5"
                      stroke-dasharray="2 2"
                    />
                  </svg>
                </div>
                <h4>Propagation</h4>
                <p>Agent B, C, D... can now use this capability</p>
              </div>
            </div>
          </div>
        </section>

        {
          /* ═══════════════════════════════════════════════════════════════════
            TECHNICAL FOUNDATION
        ═══════════════════════════════════════════════════════════════════ */
        }
        <section id="tech" class="section-tech">
          <div class="container">
            <div class="section-header">
              <span class="section-label">Under the Hood</span>
              <h2 class="section-title">Built for Emergence</h2>
            </div>

            <div class="tech-grid">
              <div class="tech-card">
                <div class="tech-icon">
                  <HypergraphIllustration />
                </div>
                <h4>SuperHyperGraph Structure</h4>
                <p>
                  Recursive n-ary relationships capture how tools combine into capabilities, and capabilities into meta-capabilities. Not just pairs — full patterns with unlimited nesting.
                </p>
              </div>

              <div class="tech-card">
                <div class="tech-icon">
                  <SandboxIllustration />
                </div>
                <h4>Secure Sandbox</h4>
                <p>Deno runtime executes generated code safely. PII filtering before storage.</p>
              </div>

              <div class="tech-card">
                <div class="tech-icon">
                  <HILIllustration />
                </div>
                <h4>Human-in-the-Loop</h4>
                <p>Granular AIL/HIL checkpoints. Approve sensitive operations before execution.</p>
              </div>

              <div class="tech-card">
                <div class="tech-icon">
                  <SearchIllustration />
                </div>
                <h4>Semantic Routing</h4>
                <p>
                  BGE embeddings understand intent. Find tools by description, not memorization.
                </p>
              </div>
            </div>

            <div class="tech-stats">
              <div class="stat">
                <span class="stat-value">229×</span>
                <span class="stat-label">Context Reduction</span>
              </div>
              <div class="stat">
                <span class="stat-value">∞</span>
                <span class="stat-label">Emergent Capabilities</span>
              </div>
              <div class="stat">
                <span class="stat-value">15+</span>
                <span class="stat-label">MCP Servers</span>
              </div>
            </div>
          </div>
        </section>

        {
          /* ═══════════════════════════════════════════════════════════════════
            LATEST POSTS
        ═══════════════════════════════════════════════════════════════════ */
        }
        {latestPosts.length > 0 && (
          <section class="section-blog">
            <div class="container">
              <div class="section-header">
                <span class="section-label">Engineering Blog</span>
                <h2 class="section-title">Latest Insights</h2>
                <p class="section-desc">
                  Deep dives, debugging stories, and lessons learned.
                </p>
              </div>

              <div class="blog-preview-grid">
                {latestPosts.map((post: Post) => (
                  <article class="blog-preview-card" key={post.slug}>
                    <div class="blog-preview-meta">
                      <span class="blog-preview-category">{post.category}</span>
                      <time class="blog-preview-date">{formatDate(post.date)}</time>
                    </div>
                    <h3 class="blog-preview-title">
                      <a href={`/blog/${post.slug}`}>{post.title}</a>
                    </h3>
                    <p class="blog-preview-snippet">{post.snippet}</p>
                    <div class="blog-preview-tags">
                      {post.tags.slice(0, 3).map((tag) => (
                        <span class="blog-preview-tag" key={tag}>#{tag}</span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>

              <div class="blog-preview-cta">
                <a href="/blog" class="btn btn-ghost">
                  View All Posts →
                </a>
              </div>
            </div>
          </section>
        )}

        {
          /* ═══════════════════════════════════════════════════════════════════
            CTA
        ═══════════════════════════════════════════════════════════════════ */
        }
        <section class="section-cta">
          <div class="container">
            <div class="cta-content">
              <h2>Curious? Dive in.</h2>
              <p>
                Casys PML is fully open source. Explore the code, run experiments, or contribute to the
                research.
              </p>
              <div class="cta-actions">
                <a
                  href="https://github.com/Casys-AI/casys-pml"
                  class="btn btn-primary"
                  target="_blank"
                  rel="noopener"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                  </svg>
                  Clone & Experiment
                </a>
                <a href="/blog" class="btn btn-accent">
                  Read the Blog
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
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
              <a href="/docs">Docs</a>
              {SHOW_AUTH && !isCloudMode && <a href="/dashboard">Dashboard</a>}
            </div>
          </div>
        </footer>

        <style>
          {`
          /* ═══════════════════════════════════════════════════════════════════
             DESIGN TOKENS
          ═══════════════════════════════════════════════════════════════════ */
          :root {
            --bg: #08080a;
            --bg-elevated: #0f0f12;
            --bg-card: #141418;
            --accent: #FFB86F;
            --accent-dim: rgba(255, 184, 111, 0.1);
            --accent-medium: rgba(255, 184, 111, 0.2);
            --purple: #a78bfa;
            --green: #4ade80;
            --red: #f87171;
            --text: #f0ede8;
            --text-muted: #a8a29e;
            --text-dim: #6b6560;
            --border: rgba(255, 184, 111, 0.08);
            --border-strong: rgba(255, 184, 111, 0.15);

            --font-display: 'Instrument Serif', Georgia, serif;
            --font-sans: 'Geist', -apple-system, system-ui, sans-serif;
            --font-mono: 'Geist Mono', monospace;
          }

          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          /* ═══════════════════════════════════════════════════════════════════
             BASE LAYOUT
          ═══════════════════════════════════════════════════════════════════ */
          .page {
            min-height: 100vh;
            background: var(--bg);
            color: var(--text);
            font-family: var(--font-sans);
            position: relative;
            overflow-x: hidden;
          }

          .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 2rem;
          }

          /* ═══════════════════════════════════════════════════════════════════
             ANIMATED NETWORK BACKGROUND
          ═══════════════════════════════════════════════════════════════════ */
          .network-bg {
            position: fixed;
            inset: 0;
            z-index: 0;
            pointer-events: none;
            opacity: 0.4;
          }

          .network-svg {
            width: 100%;
            height: 100%;
          }

          .connections path {
            stroke-dasharray: 1000;
            stroke-dashoffset: 1000;
            animation: draw-path 20s ease-in-out infinite;
          }

          .path-1 { animation-delay: 0s; }
          .path-2 { animation-delay: 2s; }
          .path-3 { animation-delay: 4s; }
          .path-4 { animation-delay: 6s; }
          .path-5 { animation-delay: 8s; }

          @keyframes draw-path {
            0%, 100% { stroke-dashoffset: 1000; }
            50% { stroke-dashoffset: 0; }
          }

          .node-float-1 { animation: float 8s ease-in-out infinite; }
          .node-float-2 { animation: float 10s ease-in-out infinite 1s; }
          .node-float-3 { animation: float 12s ease-in-out infinite 2s; }
          .node-float-4 { animation: float 9s ease-in-out infinite 3s; }
          .node-float-5 { animation: float 11s ease-in-out infinite 4s; }
          .node-float-6 { animation: float 7s ease-in-out infinite 5s; }

          @keyframes float {
            0%, 100% { transform: translate(0, 0); }
            25% { transform: translate(10px, -15px); }
            50% { transform: translate(-5px, 10px); }
            75% { transform: translate(15px, 5px); }
          }

          /* ═══════════════════════════════════════════════════════════════════
             HEADER
          ═══════════════════════════════════════════════════════════════════ */
          .header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 100;
            padding: 1rem 2rem;
            background: rgba(8, 8, 10, 0.8);
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
            font-weight: 400;
            color: var(--accent);
            letter-spacing: -0.02em;
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

          .nav-link:hover {
            color: var(--text);
          }

          .nav-link-github {
            display: flex;
            align-items: center;
            padding: 0.5rem;
            border-radius: 6px;
            transition: background 0.2s;
          }

          .nav-link-github:hover {
            background: var(--accent-dim);
          }

          /* Auth Elements */
          .btn-signin {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem 1rem;
            font-size: 0.875rem;
            font-weight: 600;
            font-family: var(--font-sans);
            text-decoration: none;
            border-radius: 8px;
            background: var(--accent);
            color: var(--bg);
            transition: all 0.2s;
            cursor: pointer;
            border: none;
          }

          .btn-signin:hover {
            filter: brightness(1.1);
            transform: translateY(-1px);
          }

          .badge-local {
            display: inline-flex;
            align-items: center;
            gap: 0.375rem;
            padding: 0.375rem 0.75rem;
            font-size: 0.75rem;
            font-weight: 500;
            font-family: var(--font-mono);
            color: var(--green);
            background: rgba(74, 222, 128, 0.1);
            border: 1px solid rgba(74, 222, 128, 0.2);
            border-radius: 6px;
            letter-spacing: 0.02em;
          }

          .nav-user {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.375rem 0.75rem;
            text-decoration: none;
            border-radius: 8px;
            background: var(--accent-dim);
            border: 1px solid var(--border);
            transition: all 0.2s;
          }

          .nav-user:hover {
            border-color: var(--accent);
            background: var(--accent-medium);
          }

          .nav-avatar {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            object-fit: cover;
          }

          .nav-username {
            font-size: 0.875rem;
            font-weight: 500;
            color: var(--text);
          }

          /* ═══════════════════════════════════════════════════════════════════
             HERO
          ═══════════════════════════════════════════════════════════════════ */
          .hero {
            position: relative;
            z-index: 10;
            min-height: 100vh;
            display: flex;
            align-items: center;
            padding: 8rem 2rem 4rem;
            max-width: 1200px;
            margin: 0 auto;
          }

          .hero-grid {
            display: grid;
            grid-template-columns: 1fr 1.2fr;
            gap: 3rem;
            align-items: center;
            width: 100%;
          }

          .hero-content {
            max-width: 600px;
          }

          .hero-eyebrow {
            font-family: var(--font-mono);
            font-size: 0.75rem;
            font-weight: 500;
            color: var(--accent);
            text-transform: uppercase;
            letter-spacing: 0.2em;
            margin-bottom: 1.5rem;
          }

          .hero-title {
            font-family: var(--font-display);
            font-size: clamp(2.25rem, 4vw, 3rem);
            font-weight: 400;
            line-height: 1.2;
            letter-spacing: -0.02em;
            margin-bottom: 1.25rem;
            color: var(--text);
          }

          .hero-title-accent {
            color: var(--accent);
            font-style: italic;
          }

          .hero-desc {
            font-size: 1rem;
            line-height: 1.7;
            color: var(--text-muted);
            max-width: 480px;
            margin-bottom: 2rem;
          }

          .hero-actions {
            display: flex;
            gap: 1rem;
            flex-wrap: wrap;
          }

          .hero-repl-wrapper {
            display: flex;
            justify-content: center;
            align-items: center;
          }

          /* Buttons */
          .btn {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.875rem 1.5rem;
            font-size: 0.9rem;
            font-weight: 600;
            font-family: var(--font-sans);
            text-decoration: none;
            border-radius: 8px;
            transition: all 0.2s;
            cursor: pointer;
            border: none;
          }

          .btn-primary {
            background: var(--accent);
            color: var(--bg);
          }

          .btn-primary:hover {
            filter: brightness(1.1);
            transform: translateY(-2px);
          }

          .btn-ghost {
            background: transparent;
            color: var(--text-muted);
            border: 1px solid var(--border-strong);
          }

          .btn-ghost:hover {
            background: var(--accent-dim);
            border-color: var(--accent);
            color: var(--text);
          }

          .btn-accent {
            background: transparent;
            color: var(--accent);
            border: 1px solid var(--accent);
          }

          .btn-accent:hover {
            background: var(--accent);
            color: var(--bg);
          }

          /* Hero Example Card */
          .hero-example {
            background: var(--bg-card);
            border: 1px solid var(--border-strong);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
          }

          .example-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.75rem 1.25rem;
            background: var(--bg-elevated);
            border-bottom: 1px solid var(--border);
          }

          .example-badge {
            font-family: var(--font-mono);
            font-size: 0.65rem;
            font-weight: 600;
            color: var(--green);
            text-transform: uppercase;
            letter-spacing: 0.1em;
            padding: 0.25rem 0.5rem;
            background: rgba(74, 222, 128, 0.1);
            border-radius: 4px;
          }

          .example-id {
            font-family: var(--font-mono);
            font-size: 0.75rem;
            color: var(--text-dim);
          }

          .example-code {
            padding: 1.25rem;
            margin: 0;
            font-family: var(--font-mono);
            font-size: 0.8rem;
            line-height: 1.6;
            color: var(--text-muted);
            background: transparent;
            overflow-x: auto;
          }

          .example-code code {
            color: var(--text-muted);
          }

          .example-footer {
            display: flex;
            gap: 1.5rem;
            padding: 0.75rem 1.25rem;
            background: var(--bg-elevated);
            border-top: 1px solid var(--border);
          }

          .example-stat {
            font-family: var(--font-mono);
            font-size: 0.7rem;
            color: var(--accent);
          }

          /* ═══════════════════════════════════════════════════════════════════
             SECTION: PROBLEM
          ═══════════════════════════════════════════════════════════════════ */
          .section-problem {
            position: relative;
            z-index: 10;
            padding: 8rem 2rem;
            background: linear-gradient(180deg, var(--bg) 0%, var(--bg-elevated) 100%);
          }

          .section-label {
            display: inline-block;
            font-family: var(--font-mono);
            font-size: 0.7rem;
            font-weight: 500;
            color: var(--accent);
            text-transform: uppercase;
            letter-spacing: 0.15em;
            padding: 0.5rem 1rem;
            background: var(--accent-dim);
            border-radius: 4px;
            margin-bottom: 1.5rem;
          }

          .problem-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4rem;
            align-items: center;
          }

          .problem-title {
            font-family: var(--font-display);
            font-size: 2.5rem;
            font-weight: 400;
            line-height: 1.2;
            margin-bottom: 1.5rem;
          }

          .problem-highlight {
            color: var(--red);
          }

          .problem-desc {
            font-size: 1.125rem;
            line-height: 1.7;
            color: var(--text-muted);
            margin-bottom: 1rem;
          }

          /* Amnesia Diagram */
          .amnesia-diagram {
            display: flex;
            flex-direction: column;
            gap: 1rem;
            padding: 2rem;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
          }

          .session {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 1rem 1.5rem;
            background: var(--bg-elevated);
            border-radius: 8px;
            border-left: 3px solid var(--text-dim);
          }

          .session-label {
            font-family: var(--font-mono);
            font-size: 0.75rem;
            color: var(--text-dim);
          }

          .session-discovery {
            font-size: 0.875rem;
            color: var(--text-muted);
          }

          .amnesia-arrow {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            color: var(--red);
            font-size: 0.75rem;
            font-family: var(--font-mono);
            opacity: 0.7;
          }

          /* ═══════════════════════════════════════════════════════════════════
             SECTION: SOLUTION
          ═══════════════════════════════════════════════════════════════════ */
          .section-solution {
            position: relative;
            z-index: 10;
            padding: 8rem 2rem;
            background: var(--bg-elevated);
          }

          .section-header {
            text-align: center;
            margin-bottom: 4rem;
          }

          .section-title {
            font-family: var(--font-display);
            font-size: 2.5rem;
            font-weight: 400;
            margin-bottom: 1rem;
          }

          .section-desc {
            font-size: 1.125rem;
            color: var(--text-muted);
            max-width: 600px;
            margin: 0 auto;
            line-height: 1.7;
          }

          /* Emergence Grid */
          .emergence-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 2rem;
            margin-bottom: 4rem;
          }

          .emergence-card {
            padding: 2.5rem;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            transition: all 0.3s;
          }

          .emergence-card:hover {
            border-color: var(--accent);
            transform: translateY(-4px);
          }

          .emergence-card-accent {
            border-color: var(--purple);
          }

          .emergence-card-accent:hover {
            border-color: var(--purple);
            box-shadow: 0 0 40px rgba(167, 139, 250, 0.1);
          }

          .emergence-icon {
            width: 48px;
            height: 48px;
            margin-bottom: 1.5rem;
          }

          .emergence-level {
            font-family: var(--font-mono);
            font-size: 0.7rem;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 0.1em;
          }

          .emergence-title {
            font-family: var(--font-display);
            font-size: 1.5rem;
            font-weight: 400;
            margin: 0.5rem 0 1rem;
          }

          .emergence-desc {
            font-size: 0.95rem;
            line-height: 1.7;
            color: var(--text-muted);
            margin-bottom: 1.5rem;
          }

          .emergence-desc strong {
            color: var(--accent);
          }

          .emergence-card-accent .emergence-desc strong {
            color: var(--purple);
          }

          .emergence-visual {
            height: 200px;
            background: var(--bg);
            border-radius: 8px;
            overflow: hidden;
          }

          /* Learning Loop */
          .learning-loop {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4rem;
            align-items: center;
            padding: 3rem;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
          }

          .loop-visual {
            height: 300px;
          }

          .loop-title {
            font-family: var(--font-display);
            font-size: 1.75rem;
            margin-bottom: 2rem;
          }

          .loop-item {
            display: flex;
            align-items: flex-start;
            gap: 1rem;
            margin-bottom: 1.5rem;
          }

          .loop-badge {
            font-family: var(--font-mono);
            font-size: 0.7rem;
            font-weight: 600;
            padding: 0.35rem 0.75rem;
            border-radius: 4px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            white-space: nowrap;
          }

          .loop-execution {
            background: rgba(255, 184, 111, 0.2);
            color: var(--accent);
            border: 1px solid rgba(255, 184, 111, 0.3);
          }

          .loop-adaptation {
            background: rgba(255, 184, 111, 0.1);
            color: var(--accent);
            border: 1px dashed rgba(255, 184, 111, 0.3);
          }

          .loop-meta {
            background: rgba(255, 184, 111, 0.05);
            color: var(--text-muted);
            border: 1px dotted rgba(255, 184, 111, 0.3);
          }

          .loop-item p {
            font-size: 0.95rem;
            color: var(--text-muted);
            line-height: 1.5;
          }

          /* ═══════════════════════════════════════════════════════════════════
             SECTION: MOAT
          ═══════════════════════════════════════════════════════════════════ */
          .section-moat {
            position: relative;
            z-index: 10;
            padding: 8rem 2rem;
            background: var(--bg);
          }

          /* Propagation Flow */
          .propagation-flow {
            display: flex;
            align-items: flex-start;
            justify-content: center;
            gap: 1rem;
            padding: 3rem 2rem;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
          }

          .flow-step {
            flex: 1;
            max-width: 220px;
            text-align: center;
            padding: 1.5rem;
          }

          .flow-step-highlight {
            background: var(--accent-dim);
            border-radius: 12px;
          }

          .flow-icon {
            width: 56px;
            height: 56px;
            margin: 0 auto 1rem;
            padding: 8px;
            background: var(--bg-elevated);
            border-radius: 12px;
            border: 1px solid var(--border);
          }

          .flow-icon svg {
            width: 100%;
            height: 100%;
          }

          .flow-step h4 {
            font-family: var(--font-display);
            font-size: 1.1rem;
            font-weight: 400;
            margin-bottom: 0.5rem;
            color: var(--text);
          }

          .flow-step p {
            font-size: 0.85rem;
            color: var(--text-muted);
            line-height: 1.5;
          }

          .flow-arrow {
            display: flex;
            align-items: center;
            padding-top: 2rem;
          }

          .flow-arrow svg {
            width: 40px;
            height: 20px;
          }

          /* ═══════════════════════════════════════════════════════════════════
             SECTION: TECH
          ═══════════════════════════════════════════════════════════════════ */
          .section-tech {
            position: relative;
            z-index: 10;
            padding: 8rem 2rem;
            background: var(--bg-elevated);
          }

          .tech-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 1.5rem;
            margin-bottom: 4rem;
          }

          .tech-card {
            padding: 2rem;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            transition: all 0.2s;
          }

          .tech-card:hover {
            border-color: var(--accent);
          }

          .tech-icon {
            height: 120px;
            margin-bottom: 1rem;
            border-radius: 8px;
            overflow: hidden;
            background: transparent;
          }

          .tech-icon-svg {
            width: 48px;
            height: 48px;
            margin-bottom: 1rem;
          }

          .tech-card h4 {
            font-family: var(--font-display);
            font-size: 1.125rem;
            font-weight: 400;
            margin-bottom: 0.5rem;
          }

          .tech-card p {
            font-size: 0.875rem;
            color: var(--text-muted);
            line-height: 1.6;
          }

          .tech-stats {
            display: flex;
            justify-content: center;
            gap: 4rem;
            padding-top: 3rem;
            border-top: 1px solid var(--border);
          }

          .stat {
            text-align: center;
          }

          .stat-value {
            display: block;
            font-family: var(--font-mono);
            font-size: 2.5rem;
            font-weight: 600;
            color: var(--accent);
            margin-bottom: 0.5rem;
          }

          .stat-label {
            font-size: 0.75rem;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 0.1em;
          }

          /* ═══════════════════════════════════════════════════════════════════
             SECTION: BLOG
          ═══════════════════════════════════════════════════════════════════ */
          .section-blog {
            position: relative;
            z-index: 10;
            padding: 8rem 2rem;
            background: var(--bg);
          }

          .blog-preview-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 2rem;
            margin-bottom: 3rem;
          }

          .blog-preview-card {
            padding: 2rem;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            transition: all 0.2s;
          }

          .blog-preview-card:hover {
            border-color: var(--accent);
            transform: translateY(-4px);
          }

          .blog-preview-meta {
            display: flex;
            align-items: center;
            gap: 1rem;
            margin-bottom: 1rem;
          }

          .blog-preview-category {
            font-family: var(--font-mono);
            font-size: 0.65rem;
            color: var(--accent);
            text-transform: uppercase;
            letter-spacing: 0.1em;
            padding: 0.2rem 0.6rem;
            background: var(--accent-dim);
            border-radius: 4px;
          }

          .blog-preview-date {
            font-size: 0.8rem;
            color: var(--text-dim);
          }

          .blog-preview-title {
            font-family: var(--font-display);
            font-size: 1.25rem;
            font-weight: 400;
            margin-bottom: 0.75rem;
          }

          .blog-preview-title a {
            color: var(--text);
            text-decoration: none;
          }

          .blog-preview-title a:hover {
            color: var(--accent);
          }

          .blog-preview-snippet {
            font-size: 0.9rem;
            color: var(--text-muted);
            line-height: 1.6;
            margin-bottom: 1rem;
          }

          .blog-preview-tags {
            display: flex;
            gap: 0.5rem;
          }

          .blog-preview-tag {
            font-family: var(--font-mono);
            font-size: 0.7rem;
            color: var(--text-dim);
          }

          .blog-preview-cta {
            text-align: center;
          }

          /* ═══════════════════════════════════════════════════════════════════
             SECTION: CTA
          ═══════════════════════════════════════════════════════════════════ */
          .section-cta {
            position: relative;
            z-index: 10;
            padding: 8rem 2rem;
            background: var(--bg);
            border-top: 1px solid var(--border);
          }

          .cta-content {
            text-align: center;
            max-width: 600px;
            margin: 0 auto;
          }

          .cta-content h2 {
            font-family: var(--font-display);
            font-size: 2.5rem;
            font-weight: 400;
            margin-bottom: 1rem;
          }

          .cta-content p {
            font-size: 1.125rem;
            color: var(--text-muted);
            margin-bottom: 2rem;
          }

          .cta-actions {
            display: flex;
            justify-content: center;
            gap: 1rem;
          }

          /* ═══════════════════════════════════════════════════════════════════
             FOOTER
          ═══════════════════════════════════════════════════════════════════ */
          .footer {
            position: relative;
            z-index: 10;
            padding: 2rem;
            background: var(--bg);
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
            transition: color 0.2s;
          }

          .footer-links a:hover {
            color: var(--accent);
          }

          /* ═══════════════════════════════════════════════════════════════════
             RESPONSIVE
          ═══════════════════════════════════════════════════════════════════ */
          @media (max-width: 1024px) {
            .tech-grid {
              grid-template-columns: repeat(2, 1fr);
            }
            .blog-preview-grid {
              grid-template-columns: repeat(2, 1fr);
            }
          }

          @media (max-width: 768px) {
            .header {
              padding: 1rem;
            }

            .logo-text {
              display: none;
            }

            .nav {
              gap: 0.75rem;
            }

            /* Hide desktop nav links on mobile - MobileMenu handles navigation */
            .nav-link:not(.nav-link-github) {
              display: none;
            }

            .hero {
              padding: 6rem 1.5rem 3rem;
            }

            .hero-grid {
              grid-template-columns: 1fr;
              gap: 2rem;
            }

            .hero-title {
              font-size: 2.5rem;
            }

            .hero-example {
              max-width: 100%;
            }

            .problem-grid,
            .emergence-grid,
            .learning-loop {
              grid-template-columns: 1fr;
              gap: 2rem;
            }

            .propagation-flow {
              flex-direction: column;
              align-items: center;
            }

            .flow-arrow {
              transform: rotate(90deg);
              padding: 0.5rem 0;
            }

            .tech-grid {
              grid-template-columns: 1fr;
            }

            .blog-preview-grid {
              grid-template-columns: 1fr;
            }

            .tech-stats {
              flex-direction: column;
              gap: 2rem;
            }

            .cta-actions {
              flex-direction: column;
            }

            .footer-inner {
              flex-direction: column;
              gap: 1.5rem;
              text-align: center;
            }

            .insight-card {
              margin-top: 2rem;
            }
          }

          /* ═══════════════════════════════════════════════════════════════════
             UTILITIES
          ═══════════════════════════════════════════════════════════════════ */
          html {
            scroll-behavior: smooth;
            scroll-padding-top: 80px;
          }

          ::selection {
            background: var(--accent);
            color: var(--bg);
          }
        `}
        </style>
      </div>
    </>
  );
}
