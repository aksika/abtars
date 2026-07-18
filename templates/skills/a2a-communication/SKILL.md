---
name: a2a-communication
description: Communicate with other abtars agents — delegate tasks, ask questions
requires: abtars
---

# Peer Communication (peer_ask)

Talk to other abtars instances configured in `~/.abtars/config/peers.json`.

## When to use

- You need information or action from another agent
- The user explicitly asks you to delegate to a peer ("ask <peer>...", "tell <peer> to...")
- A task requires capabilities only available on the other host

## When NOT to use

- The user is talking to you directly — don't forward their message to a peer unless asked
- Simple questions you can answer yourself
- Anything time-critical under 1 second (peer_ask blocks for up to 60s)

## Usage

```
peer_ask(peer_name="<peer>", prompt="What's the current disk usage?")
peer_ask(peer_name="<peer>", prompt="Run 'abtars status' and report back")
```

## Available peers

Check `~/.abtars/config/peers.json` for configured peer names. If no peers configured, the tool returns an error listing "(none)".

## Behavior

- Blocks until the peer responds (up to 60s timeout)
- Hop limit prevents infinite loops (max 12 hops across the chain)
- Each call is logged as PEER_CALL in the bridge log
- The peer processes your prompt as if a user sent it — full agent capabilities on their side

## If peer_ask fails (connection refused / timeout)

The peer may be behind a firewall that blocks inbound TCP. Use the doorbell:

```
peer_doorbell(peer_name="<peer>")
```

This sends a signed UDP doorbell on port 5353 that tells the peer to establish a direct WSS connection. Flow:
1. `peer_ask("<peer>", "your question")` → fails (ECONNREFUSED)
2. `peer_doorbell("<peer>")` → sends signed doorbell query
3. Peer receives doorbell → initiates outbound WSS connect to you
4. WSS route established — retry `peer_ask`

**Always try `peer_ask` first.** Only use `peer_doorbell` if direct call fails. The doorbell requests a WSS refresh, not a direct answer.

## Authentication (CRITICAL)

- All peer calls use **JWT-HS256** auth automatically (`peer-jwt.ts`)
- The shared secret is the `token` field in `peers.json` for each peer
- JWT is sent as `Authorization: Bearer <token>` header
- **NEVER** call a peer endpoint manually (curl/http) without JWT — you'll get 401
- Always use `peer_ask()` tool which handles signing automatically
- If you get 401 from a peer, it means auth failed — check token match, clock skew, or peer name mismatch (iss/aud)

## Network topology

Peer IPs are configured in `~/.abtars/config/peers.json`. Each entry has a `url` field with the peer's address and port.
