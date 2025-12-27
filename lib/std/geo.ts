/**
 * Geographic and geolocation tools
 *
 * Distance calculations, coordinate conversions, and geospatial utilities.
 *
 * @module lib/std/geo
 */

import type { MiniTool } from "./types.ts";

// Earth's radius in various units
const EARTH_RADIUS = {
  km: 6371,
  mi: 3959,
  m: 6371000,
  nm: 3440, // nautical miles
};

// Degrees to radians
const toRad = (deg: number): number => deg * (Math.PI / 180);
// Radians to degrees
const toDeg = (rad: number): number => rad * (180 / Math.PI);

export const geoTools: MiniTool[] = [
  {
    name: "geo_distance",
    description:
      "Calculate distance between two coordinates using Haversine formula. Get great-circle distance between latitude/longitude points. Supports km, miles, meters, nautical miles. Use for delivery routes, proximity search, or travel distance. Keywords: haversine, distance, coordinates, lat long, GPS distance, great circle.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        lat1: { type: "number", description: "Latitude of point 1" },
        lon1: { type: "number", description: "Longitude of point 1" },
        lat2: { type: "number", description: "Latitude of point 2" },
        lon2: { type: "number", description: "Longitude of point 2" },
        unit: {
          type: "string",
          enum: ["km", "mi", "m", "nm"],
          description: "Distance unit (default: km)",
        },
      },
      required: ["lat1", "lon1", "lat2", "lon2"],
    },
    handler: ({ lat1, lon1, lat2, lon2, unit = "km" }) => {
      const R = EARTH_RADIUS[unit as keyof typeof EARTH_RADIUS] || EARTH_RADIUS.km;

      const dLat = toRad((lat2 as number) - (lat1 as number));
      const dLon = toRad((lon2 as number) - (lon1 as number));

      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1 as number)) * Math.cos(toRad(lat2 as number)) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);

      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = R * c;

      return {
        distance: Math.round(distance * 1000) / 1000,
        unit,
        from: { lat: lat1, lon: lon1 },
        to: { lat: lat2, lon: lon2 },
      };
    },
  },
  {
    name: "geo_bearing",
    description:
      "Calculate initial bearing/heading between two coordinates. Get compass direction from point A to point B in degrees (0-360). Use for navigation, direction indicators, or route planning. Keywords: bearing, heading, compass, direction, azimuth, navigation.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        lat1: { type: "number", description: "Latitude of start point" },
        lon1: { type: "number", description: "Longitude of start point" },
        lat2: { type: "number", description: "Latitude of end point" },
        lon2: { type: "number", description: "Longitude of end point" },
      },
      required: ["lat1", "lon1", "lat2", "lon2"],
    },
    handler: ({ lat1, lon1, lat2, lon2 }) => {
      const φ1 = toRad(lat1 as number);
      const φ2 = toRad(lat2 as number);
      const Δλ = toRad((lon2 as number) - (lon1 as number));

      const y = Math.sin(Δλ) * Math.cos(φ2);
      const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

      let bearing = toDeg(Math.atan2(y, x));
      bearing = (bearing + 360) % 360; // Normalize to 0-360

      // Cardinal direction
      const cardinals = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
      const cardinal = cardinals[Math.round(bearing / 45) % 8];

      return {
        bearing: Math.round(bearing * 100) / 100,
        cardinal,
        from: { lat: lat1, lon: lon1 },
        to: { lat: lat2, lon: lon2 },
      };
    },
  },
  {
    name: "geo_midpoint",
    description:
      "Calculate geographic midpoint between two coordinates. Find the halfway point along the great circle path. Use for meeting point calculation, route waypoints, or center finding. Keywords: midpoint, center point, halfway, middle, geographic center, waypoint.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        lat1: { type: "number", description: "Latitude of point 1" },
        lon1: { type: "number", description: "Longitude of point 1" },
        lat2: { type: "number", description: "Latitude of point 2" },
        lon2: { type: "number", description: "Longitude of point 2" },
      },
      required: ["lat1", "lon1", "lat2", "lon2"],
    },
    handler: ({ lat1, lon1, lat2, lon2 }) => {
      const φ1 = toRad(lat1 as number);
      const λ1 = toRad(lon1 as number);
      const φ2 = toRad(lat2 as number);
      const Δλ = toRad((lon2 as number) - (lon1 as number));

      const Bx = Math.cos(φ2) * Math.cos(Δλ);
      const By = Math.cos(φ2) * Math.sin(Δλ);

      const φ3 = Math.atan2(
        Math.sin(φ1) + Math.sin(φ2),
        Math.sqrt((Math.cos(φ1) + Bx) * (Math.cos(φ1) + Bx) + By * By),
      );
      const λ3 = λ1 + Math.atan2(By, Math.cos(φ1) + Bx);

      return {
        lat: Math.round(toDeg(φ3) * 1000000) / 1000000,
        lon: Math.round(toDeg(λ3) * 1000000) / 1000000,
        from: { lat: lat1, lon: lon1 },
        to: { lat: lat2, lon: lon2 },
      };
    },
  },
  {
    name: "geo_destination",
    description:
      "Calculate destination point given start, bearing, and distance. Find where you end up traveling a given direction and distance. Use for route planning, radar circles, or coverage areas. Keywords: destination point, travel to, bearing distance, endpoint, project point.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Starting latitude" },
        lon: { type: "number", description: "Starting longitude" },
        bearing: { type: "number", description: "Bearing in degrees (0-360)" },
        distance: { type: "number", description: "Distance to travel" },
        unit: {
          type: "string",
          enum: ["km", "mi", "m", "nm"],
          description: "Distance unit (default: km)",
        },
      },
      required: ["lat", "lon", "bearing", "distance"],
    },
    handler: ({ lat, lon, bearing, distance, unit = "km" }) => {
      const R = EARTH_RADIUS[unit as keyof typeof EARTH_RADIUS] || EARTH_RADIUS.km;
      const d = (distance as number) / R; // Angular distance

      const φ1 = toRad(lat as number);
      const λ1 = toRad(lon as number);
      const θ = toRad(bearing as number);

      const φ2 = Math.asin(
        Math.sin(φ1) * Math.cos(d) +
          Math.cos(φ1) * Math.sin(d) * Math.cos(θ),
      );
      const λ2 = λ1 + Math.atan2(
        Math.sin(θ) * Math.sin(d) * Math.cos(φ1),
        Math.cos(d) - Math.sin(φ1) * Math.sin(φ2),
      );

      return {
        lat: Math.round(toDeg(φ2) * 1000000) / 1000000,
        lon: Math.round(toDeg(λ2) * 1000000) / 1000000,
        from: { lat, lon },
        bearing,
        distance,
        unit,
      };
    },
  },
  {
    name: "geo_bounds",
    description:
      "Calculate bounding box containing all given points. Get min/max lat/lon rectangle enclosing a set of coordinates. Use for map viewport, search bounds, or area calculation. Keywords: bounding box, bounds, extent, envelope, min max, viewport.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        points: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
            },
          },
          description: "Array of {lat, lon} points",
        },
      },
      required: ["points"],
    },
    handler: ({ points }) => {
      const pts = points as Array<{ lat: number; lon: number }>;

      if (pts.length === 0) {
        return { error: "No points provided" };
      }

      let minLat = pts[0].lat;
      let maxLat = pts[0].lat;
      let minLon = pts[0].lon;
      let maxLon = pts[0].lon;

      for (const p of pts) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      }

      return {
        bounds: {
          north: maxLat,
          south: minLat,
          east: maxLon,
          west: minLon,
        },
        center: {
          lat: (minLat + maxLat) / 2,
          lon: (minLon + maxLon) / 2,
        },
        pointCount: pts.length,
      };
    },
  },
  {
    name: "geo_point_in_polygon",
    description:
      "Check if a coordinate point is inside a polygon. Test if lat/lon is within a bounded area using ray casting algorithm. Use for geofencing, zone detection, or area membership. Keywords: point in polygon, contains point, geofence, inside area, ray casting, zone.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        point: {
          type: "object",
          properties: {
            lat: { type: "number" },
            lon: { type: "number" },
          },
          description: "Point to test {lat, lon}",
        },
        polygon: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
            },
          },
          description: "Polygon vertices as [{lat, lon}, ...]",
        },
      },
      required: ["point", "polygon"],
    },
    handler: ({ point, polygon }) => {
      const pt = point as { lat: number; lon: number };
      const poly = polygon as Array<{ lat: number; lon: number }>;

      if (poly.length < 3) {
        return { error: "Polygon must have at least 3 vertices" };
      }

      // Ray casting algorithm
      let inside = false;
      const x = pt.lon;
      const y = pt.lat;

      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].lon;
        const yi = poly[i].lat;
        const xj = poly[j].lon;
        const yj = poly[j].lat;

        const intersect = ((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi) + xi);

        if (intersect) inside = !inside;
      }

      return {
        inside,
        point: pt,
        polygonVertices: poly.length,
      };
    },
  },
  {
    name: "geo_dms_to_decimal",
    description:
      "Convert DMS (degrees, minutes, seconds) to decimal degrees. Transform traditional coordinate format to decimal for GPS and mapping. Use for data import, coordinate conversion, or legacy data. Keywords: DMS to decimal, degrees minutes seconds, coordinate convert, GPS format, traditional coords.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        degrees: { type: "number", description: "Degrees" },
        minutes: { type: "number", description: "Minutes" },
        seconds: { type: "number", description: "Seconds" },
        direction: {
          type: "string",
          enum: ["N", "S", "E", "W"],
          description: "Cardinal direction",
        },
      },
      required: ["degrees", "minutes", "seconds", "direction"],
    },
    handler: ({ degrees, minutes, seconds, direction }) => {
      let decimal = Math.abs(degrees as number) + (minutes as number) / 60 +
        (seconds as number) / 3600;

      if (direction === "S" || direction === "W") {
        decimal = -decimal;
      }

      return {
        decimal: Math.round(decimal * 1000000) / 1000000,
        dms: { degrees, minutes, seconds, direction },
      };
    },
  },
  {
    name: "geo_decimal_to_dms",
    description:
      "Convert decimal degrees to DMS (degrees, minutes, seconds). Transform GPS coordinates to traditional format for display or printing. Use for coordinate formatting, map labels, or human-readable output. Keywords: decimal to DMS, degrees minutes seconds, format coordinate, GPS to DMS, readable coords.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        decimal: { type: "number", description: "Decimal degrees" },
        type: { type: "string", enum: ["lat", "lon"], description: "Latitude or longitude" },
      },
      required: ["decimal", "type"],
    },
    handler: ({ decimal, type }) => {
      const isNegative = (decimal as number) < 0;
      let absDecimal = Math.abs(decimal as number);

      const degrees = Math.floor(absDecimal);
      const minFloat = (absDecimal - degrees) * 60;
      const minutes = Math.floor(minFloat);
      const seconds = Math.round((minFloat - minutes) * 60 * 1000) / 1000;

      let direction: string;
      if (type === "lat") {
        direction = isNegative ? "S" : "N";
      } else {
        direction = isNegative ? "W" : "E";
      }

      return {
        degrees,
        minutes,
        seconds,
        direction,
        formatted: `${degrees}°${minutes}'${seconds}"${direction}`,
        decimal,
      };
    },
  },
  {
    name: "geo_validate",
    description:
      "Validate latitude and longitude coordinates. Check if coordinates are within valid ranges (-90 to 90 for lat, -180 to 180 for lon). Use for input validation, data cleaning, or error checking. Keywords: validate coordinates, check lat lon, coordinate range, valid GPS, bounds check.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude to validate" },
        lon: { type: "number", description: "Longitude to validate" },
      },
      required: ["lat", "lon"],
    },
    handler: ({ lat, lon }) => {
      const latValid = (lat as number) >= -90 && (lat as number) <= 90;
      const lonValid = (lon as number) >= -180 && (lon as number) <= 180;

      return {
        valid: latValid && lonValid,
        lat: {
          value: lat,
          valid: latValid,
          error: latValid ? null : "Latitude must be between -90 and 90",
        },
        lon: {
          value: lon,
          valid: lonValid,
          error: lonValid ? null : "Longitude must be between -180 and 180",
        },
      };
    },
  },
  {
    name: "geo_area",
    description:
      "Calculate area of a polygon in square kilometers or miles. Compute surface area of closed geographic region using spherical excess formula. Use for land area, coverage zones, or territory sizing. Keywords: polygon area, surface area, land size, zone area, territory, square km.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        polygon: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
            },
          },
          description: "Polygon vertices as [{lat, lon}, ...]",
        },
        unit: {
          type: "string",
          enum: ["km2", "mi2", "m2", "ha"],
          description: "Area unit (default: km2)",
        },
      },
      required: ["polygon"],
    },
    handler: ({ polygon, unit = "km2" }) => {
      const poly = polygon as Array<{ lat: number; lon: number }>;

      if (poly.length < 3) {
        return { error: "Polygon must have at least 3 vertices" };
      }

      // Shoelace formula with spherical correction
      let area = 0;
      const n = poly.length;

      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const lat1 = toRad(poly[i].lat);
        const lat2 = toRad(poly[j].lat);
        const dLon = toRad(poly[j].lon - poly[i].lon);

        area += dLon * (2 + Math.sin(lat1) + Math.sin(lat2));
      }

      area = Math.abs(area * EARTH_RADIUS.km * EARTH_RADIUS.km / 2);

      // Convert units
      let result = area;
      switch (unit) {
        case "mi2":
          result = area * 0.386102;
          break;
        case "m2":
          result = area * 1000000;
          break;
        case "ha":
          result = area * 100;
          break;
      }

      return {
        area: Math.round(result * 1000) / 1000,
        unit,
        vertices: n,
      };
    },
  },
  {
    name: "geo_nearest",
    description:
      "Find the nearest point from a list to a reference point. Sort locations by distance and return closest. Use for store locator, nearest neighbor, or proximity search. Keywords: nearest point, closest location, proximity, store locator, find nearest, sort by distance.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        reference: {
          type: "object",
          properties: {
            lat: { type: "number" },
            lon: { type: "number" },
          },
          description: "Reference point {lat, lon}",
        },
        points: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
              id: { type: "string" },
            },
          },
          description: "Points to search [{lat, lon, id?}, ...]",
        },
        limit: { type: "number", description: "Max results to return (default: 1)" },
        maxDistance: { type: "number", description: "Max distance in km (optional)" },
      },
      required: ["reference", "points"],
    },
    handler: ({ reference, points, limit = 1, maxDistance }) => {
      const ref = reference as { lat: number; lon: number };
      const pts = points as Array<{ lat: number; lon: number; id?: string }>;

      // Calculate distances
      const withDistance = pts.map((p, index) => {
        const dLat = toRad(p.lat - ref.lat);
        const dLon = toRad(p.lon - ref.lon);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(ref.lat)) * Math.cos(toRad(p.lat)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = EARTH_RADIUS.km * c;

        return {
          ...p,
          index,
          distance: Math.round(distance * 1000) / 1000,
        };
      });

      // Filter by max distance if specified
      let filtered = withDistance;
      if (maxDistance !== undefined) {
        filtered = withDistance.filter((p) => p.distance <= (maxDistance as number));
      }

      // Sort by distance and limit
      const sorted = filtered.sort((a, b) => a.distance - b.distance).slice(0, limit as number);

      return {
        reference: ref,
        results: sorted,
        totalPoints: pts.length,
        withinRange: filtered.length,
      };
    },
  },
  {
    name: "geo_center",
    description:
      "Calculate geographic center (centroid) of multiple points. Find the average location of a set of coordinates. Use for cluster center, meeting point, or average location. Keywords: centroid, center point, average location, geographic mean, cluster center.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        points: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
            },
          },
          description: "Points to center [{lat, lon}, ...]",
        },
      },
      required: ["points"],
    },
    handler: ({ points }) => {
      const pts = points as Array<{ lat: number; lon: number }>;

      if (pts.length === 0) {
        return { error: "No points provided" };
      }

      // Convert to Cartesian, average, convert back
      let x = 0, y = 0, z = 0;

      for (const p of pts) {
        const lat = toRad(p.lat);
        const lon = toRad(p.lon);
        x += Math.cos(lat) * Math.cos(lon);
        y += Math.cos(lat) * Math.sin(lon);
        z += Math.sin(lat);
      }

      const n = pts.length;
      x /= n;
      y /= n;
      z /= n;

      const lon = Math.atan2(y, x);
      const hyp = Math.sqrt(x * x + y * y);
      const lat = Math.atan2(z, hyp);

      return {
        center: {
          lat: Math.round(toDeg(lat) * 1000000) / 1000000,
          lon: Math.round(toDeg(lon) * 1000000) / 1000000,
        },
        pointCount: n,
      };
    },
  },
  {
    name: "geo_distance_matrix",
    description:
      "Calculate distance matrix between multiple points. Get all pairwise distances for route optimization or clustering. Use for TSP, delivery optimization, or distance analysis. Keywords: distance matrix, all pairs, pairwise distance, route optimization, TSP, clustering.",
    category: "geo",
    inputSchema: {
      type: "object",
      properties: {
        points: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
              id: { type: "string" },
            },
          },
          description: "Points for matrix [{lat, lon, id?}, ...]",
        },
        unit: {
          type: "string",
          enum: ["km", "mi", "m"],
          description: "Distance unit (default: km)",
        },
      },
      required: ["points"],
    },
    handler: ({ points, unit = "km" }) => {
      const pts = points as Array<{ lat: number; lon: number; id?: string }>;
      const R = EARTH_RADIUS[unit as keyof typeof EARTH_RADIUS] || EARTH_RADIUS.km;

      const matrix: number[][] = [];

      for (let i = 0; i < pts.length; i++) {
        matrix[i] = [];
        for (let j = 0; j < pts.length; j++) {
          if (i === j) {
            matrix[i][j] = 0;
          } else {
            const dLat = toRad(pts[j].lat - pts[i].lat);
            const dLon = toRad(pts[j].lon - pts[i].lon);
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(pts[i].lat)) * Math.cos(toRad(pts[j].lat)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            matrix[i][j] = Math.round(R * c * 1000) / 1000;
          }
        }
      }

      return {
        matrix,
        labels: pts.map((p, i) => p.id || `Point ${i}`),
        unit,
        size: pts.length,
      };
    },
  },
];
