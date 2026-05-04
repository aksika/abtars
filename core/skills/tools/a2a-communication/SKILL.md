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
