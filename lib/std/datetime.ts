/**
 * Date/time manipulation tools
 *
 * Uses date-fns for robust date handling.
 *
 * Inspired by:
 * - IT-Tools MCP: https://github.com/wrenchpilot/it-tools-mcp
 *
 * @module lib/std/datetime
 */

import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  addSeconds,
  addWeeks,
  addYears,
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  differenceInMonths,
  differenceInSeconds,
  differenceInWeeks,
  differenceInYears,
  format,
  formatISO,
  getDate,
  getDay,
  getHours,
  getMinutes,
  getMonth,
  getSeconds,
  getUnixTime,
  getYear,
  parse,
  parseISO,
} from "date-fns";
import type { MiniTool } from "./types.ts";

export const datetimeTools: MiniTool[] = [
  {
    name: "datetime_now",
    description:
      "Get current date and time in various formats. Returns ISO, Unix timestamp, date-only, time-only, or custom pattern. Essential for timestamps, logging, or time-based operations. Keywords: current time, now, today date, timestamp, current datetime.",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["iso", "unix", "date", "time", "full"],
          description: "Output format",
        },
        pattern: {
          type: "string",
          description: "Custom format pattern (e.g., 'yyyy-MM-dd HH:mm:ss')",
        },
      },
    },
    handler: ({ format: fmt = "iso", pattern }) => {
      const now = new Date();
      if (pattern) {
        return format(now, pattern as string);
      }
      switch (fmt) {
        case "unix":
          return getUnixTime(now);
        case "date":
          return format(now, "yyyy-MM-dd");
        case "time":
          return format(now, "HH:mm:ss");
        case "full":
          return format(now, "PPpp"); // date-fns locale-aware full format
        default:
          return formatISO(now);
      }
    },
  },
  {
    name: "datetime_format",
    description:
      "Format a date using date-fns patterns. Use yyyy for year, MM for month, dd for day, HH for hours, mm for minutes. Create custom date displays like 'EEEE, MMMM do yyyy'. Keywords: format date, date pattern, date display, custom date format, date-fns.",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date string or ISO timestamp" },
        pattern: {
          type: "string",
          description: "Format pattern (e.g., 'yyyy-MM-dd HH:mm', 'EEEE, MMMM do yyyy')",
        },
      },
      required: ["date", "pattern"],
    },
    handler: ({ date, pattern }) => {
      const d = typeof date === "number" ? new Date(date) : parseISO(date as string);
      return format(d, pattern as string);
    },
  },
  {
    name: "datetime_diff",
    description:
      "Calculate time difference between two dates in any unit. Get difference in seconds, minutes, hours, days, weeks, months, or years. Use for age calculation, duration, or elapsed time. Keywords: date difference, time between, days since, duration, elapsed time, age calculation.",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date" },
        to: { type: "string", description: "End date (default: now)" },
        unit: {
          type: "string",
          enum: ["seconds", "minutes", "hours", "days", "weeks", "months", "years"],
          description: "Unit for result",
        },
      },
      required: ["from"],
    },
    handler: ({ from, to, unit = "days" }) => {
      const fromDate = parseISO(from as string);
      const toDate = to ? parseISO(to as string) : new Date();

      switch (unit) {
        case "seconds":
          return differenceInSeconds(toDate, fromDate);
        case "minutes":
          return differenceInMinutes(toDate, fromDate);
        case "hours":
          return differenceInHours(toDate, fromDate);
        case "days":
          return differenceInDays(toDate, fromDate);
        case "weeks":
          return differenceInWeeks(toDate, fromDate);
        case "months":
          return differenceInMonths(toDate, fromDate);
        case "years":
          return differenceInYears(toDate, fromDate);
        default:
          return differenceInDays(toDate, fromDate);
      }
    },
  },
  {
    name: "datetime_add",
    description:
      "Add or subtract time from a date. Add days, hours, months, or any unit to calculate future/past dates. Use negative values to subtract. Essential for scheduling and date calculations. Keywords: add days, add months, subtract time, date arithmetic, future date, past date.",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Base date (default: now)" },
        amount: { type: "number", description: "Amount to add (negative to subtract)" },
        unit: {
          type: "string",
          enum: ["seconds", "minutes", "hours", "days", "weeks", "months", "years"],
          description: "Unit",
        },
      },
      required: ["amount", "unit"],
    },
    handler: ({ date, amount, unit }) => {
      const d = date ? parseISO(date as string) : new Date();
      const amt = amount as number;

      let result: Date;
      switch (unit) {
        case "seconds":
          result = addSeconds(d, amt);
          break;
        case "minutes":
          result = addMinutes(d, amt);
          break;
        case "hours":
          result = addHours(d, amt);
          break;
        case "days":
          result = addDays(d, amt);
          break;
        case "weeks":
          result = addWeeks(d, amt);
          break;
        case "months":
          result = addMonths(d, amt);
          break;
        case "years":
          result = addYears(d, amt);
          break;
        default:
          result = d;
      }
      return formatISO(result);
    },
  },
  {
    name: "datetime_parse",
    description:
      "Parse a date string and extract all components. Returns year, month, day, hour, minute, second, day of week, and both ISO and Unix formats. Use for date validation or component extraction. Keywords: parse date, extract date parts, date components, validate date, date breakdown.",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date string to parse" },
        inputFormat: {
          type: "string",
          description: "Input format pattern (if not ISO)",
        },
      },
      required: ["date"],
    },
    handler: ({ date, inputFormat }) => {
      let d: Date;
      if (inputFormat) {
        d = parse(date as string, inputFormat as string, new Date());
      } else {
        d = parseISO(date as string);
      }

      const dayNames = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];

      return {
        year: getYear(d),
        month: getMonth(d) + 1,
        day: getDate(d),
        hour: getHours(d),
        minute: getMinutes(d),
        second: getSeconds(d),
        dayOfWeek: getDay(d),
        dayName: dayNames[getDay(d)],
        iso: formatISO(d),
        unix: getUnixTime(d),
      };
    },
  },
  // Inspired by IT-Tools MCP: https://github.com/wrenchpilot/it-tools-mcp
  {
    name: "datetime_cron_parse",
    description:
      "Parse cron expressions and explain their schedule in human-readable form. Understand what minute, hour, day, month, weekday fields mean. Use for validating and documenting cron jobs. Keywords: cron parse, cron expression, cron schedule, cron explain, scheduled tasks.",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Cron expression (5 or 6 fields: min hour day month weekday [year])",
        },
      },
      required: ["expression"],
    },
    handler: ({ expression }) => {
      const parts = (expression as string).trim().split(/\s+/);
      if (parts.length < 5 || parts.length > 6) {
        throw new Error("Cron expression must have 5 or 6 fields");
      }

      const fieldNames = ["minute", "hour", "dayOfMonth", "month", "dayOfWeek", "year"];
      const fieldRanges = [
        { min: 0, max: 59, names: null },
        { min: 0, max: 23, names: null },
        { min: 1, max: 31, names: null },
        {
          min: 1,
          max: 12,
          names: [
            "",
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
          ],
        },
        { min: 0, max: 6, names: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] },
        { min: 1970, max: 2099, names: null },
      ];

      const describeField = (value: string, idx: number): string => {
        const range = fieldRanges[idx];
        const name = fieldNames[idx];

        if (value === "*") return `every ${name}`;
        if (value.includes("/")) {
          const [, step] = value.split("/");
          return `every ${step} ${name}s`;
        }
        if (value.includes("-")) {
          const [start, end] = value.split("-");
          return `${name} ${start} through ${end}`;
        }
        if (value.includes(",")) {
          return `${name} ${value}`;
        }
        if (range.names && !isNaN(Number(value))) {
          return `${name} ${range.names[Number(value)] || value}`;
        }
        return `${name} ${value}`;
      };

      const descriptions = parts.map((p, i) => describeField(p, i));

      return {
        expression,
        fields: {
          minute: parts[0],
          hour: parts[1],
          dayOfMonth: parts[2],
          month: parts[3],
          dayOfWeek: parts[4],
          year: parts[5] || "*",
        },
        description: descriptions.join(", "),
        isValid: true,
      };
    },
  },
  {
    name: "datetime_unix",
    description:
      "Convert between Unix timestamp (seconds since 1970) and ISO date string. Handle both seconds and milliseconds. Essential for API timestamps and epoch time. Keywords: unix timestamp, epoch time, timestamp convert, from unix, to unix, seconds since 1970.",
    category: "datetime",
    inputSchema: {
      type: "object",
      properties: {
        value: {
          type: ["string", "number"],
          description: "Unix timestamp (number) or ISO date string",
        },
        action: {
          type: "string",
          enum: ["to_unix", "from_unix"],
          description: "Conversion direction",
        },
      },
      required: ["value", "action"],
    },
    handler: ({ value, action }) => {
      if (action === "to_unix") {
        const d = typeof value === "string" ? parseISO(value as string) : new Date(value as number);
        return {
          unix: getUnixTime(d),
          unixMs: d.getTime(),
          iso: formatISO(d),
        };
      }
      // from_unix
      const timestamp = typeof value === "string"
        ? parseInt(value as string, 10)
        : (value as number);
      // Detect if it's seconds or milliseconds
      const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
      const d = new Date(ms);
      return {
        iso: formatISO(d),
        formatted: format(d, "PPpp"),
        unix: Math.floor(ms / 1000),
        unixMs: ms,
      };
    },
  },
];
