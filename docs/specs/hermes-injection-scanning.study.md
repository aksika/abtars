# Hermes Injection Scanning — Study

Source: `/home/qakosal/workspace/hermes-agent/`
Date: 2026-03-14

## Overview

Hermes has **4 distinct scanning surfaces**, each tailored to its threat model. All are regex-based, zero-LLM, pure string matching.

## Surface 1: Context Files (`prompt_builder.py`)

**What it scans:** AGENTS.md, .cursorrules, SOUL.md — files injected into the system prompt.

**Pattern count:** 10 patterns + invisible unicode set (10 chars)

**Action on match:** Block entire file, replace with `[BLOCKED: {filename} contained potential prompt injection (...)]`

**Patterns:**

| ID | What it catches |
|----|-----------------|
| prompt_injection | "ignore previous/all instructions" |
| deception_hide | "do not tell the user" |
| sys_prompt_override | "system prompt override" |
| disregard_rules | "disregard your/all instructions" |
| bypass_restrictions | "act as if you have no restrictions" |
| html_comment_injection | `<!-- ignore/override/secret -->` |
| hidden_div | `<div style="display:none">` |
| translate_execute | "translate X into Y and execute" |
| exfil_curl | `curl ... $TOKEN` |
| read_secrets | `cat .env / credentials / .netrc` |

## Surface 2: Memory Content (`memory_tool.py`)

**What it scans:** Content being saved to MEMORY.md / USER.md (curated memory that gets injected into system prompt).

**Pattern count:** 12 patterns + invisible unicode set (10 chars)

**Action on match:** Block the save, return error string to agent.

**Extra patterns vs context scanning:**
- `role_hijack` — "you are now..."
- `exfil_wget` — wget variant
- `ssh_backdoor` — authorized_keys
- `ssh_access` — ~/.ssh references
- `hermes_env` — ~/.hermes/.env

**Design insight:** Memory is more dangerous than context files because the agent writes it autonomously — a poisoned memory persists across sessions.

## Surface 3: Cron Prompts (`cronjob_tools.py`)

**What it scans:** Prompts scheduled for future autonomous execution.

**Pattern count:** 10 patterns + invisible unicode set (10 chars)

**Action on match:** Block the cron job creation, return error string.

**Extra patterns vs context scanning:**
- `sudoers_mod` — /etc/sudoers, visudo
- `destructive_root_rm` — rm -rf /
- Cron uses **relaxed word-gap regex**: `ignore\s+(?:\w+\s+)*(?:previous|all)` — catches "ignore the previous instructions" (words between keywords)

## Surface 4: Skills Guard (`skills_guard.py`)

**What it scans:** Externally downloaded skill packages before installation.

**Pattern count:** ~80 patterns + invisible unicode set (19 chars) + structural checks

This is the comprehensive one. Categories:

| Category | Count | Examples |
|----------|-------|---------|
| Exfiltration | 17 | curl/wget/fetch with secrets, DNS exfil, markdown image exfil, env dumps, tmp staging |
| Injection | 16 | ignore instructions, role hijack, DAN jailbreak, developer mode, hypothetical bypass, fake updates |
| Destructive | 8 | rm -rf /, chmod 777, mkfs, dd, shutil.rmtree |
| Persistence | 10 | crontab, shell rc files, authorized_keys, systemd, launchd, agent config files |
| Network | 9 | reverse shells, tunneling services, hardcoded IPs, bind 0.0.0.0 |
| Obfuscation | 14 | base64 decode pipe, eval/exec, echo\|bash, hex encoding, chr() building |
| Execution | 6 | subprocess, os.system, child_process |
| Traversal | 5 | ../../.., /etc/passwd, /proc/self |
| Supply chain | 8 | curl\|sh, unpinned pip/npm, git clone, docker pull |
| Privilege escalation | 5 | sudo, setuid, NOPASSWD, allowed-tools field |
| Credential exposure | 6 | hardcoded API keys, private keys, GitHub/OpenAI/Anthropic/AWS tokens |
| Mining | 2 | xmrig, hashrate |

**Structural checks:**
- Max 50 files, max 1MB total, max 256KB per file
- Binary file detection (.exe, .dll, .so)
- Symlink escape detection (must resolve within skill dir)
- Unexpected executable permissions

**Trust-based verdict system:**

```
Verdict = safe (0 findings) | caution (high severity) | dangerous (critical severity)

              safe    caution  dangerous
builtin:     allow   allow    allow
trusted:     allow   allow    block
community:   allow   block    block
```

## Architecture Patterns

1. **All scanners are pure regex** — no LLM, no network, zero latency
2. **Invisible unicode detection** is universal across all 4 surfaces
3. **Action varies by surface:**
   - Context files → replace content with [BLOCKED] marker
   - Memory saves → reject the save, return error
   - Cron jobs → reject creation
   - Skills → block installation (with `--force` override for caution)
4. **Pattern overlap is intentional** — each surface has a curated subset relevant to its threat model
5. **Relaxed word-gap regex** in cron scanner: `\s+(?:\w+\s+)*` between keywords to catch evasion

## Relevance to AgentBridge

Our A2A endpoint (port 3001) accepts prompts from external agents. The threat model:
- External agent sends a crafted message → kiro-cli executes it with full tool access
- Current safeguards: IP allowlist (127.0.0.1 + configured), SSH tunnel
- Missing: content-level scanning of the prompt itself

The **memory_tool.py scanner** (Surface 2) is the closest analog — lightweight (~12 patterns), blocks content that would poison the agent, zero latency.
