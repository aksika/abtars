# #45 AES Encryption for SECRET Memories

**Date:** 2026-04-15
**Status:** Planned
**Priority:** LOW
**Repo:** abmind

## Goal

Encrypt classification=3 (SECRET) memory content at rest using machine-bound AES-256-GCM. If the database file is copied to another machine or read directly, SECRET content is unreadable.

## Design Decisions

1. **Machine-bound key** — derive encryption key from `/etc/machine-id` on first run, persist to `~/.abmind/secret/abmind.key`. Copy to `~/.agentbridge/secret/abmind.key` for centralized backup.
2. **Encrypt-only lifecycle** — SECRET rows are never decrypted back to plaintext in the DB. No reclassify-from-3 path. If the agent needs a lower-classification version, it reads via `--user-override` and creates a new sanitized memory at a lower classification.
3. **`--user-override` for read** — the only decrypt path. Agent must have explicit user permission to read SECRET content.
4. **FTS5 exclusion** — encrypted rows are removed from FTS5 index. Already excluded from recall by the classification hard cap (≤ 2), so no functional loss.

## Key Derivation

```
machine_id = read("/etc/machine-id").trim()          // e.g. "e150b7283f594e85a2046bbb169a2355"
key        = PBKDF2(machine_id, salt="abmind-v1", iterations=100000, keylen=32, digest=sha256)
```

### Key file locations

- **Primary:** `~/.abmind/secret/abmind.key` (dir chmod 700, file chmod 600)
- **Backup copy:** `~/.agentbridge/secret/abmind.key` (managed by agentbridge daily backup)

### First run

1. If `~/.abmind/secret/abmind.key` exists → use it
2. Else: read `/etc/machine-id`, derive key via PBKDF2, write to `~/.abmind/secret/abmind.key`
3. If `~/.agentbridge/secret/` exists → copy key there (backup convenience)

### Fallback

- `ABMIND_KEY_FILE` env var overrides the path
- If no machine-id and no key file → refuse to store classification=3, log warning

### Key rotation

```
abmind rekey --old-key <path-to-old-keyfile>
  → read old key from file
  → read current key from ~/.abmind/secret/abmind.key
  → SELECT * FROM extracted_memories WHERE encrypted = 1
  → for each: decrypt with old key → encrypt with new key → UPDATE
  → copy new key to ~/.agentbridge/secret/abmind.key
  → report: "Re-encrypted N memories with new key"
```

## Encryption Scheme

- **Algorithm:** AES-256-GCM (authenticated — detects tampering)
- **IV:** 12 bytes random per row (crypto.randomBytes)
- **Storage format:** `base64(iv[12] + ciphertext + authTag[16])` in content columns
- **Marker:** `encrypted INTEGER DEFAULT 0` column on `extracted_memories`. 1 = content is encrypted. No prefix parsing, no ambiguity.
- **Encrypted columns:** `content_en`, `content_original`
- **Not encrypted:** metadata (id, memory_type, emotion tags, importance flags, timestamps, classification) — needed for queries and sleep maintenance
- **Key caching:** `deriveKey()` called once per process, result cached in module scope. PBKDF2 100K iterations (~100ms) only on first call.

## Flows

### Store (classification=3)

```
abmind store --translated "sk-proj-abc123..." --memory-type fact --classification 3
  → deriveKey() (cached)
  → encrypt(content_en) → encrypted blob in content_en column
  → encrypt(content_original) → encrypted blob in content_original column
  → SET encrypted = 1
  → DELETE from FTS5 index for this row
  → INSERT as normal (metadata unencrypted)
```

### Recall (normal)

```
abmind recall --translated "api key"
  → recall engine applies classification hard cap (≤ 2)
  → SECRET rows never returned
  → no decryption needed
```

### Recall (--user-override)

```
abmind recall --translated "api key" --user-override
  → recall by metadata (id, memory_type, timestamps) — not FTS5
  → deriveKey() (cached)
  → decrypt(content_en), decrypt(content_original)
  → return plaintext to caller
```

### List SECRET memories

```
abmind list-secrets
  → SELECT id, memory_type, created_at, emotion_tags, importance_flags
    FROM extracted_memories WHERE classification = 3
  → display metadata table (no content, no decryption)
  → user picks ID, then: abmind recall --memory-id 42 --user-override
```

