#!/usr/bin/env bash
# Delete all failed workflow runs from a GitHub repo.
# Usage: gh-cleanup-runs.sh [owner/repo] [status]
# Requires: gh CLI authenticated

REPO="${1:-aksika/abtars}"
STATUS="${2:-failure}"

echo "Deleting $STATUS runs from $REPO..."
gh run list --repo "$REPO" --status "$STATUS" --limit 200 --json databaseId -q '.[].databaseId' | while read -r id; do
  gh run delete "$id" --repo "$REPO" && echo "  deleted $id" || echo "  FAILED $id"
done
echo "Done."
