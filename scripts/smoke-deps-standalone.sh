#!/usr/bin/env bash
set -euo pipefail

# smoke-deps-standalone.sh — Verify bundled abtars deps works without abmind.
# Runs after `npm run bundle`. Uses the esbuild output in bundle/.
# Must pass even when abmind and workspace node_modules are unavailable.

BUNDLE_DIR="$(cd "$(dirname "$0")/../bundle" && pwd)"
TMP_DIR="$(mktemp -d "/tmp/abtars-deps-smoke-XXXXXX")"
TMP_HOME="$TMP_DIR/home"
TMP_DEPS_ROOT="$TMP_DIR/deps-root"
TMP_BUNDLE="$TMP_DIR/bundle"

trap 'rm -rf "$TMP_DIR"' EXIT

echo "=== smoke-deps-standalone ==="

# 1. Copy bundle artifacts to isolated location
mkdir -p "$TMP_BUNDLE" "$TMP_HOME" "$TMP_DEPS_ROOT"
cp "$BUNDLE_DIR"/*.js "$BUNDLE_DIR"/*.map "$TMP_BUNDLE/" 2>/dev/null || true

# 2. Pick the CLI entry point
CLI="$TMP_BUNDLE/abtars-cli.js"
if [ ! -f "$CLI" ]; then
  echo "FAIL: bundle CLI not found at $CLI"
  exit 1
fi

# 3. Run with isolated environment — HOME, PATH, and Pi config
export HOME="$TMP_HOME"
export AB_SHARED_DEPS_ROOT="$TMP_DEPS_ROOT"
unset NODE_PATH
# Isolate PATH to prevent developer's Pi/global npm from being discovered
NODE_BIN="$(dirname "$(command -v node)")"
export PATH="$NODE_BIN:/usr/bin:/bin"

echo "--- deps list ---"
if ! node "$CLI" deps list > "$TMP_DIR/list.out" 2>&1; then
  echo "FAIL: deps list exited non-zero"
  cat "$TMP_DIR/list.out"
  exit 1
fi
echo "OK"

echo "--- deps update (bare, empty root) ---"
if ! node "$CLI" deps update > "$TMP_DIR/update.out" 2>&1; then
  # #1427: bare update on empty root = "No installed optional dependencies" = ok
  if grep -q "No installed optional dependencies" "$TMP_DIR/update.out"; then
    echo "OK (empty root)"
  else
    echo "FAIL: deps update failed unexpectedly"
    cat "$TMP_DIR/update.out"
    exit 1
  fi
else
  echo "OK"
fi

echo "--- deps update <absent-group> (explicit absent) ---"
if node "$CLI" deps update pdf > "$TMP_DIR/update-absent.out" 2>&1; then
  echo "FAIL: expected non-zero for absent group"
  cat "$TMP_DIR/update-absent.out"
  exit 1
fi
# #1427: should print instruction to install first, not crash on module resolution
if grep -q -i "install.*first\|not installed\|unknown" "$TMP_DIR/update-absent.out"; then
  echo "OK (absent group instruction)"
else
  echo "FAIL: absent group did not produce expected instruction"
  cat "$TMP_DIR/update-absent.out"
  exit 1
fi

echo "--- bundle scan: no abmind/deploy-lib ---"
if grep -r "abmind/deploy-lib" "$TMP_BUNDLE" --include="*.js" 2>/dev/null; then
  echo "FAIL: bundle contains abmind/deploy-lib specifier"
  exit 1
fi
echo "OK"

echo ""
echo "=== smoke-deps-standalone PASSED ==="
