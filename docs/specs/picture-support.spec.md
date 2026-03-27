# Picture / Media Support — Spec

## Overview

Accept files from Telegram/Discord, validate, save to disk, pass images to KP for analysis. Dreamy handles overnight description extraction and cleanup.

## Inbound Sources

1. **Telegram** — `message.photo`, `message.document`
2. **Discord** — `message.attachments`
3. **A2A (Agent API)** — file attachments in agent-to-agent messages

### A2A Security

A2A file transfers are **text-only**. Regardless of detected MIME type, all A2A inbound files are stored as `.txt`. No binary execution, no image rendering. The agent-api-server strips any non-text content before saving.

## Inbound Flow

```
User sends photo/file on TG/Discord
  → Adapter downloads raw bytes
  → media-utils.ts: validate magic bytes → detect MIME → assign extension → save
  → Pipeline: if image → send as [{ type: "image", data: base64 }, { type: "text", text: caption }] to ACP
            : if non-image → send as [{ type: "text", text: "[File received: name.ext, N bytes]" }]
  → KP responds (analyzes image or acknowledges file)
```

## File Storage

- `~/.agentbridge/received/media/` — images and files from Telegram/Discord (user-to-agent)
- `~/.agentbridge/received/files/` — text files from A2A agents (always `.txt`)

Cleanup: Dreamy checks total size of `~/.agentbridge/received/`. If >100MB, delete oldest files (FIFO) across both subdirs until under 100MB.

Filename: `YYYYMMDD_HHMMSS_<chatId>_<6hex>.<ext>`
- Example: `20260327_211300_7773842843_a3f1b2.jpg`
- `<6hex>` = `randomBytes(3).toString("hex")` — prevents filename guessing
- `<ext>` = determined by magic bytes, NOT by claimed filename/extension

## Security

### Magic Byte Detection

Use `file-type` npm package (`fileTypeFromBuffer`) — same as OpenClaw. Returns `{ ext, mime }` from buffer content.

Reference: OpenClaw `src/media/mime.ts` uses `fileTypeFromBuffer` with fallback to extension mapping.

### Extension Assignment

| Detected MIME | Extension | Sent to ACP as |
|---------------|-----------|----------------|
| `image/jpeg` | `.jpg` | image (base64) |
| `image/png` | `.png` | image (base64) |
| `image/webp` | `.webp` | image (base64) |
| `image/gif` | `.gif` | image (base64) |
| `application/pdf` | `.pdf` | text placeholder |
| `text/*` | `.txt` | text placeholder |
| anything else / undetected | `.bin` | text placeholder |

### Validation Rules

1. **Magic bytes first** — detect MIME from buffer using `file-type` package, ignore claimed content-type
2. **Fallback chain** (like OpenClaw): sniff buffer → if generic (octet-stream/zip), fall back to file extension → fall back to claimed header
3. **MIME vs claimed mismatch** — log warning, use detected MIME (not claimed)
4. **Max file size** — 16MB. Reject larger files with user-facing message.
5. **No path traversal** — filename is generated server-side, never from user input

## New Files

### `src/components/media-utils.ts` (~60 lines)

```typescript
export interface SavedMedia {
  path: string;        // full path to saved file
  mime: string;        // detected MIME type
  ext: string;         // file extension (from magic bytes)
  size: number;        // bytes
  isImage: boolean;    // true if image/* MIME
}

export async function saveInboundMedia(buffer: Buffer, chatId: number): Promise<SavedMedia>
export function getMediaDir(): string
export async function cleanupMedia(maxBytes: number): Promise<number>  // returns bytes freed
```

- `saveInboundMedia`: detect MIME → assign ext → write to `media/received/`
- `cleanupMedia`: FIFO delete oldest files until total size < maxBytes (called by Dreamy)

### Changes to Existing Files

**`src/types/platform.ts`** — add to `InboundMessage`:
```typescript
imageBase64?: string;     // base64-encoded image data (for ACP prompt)
fileInfo?: { path: string; mime: string; size: number; name: string };
```

**`src/platforms/telegram-adapter.ts`** — handle `message.photo` and `message.document`:
- Download via `getFile` API → `saveInboundMedia` → set `imageBase64` or `fileInfo` on InboundMessage

**`src/platforms/discord-adapter.ts`** — handle `message.attachments`:
- Download attachment URL → `saveInboundMedia` → set `imageBase64` or `fileInfo`

**`src/components/message-pipeline.ts`** — modify prompt construction:
- If `msg.imageBase64`: send `[{ type: "image", data: base64, mimeType }, { type: "text", text }]`
- If `msg.fileInfo` (non-image): prepend `[File received: name, size]` to text prompt

**`persona/sleeping_prompt.md`** — add to Dreamy's tasks:
- Scan `media/received/` for unprocessed images
- For images not described in today's transcript: generate description via LLM, store as extracted memory
- Cleanup: if `media/received/` total > 100MB, delete oldest files (FIFO) until under 100MB

## Dependencies

- `file-type` — npm package for magic byte MIME detection (add to package.json)
- ACP `promptCapabilities.image: true` — already confirmed supported

## Stages

1. **media-utils.ts** — save, detect, cleanup (testable standalone)
2. **Telegram adapter** — download + save photos/documents
3. **Pipeline** — send images to ACP
4. **Discord adapter** — download + save attachments
5. **Sleep prompt** — Dreamy description extraction + cleanup
6. **Tests**

## Reference

OpenClaw patterns studied:
- `src/media/mime.ts` — `detectMime()` with `fileTypeFromBuffer`, extension mapping, MIME normalization
- `src/media/constants.ts` — `mediaKindFromMime()`, size limits per kind
- `src/media-understanding/types.ts` — `MediaAttachment`, `MediaUnderstandingOutput`
- `extensions/msteams/src/attachments/download.ts` — download + save + MIME validation
- `src/gateway/chat-attachments.ts` — base64 image handling, MIME sniff vs claimed validation
