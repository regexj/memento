import { logger } from "../../logger.ts";
import type { McpClientManager } from "../../mcp.ts";
import type { CollectionWindow, McpServerConfig } from "../../types.ts";
import { collectAtlassianActivity } from "../atlassian.ts";
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

function textContent(issues: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify({ issues }) }] };
}

const WINDOW: CollectionWindow = {
  from: new Date("2025-06-01T00:00:00.000Z"),
  to: new Date("2025-06-08T00:00:00.000Z"),
};

const SERVER_CONFIG: McpServerConfig = {
  name: "atlassian",
  command: "node",
  args: ["atlassian-mcp.js"],
  toolCalls: [],
};

const JIRA_USERNAME = "alice";
const JIRA_BASE_URL = "https://example.atlassian.net";
const FAKE_CLIENT = { id: "client" } as unknown as Client;

describe("collectAtlassianActivity — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls jira_search four times with the expected JQL and aggregates shaped issues", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe("jira_search");
        const jql = args["jql"] as string;
        if (jql.includes("resolved >=")) {
          return Promise.resolve(
            textContent([
              {
                key: "PROJ-1",
                fields: {
                  summary: "Done ticket",
                  status: { name: "Done" },
                  issuetype: { name: "Task" },
                  customfield_10016: 5,
                  parent: { fields: { summary: "Launch Q3" } },
                },
              },
            ]),
          );
        }
        if (jql.includes("commentedByUser")) {
          return Promise.resolve(
            textContent([
              {
                key: "PROJ-2",
                fields: {
                  summary: "Commented ticket",
                  status: { name: "In Progress" },
                  issuetype: { name: "Bug" },
                },
              },
            ]),
          );
        }
        if (jql.includes("status CHANGED BY")) {
          return Promise.resolve(
            textContent([
              {
                key: "PROJ-3",
                fields: {
                  summary: "Transitioned ticket",
                  status: { name: "In Review" },
                  issuetype: { name: "Story" },
                  epic: { name: "Epic A" },
                },
              },
            ]),
          );
        }
        if (jql.includes("reporter =")) {
          return Promise.resolve(
            textContent([
              {
                key: "PROJ-4",
                fields: {
                  summary: "Created ticket",
                  status: { name: "To Do" },
                  issuetype: { name: "Task" },
                },
              },
            ]),
          );
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
    });

    expect(manager.connect).toHaveBeenCalledWith(SERVER_CONFIG);
    expect(manager.callTool).toHaveBeenCalledTimes(4);

    const calls = manager.callTool.mock.calls;
    expect(calls[0]).toEqual([
      FAKE_CLIENT,
      "jira_search",
      {
        jql: 'assignee = "alice" AND resolved >= "2025-06-01" AND resolved <= "2025-06-08"',
      },
    ]);
    expect(calls[1]).toEqual([
      FAKE_CLIENT,
      "jira_search",
      {
        jql: 'commentedByUser = "alice" AND updated >= "2025-06-01" AND updated <= "2025-06-08"',
      },
    ]);
    expect(calls[2]).toEqual([
      FAKE_CLIENT,
      "jira_search",
      { jql: 'status CHANGED BY "alice" DURING ("2025-06-01", "2025-06-08")' },
    ]);
    expect(calls[3]).toEqual([
      FAKE_CLIENT,
      "jira_search",
      {
        jql: 'reporter = "alice" AND created >= "2025-06-01" AND created <= "2025-06-08"',
      },
    ]);

    expect(result).toEqual([
      {
        type: "ticket_completed",
        title: "Done ticket",
        ticketKey: "PROJ-1",
        url: "https://example.atlassian.net/browse/PROJ-1",
        issueType: "Task",
        storyPoints: 5,
        epicName: "Launch Q3",
        metadata: { status: "Done" },
      },
      {
        type: "ticket_commented",
        title: "Commented ticket",
        ticketKey: "PROJ-2",
        url: "https://example.atlassian.net/browse/PROJ-2",
        issueType: "Bug",
        metadata: { status: "In Progress" },
      },
      {
        type: "ticket_transitioned",
        title: "Transitioned ticket",
        ticketKey: "PROJ-3",
        url: "https://example.atlassian.net/browse/PROJ-3",
        issueType: "Story",
        epicName: "Epic A",
        metadata: { status: "In Review" },
      },
      {
        type: "ticket_created",
        title: "Created ticket",
        ticketKey: "PROJ-4",
        url: "https://example.atlassian.net/browse/PROJ-4",
        issueType: "Task",
        metadata: { status: "To Do" },
      },
    ]);

    expect(logger.info).toHaveBeenCalledWith(
      "Collected 4 Atlassian activity item(s)",
    );
  });

  it("trims trailing slashes from the jira base URL when building ticket URLs", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, _toolName: string, args: Record<string, unknown>) => {
        const jql = args["jql"] as string;
        if (jql.includes("resolved >=")) {
          return Promise.resolve(
            textContent([{ key: "PROJ-1", fields: { summary: "S" } }]),
          );
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: "https://example.atlassian.net///",
    });

    const first = result[0];
    expect(first?.url).toBe("https://example.atlassian.net/browse/PROJ-1");
  });
});

