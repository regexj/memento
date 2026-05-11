import type { SourceServerConfigs } from "./collector.ts";
import { logger } from "./logger.ts";
import type { McpServerConfig } from "./types.ts";
import { errorDetail } from "./util.ts";
import { readFileSync } from "node:fs";

const DEFAULT_CONFIG_PATH = "./memento.mcp.json";

type BuiltInSource = "github" | "jira" | "confluence" | "calendar" | "drive";

const BUILT_IN_SOURCES: readonly BuiltInSource[] = [
  "github",
  "jira",
  "confluence",
  "calendar",
  "drive",
];

interface RawServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface ParsedConfig {
  mcpServers: Record<string, RawServerEntry>;
  sources: Partial<Record<BuiltInSource, string>>;
}

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  for (const entry of Object.values(value)) {
    if (typeof entry !== "string") {
      return false;
    }
  }
  return true;
}

function parseServerEntry(
  key: string,
  raw: unknown,
  configPath: string,
): RawServerEntry {
  if (!isRecord(raw)) {
    exitWithError(
      `Error: "${configPath}" mcpServers["${key}"] must be an object`,
    );
  }

  const command = raw["command"];
  const url = raw["url"];
  const args = raw["args"];
  const env = raw["env"];
  const headers = raw["headers"];

  if (command !== undefined && typeof command !== "string") {
    exitWithError(
      `Error: "${configPath}" mcpServers["${key}"].command must be a string`,
    );
  }
  if (url !== undefined && typeof url !== "string") {
    exitWithError(
      `Error: "${configPath}" mcpServers["${key}"].url must be a string`,
    );
  }
  if (command === undefined && url === undefined) {
    exitWithError(
      `Error: "${configPath}" mcpServers["${key}"] must define either "command" or "url"`,
    );
  }
  if (command !== undefined && url !== undefined) {
    exitWithError(
      `Error: "${configPath}" mcpServers["${key}"] must define either "command" or "url", not both`,
    );
  }
  if (args !== undefined && !isStringArray(args)) {
    exitWithError(
      `Error: "${configPath}" mcpServers["${key}"].args must be an array of strings`,
    );
  }
  if (env !== undefined && !isStringRecord(env)) {
    exitWithError(
      `Error: "${configPath}" mcpServers["${key}"].env must be an object of string values`,
    );
  }
  if (headers !== undefined && !isStringRecord(headers)) {
    exitWithError(
      `Error: "${configPath}" mcpServers["${key}"].headers must be an object of string values`,
    );
  }
  if (headers !== undefined && command !== undefined) {
    exitWithError(
      `Error: "${configPath}" mcpServers["${key}"].headers is only valid for URL-based (HTTP) servers`,
    );
  }

  const entry: RawServerEntry = {};
  if (typeof command === "string") {
    entry.command = command;
  }
  if (typeof url === "string") {
    entry.url = url;
  }
  if (args !== undefined) {
    entry.args = args;
  }
  if (env !== undefined) {
    entry.env = env;
  }
  if (headers !== undefined) {
    entry.headers = headers;
  }
  return entry;
}

function parseSourcesMap(
  raw: unknown,
  configPath: string,
  serverKeys: ReadonlySet<string>,
): Partial<Record<BuiltInSource, string>> {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    exitWithError(`Error: "${configPath}" "sources" must be an object`);
  }
  const result: Partial<Record<BuiltInSource, string>> = {};
  for (const [sourceName, serverKey] of Object.entries(raw)) {
    if (!(BUILT_IN_SOURCES as readonly string[]).includes(sourceName)) {
      exitWithError(
        `Error: "${configPath}" "sources" has unknown source "${sourceName}". Supported: ${BUILT_IN_SOURCES.join(", ")}`,
      );
    }
    if (typeof serverKey !== "string") {
      exitWithError(
        `Error: "${configPath}" "sources.${sourceName}" must be a string`,
      );
    }
    if (!serverKeys.has(serverKey)) {
      exitWithError(
        `Error: "${configPath}" "sources.${sourceName}" references "${serverKey}" which is not defined in "mcpServers"`,
      );
    }
    result[sourceName as BuiltInSource] = serverKey;
  }
  return result;
}

