# Multi-CLI Support Plan (Kiro / Gemini CLI)

## Goal

The bridge should work with any compatible CLI agent, not just Kiro. A single env var selects the CLI. All CLI-related config is grouped in one .env section.

## Current State

CLI config is scattered across the .env:
- `KIRO_TRANSPORT` — transport mode (tmux/acp)
- `KIRO_CLI_PATH` — binary path
- `KIRO_MODEL` — model override
- `WORKING_DIR` — project directory
- `TRUST_MODE` — auto-approve
- `BROWSING_AGENT` — browse subagent model
- `MEMORY_SUBAGENT_MODEL` — sleep/memory model
- `CODING_AGENT_MODEL` — coding model

All prefixed with `KIRO_` or generic names. No way to switch to a different CLI.

## Proposed .env Structure

```env
# ============================================================
# Agent CLI Configuration
# ============================================================

# Which CLI to use: "kiro" (default) or "gemini"
AGENT_CLI=kiro

# Transport: "acp" (recommended) or "tmux" (kiro only)
AGENT_TRANSPORT=acp

# Path to CLI binary (default: auto-detected from AGENT_CLI)
#   kiro  → "kiro-cli"
#   gemini → "gemini"
# AGENT_CLI_PATH=kiro-cli

# Working directory where the agent operates
WORKING_DIR=.

# Auto-approve all agent actions (default: true)
TRUST_MODE=true

# ── Models ──────────────────────────────────────────────────
# Main conversation model
AGENT_MODEL=claude-sonnet-4.6

# Browse subagent model
AGENT_BROWSE_MODEL=claude-sonnet-4.6

# Sleep/memory subagent model
AGENT_SLEEP_MODEL=claude-opus-4.6

# Coding subagent model
AGENT_CODING_MODEL=claude-opus-4.6
```

## Implementation

### Phase 1: Env restructure (backward compatible)

1. Add new env vars (`AGENT_CLI`, `AGENT_TRANSPORT`, `AGENT_MODEL`, etc.)
2. Keep old vars as fallbacks: `KIRO_TRANSPORT` → `AGENT_TRANSPORT`, `KIRO_MODEL` → `AGENT_MODEL`, etc.
3. `config.ts` reads new vars first, falls back to old
4. Update `.env.example` with new grouped section
5. Update README

### Phase 2: Gemini CLI adapter

**Gemini CLI supports ACP natively** via `--experimental-acp` flag. Same JSON-RPC over stdio protocol as Kiro. No new transport needed.

6. In `bridge-app.ts` / `acp-transport.ts`: when `AGENT_CLI=gemini`, spawn `gemini --experimental-acp` instead of `kiro-cli acp`
7. Test with Gemini CLI — verify session creation, tool calls, permission flow
8. Gemini model set via `AGENT_MODEL` (e.g. `gemini-2.5-pro`)

### Phase 3: CLI-agnostic abstractions

10. Rename `AcpTransport` → `AgentTransport` (if protocol is shared)
11. Abstract CLI-specific quirks (session management, tool format, permission handling)
12. Update asbuilts

## Mapping: Old → New env vars

| Old | New | Fallback |
|-----|-----|----------|
| `KIRO_TRANSPORT` | `AGENT_TRANSPORT` | Yes |
| `KIRO_CLI_PATH` | `AGENT_CLI_PATH` | Yes |
| `KIRO_MODEL` | `AGENT_MODEL` | Yes |
| `BROWSING_AGENT` | `AGENT_BROWSE_MODEL` | Yes |
| `MEMORY_SUBAGENT_MODEL` | `AGENT_SLEEP_MODEL` | Yes |
| `CODING_AGENT_MODEL` | `AGENT_CODING_MODEL` | Yes |
| (new) | `AGENT_CLI` | — |

## Open Questions

- ~~Does Gemini CLI support ACP?~~ **Yes** — `gemini --experimental-acp` (same JSON-RPC over stdio as Kiro)
- Tool format differences? (Gemini uses MCP tools same as Kiro — both support `@builtin` and custom MCP servers)
- Permission model? (Gemini may handle permissions differently — needs testing)
- Gemini CLI requires `GEMINI_API_KEY` env var — needs to be in the .env section
