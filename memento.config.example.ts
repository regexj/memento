import { defineConfig } from "./src/define-config.ts";

/**
 * Memento configuration file.
 *
 * Copy this file to `memento.config.ts` and fill in your credentials.
 * `memento.config.ts` is gitignored to prevent committing secrets.
 *
 * A source is enabled simply by being present in the `sources` object.
 * Remove a source key to disable it.
 */
export const config = defineConfig({
  // ─── LLM Provider ───────────────────────────────────────────────────────────
  // Choose ONE provider block and uncomment it.

  // Option 1: Anthropic (cloud)
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKey: "<your-anthropic-api-key>",
  },

  // Option 2: OpenAI (cloud)
  // llm: {
  //   provider: "openai",
  //   model: "gpt-4o",
  //   apiKey: "<your-openai-api-key>",
  // },

  // Option 3: Ollama (local, free — no API key required)
  // llm: {
  //   provider: "ollama",
  //   model: "llama3.2",
  // },

  // ─── Data Sources ───────────────────────────────────────────────────────────
  // Set `enabled: true` to activate a source.
  // `server` references a key in `mcpServers` below.
  sources: {
    github: {
      enabled: true,
      server: "github",
      username: "<your-github-username>",
    },
    jira: {
      enabled: true,
      server: "atlassian",
      username: "<your-jira-email>",
      baseUrl: "https://<your-org>.atlassian.net",
    },
    confluence: {
      enabled: true,
      server: "atlassian",
      baseUrl: "https://<your-org>.atlassian.net/wiki",
    },
    // Calendar and Drive require Google Workspace OAuth setup.
    // See the "Google Workspace authentication" section in README.md.
    calendar: {
      enabled: false,
      server: "google",
    },
    drive: {
      enabled: false,
      server: "google",
      userEmail: "<your-google-email>",
    },
  },

  // ─── MCP Servers ────────────────────────────────────────────────────────────
  // Define how to connect to each MCP server.
  // Stdio servers use `command`/`args`/`env`.
  // HTTP servers use `url`/`headers`.
  mcpServers: {
    // GitHub — remote HTTP server (GitHub Copilot MCP)
    github: {
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: "Bearer <your-github-personal-access-token>",
      },
    },

    // Atlassian (Jira + Confluence) — local stdio server
    // Requires `uv`/`uvx` to be installed (https://docs.astral.sh/uv/).
    atlassian: {
      command: "uvx",
      args: ["mcp-atlassian"],
      env: {
        JIRA_URL: "https://<your-org>.atlassian.net",
        JIRA_USERNAME: "<your-jira-email>",
        JIRA_API_TOKEN: "<your-jira-api-token>",
        CONFLUENCE_URL: "https://<your-org>.atlassian.net/wiki",
        CONFLUENCE_USERNAME: "<your-confluence-email>",
        CONFLUENCE_API_TOKEN: "<your-confluence-api-token>",
      },
    },

    // Google Workspace (Calendar + Drive) — local stdio server
    // Uses the community `taylorwilsdon/google_workspace_mcp` server.
    // Requires `uv`/`uvx` to be installed (https://docs.astral.sh/uv/).
    google: {
      command: "uvx",
      args: ["workspace-mcp"],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: "<your-google-oauth-client-id>",
        GOOGLE_OAUTH_CLIENT_SECRET: "<your-google-oauth-client-secret>",
        OAUTHLIB_INSECURE_TRANSPORT: "1",
        WORKSPACE_MCP_READ_ONLY: "true",
        WORKSPACE_MCP_TOOLS: "calendar,drive",
      },
    },
  },

  // ─── Review Cycle ───────────────────────────────────────────────────────────
  // Month (1-12) when your annual review cycle starts. Defaults to 1 (January).
  reviewCycleMonth: 1,

  // ─── Custom Servers (optional) ──────────────────────────────────────────────
  // Additional MCP servers with pre-configured tool calls for data collection.
  // customServers: [
  //   {
  //     name: "slack",
  //     command: "npx",
  //     args: ["-y", "@anthropic/slack-mcp-server"],
  //     env: { SLACK_TOKEN: "<your-slack-token>" },
  //     toolCalls: [
  //       {
  //         tool: "search_messages",
  //         args: { query: "from:${USERNAME}", after: "${FROM_DATE}" },
  //       },
  //     ],
  //   },
  // ],
});
