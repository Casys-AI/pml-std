/**
 * Smoke test pour Story 6.2 - Dashboard et API Snapshot
 *
 * Teste simplement que le code ne plante pas et retourne la bonne structure
 */

import { assertEquals, assertExists } from "@std/assert";
import { PGliteClient } from "../../src/db/client.ts";
import { getAllMigrations, MigrationRunner } from "../../src/db/migrations.ts";
import { GraphRAGEngine } from "../../src/graphrag/graph-engine.ts";

// TEST CRITIQUE: getGraphSnapshot() ne plante pas et retourne une structure valide
Deno.test("Smoke test - getGraphSnapshot retourne structure JSON valide", async () => {
  const db = new PGliteClient("memory://");
  await db.connect();

  const migrationRunner = new MigrationRunner(db);
  await migrationRunner.runUp(getAllMigrations());

  const engine = new GraphRAGEngine(db);
  await engine.syncFromDatabase();

  // Appeler getGraphSnapshot
  const snapshot = engine.getGraphSnapshot();

  // Vérifier structure minimale requise pour le dashboard
  assertExists(snapshot);
  assertExists(snapshot.nodes);
  assertExists(snapshot.edges);
  assertExists(snapshot.metadata);

  assertEquals(Array.isArray(snapshot.nodes), true);
  assertEquals(Array.isArray(snapshot.edges), true);

  assertExists(snapshot.metadata.total_nodes);
  assertExists(snapshot.metadata.total_edges);
  assertExists(snapshot.metadata.density);
  assertExists(snapshot.metadata.last_updated);

  // Vérifier que c'est du JSON sérialisable (pas de fonctions, etc.)
  const json = JSON.stringify(snapshot);
  const parsed = JSON.parse(json);

  assertEquals(parsed.metadata.total_nodes, snapshot.metadata.total_nodes);
  assertEquals(parsed.metadata.total_edges, snapshot.metadata.total_edges);

  await db.close();
});

// TEST CRITIQUE: Le Fresh dashboard route existe et contient les éléments requis
Deno.test("Smoke test - Fresh dashboard.tsx exists and contains required elements", async () => {
  // Story 6.2: Dashboard migrated from public/dashboard.html to Fresh
  const routeCode = await Deno.readTextFile("src/web/routes/dashboard.tsx");
  const graphVizCode = await Deno.readTextFile("src/web/islands/D3GraphVisualization.tsx");
  const metricsCode = await Deno.readTextFile("src/web/islands/MetricsPanel.tsx");

  // Vérifier dashboard route
  assertEquals(
    routeCode.includes("Casys PML - Graph Dashboard"),
    true,
    "Route doit avoir le titre",
  );
  assertEquals(
    routeCode.includes("cytoscape") || routeCode.includes("Cytoscape") ||
      routeCode.includes("GraphExplorer"),
    true,
    "Route doit utiliser Cytoscape ou GraphExplorer pour la visualisation",
  );
  assertEquals(
    routeCode.includes("GraphExplorer"),
    true,
    "Route doit utiliser GraphExplorer island",
  );
  assertEquals(
    routeCode.includes("MetricsPanel"),
    true,
    "Route doit utiliser MetricsPanel island (Story 6.3)",
  );

  // Vérifier GraphVisualization island (composant avec API/SSE)
  assertEquals(
    graphVizCode.includes("/api/graph/hypergraph"),
    true,
    "Island doit appeler l'API hypergraph",
  );
  assertEquals(graphVizCode.includes("/events/stream"), true, "Island doit se connecter au SSE");
  assertEquals(
    graphVizCode.includes("EventSource"),
    true,
    "Island doit utiliser EventSource pour SSE",
  );

  // Vérifier MetricsPanel island (Story 6.3)
  assertEquals(
    metricsCode.includes("/api/metrics"),
    true,
    "MetricsPanel doit appeler l'API metrics",
  );
  assertEquals(metricsCode.includes("Chart"), true, "MetricsPanel doit utiliser Chart.js");
});
