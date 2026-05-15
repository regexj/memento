import type { CollectionWindow, SourceResult } from "../types.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.ts");

const mockGenerateText = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  Output: {
    object: ({ schema }: { schema: unknown }) => ({ _type: "object", schema }),
  },
}));

// Import after mocks are set up
const { buildUserPrompt, summarise } = await import("../summariser.ts");
const { logger } = await import("../logger.ts");

const WINDOW: CollectionWindow = {
  from: new Date("2025-06-09T00:00:00.000Z"),
  to: new Date("2025-06-15T00:00:00.000Z"),
};

const MOCK_MODEL = { modelId: "test-model" } as never;

function makeSummaryOutput() {
  return {
    delivered: "- Merged 3 PRs",
    reviewedSupported: "- Reviewed 2 PRs for teammates",
    documentationProcess: "- Updated API docs",
    notableHighlights: "- Led incident response",
    impactFraming: "Improved deployment reliability for the team.",
  };
}

describe("buildUserPrompt", () => {
  it("includes the date range in YYYY-MM-DD format", () => {
    const prompt = buildUserPrompt([], [], WINDOW);

    expect(prompt).toContain("2025-06-09");
    expect(prompt).toContain("2025-06-15");
  });

  it("includes unavailable sources when failures are present", () => {
    const prompt = buildUserPrompt([], ["github", "jira"], WINDOW);

    expect(prompt).toContain("Unavailable sources: github, jira");
  });

  it("serializes activity items with all metadata fields", () => {
    const results: SourceResult[] = [
      {
        source: "github",
        data: [
          {
            type: "pr_merged",
            title: "Add auth module",
            repo: "my-app",
            url: "https://github.com/org/my-app/pull/42",
          },
        ],
      },
    ];

    const prompt = buildUserPrompt(results, [], WINDOW);

    expect(prompt).toContain("## github");
    expect(prompt).toContain("[pr_merged] Add auth module");
    expect(prompt).toContain("Repo: my-app");
    expect(prompt).toContain("URL: https://github.com/org/my-app/pull/42");
  });

  it("serializes jira items with ticket metadata", () => {
    const results: SourceResult[] = [
      {
        source: "jira",
        data: [
          {
            type: "ticket_completed",
            title: "Implement login",
            ticketKey: "PROJ-123",
            issueType: "feature",
            storyPoints: 5,
            epicName: "Authentication",
          },
        ],
      },
    ];

    const prompt = buildUserPrompt(results, [], WINDOW);

    expect(prompt).toContain("Ticket: PROJ-123");
    expect(prompt).toContain("Issue Type: feature");
    expect(prompt).toContain("Story Points: 5");
    expect(prompt).toContain("Epic: Authentication");
  });

  it("serializes confluence items with space name", () => {
    const results: SourceResult[] = [
      {
        source: "confluence",
        data: [
          {
            type: "page_created",
            title: "Architecture Decision Record",
            spaceName: "Engineering",
            url: "https://wiki.example.com/page/123",
          },
        ],
      },
    ];

    const prompt = buildUserPrompt(results, [], WINDOW);

    expect(prompt).toContain("Space: Engineering");
  });

  it("serializes calendar items with attendees and conference URL", () => {
    const results: SourceResult[] = [
      {
        source: "calendar",
        data: [
          {
            type: "calendar_event",
            title: "Sprint Planning",
            description: "Plan next sprint",
            eventAttendees: ["Alice <alice@co.com>", "Bob <bob@co.com>"],
            conferenceUrl: "https://meet.google.com/abc-def",
          },
        ],
      },
    ];

    const prompt = buildUserPrompt(results, [], WINDOW);

    expect(prompt).toContain("Description: Plan next sprint");
    expect(prompt).toContain(
      "Attendees: Alice <alice@co.com>, Bob <bob@co.com>",
    );
    expect(prompt).toContain("Conference: https://meet.google.com/abc-def");
  });

  it("serializes drive items with lastModified", () => {
    const results: SourceResult[] = [
      {
        source: "drive",
        data: [
          {
            type: "drive_document_authored",
            title: "Design Doc",
            url: "https://docs.google.com/doc/123",
            lastModified: "2025-06-12T10:00:00.000Z",
          },
        ],
      },
    ];

    const prompt = buildUserPrompt(results, [], WINDOW);

    expect(prompt).toContain("Last Modified: 2025-06-12T10:00:00.000Z");
  });

  it("shows 'No activity recorded' for sources with empty data", () => {
    const results: SourceResult[] = [{ source: "github", data: [] }];

    const prompt = buildUserPrompt(results, [], WINDOW);

    expect(prompt).toContain("## github\nNo activity recorded.");
  });

  it("omits optional fields that are undefined", () => {
    const results: SourceResult[] = [
      {
        source: "github",
        data: [{ type: "pr_opened", title: "Simple PR" }],
      },
    ];

    const prompt = buildUserPrompt(results, [], WINDOW);

    expect(prompt).not.toContain("Repo:");
    expect(prompt).not.toContain("URL:");
    expect(prompt).not.toContain("Ticket:");
    expect(prompt).not.toContain("Epic:");
  });

  it("omits attendees when the array is empty", () => {
    const results: SourceResult[] = [
      {
        source: "calendar",
        data: [
          {
            type: "calendar_event",
            title: "Solo focus time",
            eventAttendees: [],
          },
        ],
      },
    ];

    const prompt = buildUserPrompt(results, [], WINDOW);

    expect(prompt).not.toContain("Attendees:");
  });

  it("combines multiple sources in order", () => {
    const results: SourceResult[] = [
      { source: "github", data: [{ type: "pr_opened", title: "PR 1" }] },
      {
        source: "jira",
        data: [{ type: "ticket_completed", title: "Ticket 1" }],
      },
    ];

    const prompt = buildUserPrompt(results, [], WINDOW);

    const githubIndex = prompt.indexOf("## github");
    const jiraIndex = prompt.indexOf("## jira");
    expect(githubIndex).toBeLessThan(jiraIndex);
  });
});

