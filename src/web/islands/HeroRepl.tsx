/**
 * HeroRepl - Interactive REPL component for the landing page hero
 * Prototype - DO NOT integrate yet
 */

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

// Simple syntax highlighter for the REPL
function highlightCode(code: string): preact.JSX.Element[] {
  const lines = code.split("\n");

  return lines.map((line, lineIndex) => {
    const elements: preact.JSX.Element[] = [];
    let remaining = line;
    let key = 0;

    // Process the line character by character with regex patterns
    while (remaining.length > 0) {
      // Comments
      const commentMatch = remaining.match(/^(\/\/.*)/);
      if (commentMatch) {
        elements.push(<span key={key++} class="hl-comment">{commentMatch[1]}</span>);
        remaining = remaining.slice(commentMatch[1].length);
        continue;
      }

      // Strings (double quotes)
      const doubleStringMatch = remaining.match(/^("[^"]*")/);
      if (doubleStringMatch) {
        elements.push(<span key={key++} class="hl-string">{doubleStringMatch[1]}</span>);
        remaining = remaining.slice(doubleStringMatch[1].length);
        continue;
      }

      // Strings (single quotes)
      const singleStringMatch = remaining.match(/^('[^']*')/);
      if (singleStringMatch) {
        elements.push(<span key={key++} class="hl-string">{singleStringMatch[1]}</span>);
        remaining = remaining.slice(singleStringMatch[1].length);
        continue;
      }

      // Template literals (backticks) - simplified
      const templateMatch = remaining.match(/^(`[^`]*`)/);
      if (templateMatch) {
        elements.push(<span key={key++} class="hl-string">{templateMatch[1]}</span>);
        remaining = remaining.slice(templateMatch[1].length);
        continue;
      }

      // Keywords
      const keywordMatch = remaining.match(/^(await|async|const|let|var|return|function|if|else|for|while|new|import|export|from|class|extends|type|interface)\b/);
      if (keywordMatch) {
        elements.push(<span key={key++} class="hl-keyword">{keywordMatch[1]}</span>);
        remaining = remaining.slice(keywordMatch[1].length);
        continue;
      }

      // Built-in objects/values
      const builtinMatch = remaining.match(/^(true|false|null|undefined|JSON|console|Math)\b/);
      if (builtinMatch) {
        elements.push(<span key={key++} class="hl-builtin">{builtinMatch[1]}</span>);
        remaining = remaining.slice(builtinMatch[1].length);
        continue;
      }

      // Numbers
      const numberMatch = remaining.match(/^(\d+\.?\d*)/);
      if (numberMatch) {
        elements.push(<span key={key++} class="hl-number">{numberMatch[1]}</span>);
        remaining = remaining.slice(numberMatch[1].length);
        continue;
      }

      // Property/method calls (word followed by . or :)
      const propMatch = remaining.match(/^(mcp|pml|fs|github|capability_captured|match|parameters|tools_used|intent|code|path|title|type|example|title_template|capability|similarity|success_rate|reuse_count|last_used)\b/);
      if (propMatch) {
        elements.push(<span key={key++} class="hl-property">{propMatch[1]}</span>);
        remaining = remaining.slice(propMatch[1].length);
        continue;
      }

      // Function calls
      const funcMatch = remaining.match(/^(execute_code|execute_dag|read_file|create_issue|parse)\b/);
      if (funcMatch) {
        elements.push(<span key={key++} class="hl-function">{funcMatch[1]}</span>);
        remaining = remaining.slice(funcMatch[1].length);
        continue;
      }

      // Level indicators (for compose tab)
      const levelMatch = remaining.match(/^(Level \d+:)/);
      if (levelMatch) {
        elements.push(<span key={key++} class="hl-level">{levelMatch[1]}</span>);
        remaining = remaining.slice(levelMatch[1].length);
        continue;
      }

      // Tree characters
      const treeMatch = remaining.match(/^([└├─│]+)/);
      if (treeMatch) {
        elements.push(<span key={key++} class="hl-tree">{treeMatch[1]}</span>);
        remaining = remaining.slice(treeMatch[1].length);
        continue;
      }

      // Default: take one character
      elements.push(<span key={key++}>{remaining[0]}</span>);
      remaining = remaining.slice(1);
    }

    // Add newline except for last line
    if (lineIndex < lines.length - 1) {
      elements.push(<span key={key++}>
</span>);
    }

    return <span key={lineIndex}>{elements}</span>;
  });
}

const tabs = [
  { id: "execute", label: "Execute", icon: "▶" },
  { id: "learn", label: "Learn", icon: "◈" },
  { id: "compose", label: "Compose", icon: "⬡" },
  { id: "reuse", label: "Reuse", icon: "↻" },
] as const;

type TabId = typeof tabs[number]["id"];

interface TabContent {
  code: string;
  output: string[];
  status: "success" | "info" | "learn";
}

const tabContents: Record<TabId, TabContent> = {
  execute: {
    code: `// First execution - agent writes code
await pml.execute_code({
  intent: "read config and create github issue",
  code: \`
    const cfg = await mcp.fs.read_file({ path: "config.json" });
    const { version } = JSON.parse(cfg);
    await mcp.github.create_issue({
      title: \\\`Release v\\\${version}\\\`
    });
  \`
})`,
    output: [
      "⚙ Sandbox: Deno 2.5 isolated",
      "⚙ Tools injected: mcp.fs, mcp.github",
      "✓ Execution successful",
      "",
      '→ Issue #142 created: "Release v2.1.0"',
    ],
    status: "success",
  },
  learn: {
    code: `// PML captures automatically (eager learning)
// No configuration needed - just observes success

capability_captured: {
  intent: "read config and create github issue",
  tools_used: ["fs.read_file", "github.create_issue"],

  // Schema inferred via AST parsing
  parameters: {
    path: { type: "string", example: "config.json" },
    title_template: { type: "string" }
  }
}`,
    output: [
      "◈ Capability captured on first success",
      "◈ Schema inferred: 2 parameters detected",
      "◈ Embedding generated for semantic search",
      "",
      "→ Ready for reuse (no manual config needed)",
    ],
    status: "learn",
  },
  compose: {
    code: `// PML detects composition automatically
// Tools → Capabilities → Meta-capabilities

Level 0: Tools (atomic)
  └─ fs.read_file, github.create_issue

Level 1: Capability (learned)
  └─ "config_to_issue" (contains both tools)

Level 2: Meta-capability (emergent)
  └─ "release_workflow"
     ├─ config_to_issue
     ├─ run_tests
     └─ deploy_to_prod`,
    output: [
      "⬡ Composition detected: 2 tools → 1 capability",
      "⬡ Dependency graph updated",
      "⬡ Transitive reliability: 0.94 × 0.98 = 0.92",
      "",
      "→ Hierarchical learning (SECI model)",
    ],
    status: "info",
  },
  reuse: {
    code: `// Later: similar intent triggers suggestion
await pml.execute_dag({
  intent: "update changelog and open PR"
})

// PML finds matching capability
match: {
  capability: "config_to_issue",
  similarity: 0.89,
  success_rate: 0.94,
  reuse_count: 12,
  last_used: "2h ago"
}`,
    output: [
      "↻ Found capability: config_to_issue (89% match)",
      "↻ Success rate: 94% over 12 executions",
      "↻ Reusing learned code (not regenerating)",
      "",
      "→ 5x faster than vanilla execution",
    ],
    status: "success",
  },
};

export function HeroRepl() {
  const activeTab = useSignal<TabId>("execute");
  const isTyping = useSignal(false);
  const displayedCode = useSignal("");
  const showOutput = useSignal(false);
  const currentOutputLine = useSignal(0);

  // Typing animation effect
  useEffect(() => {
    const content = tabContents[activeTab.value];
    const fullCode = content.code;

    isTyping.value = true;
    showOutput.value = false;
    currentOutputLine.value = 0;
    displayedCode.value = "";

    let charIndex = 0;
    const typeInterval = setInterval(() => {
      if (charIndex < fullCode.length) {
        displayedCode.value = fullCode.slice(0, charIndex + 1);
        charIndex++;
      } else {
        clearInterval(typeInterval);
        isTyping.value = false;

        // Start showing output after typing completes
        setTimeout(() => {
          showOutput.value = true;
          let lineIndex = 0;
          const outputInterval = setInterval(() => {
            if (lineIndex < content.output.length) {
              currentOutputLine.value = lineIndex + 1;
              lineIndex++;
            } else {
              clearInterval(outputInterval);
            }
          }, 120);
        }, 300);
      }
    }, 18);

    return () => clearInterval(typeInterval);
  }, [activeTab.value]);

  const content = tabContents[activeTab.value];

  return (
    <div class="hero-repl">
      {/* Window chrome */}
      <div class="repl-chrome">
        <div class="repl-dots">
          <span class="dot dot-red" />
          <span class="dot dot-yellow" />
          <span class="dot dot-green" />
        </div>
        <div class="repl-title">pml-repl</div>
        <div class="repl-badge">LIVE</div>
      </div>

      {/* Tabs */}
      <div class="repl-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            class={`repl-tab ${activeTab.value === tab.id ? "active" : ""}`}
            onClick={() => (activeTab.value = tab.id)}
          >
            <span class="tab-icon">{tab.icon}</span>
            <span class="tab-label">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Code area */}
      <div class="repl-body">
        <div class="repl-input">
          <span class="repl-prompt">›</span>
          <pre class="repl-code">
            <code>{highlightCode(displayedCode.value)}</code>
            {isTyping.value && <span class="cursor">▋</span>}
          </pre>
        </div>

        {/* Output area */}
        {showOutput.value && (
          <div class={`repl-output status-${content.status}`}>
            {content.output.slice(0, currentOutputLine.value).map((line, i) => (
              <div key={i} class="output-line">
                {line}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div class="repl-status">
        <span class="status-item">
          <span class="status-dot" />
          {isTyping.value ? "typing..." : showOutput.value ? "complete" : "ready"}
        </span>
        <span class="status-item">capabilities: 23 learned</span>
        <span class="status-item">reuse rate: 67%</span>
      </div>

      <style>{`
        .hero-repl {
          width: 100%;
          max-width: 580px;
          background: #0a0a0c;
          border: 1px solid rgba(255, 184, 111, 0.15);
          border-radius: 12px;
          overflow: hidden;
          font-family: 'Geist Mono', 'SF Mono', Consolas, monospace;
          box-shadow:
            0 0 0 1px rgba(255, 184, 111, 0.05),
            0 20px 50px rgba(0, 0, 0, 0.5),
            0 0 100px rgba(255, 184, 111, 0.03);
        }

        /* Window chrome */
        .repl-chrome {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          background: #0f0f12;
          border-bottom: 1px solid rgba(255, 184, 111, 0.08);
        }

        .repl-dots {
          display: flex;
          gap: 6px;
        }

        .dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
        }

        .dot-red { background: #ff5f57; }
        .dot-yellow { background: #febc2e; }
        .dot-green { background: #28c840; }

        .repl-title {
          flex: 1;
          font-size: 11px;
          color: #6b6560;
          letter-spacing: 0.05em;
        }

        .repl-badge {
          font-size: 9px;
          font-weight: 600;
          color: #28c840;
          background: rgba(40, 200, 64, 0.1);
          padding: 3px 8px;
          border-radius: 4px;
          letter-spacing: 0.1em;
          animation: pulse-glow 2s ease-in-out infinite;
        }

        @keyframes pulse-glow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }

        /* Tabs */
        .repl-tabs {
          display: flex;
          gap: 2px;
          padding: 8px 12px 0;
          background: #0c0c0e;
          border-bottom: 1px solid rgba(255, 184, 111, 0.08);
        }

        .repl-tab {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 10px 16px;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          color: #6b6560;
          font-family: inherit;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          letter-spacing: 0.02em;
        }

        .repl-tab:hover {
          color: #a8a29e;
          background: rgba(255, 184, 111, 0.03);
        }

        .repl-tab.active {
          color: #FFB86F;
          border-bottom-color: #FFB86F;
          background: rgba(255, 184, 111, 0.05);
        }

        .tab-icon {
          font-size: 10px;
          opacity: 0.7;
        }

        .repl-tab.active .tab-icon {
          opacity: 1;
        }

        /* Body */
        .repl-body {
          padding: 20px;
          min-height: 220px;
          background: linear-gradient(180deg, #0a0a0c 0%, #08080a 100%);
        }

        .repl-input {
          display: flex;
          gap: 12px;
        }

        .repl-prompt {
          color: #FFB86F;
          font-size: 14px;
          font-weight: 600;
          line-height: 1.6;
          user-select: none;
        }

        .repl-code {
          flex: 1;
          margin: 0;
          font-size: 12px;
          line-height: 1.6;
          color: #e0ddd8;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .repl-code code {
          color: inherit;
        }

        /* Syntax highlighting */
        .hl-comment {
          color: #6b6560;
          font-style: italic;
        }

        .hl-string {
          color: #a5d6a7;
        }

        .hl-keyword {
          color: #c792ea;
          font-weight: 500;
        }

        .hl-builtin {
          color: #82aaff;
        }

        .hl-number {
          color: #f78c6c;
        }

        .hl-property {
          color: #89ddff;
        }

        .hl-function {
          color: #ffcb6b;
        }

        .hl-level {
          color: #FFB86F;
          font-weight: 600;
        }

        .hl-tree {
          color: #6b6560;
        }

        .cursor {
          color: #FFB86F;
          animation: blink 1s step-end infinite;
          margin-left: 1px;
        }

        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }

        /* Output */
        .repl-output {
          margin-top: 20px;
          padding-top: 16px;
          border-top: 1px dashed rgba(255, 184, 111, 0.1);
        }

        .output-line {
          font-size: 11px;
          line-height: 1.8;
          color: #a8a29e;
          animation: fade-in 0.15s ease-out;
        }

        .output-line:empty {
          height: 12px;
        }

        .status-success .output-line {
          color: #a8a29e;
        }

        .status-info .output-line {
          color: #8b9dc3;
        }

        .status-learn .output-line {
          color: #fbbf24;
        }

        .status-learn .output-line:first-child {
          color: #f59e0b;
        }

        /* Highlight specific output patterns */
        .output-line:first-child {
          color: #4ade80;
        }

        .repl-output.status-info .output-line:first-child {
          color: #a78bfa;
        }

        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        /* Status bar */
        .repl-status {
          display: flex;
          gap: 20px;
          padding: 10px 16px;
          background: #0c0c0e;
          border-top: 1px solid rgba(255, 184, 111, 0.08);
        }

        .status-item {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 10px;
          color: #4a4540;
          letter-spacing: 0.03em;
        }

        .status-dot {
          width: 6px;
          height: 6px;
          background: #4ade80;
          border-radius: 50%;
          box-shadow: 0 0 8px rgba(74, 222, 128, 0.4);
        }

        /* Responsive */
        @media (max-width: 640px) {
          .hero-repl {
            max-width: 100%;
          }

          .repl-tab {
            padding: 8px 12px;
          }

          .tab-label {
            display: none;
          }

          .tab-icon {
            font-size: 14px;
          }

          .repl-body {
            padding: 16px;
            min-height: 200px;
          }

          .repl-code {
            font-size: 11px;
          }

          .status-item:not(:first-child) {
            display: none;
          }
        }
      `}</style>
    </div>
  );
}

export default HeroRepl;
