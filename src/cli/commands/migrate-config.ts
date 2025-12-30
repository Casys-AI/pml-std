/**
 * Migrate Config Command
 *
 * Migrates legacy YAML configuration to JSON format (ADR-009)
 *
 * @module cli/commands/migrate-config
 */

import { Command } from "@cliffy/command";
import { parse as parseYAML } from "@std/yaml";
import { getAgentCardsConfigPath, getLegacyConfigPath } from "../utils.ts";

/**
 * Create migrate-config command
 *
 * Usage:
 *   pml migrate-config          # Migrate YAML → JSON
 *   pml migrate-config --force  # Overwrite existing JSON
 */
export function createMigrateConfigCommand() {
  return new Command()
    .name("migrate-config")
    .description("Migrate YAML configuration to JSON (ADR-009: MCP ecosystem alignment)")
    .option(
      "--force",
      "Overwrite existing JSON config if it exists",
      { default: false },
    )
    .action(async (options) => {
      const yamlPath = getLegacyConfigPath();
      const jsonPath = getAgentCardsConfigPath();

      console.log("🔄 Migrating configuration: YAML → JSON\n");
      console.log(`  Source: ${yamlPath}`);
      console.log(`  Target: ${jsonPath}\n`);

      // Step 1: Check if YAML config exists
      try {
        await Deno.stat(yamlPath);
      } catch {
        console.log("❌ No YAML config found. Nothing to migrate.");
        console.log(`   Expected location: ${yamlPath}\n`);
        return;
      }

      // Step 2: Check if JSON already exists
      try {
        await Deno.stat(jsonPath);
        if (!options.force) {
          console.log("⚠️  JSON config already exists:");
          console.log(`   ${jsonPath}`);
          console.log("\n   Use --force to overwrite, or delete the JSON file manually.\n");
          return;
        } else {
          console.log("⚠️  Overwriting existing JSON config (--force)\n");
        }
      } catch {
        // JSON doesn't exist - safe to proceed
      }

      // Step 3: Load YAML config
      let yamlConfig: Record<string, unknown>;
      try {
        const yamlContent = await Deno.readTextFile(yamlPath);
        yamlConfig = parseYAML(yamlContent) as Record<string, unknown>;
      } catch (error) {
        console.error(`❌ Failed to parse YAML config: ${error}`);
        Deno.exit(1);
      }

      // Step 4: Transform to JSON-compatible format
      // YAML format: { servers: [...] }
      // JSON format: { mcpServers: { id: {...} } }
      let jsonConfig: Record<string, unknown>;

      if (yamlConfig.servers && Array.isArray(yamlConfig.servers)) {
        // Legacy YAML array format → JSON object format
        jsonConfig = {
          mcpServers: (yamlConfig.servers as Array<Record<string, unknown>>).reduce(
            (acc: Record<string, unknown>, server: Record<string, unknown>) => {
              const serverId = server.id as string;
              acc[serverId] = {
                command: server.command,
                ...(server.args ? { args: server.args } : {}),
                ...(server.env ? { env: server.env } : {}),
              };
              return acc;
            },
            {},
          ),
          context: yamlConfig.context || {
            topK: 10,
            similarityThreshold: 0.7,
          },
          execution: yamlConfig.execution || {
            maxConcurrency: 10,
            timeout: 30000,
          },
        };
      } else if (yamlConfig.mcpServers) {
        // Already in JSON-like format
        jsonConfig = yamlConfig;
      } else {
        console.error("❌ Unknown YAML config format");
        console.error("   Expected: { servers: [...] } or { mcpServers: {...} }");
        Deno.exit(1);
      }

      // Step 5: Write JSON config
      try {
        const jsonContent = JSON.stringify(jsonConfig, null, 2);
        await Deno.writeTextFile(jsonPath, jsonContent);
      } catch (error) {
        console.error(`❌ Failed to write JSON config: ${error}`);
        Deno.exit(1);
      }

      // Step 6: Success message
      console.log("✅ Migration complete!\n");
      console.log(`  JSON config created: ${jsonPath}`);
      console.log(`  Format: MCP ecosystem compatible\n`);

      // Step 7: Suggest cleanup
      console.log("🗑️  You can now delete the old YAML config:");
      console.log(`   rm ${yamlPath}\n`);
      console.log("💡 Tip: Casys PML will now use the JSON config automatically.");
    });
}
