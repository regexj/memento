import { loadConfig, resolveSourceServerConfigs } from "./load-config.ts";
import { logger } from "./logger.ts";
import { type McpToolInfo, createMcpClientManager } from "./mcp.ts";
import type { McpServerConfig, SourceServerConfigs } from "./types.ts";
import { errorMessage } from "./util.ts";
import { fileURLToPath } from "node:url";

/**
 * Lists available MCP tools for each configured server. Useful when wiring
 * up a new source — the canonical way to discover tool names and schemas
 * without guessing.
 *
 * Usage:
 *   npm run list-tools                          # list tools for every server
 *   npm run list-tools -- github                # filter by source name(s)
 *   npm run list-tools -- --schema              # include input schemas
 */

export interface ParsedArgs {
  includeSchema: boolean;
  sourceFilters: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  let includeSchema = false;
  const sourceFilters: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--schema") {
      includeSchema = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    sourceFilters.push(arg);
  }

  return { includeSchema, sourceFilters };
}

export function formatTool(tool: McpToolInfo, includeSchema: boolean): string {
  const lines: string[] = [];
  lines.push(`  • ${tool.name}`);
  if (tool.description !== undefined) {
    const firstLine = tool.description.split("\n")[0];
    lines.push(`      ${firstLine}`);
  }
  if (includeSchema) {
    const schema = JSON.stringify(tool.inputSchema, null, 2)
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n");
    lines.push(schema);
  }
  return lines.join("\n");
}

export function pickServers(
  serverConfigs: SourceServerConfigs,
  sourceFilters: string[],
): Array<{ source: string; config: McpServerConfig }> {
  const entries = Object.entries(serverConfigs).filter(
    (entry): entry is [string, McpServerConfig] => entry[1] !== undefined,
  );
  if (sourceFilters.length === 0) {
    return entries.map(([source, config]) => ({ source, config }));
  }

  const knownSources = new Set(entries.map(([source]) => source));
  const unknown = sourceFilters.filter((name) => !knownSources.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown source(s): ${unknown.join(", ")}. Configured sources: ${[...knownSources].join(", ") || "(none)"}`,
    );
  }
  return entries
    .filter(([source]) => sourceFilters.includes(source))
    .map(([source, config]) => ({ source, config }));
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const serverConfigs = resolveSourceServerConfigs(config);

  const servers = pickServers(serverConfigs, args.sourceFilters);
  if (servers.length === 0) {
    process.stdout.write(
      "No MCP servers configured. Check your memento.config.ts sources.\n",
    );
    return;
  }

  const manager = createMcpClientManager();
  let hadFailure = false;
  try {
    for (const { source, config: serverConfig } of servers) {
      process.stdout.write(
        `\n=== ${source} (server: "${serverConfig.name}") ===\n`,
      );
      try {
        const client = await manager.connect(serverConfig);
        const tools = await manager.listTools(client);
        if (tools.length === 0) {
          process.stdout.write("  (no tools exposed)\n");
          continue;
        }
        const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
        for (const tool of sorted) {
          process.stdout.write(`${formatTool(tool, args.includeSchema)}\n`);
        }
        process.stdout.write(`  (${tools.length} tool(s))\n`);
      } catch (error) {
        hadFailure = true;
        process.stdout.write(`  Failed: ${errorMessage(error)}\n`);
        logger.error(
          `Failed to list tools for source "${source}"`,
          errorMessage(error),
        );
      }
    }
  } finally {
    await manager.disconnectAll();
  }

  if (hadFailure) {
    process.exitCode = 1;
  }
}

export function run(): void {
  main().catch((error: unknown) => {
    const message = errorMessage(error);
    process.stdout.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}

/* v8 ignore start */
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  run();
}
/* v8 ignore stop */
