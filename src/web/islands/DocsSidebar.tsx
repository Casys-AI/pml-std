import { useSignal } from "@preact/signals";
import type { DocNavItem } from "../utils/docs.ts";

interface DocsSidebarProps {
  navigation: DocNavItem[];
  currentPath: string;
}

function NavItem({
  item,
  currentPath,
  depth = 0,
  expandedSections,
  toggleSection,
}: {
  item: DocNavItem;
  currentPath: string;
  depth?: number;
  expandedSections: Set<string>;
  toggleSection: (href: string) => void;
}) {
  const isActive = currentPath === item.href;
  const isParentActive = currentPath.startsWith(item.href + "/");
  const hasChildren = item.children && item.children.length > 0;
  const isExpanded = expandedSections.has(item.href) || isActive || isParentActive;

  const handleClick = (e: Event) => {
    if (hasChildren) {
      e.preventDefault();
      toggleSection(item.href);
      // Navigate to the section index page
      globalThis.location.href = item.href;
    }
  };

  const handleArrowClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSection(item.href);
  };

  return (
    <li class="nav-item">
      <a
        href={item.href}
        class={`nav-link ${isActive ? "nav-link-active" : ""} ${
          isParentActive ? "nav-link-parent" : ""
        }`}
        style={{ paddingLeft: `${1.5 + depth * 1}rem` }}
        onClick={hasChildren ? handleClick : undefined}
      >
        {hasChildren && (
          <span
            class={`nav-arrow ${isExpanded ? "nav-arrow-expanded" : ""}`}
            onClick={handleArrowClick}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </span>
        )}
        <span class="nav-link-text">{item.title}</span>
      </a>
      {hasChildren && isExpanded && (
        <ul class="nav-children">
          {item.children!.map((child) => (
            <NavItem
              key={child.slug}
              item={child}
              currentPath={currentPath}
              depth={depth + 1}
              expandedSections={expandedSections}
              toggleSection={toggleSection}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function DocsSidebar({ navigation, currentPath }: DocsSidebarProps) {
  // Initialize expanded sections based on current path
  const getInitialExpanded = (): Set<string> => {
    const expanded = new Set<string>();
    // Expand all parent sections of current path
    const parts = currentPath.split("/").filter(Boolean);
    let path = "";
    for (const part of parts) {
      path += "/" + part;
      expanded.add(path);
    }
    return expanded;
  };

  const expandedSections = useSignal<Set<string>>(getInitialExpanded());

  const toggleSection = (href: string) => {
    const newExpanded = new Set(expandedSections.value);
    if (newExpanded.has(href)) {
      newExpanded.delete(href);
    } else {
      newExpanded.add(href);
    }
    expandedSections.value = newExpanded;
  };

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        <a href="/docs" class="sidebar-title">Documentation</a>
      </div>
      <nav class="sidebar-nav">
        <ul class="nav-list">
          {navigation.map((item) => (
            <NavItem
              key={item.slug}
              item={item}
              currentPath={currentPath}
              expandedSections={expandedSections.value}
              toggleSection={toggleSection}
            />
          ))}
        </ul>
      </nav>

      <style>
        {`
        .sidebar {
          width: var(--sidebar-width, 280px);
          flex-shrink: 0;
          border-right: 1px solid var(--border, rgba(255, 184, 111, 0.08));
          background: var(--bg-elevated, #0f0f12);
          position: sticky;
          top: 65px;
          height: calc(100vh - 65px);
          overflow-y: auto;
        }

        .sidebar-header {
          padding: 1.5rem;
          border-bottom: 1px solid var(--border, rgba(255, 184, 111, 0.08));
        }

        .sidebar-title {
          font-family: var(--font-display, 'Instrument Serif', Georgia, serif);
          font-size: 1.25rem;
          color: var(--text, #f0ede8);
          text-decoration: none;
        }

        .sidebar-title:hover {
          color: var(--accent, #FFB86F);
        }

        .sidebar-nav {
          padding: 1rem 0;
        }

        .nav-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }

        .nav-item {
          margin: 0;
        }

        .nav-children {
          list-style: none;
          margin: 0;
          padding: 0;
        }

        .sidebar-nav .nav-link {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.6rem 1.5rem;
          color: var(--text-muted, #a8a29e);
          text-decoration: none;
          font-size: 0.875rem;
          transition: all 0.15s ease;
          border-left: 2px solid transparent;
          cursor: pointer;
        }

        .sidebar-nav .nav-link:hover {
          color: var(--text, #f0ede8);
          background: var(--accent-dim, rgba(255, 184, 111, 0.1));
        }

        .sidebar-nav .nav-link-active {
          color: var(--accent, #FFB86F);
          background: var(--accent-dim, rgba(255, 184, 111, 0.1));
          border-left-color: var(--accent, #FFB86F);
        }

        .sidebar-nav .nav-link-parent {
          color: var(--text, #f0ede8);
        }

        .nav-arrow {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          transition: transform 0.2s ease;
          flex-shrink: 0;
          border-radius: 3px;
        }

        .nav-arrow:hover {
          background: var(--accent-dim, rgba(255, 184, 111, 0.1));
        }

        .nav-arrow-expanded {
          transform: rotate(90deg);
        }

        .nav-link-text {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        @media (max-width: 1024px) {
          .sidebar {
            display: none;
          }
        }
        `}
      </style>
    </aside>
  );
}
