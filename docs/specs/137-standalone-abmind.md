# #137 Standalone abmind for kiro-cli via Steering File

**Date:** 2026-04-14
**Status:** Planned
**Priority:** MEDIUM
**Depends on:** #131 (done), #132 (done)

## Goal

Any kiro-cli user drops in a steering file + installs abmind → persistent memory with manual sleep.

## Deliverables

### 1. Steering file (`.kiro/steering/abmind.md`)

Teaches Kiro when/how to use abmind via `execute_bash`:
- Recall: `abmind recall --translated "keywords" --chat-id 0`
- Store: `abmind store --translated "text" --memory-type fact --chat-id 0`
- Edit: `abmind edit --memory-id <id> --boost`
- Status: `abmind status`
- Sleep: `abmind sleep-state` → review → `abmind sleep-apply --promote <ids>`
- Memory types: fact, preference, decision, event
- Rules: store non-obvious info, recall before answering, don't store derivable data

### 2. Sleep CLI commands (in abmind repo)

```bash
abmind sleep-state                          # JSON: candidates, stats
abmind sleep-prompt --step 1                # prompt text for step N
abmind sleep-apply --promote 42,43 --demote 17  # apply decisions
abmind sleep-apply --dry-run --promote 42   # preview without writing
abmind sleep-report                         # dream report markdown
```

### 3. README update (abmind repo)

Setup instructions for standalone use:
```bash
git clone github.com/aksika/abmind
cd abmind && npm install && npm run build
cp .kiro/steering/abmind.md ~/my-project/.kiro/steering/
# Start using: kiro-cli in ~/my-project/
```

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Write `.kiro/steering/abmind.md` in abmind repo | 15 min |
| 2 | Add `abmind sleep-state` CLI — dumps candidates as JSON | 20 min |
| 3 | Add `abmind sleep-apply --promote --demote --dry-run` | 20 min |
| 4 | Add `abmind sleep-report` — generates dream report | 15 min |
| 5 | Test: install abmind, copy steering file, verify kiro-cli uses it | 15 min |
| 6 | README in abmind repo — setup instructions | 15 min |
| **Total** | | **~1.5 hr** |

## How it works

Kiro-cli reads `.kiro/steering/abmind.md` on every interaction. The steering file teaches Kiro:
1. You have persistent memory via `abmind` CLI
2. When to recall (before answering questions about past)
3. When to store (user shares non-obvious info)
4. How to consolidate (manual sleep via CLI commands)

Kiro calls `abmind` via `execute_bash`. No MCP, no transport, no runtime. Just CLI.

For sleep: Kiro IS the agent. It reads candidates via `sleep-state`, thinks about them (it's the LLM), and applies decisions via `sleep-apply`. No separate Dreamy needed.
