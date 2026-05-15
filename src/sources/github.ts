import { logger } from "../logger.ts";
import type { McpClientManager } from "../mcp.ts";
import type {
  ActivityItem,
  CollectionWindow,
  McpServerConfig,
} from "../types.ts";
import {
  errorMessage,
  formatDate,
  getNumber,
  getString,
  isRecord,
} from "../util.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface CollectGithubOptions {
  manager: McpClientManager;
  serverConfig: McpServerConfig;
  window: CollectionWindow;
  username: string;
}

interface ToolInvocation {
  tool: string;
  query: string;
  type: string;
  shaper: (raw: unknown) => ActivityItem | null;
}

function extractItemsFromStructured(
  structured: unknown,
): unknown[] | undefined {
  if (!isRecord(structured)) {
    return undefined;
  }
  const items = structured["items"];
  if (Array.isArray(items)) {
    return items;
  }
  return undefined;
}

function extractItemsFromContent(content: unknown): unknown[] | undefined {
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
      if (isRecord(parsed) && Array.isArray(parsed["items"])) {
        return parsed["items"];
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
  const structured = extractItemsFromStructured(raw["structuredContent"]);
  if (structured !== undefined) {
    return structured;
  }
  const fromContent = extractItemsFromContent(raw["content"]);
  if (fromContent !== undefined) {
    return fromContent;
  }
  return [];
}

function extractRepoFromHtmlUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  const match = /github\.com\/([^/]+\/[^/]+)/.exec(url);
  return match ? match[1] : undefined;
}

function resolveRepo(item: Record<string, unknown>): string | undefined {
  const repository = item["repository"];
  if (isRecord(repository)) {
    const fullName = getString(repository["full_name"]);
    if (fullName !== undefined) {
      return fullName;
    }
  }
  return extractRepoFromHtmlUrl(getString(item["html_url"]));
}

function shapePrOrIssue(type: string): (raw: unknown) => ActivityItem | null {
  return (raw: unknown): ActivityItem | null => {
    if (!isRecord(raw)) {
      return null;
    }
    const title =
      getString(raw["title"]) ?? `#${getNumber(raw["number"]) ?? "?"}`;
    const item: ActivityItem = { type, title };
    const url = getString(raw["html_url"]);
    if (url !== undefined) {
      item.url = url;
    }
    const repo = resolveRepo(raw);
    if (repo !== undefined) {
      item.repo = repo;
    }
    const description = getString(raw["body"]);
    if (description) {
      item.description = description;
    }
    return item;
  };
}

function buildInvocations(
  username: string,
  window: CollectionWindow,
): ToolInvocation[] {
  const from = formatDate(window.from);
  const to = formatDate(window.to);
  return [
    {
      tool: "search_pull_requests",
      query: `is:pr author:${username} created:${from}..${to}`,
      type: "pr_opened",
      shaper: shapePrOrIssue("pr_opened"),
    },
    {
      tool: "search_pull_requests",
      query: `is:pr author:${username} merged:${from}..${to}`,
      type: "pr_merged",
      shaper: shapePrOrIssue("pr_merged"),
    },
    {
      tool: "search_pull_requests",
      query: `is:pr reviewed-by:${username} updated:${from}..${to}`,
      type: "pr_reviewed",
      shaper: shapePrOrIssue("pr_reviewed"),
    },
    {
      tool: "search_pull_requests",
      query: `is:pr commenter:${username} updated:${from}..${to}`,
      type: "pr_review_comment",
      shaper: shapePrOrIssue("pr_review_comment"),
    },
    {
      tool: "search_issues",
      query: `is:issue assignee:${username} closed:${from}..${to}`,
      type: "issue_closed",
      shaper: shapePrOrIssue("issue_closed"),
    },
  ];
}

async function runInvocation(
  manager: McpClientManager,
  client: Client,
  invocation: ToolInvocation,
): Promise<ActivityItem[]> {
  try {
    const raw = await manager.callTool(client, invocation.tool, {
      query: invocation.query,
    });
    const items = parseToolResult(raw);
    const shaped: ActivityItem[] = [];
    for (const entry of items) {
      const item = invocation.shaper(entry);
      if (item !== null) {
        shaped.push(item);
      }
    }
    return shaped;
  } catch (error) {
    logger.warn(
      `GitHub tool "${invocation.tool}" (${invocation.type}) failed`,
      errorMessage(error),
    );
    return [];
  }
}

export async function collectGithubActivity(
  options: CollectGithubOptions,
): Promise<ActivityItem[]> {
  const { manager, serverConfig, window, username } = options;

  let client: Client;
  try {
    client = await manager.connect(serverConfig);
  } catch (error) {
    logger.error("Failed to connect to GitHub MCP server", errorMessage(error));
    return [];
  }

  const invocations = buildInvocations(username, window);
  const activities: ActivityItem[] = [];
  for (const invocation of invocations) {
    const items = await runInvocation(manager, client, invocation);
    activities.push(...items);
  }

  logger.info(`Collected ${activities.length} GitHub activity item(s)`);
  return activities;
}
