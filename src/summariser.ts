import { logger } from "./logger.ts";
import type { CollectionWindow, SourceResult, WeeklySummary } from "./types.ts";
import { formatDate } from "./util.ts";
import { Output, generateText } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";

const weeklySummarySchema = z.object({
  delivered: z
    .string()
    .describe(
      "Features, fixes, and PRs merged with quantified metrics (counts, story points). Use markdown bullet list format.",
    ),
  reviewedSupported: z
    .string()
    .describe(
      "Code reviews performed, teammates helped, and unblocking contributions. Use markdown bullet list format.",
    ),
  documentationProcess: z
    .string()
    .describe(
      "Documentation written and process improvements made. Use markdown bullet list format.",
    ),
  notableHighlights: z
    .string()
    .describe(
      "Items worth calling out in a self-review. Use markdown bullet list format.",
    ),
  impactFraming: z
    .string()
    .describe(
      "1-2 sentences describing business or team value delivered that week.",
    ),
});

const summaryOutput = Output.object({ schema: weeklySummarySchema });

const SYSTEM_PROMPT = `You are a work diary assistant. Summarise the following weekly activity into exactly five sections.

Rules:
- Quantify where possible (e.g., "Merged 4 PRs", "Completed 12 story points")
- Impact Framing should be 1-2 sentences on business/team value
- If a section has no activity, write "No activity this week."
- If sources were unavailable, note them at the top of the delivered section.
- Use markdown bullet list format for all sections except Impact Framing.`;

function formatDateRange(window: CollectionWindow): string {
  const from = formatDate(window.from);
  const to = formatDate(window.to);
  return `${from} – ${to}`;
}

function serializeActivityData(
  results: SourceResult[],
  failures: string[],
): string {
  const sections: string[] = [];

  if (failures.length > 0) {
    sections.push(
      `Unavailable sources: ${failures.join(", ")}. Data from these sources could not be collected.`,
    );
  }

  for (const result of results) {
    if (result.data.length === 0) {
      sections.push(`## ${result.source}\nNo activity recorded.`);
      continue;
    }

    const items = result.data.map((item) => {
      const parts: string[] = [`- [${item.type}] ${item.title}`];

      if (item.repo !== undefined) parts.push(`  Repo: ${item.repo}`);
      if (item.ticketKey !== undefined)
        parts.push(`  Ticket: ${item.ticketKey}`);
      if (item.issueType !== undefined)
        parts.push(`  Issue Type: ${item.issueType}`);
      if (item.storyPoints !== undefined)
        parts.push(`  Story Points: ${item.storyPoints}`);
      if (item.epicName !== undefined) parts.push(`  Epic: ${item.epicName}`);
      if (item.spaceName !== undefined)
        parts.push(`  Space: ${item.spaceName}`);
      if (item.url !== undefined) parts.push(`  URL: ${item.url}`);
      if (item.description !== undefined)
        parts.push(`  Description: ${item.description}`);
      if (item.eventAttendees !== undefined && item.eventAttendees.length > 0)
        parts.push(`  Attendees: ${item.eventAttendees.join(", ")}`);
      if (item.conferenceUrl !== undefined)
        parts.push(`  Conference: ${item.conferenceUrl}`);
      if (item.lastModified !== undefined)
        parts.push(`  Last Modified: ${item.lastModified}`);

      return parts.join("\n");
    });

    sections.push(`## ${result.source}\n${items.join("\n")}`);
  }

  return sections.join("\n\n");
}

export function buildUserPrompt(
  results: SourceResult[],
  failures: string[],
  window: CollectionWindow,
): string {
  const dateRange = formatDateRange(window);
  const serialized = serializeActivityData(results, failures);
  return `Activity data for the period: ${dateRange}\n\n${serialized}`;
}

export interface SummariseOptions {
  model: LanguageModel;
  results: SourceResult[];
  failures: string[];
  window: CollectionWindow;
}

export async function summarise(
  options: SummariseOptions,
): Promise<WeeklySummary> {
  const { model, results, failures, window } = options;

  logger.startStage("summarise");

  const userPrompt = buildUserPrompt(results, failures, window);

  const result = await generateText({
    model,
    output: summaryOutput,
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  logger.endStage("summarise");

  return {
    delivered: result.output.delivered,
    reviewedSupported: result.output.reviewedSupported,
    documentationProcess: result.output.documentationProcess,
    notableHighlights: result.output.notableHighlights,
    impactFraming: result.output.impactFraming,
  };
}
