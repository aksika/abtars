# What is abTARS

abTARS is a personal agent you run on your own machine and configure yourself. It connects Pi to the chat and terminal interfaces you already use, then adds tools, provider selection, scheduled work, memory integration, and process supervision around it.

## Built around Pi

On the API route, Pi's agent core runs the model and tool loop and Pi's provider engine connects to API providers. abTARS supplies everything product-specific around that engine: sessions and message delivery, tool definitions with per-execution filtering and in-process execution, permission and sandbox policy around every call, turn safety and loop guards, provider selection with health tracking and fallback, durable context projection, and usage telemetry. The ACP route connects to a compatible agent CLI instead and does not use Pi.

## Use it where you already work

Talk to the agent through Telegram or Discord, or connect the optional local terminal interface. The same abTARS service handles sessions, configuration, and tools across those interfaces.

## Choose your integrations

Configure model providers and fallback candidates for the API route, or use an ACP-compatible CLI. Add persistent memory with abmind, which installs separately and remains an independent product — abTARS also runs without it. Delegate larger coding goals to supervised Pi coding sessions, and extend behavior with skills, scheduled tasks, and MCP servers.

## Operate the service yourself

Configuration and runtime data live on your machine. You choose the interfaces, provider, integrations, and supervision mode: a supervised install that recovers after failures, or a simple run you start and stop yourself.

See the [installation](/abtars/install), [transport](/abtars/transport), and [supervision](/abtars/supervision) guides for the current setup, and [Pi integration](/abtars/pi) for what abTARS adds over Pi.
