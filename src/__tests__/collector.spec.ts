import { collect } from "../collector.ts";
import type {
  CollectorDependencies,
  SourceServerConfigs,
} from "../collector.ts";
import { logger } from "../logger.ts";
import type { McpClientManager } from "../mcp.ts";
import type {
  ActivityItem,
  CalendarCollectionResult,
  CollectionWindow,
  Config,
  McpServerConfig,
} from "../types.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.ts");

const WINDOW: CollectionWindow = {
  from: new Date("2025-06-01T00:00:00.000Z"),
  to: new Date("2025-06-08T00:00:00.000Z"),
};

const MANAGER: McpClientManager = {
  connect: vi.fn(),
  callTool: vi.fn(),
  listTools: vi.fn(),
  disconnectAll: vi.fn(),
};

function makeServerConfig(name: string): McpServerConfig {
  return { name, command: "node", args: [`${name}.js`], toolCalls: [] };
}

const SERVER_CONFIGS: Required<SourceServerConfigs> = {
  github: makeServerConfig("github"),
  jira: makeServerConfig("jira"),
  confluence: makeServerConfig("confluence"),
  calendar: {
    name: "calendar",
    url: "https://calendar.example/mcp",
    toolCalls: [],
  },
  drive: { name: "drive", url: "https://drive.example/mcp", toolCalls: [] },
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
    enabledSources: [],
    reviewCycleMonth: 1,
    diaryDir: "./diary",
    logFile: "./memento.log",
  };
  return { ...base, ...overrides };
}

function githubItem(): ActivityItem {
  return { type: "pr_opened", title: "PR" };
}

function jiraItem(): ActivityItem {
  return { type: "ticket_completed", title: "TICKET" };
}

function confluenceItem(): ActivityItem {
  return { type: "page_created", title: "Page" };
}

function calendarItem(): ActivityItem {
  return { type: "calendar_event", title: "Meeting" };
}

function driveItem(): ActivityItem {
  return { type: "drive_document_authored", title: "Doc" };
}

function customItem(): ActivityItem {
  return { type: "custom_slack_search", title: "Message" };
}

function makeDependencies(
  overrides: Partial<CollectorDependencies> = {},
): CollectorDependencies {
  const base: CollectorDependencies = {
    collectGithub: vi.fn(async () => [githubItem()]),
    collectJira: vi.fn(async () => [jiraItem()]),
    collectConfluence: vi.fn(async () => [confluenceItem()]),
    collectCalendar: vi.fn(
      async (): Promise<CalendarCollectionResult> => ({
        items: [calendarItem()],
        attachmentFileIds: ["file-1"],
      }),
    ),
    collectDrive: vi.fn(async () => [driveItem()]),
    collectCustom: vi.fn(async () => [customItem()]),
  };
  return { ...base, ...overrides };
}

