#!/usr/bin/env bash
# agentbridge-fetch — fetch a URL and return clean markdown.
# Usage: agentbridge-fetch <url>
# Returns truncated markdown to stdout. Exits 1 on error.
set -euo pipefail

MAX_CHARS=50000

if [[ $# -lt 1 ]]; then
  echo "Usage: agentbridge-fetch <url>" >&2
  exit 1
fi

URL="$1"

if ! command -v lightpanda &>/dev/null; then
  echo "ERROR: lightpanda not installed. Use Level 2 browse (agentbridge-browse) instead." >&2
  exit 1
fi

OUTPUT=$(lightpanda fetch \
  --dump markdown \
  --strip-mode full \
  --http-connect-timeout 10000 \
  --http-timeout 15000 \
  --wait-ms 10000 \
  --block-private-networks \
  "$URL" 2>/dev/null)

if [[ -z "$OUTPUT" ]]; then
  echo "ERROR: Empty response. Page may require JavaScript or login. Use Level 2 browse (agentbridge-browse) instead." >&2
  exit 1
fi

# Truncate to prevent context window blowout
if [[ ${#OUTPUT} -gt $MAX_CHARS ]]; then
  echo "${OUTPUT:0:$MAX_CHARS}"
  echo ""
  echo "[Content truncated at ${MAX_CHARS} characters]"
else
  echo "$OUTPUT"
fi
