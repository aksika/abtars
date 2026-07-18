#!/usr/bin/env python3
"""Fetch OpenRouter leaderboard top N models and optionally add to models.json.

Usage:
  scout-leaderboard.py 20              # print top 20, no changes
  scout-leaderboard.py 20 --update    # add/update top 20 in models.json
  scout-leaderboard.py 20 --test      # test each model + update

Fetches from /api/v1/models?sort=most-popular&limit=N
Includes provider endpoint details from /endpoints API.
"""
import json, os, sys, urllib.request
from datetime import date

config_dir = os.path.expanduser("~/.abtars/config")
tc_path = os.path.join(config_dir, "transport.json")
models_path = os.path.join(config_dir, "models.json")

do_update = "--update" in sys.argv or "--test" in sys.argv
do_test = "--test" in sys.argv

# Parse limit
limit = 20
for arg in sys.argv[1:]:
    if arg.lstrip("-").isdigit():
        limit = int(arg.lstrip("-"))

# Get API key
try:
    tc = json.load(open(tc_path))
    env_var = tc["providers"].get("openrouter", {}).get("apiKeyEnv", "OPENROUTER_API_KEY")
    key = os.environ.get(env_var, "")
except Exception:
    key = os.environ.get("OPENROUTER_API_KEY", "")
if not key:
    print("❌ No OpenRouter API key found"); sys.exit(1)

def api_get(path):
    req = urllib.request.Request(
        f"https://openrouter.ai/api/v1{path}",
        headers={"Authorization": f"Bearer {key}"}
    )
    return json.loads(urllib.request.urlopen(req, timeout=15).read())

def test_model(mid):
    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            data=json.dumps({
                "model": mid,
                "messages": [{"role": "user", "content": "Say OK"}],
                "max_tokens": 50
            }).encode()
        )
        resp = json.loads(urllib.request.urlopen(req, timeout=20).read())
        choices = resp.get("choices", [])
        if choices:
            return True, resp.get("provider", "?")
        return False, "?"
    except Exception:
        return False, "?"

def fetch_endpoints(mid):
    try:
        data = api_get(f"/models/{mid}/endpoints")
        endpoints = data.get("data", {}).get("endpoints", [])
        providers = {}
        for ep in endpoints:
            pname = ep.get("provider_name", "?")
            providers[pname] = {
                "status": ep.get("status", -1),
                "uptime_30m": round(ep.get("uptime_last_30m", 0), 2),
                "uptime_1d": round(ep.get("uptime_last_1d", 0), 2),
                "latency_p50": ep.get("latency_last_30m", {}).get("p50", 0),
                "throughput_p50": ep.get("throughput_last_30m", {}).get("p50", 0),
                "quant": ep.get("quantization", "?"),
                "max_completion_tokens": ep.get("max_completion_tokens", 0) or 0,
            }
        return providers
    except Exception:
        return {}

# Fetch leaderboard
print(f"Fetching top {limit} models from OpenRouter leaderboard...")
data = api_get(f"/models?sort=most-popular&limit={limit}")
models = data.get("data", [])

# Load catalog
try:
    catalog = json.load(open(models_path))
except Exception:
    catalog = {}

print(f"\n{'#':>3} {'Model':<50} {'Ctx':>8} {'In $/1M':>10} {'Out $/1M':>11} {'Status'}")
print("-" * 100)

added, updated = 0, 0
for i, m in enumerate(models, 1):
    mid = m["id"]
    ctx = m.get("context_length") or 0
    pricing = m.get("pricing", {})
    inp = float(pricing.get("prompt", 0) or 0)
    out = float(pricing.get("completion", 0) or 0)
    is_free = ":free" in mid

    alive_str = ""
    if do_test:
        alive, provider = test_model(mid)
        alive_str = f" alive={alive} ({provider})" if do_update else f" alive={alive} ({provider})"
        providers = fetch_endpoints(mid) if do_update else {}
        entry = {
            "contextWindow": ctx,
            "maxOutput": m.get("top_provider", {}).get("max_completion_tokens") or 0,
            "rank": 1 if ctx >= 500000 else (2 if ctx >= 200000 else 3),
            "cost": {"input": inp, "output": out},
            "transports": ["openrouter"],
            "description": f"OpenRouter leaderboard top {limit} (rank {i})",
            "validatedAt": date.today().isoformat(),
            "status": "alive" if alive else "dead",
            "providers": providers,
        }
        if mid not in catalog:
            catalog[mid] = entry
            added += 1
        else:
            catalog[mid].update({k: v for k, v in entry.items() if k != "description"})
            updated += 1

    flag = "✓" if mid in catalog else "NEW"
    free_tag = " FREE" if is_free else ""
    print(f"{i:>3} {mid:<50} {ctx:>8} {inp:>10.7f} {out:>11.7f} {flag}{free_tag}{alive_str}")

if do_update:
    with open(models_path, "w") as f:
        json.dump(catalog, f, indent=2); f.write("\n")
    print(f"\n✓ models.json updated: {added} added, {updated} updated ({len(catalog)} total)")

print(f"\nNote: sort=most-popular = OpenRouter's default leaderboard order")
print(f"Other sort options: top-weekly, intelligence-high-to-low, pricing-low-to-high")
