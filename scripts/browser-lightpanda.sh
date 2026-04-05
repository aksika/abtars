#!/usr/bin/env bash
# Manage the Lightpanda browser Docker container (lazy start).
# Usage:
#   ./scripts/browser-lightpanda.sh start   # start container (pull if needed)
#   ./scripts/browser-lightpanda.sh stop    # stop + remove
#   ./scripts/browser-lightpanda.sh status  # check if running
#   ./scripts/browser-lightpanda.sh pull    # pull latest nightly
set -euo pipefail

IMAGE="lightpanda/browser:nightly"
CONTAINER="lightpanda"
PORT="${LIGHTPANDA_CDP_PORT:-9222}"

case "${1:-start}" in
  pull)
    echo "📦 Pulling $IMAGE..."
    docker pull "$IMAGE"
    ;;
  start)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
      echo "✅ $CONTAINER already running"
      exit 0
    fi
    # Start existing stopped container if it exists
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
      docker start "$CONTAINER" >/dev/null
      echo "✅ $CONTAINER started (existing)"
      exit 0
    fi
    # Pull if image not present
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "📦 Pulling $IMAGE..."
      docker pull "$IMAGE"
    fi
    docker run -d \
      --name "$CONTAINER" \
      -p "${PORT}:9222" \
      -e LIGHTPANDA_DISABLE_TELEMETRY=true \
      "$IMAGE"
    echo "✅ $CONTAINER started on port $PORT"
    ;;
  stop)
    docker stop "$CONTAINER" 2>/dev/null && docker rm "$CONTAINER" 2>/dev/null
    echo "🛑 $CONTAINER stopped"
    ;;
  status)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
      echo "running"
    else
      echo "stopped"
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|status|pull}"
    exit 1
    ;;
esac
