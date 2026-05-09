import { logger } from "../../logger.ts";
import type { McpClientManager } from "../../mcp.ts";
import type { CollectionWindow, McpServerConfig } from "../../types.ts";
import { collectConfluenceActivity } from "../confluence.ts";
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

function textContent(results: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
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

const USERNAME = "alice";
const BASE_URL = "https://example.atlassian.net/wiki";
const FAKE_CLIENT = { id: "client" } as unknown as Client;

describe("collectConfluenceActivity — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls confluence_search with the expected CQL and shapes pages into ActivityItems", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        expect(toolName).toBe("confluence_search");
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve(
            textContent([
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
            textContent([
              {
                title: "Updated runbook",
                space: { name: "Platform" },
                url: "https://example.atlassian.net/wiki/spaces/PLAT/pages/456/Updated-runbook",
              },
            ]),
          );
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectConfluenceActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
      baseUrl: BASE_URL,
    });

    expect(manager.connect).toHaveBeenCalledWith(SERVER_CONFIG);
    expect(manager.callTool).toHaveBeenCalledTimes(2);

    expect(manager.callTool.mock.calls).toEqual([
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
      "Collected 2 Confluence activity item(s)",
    );
  });

  it("trims trailing slashes from base URL when building page URLs from webui", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, _toolName: string, args: Record<string, unknown>) => {
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve(
            textContent([
              {
                title: "Doc",
                space: { name: "Engineering" },
                _links: { webui: "/spaces/ENG/pages/1/Doc" },
              },
            ]),
          );
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectConfluenceActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
      baseUrl: "https://example.atlassian.net/wiki///",
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
      (_client: Client, _toolName: string, args: Record<string, unknown>) => {
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve(
            textContent([
              {
                title: "Doc",
                _links: { webui: "spaces/ENG/pages/1/Doc" },
              },
            ]),
          );
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectConfluenceActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
      baseUrl: BASE_URL,
    });

    const page = result.find((item) => item.type === "page_created");
    expect(page?.url).toBe(
      "https://example.atlassian.net/wiki/spaces/ENG/pages/1/Doc",
    );
  });
});

describe("collectConfluenceActivity — connection failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] and logs error when manager.connect throws an Error", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue(new Error("unreachable"));

    const result = await collectConfluenceActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
      baseUrl: BASE_URL,
    });

    expect(result).toEqual([]);
    expect(manager.callTool).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to Confluence MCP server",
      "unreachable",
    );
  });

  it("coerces non-Error rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue("raw string");

    const result = await collectConfluenceActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
      baseUrl: BASE_URL,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to Confluence MCP server",
      "raw string",
    );
  });
});

describe("collectConfluenceActivity — tool call failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs warning and continues when confluence_search throws an Error", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, _toolName: string, args: Record<string, unknown>) => {
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.reject(new Error("confluence down"));
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectConfluenceActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
      baseUrl: BASE_URL,
    });

    expect(result).toEqual([]);
    expect(manager.callTool).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'Confluence tool "confluence_search" (page_created) failed',
      "confluence down",
    );
  });

  it("coerces non-Error rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, _toolName: string, args: Record<string, unknown>) => {
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.reject("conf bad");
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectConfluenceActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
      baseUrl: BASE_URL,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Confluence tool "confluence_search" (page_created) failed',
      "conf bad",
    );
  });
});

describe("collectConfluenceActivity — response parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSingleToolResponse(response: unknown): Promise<number> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, _toolName: string, args: Record<string, unknown>) => {
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve(response);
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectConfluenceActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
      baseUrl: BASE_URL,
    });

    return result.filter((item) => item.type === "page_created").length;
  }

  it("falls through to content when structuredContent has no results array", async () => {
    const count = await runSingleToolResponse({
      structuredContent: { other: "value" },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [{ title: "Content page" }],
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
            results: [{ title: "After image" }],
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
            results: [{ title: "Valid" }],
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
          text: JSON.stringify([{ title: "Bare array page" }]),
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
            results: [{ title: "After null" }],
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

describe("collectConfluenceActivity — page shaping", () => {
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
      (_client: Client, _toolName: string, args: Record<string, unknown>) => {
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve(textContent([page]));
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectConfluenceActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
      baseUrl: BASE_URL,
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
      (_client: Client, _toolName: string, args: Record<string, unknown>) => {
        const cql = args["query"] as string;
        if (cql.includes("creator =")) {
          return Promise.resolve({
            structuredContent: {
              results: [{ title: "Structured page" }],
            },
          });
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectConfluenceActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
      baseUrl: BASE_URL,
    });

    const page = result.find((item) => item.type === "page_created");
    expect(page?.title).toBe("Structured page");
  });
});
