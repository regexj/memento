import { logger } from "../logger.ts";
import type { McpClientManager } from "../mcp.ts";
import type {
  ActivityItem,
  CollectionWindow,
  McpServerConfig,
  ToolCallConfig,
} from "../types.ts";
import { errorMessage, formatDate, getString, isRecord } from "../util.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readFile as fsReadFile } from "node:fs/promises";

export interface CollectCustomOptions {
  manager: McpClientManager;
  window: CollectionWindow;
  username: string;
  configPath?: string;
  readFile?: (path: string) => Promise<string>;
}

interface CustomServerDefinition {
  serverConfig: McpServerConfig;
  toolCalls: ToolCallConfig[];
}

interface ParsedCustomConfig {
  servers: CustomServerDefinition[];
}

const DEFAULT_CONFIG_PATH = "./mcp-servers.json";

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    result.push(entry);
  }
  return result;
}

function getStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return undefined;
    }
    result[key] = entry;
  }
  return result;
}

function substituteVariables(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, varName: string) => {
    const value = variables[varName];
    return value !== undefined ? value : match;
  });
}

function substituteArgs(
  args: Record<string, string>,
  variables: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    result[key] = substituteVariables(value, variables);
  }
  return result;
}

function parseToolCall(raw: unknown): ToolCallConfig | null {
  if (!isRecord(raw)) {
    return null;
  }
  const tool = getString(raw["tool"]);
  if (tool === undefined) {
    return null;
  }
  const args = getStringRecord(raw["args"]);
  return { tool, args: args ?? {} };
}

function parseServerDefinition(raw: unknown): CustomServerDefinition | string {
  if (!isRecord(raw)) {
    return "entry is not an object";
  }
  const name = getString(raw["name"]);
  if (name === undefined) {
    return 'missing "name"';
  }
  const command = getString(raw["command"]);
  const url = getString(raw["url"]);
  if (command === undefined && url === undefined) {
    return `server "${name}" must define "command" or "url"`;
  }
  if (command !== undefined && url !== undefined) {
    return `server "${name}" must define either "command" or "url", not both`;
  }

  const toolCallsRaw = raw["toolCalls"];
  if (!Array.isArray(toolCallsRaw)) {
    return `server "${name}" must define a "toolCalls" array`;
  }
  const toolCalls: ToolCallConfig[] = [];
  for (const entry of toolCallsRaw) {
    const parsed = parseToolCall(entry);
    if (parsed === null) {
      return `server "${name}" has an invalid tool call entry`;
    }
    toolCalls.push(parsed);
  }

  const serverConfig: McpServerConfig = { name, toolCalls };
  if (command !== undefined) {
    serverConfig.command = command;
    const args = getStringArray(raw["args"]);
    if (args !== undefined) {
      serverConfig.args = args;
    }
  }
  if (url !== undefined) {
    serverConfig.url = url;
  }
  const env = getStringRecord(raw["env"]);
  if (env !== undefined) {
    serverConfig.env = env;
  }

  return { serverConfig, toolCalls };
}

function parseConfig(text: string): ParsedCustomConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logger.error(
      "Failed to parse custom MCP server config as JSON",
      errorMessage(error),
    );
    return null;
  }
  if (!isRecord(parsed)) {
    logger.error(
      'Custom MCP server config must be a JSON object with a "servers" array',
    );
    return null;
  }
  const serversRaw = parsed["servers"];
  if (!Array.isArray(serversRaw)) {
    logger.error('Custom MCP server config must contain a "servers" array');
    return null;
  }
  const servers: CustomServerDefinition[] = [];
  for (const entry of serversRaw) {
    const result = parseServerDefinition(entry);
    if (typeof result === "string") {
      logger.warn(`Skipping custom MCP server entry: ${result}`);
      continue;
    }
    servers.push(result);
  }
  return { servers };
}

