# Agent Swarm

Tell your agent one thing. It mobilizes an army.

## What is it?

Agent Swarm lets your abtars agent delegate work to parallel workers — locally (subagent sessions) or remotely (other abtars instances on different machines). The main agent acts as a team leader: it decomposes goals, assigns tasks, tracks progress on a kanban board, and delivers results when everything is done.

You stay in one conversation. The swarm works in the background.

## How it works

```
You: "Prepare my weekly investment report"

Main agent (orchestrator):
  ├── Worker A: fetch market data        (Molty — fast internet)
  ├── Worker B: analyze portfolio         (KP — has broker API)
  ├── Worker C: check news sentiment      (Molty — has RSS tools)
  │
  │   [all run in parallel on different hardware]
  │
  ├── Verifier: check outputs are coherent
  ├── Synthesizer: write final report
  │
  └── Delivers: "Your report is ready 📄" + attached file
```

3 minutes (parallel) vs 15 minutes (sequential). You did nothing after the first message.

## Key concepts

### Orchestrator & workers

The main agent is the **orchestrator**. It can spawn **workers** — either local subagent sessions (same machine, cheap model) or remote peers (different hardware, specialized tools).

Workers run with isolated context (no parent history leaking) and restricted tools (can't re-delegate by default).

### Kanban board

Every task lands on the [kanban board](/abtars/kanban). The orchestrator and workers both write to it. You see the full picture via `/kanban`:

```
~ #1 research-ai-news (agent/HIGH)
~ #2 fetch-stock-data (agent/HIGH)
✓ #3 check-twitter (agent/MEDIUM) 260609:0803
- #4 verify-outputs (agent/HIGH) blocked
- #5 write-report (agent/HIGH) blocked
```

### DAG dependencies

Tasks can depend on other tasks. A verifier won't start until all workers finish. A synthesizer won't start until the verifier approves. Work flows forward — no cycles.

### Cross-host delegation

Your abtars instances on different machines become specialized workers:
- One has GPU access (local models, fast inference)
- One has API keys for specific services
- One is always-on (Mac mini in a closet)

The orchestrator picks the right peer for each subtask based on what tools it has.

## Use cases

**Research & reports** — "What happened in AI this week?" → parallel workers scan Twitter, RSS, HN, arXiv. Verifier deduplicates. Synthesizer writes a digest.

**Multi-step personal tasks** — "Book a restaurant, check weather, plan the route" → three workers in parallel, merged into one answer.

**Distributed monitoring** — KP detects an issue, delegates the fix to Molty (which has the right access). No human coordination.

**Autonomous daily routine** — Morning: finance check + news scan + weather report. All parallel. Delivered as one message when you wake up.

## What you see

Your conversation stays clean. The agent says "I'm working on it" and the next thing you see is the result — with the file attached. Check `/kanban` anytime to see progress.

## Commands

| Command | What it does |
|---------|-------------|
| `/kanban` | Show active work (all sources) |
| `/kanban all` | Include delivered items |
| `/tasks` | Cron scheduler (different from kanban) |

## Configuration

No configuration needed for local delegation — it works out of the box.

For cross-host delegation: set up [peer-to-peer](/abtars/peers) connections between your abtars instances. Once peers can talk, delegation flows automatically.

## Cost awareness

Each worker consumes tokens independently. Budget caps prevent runaway spending — set a max per task, and the orchestrator aborts if exceeded. Check spend via `/kanban` cost breakdown.

## Technical details

- Local workers: `SubagentRuntime` in isolated sessions
- Remote workers: A2A REST API (`/v1/tasks` endpoints)
- State: SQLite kanban board (survives restarts)
- Auth: existing peer JWT tokens
- Depth: flat by default (no recursive delegation storms)
