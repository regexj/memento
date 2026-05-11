import { main, parseConfigPathArg, run } from "../collect.ts";
import { collect } from "../collector.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../logger.ts";
import { getCollectionWindow } from "../marker.ts";
import { createMcpClientManager } from "../mcp.ts";
import { loadSourceServerConfigs } from "../source-config.ts";
import type {
  CollectionWindow,
  Config,
  McpServerConfig,
  SourceResult,
} from "../types.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../collector.ts", () => ({
  collect: vi.fn(),
}));
vi.mock("../config.ts", () => ({
  loadConfig: vi.fn(),
}));
vi.mock("../marker.ts", () => ({
  getCollectionWindow: vi.fn(),
}));
vi.mock("../mcp.ts", () => ({
  createMcpClientManager: vi.fn(),
}));
vi.mock("../source-config.ts", () => ({
  loadSourceServerConfigs: vi.fn(),
}));
vi.mock("../logger.ts");

const mockedCollect = vi.mocked(collect);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedGetCollectionWindow = vi.mocked(getCollectionWindow);
const mockedCreateMcpClientManager = vi.mocked(createMcpClientManager);
const mockedLoadSourceServerConfigs = vi.mocked(loadSourceServerConfigs);

const WINDOW: CollectionWindow = {
  from: new Date("2025-06-09T00:00:00.000Z"),
  to: new Date("2025-06-16T00:00:00.000Z"),
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    llmProvider: "anthropic",
    llmModel: "claude-sonnet-4",
    llmApiKey: "sk-test",
    githubUsername: "alice",
    jiraUsername: "alice@example.com",
    jiraBaseUrl: "https://jira.example.com",
    confluenceBaseUrl: "https://confluence.example.com",
    enabledSources: ["github"],
    reviewCycleMonth: 1,
    diaryDir: "./diary",
    logFile: "./memento.log",
  };
  return { ...base, ...overrides };
}

function makeManager(): ReturnType<typeof createMcpClientManager> {
  return {
    connect: vi.fn(),
    callTool: vi.fn(),
    listTools: vi.fn().mockResolvedValue([]),
    disconnectAll: vi.fn().mockResolvedValue(undefined),
  };
}

const SERVER_CONFIGS = {
  github: {
    name: "github",
    command: "node",
    args: ["gh.js"],
    toolCalls: [],
  } as McpServerConfig,
};

describe("parseConfigPathArg", () => {
  it("returns undefined when no --mcp-config flag is present", () => {
    expect(parseConfigPathArg([])).toBeUndefined();
    expect(parseConfigPathArg(["--other", "value"])).toBeUndefined();
  });

  it("parses --mcp-config <path> form", () => {
    expect(parseConfigPathArg(["--mcp-config", "/etc/memento.mcp.json"])).toBe(
      "/etc/memento.mcp.json",
    );
  });

  it("parses --mcp-config=<path> form", () => {
    expect(parseConfigPathArg(["--mcp-config=/tmp/foo.json"])).toBe(
      "/tmp/foo.json",
    );
  });

  it("returns undefined when --mcp-config is the last arg with no value", () => {
    expect(parseConfigPathArg(["--mcp-config"])).toBeUndefined();
  });

  it("returns the first --mcp-config value when multiple are provided", () => {
    expect(
      parseConfigPathArg([
        "--mcp-config=/first.json",
        "--mcp-config=/second.json",
      ]),
    ).toBe("/first.json");
  });

  it("skips unrelated args before finding --mcp-config", () => {
    expect(
      parseConfigPathArg(["--verbose", "--mcp-config", "/x.json", "extra"]),
    ).toBe("/x.json");
  });

  it("accepts an empty string after --mcp-config=", () => {
    expect(parseConfigPathArg(["--mcp-config="])).toBe("");
  });
});

