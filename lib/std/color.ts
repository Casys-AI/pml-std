/**
 * Color manipulation tools
 *
 * Convert between color formats, calculate contrast, generate palettes.
 *
 * Inspired by:
 * - IT-Tools MCP: https://github.com/wrenchpilot/it-tools-mcp
 *
 * @module lib/std/color
 */

import type { MiniTool } from "./types.ts";

// Type definitions
interface RGB {
  r: number;
  g: number;
  b: number;
}
interface HSL {
  h: number;
  s: number;
  l: number;
}

// Helper functions
const hexToRgb = (hex: string): RGB | null => {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) {
    h = h.split("").map((c) => c + c).join("");
  }
  if (!/^[0-9A-Fa-f]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
};

const rgbToHex = (r: number, g: number, b: number): string => {
  const toHex = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

const rgbToHsl = (r: number, g: number, b: number): HSL => {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const l = (max + min) / 2;
  let h = 0, s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rNorm:
        h = ((gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)) / 6;
        break;
      case gNorm:
        h = ((bNorm - rNorm) / d + 2) / 6;
        break;
      case bNorm:
        h = ((rNorm - gNorm) / d + 4) / 6;
        break;
    }
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
};

const hslToRgb = (h: number, s: number, l: number): RGB => {
  const hNorm = h / 360;
  const sNorm = s / 100;
  const lNorm = l / 100;

  if (sNorm === 0) {
    const gray = Math.round(lNorm * 255);
    return { r: gray, g: gray, b: gray };
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = lNorm < 0.5 ? lNorm * (1 + sNorm) : lNorm + sNorm - lNorm * sNorm;
  const p = 2 * lNorm - q;

  return {
    r: Math.round(hue2rgb(p, q, hNorm + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hNorm) * 255),
    b: Math.round(hue2rgb(p, q, hNorm - 1 / 3) * 255),
  };
};

// Named colors
const namedColors: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00ff00",
  aqua: "#00ffff",
  teal: "#008080",
  navy: "#000080",
  fuchsia: "#ff00ff",
  purple: "#800080",
  orange: "#ffa500",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  coral: "#ff7f50",
  gold: "#ffd700",
  indigo: "#4b0082",
};

