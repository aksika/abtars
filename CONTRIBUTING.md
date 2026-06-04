# Contributing to abTARS

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/aksika/abtars.git
cd abtars
npm install
npm run build
npm test
```

Requires Node.js 22+.

## Code Style

- TypeScript strict mode
- Named exports over default exports
- `const` over `let`, no `var`
- PascalCase for classes/interfaces, camelCase for functions/variables, UPPER_SNAKE_CASE for constants
- No `any` — use `unknown` and narrow
- Always define return types for functions

## Making Changes

1. Fork the repo
2. Create a branch from `dev` (`git checkout -b my-fix dev`)
3. Make your changes
4. Run `npm test` — all tests must pass
5. Run `npm run build` — must compile clean
6. Commit with a descriptive message
7. Open a PR against `dev`

## Commit Messages

Format: `type: description (#ticket)`

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

Examples:
```
feat: add IRC platform adapter (#399)
fix: session switch loses context (#622)
docs: update sleep pipeline in wiki
```

## Project Structure

```
src/
  boot/           — startup phases (ordered)
  components/     — core logic (pipeline, transport, sessions)
  platforms/      — Telegram, Discord, IRC adapters
  capabilities/   — optional features (browser, sleep)
  cli/            — CLI commands
core/
  skills/         — built-in skills
  core_templates/ — seed files for fresh installs
```

## Testing

```bash
npm test              # full suite
npm run test:watch    # watch mode
npx vitest run src/components/my-file.test.ts  # single file
```

Write tests for new features. Match existing patterns — vitest, mocked dependencies, no external calls. **PRs without tests won't be accepted.**

## What to Contribute

- Bug fixes (check GitHub Issues)
- Platform adapters (WhatsApp, Slack, etc.)
- Skills (see `core/skills/` for examples)
- Documentation improvements
- Test coverage for untested modules

## What NOT to Do

- Don't add provider-specific logic to core (see `provider-universality.md`)
- Don't commit secrets, API keys, or personal data
- Don't modify the watchdog system without discussion
- Don't open PRs against `main` — always target `dev`

## Questions?

Open a GitHub Issue with the "question" label.
