/**
 * MobileMenu - Elegant slide-out navigation for mobile devices
 * Design: Matches the Casys PML dark theme with amber accent
 */

import { useSignal } from "@preact/signals";

interface NavLink {
  href: string;
  label: string;
  isExternal?: boolean;
}

const navLinks: NavLink[] = [
  { href: "#problem", label: "Why" },
  { href: "#how", label: "How" },
  { href: "#tech", label: "Tech" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
  { href: "https://github.com/Casys-AI/casys-pml", label: "GitHub", isExternal: true },
];

export default function MobileMenu() {
  const isOpen = useSignal(false);

  const toggleMenu = () => {
    isOpen.value = !isOpen.value;
    // Prevent body scroll when menu is open
    document.body.style.overflow = isOpen.value ? "hidden" : "";
  };

  const closeMenu = () => {
    isOpen.value = false;
    document.body.style.overflow = "";
  };

  return (
    <>
      {/* Hamburger Button */}
      <button
        type="button"
        onClick={toggleMenu}
        class="mobile-menu-trigger"
        aria-label={isOpen.value ? "Close menu" : "Open menu"}
        aria-expanded={isOpen.value}
      >
        <div class={`hamburger ${isOpen.value ? "hamburger--open" : ""}`}>
          <span class="hamburger-line hamburger-line--1" />
          <span class="hamburger-line hamburger-line--2" />
          <span class="hamburger-line hamburger-line--3" />
        </div>
      </button>

      {/* Backdrop */}
      <div
        class={`mobile-menu-backdrop ${isOpen.value ? "mobile-menu-backdrop--visible" : ""}`}
        onClick={closeMenu}
        aria-hidden="true"
      />

      {/* Slide-out Drawer */}
      <nav
        class={`mobile-menu-drawer ${isOpen.value ? "mobile-menu-drawer--open" : ""}`}
        aria-hidden={!isOpen.value}
      >
        {/* Drawer Header */}
        <div class="mobile-menu-header">
          <span class="mobile-menu-logo">Casys PML</span>
          <button
            type="button"
            onClick={closeMenu}
            class="mobile-menu-close"
            aria-label="Close menu"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Navigation Links */}
        <ul class="mobile-menu-links">
          {navLinks.map((link, index) => (
            <li
              key={link.href}
              class="mobile-menu-item"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <a
                href={link.href}
                class="mobile-menu-link"
                onClick={closeMenu}
                target={link.isExternal ? "_blank" : undefined}
                rel={link.isExternal ? "noopener noreferrer" : undefined}
              >
                <span class="mobile-menu-link-text">{link.label}</span>
                {link.isExternal && (
                  <svg
                    class="mobile-menu-external-icon"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
                  </svg>
                )}
              </a>
            </li>
          ))}
        </ul>

        {/* Decorative Footer */}
        <div class="mobile-menu-footer">
          <div class="mobile-menu-tagline">Procedural Memory Layer</div>
          <div class="mobile-menu-glow" />
        </div>
      </nav>

      <style>{`
        /* ═══════════════════════════════════════════════════════════════════
           MOBILE MENU - Only visible on mobile (< 768px)
        ═══════════════════════════════════════════════════════════════════ */

        .mobile-menu-trigger {
          display: none;
          align-items: center;
          justify-content: center;
          width: 44px;
          height: 44px;
          padding: 0;
          background: transparent;
          border: 1px solid rgba(255, 184, 111, 0.15);
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s ease;
          -webkit-tap-highlight-color: transparent;
        }

        .mobile-menu-trigger:hover,
        .mobile-menu-trigger:focus {
          background: rgba(255, 184, 111, 0.08);
          border-color: rgba(255, 184, 111, 0.3);
          outline: none;
        }

        .mobile-menu-trigger:active {
          transform: scale(0.95);
        }

        /* Hamburger Icon */
        .hamburger {
          position: relative;
          width: 22px;
          height: 16px;
        }

        .hamburger-line {
          position: absolute;
          left: 0;
          width: 100%;
          height: 2px;
          background: #FFB86F;
          border-radius: 2px;
          transition: all 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
        }

        .hamburger-line--1 { top: 0; }
        .hamburger-line--2 { top: 50%; transform: translateY(-50%); }
        .hamburger-line--3 { bottom: 0; }

        /* Hamburger → X animation */
        .hamburger--open .hamburger-line--1 {
          top: 50%;
          transform: translateY(-50%) rotate(45deg);
        }

        .hamburger--open .hamburger-line--2 {
          opacity: 0;
          transform: translateX(-10px);
        }

        .hamburger--open .hamburger-line--3 {
          bottom: 50%;
          transform: translateY(50%) rotate(-45deg);
        }

        /* Backdrop */
        .mobile-menu-backdrop {
          position: fixed;
          inset: 0;
          z-index: 998;
          background: rgba(8, 8, 10, 0.85);
          backdrop-filter: blur(8px);
          opacity: 0;
          visibility: hidden;
          transition: opacity 0.3s ease, visibility 0.3s ease;
        }

        .mobile-menu-backdrop--visible {
          opacity: 1;
          visibility: visible;
        }

        /* Drawer */
        .mobile-menu-drawer {
          position: fixed;
          top: 0;
          right: 0;
          z-index: 999;
          width: min(320px, 85vw);
          height: 100vh;
          height: 100dvh;
          display: flex;
          flex-direction: column;
          background: linear-gradient(
            165deg,
            #0f0f12 0%,
            #08080a 50%,
            #0a0908 100%
          );
          border-left: 1px solid rgba(255, 184, 111, 0.12);
          box-shadow: -20px 0 60px rgba(0, 0, 0, 0.5);
          transform: translateX(100%);
          transition: transform 0.4s cubic-bezier(0.32, 0.72, 0, 1);
          overflow: hidden;
        }

        .mobile-menu-drawer--open {
          transform: translateX(0);
        }

        /* Drawer Header */
        .mobile-menu-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1.25rem 1.5rem;
          border-bottom: 1px solid rgba(255, 184, 111, 0.08);
        }

        .mobile-menu-logo {
          font-family: 'Instrument Serif', Georgia, serif;
          font-size: 1.5rem;
          font-weight: 400;
          color: #FFB86F;
          letter-spacing: -0.02em;
        }

        .mobile-menu-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          padding: 0;
          background: rgba(255, 184, 111, 0.05);
          border: 1px solid rgba(255, 184, 111, 0.1);
          border-radius: 10px;
          color: #a8a29e;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .mobile-menu-close:hover,
        .mobile-menu-close:focus {
          background: rgba(255, 184, 111, 0.1);
          border-color: rgba(255, 184, 111, 0.2);
          color: #FFB86F;
          outline: none;
        }

        /* Navigation Links */
        .mobile-menu-links {
          flex: 1;
          list-style: none;
          margin: 0;
          padding: 1.5rem 0;
          overflow-y: auto;
        }

        .mobile-menu-item {
          opacity: 0;
          transform: translateX(20px);
        }

        .mobile-menu-drawer--open .mobile-menu-item {
          animation: slideIn 0.4s cubic-bezier(0.32, 0.72, 0, 1) forwards;
        }

        @keyframes slideIn {
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        .mobile-menu-link {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1rem 1.5rem;
          text-decoration: none;
          color: #f0ede8;
          font-family: 'Geist', -apple-system, system-ui, sans-serif;
          font-size: 1.125rem;
          font-weight: 500;
          letter-spacing: 0.01em;
          transition: all 0.2s ease;
          position: relative;
        }

        .mobile-menu-link::before {
          content: '';
          position: absolute;
          left: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 3px;
          height: 0;
          background: #FFB86F;
          border-radius: 0 2px 2px 0;
          transition: height 0.2s ease;
        }

        .mobile-menu-link:hover,
        .mobile-menu-link:focus {
          background: rgba(255, 184, 111, 0.05);
          color: #FFB86F;
          padding-left: 2rem;
          outline: none;
        }

        .mobile-menu-link:hover::before,
        .mobile-menu-link:focus::before {
          height: 60%;
        }

        .mobile-menu-link-text {
          position: relative;
        }

        .mobile-menu-external-icon {
          opacity: 0.5;
          transition: opacity 0.2s ease;
        }

        .mobile-menu-link:hover .mobile-menu-external-icon {
          opacity: 1;
        }

        /* Footer */
        .mobile-menu-footer {
          position: relative;
          padding: 1.5rem;
          border-top: 1px solid rgba(255, 184, 111, 0.08);
          overflow: hidden;
        }

        .mobile-menu-tagline {
          font-family: 'Geist Mono', monospace;
          font-size: 0.7rem;
          color: #6b6560;
          text-transform: uppercase;
          letter-spacing: 0.15em;
        }

        .mobile-menu-glow {
          position: absolute;
          bottom: -50px;
          right: -50px;
          width: 150px;
          height: 150px;
          background: radial-gradient(
            circle,
            rgba(255, 184, 111, 0.15) 0%,
            transparent 70%
          );
          pointer-events: none;
        }

        /* Show only on mobile */
        @media (max-width: 768px) {
          .mobile-menu-trigger {
            display: flex;
          }
        }

        /* Reduced motion preference */
        @media (prefers-reduced-motion: reduce) {
          .mobile-menu-drawer,
          .mobile-menu-backdrop,
          .hamburger-line,
          .mobile-menu-item,
          .mobile-menu-link {
            transition: none;
            animation: none;
          }

          .mobile-menu-item {
            opacity: 1;
            transform: none;
          }
        }
      `}</style>
    </>
  );
}
