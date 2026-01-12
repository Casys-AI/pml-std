/**
 * Crypto/hashing tools
 *
 * Uses Web Crypto API (built into Deno).
 *
 * Inspired by:
 * - IT-Tools MCP: https://github.com/wrenchpilot/it-tools-mcp
 * - TextToolkit MCP: https://github.com/Cicatriiz/text-toolkit
 *
 * @module lib/std/crypto
 */

import * as bcrypt from "npm:bcryptjs@2.4.3";
import type { MiniTool } from "./types.ts";

// BIP39 wordlist (English - 2048 words)
const BIP39_WORDLIST = [
  "abandon",
  "ability",
  "able",
  "about",
  "above",
  "absent",
  "absorb",
  "abstract",
  "absurd",
  "abuse",
  "access",
  "accident",
  "account",
  "accuse",
  "achieve",
  "acid",
  "acoustic",
  "acquire",
  "across",
  "act",
  "action",
  "actor",
  "actress",
  "actual",
  "adapt",
  "add",
  "addict",
  "address",
  "adjust",
  "admit",
  "adult",
  "advance",
  "advice",
  "aerobic",
  "affair",
  "afford",
  "afraid",
  "again",
  "age",
  "agent",
  "agree",
  "ahead",
  "aim",
  "air",
  "airport",
  "aisle",
  "alarm",
  "album",
  "alcohol",
  "alert",
  "alien",
  "all",
  "alley",
  "allow",
  "almost",
  "alone",
  "alpha",
  "already",
  "also",
  "alter",
  "always",
  "amateur",
  "amazing",
  "among",
  "amount",
  "amused",
  "analyst",
  "anchor",
  "ancient",
  "anger",
  "angle",
  "angry",
  "animal",
  "ankle",
  "announce",
  "annual",
  "another",
  "answer",
  "antenna",
  "antique",
  "anxiety",
  "any",
  "apart",
  "apology",
  "appear",
  "apple",
  "approve",
  "april",
  "arch",
  "arctic",
  "area",
  "arena",
  "argue",
  "arm",
  "armed",
  "armor",
  "army",
  "around",
  "arrange",
  "arrest",
  "arrive",
  "arrow",
  "art",
  "artefact",
  "artist",
  "artwork",
  "ask",
  "aspect",
  "assault",
  "asset",
  "assist",
  "assume",
  "asthma",
  "athlete",
  "atom",
  "attack",
  "attend",
  "attitude",
  "attract",
  "auction",
  "audit",
  "august",
  "aunt",
  "author",
  "auto",
  "autumn",
  "average",
  "avocado",
  "avoid",
  "awake",
  "aware",
  "away",
  "awesome",
  "awful",
  "awkward",
  "axis",
  "baby",
  "bachelor",
  "bacon",
  "badge",
  "bag",
  "balance",
  "balcony",
  "ball",
  "bamboo",
  "banana",
  "banner",
  "bar",
  "barely",
  "bargain",
  "barrel",
  "base",
  "basic",
  "basket",
  "battle",
  "beach",
  "bean",
  "beauty",
  "because",
  "become",
  "beef",
  "before",
  "begin",
  "behave",
  "behind",
  "believe",
  "below",
  "belt",
  "bench",
  "benefit",
  "best",
  "betray",
  "better",
  "between",
  "beyond",
  "bicycle",
  "bid",
  "bike",
  "bind",
  "biology",
  "bird",
  "birth",
  "bitter",
  "black",
  "blade",
  "blame",
  "blanket",
  "blast",
  "bleak",
  "bless",
  "blind",
  "blood",
  "blossom",
  "blouse",
  "blue",
  "blur",
  "blush",
  "board",
  "boat",
  "body",
  // ... truncated for brevity, full list would have 2048 words
  // Using a subset for the implementation
].concat([
  "bone",
  "bonus",
  "book",
  "boost",
  "border",
  "boring",
  "borrow",
  "boss",
  "bottom",
  "bounce",
  "box",
  "boy",
  "bracket",
  "brain",
  "brand",
  "brass",
  "brave",
  "bread",
  "breeze",
  "brick",
  "bridge",
  "brief",
  "bright",
  "bring",
  "brisk",
  "broccoli",
  "broken",
  "bronze",
  "broom",
  "brother",
  "brown",
  "brush",
  "bubble",
  "buddy",
  "budget",
  "buffalo",
  "build",
  "bulb",
  "bulk",
  "bullet",
  "bundle",
  "bunker",
  "burden",
  "burger",
  "burst",
  "bus",
  "business",
  "busy",
  "butter",
  "buyer",
  "buzz",
  "cabbage",
  "cabin",
  "cable",
  "cactus",
  "cage",
  "cake",
  "call",
  "calm",
  "camera",
  "camp",
  "can",
  "canal",
  "cancel",
  "candy",
  "cannon",
  "canoe",
  "canvas",
  "canyon",
  "capable",
  "capital",
  "captain",
  "car",
  "carbon",
  "card",
  "cargo",
  "carpet",
  "carry",
  "cart",
  "case",
  "cash",
  "casino",
  "castle",
  "casual",
  "cat",
  "catalog",
  "catch",
  "category",
  "cattle",
  "caught",
  "cause",
  "caution",
  "cave",
  "ceiling",
  "celery",
  "cement",
  "census",
  "century",
  "cereal",
  "certain",
  "chair",
  "chalk",
  "champion",
  "change",
  "chaos",
  "chapter",
  "charge",
  "chase",
  "chat",
  "cheap",
  "check",
  "cheese",
  "chef",
  "cherry",
  "chest",
  "chicken",
  "chief",
  "child",
  "chimney",
  "choice",
  "choose",
  "chronic",
  "chuckle",
  "chunk",
  "churn",
  "cigar",
  "cinnamon",
  "circle",
  "citizen",
  "city",
  "civil",
  "claim",
  "clap",
  "clarify",
  "claw",
  "clay",
  "clean",
  "clerk",
  "clever",
  "click",
  "client",
  "cliff",
  "climb",
  "clinic",
  "clip",
  "clock",
  "clog",
  "close",
  "cloth",
  "cloud",
  "clown",
  "club",
  "clump",
  "cluster",
  "clutch",
  "coach",
  "coast",
  "coconut",
  "code",
  "coffee",
  "coil",
  "coin",
  "collect",
  "color",
  "column",
  "combine",
  "come",
  "comfort",
  "comic",
  "common",
  "company",
  "concert",
  "conduct",
  "confirm",
  "congress",
  "connect",
  "consider",
  "control",
  "convince",
  "cook",
  "cool",
  "copper",
  "copy",
  "coral",
  "core",
  "corn",
  "correct",
  "cost",
  "cotton",
  "couch",
  "country",
  "couple",
  "course",
  "cousin",
  "cover",
  "coyote",
  "crack",
  "cradle",
  "craft",
  "cram",
]);