describe("collectAtlassianActivity — connection failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] and logs error when manager.connect throws an Error", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue(new Error("unreachable"));

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
    });

    expect(result).toEqual([]);
    expect(manager.callTool).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to Atlassian MCP server",
      "unreachable",
    );
  });

  it("coerces non-Error rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue("raw string");

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to Atlassian MCP server",
      "raw string",
    );
  });
});

describe("collectAtlassianActivity — tool call failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs warning when a tool throws an Error and continues with remaining tools", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    let callIndex = 0;
    manager.callTool.mockImplementation(() => {
      callIndex += 1;
      if (callIndex === 1) {
        return Promise.reject(new Error("tool broke"));
      }
      return Promise.resolve(textContent([]));
    });

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
    });

    expect(result).toEqual([]);
    expect(manager.callTool).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledWith(
      'Jira tool "jira_search" (ticket_completed) failed',
      "tool broke",
    );
  });

  it("coerces non-Error rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    let callIndex = 0;
    manager.callTool.mockImplementation(() => {
      callIndex += 1;
      if (callIndex === 1) {
        return Promise.reject("bad thing");
      }
      return Promise.resolve(textContent([]));
    });

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Jira tool "jira_search" (ticket_completed) failed',
      "bad thing",
    );
  });
});

