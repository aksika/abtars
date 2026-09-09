# Peer-to-Peer (A2A)

Multiple abTARS instances can communicate directly — agent-to-agent. One instance asks another a question or delegates a task, and gets a response.

## Two lanes (caller-selected)

| Intent | Tool | Receiver | Durable work |
| --- | --- | --- | --- |
| Quick discussion / Q&A, including follow-ups | `peer_session(peer_name, message, session_id?)` | Cardless chat turn | None — no card, contract, or Orc run |
| Delegate work with durable ownership and results | `peer_ask_help(peer, goal, ...)` | Supervised execution | Proxy card, contract, review, terminal result |

A one-sentence delegation is still delegation — use `peer_ask_help`. A long
discussion is still chat — use `peer_session`. Transport reachability never
chooses the lane: both ride the authenticated WS peer route. If no route is
open you get an explicit `unavailable` error (never a silent HTTP retry);
the route owner dials out and the other side accepts.

## How it works

Each abTARS instance exposes an **Agent API** — an authenticated endpoint
(default port 7100) plus a persistent WS peer route to each enrolled peer:

```
┌──────────┐   peer_session / peer_ask_help   ┌──────────┐
│ Instance A │ ──────────────────────────────► │ Instance B │
│ (WSL)    │ ◄────────────────────────────── │  (Mac)   │
└──────────┘   response over the same route   └──────────┘
```

## Security

Two independent layers:

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **Transport** | TLS 1.3 with self-signed Ed25519 certs + cert pinning | Wire encryption |
| **Request auth** | JWT signed with Ed25519 keys | Identity verification |

Both must pass. Compromising one doesn't break the other.

## peer_session tool (quick chat)

The agent uses `peer_session` for discussion:

```
peer_session(peer_name: "peer-b", message: "What's your current sleep status?")
→ "I'm awake, last slept 6 hours ago."
```

The remote instance answers with a discussion-only turn: no tools, no memory
writes, no file or config changes, no side effects. Anything needing action
is answered with a pointer to `peer_ask_help`. Conversations persist up to
ten exchanges (20 messages) with five-minute idle expiry; pass `session_id`
for follow-ups, omit it for a new conversation.

## peer_ask_help tool (delegation)

The agent uses `peer_ask_help` to delegate durable work. The remote instance
accepts (or declines/defers) and works it through its supervised pipeline,
delivering a terminal result. See the lane table above.

## Configuration

`~/.abtars/config/peers.json`:

```json
{
  "self": {
    "name": "peer-a",
    "signingKey": "<Ed25519 private key for JWT signing>"
  },
  "peers": {
    "peer-b": {
      "host": "<peer-ip-or-hostname>",
      "port": 3100,
      "token": "<shared secret for JWT>",
      "verifyKey": "<peer-b's Ed25519 public key>",
      "certFingerprint": "SHA256:B3:9A:5D:...",
      "certPem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
    }
  }
}
```

| Field | Purpose |
|-------|---------|
| `self.name` | This instance's name |
| `peers.<name>.host` | Peer's IP/hostname |
| `peers.<name>.port` | Peer's Agent API port (default 3100) |
| `peers.<name>.token` | Shared secret for JWT auth |
| `peers.<name>.verifyKey` | Peer's public key for JWT verification |
| `peers.<name>.maxClass` | Disclosure ceiling 0–3 (default 0 when absent; invalid values also default to 0). Effective A2A recall cap is min(maxClass, 2) — SECRET never leaves. |
| `peers.<name>.certFingerprint` | Peer's TLS cert SHA-256 fingerprint |
| `peers.<name>.certPem` | Peer's full TLS certificate (PEM) |

A peer only ever receives memories at or below its `maxClass` through the
peer-identity recall boundary (absent or invalid `maxClass` means 0,
UNCLASSIFIED-only). `maxClass` is a disclosure ceiling, not a permission:
class-2 rows still require ownership by the recalling peer principal, and it
enables no recall on the tool-free lane-1 chat turn. SECRET (3) is never
returned to a peer at any level.

## Setting up TLS certificates

See the [TLS Certificate Setup](/abtars/peers-tls) guide for step-by-step instructions.

## Use cases

- **Cross-host delegation:** "Ask peer to check if Ollama is running"
- **Information sharing:** "What did you tell the user last?"
- **Coordinated tasks:** One instance triggers work on another
- **Health checks:** Verify a peer is alive and responsive
