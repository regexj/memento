import { logger } from "../../logger.ts";
import type { McpClientManager } from "../../mcp.ts";
import type { CollectionWindow, McpServerConfig } from "../../types.ts";
import { collectDriveActivity } from "../drive.ts";
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

const EXPECTED_QUERY =
  "modifiedTime >= '2025-06-01T00:00:00.000Z' and " +
  "modifiedTime <= '2025-06-08T00:00:00.000Z' and " +
  "('me' in owners or 'me' in writers)";

const SERVER_CONFIG: McpServerConfig = {
  name: "drive",
  url: "https://drivemcp.googleapis.com/mcp/v1",
  toolCalls: [],
};

const FAKE_CLIENT = { id: "client" } as unknown as Client;

describe("collectDriveActivity — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls search_drive_files with a date-bounded ownership query and shapes authored documents", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "search_drive_files") {
        return Promise.resolve(
          textContent("files", [
            {
              id: "doc-1",
              name: "Design Doc",
              webViewLink: "https://docs.google.com/d/doc-1",
              modifiedTime: "2025-06-05T12:00:00.000Z",
            },
            {
              id: "doc-2",
              name: "Retro Notes",
              webViewLink: "https://docs.google.com/d/doc-2",
              modifiedTime: "2025-06-07T09:30:00.000Z",
            },
          ]),
        );
      }
      return Promise.resolve({});
    });

    const result = await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(manager.connect).toHaveBeenCalledWith(SERVER_CONFIG);
    expect(manager.callTool).toHaveBeenCalledTimes(1);
    expect(manager.callTool).toHaveBeenCalledWith(
      FAKE_CLIENT,
      "search_drive_files",
      {
        q: EXPECTED_QUERY,
      },
    );

    expect(result).toEqual([
      {
        type: "drive_document_authored",
        title: "Design Doc",
        url: "https://docs.google.com/d/doc-1",
        lastModified: "2025-06-05T12:00:00.000Z",
        fileId: "doc-1",
      },
      {
        type: "drive_document_authored",
        title: "Retro Notes",
        url: "https://docs.google.com/d/doc-2",
        lastModified: "2025-06-07T09:30:00.000Z",
        fileId: "doc-2",
      },
    ]);

    expect(logger.info).toHaveBeenCalledWith(
      "Collected 2 Drive activity item(s)",
    );
  });

  it("fetches file content for supplied attachment fileIds and emits drive_meeting_notes items", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "search_drive_files") {
          return Promise.resolve(textContent("files", []));
        }
        if (toolName === "get_drive_file_content") {
          const fileId = args["fileId"];
          if (fileId === "file-notes-1") {
            return Promise.resolve(
              textObject("content", { content: "Meeting notes body" }),
            );
          }
          if (fileId === "file-transcript-1") {
            return Promise.resolve(
              textObject("content", { content: "Transcript body" }),
            );
          }
        }
        return Promise.resolve({});
      },
    );

    const result = await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      attachmentFileIds: ["file-notes-1", "file-transcript-1"],
    });

    const readCalls = manager.callTool.mock.calls.filter(
      (c) => c[1] === "get_drive_file_content",
    );
    expect(readCalls).toEqual([
      [FAKE_CLIENT, "get_drive_file_content", { fileId: "file-notes-1" }],
      [FAKE_CLIENT, "get_drive_file_content", { fileId: "file-transcript-1" }],
    ]);

    expect(result).toEqual([
      {
        type: "drive_meeting_notes",
        title: "file-notes-1",
        fileId: "file-notes-1",
        metadata: { content: "Meeting notes body" },
      },
      {
        type: "drive_meeting_notes",
        title: "file-transcript-1",
        fileId: "file-transcript-1",
        metadata: { content: "Transcript body" },
      },
    ]);

    expect(logger.info).toHaveBeenCalledWith(
      "Collected 2 Drive activity item(s)",
    );
  });

  it("deduplicates fileIds across search_drive_files and attachments — meeting notes replaces authored entry", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "search_drive_files") {
          return Promise.resolve(
            textContent("files", [
              {
                id: "shared-file",
                name: "Shared Notes",
                webViewLink: "https://docs.google.com/d/shared-file",
                modifiedTime: "2025-06-06T08:00:00.000Z",
              },
              {
                id: "other-file",
                name: "Other",
                webViewLink: "https://docs.google.com/d/other-file",
                modifiedTime: "2025-06-04T10:00:00.000Z",
              },
            ]),
          );
        }
        if (
          toolName === "get_drive_file_content" &&
          args["fileId"] === "shared-file"
        ) {
          return Promise.resolve(
            textObject("content", { content: "Meeting body" }),
          );
        }
        return Promise.resolve({});
      },
    );

    const result = await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      attachmentFileIds: ["shared-file"],
    });

    // The shared-file should be replaced by the meeting notes version
    expect(result).toHaveLength(2);
    expect(result).toEqual([
      {
        type: "drive_meeting_notes",
        title: "Shared Notes",
        url: "https://docs.google.com/d/shared-file",
        fileId: "shared-file",
        metadata: { content: "Meeting body" },
      },
      {
        type: "drive_document_authored",
        title: "Other",
        url: "https://docs.google.com/d/other-file",
        lastModified: "2025-06-04T10:00:00.000Z",
        fileId: "other-file",
      },
    ]);
  });

  it("does not call get_drive_file_content when attachmentFileIds is omitted", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "search_drive_files") {
        return Promise.resolve(textContent("files", []));
      }
      return Promise.resolve({});
    });

    await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    const toolNames = manager.callTool.mock.calls.map((c) => c[1]);
    expect(toolNames).not.toContain("get_drive_file_content");
  });

  it("does not call get_drive_file_content when attachmentFileIds is an empty array", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "search_drive_files") {
        return Promise.resolve(textContent("files", []));
      }
      return Promise.resolve({});
    });

    await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      attachmentFileIds: [],
    });

    const toolNames = manager.callTool.mock.calls.map((c) => c[1]);
    expect(toolNames).not.toContain("get_drive_file_content");
  });
});

