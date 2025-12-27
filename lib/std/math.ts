/**
 * Math calculation tools
 *
 * Uses mathjs for safe expression evaluation and simple-statistics for stats.
 *
 * Inspired by:
 * - IT-Tools MCP: https://github.com/wrenchpilot/it-tools-mcp
 * - Math MCP: https://github.com/EthanHenrickson/math-mcp
 *
 * @module lib/std/math
 */

import { evaluate } from "mathjs";
import * as ss from "simple-statistics";
import type { MiniTool } from "./types.ts";

export const mathTools: MiniTool[] = [
  {
    name: "math_eval",
    description:
      "Evaluate mathematical expressions safely using mathjs. Supports arithmetic (+, -, *, /, %, ^), functions (sqrt, sin, cos, tan, log, exp), and constants (pi, e). Use for calculations, formula evaluation, or scientific computing. Keywords: math eval, calculate expression, mathjs, formula, scientific calculator, arithmetic.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Math expression (e.g., '2 + 3 * 4', 'sqrt(16)', 'sin(pi/2)')",
        },
      },
      required: ["expression"],
    },
    handler: ({ expression }) => {
      try {
        return evaluate(expression as string);
      } catch (e) {
        throw new Error(`Invalid expression: ${(e as Error).message}`);
      }
    },
  },
  {
    name: "math_stats",
    description:
      "Calculate comprehensive statistics for an array of numbers: min, max, sum, mean, median, standard deviation, and variance. Get count and all major statistical measures in one call. Use for data analysis, reporting, or understanding distributions. Keywords: statistics, mean average, median, stddev, variance, descriptive stats, data analysis.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        numbers: { type: "array", items: { type: "number" }, description: "Array of numbers" },
      },
      required: ["numbers"],
    },
    handler: ({ numbers }) => {
      const nums = numbers as number[];
      if (nums.length === 0) {
        return { min: 0, max: 0, sum: 0, mean: 0, median: 0, stddev: 0, variance: 0, count: 0 };
      }
      return {
        min: ss.min(nums),
        max: ss.max(nums),
        sum: ss.sum(nums),
        mean: ss.mean(nums),
        median: ss.median(nums),
        stddev: nums.length > 1 ? ss.standardDeviation(nums) : 0,
        variance: nums.length > 1 ? ss.variance(nums) : 0,
        count: nums.length,
      };
    },
  },
  {
    name: "math_round",
    description:
      "Round a number to specified decimal places with configurable rounding mode (round, floor, ceil). Control precision for currency, measurements, or display formatting. Use for financial calculations, formatting output, or precision control. Keywords: round number, decimal places, floor ceiling, truncate, precision, format number.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "number", description: "Number to round" },
        decimals: { type: "number", description: "Decimal places (default: 0)" },
        mode: { type: "string", enum: ["round", "floor", "ceil"], description: "Rounding mode" },
      },
      required: ["number"],
    },
    handler: ({ number, decimals = 0, mode = "round" }) => {
      const factor = Math.pow(10, decimals as number);
      const n = (number as number) * factor;
      let result: number;
      switch (mode) {
        case "floor":
          result = Math.floor(n);
          break;
        case "ceil":
          result = Math.ceil(n);
          break;
        default:
          result = Math.round(n);
      }
      return result / factor;
    },
  },
  {
    name: "math_random",
    description:
      "Generate random numbers within a specified range. Create single or multiple random values, choose integer or decimal output. Use for testing, simulations, games, or sampling. Keywords: random number, generate random, random range, integer random, random generator, dice roll.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        min: { type: "number", description: "Minimum value (default: 0)" },
        max: { type: "number", description: "Maximum value (default: 100)" },
        count: { type: "number", description: "How many numbers (default: 1)" },
        integer: { type: "boolean", description: "Integer only (default: true)" },
      },
    },
    handler: ({ min = 0, max = 100, count = 1, integer = true }) => {
      const generate = () => {
        const n = Math.random() * ((max as number) - (min as number)) + (min as number);
        return integer ? Math.floor(n) : n;
      };
      const cnt = count as number;
      return cnt === 1 ? generate() : Array.from({ length: cnt }, generate);
    },
  },
  {
    name: "math_percentage",
    description:
      "Calculate percentage from value and total (value/total × 100) or calculate value from percentage and total. Bidirectional percentage calculations. Use for discounts, proportions, or statistical ratios. Keywords: percentage, percent of, calculate %, ratio, proportion, percent calculation.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "The value" },
        total: { type: "number", description: "The total (for calculating %)" },
        percentage: { type: "number", description: "Percentage (for calculating value)" },
      },
    },
    handler: ({ value, total, percentage }) => {
      if (percentage !== undefined && total !== undefined) {
        return ((percentage as number) / 100) * (total as number);
      }
      if (value !== undefined && total !== undefined) {
        return ((value as number) / (total as number)) * 100;
      }
      throw new Error("Provide (value, total) or (percentage, total)");
    },
  },
  {
    name: "math_linear_regression",
    description:
      "Calculate linear regression (y = mx + b) from data points. Get slope, intercept, R² correlation, and prediction function. Analyze trends, fit lines to data, or make predictions. Use for trend analysis, forecasting, or data science. Keywords: linear regression, slope intercept, R squared, trend line, fit line, predict, correlation.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        points: {
          type: "array",
          items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          description: "Array of [x, y] points",
        },
      },
      required: ["points"],
    },
    handler: ({ points }) => {
      const data = points as [number, number][];
      if (data.length < 2) throw new Error("Need at least 2 points");
      const regression = ss.linearRegression(data);
      const line = ss.linearRegressionLine(regression);
      return {
        slope: regression.m,
        intercept: regression.b,
        predict: (x: number) => line(x),
        r2: ss.rSquared(data, line),
      };
    },
  },
  {
    name: "math_mode",
    description:
      "Find the most frequent value(s) in an array of numbers. Identify the statistical mode for frequency analysis or categorical data. Use for finding common values, frequency analysis, or statistics. Keywords: mode, most frequent, frequency, common value, statistical mode, occurrence.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        numbers: { type: "array", items: { type: "number" }, description: "Array of numbers" },
      },
      required: ["numbers"],
    },
    handler: ({ numbers }) => {
      const nums = numbers as number[];
      if (nums.length === 0) return null;
      return ss.mode(nums);
    },
  },
  {
    name: "math_convert",
    description:
      "Convert between common unit pairs: radians/degrees, Celsius/Fahrenheit, kilometers/miles. Quick conversion for everyday unit transformations. Use for unit conversion in calculations or display. Keywords: unit convert, radians degrees, celsius fahrenheit, km miles, temperature convert, angle convert.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "Value to convert" },
        from: {
          type: "string",
          enum: ["radians", "degrees", "celsius", "fahrenheit", "km", "miles"],
          description: "Source unit",
        },
        to: {
          type: "string",
          enum: ["radians", "degrees", "celsius", "fahrenheit", "km", "miles"],
          description: "Target unit",
        },
      },
      required: ["value", "from", "to"],
    },
    handler: ({ value, from, to }) => {
      const v = value as number;
      const conversions: Record<string, Record<string, (n: number) => number>> = {
        radians: {
          degrees: (n) => n * (180 / Math.PI),
          radians: (n) => n,
        },
        degrees: {
          radians: (n) => n * (Math.PI / 180),
          degrees: (n) => n,
        },
        celsius: {
          fahrenheit: (n) => (n * 9) / 5 + 32,
          celsius: (n) => n,
        },
        fahrenheit: {
          celsius: (n) => ((n - 32) * 5) / 9,
          fahrenheit: (n) => n,
        },
        km: {
          miles: (n) => n * 0.621371,
          km: (n) => n,
        },
        miles: {
          km: (n) => n * 1.60934,
          miles: (n) => n,
        },
      };
      const fn = conversions[from as string]?.[to as string];
      if (!fn) throw new Error(`Cannot convert from ${from} to ${to}`);
      return fn(v);
    },
  },
  // Inspired by IT-Tools MCP: https://github.com/wrenchpilot/it-tools-mcp
  {
    name: "math_base_convert",
    description:
      "Convert numbers between numeral bases: binary (2), octal (8), decimal (10), hexadecimal (16). Translate numbers between different representations. Use for programming, debugging, or educational purposes. Keywords: base convert, binary hex, decimal to hex, number base, radix, octal, hexadecimal.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string", description: "Number to convert (as string)" },
        from: {
          type: "number",
          enum: [2, 8, 10, 16],
          description: "Source base (2=binary, 8=octal, 10=decimal, 16=hex)",
        },
        to: {
          type: "number",
          enum: [2, 8, 10, 16],
          description: "Target base",
        },
      },
      required: ["value", "from", "to"],
    },
    handler: ({ value, from, to }) => {
      const num = parseInt(value as string, from as number);
      if (isNaN(num)) throw new Error(`Invalid number for base ${from}: ${value}`);
      return num.toString(to as number).toUpperCase();
    },
  },
  {
    name: "math_roman",
    description:
      "Convert between Roman numerals and Arabic numbers (1-3999). Translate MCMXCIV to 1994 or vice versa. Use for document formatting, historical dates, or educational purposes. Keywords: Roman numeral, arabic number, numeral convert, MCMXCIV, Roman to number, number to Roman.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        value: {
          type: ["string", "number"],
          description: "Roman numeral (string) or Arabic number",
        },
        action: {
          type: "string",
          enum: ["to_roman", "from_roman"],
          description: "Conversion direction",
        },
      },
      required: ["value", "action"],
    },
    handler: ({ value, action }) => {
      const romanMap: [string, number][] = [
        ["M", 1000],
        ["CM", 900],
        ["D", 500],
        ["CD", 400],
        ["C", 100],
        ["XC", 90],
        ["L", 50],
        ["XL", 40],
        ["X", 10],
        ["IX", 9],
        ["V", 5],
        ["IV", 4],
        ["I", 1],
      ];

      if (action === "to_roman") {
        let num = typeof value === "string" ? parseInt(value, 10) : (value as number);
        if (num < 1 || num > 3999) throw new Error("Number must be between 1 and 3999");
        let result = "";
        for (const [roman, arabic] of romanMap) {
          while (num >= arabic) {
            result += roman;
            num -= arabic;
          }
        }
        return result;
      }

      // from_roman
      const roman = (value as string).toUpperCase();
      let result = 0;
      let i = 0;
      for (const [r, arabic] of romanMap) {
        while (roman.slice(i, i + r.length) === r) {
          result += arabic;
          i += r.length;
        }
      }
      return result;
    },
  },
  {
    name: "math_convert_angle",
    description:
      "Convert between all angle units: degrees, radians, gradians, turns, arcminutes, arcseconds. Comprehensive angle unit conversion for trigonometry or navigation. Use for scientific calculations, CAD, or astronomy. Keywords: angle convert, degrees radians, gradians, turns, arcminutes, arcseconds, trigonometry.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "Value to convert" },
        from: {
          type: "string",
          enum: ["degrees", "radians", "gradians", "turns", "arcminutes", "arcseconds"],
          description: "Source unit",
        },
        to: {
          type: "string",
          enum: ["degrees", "radians", "gradians", "turns", "arcminutes", "arcseconds"],
          description: "Target unit",
        },
      },
      required: ["value", "from", "to"],
    },
    handler: ({ value, from, to }) => {
      const v = value as number;
      // First convert to degrees as base unit
      const toDegrees: Record<string, (n: number) => number> = {
        degrees: (n) => n,
        radians: (n) => n * (180 / Math.PI),
        gradians: (n) => n * 0.9,
        turns: (n) => n * 360,
        arcminutes: (n) => n / 60,
        arcseconds: (n) => n / 3600,
      };
      // Then convert from degrees to target
      const fromDegrees: Record<string, (n: number) => number> = {
        degrees: (n) => n,
        radians: (n) => n * (Math.PI / 180),
        gradians: (n) => n / 0.9,
        turns: (n) => n / 360,
        arcminutes: (n) => n * 60,
        arcseconds: (n) => n * 3600,
      };
      const degrees = toDegrees[from as string]?.(v);
      if (degrees === undefined) throw new Error(`Unknown unit: ${from}`);
      const result = fromDegrees[to as string]?.(degrees);
      if (result === undefined) throw new Error(`Unknown unit: ${to}`);
      return result;
    },
  },
  {
    name: "math_convert_energy",
    description:
      "Convert between energy units: joules, calories, kilocalories, kWh, BTU, electron volts, watt-hours, foot-pounds. Essential for physics, nutrition, or engineering calculations. Use for energy calculations or unit comparison. Keywords: energy convert, joules calories, kWh BTU, electron volt, watt hours, calorie joule.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "Value to convert" },
        from: {
          type: "string",
          enum: [
            "joules",
            "calories",
            "kilocalories",
            "kwh",
            "btu",
            "ev",
            "watt_hours",
            "foot_pounds",
          ],
          description: "Source unit",
        },
        to: {
          type: "string",
          enum: [
            "joules",
            "calories",
            "kilocalories",
            "kwh",
            "btu",
            "ev",
            "watt_hours",
            "foot_pounds",
          ],
          description: "Target unit",
        },
      },
      required: ["value", "from", "to"],
    },
    handler: ({ value, from, to }) => {
      const v = value as number;
      // Convert to joules as base unit
      const toJoules: Record<string, number> = {
        joules: 1,
        calories: 4.184,
        kilocalories: 4184,
        kwh: 3600000,
        btu: 1055.06,
        ev: 1.602176634e-19,
        watt_hours: 3600,
        foot_pounds: 1.35582,
      };
      const joules = v * (toJoules[from as string] ?? 1);
      const result = joules / (toJoules[to as string] ?? 1);
      return result;
    },
  },
  {
    name: "math_convert_power",
    description:
      "Convert between power units: watts, kilowatts, megawatts, horsepower, BTU/hour, foot-pounds/second. Essential for engineering, automotive, or HVAC calculations. Use for power ratings or equipment specs. Keywords: power convert, watts horsepower, kilowatt, megawatt, BTU per hour, power units.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "Value to convert" },
        from: {
          type: "string",
          enum: [
            "watts",
            "kilowatts",
            "megawatts",
            "horsepower",
            "btu_per_hour",
            "foot_pounds_per_second",
          ],
          description: "Source unit",
        },
        to: {
          type: "string",
          enum: [
            "watts",
            "kilowatts",
            "megawatts",
            "horsepower",
            "btu_per_hour",
            "foot_pounds_per_second",
          ],
          description: "Target unit",
        },
      },
      required: ["value", "from", "to"],
    },
    handler: ({ value, from, to }) => {
      const v = value as number;
      // Convert to watts as base unit
      const toWatts: Record<string, number> = {
        watts: 1,
        kilowatts: 1000,
        megawatts: 1000000,
        horsepower: 745.7,
        btu_per_hour: 0.293071,
        foot_pounds_per_second: 1.35582,
      };
      const watts = v * (toWatts[from as string] ?? 1);
      const result = watts / (toWatts[to as string] ?? 1);
      return result;
    },
  },
  // Temperature conversion - inspired by IT-Tools MCP
  {
    name: "math_convert_temperature",
    description:
      "Convert between all temperature scales: Celsius, Fahrenheit, Kelvin, Rankine. Get precise temperature conversions for weather, science, or cooking. Use for international communication or scientific work. Keywords: temperature convert, Celsius Fahrenheit, Kelvin, Rankine, degrees convert, thermometer.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "Temperature value" },
        from: {
          type: "string",
          enum: ["celsius", "fahrenheit", "kelvin", "rankine"],
          description: "Source unit",
        },
        to: {
          type: "string",
          enum: ["celsius", "fahrenheit", "kelvin", "rankine"],
          description: "Target unit",
        },
      },
      required: ["value", "from", "to"],
    },
    handler: ({ value, from, to }) => {
      const v = value as number;

      // First convert to Celsius
      let celsius: number;
      switch (from) {
        case "celsius":
          celsius = v;
          break;
        case "fahrenheit":
          celsius = (v - 32) * (5 / 9);
          break;
        case "kelvin":
          celsius = v - 273.15;
          break;
        case "rankine":
          celsius = (v - 491.67) * (5 / 9);
          break;
        default:
          throw new Error(`Unknown unit: ${from}`);
      }

      // Then convert from Celsius to target
      let result: number;
      switch (to) {
        case "celsius":
          result = celsius;
          break;
        case "fahrenheit":
          result = celsius * (9 / 5) + 32;
          break;
        case "kelvin":
          result = celsius + 273.15;
          break;
        case "rankine":
          result = (celsius + 273.15) * (9 / 5);
          break;
        default:
          throw new Error(`Unknown unit: ${to}`);
      }

      return {
        from: { value: v, unit: from },
        to: { value: Math.round(result * 1000) / 1000, unit: to },
      };
    },
  },
  {
    name: "math_percentage_calc",
    description:
      "Calculate various percentage operations: X% of Y, percentage change between values, increase/decrease by %, what percent is X of Y. Complete percentage calculator for business or analysis. Keywords: percentage calculator, percent change, increase decrease, percent of, markup markdown, growth rate.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["of", "change", "increase", "decrease", "what_percent"],
          description: "Operation type",
        },
        value: { type: "number", description: "Main value" },
        percent: { type: "number", description: "Percentage value" },
        from: { type: "number", description: "For 'change' operation: original value" },
        to: { type: "number", description: "For 'change' operation: new value" },
      },
      required: ["operation"],
    },
    handler: ({ operation, value, percent, from, to }) => {
      switch (operation) {
        case "of":
          // What is X% of Y?
          if (percent === undefined || value === undefined) {
            throw new Error("'of' requires 'percent' and 'value'");
          }
          return {
            operation: `${percent}% of ${value}`,
            result: ((percent as number) / 100) * (value as number),
          };

        case "change":
          // What is the percentage change from X to Y?
          if (from === undefined || to === undefined) {
            throw new Error("'change' requires 'from' and 'to'");
          }
          const change = (((to as number) - (from as number)) / (from as number)) * 100;
          return {
            operation: `Change from ${from} to ${to}`,
            result: Math.round(change * 100) / 100,
            direction: change >= 0 ? "increase" : "decrease",
          };

        case "increase":
          // Increase X by Y%
          if (value === undefined || percent === undefined) {
            throw new Error("'increase' requires 'value' and 'percent'");
          }
          return {
            operation: `Increase ${value} by ${percent}%`,
            result: (value as number) * (1 + (percent as number) / 100),
          };

        case "decrease":
          // Decrease X by Y%
          if (value === undefined || percent === undefined) {
            throw new Error("'decrease' requires 'value' and 'percent'");
          }
          return {
            operation: `Decrease ${value} by ${percent}%`,
            result: (value as number) * (1 - (percent as number) / 100),
          };

        case "what_percent":
          // X is what percent of Y?
          if (value === undefined || from === undefined) {
            throw new Error("'what_percent' requires 'value' (part) and 'from' (whole)");
          }
          return {
            operation: `${value} is what % of ${from}`,
            result: Math.round(((value as number) / (from as number)) * 10000) / 100,
          };

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
  },
  // Comprehensive unit conversion - inspired by calculator-server
  {
    name: "math_convert_units",
    description:
      "Universal unit converter for length, weight, volume, area, speed, and data storage. Convert meters to feet, kg to lbs, liters to gallons, GB to MB, and more. Auto-detects unit category. Use for any measurement conversion. Keywords: unit converter, metric imperial, length weight volume, convert units, measurement, meters feet.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number", description: "Value to convert" },
        from: { type: "string", description: "Source unit" },
        to: { type: "string", description: "Target unit" },
        category: {
          type: "string",
          enum: ["length", "weight", "volume", "area", "speed", "data"],
          description: "Unit category (auto-detected if omitted)",
        },
      },
      required: ["value", "from", "to"],
    },
    handler: ({ value, from, to }) => {
      const v = value as number;
      const fromUnit = (from as string).toLowerCase().replace(/\s+/g, "_");
      const toUnit = (to as string).toLowerCase().replace(/\s+/g, "_");

      // Length conversions (base: meters)
      const length: Record<string, number> = {
        meters: 1,
        m: 1,
        meter: 1,
        kilometers: 1000,
        km: 1000,
        centimeters: 0.01,
        cm: 0.01,
        millimeters: 0.001,
        mm: 0.001,
        micrometers: 1e-6,
        um: 1e-6,
        nanometers: 1e-9,
        nm: 1e-9,
        miles: 1609.344,
        mi: 1609.344,
        yards: 0.9144,
        yd: 0.9144,
        feet: 0.3048,
        ft: 0.3048,
        foot: 0.3048,
        inches: 0.0254,
        in: 0.0254,
        inch: 0.0254,
        nautical_miles: 1852,
        nmi: 1852,
        light_years: 9.461e15,
        ly: 9.461e15,
      };

      // Weight/mass conversions (base: kilograms)
      const weight: Record<string, number> = {
        kilograms: 1,
        kg: 1,
        grams: 0.001,
        g: 0.001,
        milligrams: 1e-6,
        mg: 1e-6,
        micrograms: 1e-9,
        ug: 1e-9,
        metric_tons: 1000,
        tonnes: 1000,
        t: 1000,
        pounds: 0.453592,
        lb: 0.453592,
        lbs: 0.453592,
        ounces: 0.0283495,
        oz: 0.0283495,
        stones: 6.35029,
        st: 6.35029,
        short_tons: 907.185,
        us_tons: 907.185,
        long_tons: 1016.05,
        uk_tons: 1016.05,
      };

      // Volume conversions (base: liters)
      const volume: Record<string, number> = {
        liters: 1,
        l: 1,
        liter: 1,
        litres: 1,
        milliliters: 0.001,
        ml: 0.001,
        cubic_meters: 1000,
        m3: 1000,
        cubic_centimeters: 0.001,
        cm3: 0.001,
        cc: 0.001,
        gallons: 3.78541,
        gal: 3.78541,
        us_gallons: 3.78541,
        uk_gallons: 4.54609,
        imperial_gallons: 4.54609,
        quarts: 0.946353,
        qt: 0.946353,
        pints: 0.473176,
        pt: 0.473176,
        cups: 0.236588,
        cup: 0.236588,
        fluid_ounces: 0.0295735,
        fl_oz: 0.0295735,
        tablespoons: 0.0147868,
        tbsp: 0.0147868,
        teaspoons: 0.00492892,
        tsp: 0.00492892,
      };

      // Area conversions (base: square meters)
      const area: Record<string, number> = {
        square_meters: 1,
        m2: 1,
        sq_m: 1,
        square_kilometers: 1e6,
        km2: 1e6,
        sq_km: 1e6,
        square_centimeters: 1e-4,
        cm2: 1e-4,
        sq_cm: 1e-4,
        square_millimeters: 1e-6,
        mm2: 1e-6,
        sq_mm: 1e-6,
        hectares: 10000,
        ha: 10000,
        acres: 4046.86,
        ac: 4046.86,
        square_feet: 0.092903,
        ft2: 0.092903,
        sq_ft: 0.092903,
        square_yards: 0.836127,
        yd2: 0.836127,
        sq_yd: 0.836127,
        square_inches: 0.00064516,
        in2: 0.00064516,
        sq_in: 0.00064516,
        square_miles: 2.59e6,
        mi2: 2.59e6,
        sq_mi: 2.59e6,
      };

      // Speed conversions (base: meters per second)
      const speed: Record<string, number> = {
        meters_per_second: 1,
        m_s: 1,
        mps: 1,
        kilometers_per_hour: 0.277778,
        km_h: 0.277778,
        kph: 0.277778,
        kmh: 0.277778,
        miles_per_hour: 0.44704,
        mph: 0.44704,
        mi_h: 0.44704,
        feet_per_second: 0.3048,
        ft_s: 0.3048,
        fps: 0.3048,
        knots: 0.514444,
        kn: 0.514444,
        kt: 0.514444,
        mach: 343, // at sea level
      };

      // Data conversions (base: bytes)
      const data: Record<string, number> = {
        bytes: 1,
        b: 1,
        byte: 1,
        kilobytes: 1024,
        kb: 1024,
        megabytes: 1048576,
        mb: 1048576,
        gigabytes: 1073741824,
        gb: 1073741824,
        terabytes: 1099511627776,
        tb: 1099511627776,
        petabytes: 1125899906842624,
        pb: 1125899906842624,
        bits: 0.125,
        bit: 0.125,
        kilobits: 128,
        kbit: 128,
        megabits: 131072,
        mbit: 131072,
        gigabits: 134217728,
        gbit: 134217728,
      };

      const categories = { length, weight, volume, area, speed, data };

      // Find which category contains both units
      for (const [catName, units] of Object.entries(categories)) {
        if (units[fromUnit] !== undefined && units[toUnit] !== undefined) {
          const baseValue = v * units[fromUnit];
          const result = baseValue / units[toUnit];
          return {
            from: { value: v, unit: from },
            to: { value: result, unit: to },
            category: catName,
          };
        }
      }

      throw new Error(
        `Cannot convert between '${from}' and '${to}'. Ensure both units are in the same category.`,
      );
    },
  },
  // Financial calculations - inspired by calculator-server
  {
    name: "math_financial",
    description:
      "Financial calculator for compound/simple interest, loan payments, present/future value, NPV, and ROI. Calculate mortgage payments, investment growth, or project profitability. Use for financial planning, loans, or investment analysis. Keywords: compound interest, loan payment, NPV, ROI, mortgage calculator, future value, amortization.",
    category: "math",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "compound_interest",
            "simple_interest",
            "loan_payment",
            "present_value",
            "future_value",
            "npv",
            "roi",
          ],
          description: "Financial operation",
        },
        principal: { type: "number", description: "Principal amount (P)" },
        rate: { type: "number", description: "Interest rate as percentage (e.g., 5 for 5%)" },
        time: { type: "number", description: "Time in years" },
        periods: {
          type: "number",
          description: "Compounding periods per year (default: 12 for monthly)",
        },
        payment: { type: "number", description: "Regular payment amount" },
        cashFlows: {
          type: "array",
          items: { type: "number" },
          description: "Array of cash flows for NPV (first is initial investment, negative)",
        },
        initialInvestment: { type: "number", description: "Initial investment for ROI" },
        finalValue: { type: "number", description: "Final value for ROI" },
      },
      required: ["operation"],
    },
    handler: (
      { operation, principal, rate, time, periods = 12, cashFlows, initialInvestment, finalValue },
    ) => {
      const P = principal as number;
      const r = (rate as number) / 100; // Convert percentage to decimal
      const t = time as number;
      const n = periods as number;

      switch (operation) {
        case "compound_interest": {
          // A = P(1 + r/n)^(nt)
          if (P === undefined || rate === undefined || t === undefined) {
            throw new Error("compound_interest requires principal, rate, and time");
          }
          const amount = P * Math.pow(1 + r / n, n * t);
          const interest = amount - P;
          return {
            principal: P,
            rate: `${rate}%`,
            time: `${t} years`,
            periods: n,
            finalAmount: Math.round(amount * 100) / 100,
            interestEarned: Math.round(interest * 100) / 100,
            effectiveRate: `${Math.round((Math.pow(1 + r / n, n) - 1) * 10000) / 100}%`,
          };
        }

        case "simple_interest": {
          // I = P * r * t
          if (P === undefined || rate === undefined || t === undefined) {
            throw new Error("simple_interest requires principal, rate, and time");
          }
          const interest = P * r * t;
          return {
            principal: P,
            rate: `${rate}%`,
            time: `${t} years`,
            interest: Math.round(interest * 100) / 100,
            finalAmount: Math.round((P + interest) * 100) / 100,
          };
        }

        case "loan_payment": {
          // Monthly payment = P * [r(1+r)^n] / [(1+r)^n - 1]
          if (P === undefined || rate === undefined || t === undefined) {
            throw new Error("loan_payment requires principal, rate, and time");
          }
          const monthlyRate = r / 12;
          const numPayments = t * 12;
          const payment = P * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) /
            (Math.pow(1 + monthlyRate, numPayments) - 1);
          const totalPaid = payment * numPayments;
          return {
            loanAmount: P,
            annualRate: `${rate}%`,
            termYears: t,
            monthlyPayment: Math.round(payment * 100) / 100,
            totalPayments: numPayments,
            totalPaid: Math.round(totalPaid * 100) / 100,
            totalInterest: Math.round((totalPaid - P) * 100) / 100,
          };
        }

        case "present_value": {
          // PV = FV / (1 + r)^t
          if (finalValue === undefined || rate === undefined || t === undefined) {
            throw new Error("present_value requires finalValue, rate, and time");
          }
          const pv = (finalValue as number) / Math.pow(1 + r, t);
          return {
            futureValue: finalValue,
            rate: `${rate}%`,
            time: `${t} years`,
            presentValue: Math.round(pv * 100) / 100,
          };
        }

        case "future_value": {
          // FV = PV * (1 + r)^t
          if (P === undefined || rate === undefined || t === undefined) {
            throw new Error("future_value requires principal, rate, and time");
          }
          const fv = P * Math.pow(1 + r, t);
          return {
            presentValue: P,
            rate: `${rate}%`,
            time: `${t} years`,
            futureValue: Math.round(fv * 100) / 100,
          };
        }

        case "npv": {
          // NPV = sum of [Ct / (1+r)^t] for each period
          if (!cashFlows || rate === undefined) {
            throw new Error("npv requires cashFlows array and rate");
          }
          const flows = cashFlows as number[];
          let npv = 0;
          for (let i = 0; i < flows.length; i++) {
            npv += flows[i] / Math.pow(1 + r, i);
          }
          return {
            cashFlows: flows,
            discountRate: `${rate}%`,
            npv: Math.round(npv * 100) / 100,
            profitable: npv > 0,
          };
        }

        case "roi": {
          // ROI = (Final - Initial) / Initial * 100
          if (initialInvestment === undefined || finalValue === undefined) {
            throw new Error("roi requires initialInvestment and finalValue");
          }
          const roi = ((finalValue as number) - (initialInvestment as number)) /
            (initialInvestment as number) * 100;
          return {
            initialInvestment,
            finalValue,
            roi: `${Math.round(roi * 100) / 100}%`,
            profit: Math.round(((finalValue as number) - (initialInvestment as number)) * 100) /
              100,
          };
        }

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
  },
];
