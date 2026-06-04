# Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Platforms   │────▶│   Pipeline   │────▶│    Transport    │
│             │     │              │     │                 │
│ • Telegram  │     │ • Commands   │     │ • CLI (ACP/tmux)│
│ • Discord   │◀────│ • Memory     │◀────│ • API (HTTP)    │
│ • IRC       │     │ • Streaming  │     │ • Fallback      │
└─────────────┘     └──────────────┘     └─────────────────┘
                           │
                    ┌──────┴──────┐
                    │   abmind    │
                    │  (memory)   │
                    └─────────────┘

┌─────────────────────────────────────────────────────────┐
│                    A2A (Peer-to-Peer)                    │
│                                                         │
│  abTARS instance ◀──── /v1/chat/completions ────▶ abTARS instance  │
│  (Instance A)         JWT + digital signatures     (Instance B)  │
│                       over Tailscale                               │
└─────────────────────────────────────────────────────────┘
```

**Platforms** receive messages from users and deliver responses back.

**Pipeline** processes each message: runs commands, checks permissions, builds prompts with memory context, manages streaming delivery.

**Transport** communicates with AI models — either by spawning a CLI tool (Kiro, Gemini) or calling an HTTP API (ollama, OpenRouter).

**abmind** provides persistent memory — recall on every turn, store after every response, sleep cycles for maintenance.

**A2A (Agent-to-Agent)** enables peer communication between abTARS instances. Agents can ask each other questions, delegate tasks, and share information over an authenticated channel.

## A2A Protocol

Two abTARS instances communicate via OpenAI-compatible `/v1/chat/completions` endpoint over Tailscale:

- **Authentication** — per-peer JWT tokens + digital signatures
- **Anti-loop** — hop counting prevents infinite ping-pong
- **Firewall traversal** — UDP wakeup + callback mechanism for NAT/corporate firewalls
- **Agent tools** — `peer_ask` (single question), `peer_chat` (multi-turn session), `peer_wakeup` (wake sleeping peer)

Configure peers in `~/.abtars/config/peers.json`.

## Boot Phases

The bridge starts in ordered phases: config → memory → transport → platforms → capabilities → heartbeat → sleep → dashboard. Each phase is independent — if one fails, the rest continue.

## Capabilities

Optional features that load at boot if their requirements are met:

- **Browser** — web browsing via Playwright
- **Skills** — markdown-defined agent behaviors
- **MCP** — external tool servers via mcporter

## Heartbeat

A periodic tick (configurable interval) that runs scheduled tasks, checks model health, and triggers sleep cycles during quiet hours.