Solves discoverability: user can find SECRET memories by metadata without needing FTS5 search on encrypted content.

### Reclassify TO 3

```
abmind edit --memory-id 42 --classification 3
  → deriveKey() (cached)
  → encrypt existing plaintext content_en, content_original
  → SET encrypted = 1
  → UPDATE row with encrypted blobs
  → DELETE from FTS5 index
```

### Reclassify FROM 3

Not supported. Agent creates a new memory at lower classification instead. The encrypted row can be deleted manually.

### Migration

```
abmind encrypt-secrets
  → SELECT * FROM extracted_memories WHERE classification = 3 AND encrypted = 0
  → for each: encrypt content_en, content_original → UPDATE, SET encrypted = 1
  → DELETE from FTS5 for these rows
  → report: "Encrypted N SECRET memories"
```

### Sleep Pipeline

Sleep (Dreamy) skips classification=3 rows. Already enforced by the classification hard cap in recall, but also explicitly: sleep candidate queries add `WHERE classification < 3`. Dreamy never sees encrypted content.

## Prerequisite: agentbridge `titok/` → `secret/` migration

Separate task. Rename `~/.agentbridge/titok/` to `~/.agentbridge/secret/`, chmod 700. Update all references:

| File | Change |
|---|---|
| `scripts/daily-backup.sh` | `titok/db.key` → `secret/db.key` |
| `scripts/doctor.sh` | `titok` → `secret` |
| `scripts/deploy.sh` | `titok/` → `secret/` |
| `scripts/browser-patchright.sh` | `titok/cookies` → `secret/cookies` |
| `src/cli/agentbridge-tweet.ts` | `titok/cookies/` → `secret/cookies/` |
| `.gitignore` | `titok/` → `secret/` |
| docs (4 files) | update references |

Runtime migration in `doctor.sh`: if `titok/` exists and `secret/` doesn't, `mv titok secret && chmod 700 secret`.

## Implementation

| Step | What | File | Effort |
|---|---|---|---|
| 1 | Key init: read/generate key, write to `~/.abmind/secret/`, copy to `~/.agentbridge/secret/` | `src/crypto.ts` | 20 min |
| 2 | `deriveKey()` — PBKDF2 from key file, cache in memory | `src/crypto.ts` | 15 min |
| 3 | `encrypt(plaintext)` / `decrypt(blob)` — AES-256-GCM | `src/crypto.ts` | 20 min |
| 4 | Migration: add `encrypted INTEGER DEFAULT 0` column | `src/db/` | 5 min |
| 5 | Hook store: encrypt on classification=3 INSERT | `src/memory-manager.ts` | 15 min |
| 6 | Hook edit: encrypt on reclassify to 3 | `src/memory-manager.ts` | 10 min |
| 7 | FTS5 exclusion for encrypted rows | `src/db/` | 10 min |
| 7 | `--user-override` decrypt in recall | `src/recall-engine.ts` | 15 min |
| 8 | `abmind list-secrets` CLI command | `src/cli/` | 15 min |
| 9 | `abmind encrypt-secrets` migration CLI | `src/cli/` | 15 min |
| 10 | `abmind rekey --old-key` CLI command | `src/cli/` | 15 min |
| 11 | Tests | `tests/crypto.test.ts` | 30 min |
| **Total** | | | **~3 hr** |

## What This Does NOT Cover

- **Full-database encryption (SQLCipher)** — overkill, adds native dependency
- **Embedding/signature encryption** — excluded from recall anyway, embeddings don't reveal content
- **Reclassify from SECRET** — by design, create new memory instead
- **macOS Keychain / OS keyring** — future enhancement if needed

## Dependencies

None. Node.js `crypto` module only.

## Risks

| Risk | Mitigation |
|---|---|
| Key file lost | Backed up in both `~/.abmind/secret/` and `~/.agentbridge/secret/` (daily backup covers agentbridge) |
| Machine-id changes (OS reinstall) | Key file persists independently. Only matters on first-ever generation. |
| WSL reset | Key file in `~/.abmind/secret/` lost if home is wiped. Restore from `~/.agentbridge/secret/` backup. `abmind rekey` if both lost. |
| No machine-id (macOS, container) | `ABMIND_KEY_FILE` env var, or manually create `~/.abmind/secret/abmind.key` |