function pickTitle(record: Record<string, unknown>): string | undefined {
  const candidates = ["title", "name", "summary", "subject", "key"];
  for (const key of candidates) {
    const value = getString(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function extractArrayFromStructured(structured: unknown): unknown[] | null {
  if (Array.isArray(structured)) {
    return structured;
  }
  if (!isRecord(structured)) {
    return null;
  }
  for (const value of Object.values(structured)) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return null;
}

function extractArrayFromContent(content: unknown): unknown[] | null {
  if (!Array.isArray(content)) {
    return null;
  }
  for (const entry of content) {
    if (!isRecord(entry)) {
      continue;
    }
    if (entry["type"] !== "text") {
      continue;
    }
    const text = entry["text"];
    if (typeof text !== "string") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (isRecord(parsed)) {
      for (const value of Object.values(parsed)) {
        if (Array.isArray(value)) {
          return value;
        }
      }
    }
  }
  return null;
}

function extractRecords(raw: unknown): unknown[] | null {
  if (!isRecord(raw)) {
    return null;
  }
  const fromStructured = extractArrayFromStructured(raw["structuredContent"]);
  if (fromStructured !== null) {
    return fromStructured;
  }
  return extractArrayFromContent(raw["content"]);
}

function shapeRecord(
  record: unknown,
  serverName: string,
  toolName: string,
): ActivityItem {
  const type = `custom_${serverName}_${toolName}`;
  if (isRecord(record)) {
    const title = pickTitle(record) ?? `${serverName}: ${toolName}`;
    const item: ActivityItem = { type, title, metadata: record };
    const url = getString(record["url"]) ?? getString(record["html_url"]);
    if (url !== undefined) {
      item.url = url;
    }
    return item;
  }
  return {
    type,
    title: `${serverName}: ${toolName}`,
    metadata: { raw: record },
  };
}

function shapeToolCallResult(
  raw: unknown,
  serverName: string,
  toolName: string,
): ActivityItem[] {
  const records = extractRecords(raw);
  if (records === null) {
    return [
      {
        type: `custom_${serverName}_${toolName}`,
        title: `${serverName}: ${toolName}`,
        metadata: { raw },
      },
    ];
  }
  return records.map((record) => shapeRecord(record, serverName, toolName));
}

async function runToolCall(
  manager: McpClientManager,
  client: Client,
  serverName: string,
  toolCall: ToolCallConfig,
  variables: Record<string, string>,
): Promise<ActivityItem[]> {
  const args = substituteArgs(toolCall.args, variables);
  try {
    const raw = await manager.callTool(client, toolCall.tool, args);
    return shapeToolCallResult(raw, serverName, toolCall.tool);
  } catch (error) {
    logger.warn(
      `Custom MCP tool "${toolCall.tool}" on server "${serverName}" failed`,
      errorMessage(error),
    );
    return [];
  }
}

async function runServer(
  manager: McpClientManager,
  definition: CustomServerDefinition,
  variables: Record<string, string>,
): Promise<ActivityItem[]> {
  const { serverConfig, toolCalls } = definition;
  let client: Client;
  try {
    client = await manager.connect(serverConfig);
  } catch (error) {
    logger.error(
      `Failed to connect to custom MCP server "${serverConfig.name}"`,
      errorMessage(error),
    );
    return [];
  }
  const activities: ActivityItem[] = [];
  for (const toolCall of toolCalls) {
    const items = await runToolCall(
      manager,
      client,
      serverConfig.name,
      toolCall,
      variables,
    );
    activities.push(...items);
  }
  return activities;
}

async function readConfigFile(
  configPath: string,
  readFile: (path: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await readFile(configPath);
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      logger.info(
        `No custom MCP server config found at "${configPath}"; skipping custom sources`,
      );
      return null;
    }
    logger.error(
      `Failed to read custom MCP server config at "${configPath}"`,
      errorMessage(error),
    );
    return null;
  }
}

export async function collectCustomActivity(
  options: CollectCustomOptions,
): Promise<ActivityItem[]> {
  const { manager, window, username } = options;
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const readFile =
    options.readFile ?? ((path) => fsReadFile(path, { encoding: "utf-8" }));

  const text = await readConfigFile(configPath, readFile);
  if (text === null) {
    return [];
  }

  const parsed = parseConfig(text);
  if (parsed === null) {
    return [];
  }
  if (parsed.servers.length === 0) {
    logger.info("Custom MCP server config has no valid servers");
    return [];
  }

  const variables: Record<string, string> = {
    USERNAME: username,
    FROM_DATE: formatDate(window.from),
    TO_DATE: formatDate(window.to),
  };

  const activities: ActivityItem[] = [];
  for (const definition of parsed.servers) {
    const items = await runServer(manager, definition, variables);
    activities.push(...items);
  }

  logger.info(`Collected ${activities.length} custom activity item(s)`);
  return activities;
}
