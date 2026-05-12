/**
 * Typed configuration helper for memento.config.ts.
 *
 * Usage:
 * ```ts
 * import { defineConfig } from "./src/define-config.ts";
 * export const config = defineConfig({ ... });
 * ```
 */

// --- LLM Configuration ---

type CloudProvider = "anthropic" | "openai" | "google" | "mistral";
type LocalProvider = "ollama";
export type LlmProvider = CloudProvider | LocalProvider;

export interface LlmConfig {
  /** LLM provider identifier. */
  provider: LlmProvider;
  /** Model identifier for the chosen provider (e.g. "claude-sonnet-4-20250514", "gpt-4o"). */
  model: string;
  /** API key. Required for cloud providers, optional for local providers like Ollama. */
  apiKey?: string;
}

// --- Source Settings ---

export interface GitHubSourceSettings {
  username: string;
}

export interface JiraSourceSettings {
  username: string;
  baseUrl: string;
}

export interface ConfluenceSourceSettings {
  baseUrl: string;
}

export interface CalendarSourceSettings {
  /** Optional list of calendar IDs to include. Defaults to all calendars. */
  calendarIds?: string[];
}

export interface DriveSourceSettings {
  /** Optional user email used for ownership/writer filtering in Drive queries. */
  userEmail?: string;
}

export interface SourcesConfig {
  github?: GitHubSourceSettings;
  jira?: JiraSourceSettings;
  confluence?: ConfluenceSourceSettings;
  calendar?: CalendarSourceSettings;
  drive?: DriveSourceSettings;
}

// --- MCP Server Definitions ---

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerEntry = StdioServerConfig | HttpServerConfig;

// --- Custom Servers ---

export interface CustomToolCall {
  tool: string;
  args: Record<string, string>;
}

export interface CustomServerEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  toolCalls: CustomToolCall[];
}

// --- Source-to-Server Map ---

export type SourceServerMap = Partial<Record<keyof SourcesConfig, string>>;

// --- Top-Level Config ---

export interface MementoConfig {
  /** LLM provider and model configuration. */
  llm: LlmConfig;
  /** Enabled data sources and their per-source settings. A source is enabled by being present. */
  sources: SourcesConfig;
  /** MCP server definitions keyed by server name. */
  mcpServers: Record<string, McpServerEntry>;
  /** Maps each source name to its MCP server key. Defaults to source name as key when omitted. */
  sourceServerMap?: SourceServerMap;
  /** Starting month (1-12) of the annual review cycle. Defaults to 1 (January). */
  reviewCycleMonth?: number;
  /** Additional MCP servers with pre-configured tool calls for data collection. */
  customServers?: CustomServerEntry[];
}

/* v8 ignore start */
export function defineConfig(config: MementoConfig): MementoConfig {
  return config;
}
/* v8 ignore end */