describe("main", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = process.argv;
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    mockedLoadConfig.mockReturnValue(makeConfig());
    mockedGetCollectionWindow.mockReturnValue(WINDOW);
    mockedLoadSourceServerConfigs.mockReturnValue(SERVER_CONFIGS);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    process.argv = originalArgv;
  });

  it("runs the collection pipeline and prints JSON output to stdout", async () => {
    const manager = makeManager();
    mockedCreateMcpClientManager.mockReturnValue(manager);

    const results: SourceResult[] = [
      { source: "github", data: [{ type: "pr_opened", title: "PR #1" }] },
    ];
    mockedCollect.mockResolvedValue({ results, failures: [] });

    process.argv = ["node", "collect.ts"];

    await main();

    expect(mockedLoadConfig).toHaveBeenCalledTimes(1);
    expect(mockedGetCollectionWindow).toHaveBeenCalledTimes(1);
    expect(mockedCreateMcpClientManager).toHaveBeenCalledTimes(1);
    expect(mockedLoadSourceServerConfigs).toHaveBeenCalledWith();
    expect(mockedCollect).toHaveBeenCalledWith({
      manager,
      window: WINDOW,
      config: expect.objectContaining({ enabledSources: ["github"] }),
      serverConfigs: SERVER_CONFIGS,
    });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const written = stdoutSpy.mock.calls[0]![0] as string;
    expect(written.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({
      window: {
        from: "2025-06-09T00:00:00.000Z",
        to: "2025-06-16T00:00:00.000Z",
      },
      enabledSources: ["github"],
      failures: [],
      results: [
        { source: "github", data: [{ type: "pr_opened", title: "PR #1" }] },
      ],
    });

    expect(logger.startStage).toHaveBeenCalledWith("collect-only");
    expect(logger.endStage).toHaveBeenCalledWith("collect-only");
    expect(manager.disconnectAll).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("passes the --mcp-config path through to loadSourceServerConfigs", async () => {
    const manager = makeManager();
    mockedCreateMcpClientManager.mockReturnValue(manager);
    mockedCollect.mockResolvedValue({ results: [], failures: [] });

    process.argv = ["node", "collect.ts", "--mcp-config=/custom/path.json"];

    await main();

    expect(mockedLoadSourceServerConfigs).toHaveBeenCalledWith(
      "/custom/path.json",
    );
  });

  it("logs a warning when the collector reports source failures", async () => {
    const manager = makeManager();
    mockedCreateMcpClientManager.mockReturnValue(manager);
    mockedCollect.mockResolvedValue({
      results: [],
      failures: ["github", "jira"],
    });

    process.argv = ["node", "collect.ts"];

    await main();

    expect(logger.warn).toHaveBeenCalledWith(
      "Collection completed with 2 source failure(s): github, jira",
    );
  });

  it("disconnects the manager and ends the stage even when collect rejects", async () => {
    const manager = makeManager();
    mockedCreateMcpClientManager.mockReturnValue(manager);
    mockedCollect.mockRejectedValue(new Error("pipeline exploded"));

    process.argv = ["node", "collect.ts"];

    await expect(main()).rejects.toThrow("pipeline exploded");

    expect(manager.disconnectAll).toHaveBeenCalledTimes(1);
    expect(logger.endStage).toHaveBeenCalledWith("collect-only");
  });
});

describe("run", () => {
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    mockedLoadConfig.mockReturnValue(makeConfig());
    mockedGetCollectionWindow.mockReturnValue(WINDOW);
    mockedLoadSourceServerConfigs.mockReturnValue(SERVER_CONFIGS);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("sets process.exitCode to 1 and logs an error when main rejects with an Error", async () => {
    const manager = makeManager();
    mockedCreateMcpClientManager.mockReturnValue(manager);
    mockedCollect.mockRejectedValue(new Error("boom"));

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      run();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Collection harness failed",
      "boom",
    );
  });

  it("coerces non-Error rejection reasons via String()", async () => {
    const manager = makeManager();
    mockedCreateMcpClientManager.mockReturnValue(manager);
    mockedCollect.mockRejectedValue("raw failure");

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      run();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Collection harness failed",
      "raw failure",
    );
  });

  it("leaves process.exitCode unchanged when main resolves", async () => {
    const manager = makeManager();
    mockedCreateMcpClientManager.mockReturnValue(manager);
    mockedCollect.mockResolvedValue({ results: [], failures: [] });

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      run();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(process.exitCode).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
