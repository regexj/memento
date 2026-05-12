import { config as rawConfig } from "../memento.config.ts";
import { logger } from "./logger.ts";
import { z } from "zod";

const CLOUD_PROVIDERS = ["anthropic", "openai", "google", "mistral"] as const;
const LOCAL_PROVIDERS = ["ollama"] as const;
const ALL_PROVIDERS = [...CLOUD_PROVIDERS, ...LOCAL_PROVIDERS] as const;

const StdioServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const HttpServerSchema = z.object({
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpServerEntrySchema = z.union([StdioServerSchema, HttpServerSchema]);

const CustomToolCallSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.string()),
});

const CustomServerEntrySchema = z.object({
  name: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  toolCalls: z.array(CustomToolCallSchema),
});

const LlmConfigSchema = z
  .object({
    provider: z.enum(ALL_PROVIDERS),
    model: z.string().min(1, "config.llm.model must not be empty"),
    apiKey: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      (CLOUD_PROVIDERS as readonly string[]).includes(data.provider) &&
      !data.apiKey
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: `config.llm.apiKey is required for cloud provider "${data.provider}"`,
      });
    }
  });

const GitHubSourceSchema = z.object({
  username: z
    .string()
    .min(1, "config.sources.github.username must not be empty"),
});

const JiraSourceSchema = z.object({
  username: z.string().min(1, "config.sources.jira.username must not be empty"),
  baseUrl: z.string().min(1, "config.sources.jira.baseUrl must not be empty"),
});

const ConfluenceSourceSchema = z.object({
  baseUrl: z
    .string()
    .min(1, "config.sources.confluence.baseUrl must not be empty"),
});

const CalendarSourceSchema = z.object({
  calendarIds: z.array(z.string()).optional(),
});

const DriveSourceSchema = z.object({
  userEmail: z.string().optional(),
});

const SourcesConfigSchema = z.object({
  github: GitHubSourceSchema.optional(),
  jira: JiraSourceSchema.optional(),
  confluence: ConfluenceSourceSchema.optional(),
  calendar: CalendarSourceSchema.optional(),
  drive: DriveSourceSchema.optional(),
});

const SourceServerMapSchema = z
  .object({
    github: z.string().optional(),
    jira: z.string().optional(),
    confluence: z.string().optional(),
    calendar: z.string().optional(),
    drive: z.string().optional(),
  })
  .optional();

const MementoConfigSchema = z
  .object({
    llm: LlmConfigSchema,
    sources: SourcesConfigSchema,
    mcpServers: z.record(z.string(), McpServerEntrySchema),
    sourceServerMap: SourceServerMapSchema,
    reviewCycleMonth: z.number().int().min(1).max(12).default(1),
    customServers: z.array(CustomServerEntrySchema).optional(),
  })
  .superRefine((data, ctx) => {
    const googleSources: Array<"calendar" | "drive"> = [];
    if (data.sources.calendar !== undefined) googleSources.push("calendar");
    if (data.sources.drive !== undefined) googleSources.push("drive");

    if (googleSources.length === 0) return;

    for (const source of googleSources) {
      const serverKey = data.sourceServerMap?.[source] ?? source;
      const serverEntry = data.mcpServers[serverKey];

      if (serverEntry === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["mcpServers", serverKey],
          message: `config.mcpServers["${serverKey}"] is required when ${source} source is enabled`,
        });
        continue;
      }

      if (!("command" in serverEntry)) continue;

      const env = serverEntry.env;
      if (!env?.["GOOGLE_OAUTH_CLIENT_ID"]) {
        ctx.addIssue({
          code: "custom",
          path: ["mcpServers", serverKey, "env", "GOOGLE_OAUTH_CLIENT_ID"],
          message: `config.mcpServers["${serverKey}"].env.GOOGLE_OAUTH_CLIENT_ID is required when ${source} source is enabled`,
        });
      }
      if (!env?.["GOOGLE_OAUTH_CLIENT_SECRET"]) {
        ctx.addIssue({
          code: "custom",
          path: ["mcpServers", serverKey, "env", "GOOGLE_OAUTH_CLIENT_SECRET"],
          message: `config.mcpServers["${serverKey}"].env.GOOGLE_OAUTH_CLIENT_SECRET is required when ${source} source is enabled`,
        });
      }
    }
  });

export type ValidatedConfig = z.infer<typeof MementoConfigSchema>;

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  • ${path}: ${issue.message}`;
    })
    .join("\n");
}

export function validateConfig(input: unknown): ValidatedConfig {
  const result = MementoConfigSchema.safeParse(input);
  if (!result.success) {
    const formatted = formatZodError(result.error);
    logger.error(`Invalid memento.config.ts:\n${formatted}`);
    process.exit(1);
  }
  return result.data;
}

/* v8 ignore start */
export function loadConfig(): ValidatedConfig {
  return validateConfig(rawConfig);
}
/* v8 ignore stop */
