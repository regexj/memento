import { logger } from "./logger.ts";
import type { CollectionWindow, WeeklySummary } from "./types.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIARY_DIR = "diary";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Formats a Date as "Month Day" (e.g., "9 June").
 */
function formatMonthDay(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Formats a Date as "Month Day, Year" (e.g., "15 June 2025").
 */
function formatMonthDayYear(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Determines whether the collection window spans more than 7 days.
 */
function isMultiWeekSpan(window: CollectionWindow): boolean {
  const diffMs = window.to.getTime() - window.from.getTime();
  return diffMs > SEVEN_DAYS_MS;
}

/**
 * Builds the level-1 heading for the diary entry.
 *
 * Normal week: "# Week of June 9 – June 15, 2025"
 * Multi-week span (missed runs): "# Period of June 2 – June 15, 2025"
 */
export function buildHeading(window: CollectionWindow): string {
  const prefix = isMultiWeekSpan(window) ? "Period of" : "Week of";
  const fromStr = formatMonthDay(window.from);
  const toStr = formatMonthDayYear(window.to);
  return `# ${prefix} ${fromStr} - ${toStr}`;
}

/**
 * Formats the WeeklySummary into the diary entry markdown content.
 */
export function formatDiaryEntry(
  summary: WeeklySummary,
  window: CollectionWindow,
): string {
  const heading = buildHeading(window);

  const sections = [
    heading,
    "",
    "### Delivered",
    "",
    summary.delivered,
    "",
    "### Reviewed / Supported",
    "",
    summary.reviewedSupported,
    "",
    "### Documentation / Process",
    "",
    summary.documentationProcess,
    "",
    "### Notable Highlights",
    "",
    summary.notableHighlights,
    "",
    "### Impact Framing",
    "",
    summary.impactFraming,
    "",
  ];

  return sections.join("\n");
}

/**
 * Computes the output directory path for the diary entry based on the run date.
 * Returns the path: diary/YYYY/MM/DD
 */
export function getDiaryDir(runDate: Date): string {
  const year = runDate.getUTCFullYear().toString();
  const month = (runDate.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = runDate.getUTCDate().toString().padStart(2, "0");
  return join(DIARY_DIR, year, month, day);
}

/**
 * Writes the diary entry to diary/YYYY/MM/DD/diary.md.
 * Creates the full directory path if it does not exist.
 * Overwrites existing diary.md if present.
 */
export function writeDiaryEntry(
  summary: WeeklySummary,
  window: CollectionWindow,
  runDate: Date = new Date(),
): string {
  const dirPath = getDiaryDir(runDate);
  const filePath = join(dirPath, "diary.md");

  mkdirSync(dirPath, { recursive: true });

  const content = formatDiaryEntry(summary, window);
  writeFileSync(filePath, content, "utf-8");

  logger.info(`Diary entry written to ${filePath}`);
  return filePath;
}
