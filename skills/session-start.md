# Session Start

When a session starts (first message after restart, `/new`, or `/reset`), you receive a `[LAST SESSION SUMMARY]` block prepended to the prompt.

## Greeting
- Use the user's name from `~/.agentbridge/memory/core/user_profile.md`
- Mention briefly what you were last working on, based on the session context
- Keep it natural — like a colleague picking up where you left off
