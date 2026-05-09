import { logger } from "./logger.ts";
import type { CollectionWindow } from "./types.ts";
import { readFileSync, writeFileSync } from "node:fs";

const MARKER_FILE = ".last-run";

export function readMarker(): Date | null {
  try {
    const content = readFileSync(MARKER_FILE, "utf-8").trim();
    const date = new Date(content);
    if (isNaN(date.getTime())) {
      logger.warn(`Invalid date in marker file: "${content}"`);
      return null;
    }
    return stripTime(date);
  } catch {
    return null;
  }
}

export function writeMarker(): void {
  const now = new Date().toISOString();
  writeFileSync(MARKER_FILE, now, "utf-8");
  logger.info(`Marker updated: ${now}`);
}

function stripTime(date: Date): Date {
  return new Date(date.toISOString().split("T")[0]);
}

/**
 * Computes the collection window based on the marker file.
 * If a marker exists, collects from that date to today.
 * If no marker exists, defaults to the past 7 days.
 */
export function getCollectionWindow(): CollectionWindow {
  const marker = readMarker();
  const to = stripTime(new Date());

  if (marker) {
    const from = stripTime(marker);
    logger.info(
      `Collection window from marker: ${from.toISOString()} to ${to.toISOString()}`,
    );
    return { from, to };
  }

  const from = new Date(to);
  from.setDate(from.getDate() - 7);
  logger.info(
    `No marker found, defaulting to 7-day window: ${from.toISOString()} to ${to.toISOString()}`,
  );
  return { from, to };
}
