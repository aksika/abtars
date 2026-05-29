# Peer-to-Peer (A2A)

Multiple abTARS instances can communicate directly — agent-to-agent. One instance asks another a question or delegates a task, and gets a response.

## How it works

Each abTARS instance exposes an **Agent API** — an authenticated HTTPS endpoint on port 3100. Other instances call it using the `peer_ask` tool.

```
┌──────────┐   peer_ask    ┌──────────┐
│ Instance A │ ──────────► │ Instance B │
│ (WSL)    │ ◄──────────── │  (Mac)   │
└──────────┘   response    └──────────┘
```

## Security

Two independent layers:

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **Transport** | TLS 1.3 with self-signed Ed25519 certs + cert pinning | Wire encryption |
| **Request auth** | JWT signed with Ed25519 keys | Identity verification |

Both must pass. Compromising one doesn't break the other.

## peer_ask tool

The agent uses `peer_ask` to talk to another instance:

```
peer_ask(peer: "molty", message: "What's your current sleep status?")
→ "I'm awake, last slept 6 hours ago."
```

The remote instance processes the message through its full agent pipeline (model, memory, tools) and returns the response.

## Configuration

`~/.abtars/config/peers.json`:

```json
{
  "self": {
    "name": "kp",
    "signingKey": "<Ed25519 private key for JWT signing>"
  },
  "peers": {
    "molty": {
      "host": "<peer-ip-or-hostname>",
      "port": 3100,
      "token": "<shared secret for JWT>",
      "verifyKey": "<molty's Ed25519 public key>",
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
| `peers.<name>.certFingerprint` | Peer's TLS cert SHA-256 fingerprint |
| `peers.<name>.certPem` | Peer's full TLS certificate (PEM) |

## Setting up TLS certificates

See the [TLS Certificate Setup](/abtars/peers-tls) guide for step-by-step instructions.

## Use cases

- **Cross-host delegation:** "Ask peer to check if Ollama is running"
- **Information sharing:** "What did you tell the user last?"
- **Coordinated tasks:** One instance triggers work on another
- **Health checks:** Verify a peer is alive and responsive
