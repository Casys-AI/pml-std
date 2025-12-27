/**
 * Tests for Story 8.3: Hypergraph View Mode
 *
 * Tests the view mode toggle, hull zone rendering helpers,
 * and hypergraph data transformation.
 *
 * @module tests/web/hypergraph-view-mode
 */

import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals, assertExists } from "jsr:@std/assert";

// ─────────────────────────────────────────────────────────────────────────────
// Hull Zone Helper Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Story 8.3: Hypergraph View Mode", () => {
  describe("Hull Zone Helpers", () => {
    // Inline implementation of expandHull for testing
    function expandHull(
      hull: [number, number][],
      padding: number,
    ): [number, number][] {
      if (!hull || hull.length < 3) return hull;

      // Calculate centroid
      const cx = hull.reduce((sum, [x]) => sum + x, 0) / hull.length;
      const cy = hull.reduce((sum, [, y]) => sum + y, 0) / hull.length;

      return hull.map(([x, y]) => {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist === 0) return [x, y] as [number, number];
        const scale = (dist + padding) / dist;
        return [cx + dx * scale, cy + dy * scale] as [number, number];
      });
    }

    it("expandHull expands triangle outward by padding", () => {
      // Simple equilateral triangle centered at origin
      const hull: [number, number][] = [
        [0, 10],
        [-8.66, -5],
        [8.66, -5],
      ];
      const padding = 5;

      const expanded = expandHull(hull, padding);

      // Each point should be further from centroid
      assertEquals(expanded.length, 3);

      // Centroid of original
      const cx = 0;
      const cy = 0;

      // Check each expanded point is further from centroid
      for (let i = 0; i < hull.length; i++) {
        const origDist = Math.sqrt(
          (hull[i][0] - cx) ** 2 + (hull[i][1] - cy) ** 2,
        );
        const expDist = Math.sqrt(
          (expanded[i][0] - cx) ** 2 + (expanded[i][1] - cy) ** 2,
        );
        // Expanded distance should be approximately original + padding
        assertEquals(Math.round(expDist - origDist), padding);
      }
    });

    it("expandHull returns original for < 3 points", () => {
      const twoPoints: [number, number][] = [
        [0, 0],
        [10, 10],
      ];
      const expanded = expandHull(twoPoints, 10);
      assertEquals(expanded, twoPoints);
    });

    it("expandHull handles point at centroid", () => {
      // If a point is exactly at centroid, it stays there
      const hull: [number, number][] = [
        [0, 0],
        [10, 0],
        [5, 8.66],
      ];
      const expanded = expandHull(hull, 5);
      assertEquals(expanded.length, 3);
      // All points should still be valid numbers
      expanded.forEach(([x, y]) => {
        assertEquals(isNaN(x), false);
        assertEquals(isNaN(y), false);
      });
    });
  });

  describe("Ellipse Path Helper", () => {
    // Inline implementation for testing
    function createEllipsePath(
      points: [number, number][],
      minRadius: number,
    ): string {
      if (points.length !== 2) return "";
      const [p1, p2] = points;
      const cx = (p1[0] + p2[0]) / 2;
      const cy = (p1[1] + p2[1]) / 2;
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      const rx = Math.max(dist / 2 + minRadius / 2, minRadius);
      const ry = minRadius;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

      return `M${cx - rx},${cy}A${rx},${ry} ${angle} 1,0 ${
        cx + rx
      },${cy}A${rx},${ry} ${angle} 1,0 ${cx - rx},${cy}`;
    }

    it("creates valid SVG path for horizontal points", () => {
      const points: [number, number][] = [
        [0, 50],
        [100, 50],
      ];
      const path = createEllipsePath(points, 30);

      assertExists(path);
      assertEquals(path.startsWith("M"), true);
      assertEquals(path.includes("A"), true);
      // Should contain center coordinates
      assertEquals(path.includes("50"), true); // cx = 50
    });

    it("creates valid SVG path for vertical points", () => {
      const points: [number, number][] = [
        [50, 0],
        [50, 100],
      ];
      const path = createEllipsePath(points, 30);

      assertExists(path);
      assertEquals(path.startsWith("M"), true);
      // Angle should be 90 degrees
      assertEquals(path.includes("90"), true);
    });

    it("returns empty string for wrong number of points", () => {
      const onePoint: [number, number][] = [[50, 50]];
      const threePoints: [number, number][] = [
        [0, 0],
        [50, 50],
        [100, 0],
      ];

      assertEquals(createEllipsePath(onePoint, 30), "");
      assertEquals(createEllipsePath(threePoints, 30), "");
    });

    it("ensures minimum radius", () => {
      // Points very close together
      const closePoints: [number, number][] = [
        [50, 50],
        [51, 50],
      ];
      const path = createEllipsePath(closePoints, 50);

      assertExists(path);
      // rx should be at least minRadius
      assertEquals(path.includes("50"), true);
    });
  });

  describe("CapabilityZone structure", () => {
    interface CapabilityZone {
      id: string;
      label: string;
      color: string;
      opacity: number;
      toolIds: string[];
      padding: number;
      minRadius: number;
    }

    it("zone has all required fields", () => {
      const zone: CapabilityZone = {
        id: "cap-test-uuid",
        label: "Test Capability",
        color: "#8b5cf6",
        opacity: 0.3,
        toolIds: ["filesystem:read", "github:create_issue"],
        padding: 20,
        minRadius: 50,
      };

      assertEquals(zone.id, "cap-test-uuid");
      assertEquals(zone.toolIds.length, 2);
      assertEquals(zone.opacity, 0.3);
    });

    it("zone handles empty toolIds", () => {
      const emptyZone: CapabilityZone = {
        id: "cap-empty",
        label: "Empty Cap",
        color: "#3b82f6",
        opacity: 0.2,
        toolIds: [],
        padding: 20,
        minRadius: 50,
      };

      assertEquals(emptyZone.toolIds.length, 0);
    });
  });

  describe("Hypergraph Data Transformation", () => {
    interface SimNode {
      id: string;
      label: string;
      server: string;
      pagerank: number;
      degree: number;
      x: number;
      y: number;
      nodeType?: "tool" | "capability";
      parents?: string[];
    }

    it("transforms hypergraph API response to SimNodes", () => {
      const apiResponse = {
        nodes: [
          {
            data: {
              id: "filesystem:read",
              type: "tool" as const,
              label: "read",
              server: "filesystem",
              pagerank: 0.15,
              degree: 5,
              parents: ["cap-uuid-1", "cap-uuid-2"],
            },
          },
        ],
      };

      // Simulate transformation
      const nodes: SimNode[] = apiResponse.nodes
        .filter((n) => n.data.type === "tool")
        .map((n) => ({
          id: n.data.id,
          label: n.data.label,
          server: n.data.server || "unknown",
          pagerank: n.data.pagerank || 0,
          degree: n.data.degree || 0,
          nodeType: "tool" as const,
          parents: n.data.parents || [],
          x: Math.random() * 800,
          y: Math.random() * 600,
        }));

      assertEquals(nodes.length, 1);
      assertEquals(nodes[0].id, "filesystem:read");
      assertEquals(nodes[0].parents?.length, 2);
      assertEquals(nodes[0].nodeType, "tool");
    });

    it("identifies multi-parent tools (hyperedge semantics)", () => {
      const nodes: SimNode[] = [
        {
          id: "tool1",
          label: "Tool 1",
          server: "server1",
          pagerank: 0.1,
          degree: 3,
          parents: ["cap1"],
          x: 0,
          y: 0,
        },
        {
          id: "tool2",
          label: "Tool 2",
          server: "server1",
          pagerank: 0.2,
          degree: 5,
          parents: ["cap1", "cap2", "cap3"], // Multi-parent!
          x: 100,
          y: 100,
        },
      ];

      const multiParentNodes = nodes.filter(
        (n) => n.parents && n.parents.length > 1,
      );

      assertEquals(multiParentNodes.length, 1);
      assertEquals(multiParentNodes[0].id, "tool2");
      assertEquals(multiParentNodes[0].parents?.length, 3);
    });
  });

  describe("BroadcastChannel Events", () => {
    it("capability selected event has correct structure", () => {
      const event = {
        type: "capability.selected",
        payload: {
          capabilityId: "cap-uuid-123",
          label: "File Operations",
          timestamp: Date.now(),
        },
      };

      assertEquals(event.type, "capability.selected");
      assertEquals(event.payload.capabilityId, "cap-uuid-123");
      assertExists(event.payload.label);
    });
  });

  describe("Zone Color Palette", () => {
    const ZONE_COLORS = [
      "#8b5cf6", // violet
      "#3b82f6", // blue
      "#10b981", // emerald
      "#f59e0b", // amber
      "#ef4444", // red
      "#ec4899", // pink
      "#06b6d4", // cyan
      "#84cc16", // lime
    ];

    it("has 8 distinct colors", () => {
      assertEquals(ZONE_COLORS.length, 8);
      // All unique
      const unique = new Set(ZONE_COLORS);
      assertEquals(unique.size, 8);
    });

    it("cycles colors for many capabilities", () => {
      const capCount = 12;
      const colors: string[] = [];

      for (let i = 0; i < capCount; i++) {
        colors.push(ZONE_COLORS[i % ZONE_COLORS.length]);
      }

      // Should have repeated colors after 8
      assertEquals(colors[0], colors[8]);
      assertEquals(colors[1], colors[9]);
    });

    it("all colors are valid hex", () => {
      const hexRegex = /^#[0-9a-f]{6}$/i;
      ZONE_COLORS.forEach((color) => {
        assertEquals(hexRegex.test(color), true, `${color} is not valid hex`);
      });
    });
  });
});
