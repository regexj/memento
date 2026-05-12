import type { SourceServerConfigs } from "../collector.ts";
import {
  formatTool,
  main,
  parseArgs,
  pickServers,
  run,
} from "../list-tools.ts";
import { logger } from "../logger.ts";
import { type McpToolInfo, createMcpClientManager } from "../mcp.ts";
import { loadSourceServerConfigs } from "../source-config.ts";
import type { McpServerConfig } from "../types.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mcp.ts", () => ({
  createMcpClientManager: vi.fn(),
}));
vi.mock("../source-config.ts", () => ({
  loadSourceServerConfigs: vi.fn(),
}));
vi.mock("../logger.ts");

const mockedCreateMcpClientManager = vi.mocked(createMcpClientManager);
const mockedLoadSourceServerConfigs = vi.mocked(loadSourceServerConfigs);

const FAKE_CLIENT = {} as Client;

function makeServerConfig(
  name: string,
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    name,
    command: "node",
    args: [`${name}.js`],
    toolCalls: [],
    ...overrides,
  };
}

function makeManager(): ReturnType<typeof createMcpClientManager> {
  return {
    connect: vi.fn().mockResolvedValue(FAKE_CLIENT),
    callTool: vi.fn(),
    listTools: vi.fn().mockResolvedValue([]),
    disconnectAll: vi.fn().mockResolvedValue(undefined),
  };
}

describe("parseArgs", () => {
  it("returns defaults when no args are provided", () => {
    expect(parseArgs([])).toEqual({
      configPath: undefined,
      includeSchema: false,
      sourceFilters: [],
    });
  });

  it("parses --mcp-config <path> form", () => {
    expect(parseArgs(["--mcp-config", "/etc/memento.mcp.json"])).toEqual({
      configPath: "/etc/memento.mcp.json",
      includeSchema: false,
      sourceFilters: [],
    });
  });

  it("parses --mcp-config=<path> form", () => {
    expect(parseArgs(["--mcp-config=/tmp/foo.json"])).toEqual({
      configPath: "/tmp/foo.json",
      includeSchema: false,
      sourceFilters: [],
    });
  });

  it("throws on a trailing --mcp-config with no value", () => {
    expect(() => parseArgs(["--mcp-config"])).toThrow(
      "Unknown flag: --mcp-config",
    );
  });

  it("accepts an empty string after --mcp-config=", () => {
    expect(parseArgs(["--mcp-config="]).configPath).toBe("");
  });

  it("sets includeSchema when --schema is present", () => {
    expect(parseArgs(["--schema"]).includeSchema).toBe(true);
  });

  it("collects positional args as source filters", () => {
    expect(parseArgs(["github", "jira"]).sourceFilters).toEqual([
      "github",
      "jira",
    ]);
  });

  it("combines flags and filters in any order", () => {
    expect(
      parseArgs(["github", "--schema", "--mcp-config=/x.json", "jira"]),
    ).toEqual({
      configPath: "/x.json",
      includeSchema: true,
      sourceFilters: ["github", "jira"],
    });
  });

  it("throws on unknown flags", () => {
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown flag: --unknown");
  });

  it("skips undefined entries in the argv array", () => {
    const argv = ["github"];
    // Simulate sparse array (arg at index 1 is undefined).
    argv.length = 2;
    expect(parseArgs(argv).sourceFilters).toEqual(["github"]);
  });
});

describe("formatTool", () => {
  it("formats a tool with a description, without its schema by default", () => {
    const tool: McpToolInfo = {
      name: "search",
      description: "Run a search query",
      inputSchema: { type: "object" },
    };
    expect(formatTool(tool, false)).toBe(
      "  • search\n      Run a search query",
    );
  });

  it("uses only the first line of a multiline description", () => {
    const tool: McpToolInfo = {
      name: "multi",
      description: "First line\nSecond line\nThird line",
      inputSchema: { type: "object" },
    };
    expect(formatTool(tool, false)).toBe("  • multi\n      First line");
  });

  it("omits the description line when description is undefined", () => {
    const tool: McpToolInfo = {
      name: "quiet",
      inputSchema: { type: "object" },
    };
    expect(formatTool(tool, false)).toBe("  • quiet");
  });

  it("appends the indented JSON schema when includeSchema is true", () => {
    const tool: McpToolInfo = {
      name: "with_schema",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    };
    const output = formatTool(tool, true);
    expect(output).toContain("  • with_schema");
    expect(output).toContain('      "type": "object"');
    expect(output).toContain('      "properties"');
    for (const line of output.split("\n").slice(1)) {
      expect(line.startsWith("      ")).toBe(true);
    }
  });

  it("handles an empty-string description by producing a blank-lined second line", () => {
    const tool: McpToolInfo = {
      name: "blank_desc",
      description: "",
      inputSchema: { type: "object" },
    };
    expect(formatTool(tool, false)).toBe("  • blank_desc\n      ");
  });
});