describe("collect — enabled sources selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs only github and custom when only github is enabled", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ enabledSources: ["github"] });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(dependencies.collectGithub).toHaveBeenCalledTimes(1);
    expect(dependencies.collectJira).not.toHaveBeenCalled();
    expect(dependencies.collectConfluence).not.toHaveBeenCalled();
    expect(dependencies.collectCalendar).not.toHaveBeenCalled();
    expect(dependencies.collectDrive).not.toHaveBeenCalled();
    expect(dependencies.collectCustom).toHaveBeenCalledTimes(1);
    expect(result.failures).toEqual([]);
    expect(result.results.map((r) => r.source)).toEqual(["github", "custom"]);
  });

  it("runs all sources and passes Calendar attachmentFileIds to Drive", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({
      enabledSources: ["github", "jira", "confluence", "calendar", "drive"],
    });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(dependencies.collectGithub).toHaveBeenCalledWith({
      manager: MANAGER,
      serverConfig: SERVER_CONFIGS.github,
      window: WINDOW,
      username: "alice",
    });
    expect(dependencies.collectJira).toHaveBeenCalledWith({
      manager: MANAGER,
      serverConfig: SERVER_CONFIGS.jira,
      window: WINDOW,
      username: "alice@example.com",
      baseUrl: "https://jira.example.com",
    });
    expect(dependencies.collectConfluence).toHaveBeenCalledWith({
      manager: MANAGER,
      serverConfig: SERVER_CONFIGS.confluence,
      window: WINDOW,
      baseUrl: "https://confluence.example.com",
    });
    expect(dependencies.collectCalendar).toHaveBeenCalledWith({
      manager: MANAGER,
      serverConfig: SERVER_CONFIGS.calendar,
      window: WINDOW,
    });
    expect(dependencies.collectDrive).toHaveBeenCalledWith({
      manager: MANAGER,
      serverConfig: SERVER_CONFIGS.drive,
      window: WINDOW,
      attachmentFileIds: ["file-1"],
    });
    expect(dependencies.collectCustom).toHaveBeenCalledTimes(1);

    expect(result.results.map((r) => r.source)).toEqual([
      "github",
      "jira",
      "confluence",
      "calendar",
      "custom",
      "drive",
    ]);
    expect(result.failures).toEqual([]);
  });

  it("passes the custom configPath and default username when provided", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ enabledSources: ["github"] });

    await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      customConfigPath: "./custom.json",
      dependencies,
    });

    expect(dependencies.collectCustom).toHaveBeenCalledWith({
      manager: MANAGER,
      window: WINDOW,
      username: "alice",
      configPath: "./custom.json",
    });
  });

  it("falls back to jiraUsername for custom source when githubUsername is missing", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({
      enabledSources: [],
      githubUsername: undefined,
    });

    await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(dependencies.collectCustom).toHaveBeenCalledWith({
      manager: MANAGER,
      window: WINDOW,
      username: "alice@example.com",
    });
  });

  it("uses empty username for custom source when neither github nor jira username is set", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({
      enabledSources: [],
      githubUsername: undefined,
      jiraUsername: undefined,
    });

    await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(dependencies.collectCustom).toHaveBeenCalledWith({
      manager: MANAGER,
      window: WINDOW,
      username: "",
    });
  });

  it("uses built-in defaults when no dependencies override is provided", async () => {
    const config = makeConfig({ enabledSources: [] });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: {},
      customConfigPath: "./does-not-exist.json",
    });

    // The default collectCustom reads a missing file → [] and does not throw.
    expect(result.failures).toEqual([]);
    expect(result.results).toEqual([{ source: "custom", data: [] }]);
  });
});

describe("collect — graceful degradation (Property 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns N-K successful results and K failure entries", async () => {
    const dependencies = makeDependencies({
      collectGithub: vi.fn(async () => {
        throw new Error("github down");
      }),
      collectConfluence: vi.fn(async () => {
        throw new Error("confluence down");
      }),
    });
    const config = makeConfig({
      enabledSources: ["github", "jira", "confluence"],
    });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    // Phase 1 runs: github, jira, confluence, custom → 4 tasks, 2 failures → 2 successes
    expect(result.results.map((r) => r.source)).toEqual(["jira", "custom"]);
    expect(result.failures).toEqual(["github", "confluence"]);
    expect(logger.error).toHaveBeenCalledWith(
      'Source "github" failed',
      "github down",
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Source "confluence" failed',
      "confluence down",
    );
  });

  it("coerces non-Error rejection reasons via String()", async () => {
    const dependencies = makeDependencies({
      collectJira: vi.fn(async () => {
        throw "raw string";
      }),
    });
    const config = makeConfig({ enabledSources: ["jira"] });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(result.failures).toEqual(["jira"]);
    expect(logger.error).toHaveBeenCalledWith(
      'Source "jira" failed',
      "raw string",
    );
  });

  it("runs Drive even when Calendar failed and passes empty attachmentFileIds", async () => {
    const dependencies = makeDependencies({
      collectCalendar: vi.fn(async () => {
        throw new Error("calendar oauth denied");
      }),
    });
    const config = makeConfig({ enabledSources: ["calendar", "drive"] });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(dependencies.collectDrive).toHaveBeenCalledWith({
      manager: MANAGER,
      serverConfig: SERVER_CONFIGS.drive,
      window: WINDOW,
      attachmentFileIds: [],
    });
    expect(result.failures).toEqual(["calendar"]);
    expect(result.results.map((r) => r.source)).toEqual(["custom", "drive"]);
  });

  it("records drive failure when Phase 2 throws", async () => {
    const dependencies = makeDependencies({
      collectDrive: vi.fn(async () => {
        throw new Error("drive down");
      }),
    });
    const config = makeConfig({ enabledSources: ["calendar", "drive"] });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(result.failures).toEqual(["drive"]);
    expect(result.results.map((r) => r.source)).toEqual(["calendar", "custom"]);
    expect(logger.error).toHaveBeenCalledWith(
      'Source "drive" failed',
      "drive down",
    );
  });

  it("coerces non-Error rejection reasons in Phase 2 via String()", async () => {
    const dependencies = makeDependencies({
      collectDrive: vi.fn(async () => {
        throw 42;
      }),
    });
    const config = makeConfig({ enabledSources: ["drive"] });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(result.failures).toEqual(["drive"]);
    expect(logger.error).toHaveBeenCalledWith('Source "drive" failed', "42");
  });
});

