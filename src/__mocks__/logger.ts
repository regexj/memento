import type { Logger } from "../logger.ts";
import { vi } from "vitest";

export const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  startStage: vi.fn(),
  endStage: vi.fn(),
};

export const createLogger = vi.fn((): Logger => logger);
