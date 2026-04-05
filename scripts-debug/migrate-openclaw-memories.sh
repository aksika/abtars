#!/usr/bin/env bash
# Migrate OpenClaw Molty memories → AgentBridge NewMolty
# Run on Mac: bash migrate-openclaw-memories.sh

set -euo pipefail
AB="$HOME/.agentbridge"
STORE="$AB/bin/agentbridge-store"

echo "Migrating 7 memories from OpenClaw..."

# p4: Jokes preference
"$STORE" \
  --translated "Jokes and riddles: English only, interactive guessing (2-3 guesses before reveal), max 1/day, funny professor style, 1 question per message" \
  --original "Jokes and riddles: English only, interactive guessing (2-3 guesses before reveal), max 1/day, funny professor style, 1 question per message" \
  --memory-type preference --emotion-score 2 --chat-id 1 \
  --trust 2 --integrity 2 --credibility 2 --classification 1

# p5: Alexa English-only
"$STORE" \
  --translated "Alexa interaction must be English-only — no Hungarian voice commands or TTS" \
  --original "Alexa interaction must be English-only — no Hungarian voice commands or TTS" \
  --memory-type preference --emotion-score 1 --chat-id 1 \
  --trust 2 --integrity 2 --credibility 2 --classification 1

# p7: Bedtime routine order
"$STORE" \
  --translated "Bedtime routine shutdown order: LED strip OFF, xmas_bulbs_socket_1 OFF, kitchen_lamp_socket_1 OFF, kalyha_socket_1 OFF" \
  --original "Bedtime routine shutdown order: LED strip OFF, xmas_bulbs_socket_1 OFF, kitchen_lamp_socket_1 OFF, kalyha_socket_1 OFF" \
  --memory-type preference --emotion-score 1 --chat-id 1 \
  --trust 2 --integrity 2 --credibility 2 --classification 1

# f2: HA devices
"$STORE" \
  --translated "Home Assistant devices: LED strip, xmas_bulbs_socket_1, kitchen_lamp_socket_1, kalyha_socket_1, media_player.echo_akos" \
  --original "Home Assistant devices: LED strip, xmas_bulbs_socket_1, kitchen_lamp_socket_1, kalyha_socket_1, media_player.echo_akos" \
  --memory-type fact --emotion-score 0 --chat-id 1 \
  --trust 3 --integrity 3 --credibility 3 --classification 1

# d3: Changelog rule
"$STORE" \
  --translated "Always include changelog or what-changed summary when reporting updates (OpenClaw, files, system)" \
  --original "Always include changelog or what-changed summary when reporting updates (OpenClaw, files, system)" \
  --memory-type decision --emotion-score 1 --chat-id 1 \
  --trust 2 --integrity 2 --credibility 2 --classification 1

# l1: Single speak per reply
"$STORE" \
  --translated "Never send multiple TTS speaks per reply — user complained about repetitions. One speak per response only." \
  --original "Never send multiple TTS speaks per reply — user complained about repetitions. One speak per response only." \
  --memory-type lesson --emotion-score -3 --chat-id 1 \
  --trust 2 --integrity 2 --credibility 2 --classification 1

# f1 (refined): Alexa device name — existing #6 is about API, this adds the human name
"$STORE" \
  --translated "Alexa device human name: Echo Akos (entity: media_player.echo_akos). CLI: alexacli command -d Echo Akos" \
  --original "Alexa device human name: Echo Akos (entity: media_player.echo_akos). CLI: alexacli command -d Echo Akos" \
  --memory-type fact --emotion-score 0 --chat-id 1 \
  --trust 3 --integrity 3 --credibility 3 --classification 1

echo "Done — 7 memories migrated."