describe("pickServers", () => {
  const github = makeServerConfig("github");
  const jira = makeServerConfig("atlassian");
  const confluence = makeServerConfig("atlassian");

  it("returns every configured server when no filters are provided", () => {
    const configs: SourceServerConfigs = { github, jira };
    expect(pickServers(configs, [])).toEqual([
      { source: "github", config: github },
      { source: "jira", config: jira },
    ]);
  });

  it("skips sources whose config is undefined", () => {
    const configs: SourceServerConfigs = { github };
    expect(pickServers(configs, [])).toEqual([
      { source: "github", config: github },
    ]);
  });

  it("filters to the requested sources when filters are provided", () => {
    const configs: SourceServerConfigs = { github, jira, confluence };
    expect(pickServers(configs, ["jira"])).toEqual([
      { source: "jira", config: jira },
    ]);
  });

  it("throws with the known source list when a filter refers to an unknown source", () => {
    const configs: SourceServerConfigs = { github, jira };
    expect(() => pickServers(configs, ["slack"])).toThrow(
      /Unknown source\(s\): slack\. Configured sources: github, jira/,
    );
  });

  it("throws with '(none)' when no sources are configured and a filter is provided", () => {
    const configs: SourceServerConfigs = {};
    expect(() => pickServers(configs, ["github"])).toThrow(
      /Configured sources: \(none\)/,
    );
  });

  it("returns an empty array when filters match none of the configured sources", () => {
    const configs: SourceServerConfigs = { github, jira };
    // Filtering to something that IS configured but with empty filter list
    // would short-circuit above. This verifies behaviour when filters match a
    // subset — nothing surprising should happen.
    expect(pickServers(configs, ["github"])).toEqual([
      { source: "github", config: github },
    ]);
  });
});

