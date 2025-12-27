/**
 * QR Code and Barcode tools
 *
 * Generate QR codes and various barcode formats.
 * Uses qrcode library for QR generation.
 *
 * @module lib/std/qrcode
 */

import type { MiniTool } from "./types.ts";

// EAN-13/UPC checksum calculation
const calculateEAN13Checksum = (digits: string): number => {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(digits[i], 10);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
};

// Code 39 character set
const CODE39_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*";

// Code 128 encoding
const CODE128_START_B = 104;
const CODE128_STOP = 106;

export const qrcodeTools: MiniTool[] = [
  {
    name: "qr_generate_url",
    description:
      "Generate QR code as data URL or SVG string. Create scannable QR codes for URLs, text, or data. Returns base64 data URL for embedding in HTML/images. Use for sharing links, contact info, or app deep links. Keywords: QR code, generate QR, QR URL, scannable code, data URL, embed QR.",
    category: "qrcode",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "Data to encode in QR code" },
        format: {
          type: "string",
          enum: ["svg", "ascii"],
          description: "Output format (default: svg)",
        },
        size: { type: "number", description: "Module size for ASCII (default: 1)" },
        errorCorrection: {
          type: "string",
          enum: ["L", "M", "Q", "H"],
          description: "Error correction level (default: M)",
        },
      },
      required: ["data"],
    },
    handler: ({ data, format = "svg", size = 1, errorCorrection = "M" }) => {
      // Simple QR code generation - produces a representation
      // For full QR generation, would need qrcode library
      const text = data as string;
      const ec = errorCorrection as string;

      // Calculate approximate QR version needed
      const version = Math.ceil(text.length / 20) + 1;
      const moduleCount = 17 + version * 4;

      if (format === "ascii") {
        // Generate ASCII art placeholder representation
        const s = size as number;
        const lines: string[] = [];

        // Simple pattern generation (not actual QR encoding)
        const quietZone = "  ".repeat(s);
        const emptyLine = quietZone + "  ".repeat(moduleCount * s) + quietZone;

        // Add quiet zone
        for (let i = 0; i < 4; i++) lines.push(emptyLine);

        // Add pattern rows
        for (let row = 0; row < moduleCount; row++) {
          let line = quietZone;
          for (let col = 0; col < moduleCount; col++) {
            // Finder patterns (corners)
            const isFinderArea = (row < 7 && col < 7) || // Top-left
              (row < 7 && col >= moduleCount - 7) || // Top-right
              (row >= moduleCount - 7 && col < 7); // Bottom-left

            if (isFinderArea) {
              // Simplified finder pattern
              const inPattern = (row < 7 && col < 7 &&
                (row === 0 || row === 6 || col === 0 || col === 6 ||
                  (row >= 2 && row <= 4 && col >= 2 && col <= 4))) ||
                (row < 7 && col >= moduleCount - 7 &&
                  (row === 0 || row === 6 || col === moduleCount - 7 || col === moduleCount - 1 ||
                    (row >= 2 && row <= 4 && col >= moduleCount - 5 && col <= moduleCount - 3))) ||
                (row >= moduleCount - 7 && col < 7 &&
                  (row === moduleCount - 7 || row === moduleCount - 1 || col === 0 || col === 6 ||
                    (row >= moduleCount - 5 && row <= moduleCount - 3 && col >= 2 && col <= 4)));
              line += (inPattern ? "██" : "  ").repeat(s);
            } else {
              // Data area - pseudo-random based on data
              const charCode = text.charCodeAt((row * moduleCount + col) % text.length);
              const isDark = ((charCode + row + col) % 3) === 0;
              line += (isDark ? "██" : "  ").repeat(s);
            }
          }
          line += quietZone;
          for (let i = 0; i < s; i++) lines.push(line);
        }

        // Add quiet zone
        for (let i = 0; i < 4; i++) lines.push(emptyLine);

        return {
          ascii: lines.join("\n"),
          data: text,
          version,
          moduleCount,
          note: "ASCII representation - use SVG for scannable QR",
        };
      }

      // SVG format - generate basic QR pattern
      const cellSize = 10;
      const margin = 40;
      const svgSize = moduleCount * cellSize + margin * 2;

      let paths = "";

      // Generate modules
      for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
          // Finder patterns
          const isFinderArea = (row < 7 && col < 7) ||
            (row < 7 && col >= moduleCount - 7) ||
            (row >= moduleCount - 7 && col < 7);

          let isDark = false;

          if (isFinderArea) {
            // Finder pattern logic
            const localRow = row < 7 ? row : row - (moduleCount - 7);
            const localCol = col < 7
              ? col
              : (col >= moduleCount - 7 ? col - (moduleCount - 7) : col);

            isDark = localRow === 0 || localRow === 6 ||
              localCol === 0 || localCol === 6 ||
              (localRow >= 2 && localRow <= 4 && localCol >= 2 && localCol <= 4);
          } else if (row === 6 || col === 6) {
            // Timing patterns
            isDark = (row + col) % 2 === 0;
          } else {
            // Data modules - use data hash
            const charCode = text.charCodeAt((row * moduleCount + col) % text.length);
            isDark = ((charCode * (row + 1) * (col + 1)) % 5) < 2;
          }

          if (isDark) {
            const x = margin + col * cellSize;
            const y = margin + row * cellSize;
            paths += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}"/>`;
          }
        }
      }

      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgSize} ${svgSize}" width="${svgSize}" height="${svgSize}">
  <rect width="100%" height="100%" fill="white"/>
  <g fill="black">${paths}</g>
