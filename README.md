# abTARS

abTARS is a personal agent built around [Pi](https://github.com/earendil-works/pi). It runs on your machine and connects Pi to chat and terminal interfaces, then adds tools, provider selection, scheduled work, memory integration, and process supervision.

## How it works

- **API route (`pi-ai`)** — Pi's agent core runs the model and tool loop, and Pi's provider engine connects to API providers.
- **ACP route** — abTARS connects to a compatible agent CLI through ACP. This route does not require Pi.
- **abTARS services** — platform adapters, sessions, tools and permissions, provider selection and fallback, and scheduled tasks.
- **Optional memory** — [abmind](https://github.com/aksika/abmind) is installed separately and discovered at runtime. abTARS can also run without it.

### What abTARS adds over Pi

Pi supplies the generic engine: the per-turn agent and tool loop,
provider streaming with tool-call handling, reasoning-level clamping,
cache session semantics, and context-overflow detection. abTARS supplies
everything product-specific around it: sessions and message delivery,
tool definitions with per-execution filtering and in-process execution,
permission and sandbox policy around every call, turn safety and loop
guards, provider selection with health tracking and fallback, durable
context projection, usage and cost telemetry, scheduled work, process
supervision, peer coordination, and the Pi-free ACP and emergency paths.

## What it does

- **Talk with your agent** through Telegram, Discord, or the local terminal interface.
- **Pick your model route** — API providers via Pi, or an ACP-compatible agent CLI. Switch with `/route`, inspect with `/model`.
- **Run tools and skills** — shell, files, web, todos, Kanban, artifacts, MCP servers, and authorable skills.
- **Delegate coding work** — supervised Pi coding sessions (`/coding`, `/pi run`) with Kanban-backed lifecycle.
- **Automate** — scheduled tasks, sleep maintenance, and optional peer-to-peer collaboration.
- **Add long-term memory** with [abmind](https://github.com/aksika/abmind), a separate product that abTARS discovers at runtime. abTARS can also run without abmind.
- **Keep the service running** with heartbeat scheduling, process supervision, and recovery.

## Requirements

- Node.js 22.19 or newer
- A Telegram or Discord bot, if you want to use a messaging platform
- A configured provider for your chosen route

See the [installation guide](docs/wiki/install.md) to get started. The Pi runtime is required for the API route and Pi coding features; the standard installer sets it up.

## Documentation

- [Quick start](docs/wiki/quickstart.md)
- [Installation](docs/wiki/install.md)
- [Transport configuration](docs/wiki/transport.md)
- [Models and routes](docs/wiki/models.md)
- [Commands](docs/wiki/commands.md)
- [Sessions](docs/wiki/sessions.md)
- [Scheduled tasks](docs/wiki/tasks.md)
- [Skills](docs/wiki/skills.md)
- [Pi integration](docs/wiki/pi.md)
- [API providers with Pi](docs/wiki/pi-providers.md)
- [Pi coding sessions](docs/wiki/pi-executor.md)
- [Terminal interface](docs/wiki/pi-tui.md)
- [Peer-to-peer](docs/wiki/peers.md)
- [MCP integration](docs/wiki/mcp-integration.md)
- [Security](docs/wiki/security.md)
- [Resilience](docs/wiki/resilience.md)
- [Troubleshooting](docs/wiki/troubleshooting.md)
- [Architecture](docs/wiki/architecture.md)

Full documentation: [aksika.github.io/abtars](https://aksika.github.io/abtars/)

## Development

```bash
npm install          # install deps
npm run build        # tsc + dashboard assets + build info
npm run typecheck    # strict typecheck (run before committing)
npm test             # fast deterministic suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for workflow and conventions.

## Community

- **GitHub:** [aksika/abtars](https://github.com/aksika/abtars) · [aksika/abmind](https://github.com/aksika/abmind)

## License

Apache-2.0