describe("collectAtlassianActivity — response parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSingleToolResponse(response: unknown): Promise<number> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, _toolName: string, args: Record<string, unknown>) => {
        const jql = args["jql"] as string;
        if (jql.includes("resolved >=")) {
          return Promise.resolve(response);
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
    });

    return result.filter((item) => item.type === "ticket_completed").length;
  }

  it("uses structuredContent.issues when present", async () => {
    const count = await runSingleToolResponse({
      structuredContent: {
        issues: [{ key: "PROJ-1", fields: { summary: "Structured issue" } }],
      },
    });
    expect(count).toBe(1);
  });

  it("falls through to content when structuredContent has no issues array", async () => {
    const count = await runSingleToolResponse({
      structuredContent: { other: "value" },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            issues: [{ key: "PROJ-2", fields: { summary: "Content issue" } }],
          }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("skips content entries with non-text type", async () => {
    const count = await runSingleToolResponse({
      content: [
        { type: "image", data: "..." },
        {
          type: "text",
          text: JSON.stringify({
            issues: [{ key: "PROJ-3", fields: { summary: "After image" } }],
          }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("skips content entries where text is not a string", async () => {
    const count = await runSingleToolResponse({
      content: [
        { type: "text", text: 123 },
        {
          type: "text",
          text: JSON.stringify({
            issues: [{ key: "PROJ-4", fields: { summary: "Valid" } }],
          }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("returns empty when content text is invalid JSON", async () => {
    const count = await runSingleToolResponse({
      content: [{ type: "text", text: "not json{" }],
    });
    expect(count).toBe(0);
  });

  it("uses a bare array returned from JSON.parse", async () => {
    const count = await runSingleToolResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { key: "PROJ-5", fields: { summary: "Bare array issue" } },
          ]),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("returns empty when parsed content is a primitive", async () => {
    const count = await runSingleToolResponse({
      content: [{ type: "text", text: JSON.stringify("hello") }],
    });
    expect(count).toBe(0);
  });

  it("skips null entries in content array", async () => {
    const count = await runSingleToolResponse({
      content: [
        null,
        {
          type: "text",
          text: JSON.stringify({
            issues: [{ key: "PROJ-6", fields: { summary: "After null" } }],
          }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("returns empty when response is null", async () => {
    const count = await runSingleToolResponse(null);
    expect(count).toBe(0);
  });

  it("returns empty when response is a string", async () => {
    const count = await runSingleToolResponse("not an object");
    expect(count).toBe(0);
  });

  it("returns empty when response has neither content nor structuredContent", async () => {
    const count = await runSingleToolResponse({ other: "field" });
    expect(count).toBe(0);
  });

  it("skips issue entries that are not objects", async () => {
    const count = await runSingleToolResponse(
      textContent(["not an object", 42, null]),
    );
    expect(count).toBe(0);
  });

  it("returns empty when content entries are all skippable without any parseable text", async () => {
    const count = await runSingleToolResponse({
      content: [null, { type: "image", data: "x" }, { type: "text", text: 5 }],
    });
    expect(count).toBe(0);
  });

  it("returns empty when content is not an array", async () => {
    const count = await runSingleToolResponse({ content: "not an array" });
    expect(count).toBe(0);
  });
});

describe("collectAtlassianActivity — issue shaping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function collectFirstCompleted(
    issue: Record<string, unknown>,
  ): Promise<ActivityItemSnapshot | undefined> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, _toolName: string, args: Record<string, unknown>) => {
        const jql = args["jql"] as string;
        if (jql.includes("resolved >=")) {
          return Promise.resolve(textContent([issue]));
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
    });

    const first = result.find((entry) => entry.type === "ticket_completed");
    return first as ActivityItemSnapshot | undefined;
  }

  interface ActivityItemSnapshot {
    type: string;
    title: string;
    ticketKey?: string;
    url?: string;
    issueType?: string;
    storyPoints?: number;
    epicName?: string;
    metadata?: Record<string, unknown>;
  }

  it("drops issues without a key", async () => {
    const item = await collectFirstCompleted({ fields: { summary: "X" } });
    expect(item).toBeUndefined();
  });

  it("falls back to ticket key as title when summary is missing", async () => {
    const item = await collectFirstCompleted({ key: "PROJ-10", fields: {} });
    expect(item?.title).toBe("PROJ-10");
  });

  it("treats a missing fields object as empty fields", async () => {
    const item = await collectFirstCompleted({ key: "PROJ-11" });
    expect(item?.title).toBe("PROJ-11");
    expect(item?.issueType).toBeUndefined();
    expect(item?.storyPoints).toBeUndefined();
    expect(item?.epicName).toBeUndefined();
    expect(item?.metadata).toBeUndefined();
  });

  it("reads story points from alternate custom field 10026", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-12",
      fields: { summary: "S", customfield_10026: 8 },
    });
    expect(item?.storyPoints).toBe(8);
  });

  it("reads story points from a plain 'storypoints' field", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-13",
      fields: { summary: "S", storypoints: 3 },
    });
    expect(item?.storyPoints).toBe(3);
  });

  it("reads story points from 'story_points' field", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-14",
      fields: { summary: "S", story_points: 2 },
    });
    expect(item?.storyPoints).toBe(2);
  });

  it("ignores non-numeric story point values", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-15",
      fields: { summary: "S", customfield_10016: "not a number" },
    });
    expect(item?.storyPoints).toBeUndefined();
  });

  it("prefers parent.fields.summary for epic name", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-16",
      fields: {
        summary: "S",
        parent: { fields: { summary: "Parent epic" } },
        epic: { name: "Ignored epic" },
      },
    });
    expect(item?.epicName).toBe("Parent epic");
  });

  it("falls back to epic.name when parent summary is missing", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-17",
      fields: { summary: "S", epic: { name: "Epic only" } },
    });
    expect(item?.epicName).toBe("Epic only");
  });

  it("ignores parent when parent.fields is not an object", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-18",
      fields: {
        summary: "S",
        parent: { fields: "not an object" },
        epic: { name: "Epic fallback" },
      },
    });
    expect(item?.epicName).toBe("Epic fallback");
  });

  it("ignores parent when parent.fields.summary is not a string", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-19",
      fields: {
        summary: "S",
        parent: { fields: { summary: 42 } },
        epic: { name: "Epic fallback" },
      },
    });
    expect(item?.epicName).toBe("Epic fallback");
  });

  it("ignores parent when it is not an object", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-20",
      fields: {
        summary: "S",
        parent: "not an object",
        epic: { name: "Epic only" },
      },
    });
    expect(item?.epicName).toBe("Epic only");
  });

  it("leaves epic name undefined when neither parent nor epic is set", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-21",
      fields: { summary: "S" },
    });
    expect(item?.epicName).toBeUndefined();
  });

  it("ignores epic when it is not an object", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-22",
      fields: { summary: "S", epic: "not an object" },
    });
    expect(item?.epicName).toBeUndefined();
  });

  it("ignores epic when epic.name is not a string", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-23",
      fields: { summary: "S", epic: { name: 42 } },
    });
    expect(item?.epicName).toBeUndefined();
  });

  it("leaves issue type undefined when issuetype object is missing", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-24",
      fields: { summary: "S" },
    });
    expect(item?.issueType).toBeUndefined();
  });

  it("leaves issue type undefined when issuetype is not an object", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-25",
      fields: { summary: "S", issuetype: "not an object" },
    });
    expect(item?.issueType).toBeUndefined();
  });

  it("leaves status metadata undefined when status is not an object", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-26",
      fields: { summary: "S", status: "not an object" },
    });
    expect(item?.metadata).toBeUndefined();
  });

  it("leaves status metadata undefined when status.name is not a string", async () => {
    const item = await collectFirstCompleted({
      key: "PROJ-27",
      fields: { summary: "S", status: { name: 42 } },
    });
    expect(item?.metadata).toBeUndefined();
  });
});

