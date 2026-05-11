import { logger } from "../logger.ts";
import type { McpClientManager } from "../mcp.ts";
import type {
  ActivityItem,
  CollectionWindow,
  McpServerConfig,
} from "../types.ts";
import { errorMessage, getString, isRecord } from "../util.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface CollectDriveOptions {
  manager: McpClientManager;
  serverConfig: McpServerConfig;
  window: CollectionWindow;
  attachmentFileIds?: string[];
}

interface AuthoredFileMeta {
  title: string;
  url?: string;
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

function parseArrayToolResult(raw: unknown, key: string): unknown[] {
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

function extractObjectFromStructured(
  structured: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(structured)) {
    return undefined;
  }
  const nested = structured[key];
  if (isRecord(nested)) {
    return nested;
  }
  return structured;
}

function extractObjectFromContent(
  content: unknown,
  key: string,
): Record<string, unknown> | undefined {
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
      if (!isRecord(parsed)) {
        return undefined;
      }
      const nested = parsed[key];
      if (isRecord(nested)) {
        return nested;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseObjectToolResult(
  raw: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const structured = extractObjectFromStructured(raw["structuredContent"], key);
  if (structured !== undefined) {
    return structured;
  }
  return extractObjectFromContent(raw["content"], key);
}

function buildSearchQuery(window: CollectionWindow): string {
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  return `modifiedTime >= '${from}' and modifiedTime <= '${to}' and ('me' in owners or 'me' in writers)`;
}

async function collectAuthoredDocuments(
  manager: McpClientManager,
  client: Client,
  window: CollectionWindow,
  authoredByFileId: Map<string, AuthoredFileMeta>,
): Promise<ActivityItem[]> {
  const items: ActivityItem[] = [];
  try {
    const raw = await manager.callTool(client, "search_files", {
      q: buildSearchQuery(window),
    });
    const files = parseArrayToolResult(raw, "files");
    for (const entry of files) {
      if (!isRecord(entry)) {
        continue;
      }
      const id = getString(entry["id"]);
      const name = getString(entry["name"]);
      if (id === undefined || name === undefined) {
        continue;
      }
      if (authoredByFileId.has(id)) {
        continue;
      }
      const item: ActivityItem = {
        type: "drive_document_authored",
        title: name,
        fileId: id,
      };
      const url = getString(entry["webViewLink"]);
      if (url !== undefined) {
        item.url = url;
      }
      const lastModified = getString(entry["modifiedTime"]);
      if (lastModified !== undefined) {
        item.lastModified = lastModified;
      }
      const meta: AuthoredFileMeta = { title: name };
      if (url !== undefined) {
        meta.url = url;
      }
      authoredByFileId.set(id, meta);
      items.push(item);
    }
  } catch (error) {
    logger.warn('Drive tool "search_files" failed', errorMessage(error));
  }
  return items;
}

async function fetchMeetingNotes(
  manager: McpClientManager,
  client: Client,
  fileId: string,
  authoredByFileId: Map<string, AuthoredFileMeta>,
): Promise<ActivityItem | null> {
  try {
    const raw = await manager.callTool(client, "read_file_content", {
      fileId,
    });
    const contentObject = parseObjectToolResult(raw, "content");
    const content =
      contentObject !== undefined
        ? getString(contentObject["content"])
        : undefined;
    if (content === undefined) {
      return null;
    }
    const existing = authoredByFileId.get(fileId);
    const item: ActivityItem = {
      type: "drive_meeting_notes",
      title: existing?.title ?? fileId,
      fileId,
      metadata: { content },
    };
    if (existing?.url !== undefined) {
      item.url = existing.url;
    }
    return item;
  } catch (error) {
    logger.warn(
      `Drive tool "read_file_content" failed for fileId "${fileId}"`,
      errorMessage(error),
    );
    return null;
  }
}

export async function collectDriveActivity(
  options: CollectDriveOptions,
): Promise<ActivityItem[]> {
  const { manager, serverConfig, window, attachmentFileIds } = options;

  let client: Client;
  try {
    client = await manager.connect(serverConfig);
  } catch (error) {
    logger.error("Failed to connect to Drive MCP server", errorMessage(error));
    return [];
  }

  const authoredByFileId = new Map<string, AuthoredFileMeta>();
  const activities: ActivityItem[] = [];

  const authoredItems = await collectAuthoredDocuments(
    manager,
    client,
    window,
    authoredByFileId,
  );
  activities.push(...authoredItems);

  if (attachmentFileIds !== undefined && attachmentFileIds.length > 0) {
    for (const fileId of attachmentFileIds) {
      const item = await fetchMeetingNotes(
        manager,
        client,
        fileId,
        authoredByFileId,
      );
      if (item !== null) {
        activities.push(item);
      }
    }
  }

  logger.info(`Collected ${activities.length} Drive activity item(s)`);
  return activities;
}
