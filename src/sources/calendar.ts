import { logger } from "../logger.ts";
import type { McpClientManager } from "../mcp.ts";
import type {
  ActivityItem,
  CalendarCollectionResult,
  CollectionWindow,
  McpServerConfig,
} from "../types.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface CollectCalendarOptions {
  manager: McpClientManager;
  serverConfig: McpServerConfig;
  window: CollectionWindow;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

async function listCalendarIds(
  manager: McpClientManager,
  client: Client,
): Promise<string[]> {
  try {
    const raw = await manager.callTool(client, "list_calendars", {});
    const calendars = parseArrayToolResult(raw, "calendars");
    const ids: string[] = [];
    for (const entry of calendars) {
      if (!isRecord(entry)) {
        continue;
      }
      const id = getString(entry["id"]);
      if (id !== undefined) {
        ids.push(id);
      }
    }
    return ids;
  } catch (error) {
    logger.warn('Calendar tool "list_calendars" failed', errorMessage(error));
    return [];
  }
}

async function listEventsForCalendar(
  manager: McpClientManager,
  client: Client,
  calendarId: string,
  window: CollectionWindow,
): Promise<Record<string, unknown>[]> {
  try {
    const raw = await manager.callTool(client, "list_events", {
      calendarId,
      timeMin: window.from.toISOString(),
      timeMax: window.to.toISOString(),
    });
    const events = parseArrayToolResult(raw, "events");
    const shaped: Record<string, unknown>[] = [];
    for (const entry of events) {
      if (isRecord(entry)) {
        shaped.push(entry);
      }
    }
    return shaped;
  } catch (error) {
    logger.warn(
      `Calendar tool "list_events" failed for calendar "${calendarId}"`,
      errorMessage(error),
    );
    return [];
  }
}

function isSparseEvent(event: Record<string, unknown>): boolean {
  return (
    event["description"] === undefined &&
    event["attendees"] === undefined &&
    event["attachments"] === undefined
  );
}

async function getEventDetail(
  manager: McpClientManager,
  client: Client,
  calendarId: string,
  eventId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await manager.callTool(client, "get_event", {
      calendarId,
      eventId,
    });
    return parseObjectToolResult(raw, "event");
  } catch (error) {
    logger.warn(
      `Calendar tool "get_event" failed for event "${eventId}"`,
      errorMessage(error),
    );
    return undefined;
  }
}

async function enrichEvent(
  manager: McpClientManager,
  client: Client,
  calendarId: string,
  event: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isSparseEvent(event)) {
    return event;
  }
  const id = getString(event["id"]);
  if (id === undefined) {
    return event;
  }
  const detail = await getEventDetail(manager, client, calendarId, id);
  if (detail === undefined) {
    return event;
  }
  return detail;
}

function formatAttendee(attendee: unknown): string | undefined {
  if (!isRecord(attendee)) {
    return undefined;
  }
  const email = getString(attendee["email"]);
  const displayName = getString(attendee["displayName"]);
  if (displayName !== undefined && email !== undefined) {
    return `${displayName} <${email}>`;
  }
  if (displayName !== undefined) {
    return displayName;
  }
  if (email !== undefined) {
    return email;
  }
  return undefined;
}

function extractAttendees(
  event: Record<string, unknown>,
): string[] | undefined {
  const attendees = event["attendees"];
  if (!Array.isArray(attendees)) {
    return undefined;
  }
  const formatted: string[] = [];
  for (const entry of attendees) {
    const value = formatAttendee(entry);
    if (value !== undefined) {
      formatted.push(value);
    }
  }
  return formatted.length > 0 ? formatted : undefined;
}

function extractConferenceUrl(
  event: Record<string, unknown>,
): string | undefined {
  const conferenceData = event["conferenceData"];
  if (!isRecord(conferenceData)) {
    return undefined;
  }
  const entryPoints = conferenceData["entryPoints"];
  if (!Array.isArray(entryPoints)) {
    return undefined;
  }
  let fallback: string | undefined;
  for (const point of entryPoints) {
    if (!isRecord(point)) {
      continue;
    }
    const uri = getString(point["uri"]);
    if (uri === undefined) {
      continue;
    }
    if (point["entryPointType"] === "video") {
      return uri;
    }
    if (fallback === undefined) {
      fallback = uri;
    }
  }
  return fallback;
}

function extractAttachmentFileIds(event: Record<string, unknown>): string[] {
  const attachments = event["attachments"];
  if (!Array.isArray(attachments)) {
    return [];
  }
  const ids: string[] = [];
  for (const attachment of attachments) {
    if (!isRecord(attachment)) {
      continue;
    }
    const fileId = getString(attachment["fileId"]);
    if (fileId !== undefined) {
      ids.push(fileId);
    }
  }
  return ids;
}

function shapeEvent(event: Record<string, unknown>): {
  item: ActivityItem | null;
  fileIds: string[];
} {
  const summary = getString(event["summary"]);
  if (summary === undefined) {
    return { item: null, fileIds: [] };
  }
  const item: ActivityItem = { type: "calendar_event", title: summary };
  const url = getString(event["htmlLink"]);
  if (url !== undefined) {
    item.url = url;
  }
  const description = getString(event["description"]);
  if (description !== undefined) {
    item.description = description;
  }
  const attendees = extractAttendees(event);
  if (attendees !== undefined) {
    item.eventAttendees = attendees;
  }
  const conferenceUrl = extractConferenceUrl(event);
  if (conferenceUrl !== undefined) {
    item.conferenceUrl = conferenceUrl;
  }
  return { item, fileIds: extractAttachmentFileIds(event) };
}

export async function collectCalendarActivity(
  options: CollectCalendarOptions,
): Promise<CalendarCollectionResult> {
  const { manager, serverConfig, window } = options;

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

  const calendarIds = await listCalendarIds(manager, client);
  const items: ActivityItem[] = [];
  const fileIdSet = new Set<string>();
  const seenEventIds = new Set<string>();

  for (const calendarId of calendarIds) {
    const events = await listEventsForCalendar(
      manager,
      client,
      calendarId,
      window,
    );
    for (const event of events) {
      const id = getString(event["id"]);
      if (id !== undefined) {
        if (seenEventIds.has(id)) {
          continue;
        }
        seenEventIds.add(id);
      }
      const enriched = await enrichEvent(manager, client, calendarId, event);
      const { item, fileIds } = shapeEvent(enriched);
      if (item !== null) {
        items.push(item);
      }
      for (const fileId of fileIds) {
        fileIdSet.add(fileId);
      }
    }
  }

  logger.info(`Collected ${items.length} Calendar activity item(s)`);
  return { items, attachmentFileIds: [...fileIdSet] };
}
