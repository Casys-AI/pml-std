
import { GraphNodeData } from "../components/ui/mod.ts";
import { CapabilityData } from "../islands/D3GraphVisualization.tsx";

interface NodePosition {
  id: string;
  x: number;
  y: number;
}

/**
 * Computes positions for a bipartite graph with clustering (grappes).
 *
 * Layout: Capabilities on LEFT, Tools on RIGHT
 * Tools cluster around their parent capabilities vertically.
 * Uses force-simulation-like repulsion to prevent overlap.
 *
 * @param capabilities List of capability nodes
 * @param tools List of tool nodes
 * @param width Container width
 * @param height Container height
 * @param padding Padding around the graph
 */
export function computeBipartitePositions(
  capabilities: CapabilityData[],
  tools: GraphNodeData[],
  width: number,
  height: number,
  padding = 50
): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();

  // Proportional margins (not fixed pixels)
  const leftX = width * 0.15;  // 15% from left
  const rightX = width * 0.85; // 85% from left (15% from right)
  const centerX = width * 0.5;

  const availableHeight = height - (padding * 2);
  const startY = padding;

  // ─────────────────────────────────────────────────────────────────────
  // 1. Position Capabilities (Left Column) - evenly distributed
  // ─────────────────────────────────────────────────────────────────────

  // Sort by tool count (most connected at top for visibility)
  const sortedCaps = [...capabilities].sort((a, b) => b.toolsCount - a.toolsCount);

  const capSpacing = availableHeight / Math.max(sortedCaps.length, 1);

  sortedCaps.forEach((cap, index) => {
    positions.set(cap.id, {
      id: cap.id,
      x: leftX,
      y: startY + (index + 0.5) * capSpacing
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. Position Tools (Right side) - clustered by capability
  // ─────────────────────────────────────────────────────────────────────

  // Group tools by their primary capability (first parent)
  const toolsByPrimaryCap = new Map<string, GraphNodeData[]>();
  const orphanTools: GraphNodeData[] = [];

  tools.forEach(tool => {
    const parents = tool.parents || [];
    if (parents.length === 0) {
      orphanTools.push(tool);
    } else {
      // Use first parent as primary
      const primaryCap = parents[0];
      if (!toolsByPrimaryCap.has(primaryCap)) {
        toolsByPrimaryCap.set(primaryCap, []);
      }
      toolsByPrimaryCap.get(primaryCap)!.push(tool);
    }
  });

  // Position each cluster of tools near their capability
  const nodeRadius = 12;
  const clusterSpread = 40; // How far tools spread from cluster center

  sortedCaps.forEach((cap) => {
    const capPos = positions.get(cap.id);
    if (!capPos) return;

    const clusterTools = toolsByPrimaryCap.get(cap.id) || [];
    if (clusterTools.length === 0) return;

    // Arrange tools in a small arc/cluster to the right of the capability
    const clusterCenterX = rightX;
    const clusterCenterY = capPos.y;

    clusterTools.forEach((tool, i) => {
      const count = clusterTools.length;

      if (count === 1) {
        // Single tool: place directly at cluster center
        positions.set(tool.id, {
          id: tool.id,
          x: clusterCenterX,
          y: clusterCenterY
        });
      } else {
        // Multiple tools: arrange in vertical cluster with slight horizontal variation
        const verticalSpread = Math.min(clusterSpread * 2, capSpacing * 0.8);
        const yOffset = (i - (count - 1) / 2) * (verticalSpread / count);

        // Add slight X variation for visual clustering effect
        const xVariation = Math.sin(i * 0.8) * 15;

        positions.set(tool.id, {
          id: tool.id,
          x: clusterCenterX + xVariation,
          y: clusterCenterY + yOffset
        });
      }
    });
  });

  // Position orphan tools at the bottom
  const orphanStartY = height - padding - (orphanTools.length * nodeRadius * 2.5);
  orphanTools.forEach((tool, i) => {
    positions.set(tool.id, {
      id: tool.id,
      x: centerX + Math.sin(i * 0.5) * 30,
      y: Math.max(orphanStartY + i * nodeRadius * 2.5, startY)
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Collision resolution - simple repulsion pass
  // ─────────────────────────────────────────────────────────────────────

  const allNodes = [...positions.entries()];
  const minDist = nodeRadius * 2.5;

  // Run a few iterations of repulsion
  for (let iter = 0; iter < 50; iter++) {
    let moved = false;

    for (let i = 0; i < allNodes.length; i++) {
      const [_idA, posA] = allNodes[i];

      for (let j = i + 1; j < allNodes.length; j++) {
        const [_idB, posB] = allNodes[j];

        const dx = posB.x - posA.x;
        const dy = posB.y - posA.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < minDist && dist > 0) {
          // Push apart
          const overlap = (minDist - dist) / 2;
          const _nx = dx / dist;
          const ny = dy / dist;

          // Only move in Y to preserve bipartite structure
          posA.y -= ny * overlap * 0.5;
          posB.y += ny * overlap * 0.5;

          // Clamp to bounds
          posA.y = Math.max(startY, Math.min(height - padding, posA.y));
          posB.y = Math.max(startY, Math.min(height - padding, posB.y));

          moved = true;
        }
      }
    }

    if (!moved) break;
  }

  // Update positions map with resolved positions
  allNodes.forEach(([id, pos]) => {
    positions.set(id, pos);
  });

  return positions;
}
