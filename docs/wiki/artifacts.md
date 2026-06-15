# Artifacts

File sharing between peers in the agent swarm. Two tiers — inline for small files, S3 for large ones.

## Inline artifacts (< 1MB)

Workers and Orc exchange small files directly in task payloads. No configuration needed — works out of the box.

### Sending files to a remote worker

The Orc includes artifacts when delegating:

```
peer_delegate(peer: "molty", goal: "Run this script", artifacts: [{name: "config.json", content: "<base64>"}])
```

The remote worker finds the file at `~/.abtars/workspace/cards/<cardId>/config.json`.

### Returning files from a worker

Workers call `artifact_attach` during execution:

```
artifact_attach(path: "~/.abtars/workspace/cards/42/results.json")
```

On task completion, attached files are sent back to the originator via the callback payload.

### Limits

- Max 1MB per file (raw, before base64 encoding)
- Max 5MB total per request
- Filenames are sanitized (no path traversal)

## S3 artifact store (unlimited)

For larger files — binaries, datasets, reports. Uses any S3-compatible storage (Cloudflare R2 recommended for free tier).

### Configuration

Add to `~/.abtars/config/.env`:

```bash
ARTIFACT_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
ARTIFACT_S3_KEY=<access-key>
ARTIFACT_S3_SECRET=<secret>
ARTIFACT_S3_BUCKET=abtars-artifacts
ARTIFACT_S3_REGION=auto
```

Tools (`artifact_push`, `artifact_pull`) appear automatically after restart when endpoint is configured.

### Usage

```
# Upload a file
artifact_push(local_path: "/path/to/binary", remote_path: "shared/vanity-gen-linux")

# Download a file
artifact_pull(remote_path: "shared/vanity-gen-linux", local_path: "~/.abtars/workspace/vanity-gen")
```

### Lazy SDK install

The S3 SDK (`@aws-sdk/client-s3`) is NOT installed during `abtars install`. It installs automatically on first `artifact_push` or `artifact_pull` call (~5 second one-time delay). Subsequent calls are instant.

### Path conventions

```
cards/<cardId>/<filename>     — task-scoped (auto-cleaned with card)
shared/<filename>             — fleet-wide (binaries, configs)
reports/<date>/<filename>     — persistent outputs
```

### Cloudflare R2 free tier

- 10GB storage
- 1M writes / 10M reads per month
- Zero egress fees
- Permanent (not 12-month trial)

Set up at: https://dash.cloudflare.com → R2 → Create bucket → API tokens

## When to use which

| Scenario | Use |
|----------|-----|
| Config file for a worker task | Inline (`peer_delegate` with artifacts) |
| Worker returning a JSON result | Inline (`artifact_attach`) |
| Distributing a 50MB binary to fleet | S3 (`artifact_push` + URL in task goal) |
| Sharing a dataset between workers | S3 (`artifact_push`, workers `artifact_pull`) |
| Backing up kanban state | S3 (reports path) |
