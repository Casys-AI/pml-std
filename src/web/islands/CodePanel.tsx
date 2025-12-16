/**
 * CodePanel Island - Bottom panel for displaying capability code snippets
 * Story 8.4: Code Panel Integration
 *
 * Displays:
 * - Capability name and description
 * - Syntax-highlighted code snippet
 * - Success rate, usage count, tools count stats
 * - Copy to clipboard functionality
 * - Tools list with clickable items
 *
 * @module web/islands/CodePanel
 */

import { useEffect, useState, useRef, useCallback } from "preact/hooks";
import { highlightCode, detectLanguage, syntaxHighlightStyles } from "../lib/syntax-highlight.ts";
import type { CapabilityData, ToolData } from "./CytoscapeGraph.tsx";

// Re-export for convenience
export type { CapabilityData, ToolData };

interface CodePanelProps {
  /** Capability data to display (null hides panel) */
  capability: CapabilityData | null;
  /** Tool data to display (null hides panel) */
  tool?: ToolData | null;
  /** Callback when panel is closed */
  onClose: () => void;
  /** Callback when a tool is clicked (highlights in graph) */
  onToolClick?: (toolId: string) => void;
  /** Server color mapping function */
  getServerColor?: (server: string) => string;
}

/**
 * Default server color palette (matches D3GraphVisualization)
 */
const DEFAULT_COLORS = [
  "#FFB86F", "#FF6B6B", "#4ECDC4", "#FFE66D",
  "#95E1D3", "#F38181", "#AA96DA", "#FCBAD3",
];

/**
 * Format relative time ("2h ago", "yesterday", etc.)
 */
function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "N/A";

  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * CodePanel Component
 *
 * Bottom panel that displays capability code and metadata.
 * Shows when a capability hull is clicked in the hypergraph view.
 */
// Min/Max heights for the panel
const MIN_PANEL_HEIGHT = 150;
const DEFAULT_MAX_HEIGHT = 800;
const DEFAULT_PANEL_HEIGHT = 300;

// Get max height dynamically (SSR-safe)
const getMaxPanelHeight = () =>
  typeof window !== "undefined" ? globalThis.innerHeight * 0.8 : DEFAULT_MAX_HEIGHT;

