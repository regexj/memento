import { appendFileSync } from "node:fs";

type LogLevel = "INFO" | "WARN" | "ERROR";

interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  startStage(stage: string): void;
  endStage(stage: string): void;
}

function createLogger(logFilePath = "./memento.log"): Logger {
  const stageTimers = new Map<string, number>();

  function writeLog(level: LogLevel, message: string, args?: unknown[]): void {
    args = args || [];
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}`;

    if (level === "ERROR") {
      console.error(line, ...args);
    } else if (level === "WARN") {
      console.warn(line, ...args);
    } else {
      console.info(line, ...args);
    }

    try {
      const fileLine = args.length > 0
        ? `${line} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`
        : line;
      appendFileSync(logFilePath, fileLine + "\n");
    } catch {
      // If we can't write to the log file, continue without blocking
    }
  }

  return {
    info(message: string, ...args: unknown[]) {
      writeLog("INFO", message, args);
    },

    warn(message: string, ...args: unknown[]) {
      writeLog("WARN", message, args);
    },

    error(message: string, ...args: unknown[]) {
      writeLog("ERROR", message, args);
    },

    startStage(stage: string) {
      stageTimers.set(stage, Date.now());
      writeLog("INFO", `Stage "${stage}" started`, []);
    },

    endStage(stage: string) {
      const startTime = stageTimers.get(stage);
      if (startTime === undefined) {
        writeLog("WARN", `Stage "${stage}" ended but was never started`);
        return;
      }
      const duration = Date.now() - startTime;
      stageTimers.delete(stage);
      writeLog("INFO", `Stage "${stage}" completed in ${duration}ms`);
    },
  };
}

export const logger = createLogger(process.env["LOG_FILE"] || "./memento.log");
export { createLogger, type Logger };
