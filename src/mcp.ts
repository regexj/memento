import { logger } from "./logger.ts";
import type { McpServerConfig } from "./types.ts";
import { errorMessage, sleep } from "./util.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import "dotenv/config";
import type { IOType } from "node:child_process";

const RETRY_DELAY_MS = 5000;

/**
 * Resolves how stdio MCP subprocess stderr is routed. Defaults to "ignore".
 * Override with the `MCP_STDIO_STDERR` env var (`inherit` | `pipe` | `ignore`)
 */
function resolveStdioStderr(): IOType {
  const raw = process.env["MCP_STDIO_STDERR"]?.toLowerCase();
  if (raw === "inherit" || raw === "pipe" || raw === "ignore") {
    return raw;
  }
  return "ignore";
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpClientManager {
  connect(serverConfig: McpServerConfig): Promise<Client>;
  callTool(
    client: Client,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  listTools(client: Client): Promise<McpToolInfo[]>;
  disconnectAll(): Promise<void>;
}

interface McpClientManagerOptions {
  retryDelayMs?: number;
  createTransport?: (serverConfig: McpServerConfig) => Transport;
  createClient?: () => Client;
}

function defaultCreateTransport(serverConfig: McpServerConfig): Transport {
  if (serverConfig.command) {
    return new StdioClientTransport({
      command: serverConfig.command,
      ...(serverConfig.args !== undefined ? { args: serverConfig.args } : {}),
      ...(serverConfig.env !== undefined ? { env: serverConfig.env } : {}),
      stderr: resolveStdioStderr(),
    });
  }
  if (serverConfig.url) {
    const options =
      serverConfig.headers !== undefined
        ? { requestInit: { headers: serverConfig.headers } }
        : undefined;
    return new StreamableHTTPClientTransport(
      new URL(serverConfig.url),
      options,
    );
  }
  throw new Error(
    `MCP server "${serverConfig.name}" config must include either "command" (stdio) or "url" (streamable HTTP).`,
  );
}

function defaultCreateClient(): Client {
  return new Client(
    { name: "memento", version: "1.0.0" },
    { capabilities: {} },
  );
}

function createMcpClientManager(
  options: McpClientManagerOptions = {},
): McpClientManager {
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const createTransport = options.createTransport ?? defaultCreateTransport;
  const createClient = options.createClient ?? defaultCreateClient;
  const connectedClients: Client[] = [];
  const clientsByName = new Map<string, Client>();

  async function attemptConnect(
    serverConfig: McpServerConfig,
  ): Promise<Client> {
    const client = createClient();
    const transport = createTransport(serverConfig);
    await client.connect(transport);
    return client;
  }

  function registerClient(serverConfig: McpServerConfig, client: Client): void {
    connectedClients.push(client);
    clientsByName.set(serverConfig.name, client);
  }

  async function connect(serverConfig: McpServerConfig): Promise<Client> {
    const existing = clientsByName.get(serverConfig.name);
    if (existing !== undefined) {
      logger.info(
        `Reusing existing MCP client for server "${serverConfig.name}"`,
      );
      return existing;
    }

    logger.info(`Connecting to MCP server "${serverConfig.name}"`);
    try {
      const client = await attemptConnect(serverConfig);
      registerClient(serverConfig, client);
      logger.info(`Connected to MCP server "${serverConfig.name}"`);
      return client;
    } catch (error) {
      logger.warn(
        `Connection to MCP server "${serverConfig.name}" failed, retrying in ${retryDelayMs}ms`,
        errorMessage(error),
      );
      await sleep(retryDelayMs);
      try {
        const client = await attemptConnect(serverConfig);
        registerClient(serverConfig, client);
        logger.info(`Connected to MCP server "${serverConfig.name}" on retry`);
        return client;
      } catch (retryError) {
        logger.error(
          `Connection to MCP server "${serverConfig.name}" failed after retry`,
          errorMessage(retryError),
        );
        throw retryError;
      }
    }
  }

  async function callTool(
    client: Client,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    logger.info(`Calling MCP tool "${toolName}"`);
    return await client.callTool({ name: toolName, arguments: args });
  }

  async function listTools(client: Client): Promise<McpToolInfo[]> {
    logger.info("Listing MCP tools");
    const response = await client.listTools();
    return response.tools.map((tool) => {
      const info: McpToolInfo = {
        name: tool.name,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      };
      if (tool.description !== undefined) {
        info.description = tool.description;
      }
      return info;
    });
  }

  async function disconnectAll(): Promise<void> {
    const count = connectedClients.length;
    const results = await Promise.allSettled(
      connectedClients.map((client) => client.close()),
    );
    connectedClients.length = 0;
    clientsByName.clear();
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn(
          "Error while disconnecting MCP client",
          errorMessage(result.reason),
        );
      }
    }
    logger.info(`Disconnected ${count} MCP client(s)`);
  }

  return { connect, callTool, listTools, disconnectAll };
}

export {
  createMcpClientManager,
  type McpClientManager,
  type McpClientManagerOptions,
  type McpToolInfo,
};
