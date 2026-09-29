# Architecture

## Message interfaces

Telegram and Discord adapters receive messages and deliver replies. The optional local terminal interface provides a way to work with the agent on the machine running abTARS.

The message pipeline handles commands, access checks, sessions, prompt construction, tools, and streamed responses.

## Execution routes

- The pi-ai route uses Pi's agent core and provider engine for API model requests and tool execution. abTARS selects the route, assigns models, and manages configured fallback candidates.
- The ACP route connects to an ACP-compatible agent CLI. It runs independently of Pi.

See [Transport Configuration](/abtars/transport) and [Pi Integration](/abtars/pi).

## Optional integrations

- abmind is a separate, optional product that adds persistent memory.
- Skills, MCP servers, and browser tools extend the agent when configured.
- The Agent API lets configured abTARS instances communicate over authenticated peer connections. Peer connections are configured explicitly; see [Peer-to-Peer](/abtars/peers).

## Background work and recovery

The heartbeat runs registered periodic work, including scheduled tasks. In daemon mode, the external watchdog and operating-system service manager monitor the bridge and watchdog processes.

See [Process Supervision](/abtars/supervision) for recovery behavior.