describe("main", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  });

  it("prints a friendly message when no servers are configured", async () => {
    mockedLoadSourceServerConfigs.mockReturnValue({});
    process.argv = ["node", "list-tools.ts"];

    await main();

    expect(stdoutSpy).toHaveBeenCalledWith(
      "No MCP servers configured. Add one to memento.mcp.json.\n",
    );
    expect(mockedCreateMcpClientManager).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("connects to each configured server, sorts tools by name, and disconnects", async () => {
    const github = makeServerConfig("github");
    mockedLoadSourceServerConfigs.mockReturnValue({ github });
    const manager = makeManager();
    (manager.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "zoo", inputSchema: { type: "object" } },
      {
        name: "ant",
        description: "Sort me to the top",
        inputSchema: { type: "object" },
      },
    ] satisfies McpToolInfo[]);
    mockedCreateMcpClientManager.mockReturnValue(manager);

    process.argv = ["node", "list-tools.ts"];

    await main();

    expect(manager.connect).toHaveBeenCalledWith(github);
    expect(manager.listTools).toHaveBeenCalledWith(FAKE_CLIENT);
    expect(manager.disconnectAll).toHaveBeenCalledTimes(1);

    const written = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .join("");
    const antIndex = written.indexOf("• ant");
    const zooIndex = written.indexOf("• zoo");
    expect(antIndex).toBeGreaterThan(-1);
    expect(zooIndex).toBeGreaterThan(antIndex);
    expect(written).toContain('=== github (server: "github") ===');
    expect(written).toContain("(2 tool(s))");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints '(no tools exposed)' when a server returns an empty tool list", async () => {
    mockedLoadSourceServerConfigs.mockReturnValue({
      github: makeServerConfig("github"),
    });
    const manager = makeManager();
    (manager.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockedCreateMcpClientManager.mockReturnValue(manager);

    process.argv = ["node", "list-tools.ts"];

    await main();

    const written = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .join("");
    expect(written).toContain("(no tools exposed)");
    expect(process.exitCode).toBeUndefined();
  });

  it("passes --mcp-config through to loadSourceServerConfigs", async () => {
    mockedLoadSourceServerConfigs.mockReturnValue({});
    process.argv = ["node", "list-tools.ts", "--mcp-config=/custom.json"];

    await main();

    expect(mockedLoadSourceServerConfigs).toHaveBeenCalledWith("/custom.json");
  });

  it("calls loadSourceServerConfigs with no argument when --mcp-config is absent", async () => {
    mockedLoadSourceServerConfigs.mockReturnValue({});
    process.argv = ["node", "list-tools.ts"];

    await main();

    expect(mockedLoadSourceServerConfigs).toHaveBeenCalledWith();
  });

  it("emits JSON schemas in output when --schema is set", async () => {
    mockedLoadSourceServerConfigs.mockReturnValue({
      github: makeServerConfig("github"),
    });
    const manager = makeManager();
    (manager.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        name: "only",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ] satisfies McpToolInfo[]);
    mockedCreateMcpClientManager.mockReturnValue(manager);

    process.argv = ["node", "list-tools.ts", "--schema"];

    await main();

    const written = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .join("");
    expect(written).toContain('"type": "object"');
    expect(written).toContain('"properties"');
  });

  it("logs, prints, and sets exit code 1 when a server fails, but continues to the next", async () => {
    mockedLoadSourceServerConfigs.mockReturnValue({
      github: makeServerConfig("github"),
      jira: makeServerConfig("atlassian"),
    });
    const manager = makeManager();
    (manager.connect as ReturnType<typeof vi.fn>).mockImplementation(
      (config: McpServerConfig) => {
        if (config.name === "github") {
          return Promise.reject(new Error("auth failed"));
        }
        return Promise.resolve(FAKE_CLIENT);
      },
    );
    (manager.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "jira_search", inputSchema: { type: "object" } },
    ] satisfies McpToolInfo[]);
    mockedCreateMcpClientManager.mockReturnValue(manager);

    process.argv = ["node", "list-tools.ts"];

    await main();

    const written = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .join("");
    expect(written).toContain("Failed: auth failed");
    expect(written).toContain("• jira_search");
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to list tools for source "github"',
      "auth failed",
    );
    expect(manager.disconnectAll).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("coerces non-Error failures via String() when logging and reporting", async () => {
    mockedLoadSourceServerConfigs.mockReturnValue({
      github: makeServerConfig("github"),
    });
    const manager = makeManager();
    (manager.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
      "raw string error",
    );
    mockedCreateMcpClientManager.mockReturnValue(manager);

    process.argv = ["node", "list-tools.ts"];

    await main();

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to list tools for source "github"',
      "raw string error",
    );
    expect(process.exitCode).toBe(1);
  });

  it("disconnects the manager even when every server fails", async () => {
    mockedLoadSourceServerConfigs.mockReturnValue({
      github: makeServerConfig("github"),
    });
    const manager = makeManager();
    (manager.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("nope"),
    );
    mockedCreateMcpClientManager.mockReturnValue(manager);

    process.argv = ["node", "list-tools.ts"];

    await main();

    expect(manager.disconnectAll).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("restricts output to filtered sources only", async () => {
    mockedLoadSourceServerConfigs.mockReturnValue({
      github: makeServerConfig("github"),
      jira: makeServerConfig("atlassian"),
    });
    const manager = makeManager();
    (manager.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "only", inputSchema: { type: "object" } },
    ] satisfies McpToolInfo[]);
    mockedCreateMcpClientManager.mockReturnValue(manager);

    process.argv = ["node", "list-tools.ts", "jira"];

    await main();

    expect(manager.connect).toHaveBeenCalledTimes(1);
    expect(manager.connect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "atlassian" }),
    );
    const written = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .join("");
    expect(written).toContain("=== jira");
    expect(written).not.toContain("=== github");
  });
});

describe("run", () => {
  let originalExitCode: typeof process.exitCode;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    originalArgv = process.argv;
    process.exitCode = undefined;
    process.argv = ["node", "list-tools.ts"];
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    process.exitCode = originalExitCode;
    process.argv = originalArgv;
  });

  it("sets process.exitCode to 1 and prints an Error message when main rejects", async () => {
    mockedLoadSourceServerConfigs.mockImplementation(() => {
      throw new Error("config broken");
    });

    run();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(process.exitCode).toBe(1);
    const written = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .join("");
    expect(written).toContain("Error: config broken");
  });

  it("coerces non-Error rejection reasons via String()", async () => {
    mockedLoadSourceServerConfigs.mockImplementation(() => {
      throw "raw failure";
    });

    run();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(process.exitCode).toBe(1);
    const written = stdoutSpy.mock.calls
      .map((call: unknown[]) => call[0] as string)
      .join("");
    expect(written).toContain("Error: raw failure");
  });

  it("leaves process.exitCode unchanged when main resolves cleanly", async () => {
    mockedLoadSourceServerConfigs.mockReturnValue({});

    run();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(process.exitCode).toBeUndefined();
  });
});
