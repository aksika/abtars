# Picture / Media Support — Initial Assessment

**Backlog:** #22
**Date:** 2026-03-22

## What

Enable AgentBridge to receive and send images across Telegram and Discord.

## Directions

### Inbound (user → bot → Kiro)

1. **Telegram photos**: `message.photo` array (multiple sizes), pick largest within a size cap, download via `getFile` API
2. **Discord attachments**: `message.attachments` collection, download URL directly
3. **Forward to Kiro**: Kiro CLI accepts images via ACP (`image` content blocks in JSON-RPC). For tmux transport, save to temp file and reference in prompt (e.g. "see attached image at /tmp/ab-img-xxx.png")
4. **Memory**: optionally store image references (path + description) in memory DB — not the binary blob itself

### Outbound (Kiro → bot → user)

1. **Telegram**: `sendPhoto` API for images, `sendDocument` for other files
2. **Discord**: file attachments on message send
3. **Source**: parse Kiro responses for image paths / base64 content blocks

### Size handling

- Cap inbound images (e.g. 10MB) — reject or compress above cap
- OpenClaw pattern: JPEG re-encode with progressive quality reduction + downscale (see `tool-images.ts` `resizeImageBase64IfNeeded`)
- Use `sharp` for compression if needed (OpenClaw's proven approach)
- For memory storage: reference only (path + metadata), never store binary in SQLite

## Open questions

1. Does Kiro CLI ACP support image content blocks today, or tmux-only workaround needed?
2. Should we compress on ingest or pass through at original quality?
3. Memory integration: store image descriptions (via vision model) as extracted memories?
4. Supported formats: PNG, JPEG, WebP, GIF — anything else?
5. Video/audio: out of scope for v1?

## Complexity estimate

Medium. Telegram/Discord APIs for media are well-documented. Main work is:
- Download + size validation (~50 lines)
- Forward to Kiro transport (~30 lines per transport)
- Parse outbound images from Kiro (~40 lines)
- Send back via platform API (~30 lines per platform)
- Optional: sharp-based compression (~60 lines, can defer)

## Reference

- OpenClaw `src/agents/tool-images.ts` — image resize/compress pipeline
- OpenClaw `src/web/media.ts` — media loading, SSRF protection, size caps
- OpenClaw `src/media-understanding/attachments.cache.ts` — attachment caching pattern
- Telegram Bot API: `getFile`, `sendPhoto`, `sendDocument`
- Discord.js: `MessageAttachment`, file send
