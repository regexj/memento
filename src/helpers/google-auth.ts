/* v8 ignore start */
/**
 * One-time Google OAuth setup script.
 *
 * Spawns the workspace-mcp server and repeatedly calls list_calendars until
 * auth succeeds. The server opens a browser for the OAuth consent flow —
 * complete it there, and this script will detect success.
 *
 * Usage: npm run auth:google
 */
import { config } from "../../memento.config.ts";
import { logger } from "../logger.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import "dotenv/config";

const serverConfig = config.mcpServers["google"];
if (!serverConfig || !("command" in serverConfig)) {
  logger.error(
    'No "google" stdio server found in memento.config.ts mcpServers',
  );
  process.exit(1);
}

logger.startStage("google-auth");
logger.info("Starting workspace-mcp server...");

const transport = new StdioClientTransport({
  command: serverConfig.command,
  args: serverConfig.args,
  env: { ...process.env, ...serverConfig.env } as Record<string, string>,
  stderr: "inherit",
});

const client = new Client(
  { name: "memento-auth", version: "1.0.0" },
  { capabilities: {} },
);

await client.connect(transport);
logger.info("Connected to workspace-mcp.");
logger.info("Triggering OAuth flow — complete the sign-in in your browser.");
logger.info("Waiting for authentication (will retry every 5 seconds)...");

const MAX_ATTEMPTS = 60; // 5 minutes
const DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSuccess(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as Record<string, unknown>;
  // Check if the response has content (successful tool call)
  if (Array.isArray(r["content"])) {
    for (const entry of r["content"]) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>)["type"] === "text"
      ) {
        const text = (entry as Record<string, unknown>)["text"];
        if (
          typeof text === "string" &&
          !text.includes("error") &&
          !text.includes("authorization")
        ) {
          return true;
        }
      }
    }
  }
  // Also check isError flag
  if (r["isError"] === true) return false;
  if (
    r["content"] &&
    Array.isArray(r["content"]) &&
    (r["content"] as unknown[]).length > 0
  ) {
    return true;
  }
  return false;
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    const result = await client.callTool({
      name: "list_calendars",
      arguments: {},
    });

    if (isSuccess(result)) {
      logger.info("Authentication successful! Calendars retrieved.");
      logger.info("Result", JSON.stringify(result, null, 2));
      await client.close();
      logger.endStage("google-auth");
      process.exit(0);
    }

    // Got a response but it's an auth error — keep waiting
    logger.info(`Attempt ${attempt}: awaiting browser auth...`);
  } catch {
    logger.info(`Attempt ${attempt}: awaiting browser auth...`);
  }

  await sleep(DELAY_MS);
}

logger.error("Timed out waiting for authentication (5 minutes).");
logger.info("Run this script again after completing the browser sign-in.");
await client.close();
process.exit(1);
/* v8 ignore end */
