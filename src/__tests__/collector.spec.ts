import { collect } from "../collector.ts";
import type { CollectorDependencies } from "../collector.ts";
import type { ValidatedConfig } from "../load-config.ts";
import { logger } from "../logger.ts";
import type { McpClientManager } from "../mcp.ts";
import type {
  ActivityItem,
  CalendarCollectionResult,
  CollectionWindow,
  McpServerConfig,
  SourceServerConfigs,
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

const SERVER_CONFIGS: SourceServerConfigs = {
  github: makeServerConfig("github"),
  jira: makeServerConfig("jira"),
  confluence: makeServerConfig("confluence"),
  calendar: {
    name: "calendar",
    url: "https://calendar.example/mcp",
    toolCalls: [],
  },
};

function makeConfig(overrides: Partial<ValidatedConfig> = {}): ValidatedConfig {
  const base: ValidatedConfig = {
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4",
      apiKey: "sk-test",
    },
    sources: {},
    mcpServers: {
      github: { command: "node", args: ["gh.js"] },
      jira: { command: "node", args: ["jira.js"] },
      confluence: { command: "node", args: ["confluence.js"] },
      calendar: { url: "https://calendar.example/mcp" },
    },
    reviewCycleMonth: 1,
  };
  return { ...base, ...overrides };
}

function configWithSources(...sources: string[]): ValidatedConfig {
  const sourcesObj: ValidatedConfig["sources"] = {};
  if (sources.includes("github")) {
    sourcesObj.github = { enabled: true, server: "github", username: "alice" };
  }
  if (sources.includes("jira")) {
    sourcesObj.jira = {
      enabled: true,
      server: "jira",
      username: "alice@example.com",
      baseUrl: "https://jira.example.com",
    };
  }
  if (sources.includes("confluence")) {
    sourcesObj.confluence = {
      enabled: true,
      server: "confluence",
      baseUrl: "https://confluence.example.com",
    };
  }
  if (sources.includes("calendar")) {
    sourcesObj.calendar = { enabled: true, server: "calendar" };
  }
  return makeConfig({ sources: sourcesObj });
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
    const config = configWithSources("github");

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
    expect(dependencies.collectCustom).toHaveBeenCalledTimes(1);
    expect(result.failures).toEqual([]);
    expect(result.results.map((r) => r.source)).toEqual(["github", "custom"]);
  });

  it("runs all sources including calendar", async () => {
    const dependencies = makeDependencies();
    const config = configWithSources(
      "github",
      "jira",
      "confluence",
      "calendar",
    );

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
    expect(dependencies.collectCustom).toHaveBeenCalledTimes(1);

    expect(result.results.map((r) => r.source)).toEqual([
      "github",
      "jira",
      "confluence",
      "calendar",
      "custom",
    ]);
    expect(result.failures).toEqual([]);
  });

  it("passes the custom configPath and default username when provided", async () => {
    const dependencies = makeDependencies();
    const config = configWithSources("github");

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

  it("falls back to jira username for custom source when github source is not configured", async () => {
    const dependencies = makeDependencies();
    const config = configWithSources("jira");

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

  it("uses empty username for custom source when neither github nor jira source is configured", async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ sources: {} });

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
    const config = makeConfig({ sources: {} });

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
    const config = configWithSources("github", "jira", "confluence");

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
    const config = configWithSources("jira");

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
});

describe("collect — missing server/config errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails github when serverConfigs.github is missing", async () => {
    const dependencies = makeDependencies();
    const config = configWithSources("github");
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

  it("fails jira when serverConfigs.jira is missing", async () => {
    const dependencies = makeDependencies();
    const config = configWithSources("jira");
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

  it("fails confluence when serverConfigs.confluence is missing", async () => {
    const dependencies = makeDependencies();
    const config = configWithSources("confluence");
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

  it("fails calendar when serverConfigs.calendar is missing", async () => {
    const dependencies = makeDependencies();
    const config = configWithSources("calendar");
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
});

describe("collect — logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wraps the run in "collect" stage timing', async () => {
    const dependencies = makeDependencies();
    const config = makeConfig({ sources: {} });

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
    const config = configWithSources("github");

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
});
