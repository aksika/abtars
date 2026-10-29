# Sleep System (Dreamy)

Dreamy is the nightly memory maintenance agent. After bedtime, it processes the day's conversations — grouping them into topic episodes, promoting durable knowledge, and pruning raw data only after its evidence is preserved.

## How it triggers

A scheduled `sleep-cycle` system task fires the cycle. Dreamy runs as its own
Pi session; the bridge pumps provider completions and polls daemon progress
until the run settles.

- Manual run: `/sleep now` starts a full fresh cycle
- After a failure: `/sleep resume` retries the failed run
- If the bridge restarts and sleep hasn't run today, it catches up on the next quiet period

## Quality levels

| Level | When |
|-------|------|
| `normal` | Default (`SLEEP_QUALITY=normal`) |
| `ultimate` | Full fresh cycle (`/sleep now`) |

## Configuration

```bash
# ~/.abtars/config/.env
SLEEP_QUALITY=normal
```

## Hardware sleep (optional, separate)

Putting the machine to sleep is a separate optional power action, not a
Dreamy step. When enabled, the bridge suspends after Dreamy completes; a
message during the grace period cancels it.

## Commands

| Command | Description |
|---------|-------------|
| `/sleep` | Show sleep status (last run, next scheduled) |
| `/sleep now` | Force a full fresh sleep cycle immediately |
| `/sleep resume` | Retry the failed run |

## Guard logic

A run starts only with daemon admission. If admission is missing or fails,
the command is rejected and nothing is spawned — a failed run stays failed
until `/sleep resume` retries it.
