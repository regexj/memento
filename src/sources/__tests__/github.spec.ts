import { logger } from "../../logger.ts";
import type { McpClientManager } from "../../mcp.ts";
import type { CollectionWindow, McpServerConfig } from "../../types.ts";
import { collectGithubActivity } from "../github.ts";
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

function textContent(items: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify({ items }) }] };
}

const WINDOW: CollectionWindow = {
  from: new Date("2025-06-01T00:00:00.000Z"),
  to: new Date("2025-06-08T00:00:00.000Z"),
};

const SERVER_CONFIG: McpServerConfig = {
  name: "github",
  command: "node",
  args: ["github-mcp.js"],
  toolCalls: [],
};

const USERNAME = "alice";
const FAKE_CLIENT = { id: "client" } as unknown as Client;

describe("collectGithubActivity — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls the five tools in order with correct queries and aggregates items", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "search_pull_requests") {
          const query = args["query"] as string;
          if (query.includes("author:alice created:")) {
            return Promise.resolve(
              textContent([
                {
                  title: "Add feature X",
                  html_url: "https://github.com/owner/repo-a/pull/1",
                  repository: { full_name: "owner/repo-a" },
                },
              ]),
            );
          }
          if (query.includes("author:alice merged:")) {
            return Promise.resolve(
              textContent([
                {
                  title: "Merged Y",
                  html_url: "https://github.com/owner/repo-a/pull/2",
                  repository: { full_name: "owner/repo-a" },
                },
              ]),
            );
          }
          if (query.includes("reviewed-by:alice")) {
            return Promise.resolve(
              textContent([
                {
                  title: "Reviewed Z",
                  html_url: "https://github.com/owner/repo-b/pull/3",
                  repository: { full_name: "owner/repo-b" },
                },
              ]),
            );
          }
          if (query.includes("commenter:alice")) {
            return Promise.resolve(
              textContent([
                {
                  title: "Commented on W",
                  html_url: "https://github.com/owner/repo-b/pull/4",
                  repository: { full_name: "owner/repo-b" },
                },
              ]),
            );
          }
        }
        if (toolName === "search_issues") {
          return Promise.resolve(
            textContent([
              {
                title: "Closed issue",
                html_url: "https://github.com/owner/repo-c/issues/5",
                repository: { full_name: "owner/repo-c" },
              },
            ]),
          );
        }
        return Promise.resolve({});
      },
    );

    const result = await collectGithubActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
    });

    expect(manager.connect).toHaveBeenCalledWith(SERVER_CONFIG);
    expect(manager.callTool).toHaveBeenCalledTimes(5);

    const calls = manager.callTool.mock.calls;
    expect(calls[0]).toEqual([
      FAKE_CLIENT,
      "search_pull_requests",
      { query: "is:pr author:alice created:2025-06-01..2025-06-08" },
    ]);
    expect(calls[1]).toEqual([
      FAKE_CLIENT,
      "search_pull_requests",
      { query: "is:pr author:alice merged:2025-06-01..2025-06-08" },
    ]);
    expect(calls[2]).toEqual([
      FAKE_CLIENT,
      "search_pull_requests",
      { query: "is:pr reviewed-by:alice updated:2025-06-01..2025-06-08" },
    ]);
    expect(calls[3]).toEqual([
      FAKE_CLIENT,
      "search_pull_requests",
      { query: "is:pr commenter:alice updated:2025-06-01..2025-06-08" },
    ]);
    expect(calls[4]).toEqual([
      FAKE_CLIENT,
      "search_issues",
      { query: "is:issue assignee:alice closed:2025-06-01..2025-06-08" },
    ]);

    expect(result).toEqual([
      {
        type: "pr_opened",
        title: "Add feature X",
        url: "https://github.com/owner/repo-a/pull/1",
        repo: "owner/repo-a",
      },
      {
        type: "pr_merged",
        title: "Merged Y",
        url: "https://github.com/owner/repo-a/pull/2",
        repo: "owner/repo-a",
      },
      {
        type: "pr_reviewed",
        title: "Reviewed Z",
        url: "https://github.com/owner/repo-b/pull/3",
        repo: "owner/repo-b",
      },
      {
        type: "pr_review_comment",
        title: "Commented on W",
        url: "https://github.com/owner/repo-b/pull/4",
        repo: "owner/repo-b",
      },
      {
        type: "issue_closed",
        title: "Closed issue",
        url: "https://github.com/owner/repo-c/issues/5",
        repo: "owner/repo-c",
      },
    ]);

    expect(logger.info).toHaveBeenCalledWith(
      "Collected 5 GitHub activity item(s)",
    );
  });
});

describe("collectGithubActivity — connection failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] and logs error when manager.connect throws an Error", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue(new Error("unreachable"));

    const result = await collectGithubActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
    });

    expect(result).toEqual([]);
    expect(manager.callTool).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to GitHub MCP server",
      "unreachable",
    );
  });

  it("coerces non-Error rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue("raw string");

    const result = await collectGithubActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to GitHub MCP server",
      "raw string",
    );
  });
});