function parseConfig(text: string, configPath: string): ParsedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = errorDetail(error);
    exitWithError(`Error: failed to parse "${configPath}" as JSON: ${detail}`);
  }
  if (!isRecord(parsed)) {
    exitWithError(`Error: "${configPath}" must be a JSON object`);
  }
  const mcpServersRaw = parsed["mcpServers"];
  if (!isRecord(mcpServersRaw)) {
    exitWithError(`Error: "${configPath}" must contain an "mcpServers" object`);
  }

  const mcpServers: Record<string, RawServerEntry> = {};
  for (const [key, value] of Object.entries(mcpServersRaw)) {
    mcpServers[key] = parseServerEntry(key, value, configPath);
  }

  const sources = parseSourcesMap(
    parsed["sources"],
    configPath,
    new Set(Object.keys(mcpServers)),
  );

  return { mcpServers, sources };
}

function toMcpServerConfig(
  name: string,
  entry: RawServerEntry,
): McpServerConfig {
  const config: McpServerConfig = { name, toolCalls: [] };
  if (entry.command !== undefined) {
    config.command = entry.command;
  }
  if (entry.url !== undefined) {
    config.url = entry.url;
  }
  if (entry.args !== undefined) {
    config.args = entry.args;
  }
  if (entry.env !== undefined) {
    config.env = entry.env;
  }
  if (entry.headers !== undefined) {
    config.headers = entry.headers;
  }
  return config;
}

function resolveServerKey(
  source: BuiltInSource,
  explicitSources: Partial<Record<BuiltInSource, string>>,
  mcpServers: Record<string, RawServerEntry>,
): string | undefined {
  const explicit = explicitSources[source];
  if (explicit !== undefined) {
    return explicit;
  }
  if (Object.prototype.hasOwnProperty.call(mcpServers, source)) {
    return source;
  }
  return undefined;
}

function readConfigFile(configPath: string): string | null {
  try {
    return readFileSync(configPath, "utf-8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      return null;
    }
    const detail = error instanceof Error ? error.message : String(error);
    exitWithError(`Error: failed to read "${configPath}": ${detail}`);
  }
}

/**
 * Loads MCP server configurations for the built-in sources from a JSON
 * config file (default: `./memento.mcp.json`).
 *
 * Expected schema:
 * ```json
 * {
 *   "mcpServers": {
 *     "github":    { "command": "...", "args": [...], "env": {...} },
 *     "atlassian": { "command": "...", "args": [...], "env": {...} }
 *   },
 *   "sources": {
 *     "github":     "github",
 *     "jira":       "atlassian",
 *     "confluence": "atlassian"
 *   }
 * }
 * ```
 *
 * If `sources` is omitted, each built-in source name (github, jira,
 * confluence, calendar, drive) looks up the identically-named key in
 * `mcpServers`. Missing entries cause the source to be omitted from the
 * returned object.
 *
 * Returns an empty object if the config file does not exist so downstream
 * code (tests, custom-only runs) can still function. Any parse/validation
 * error calls process.exit(1).
 */
export function loadSourceServerConfigs(
  configPath: string = DEFAULT_CONFIG_PATH,
): SourceServerConfigs {
  const text = readConfigFile(configPath);
  if (text === null) {
    logger.warn(
      `No MCP server config found at "${configPath}"; all built-in sources will be skipped`,
    );
    return {};
  }

  const parsed = parseConfig(text, configPath);

  const configs: SourceServerConfigs = {};
  for (const source of BUILT_IN_SOURCES) {
    const key = resolveServerKey(source, parsed.sources, parsed.mcpServers);
    if (key === undefined) {
      continue;
    }
    configs[source] = toMcpServerConfig(key, parsed.mcpServers[key]);
  }
  return configs;
}
