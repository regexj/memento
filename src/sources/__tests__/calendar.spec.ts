import { logger } from "../../logger.ts";
import type { McpClientManager } from "../../mcp.ts";
import type { CollectionWindow, McpServerConfig } from "../../types.ts";
import { collectCalendarActivity } from "../calendar.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger.ts");

interface MockManager {
  connect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  disconnectAll: ReturnType<typeof vi.fn>;
}

function makeManager(): MockManager {
  return {
    connect: vi.fn(),
    callTool: vi.fn(),
    disconnectAll: vi.fn(),
  };
}

function asManager(manager: MockManager): McpClientManager {
  return manager as unknown as McpClientManager;
}

function textResponse(text: string): {
  content: { type: "text"; text: string }[];
  structuredContent: { result: string };
  isError: boolean;
} {
  return {
    content: [{ type: "text", text }],
    structuredContent: { result: text },
    isError: false,
  };
}

const WINDOW: CollectionWindow = {
  from: new Date("2025-06-01T00:00:00.000Z"),
  to: new Date("2025-06-08T00:00:00.000Z"),
};

const SERVER_CONFIG: McpServerConfig = {
  name: "google",
  command: "uvx",
  args: ["workspace-mcp"],
  toolCalls: [],
};

const FAKE_CLIENT = { id: "client" } as unknown as Client;

const CALENDARS_RESPONSE = textResponse(
  "Successfully listed 2 calendars for user@example.com:\n" +
    '- "Work" (ID: work@example.com)\n' +
    '- "Personal" (ID: personal@group.calendar.google.com)',
);

const EVENTS_RESPONSE_WORK = textResponse(
  "Successfully retrieved 2 events from calendar 'work@example.com' for user@example.com:\n" +
    '- "Sprint Planning" (Starts: 2025-06-02T09:00:00+01:00, Ends: 2025-06-02T10:00:00+01:00) ID: evt-1 | Link: https://www.google.com/calendar/event?eid=abc123\n' +
    '- "1:1 with Manager" (Starts: 2025-06-03T14:00:00+01:00, Ends: 2025-06-03T14:30:00+01:00) ID: evt-2 | Link: https://www.google.com/calendar/event?eid=def456',
);

const EVENTS_RESPONSE_PERSONAL = textResponse(
  "Successfully retrieved 1 events from calendar 'personal@group.calendar.google.com' for user@example.com:\n" +
    '- "Dentist" (Starts: 2025-06-04T11:00:00+01:00, Ends: 2025-06-04T12:00:00+01:00) ID: evt-3 | Link: https://www.google.com/calendar/event?eid=ghi789',
);

describe("collectCalendarActivity — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("discovers calendars, fetches events, and shapes into ActivityItems", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "list_calendars") {
          return Promise.resolve(CALENDARS_RESPONSE);
        }
        if (toolName === "get_events") {
          if (args["calendar_id"] === "work@example.com") {
            return Promise.resolve(EVENTS_RESPONSE_WORK);
          }
          if (args["calendar_id"] === "personal@group.calendar.google.com") {
            return Promise.resolve(EVENTS_RESPONSE_PERSONAL);
          }
        }
        return Promise.resolve({});
      },
    );

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(manager.connect).toHaveBeenCalledWith(SERVER_CONFIG);
    expect(result.items).toEqual([
      {
        type: "calendar_event",
        title: "Sprint Planning",
        url: "https://www.google.com/calendar/event?eid=abc123",
      },
      {
        type: "calendar_event",
        title: "1:1 with Manager",
        url: "https://www.google.com/calendar/event?eid=def456",
      },
      {
        type: "calendar_event",
        title: "Dentist",
        url: "https://www.google.com/calendar/event?eid=ghi789",
      },
    ]);
    expect(result.attachmentFileIds).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      "Collected 3 Calendar activity item(s)",
    );
  });

  it("uses configured calendarIds instead of discovering all", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "get_events") {
        return Promise.resolve(EVENTS_RESPONSE_WORK);
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      calendarIds: ["work@example.com"],
    });

    // Should NOT call list_calendars
    const toolNames = manager.callTool.mock.calls.map((c) => c[1]);
    expect(toolNames).not.toContain("list_calendars");

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.title).toBe("Sprint Planning");
    expect(logger.info).toHaveBeenCalledWith(
      "Using 1 configured calendar ID(s)",
    );
  });

  it("deduplicates events that appear in multiple calendars", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    const sharedEvent = textResponse(
      "Successfully retrieved 1 events:\n" +
        '- "Shared Meeting" (Starts: 2025-06-02T09:00:00Z, Ends: 2025-06-02T10:00:00Z) ID: shared-1 | Link: https://example.com/evt',
    );
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(
          textResponse(
            'Listed 2 calendars:\n- "A" (ID: a@x.com)\n- "B" (ID: b@x.com)',
          ),
        );
      }
      if (toolName === "get_events") {
        return Promise.resolve(sharedEvent);
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Shared Meeting");
  });

  it("passes correct time window args to get_events", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(
          textResponse('Calendars:\n- "Cal" (ID: cal@x.com)'),
        );
      }
      return Promise.resolve(textResponse("No events."));
    });

    await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    const getEventsCall = manager.callTool.mock.calls.find(
      (c) => c[1] === "get_events",
    );
    expect(getEventsCall?.[2]).toEqual({
      calendar_id: "cal@x.com",
      time_min: "2025-06-01T00:00:00.000Z",
      time_max: "2025-06-08T00:00:00.000Z",
    });
  });
});