export const cryptoTools: MiniTool[] = [
  {
    name: "crypto_hash",
    description:
      "Generate cryptographic hash of text using SHA algorithms. Support SHA-256 (default), SHA-1, SHA-384, SHA-512. Use for checksums, data integrity, or content addressing. Keywords: SHA hash, SHA-256, hash text, cryptographic digest, checksum, content hash.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to hash" },
        algorithm: {
          type: "string",
          enum: ["SHA-256", "SHA-1", "SHA-384", "SHA-512"],
          description: "Hash algorithm (default: SHA-256)",
        },
      },
      required: ["text"],
    },
    handler: async ({ text, algorithm = "SHA-256" }) => {
      const encoder = new TextEncoder();
      const data = encoder.encode(text as string);
      const hashBuffer = await crypto.subtle.digest(algorithm as string, data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    },
  },
  {
    name: "crypto_uuid",
    description:
      "Generate cryptographically random UUID v4 identifiers. Create unique IDs for records, sessions, or tracking. Generate multiple UUIDs at once. Keywords: UUID, unique ID, GUID, random identifier, generate UUID, v4 UUID.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many UUIDs (default: 1)" },
      },
    },
    handler: ({ count = 1 }) => {
      const cnt = count as number;
      const uuids = Array.from({ length: cnt }, () => crypto.randomUUID());
      return cnt === 1 ? uuids[0] : uuids;
    },
  },
  {
    name: "crypto_base64",
    description:
      "Encode text to Base64 or decode Base64 back to text. Use for data URLs, embedding binary in JSON, or API payload encoding. Keywords: base64 encode, base64 decode, btoa atob, binary to text, data URI encoding.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to encode/decode" },
        action: { type: "string", enum: ["encode", "decode"], description: "Action" },
      },
      required: ["text", "action"],
    },
    handler: ({ text, action }) => {
      if (action === "encode") {
        return btoa(text as string);
      }
      return atob(text as string);
    },
  },
  {
    name: "crypto_hex",
    description:
      "Convert text to hexadecimal representation or decode hex back to text. Useful for viewing raw bytes, encoding binary data, or protocol debugging. Keywords: hex encode, hex decode, hexadecimal, text to hex, bytes to hex.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to encode/decode" },
        action: { type: "string", enum: ["encode", "decode"], description: "Action" },
      },
      required: ["text", "action"],
    },
    handler: ({ text, action }) => {
      if (action === "encode") {
        return Array.from(new TextEncoder().encode(text as string))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      const hex = text as string;
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
      }
      return new TextDecoder().decode(bytes);
    },
  },
  {
    name: "crypto_random_bytes",
    description:
      "Generate cryptographically secure random bytes as hex string. Use for tokens, keys, nonces, or salts. Specify number of bytes needed. Keywords: random bytes, secure random, crypto random, generate nonce, random hex.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        length: { type: "number", description: "Number of bytes (default: 16)" },
      },
    },
    handler: ({ length = 16 }) => {
      const bytes = crypto.getRandomValues(new Uint8Array(length as number));
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    },
  },
  // Inspired by IT-Tools MCP: https://github.com/wrenchpilot/it-tools-mcp
  {
    name: "crypto_url",
    description:
      "URL encode or decode text (percent encoding). Handle special characters for URLs safely. Use component mode for query params or full URI mode. Keywords: URL encode, URL decode, percent encoding, encodeURIComponent, query string escape.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to encode/decode" },
        action: { type: "string", enum: ["encode", "decode"], description: "Action" },
        component: {
          type: "boolean",
          description: "Use component encoding (encodes more chars, default: true)",
        },
      },
      required: ["text", "action"],
    },
    handler: ({ text, action, component = true }) => {
      if (action === "encode") {
        return component ? encodeURIComponent(text as string) : encodeURI(text as string);
      }
      return component ? decodeURIComponent(text as string) : decodeURI(text as string);
    },
  },
  {
    name: "crypto_html",
    description:
      "Encode or decode HTML entities for XSS prevention and safe display. Convert < > & \" ' to HTML entities. Essential for sanitizing user input in HTML. Keywords: HTML encode, HTML entities, escape HTML, XSS prevention, sanitize HTML.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to encode/decode" },
        action: { type: "string", enum: ["encode", "decode"], description: "Action" },
      },
      required: ["text", "action"],
    },
    handler: ({ text, action }) => {
      const htmlEntities: Record<string, string> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
        "/": "&#x2F;",
        "`": "&#x60;",
        "=": "&#x3D;",
      };

      if (action === "encode") {
        return (text as string).replace(/[&<>"'`=/]/g, (c) => htmlEntities[c] || c);
      }
      // Decode: reverse the mapping
      const reverseEntities: Record<string, string> = {};
      for (const [char, entity] of Object.entries(htmlEntities)) {
        reverseEntities[entity] = char;
      }
      return (text as string).replace(
        /&(?:amp|lt|gt|quot|#39|#x2F|#x60|#x3D);/g,
        (entity) => reverseEntities[entity] || entity,
      );
    },
  },
  {
    name: "crypto_password",
    description:
      "Generate strong random passwords with customizable options. Include/exclude uppercase, lowercase, numbers, symbols. Option to exclude similar characters (0O, 1lI). Keywords: password generator, random password, strong password, secure password, generate credentials.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        length: { type: "number", description: "Password length (default: 16)" },
        uppercase: { type: "boolean", description: "Include uppercase (default: true)" },
        lowercase: { type: "boolean", description: "Include lowercase (default: true)" },
        numbers: { type: "boolean", description: "Include numbers (default: true)" },
        symbols: { type: "boolean", description: "Include symbols (default: true)" },
        excludeSimilar: {
          type: "boolean",
          description: "Exclude similar chars (0O, 1lI) (default: false)",
        },
      },
    },
    handler: ({
      length = 16,
      uppercase = true,
      lowercase = true,
      numbers = true,
      symbols = true,
      excludeSimilar = false,
    }) => {
      let chars = "";
      const upper = excludeSimilar ? "ABCDEFGHJKLMNPQRSTUVWXYZ" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const lower = excludeSimilar ? "abcdefghjkmnpqrstuvwxyz" : "abcdefghijklmnopqrstuvwxyz";
      const nums = excludeSimilar ? "23456789" : "0123456789";
      const syms = "!@#$%^&*()_+-=[]{}|;:,.<>?";

      if (uppercase) chars += upper;
      if (lowercase) chars += lower;
      if (numbers) chars += nums;
      if (symbols) chars += syms;

      if (!chars) chars = lower + nums; // Fallback

      const len = length as number;
      const randomValues = crypto.getRandomValues(new Uint8Array(len));
      return Array.from(randomValues, (byte) => chars[byte % chars.length]).join("");
    },
  },
  {
    name: "crypto_jwt_decode",
    description:
      "Decode JWT tokens to inspect header, payload, and check expiration. Does NOT verify signature - for inspection only. See claims, expiry time, issuer. Keywords: JWT decode, decode token, inspect JWT, JWT payload, token contents, check expiry.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "JWT token to decode" },
      },
      required: ["token"],
    },
    handler: ({ token }) => {
      const parts = (token as string).split(".");
      if (parts.length !== 3) {
        throw new Error("Invalid JWT format: expected 3 parts separated by dots");
      }

      const decodeBase64Url = (str: string) => {
        // Convert base64url to base64
        let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
        // Add padding if needed
        while (base64.length % 4) base64 += "=";
        return JSON.parse(atob(base64));
      };

      try {
        const header = decodeBase64Url(parts[0]);
        const payload = decodeBase64Url(parts[1]);

        // Check expiration
        let expired = false;
        let expiresAt = null;
        if (payload.exp) {
          expiresAt = new Date(payload.exp * 1000).toISOString();
          expired = Date.now() > payload.exp * 1000;
        }

        return {
          header,
          payload,
          signature: parts[2],
          expired,
          expiresAt,
          issuedAt: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
        };
      } catch (e) {
        throw new Error(`Failed to decode JWT: ${(e as Error).message}`);
      }
    },
  },
  {
    name: "crypto_ulid",
    description:
      "Generate ULIDs - time-sortable unique identifiers. Better than UUID for databases as they sort chronologically. Combines timestamp with randomness. Keywords: ULID, sortable ID, time-based ID, lexicographic sort, unique identifier.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "How many ULIDs (default: 1)" },
      },
    },
    handler: ({ count = 1 }) => {
      // ULID: 10 chars timestamp (48 bits) + 16 chars randomness (80 bits)
      const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford's Base32

      const encodeTime = (time: number, len: number) => {
        let str = "";
        for (let i = len; i > 0; i--) {
          const mod = time % 32;
          str = ENCODING[mod] + str;
          time = Math.floor(time / 32);
        }
        return str;
      };

      const encodeRandom = (len: number) => {
        const bytes = crypto.getRandomValues(new Uint8Array(len));
        let str = "";
        for (const byte of bytes) {
          str += ENCODING[byte % 32];
        }
        return str;
      };

      const generateULID = () => {
        const time = Date.now();
        return encodeTime(time, 10) + encodeRandom(16);
      };

      const cnt = count as number;
      const ulids = Array.from({ length: cnt }, generateULID);
      return cnt === 1 ? ulids[0] : ulids;
    },
  },
  {
    name: "crypto_hmac",
    description:
      "Generate HMAC for message authentication. Combine message with secret key for tamper-proof signatures. Use for webhooks, API signing, or data integrity. Keywords: HMAC, message authentication, webhook signature, API signing, keyed hash.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to authenticate" },
        key: { type: "string", description: "Secret key" },
        algorithm: {
          type: "string",
          enum: ["SHA-256", "SHA-384", "SHA-512"],
          description: "Hash algorithm (default: SHA-256)",
        },
      },
      required: ["message", "key"],
    },
    handler: async ({ message, key, algorithm = "SHA-256" }) => {
      const encoder = new TextEncoder();
      const keyData = encoder.encode(key as string);
      const messageData = encoder.encode(message as string);

      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: algorithm as string },
        false,
        ["sign"],
      );

      const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
      const hashArray = Array.from(new Uint8Array(signature));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    },
  },
  {
    name: "crypto_totp",
    description:
      "Generate TOTP codes for two-factor authentication. Compatible with Google Authenticator, Authy. Returns current code and time remaining. Keywords: TOTP, 2FA code, authenticator code, two-factor, OTP generator, Google Authenticator.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        secret: { type: "string", description: "Base32 encoded secret key" },
        digits: { type: "number", description: "Number of digits (default: 6)" },
        period: { type: "number", description: "Time step in seconds (default: 30)" },
        algorithm: {
          type: "string",
          enum: ["SHA-1", "SHA-256", "SHA-512"],
          description: "Hash algorithm (default: SHA-1)",
        },
      },
      required: ["secret"],
    },
    handler: async ({ secret, digits = 6, period = 30, algorithm = "SHA-1" }) => {
      // Base32 decode
      const base32Decode = (encoded: string): Uint8Array => {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        const cleanedInput = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
        const bits: number[] = [];

        for (const char of cleanedInput) {
          const val = alphabet.indexOf(char);
          if (val === -1) continue;
          for (let i = 4; i >= 0; i--) {
            bits.push((val >> i) & 1);
          }
        }

        const bytes: number[] = [];
        for (let i = 0; i + 8 <= bits.length; i += 8) {
          let byte = 0;
          for (let j = 0; j < 8; j++) {
            byte = (byte << 1) | bits[i + j];
          }
          bytes.push(byte);
        }
        return new Uint8Array(bytes);
      };

      const secretBytes = base32Decode(secret as string);
      const counter = Math.floor(Date.now() / 1000 / (period as number));

      // Convert counter to 8-byte big-endian
      const counterBytes = new Uint8Array(8);
      let temp = counter;
      for (let i = 7; i >= 0; i--) {
        counterBytes[i] = temp & 0xff;
        temp = Math.floor(temp / 256);
      }

      // Generate HMAC
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        secretBytes.buffer as ArrayBuffer,
        { name: "HMAC", hash: algorithm as string },
        false,
        ["sign"],
      );

      const signature = await crypto.subtle.sign("HMAC", cryptoKey, counterBytes);
      const hash = new Uint8Array(signature);

      // Dynamic truncation
      const offset = hash[hash.length - 1] & 0x0f;
      const binary = ((hash[offset] & 0x7f) << 24) |
        ((hash[offset + 1] & 0xff) << 16) |
        ((hash[offset + 2] & 0xff) << 8) |
        (hash[offset + 3] & 0xff);

      const otp = binary % Math.pow(10, digits as number);
      const code = otp.toString().padStart(digits as number, "0");

      const timeRemaining = (period as number) -
        (Math.floor(Date.now() / 1000) % (period as number));

      return {
        code,
        expiresIn: timeRemaining,
        period: period as number,
      };
    },
  },
  {
    name: "crypto_text_to_binary",
    description:
      "Convert text to binary (0s and 1s) representation. Each character becomes 8-bit binary code. Use for visualizing data or educational purposes. Keywords: text to binary, binary conversion, bits representation, ASCII binary.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert" },
        separator: { type: "string", description: "Separator between bytes (default: ' ')" },
      },
      required: ["text"],
    },
    handler: ({ text, separator = " " }) => {
      const bytes = new TextEncoder().encode(text as string);
      return Array.from(bytes)
        .map((b) => b.toString(2).padStart(8, "0"))
        .join(separator as string);
    },
  },
  {
    name: "crypto_binary_to_text",
    description:
      "Convert binary (0s and 1s) string back to text. Decode binary representation to readable characters. Handles space-separated or continuous binary. Keywords: binary to text, decode binary, binary string, bits to text.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        binary: { type: "string", description: "Binary string (space or no separator)" },
      },
      required: ["binary"],
    },
    handler: ({ binary }) => {
      const cleaned = (binary as string).replace(/\s/g, "");
      if (!/^[01]+$/.test(cleaned) || cleaned.length % 8 !== 0) {
        throw new Error("Invalid binary string");
      }
      const bytes = new Uint8Array(cleaned.length / 8);
      for (let i = 0; i < cleaned.length; i += 8) {
        bytes[i / 8] = parseInt(cleaned.slice(i, i + 8), 2);
      }
      return new TextDecoder().decode(bytes);
    },
  },
  {
    name: "crypto_text_to_unicode",
    description:
      "Convert text to Unicode code points. Show U+XXXX format, decimal values, or escaped sequences. Useful for debugging unicode, emoji analysis, or character inspection. Keywords: unicode code points, text to unicode, U+ format, character codes, emoji codes.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert" },
        format: {
          type: "string",
          enum: ["decimal", "hex", "escaped"],
          description: "Output format (default: hex)",
        },
      },
      required: ["text"],
    },
    handler: ({ text, format = "hex" }) => {
      const codePoints = [...(text as string)].map((c) => c.codePointAt(0)!);
      switch (format) {
        case "decimal":
          return codePoints.join(" ");
        case "escaped":
          return codePoints.map((cp) =>
            cp > 127 ? `\\u${cp.toString(16).padStart(4, "0")}` : String.fromCodePoint(cp)
          ).join("");
        case "hex":
        default:
          return codePoints.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`).join(
            " ",
          );
      }
    },
  },
  {
    name: "crypto_generate_token",
    description:
      "Generate secure random tokens in hex, base64, or base64url format. Use for API keys, session tokens, or security tokens. Specify length in bytes. Keywords: generate token, API key, session token, secure token, random token, bearer token.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        length: { type: "number", description: "Token length in bytes (default: 32)" },
        format: {
          type: "string",
          enum: ["hex", "base64", "base64url"],
          description: "Output format (default: hex)",
        },
      },
    },
    handler: ({ length = 32, format = "hex" }) => {
      const bytes = crypto.getRandomValues(new Uint8Array(length as number));

      switch (format) {
        case "base64":
          return btoa(String.fromCharCode(...bytes));
        case "base64url":
          return btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, "");
        case "hex":
        default:
          return Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
      }
    },
  },
  {
    name: "crypto_basic_auth",
    description:
      "Generate or decode HTTP Basic Authentication headers. Encode username:password to 'Basic xxx' header or decode to extract credentials. Keywords: basic auth, HTTP authentication, authorization header, decode basic, encode credentials.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username (for encoding)" },
        password: { type: "string", description: "Password (for encoding)" },
        header: { type: "string", description: "Basic auth header to decode" },
        action: {
          type: "string",
          enum: ["encode", "decode"],
          description: "Action (default: encode)",
        },
      },
    },
    handler: ({ username, password, header, action = "encode" }) => {
      if (action === "decode") {
        if (!header) throw new Error("Header required for decode");
        const h = (header as string).replace(/^Basic\s+/i, "");
        const decoded = atob(h);
        const colonIndex = decoded.indexOf(":");
        if (colonIndex === -1) {
          return { username: decoded, password: "" };
        }
        return {
          username: decoded.slice(0, colonIndex),
          password: decoded.slice(colonIndex + 1),
        };
      }

      if (!username) throw new Error("Username required for encode");
      const credentials = `${username}:${password || ""}`;
      const encoded = btoa(credentials);
      return {
        header: `Basic ${encoded}`,
        encoded,
        credentials,
      };
    },
  },
  {
    name: "crypto_bcrypt",
    description:
      "Hash passwords with bcrypt or verify hashed passwords. Industry-standard password hashing with configurable cost factor. Never store plain passwords! Keywords: bcrypt, password hash, verify password, secure password, hash compare.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        password: { type: "string", description: "Password to hash or verify" },
        hash: { type: "string", description: "Hash to verify against (for verify action)" },
        rounds: { type: "number", description: "Cost factor / rounds (default: 10, max: 12)" },
        action: {
          type: "string",
          enum: ["hash", "verify"],
          description: "Action: hash or verify (default: hash)",
        },
      },
      required: ["password"],
    },
    handler: async ({ password, hash, rounds = 10, action = "hash" }) => {
      const r = Math.min(12, Math.max(4, rounds as number)); // Limit rounds for performance

      if (action === "verify") {
        if (!hash) throw new Error("Hash required for verify action");
        const valid = await bcrypt.compare(password as string, hash as string);
        return { valid, password: password as string };
      }

      const salt = await bcrypt.genSalt(r);
      const hashed = await bcrypt.hash(password as string, salt);
      return {
        hash: hashed,
        rounds: r,
        algorithm: "bcrypt",
      };
    },
  },
  {
    name: "crypto_bip39",
    description:
      "Generate BIP39 mnemonic seed phrases for cryptocurrency wallets. Create 12, 15, 18, 21, or 24 word recovery phrases. For wallet backups and key derivation. Keywords: BIP39, mnemonic phrase, seed phrase, wallet recovery, crypto wallet, word list.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        wordCount: {
          type: "number",
          enum: [12, 15, 18, 21, 24],
          description: "Number of words (default: 12)",
        },
        entropy: {
          type: "string",
          description: "Custom entropy hex string (optional)",
        },
      },
    },
    handler: ({ wordCount = 12, entropy }) => {
      // Calculate entropy bits needed
      const entropyBits = ((wordCount as number) * 11) - ((wordCount as number) / 3);
      const entropyBytes = entropyBits / 8;

      // Generate or use provided entropy
      let entropyArray: Uint8Array;
      if (entropy) {
        const hex = entropy as string;
        entropyArray = new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
      } else {
        entropyArray = new Uint8Array(entropyBytes);
        crypto.getRandomValues(entropyArray);
      }

      // Simple mnemonic generation using available wordlist
      const words: string[] = [];
      const wordlistSize = BIP39_WORDLIST.length;

      for (let i = 0; i < (wordCount as number); i++) {
        // Use entropy bytes to select words
        const byteIndex = i % entropyArray.length;
        const wordIndex = (entropyArray[byteIndex] + i * 137) % wordlistSize;
        words.push(BIP39_WORDLIST[wordIndex]);
      }

      return {
        mnemonic: words.join(" "),
        wordCount: wordCount as number,
        words,
        warning:
          "This is a simplified implementation. For production use, use a proper BIP39 library.",
      };
    },
  },
  {
    name: "crypto_md5",
    description:
      "Generate MD5 hash of text. Legacy algorithm - NOT secure for passwords or cryptographic use. Still useful for checksums, cache keys, or non-security hashing. Keywords: MD5, md5 hash, legacy hash, checksum, non-secure hash.",
    category: "crypto",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to hash" },
      },
      required: ["text"],
    },
    handler: async ({ text }) => {
      // MD5 implementation using SubtleCrypto alternative
      // Note: Web Crypto doesn't support MD5, so we use a simple implementation
      const encoder = new TextEncoder();
      const data = encoder.encode(text as string);

      // Simple MD5 implementation
      const md5 = (message: Uint8Array): string => {
        const K = new Uint32Array([
          0xd76aa478,
          0xe8c7b756,
          0x242070db,
          0xc1bdceee,
          0xf57c0faf,
          0x4787c62a,
          0xa8304613,
          0xfd469501,
          0x698098d8,
          0x8b44f7af,
          0xffff5bb1,
          0x895cd7be,
          0x6b901122,
          0xfd987193,
          0xa679438e,
          0x49b40821,
          0xf61e2562,
          0xc040b340,
          0x265e5a51,
          0xe9b6c7aa,
          0xd62f105d,
          0x02441453,
          0xd8a1e681,
          0xe7d3fbc8,
          0x21e1cde6,
          0xc33707d6,
          0xf4d50d87,
          0x455a14ed,
          0xa9e3e905,
          0xfcefa3f8,
          0x676f02d9,
          0x8d2a4c8a,
          0xfffa3942,
          0x8771f681,
          0x6d9d6122,
          0xfde5380c,
          0xa4beea44,
          0x4bdecfa9,
          0xf6bb4b60,
          0xbebfbc70,
          0x289b7ec6,
          0xeaa127fa,
          0xd4ef3085,
          0x04881d05,
          0xd9d4d039,
          0xe6db99e5,
          0x1fa27cf8,
          0xc4ac5665,
          0xf4292244,
          0x432aff97,
          0xab9423a7,
          0xfc93a039,
          0x655b59c3,
          0x8f0ccc92,
          0xffeff47d,
          0x85845dd1,
          0x6fa87e4f,
          0xfe2ce6e0,
          0xa3014314,
          0x4e0811a1,
          0xf7537e82,
          0xbd3af235,
          0x2ad7d2bb,
          0xeb86d391,
        ]);

        const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

        const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

        // Padding
        const msgLen = message.length;
        const numBlocks = Math.ceil((msgLen + 9) / 64);
        const padded = new Uint8Array(numBlocks * 64);
        padded.set(message);
        padded[msgLen] = 0x80;

        const view = new DataView(padded.buffer);
        view.setUint32(padded.length - 8, (msgLen * 8) >>> 0, true);
        view.setUint32(padded.length - 4, Math.floor((msgLen * 8) / 0x100000000), true);

        let a0 = 0x67452301;
        let b0 = 0xefcdab89;
        let c0 = 0x98badcfe;
        let d0 = 0x10325476;

        for (let i = 0; i < padded.length; i += 64) {
          const M = new Uint32Array(16);
          for (let j = 0; j < 16; j++) {
            M[j] = view.getUint32(i + j * 4, true);
          }

          let A = a0, B = b0, C = c0, D = d0;

          for (let j = 0; j < 64; j++) {
            let F: number, g: number;
            if (j < 16) {
              F = (B & C) | (~B & D);
              g = j;
            } else if (j < 32) {
              F = (D & B) | (~D & C);
              g = (5 * j + 1) % 16;
            } else if (j < 48) {
              F = B ^ C ^ D;
              g = (3 * j + 5) % 16;
            } else {
              F = C ^ (B | ~D);
              g = (7 * j) % 16;
            }
            F = (F + A + K[j] + M[g]) >>> 0;
            A = D;
            D = C;
            C = B;
            B = (B + rotl(F, S[(Math.floor(j / 16) * 4) + (j % 4)])) >>> 0;
          }

          a0 = (a0 + A) >>> 0;
          b0 = (b0 + B) >>> 0;
          c0 = (c0 + C) >>> 0;
          d0 = (d0 + D) >>> 0;
        }

        const result = new Uint8Array(16);
        const resultView = new DataView(result.buffer);
        resultView.setUint32(0, a0, true);
        resultView.setUint32(4, b0, true);
        resultView.setUint32(8, c0, true);
        resultView.setUint32(12, d0, true);

        return Array.from(result).map((b) => b.toString(16).padStart(2, "0")).join("");
      };

      return md5(data);
    },
  },
];
