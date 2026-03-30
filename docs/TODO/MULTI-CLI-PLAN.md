# Multi-CLI Support Plan (#48)

## Goal

AgentBridge works with any ACP-compatible CLI agent, not just Kiro. A single env var selects the CLI. All CLI-related config is grouped in one .env section.

## Phases

### Phase 1: Abstract CLI spawn + env restructure

**What changes:**
- `config.ts` — add `AGENT_CLI`, `AGENT_TRANSPORT`, `AGENT_MODEL`, `AGENT_BROWSE_MODEL`, `AGENT_SLEEP_MODEL`, `AGENT_CODING_MODEL`
- Old vars kept as fallbacks (backward compatible)
- `acp-transport.ts` — CLI spawn command driven by `AGENT_CLI` + `AGENT_TRANSPORT`
- `.env.example` — new grouped "Agent CLI Configuration" section
- README updated

**New .env section:**
```env
# ============================================================
# Agent CLI Configuration
# ============================================================

# Which CLI to use: "kiro" (default) or "gemini" or path to any ACP-compatible CLI
AGENT_CLI=kiro

# Transport: "acp" (recommended) or "tmux" (kiro only)
AGENT_TRANSPORT=acp

# Path to CLI binary (default: auto-detected from AGENT_CLI)
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

**Backward compatibility mapping:**
| Old var | New var | Fallback |
|---------|---------|---------|
| `KIRO_TRANSPORT` | `AGENT_TRANSPORT` | Yes |
| `KIRO_CLI_PATH` | `AGENT_CLI_PATH` | Yes |
| `KIRO_MODEL` | `AGENT_MODEL` | Yes |
| `BROWSING_AGENT` | `AGENT_BROWSE_MODEL` | Yes |
| `MEMORY_SUBAGENT_MODEL` | `AGENT_SLEEP_MODEL` | Yes |
| `CODING_AGENT_MODEL` | `AGENT_CODING_MODEL` | Yes |

**CLI spawn logic:**
```ts
function getCliCommand(config: Config): { cmd: string; args: string[] } {
  const cli = config.agentCli ?? "kiro";
  const transport = config.agentTransport ?? "acp";

  if (cli === "kiro") return { cmd: config.agentCliPath ?? "kiro-cli", args: ["acp"] };
  if (cli === "gemini") return { cmd: config.agentCliPath ?? "gemini", args: ["--experimental-acp"] };

  // Custom CLI path — pass as-is with acp flag
  return { cmd: cli, args: ["--experimental-acp"] };
}
```

**Files to change:**
- `src/components/config.ts` — add new fields, fallback logic
- `src/components/acp-transport.ts` — use `getCliCommand()`
- `src/bridge-app.ts` — pass new config fields to subagents (browse, sleep, coding)
- `.env.example` — new section
- `README.md` — update config table

### Phase 2: Gemini CLI

**Prerequisites:** Phase 1 done, Gemini CLI installed (`npm install -g @google/gemini-cli`)

**What changes:**
- Test `AGENT_CLI=gemini` with `gemini --experimental-acp`
- Verify session creation, tool calls, permission flow
- Gemini uses `AGENT_MODEL` for model selection (e.g. `gemini-2.5-pro`)
- Document in README

**Known differences from Kiro:**
- Gemini CLI uses `--experimental-acp` flag (not just `acp` subcommand)
- Model names differ (`gemini-2.5-pro` vs `claude-sonnet-4.6`)
- Permission handling may differ — needs testing
- Steering/skills format may need adaptation

**Files to change:**
- `src/components/acp-transport.ts` — handle Gemini-specific startup differences if any
- `docs/asbuilts/system.asbuilt.md` — update transport section
- `.env.example` — add Gemini example

### Phase 3: Cloud9 CLI (separate project)

Cloud9 is a standalone project. AgentBridge just needs `AGENT_CLI=cloud9` to work.
No changes to AgentBridge beyond Phase 1.

## Execution Order

1. `config.ts` — add new fields + fallback logic
2. `acp-transport.ts` — `getCliCommand()` factory
3. `bridge-app.ts` — propagate new model vars to subagents
4. `.env.example` + README
5. Tests for config fallback logic
6. Test with `AGENT_CLI=gemini`
7. Update asbuilts

## Estimated effort

Phase 1: ~50 lines code + docs
Phase 2: ~10 lines + testing