export const colorTools: MiniTool[] = [
  {
    name: "color_hex_to_rgb",
    description:
      "Convert hex color code to RGB values. Parse #RRGGBB or #RGB format to red, green, blue components (0-255). Use for color manipulation, CSS processing, or design tools. Keywords: hex to RGB, color convert, parse hex, hex color, RGB values, color code.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        hex: { type: "string", description: "Hex color (e.g., '#ff5733' or 'ff5733')" },
      },
      required: ["hex"],
    },
    handler: ({ hex }) => {
      const rgb = hexToRgb(hex as string);
      if (!rgb) throw new Error(`Invalid hex color: ${hex}`);
      return { ...rgb, css: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` };
    },
  },
  {
    name: "color_rgb_to_hex",
    description:
      "Convert RGB values to hex color code. Transform red, green, blue components to #RRGGBB format for CSS or design. Use for color formatting, CSS generation, or palette export. Keywords: RGB to hex, color convert, hex color, generate hex, color code, format color.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        r: { type: "number", description: "Red (0-255)" },
        g: { type: "number", description: "Green (0-255)" },
        b: { type: "number", description: "Blue (0-255)" },
      },
      required: ["r", "g", "b"],
    },
    handler: ({ r, g, b }) => {
      const hex = rgbToHex(r as number, g as number, b as number);
      return { hex, hexUpper: hex.toUpperCase() };
    },
  },
  {
    name: "color_rgb_to_hsl",
    description:
      "Convert RGB to HSL (Hue, Saturation, Lightness). Transform RGB color model to HSL for easier color manipulation and adjustment. Use for color adjustments, theme generation, or color theory. Keywords: RGB to HSL, color convert, HSL color, hue saturation, color model, transform color.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        r: { type: "number", description: "Red (0-255)" },
        g: { type: "number", description: "Green (0-255)" },
        b: { type: "number", description: "Blue (0-255)" },
      },
      required: ["r", "g", "b"],
    },
    handler: ({ r, g, b }) => {
      const hsl = rgbToHsl(r as number, g as number, b as number);
      return { ...hsl, css: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)` };
    },
  },
  {
    name: "color_hsl_to_rgb",
    description:
      "Convert HSL to RGB values. Transform Hue (0-360), Saturation (0-100), Lightness (0-100) to RGB. Use for generating colors from HSL adjustments or color wheel operations. Keywords: HSL to RGB, color convert, RGB from HSL, hue to RGB, color transform.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        h: { type: "number", description: "Hue (0-360)" },
        s: { type: "number", description: "Saturation (0-100)" },
        l: { type: "number", description: "Lightness (0-100)" },
      },
      required: ["h", "s", "l"],
    },
    handler: ({ h, s, l }) => {
      const rgb = hslToRgb(h as number, s as number, l as number);
      return {
        ...rgb,
        hex: rgbToHex(rgb.r, rgb.g, rgb.b),
        css: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
      };
    },
  },
  {
    name: "color_rgb_to_hsv",
    description:
      "Convert RGB to HSV (Hue, Saturation, Value). Transform RGB to HSV for color picker interfaces or brightness adjustments. Use for color pickers, image processing, or color matching. Keywords: RGB to HSV, HSB, color convert, value brightness, color picker, saturation.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        r: { type: "number", description: "Red (0-255)" },
        g: { type: "number", description: "Green (0-255)" },
        b: { type: "number", description: "Blue (0-255)" },
      },
      required: ["r", "g", "b"],
    },
    handler: ({ r, g, b }) => {
      const rNorm = (r as number) / 255;
      const gNorm = (g as number) / 255;
      const bNorm = (b as number) / 255;
      const max = Math.max(rNorm, gNorm, bNorm);
      const min = Math.min(rNorm, gNorm, bNorm);
      const v = max;
      const d = max - min;
      const s = max === 0 ? 0 : d / max;
      let h = 0;

      if (max !== min) {
        if (max === rNorm) h = ((gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)) / 6;
        else if (max === gNorm) h = ((bNorm - rNorm) / d + 2) / 6;
        else h = ((rNorm - gNorm) / d + 4) / 6;
      }

      return { h: Math.round(h * 360), s: Math.round(s * 100), v: Math.round(v * 100) };
    },
  },
  {
    name: "color_hsv_to_rgb",
    description:
      "Convert HSV to RGB values. Transform Hue, Saturation, Value (Brightness) to RGB. Use for color picker output, HSB color handling, or brightness-based color generation. Keywords: HSV to RGB, HSB to RGB, color convert, brightness to RGB, color picker output.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        h: { type: "number", description: "Hue (0-360)" },
        s: { type: "number", description: "Saturation (0-100)" },
        v: { type: "number", description: "Value/Brightness (0-100)" },
      },
      required: ["h", "s", "v"],
    },
    handler: ({ h, s, v }) => {
      const hNorm = (h as number) / 360;
      const sNorm = (s as number) / 100;
      const vNorm = (v as number) / 100;

      const i = Math.floor(hNorm * 6);
      const f = hNorm * 6 - i;
      const p = vNorm * (1 - sNorm);
      const q = vNorm * (1 - f * sNorm);
      const t = vNorm * (1 - (1 - f) * sNorm);

      let r = 0, g = 0, b = 0;
      switch (i % 6) {
        case 0:
          r = vNorm;
          g = t;
          b = p;
          break;
        case 1:
          r = q;
          g = vNorm;
          b = p;
          break;
        case 2:
          r = p;
          g = vNorm;
          b = t;
          break;
        case 3:
          r = p;
          g = q;
          b = vNorm;
          break;
        case 4:
          r = t;
          g = p;
          b = vNorm;
          break;
        case 5:
          r = vNorm;
          g = p;
          b = q;
          break;
      }

      const rgb = { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
      return { ...rgb, hex: rgbToHex(rgb.r, rgb.g, rgb.b) };
    },
  },
  {
    name: "color_rgb_to_cmyk",
    description:
      "Convert RGB to CMYK (Cyan, Magenta, Yellow, Key/Black). Transform screen colors to print color model. Use for print design, color proofing, or prepress work. Keywords: RGB to CMYK, print color, color convert, cyan magenta, screen to print, prepress.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        r: { type: "number", description: "Red (0-255)" },
        g: { type: "number", description: "Green (0-255)" },
        b: { type: "number", description: "Blue (0-255)" },
      },
      required: ["r", "g", "b"],
    },
    handler: ({ r, g, b }) => {
      const rNorm = (r as number) / 255;
      const gNorm = (g as number) / 255;
      const bNorm = (b as number) / 255;
      const k = 1 - Math.max(rNorm, gNorm, bNorm);

      if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };

      return {
        c: Math.round(((1 - rNorm - k) / (1 - k)) * 100),
        m: Math.round(((1 - gNorm - k) / (1 - k)) * 100),
        y: Math.round(((1 - bNorm - k) / (1 - k)) * 100),
        k: Math.round(k * 100),
      };
    },
  },
  {
    name: "color_cmyk_to_rgb",
    description:
      "Convert CMYK to RGB values. Transform print colors (Cyan, Magenta, Yellow, Key) to screen RGB. Use for importing print colors, design conversion, or color matching. Keywords: CMYK to RGB, print to screen, color convert, cyan magenta, import print.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        c: { type: "number", description: "Cyan (0-100)" },
        m: { type: "number", description: "Magenta (0-100)" },
        y: { type: "number", description: "Yellow (0-100)" },
        k: { type: "number", description: "Key/Black (0-100)" },
      },
      required: ["c", "m", "y", "k"],
    },
    handler: ({ c, m, y, k }) => {
      const cNorm = (c as number) / 100;
      const mNorm = (m as number) / 100;
      const yNorm = (y as number) / 100;
      const kNorm = (k as number) / 100;

      const rgb = {
        r: Math.round(255 * (1 - cNorm) * (1 - kNorm)),
        g: Math.round(255 * (1 - mNorm) * (1 - kNorm)),
        b: Math.round(255 * (1 - yNorm) * (1 - kNorm)),
      };
      return { ...rgb, hex: rgbToHex(rgb.r, rgb.g, rgb.b) };
    },
  },
  {
    name: "color_parse",
    description:
      "Parse any color format to RGB values. Accepts hex (#fff, #ffffff), rgb(), hsl(), named colors. Universal color input handler. Use for accepting user color input or normalizing color formats. Keywords: parse color, color input, any format, named color, detect format, universal color.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        color: { type: "string", description: "Color in any format (hex, rgb, hsl, name)" },
      },
      required: ["color"],
    },
    handler: ({ color }) => {
      const c = (color as string).trim().toLowerCase();

      // Named color
      if (namedColors[c]) {
        const rgb = hexToRgb(namedColors[c])!;
        return { ...rgb, hex: namedColors[c], format: "named" };
      }

      // Hex
      if (c.startsWith("#") || /^[0-9a-f]{3,6}$/i.test(c)) {
        const rgb = hexToRgb(c.startsWith("#") ? c : `#${c}`);
        if (rgb) return { ...rgb, hex: rgbToHex(rgb.r, rgb.g, rgb.b), format: "hex" };
      }

      // RGB
      const rgbMatch = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (rgbMatch) {
        const r = parseInt(rgbMatch[1], 10);
        const g = parseInt(rgbMatch[2], 10);
        const b = parseInt(rgbMatch[3], 10);
        return { r, g, b, hex: rgbToHex(r, g, b), format: "rgb" };
      }

      // HSL
      const hslMatch = c.match(/hsla?\s*\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?/);
      if (hslMatch) {
        const h = parseInt(hslMatch[1], 10);
        const s = parseInt(hslMatch[2], 10);
        const l = parseInt(hslMatch[3], 10);
        const rgb = hslToRgb(h, s, l);
        return { ...rgb, hex: rgbToHex(rgb.r, rgb.g, rgb.b), format: "hsl" };
      }

      return { error: "Unable to parse color" };
    },
  },
  {
    name: "color_lighten",
    description:
      "Lighten a color by percentage. Increase lightness in HSL color space. Use for hover states, highlights, or creating lighter variants. Keywords: lighten color, tint, increase brightness, lighter shade, color variant, hover color.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        color: { type: "string", description: "Color in any format" },
        amount: { type: "number", description: "Percentage to lighten (0-100, default: 10)" },
      },
      required: ["color"],
    },
    handler: ({ color, amount = 10 }) => {
      const c = (color as string).trim().toLowerCase();
      const hex = c.startsWith("#") ? c : namedColors[c] || `#${c}`;
      const rgb = hexToRgb(hex);
      if (!rgb) return { error: "Unable to parse color" };

      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      hsl.l = Math.min(100, hsl.l + (amount as number));

      const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      return { hex: rgbToHex(newRgb.r, newRgb.g, newRgb.b), rgb: newRgb, hsl };
    },
  },
  {
    name: "color_darken",
    description:
      "Darken a color by percentage. Decrease lightness in HSL color space. Use for pressed states, shadows, or creating darker variants. Keywords: darken color, shade, decrease brightness, darker variant, color variant, pressed color.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        color: { type: "string", description: "Color in any format" },
        amount: { type: "number", description: "Percentage to darken (0-100, default: 10)" },
      },
      required: ["color"],
    },
    handler: ({ color, amount = 10 }) => {
      const c = (color as string).trim().toLowerCase();
      const hex = c.startsWith("#") ? c : namedColors[c] || `#${c}`;
      const rgb = hexToRgb(hex);
      if (!rgb) return { error: "Unable to parse color" };

      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      hsl.l = Math.max(0, hsl.l - (amount as number));

      const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      return { hex: rgbToHex(newRgb.r, newRgb.g, newRgb.b), rgb: newRgb, hsl };
    },
  },
  {
    name: "color_saturate",
    description:
      "Increase color saturation by percentage. Make colors more vivid and intense. Use for emphasis, highlighting, or vibrancy adjustment. Keywords: saturate color, increase saturation, vivid color, color intensity, vibrant, color boost.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        color: { type: "string", description: "Color in any format" },
        amount: { type: "number", description: "Percentage to saturate (0-100, default: 10)" },
      },
      required: ["color"],
    },
    handler: ({ color, amount = 10 }) => {
      const c = (color as string).trim().toLowerCase();
      const hex = c.startsWith("#") ? c : namedColors[c] || `#${c}`;
      const rgb = hexToRgb(hex);
      if (!rgb) return { error: "Unable to parse color" };

      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      hsl.s = Math.min(100, hsl.s + (amount as number));

      const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      return { hex: rgbToHex(newRgb.r, newRgb.g, newRgb.b), rgb: newRgb, hsl };
    },
  },
  {
    name: "color_desaturate",
    description:
      "Decrease color saturation by percentage. Make colors more muted and gray. Use for disabled states, backgrounds, or subtle variants. Keywords: desaturate color, muted color, gray out, reduce saturation, subtle color, mute.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        color: { type: "string", description: "Color in any format" },
        amount: { type: "number", description: "Percentage to desaturate (0-100, default: 10)" },
      },
      required: ["color"],
    },
    handler: ({ color, amount = 10 }) => {
      const c = (color as string).trim().toLowerCase();
      const hex = c.startsWith("#") ? c : namedColors[c] || `#${c}`;
      const rgb = hexToRgb(hex);
      if (!rgb) return { error: "Unable to parse color" };

      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      hsl.s = Math.max(0, hsl.s - (amount as number));

      const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      return { hex: rgbToHex(newRgb.r, newRgb.g, newRgb.b), rgb: newRgb, hsl };
    },
  },
  {
    name: "color_invert",
    description:
      "Invert a color to its complement. Create opposite color on the color wheel for high contrast. Use for dark mode, contrast effects, or visual highlighting. Keywords: invert color, complement, opposite color, negate, color flip, contrast.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        color: { type: "string", description: "Color to invert" },
      },
      required: ["color"],
    },
    handler: ({ color }) => {
      const c = (color as string).trim().toLowerCase();
      const hex = c.startsWith("#") ? c : namedColors[c] || `#${c}`;
      const rgb = hexToRgb(hex);
      if (!rgb) return { error: "Unable to parse color" };

      const inverted = { r: 255 - rgb.r, g: 255 - rgb.g, b: 255 - rgb.b };
      return { hex: rgbToHex(inverted.r, inverted.g, inverted.b), rgb: inverted };
    },
  },
  {
    name: "color_grayscale",
    description:
      "Convert color to grayscale equivalent. Remove all color leaving only luminance. Use for print preview, disabled states, or accessibility testing. Keywords: grayscale, black white, desaturate full, monochrome, luminance, gray.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        color: { type: "string", description: "Color to convert" },
      },
      required: ["color"],
    },
    handler: ({ color }) => {
      const c = (color as string).trim().toLowerCase();
      const hex = c.startsWith("#") ? c : namedColors[c] || `#${c}`;
      const rgb = hexToRgb(hex);
      if (!rgb) return { error: "Unable to parse color" };

      const gray = Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
      return {
        hex: rgbToHex(gray, gray, gray),
        rgb: { r: gray, g: gray, b: gray },
        luminance: gray,
      };
    },
  },
  {
    name: "color_palette",
    description:
      "Generate color palette from base color. Create complementary, analogous, triadic, or split-complementary schemes. Use for design systems, theme generation, or color harmony. Keywords: color palette, color scheme, complementary, analogous, triadic, color harmony.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        color: { type: "string", description: "Base color in hex (e.g., '#ff5733')" },
        type: {
          type: "string",
          enum: ["complementary", "triadic", "analogous", "split", "tetradic", "monochromatic"],
          description: "Palette type (default: complementary)",
        },
        count: {
          type: "number",
          description: "Number of colors for analogous/monochromatic (default: 5)",
        },
      },
      required: ["color"],
    },
    handler: ({ color, type = "complementary", count = 5 }) => {
      const c = (color as string).trim().toLowerCase();
      const hex = c.startsWith("#") ? c : namedColors[c] || `#${c}`;
      const rgb = hexToRgb(hex);
      if (!rgb) return { error: "Unable to parse color" };

      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      const h = hsl.h / 360;
      const s = hsl.s / 100;
      const l = hsl.l / 100;

      const hslToHex = (h: number, s: number, l: number): string => {
        h = ((h % 1) + 1) % 1;
        const rgb = hslToRgb(Math.round(h * 360), Math.round(s * 100), Math.round(l * 100));
        return rgbToHex(rgb.r, rgb.g, rgb.b);
      };

      const baseHex = hslToHex(h, s, l);
      let palette: string[] = [];

      switch (type) {
        case "complementary":
          palette = [baseHex, hslToHex(h + 0.5, s, l)];
          break;
        case "triadic":
          palette = [baseHex, hslToHex(h + 1 / 3, s, l), hslToHex(h + 2 / 3, s, l)];
          break;
        case "analogous": {
          const step = 0.083;
          for (let i = 0; i < (count as number); i++) {
            const offset = (i - Math.floor((count as number) / 2)) * step;
            palette.push(hslToHex(h + offset, s, l));
          }
          break;
        }
        case "split":
          palette = [baseHex, hslToHex(h + 0.417, s, l), hslToHex(h + 0.583, s, l)];
          break;
        case "tetradic":
          palette = [
            baseHex,
            hslToHex(h + 0.25, s, l),
            hslToHex(h + 0.5, s, l),
            hslToHex(h + 0.75, s, l),
          ];
          break;
        case "monochromatic":
          for (let i = 0; i < (count as number); i++) {
            const newL = 0.1 + (0.8 * i / ((count as number) - 1));
            palette.push(hslToHex(h, s, newL));
          }
          break;
        default:
          palette = [baseHex];
      }

      return {
        base: baseHex,
        type,
        palette,
        hsl: { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) },
      };
    },
  },
  {
    name: "color_blend",
    description:
      "Blend two colors together with optional gradient steps. Mix colors for transitions, gradients, or intermediate colors. Use for creating color blends, gradients, or interpolation. Keywords: blend colors, mix colors, color gradient, interpolate colors, merge colors, gradient steps.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        color1: { type: "string", description: "First color in hex" },
        color2: { type: "string", description: "Second color in hex" },
        ratio: { type: "number", description: "Blend ratio 0-1 (default: 0.5)" },
        steps: { type: "number", description: "Generate gradient steps (optional)" },
      },
      required: ["color1", "color2"],
    },
    handler: ({ color1, color2, ratio = 0.5, steps }) => {
      const c1 = hexToRgb(
        (color1 as string).replace(/^#/, "").length === 6 ? (color1 as string) : `#${color1}`,
      );
      const c2 = hexToRgb(
        (color2 as string).replace(/^#/, "").length === 6 ? (color2 as string) : `#${color2}`,
      );

      if (!c1 || !c2) return { error: "Unable to parse colors" };

      const blend = (r: number) => ({
        r: Math.round(c1.r + (c2.r - c1.r) * r),
        g: Math.round(c1.g + (c2.g - c1.g) * r),
        b: Math.round(c1.b + (c2.b - c1.b) * r),
      });

      if (steps && (steps as number) > 2) {
        const gradient = [];
        for (let i = 0; i < (steps as number); i++) {
          const r = i / ((steps as number) - 1);
          const c = blend(r);
          gradient.push(rgbToHex(c.r, c.g, c.b));
        }
        return { gradient, steps };
      }

      const blended = blend(ratio as number);
      return { color1, color2, ratio, result: rgbToHex(blended.r, blended.g, blended.b) };
    },
  },
  {
    name: "color_contrast",
    description:
      "Calculate WCAG contrast ratio between two colors. Measure accessibility compliance for text/background combinations. Returns ratio and WCAG level (AA, AAA). Use for accessibility testing, design validation, or a11y compliance. Keywords: contrast ratio, WCAG, accessibility, a11y, text contrast, background contrast.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        foreground: { type: "string", description: "Foreground color in hex" },
        background: { type: "string", description: "Background color in hex" },
      },
      required: ["foreground", "background"],
    },
    handler: ({ foreground, background }) => {
      const fg = hexToRgb(
        (foreground as string).replace(/^#/, "").length === 6
          ? (foreground as string)
          : `#${foreground}`,
      );
      const bg = hexToRgb(
        (background as string).replace(/^#/, "").length === 6
          ? (background as string)
          : `#${background}`,
      );

      if (!fg || !bg) return { error: "Unable to parse colors" };

      const luminance = (c: RGB) => {
        const adjust = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * adjust(c.r) + 0.7152 * adjust(c.g) + 0.0722 * adjust(c.b);
      };

      const l1 = luminance(fg);
      const l2 = luminance(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

      return {
        foreground,
        background,
        ratio: Math.round(ratio * 100) / 100,
        wcag: { aa: ratio >= 4.5, aaLarge: ratio >= 3, aaa: ratio >= 7, aaaLarge: ratio >= 4.5 },
        rating: ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA Large" : "Fail",
      };
    },
  },
  {
    name: "color_random",
    description:
      "Generate random colors with optional constraints. Create random hex colors with saturation and lightness ranges. Use for placeholder colors, random themes, or generative design. Keywords: random color, generate color, random hex, color generator, random palette.",
    category: "color",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of colors (default: 1)" },
        saturation: {
          type: "array",
          items: { type: "number" },
          description: "Saturation range [min, max] (0-100)",
        },
        lightness: {
          type: "array",
          items: { type: "number" },
          description: "Lightness range [min, max] (0-100)",
        },
      },
    },
    handler: ({ count = 1, saturation, lightness }) => {
      const sRange = (saturation as number[]) || [50, 80];
      const lRange = (lightness as number[]) || [40, 60];

      const colors = [];
      for (let i = 0; i < (count as number); i++) {
        const h = Math.floor(Math.random() * 360);
        const s = sRange[0] + Math.random() * (sRange[1] - sRange[0]);
        const l = lRange[0] + Math.random() * (lRange[1] - lRange[0]);

        const rgb = hslToRgb(h, Math.round(s), Math.round(l));
        colors.push({
          hex: rgbToHex(rgb.r, rgb.g, rgb.b),
          hsl: { h, s: Math.round(s), l: Math.round(l) },
        });
      }

      return (count as number) === 1 ? colors[0] : colors;
    },
  },
];