describe("collectDriveActivity — connection failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] and logs error when manager.connect throws an Error", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue(new Error("unreachable"));

    const result = await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      attachmentFileIds: ["file-1"],
    });

    expect(result).toEqual([]);
    expect(manager.callTool).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to Drive MCP server",
      "unreachable",
    );
  });

  it("coerces non-Error rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockRejectedValue("raw string");

    const result = await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to connect to Drive MCP server",
      "raw string",
    );
  });
});

describe("collectDriveActivity — tool call failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs warning when search_drive_files throws and still processes attachment fileIds", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "search_drive_files") {
        return Promise.reject(new Error("search broke"));
      }
      if (toolName === "get_drive_file_content") {
        return Promise.resolve(
          textObject("content", { content: "transcript" }),
        );
      }
      return Promise.resolve({});
    });

    const result = await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      attachmentFileIds: ["file-xyz"],
    });

    expect(result).toEqual([
      {
        type: "drive_meeting_notes",
        title: "file-xyz",
        fileId: "file-xyz",
        metadata: { content: "transcript" },
      },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Drive tool "search_drive_files" failed',
      "search broke",
    );
  });

  it("coerces non-Error search_drive_files rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "search_drive_files") {
        return Promise.reject("bad search");
      }
      return Promise.resolve({});
    });

    await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Drive tool "search_drive_files" failed',
      "bad search",
    );
  });

  it("logs warning when get_drive_file_content throws for one fileId and continues with others", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation(
      (_client: Client, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "search_drive_files") {
          return Promise.resolve(textContent("files", []));
        }
        if (toolName === "get_drive_file_content") {
          if (args["fileId"] === "broken") {
            return Promise.reject(new Error("fetch broke"));
          }
          return Promise.resolve(textObject("content", { content: "ok body" }));
        }
        return Promise.resolve({});
      },
    );

    const result = await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      attachmentFileIds: ["broken", "good"],
    });

    expect(result).toEqual([
      {
        type: "drive_meeting_notes",
        title: "good",
        fileId: "good",
        metadata: { content: "ok body" },
      },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Drive tool "get_drive_file_content" failed for fileId "broken"',
      "fetch broke",
    );
  });

  it("coerces non-Error get_drive_file_content rejection reasons via String()", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "search_drive_files") {
        return Promise.resolve(textContent("files", []));
      }
      if (toolName === "get_drive_file_content") {
        return Promise.reject("read broke");
      }
      return Promise.resolve({});
    });

    await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      attachmentFileIds: ["file-1"],
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Drive tool "get_drive_file_content" failed for fileId "file-1"',
      "read broke",
    );
  });
});

