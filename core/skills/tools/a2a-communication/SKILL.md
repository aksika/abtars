---
name: a2a-communication
description: Communicate with other abtars agents (Molty, KP) via peer_ask tool. Delegate tasks, ask questions, coordinate across instances.
requires: abtars
---

# Peer Communication (peer_ask)

Talk to other abtars instances configured in `~/.abtars/config/peers.json`.

## When to use

- You need information or action from another agent (e.g. ask Molty to check something on the Mac, ask KP to run a command on WSL)
- The user explicitly asks you to delegate to a peer ("ask molty...", "tell kp to...")
- A task requires capabilities only available on the other host

## When NOT to use

- The user is talking to you directly — don't forward their message to a peer unless asked
- Simple questions you can answer yourself
- Anything time-critical under 1 second (peer_ask blocks for up to 60s)

## Usage

```
peer_ask(peer_name="molty", prompt="What's the current disk usage on the Mac?")
peer_ask(peer_name="kp", prompt="Run 'abtars status' and report back")
```

## Available peers

Check `~/.abtars/config/peers.json` for configured peer names. If no peers configured, the tool returns an error listing "(none)".

## Behavior

- Blocks until the peer responds (up to 60s timeout)
- Hop limit prevents infinite loops (max 12 hops across the chain)
- Each call is logged as PEER_CALL in the bridge log
- The peer processes your prompt as if a user sent it — full agent capabilities on their side

## If peer_ask fails (connection refused / timeout)

The peer may be behind a firewall that blocks inbound TCP. Use the UDP wake-up:

```
peer_wakeup(peer_name="kp")
```

This sends a DNS-disguised UDP packet that tells the peer to call YOU back. Flow:
1. `peer_ask("kp", "your question")` → fails (ECONNREFUSED)
2. `peer_wakeup("kp")` → sends mDNS wake-up signal
3. KP receives wake-up → initiates outbound `callPeer("molty", "callback")` to you
4. You receive the callback and can respond

**Always try `peer_ask` first.** Only use `peer_wakeup` if direct call fails. The wake-up is a doorbell — it triggers a callback, not a direct answer to your question.

## Authentication (CRITICAL)

- All peer calls use **JWT-HS256** auth automatically (`peer-jwt.ts`)
- The shared secret is the `token` field in `peers.json` for each peer
- JWT is sent as `Authorization: Bearer <token>` header
- **NEVER** call a peer endpoint manually (curl/http) without JWT — you'll get 401
- Always use `peer_ask()` tool which handles signing automatically
- If you get 401 from a peer, it means auth failed — check token match, clock skew, or peer name mismatch (iss/aud)

## Network topology

- **molty**: `100.82.167.127:3100` (Tailscale IP, Mac)
- **IRC bridges server**: `192.168.1.128:6667` (Mac LAN IP — NOT localhost!)
- These are two different IPs for the same Mac (Tailscale vs LAN)
