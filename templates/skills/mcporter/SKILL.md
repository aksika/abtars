---
name: mcporter
description: Call external MCP servers (Context7, Linear, GitHub, Notion, etc.)
---

# mcporter — MCP Tool Access

Use `mcporter` to discover and call tools on external MCP servers.

## List available servers

```bash
mcporter list
```

## List tools on a specific server

```bash
mcporter list <server> --schema
```

## Call a tool

```bash
mcporter call <server>.<tool> key=value key2=value2
```

## Examples

```bash
# Resolve a library ID on Context7
mcporter call context7.resolve-library-id libraryName=react

# Get library docs
mcporter call context7.get-library-docs context7CompatibleLibraryID=/websites/react_dev topic=hooks

# Search Linear
mcporter call linear.search_documentation query="automations"
```

## Notes

- Config: `~/workspace/mcporter/config/mcporter.json`
- Auto-imports configs from Cursor, Claude, Codex, VS Code
- For OAuth servers, run `mcporter auth <server>` first
- Use `--output json` for machine-readable results
