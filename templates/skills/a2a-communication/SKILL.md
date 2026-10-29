---
name: a2a-communication
description: Communicate with other abtars agents — quick chat or delegation
requires: abtars
---

# Peer Communication (two lanes)

Talk to other abtars instances configured in `~/.abtars/config/peers.json`.
Pick the lane explicitly — transport reachability never chooses it.

| Intent | Tool | What happens |
| --- | --- | --- |
| Quick discussion / Q&A, including follow-ups | `peer_session` | Cardless chat turn over the peer route. No card, no Orc run. |
| Delegate work with durable ownership and results | `peer_ask_help` | Supervised work: proxy card, contract, review, terminal result. |

A one-sentence delegation is still delegation (`peer_ask_help`). A long
discussion is still chat (`peer_session`).

## When to use

- You need information or action from another agent
- The user explicitly asks you to contact a peer ("ask <peer>...", "tell <peer> to...")
- A task requires capabilities only available on the other host

## When NOT to use

- The user is talking to you directly — don't forward their message to a peer unless asked
- Simple questions you can answer yourself
- Anything time-critical under 1 second (chat blocks for up to 60s)

## Usage

```
peer_session(peer_name="<peer>", message="What's the current disk usage?")
peer_session(peer_name="<peer>", message="Follow-up question", session_id="<id from previous call>")
peer_ask_help(peer="<peer>", goal="Run 'abtars status' and report back")
```

## Available peers

Peer names come from `~/.abtars/config/peers.json`. Read it with the Read
tool — never with bash. `cat`/`find` discovery chains (especially
`find ... -exec`) trigger the Telegram authorization prompt on every host
and block the turn. If no peers are configured, the peer tools return an
error listing "(none)".

## Behavior

- Chat blocks until the peer responds (up to 60s timeout); the remote side
  answers discussion-only with no tools, memory writes, or side effects.
- Chat conversations persist up to ten exchanges (20 messages) with
  five-minute idle expiry. Omit `session_id` for a new conversation; an
  unknown or expired ID returns `session_expired`.
- Delegation is accepted/declined/deferred by the receiver and tracked to a
  terminal result; poll with `peer_help_status`, cancel with
  `peer_withdraw_help`.
- Each call is logged as PEER_CALL in the bridge log.

## If a peer call fails (no open route)

Both lanes ride the authenticated WS peer route. With no open route you get
an explicit `unavailable` error — there is no direct-dial fallback. Check
route state first (`abtars doctor`, routes probe):

```
peer_doorbell(peer_name="<peer>")
```

This sends a signed UDP doorbell on port 5353 asking the peer to
(re)establish its outbound WSS connection to you, then retry the call.
The doorbell requests a route refresh, not an answer.

## Authentication

- All peer traffic uses Ed25519 request signing with the enrolled keys in
  `peers.json` (`verifyKey`); WS routes additionally pin the peer TLS cert.
- **NEVER** call a peer endpoint manually (curl/http) without proper auth.
- Always use the `peer_session` / `peer_ask_help` tools, which authenticate
  automatically. If a call is rejected, check enrollment, trust, and peer
  name mismatch — not shared secrets.

## Network topology

Peer addresses are configured in `~/.abtars/config/peers.json`. Either side
can dial out; the route is bidirectional once established, so a peer behind
a restrictive firewall stays reachable as long as it dials out.
