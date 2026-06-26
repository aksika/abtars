# Security

abTARS uses a layered security model with progressive isolation levels.

## Security Modes

Set `SECURITY_MODE` in `~/.abtars/config/.env`:

| Mode | Level | What it does | Overhead |
|------|-------|-------------|----------|
| `off` | 0 | No restrictions | 0 |
| `guardrails` | 1 | App-level command classification + path blocking + ActionGate auth | ~0ms |
| `seatbelt` ⚠️ BETA | 2 | OS-level sandbox per bash command (bwrap / sandbox-exec) | ~5ms/cmd |
| `sandbox` | 3 | Full Docker container per session (planned) | ~2s/session |

Default: `guardrails`

## Level 1 — Guardrails

Application-level protection. Always active regardless of security mode.

- **Command classification:** dangerous commands (`rm -rf`, `git push --force`, `sudo`) are blocked or require Telegram approval via ActionGate
- **Path restrictions:** secrets (`~/.abtars/secret/`) and config blocked from bash access
- **Audit log:** all denied/gated commands logged to `~/.abtars/logs/audit.jsonl`

## Level 2 — Seatbelt (BETA)

```bash
# Enable:
echo "SECURITY_MODE=seatbelt" >> ~/.abtars/config/.env
```

Wraps every `execute_bash` tool call in OS-level sandboxing:

- **Linux:** [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) — namespace isolation
- **macOS:** `sandbox-exec` — Apple's kernel-level sandbox profiles

### What it protects

- Secrets (`~/.abtars/secret/`, `~/.abtars/config/.env`) cannot be read from bash
- Memory database (`~/.abmind/`) inaccessible
- Write access limited to workspace + /tmp
- Network controllable per session type (full, allowlist, or none)

### Requirements

- **Linux:** `sudo apt install bubblewrap` (or `dnf install bubblewrap`)
- **macOS:** built-in (no install needed)

If the tool isn't available, abTARS falls back to guardrails mode with a warning.

### Session-type policies

| Session | Filesystem | Network |
|---------|-----------|---------|
| Main (A) | Read all, write workspace/logs/tmp, deny secret writes | Full |
| Worker (W) | Read/write own session dir only | Allowlist (model providers) |
| Browse (B) | Read/write own session dir only | Full |

### Command bypass

Bare read-only commands with no arguments (`date`, `pwd`, `whoami`) skip the sandbox for performance. All other commands are sandboxed.

Destructive patterns (`rm -rf`, `git push --force`, `DROP TABLE`) still require ActionGate approval even with seatbelt active.

### Known limitations (BETA)

- `sandbox-exec` is deprecated by Apple — works today but may break on future macOS versions
- Some commands may fail due to missing path permissions — check logs for sandbox denial messages
- Network domain allowlist is enforced at app level on Linux (bwrap can't do domain-level filtering)
- bwrap version compatibility varies across distros

## Level 3 — Docker Sandbox (planned)

Full session isolation: Worker/Browse/Code sessions run inside Docker containers. Complete filesystem and process isolation. Requires Docker daemon.

Status: bridge-side infrastructure landed, container-side agent pending.

## ActionGate

Privileged commands (classified as `auth-required`) trigger a Telegram inline keyboard asking for approval before execution. Tokens expire after 120 seconds.

When seatbelt is active, non-destructive auth-required commands are auto-approved (the OS sandbox limits blast radius). Destructive patterns always require manual approval.

## Checking Security Status

```bash
abtars doctor     # shows seatbelt/Docker availability
/status           # shows active security mode in Telegram
```
