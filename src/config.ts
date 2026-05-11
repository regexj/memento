import type { Config } from "./types.ts";
import dotenv from "dotenv";

dotenv.config();

const CLOUD_PROVIDERS = ["anthropic", "openai", "google", "mistral"] as const;
const LOCAL_PROVIDERS = ["ollama"] as const;
const ALL_PROVIDERS = [...CLOUD_PROVIDERS, ...LOCAL_PROVIDERS] as const;
// const ALL_SOURCES = ["github", "jira", "confluence"] as const;

function isCloudProvider(provider: string): boolean {
  return (CLOUD_PROVIDERS as readonly string[]).includes(provider);
}

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    exitWithError(`Error: Required environment variable "${name}" is missing.`);
  }
  return value;
}

function validateSourceVariables(sources: string[]): void {
  if (sources.includes("github")) {
    requireEnv("GITHUB_USERNAME");
  }
  if (sources.includes("jira")) {
    requireEnv("JIRA_USERNAME");
    requireEnv("JIRA_BASE_URL");
  }
  if (sources.includes("confluence")) {
    requireEnv("CONFLUENCE_BASE_URL");
  }
}

export function loadConfig(): Config {
  const llmProvider = requireEnv("LLM_PROVIDER");
  const llmModel = requireEnv("LLM_MODEL");

  if (!(ALL_PROVIDERS as readonly string[]).includes(llmProvider)) {
    exitWithError(
      `Error: Unsupported LLM_PROVIDER "${llmProvider}". Supported providers: ${ALL_PROVIDERS.join(", ")}`,
    );
  }

  const llmApiKey: string | undefined = process.env["LLM_API_KEY"];

  if (isCloudProvider(llmProvider) && !llmApiKey) {
    exitWithError(
      `Error: LLM_API_KEY is required for cloud provider "${llmProvider}".`,
    );
  }

  const sourcesRaw =
    process.env["MEMENTO_SOURCES"] || "github,jira,confluence,calendar,drive";
  const enabledSources = sourcesRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  validateSourceVariables(enabledSources);

  const cycleMonthRaw = process.env["REVIEW_CYCLE_MONTH"];
  let reviewCycleMonth = 1;
  if (cycleMonthRaw) {
    const parsed = parseInt(cycleMonthRaw, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 12) {
      exitWithError(
        `Error: REVIEW_CYCLE_MONTH must be a number between 1 and 12. Got: "${cycleMonthRaw}"`,
      );
    }
    reviewCycleMonth = parsed;
  }

  const diaryDir = process.env["DIARY_DIR"] || "./diary";
  const logFile = process.env["LOG_FILE"] || "./memento.log";

  return {
    llmProvider,
    llmModel,
    llmApiKey,
    githubUsername: process.env["GITHUB_USERNAME"],
    jiraUsername: process.env["JIRA_USERNAME"],
    jiraBaseUrl: process.env["JIRA_BASE_URL"],
    confluenceBaseUrl: process.env["CONFLUENCE_BASE_URL"],
    enabledSources,
    reviewCycleMonth,
    diaryDir,
    logFile,
  };
}
