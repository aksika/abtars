---
name: skill-authoring
description: Create, revise, or remove reusable procedural and interactive skills; use memory_store for facts and preferences.
tags: [skills, workflow]
---

# Skill Authoring

Store reusable procedures as skills. Store facts, events, and preferences with `memory_store`.

## Choose the right persistence

Use a skill when the knowledge explains **how to do something** and is likely to help again, especially when the procedure is multi-step, error-prone, or corrected by the user.

Use `memory_store` when the knowledge records **what is true**: a fact, event, decision, or preference. Do not create a skill for one conversation's outcome.

Never put credentials, tokens, private user data, or conversation transcripts in a skill. Declare required environment-variable names, not their values.

## Authoring workflow

1. Search `~/.abtars/skills/skills_catalog.md` for an existing skill that already covers the procedure. Improve it instead of creating a duplicate.
2. Choose a lowercase kebab-case name, 3-64 characters, with no leading or trailing hyphen.
3. Write a specific description (1-120 characters) that says what the skill does and when it applies. The catalog uses this text to select skills.
4. Keep the body procedural and imperative. Include prerequisites, ordered actions, failure handling, and a concrete verification step only when they add real value.
5. Create the skill with `skill_create`. Pass only the Markdown body in `content`; the tool writes frontmatter.
6. Run `/skill reload`, then confirm the skill appears in `skills_catalog.md` with the expected name and description.

`skill_create` writes `~/.abtars/skills/self/<skill-name>/SKILL.md`. Its body must be 100-50,000 UTF-8 bytes. Prefer a concise body; move substantial supporting material into `references/`.

## Skill shape

```text
<skill-name>/
├── SKILL.md            # required: metadata and instructions
├── skill.json          # only for a persistent interactive skill
├── scripts/            # optional deterministic helpers
└── references/         # optional detailed guidance
```

A typical generated file has:

```markdown
---
name: inspect-service-logs
description: Diagnose a failing service from its logs; use for startup failures and repeated crashes.
tags: [debugging, services]
related: [troubleshooting]
---

# Inspect Service Logs

1. Capture the first error and its surrounding context.
2. Trace it to the component that emitted it.
3. Verify the diagnosis by reproducing the failure or checking runtime state.
```

Optional eligibility metadata may declare dependencies:

```yaml
requires:
  bins: [jq, curl]
  npm: [some-package]
  env: [SERVICE_TOKEN]
  files: [~/.config/example/config.json]
```

Use the exact keys `bins`, `npm`, `env`, and `files`. Do not use `packages`. Keep secrets in the runtime environment or private runtime configuration, never in SKILL.md.

## Scripts and references

`skill_create` creates only SKILL.md. Add optional resources under the returned `self/<skill-name>/` directory with filesystem tools when needed.

- Put executable helpers in `scripts/`; make them self-contained and executable.
- Use shell for small helpers and Node or Python only when complexity warrants it.
- Do not bundle `node_modules`.
- Put detailed reference material in `references/` and tell the SKILL.md reader exactly when to open it.
- Test each added script with a representative invocation before relying on it.

Files produced **when a skill runs** belong in `~/.abtars/workspace/<skill-name>/`. Authoring files such as SKILL.md, scripts, references, and skill.json remain in `~/.abtars/skills/self/<skill-name>/`.

## Interactive skills

Create a persistent conversational (K-session) skill only when later user turns must continue the same bounded workflow. In addition to SKILL.md, add a strict `skill.json`:

```json
{
  "interactive": true,
  "timeout": 1800,
  "agent": "professor",
  "description": "Short guided tutoring session",
  "contextPath": "workspace/tutor/${userId}/CONTEXT.md",
  "prerequisites": []
}
```

Rules:

- `timeout` is a positive integer in seconds.
- `agent`, when present, is one of `task`, `professor`, `browsie`, `coding`, or `dreamy`.
- `tools` and `prerequisites`, when present, are arrays of strings; prerequisites are executable names.
- Keep `contextPath` under `~/.abtars/`; use `${userId}` when memory must be isolated per user.
- Reload skills and verify the skill appears in `/skills` before scheduling it. See the `create-task` skill for scheduled launches.

## Maintain existing skills

- Use `skill_patch` for one exact, localized replacement. The old string must occur exactly once.
- Use `skill_update` for a full body rewrite of a tool-created skill with flat frontmatter. Omitted description, tags, and related fields are preserved. If custom nested metadata such as `requires` exists, use a targeted patch so it is not flattened.
- Use `skill_remove` only when removal is intended; it moves a self-authored skill to `.trash` for recoverability.
- These lifecycle tools operate only on `skills/self/`; do not use them to overwrite bundled core skills.
- After every change, reload and inspect the catalog. Run any scripts or commands needed to verify the changed procedure.