describe("collectGithubActivity — tool call failures", () => {
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

    const result = await collectGithubActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
    });

    expect(result).toEqual([]);
    expect(manager.callTool).toHaveBeenCalledTimes(5);
    expect(logger.warn).toHaveBeenCalledWith(
      'GitHub tool "search_pull_requests" (pr_opened) failed',
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

    const result = await collectGithubActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'GitHub tool "search_pull_requests" (pr_opened) failed',
      "bad thing",
    );
  });
});

describe("collectGithubActivity — response parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSingleToolResponse(response: unknown): Promise<number> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        const query = args["query"] as string;
        if (
          toolName === "search_pull_requests" &&
          query.includes("author:alice created:")
        ) {
          return Promise.resolve(response);
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectGithubActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
    });

    return result.filter((item) => item.type === "pr_opened").length;
  }

  it("uses structuredContent.items when present", async () => {
    const count = await runSingleToolResponse({
      structuredContent: {
        items: [
          {
            title: "Structured PR",
            html_url: "https://github.com/owner/repo/pull/10",
            repository: { full_name: "owner/repo" },
          },
        ],
      },
    });
    expect(count).toBe(1);
  });

  it("falls through to content when structuredContent has no items array", async () => {
    const count = await runSingleToolResponse({
      structuredContent: { other: "value" },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items: [
              {
                title: "Content PR",
                html_url: "https://github.com/owner/repo/pull/11",
              },
            ],
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
            items: [
              {
                title: "After image",
                html_url: "https://github.com/o/r/pull/1",
              },
            ],
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
            items: [
              { title: "Valid", html_url: "https://github.com/o/r/pull/1" },
            ],
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
            { title: "Bare PR", html_url: "https://github.com/o/r/pull/1" },
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
            items: [
              {
                title: "After null",
                html_url: "https://github.com/o/r/pull/1",
              },
            ],
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

  it("skips items that are not objects", async () => {
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

describe("collectGithubActivity — PR/issue repo resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function collectFirstPr(
    item: Record<string, unknown>,
  ): Promise<
    | { repo?: string; title: string; url?: string; description?: string }
    | undefined
  > {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        const query = args["query"] as string;
        if (
          toolName === "search_pull_requests" &&
          query.includes("author:alice created:")
        ) {
          return Promise.resolve(textContent([item]));
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectGithubActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
    });
    const first = result.find((entry) => entry.type === "pr_opened");
    if (first === undefined) {
      return undefined;
    }
    const out: {
      repo?: string;
      title: string;
      url?: string;
      description?: string;
    } = {
      title: first.title,
    };
    if (first.repo !== undefined) {
      out.repo = first.repo;
    }
    if (first.url !== undefined) {
      out.url = first.url;
    }
    if (first.description !== undefined) {
      out.description = first.description;
    }
    return out;
  }

  it("uses repository.full_name when available", async () => {
    const out = await collectFirstPr({
      title: "A",
      html_url: "https://github.com/owner/fromurl/pull/1",
      repository: { full_name: "owner/direct" },
      repository_url: "https://api.github.com/repos/owner/repourl",
    });
    expect(out?.repo).toBe("owner/direct");
  });

  it("extracts repo from html_url when repository.full_name is missing", async () => {
    const out = await collectFirstPr({
      title: "A",
      html_url: "https://github.com/owner/fromurl/pull/1",
    });
    expect(out?.repo).toBe("owner/fromurl");
  });

  it("leaves repo undefined when no repo info is available", async () => {
    const out = await collectFirstPr({ title: "A" });
    expect(out?.repo).toBeUndefined();
    expect(out?.url).toBeUndefined();
  });

  it("returns undefined repo when html_url does not match the github.com pattern", async () => {
    const out = await collectFirstPr({
      title: "A",
      html_url: "https://example.com/not/github",
    });
    expect(out?.repo).toBeUndefined();
  });

  it("returns undefined repo when repository_url does not match the repos pattern", async () => {
    const out = await collectFirstPr({
      title: "A",
      repository_url: "https://api.github.com/other/path",
    });
    expect(out?.repo).toBeUndefined();
  });

  it("ignores repository object that lacks full_name string", async () => {
    const out = await collectFirstPr({
      title: "A",
      html_url: "https://github.com/owner/fallback/pull/1",
      repository: { full_name: 42 },
    });
    expect(out?.repo).toBe("owner/fallback");
  });

  it("extracts description from body when available", async () => {
    const out = await collectFirstPr({
      title: "A",
      body: "Did a thing",
    });
    expect(out?.description).toBe("Did a thing");
  });
});

describe("collectGithubActivity — PR/issue title fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to #number when title is missing", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        const query = args["query"] as string;
        if (
          toolName === "search_pull_requests" &&
          query.includes("author:alice created:")
        ) {
          return Promise.resolve(textContent([{ number: 42 }]));
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectGithubActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
    });
    const pr = result.find((r) => r.type === "pr_opened");
    expect(pr?.title).toBe("#42");
  });

  it("falls back to #? when title and number are missing", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        const query = args["query"] as string;
        if (
          toolName === "search_pull_requests" &&
          query.includes("author:alice created:")
        ) {
          return Promise.resolve(textContent([{}]));
        }
        return Promise.resolve(textContent([]));
      },
    );

    const result = await collectGithubActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      username: USERNAME,
    });
    const pr = result.find((r) => r.type === "pr_opened");
    expect(pr?.title).toBe("#?");
  });
});
