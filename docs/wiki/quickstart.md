# Quick Start

New to abTARS? This page walks you through what you need and what to decide before installing.

Experienced? Jump straight to [Installation](./install.md) for the full technical steps.

## What you'll need

1. **A computer that stays on** — Mac mini, NUC, old laptop, cloud VM, WSL on your desktop. abTARS runs 24/7 on your hardware.

2. **Node.js 22+** — the runtime. Install via [Homebrew](https://brew.sh) (macOS) or [NodeSource](https://github.com/nodesource/distributions) (Linux/WSL).

3. **A Telegram bot token** — create one via [@BotFather](https://t.me/BotFather) on Telegram. This is how you'll talk to your agent.

4. **A model provider** — at least one of:
   - **ollama** (free, runs locally — good for privacy)
   - **OpenRouter** (paid, access to all frontier models)
   - **Kiro CLI / Gemini CLI / Claude Code** (if you already use one)

## Decisions to make

### How should it run?

| Mode | What it means |
|------|--------------|
| **Supervised (recommended)** | Installs as an OS service. Auto-restarts on crash, survives reboots, watchdog monitors health. Your agent is always on. |
| **Simple** | Runs in the background. If it crashes, you restart manually. Good for trying things out. |

### Which model?

Any model works. For the best experience:
- **128K+ context window** — smaller models lose context fast with tool use
- **Frontier quality** (GPT-4o, Claude, Gemini Pro) — better at following instructions, harder to manipulate
- **Local models via ollama** — fully private, no API costs, but weaker on complex tasks

You can switch models anytime via `/model` in Telegram. No reinstall needed.

## Let your AI install it for you

If you use an agentic coding tool (Kiro, Claude Code, Gemini CLI, Cursor, Copilot), just give it the [Installation page](./install.md) and ask it to install abTARS for you. It has all the information it needs — prerequisites, commands, platform-specific steps.

> "Install abTARS on this machine following the install guide. Use alpha channel, supervised mode."

That's it. Your AI colleague handles the rest.

## Manual install

Follow [Installation](./install.md) — it has step-by-step instructions for both Linux/WSL and macOS.

## After install

### Verify it works

```bash
abtars status       # should show bridge: ● running
abtars doctor       # should show all green
```

Send a message to your bot on Telegram — it should respond.

### Telegram commands

| Command | What it does |
|---------|-------------|
| `/status` | Bridge health, uptime, model |
| `/model` | Switch model/provider on the fly |
| `/new` | Start a fresh conversation session |
| `/sleep` | Trigger sleep + memory consolidation |
| `/help` | Full command list |

### Customize personality

Edit `~/.abmind/memory/core/SOUL.md` — this defines who your agent is: name, personality, language, tone. Make it yours.

### Updating

```bash
npm update -g abtars@alpha abmind@alpha
abtars update
```

### Something broke?

```bash
abtars doctor --fix
```

See [Health Check](./healthcheck.md) for more.

## Security

> ⚠️ When creating your bot with @BotFather, keep it **private** (not searchable publicly). abTARS has access to your machine via tools. The built-in allowlist blocks unknown senders, but the bot should not be discoverable in the first place. Only people who know the exact bot username should be able to reach it.
