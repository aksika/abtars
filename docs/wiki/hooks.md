# Hooks

Hooks let you run custom scripts at specific lifecycle events.

## Configuration

Place hook definitions in `~/.abtars/config/hooks.json`:

```json
{
  "BeforeMessage": [
    {
      "name": "my-filter",
      "command": "python3 ~/.abtars/hooks/filter.py",
      "timeout": 5000
    }
  ],
  "SessionStart": [
    {
      "name": "greet",
      "command": "echo 'Session started'",
      "timeout": 3000
    }
  ]
}
```

## Available Events

| Event | When it fires |
|-------|--------------|
| `BridgeStart` | Bridge process started, all boot nodes settled |
| `SessionStart` | New session created (`/session new`) |
| `SessionEnd` | Session ending (before reset) |
| `BeforeMessage` | Before processing a user message (the only event that can block the pipeline) |
| `AfterMessage` | After a user message is processed |
| `AfterPrompt` | After a prompt completes |

## Hook behavior

- Hooks run as shell commands
- Stdout is captured and can influence the pipeline (event-dependent)
- Timeout kills the hook process (default: 5000ms)
- Failed hooks log a warning but don't block the pipeline
- Multiple hooks per event run sequentially in array order