describe("collect — missing server/config errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails github when serverConfigs.github is missing", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ enabledSources: ["github"] });
    const serverConfigs: SourceServerConfigs = { ...SERVER_CONFIGS };
    delete serverConfigs.github;

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs,
      dependencies,
    });

    expect(dependencies.collectGithub).not.toHaveBeenCalled();
    expect(result.failures).toContain("github");
  });

  it("fails github when config.githubUsername is missing", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({
      enabledSources: ["github"],
      githubUsername: undefined,
    });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(dependencies.collectGithub).not.toHaveBeenCalled();
    expect(result.failures).toContain("github");
  });

  it("fails jira when serverConfigs.jira is missing", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ enabledSources: ["jira"] });
    const serverConfigs: SourceServerConfigs = { ...SERVER_CONFIGS };
    delete serverConfigs.jira;

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs,
      dependencies,
    });

    expect(result.failures).toContain("jira");
  });

  it("fails jira when config.jiraUsername is missing", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({
      enabledSources: ["jira"],
      jiraUsername: undefined,
    });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(result.failures).toContain("jira");
  });

  it("fails jira when config.jiraBaseUrl is missing", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({
      enabledSources: ["jira"],
      jiraBaseUrl: undefined,
    });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(result.failures).toContain("jira");
  });

  it("fails confluence when serverConfigs.confluence is missing", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ enabledSources: ["confluence"] });
    const serverConfigs: SourceServerConfigs = { ...SERVER_CONFIGS };
    delete serverConfigs.confluence;

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs,
      dependencies,
    });

    expect(result.failures).toContain("confluence");
  });

  it("fails confluence when config.confluenceBaseUrl is missing", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({
      enabledSources: ["confluence"],
      confluenceBaseUrl: undefined,
    });

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(result.failures).toContain("confluence");
  });

  it("fails calendar when serverConfigs.calendar is missing", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ enabledSources: ["calendar"] });
    const serverConfigs: SourceServerConfigs = { ...SERVER_CONFIGS };
    delete serverConfigs.calendar;

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs,
      dependencies,
    });

    expect(result.failures).toContain("calendar");
  });

  it("fails drive when serverConfigs.drive is missing", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ enabledSources: ["drive"] });
    const serverConfigs: SourceServerConfigs = { ...SERVER_CONFIGS };
    delete serverConfigs.drive;

    const result = await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs,
      dependencies,
    });

    expect(result.failures).toContain("drive");
    expect(dependencies.collectDrive).not.toHaveBeenCalled();
  });
});

describe("collect — logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wraps the run in "collect" stage timing', async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ enabledSources: [] });

    await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(logger.startStage).toHaveBeenCalledWith("collect");
    expect(logger.endStage).toHaveBeenCalledWith("collect");
  });

  it("logs per-source collected counts on success", async () => {
    const dependencies = makeDependencies({
      collectGithub: vi.fn(async () => [githubItem(), githubItem()]),
    });
    const config = makeConfig({ enabledSources: ["github"] });

    await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(logger.info).toHaveBeenCalledWith(
      'Source "github" collected 2 item(s)',
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Source "custom" collected 1 item(s)',
    );
  });

  it("logs the drive item count on Phase 2 success", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ enabledSources: ["drive"] });

    await collect({
      manager: MANAGER,
      window: WINDOW,
      config,
      serverConfigs: SERVER_CONFIGS,
      dependencies,
    });

    expect(logger.info).toHaveBeenCalledWith(
      'Source "drive" collected 1 item(s)',
    );
  });
});
