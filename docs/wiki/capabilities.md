# Capabilities

Self-contained subsystems that register themselves at startup. Add features without touching core bridge code.

## How it works

On boot, `discoverCapabilities()` scans `src/capabilities/` for directories with a `capability.json` manifest. Each is dynamically imported and its `register(api)` function called.

## Built-in capabilities

| Capability | What it provides |
|------------|-----------------|
| **Browser** | Browsie subagent, browse-checker heartbeat task, SSRF guard |
| **Hotskills** | Live-reload skill files, eligibility gating via `requires` frontmatter |
| **Sleep** | Dreamy spawn + retry, progress protocol |

## Adding a capability

1. Create `src/capabilities/<name>/capability.json`:
   ```json
   { "name": "my-feature", "description": "What it does" }
   ```

2. Create `src/capabilities/<name>/index.ts`:
   ```typescript
   import { CapabilityApi } from '../capability';

   export function register(api: CapabilityApi): void {
     // Register commands, heartbeat tasks, services
     api.registerHeartbeatTask('my-task', async () => { /* ... */ });
   }
   ```

3. Restart bridge — auto-discovered, no wiring needed.

## CapabilityApi

What a capability can register:

| Method | Purpose |
|--------|---------|
| `registerHeartbeatTask(name, fn)` | Runs every heartbeat tick (5 min) |
| `registerCommand(name, handler)` | Chat command |
| `registerService(name, service)` | Background service with start/stop lifecycle |
| `runtime` | Access to SubagentRuntime for spawning agents |

## Disabling capabilities

```bash
# ~/.abtars/config/.env
DISABLED_CAPABILITIES=browser,hotskills
```

Comma-separated names. Disabled capabilities are skipped at discovery — zero overhead.

## Replacing a capability

1. Drop a new capability directory (e.g. `browser-v2/`)
2. Disable the old one: `DISABLED_CAPABILITIES=browser`
3. Restart — old one skipped, new one loads
