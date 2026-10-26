# Sessions

abTARS supports multiple concurrent conversation sessions per platform. Each session is an isolated conversation context with its own message history.

## Concepts

**Transport session** — an actual conversation context (message history sent to the model). Created by `/session new`, switched with `/session <#>`.

**Storage session ID** — the session key messages are archived under. The sleep cycle uses it to group episodes per session.

## Session ID Format

```
{unixTimestamp}_{type}_{shortIndex}
```

Example: `1747563282_A_01`

| Code | Type |
|------|------|
| A | Main |
| B | Browse |
| C | Code |
| T | Task |
| P | Peer |
| S | System |
| O | Orc |
| W | Worker |
| D | Dreamy |
| H | Healer |
| K | Skill |

`/session new` creates Main, Browse, Code, or Task sessions. The other
types are created by the system itself (peer traffic, scheduled work,
supervised runs, sleep, skill sessions).

## Commands

Session commands are available to all roles (destructive resets stay
owner-gated elsewhere).

| Command | Description |
|---------|-------------|
| `/session` | List all sessions |
| `/session new` | Create new Main session |
| `/session new browse` | Create Browse session |
| `/session new code` | Create Code session |
| `/session new task` | Create Task session |
| `/session <#>` | Switch to session by number |
| `/session end [#]` | End session (defaults to the active one) |
| `/session kill <#>` | Kill session by number (required) |
| `/session pause [#]` | Pause session (defaults to the active one) |
| `/session resume [#]` | Resume a paused session (defaults to the active one) |

## Lifecycle

### Manual sessions

Created with `/session new [browse|code|task]`. Each gets its own conversation context: Main sessions greet on creation and carry the role SOUL bundle once as the Pi session system prompt (never re-injected per turn). Sessions stay open until explicitly ended or killed.

### Auto-spawned sessions

When the model invokes a tool (browse, task), a sub-session is automatically created. These:
- Run inline (no context switch — responses appear in the current conversation)
- Are visible in `/session` list
- Can be killed by the user

### End vs Kill

| | `/session end` | `/session kill` |
|---|---|---|
| Session state | Marked ended | Marked ended |
| Messages in memory | Kept | Kept — message deletion is owner-side; kill does not reach into storage |
| Extracted memories | Kept | Kept (the legacy `extracted_memories` store is retired) |
| Session removed | Yes | Yes |

## Rules

- At least one Main session must be active per platform at all times
- Killing the last Main auto-creates a fresh replacement
- `/session end` on the last Main resets it (clears history, creates new)
- Sessions are per-platform (Telegram and Discord have separate session lists)
- Bridge restart clears all sessions (fresh Main #1 on reconnect)
- Short index is monotonic per bridge lifetime (never reused)

## Configuration

| Env variable | Default | Description |
|---|---|---|
| `MAX_SESSIONS` | 10 | Hard cap on concurrent sessions per user |
| `MAX_TOTAL_SESSIONS` | 12 | Hard cap on concurrent sessions globally |

## Memory Integration

- Messages are archived to memory as they are recorded
- The sleep cycle (Dreamy) builds topic episodes from Main (A) sessions
- Non-Main session messages are stored but not used for episode grouping
- `/session kill` ends the session without reaching into memory storage
