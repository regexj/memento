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

function textContent(
  key: string,
  items: unknown,
): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: JSON.stringify({ [key]: items }) }],
  };
}

function textObject(
  key: string,
  value: unknown,
): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: JSON.stringify({ [key]: value }) }],
  };
}

const WINDOW: CollectionWindow = {
  from: new Date("2025-06-01T00:00:00.000Z"),
  to: new Date("2025-06-08T00:00:00.000Z"),
};

const SERVER_CONFIG: McpServerConfig = {
  name: "calendar",
  url: "https://calendarmcp.googleapis.com/mcp/v1",
  toolCalls: [],
};

const FAKE_CLIENT = { id: "client" } as unknown as Client;

describe("collectCalendarActivity — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists calendars, fetches events per calendar, shapes items, and aggregates attachment fileIds", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "list_calendars") {
          return Promise.resolve(
            textContent("calendars", [
              { id: "primary" },
              { id: "team@example.com" },
            ]),
          );
        }
        if (toolName === "list_events") {
          const calendarId = args["calendarId"];
          if (calendarId === "primary") {
            return Promise.resolve(
              textContent("events", [
                {
                  id: "evt-1",
                  summary: "Planning meeting",
                  htmlLink: "https://calendar.google.com/event?eid=evt-1",
                  description: "Quarterly planning",
                  attendees: [
                    { displayName: "Alice", email: "alice@example.com" },
                    { email: "bob@example.com" },
                  ],
                  conferenceData: {
                    entryPoints: [
                      {
                        entryPointType: "more",
                        uri: "https://example.com/more",
                      },
                      {
                        entryPointType: "video",
                        uri: "https://meet.google.com/abc-defg-hij",
                      },
                    ],
                  },
                  attachments: [
                    { fileId: "file-notes-1" },
                    { fileId: "file-transcript-1" },
                  ],
                },
              ]),
            );
          }
          if (calendarId === "team@example.com") {
            return Promise.resolve(
              textContent("events", [
                {
                  id: "evt-2",
                  summary: "Standup",
                  htmlLink: "https://calendar.google.com/event?eid=evt-2",
                  description: "Daily",
                  attendees: [
                    { displayName: "Carol", email: "carol@example.com" },
                  ],
                  attachments: [{ fileId: "file-notes-1" }],
                },
              ]),
            );
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
    const calls = manager.callTool.mock.calls;
    expect(calls[0]).toEqual([FAKE_CLIENT, "list_calendars", {}]);
    expect(calls[1]).toEqual([
      FAKE_CLIENT,
      "list_events",
      {
        calendarId: "primary",
        timeMin: "2025-06-01T00:00:00.000Z",
        timeMax: "2025-06-08T00:00:00.000Z",
      },
    ]);
    expect(calls[2]).toEqual([
      FAKE_CLIENT,
      "list_events",
      {
        calendarId: "team@example.com",
        timeMin: "2025-06-01T00:00:00.000Z",
        timeMax: "2025-06-08T00:00:00.000Z",
      },
    ]);
    expect(manager.callTool).toHaveBeenCalledTimes(3);

    expect(result.items).toEqual([
      {
        type: "calendar_event",
        title: "Planning meeting",
        url: "https://calendar.google.com/event?eid=evt-1",
        description: "Quarterly planning",
        eventAttendees: ["Alice <alice@example.com>", "bob@example.com"],
        conferenceUrl: "https://meet.google.com/abc-defg-hij",
      },
      {
        type: "calendar_event",
        title: "Standup",
        url: "https://calendar.google.com/event?eid=evt-2",
        description: "Daily",
        eventAttendees: ["Carol <carol@example.com>"],
      },
    ]);
    expect(result.attachmentFileIds).toEqual([
      "file-notes-1",
      "file-transcript-1",
    ]);

    expect(logger.info).toHaveBeenCalledWith(
      "Collected 2 Calendar activity item(s)",
    );
  });

  it("enriches sparse events via get_event when description/attendees/attachments are all missing", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "list_calendars") {
          return Promise.resolve(textContent("calendars", [{ id: "primary" }]));
        }
        if (toolName === "list_events") {
          return Promise.resolve(
            textContent("events", [{ id: "evt-sparse", summary: "Sparse" }]),
          );
        }
        if (toolName === "get_event") {
          expect(args).toEqual({
            calendarId: "primary",
            eventId: "evt-sparse",
          });
          return Promise.resolve(
            textObject("event", {
              id: "evt-sparse",
              summary: "Enriched title",
              description: "Detailed description",
              attendees: [{ email: "x@example.com" }],
              attachments: [{ fileId: "enriched-file" }],
            }),
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

    expect(result.items).toEqual([
      {
        type: "calendar_event",
        title: "Enriched title",
        description: "Detailed description",
        eventAttendees: ["x@example.com"],
      },
    ]);
    expect(result.attachmentFileIds).toEqual(["enriched-file"]);
  });

  it("does not call get_event when the event already contains description/attendees/attachments", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(textContent("calendars", [{ id: "primary" }]));
      }
      if (toolName === "list_events") {
        return Promise.resolve(
          textContent("events", [
            {
              id: "evt-full",
              summary: "Full event",
              attendees: [{ email: "a@example.com" }],
            },
          ]),
        );
      }
      if (toolName === "get_event") {
        throw new Error("should not be called");
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toHaveLength(1);
    const toolNames = manager.callTool.mock.calls.map((c) => c[1]);
    expect(toolNames).not.toContain("get_event");
  });

  it("deduplicates events seen in multiple calendars by event id", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(
          textContent("calendars", [{ id: "primary" }, { id: "shared" }]),
        );
      }
      if (toolName === "list_events") {
        return Promise.resolve(
          textContent("events", [
            {
              id: "shared-evt",
              summary: "Shared meeting",
              description: "d",
            },
          ]),
        );
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Shared meeting");
  });
});

