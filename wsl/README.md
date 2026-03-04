# WSL Scripts

Helper scripts for running agentbridge under WSL.

## Layout

- Project code: `/mnt/c/Users/qakosal/workspace/openclaw/agentbridge/`
- Runtime config & logs: `~/.agentbridge/`
  - `.env` — bot token, user IDs, transport settings
  - `bridge.log` — log file (when LOG_LEVEL != off)

## Scripts

| Script | Purpose |
|--------|---------|
| `setup.sh` | Install deps, build, create `~/.agentbridge/.env` |
| `run.sh` | Start tmux session + bridge |

## First time setup

```bash
cd /mnt/c/Users/qakosal/workspace/openclaw
chmod +x wsl/*.sh agentbridge/scripts/*.sh
./wsl/setup.sh
# Edit ~/.agentbridge/.env with your bot token and user IDs
```

## Running

```bash
./wsl/run.sh
```