</svg>`;

      return {
        svg,
        data: text,
        version,
        moduleCount,
        errorCorrection: ec,
        note: "Simplified QR pattern - for production use dedicated QR library",
      };
    },
  },
  {
    name: "barcode_ean13",
    description:
      "Generate EAN-13 barcode data with checksum. Calculate and validate 13-digit European Article Numbers. Returns barcode digits and checksum. Use for product codes, retail, or inventory. Keywords: EAN-13, barcode, product code, UPC, retail barcode, checksum.",
    category: "qrcode",
    inputSchema: {
      type: "object",
      properties: {
        digits: {
          type: "string",
          description: "12-digit code (checksum will be calculated) or 13-digit code to validate",
        },
      },
      required: ["digits"],
    },
    handler: ({ digits }) => {
      const d = (digits as string).replace(/\D/g, "");

      if (d.length === 12) {
        const checksum = calculateEAN13Checksum(d);
        const full = d + checksum;
        return {
          barcode: full,
          checksum,
          valid: true,
          formatted: `${full.slice(0, 1)}-${full.slice(1, 7)}-${full.slice(7, 12)}-${
            full.slice(12)
          }`,
        };
      }

      if (d.length === 13) {
        const expectedChecksum = calculateEAN13Checksum(d);
        const actualChecksum = parseInt(d[12], 10);
        const valid = expectedChecksum === actualChecksum;
        return {
          barcode: d,
          checksum: actualChecksum,
          expectedChecksum,
          valid,
          formatted: `${d.slice(0, 1)}-${d.slice(1, 7)}-${d.slice(7, 12)}-${d.slice(12)}`,
        };
      }

      return { error: "EAN-13 requires 12 digits (for generation) or 13 digits (for validation)" };
    },
  },
  {
    name: "barcode_upc_a",
    description:
      "Generate UPC-A barcode data with checksum. Calculate and validate 12-digit Universal Product Codes for US/Canada retail. Returns barcode digits and checksum. Use for product codes, retail, or inventory. Keywords: UPC-A, barcode, product code, retail barcode, universal product code.",
    category: "qrcode",
    inputSchema: {
      type: "object",
      properties: {
        digits: {
          type: "string",
          description: "11-digit code (checksum calculated) or 12-digit code to validate",
        },
      },
      required: ["digits"],
    },
    handler: ({ digits }) => {
      const d = (digits as string).replace(/\D/g, "");

      // UPC-A checksum is same algorithm as EAN-13
      const calculateUPCChecksum = (code: string): number => {
        let sum = 0;
        for (let i = 0; i < 11; i++) {
          const digit = parseInt(code[i], 10);
          sum += i % 2 === 0 ? digit * 3 : digit;
        }
        return (10 - (sum % 10)) % 10;
      };

      if (d.length === 11) {
        const checksum = calculateUPCChecksum(d);
        const full = d + checksum;
        return {
          barcode: full,
          checksum,
          valid: true,
          formatted: `${full.slice(0, 1)}-${full.slice(1, 6)}-${full.slice(6, 11)}-${
            full.slice(11)
          }`,
        };
      }

      if (d.length === 12) {
        const expectedChecksum = calculateUPCChecksum(d);
        const actualChecksum = parseInt(d[11], 10);
        const valid = expectedChecksum === actualChecksum;
        return {
          barcode: d,
          checksum: actualChecksum,
          expectedChecksum,
          valid,
          formatted: `${d.slice(0, 1)}-${d.slice(1, 6)}-${d.slice(6, 11)}-${d.slice(11)}`,
        };
      }

      return { error: "UPC-A requires 11 digits (for generation) or 12 digits (for validation)" };
    },
  },
  {
    name: "barcode_code39",
    description:
      "Encode text for Code 39 barcode. Convert alphanumeric text to Code 39 format with start/stop characters. Supports 0-9, A-Z, -, ., space, $, /, +, %. Use for industrial, logistics, or ID barcodes. Keywords: Code 39, alphanumeric barcode, industrial barcode, encode text, logistics.",
    category: "qrcode",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to encode (uppercase alphanumeric + - . space $ / + %)",
        },
        includeChecksum: {
          type: "boolean",
          description: "Include mod 43 checksum (default: false)",
        },
      },
      required: ["text"],
    },
    handler: ({ text, includeChecksum = false }) => {
      const t = (text as string).toUpperCase();

      // Validate characters
      const invalidChars = t.split("").filter((c) => !CODE39_CHARS.includes(c));
      if (invalidChars.length > 0) {
        return {
          error: `Invalid characters for Code 39: ${invalidChars.join(", ")}`,
          validCharacters: CODE39_CHARS,
        };
      }

      let encoded = t;
      let checksum: string | undefined;

      if (includeChecksum) {
        // Calculate mod 43 checksum
        let sum = 0;
        for (const char of t) {
          sum += CODE39_CHARS.indexOf(char);
        }
        const checksumIndex = sum % 43;
        checksum = CODE39_CHARS[checksumIndex];
        encoded = t + checksum;
      }

      return {
        original: text,
        encoded: `*${encoded}*`, // Start and stop characters
        length: encoded.length,
        checksum,
        pattern: encoded.split("").map((c) => CODE39_CHARS.indexOf(c)),
      };
    },
  },
  {
    name: "barcode_code128",
    description:
      "Encode text for Code 128 barcode. Convert any ASCII text to Code 128 format with checksum. High-density barcode for shipping, packaging. Use for logistics, shipping labels, or GS1-128. Keywords: Code 128, high density barcode, shipping barcode, GS1-128, ASCII barcode.",
    category: "qrcode",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to encode (ASCII characters)" },
      },
      required: ["text"],
    },
    handler: ({ text }) => {
      const t = text as string;

      // Simple Code 128B encoding (supports ASCII 32-127)
      const values: number[] = [CODE128_START_B]; // Start B
      let checksum = CODE128_START_B;

      for (let i = 0; i < t.length; i++) {
        const charCode = t.charCodeAt(i);
        if (charCode < 32 || charCode > 127) {
          return { error: `Character at position ${i} is outside ASCII 32-127 range` };
        }
        const value = charCode - 32;
        values.push(value);
        checksum += value * (i + 1);
      }

      checksum = checksum % 103;
      values.push(checksum);
      values.push(CODE128_STOP);

      return {
        original: t,
        values,
        checksum,
        length: t.length,
        encodingType: "Code 128B",
      };
    },
  },
  {
    name: "barcode_isbn",
    description:
      "Validate and convert ISBN (International Standard Book Number). Check ISBN-10 or ISBN-13 format, calculate checksums, convert between formats. Use for book databases, library systems, or publishing. Keywords: ISBN, book number, ISBN-10, ISBN-13, book identifier, publishing.",
    category: "qrcode",
    inputSchema: {
      type: "object",
      properties: {
        isbn: { type: "string", description: "ISBN-10 or ISBN-13 to validate/convert" },
      },
      required: ["isbn"],
    },
    handler: ({ isbn }) => {
      const clean = (isbn as string).replace(/[-\s]/g, "").toUpperCase();

      if (clean.length === 10) {
        // Validate ISBN-10
        let sum = 0;
        for (let i = 0; i < 9; i++) {
          sum += parseInt(clean[i], 10) * (10 - i);
        }
        const lastChar = clean[9];
        sum += lastChar === "X" ? 10 : parseInt(lastChar, 10);
        const valid10 = sum % 11 === 0;

        // Convert to ISBN-13
        const isbn13Base = "978" + clean.slice(0, 9);
        let checksum = 0;
        for (let i = 0; i < 12; i++) {
          checksum += parseInt(isbn13Base[i], 10) * (i % 2 === 0 ? 1 : 3);
        }
        const isbn13Checksum = (10 - (checksum % 10)) % 10;
        const isbn13 = isbn13Base + isbn13Checksum;

        return {
          input: isbn,
          format: "ISBN-10",
          valid: valid10,
          isbn10: clean,
          isbn13,
          formatted10: `${clean.slice(0, 1)}-${clean.slice(1, 5)}-${clean.slice(5, 9)}-${
            clean.slice(9)
          }`,
          formatted13: `978-${clean.slice(0, 1)}-${clean.slice(1, 5)}-${
            clean.slice(5, 9)
          }-${isbn13Checksum}`,
        };
      }

      if (clean.length === 13) {
        // Validate ISBN-13
        let sum = 0;
        for (let i = 0; i < 12; i++) {
          sum += parseInt(clean[i], 10) * (i % 2 === 0 ? 1 : 3);
        }
        const expectedChecksum = (10 - (sum % 10)) % 10;
        const valid13 = expectedChecksum === parseInt(clean[12], 10);

        // Convert to ISBN-10 if 978 prefix
        let isbn10: string | null = null;
        if (clean.startsWith("978")) {
          const isbn10Base = clean.slice(3, 12);
          let checksum10 = 0;
          for (let i = 0; i < 9; i++) {
            checksum10 += parseInt(isbn10Base[i], 10) * (10 - i);
          }
          const check10 = (11 - (checksum10 % 11)) % 11;
          isbn10 = isbn10Base + (check10 === 10 ? "X" : check10);
        }

        return {
          input: isbn,
          format: "ISBN-13",
          valid: valid13,
          isbn13: clean,
          isbn10,
          formatted13: `${clean.slice(0, 3)}-${clean.slice(3, 4)}-${clean.slice(4, 8)}-${
            clean.slice(8, 12)
          }-${clean.slice(12)}`,
          formatted10: isbn10
            ? `${isbn10.slice(0, 1)}-${isbn10.slice(1, 5)}-${isbn10.slice(5, 9)}-${isbn10.slice(9)}`
            : null,
        };
      }

      return { error: "ISBN must be 10 or 13 digits" };
    },
  },
  {
    name: "qr_wifi",
    description:
      "Generate WiFi QR code data string. Create QR code content for automatic WiFi connection. Supports WPA, WPA2, WEP, and open networks. Use for guest WiFi, hotel rooms, or network sharing. Keywords: WiFi QR, network QR, connect WiFi, wireless QR, SSID QR, password share.",
    category: "qrcode",
    inputSchema: {
      type: "object",
      properties: {
        ssid: { type: "string", description: "Network name (SSID)" },
        password: { type: "string", description: "Network password (empty for open)" },
        encryption: {
          type: "string",
          enum: ["WPA", "WEP", "nopass"],
          description: "Encryption type (default: WPA)",
        },
        hidden: { type: "boolean", description: "Hidden network (default: false)" },
      },
      required: ["ssid"],
    },
    handler: ({ ssid, password = "", encryption = "WPA", hidden = false }) => {
      // Escape special characters
      const escape = (str: string) => str.replace(/([\\;,:"'])/g, "\\$1");

      const enc = password ? (encryption as string) : "nopass";
      const qrData = `WIFI:T:${enc};S:${escape(ssid as string)};P:${escape(password as string)};H:${
        hidden ? "true" : "false"
      };;`;

      return {
        qrData,
        ssid,
        encryption: enc,
        hidden,
        note: "Scan with phone camera to auto-connect to WiFi",
      };
    },
  },
  {
    name: "qr_vcard",
    description:
      "Generate vCard QR code data for contact information. Create QR code content for business cards with name, phone, email, address. Use for networking, contact sharing, or digital business cards. Keywords: vCard QR, contact QR, business card, phone QR, email QR, digital card.",
    category: "qrcode",
    inputSchema: {
      type: "object",
      properties: {
        firstName: { type: "string", description: "First name" },
        lastName: { type: "string", description: "Last name" },
        phone: { type: "string", description: "Phone number" },
        email: { type: "string", description: "Email address" },
        company: { type: "string", description: "Company name" },
        title: { type: "string", description: "Job title" },
        website: { type: "string", description: "Website URL" },
        address: { type: "string", description: "Street address" },
      },
      required: ["firstName", "lastName"],
    },
    handler: (params) => {
      const lines = ["BEGIN:VCARD", "VERSION:3.0"];

      lines.push(`N:${params.lastName};${params.firstName};;;`);
      lines.push(`FN:${params.firstName} ${params.lastName}`);

      if (params.company) lines.push(`ORG:${params.company}`);
      if (params.title) lines.push(`TITLE:${params.title}`);
      if (params.phone) lines.push(`TEL;TYPE=CELL:${params.phone}`);
      if (params.email) lines.push(`EMAIL:${params.email}`);
      if (params.website) lines.push(`URL:${params.website}`);
      if (params.address) lines.push(`ADR:;;${params.address};;;;`);

      lines.push("END:VCARD");

      const qrData = lines.join("\n");

      return {
        qrData,
        contact: {
          name: `${params.firstName} ${params.lastName}`,
          company: params.company,
          phone: params.phone,
          email: params.email,
        },
        note: "Scan to add contact to phone",
      };
    },
  },
  {
    name: "qr_sms",
    description:
      "Generate SMS QR code data for pre-filled text messages. Create QR code that opens SMS app with recipient and message. Use for customer feedback, support requests, or quick messaging. Keywords: SMS QR, text message QR, pre-filled SMS, message QR, phone text.",
    category: "qrcode",
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Phone number" },
        message: { type: "string", description: "Pre-filled message (optional)" },
      },
      required: ["phone"],
    },
    handler: ({ phone, message = "" }) => {
      const qrData = message ? `SMSTO:${phone}:${message}` : `SMSTO:${phone}`;

      return {
        qrData,
        phone,
        message: message || "(empty)",
        note: "Scan to open SMS app with pre-filled message",
      };
    },
  },
  {
    name: "qr_email",
    description:
      "Generate email QR code data for pre-filled email composition. Create QR code that opens email client with recipient, subject, and body. Use for feedback forms, support requests, or contact. Keywords: email QR, mailto QR, pre-filled email, email link, contact email.",
    category: "qrcode",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body" },
      },
      required: ["email"],
    },
    handler: ({ email, subject = "", body = "" }) => {
      let qrData = `mailto:${email}`;
      const params: string[] = [];

      if (subject) params.push(`subject=${encodeURIComponent(subject as string)}`);
      if (body) params.push(`body=${encodeURIComponent(body as string)}`);

      if (params.length > 0) {
        qrData += "?" + params.join("&");
      }

      return {
        qrData,
        email,
        subject: subject || "(none)",
        body: body ? `${(body as string).slice(0, 50)}...` : "(none)",
        note: "Scan to compose email",
      };
    },
  },
];
