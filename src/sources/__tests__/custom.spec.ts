import { logger } from "../../logger.ts";
import type { McpClientManager } from "../../mcp.ts";
import type { CollectionWindow } from "../../types.ts";
import { collectCustomActivity } from "../custom.ts";
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

function textContent(payload: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

const WINDOW: CollectionWindow = {
  from: new Date("2025-06-01T00:00:00.000Z"),
  to: new Date("2025-06-08T00:00:00.000Z"),
};

const USERNAME = "alice";
const FAKE_CLIENT = { id: "client" } as unknown as Client;
const CONFIG_PATH = "./mcp-servers.json";

function makeReadFile(content: string): (path: string) => Promise<string> {
  return vi.fn(async () => content);
}

function makeReadFileReject(error: unknown): (path: string) => Promise<string> {
  return vi.fn(async () => {
    throw error;
  });
}

describe("collectCustomActivity — config loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] and logs info when config file does not exist (ENOENT)", async () => {
    const manager = makeManager();
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    const readFile = makeReadFileReject(err);

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([]);
    expect(manager.connect).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      `No custom MCP server config found at "${CONFIG_PATH}"; skipping custom sources`,
    );
  });

  it("returns [] and logs error for non-ENOENT read errors (Error instance)", async () => {
    const manager = makeManager();
    const readFile = makeReadFileReject(new Error("permission denied"));

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([]);
    expect(manager.connect).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      `Failed to read custom MCP server config at "${CONFIG_PATH}"`,
      "permission denied",
    );
  });

  it("coerces non-Error rejection reasons via String()", async () => {
    const manager = makeManager();
    const readFile = makeReadFileReject("bad");

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      `Failed to read custom MCP server config at "${CONFIG_PATH}"`,
      "bad",
    );
  });

  it("returns [] and logs error when config is not valid JSON", async () => {
    const manager = makeManager();
    const readFile = makeReadFile("not-json{");

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to parse custom MCP server config as JSON",
      expect.any(String),
    );
  });

  it("returns [] when JSON config is not an object", async () => {
    const manager = makeManager();
    const readFile = makeReadFile(JSON.stringify(["a", "b"]));

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'Custom MCP server config must be a JSON object with a "servers" array',
    );
  });

  it("returns [] when servers field is not an array", async () => {
    const manager = makeManager();
    const readFile = makeReadFile(JSON.stringify({ servers: "nope" }));

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'Custom MCP server config must contain a "servers" array',
    );
  });

  it("logs info and returns [] when config has zero valid servers", async () => {
    const manager = makeManager();
    const readFile = makeReadFile(JSON.stringify({ servers: [] }));

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      "Custom MCP server config has no valid servers",
    );
  });

  it("defaults configPath to ./mcp-servers.json when not provided", async () => {
    const manager = makeManager();
    const readFile = vi.fn(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      readFile,
    });

    expect(readFile).toHaveBeenCalledWith("./mcp-servers.json");
  });

  it("uses the real fs.readFile when readFile option is not provided", async () => {
    const manager = makeManager();

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: "./__definitely-not-a-real-path__/mcp-servers.json",
    });

    expect(result).toEqual([]);
    expect(manager.connect).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'No custom MCP server config found at "./__definitely-not-a-real-path__/mcp-servers.json"; skipping custom sources',
    );
  });
});

