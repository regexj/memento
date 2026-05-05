export interface Config {
  llmProvider: string;
  llmModel: string;
  llmApiKey?: string;
  githubUsername?: string;
  jiraUsername?: string;
  jiraBaseUrl?: string;
  confluenceBaseUrl?: string;
  enabledSources: string[];
  reviewCycleMonth: number;
  diaryDir: string;
  logFile: string;
}

export interface CollectionWindow {
  from: Date;
  to: Date;
}

export interface ActivityItem {
  type: string;
  title: string;
  url?: string;
  repo?: string;
  ticketKey?: string;
  issueType?: string;
  storyPoints?: number;
  epicName?: string;
  spaceName?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceResult {
  source: string;
  data: ActivityItem[];
}

export interface WeeklySummary {
  delivered: string;
  reviewedSupported: string;
  documentationProcess: string;
  notableHighlights: string;
  impactFraming: string;
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  toolCalls: ToolCallConfig[];
}

export interface ToolCallConfig {
  tool: string;
  args: Record<string, string>;
}
