# Custom Providers (abtars + pi)

Add a new API provider end-to-end: store the key, wire it into abtars, expose it to pi, and verify. Worked example below uses Token Harbor (`tokenharbor`) with `deepseek-v4-flash`.

## Overview

A provider is three things, each in its own place:

| Concern | Where | File |
|---------|-------|------|
| API key (encrypted at rest) | Sealed store | `~/.abtars/secret/<ENV_NAME>` |
| Endpoint + key reference | abtars provider config | `~/.abtars/config/transport.json` |
| Model metadata | abtars model catalog | `~/.abtars/config/models.json` |
| pi's own provider view (optional) | pi custom provider | `~/.pi/agent/models.json` |

The key never lives in plaintext config. The sealed store decrypts it into the
daemon's `process.env` at boot (`reloadSecrets`), and both abtars and pi read it
from there by environment-variable name.

## Step 1 — Store the API key

The filename becomes the env var name. No extension.

```bash
echo -n "<your-api-key>" > ~/.abtars/secret/TOKENHARBOR_API_KEY
chmod 600 ~/.abtars/secret/TOKENHARBOR_API_KEY
```

- `echo -n` — no trailing newline; some APIs reject keys with `\n`.
- The file is auto-encrypted (`ENC:` prefix) on next boot.
- A full restart is required for new keys — secrets load at process boot.

## Step 2 — Register the provider in abtars

Add to `providers` in `~/.abtars/config/transport.json`. The `apiKeyEnv` names
the secret file (must match exactly, no extension). Raw credential fields
(`apiKey`, `token`, `secret`, ...) are rejected by schema.

```json
{
  "providers": {
    "tokenharbor": {
      "transport": "api",
      "endpoint": "https://tokenharbor.ai/v1",
      "apiKeyEnv": "TOKENHARBOR_API_KEY"
    }
  }
}
```

## Step 3 — Add models to the abtars catalog

`~/.abtars/config/models.json` is a flat catalog keyed by model id. Each entry
lists the transports (providers) that can serve it. `cost` is per token
(`$/1M ÷ 1,000,000`).

```json
{
  "deepseek-v4-flash": {
    "contextWindow": 1000000,
    "maxOutput": 384000,
    "rank": 2,
    "cost": { "input": 1.4e-07, "output": 2.8e-07 },
    "transports": ["tokenharbor"],
    "status": "alive"
  }
}
```

Free tier variants are separate model ids with zero cost:

```json
{
  "deepseek-v4-flash:free": {
    "contextWindow": 1000000,
    "maxOutput": 384000,
    "rank": 2,
    "cost": { "input": 0.0, "output": 0.0 },
    "transports": ["tokenharbor"],
    "status": "alive"
  }
}
```

Notes:

- Use the exact model id from the provider's catalog (`/v1/models` or their
  web page). A catalog display name like "DeepSeek V4 Flash0731" is a label,
  not the id — the id is `deepseek-v4-flash`.
- A model already curated for another provider (e.g. `transports:
  ["opencode-go"]`) becomes available on the new provider simply by adding it
  to the `transports` array — do not duplicate the whole entry.

## Step 4 — Restart and switch

```bash
abtars stop --force && abtars start
```

Then switch in abtars:

```
/change            → pick provider (tokenharbor)
/model change      → pick provider → model
```

The picker ("No curated models for X yet") reads `models.json` for the chosen
provider. If the provider has no curated entries, nothing shows.

## Step 5 — pi's own provider view (optional)

When pi runs its own provider engine, add the provider to `~/.pi/agent/models.json`
so pi can resolve the key directly:

```json
{
  "providers": {
    "tokenharbor": {
      "name": "Token Harbor",
      "baseUrl": "https://tokenharbor.ai/v1",
      "api": "openai-completions",
      "apiKey": "$TOKENHARBOR_API_KEY",
      "models": [
        { "id": "deepseek-v4-flash:free", "name": "DeepSeek V4 Flash (free)", "input": ["text"] }
      ]
    }
  }
}
```

`"apiKey": "$TOKENHARBOR_API_KEY"` is pi's env-var reference — the same
mechanism pi's built-in providers use (e.g. `opencode-go` reads
`OPENCODE_API_KEY`). pi resolves it at request time from the environment it
was launched with.

Two ways to supply the key to pi:

1. **Shell export** — `export TOKENHARBOR_API_KEY=...` in the shell pi runs in.
2. **`/login`** in pi → pick the provider → paste the key (stored in
   `~/.pi/agent/auth.json`).

When pi is launched through the abtars TUI handoff (`/coding`), it inherits the
abtars daemon's full environment — so a key in the sealed store is already
visible to pi with no shell export needed.

## Step 6 — Verify

Check the provider resolves and the model is callable:

```bash
# provider shows ready + model available
abtars status

# direct API test with the stored key
KEY=$(node -e "import('$HOME/.abtars-releases/current/bundle/secrets-*.js').then(m=>console.log(m.readSecret('TOKENHARBOR_API_KEY')))")
curl -s https://tokenharbor.ai/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash:free","messages":[{"role":"user","content":"say OK"}],"max_tokens":10}'
```

The `secrets-*.js` glob works on both platforms — always expand it with
`$HOME` (never hardcode a home directory path).

A non-`200` response with a JSON error body is the provider's own gate, not a
config problem. Common ones:

| Error | Meaning | Fix |
|-------|---------|-----|
| `email_verification_required` | Account email not verified | Verify in provider dashboard |
| `balance_zero` | No credit on paid account | Top up |
| `403 Forbidden` in model health check | Same gates above, surfaced at boot | Fix at provider, then `/model health reset` |

## Gotchas

- **Key name mismatch is silent.** `apiKeyEnv: "TOKENHARBOR_API_KEY"` must equal
  the sealed file name exactly; a typo just makes the provider unavailable.
- **Restart required.** `/restart` reinits the pipeline in-process but does not
  reload secrets. New keys need `abtars stop --force && abtars start`.
- **Don't edit `.env`.** Credential-shaped vars are migrated to `secret/` on
  boot; write directly to `secret/` instead.
- **Same key, both sides.** abtars reads it via `apiKeyEnv`; pi reads it via
  `$TOKENHARBOR_API_KEY`. Both resolve the same `process.env` value.

## Device Notes (Linux vs macOS)

The steps above run on both platforms, but these specifics differ:

| Item | Linux / WSL | macOS |
|------|-------------|-------|
| abtars dir | `~/.abtars/` | `~/.abtars/` (same) |
| Releases bundle | `~/.abtars-releases/current/bundle/` | `~/.abtars-releases/current/bundle/` (same) |
| `abtars` on PATH | Already on PATH | `export PATH=/opt/homebrew/bin:$HOME/.local/bin:$HOME/.abtars/bin:$PATH` first |
| Restart | `abtars stop --force && abtars start` | same |

**macOS pitfalls:**

- **`$HOME` does not expand inside transferred scripts.** When you run a
  script on the remote host via an encoded/escaped transport, `$HOME` (or `~`)
  inside the script body stays literal and fails with `FileNotFoundError`.
  Use the expanded absolute path (`$HOME/.abtars/...` expanded on the remote,
  e.g. `/Users/<user>/.abtars/...`) inside such scripts.
- **PATH must be set per-command.** `abtars`/`abmind` live under
  `/opt/homebrew/bin` (Apple Silicon). Prefix every command with the export
  above.