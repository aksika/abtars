#!/usr/bin/env bash
# Manage the agentbridge-browser Docker container.
# Usage:
#   ./scripts/browser-docker.sh          # build + start
#   ./scripts/browser-docker.sh stop     # stop + remove
#   ./scripts/browser-docker.sh status   # check if running
set -euo pipefail

IMAGE="agentbridge-browser"
CONTAINER="agentbridge-browser"
AB_HOME="${HOME}/.agentbridge"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOCKET_DIR="$AB_HOME"

case "${1:-start}" in
  stop)
    docker rm -f "$CONTAINER" 2>/dev/null && echo "Stopped $CONTAINER" || echo "Not running"
    ;;
  status)
    docker ps --filter "name=$CONTAINER" --format "{{.Status}}" | grep -q . \
      && echo "Running" || echo "Not running"
    ;;
  start|"")
    # Build
    echo "🔨 Building $IMAGE..."
    docker build -t "$IMAGE" -f "$PROJECT_DIR/docker/browser/Dockerfile" "$PROJECT_DIR"

    # Stop old container if running
    docker rm -f "$CONTAINER" 2>/dev/null || true

    # Ensure socket dir exists
    mkdir -p "$SOCKET_DIR"

    # Run — mount socket dir, pass env
    echo "🚀 Starting $CONTAINER..."
    docker run -d \
      --name "$CONTAINER" \
      --restart unless-stopped \
      -v "$SOCKET_DIR:/run/browser" \
      -e BROWSER_SOCKET_PATH=/run/browser/browser.sock \
      -e BROWSER_CHANNEL="${BROWSER_CHANNEL:-chrome}" \
      -e BROWSER_ALLOWED_DOMAINS="${BROWSER_ALLOWED_DOMAINS:-}" \
      "$IMAGE"

    echo "✅ Browser container running — socket at $SOCKET_DIR/browser.sock"
    ;;
  *)
    echo "Usage: $0 [start|stop|status]"
    exit 1
    ;;
esac
