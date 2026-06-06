#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
node esbuild.config.js
rm -rf bundle/public && cp -r src/components/dashboard/public bundle/public
NO_RESTART=1 node bundle/abtars-cli.js update --from-local
