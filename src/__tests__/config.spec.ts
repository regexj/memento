import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config.ts";

vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
}));

function setEnv(vars: Record<string, string>) {
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

function clearMementoEnv() {
  const keys = [
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_API_KEY",
    "GITHUB_USERNAME",
    "JIRA_USERNAME",
    "JIRA_BASE_URL",
    "CONFLUENCE_BASE_URL",
    "MEMENTO_SOURCES",
    "REVIEW_CYCLE_MONTH",
    "DIARY_DIR",
    "LOG_FILE",
  ];
  for (const key of keys) {
    delete process.env[key];
  }
}

const VALID_ENV = {
  LLM_PROVIDER: "anthropic",
  LLM_MODEL: "claude-sonnet-4-20250514",
  LLM_API_KEY: "sk-test-key",
  GITHUB_USERNAME: "testuser",
  JIRA_USERNAME: "testuser",
  JIRA_BASE_URL: "https://test.atlassian.net",
  CONFLUENCE_BASE_URL: "https://test.atlassian.net/wiki",
};

describe("loadConfig", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearMementoEnv();
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockConsoleError.mockRestore();
    clearMementoEnv();
  });

  describe("required variables", () => {
    it("exits with error when LLM_PROVIDER is missing", () => {
      setEnv({ LLM_MODEL: "gpt-4o", LLM_API_KEY: "key" });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('"LLM_PROVIDER" is missing')
      );
    });

    it("exits with error when LLM_MODEL is missing", () => {
      setEnv({ LLM_PROVIDER: "openai", LLM_API_KEY: "key" });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('"LLM_MODEL" is missing')
      );
    });
  });

  describe("LLM provider validation", () => {
    it("exits with error for unsupported provider", () => {
      setEnv({
        LLM_PROVIDER: "unsupported",
        LLM_MODEL: "some-model",
        LLM_API_KEY: "key",
      });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported LLM_PROVIDER "unsupported"')
      );
    });

    it("exits with error when cloud provider has no API key", () => {
      setEnv({
        LLM_PROVIDER: "anthropic",
        LLM_MODEL: "claude-sonnet-4-20250514",
        GITHUB_USERNAME: "user",
        JIRA_USERNAME: "user",
        JIRA_BASE_URL: "https://x.atlassian.net",
        CONFLUENCE_BASE_URL: "https://x.atlassian.net/wiki",
      });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          'LLM_API_KEY is required for cloud provider "anthropic"'
        )
      );
    });

    it.each(["anthropic", "openai", "google", "mistral"])(
      "requires API key for cloud provider: %s",
      (provider) => {
        setEnv({ LLM_PROVIDER: provider, LLM_MODEL: "model" });

        expect(() => loadConfig()).toThrow("process.exit called");
        expect(mockConsoleError).toHaveBeenCalledWith(
          expect.stringContaining(
            `LLM_API_KEY is required for cloud provider "${provider}"`
          )
        );
      }
    );

    it("allows ollama without API key", () => {
      setEnv({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "llama3.2",
        MEMENTO_SOURCES: "github",
        GITHUB_USERNAME: "user",
      });

      const config = loadConfig();
      expect(config.llmProvider).toBe("ollama");
      expect(config.llmApiKey).toBeUndefined();
    });
  });

  describe("source-specific variable validation", () => {
    it("exits with error when GITHUB_USERNAME is missing for github source", () => {
      setEnv({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "llama3.2",
        MEMENTO_SOURCES: "github",
      });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('"GITHUB_USERNAME" is missing')
      );
    });

    it("exits with error when JIRA_USERNAME is missing for jira source", () => {
      setEnv({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "llama3.2",
        MEMENTO_SOURCES: "jira",
      });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('"JIRA_USERNAME" is missing')
      );
    });

    it("exits with error when JIRA_BASE_URL is missing for jira source", () => {
      setEnv({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "llama3.2",
        MEMENTO_SOURCES: "jira",
        JIRA_USERNAME: "user",
      });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('"JIRA_BASE_URL" is missing')
      );
    });

    it("exits with error when CONFLUENCE_BASE_URL is missing for confluence source", () => {
      setEnv({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "llama3.2",
        MEMENTO_SOURCES: "confluence",
      });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('"CONFLUENCE_BASE_URL" is missing')
      );
    });

    it("does not require source vars for disabled sources", () => {
      setEnv({
        LLM_PROVIDER: "ollama",
        LLM_MODEL: "llama3.2",
        MEMENTO_SOURCES: "github",
        GITHUB_USERNAME: "user",
      });

      const config = loadConfig();
      expect(config.enabledSources).toEqual(["github"]);
      expect(config.jiraUsername).toBeUndefined();
    });
  });

  describe("MEMENTO_SOURCES parsing", () => {
    it("defaults to github,jira,confluence when not set", () => {
      setEnv({ ...VALID_ENV });

      const config = loadConfig();
      expect(config.enabledSources).toEqual([
        "github",
        "jira",
        "confluence",
      ]);
    });

    it("parses comma-separated sources", () => {
      setEnv({
        ...VALID_ENV,
        MEMENTO_SOURCES: "github,jira",
      });

      const config = loadConfig();
      expect(config.enabledSources).toEqual(["github", "jira"]);
    });

    it("trims whitespace and lowercases source names", () => {
      setEnv({
        ...VALID_ENV,
        MEMENTO_SOURCES: " GitHub , Jira ",
      });

      const config = loadConfig();
      expect(config.enabledSources).toEqual(["github", "jira"]);
    });

    it("filters out empty strings from sources", () => {
      setEnv({
        ...VALID_ENV,
        MEMENTO_SOURCES: "github,,jira,",
      });

      const config = loadConfig();
      expect(config.enabledSources).toEqual(["github", "jira"]);
    });
  });

  describe("REVIEW_CYCLE_MONTH parsing", () => {
    it("defaults to 1 when not set", () => {
      setEnv({ ...VALID_ENV });

      const config = loadConfig();
      expect(config.reviewCycleMonth).toBe(1);
    });

    it("parses valid month values", () => {
      setEnv({ ...VALID_ENV, REVIEW_CYCLE_MONTH: "5" });

      const config = loadConfig();
      expect(config.reviewCycleMonth).toBe(5);
    });

    it("exits with error for month < 1", () => {
      setEnv({ ...VALID_ENV, REVIEW_CYCLE_MONTH: "0" });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("REVIEW_CYCLE_MONTH must be a number between 1 and 12")
      );
    });

    it("exits with error for month > 12", () => {
      setEnv({ ...VALID_ENV, REVIEW_CYCLE_MONTH: "13" });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("REVIEW_CYCLE_MONTH must be a number between 1 and 12")
      );
    });

    it("exits with error for non-numeric value", () => {
      setEnv({ ...VALID_ENV, REVIEW_CYCLE_MONTH: "abc" });

      expect(() => loadConfig()).toThrow("process.exit called");
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("REVIEW_CYCLE_MONTH must be a number between 1 and 12")
      );
    });
  });

  describe("optional variables and defaults", () => {
    it("uses default diary dir and log file when not set", () => {
      setEnv({ ...VALID_ENV });

      const config = loadConfig();
      expect(config.diaryDir).toBe("./diary");
      expect(config.logFile).toBe("./memento.log");
    });

    it("uses custom diary dir and log file when set", () => {
      setEnv({
        ...VALID_ENV,
        DIARY_DIR: "/custom/diary",
        LOG_FILE: "/custom/memento.log",
      });

      const config = loadConfig();
      expect(config.diaryDir).toBe("/custom/diary");
      expect(config.logFile).toBe("/custom/memento.log");
    });
  });

  describe("successful config loading", () => {
    it("returns a complete Config object with all fields", () => {
      setEnv({ ...VALID_ENV, REVIEW_CYCLE_MONTH: "6" });

      const config = loadConfig();
      expect(config).toEqual({
        llmProvider: "anthropic",
        llmModel: "claude-sonnet-4-20250514",
        llmApiKey: "sk-test-key",
        githubUsername: "testuser",
        jiraUsername: "testuser",
        jiraBaseUrl: "https://test.atlassian.net",
        confluenceBaseUrl: "https://test.atlassian.net/wiki",
        enabledSources: ["github", "jira", "confluence"],
        reviewCycleMonth: 6,
        diaryDir: "./diary",
        logFile: "./memento.log",
      });
    });
  });
});
