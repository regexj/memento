import { logger } from "../logger.ts";
import { loadSourceServerConfigs } from "../source-config.ts";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("../logger.ts");

const mockedReadFileSync = vi.mocked(readFileSync);

function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(
    `ENOENT: no such file or directory, open '${path}'`,
  ) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

describe("loadSourceServerConfigs — missing file", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  it("returns an empty object and warns when the default config file is missing", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw enoent("./memento.mcp.json");
    });

    const result = loadSourceServerConfigs();

    expect(result).toEqual({});
    expect(mockedReadFileSync).toHaveBeenCalledWith(
      "./memento.mcp.json",
      "utf-8",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'No MCP server config found at "./memento.mcp.json"',
      ),
    );
  });

  it("returns an empty object and warns when a custom config path is missing", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw enoent("/tmp/custom.json");
    });

    const result = loadSourceServerConfigs("/tmp/custom.json");

    expect(result).toEqual({});
    expect(mockedReadFileSync).toHaveBeenCalledWith(
      "/tmp/custom.json",
      "utf-8",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'No MCP server config found at "/tmp/custom.json"',
      ),
    );
  });

  it("exits when readFileSync fails for a non-ENOENT reason", () => {
    const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    mockedReadFileSync.mockImplementation(() => {
      throw err;
    });

    expect(() => loadSourceServerConfigs("./blocked.json")).toThrow(
      "process.exit called",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        'Error: failed to read "./blocked.json": EACCES: permission denied',
      ),
    );
  });

  it("exits when readFileSync throws a non-Error value", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw "raw string failure";
    });

    expect(() => loadSourceServerConfigs("./weird.json")).toThrow(
      "process.exit called",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        'Error: failed to read "./weird.json": raw string failure',
      ),
    );
  });
});

describe("loadSourceServerConfigs — JSON parse and top-level shape", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  it("exits when the file content is not valid JSON", () => {
    mockedReadFileSync.mockReturnValue("{ not json");

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        'Error: failed to parse "./memento.mcp.json" as JSON:',
      ),
    );
  });

  it("exits when the parsed JSON is not an object", () => {
    mockedReadFileSync.mockReturnValue("[1, 2, 3]");

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" must be a JSON object',
    );
  });

  it("exits when the parsed JSON is a primitive", () => {
    mockedReadFileSync.mockReturnValue('"just a string"');

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" must be a JSON object',
    );
  });

  it("exits when mcpServers is missing", () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ sources: {} }));

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" must contain an "mcpServers" object',
    );
  });

  it("exits when mcpServers is an array", () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: [] }));

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" must contain an "mcpServers" object',
    );
  });
});

describe("loadSourceServerConfigs — per-server entry validation", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  it("exits when a server entry is not an object", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ mcpServers: { github: "not-an-object" } }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"] must be an object',
    );
  });

  it("exits when command is not a string", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ mcpServers: { github: { command: 42 } } }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"].command must be a string',
    );
  });

  it("exits when url is not a string", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ mcpServers: { github: { url: 42 } } }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"].url must be a string',
    );
  });

  it("exits when neither command nor url is provided", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ mcpServers: { github: {} } }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"] must define either "command" or "url"',
    );
  });

  it("exits when both command and url are provided", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          github: { command: "node", url: "https://x.example/mcp" },
        },
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"] must define either "command" or "url", not both',
    );
  });

  it("exits when args is not an array of strings", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node", args: ["ok", 2] } },
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"].args must be an array of strings',
    );
  });

  it("exits when args is not an array at all", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node", args: "server.js" } },
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"].args must be an array of strings',
    );
  });

  it("exits when env contains non-string values", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node", env: { TOKEN: 42 } } },
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"].env must be an object of string values',
    );
  });

  it("exits when env is an array", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node", env: ["TOKEN=abc"] } },
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"].env must be an object of string values',
    );
  });

  it("exits when headers contains non-string values", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          github: {
            url: "https://x.example/mcp",
            headers: { Authorization: 123 },
          },
        },
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"].headers must be an object of string values',
    );
  });

  it("exits when headers is provided alongside a stdio command", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          github: {
            command: "node",
            headers: { Authorization: "Bearer x" },
          },
        },
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" mcpServers["github"].headers is only valid for URL-based (HTTP) servers',
    );
  });
});

