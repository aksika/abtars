#!/bin/sh
# install.sh — one-liner installer for abtars.
#
# Piped usage (no download step, installs latest dev commit by default):
#   curl -fsSL https://raw.githubusercontent.com/aksika/abtars/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --stable
#   curl -fsSL .../install.sh | sh -s -- --alpha
#   curl -fsSL .../install.sh | sh -s -- --dev [DIR]
#
# This script is self-contained so it survives the pipe transport: it never
# reads answers from stdin itself, and the interactive onboarding wizard is
# reattached to /dev/tty (or runs with the caller's ABTARS_INSTALL_ARGS when
# no terminal exists). Its only writes are its private temp directory; ALL
# scaffolding/staging/activation is delegated to the TypeScript installer
# (`abtars install`, which runs `abtars update` internally for the selected
# channel). abmind is intentionally separate — install it with its own
# one-liner when memory is needed.
#
# Environment:
#   ABTARS_HOME               override ~/.abtars runtime root
#   ABTARS_RELEASES           override ~/.abtars-releases releases root
#   ABTARS_BIN                override ~/.local/bin public bin dir
#   ABTARS_BOOTSTRAP_TARBALL  bootstrap from this local .tgz instead of `npm pack`
#   ABTARS_INSTALL_ARGS       extra args for `abtars install`
#                             (e.g. "--non-interactive --accept-risk --user-name y ...")
#
# Default channel: --dev (latest dev commit)
# Exit codes: 0 = success, 1 = bad usage/prereqs, 2 = acquisition/install failed
set -eu

CHANNEL="dev"
DEV_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
        --stable) CHANNEL="stable" ;;
        --alpha) CHANNEL="alpha" ;;
        --dev)
            CHANNEL="dev"
            case "${2:-}" in
                ""|--*) ;;          # no dir → owned-dev pull mode (clone origin/dev)
                *) DEV_DIR="$2"; shift ;;
            esac
            ;;
        --help|-h)
            cat <<EOF
Usage: curl -fsSL <raw>/scripts/install.sh | sh [-s -- [--dev [DIR]|--stable|--alpha]]
  --dev      Clone dev + build latest commit (no DIR), or build DIR as-is (default)
  --stable   Install latest stable
  --alpha    Install latest alpha
EOF
            exit 0
            ;;
        *) printf 'ERROR: unknown option: %s\n' "$1" >&2; exit 1 ;;
    esac
    shift
done

err() { printf 'ERROR: %s\n' "$1" >&2; }

command -v node >/dev/null 2>&1 || { err "node is required but not installed (need 22+)"; exit 1; }
command -v npm >/dev/null 2>&1 || { err "npm is required but not installed"; exit 1; }
if [ "$CHANNEL" = "dev" ] && [ -z "$DEV_DIR" ] && [ -z "${ABTARS_BOOTSTRAP_TARBALL:-}" ]; then
    command -v git >/dev/null 2>&1 || { err "git is required for --dev (no DIR) but not installed"; exit 1; }
fi

ABTARS_HOME="${ABTARS_HOME:-$HOME/.abtars}"
ABTARS_RELEASES="${ABTARS_RELEASES:-$HOME/.abtars-releases}"
ABTARS_BINDIR="${ABTARS_BIN:-$HOME/.local/bin}"
SCRATCH="$(mktemp -d 2>/dev/null || mktemp -d -t abtars)"
trap 'rm -rf "$SCRATCH"' EXIT
chmod 0700 "$SCRATCH"

# ── 1. Acquire the installer artifact ──────────────────────────────────────
# The installer code always comes from a packaged release. For dev, the
# installer itself clones/builds the dev tree (`abtars install --dev` runs
# `abtars update --dev`) — the bootstrap never does.
TARBALL=""
if [ -n "${ABTARS_BOOTSTRAP_TARBALL:-}" ]; then
    [ -f "$ABTARS_BOOTSTRAP_TARBALL" ] || { err "ABTARS_BOOTSTRAP_TARBALL not found: $ABTARS_BOOTSTRAP_TARBALL"; exit 2; }
    cp "$ABTARS_BOOTSTRAP_TARBALL" "$SCRATCH/abtars.tgz"
    TARBALL="$SCRATCH/abtars.tgz"
