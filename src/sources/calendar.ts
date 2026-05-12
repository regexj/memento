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
}

/**
 * Describes the argument names the `get_events` tool expects for the
 * time-range filter. Resolved at runtime by probing the tool's input schema.
 */
interface GetEventsArgNames {
  calendarId: string;
  startTime: string;
  endTime: string;
}

const DEFAULT_ARG_NAMES: GetEventsArgNames = {
  calendarId: "calendar_id",
  startTime: "start_time",
  endTime: "end_time",
};

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

/**
 * Probes the MCP server's advertised tool list to determine the argument names
 * for the `get_events` tool. Falls back to workspace-mcp defaults if the tool
 * schema cannot be read or does not contain recognizable property names.
 */
async function resolveGetEventsArgNames(
  manager: McpClientManager,
  client: Client,
): Promise<GetEventsArgNames> {
  try {
    const tools = await manager.listTools(client);
    const getEventsTool = tools.find((t) => t.name === "get_events");
    if (getEventsTool === undefined) {
      logger.warn(
        'Could not find "get_events" in advertised tools, using default argument names',
      );
      return DEFAULT_ARG_NAMES;
    }
    const schema = getEventsTool.inputSchema;
    const properties = schema["properties"];
    if (!isRecord(properties)) {
      return DEFAULT_ARG_NAMES;
    }
    const propNames = Object.keys(properties);

    // Resolve calendarId argument name
    const calendarId = propNames.includes("calendar_id")
      ? "calendar_id"
      : propNames.includes("calendarId")
        ? "calendarId"
        : DEFAULT_ARG_NAMES.calendarId;

    // Resolve start time argument name
    const startTime = propNames.includes("start_time")
      ? "start_time"
      : propNames.includes("start_date")
        ? "start_date"
        : propNames.includes("timeMin")
          ? "timeMin"
          : DEFAULT_ARG_NAMES.startTime;

    // Resolve end time argument name
    const endTime = propNames.includes("end_time")
      ? "end_time"
      : propNames.includes("end_date")
        ? "end_date"
        : propNames.includes("timeMax")
          ? "timeMax"
          : DEFAULT_ARG_NAMES.endTime;

    return { calendarId, startTime, endTime };
  } catch (error) {
    logger.warn(
      "Failed to probe get_events tool schema, using default argument names",
      errorMessage(error),
    );
    return DEFAULT_ARG_NAMES;
  }
}

async function getEventsForCalendar(
  manager: McpClientManager,
  client: Client,
  calendarId: string,
  window: CollectionWindow,
  argNames: GetEventsArgNames,
): Promise<Record<string, unknown>[]> {
  try {
    const raw = await manager.callTool(client, "get_events", {
      [argNames.calendarId]: calendarId,
      [argNames.startTime]: window.from.toISOString(),
      [argNames.endTime]: window.to.toISOString(),
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
      `Calendar tool "get_events" failed for calendar "${calendarId}"`,
      errorMessage(error),
    );
    return [];
  }
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

  const argNames = await resolveGetEventsArgNames(manager, client);
  const calendarIds = await listCalendarIds(manager, client);
  const items: ActivityItem[] = [];
  const fileIdSet = new Set<string>();
  const seenEventIds = new Set<string>();

  for (const calendarId of calendarIds) {
    const events = await getEventsForCalendar(
      manager,
      client,
      calendarId,
      window,
      argNames,
    );
    for (const event of events) {
      const id = getString(event["id"]);
      if (id !== undefined) {
        if (seenEventIds.has(id)) {
          continue;
        }
        seenEventIds.add(id);
      }
      const { item, fileIds } = shapeEvent(event);
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
