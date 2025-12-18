// @ts-nocheck
/**
 * Dynamic Open Graph Image Generator
 * Generates beautiful OG images for blog posts using Satori + Resvg
 *
 * Route: /blog/og/[slug].png
 */

import satori from "satori";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { getPost } from "../../../utils/posts.ts";

// Cache
let wasmInitialized = false;
let fontData: ArrayBuffer | null = null;
let fontDataBold: ArrayBuffer | null = null;

async function loadFonts() {
  if (!fontData) {
    fontData = await fetch(
      "https://cdn.jsdelivr.net/fontsource/fonts/geist-sans@latest/latin-600-normal.woff"
    ).then((res) => res.arrayBuffer());
  }
  if (!fontDataBold) {
    fontDataBold = await fetch(
      "https://cdn.jsdelivr.net/fontsource/fonts/geist-sans@latest/latin-700-normal.woff"
    ).then((res) => res.arrayBuffer());
  }
  return { fontData, fontDataBold };
}

export const handler = {
  async GET(ctx: any) {
    const { slug } = ctx.params;

    try {
      const post = await getPost(slug);
      if (!post) {
        return new Response("Post not found", { status: 404 });
      }

      // Load fonts
      const fonts = await loadFonts();

      // Initialize WASM if not done
      if (!wasmInitialized) {
        try {
          await initWasm(
            fetch("https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm")
          );
          wasmInitialized = true;
        } catch (e) {
          // Already initialized
          wasmInitialized = true;
        }
      }

      // Category colors
      const categoryColors: Record<string, string> = {
        architecture: "#8B5CF6",
        engineering: "#3B82F6",
        research: "#10B981",
        tutorial: "#F59E0B",
        announcement: "#EF4444",
        default: "#FFB86F",
      };

      const categoryColor = categoryColors[post.category.toLowerCase()] || categoryColors.default;
      const titleSize = post.title.length > 60 ? 42 : post.title.length > 40 ? 48 : 56;

      // Generate SVG with Satori
      const svg = await satori(
        {
          type: "div",
          props: {
            style: {
              height: "100%",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              backgroundColor: "#0a0a0c",
              padding: "50px",
            },
            children: [
              // Top bar
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "30px",
                  },
                  children: [
                    // Logo
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          alignItems: "center",
                        },
                        children: [
                          {
                            type: "div",
                            props: {
                              style: {
                                width: "36px",
                                height: "36px",
                                borderRadius: "8px",
                                backgroundColor: "#FFB86F",
                                marginRight: "12px",
                              },
                            },
                          },
                          {
                            type: "span",
                            props: {
                              style: {
                                fontSize: "24px",
                                fontWeight: 700,
                                color: "#ffffff",
                              },
                              children: "Casys PML",
                            },
                          },
                        ],
                      },
                    },
                    // Category badge
                    {
                      type: "div",
                      props: {
                        style: {
                          padding: "6px 16px",
                          borderRadius: "16px",
                          backgroundColor: categoryColor,
                          color: "#ffffff",
                          fontSize: "14px",
                          fontWeight: 600,
                          textTransform: "uppercase",
                        },
                        children: post.category,
                      },
                    },
                  ],
                },
              },
              // Title
              {
                type: "div",
                props: {
                  style: {
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                  },
                  children: [
                    {
                      type: "div",
                      props: {
                        style: {
                          fontSize: `${titleSize}px`,
                          fontWeight: 700,
                          color: "#ffffff",
                          lineHeight: 1.2,
                        },
                        children: post.title,
                      },
                    },
                  ],
                },
              },
              // Bottom bar
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    borderTop: "1px solid #333333",
                    paddingTop: "20px",
                  },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: {
                          fontSize: "18px",
                          color: "#888888",
                        },
                        children: `by ${post.author}`,
                      },
                    },
                    {
                      type: "span",
                      props: {
                        style: {
                          fontSize: "18px",
                          color: "#FFB86F",
                        },
                        children: post.date.toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          width: 1200,
          height: 630,
          fonts: [
            {
              name: "Geist",
              data: fonts.fontData!,
              weight: 600,
              style: "normal",
            },
            {
              name: "Geist",
              data: fonts.fontDataBold!,
              weight: 700,
              style: "normal",
            },
          ],
        }
      );

      // Convert SVG to PNG
      const resvg = new Resvg(svg, {
        fitTo: {
          mode: "width",
          value: 1200,
        },
      });
      const pngData = resvg.render();
      const pngBuffer = pngData.asPng();

      return new Response(pngBuffer, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400, s-maxage=604800",
        },
      });
    } catch (error) {
      console.error("OG image generation error:", error);
      return new Response(`Error generating image: ${error}`, { status: 500 });
    }
  },
};
