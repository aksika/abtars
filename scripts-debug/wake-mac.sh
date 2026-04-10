#!/usr/bin/env bash
# Wake Mac and keep it awake via SSH + caffeinate
# Usage: ./wake-mac.sh [--stop]

SSH_KEY=~/.ssh/mac_ed25519
USER=akos
HOST=100.82.167.127
PID_FILE=/tmp/wake-mac.pid

if [ "$1" = "--stop" ]; then
  [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null && rm -f "$PID_FILE" && echo "Stopped" || echo "Not running"
  exit 0
fi

echo $$ > "$PID_FILE"
echo "Pinging $USER@$HOST every 10s until reachable, then caffeinate. Ctrl+C or --stop to kill."

while true; do
  if ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o BatchMode=yes "$USER@$HOST" "pgrep -x caffeinate >/dev/null || nohup caffeinate -d >/dev/null 2>&1 &" 2>/dev/null; then
    echo "$(date +%H:%M:%S) ✅ alive"
  else
    echo "$(date +%H:%M:%S) ❌ unreachable"
  fi
  sleep 10
done
