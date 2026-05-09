import { logger } from "../logger.ts";
import type { McpClientManager } from "../mcp.ts";
import type {
  ActivityItem,
  CollectionWindow,
  McpServerConfig,
} from "../types.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface CollectAtlassianOptions {
  manager: McpClientManager;
  serverConfig: McpServerConfig;
  window: CollectionWindow;
  jiraUsername: string;
  jiraBaseUrl: string;
  confluenceBaseUrl?: string;
}

interface JiraInvocation {
  jql: string;
  type: string;
}

interface ConfluenceInvocation {
  cql: string;
  type: string;
}

const STORY_POINT_FIELD_CANDIDATES = [
  "customfield_10016",
  "customfield_10026",
  "storypoints",
  "story_points",
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function extractItemsFromStructured(
  structured: unknown,
  key: string,
): unknown[] | undefined {
  if (!isRecord(structured)) {
    return undefined;
  }
  const items = structured[key];
  if (Array.isArray(items)) {
    return items;
  }
  return undefined;
}

function extractItemsFromContent(
  content: unknown,
  key: string,
): unknown[] | undefined {
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
      if (isRecord(parsed) && Array.isArray(parsed[key])) {
        return parsed[key] as unknown[];
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseToolResult(raw: unknown, key: string): unknown[] {
  if (!isRecord(raw)) {
    return [];
  }
  const structured = extractItemsFromStructured(raw["structuredContent"], key);
  if (structured !== undefined) {
    return structured;
  }
  const fromContent = extractItemsFromContent(raw["content"], key);
  if (fromContent !== undefined) {
    return fromContent;
  }
  return [];
}

function buildTicketUrl(baseUrl: string, ticketKey: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/browse/${ticketKey}`;
}

function extractStoryPoints(
  fields: Record<string, unknown>,
): number | undefined {
  for (const key of STORY_POINT_FIELD_CANDIDATES) {
    const num = getNumber(fields[key]);
    if (num !== undefined) {
      return num;
    }
  }
  return undefined;
}

function extractEpicName(fields: Record<string, unknown>): string | undefined {
  const parent = fields["parent"];
  if (isRecord(parent)) {
    const parentFields = parent["fields"];
    if (isRecord(parentFields)) {
      const summary = getString(parentFields["summary"]);
      if (summary !== undefined) {
        return summary;
      }
    }
  }
  const epic = fields["epic"];
  if (isRecord(epic)) {
    const name = getString(epic["name"]);
    if (name !== undefined) {
      return name;
    }
  }
  return undefined;
}

function extractStatus(fields: Record<string, unknown>): string | undefined {
  const status = fields["status"];
  if (!isRecord(status)) {
    return undefined;
  }
  return getString(status["name"]);
}

function extractIssueType(fields: Record<string, unknown>): string | undefined {
  const issueType = fields["issuetype"];
  if (!isRecord(issueType)) {
    return undefined;
  }
  return getString(issueType["name"]);
}

function shapeJiraIssue(
  type: string,
  baseUrl: string,
): (raw: unknown) => ActivityItem | null {
  return (raw: unknown): ActivityItem | null => {
    if (!isRecord(raw)) {
      return null;
    }
    const key = getString(raw["key"]);
    if (key === undefined) {
      return null;
    }
    const fields = isRecord(raw["fields"]) ? raw["fields"] : {};
    const summary = getString(fields["summary"]) ?? key;

    const item: ActivityItem = {
      type,
      title: summary,
      ticketKey: key,
      url: buildTicketUrl(baseUrl, key),
    };

    const issueType = extractIssueType(fields);
    if (issueType !== undefined) {
      item.issueType = issueType;
    }
    const storyPoints = extractStoryPoints(fields);
    if (storyPoints !== undefined) {
      item.storyPoints = storyPoints;
    }
    const epicName = extractEpicName(fields);
    if (epicName !== undefined) {
      item.epicName = epicName;
    }
    const status = extractStatus(fields);
    if (status !== undefined) {
      item.metadata = { status };
    }

    return item;
  };
}

function buildJiraInvocations(
  username: string,
  window: CollectionWindow,
): JiraInvocation[] {
  const from = formatDate(window.from);
  const to = formatDate(window.to);
  return [
    {
      jql: `assignee = "${username}" AND resolved >= "${from}" AND resolved <= "${to}"`,
      type: "ticket_completed",
    },
    {
      jql: `commentedByUser = "${username}" AND updated >= "${from}" AND updated <= "${to}"`,
      type: "ticket_commented",
    },
    {
      jql: `status CHANGED BY "${username}" DURING ("${from}", "${to}")`,
      type: "ticket_transitioned",
    },
    {
      jql: `reporter = "${username}" AND created >= "${from}" AND created <= "${to}"`,
      type: "ticket_created",
    },
  ];
}

async function runJiraInvocation(
  manager: McpClientManager,
  client: Client,
  invocation: JiraInvocation,
  baseUrl: string,
): Promise<ActivityItem[]> {
  const shaper = shapeJiraIssue(invocation.type, baseUrl);
  try {
    const raw = await manager.callTool(client, "jira_search", {
      jql: invocation.jql,
    });
    const issues = parseToolResult(raw, "issues");
    const shaped: ActivityItem[] = [];
    for (const entry of issues) {
      const item = shaper(entry);
      if (item !== null) {
        shaped.push(item);
      }
    }
    return shaped;
  } catch (error) {
    logger.warn(
      `Jira tool "jira_search" (${invocation.type}) failed`,
      errorMessage(error),
    );
    return [];
  }
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

    return item;
  };
}

function buildConfluenceInvocations(
  username: string,
  window: CollectionWindow,
): ConfluenceInvocation[] {
  const from = formatDate(window.from);
  const to = formatDate(window.to);
  return [
    {
      cql: `type = page AND creator = "${username}" AND created >= "${from}" AND created <= "${to}"`,
      type: "page_created",
    },
    {
      cql: `type = page AND contributor = "${username}" AND lastmodified >= "${from}" AND lastmodified <= "${to}"`,
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
    const pages = parseToolResult(raw, "results");
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

export async function collectAtlassianActivity(
  options: CollectAtlassianOptions,
): Promise<ActivityItem[]> {
  const {
    manager,
    serverConfig,
    window,
    jiraUsername,
    jiraBaseUrl,
    confluenceBaseUrl,
  } = options;

  let client: Client;
  try {
    client = await manager.connect(serverConfig);
  } catch (error) {
    logger.error(
      "Failed to connect to Atlassian MCP server",
      errorMessage(error),
    );
    return [];
  }

  const activities: ActivityItem[] = [];

  const jiraInvocations = buildJiraInvocations(jiraUsername, window);
  for (const invocation of jiraInvocations) {
    const items = await runJiraInvocation(
      manager,
      client,
      invocation,
      jiraBaseUrl,
    );
    activities.push(...items);
  }

  if (confluenceBaseUrl !== undefined) {
    const confluenceInvocations = buildConfluenceInvocations(
      jiraUsername,
      window,
    );
    for (const invocation of confluenceInvocations) {
      const items = await runConfluenceInvocation(
        manager,
        client,
        invocation,
        confluenceBaseUrl,
      );
      activities.push(...items);
    }
  }

  logger.info(`Collected ${activities.length} Atlassian activity item(s)`);
  return activities;
}
