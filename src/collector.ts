import { logger } from "./logger.ts";
import type { McpClientManager } from "./mcp.ts";
import { collectCalendarActivity } from "./sources/calendar.ts";
import { collectConfluenceActivity } from "./sources/confluence.ts";
import { collectCustomActivity } from "./sources/custom.ts";
import { collectDriveActivity } from "./sources/drive.ts";
import { collectGithubActivity } from "./sources/github.ts";
import { collectJiraActivity } from "./sources/jira.ts";
import type {
  ActivityItem,
  CollectionWindow,
  Config,
  McpServerConfig,
  SourceResult,
} from "./types.ts";

export interface SourceServerConfigs {
  github?: McpServerConfig;
  jira?: McpServerConfig;
  confluence?: McpServerConfig;
  calendar?: McpServerConfig;
  drive?: McpServerConfig;
}

export interface CollectorDependencies {
  collectGithub: typeof collectGithubActivity;
  collectJira: typeof collectJiraActivity;
  collectConfluence: typeof collectConfluenceActivity;
  collectCalendar: typeof collectCalendarActivity;
  collectDrive: typeof collectDriveActivity;
  collectCustom: typeof collectCustomActivity;
}

export interface CollectOptions {
  manager: McpClientManager;
  window: CollectionWindow;
  config: Config;
  serverConfigs: SourceServerConfigs;
  customConfigPath?: string;
  dependencies?: Partial<CollectorDependencies>;
}

export interface CollectResult {
  results: SourceResult[];
  failures: string[];
}

const DEFAULT_DEPENDENCIES: CollectorDependencies = {
  collectGithub: collectGithubActivity,
  collectJira: collectJiraActivity,
  collectConfluence: collectConfluenceActivity,
  collectCalendar: collectCalendarActivity,
  collectDrive: collectDriveActivity,
  collectCustom: collectCustomActivity,
};

interface Phase1Task {
  source: string;
  task: Promise<ActivityItem[]>;
}