describe("collectCalendarActivity — connection failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty result and logs error when manager.connect throws an Error", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue(new Error("unreachable"));

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result).toEqual({ items: [], attachmentFileIds: [] });
    expect(manager.callTool).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to Calendar MCP server",
      "unreachable",
    );
  });

  it("coerces non-Error rejection reasons via String()", async () => {
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

  it("logs warning and returns empty result when list_calendars throws an Error", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.reject(new Error("calendars broke"));
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([]);
    expect(result.attachmentFileIds).toEqual([]);
    expect(manager.callTool).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Calendar tool "list_calendars" failed',
      "calendars broke",
    );
  });

  it("coerces non-Error list_calendars rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.reject("no cal");
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Calendar tool "list_calendars" failed',
      "no cal",
    );
  });

  it("logs warning and continues to next calendar when list_events throws", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "list_calendars") {
          return Promise.resolve(
            textContent("calendars", [{ id: "broken" }, { id: "good" }]),
          );
        }
        if (toolName === "list_events") {
          if (args["calendarId"] === "broken") {
            return Promise.reject(new Error("events broke"));
          }
          return Promise.resolve(
            textContent("events", [
              { id: "g1", summary: "Good event", description: "d" },
            ]),
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
    expect(result.items[0]?.title).toBe("Good event");
    expect(logger.warn).toHaveBeenCalledWith(
      'Calendar tool "list_events" failed for calendar "broken"',
      "events broke",
    );
  });

  it("coerces non-Error list_events rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(textContent("calendars", [{ id: "primary" }]));
      }
      if (toolName === "list_events") {
        return Promise.reject("bad events");
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Calendar tool "list_events" failed for calendar "primary"',
      "bad events",
    );
  });

  it("logs warning and falls back to the original event when get_event throws", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(textContent("calendars", [{ id: "primary" }]));
      }
      if (toolName === "list_events") {
        return Promise.resolve(
          textContent("events", [{ id: "evt-sparse", summary: "Bare event" }]),
        );
      }
      if (toolName === "get_event") {
        return Promise.reject(new Error("detail broke"));
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([
      { type: "calendar_event", title: "Bare event" },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Calendar tool "get_event" failed for event "evt-sparse"',
      "detail broke",
    );
  });

  it("coerces non-Error get_event rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(textContent("calendars", [{ id: "primary" }]));
      }
      if (toolName === "list_events") {
        return Promise.resolve(
          textContent("events", [{ id: "evt", summary: "S" }]),
        );
      }
      if (toolName === "get_event") {
        return Promise.reject("boom");
      }
      return Promise.resolve({});
    });

    await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Calendar tool "get_event" failed for event "evt"',
      "boom",
    );
  });
});

