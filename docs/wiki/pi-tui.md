# TUI — Terminal Interface

`abtars tui` attaches a terminal face to the always-on bridge — like `tmux attach` for your agent. It runs over a Unix socket (`~/.abtars/tui.sock`) so the headless daemon never touches a terminal; the foreground client owns the PTY and renders via Pi's TUI library.

## Requirements

- Bridge running with `TUI_ENABLED=true` (or `--tui` flag)
- `@earendil-works/pi-tui` installed (`abtars deps install`)
- A terminal that supports raw mode (SSH works, tmux works)

## Usage

```bash
abtars tui                    # resume active session, or create Main (A)
abtars tui --session 2        # switch to existing TUI session #2
abtars tui --new C            # create a new C-type session
abtars tui --orc              # attach to the Orc session (query-only)
```

`--session`, `--new`, and `--orc` are mutually exclusive.

## Attach Modes

| Mode | Effect |
|------|--------|
| `resume` (default) | Reattaches to your active TUI session, or creates a new Main (A) session |
| `--session N` | Switches to an existing TUI session by index |
| `--new [TYPE]` | Creates a fresh session (A, B, or C; defaults to A) |
| `--orc` | Attaches to the persistent Orc session — query-only, no interruption |

## Orc Mode

`--orc` sends queries to the Orc session. If Orc is busy, your input is rejected with a message (never preempts). You receive the full response when Orc is idle.

## Detachment

- **Ctrl-C / Ctrl-D** — clean detach, exit 0
- **New attach from another terminal** — supersedes the current connection; old client sees a clean detach message and exits 0
- **Bridge dies** — socket closes, client restores terminal, exits 0

All detach paths restore the terminal to its original state.

## Steering

From any attach mode, prefix your input with `/steer` to send a cooperative steering instruction to the current session:

```
/steer focus on the test file first
```

Steer is queued and consumed when the busy session reaches a safe boundary. You receive an acknowledgement (`Steer queued`) and a lifecycle update when consumed.

## Session Selector

The TUI maintains one active session at a time. Switch with `--session N` or create new ones with `--new`. Each session has independent context — switching preserves the prior session's state.

## What you see

- **Status line** — model, provider, token usage, context utilization, reasoning level
- **Message log** — scrollable conversation history with Markdown rendering
- **Editor** — text input area at the bottom
- **System messages** — session events, steer acknowledgements, activity updates (Orc mode)
