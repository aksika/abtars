# Kanban Board

abtars has a built-in kanban board for tracking work. The main agent acts as team leader — it picks up completed work, delivers results, and tracks everything in one place.

## How it works

```
Task runs → writes to board → main agent polls → delivers result → marks delivered
```

Any source can create cards:
- **Task scheduler** — cron tasks write automatically
- **User** — ask the agent ("remind me to X by Friday")
- **Agent** — self-assigns work, decomposes into sub-cards
- **Peer** — delegated from another host (future)

## Commands

| Command | What it shows |
|---------|---------------|
| `/kanban` | Active board (queued, running, done, failed) |
| `/kanban all` | Everything including delivered |
| `/kanban status=done` | Filter by status |
| `/kanban source=task` | Only task-scheduler cards |
| `/kanban priority=HIGH` | Urgent items |
| `/kanban type=research` | By card type |
| `/kanban labels=finance` | By tag |

## Card lifecycle

```
📥 queued → ⏳ running → 📬 done → 🚚 delivering → ✅ delivered
                           ↓
                         ❌ failed (after 3 delivery attempts or task error)
```

## Agent delivery

When a card reaches `done`:
1. Main agent picks it up on the next heartbeat tick
2. Announces completion briefly ("Your finance report is ready — see attached 📄")
3. Attaches the result file as a document
4. Marks the card `delivered`

If delivery fails (model error, rate limit), it retries up to 3 times. After 3 failures, the card is marked `failed`.

## Agent tool

The agent has a `kanban_manage` tool and can:
- Create cards: "add to my board: review the RSS output quality"
- Update cards: change priority, add labels, set deadlines
- List cards: check what's pending

## Storage

SQLite database at `~/.abtars/kanban/kanban.db`. Included in `abtars backup --config`.

Cards older than 7 days (after delivery) are automatically purged.

## Schema

Each card has: title, source, priority, status, type, labels, notes, due date, result file, parent card (for subtasks), and blocked-by (dependencies).
