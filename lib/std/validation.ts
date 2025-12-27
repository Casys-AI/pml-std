/**
 * Validation tools
 *
 * Uses zod for schema validation and validator for format checks.
 *
 * @module lib/std/validation
 */

import { z } from "zod";
import validator from "validator";
import type { MiniTool } from "./types.ts";

export const validationTools: MiniTool[] = [
  {
    name: "validate_email",
    description:
      "Validate email address format and normalize. Check if email follows RFC standards, normalize domain case and gmail dots. Use for form validation, user registration, or data cleaning. Keywords: validate email, email format, check email, email validator, email regex, normalize email.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email to validate" },
      },
      required: ["email"],
    },
    handler: ({ email }) => ({
      valid: validator.isEmail(email as string),
      normalized: validator.normalizeEmail(email as string) || email,
    }),
  },
  {
    name: "validate_url",
    description:
      "Validate URL format with configurable protocol requirements. Check if string is a valid URL, specify allowed protocols (http, https, ftp). Use for link validation, form inputs, or security checks. Keywords: validate URL, URL format, check URL, URL validator, valid link, protocol check.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to validate" },
        protocols: {
          type: "array",
          items: { type: "string" },
          description: "Allowed protocols (default: ['http', 'https'])",
        },
        requireProtocol: { type: "boolean", description: "Require protocol (default: true)" },
      },
      required: ["url"],
    },
    handler: ({ url, protocols = ["http", "https"], requireProtocol = true }) => ({
      valid: validator.isURL(url as string, {
        protocols: protocols as string[],
        require_protocol: requireProtocol as boolean,
      }),
    }),
  },
  {
    name: "validate_uuid",
    description:
      "Validate UUID format with optional version check (v1-v5). Verify UUIDs from databases, APIs, or user input. Use for ID validation, data integrity, or input sanitization. Keywords: validate UUID, UUID format, check UUID, GUID validate, UUID version, unique identifier.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "UUID to validate" },
        version: { type: "number", enum: [1, 2, 3, 4, 5], description: "UUID version" },
      },
      required: ["uuid"],
    },
    handler: ({ uuid, version }) => ({
      valid: validator.isUUID(uuid as string, version as 1 | 2 | 3 | 4 | 5 | undefined),
    }),
  },
  {
    name: "validate_credit_card",
    description:
      "Validate credit card number using Luhn algorithm. Check if card number has valid checksum without knowing the issuer. Use for payment form validation or data verification. Keywords: credit card validate, Luhn algorithm, card number check, payment validation, checksum verify.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "string", description: "Credit card number" },
      },
      required: ["number"],
    },
    handler: ({ number }) => ({
      valid: validator.isCreditCard(number as string),
    }),
  },
  {
    name: "validate_ip",
    description:
      "Validate IP address format for IPv4 or IPv6. Check if string is valid IP address, detect version automatically. Use for network configuration, firewall rules, or access control. Keywords: validate IP, IP address, IPv4 IPv6, IP format, check IP, network address.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        ip: { type: "string", description: "IP address" },
        version: { type: "number", enum: [4, 6], description: "IP version (4 or 6)" },
      },
      required: ["ip"],
    },
    handler: ({ ip, version }) => ({
      valid: validator.isIP(ip as string, version as 4 | 6 | undefined),
      isIPv4: validator.isIP(ip as string, 4),
      isIPv6: validator.isIP(ip as string, 6),
    }),
  },
  {
    name: "validate_json",
    description:
      "Validate JSON string syntax and parse. Check if string is valid JSON, returns parsed object on success or error details on failure. Use for API input validation, config file checking, or data import. Keywords: validate JSON, parse JSON, JSON syntax, check JSON, valid JSON, JSON error.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "string", description: "JSON string to validate" },
      },
      required: ["json"],
    },
    handler: ({ json }) => {
      try {
        const parsed = JSON.parse(json as string);
        return { valid: true, parsed };
      } catch (e) {
        return { valid: false, error: (e as Error).message };
      }
    },
  },
  {
    name: "validate_schema",
    description:
      "Validate data against a Zod-compatible schema definition. Define expected types, constraints (min/max, patterns), and required fields. Get detailed error messages with paths. Use for API validation, form validation, or data contracts. Keywords: schema validation, Zod validate, type checking, data validation, contract validation, input schema.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        data: { description: "Data to validate" },
        schema: {
          type: "object",
          description:
            "Schema definition object (e.g., { type: 'object', properties: { name: { type: 'string' } } })",
        },
      },
      required: ["data", "schema"],
    },
    handler: ({ data, schema }) => {
      // Convert simple schema definition to Zod schema
      const buildZodSchema = (def: Record<string, unknown>): z.ZodTypeAny => {
        const type = def.type as string;
        switch (type) {
          case "string": {
            let s = z.string();
            if (def.minLength) s = s.min(def.minLength as number);
            if (def.maxLength) s = s.max(def.maxLength as number);
            if (def.pattern) s = s.regex(new RegExp(def.pattern as string));
            if (def.email) s = s.email();
            if (def.url) s = s.url();
            return def.optional ? s.optional() : s;
          }
          case "number": {
            let n = z.number();
            if (def.min !== undefined) n = n.min(def.min as number);
            if (def.max !== undefined) n = n.max(def.max as number);
            if (def.int) n = n.int();
            return def.optional ? n.optional() : n;
          }
          case "boolean":
            return def.optional ? z.boolean().optional() : z.boolean();
          case "array": {
            const items = def.items
              ? buildZodSchema(def.items as Record<string, unknown>)
              : z.any();
            let a = z.array(items);
            if (def.minItems) a = a.min(def.minItems as number);
            if (def.maxItems) a = a.max(def.maxItems as number);
            return def.optional ? a.optional() : a;
          }
          case "object": {
            const shape: Record<string, z.ZodTypeAny> = {};
            const props = def.properties as Record<string, Record<string, unknown>> | undefined;
            if (props) {
              for (const [key, propDef] of Object.entries(props)) {
                shape[key] = buildZodSchema(propDef);
              }
            }
            const o = z.object(shape);
            return def.optional ? o.optional() : o;
          }
          default:
            return z.any();
        }
      };

      try {
        const zodSchema = buildZodSchema(schema as Record<string, unknown>);
        const result = zodSchema.safeParse(data);
        if (result.success) {
          return { valid: true, data: result.data };
        }
        return {
          valid: false,
          errors: result.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        };
      } catch (e) {
        return { valid: false, error: (e as Error).message };
      }
    },
  },
  {
    name: "validate_phone",
    description:
      "Validate mobile phone number format with locale support. Check if number matches expected format for specific countries or any locale. Use for contact form validation or international phone numbers. Keywords: validate phone, phone number, mobile number, phone format, international phone, locale phone.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Phone number" },
        locale: { type: "string", description: "Locale (e.g., 'en-US', 'fr-FR')" },
      },
      required: ["phone"],
    },
    handler: ({ phone, locale }) => ({
      valid: validator.isMobilePhone(
        phone as string,
        (locale as validator.MobilePhoneLocale) || "any",
      ),
    }),
  },
  {
    name: "validate_date",
    description:
      "Validate date string format against ISO8601 or custom format. Check if date string is properly formatted and represents valid date. Use for form validation, data import, or date parsing. Keywords: validate date, date format, ISO8601, check date, date string, parse date.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date string" },
        format: { type: "string", description: "Expected format (ISO8601 by default)" },
      },
      required: ["date"],
    },
    handler: ({ date, format }) => {
      if (format === "ISO8601" || !format) {
        return { valid: validator.isISO8601(date as string) };
      }
      return { valid: validator.isDate(date as string, { format: format as string }) };
    },
  },
  // IBAN validation - inspired by IT-Tools MCP
  {
    name: "validate_iban",
    description:
      "Validate IBAN (International Bank Account Number) with checksum verification. Supports 90+ countries, validates length, format, and mod-97 checksum. Returns country code, BBAN, and formatted display. Use for banking, payments, or financial forms. Keywords: IBAN validate, bank account, checksum, international bank, BBAN, payment validation.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        iban: { type: "string", description: "IBAN to validate" },
      },
      required: ["iban"],
    },
    handler: ({ iban }) => {
      // Remove spaces and convert to uppercase
      const cleaned = (iban as string).replace(/\s/g, "").toUpperCase();

      // IBAN must be at least 15 characters
      if (cleaned.length < 15 || cleaned.length > 34) {
        return { valid: false, error: "Invalid IBAN length" };
      }

      // Check format: 2 letters + 2 digits + alphanumeric
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(cleaned)) {
        return { valid: false, error: "Invalid IBAN format" };
      }

      // Country code lengths
      const countryLengths: Record<string, number> = {
        AL: 28,
        AD: 24,
        AT: 20,
        AZ: 28,
        BH: 22,
        BY: 28,
        BE: 16,
        BA: 20,
        BR: 29,
        BG: 22,
        CR: 22,
        HR: 21,
        CY: 28,
        CZ: 24,
        DK: 18,
        DO: 28,
        TL: 23,
        EE: 20,
        FO: 18,
        FI: 18,
        FR: 27,
        GE: 22,
        DE: 22,
        GI: 23,
        GR: 27,
        GL: 18,
        GT: 28,
        HU: 28,
        IS: 26,
        IQ: 23,
        IE: 22,
        IL: 23,
        IT: 27,
        JO: 30,
        KZ: 20,
        XK: 20,
        KW: 30,
        LV: 21,
        LB: 28,
        LY: 25,
        LI: 21,
        LT: 20,
        LU: 20,
        MT: 31,
        MR: 27,
        MU: 30,
        MC: 27,
        MD: 24,
        ME: 22,
        NL: 18,
        MK: 19,
        NO: 15,
        PK: 24,
        PS: 29,
        PL: 28,
        PT: 25,
        QA: 29,
        RO: 24,
        LC: 32,
        SM: 27,
        ST: 25,
        SA: 24,
        RS: 22,
        SC: 31,
        SK: 24,
        SI: 19,
        ES: 24,
        SD: 18,
        SE: 24,
        CH: 21,
        TN: 24,
        TR: 26,
        UA: 29,
        AE: 23,
        GB: 22,
        VA: 22,
        VG: 24,
      };

      const countryCode = cleaned.slice(0, 2);
      const expectedLength = countryLengths[countryCode];

      if (expectedLength && cleaned.length !== expectedLength) {
        return {
          valid: false,
          error:
            `Invalid length for ${countryCode}: expected ${expectedLength}, got ${cleaned.length}`,
        };
      }

      // Move first 4 chars to end
      const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);

      // Convert letters to numbers (A=10, B=11, etc.)
      let numericString = "";
      for (const char of rearranged) {
        if (/[A-Z]/.test(char)) {
          numericString += (char.charCodeAt(0) - 55).toString();
        } else {
          numericString += char;
        }
      }

      // Validate checksum using mod 97
      let remainder = 0;
      for (const char of numericString) {
        remainder = (remainder * 10 + parseInt(char, 10)) % 97;
      }

      const isValid = remainder === 1;

      return {
        valid: isValid,
        iban: cleaned,
        country: countryCode,
        checkDigits: cleaned.slice(2, 4),
        bban: cleaned.slice(4),
        formatted: cleaned.match(/.{1,4}/g)?.join(" ") || cleaned,
      };
    },
  },
  {
    name: "validate_credit_card_info",
    description:
      "Validate credit card with Luhn algorithm and detect card type (Visa, Mastercard, Amex, Discover, Diners, JCB). Returns card type, last 4 digits, and masked number. Use for payment forms, card identification, or checkout flows. Keywords: credit card type, Visa Mastercard, card detect, payment card, card validation, card brand.",
    category: "validation",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "string", description: "Credit card number" },
      },
      required: ["number"],
    },
    handler: ({ number }) => {
      const cleaned = (number as string).replace(/[\s-]/g, "");

      if (!/^\d{13,19}$/.test(cleaned)) {
        return { valid: false, error: "Invalid card number format" };
      }

      // Luhn algorithm
      let sum = 0;
      let isEven = false;

      for (let i = cleaned.length - 1; i >= 0; i--) {
        let digit = parseInt(cleaned[i], 10);

        if (isEven) {
          digit *= 2;
          if (digit > 9) digit -= 9;
        }

        sum += digit;
        isEven = !isEven;
      }

      const isValid = sum % 10 === 0;

      // Detect card type
      let cardType = "Unknown";
      if (/^4/.test(cleaned)) cardType = "Visa";
      else if (/^5[1-5]/.test(cleaned) || /^2[2-7]/.test(cleaned)) cardType = "Mastercard";
      else if (/^3[47]/.test(cleaned)) cardType = "American Express";
      else if (/^6(?:011|5)/.test(cleaned)) cardType = "Discover";
      else if (/^3(?:0[0-5]|[68])/.test(cleaned)) cardType = "Diners Club";
      else if (/^35/.test(cleaned)) cardType = "JCB";

      return {
        valid: isValid,
        cardType,
        lastFour: cleaned.slice(-4),
        masked: "*".repeat(cleaned.length - 4) + cleaned.slice(-4),
      };
    },
  },
];