describe("collectCalendarActivity — calendar list parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runListCalendarsResponse(response: unknown): Promise<number> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(response);
      }
      if (toolName === "list_events") {
        return Promise.resolve(textContent("events", []));
      }
      return Promise.resolve({});
    });

    await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    const listEventsCalls = manager.callTool.mock.calls.filter(
      (c) => c[1] === "list_events",
    );
    return listEventsCalls.length;
  }

  it("uses structuredContent.calendars when present", async () => {
    const count = await runListCalendarsResponse({
      structuredContent: { calendars: [{ id: "primary" }, { id: "team" }] },
    });
    expect(count).toBe(2);
  });

  it("falls through to content when structuredContent has no calendars array", async () => {
    const count = await runListCalendarsResponse({
      structuredContent: { other: "value" },
      content: [
        {
          type: "text",
          text: JSON.stringify({ calendars: [{ id: "content-cal" }] }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("accepts bare array from JSON.parse", async () => {
    const count = await runListCalendarsResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify([{ id: "bare-cal" }]),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("skips calendar entries without a string id", async () => {
    const count = await runListCalendarsResponse({
      structuredContent: {
        calendars: [{ id: "ok" }, { id: 42 }, "string", null],
      },
    });
    expect(count).toBe(1);
  });

  it("skips content entries with non-text type", async () => {
    const count = await runListCalendarsResponse({
      content: [
        { type: "image", data: "..." },
        {
          type: "text",
          text: JSON.stringify({ calendars: [{ id: "after-image" }] }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("skips content entries where text is not a string", async () => {
    const count = await runListCalendarsResponse({
      content: [
        { type: "text", text: 123 },
        {
          type: "text",
          text: JSON.stringify({ calendars: [{ id: "valid" }] }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("returns empty when content text is invalid JSON", async () => {
    const count = await runListCalendarsResponse({
      content: [{ type: "text", text: "not json{" }],
    });
    expect(count).toBe(0);
  });

  it("returns empty when parsed content is a primitive", async () => {
    const count = await runListCalendarsResponse({
      content: [{ type: "text", text: JSON.stringify("hello") }],
    });
    expect(count).toBe(0);
  });

  it("skips null entries in content array", async () => {
    const count = await runListCalendarsResponse({
      content: [
        null,
        {
          type: "text",
          text: JSON.stringify({ calendars: [{ id: "after-null" }] }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("returns empty when response is null", async () => {
    const count = await runListCalendarsResponse(null);
    expect(count).toBe(0);
  });

  it("returns empty when response is a string", async () => {
    const count = await runListCalendarsResponse("not an object");
    expect(count).toBe(0);
  });

  it("returns empty when response has neither content nor structuredContent", async () => {
    const count = await runListCalendarsResponse({ other: "field" });
    expect(count).toBe(0);
  });

  it("returns empty when content is not an array", async () => {
    const count = await runListCalendarsResponse({ content: "not an array" });
    expect(count).toBe(0);
  });

  it("returns empty when content is present but contains no parseable text", async () => {
    const count = await runListCalendarsResponse({
      content: [null, { type: "image" }, { type: "text", text: 5 }],
    });
    expect(count).toBe(0);
  });
});

describe("collectCalendarActivity — event shaping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  interface EventSnapshot {
    type: string;
    title: string;
    url?: string;
    description?: string;
    eventAttendees?: string[];
    conferenceUrl?: string;
  }

  async function collectFirstEvent(
    event: Record<string, unknown>,
  ): Promise<EventSnapshot | undefined> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(textContent("calendars", [{ id: "primary" }]));
      }
      if (toolName === "list_events") {
        return Promise.resolve(textContent("events", [event]));
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    const first = result.items[0];
    return first as EventSnapshot | undefined;
  }

  async function collectFirstResult(
    event: Record<string, unknown>,
  ): Promise<{ items: EventSnapshot[]; attachmentFileIds: string[] }> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(textContent("calendars", [{ id: "primary" }]));
      }
      if (toolName === "list_events") {
        return Promise.resolve(textContent("events", [event]));
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    return {
      items: result.items as EventSnapshot[],
      attachmentFileIds: result.attachmentFileIds,
    };
  }

  it("drops events without a summary", async () => {
    const item = await collectFirstEvent({
      id: "x",
      description: "d",
    });
    expect(item).toBeUndefined();
  });

  it("leaves url undefined when htmlLink is missing", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "No link",
      description: "d",
    });
    expect(item?.url).toBeUndefined();
  });

  it("leaves description undefined when not a string", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: 42,
      attendees: [{ email: "a@example.com" }],
    });
    expect(item?.description).toBeUndefined();
  });

  it("leaves eventAttendees undefined when attendees is not an array", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: "d",
      attendees: "bad",
    });
    expect(item?.eventAttendees).toBeUndefined();
  });

  it("leaves eventAttendees undefined when attendees is an empty array", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: "d",
      attendees: [],
    });
    expect(item?.eventAttendees).toBeUndefined();
  });

  it("skips attendee entries that are not objects", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: "d",
      attendees: ["string", 42, null, { email: "ok@example.com" }],
    });
    expect(item?.eventAttendees).toEqual(["ok@example.com"]);
  });

  it("skips attendee entries that have neither displayName nor email", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: "d",
      attendees: [{ responseStatus: "accepted" }, { displayName: "Only name" }],
    });
    expect(item?.eventAttendees).toEqual(["Only name"]);
  });

  it("leaves conferenceUrl undefined when conferenceData is missing", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: "d",
    });
    expect(item?.conferenceUrl).toBeUndefined();
  });

  it("leaves conferenceUrl undefined when conferenceData is not an object", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: "d",
      conferenceData: "bad",
    });
    expect(item?.conferenceUrl).toBeUndefined();
  });

  it("leaves conferenceUrl undefined when entryPoints is not an array", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: "d",
      conferenceData: { entryPoints: "bad" },
    });
    expect(item?.conferenceUrl).toBeUndefined();
  });

  it("falls back to first non-video entry point when no video entry point exists", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: "d",
      conferenceData: {
        entryPoints: [
          { entryPointType: "phone", uri: "tel:+1-555-0000" },
          { entryPointType: "more", uri: "https://example.com/more" },
        ],
      },
    });
    expect(item?.conferenceUrl).toBe("tel:+1-555-0000");
  });

  it("skips entry points that are not objects when resolving conference url", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: "d",
      conferenceData: {
        entryPoints: [
          null,
          "bad",
          { entryPointType: "video", uri: "https://meet.example.com/z" },
        ],
      },
    });
    expect(item?.conferenceUrl).toBe("https://meet.example.com/z");
  });

  it("skips entry points without a string uri", async () => {
    const item = await collectFirstEvent({
      id: "x",
      summary: "S",
      description: "d",
      conferenceData: {
        entryPoints: [
          { entryPointType: "video", uri: 42 },
          { entryPointType: "video", uri: "https://meet.example.com/z" },
        ],
      },
    });
    expect(item?.conferenceUrl).toBe("https://meet.example.com/z");
  });

  it("returns no file ids when attachments is not an array", async () => {
    const out = await collectFirstResult({
      id: "x",
      summary: "S",
      description: "d",
      attachments: "bad",
    });
    expect(out.attachmentFileIds).toEqual([]);
  });

  it("skips attachment entries that are not objects", async () => {
    const out = await collectFirstResult({
      id: "x",
      summary: "S",
      description: "d",
      attachments: ["x", 42, null, { fileId: "ok" }],
    });
    expect(out.attachmentFileIds).toEqual(["ok"]);
  });

  it("skips attachment entries without a string fileId", async () => {
    const out = await collectFirstResult({
      id: "x",
      summary: "S",
      description: "d",
      attachments: [{ fileId: 42 }, { fileId: "good" }],
    });
    expect(out.attachmentFileIds).toEqual(["good"]);
  });
});

