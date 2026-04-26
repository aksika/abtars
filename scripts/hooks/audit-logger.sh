#!/usr/bin/env bash
# audit-logger.sh — Canonical hook example for agentbridge.
# Appends each hook event as a JSON line to ~/.agentbridge/logs/audit.jsonl.
#
# Install:
#   mkdir -p ~/.agentbridge/hooks && chmod 700 ~/.agentbridge/hooks
#   cp scripts/hooks/audit-logger.sh ~/.agentbridge/hooks/
#   chmod +x ~/.agentbridge/hooks/audit-logger.sh
#
# Then add to ~/.agentbridge/config/hooks.json:
#   { "enabled": true, "hooks": {
#       "BeforeMessage": [{ "name": "audit-in", "command": "~/.agentbridge/hooks/audit-logger.sh" }],
#       "AfterMessage":  [{ "name": "audit-out", "command": "~/.agentbridge/hooks/audit-logger.sh" }],
#       "AfterPrompt":   [{ "name": "audit-prompt", "command": "~/.agentbridge/hooks/audit-logger.sh" }]
#   }}

LOG="${AGENT_BRIDGE_HOME:-$HOME/.agentbridge}/logs/audit.jsonl"
mkdir -p "$(dirname "$LOG")"

# Read JSON from stdin, append to log
cat >> "$LOG"
echo >> "$LOG"
