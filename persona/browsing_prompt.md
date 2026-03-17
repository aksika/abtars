# Web Research Task

**Date:** ${DATE}
**Task ID:** ${TASK_ID}
**Chat ID:** ${CHAT_ID}
**Browser status:** ${BROWSER_STATUS}

## Task

${TASK}

## How to complete this

Use the `shell` tool to run `agentbridge-browser` CLI commands. This is a local development tool installed on this machine that controls a headless Chromium instance running in Docker.

### Available commands

```bash
# Navigate to a URL
agentbridge-browser --action navigate --url "https://example.com" --session-id browse

# Click an element
agentbridge-browser --action click --selector "text=Sign In" --session-id browse

# Fill a form field
agentbridge-browser --action fill --selector "#email" --value "test@example.com" --session-id browse

# Extract visible text (optional --selector to scope)
agentbridge-browser --action extract_text --session-id browse

# Take a screenshot (optional --full-page)
agentbridge-browser --action screenshot --session-id browse

# List interactive elements (links, buttons, inputs)
agentbridge-browser --action get_page_info --session-id browse

# Close session when done
agentbridge-browser --action close_session --session-id browse
```

Always use `--session-id browse` to keep state across calls.

### If the browser container is not running

```bash
docker ps --filter name=agentbridge-browser --format "{{.Status}}"
# If empty, start it:
~/.agentbridge/browser-docker.sh
```

### Session persistence

The browser may already have active sessions from previous use. Navigate first — if the site loads normally, proceed. If you need stored session data, check `~/.agentbridge/titok/`.

## Output

Write your findings to this file:

```
~/.agentbridge/subagents/${REPORT_FILE}
```

Then output: `REPORT_SAVED: ~/.agentbridge/subagents/${REPORT_FILE}`

Include in the report:
- Pages visited
- Information found
- Any errors encountered
- Key data extracted
