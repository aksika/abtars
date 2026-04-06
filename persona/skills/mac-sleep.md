---
name: mac-sleep
description: Put the Mac to sleep immediately. Use when the owner asks to sleep/nap/shut down the machine.
user-invocable: true
---

# Put Mac to Sleep

Use `exec` to run:

```bash
~/molty/bin/sleep-mac
```

## Important

- This will immediately sleep the Mac. SSH sessions and the gateway will disconnect.
- The Mac wakes automatically at 8:00 AM via scheduled power management.
- Always confirm with the user before running — this kills all active connections.
- If the user says "shutdown" or "turn off", clarify that sleep is used instead (can't shutdown due to SSH session recovery).
