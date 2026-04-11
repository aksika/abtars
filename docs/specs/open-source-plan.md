# Open-Sourcing @agentbridge/memory

**Date:** 2026-04-11
**Status:** Planning

## Repo Strategy

Separate public repo from the private bridge:
```
github.com/aksika/agentbridge         ← private (bridge, persona, secrets)
github.com/aksika/agentbridge-memory  ← public (memory package only)
```

Bridge depends on the public package via npm. Memory developed in public repo, published to npm, bridge consumes it.

## What Must NOT Be Public

- `.env` files, API keys, tokens
- `persona/` directory (SOUL.md, prompts, agent notes — personal agent identity)
- `~/.agentbridge/` runtime data (memory.db, logs, user data)
- Any PII in test fixtures or comments
- Git history containing any of the above (use `git filter-repo` or start fresh)

## What Should Be Public

- All `packages/memory/src/` code
- Tests (with sanitized fixtures)
- README, architecture docs, API docs
- LICENSE file
- CI config (GitHub Actions for test + publish)
- `.env.example` with placeholder values

## License

**MIT** (recommended) — maximum adoption, anyone can use/modify/sell. Most npm packages use this. lossless-claw uses MIT. Apache 2.0 is the alternative (adds patent grant for corporate protection).

## Package Quality Checklist

| Item | Why |
|---|---|
| `README.md` with install + quick start + API | First thing people see |
| `LICENSE` file | npm won't feature unlicensed packages |
| `CHANGELOG.md` | Track versions (use changesets) |
| `.npmignore` or `files` in package.json | Only ship dist + types, not tests/src |
| TypeScript declarations (`.d.ts`) | TypeScript users get autocomplete |
| Semantic versioning | Breaking changes = major bump |
| CI: test on push, publish on tag | Automated quality gate |
| Zero/minimal dependencies | `better-sqlite3` is the only hard dep |
| Node.js version range in `engines` | Declare what you support |

## npm Publish Setup

```json
{
  "name": "@agentbridge/memory",
  "version": "0.1.0",
  "license": "MIT",
  "files": ["dist", "README.md", "LICENSE"],
  "bin": { "abm": "./dist/cli/abm.js" },
  "engines": { "node": ">=22" },
  "publishConfig": { "access": "public" }
}
```

GitHub Actions for publish:
```yaml
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: 'https://registry.npmjs.org' }
      - run: npm ci && npm test && npm run build
      - run: npm publish --access public
        env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
```

## CLI Command vs Package Name

Package name and CLI command are independent:
```json
{
  "name": "@agentbridge/memory",
  "bin": { "abm": "./dist/cli/abm.js" }
}
```
- `npm install -g @agentbridge/memory` → user types `abm recall "pizza"`
- `npx @agentbridge/memory recall "pizza"` also works

## Documentation Strategy

- **README.md** — install, quick start, CLI usage, programmatic API
- **docs/architecture.md** — how it works internally
- **docs/configuration.md** — all config options
- **API reference** — auto-generated from TSDoc comments (typedoc)
- **CONTRIBUTING.md** — how to contribute, dev setup, test instructions

## Positioning

Unique features no other open-source package has:
- 4-stage recall with trigram FTS5 + embeddings + signatures
- Emotion tagging + emotional arcs
- Sleep maintenance cycle (overnight curation)
- ABM-L compression language
- Timeline narratives
- Brain-inspired patterns (flashbulb, decay, interference)

Tagline: "The most complete AI agent memory system. SQLite-based, zero cloud dependencies, works with any LLM."

## Risks

- **Breaking changes** — once published, people depend on your API. Use semver strictly.
- **Support burden** — issues, PRs, questions. Set expectations in CONTRIBUTING.md.
- **Competitive exposure** — anyone can see your approach. But execution > ideas.
- **Bridge coupling leaks** — if any bridge-specific code sneaks into the package, it breaks standalone users.

## Order of Operations

1. Implement `abm` CLI (#124) — first thing users interact with
2. Pick license (MIT)
3. Create public repo `agentbridge-memory`
4. Copy `packages/memory/` as the root
5. Add README, LICENSE, CONTRIBUTING, CI
6. Sanitize: remove any PII, persona references, hardcoded paths
7. `npm publish --access public`
8. Bridge repo switches from workspace to `npm install @agentbridge/memory`

## Reference

- lossless-claw: `~/workspace/lossless-claw` — OpenClaw plugin, MIT, similar architecture
- MemPalace study: `docs/specs/mempalace-study.md` — competitive analysis