describe("collectCustomActivity — server entry validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips server entries that are not objects", async () => {
    const manager = makeManager();
    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          "string-entry",
          {
            name: "valid",
            command: "node",
            toolCalls: [],
          },
        ],
      }),
    );
    manager.connect.mockResolvedValue(FAKE_CLIENT);

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "Skipping custom MCP server entry: entry is not an object",
    );
    expect(manager.connect).toHaveBeenCalledTimes(1);
  });

  it("skips server entries missing a name", async () => {
    const manager = makeManager();
    const readFile = makeReadFile(
      JSON.stringify({
        servers: [{ command: "node", toolCalls: [] }],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping custom MCP server entry: missing "name"',
    );
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it("skips server entries with neither command nor url", async () => {
    const manager = makeManager();
    const readFile = makeReadFile(
      JSON.stringify({
        servers: [{ name: "broken", toolCalls: [] }],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping custom MCP server entry: server "broken" must define "command" or "url"',
    );
  });

  it("skips server entries with both command and url", async () => {
    const manager = makeManager();
    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "conflict",
            command: "node",
            url: "https://example.com",
            toolCalls: [],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping custom MCP server entry: server "conflict" must define either "command" or "url", not both',
    );
  });

  it("skips server entries with non-array toolCalls", async () => {
    const manager = makeManager();
    const readFile = makeReadFile(
      JSON.stringify({
        servers: [{ name: "bad-tools", command: "node", toolCalls: "nope" }],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping custom MCP server entry: server "bad-tools" must define a "toolCalls" array',
    );
  });

  it("skips server entries with invalid tool call entries", async () => {
    const manager = makeManager();
    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "bad-call",
            command: "node",
            toolCalls: [{ args: { a: "b" } }],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping custom MCP server entry: server "bad-call" has an invalid tool call entry',
    );
  });

  it("skips tool call entries that are not objects", async () => {
    const manager = makeManager();
    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "bad-call",
            command: "node",
            toolCalls: ["string-call"],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping custom MCP server entry: server "bad-call" has an invalid tool call entry',
    );
  });

  it("accepts tool call with missing args and defaults them to empty object", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "noargs",
            command: "node",
            toolCalls: [{ tool: "list_things" }],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.callTool).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "list_things",
      {},
    );
  });

  it("treats non-record args as empty args", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "bad-args",
            command: "node",
            toolCalls: [{ tool: "list_things", args: ["not", "a", "record"] }],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.callTool).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "list_things",
      {},
    );
  });

  it("treats args with non-string values as empty args", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "bad-arg-values",
            command: "node",
            toolCalls: [{ tool: "list_things", args: { limit: 5 } }],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.callTool).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "list_things",
      {},
    );
  });
});

describe("collectCustomActivity — server config construction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes stdio server config with command, args, env to manager.connect", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "slack",
            command: "npx",
            args: ["-y", "@anthropic/slack-mcp-server"],
            env: { SLACK_TOKEN: "xoxb-test" },
            toolCalls: [{ tool: "search_messages", args: {} }],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.connect).toHaveBeenCalledWith({
      name: "slack",
      command: "npx",
      args: ["-y", "@anthropic/slack-mcp-server"],
      env: { SLACK_TOKEN: "xoxb-test" },
      toolCalls: [{ tool: "search_messages", args: {} }],
    });
  });

  it("passes HTTP server config with url to manager.connect", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "remote",
            url: "https://remote.example/mcp",
            toolCalls: [{ tool: "ping", args: {} }],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.connect).toHaveBeenCalledWith({
      name: "remote",
      url: "https://remote.example/mcp",
      toolCalls: [{ tool: "ping", args: {} }],
    });
  });

  it("ignores args when they are not all strings and ignores env when it is not a string record", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "partial",
            command: "node",
            args: ["ok", 42],
            env: { KEY: 1 },
            toolCalls: [{ tool: "ping", args: {} }],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.connect).toHaveBeenCalledWith({
      name: "partial",
      command: "node",
      toolCalls: [{ tool: "ping", args: {} }],
    });
  });

  it("ignores args when it is not an array", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "no-args-array",
            command: "node",
            args: "not-an-array",
            toolCalls: [{ tool: "ping", args: {} }],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.connect).toHaveBeenCalledWith({
      name: "no-args-array",
      command: "node",
      toolCalls: [{ tool: "ping", args: {} }],
    });
  });

  it("ignores env when it is not a record", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "no-env-record",
            command: "node",
            env: "not-a-record",
            toolCalls: [{ tool: "ping", args: {} }],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.connect).toHaveBeenCalledWith({
      name: "no-env-record",
      command: "node",
      toolCalls: [{ tool: "ping", args: {} }],
    });
  });
});

