# MCP Integration Guide

abtars connects to external services (Notion, JIRA, GitHub, etc.) via **MCP servers** using the `mcporter` CLI as a bridge. The agent gets a single `mcp` tool that can call any configured MCP server.

## How it works

```
User: "create a JIRA ticket for the login bug"
  │
  ▼
Agent calls: mcp(server="atlassian", tool="jira_create_issue", args={...})
  │
  ▼
abtars → mcporter call atlassian.jira_create_issue project=PROJ summary="Login bug"
  │
  ▼
mcporter → Atlassian MCP server → JIRA API → ticket created
  │
  ▼
Agent: "Done — created PROJ-142: Login bug"
```

The agent doesn't need custom code per service. It calls the generic `mcp` tool, mcporter routes to the right server.

## Setup

### 1. Install mcporter

```bash
npm install -g mcporter
```

### 2. Add an MCP server

```bash
mcporter add <server-name> --command "npx -y @modelcontextprotocol/<package>"
```

Or for servers that use env vars:

```bash
mcporter add <server-name> --command "npx -y <package>" --env KEY=value
```

### 3. Verify

```bash
mcporter list                    # shows configured servers
mcporter list <server> --schema  # shows available tools + parameters
```

### 4. Use from the agent

The agent automatically has access via the `mcp` tool. Ask it naturally:

- "Search JIRA for my open tickets"
- "Create a Notion page with today's meeting notes"
- "Make a PowerPoint about Q4 results"

Or use the `/mcp` command to see available servers.

## Common MCP Servers

### Notion

Read/write your Notion workspace — search pages, create databases, update content.

```bash
mcporter add notion --command "npx -y @modelcontextprotocol/notion" --env NOTION_API_KEY=secret_xxx
```

**Get your API key:** https://www.notion.so/my-integrations → New integration → copy the token.

**Share pages:** The integration only sees pages you explicitly share with it. In Notion, open a page → ⋯ → Connections → add your integration.

**Tools available:** `notion_search`, `notion_create_page`, `notion_update_page`, `notion_query_database`, `notion_create_database`, etc.

**Use cases:**
- "Search Notion for the deployment runbook"
- "Create a new page in my Projects database with title X"
- "Update the status field on the sprint planning page"

### JIRA / Atlassian

Search issues, create tickets, update status, add comments.

```bash
mcporter add atlassian --command "npx -y @modelcontextprotocol/atlassian" \
  --env ATLASSIAN_SITE_URL=https://yoursite.atlassian.net \
  --env ATLASSIAN_USER_EMAIL=you@company.com \
  --env ATLASSIAN_API_TOKEN=xxx
```

**Get your API token:** https://id.atlassian.com/manage-profile/security/api-tokens

**Tools available:** `jira_search`, `jira_create_issue`, `jira_update_issue`, `jira_add_comment`, `confluence_search`, `confluence_create_page`, etc.

**Use cases:**
- "What are my open JIRA tickets?"
- "Create a bug ticket: login page returns 500 on Safari"
- "Move PROJ-99 to Done"

### GitHub

Repos, issues, PRs, code search.

```bash
mcporter add github --command "npx -y @modelcontextprotocol/github" --env GITHUB_TOKEN=ghp_xxx
```

**Tools available:** `search_repositories`, `create_issue`, `list_pull_requests`, `get_file_contents`, etc.

**Use cases:**
- "List open PRs on abtars"
- "Create an issue: memory leak in recall pipeline"
- "Show me the README of aksika/abmind"

### PowerPoint (pptx)

Create presentations programmatically.

```bash
mcporter add pptx --command "npx -y @mcporter/pptx"
```

**Tools available:** `create_presentation`, `add_slide`, `manage_text`, `add_bullet_points`, `add_table`, `add_chart`, `save_presentation`, `auto_generate_presentation`

**Use cases:**
- "Create a 5-slide presentation about our Q4 results"
- "Add a chart showing monthly revenue to slide 3"

### Linear

Project management (alternative to JIRA).

```bash
mcporter add linear --command "npx -y @modelcontextprotocol/linear" --env LINEAR_API_KEY=lin_xxx
```

### Slack

Read/send messages, search channels.

```bash
mcporter add slack --command "npx -y @modelcontextprotocol/slack" --env SLACK_BOT_TOKEN=xoxb-xxx
```

### Google Drive / Gmail / Calendar

Accessed via `gws-cli` (Google Workspace CLI), not MCP. The agent calls it directly through the `execute_bash` tool:

```bash
gog gmail send --to user@example.com --subject "Report" --body "..."
gog drive list
gog calendar events
```

Not an MCP server — `gog` is a standalone CLI already on PATH and pre-approved for exec.

## Adding any MCP server

The MCP ecosystem is growing. Any server that follows the MCP protocol works:

1. Find a server: https://github.com/modelcontextprotocol/servers
2. `mcporter add <name> --command "npx -y <package>" --env KEY=value`
3. `mcporter list <name> --schema` to see what tools it exposes
4. Ask the agent to use it

## abmind as MCP server

abmind itself exposes an MCP server for other tools (Cursor, Windsurf, Claude Code, etc.) to use:

```bash
abmind mcp
```

This gives external tools access to `memory_recall`, `memory_store`, `memory_edit`, `memory_status`. Used by the Claude Code and Gemini CLI integrations.

## Troubleshooting

**"mcporter: command not found"** — Install it: `npm install -g mcporter`

**"daemon not running"** — The agent starts it automatically on first use. Manual: `mcporter daemon start`

**"tool returned error"** — Check credentials: `mcporter call <server>.<tool>` manually to see the raw error.

**"server not found"** — List configured servers: `mcporter list`. Add missing ones with `mcporter add`.

**Timeout on first call** — The daemon cold-starts MCP servers on first use (~3-5s). Subsequent calls are fast.
