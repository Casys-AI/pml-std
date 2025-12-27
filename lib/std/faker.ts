/**
 * Mock data generation tools
 *
 * Generate realistic fake data for testing and development.
 *
 * @module lib/std/faker
 */

import type { MiniTool } from "./types.ts";

// Seed-based random for reproducibility
let seed = Date.now();
const seededRandom = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const pick = <T>(arr: T[]): T => arr[Math.floor(seededRandom() * arr.length)];
const pickN = <T>(arr: T[], n: number): T[] => {
  const shuffled = [...arr].sort(() => seededRandom() - 0.5);
  return shuffled.slice(0, n);
};

// Data pools
const firstNames = [
  "James",
  "Mary",
  "John",
  "Patricia",
  "Robert",
  "Jennifer",
  "Michael",
  "Linda",
  "William",
  "Elizabeth",
  "David",
  "Barbara",
  "Richard",
  "Susan",
  "Joseph",
  "Jessica",
  "Thomas",
  "Sarah",
  "Charles",
  "Karen",
  "Emma",
  "Liam",
  "Olivia",
  "Noah",
  "Ava",
  "Oliver",
  "Isabella",
  "Lucas",
  "Sophia",
  "Mason",
];
const lastNames = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
  "Moore",
  "Jackson",
  "Martin",
  "Lee",
  "Perez",
  "Thompson",
  "White",
  "Harris",
  "Sanchez",
  "Clark",
  "Ramirez",
  "Lewis",
  "Robinson",
];
const domains = [
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "protonmail.com",
  "icloud.com",
  "mail.com",
  "example.com",
];
const streetTypes = [
  "Street",
  "Avenue",
  "Boulevard",
  "Drive",
  "Lane",
  "Road",
  "Way",
  "Place",
  "Court",
  "Circle",
];
const cities = [
  "New York",
  "Los Angeles",
  "Chicago",
  "Houston",
  "Phoenix",
  "Philadelphia",
  "San Antonio",
  "San Diego",
  "Dallas",
  "San Jose",
  "Austin",
  "Jacksonville",
  "Fort Worth",
  "Columbus",
  "Charlotte",
  "Seattle",
  "Denver",
  "Boston",
  "Portland",
  "Miami",
];
const states = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
];
const companies = [
  "Acme Corp",
  "Globex",
  "Initech",
  "Umbrella Corp",
  "Stark Industries",
  "Wayne Enterprises",
  "Cyberdyne",
  "Tyrell Corp",
  "Aperture Science",
  "Weyland-Yutani",
];
const jobTitles = [
  "Software Engineer",
  "Product Manager",
  "Data Scientist",
  "UX Designer",
  "DevOps Engineer",
  "Marketing Manager",
  "Sales Representative",
  "Financial Analyst",
  "HR Specialist",
  "Project Manager",
  "QA Engineer",
  "Technical Writer",
  "System Administrator",
  "Business Analyst",
  "Customer Support",
];
const loremWords = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "et",
  "dolore",
  "magna",
  "aliqua",
  "enim",
  "ad",
  "minim",
  "veniam",
  "quis",
  "nostrud",
  "exercitation",
  "ullamco",
  "laboris",
  "nisi",
  "aliquip",
];
const colors = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "brown",
  "gray",
  "black",
  "white",
  "cyan",
  "magenta",
  "lime",
  "teal",
  "navy",
  "maroon",
  "olive",
  "aqua",
  "silver",
];
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
];

