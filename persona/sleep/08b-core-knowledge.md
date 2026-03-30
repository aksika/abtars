# §7b Core Knowledge Maintenance

Review the two core files that are injected into every context window. Brevity is critical — every line costs tokens on every conversation.

## user_profile.md

```bash
cat ~/.agentbridge/memory/core/user_profile.md
```

- Remove stale or redundant lines
- Keep ≤10 lines of high-signal facts
- Only facts that help every conversation (name, language, environment, preferences)

## agent_notes.md

```bash
cat ~/.agentbridge/memory/core/agent_notes.md
```

- Remove stale or redundant lines
- Keep ≤10 lines of operational rules
- Replace lessons that have been internalized with newer ones

Respond with changes made (or "no changes needed").
