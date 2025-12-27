/**
 * Fake data generation tools
 *
 * Uses @faker-js/faker for realistic test data.
 *
 * @module lib/std/data
 */

import { faker } from "@faker-js/faker";
import type { MiniTool } from "./types.ts";

// Note: In faker v9, locale is set via seed or at import time
// We'll use the default faker instance which uses en locale

export const dataTools: MiniTool[] = [
  {
    name: "data_person",
    description: "Generate fake person data (name, email, phone, job, etc.)",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        sex: { type: "string", enum: ["male", "female"], description: "Gender for name" },
      },
    },
    handler: ({ sex }) => {
      const sexOpt = sex as "male" | "female" | undefined;
      return {
        firstName: faker.person.firstName(sexOpt),
        lastName: faker.person.lastName(sexOpt),
        fullName: faker.person.fullName({ sex: sexOpt }),
        email: faker.internet.email(),
        phone: faker.phone.number(),
        jobTitle: faker.person.jobTitle(),
        jobArea: faker.person.jobArea(),
        bio: faker.person.bio(),
      };
    },
  },
  {
    name: "data_address",
    description: "Generate fake address data",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: () => {
      return {
        street: faker.location.streetAddress(),
        city: faker.location.city(),
        state: faker.location.state(),
        zipCode: faker.location.zipCode(),
        country: faker.location.country(),
        countryCode: faker.location.countryCode(),
        latitude: faker.location.latitude(),
        longitude: faker.location.longitude(),
      };
    },
  },
  {
    name: "data_company",
    description: "Generate fake company data",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: () => {
      return {
        name: faker.company.name(),
        catchPhrase: faker.company.catchPhrase(),
        buzzPhrase: faker.company.buzzPhrase(),
        industry: faker.commerce.department(),
      };
    },
  },
  {
    name: "data_lorem",
    description: "Generate lorem ipsum text",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["words", "sentences", "paragraphs", "lines"],
          description: "Type of text",
        },
        count: { type: "number", description: "Number of units (default: 3)" },
      },
    },
    handler: ({ type = "sentences", count = 3 }) => {
      const cnt = count as number;
      switch (type) {
        case "words":
          return faker.lorem.words(cnt);
        case "sentences":
          return faker.lorem.sentences(cnt);
        case "paragraphs":
          return faker.lorem.paragraphs(cnt);
        case "lines":
          return faker.lorem.lines(cnt);
        default:
          return faker.lorem.sentences(cnt);
      }
    },
  },
  {
    name: "data_internet",
    description: "Generate fake internet data (username, url, ip, etc.)",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["email", "username", "url", "ip", "ipv6", "mac", "userAgent", "password"],
          description: "Type of data",
        },
      },
      required: ["type"],
    },
    handler: ({ type }) => {
      switch (type) {
        case "email":
          return faker.internet.email();
        case "username":
          return faker.internet.userName();
        case "url":
          return faker.internet.url();
        case "ip":
          return faker.internet.ip();
        case "ipv6":
          return faker.internet.ipv6();
        case "mac":
          return faker.internet.mac();
        case "userAgent":
          return faker.internet.userAgent();
        case "password":
          return faker.internet.password();
        default:
          return faker.internet.email();
      }
    },
  },
  {
    name: "data_finance",
    description: "Generate fake financial data",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["amount", "currency", "creditCard", "iban", "bic", "bitcoin"],
          description: "Type of financial data",
        },
      },
      required: ["type"],
    },
    handler: ({ type }) => {
      switch (type) {
        case "amount":
          return faker.finance.amount();
        case "currency":
          return faker.finance.currency();
        case "creditCard":
          return {
            number: faker.finance.creditCardNumber(),
            issuer: faker.finance.creditCardIssuer(),
            cvv: faker.finance.creditCardCVV(),
          };
        case "iban":
          return faker.finance.iban();
        case "bic":
          return faker.finance.bic();
        case "bitcoin":
          return faker.finance.bitcoinAddress();
        default:
          return faker.finance.amount();
      }
    },
  },
  {
    name: "data_date",
    description: "Generate fake dates",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["past", "future", "recent", "soon", "birthdate", "between"],
          description: "Type of date",
        },
        years: { type: "number", description: "Years range (for past/future)" },
        from: { type: "string", description: "Start date (for between)" },
        to: { type: "string", description: "End date (for between)" },
      },
    },
    handler: ({ type = "recent", years = 1, from, to }) => {
      switch (type) {
        case "past":
          return faker.date.past({ years: years as number }).toISOString();
        case "future":
          return faker.date.future({ years: years as number }).toISOString();
        case "recent":
          return faker.date.recent().toISOString();
        case "soon":
          return faker.date.soon().toISOString();
        case "birthdate":
          return faker.date.birthdate().toISOString();
        case "between":
          return faker.date
            .between({ from: from as string, to: to as string })
            .toISOString();
        default:
          return faker.date.recent().toISOString();
      }
    },
  },
  {
    name: "data_image",
    description: "Generate fake image URLs",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["avatar", "url", "urlLoremFlickr", "dataUri"],
          description: "Type of image",
        },
        width: { type: "number", description: "Width in pixels" },
        height: { type: "number", description: "Height in pixels" },
        category: { type: "string", description: "Category (for urlLoremFlickr)" },
      },
    },
    handler: ({ type = "url", width = 640, height = 480, category }) => {
      switch (type) {
        case "avatar":
          return faker.image.avatar();
        case "url":
          return faker.image.url({ width: width as number, height: height as number });
        case "urlLoremFlickr":
          return faker.image.urlLoremFlickr({
            width: width as number,
            height: height as number,
            category: category as string,
          });
        case "dataUri":
          return faker.image.dataUri({ width: width as number, height: height as number });
        default:
          return faker.image.url();
      }
    },
  },
  // SVG placeholder generator - inspired by IT-Tools MCP
  {
    name: "data_svg_placeholder",
    description: "Generate SVG placeholder image with custom dimensions and text",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number", description: "Width in pixels (default: 300)" },
        height: { type: "number", description: "Height in pixels (default: 150)" },
        text: { type: "string", description: "Text to display (default: WxH)" },
        bgColor: { type: "string", description: "Background color (default: #cccccc)" },
        textColor: { type: "string", description: "Text color (default: #666666)" },
        fontSize: {
          type: "number",
          description: "Font size in pixels (auto-calculated if not set)",
        },
      },
    },
    handler: (
      { width = 300, height = 150, text, bgColor = "#cccccc", textColor = "#666666", fontSize },
    ) => {
      const w = width as number;
      const h = height as number;
      const displayText = (text as string) || `${w}×${h}`;
      const size = (fontSize as number) || Math.min(w, h) / 5;

      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect fill="${bgColor}" width="${w}" height="${h}"/>
  <text fill="${textColor}" font-family="Arial, sans-serif" font-size="${size}"
        x="50%" y="50%" dominant-baseline="middle" text-anchor="middle">
    ${displayText}
  </text>
</svg>`;

      const dataUri = `data:image/svg+xml;base64,${btoa(svg)}`;

      return {
        svg,
        dataUri,
        width: w,
        height: h,
      };
    },
  },
  {
    name: "data_qr_code",
    description: "Generate QR code as SVG (uses Google Charts API URL or generates simple pattern)",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "Data to encode in QR code" },
        size: { type: "number", description: "Size in pixels (default: 200)" },
        format: {
          type: "string",
          enum: ["url", "svg"],
          description:
            "Output format: 'url' for Google Charts API, 'svg' for inline SVG placeholder",
        },
      },
      required: ["data"],
    },
    handler: ({ data, size = 200, format = "url" }) => {
      const s = size as number;
      const d = encodeURIComponent(data as string);

      if (format === "url") {
        // Google Charts QR API (public, no key needed)
        const url = `https://chart.googleapis.com/chart?cht=qr&chs=${s}x${s}&chl=${d}&choe=UTF-8`;
        return {
          url,
          size: s,
          data: data as string,
        };
      }

      // Simple visual placeholder for QR code (not a real QR code)
      const modules = 21; // QR Version 1 is 21x21
      const moduleSize = s / modules;

      // Generate a deterministic pattern based on input data
      const hash = [...(data as string)].reduce(
        (acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0,
        0,
      );

      let rects = "";
      for (let y = 0; y < modules; y++) {
        for (let x = 0; x < modules; x++) {
          // Position patterns (corners)
          const isPositionPattern = (x < 7 && y < 7) || // Top-left
            (x >= modules - 7 && y < 7) || // Top-right
            (x < 7 && y >= modules - 7); // Bottom-left

          // Timing patterns
          const isTimingPattern = x === 6 || y === 6;

          // Generate pseudo-random data based on position and input hash
          const seed = (x * 31 + y * 17 + hash) >>> 0;
          const isDataModule = (seed % 3) === 0;

          const isFilled = isPositionPattern || (isTimingPattern && (x + y) % 2 === 0) ||
            (!isPositionPattern && !isTimingPattern && isDataModule);

          if (isFilled) {
            rects += `<rect x="${x * moduleSize}" y="${
              y * moduleSize
            }" width="${moduleSize}" height="${moduleSize}"/>`;
          }
        }
      }

      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect fill="white" width="${s}" height="${s}"/>
  <g fill="black">${rects}</g>
</svg>`;

      return {
        svg,
        dataUri: `data:image/svg+xml;base64,${btoa(svg)}`,
        size: s,
        data: data as string,
        warning:
          "This is a visual placeholder. For real QR codes, use format='url' for Google Charts API.",
      };
    },
  },
  {
    name: "data_barcode",
    description: "Generate barcode URL (Code128/EAN13) via public API",
    category: "data",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "Data to encode" },
        type: {
          type: "string",
          enum: ["code128", "ean13", "upc", "code39"],
          description: "Barcode type (default: code128)",
        },
        width: { type: "number", description: "Width in pixels (default: 200)" },
        height: { type: "number", description: "Height in pixels (default: 80)" },
      },
      required: ["data"],
    },
    handler: ({ data, type = "code128", width = 200, height = 80 }) => {
      const d = encodeURIComponent(data as string);
      const w = width as number;
      const h = height as number;

      // Using bwip-js public API endpoint style URL
      const url = `https://bwipjs-api.metafloor.com/?bcid=${type}&text=${d}&scale=3&height=${
        Math.floor(h / 10)
      }&includetext`;

      return {
        url,
        data: data as string,
        type: type as string,
        width: w,
        height: h,
      };
    },
  },
];
