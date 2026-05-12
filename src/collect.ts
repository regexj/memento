import { collect } from "./collector.ts";
import { loadConfig, resolveSourceServerConfigs } from "./load-config.ts";
import { logger } from "./logger.ts";
import { getCollectionWindow } from "./marker.ts";
import { createMcpClientManager } from "./mcp.ts";
import { errorMessage } from "./util.ts";
import { fileURLToPath } from "node:url";

/**
 * Collection-only harness. Runs the data-collection side of the pipeline
 * (MCP servers + source modules + collector) without touching the LLM,
 * summarizer, or diary writer. Results are printed as JSON to stdout.
 *
 * The last-run marker is read to compute the collection window, but is
 * NOT updated, so repeated invocations stay reproducible until the real
 * pipeline runs and writes the marker itself.
 *
 * Use-case: configuring a new source module or debugging MCP server configuration.
 */

export async function main(): Promise<void> {
  const config = loadConfig();
  const serverConfigs = resolveSourceServerConfigs(config);
  const window = getCollectionWindow();
  const manager = createMcpClientManager();

  logger.startStage("collect-only");
  try {
    const result = await collect({
      manager,
      window,
      config,
      serverConfigs,
    });

    const enabledSources = Object.entries(config.sources)
      .filter(([, source]) => source?.enabled)
      .map(([name]) => name);

    const output = {
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
      },
      enabledSources,
      failures: result.failures,
      results: result.results,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

    if (result.failures.length > 0) {
      logger.warn(
        `Collection completed with ${result.failures.length} source failure(s): ${result.failures.join(", ")}`,
      );
    }
  } finally {
    await manager.disconnectAll();
    logger.endStage("collect-only");
  }
}

export function run(): void {
  main().catch((error: unknown) => {
    const message = errorMessage(error);
    logger.error("Collection harness failed", message);
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
