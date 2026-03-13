# How to Add a New Plugin/Skill to OpenClaw (for Molty)

## Checklist

Every new plugin needs ALL of these or the tools won't appear:

### 1. Plugin code
Create `~/.openclaw/extensions/<plugin-name>/`:
- `index.js` — registers tools via `api.registerTool()`
- `openclaw.plugin.json` — manifest with `name`, `version`, `main`
- `package.json` — ESM module (`"type": "module"`)

### 2. `plugins.allow` in `openclaw.json`
```json
"plugins": {
  "allow": ["...", "<plugin-name>"]
}
```
Without this, the plugin won't load at all.

### 3. `plugins.entries` in `openclaw.json`
```json
"plugins": {
  "entries": {
    "<plugin-name>": { "enabled": true }
  }
}
```

### 4. ⚠️ `tools.allow` in `openclaw.json`
```json
"tools": {
  "allow": ["...", "<plugin-name>"]
}
```
**This is the one you'll forget.** Without it, the plugin loads (you'll see `[plugins] <name>: loaded` in logs) but the model CANNOT see or use the tools. Every plugin needs to be in BOTH `plugins.allow` AND `tools.allow`.

### 5. Skill file (optional but recommended)
`~/.openclaw/workspace/skills/<plugin-name>/SKILL.md` — tells the model when/how to use the tools. With `workspaceAccess: "none"`, OpenClaw mirrors skills into the sandbox automatically (no need to maintain two copies).

### 6. TOOLS.md (optional)
`~/.openclaw/workspace/TOOLS.md` — list the tool names and descriptions. May help the model discover them, but `tools.allow` is what actually gates access.

### 7. Restart gateway
```bash
openclaw gateway restart
```
Then `/new` in the chat to start a fresh session — model picks up new tools on session start.

## Debugging

| Symptom | Cause |
|---------|-------|
| Plugin not in logs at all | Missing from `plugins.allow` or `plugins.entries` |
| `[plugins] <name>: loaded` but model says "tool not found" | **Missing from `tools.allow`** |
| Tool exists but returns errors | Check network (localhost vs host.docker.internal depending on sandbox mode) |
| Sandbox mode off → `host.docker.internal` doesn't resolve | Use `localhost` when sandbox is off |
| Sandbox mode on → `localhost` doesn't reach host | Use `host.docker.internal` |

## Network (for HTTP-based plugins)

| Sandbox mode | Hostname to use | Why |
|---|---|---|
| `"off"` | `localhost` | Agent runs on host directly |
| `"docker"` | `host.docker.internal` | Agent runs in Docker container |

If the target is on another machine, use SSH reverse tunnel (`-R port:localhost:port`) and connect to `localhost` on the Mac side.