const CONFLUENCE_BASE_URL = "https://example.atlassian.net/wiki";

function confluenceTextContent(results: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
}

describe("collectAtlassianActivity — Confluence happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls confluence_search with the expected CQL and shapes pages into ActivityItems", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "jira_search") {
          return Promise.resolve(textContent([]));
        }
        expect(toolName).toBe("confluence_search");
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve(
            confluenceTextContent([
              {
                title: "New onboarding doc",
                space: { name: "Engineering" },
                _links: { webui: "/spaces/ENG/pages/123/New-onboarding-doc" },
              },
            ]),
          );
        }
        if (cql.includes("contributor =")) {
          return Promise.resolve(
            confluenceTextContent([
              {
                title: "Updated runbook",
                space: { name: "Platform" },
                url: "https://example.atlassian.net/wiki/spaces/PLAT/pages/456/Updated-runbook",
              },
            ]),
          );
        }
        return Promise.resolve(confluenceTextContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
      confluenceBaseUrl: CONFLUENCE_BASE_URL,
    });

    expect(manager.connect).toHaveBeenCalledTimes(1);
    expect(manager.callTool).toHaveBeenCalledTimes(6);

    const confluenceCalls = manager.callTool.mock.calls.filter(
      (call) => call[1] === "confluence_search",
    );
    expect(confluenceCalls).toEqual([
      [
        FAKE_CLIENT,
        "confluence_search",
        {
          query:
            'type = page AND creator = "alice" AND created >= "2025-06-01" AND created <= "2025-06-08"',
        },
      ],
      [
        FAKE_CLIENT,
        "confluence_search",
        {
          query:
            'type = page AND contributor = "alice" AND lastmodified >= "2025-06-01" AND lastmodified <= "2025-06-08"',
        },
      ],
    ]);

    expect(result).toEqual([
      {
        type: "page_created",
        title: "New onboarding doc",
        url: "https://example.atlassian.net/wiki/spaces/ENG/pages/123/New-onboarding-doc",
        spaceName: "Engineering",
      },
      {
        type: "page_edited",
        title: "Updated runbook",
        url: "https://example.atlassian.net/wiki/spaces/PLAT/pages/456/Updated-runbook",
        spaceName: "Platform",
      },
    ]);

    expect(logger.info).toHaveBeenCalledWith(
      "Collected 2 Atlassian activity item(s)",
    );
  });

  it("does not call confluence_search when confluenceBaseUrl is not provided", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent([]));

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
    });

    expect(result).toEqual([]);
    expect(manager.callTool).toHaveBeenCalledTimes(4);
    for (const call of manager.callTool.mock.calls) {
      expect(call[1]).toBe("jira_search");
    }
  });

  it("trims trailing slashes from confluence base URL when building page URLs from webui", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "jira_search") {
          return Promise.resolve(textContent([]));
        }
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve(
            confluenceTextContent([
              {
                title: "Doc",
                space: { name: "Engineering" },
                _links: { webui: "/spaces/ENG/pages/1/Doc" },
              },
            ]),
          );
        }
        return Promise.resolve(confluenceTextContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
      confluenceBaseUrl: "https://example.atlassian.net/wiki///",
    });

    const page = result.find((item) => item.type === "page_created");
    expect(page?.url).toBe(
      "https://example.atlassian.net/wiki/spaces/ENG/pages/1/Doc",
    );
  });

  it("prepends a slash to webui when it doesn't already start with one", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "jira_search") {
          return Promise.resolve(textContent([]));
        }
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve(
            confluenceTextContent([
              {
                title: "Doc",
                _links: { webui: "spaces/ENG/pages/1/Doc" },
              },
            ]),
          );
        }
        return Promise.resolve(confluenceTextContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
      confluenceBaseUrl: CONFLUENCE_BASE_URL,
    });

    const page = result.find((item) => item.type === "page_created");
    expect(page?.url).toBe(
      "https://example.atlassian.net/wiki/spaces/ENG/pages/1/Doc",
    );
  });
});