describe("collectCustomActivity — variable substitution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("substitutes ${USERNAME}, ${FROM_DATE}, ${TO_DATE} in tool call args", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "slack",
            command: "npx",
            args: [],
            toolCalls: [
              {
                tool: "search_messages",
                args: {
                  query: "from:${USERNAME}",
                  after: "${FROM_DATE}",
                  before: "${TO_DATE}",
                },
              },
            ],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.callTool).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "search_messages",
      {
        query: "from:alice",
        after: "2025-06-01",
        before: "2025-06-08",
      },
    );
  });

  it("leaves unknown variables unchanged", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "x",
            command: "node",
            toolCalls: [
              {
                tool: "tool",
                args: { q: "prefix ${MYSTERY} suffix" },
              },
            ],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.callTool).toHaveBeenCalledWith(FAKE_CLIENT, "tool", {
      q: "prefix ${MYSTERY} suffix",
    });
  });

  it("substitutes multiple occurrences of a variable", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(textContent({ items: [] }));

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "x",
            command: "node",
            toolCalls: [
              {
                tool: "tool",
                args: { q: "${USERNAME}-${USERNAME}" },
              },
            ],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(manager.callTool).toHaveBeenCalledWith(FAKE_CLIENT, "tool", {
      q: "alice-alice",
    });
  });
});

