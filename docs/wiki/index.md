# abTARS

abTARS is a personal agent built around [Pi](https://github.com/earendil-works/pi). It connects Pi to chat and terminal interfaces, then adds tools, provider selection, scheduled work, integrations, and process supervision.

## How it works

- **API route (`pi-ai`)** — Pi's agent core runs the model and tool loop, and Pi's provider engine connects to API providers.
- **ACP route** — abTARS connects to a compatible agent CLI through ACP. This route does not require Pi.
- **abTARS services** — platform adapters, sessions, tools and permissions, provider selection and fallback, and scheduled tasks.
- **Optional memory** — [abmind](https://github.com/aksika/abmind) is installed separately and discovered at runtime. abTARS can also run without it.

## Features

- Chat through Telegram or Discord, or enable and use the local terminal interface.
- Configure API providers and ACP-compatible command-line agents.
- Run tools, scheduled tasks, and supervised Pi coding sessions.
- Add persistent memory with abmind.
- Use process supervision to recover from bridge or watchdog failures.

## Requirements

- Node.js 22.19 or newer
- A Telegram or Discord bot, if you want to use a messaging platform
- A configured provider for your chosen route

See the [installation guide](/abtars/install) to get started.

## Documentation

- [Quick start](/abtars/quickstart)
- [Installation](/abtars/install)
- [Transport configuration](/abtars/transport)
- [Pi integration](/abtars/pi)
- [Pi coding sessions](/abtars/pi-executor)
- [Security](/abtars/security)
- [Resilience](/abtars/resilience)

## Community

- [Discord](https://discord.gg/pj2qbWJT8)
- [GitHub: abTARS](https://github.com/aksika/abtars)
- [GitHub: abmind](https://github.com/aksika/abmind)
