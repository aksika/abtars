# Agent Swarm

Tell your agent one thing. It mobilizes an army.

## What is it?

Agent Swarm lets your abtars agent delegate work to parallel workers — locally (subagent sessions) or remotely (other abtars instances on different machines). The main agent acts as a team leader: it decomposes goals, assigns tasks, tracks progress on a kanban board, and delivers results when everything is done.

You stay in one conversation. The swarm works in the background.

## How it works

```
You: "Prepare my weekly investment report"

Main agent (orchestrator):
  +-- Worker A: fetch market data        (Molty — fast internet)
  +-- Worker B: analyze portfolio         (KP — has broker API)
  +-- Worker C: check news sentiment      (Molty — has RSS tools)
  |
  |   [all run in parallel on different hardware]
  |
  +-- Verifier: check outputs are coherent
  +-- Synthesizer: write final report
  |
  '-- Delivers: "Your report is ready" + attached file
```

3 minutes (parallel) vs 15 minutes (sequential). You did nothing after the first message.

## Orchestrator & Workers

The main agent is the **orchestrator**. It spawns **workers** — either local subagent sessions (same machine, cheap model) or remote peers (different hardware, specialized tools).

Workers run with isolated context (no parent history leaking) and restricted tools (can't re-delegate).

## Kanban Board

Every task lands on the kanban board. The orchestrator and workers both write to it. Check status via `/kanban`:

```
~ #1 research-ai-news (agent/HIGH)
~ #2 fetch-stock-data (agent/HIGH)
* #3 check-twitter (agent/MEDIUM)
+ #4 verify-outputs (agent/HIGH) <- #1,#2,#3
+ #5 write-report (agent/HIGH) <- #4
```

## DAG Dependencies

Tasks can depend on other tasks. A verifier won't start until all workers finish. A synthesizer won't start until the verifier approves. The reconciler handles sequencing automatically — no polling, no manual checks.

```
Worker-A --+
Worker-B --+--> Verifier --> Synthesizer
Worker-C --+
```

## Gossip Health

Peers broadcast health (load, capabilities, version) every heartbeat tick via UDP. The orchestrator uses this live peer table for routing:
- Only delegates to alive peers (no 60s timeout hitting dead hosts)
- Routes by capability ("gpu", "browser", "xcode")
- Prefers least-loaded peer

No configuration needed — auto-discovered at boot.

## Use Cases

**Research & reports** — "What happened in AI this week?" — parallel workers scan Twitter, RSS, HN, arXiv. Verifier deduplicates. Synthesizer writes a digest.

**Multi-step personal tasks** — "Book a restaurant, check weather, plan the route" — three workers in parallel, merged into one answer.

**Distributed monitoring** — KP detects an issue, delegates the fix to Molty (which has the right access). No human coordination.

**Autonomous daily routine** — Morning: finance check + news scan + weather report. All parallel. Delivered as one message when you wake up.

## Commands

| Command | What it does |
|---------|-------------|
| `/kanban` | Show active work (all sources) |
| `/kanban all` | Include delivered items |

## Cost Awareness

Each worker consumes tokens independently. Budget caps prevent runaway spending — set a max per task, and the orchestrator aborts if exceeded.

---

## Peer-to-Peer Communication

Multiple abTARS instances communicate directly — agent-to-agent. One instance asks another a question or delegates a task, and gets a response.

### Architecture

Each abTARS instance exposes an **Agent API** — an authenticated endpoint on port 3100. Other instances call it using the `peer_ask` tool or delegate tasks via `peer_delegate`.

```
+-----------+  peer_ask / delegate   +-----------+
| Instance A | ---------------------> | Instance B |
|   (WSL)   | <--------------------- |   (Mac)   |
+-----------+      response          +-----------+
```

### Security

Two independent layers:

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **Transport** | TLS 1.3 with self-signed Ed25519 certs + cert pinning | Wire encryption |
| **Request auth** | JWT signed with shared secret | Identity verification |

Both must pass. Compromising one doesn't break the other.

### peer_ask tool

The agent uses `peer_ask` to talk to another instance:

```
peer_ask(peer: "molty", message: "What's your current sleep status?")
--> "I'm awake, last slept 6 hours ago."
```

The remote instance processes the message through its full agent pipeline (model, memory, tools) and returns the response.

### peer_delegate tool

For background work — fire-and-forget with result delivery via callback:

```
peer_delegate(peer: "molty", goal: "Compile the iOS app", priority: "HIGH")
--> { local_card_id: 42, remote_task_id: 7 }
```

The remote peer completes the work and pushes the result back via callback. Local kanban card auto-updates.

### Configuration

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
      "verifyKey": "<peer's Ed25519 public key>",
      "certFingerprint": "SHA256:B3:9A:5D:...",
      "certPem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
    }
  }
}
```

| Field | Purpose |
|-------|---------|
| `self.name` | This instance's identity |
| `peers.<name>.host` | Peer's IP/hostname |
| `peers.<name>.port` | Agent API port (default 3100) |
| `peers.<name>.token` | Shared secret for JWT |
| `peers.<name>.verifyKey` | Peer's public key for JWT verification |
| `peers.<name>.certFingerprint` | Peer's TLS cert SHA-256 fingerprint |
| `peers.<name>.certPem` | Peer's full TLS certificate (PEM) |

---

## TLS Certificate Setup

How to generate and exchange certificates for secure A2A communication.

### Generate a certificate

Run on each host:

```bash
cd ~/.abtars/config
openssl req -x509 -newkey ed25519 \
  -keyout identity.tls.key \
  -out identity.crt \
  -days 3650 \
  -nodes \
  -subj "/CN=$(hostname)"
chmod 600 identity.tls.key
```

This creates a 10-year self-signed Ed25519 certificate. No CA needed.

### Get your fingerprint

```bash
openssl x509 -in ~/.abtars/config/identity.crt -fingerprint -sha256 -noout
```

### Exchange certificates

Each peer needs the other's fingerprint and certificate PEM. Send your `identity.crt` to your peer (it's not secret — it's a public certificate).

### Add peer's cert to peers.json

On **your** host, add the peer's cert info to `peers.json` under the peer's entry (`certFingerprint` + `certPem` fields). Do this on **both** hosts — each needs the other's cert.

### Verify

After restarting both bridges:

```bash
# Test the connection
curl -sk https://<peer-ip>:3100/health
```

### Troubleshooting

| Problem | Fix |
|---------|-----|
| "identity.crt not found" | Run the openssl command above |
| "agent-api starting without TLS" | Cert files missing — check paths |
| "cert fingerprint mismatch" | Wrong cert in peers.json — re-exchange |
| `abtars doctor` warns about certs | Run `chmod 600` on both cert files |

### Notes

- Certificates are valid for 10 years — no rotation needed
- The private key (`identity.tls.key`) never leaves the host
- The certificate (`identity.crt`) is safe to share — it's public
- If you regenerate a cert, exchange the new fingerprint with all peers
