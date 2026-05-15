import { logger } from "../logger.ts";
import type { McpClientManager } from "../mcp.ts";
import type {
  ActivityItem,
  CollectionWindow,
  McpServerConfig,
} from "../types.ts";
import { errorMessage, formatDate, getString, isRecord } from "../util.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface CollectConfluenceOptions {
  manager: McpClientManager;
  serverConfig: McpServerConfig;
  window: CollectionWindow;
  baseUrl: string;
}

interface ConfluenceInvocation {
  cql: string;
  type: string;
}

function extractResultsFromStructured(
  structured: unknown,
): unknown[] | undefined {
  if (!isRecord(structured)) {
    return undefined;
  }
  const result = structured["result"];
  if (typeof result !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (isRecord(parsed) && Array.isArray(parsed["result"])) {
      return parsed["result"] as unknown[];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function extractResultsFromContent(content: unknown): unknown[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
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
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (isRecord(parsed) && Array.isArray(parsed["results"])) {
        return parsed["results"] as unknown[];
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseToolResult(raw: unknown): unknown[] {
  if (!isRecord(raw)) {
    return [];
  }
  const structured = extractResultsFromStructured(raw["structuredContent"]);
  if (structured !== undefined) {
    return structured;
  }
  const fromContent = extractResultsFromContent(raw["content"]);
  if (fromContent !== undefined) {
    return fromContent;
  }
  return [];
}

function extractSpaceName(raw: Record<string, unknown>): string | undefined {
  const space = raw["space"];
  if (!isRecord(space)) {
    return undefined;
  }
  return getString(space["name"]);
}

function resolvePageUrl(
  raw: Record<string, unknown>,
  baseUrl: string,
): string | undefined {
  const direct = getString(raw["url"]);
  if (direct !== undefined) {
    return direct;
  }
  const links = raw["_links"];
  if (isRecord(links)) {
    const webui = getString(links["webui"]);
    if (webui !== undefined) {
      const trimmed = baseUrl.replace(/\/+$/, "");
      const path = webui.startsWith("/") ? webui : `/${webui}`;
      return `${trimmed}${path}`;
    }
  }
  return undefined;
}

function shapeConfluencePage(
  type: string,
  baseUrl: string,
): (raw: unknown) => ActivityItem | null {
  return (raw: unknown): ActivityItem | null => {
    if (!isRecord(raw)) {
      return null;
    }
    const title = getString(raw["title"]);
    if (title === undefined) {
      return null;
    }

    const item: ActivityItem = { type, title };

    const url = resolvePageUrl(raw, baseUrl);
    if (url !== undefined) {
      item.url = url;
    }

    const spaceName = extractSpaceName(raw);
    if (spaceName !== undefined) {
      item.spaceName = spaceName;
    }

    if (isRecord(raw["content"])) {
      item.description = getString(raw["content"]["value"]);
    }

    return item;
  };
}

function buildConfluenceInvocations(
  window: CollectionWindow,
): ConfluenceInvocation[] {
  const from = formatDate(window.from);
  const to = formatDate(window.to);
  return [
    {
      cql: `type = page AND creator = currentUser() AND created >= "${from}" AND created <= "${to}"`,
      type: "page_created",
    },
    {
      cql: `type = page AND contributor = currentUser() AND lastmodified >= "${from}" AND lastmodified <= "${to}"`,
      type: "page_edited",
    },
  ];
}

async function runConfluenceInvocation(
  manager: McpClientManager,
  client: Client,
  invocation: ConfluenceInvocation,
  baseUrl: string,
): Promise<ActivityItem[]> {
  const shaper = shapeConfluencePage(invocation.type, baseUrl);
  try {
    const raw = await manager.callTool(client, "confluence_search", {
      query: invocation.cql,
    });
    const pages = parseToolResult(raw);
    const shaped: ActivityItem[] = [];
    for (const entry of pages) {
      const item = shaper(entry);
      if (item !== null) {
        shaped.push(item);
      }
    }
    return shaped;
  } catch (error) {
    logger.warn(
      `Confluence tool "confluence_search" (${invocation.type}) failed`,
      errorMessage(error),
    );
    return [];
  }
}

export async function collectConfluenceActivity(
  options: CollectConfluenceOptions,
): Promise<ActivityItem[]> {
  const { manager, serverConfig, window, baseUrl } = options;

  let client: Client;
  try {
    client = await manager.connect(serverConfig);
  } catch (error) {
    logger.error(
      "Failed to connect to Confluence MCP server",
      errorMessage(error),
    );
    return [];
  }

  const invocations = buildConfluenceInvocations(window);
  const activities: ActivityItem[] = [];
  for (const invocation of invocations) {
    const items = await runConfluenceInvocation(
      manager,
      client,
      invocation,
      baseUrl,
    );
    activities.push(...items);
  }

  logger.info(`Collected ${activities.length} Confluence activity item(s)`);
  return activities;
}
