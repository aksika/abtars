# Security Hardening Plan

> Generated: 2026-04-05 after studying NemoClaw's security model.
> These are security improvements identified by comparing AgentBridge's
> attack surface against NemoClaw's 4-layer defense (network, filesystem, process, inference).

---

## High Priority

### 1. Credential redaction in logs

**Problem:** `bridge.log` could contain API keys if the agent echoes env vars via `execute_bash`, or if an error message includes a token. The self-healer scans logs and could inject secrets back into the conversation.

**What NemoClaw does:** CLI automatically redacts secret patterns from stdout/stderr before logging.

**Action:** Add a sanitizer to `logger.ts` that strips patterns before writing to file:
- `sk-[a-zA-Z0-9]+` (OpenAI/Anthropic keys)
- `\d+:[A-Za-z0-9_-]{35,}` (Telegram bot tokens)
- `Bearer [a-zA-Z0-9._-]+`
- `NVIDIA_API_KEY=\S+`, `GROQ_API_KEY=\S+`, etc.

**Effort:** Low (~20 lines). **Risk:** None.

### 2. SSRF protection for browser agent

**Problem:** `agentbridge-browse` navigates arbitrary URLs via headless Chromium. There's a `DomainAllowlist` but no private IP check. An attacker could trick the agent into browsing:
- `http://169.254.169.254` (cloud metadata endpoint)
- `http://localhost:3000` (the dashboard)
- `http://10.0.0.1` (internal network)

**What NemoClaw does:** Full `ssrf.ts` module validates URLs against private IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, ::1, fd00::/8) and resolves DNS before connecting to catch DNS rebinding.

**Action:** Add `isPrivateIp()` check to `browser-tool.ts` navigate action. Resolve hostname to IP first, reject if private. Can adapt NemoClaw's `ssrf.ts` directly.

**Effort:** Low (~30 lines). **Risk:** None (additive check before navigation).

### 3. Security regression tests

**Problem:** Zero security-specific tests. No automated verification that secrets don't leak, inputs are validated, or known attack patterns are caught.

**What NemoClaw does:** Dedicated test files for credential exposure, path traversal, code injection, binary restrictions.

**Action:** Create `src/tests/security.test.ts` covering:
- Log sanitizer strips known secret patterns
- Prompt injection scanner catches known payloads (already has 22 patterns — test them)
- A2A API rejects oversized request bodies
- Browser agent rejects private IP URLs
- CLI tools don't pass secrets as command-line arguments (grep source for `process.env["...KEY"]` in spawn args)

**Effort:** Medium (~50-80 lines). **Risk:** None (test-only).

---

## Medium Priority

### 4. Path validation for agent-written files

**Problem:** CLI tools (`agentbridge-store`, `agentbridge-edit`, `agentbridge-todo`) write to `~/.agentbridge/` but don't validate that agent-provided paths stay within bounds. A crafted path like `../../.ssh/authorized_keys` could escape.

**What NemoClaw does:** `isWithinRoot()` function resolves paths and verifies they don't escape the expected root via `../`.

**Action:** Add `isWithinRoot(candidatePath, AGENT_BRIDGE_HOME)` check to any CLI tool that accepts a file path argument. Reject paths that resolve outside `~/.agentbridge/`.

**Effort:** Low (~15 lines shared utility + checks in CLI tools). **Risk:** Low.

### 5. Request body size limit on A2A API

**Problem:** `agent-api-server.ts` reads the full HTTP request body without any size limit. A malicious peer agent could send a multi-GB payload to exhaust memory.

**What NemoClaw does:** Input validation at every boundary.

**Action:** Add a `MAX_BODY_BYTES` constant (e.g. 1MB) and reject requests that exceed it in `readBody()`.

**Effort:** Low (~5 lines). **Risk:** None.

### 6. Credential isolation from process arguments

**Problem:** Need to verify that no CLI tool passes secret values as command-line arguments (visible in `ps aux`). Should pass env var names, not values.

**What NemoClaw does:** Passes `--credential NVIDIA_API_KEY` (env var name) not `--credential NVIDIA_API_KEY=sk-...` (value). Has regression tests enforcing this.

**Action:** Audit all `spawn()` and `execSync()` calls for secret leakage. Add regression test.

**Effort:** Low (audit + test). **Risk:** None.

---

## Not Applicable (different architecture)

These NemoClaw features don't apply because AgentBridge runs on bare metal, not in a container:
- Container sandboxing / Landlock LSM / seccomp filters
- Network namespace isolation / deny-by-default egress
- Capability drops / no-new-privileges
- Binary-scoped network rules
- Build toolchain removal
- Gateway process isolation
- Config integrity hashing (could adopt but low value for single-user local system)

---

## Implementation Order

1. **#5 Body size limit** — 5 lines, immediate DoS fix
2. **#1 Log sanitizer** — 20 lines, prevents secret leakage
3. **#2 SSRF protection** — 30 lines, prevents internal network access
4. **#4 Path validation** — 15 lines, prevents directory traversal
5. **#6 Credential audit** — audit only, no code change expected
6. **#3 Security tests** — covers all of the above with regression tests
