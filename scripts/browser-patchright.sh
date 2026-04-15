#!/usr/bin/env bash
# Manage the agentbridge-browser Docker container.
# Usage:
#   ./scripts/browser-patchright.sh          # build + start (headless)
#   ./scripts/browser-patchright.sh start    # start only (no build, use existing image)
#   ./scripts/browser-patchright.sh --headed # build + start (visible via WSLg)
#   ./scripts/browser-patchright.sh stop     # stop + remove
#   ./scripts/browser-patchright.sh status   # check if running
set -euo pipefail

IMAGE="agentbridge-browser"
CONTAINER="agentbridge-browser"
AB_HOME="${HOME}/.agentbridge"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOCKET_DIR="$AB_HOME/browser-socket"
HEADED=false
SKIP_BUILD=false

CMD=""
for arg in "$@"; do
  case "$arg" in
    --headed) HEADED=true ;;
    start) CMD="start"; SKIP_BUILD=true ;;
    *) CMD="$arg" ;;
  esac
done

run_container() {
  docker rm -f "$CONTAINER" 2>/dev/null || true
  mkdir -p "$SOCKET_DIR"

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
    -v "$AB_HOME/secret/cookies:/run/browser/cookies:ro" \
    -e BROWSER_SOCKET_PATH=/run/browser/browser.sock \
    -e BROWSER_CHANNEL="${BROWSER_CHANNEL:-chrome}" \
    -e BROWSER_ALLOWED_DOMAINS="${BROWSER_ALLOWED_DOMAINS:-}" \
    $EXTRA_ARGS \
    "$IMAGE"

  echo "✅ Browser container running — socket at $SOCKET_DIR/browser.sock"
}

case "${CMD:-help}" in
  stop)
    docker rm -f "$CONTAINER" 2>/dev/null && echo "Stopped $CONTAINER" || echo "Not running"
    ;;
  status)
    docker ps --filter "name=$CONTAINER" --format "{{.Status}}" | grep -q . \
      && echo "Running" || echo "Not running"
    ;;
  start)
    run_container
    ;;
  build)
    echo "🔨 Building $IMAGE..."
    DOCKER_BUILDKIT=0 docker build -t "$IMAGE" -f "$PROJECT_DIR/docker/browser/Dockerfile" "$PROJECT_DIR" 2>&1 | tail -5
    run_container
    ;;
  *)
    echo "Usage: $0 <command> [--headed]"
    echo ""
    echo "Commands:"
    echo "  build   Build image + start container"
    echo "  start   Start container (existing image)"
    echo "  stop    Stop + remove container"
    echo "  status  Check if running"
    exit 1
    ;;
esac
