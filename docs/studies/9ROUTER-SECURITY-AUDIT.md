# 9Router Security Audit

**Date:** 2026-03-30
**Version audited:** Source from github.com/decolua/9router (cloned to ~/workspace/9router)
**Codebase size:** ~8,700 lines JS in src/, plus open-sse/ proxy core

## Verdict

**No malicious backdoors found.** The code is clean, readable JS with no obfuscation, no telemetry, no postinstall hooks. Safe for use as a localhost proxy.

## Clean

- No `preinstall`/`postinstall` hooks in package.json
- No telemetry, analytics, or phone-home in normal operation
- Cloud sync feature **completely commented out** in `src/shared/services/initializeCloudSync.js`
- No obfuscated code, no minified blobs, no base64-encoded payloads
- All external URLs are legitimate provider APIs (GitHub, Google, Anthropic, OpenRouter, etc.)
- The core proxy (`open-sse/`) just forwards requests — no data exfiltration

## Features Requiring Caution

### 1. MITM Proxy (`src/mitm/`)
- Installs a **root CA certificate** and hijacks DNS to intercept HTTPS traffic
- Used for tools like Cursor that don't support custom API endpoints
- Inherently dangerous — a root CA can intercept ALL HTTPS traffic
- **Recommendation:** Never enable on Molty

### 2. Tunnel Feature (`src/lib/tunnel/tunnelManager.js`)
- When enabled, spawns a Cloudflare quick tunnel via `cloudflared`
- Registers tunnel URL with `9router.com/api/tunnel/register`
- Generates public URL like `https://r<id>.9router.com`
- This is the **only code that talks to 9router.com**
- Uses hashed machine ID (`node-machine-id` + salt) for registration
- **Recommendation:** Never enable on Molty — OpenClaw talks to 9Router on localhost, and Tailscale covers remote access

### 3. OAuth Token Storage
- Stores provider tokens (GitHub Copilot, Cursor, Kiro/AWS, etc.) in local SQLite DB (`src/lib/localDb.js`)
- Can import tokens from Cursor's local leveldb storage
- Tokens stay local — not sent externally
- **Recommendation:** Acceptable for the use case, but be aware 9Router has access to all configured provider credentials

### 4. Machine ID (`src/shared/utils/machineId.js`)
- Generates hashed hardware ID via `node-machine-id`
- Only used for tunnel registration (which should stay disabled)
- Not sent anywhere in normal localhost-only operation

### 5. child_process Usage
- Extensive use across: MITM DNS config, cert installation, cloudflared spawning, 9remote management, CLI tool settings
- All for legitimate purposes — no suspicious command execution

### 6. 9Remote (`src/app/api/9remote/`)
- Can install and spawn `9remote` (separate npm package) for remote UI access
- **Recommendation:** Don't install or enable

## Molty Deployment Notes

Running as localhost-only proxy (our setup):
- Bound to `127.0.0.1:20128` via LaunchAgent
- No MITM, no tunnel, no 9remote
- Only forwards OpenClaw requests to upstream providers
- No data leaves to 9router.com

## Files of Interest for Future Audits

| File | Why |
|------|-----|
| `src/lib/tunnel/tunnelManager.js` | Only code that contacts 9router.com |
| `src/mitm/manager.js` | MITM proxy with root CA |
| `src/mitm/cert/install.js` | Certificate installation |
| `src/mitm/dns/dnsConfig.js` | DNS hijacking |
| `src/shared/utils/machineId.js` | Hardware fingerprinting |
| `src/lib/localDb.js` | Token/credential storage |
| `src/shared/services/cloudSyncScheduler.js` | Cloud sync (currently disabled) |
| `open-sse/executors/` | Provider-specific request handling |
