import {
  buildHeading,
  formatDiaryEntry,
  getDiaryDir,
  writeDiaryEntry,
} from "../diary.ts";
import type { CollectionWindow, WeeklySummary } from "../types.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIARY_DIR = "diary";

const mockSummary: WeeklySummary = {
  delivered: "- Merged 3 PRs\n- Completed 8 story points",
  reviewedSupported: "- Reviewed 2 PRs for teammates",
  documentationProcess: "- Updated onboarding docs",
  notableHighlights: "- Led incident response for production outage",
  impactFraming: "Delivered critical bug fixes that reduced error rate by 40%.",
};

describe("diary", () => {
  describe("buildHeading", () => {
    it("uses 'Week of' prefix for windows of 7 days or less", () => {
      const window: CollectionWindow = {
        from: new Date("2025-06-09T00:00:00.000Z"),
        to: new Date("2025-06-15T00:00:00.000Z"),
      };

      const heading = buildHeading(window);
      expect(heading).toBe("# Week of 9 June - 15 June 2025");
    });

    it("uses 'Period of' prefix for windows spanning more than 7 days", () => {
      const window: CollectionWindow = {
        from: new Date("2025-06-02T00:00:00.000Z"),
        to: new Date("2025-06-15T00:00:00.000Z"),
      };

      const heading = buildHeading(window);
      expect(heading).toBe("# Period of 2 June - 15 June 2025");
    });

    it("uses 'Week of' for exactly 7 days", () => {
      const window: CollectionWindow = {
        from: new Date("2025-06-08T00:00:00.000Z"),
        to: new Date("2025-06-15T00:00:00.000Z"),
      };

      const heading = buildHeading(window);
      expect(heading).toBe("# Week of 8 June - 15 June 2025");
    });

    it("handles cross-month windows", () => {
      const window: CollectionWindow = {
        from: new Date("2025-05-28T00:00:00.000Z"),
        to: new Date("2025-06-04T00:00:00.000Z"),
      };

      const heading = buildHeading(window);
      expect(heading).toBe("# Week of 28 May - 4 June 2025");
    });

    it("handles cross-year windows with Period prefix", () => {
      const window: CollectionWindow = {
        from: new Date("2024-12-20T00:00:00.000Z"),
        to: new Date("2025-01-05T00:00:00.000Z"),
      };

      const heading = buildHeading(window);
      expect(heading).toBe("# Period of 20 December - 5 January 2025");
    });
  });

  describe("getDiaryDir", () => {
    it("returns correct path for a given date", () => {
      const date = new Date("2025-06-15T00:00:00.000Z");
      expect(getDiaryDir(date)).toBe(join("diary", "2025", "06", "15"));
    });

    it("zero-pads single-digit months and days", () => {
      const date = new Date("2025-01-05T00:00:00.000Z");
      expect(getDiaryDir(date)).toBe(join("diary", "2025", "01", "05"));
    });
  });

  describe("formatDiaryEntry", () => {
    it("formats all sections with correct headings", () => {
      const window: CollectionWindow = {
        from: new Date("2025-06-09T00:00:00.000Z"),
        to: new Date("2025-06-15T00:00:00.000Z"),
      };

      const content = formatDiaryEntry(mockSummary, window);

      expect(content).toContain("# Week of 9 June - 15 June 2025");
      expect(content).toContain("### Delivered");
      expect(content).toContain("- Merged 3 PRs");
      expect(content).toContain("### Reviewed / Supported");
      expect(content).toContain("- Reviewed 2 PRs for teammates");
      expect(content).toContain("### Documentation / Process");
      expect(content).toContain("- Updated onboarding docs");
      expect(content).toContain("### Notable Highlights");
      expect(content).toContain(
        "- Led incident response for production outage",
      );
      expect(content).toContain("### Impact Framing");
      expect(content).toContain(
        "Delivered critical bug fixes that reduced error rate by 40%.",
      );
    });
  });

  describe("writeDiaryEntry", () => {
    const testRunDate = new Date("2025-06-15T00:00:00.000Z");
    const testDir = join(TEST_DIARY_DIR, "2025", "06", "15");

    beforeEach(() => {
      // Clean up test directory before each test
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true });
      }
    });

    afterEach(() => {
      // Clean up test directory after each test
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true });
      }
    });

    it("creates the directory path and writes diary.md", () => {
      const window: CollectionWindow = {
        from: new Date("2025-06-09T00:00:00.000Z"),
        to: new Date("2025-06-15T00:00:00.000Z"),
      };

      const filePath = writeDiaryEntry(mockSummary, window, testRunDate);

      expect(filePath).toBe(join(testDir, "diary.md"));
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("# Week of 9 June - 15 June 2025");
      expect(content).toContain("### Delivered");
    });

    it("overwrites existing diary.md", () => {
      const window: CollectionWindow = {
        from: new Date("2025-06-09T00:00:00.000Z"),
        to: new Date("2025-06-15T00:00:00.000Z"),
      };

      // Write first entry
      writeDiaryEntry(mockSummary, window, testRunDate);

      // Write second entry with different content
      const updatedSummary: WeeklySummary = {
        ...mockSummary,
        delivered: "- Merged 5 PRs (updated)",
      };
      writeDiaryEntry(updatedSummary, window, testRunDate);

      const content = readFileSync(join(testDir, "diary.md"), "utf-8");
      expect(content).toContain("- Merged 5 PRs (updated)");
      expect(content).not.toContain("- Merged 3 PRs");
    });

    it("creates nested directories that do not exist", () => {
      const window: CollectionWindow = {
        from: new Date("2025-06-09T00:00:00.000Z"),
        to: new Date("2025-06-15T00:00:00.000Z"),
      };

      expect(existsSync(testDir)).toBe(false);
      writeDiaryEntry(mockSummary, window, testRunDate);
      expect(existsSync(testDir)).toBe(true);
    });
  });
});
