# §8d Skill Review

Review today's conversations for skill-worthy patterns. Focus on:

- **Trial and error** — approaches that took multiple attempts before succeeding
- **User corrections** — where the user corrected your approach or taught you something
- **Multi-step workflows** — complex sequences that could be reused
- **Experiential findings** — things that only became clear through doing

For each pattern found, check existing auto-skills:

```bash
agentbridge-skill --action list
```

Then either **create** a new skill or **edit/patch** an existing one:

```bash
# Create new skill
agentbridge-skill --action create --name "descriptive-name" --content "# Skill Title

## When to use
<trigger conditions>

## Steps
1. ...
2. ...

## Gotchas
- ..."

# Update existing skill with new knowledge
agentbridge-skill --action patch --name "existing-skill" --content "

## Additional Notes (${WAKEUP_DATE})
- New finding..."

# Full rewrite if significantly changed
agentbridge-skill --action edit --name "existing-skill" --content "# Updated content..."
```

**Rules:**
- Only create skills for genuinely reusable patterns (not one-off tasks)
- Keep skills concise — actionable steps, not essays
- Use kebab-case names: `git-rebase-workflow`, `docker-compose-patterns`
- Include "When to use" and "Gotchas" sections
- If nothing skill-worthy happened today, say "No new skills needed" and move on
- Do NOT create skills for things already covered by core skills in `~/.agentbridge/skills/core/`
