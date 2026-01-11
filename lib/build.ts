#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
/**
 * Bundle std (standard library) for sandbox use
 *
 * Creates a single ESM bundle with all dependencies inlined.
 * The bundle can be loaded in a Deno worker without external imports.
 *
 * Usage: deno task build:std
 *
 * @module lib/std/build
 */

import * as esbuild from "npm:esbuild@0.24.0";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@0.11.0";
import * as log from "@std/log";

const entryPoint = new URL("./mod.ts", import.meta.url).pathname;
const outFile = new URL("./bundle.js", import.meta.url).pathname;

log.info("📦 Building std bundle...");
log.info(`   Entry: ${entryPoint}`);
log.info(`   Output: ${outFile}`);

const result = await esbuild.build({
  plugins: [...denoPlugins({
    nodeModulesDir: true,
  })],
  entryPoints: [entryPoint],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "browser", // Browser-compatible for Deno workers
  target: "esnext",
  minify: false, // Keep readable for debugging
  sourcemap: "inline",
  mainFields: ["module", "main"], // Resolve ESM first, then CommonJS
  banner: {
    js: `/**
 * Std (Standard Library) Bundle
 * Auto-generated - do not edit manually
 * Generated: ${new Date().toISOString()}
 *
 * This bundle contains all std tools with dependencies inlined
 * for use in sandboxed Deno workers.
 */
`,
  },
});

if (result.errors.length > 0) {
  log.error("❌ Build failed:");
  for (const error of result.errors) {
    log.error(`   ${error.text}`);
  }
  Deno.exit(1);
}

if (result.warnings.length > 0) {
  log.warn("⚠️  Warnings:");
  for (const warning of result.warnings) {
    log.warn(`   ${warning.text}`);
  }
}

// Get file size
const stat = await Deno.stat(outFile);
const sizeKB = (stat.size / 1024).toFixed(1);

log.info(`✅ Bundle created: ${outFile}`);
log.info(`   Size: ${sizeKB} KB`);

await esbuild.stop();
