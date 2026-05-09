import { type Logger, createLogger } from "../logger.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logger", () => {
  let logger: Logger;
  let logFile: string;
  let tempDir: string;
  let mockConsoleInfo: ReturnType<typeof vi.spyOn>;
  let mockConsoleWarn: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "memento-test-"));
    logFile = join(tempDir, "test.log");
    logger = createLogger(logFile);
    mockConsoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    mockConsoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readLog(): string {
    return readFileSync(logFile, "utf-8");
  }

  describe("info", () => {
    it("logs to console.info with INFO level and timestamp", () => {
      logger.info("hello world");

      expect(mockConsoleInfo).toHaveBeenCalledTimes(1);
      const output = mockConsoleInfo.mock.calls[0][0] as string;
      expect(output).toMatch(/^\[.+\] \[INFO\] hello world$/);
    });

    it("writes to the log file", () => {
      logger.info("file message");

      const content = readLog();
      expect(content).toContain("[INFO] file message");
    });

    it("passes extra args to console.info", () => {
      logger.info("with args", { key: "value" }, 42);

      expect(mockConsoleInfo).toHaveBeenCalledWith(
        expect.stringContaining("[INFO] with args"),
        { key: "value" },
        42,
      );
    });

    it("serializes extra args into the log file line", () => {
      logger.info("with args", "extra", { n: 1 });

      const content = readLog();
      expect(content).toContain("extra");
      expect(content).toContain('{"n":1}');
    });
  });

  describe("warn", () => {
    it("logs to console.warn with WARN level", () => {
      logger.warn("something off");

      expect(mockConsoleWarn).toHaveBeenCalledTimes(1);
      const output = mockConsoleWarn.mock.calls[0][0] as string;
      expect(output).toMatch(/\[WARN\] something off/);
    });

    it("writes to the log file with WARN level", () => {
      logger.warn("warn msg");

      const content = readLog();
      expect(content).toContain("[WARN] warn msg");
    });
  });

  describe("error", () => {
    it("logs to console.error with ERROR level", () => {
      logger.error("bad thing");

      expect(mockConsoleError).toHaveBeenCalledTimes(1);
      const output = mockConsoleError.mock.calls[0][0] as string;
      expect(output).toMatch(/\[ERROR\] bad thing/);
    });

    it("writes to the log file with ERROR level", () => {
      logger.error("error msg");

      const content = readLog();
      expect(content).toContain("[ERROR] error msg");
    });
  });

  describe("log file path", () => {
    it("writes to the specified path", () => {
      const otherFile = join(tempDir, "other.log");
      const custom = createLogger(otherFile);
      custom.info("test");

      const content = readFileSync(otherFile, "utf-8");
      expect(content).toContain("[INFO] test");
    });

    it("defaults to ./memento.log when no path provided", () => {
      // Just verify the factory accepts no args without throwing
      const defaultLogger = createLogger();
      expect(defaultLogger).toBeDefined();
    });
  });

  describe("graceful degradation on file write failure", () => {
    it("does not throw when log file path is invalid", () => {
      const badLogger = createLogger("/nonexistent/dir/file.log");

      expect(() => badLogger.info("still works")).not.toThrow();
      expect(mockConsoleInfo).toHaveBeenCalled();
    });
  });

  describe("startStage / endStage", () => {
    it("logs stage start with INFO level", () => {
      logger.startStage("collection");

      const output = mockConsoleInfo.mock.calls[0][0] as string;
      expect(output).toMatch(/\[INFO\] Stage "collection" started/);
    });

    it("logs stage end with duration in ms", () => {
      vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1250);

      logger.startStage("summarize");
      logger.endStage("summarize");

      const endOutput = mockConsoleInfo.mock.calls[1][0] as string;
      expect(endOutput).toMatch(/Stage "summarize" completed in 250ms/);
    });

    it("warns when ending a stage that was never started", () => {
      logger.endStage("unknown");

      expect(mockConsoleWarn).toHaveBeenCalledTimes(1);
      const output = mockConsoleWarn.mock.calls[0][0] as string;
      expect(output).toContain('Stage "unknown" ended but was never started');
    });

    it("cleans up timer after endStage so it can be reused", () => {
      vi.spyOn(Date, "now")
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(200)
        .mockReturnValueOnce(300)
        .mockReturnValueOnce(500);

      logger.startStage("repeat");
      logger.endStage("repeat");
      logger.startStage("repeat");
      logger.endStage("repeat");

      const firstEnd = mockConsoleInfo.mock.calls[1][0] as string;
      expect(firstEnd).toContain("100ms");

      const secondEnd = mockConsoleInfo.mock.calls[3][0] as string;
      expect(secondEnd).toContain("200ms");
    });
  });

  describe("timestamp format", () => {
    it("includes ISO 8601 timestamp in log output", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-16T10:00:05.123Z"));

      const timedLogger = createLogger(logFile);
      timedLogger.info("timestamped");

      const output = mockConsoleInfo.mock.calls[0][0] as string;
      expect(output).toBe("[2025-06-16T10:00:05.123Z] [INFO] timestamped");

      vi.useRealTimers();
    });
  });

  describe("file appending", () => {
    it("appends multiple log entries to the same file", () => {
      logger.info("first");
      logger.warn("second");
      logger.error("third");

      const content = readLog();
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain("[INFO] first");
      expect(lines[1]).toContain("[WARN] second");
      expect(lines[2]).toContain("[ERROR] third");
    });
  });
});