describe("collectDriveActivity — search_drive_files response parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSearchFilesResponse(response: unknown): Promise<number> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "search_drive_files") {
        return Promise.resolve(response);
      }
      return Promise.resolve({});
    });

    const result = await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    return result.filter((item) => item.type === "drive_document_authored")
      .length;
  }

  it("uses structuredContent.files when present", async () => {
    const count = await runSearchFilesResponse({
      structuredContent: {
        files: [
          {
            id: "s1",
            name: "Structured",
            webViewLink: "https://x.example/s1",
            modifiedTime: "2025-06-05T00:00:00.000Z",
          },
        ],
      },
    });
    expect(count).toBe(1);
  });

  it("falls through to content when structuredContent has no files array", async () => {
    const count = await runSearchFilesResponse({
      structuredContent: { other: "value" },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            files: [{ id: "c1", name: "Content file" }],
          }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("accepts bare array from JSON.parse", async () => {
    const count = await runSearchFilesResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify([{ id: "b1", name: "Bare file" }]),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("returns 0 when response is null", async () => {
    const count = await runSearchFilesResponse(null);
    expect(count).toBe(0);
  });

  it("returns 0 when response is a string", async () => {
    const count = await runSearchFilesResponse("not an object");
    expect(count).toBe(0);
  });

  it("returns 0 when response has neither content nor structuredContent", async () => {
    const count = await runSearchFilesResponse({ other: "field" });
    expect(count).toBe(0);
  });

  it("returns 0 when content is not an array", async () => {
    const count = await runSearchFilesResponse({ content: "not an array" });
    expect(count).toBe(0);
  });

  it("skips content entries with non-text type", async () => {
    const count = await runSearchFilesResponse({
      content: [
        { type: "image", data: "..." },
        {
          type: "text",
          text: JSON.stringify({
            files: [{ id: "after-image", name: "After image" }],
          }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("skips content entries where text is not a string", async () => {
    const count = await runSearchFilesResponse({
      content: [
        { type: "text", text: 123 },
        {
          type: "text",
          text: JSON.stringify({
            files: [{ id: "valid", name: "Valid" }],
          }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("returns 0 when content text is invalid JSON", async () => {
    const count = await runSearchFilesResponse({
      content: [{ type: "text", text: "not json{" }],
    });
    expect(count).toBe(0);
  });

  it("returns 0 when parsed content is a primitive", async () => {
    const count = await runSearchFilesResponse({
      content: [{ type: "text", text: JSON.stringify("hello") }],
    });
    expect(count).toBe(0);
  });

  it("skips null entries in content array", async () => {
    const count = await runSearchFilesResponse({
      content: [
        null,
        {
          type: "text",
          text: JSON.stringify({
            files: [{ id: "after-null", name: "After null" }],
          }),
        },
      ],
    });
    expect(count).toBe(1);
  });

  it("returns 0 when content is present but contains no parseable text", async () => {
    const count = await runSearchFilesResponse({
      content: [null, { type: "image" }, { type: "text", text: 5 }],
    });
    expect(count).toBe(0);
  });

  it("skips file entries that are not objects", async () => {
    const count = await runSearchFilesResponse(
      textContent("files", [
        "string",
        42,
        null,
        { id: "real", name: "Real file" },
      ]),
    );
    expect(count).toBe(1);
  });

  it("drops file entries missing an id", async () => {
    const count = await runSearchFilesResponse(
      textContent("files", [{ name: "No id" }, { id: "ok", name: "Has both" }]),
    );
    expect(count).toBe(1);
  });

  it("drops file entries missing a name", async () => {
    const count = await runSearchFilesResponse(
      textContent("files", [{ id: "no-name" }, { id: "ok", name: "Has both" }]),
    );
    expect(count).toBe(1);
  });

  it("leaves url and lastModified undefined when those fields are not strings", async () => {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "search_drive_files") {
        return Promise.resolve(
          textContent("files", [
            {
              id: "doc-x",
              name: "Doc X",
              webViewLink: 42,
              modifiedTime: null,
            },
          ]),
        );
      }
      return Promise.resolve({});
    });

    const result = await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
    });

    expect(result).toEqual([
      {
        type: "drive_document_authored",
        title: "Doc X",
        fileId: "doc-x",
      },
    ]);
  });
});

describe("collectDriveActivity — get_drive_file_content response parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runReadFileResponse(
    response: unknown,
  ): Promise<{ type: string; metadata?: Record<string, unknown> } | undefined> {
    const manager = makeManager();
    manager.connect.mockResolvedValue(FAKE_CLIENT);
    manager.callTool.mockImplementation((_client: Client, toolName: string) => {
      if (toolName === "search_drive_files") {
        return Promise.resolve(textContent("files", []));
      }
      if (toolName === "get_drive_file_content") {
        return Promise.resolve(response);
      }
      return Promise.resolve({});
    });

    const result = await collectDriveActivity({
      manager: asManager(manager),
      serverConfig: SERVER_CONFIG,
      window: WINDOW,
      attachmentFileIds: ["file-a"],
    });

    const first = result[0];
    if (first === undefined) {
      return undefined;
    }
    const out: { type: string; metadata?: Record<string, unknown> } = {
      type: first.type,
    };
    if (first.metadata !== undefined) {
      out.metadata = first.metadata;
    }
    return out;
  }

  it("uses structuredContent.content when the structured key wraps the payload", async () => {
    const out = await runReadFileResponse({
      structuredContent: { content: { content: "Body A" } },
    });
    expect(out).toEqual({
      type: "drive_meeting_notes",
      metadata: { content: "Body A" },
    });
  });

  it("treats structuredContent itself as the payload when no nested content key", async () => {
    const out = await runReadFileResponse({
      structuredContent: { content: "Body flat" },
    });
    expect(out).toEqual({
      type: "drive_meeting_notes",
      metadata: { content: "Body flat" },
    });
  });

  it("falls through to content.content when structuredContent is absent", async () => {
    const out = await runReadFileResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({ content: { content: "Body C" } }),
        },
      ],
    });
    expect(out).toEqual({
      type: "drive_meeting_notes",
      metadata: { content: "Body C" },
    });
  });

  it("accepts flat parsed content object as the payload", async () => {
    const out = await runReadFileResponse({
      content: [
        {
          type: "text",
          text: JSON.stringify({ content: "Flat body" }),
        },
      ],
    });
    expect(out).toEqual({
      type: "drive_meeting_notes",
      metadata: { content: "Flat body" },
    });
  });

  it("skips emitting when content is missing from response", async () => {
    const out = await runReadFileResponse({ structuredContent: { other: 1 } });
    expect(out).toBeUndefined();
  });

  it("skips emitting when content is not a string", async () => {
    const out = await runReadFileResponse({
      structuredContent: { content: 42 },
    });
    expect(out).toBeUndefined();
  });

  it("skips emitting when response is null", async () => {
    const out = await runReadFileResponse(null);
    expect(out).toBeUndefined();
  });

  it("skips emitting when response is a string", async () => {
    const out = await runReadFileResponse("bad");
    expect(out).toBeUndefined();
  });

  it("skips emitting when content is not an array", async () => {
    const out = await runReadFileResponse({ content: "bad" });
    expect(out).toBeUndefined();
  });

  it("skips emitting when content has no usable entries", async () => {
    const out = await runReadFileResponse({
      content: [null, { type: "image" }, { type: "text", text: 5 }],
    });
    expect(out).toBeUndefined();
  });

  it("skips emitting when parsed content is not an object", async () => {
    const out = await runReadFileResponse({
      content: [{ type: "text", text: JSON.stringify("hello") }],
    });
    expect(out).toBeUndefined();
  });

  it("skips emitting when content text is invalid JSON", async () => {
    const out = await runReadFileResponse({
      content: [{ type: "text", text: "not json{" }],
    });
    expect(out).toBeUndefined();
  });

  it("skips null entries in content array before finding a valid payload", async () => {
    const out = await runReadFileResponse({
      content: [
        null,
        {
          type: "text",
          text: JSON.stringify({ content: "After null" }),
        },
      ],
    });
    expect(out).toEqual({
      type: "drive_meeting_notes",
      metadata: { content: "After null" },
    });
  });
});
