# Dashboard

A localhost web UI for monitoring your bridge in real-time.

## Enabling

```bash
# ~/.abtars/config/.env
ENABLE_DASHBOARD=true
```

Starts automatically on boot. Default port: 3000 (override with `DASHBOARD_PORT`).

## Features

- Platform connection status (Telegram, Discord, IRC)
- Live context window percentage
- Cron task panel (status, next fire, last result)
- Log viewer (filterable by level)
- Memory statistics (total, by type, by classification)
- 3D Memory Universe visualization

## Memory Universe

Full-screen Three.js scene with bloom post-processing. Activated via the "🌌 Memory Universe" button.

Each memory renders as a particle in a 3D starfield:

| Visual property | Maps to | How |
|----------------|---------|-----|
| Color | classification | U=cyan, R=blue, C=amber, S=red |
| Size | recall_count | More recalled = bigger |
| Brightness | emotion_score | Positive=bright, negative=dim |
| Pulse speed | memory_type | fact=still, decision=slow, preference=medium, event=fast |
| Opacity | credibility | confirmed=solid, unknown=translucent |
| Core dot | trust | owner=bright white center |

Controls: auto-rotate, orbit (drag), click for detail panel, hover for tooltip.

## API endpoints (internal)

The dashboard serves data via HTTP:

| Endpoint | Data |
|----------|------|
| `/api/status` | Bridge health, uptime, model |
| `/api/memory/stats` | Memory counts by type |
| `/api/memory/all` | Full memory set (for 3D viz) |
| `/api/cron` | Task list with status |
| `/api/logs` | Recent log entries |

WebSocket pushes live updates (ctx%, new messages, task completions).

## Access

Local only — binds to `127.0.0.1`. Access via `http://localhost:3000` on the host machine.