export const fakerTools: MiniTool[] = [
  {
    name: "faker_seed",
    description:
      "Set random seed for reproducible fake data generation. Same seed produces identical sequence of random values. Use for deterministic tests, consistent fixtures, or reproducible demos. Keywords: random seed, reproducible, deterministic, seed random, consistent data, test fixtures.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "number", description: "Seed value" },
      },
      required: ["seed"],
    },
    handler: ({ seed: s }) => {
      seed = s as number;
      return { seed, message: "Seed set successfully" };
    },
  },
  {
    name: "faker_person",
    description:
      "Generate fake person data with name, email, phone, and optional details. Create realistic user profiles for testing user management, profiles, or contact systems. Use for test data, demos, or user simulation. Keywords: fake person, random user, test user, mock profile, generate name, fake identity.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of people to generate (default: 1)" },
        includeAddress: { type: "boolean", description: "Include address (default: false)" },
        includeJob: { type: "boolean", description: "Include job info (default: false)" },
      },
    },
    handler: ({ count = 1, includeAddress = false, includeJob = false }) => {
      const people = [];
      for (let i = 0; i < (count as number); i++) {
        const firstName = pick(firstNames);
        const lastName = pick(lastNames);
        const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${
          Math.floor(seededRandom() * 100)
        }@${pick(domains)}`;
        const phone = `+1-${Math.floor(200 + seededRandom() * 800)}-${
          Math.floor(100 + seededRandom() * 900)
        }-${Math.floor(1000 + seededRandom() * 9000)}`;

        const person: Record<string, unknown> = {
          firstName,
          lastName,
          fullName: `${firstName} ${lastName}`,
          email,
          phone,
          age: Math.floor(18 + seededRandom() * 62),
          gender: seededRandom() > 0.5 ? "male" : "female",
        };

        if (includeAddress) {
          person.address = {
            street: `${Math.floor(100 + seededRandom() * 9900)} ${pick(lastNames)} ${
              pick(streetTypes)
            }`,
            city: pick(cities),
            state: pick(states),
            zipCode: String(Math.floor(10000 + seededRandom() * 90000)),
            country: "United States",
          };
        }

        if (includeJob) {
          person.job = {
            title: pick(jobTitles),
            company: pick(companies),
            department: pick(["Engineering", "Sales", "Marketing", "Finance", "HR", "Operations"]),
          };
        }

        people.push(person);
      }

      return (count as number) === 1 ? people[0] : people;
    },
  },
  {
    name: "faker_email",
    description:
      "Generate realistic fake email addresses. Create random emails with various providers for testing email validation, signup flows, or contact forms. Use for form testing, user generation, or email validation. Keywords: fake email, random email, test email, mock email, generate email, email address.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of emails (default: 1)" },
        domain: { type: "string", description: "Specific domain to use" },
        provider: {
          type: "string",
          enum: ["random", "gmail", "yahoo", "outlook", "company"],
          description: "Email provider type",
        },
      },
    },
    handler: ({ count = 1, domain, provider = "random" }) => {
      const emails = [];
      for (let i = 0; i < (count as number); i++) {
        const name = `${pick(firstNames).toLowerCase()}${pick([".", "_", ""])}${
          pick(lastNames).toLowerCase()
        }${Math.floor(seededRandom() * 1000)}`;

        let emailDomain = domain as string;
        if (!emailDomain) {
          switch (provider) {
            case "gmail":
              emailDomain = "gmail.com";
              break;
            case "yahoo":
              emailDomain = "yahoo.com";
              break;
            case "outlook":
              emailDomain = "outlook.com";
              break;
            case "company":
              emailDomain = `${pick(companies).toLowerCase().replace(/\s+/g, "")}.com`;
              break;
            default:
              emailDomain = pick(domains);
          }
        }

        emails.push(`${name}@${emailDomain}`);
      }

      return (count as number) === 1 ? emails[0] : emails;
    },
  },
  {
    name: "faker_phone",
    description:
      "Generate fake phone numbers in various formats. Create random phone numbers for US, international, or custom formats. Use for form testing, contact data, or phone validation. Keywords: fake phone, random phone, test phone, mock phone, generate phone, phone number.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of phones (default: 1)" },
        format: {
          type: "string",
          enum: ["us", "international", "simple"],
          description: "Phone format (default: 'us')",
        },
      },
    },
    handler: ({ count = 1, format = "us" }) => {
      const phones = [];
      for (let i = 0; i < (count as number); i++) {
        const area = Math.floor(200 + seededRandom() * 800);
        const exchange = Math.floor(200 + seededRandom() * 800);
        const number = Math.floor(1000 + seededRandom() * 9000);

        let phone: string;
        switch (format) {
          case "international":
            phone = `+1 (${area}) ${exchange}-${number}`;
            break;
          case "simple":
            phone = `${area}${exchange}${number}`;
            break;
          default: // us
            phone = `(${area}) ${exchange}-${number}`;
        }
        phones.push(phone);
      }

      return (count as number) === 1 ? phones[0] : phones;
    },
  },
  {
    name: "faker_address",
    description:
      "Generate fake street addresses with city, state, zip. Create realistic US addresses for testing location forms, shipping, or address validation. Use for form testing, user profiles, or location data. Keywords: fake address, random address, test address, mock location, generate address, street address.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of addresses (default: 1)" },
        country: { type: "string", description: "Country (default: 'United States')" },
      },
    },
    handler: ({ count = 1, country = "United States" }) => {
      const addresses = [];
      for (let i = 0; i < (count as number); i++) {
        addresses.push({
          street: `${Math.floor(1 + seededRandom() * 9999)} ${pick(lastNames)} ${
            pick(streetTypes)
          }`,
          apartment: seededRandom() > 0.7
            ? `Apt ${Math.floor(1 + seededRandom() * 500)}`
            : undefined,
          city: pick(cities),
          state: pick(states),
          zipCode: String(Math.floor(10000 + seededRandom() * 90000)),
          country: country as string,
          coordinates: {
            lat: 25 + seededRandom() * 23, // US latitude range
            lng: -125 + seededRandom() * 58, // US longitude range
          },
        });
      }

      return (count as number) === 1 ? addresses[0] : addresses;
    },
  },
  {
    name: "faker_company",
    description:
      "Generate fake company data with name, industry, and details. Create realistic business entities for testing B2B features, CRM systems, or business directories. Use for test data, demos, or company simulation. Keywords: fake company, random business, test company, mock company, generate business, company name.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of companies (default: 1)" },
      },
    },
    handler: ({ count = 1 }) => {
      const industries = [
        "Technology",
        "Healthcare",
        "Finance",
        "Retail",
        "Manufacturing",
        "Education",
        "Real Estate",
        "Consulting",
        "Media",
        "Transportation",
      ];
      const suffixes = [
        "Inc",
        "LLC",
        "Corp",
        "Co",
        "Ltd",
        "Group",
        "Solutions",
        "Systems",
        "Technologies",
        "Industries",
      ];

      const companiesList = [];
      for (let i = 0; i < (count as number); i++) {
        const name = seededRandom() > 0.5
          ? `${pick(lastNames)} ${pick(suffixes)}`
          : `${
            pick(["Global", "Advanced", "Premier", "United", "National", "Pacific", "Atlantic"])
          } ${pick(["Tech", "Solutions", "Services", "Industries", "Systems"])}`;

        companiesList.push({
          name,
          industry: pick(industries),
          founded: Math.floor(1950 + seededRandom() * 74),
          employees: Math.floor(10 + seededRandom() * 10000),
          revenue: `$${Math.floor(1 + seededRandom() * 999)}M`,
          website: `https://www.${name.toLowerCase().replace(/\s+/g, "")}.com`,
          phone: `+1-800-${Math.floor(100 + seededRandom() * 900)}-${
            Math.floor(1000 + seededRandom() * 9000)
          }`,
        });
      }

      return (count as number) === 1 ? companiesList[0] : companiesList;
    },
  },
  {
    name: "faker_lorem",
    description:
      "Generate Lorem Ipsum placeholder text. Create paragraphs, sentences, or words of fake Latin text for UI mockups, content placeholders, or testing layouts. Use for wireframes, prototypes, or content testing. Keywords: lorem ipsum, placeholder text, fake text, dummy text, sample text, filler content.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["words", "sentences", "paragraphs"],
          description: "Output type (default: 'paragraphs')",
        },
        count: { type: "number", description: "Number of units (default: 1)" },
      },
    },
    handler: ({ type = "paragraphs", count = 1 }) => {
      const generateSentence = () => {
        const wordCount = 5 + Math.floor(seededRandom() * 10);
        const words = pickN(loremWords, wordCount);
        words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
        return words.join(" ") + ".";
      };

      const generateParagraph = () => {
        const sentenceCount = 3 + Math.floor(seededRandom() * 5);
        return Array(sentenceCount).fill(null).map(generateSentence).join(" ");
      };

      switch (type) {
        case "words":
          return pickN(loremWords, count as number).join(" ");
        case "sentences":
          return Array(count as number).fill(null).map(generateSentence).join(" ");
        default: // paragraphs
          return Array(count as number).fill(null).map(generateParagraph).join("\n\n");
      }
    },
  },
  {
    name: "faker_uuid",
    description:
      "Generate random UUID v4 identifiers. Create unique identifiers for database records, API resources, or tracking. Use for test IDs, mock data, or unique identifiers. Keywords: UUID, GUID, unique ID, random ID, generate UUID, identifier.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of UUIDs (default: 1)" },
      },
    },
    handler: ({ count = 1 }) => {
      const generateUUID = () => {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = Math.floor(seededRandom() * 16);
          const v = c === "x" ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      };

      const uuids = Array(count as number).fill(null).map(generateUUID);
      return (count as number) === 1 ? uuids[0] : uuids;
    },
  },
  {
    name: "faker_date",
    description:
      "Generate random dates within a range. Create fake dates for testing date pickers, scheduling, or time-based features. Supports past, future, or custom date ranges. Use for test data, event simulation, or date validation. Keywords: fake date, random date, test date, mock date, generate date, date range.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of dates (default: 1)" },
        from: { type: "string", description: "Start date (ISO format, default: 1 year ago)" },
        to: { type: "string", description: "End date (ISO format, default: now)" },
        format: {
          type: "string",
          enum: ["iso", "date", "datetime", "unix"],
          description: "Output format (default: 'iso')",
        },
      },
    },
    handler: ({ count = 1, from, to, format = "iso" }) => {
      const now = Date.now();
      const yearAgo = now - 365 * 24 * 60 * 60 * 1000;

      const fromDate = from ? new Date(from as string).getTime() : yearAgo;
      const toDate = to ? new Date(to as string).getTime() : now;

      const dates = [];
      for (let i = 0; i < (count as number); i++) {
        const timestamp = fromDate + seededRandom() * (toDate - fromDate);
        const date = new Date(timestamp);

        let formatted: string | number;
        switch (format) {
          case "date":
            formatted = date.toISOString().split("T")[0];
            break;
          case "datetime":
            formatted = date.toISOString().replace("T", " ").slice(0, 19);
            break;
          case "unix":
            formatted = Math.floor(timestamp / 1000);
            break;
          default: // iso
            formatted = date.toISOString();
        }

        dates.push(formatted);
      }

      return (count as number) === 1 ? dates[0] : dates;
    },
  },
  {
    name: "faker_number",
    description:
      "Generate random numbers within range with optional precision. Create fake numeric data for testing calculations, statistics, or numeric inputs. Use for test values, mock metrics, or random integers/floats. Keywords: random number, fake number, test number, mock number, generate number, random integer.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        min: { type: "number", description: "Minimum value (default: 0)" },
        max: { type: "number", description: "Maximum value (default: 100)" },
        count: { type: "number", description: "Number of values (default: 1)" },
        precision: { type: "number", description: "Decimal places (default: 0 for integers)" },
      },
    },
    handler: ({ min = 0, max = 100, count = 1, precision = 0 }) => {
      const numbers = [];
      for (let i = 0; i < (count as number); i++) {
        let num = (min as number) + seededRandom() * ((max as number) - (min as number));
        if ((precision as number) === 0) {
          num = Math.floor(num);
        } else {
          const factor = Math.pow(10, precision as number);
          num = Math.round(num * factor) / factor;
        }
        numbers.push(num);
      }

      return (count as number) === 1 ? numbers[0] : numbers;
    },
  },
  {
    name: "faker_boolean",
    description:
      "Generate random boolean values with optional probability. Create true/false values for testing toggles, flags, or conditional logic. Use for feature flags, A/B testing, or random decisions. Keywords: random boolean, fake boolean, test flag, mock boolean, true false, coin flip.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of booleans (default: 1)" },
        probability: { type: "number", description: "Probability of true (0-1, default: 0.5)" },
      },
    },
    handler: ({ count = 1, probability = 0.5 }) => {
      const booleans = Array(count as number).fill(null).map(() =>
        seededRandom() < (probability as number)
      );
      return (count as number) === 1 ? booleans[0] : booleans;
    },
  },
  {
    name: "faker_color",
    description:
      "Generate random colors in various formats. Create fake colors as hex, RGB, HSL, or named colors for testing color pickers or UI themes. Use for design testing, random palettes, or color validation. Keywords: random color, fake color, hex color, RGB color, generate color, color picker.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of colors (default: 1)" },
        format: {
          type: "string",
          enum: ["hex", "rgb", "hsl", "name"],
          description: "Color format (default: 'hex')",
        },
      },
    },
    handler: ({ count = 1, format = "hex" }) => {
      const generateColor = () => {
        const r = Math.floor(seededRandom() * 256);
        const g = Math.floor(seededRandom() * 256);
        const b = Math.floor(seededRandom() * 256);

        switch (format) {
          case "rgb":
            return `rgb(${r}, ${g}, ${b})`;
          case "hsl": {
            const max = Math.max(r, g, b) / 255;
            const min = Math.min(r, g, b) / 255;
            const l = (max + min) / 2;
            let h = 0, s = 0;
            if (max !== min) {
              const d = max - min;
              s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
              if (max === r / 255) h = ((g - b) / 255 / d + (g < b ? 6 : 0)) / 6;
              else if (max === g / 255) h = ((b - r) / 255 / d + 2) / 6;
              else h = ((r - g) / 255 / d + 4) / 6;
            }
            return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
          }
          case "name":
            return pick(colors);
          default: // hex
            return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${
              b.toString(16).padStart(2, "0")
            }`;
        }
      };

      const colorList = Array(count as number).fill(null).map(generateColor);
      return (count as number) === 1 ? colorList[0] : colorList;
    },
  },
  {
    name: "faker_url",
    description:
      "Generate fake URLs for websites, APIs, or resources. Create realistic URLs for testing link validation, web scraping, or URL parsing. Use for test links, mock APIs, or URL validation. Keywords: fake URL, random URL, test URL, mock link, generate URL, website URL.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of URLs (default: 1)" },
        type: {
          type: "string",
          enum: ["website", "api", "image", "file"],
          description: "URL type (default: 'website')",
        },
      },
    },
    handler: ({ count = 1, type = "website" }) => {
      const urls = [];
      for (let i = 0; i < (count as number); i++) {
        const domain = `${pick(["www.", ""])}${pick(lastNames).toLowerCase()}${
          pick(["tech", "app", "io", "dev", "co", ""])
        }.${pick(["com", "org", "net", "io", "dev"])}`;

        let url: string;
        switch (type) {
          case "api":
            url = `https://api.${domain}/v${Math.floor(1 + seededRandom() * 3)}/${
              pick(["users", "posts", "items", "data", "resources"])
            }`;
            break;
          case "image":
            url = `https://${domain}/images/${Math.floor(seededRandom() * 1000)}.${
              pick(["jpg", "png", "gif", "webp"])
            }`;
            break;
          case "file":
            url = `https://${domain}/files/${pick(["document", "report", "data", "export"])}-${
              Math.floor(seededRandom() * 1000)
            }.${pick(["pdf", "csv", "xlsx", "zip"])}`;
            break;
          default: // website
            url = `https://${domain}/${
              seededRandom() > 0.5 ? pick(["about", "contact", "products", "services", "blog"]) : ""
            }`;
        }

        urls.push(url);
      }

      return (count as number) === 1 ? urls[0] : urls;
    },
  },
  {
    name: "faker_user_agent",
    description:
      "Generate random browser user agent strings. Create realistic UA strings for testing browser detection, responsive features, or device simulation. Use for web testing, crawling, or device emulation. Keywords: user agent, browser string, UA string, fake browser, device emulation, web testing.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of user agents (default: 1)" },
      },
    },
    handler: ({ count = 1 }) => {
      const agents = Array(count as number).fill(null).map(() => pick(userAgents));
      return (count as number) === 1 ? agents[0] : agents;
    },
  },
  {
    name: "faker_ip",
    description:
      "Generate random IP addresses (IPv4 or IPv6). Create fake IPs for testing network code, firewall rules, or IP validation. Use for network testing, log generation, or IP parsing. Keywords: fake IP, random IP, IPv4 IPv6, test IP, mock IP, generate IP address.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of IPs (default: 1)" },
        version: { type: "number", enum: [4, 6], description: "IP version (default: 4)" },
      },
    },
    handler: ({ count = 1, version = 4 }) => {
      const generateIPv4 = () =>
        Array(4).fill(null).map(() => Math.floor(seededRandom() * 256)).join(".");
      const generateIPv6 = () =>
        Array(8).fill(null).map(() =>
          Math.floor(seededRandom() * 65536).toString(16).padStart(4, "0")
        ).join(":");

      const ips = Array(count as number).fill(null).map(() =>
        version === 6 ? generateIPv6() : generateIPv4()
      );
      return (count as number) === 1 ? ips[0] : ips;
    },
  },
  {
    name: "faker_credit_card",
    description:
      "Generate fake credit card numbers with valid Luhn checksum. Create test card numbers for payment form testing (NOT for fraud). Includes number, expiry, and CVV. Use for payment testing, form validation, or checkout flows. Keywords: fake credit card, test card, mock payment, card number, Luhn, payment testing.",
    category: "faker",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of cards (default: 1)" },
        type: {
          type: "string",
          enum: ["visa", "mastercard", "amex", "discover"],
          description: "Card type (default: random)",
        },
      },
    },
    handler: ({ count = 1, type }) => {
      const prefixes: Record<string, string[]> = {
        visa: ["4"],
        mastercard: ["51", "52", "53", "54", "55"],
        amex: ["34", "37"],
        discover: ["6011", "65"],
      };

      const generateCard = () => {
        const cardType = (type as string) || pick(["visa", "mastercard", "amex", "discover"]);
        const prefix = pick(prefixes[cardType]);
        const length = cardType === "amex" ? 15 : 16;

        // Generate random digits
        let number = prefix;
        while (number.length < length - 1) {
          number += Math.floor(seededRandom() * 10).toString();
        }

        // Calculate Luhn checksum digit
        let sum = 0;
        for (let i = number.length - 1; i >= 0; i--) {
          let digit = parseInt(number[i], 10);
          if ((number.length - i) % 2 === 0) {
            digit *= 2;
            if (digit > 9) digit -= 9;
          }
          sum += digit;
        }
        const checkDigit = (10 - (sum % 10)) % 10;
        number += checkDigit.toString();

        // Generate expiry (future date)
        const expMonth = String(1 + Math.floor(seededRandom() * 12)).padStart(2, "0");
        const expYear = String(new Date().getFullYear() + 1 + Math.floor(seededRandom() * 5)).slice(
          -2,
        );

        // Generate CVV
        const cvvLength = cardType === "amex" ? 4 : 3;
        const cvv = String(Math.floor(seededRandom() * Math.pow(10, cvvLength))).padStart(
          cvvLength,
          "0",
        );

        return {
          number,
          type: cardType,
          expiry: `${expMonth}/${expYear}`,
          cvv,
          formatted: number.replace(/(.{4})/g, "$1 ").trim(),
        };
      };

      const cards = Array(count as number).fill(null).map(generateCard);
      return (count as number) === 1 ? cards[0] : cards;
    },
  },
];
