#!/usr/bin/env python3
"""Inject saved Google cookies into OpenClaw browser (all services: NLM, Gmail, etc.)."""
import json, urllib.request, pathlib, sys

CDP = "http://127.0.0.1:18800"
cookie_path = pathlib.Path.home() / ".notebooklm-mcp-cli/profiles/default/cookies.json"
gmail_path = pathlib.Path.home() / "google-cookies-full.json"

if not cookie_path.exists():
    print("No saved cookies"); sys.exit(1)

nlm_cookies = json.loads(cookie_path.read_text())
# Merge with Gmail/full cookie set if available
if gmail_path.exists():
    gmail_cookies = json.loads(gmail_path.read_text())
    merged = {(c["name"], c.get("domain", "")): c for c in nlm_cookies}
    for c in gmail_cookies:
        key = (c["name"], c.get("domain", ""))
        if key not in merged:
            merged[key] = c
    cookies = list(merged.values())
else:
    cookies = nlm_cookies if isinstance(nlm_cookies, list) else [{"name": k, "value": str(v), "domain": ".google.com", "path": "/", "secure": True, "httpOnly": True} for k, v in nlm_cookies.items()]

# Ensure sameSite/secure for CDP
for c in cookies:
    c.setdefault("sameSite", "None")
    c["secure"] = True

try:
    ver = json.loads(urllib.request.urlopen(f"{CDP}/json/version").read())
except Exception:
    print("Browser not reachable"); sys.exit(1)

import websocket
ws = websocket.create_connection(ver["webSocketDebuggerUrl"])
ws.send(json.dumps({"id": 1, "method": "Storage.clearCookies"}))
ws.recv()
ws.send(json.dumps({"id": 2, "method": "Storage.setCookies", "params": {"cookies": cookies}}))
ws.recv()
ws.close()

# Navigate a page to NotebookLM
tabs = json.loads(urllib.request.urlopen(f"{CDP}/json").read())
ws_url = next((t["webSocketDebuggerUrl"] for t in tabs if t.get("type") == "page" and t.get("webSocketDebuggerUrl")), None)
if ws_url:
    ws2 = websocket.create_connection(ws_url)
    ws2.send(json.dumps({"id": 1, "method": "Page.navigate", "params": {"url": "https://notebooklm.google.com"}}))
    ws2.recv()
    ws2.close()

print(f"Injected {len(cookies)} cookies, navigated to NotebookLM")
