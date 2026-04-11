# Daily Retrospective

Write a daily retrospective based on today's conversations.

## Pre-loaded data

Today's clean messages:
${CLEAN_MESSAGES}

## Task

Write a retrospective covering:

1. **What happened** — key events, tasks, decisions made today.
2. **Emotional attribution** — how the user seemed to feel during different interactions. Note shifts in tone or energy.
3. **Lessons** — what went well, what didn't, what to do differently.
4. **Recurring errors** — check if any errors appeared multiple times today and were fixed the same way. If so, note: "Recurring: [error] was fixed by [action] — consider adding as auto-fix rule via `agentbridge-autofix add`."
5. **Agent notes update** — if anything learned today should persist (user preferences, project context, recurring patterns), update `agent_notes.md` via `abmind edit`.

Write the retrospective to `${RETRO_PATH}`.

Respond with a brief confirmation of what was written.
