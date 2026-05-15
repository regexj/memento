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

function structuredResult(payload: unknown): {
  structuredContent: { result: string };
} {
  return { structuredContent: { result: JSON.stringify(payload) } };
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
                content: { value: "Runbook for deployments" },
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
            'type = page AND creator = currentUser() AND created >= "2025-06-01" AND created <= "2025-06-08"',
        },
      ],
      [
        FAKE_CLIENT,
        "confluence_search",
        {
          query:
            'type = page AND contributor = currentUser() AND lastmodified >= "2025-06-01" AND lastmodified <= "2025-06-08"',
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
        description: "Runbook for deployments",
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
      baseUrl: BASE_URL,
    });

    return result.filter((item) => item.type === "page_created").length;
  }

  it("parses structuredContent.result containing a result array", async () => {
    const count = await runSingleToolResponse(
      structuredResult({ result: [{ title: "Structured page" }] }),
    );
    expect(count).toBe(1);
  });

  it("parses structuredContent.result containing a bare array", async () => {
    const count = await runSingleToolResponse(
      structuredResult([{ title: "Bare array page" }]),
    );
    expect(count).toBe(1);
  });

  it("returns empty when structuredContent.result parses to an object without result array", async () => {
    const count = await runSingleToolResponse(structuredResult({ total: 0 }));
    expect(count).toBe(0);
  });

  it("returns empty when structuredContent.result is invalid JSON", async () => {
    const count = await runSingleToolResponse({
      structuredContent: { result: "not json{" },
    });
    expect(count).toBe(0);
  });

  it("falls through to content when structuredContent.result is not a string", async () => {
    const count = await runSingleToolResponse({
      structuredContent: { result: 123 },
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

  it("falls through to content when structuredContent is not an object", async () => {
    const count = await runSingleToolResponse({
      structuredContent: "not an object",
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

  it("uses a bare array returned from content JSON.parse", async () => {
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
    description?: string;
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

  it("extracts description from content.value", async () => {
    const item = await collectFirstCreated({
      title: "T",
      content: { value: "Page body content" },
    });
    expect(item?.description).toBe("Page body content");
  });

  it("omits description when content is not an object", async () => {
    const item = await collectFirstCreated({
      title: "T",
      content: "not an object",
    });
    expect(item?.description).toBeUndefined();
  });

  it("omits description when content.value is not a string", async () => {
    const item = await collectFirstCreated({
      title: "T",
      content: { value: 42 },
    });
    expect(item?.description).toBeUndefined();
  });

  it("omits description when content object has no value key", async () => {
    const item = await collectFirstCreated({
      title: "T",
      content: { other: "stuff" },
    });
    expect(item?.description).toBeUndefined();
  });
});