describe("collectCalendarActivity — event list parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runListEventsResponse(response: unknown): Promise<number> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(textContent("calendars", [{ id: "primary" }]));
      }
      if (toolName === "list_events") {
        return Promise.resolve(response);
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });
    return result.items.length;
  }

  it("skips event entries that are not objects", async () => {
    const count = await runListEventsResponse(
      textContent("events", [
        "string",
        42,
        null,
        { id: "e1", summary: "Real event", description: "d" },
      ]),
    );
    expect(count).toBe(1);
  });

  it("returns 0 items when list_events response is null", async () => {
    const count = await runListEventsResponse(null);
    expect(count).toBe(0);
  });

  it("does not dedupe events without an id across calendars", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(
          textContent("calendars", [{ id: "a" }, { id: "b" }]),
        );
      }
      if (toolName === "list_events") {
        return Promise.resolve(
          textContent("events", [{ summary: "No-id event", description: "d" }]),
        );
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toHaveLength(2);
  });
});

describe("collectCalendarActivity — get_event parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runGetEventResponse(
    response: unknown,
  ): Promise<{ title: string; description?: string } | undefined> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(textContent("calendars", [{ id: "primary" }]));
      }
      if (toolName === "list_events") {
        return Promise.resolve(
          textContent("events", [{ id: "evt-sparse", summary: "Bare" }]),
        );
      }
      if (toolName === "get_event") {
        return Promise.resolve(response);
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    const first = result.items[0];
    if (first === undefined) {
      return undefined;
    }
    const out: { title: string; description?: string } = { title: first.title };
    if (first.description !== undefined) {
      out.description = first.description;
    }
    return out;
  }

  it("uses structuredContent.event when present", async () => {
    const out = await runGetEventResponse({
      structuredContent: {
        event: {
          id: "evt-sparse",
          summary: "Structured title",
          description: "structured-desc",
        },
      },
    });
    expect(out?.title).toBe("Structured title");
    expect(out?.description).toBe("structured-desc");
  });

  it("treats structuredContent itself as the event when no nested event key", async () => {
    const out = await runGetEventResponse({
      structuredContent: {
        id: "evt-sparse",
        summary: "Flat structured",
        description: "flat-desc",
      },
    });
    expect(out?.title).toBe("Flat structured");
    expect(out?.description).toBe("flat-desc");
  });

  it("falls through to content.event when structuredContent is absent", async () => {
    const out = await runGetEventResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            event: {
              id: "evt-sparse",
              summary: "Content nested",
              description: "content-desc",
            },
          }),
        },
      ],
    });
    expect(out?.title).toBe("Content nested");
  });

  it("treats flat parsed content as the event when no event key is present", async () => {
    const out = await runGetEventResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: "evt-sparse",
            summary: "Flat content",
            description: "flat",
          }),
        },
      ],
    });
    expect(out?.title).toBe("Flat content");
  });

  it("falls back to the original event when parsed content is not an object", async () => {
    const out = await runGetEventResponse({
      content: [{ type: "text", text: JSON.stringify("hello") }],
    });
    expect(out?.title).toBe("Bare");
    expect(out?.description).toBeUndefined();
  });

  it("falls back to the original event when content text is invalid JSON", async () => {
    const out = await runGetEventResponse({
      content: [{ type: "text", text: "not json{" }],
    });
    expect(out?.title).toBe("Bare");
  });

  it("skips content entries with non-text type", async () => {
    const out = await runGetEventResponse({
      content: [
        { type: "image", data: "x" },
        {
          type: "text",
          text: JSON.stringify({
            event: {
              id: "evt-sparse",
              summary: "After image",
              description: "d",
            },
          }),
        },
      ],
    });
    expect(out?.title).toBe("After image");
  });

  it("skips content entries where text is not a string", async () => {
    const out = await runGetEventResponse({
      content: [
        { type: "text", text: 123 },
        {
          type: "text",
          text: JSON.stringify({
            event: {
              id: "evt-sparse",
              summary: "After bad text",
              description: "d",
            },
          }),
        },
      ],
    });
    expect(out?.title).toBe("After bad text");
  });

  it("skips content entries that are not objects", async () => {
    const out = await runGetEventResponse({
      content: [
        null,
        {
          type: "text",
          text: JSON.stringify({
            event: {
              id: "evt-sparse",
              summary: "After null",
              description: "d",
            },
          }),
        },
      ],
    });
    expect(out?.title).toBe("After null");
  });

  it("falls back to the original event when response is null", async () => {
    const out = await runGetEventResponse(null);
    expect(out?.title).toBe("Bare");
  });

  it("falls back to the original event when response is a string", async () => {
    const out = await runGetEventResponse("bad");
    expect(out?.title).toBe("Bare");
  });

  it("falls back to the original event when response has no content and no structuredContent", async () => {
    const out = await runGetEventResponse({ other: "x" });
    expect(out?.title).toBe("Bare");
  });

  it("falls back to the original event when content is not an array", async () => {
    const out = await runGetEventResponse({ content: "bad" });
    expect(out?.title).toBe("Bare");
  });

  it("falls back to the original event when content has no usable entries", async () => {
    const out = await runGetEventResponse({
      content: [null, { type: "image" }, { type: "text", text: 5 }],
    });
    expect(out?.title).toBe("Bare");
  });

  it("falls back to the original event when the sparse event has no id", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "list_calendars") {
        return Promise.resolve(textContent("calendars", [{ id: "primary" }]));
      }
      if (toolName === "list_events") {
        return Promise.resolve(
          textContent("events", [{ summary: "Idless bare" }]),
        );
      }
      if (toolName === "get_event") {
        throw new Error("should not be called");
      }
      return Promise.resolve({});
    });

    const result = await collectCalendarActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result.items).toEqual([
      { type: "calendar_event", title: "Idless bare" },
    ]);
    const toolNames = manager.callTool.mock.calls.map((c) => c[1]);
    expect(toolNames).not.toContain("get_event");
  });
});
