# Why abTARS

What makes abTARS different from other agentic frameworks.

## Private by Default

Most agent frameworks are designed for open access — anyone who knows the endpoint can interact. abTARS flips this:

- **Pre-configured user allowlist** — only explicitly approved platform IDs can talk to the agent
- **Role-based access** — master, user, guest with different permission levels
- **Memory classification** — 4 tiers (UNCLASSIFIED → SECRET), encrypted at rest for sensitive data
- **No cloud dependency** — everything runs on your hardware, nothing leaves your machine

You decide who talks to your agent. Not the other way around.

## Memory-Native Architecture

Memory isn't a plugin or afterthought — it's built into the core loop:

- **Every turn is recorded** — automatic, no configuration needed
- **Recall on every prompt** — relevant memories injected before the model sees your message
- **Sleep cycles** — background maintenance extracts facts, consolidates knowledge, detects contradictions
- **Cross-session persistence** — the agent remembers yesterday, last week, last month

Other frameworks offer memory as an optional add-on. In abTARS, the agent is useless without memory — and powerful because of it.

## Autonomous Operation

abTARS runs unattended 24/7:

- **Scheduled tasks** — cron-style jobs the agent executes on schedule
- **Self-healing** — watchdog restarts on crash, health monitoring, auto-fallback on model failure
- **Sleep/wake cycles** — the agent sleeps during quiet hours, processes memories, wakes up fresh
- **Multi-provider fallback** — if one model goes down, the next one picks up automatically

No babysitting. Deploy, configure, walk away.

## Security-First Tool Execution

The agent can run tools (bash, browser, MCP servers) — but with guardrails:

- **Per-user tool allowlist** — guests can't execute bash, only master can access secrets
- **Classified memory** — the agent knows secrets exist but can't leak them to unauthorized users
- **Outbound scanning** — (planned) detect and block secret/PII exfiltration in responses
- **Audit trail** — every tool call logged with user, timestamp, result

## Multi-Platform, Single Brain

One agent, multiple interfaces — same memory, same personality:

- Telegram (full-featured: voice, reactions, inline keyboards)
- Discord (slash commands, threads, streaming)
- IRC (lightweight, text-only)
- Peer-to-peer (agent-to-agent communication over Tailscale)

Switch platforms mid-conversation. The agent remembers everything regardless of where you talk to it.

## Operator-Owned Configuration

Everything is a JSON file you control:

- `transport.json` — providers, models, fallback chains, health tuning
- `users.json` — who can access, what they can do
- `tasks.json` — scheduled jobs
- `hooks.json` — lifecycle event handlers
- `models.json` — curated model catalog with validation status

No web dashboard required to configure. No account to create. No subscription. Edit a file, restart, done.

## What's Different

| Capability | Typical frameworks | abTARS |
|---|---|---|
| User access | Open or API-key gated | Pre-approved platform IDs only |
| Memory | Optional plugin, basic recall | Core architecture — extract, consolidate, sleep, age |
| Autonomy | Responds when prompted | Runs 24/7 with scheduled tasks + self-healing |
| Model failure | Error or single retry | Leaky-bucket health tracking + ordered fallback chain |
| Security | Trust the user | Classify, encrypt, gate per-role |
| Configuration | Web UI or env vars | JSON files, version-controlled, operator-owned |
| Deployment | Cloud service | Your hardware, your rules |
