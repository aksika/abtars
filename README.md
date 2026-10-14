# abTARS

abTARS is a personal agent built around [Pi](https://github.com/earendil-works/pi). It runs on your machine and connects Pi to chat and terminal interfaces, then adds tools, provider selection, scheduled work, memory integration, and process supervision.

## How it works

- **API route** — Pi's agent core runs the model and tool loop, and Pi's provider engine connects to API providers.
- **ACP route** — abTARS connects to a compatible agent CLI through ACP. This route does not require Pi.
- **Optional memory** — [abmind](https://github.com/aksika/abmind) is installed separately and discovered at runtime. abTARS can also run without it.

Start with [What is abTARS](https://aksika.github.io/abtars/why) and the [quick start](https://aksika.github.io/abtars/quickstart).

## Requirements

- Node.js 22.19 or newer
- A Telegram or Discord bot, if you want to use a messaging platform
- A configured provider for your chosen route

See the [installation guide](https://aksika.github.io/abtars/install) to get started. The Pi runtime is required for the API route and Pi coding features; the standard installer sets it up.

## Documentation

Full documentation: [aksika.github.io/abtars](https://aksika.github.io/abtars/)

- [Quick start](https://aksika.github.io/abtars/quickstart)
- [Installation](https://aksika.github.io/abtars/install)
- [Transport configuration](https://aksika.github.io/abtars/transport)
- [Pi integration](https://aksika.github.io/abtars/pi)
- [Pi coding sessions](https://aksika.github.io/abtars/pi-executor)
- [Security](https://aksika.github.io/abtars/security)

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
