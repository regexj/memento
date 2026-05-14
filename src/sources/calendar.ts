import { logger } from "../logger.ts";
import type { McpClientManager } from "../mcp.ts";
import type {
  ActivityItem,
  CalendarCollectionResult,
  CollectionWindow,
  McpServerConfig,
} from "../types.ts";
import { errorMessage, getString, isRecord } from "../util.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface CollectCalendarOptions {
  manager: McpClientManager;
  serverConfig: McpServerConfig;
  window: CollectionWindow;
  calendarIds?: string[];
}

/**
 * Extracts the text content from a workspace-mcp tool response.
 * Checks structuredContent.result first, then content[].text.
 */
function extractTextFromResponse(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const structured = raw["structuredContent"];
  if (isRecord(structured)) {
    const result = getString(structured["result"]);
    if (result !== undefined) {
      return result;
    }
  }

  const content = raw["content"];
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (!isRecord(entry)) continue;
      if (entry["type"] !== "text") continue;
      const text = getString(entry["text"]);
      if (text !== undefined) {
        return text;
      }
    }
  }

  return undefined;
}

/**
 * Parses calendar IDs from workspace-mcp's list_calendars text response.
 * Format: - "Calendar Name" (ID: calendar-id)
 */
function parseCalendarIdsFromText(text: string): string[] {
  const ids: string[] = [];
  const regex = /\(ID:\s*([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    /* v8 ignore start — regex guarantees non-empty capture */
    const id = match[1]?.trim();
    if (id !== undefined && id.length > 0) {
      ids.push(id);
    }
    /* v8 ignore stop */
  }
  return ids;
}

/**
 * Parses events from workspace-mcp's get_events text response.
 * Format: - "Event Title" (Starts: ..., Ends: ...) ID: event-id | Link: url
 */
function parseEventsFromText(text: string): ActivityItem[] {
  const items: ActivityItem[] = [];
  const eventRegex =
    /- "([^"]+)" \(Starts: ([^,]+), Ends: ([^)]+)\)(?:\s+Meeting: \S+)? ID: ([^\s|]+)(?:\s+\| Link: (\S+))?/g;
  let match: RegExpExecArray | null;
  while ((match = eventRegex.exec(text)) !== null) {
    const title = match[1];
    const url = match[5];
    /* v8 ignore start — regex guarantees title capture */
    if (title === undefined) continue;
    /* v8 ignore stop */

    const item: ActivityItem = {
      type: "calendar_event",
      title,
    };
    if (url !== undefined && url.length > 0) {
      item.url = url;
    }
    items.push(item);
  }
  return items;
}

async function listCalendarIds(
  manager: McpClientManager,
  client: Client,
): Promise<string[]> {
  try {
    const raw = await manager.callTool(client, "list_calendars", {});
    const text = extractTextFromResponse(raw);
    if (text === undefined) {
      logger.warn('Calendar tool "list_calendars" returned no parseable text');
      return [];
    }
    return parseCalendarIdsFromText(text);
  } catch (error) {
    logger.warn('Calendar tool "list_calendars" failed', errorMessage(error));
    return [];
  }
}

async function getEventsForCalendar(
  manager: McpClientManager,
  client: Client,
  calendarId: string,
  window: CollectionWindow,
): Promise<ActivityItem[]> {
  try {
    const raw = await manager.callTool(client, "get_events", {
      calendar_id: calendarId,
      time_min: window.from.toISOString(),
      time_max: window.to.toISOString(),
    });
    const text = extractTextFromResponse(raw);
    if (text === undefined) {
      return [];
    }
    return parseEventsFromText(text);
  } catch (error) {
    logger.warn(
      `Calendar tool "get_events" failed for calendar "${calendarId}"`,
      errorMessage(error),
    );
    return [];
  }
}

export async function collectCalendarActivity(
  options: CollectCalendarOptions,
): Promise<CalendarCollectionResult> {
  const { manager, serverConfig, window, calendarIds: filterIds } = options;

  let client: Client;
  try {
    client = await manager.connect(serverConfig);
  } catch (error) {
    logger.error(
      "Failed to connect to Calendar MCP server",
      errorMessage(error),
    );
    return { items: [], attachmentFileIds: [] };
  }

  // Use configured calendar IDs if provided, otherwise discover all
  let calendarIds: string[];
  if (filterIds !== undefined && filterIds.length > 0) {
    calendarIds = filterIds;
    logger.info(`Using ${calendarIds.length} configured calendar ID(s)`);
  } else {
    calendarIds = await listCalendarIds(manager, client);
    logger.info(`Discovered ${calendarIds.length} calendar(s)`);
  }

  const items: ActivityItem[] = [];

  for (const calendarId of calendarIds) {
    const events = await getEventsForCalendar(
      manager,
      client,
      calendarId,
      window,
    );
    items.push(...events);
  }

  logger.info(`Collected ${items.length} Calendar activity item(s)`);
  return { items, attachmentFileIds: [] };
}
