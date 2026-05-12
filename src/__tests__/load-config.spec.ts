import type { MementoConfig } from "../define-config.ts";
import { validateConfig } from "../load-config.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.ts");

function validConfig(overrides: Partial<MementoConfig> = {}): MementoConfig {
  return {
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-test",
    },
    sources: {
      github: { enabled: true, server: "github", username: "testuser" },
    },
    mcpServers: {
      github: { command: "node", args: ["gh.js"] },
    },
    ...overrides,
  };
}

describe("validateConfig", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  describe("LLM validation", () => {
    it("exits when llm.provider is missing", () => {
      const cfg = { ...validConfig(), llm: { model: "x" } };
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits when llm.model is missing", () => {
      const cfg = { ...validConfig(), llm: { provider: "anthropic" } };
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits when llm.model is empty", () => {
      const cfg = {
        ...validConfig(),
        llm: { provider: "anthropic", model: "", apiKey: "k" },
      };
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits for unsupported provider", () => {
      const cfg = {
        ...validConfig(),
        llm: { provider: "unsupported", model: "m", apiKey: "k" },
      };
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits when cloud provider has no apiKey", () => {
      const cfg = validConfig({
        llm: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it.each(["anthropic", "openai", "google", "mistral"] as const)(
      "requires apiKey for cloud provider: %s",
      (provider) => {
        const cfg = validConfig({ llm: { provider, model: "model" } });
        expect(() => validateConfig(cfg)).toThrow("process.exit called");
      },
    );

    it("allows ollama without apiKey", () => {
      const cfg = validConfig({
        llm: { provider: "ollama", model: "llama3.2" },
      });
      const result = validateConfig(cfg);
      expect(result.llm.provider).toBe("ollama");
      expect(result.llm.apiKey).toBeUndefined();
    });
  });

  describe("source-specific validation", () => {
    it("exits when github source is missing username", () => {
      const cfg = validConfig({
        sources: { github: { enabled: true, server: "github", username: "" } },
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits when jira source is missing username", () => {
      const cfg = validConfig({
        sources: {
          jira: {
            enabled: true,
            server: "atlassian",
            username: "",
            baseUrl: "https://x.atlassian.net",
          },
        },
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits when jira source is missing baseUrl", () => {
      const cfg = validConfig({
        sources: {
          jira: {
            enabled: true,
            server: "atlassian",
            username: "user",
            baseUrl: "",
          },
        },
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits when confluence source is missing baseUrl", () => {
      const cfg = validConfig({
        sources: {
          confluence: { enabled: true, server: "atlassian", baseUrl: "" },
        },
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("does not require source fields for sources not present", () => {
      const cfg = validConfig({ sources: {} });
      const result = validateConfig(cfg);
      expect(result.sources.github).toBeUndefined();
      expect(result.sources.jira).toBeUndefined();
    });
  });

  describe("Google OAuth validation for calendar/drive", () => {
    it("exits when calendar is enabled but server has no GOOGLE_OAUTH_CLIENT_ID", () => {
      const cfg = validConfig({
        sources: { calendar: { enabled: true, server: "google" } },
        mcpServers: {
          google: {
            command: "uvx",
            args: ["workspace-mcp"],
            env: { GOOGLE_OAUTH_CLIENT_SECRET: "secret" },
          },
        },
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits when calendar is enabled but server has no GOOGLE_OAUTH_CLIENT_SECRET", () => {
      const cfg = validConfig({
        sources: { calendar: { enabled: true, server: "google" } },
        mcpServers: {
          google: {
            command: "uvx",
            args: ["workspace-mcp"],
            env: { GOOGLE_OAUTH_CLIENT_ID: "id" },
          },
        },
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits when drive is enabled but mapped server is missing OAuth env", () => {
      const cfg = validConfig({
        sources: { drive: { enabled: true, server: "google" } },
        mcpServers: {
          google: { command: "uvx", args: ["workspace-mcp"], env: {} },
        },
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("resolves the server from source.server for calendar/drive", () => {
      const cfg = validConfig({
        sources: {
          calendar: { enabled: true, server: "google" },
          drive: { enabled: true, server: "google" },
        },
        mcpServers: {
          google: {
            command: "uvx",
            args: ["workspace-mcp"],
            env: {
              GOOGLE_OAUTH_CLIENT_ID: "id",
              GOOGLE_OAUTH_CLIENT_SECRET: "secret",
            },
          },
        },
      });
      const result = validateConfig(cfg);
      expect(result.sources.calendar).toBeDefined();
      expect(result.sources.drive).toBeDefined();
    });

    it("exits when source.server points to a non-existent server", () => {
      const cfg = validConfig({
        sources: { calendar: { enabled: true, server: "nonexistent" } },
        mcpServers: {},
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("skips OAuth check for HTTP-based servers", () => {
      const cfg = validConfig({
        sources: { calendar: { enabled: true, server: "google" } },
        mcpServers: {
          google: {
            url: "https://google-mcp.example.com",
            headers: { Authorization: "Bearer token" },
          },
        },
      });
      const result = validateConfig(cfg);
      expect(result.sources.calendar).toBeDefined();
    });

    it("skips OAuth check when calendar is present but disabled", () => {
      const cfg = validConfig({
        sources: { calendar: { enabled: false, server: "google" } },
        mcpServers: {},
      });
      const result = validateConfig(cfg);
      expect(result.sources.calendar?.enabled).toBe(false);
    });
  });

  describe("reviewCycleMonth", () => {
    it("defaults to 1 when not set", () => {
      const cfg = validConfig();
      delete (cfg as unknown as Record<string, unknown>)["reviewCycleMonth"];
      const result = validateConfig(cfg);
      expect(result.reviewCycleMonth).toBe(1);
    });

    it("accepts valid month values", () => {
      const cfg = validConfig({ reviewCycleMonth: 5 });
      const result = validateConfig(cfg);
      expect(result.reviewCycleMonth).toBe(5);
    });

    it("exits for month < 1", () => {
      const cfg = validConfig({ reviewCycleMonth: 0 });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits for month > 12", () => {
      const cfg = validConfig({ reviewCycleMonth: 13 });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });

    it("exits for non-integer value", () => {
      const cfg = validConfig({ reviewCycleMonth: 3.5 });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });
  });

  describe("root-level validation", () => {
    it("exits with root path when input is not an object", () => {
      expect(() => validateConfig(null)).toThrow("process.exit called");
    });

    it("exits with root path when input is a primitive", () => {
      expect(() => validateConfig("not an object")).toThrow(
        "process.exit called",
      );
    });
  });

  describe("mcpServers validation", () => {
    it("accepts stdio server config", () => {
      const cfg = validConfig({
        mcpServers: {
          github: {
            command: "node",
            args: ["server.js"],
            env: { TOKEN: "x" },
          },
        },
      });
      const result = validateConfig(cfg);
      expect(result.mcpServers["github"]).toEqual({
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "x" },
      });
    });

    it("accepts HTTP server config", () => {
      const cfg = validConfig({
        mcpServers: {
          github: {
            url: "https://mcp.github.com",
            headers: { Authorization: "Bearer x" },
          },
        },
      });
      const result = validateConfig(cfg);
      expect(result.mcpServers["github"]).toEqual({
        url: "https://mcp.github.com",
        headers: { Authorization: "Bearer x" },
      });
    });

    it("exits when server entry has neither command nor url", () => {
      const cfg = validConfig({
        mcpServers: { bad: {} as never },
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });
  });

  describe("customServers validation", () => {
    it("accepts valid custom server entries", () => {
      const cfg = validConfig({
        customServers: [
          {
            name: "slack",
            command: "npx",
            args: ["-y", "@anthropic/slack-mcp-server"],
            env: { SLACK_TOKEN: "token" },
            toolCalls: [{ tool: "search_messages", args: { query: "test" } }],
          },
        ],
      });
      const result = validateConfig(cfg);
      expect(result.customServers).toHaveLength(1);
      expect(result.customServers![0]!.name).toBe("slack");
    });

    it("exits when custom server is missing toolCalls", () => {
      const cfg = validConfig({
        customServers: [{ name: "bad", command: "x" } as never],
      });
      expect(() => validateConfig(cfg)).toThrow("process.exit called");
    });
  });

  describe("successful validation", () => {
    it("returns a fully validated config object", () => {
      const cfg: MementoConfig = {
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKey: "sk-test",
        },
        sources: {
          github: { enabled: true, server: "github", username: "testuser" },
          jira: {
            enabled: true,
            server: "atlassian",
            username: "jirauser",
            baseUrl: "https://test.atlassian.net",
          },
          confluence: {
            enabled: true,
            server: "atlassian",
            baseUrl: "https://test.atlassian.net/wiki",
          },
        },
        mcpServers: {
          github: { command: "node", args: ["gh.js"] },
          atlassian: { command: "uvx", args: ["mcp-atlassian"] },
        },
        reviewCycleMonth: 6,
      };

      const result = validateConfig(cfg);
      expect(result.llm.provider).toBe("anthropic");
      expect(result.llm.model).toBe("claude-sonnet-4-20250514");
      expect(result.sources.github?.username).toBe("testuser");
      expect(result.sources.jira?.enabled).toBe(true);
      expect(result.sources.jira?.server).toBe("atlassian");
      expect(result.reviewCycleMonth).toBe(6);
    });
  });
});
