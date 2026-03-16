#!/bin/bash
# Refresh NotebookLM auth via OpenClaw browser CDP.
# Run periodically via cron or after reboot.
NLM=/Users/akos/.local/bin/nlm
CDP=http://127.0.0.1:18800

# Check if browser CDP is reachable
if ! curl -s "$CDP/json/version" >/dev/null 2>&1; then
  echo "$(date): CDP not reachable, skipping" >> /tmp/nlm-refresh.log
  exit 0
fi

# Check if NotebookLM page exists in browser, if not inject cookies and navigate
PAGE_URL=$(curl -s "$CDP/json" 2>/dev/null | python3 -c "
import sys,json
for t in json.load(sys.stdin):
  if t.get('type')=='page' and 'notebooklm.google.com' in t.get('url',''):
    print(t['url']); break
" 2>/dev/null)

if [ -z "$PAGE_URL" ]; then
  echo "$(date): No NotebookLM page, injecting cookies..." >> /tmp/nlm-refresh.log
  python3 /Users/akos/.openclaw/scripts/inject-nlm-cookies.py 2>> /tmp/nlm-refresh.log
  sleep 5
fi

# Refresh via provider
$NLM login --provider openclaw --cdp-url "$CDP" 2>&1 | tee -a /tmp/nlm-refresh.log
echo "$(date): refresh done" >> /tmp/nlm-refresh.log
