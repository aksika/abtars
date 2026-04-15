# gws-cli Authentication Setup

## Prerequisites

- `gws-cli` installed via pipx: `pipx install gws-cli`
- Google Cloud project with Gmail API enabled
- OAuth 2.0 Client ID (Desktop app) — download `client_secret.json` from [Google Cloud Console](https://console.cloud.google.com/apis/credentials)

## Steps

### 1. Import credentials

```bash
gws-cli auth import-credentials /path/to/client_secret.json
```

Encrypts and stores at `~/.config/gws-cli/client_secret.json.enc`.

### 2. SSH port forward (headless Mac)

gws-cli starts a local HTTP server on port 8080-8082 for the OAuth callback. Forward a range from your laptop:

```bash
ssh -L 8080:127.0.0.1:8080 -L 8081:127.0.0.1:8081 -L 8082:127.0.0.1:8082 akos@molty
```

### 3. Run auth

```bash
gws-cli auth
```

Opens a Google OAuth URL. Copy the URL, open in browser on your laptop. Authorize, callback hits the forwarded port. Token saved at `~/.config/gws-cli/token.json`.

### 4. Verify

```bash
gws-cli auth status
# → {"status": "authenticated", "message": "Token is valid (valid)."}
```

## Scopes granted

- Gmail (modify)
- Drive
- Docs
- Sheets
- Presentations
- Calendar
- Contacts
- Directory (readonly)

## Troubleshooting

- **MismatchingStateError**: Close all browser tabs pointing to `127.0.0.1:808x`, then run `gws-cli auth` again. The old callback hits the new session causing a state mismatch.
- **Port mismatch**: gws-cli picks a random port (8080-8082). Forward the range, not just one port.
- **Re-auth**: `gws-cli auth --force` to re-authenticate.

## File locations

| File | Path |
|------|------|
| Encrypted credentials | `~/.config/gws-cli/client_secret.json.enc` |
| OAuth token | `~/.config/gws-cli/token.json` |
| Original client_secret | `~/.agentbridge/secret/client_secret.json` (backup) |
