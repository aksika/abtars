# abTARS

abTARS is a personal agent built around [Pi](https://github.com/earendil-works/pi). It runs on your machine and brings Pi into the conversations and workflows you already use, with messaging, tools, scheduled work, memory integration, and supervision.

Pi's agent core and provider engine power the API model route. abTARS manages message delivery, sessions, tools and permissions, integrations, and background work. ACP is also available as a Pi-free model route.

## What it does

- **Talk with your agent** through Telegram, Discord, or the local terminal interface.
- **Use Pi's model providers** on the API route, or connect through an ACP-compatible agent CLI.
- **Add long-term memory** with [abmind](https://github.com/aksika/abmind), a separate product that abTARS discovers at runtime. abTARS can also run without abmind.
- **Work in configured projects** with supervised Pi coding sessions and task runs.
- **Extend and automate** with tools, skills, scheduled tasks, and optional peer collaboration.
- **Keep the service running** with process supervision and recovery.

## How it fits together

Messages enter through Telegram, Discord, or the terminal interface and are handled by abTARS. On the API route, Pi runs the model and tool loop; abTARS supplies the session context and available tools. With ACP, abTARS connects to a compatible agent CLI instead. When abmind is installed and configured, it provides persistent memory independently of the Pi runtime.

The Pi runtime is required for the API route and Pi coding features. The standard installer sets it up. abmind is installed separately when you want its memory features.

## Requirements

- Node.js 22.19 or newer
- A Telegram or Discord bot, if you want to use a messaging platform
- A model provider for your selected transport

See the [installation guide](docs/wiki/install.md) for setup and provider configuration.

## Documentation

- [Quick start](docs/wiki/quickstart.md)
- [Installation](docs/wiki/install.md)
- [Commands](docs/wiki/commands.md)
- [Pi integration](docs/wiki/pi.md)
- [Pi providers and authentication](docs/wiki/pi-providers.md)
- [Pi coding sessions](docs/wiki/pi-executor.md)
- [Memory system](https://github.com/aksika/abmind)
- [Security](docs/wiki/security.md)
- [Resilience](docs/wiki/resilience.md)

Full documentation: [aksika.github.io/abtars](https://aksika.github.io/abtars/)

## Development

For local development, run **npm install**, **npm run build**, and **npm test** from the repository.

## Community

- **Discord:** [Join](https://discord.gg/pj2qbWJT8)
- **GitHub:** [aksika/abtars](https://github.com/aksika/abtars) · [aksika/abmind](https://github.com/aksika/abmind)

## License

Apache-2.0
