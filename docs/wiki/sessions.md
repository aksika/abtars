# Sessions

abTARS supports multiple concurrent conversation sessions per platform. Each session is an isolated conversation context with its own message history.

## Concepts

**Transport session** — an actual conversation context (message history sent to the model). Created by `/session new`, switched with `/session <#>`.

**Storage session ID** — a tag written to the memory database. Used by the sleep cycle to group and extract memories per session.

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

## Commands

All session commands are **master-only**.

| Command | Description |
|---------|-------------|
| `/session` | List all sessions |
| `/session new` | Create new Main session |
| `/session new browse` | Create Browse session |
| `/session new code` | Create Code session |
| `/session new task` | Create Task session |
| `/session <#>` | Switch to session by number |
| `/session end [#]` | End session (messages kept in memory) |
| `/session kill <#>` | Kill session and wipe its messages |

## Lifecycle

### Manual sessions

Created with `/session new [type]`. Each gets its own conversation context with the appropriate system prompt (Main gets soul/greeting, Code/Browse/Task get their agent-specific prompts). Stay open until explicitly ended or killed.

### Auto-spawned sessions

When the model invokes a tool (browse, task), a sub-session is automatically created. These:
- Run inline (no context switch — responses appear in the current conversation)
- Are visible in `/session` list
- Can be killed by the user
- Auto-end after inactivity timeout (`AUTO_SESSION_TIMEOUT_MIN`, default: 60 minutes)

### End vs Kill

| | `/session end` | `/session kill` |
|---|---|---|
| Messages in memory | Kept | Wiped |
| Extracted memories | Kept | Kept |
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
| `MAX_SESSIONS` | 10 | Hard cap on concurrent sessions per platform |
| `AUTO_SESSION_TIMEOUT_MIN` | 60 | Inactivity timeout for auto-spawned sessions (0 = end immediately) |

## Memory Integration

- Messages are tagged with the session ID in the memory database
- The sleep cycle (Dreamy) only extracts memories from Main (A) sessions
- Non-Main session messages are stored but not processed for memory extraction
- `/session kill` wipes raw messages but extracted memories survive
