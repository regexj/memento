/**
 * CLI argument parser for Memento.
 *
 * Parses process.argv for `run` and `review` commands with their respective flags.
 * Validates flag values and exits with descriptive errors for invalid input.
 */
import { loadConfig } from "./load-config.ts";

export interface RunCommand {
  command: "run";
  dryRun: boolean;
  sources: string[] | undefined;
}

export interface ReviewCommand {
  command: "review";
  start: string | undefined;
  period: string | undefined;
}

export type ParsedCommand = RunCommand | ReviewCommand;

const PERIOD_PATTERN = /^(\d+)months$|^1year$/;

export function isValidIso8601Date(value: string): boolean {
  // Accept YYYY-MM-DD format (ISO 8601 calendar date)
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(value)) return false;
  const date = new Date(value);
  return !isNaN(date.getTime());
}

export function isValidPeriod(value: string): boolean {
  return PERIOD_PATTERN.test(value);
}

const HELP_TEXT = `Usage: memento <command> [flags]

Commands:
  run      Execute the full weekly pipeline (collect, summarize, write)
  review   Generate a self-review for a specified period

run flags:
  --dry-run              Collect data and save raw.json but skip LLM and diary.md
  --sources <list>       Comma-separated list of sources to override config (e.g., github,jira)
                         Without this flag, all sources enabled in config are used.

review flags:
  --start <date>         ISO 8601 date to override review period start (e.g., 2025-01-01)
                         Without this flag, the period start is computed from config.
  --period <duration>    Override review period duration (e.g., 3months, 6months, 1year)
                         Without this flag, reviewCyclePeriod from config is used.
`;

function extractFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseRunCommand(args: string[]): RunCommand {
  const dryRun = hasFlag(args, "--dry-run");
  const sourcesRaw = extractFlag(args, "--sources");

  let sources: string[] | undefined;
  if (sourcesRaw !== undefined) {
    sources = sourcesRaw.split(",").map((s) => s.trim());
  }

  return { command: "run", dryRun, sources };
}

function parseReviewCommand(args: string[]): ReviewCommand {
  const start = extractFlag(args, "--start");
  const period = extractFlag(args, "--period");

  return { command: "review", start, period };
}

/**
 * Validates the parsed command flags against configuration and format rules.
 * Exits with non-zero status and descriptive error on invalid values.
 */
function validateCommand(parsed: ParsedCommand): void {
  if (parsed.command === "run" && parsed.sources !== undefined) {
    const config = loadConfig();
    const configuredSources = Object.keys(config.sources);

    for (const source of parsed.sources) {
      if (!configuredSources.includes(source)) {
        process.stderr.write(
          `Error: Unrecognized source "${source}". Configured sources: ${configuredSources.join(", ")}\n`,
        );
        process.exit(1);
      }
    }
  }

  if (parsed.command === "review") {
    if (parsed.start !== undefined && !isValidIso8601Date(parsed.start)) {
      process.stderr.write(
        `Error: Invalid --start value "${parsed.start}". Expected ISO 8601 date (e.g., 2025-01-01)\n`,
      );
      process.exit(1);
    }

    if (parsed.period !== undefined && !isValidPeriod(parsed.period)) {
      process.stderr.write(
        `Error: Invalid --period value "${parsed.period}". Expected format: <number>months (e.g., 3months, 6months) or 1year\n`,
      );
      process.exit(1);
    }
  }
}

/**
 * Parses CLI arguments and returns the validated command.
 * Exits with non-zero status on unknown commands or invalid flag values.
 */
export function parseCli(argv: string[] = process.argv): ParsedCommand {
  const args = argv.slice(2);
  const command = args[0];

  if (command !== "run" && command !== "review") {
    process.stderr.write(
      command
        ? `Error: Unknown command "${command}"\n\n`
        : `Error: No command provided\n\n`,
    );
    process.stderr.write(HELP_TEXT);
    process.exit(1);
  }

  const flagArgs = args.slice(1);

  let parsed: ParsedCommand;
  if (command === "run") {
    parsed = parseRunCommand(flagArgs);
  } else {
    parsed = parseReviewCommand(flagArgs);
  }

  validateCommand(parsed);
  return parsed;
}

/* v8 ignore start */
// Entry point — only runs when executed directly
const isDirectExecution =
  process.argv[1]?.endsWith("cli.ts") ||
  process.argv[1]?.endsWith("src/cli.ts");
if (isDirectExecution) {
  parseCli();
}
/* v8 ignore stop */