interface CalendarState {
  attachmentFileIds: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveCustomUsername(config: Config): string {
  if (config.githubUsername !== undefined) {
    return config.githubUsername;
  }
  if (config.jiraUsername !== undefined) {
    return config.jiraUsername;
  }
  return "";
}

function buildGithubTask(
  options: CollectOptions,
  deps: CollectorDependencies,
): Phase1Task {
  const { manager, window, config, serverConfigs } = options;
  return {
    source: "github",
    task: (async () => {
      const serverConfig = serverConfigs.github;
      const username = config.githubUsername;
      if (serverConfig === undefined || username === undefined) {
        throw new Error(
          'GitHub source is enabled but requires "serverConfigs.github" and "config.githubUsername"',
        );
      }
      return deps.collectGithub({ manager, serverConfig, window, username });
    })(),
  };
}

function buildJiraTask(
  options: CollectOptions,
  deps: CollectorDependencies,
): Phase1Task {
  const { manager, window, config, serverConfigs } = options;
  return {
    source: "jira",
    task: (async () => {
      const serverConfig = serverConfigs.jira;
      const username = config.jiraUsername;
      const baseUrl = config.jiraBaseUrl;
      if (
        serverConfig === undefined ||
        username === undefined ||
        baseUrl === undefined
      ) {
        throw new Error(
          'Jira source is enabled but requires "serverConfigs.jira", "config.jiraUsername", and "config.jiraBaseUrl"',
        );
      }
      return deps.collectJira({
        manager,
        serverConfig,
        window,
        username,
        baseUrl,
      });
    })(),
  };
}

function buildConfluenceTask(
  options: CollectOptions,
  deps: CollectorDependencies,
): Phase1Task {
  const { manager, window, config, serverConfigs } = options;
  return {
    source: "confluence",
    task: (async () => {
      const serverConfig = serverConfigs.confluence;
      const username = config.jiraUsername;
      const baseUrl = config.confluenceBaseUrl;
      if (
        serverConfig === undefined ||
        username === undefined ||
        baseUrl === undefined
      ) {
        throw new Error(
          'Confluence source is enabled but requires "serverConfigs.confluence", "config.jiraUsername", and "config.confluenceBaseUrl"',
        );
      }
      return deps.collectConfluence({
        manager,
        serverConfig,
        window,
        username,
        baseUrl,
      });
    })(),
  };
}

function buildCalendarTask(
  options: CollectOptions,
  deps: CollectorDependencies,
  calendarState: CalendarState,
): Phase1Task {
  const { manager, window, serverConfigs } = options;
  return {
    source: "calendar",
    task: (async () => {
      const serverConfig = serverConfigs.calendar;
      if (serverConfig === undefined) {
        throw new Error(
          'Calendar source is enabled but requires "serverConfigs.calendar"',
        );
      }
      const result = await deps.collectCalendar({
        manager,
        serverConfig,
        window,
      });
      calendarState.attachmentFileIds = result.attachmentFileIds;
      return result.items;
    })(),
  };
}

function buildCustomTask(
  options: CollectOptions,
  deps: CollectorDependencies,
): Phase1Task {
  const { manager, window, config, customConfigPath } = options;
  return {
    source: "custom",
    task: (async () => {
      const username = resolveCustomUsername(config);
      return deps.collectCustom({
        manager,
        window,
        username,
        ...(customConfigPath !== undefined
          ? { configPath: customConfigPath }
          : {}),
      });
    })(),
  };
}

function buildPhase1Tasks(
  options: CollectOptions,
  deps: CollectorDependencies,
  calendarState: CalendarState,
): Phase1Task[] {
  const enabled = new Set(options.config.enabledSources);
  const tasks: Phase1Task[] = [];

  if (enabled.has("github")) {
    tasks.push(buildGithubTask(options, deps));
  }
  if (enabled.has("jira")) {
    tasks.push(buildJiraTask(options, deps));
  }
  if (enabled.has("confluence")) {
    tasks.push(buildConfluenceTask(options, deps));
  }
  if (enabled.has("calendar")) {
    tasks.push(buildCalendarTask(options, deps, calendarState));
  }

  // Custom MCP servers are configured separately via mcp-servers.json and run
  // unconditionally; the custom source itself handles a missing config file.
  tasks.push(buildCustomTask(options, deps));

  return tasks;
}

async function runPhase2Drive(
  options: CollectOptions,
  deps: CollectorDependencies,
  attachmentFileIds: string[],
  results: SourceResult[],
  failures: string[],
): Promise<void> {
  const enabled = new Set(options.config.enabledSources);
  if (!enabled.has("drive")) {
    return;
  }
  try {
    const serverConfig = options.serverConfigs.drive;
    if (serverConfig === undefined) {
      throw new Error(
        'Drive source is enabled but requires "serverConfigs.drive"',
      );
    }
    const items = await deps.collectDrive({
      manager: options.manager,
      serverConfig,
      window: options.window,
      attachmentFileIds,
    });
    results.push({ source: "drive", data: items });
    logger.info(`Source "drive" collected ${items.length} item(s)`);
  } catch (error) {
    logger.error('Source "drive" failed', errorMessage(error));
    failures.push("drive");
  }
}

export async function collect(options: CollectOptions): Promise<CollectResult> {
  const dependencies: CollectorDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  };

  logger.startStage("collect");
  const calendarState: CalendarState = { attachmentFileIds: [] };
  const phase1Tasks = buildPhase1Tasks(options, dependencies, calendarState);

  const settled = await Promise.allSettled(phase1Tasks.map((t) => t.task));

  const results: SourceResult[] = [];
  const failures: string[] = [];

  for (let i = 0; i < phase1Tasks.length; i += 1) {
    const entry = phase1Tasks[i]!;
    const outcome = settled[i]!;
    if (outcome.status === "rejected") {
      logger.error(
        `Source "${entry.source}" failed`,
        errorMessage(outcome.reason),
      );
      failures.push(entry.source);
      continue;
    }
    const items = outcome.value;
    results.push({ source: entry.source, data: items });
    logger.info(`Source "${entry.source}" collected ${items.length} item(s)`);
  }

  await runPhase2Drive(
    options,
    dependencies,
    calendarState.attachmentFileIds,
    results,
    failures,
  );

  logger.endStage("collect");
  return { results, failures };
}