describe("loadSourceServerConfigs — sources map validation", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });

  it("exits when sources is not an object", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node" } },
        sources: "github",
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" "sources" must be an object',
    );
  });

  it("exits when sources references an unknown built-in source", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node" } },
        sources: { slack: "github" },
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        'Error: "./memento.mcp.json" "sources" has unknown source "slack". Supported:',
      ),
    );
  });

  it("exits when a sources entry is not a string", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node" } },
        sources: { github: 42 },
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" "sources.github" must be a string',
    );
  });

  it("exits when a sources entry references an undefined mcpServers key", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node" } },
        sources: { jira: "atlassian" },
      }),
    );

    expect(() => loadSourceServerConfigs()).toThrow("process.exit called");
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: "./memento.mcp.json" "sources.jira" references "atlassian" which is not defined in "mcpServers"',
    );
  });
});

describe("loadSourceServerConfigs — successful resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves each built-in source to its same-named mcpServers key when sources is omitted", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          github: {
            command: "node",
            args: ["gh.js"],
            env: { TOKEN: "abc" },
          },
          jira: { url: "https://jira.example/mcp" },
        },
      }),
    );

    const result = loadSourceServerConfigs();

    expect(result.github).toEqual({
      name: "github",
      command: "node",
      args: ["gh.js"],
      env: { TOKEN: "abc" },
      toolCalls: [],
    });
    expect(result.jira).toEqual({
      name: "jira",
      url: "https://jira.example/mcp",
      toolCalls: [],
    });
    expect(result.confluence).toBeUndefined();
    expect(result.calendar).toBeUndefined();
    expect(result.drive).toBeUndefined();
  });

  it("supports the explicit sources map including aliased server keys", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          "gh-copilot": {
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer ghp_xxx" },
          },
          atlassian: {
            url: "https://mcp.atlassian.com/v1/sse",
            headers: { Authorization: "Bearer at_xxx" },
          },
          calendar: { url: "https://calendarmcp.googleapis.com/mcp/v1" },
          drive: { url: "https://drivemcp.googleapis.com/mcp/v1" },
        },
        sources: {
          github: "gh-copilot",
          jira: "atlassian",
          confluence: "atlassian",
          calendar: "calendar",
          drive: "drive",
        },
      }),
    );

    const result = loadSourceServerConfigs();

    expect(result.github).toEqual({
      name: "gh-copilot",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ghp_xxx" },
      toolCalls: [],
    });
    expect(result.jira?.name).toBe("atlassian");
    expect(result.confluence?.name).toBe("atlassian");
    expect(result.calendar?.name).toBe("calendar");
    expect(result.drive?.name).toBe("drive");
  });

  it("returns an empty object when mcpServers is empty and sources is omitted", () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: {} }));

    const result = loadSourceServerConfigs();

    expect(result).toEqual({});
  });

  it("accepts a custom config path", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node" } },
      }),
    );

    const result = loadSourceServerConfigs("/etc/memento/mcp.json");

    expect(mockedReadFileSync).toHaveBeenCalledWith(
      "/etc/memento/mcp.json",
      "utf-8",
    );
    expect(result.github?.name).toBe("github");
  });

  it("does not set optional fields on McpServerConfig when they are absent", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node" } },
      }),
    );

    const result = loadSourceServerConfigs();

    expect(result.github).toEqual({
      name: "github",
      command: "node",
      toolCalls: [],
    });
    expect(result.github).not.toHaveProperty("args");
    expect(result.github).not.toHaveProperty("env");
    expect(result.github).not.toHaveProperty("url");
    expect(result.github).not.toHaveProperty("headers");
  });

  it("treats an explicit empty sources map as 'no built-in sources configured'", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: { github: { command: "node" } },
        sources: {},
      }),
    );

    const result = loadSourceServerConfigs();

    // sources={} means "no explicit mapping", but fallback still resolves
    // github -> mcpServers.github because same-named keys are auto-wired.
    expect(result.github?.name).toBe("github");
  });
});
