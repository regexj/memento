import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readMarker, writeMarker, getCollectionWindow } from "../marker.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { logger } from "../logger.ts";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../logger.ts");

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

describe("readMarker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a Date when marker file contains a valid ISO datetime", () => {
    mockedReadFileSync.mockReturnValue("2025-06-09T14:30:00.000Z");

    const result = readMarker();

    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe("2025-06-09T00:00:00.000Z");
    expect(mockedReadFileSync).toHaveBeenCalledWith(".last-run", "utf-8");
  });

  it("returns a Date when marker file contains a date-only string", () => {
    mockedReadFileSync.mockReturnValue("2025-06-09");

    const result = readMarker();

    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe("2025-06-09T00:00:00.000Z");
  });

  it("strips time from the returned date", () => {
    mockedReadFileSync.mockReturnValue("2025-06-09T23:59:59.999Z");

    const result = readMarker();

    expect(result!.toISOString()).toBe("2025-06-09T00:00:00.000Z");
  });

  it("returns null when marker file does not exist", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const result = readMarker();

    expect(result).toBeNull();
  });

  it("returns null and logs warning when marker file contains invalid date", () => {
    mockedReadFileSync.mockReturnValue("not-a-date");

    const result = readMarker();

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Invalid date in marker file")
    );
  });

  it("trims whitespace from marker file content", () => {
    mockedReadFileSync.mockReturnValue("  2025-06-09T10:00:00.000Z  \n");

    const result = readMarker();

    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe("2025-06-09T00:00:00.000Z");
  });

  it("returns null when marker file is empty", () => {
    mockedReadFileSync.mockReturnValue("   ");

    const result = readMarker();

    expect(result).toBeNull();
  });
});

describe("writeMarker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the current datetime as a full ISO string", () => {
    vi.setSystemTime(new Date("2025-06-16T10:30:45.123Z"));

    writeMarker();

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      ".last-run",
      "2025-06-16T10:30:45.123Z",
      "utf-8"
    );
  });

  it("logs the marker update", () => {
    vi.setSystemTime(new Date("2025-06-16T10:30:45.123Z"));

    writeMarker();

    expect(logger.info).toHaveBeenCalledWith(
      "Marker updated: 2025-06-16T10:30:45.123Z"
    );
  });
});

describe("getCollectionWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns window from marker date to today when marker exists", () => {
    vi.setSystemTime(new Date("2025-06-16T14:00:00.000Z"));
    mockedReadFileSync.mockReturnValue("2025-06-09T08:30:00.000Z");

    const window = getCollectionWindow();

    expect(window.from.toISOString()).toBe("2025-06-09T00:00:00.000Z");
    expect(window.to.toISOString()).toBe("2025-06-16T00:00:00.000Z");
  });

  it("returns 7-day window when no marker exists", () => {
    vi.setSystemTime(new Date("2025-06-16T14:00:00.000Z"));
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const window = getCollectionWindow();

    expect(window.from.toISOString()).toBe("2025-06-09T00:00:00.000Z");
    expect(window.to.toISOString()).toBe("2025-06-16T00:00:00.000Z");
  });

  it("always has from <= to", () => {
    vi.setSystemTime(new Date("2025-06-16T14:00:00.000Z"));
    mockedReadFileSync.mockReturnValue("2025-06-10T23:59:59.999Z");

    const window = getCollectionWindow();

    expect(window.from.getTime()).toBeLessThanOrEqual(window.to.getTime());
  });

  it("strips time from both from and to dates", () => {
    vi.setSystemTime(new Date("2025-06-16T18:45:30.500Z"));
    mockedReadFileSync.mockReturnValue("2025-06-09T22:15:00.000Z");

    const window = getCollectionWindow();

    expect(window.from.toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect(window.to.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });

  it("handles marker from more than 7 days ago (missed run recovery)", () => {
    vi.setSystemTime(new Date("2025-06-16T10:00:00.000Z"));
    mockedReadFileSync.mockReturnValue("2025-06-01T09:00:00.000Z");

    const window = getCollectionWindow();

    expect(window.from.toISOString()).toBe("2025-06-01T00:00:00.000Z");
    expect(window.to.toISOString()).toBe("2025-06-16T00:00:00.000Z");
  });

  it("logs collection window info when marker exists", () => {
    vi.setSystemTime(new Date("2025-06-16T10:00:00.000Z"));
    mockedReadFileSync.mockReturnValue("2025-06-09T08:00:00.000Z");

    getCollectionWindow();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Collection window from marker")
    );
  });

  it("logs default window info when no marker exists", () => {
    vi.setSystemTime(new Date("2025-06-16T10:00:00.000Z"));
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    getCollectionWindow();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("No marker found, defaulting to 7-day window")
    );
  });
});
