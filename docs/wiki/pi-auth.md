# Provider Authentication (pi-ai route)

Providers on the `pi-ai` route authenticate in one of three modes. The mode
is chosen per provider entry in `~/.abtars/config/transport.json`. Part of
the [Pi Integration](/abtars/pi) section.

## abtars-keyed (default)

The bridge holds the key. `apiKeyEnv` names a file in `~/.abtars/secret/`:

```json
"openrouter": {
  "transport": "api",
  "endpoint": "https://openrouter.ai/api/v1",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

Raw credential fields (`apiKey`, `token`, …) are rejected — keys never live
in `transport.json`. See [Secrets Vault](./secrets.md).

## Keyless local

Providers without `apiKeyEnv` (for example a local Ollama server) are used
as-is, with no credential lookup.

## Pi-managed

Pi owns the credential. The entry opts in with `authSource: "pi"` and
carries **no** `apiKeyEnv` (combining the two is rejected as ambiguous):

```json
"opencode-go": {
  "transport": "api",
  "endpoint": "https://opencode.ai/zen/go/v1",
  "authSource": "pi"
}
```

Set up the login in Pi itself (`pi auth check --provider <name>` shows
whether Pi can authenticate that provider). The bridge resolves Pi's model
catalog, checks Pi's live auth state before selecting the provider, and
dispatches requests through Pi's configured runtime — endpoint, API format,
headers, and token refresh stay Pi's business. No Pi credential value ever
appears in abtars config, logs, or status output.

Behavior notes:

- A missing login, unknown model, or failed refresh produces an actionable
  error naming the Pi remediation — the bridge never borrows another
  candidate's credential and never silently falls back to a keyless call.
- Pi-managed auth failures count as auth failures: the model is demoted and
  the next fallback candidate is tried, same as an expired API key.
- The ACP route is untouched — it keeps using its own CLI credentials or
  abtars secrets. Pi's credential store is never an ACP credential source.
- `/model` shows Pi-managed entries as such, and `/model doctor` reports
  Pi's live auth state per model instead of probing the provider over HTTP.

## Switching modes

Edit `transport.json` (or use `/model`), then restart the bridge
(`abtars restart`) or `/reset` to apply. `abtars doctor` confirms the
resulting configuration.