else
    TAG="latest"
    [ "$CHANNEL" = "alpha" ] && TAG="alpha"
    echo "Acquiring abtars installer (abtars@${TAG})..."
    if ! npm pack --json --pack-destination "$SCRATCH" "abtars@${TAG}" >/dev/null 2>&1; then
        err "npm pack abtars@${TAG} failed (check network/npm auth)"
        exit 2
    fi
    for f in "$SCRATCH"/abtars-*.tgz; do
        if [ -f "$f" ]; then TARBALL="$f"; break; fi
    done
fi
[ -n "$TARBALL" ] || { err "failed to acquire abtars artifact"; exit 2; }

# ── 2. Extract only the installer entrypoint ──────────────────────────────
echo "Extracting installer..."
mkdir -p "$SCRATCH/extract"
if ! tar -xzf "$TARBALL" -C "$SCRATCH/extract" --strip-components=1 2>/dev/null; then
    err "failed to extract artifact"
    exit 2
fi
ENTRYPOINT=""
for candidate in "$SCRATCH/extract/bundle/abtars-cli.js" "$SCRATCH/extract/dist/cli/abtars.js"; do
    if [ -f "$candidate" ]; then ENTRYPOINT="$candidate"; break; fi
done
if [ -z "$ENTRYPOINT" ]; then
    err "CLI entrypoint not found in artifact (tried bundle/abtars-cli.js, dist/cli/abtars.js)"
    ls -la "$SCRATCH/extract/" 2>/dev/null || true
    exit 2
fi

# ── 3. Delegate scaffolding/staging/activation to the TypeScript installer ─
# `abtars install --dev` runs the onboard wizard then `abtars update --dev`
# (clone dev, build, deploy). When piped (curl ... | sh), stdin is the script
# stream, not the terminal, so the interactive wizard must not inherit stdin
# blindly.
INSTALL_ARGS="--${CHANNEL}"
if [ -n "$DEV_DIR" ]; then
    INSTALL_ARGS="--dev ${DEV_DIR}"
fi
echo "Running abtars installer (${INSTALL_ARGS})..."
# shellcheck disable=SC2086  # intentional word-splitting of installer args
if [ -t 0 ]; then
    if ! ABTARS_HOME="$ABTARS_HOME" ABTARS_RELEASES="$ABTARS_RELEASES" ABTARS_BIN="$ABTARS_BINDIR" node "$ENTRYPOINT" install $INSTALL_ARGS ${ABTARS_INSTALL_ARGS:-}; then
        err "abtars installer failed"
        exit 2
    fi
elif [ -r /dev/tty ]; then
    if ! ABTARS_HOME="$ABTARS_HOME" ABTARS_RELEASES="$ABTARS_RELEASES" ABTARS_BIN="$ABTARS_BINDIR" node "$ENTRYPOINT" install $INSTALL_ARGS ${ABTARS_INSTALL_ARGS:-} < /dev/tty; then
        err "abtars installer failed"
        exit 2
    fi
else
    echo "No terminal detected; running with ABTARS_INSTALL_ARGS as-is."
    echo "For unattended setup, pass e.g. ABTARS_INSTALL_ARGS='--non-interactive --accept-risk ...'."
    if ! ABTARS_HOME="$ABTARS_HOME" ABTARS_RELEASES="$ABTARS_RELEASES" ABTARS_BIN="$ABTARS_BINDIR" node "$ENTRYPOINT" install $INSTALL_ARGS ${ABTARS_INSTALL_ARGS:-}; then
        err "abtars installer failed"
        exit 2
    fi
fi

# ── 4. Verify the public command resolves ─────────────────────────────────
echo "Verifying installation..."
BIN="${ABTARS_BINDIR}/abtars"
if [ ! -f "$BIN" ] && [ ! -L "$BIN" ]; then
    err "abtars command not found at ${BIN}"
    echo "Ensure the bin dir exists and is on PATH." >&2
    exit 2
fi
"$BIN" --version

echo "abtars installed successfully (channel: ${INSTALL_ARGS})."
echo "abmind is separate — install it with its own one-liner when memory is needed."
exit 0