describe("summarise", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls generateText with the model, output, system prompt, and user prompt", async () => {
    const summaryData = makeSummaryOutput();
    mockGenerateText.mockResolvedValue({ output: summaryData });

    const results: SourceResult[] = [
      { source: "github", data: [{ type: "pr_opened", title: "PR" }] },
    ];

    await summarise({
      model: MOCK_MODEL,
      results,
      failures: [],
      window: WINDOW,
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.model).toBe(MOCK_MODEL);
    expect(callArgs.output).toBeDefined();
    expect(callArgs.system).toContain("work diary assistant");
    expect(callArgs.prompt).toContain("2025-06-09");
    expect(callArgs.prompt).toContain("[pr_opened] PR");
  });

  it("returns a WeeklySummary with all five sections from the model output", async () => {
    const summaryData = makeSummaryOutput();
    mockGenerateText.mockResolvedValue({ output: summaryData });

    const result = await summarise({
      model: MOCK_MODEL,
      results: [],
      failures: [],
      window: WINDOW,
    });

    expect(result).toEqual(summaryData);
  });

  it("includes failure information in the prompt sent to the model", async () => {
    mockGenerateText.mockResolvedValue({ output: makeSummaryOutput() });

    await summarise({
      model: MOCK_MODEL,
      results: [],
      failures: ["github", "confluence"],
      window: WINDOW,
    });

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.prompt).toContain(
      "Unavailable sources: github, confluence",
    );
  });

  it("wraps execution in summarise stage timing", async () => {
    mockGenerateText.mockResolvedValue({ output: makeSummaryOutput() });

    await summarise({
      model: MOCK_MODEL,
      results: [],
      failures: [],
      window: WINDOW,
    });

    expect(logger.startStage).toHaveBeenCalledWith("summarise");
    expect(logger.endStage).toHaveBeenCalledWith("summarise");
  });

  it("propagates errors from generateText", async () => {
    mockGenerateText.mockRejectedValue(new Error("LLM unavailable"));

    await expect(
      summarise({
        model: MOCK_MODEL,
        results: [],
        failures: [],
        window: WINDOW,
      }),
    ).rejects.toThrow("LLM unavailable");
  });
});
