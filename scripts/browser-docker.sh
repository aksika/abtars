#!/usr/bin/env bash
# Manage the agentbridge-browser Docker container.
# Usage:
#   ./scripts/browser-docker.sh          # build + start (headless)
#   ./scripts/browser-docker.sh --headed # build + start (visible via WSLg)
#   ./scripts/browser-docker.sh stop     # stop + remove
#   ./scripts/browser-docker.sh status   # check if running
set -euo pipefail

IMAGE="agentbridge-browser"
CONTAINER="agentbridge-browser"
AB_HOME="${HOME}/.agentbridge"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOCKET_DIR="$AB_HOME/browser-socket"
HEADED=false

CMD=""
for arg in "$@"; do
  case "$arg" in
    --headed) HEADED=true ;;
    *) CMD="$arg" ;;
  esac
done

case "${CMD:-start}" in
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
    DOCKER_BUILDKIT=0 docker build -t "$IMAGE" -f "$PROJECT_DIR/docker/browser/Dockerfile" "$PROJECT_DIR" 2>&1 | tail -5

    # Stop old container if running
    docker rm -f "$CONTAINER" 2>/dev/null || true

    # Ensure socket dir exists
    mkdir -p "$SOCKET_DIR"

    # Run — mount socket dir, pass env
    echo "🚀 Starting $CONTAINER..."
    EXTRA_ARGS=""
    if [ "$HEADED" = true ]; then
      EXTRA_ARGS="-e DISPLAY=$DISPLAY -e BROWSER_HEADED=1 -v /tmp/.X11-unix:/tmp/.X11-unix"
      echo "   👁️  Headed mode — browser visible via WSLg"
    fi
    docker run -d \
      --name "$CONTAINER" \
      --restart unless-stopped \
      --user "$(id -u):$(id -g)" \
      -v "$SOCKET_DIR:/run/browser" \
      -v "$AB_HOME/titok/cookies:/run/browser/cookies:ro" \
      -e BROWSER_SOCKET_PATH=/run/browser/browser.sock \
      -e BROWSER_CHANNEL="${BROWSER_CHANNEL:-chrome}" \
      -e BROWSER_ALLOWED_DOMAINS="${BROWSER_ALLOWED_DOMAINS:-}" \
      $EXTRA_ARGS \
      "$IMAGE"

    echo "✅ Browser container running — socket at $SOCKET_DIR/browser.sock"
    ;;
  *)
    echo "Usage: $0 [start|stop|status]"
    exit 1
    ;;
esac
