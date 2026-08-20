# COOKIES.md — Twitter/X cookies (human guide)

Full-mode commands (`--feed`, `--timeline`, `--search`, `--replies`) need an
authenticated X session. Without cookies the script exits 2 with
`Twitter cookies not configured` and the daily-ai briefing reports
"X/Twitter feed: FAILED — cookie/auth session error".

This is a **manual, human-only step** — nobody on the machine can export your
browser session but you.

## How to export

1. Log in to `x.com` in a desktop browser (use the account that follows the
   briefing feeds).
2. Open DevTools (`F12`) → **Application** tab → **Cookies** → `https://x.com`.
3. Copy the values of these cookies:
   - `auth_token` — **required** (session token)
   - `ct0` — **required** (CSRF token)
   - optional but helpful: `kdt`, `twid`
4. Build a flat JSON object and save it (see below).

```json
{"auth_token":"...","ct0":"...","kdt":"...","twid":"..."}
```

## Where to store it

**Path (on Molty):** `~/.abtars/secret/x-cookies.json` (dir `700`, file `600`).

The script accepts the file either as **plaintext JSON** (simplest — the reader
uses it as-is when there is no `ENC:` prefix) or as an **`ENC:`-encrypted blob**
(same format as other abtars secrets: AES-256-GCM with
`~/.abtars/config/abtars.key`, HKDF purpose `abtars-secrets-v1`).

Plaintext write (via SSH into Molty):

```bash
mkdir -p ~/.abtars/secret
cat > ~/.abtars/secret/x-cookies.json <<'EOF'
{"auth_token":"REPLACE_ME","ct0":"REPLACE_ME"}
EOF
chmod 600 ~/.abtars/secret/x-cookies.json
```

Do **not** commit this file anywhere — it is a live session credential.

## Verify

```bash
node ~/.abtars/skills/core/twitterX/scripts/abtars-tweet.js --feed
```

Expected: tweet output, no exit code 2. A zero-item result with a cookie/auth
error means the session is invalid — re-export.

## When to refresh

X rotates session cookies (password change, logout, or roughly every few
months). Whenever the daily briefing's Stats section shows the X/Twitter lane
failed with an auth/cookie error, repeat the export and overwrite the file.