export default function CodePanel({
  capability,
  tool,
  onClose,
  onToolClick,
  getServerColor,
}: CodePanelProps) {
  const [copied, setCopied] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(true);

  // Resizable panel state
  const [panelHeight, setPanelHeight] = useState(() => {
    // Try to restore from localStorage
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("codePanelHeight");
      if (saved) {
        const height = parseInt(saved, 10);
        if (!isNaN(height) && height >= MIN_PANEL_HEIGHT && height <= getMaxPanelHeight()) {
          return height;
        }
      }
    }
    return DEFAULT_PANEL_HEIGHT;
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // Determine display mode
  const displayMode = tool ? "tool" : capability ? "capability" : null;

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      // Ctrl/Cmd+C to copy when panel is focused
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && capability?.codeSnippet) {
        // Only copy if no text is selected
        const selection = globalThis.getSelection();
        if (!selection || selection.toString().length === 0) {
          handleCopy();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, capability]);

  // Reset copied state when capability/tool changes
  useEffect(() => {
    setCopied(false);
  }, [capability?.id, tool?.id]);

  // Save panel height to localStorage when it changes
  useEffect(() => {
    if (typeof window !== "undefined" && panelHeight !== DEFAULT_PANEL_HEIGHT) {
      localStorage.setItem("codePanelHeight", String(panelHeight));
    }
  }, [panelHeight]);

  // Resize handlers
  const handleResizeStart = useCallback((e: MouseEvent | TouchEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startYRef.current = "touches" in e ? e.touches[0].clientY : e.clientY;
    startHeightRef.current = panelHeight;

    // Add cursor style to body during resize
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  }, [panelHeight]);

  const handleResizeMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isResizing) return;

    const currentY = "touches" in e ? e.touches[0].clientY : e.clientY;
    const deltaY = startYRef.current - currentY; // Negative = dragging down, Positive = dragging up
    const newHeight = Math.min(getMaxPanelHeight(), Math.max(MIN_PANEL_HEIGHT, startHeightRef.current + deltaY));

    setPanelHeight(newHeight);
  }, [isResizing]);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  // Global mouse/touch events for resize
  useEffect(() => {
    if (isResizing) {
      const handleMove = (e: MouseEvent | TouchEvent) => handleResizeMove(e);
      const handleEnd = () => handleResizeEnd();

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleEnd);
      document.addEventListener("touchmove", handleMove);
      document.addEventListener("touchend", handleEnd);

      return () => {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleEnd);
        document.removeEventListener("touchmove", handleMove);
        document.removeEventListener("touchend", handleEnd);
      };
    }
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  if (!capability && !tool) return null;

  // Get content to display (schema for tools, code for capabilities)
  const displayContent = tool
    ? JSON.stringify(tool.inputSchema || {}, null, 2)
    : capability?.codeSnippet || "";

  // Detect language based on mode
  const contentLanguage = tool ? "json" : detectLanguage(displayContent);

  /**
   * Copy content to clipboard
   */
  const handleCopy = async () => {
    if (!displayContent) return;

    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("[CodePanel] Failed to copy to clipboard:", error);
    }
  };

  /**
   * Get color for a server
   */
  const getColor = (server: string): string => {
    if (getServerColor) return getServerColor(server);
    // Fallback: hash-based color selection
    const hash = server.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return DEFAULT_COLORS[hash % DEFAULT_COLORS.length];
  };

  /**
   * Parse tool ID to extract server and tool name
   */
  const parseToolId = (toolId: string): { server: string; name: string } => {
    const match = toolId.match(/^([^:]+):(.+)$/);
    if (match) {
      return { server: match[1], name: match[2] };
    }
    return { server: "unknown", name: toolId };
  };

  // Split content into lines for line numbers
  const contentLines = displayContent?.split("\n") || [];

  return (
    <>
      {/* Inject syntax highlighting styles */}
      <style>{syntaxHighlightStyles}</style>

      {/* Slide-up animation */}
      <style>{`
        @keyframes slideUp {
          from {
            transform: translateY(100%);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
      `}</style>

      <div
        ref={panelRef}
        class="code-panel"
        role="region"
        aria-labelledby="code-panel-title"
        tabIndex={0}
        style={{
          width: "100%",
          height: `${panelHeight}px`,
          minHeight: `${MIN_PANEL_HEIGHT}px`,
          maxHeight: `${getMaxPanelHeight()}px`,
          background: "var(--bg-elevated, #12110f)",
          borderTop: "1px solid var(--border, rgba(255, 184, 111, 0.1))",
          display: "flex",
          flexDirection: "column",
          animation: isResizing ? "none" : "slideUp 300ms ease-out",
          position: "relative",
          zIndex: 100,
          outline: "none",
        }}
      >
        {/* Resize Handle */}
        <div
          onMouseDown={handleResizeStart as any}
          onTouchStart={handleResizeStart as any}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "8px",
            cursor: "ns-resize",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 10,
          }}
          title="Drag to resize"
        >
          {/* Visual grip indicator */}
          <div
            style={{
              width: "40px",
              height: "4px",
              borderRadius: "2px",
              background: isResizing
                ? "var(--accent, #FFB86F)"
                : "var(--border, rgba(255, 184, 111, 0.2))",
              transition: "background 0.15s ease",
            }}
            onMouseOver={(e) => {
              if (!isResizing) {
                e.currentTarget.style.background = "var(--accent, #FFB86F)";
              }
            }}
            onMouseOut={(e) => {
              if (!isResizing) {
                e.currentTarget.style.background = "var(--border, rgba(255, 184, 111, 0.2))";
              }
            }}
          />
        </div>
        {/* Header */}
        <div
          class="panel-header"
          style={{
            padding: "12px 16px",
            paddingTop: "16px", // Extra padding for resize handle
            borderBottom: "1px solid var(--border, rgba(255, 184, 111, 0.1))",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1, minWidth: 0 }}>
            {/* Title with type badge */}
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "4px",
                fontSize: "0.7rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                background: displayMode === "tool"
                  ? "var(--accent-dim, rgba(255, 184, 111, 0.1))"
                  : "rgba(34, 197, 94, 0.15)",
                color: displayMode === "tool"
                  ? "var(--accent, #FFB86F)"
                  : "var(--success, #22c55e)",
              }}
            >
              {displayMode === "tool" ? "Tool" : "Capability"}
            </span>
            <h3
              id="code-panel-title"
              style={{
                margin: 0,
                color: "var(--text, #f5f0ea)",
                fontSize: "1rem",
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={tool?.label || capability?.label}
            >
              {tool?.label || capability?.label}
            </h3>

            {/* Inline stats - different for tool vs capability */}
            <div
              style={{
                display: "flex",
                gap: "16px",
                fontSize: "0.8125rem",
                flexShrink: 0,
              }}
            >
              {displayMode === "tool" && tool && (
                <>
                  <span
                    style={{
                      color: getColor(tool.server),
                      fontWeight: 600,
                      padding: "2px 8px",
                      background: `${getColor(tool.server)}20`,
                      borderRadius: "4px",
                    }}
                    title="MCP Server"
                  >
                    {tool.server}
                  </span>
                  {tool.observedCount !== undefined && tool.observedCount > 0 && (
                    <span style={{ color: "var(--text-muted, #d5c3b5)" }} title="Observed usage">
                      {tool.observedCount}x used
                    </span>
                  )}
                  {tool.parentCapabilities && tool.parentCapabilities.length > 0 && (
                    <span style={{ color: "var(--text-dim, #8a8078)" }} title="Parent capabilities">
                      {tool.parentCapabilities.length} capabilities
                    </span>
                  )}
                </>
              )}
              {displayMode === "capability" && capability && (
                <>
                  <span
                    style={{
                      color: capability.successRate >= 0.8
                        ? "var(--success, #22c55e)"
                        : capability.successRate >= 0.5
                        ? "var(--warning, #f59e0b)"
                        : "var(--error, #ef4444)",
                      fontWeight: 600,
                    }}
                    title="Success rate"
                  >
                    {(capability.successRate * 100).toFixed(0)}%
                  </span>
                  <span style={{ color: "var(--text-muted, #d5c3b5)" }} title="Usage count">
                    {capability.usageCount}x
                  </span>
                  <span style={{ color: "var(--text-dim, #8a8078)" }} title="Tools count">
                    {capability.toolsCount} tools
                  </span>
                  {capability.communityId !== undefined && (
                    <span
                      style={{
                        color: "var(--accent, #FFB86F)",
                        fontSize: "0.75rem",
                        padding: "2px 6px",
                        background: "var(--accent-dim, rgba(255, 184, 111, 0.1))",
                        borderRadius: "4px",
                      }}
                      title="Community cluster"
                    >
                      C{capability.communityId}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Close button */}
          <button
            onClick={onClose}
            aria-label="Close panel"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-dim, #8a8078)",
              cursor: "pointer",
              padding: "4px 8px",
              fontSize: "1.25rem",
              lineHeight: 1,
              borderRadius: "4px",
              transition: "all 0.15s ease",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = "var(--bg-surface, #1a1816)";
              e.currentTarget.style.color = "var(--text, #f5f0ea)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-dim, #8a8078)";
            }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {/* Code Section */}
          <div
            style={{
              background: "var(--bg, #0a0908)",
              borderRadius: "8px",
              border: "1px solid var(--border, rgba(255, 184, 111, 0.1))",
              overflow: "hidden",
              flex: 1,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* Code header with line numbers toggle */}
            <div
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--border, rgba(255, 184, 111, 0.1))",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: "0.75rem",
                color: "var(--text-dim, #8a8078)",
              }}
            >
              <span style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {displayMode === "tool" ? "Input Schema (JSON)" : contentLanguage}
              </span>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={showLineNumbers}
                  onChange={(e) => setShowLineNumbers((e.target as HTMLInputElement).checked)}
                  style={{ accentColor: "var(--accent, #FFB86F)" }}
                />
                Line numbers
              </label>
            </div>

            {/* Code content */}
            <div
              style={{
                flex: 1,
                overflow: "auto",
                padding: "12px",
              }}
            >
              {displayContent ? (
                <pre
                  class="code-block"
                  style={{
                    margin: 0,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                    fontSize: "13px",
                    lineHeight: "1.5",
                    color: "var(--text, #f5f0ea)",
                    whiteSpace: "pre",
                    overflowX: "auto",
                  }}
                >
                  <code style={{ display: "table", width: "100%" }}>
                    {contentLines.map((line, index) => (
                      <div
                        key={index}
                        style={{
                          display: "table-row",
                        }}
                      >
                        {showLineNumbers && (
                          <span
                            style={{
                              display: "table-cell",
                              paddingRight: "16px",
                              textAlign: "right",
                              color: "var(--text-dim, #8a8078)",
                              userSelect: "none",
                              width: "1%",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {index + 1}
                          </span>
                        )}
                        <span style={{ display: "table-cell" }}>
                          {highlightCode(line || " ", contentLanguage)}
                        </span>
                      </div>
                    ))}
                  </code>
                </pre>
              ) : (
                <div
                  style={{
                    color: "var(--text-dim, #8a8078)",
                    fontStyle: "italic",
                    padding: "24px",
                    textAlign: "center",
                  }}
                >
                  {displayMode === "tool" ? "No input schema available" : "No code snippet available"}
                </div>
              )}
            </div>
          </div>

          {/* Actions + Info Row */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "16px",
              flexWrap: "wrap",
            }}
          >
            {/* Actions */}
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={handleCopy}
                disabled={!displayContent}
                style={{
                  padding: "8px 16px",
                  borderRadius: "8px",
                  border: "none",
                  background: copied
                    ? "var(--success, #22c55e)"
                    : "var(--accent, #FFB86F)",
                  color: "var(--bg, #0a0908)",
                  fontWeight: 600,
                  fontSize: "0.875rem",
                  cursor: displayContent ? "pointer" : "not-allowed",
                  opacity: displayContent ? 1 : 0.5,
                  transition: "all 0.15s ease",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {copied ? (
                  <>
                    <span>✓</span> Copied!
                  </>
                ) : (
                  <>
                    <span>📋</span> {displayMode === "tool" ? "Copy Schema" : "Copy Code"}
                  </>
                )}
              </button>

              {/* Run button - enabled for tools (future), disabled for capabilities */}
              <button
                disabled={displayMode !== "tool"}
                title={displayMode === "tool" ? "Run this tool (Coming soon)" : "Coming soon - Story 8.5"}
                style={{
                  padding: "8px 16px",
                  borderRadius: "8px",
                  border: displayMode === "tool"
                    ? "1px solid var(--accent, #FFB86F)"
                    : "1px solid var(--border, rgba(255, 184, 111, 0.1))",
                  background: displayMode === "tool"
                    ? "var(--accent-dim, rgba(255, 184, 111, 0.1))"
                    : "var(--bg-surface, #1a1816)",
                  color: displayMode === "tool"
                    ? "var(--accent, #FFB86F)"
                    : "var(--text-dim, #8a8078)",
                  fontWeight: 500,
                  fontSize: "0.875rem",
                  cursor: "not-allowed",
                  opacity: displayMode === "tool" ? 0.8 : 0.6,
                }}
              >
                ▶ {displayMode === "tool" ? "Run Tool" : "Try This"}
              </button>
            </div>

            {/* Tool description (for tool mode) */}
            {displayMode === "tool" && tool?.description && (
              <div
                style={{
                  flex: 1,
                  minWidth: "200px",
                  padding: "8px 12px",
                  background: "var(--bg-surface, #1a1816)",
                  borderRadius: "6px",
                  fontSize: "0.8125rem",
                  color: "var(--text-muted, #d5c3b5)",
                  lineHeight: "1.4",
                }}
              >
                {tool.description}
              </div>
            )}

            {/* Tools used (for capability mode) */}
            {displayMode === "capability" && capability?.toolIds && capability.toolIds.length > 0 && (
              <div
                style={{
                  display: "flex",
                  gap: "6px",
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-dim, #8a8078)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Tools:
                </span>
                {capability.toolIds.map((toolId) => {
                  const { server, name } = parseToolId(toolId);
                  const color = getColor(server);

                  return (
                    <button
                      key={toolId}
                      onClick={() => onToolClick?.(toolId)}
                      title={`${server}:${name} - Click to highlight in graph`}
                      style={{
                        padding: "4px 8px",
                        borderRadius: "4px",
                        border: `1px solid ${color}40`,
                        background: `${color}15`,
                        color: color,
                        fontSize: "0.75rem",
                        fontWeight: 500,
                        cursor: onToolClick ? "pointer" : "default",
                        transition: "all 0.15s ease",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                      onMouseOver={(e) => {
                        if (onToolClick) {
                          e.currentTarget.style.background = `${color}30`;
                          e.currentTarget.style.transform = "translateY(-1px)";
                        }
                      }}
                      onMouseOut={(e) => {
                        e.currentTarget.style.background = `${color}15`;
                        e.currentTarget.style.transform = "translateY(0)";
                      }}
                    >
                      <span
                        style={{
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: color,
                        }}
                      />
                      {name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Additional metadata */}
          {displayMode === "capability" && capability && (capability.lastUsedAt || capability.createdAt) && (
            <div
              style={{
                display: "flex",
                gap: "16px",
                fontSize: "0.75rem",
                color: "var(--text-dim, #8a8078)",
                paddingTop: "8px",
                borderTop: "1px solid var(--border, rgba(255, 184, 111, 0.1))",
              }}
            >
              {capability.lastUsedAt && (
                <span>Last used: {formatRelativeTime(capability.lastUsedAt)}</span>
              )}
              {capability.createdAt && (
                <span>Created: {formatRelativeTime(capability.createdAt)}</span>
              )}
            </div>
          )}
          {displayMode === "tool" && tool?.parentCapabilities && tool.parentCapabilities.length > 0 && (
            <div
              style={{
                display: "flex",
                gap: "8px",
                alignItems: "center",
                fontSize: "0.75rem",
                color: "var(--text-dim, #8a8078)",
                paddingTop: "8px",
                borderTop: "1px solid var(--border, rgba(255, 184, 111, 0.1))",
                flexWrap: "wrap",
              }}
            >
              <span style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Used by:
              </span>
              {tool.parentCapabilities.slice(0, 5).map((capId) => (
                <span
                  key={capId}
                  style={{
                    padding: "2px 6px",
                    borderRadius: "4px",
                    background: "rgba(34, 197, 94, 0.15)",
                    color: "var(--success, #22c55e)",
                    fontSize: "0.7rem",
                  }}
                >
                  {capId.replace("cap:", "")}
                </span>
              ))}
              {tool.parentCapabilities.length > 5 && (
                <span style={{ color: "var(--text-dim, #8a8078)" }}>
                  +{tool.parentCapabilities.length - 5} more
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
