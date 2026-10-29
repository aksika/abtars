# Security

The current SECURITY_MODE options are off and guardrails. Operating-system sandboxing and container isolation are not active.

## Security modes

Set SECURITY_MODE in ~/.abtars/config/.env:

| Value | Current behavior |
|-------|------------------|
| off | Default. Disables the configured command authorization policy. Bridge self-protection and peer-origin restrictions still apply. |
| guardrails | Applies application-level command classification, path checks, and approval rules. |
| seatbelt or docker | Not wired as operating-system containment. These values fall back to guardrails and produce a startup warning. |

Unknown values also fall back to guardrails. Do not treat seatbelt or docker as an active sandbox.

## Guardrails

When SECURITY_MODE=guardrails, abTARS applies application-level checks to supported tool actions. Some commands may be blocked or require approval. These checks are not a substitute for operating-system isolation.

Keep API keys and other credentials in the local secret directory, and avoid granting the agent access to workspaces or tools it does not need.

## Check the configured mode

Run abtars doctor for configuration and credential checks. If SECURITY_MODE is set to seatbelt or docker, review the startup log for the fallback notice that guardrails are being used.
