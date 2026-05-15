import {
  type ReviewCommand,
  type RunCommand,
  isValidIso8601Date,
  isValidPeriod,
  parseCli,
} from "../cli.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock load-config to avoid needing a real config file
vi.mock("../load-config.ts", () => ({
  loadConfig: () => ({
    llm: { provider: "ollama", model: "llama3.2" },
    sources: {
      github: { enabled: true, server: "github", username: "user" },
      jira: {
        enabled: true,
        server: "atlassian",
        username: "user",
        baseUrl: "https://example.com",
      },
      confluence: {
        enabled: true,
        server: "atlassian",
        baseUrl: "https://example.com/wiki",
      },
      calendar: { enabled: false, server: "google" },
    },
    mcpServers: {},
    reviewCycleMonth: 1,
  }),
}));

describe("cli", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  describe("isValidIso8601Date", () => {
    it("accepts valid ISO 8601 dates", () => {
      expect(isValidIso8601Date("2025-01-01")).toBe(true);
      expect(isValidIso8601Date("2024-12-31")).toBe(true);
      expect(isValidIso8601Date("2023-06-15")).toBe(true);
    });

    it("rejects invalid dates", () => {
      expect(isValidIso8601Date("not-a-date")).toBe(false);
      expect(isValidIso8601Date("2025-13-01")).toBe(false);
      expect(isValidIso8601Date("2025-00-01")).toBe(false);
      expect(isValidIso8601Date("01-01-2025")).toBe(false);
      expect(isValidIso8601Date("2025/01/01")).toBe(false);
      expect(isValidIso8601Date("")).toBe(false);
    });
  });

  describe("isValidPeriod", () => {
    it("accepts valid period formats", () => {
      expect(isValidPeriod("3months")).toBe(true);
      expect(isValidPeriod("6months")).toBe(true);
      expect(isValidPeriod("12months")).toBe(true);
      expect(isValidPeriod("18months")).toBe(true);
      expect(isValidPeriod("1year")).toBe(true);
    });

    it("rejects invalid period formats", () => {
      expect(isValidPeriod("2years")).toBe(false);
      expect(isValidPeriod("months3")).toBe(false);
      expect(isValidPeriod("3 months")).toBe(false);
      expect(isValidPeriod("year")).toBe(false);
      expect(isValidPeriod("")).toBe(false);
      expect(isValidPeriod("0months")).toBe(true); // technically valid pattern
    });
  });

  describe("parseCli — run command", () => {
    it("parses run command with no flags", () => {
      const result = parseCli(["node", "cli.ts", "run"]);
      expect(result).toEqual({
        command: "run",
        dryRun: false,
        sources: undefined,
      } satisfies RunCommand);
    });

    it("parses run command with --dry-run", () => {
      const result = parseCli(["node", "cli.ts", "run", "--dry-run"]);
      expect(result).toEqual({
        command: "run",
        dryRun: true,
        sources: undefined,
      } satisfies RunCommand);
    });

    it("parses run command with --sources", () => {
      const result = parseCli([
        "node",
        "cli.ts",
        "run",
        "--sources",
        "github,jira",
      ]);
      expect(result).toEqual({
        command: "run",
        dryRun: false,
        sources: ["github", "jira"],
      } satisfies RunCommand);
    });

    it("parses run command with both flags", () => {
      const result = parseCli([
        "node",
        "cli.ts",
        "run",
        "--dry-run",
        "--sources",
        "confluence",
      ]);
      expect(result).toEqual({
        command: "run",
        dryRun: true,
        sources: ["confluence"],
      } satisfies RunCommand);
    });

    it("exits non-zero for unrecognized source", () => {
      parseCli(["node", "cli.ts", "run", "--sources", "slack"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unrecognized source "slack"'),
      );
    });

    it("exits non-zero when one source in list is unrecognized", () => {
      parseCli(["node", "cli.ts", "run", "--sources", "github,unknown"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unrecognized source "unknown"'),
      );
    });
  });

  describe("parseCli — review command", () => {
    it("parses review command with no flags", () => {
      const result = parseCli(["node", "cli.ts", "review"]);
      expect(result).toEqual({
        command: "review",
        start: undefined,
        period: undefined,
      } satisfies ReviewCommand);
    });

    it("parses review command with --start", () => {
      const result = parseCli([
        "node",
        "cli.ts",
        "review",
        "--start",
        "2025-01-01",
      ]);
      expect(result).toEqual({
        command: "review",
        start: "2025-01-01",
        period: undefined,
      } satisfies ReviewCommand);
    });

    it("parses review command with --period", () => {
      const result = parseCli([
        "node",
        "cli.ts",
        "review",
        "--period",
        "6months",
      ]);
      expect(result).toEqual({
        command: "review",
        start: undefined,
        period: "6months",
      } satisfies ReviewCommand);
    });

    it("parses review command with both flags", () => {
      const result = parseCli([
        "node",
        "cli.ts",
        "review",
        "--start",
        "2025-01-01",
        "--period",
        "1year",
      ]);
      expect(result).toEqual({
        command: "review",
        start: "2025-01-01",
        period: "1year",
      } satisfies ReviewCommand);
    });

    it("exits non-zero for invalid --start date", () => {
      parseCli(["node", "cli.ts", "review", "--start", "not-a-date"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid --start value"),
      );
    });

    it("exits non-zero for invalid --period format", () => {
      parseCli(["node", "cli.ts", "review", "--period", "2years"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid --period value"),
      );
    });
  });

  describe("parseCli — unknown command", () => {
    it("exits non-zero and shows help for unknown command", () => {
      parseCli(["node", "cli.ts", "unknown"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown command "unknown"'),
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: memento"),
      );
    });

    it("exits non-zero and shows help when no command provided", () => {
      parseCli(["node", "cli.ts"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("No command provided"),
      );
    });
  });
});
