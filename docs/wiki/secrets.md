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
echo -n "sk-or-abc123..." > ~/.abtars/secret/OPENROUTER_API_KEY
chmod 600 ~/.abtars/secret/OPENROUTER_API_KEY
abtars stop --force && abtars start
```

On restart, the file is automatically encrypted. The plaintext value is available in memory only. That's it — no `.env` entry needed.

> **Use `echo -n`** (no trailing newline). Some APIs reject keys with `\n` appended.

> **Full process restart required.** Secrets load at process boot (module init). The Telegram `/restart` command reinits the pipeline in-process but does NOT reload secrets. Always use `abtars stop --force && abtars start` (or the watchdog restart) for new keys.

## Never store credentials in .env

`~/.abtars/secret/<ENV_NAME>` is the **only** place API keys and provider credentials belong. Do not write them to `~/.abtars/config/.env`, `.env.skills`, or any other plaintext file.

- Credential-shaped variables (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_ID`) found in `.env` / `.env.skills` are migrated to `secret/` on boot and removed from the plaintext file.
- If the same key already exists in `secret/` with a different value, the stored value wins, the plaintext copy is removed, and a redacted conflict warning is issued. **Rotate the value** — if the plaintext was written by an operator, it was exposed on disk and must be treated as compromised.
- Conflicting plaintext values with no stored secret are **not** resolved automatically: the affected provider is disabled for that boot and a rotation is required.
- `WEB_AUTH` is the one documented exception — it lives in `.env` and is managed by the dashboard setup.

The migration exists to recover misconfiguration, not as a workflow. Write keys directly to `secret/`.

## Adding a new provider

1. Write the API key:
   ```bash
   echo -n "nvapi-abc123..." > ~/.abtars/secret/NVIDIA_API_KEY
   chmod 600 ~/.abtars/secret/NVIDIA_API_KEY
   ```

2. Add the provider to `~/.abtars/config/transport.json`:
   ```json
   "nvidia": {
     "transport": "api",
     "endpoint": "https://integrate.api.nvidia.com/v1",
     "apiKeyEnv": "NVIDIA_API_KEY"
   }
   ```

3. Add the model to `~/.abtars/config/models.json`:
   ```json
   "nvidia/nemotron-3-ultra-550b-a55b": {
     "contextWindow": 131072,
     "maxOutput": 16384,
     "rank": 1,
     "cost": { "input": 0.0, "output": 0.0 },
     "transports": ["nvidia"]
   }
   ```

4. Restart the bridge:
   ```bash
   abtars stop --force && abtars start
   ```

5. Switch to the model:
   ```
   /model nvidia/nemotron-3-ultra-550b-a55b
   ```

The `apiKeyEnv` field tells the bridge which filename in `~/.abtars/secret/` to read. The filename must match exactly (no extension). Raw secret fields (`apiKey`, `token`, `secret`, `password`, ...) are **rejected** in `transport.json` — the schema is whitelisted and credentials are only ever referenced by environment-variable name.

## Don't put keys in .env

Credential-shaped assignments in `.env` / `.env.skills` (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_ID`) are auto-migrated to `secret/` on boot. The key disappears from the plaintext file and appears encrypted in `secret/`. This is a recovery path for misconfiguration — write directly to `secret/` to skip the migration step.

If a plaintext key was ever present in `.env`, treat it as compromised and rotate it: the plaintext value sat on disk unencrypted.

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
2. macOS Keychain (set during `abmind passwd`)
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
| `abmind passwd` | Set or change passphrase, re-encrypts all secrets |
| `abtars doctor` | Verify vault integrity + permissions |