describe("collectCustomActivity — tool call execution and shaping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shapes array records from structured content into ActivityItems", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(
      textContent({
        results: [
          {
            title: "Message one",
            url: "https://slack.example/1",
            foo: "bar",
          },
          {
            name: "Message two",
            html_url: "https://slack.example/2",
          },
        ],
      }),
    );

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "slack",
            command: "node",
            toolCalls: [{ tool: "search_messages", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([
      {
        type: "custom_slack_search_messages",
        title: "Message one",
        url: "https://slack.example/1",
        metadata: {
          title: "Message one",
          url: "https://slack.example/1",
          foo: "bar",
        },
      },
      {
        type: "custom_slack_search_messages",
        title: "Message two",
        url: "https://slack.example/2",
        metadata: {
          name: "Message two",
          html_url: "https://slack.example/2",
        },
      },
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "Collected 2 custom activity item(s)",
    );
  });

  it("uses structuredContent array directly when present", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({
      structuredContent: [{ title: "A" }, { summary: "B" }],
    });

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "s",
            command: "node",
            toolCalls: [{ tool: "t", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result.map((r) => r.title)).toEqual(["A", "B"]);
  });

  it("falls through to first array field in structuredContent object", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({
      structuredContent: {
        meta: "v",
        rows: [{ subject: "S" }],
      },
    });

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "s",
            command: "node",
            toolCalls: [{ tool: "t", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("S");
  });

  it("falls back to content arrays when structuredContent has no array", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({
      structuredContent: { meta: "v", otherObj: { x: 1 } },
      content: [{ type: "text", text: JSON.stringify([{ key: "FOO-1" }]) }],
    });

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "s",
            command: "node",
            toolCalls: [{ tool: "t", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("FOO-1");
  });

  it("uses first array field in parsed content object", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({ meta: "v", hits: [{ title: "H" }] }),
        },
      ],
    });

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "s",
            command: "node",
            toolCalls: [{ tool: "t", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("H");
  });

  it("returns a single raw-metadata ActivityItem when no array can be extracted from response", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({
      structuredContent: { meta: "v" },
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    });

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "slack",
            command: "node",
            toolCalls: [{ tool: "ping", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([
      {
        type: "custom_slack_ping",
        title: "slack: ping",
        metadata: {
          raw: {
            structuredContent: { meta: "v" },
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          },
        },
      },
    ]);
  });

  it("returns a single raw-metadata ActivityItem when response is not a record", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue("raw-string");

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "srv",
            command: "node",
            toolCalls: [{ tool: "tool", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([
      {
        type: "custom_srv_tool",
        title: "srv: tool",
        metadata: { raw: "raw-string" },
      },
    ]);
  });

  it("uses fallback title when no title field is present on a record", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(
      textContent({ items: [{ some: "data" }] }),
    );

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "srv",
            command: "node",
            toolCalls: [{ tool: "fetch", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([
      {
        type: "custom_srv_fetch",
        title: "srv: fetch",
        metadata: { some: "data" },
      },
    ]);
  });

  it("wraps non-object records in metadata.raw with fallback title", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(
      textContent({ items: ["str-record", 42] }),
    );

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "srv",
            command: "node",
            toolCalls: [{ tool: "fetch", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([
      {
        type: "custom_srv_fetch",
        title: "srv: fetch",
        metadata: { raw: "str-record" },
      },
      {
        type: "custom_srv_fetch",
        title: "srv: fetch",
        metadata: { raw: 42 },
      },
    ]);
  });

  it("picks title fields in priority order (title > name > summary > subject > key)", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(
      textContent({
        items: [
          { subject: "s-val", key: "k-val" },
          { key: "k-only" },
          { summary: "sum-val", subject: "s-val" },
        ],
      }),
    );

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "srv",
            command: "node",
            toolCalls: [{ tool: "tool", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result.map((r) => r.title)).toEqual(["s-val", "k-only", "sum-val"]);
  });

  it("skips content entries that are not text-typed objects", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({
      content: [
        null,
        { type: "image", data: "..." },
        { type: "text", text: 123 },
        { type: "text", text: "not-json{" },
        {
          type: "text",
          text: JSON.stringify([{ title: "found" }]),
        },
      ],
    });

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "srv",
            command: "node",
            toolCalls: [{ tool: "tool", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("found");
  });

  it("returns raw-metadata item when content parses to a primitive", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify("hello") }],
    });

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "srv",
            command: "node",
            toolCalls: [{ tool: "tool", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([
      {
        type: "custom_srv_tool",
        title: "srv: tool",
        metadata: {
          raw: {
            content: [{ type: "text", text: JSON.stringify("hello") }],
          },
        },
      },
    ]);
  });

  it("returns raw-metadata item when content array contains no usable entries", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockResolvedValue({
      content: "not an array",
    });

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "srv",
            command: "node",
            toolCalls: [{ tool: "tool", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([
      {
        type: "custom_srv_tool",
        title: "srv: tool",
        metadata: { raw: { content: "not an array" } },
      },
    ]);
  });
});

describe("collectCustomActivity — failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs error and continues when a server connection fails", async () => {
    const manager = makeManager();
    manager.connect
      .mockRejectedValueOnce(new Error("bad"))
      .mockResolvedValueOnce(FAKE_CLIENT);
    manager.callTool.mockResolvedValue(
      textContent({ items: [{ title: "T1" }] }),
    );

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "first",
            command: "node",
            toolCalls: [{ tool: "t", args: {} }],
          },
          {
            name: "second",
            command: "node",
            toolCalls: [{ tool: "u", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("T1");
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to connect to custom MCP server "first"',
      "bad",
    );
  });

  it("coerces non-Error connection failure reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue("raw-fail");

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "first",
            command: "node",
            toolCalls: [{ tool: "t", args: {} }],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to connect to custom MCP server "first"',
      "raw-fail",
    );
  });

  it("logs warning when a tool call throws and continues with remaining tool calls", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "bad") {
        return Promise.reject(new Error("tool broke"));
      }
      return Promise.resolve(textContent({ items: [{ title: "OK" }] }));
    });

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "srv",
            command: "node",
            toolCalls: [
              { tool: "bad", args: {} },
              { tool: "good", args: {} },
            ],
          },
        ],
      }),
    );

    const result = await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("OK");
    expect(logger.warn).toHaveBeenCalledWith(
      'Custom MCP tool "bad" on server "srv" failed',
      "tool broke",
    );
  });

  it("coerces non-Error tool call failure reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockRejectedValue("tool-str");

    const readFile = makeReadFile(
      JSON.stringify({
        servers: [
          {
            name: "srv",
            command: "node",
            toolCalls: [{ tool: "bad", args: {} }],
          },
        ],
      }),
    );

    await collectCustomActivity({
      manager: asManager(manager),
      window: WINDOW,
      username: USERNAME,
      configPath: CONFIG_PATH,
      readFile,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Custom MCP tool "bad" on server "srv" failed',
      "tool-str",
    );
  });
});
