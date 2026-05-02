#!/usr/bin/env bash
# audit-logger.sh — Canonical hook example for abtars.
# Appends each hook event as a JSON line to ~/.abtars/logs/audit.jsonl.
#
# Install:
#   mkdir -p ~/.abtars/hooks && chmod 700 ~/.abtars/hooks
#   cp scripts/hooks/audit-logger.sh ~/.abtars/hooks/
#   chmod +x ~/.abtars/hooks/audit-logger.sh
#
# Then add to ~/.abtars/config/hooks.json:
#   { "enabled": true, "hooks": {
#       "BeforeMessage": [{ "name": "audit-in", "command": "~/.abtars/hooks/audit-logger.sh" }],
#       "AfterMessage":  [{ "name": "audit-out", "command": "~/.abtars/hooks/audit-logger.sh" }],
#       "AfterPrompt":   [{ "name": "audit-prompt", "command": "~/.abtars/hooks/audit-logger.sh" }]
#   }}

LOG="${ABTARS_HOME:-$HOME/.abtars}/logs/audit.jsonl"
mkdir -p "$(dirname "$LOG")"

# Read JSON from stdin, append to log
cat >> "$LOG"
echo >> "$LOG"