describe("collectCalendarActivity — connection failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty result when manager.connect throws", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue(new Error("unreachable"));

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result).toEqual({ items: [], attachmentFileIds: [] });
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to Calendar MCP server",
      "unreachable",
    );
  });

  it("coerces non-Error rejection reasons", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue("raw string");

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result).toEqual({ items: [], attachmentFileIds: [] });
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to Calendar MCP server",
      "raw string",
    );
  });
});

describe("collectCalendarActivity — tool call failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty when list_calendars throws", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockRejectedValue(new Error("calendars broke"));

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Calendar tool "list_calendars" failed',
      "calendars broke",
    );
  });

  it("continues to next calendar when get_events throws for one", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "list_calendars") {
          return Promise.resolve(
            textResponse(
              'Calendars:\n- "A" (ID: broken@x.com)\n- "B" (ID: good@x.com)',
            ),
          );
        }
        if (toolName === "get_events") {
          if (args["calendar_id"] === "broken@x.com") {
            return Promise.reject(new Error("events broke"));
          }
          return Promise.resolve(
            textResponse(
              'Events:\n- "Good Event" (Starts: 2025-06-02T09:00:00Z, Ends: 2025-06-02T10:00:00Z) ID: g1 | Link: https://example.com/g1',
            ),
          );
        }
        return Promise.resolve({});
      },
    );

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Good Event");
    expect(logger.warn).toHaveBeenCalledWith(
      'Calendar tool "get_events" failed for calendar "broken@x.com"',
      "events broke",
    );
  });
});

describe("collectCalendarActivity — text parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty when list_calendars response has no text", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({ content: [] });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Calendar tool "list_calendars" returned no parseable text',
    );
  });

  it("returns empty when get_events response has no parseable events", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(
          textResponse('Calendars:\n- "Cal" (ID: cal@x.com)'),
        );
      }
      return Promise.resolve(textResponse("No events found for this period."));
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([]);
  });

  it("handles events without a Link field", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(
          textResponse('Calendars:\n- "Cal" (ID: cal@x.com)'),
        );
      }
      return Promise.resolve(
        textResponse(
          'Events:\n- "No Link Event" (Starts: 2025-06-02T09:00:00Z, Ends: 2025-06-02T10:00:00Z) ID: evt-nolink',
        ),
      );
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([
      { type: "calendar_event", title: "No Link Event" },
    ]);
  });

  it("returns empty when response is null", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(null);

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([]);
  });
});

describe("collectCalendarActivity — extractTextFromResponse fallback paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to content[].text when structuredContent is absent", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        // Response with only content, no structuredContent
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: 'Calendars:\n- "Work" (ID: work@x.com)',
            },
          ],
        });
      }
      if (toolName === "get_events") {
        // Response with only content, no structuredContent
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: 'Events:\n- "Meeting" (Starts: 2025-06-02T09:00:00Z, Ends: 2025-06-02T10:00:00Z) ID: e1 | Link: https://example.com/e1',
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([
      {
        type: "calendar_event",
        title: "Meeting",
        url: "https://example.com/e1",
      },
    ]);
  });

  it("returns empty events when get_events response has no text", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(
          textResponse('Calendars:\n- "Cal" (ID: cal@x.com)'),
        );
      }
      if (toolName === "get_events") {
        // No text content at all
        return Promise.resolve({ content: [] });
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([]);
  });
});

describe("collectCalendarActivity — response parsing edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips non-record entries in content array", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve({
          content: [
            null,
            "string",
            { type: "text", text: 'Calendars:\n- "Cal" (ID: cal@x.com)' },
          ],
        });
      }
      return Promise.resolve(textResponse("No events."));
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([]);
    // Proves it parsed the calendar ID despite junk entries
    const getEventsCalls = manager.callTool.mock.calls.filter(
      (c) => c[1] === "get_events",
    );
    expect(getEventsCalls).toHaveLength(1);
  });

  it("skips content entries with non-text type", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve({
          content: [
            { type: "image", data: "..." },
            { type: "text", text: 'Calendars:\n- "Cal" (ID: cal@x.com)' },
          ],
        });
      }
      return Promise.resolve(textResponse("No events."));
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    const getEventsCalls = manager.callTool.mock.calls.filter(
      (c) => c[1] === "get_events",
    );
    expect(getEventsCalls).toHaveLength(1);
    expect(result.items).toEqual([]);
  });

  it("skips content entries where text is not a string", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve({
          content: [
            { type: "text", text: 123 },
            { type: "text", text: 'Calendars:\n- "Cal" (ID: cal@x.com)' },
          ],
        });
      }
      return Promise.resolve(textResponse("No events."));
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    const getEventsCalls = manager.callTool.mock.calls.filter(
      (c) => c[1] === "get_events",
    );
    expect(getEventsCalls).toHaveLength(1);
    expect(result.items).toEqual([]);
  });

  it("returns undefined from extractTextFromResponse when content is not an array", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({ content: "not an array" });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Calendar tool "list_calendars" returned no parseable text',
    );
  });

  it("returns undefined from extractTextFromResponse when structuredContent.result is not a string", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({
      structuredContent: { result: 42 },
      content: [{ type: "text", text: 'Calendars:\n- "Cal" (ID: cal@x.com)' }],
    });

    await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    // Should fall through to content and find the calendar
    const getEventsCalls = manager.callTool.mock.calls.filter(
      (c) => c[1] === "get_events",
    );
    expect(getEventsCalls).toHaveLength(1);
  });
});
