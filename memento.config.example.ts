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
    // Calendar requires Google OAuth setup.
    // See the "Google Workspace authentication" section in README.md.
    // By default uses the community workspace-mcp server ("google").
    // Alternatively, point `server` at "google_calendar" for
    // the official Google MCP endpoint (requires your own token management).
    calendar: {
      enabled: false,
      server: "google",
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

    // Google Calendar — official Google MCP server (remote HTTP)
    // Uses OAuth-based authentication managed by Google.
    // See: https://developers.google.com/calendar/api/guides/overview
    google_calendar: {
      url: "https://calendarmcp.googleapis.com/mcp/v1",
      headers: {
        Authorization: "Bearer <your-google-oauth-access-token>",
      },
    },

    // Google Workspace (Calendar) — local stdio server (recommended)
    // Uses the community `taylorwilsdon/google_workspace_mcp` server.
    // Requires `uv`/`uvx` to be installed (https://docs.astral.sh/uv/).
    //
    // Setup:
    // 1. Create a Google Cloud project at https://console.cloud.google.com
    // 2. Enable the Google Calendar API
    // 3. Configure OAuth consent screen (External, add yourself as test user)
    //    → Publish to "In production" to avoid 7-day refresh token expiry
    // 4. Create a Desktop OAuth client (Credentials → OAuth client ID → Desktop app)
    // 5. Copy the Client ID and Client Secret below
    // 6. Run `npm run memento` once interactively to complete the browser consent flow
    //    (credentials are cached at ~/.google_workspace_mcp/credentials/)
    google: {
      command: "uvx",
      args: [
        "workspace-mcp",
        "--single-user",
        "--read-only",
        "--tools",
        "calendar",
      ],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: "<your-google-oauth-client-id>",
        GOOGLE_OAUTH_CLIENT_SECRET: "<your-google-oauth-client-secret>",
        OAUTHLIB_INSECURE_TRANSPORT: "1",
        USER_GOOGLE_EMAIL: "<your-google-email>",
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
