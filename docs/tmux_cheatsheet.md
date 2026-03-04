# tmux Cheatsheet

The prefix key is `Ctrl+B` — press it first, then the command key.

## Sessions

| Command | Description |
|---------|-------------|
| `tmux new -s name` | Create a new named session |
| `tmux ls` | List all sessions |
| `tmux attach -t name` | Attach to a session |
| `tmux kill-session -t name` | Kill a session |
| `tmux has-session -t name` | Check if session exists (exit code) |
| `Ctrl+B` then `d` | Detach from current session |
| `Ctrl+B` then `$` | Rename current session |
| `Ctrl+B` then `s` | Switch between sessions (interactive) |

## Windows (tabs inside a session)

| Command | Description |
|---------|-------------|
| `Ctrl+B` then `c` | Create new window |
| `Ctrl+B` then `n` | Next window |
| `Ctrl+B` then `p` | Previous window |
| `Ctrl+B` then `0-9` | Jump to window by number |
| `Ctrl+B` then `,` | Rename current window |
| `Ctrl+B` then `&` | Kill current window |
| `Ctrl+B` then `w` | List windows (interactive picker) |

## Panes (splits inside a window)

| Command | Description |
|---------|-------------|
| `Ctrl+B` then `%` | Split vertically (left/right) |
| `Ctrl+B` then `"` | Split horizontally (top/bottom) |
| `Ctrl+B` then arrow key | Move between panes |
| `Ctrl+B` then `z` | Toggle pane zoom (fullscreen) |
| `Ctrl+B` then `x` | Kill current pane |
| `Ctrl+B` then `q` | Show pane numbers (press number to jump) |
| `Ctrl+B` then `{` | Swap pane left |
| `Ctrl+B` then `}` | Swap pane right |
| `Ctrl+B` then `Space` | Cycle pane layouts |

## Copy/Scroll Mode

| Command | Description |
|---------|-------------|
| `Ctrl+B` then `[` | Enter scroll/copy mode |
| `q` | Exit scroll mode |
| Arrow keys / PgUp / PgDn | Scroll in copy mode |
| `Space` | Start selection (in copy mode) |
| `Enter` | Copy selection and exit copy mode |
| `Ctrl+B` then `]` | Paste buffer |

## Programmatic (used by the bridge)

| Command | Description |
|---------|-------------|
| `tmux send-keys -t name 'cmd' Enter` | Type a command into a session |
| `tmux send-keys -t name C-c` | Send Ctrl+C (cancel) |
| `tmux capture-pane -t name -p` | Print pane contents to stdout |
| `tmux capture-pane -t name -p -S -50` | Capture last 50 lines |
| `tmux capture-pane -t name -p -S -500` | Capture last 500 lines |

## Useful Combos

```bash
# Start kiro-cli in a session
tmux new -d -s kiro-bridge 'kiro-cli'

# Send a message to kiro
tmux send-keys -t kiro-bridge 'fix the bug in auth.ts' Enter

# Wait then read the response
sleep 5
tmux capture-pane -t kiro-bridge -p -S -100

# Cancel a running command
tmux send-keys -t kiro-bridge C-c

# Kill everything
tmux kill-session -t kiro-bridge
```

## Config (~/.tmux.conf)

```bash
# Enable mouse support (scroll, click panes, resize)
set -g mouse on

# Increase scrollback buffer (default is 2000)
set -g history-limit 50000

# Start window numbering at 1
set -g base-index 1
```

Reload config without restarting: `tmux source-file ~/.tmux.conf`