describe("collectAtlassianActivity — Confluence tool call failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs warning and continues when confluence_search throws an Error", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "jira_search") {
          return Promise.resolve(textContent([]));
        }
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.reject(new Error("confluence down"));
        }
        return Promise.resolve(confluenceTextContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
      confluenceBaseUrl: CONFLUENCE_BASE_URL,
    });

    expect(result).toEqual([]);
    expect(manager.callTool).toHaveBeenCalledTimes(6);
    expect(logger.warn).toHaveBeenCalledWith(
      'Confluence tool "confluence_search" (page_created) failed',
      "confluence down",
    );
  });

  it("coerces non-Error confluence rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "jira_search") {
          return Promise.resolve(textContent([]));
        }
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.reject("conf bad");
        }
        return Promise.resolve(confluenceTextContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
      confluenceBaseUrl: CONFLUENCE_BASE_URL,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Confluence tool "confluence_search" (page_created) failed',
      "conf bad",
    );
  });
});

describe("collectAtlassianActivity — Confluence page shaping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  interface ConfluenceSnapshot {
    type: string;
    title: string;
    url?: string;
    spaceName?: string;
  }

  async function collectFirstCreated(
    page: unknown,
  ): Promise<ConfluenceSnapshot | undefined> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "jira_search") {
          return Promise.resolve(textContent([]));
        }
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve(confluenceTextContent([page]));
        }
        return Promise.resolve(confluenceTextContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
      confluenceBaseUrl: CONFLUENCE_BASE_URL,
    });

    const first = result.find((entry) => entry.type === "page_created");
    return first as ConfluenceSnapshot | undefined;
  }

  it("drops page entries that are not objects", async () => {
    const item = await collectFirstCreated("not an object");
    expect(item).toBeUndefined();
  });

  it("drops pages without a title", async () => {
    const item = await collectFirstCreated({ space: { name: "ENG" } });
    expect(item).toBeUndefined();
  });

  it("drops pages whose title is not a string", async () => {
    const item = await collectFirstCreated({ title: 42 });
    expect(item).toBeUndefined();
  });

  it("prefers a direct url field over webui link", async () => {
    const item = await collectFirstCreated({
      title: "T",
      url: "https://direct.example.com/page",
      _links: { webui: "/should/not/be/used" },
    });
    expect(item?.url).toBe("https://direct.example.com/page");
  });

  it("omits url when neither url nor _links.webui is present", async () => {
    const item = await collectFirstCreated({ title: "T" });
    expect(item?.url).toBeUndefined();
  });

  it("omits url when _links is not an object", async () => {
    const item = await collectFirstCreated({
      title: "T",
      _links: "not an object",
    });
    expect(item?.url).toBeUndefined();
  });

  it("omits url when _links.webui is not a string", async () => {
    const item = await collectFirstCreated({
      title: "T",
      _links: { webui: 42 },
    });
    expect(item?.url).toBeUndefined();
  });

  it("omits spaceName when space is not an object", async () => {
    const item = await collectFirstCreated({
      title: "T",
      space: "not an object",
    });
    expect(item?.spaceName).toBeUndefined();
  });

  it("omits spaceName when space.name is not a string", async () => {
    const item = await collectFirstCreated({
      title: "T",
      space: { name: 42 },
    });
    expect(item?.spaceName).toBeUndefined();
  });

  it("uses structuredContent.results when present", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "jira_search") {
          return Promise.resolve(textContent([]));
        }
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve({
            structuredContent: {
              results: [{ title: "Structured page" }],
            },
          });
        }
        return Promise.resolve(confluenceTextContent([]));
      },
    );

    const result = await collectAtlassianActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      jiraUsername: JIRA_USERNAME,
      jiraBaseUrl: JIRA_BASE_URL,
      confluenceBaseUrl: CONFLUENCE_BASE_URL,
    });

    const page = result.find((item) => item.type === "page_created");
    expect(page?.title).toBe("Structured page");
  });
});
