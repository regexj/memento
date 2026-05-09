import { logger } from "../logger.ts";
import type { McpClientManager } from "../mcp.ts";
import type {
  ActivityItem,
  CollectionWindow,
  McpServerConfig,
} from "../types.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface CollectJiraOptions {
  manager: McpClientManager;
  serverConfig: McpServerConfig;
  window: CollectionWindow;
  username: string;
  baseUrl: string;
}

interface JiraInvocation {
  jql: string;
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

function extractIssuesFromStructured(
  structured: unknown,
): unknown[] | undefined {
  if (!isRecord(structured)) {
    return undefined;
  }
  const items = structured["issues"];
  if (Array.isArray(items)) {
    return items;
  }
  return undefined;
}

function extractIssuesFromContent(content: unknown): unknown[] | undefined {
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
      if (isRecord(parsed) && Array.isArray(parsed["issues"])) {
        return parsed["issues"] as unknown[];
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
  const structured = extractIssuesFromStructured(raw["structuredContent"]);
  if (structured !== undefined) {
    return structured;
  }
  const fromContent = extractIssuesFromContent(raw["content"]);
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
    const issues = parseToolResult(raw);
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

export async function collectJiraActivity(
  options: CollectJiraOptions,
): Promise<ActivityItem[]> {
  const { manager, serverConfig, window, username, baseUrl } = options;

  let client: Client;
  try {
    client = await manager.connect(serverConfig);
  } catch (error) {
    logger.error("Failed to connect to Jira MCP server", errorMessage(error));
    return [];
  }

  const invocations = buildJiraInvocations(username, window);
  const activities: ActivityItem[] = [];
  for (const invocation of invocations) {
    const items = await runJiraInvocation(manager, client, invocation, baseUrl);
    activities.push(...items);
  }

  logger.info(`Collected ${activities.length} Jira activity item(s)`);
  return activities;
}
