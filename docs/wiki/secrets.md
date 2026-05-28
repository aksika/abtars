# Secrets Vault

abTARS includes a built-in encrypted vault for API keys, tokens, and session cookies. No external tools needed — no HashiCorp Vault, no AWS Secrets Manager, no 1Password CLI. Everything stays local, encrypted at rest, decrypted only in memory.

## How it works

```
~/.abtars/secret/
  OPENROUTER_API_KEY     ← AES-256-GCM encrypted at rest
  TELEGRAM_BOT_TOKEN     ← decrypted into memory at boot
  OPENAI_API_KEY         ← never touches disk in plaintext
  x-cookies.json         ← session cookies, also encrypted
```

- **Drop a file → restart → encrypted.** No commands to learn.
- **Filename = env var name.** `OPENAI_API_KEY` file → `process.env.OPENAI_API_KEY` at runtime.
- **Files with extensions** (`.json`) are accessed via tools, not env vars.
- **AES-256-GCM** encryption using a key derived from your passphrase via scrypt.
- **Same passphrase on any machine** = same key = portable encrypted backups.

## Adding a secret

```bash
echo "sk-or-abc123..." > ~/.abtars/secret/OPENROUTER_API_KEY
chmod 600 ~/.abtars/secret/OPENROUTER_API_KEY
abtars stop && abtars start
```

On restart, the file is automatically encrypted. The plaintext value is available in memory only. That's it — no `.env` entry needed.

## What makes it a vault

| Feature | How |
|---------|-----|
| **Encryption at rest** | AES-256-GCM, every file in `secret/` |
| **Auto-encrypt on ingest** | Drop plaintext → boot encrypts in-place |
| **Memory-only decryption** | Secrets never exist as plaintext on disk after first boot |
| **Passphrase-derived key** | No random key file to lose — your passphrase IS the key |
| **Portable** | Copy `secret/` to new machine + same passphrase = works |
| **Permission enforcement** | Doctor checks chmod 600 on every file |
| **Log redaction** | Secrets never appear in bridge logs (class-based redaction) |
| **Model isolation** | Agent cannot read raw secret files — only decrypted values via controlled paths |

## Passphrase for daemon mode

The bridge needs the passphrase to decrypt at boot:

1. `ABMIND_PASSPHRASE` environment variable (systemd unit, launchd plist)
2. macOS Keychain (set during `abtars passwd`)
3. Interactive prompt (only if TTY available)

## Cookie access

Files with extensions (like `x-cookies.json`) are encrypted the same way but accessed via the `cookie_read` tool instead of env vars:

```
cookie_read({ name: "x-cookies" })
→ decrypts and returns the JSON content
```

## Doctor checks

`abtars doctor` verifies:
- All secret files are `chmod 600`
- No files are empty
- Encryption is intact (ENC: prefix present)

## Commands

| Command | Purpose |
|---------|---------|
| `abtars passwd` | Set or change passphrase, re-encrypts all secrets |
| `abtars doctor` | Verify vault integrity + permissions |
