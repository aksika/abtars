#!/usr/bin/env python3
"""List free models from OpenRouter, compare against models.json catalog.
Usage:
  scout-openrouter.py          # list only
  scout-openrouter.py --test   # list + liveness test + write status to models.json
"""
import json, os, sys, urllib.request

config_dir = os.path.expanduser("~/.abtars/config")
tc_path = os.path.join(config_dir, "transport.json")
models_path = os.path.join(config_dir, "models.json")
do_test = "--test" in sys.argv

# Get API key from transport.json
try:
    tc = json.load(open(tc_path))
    env_var = tc["providers"].get("openrouter", {}).get("apiKeyEnv", "OPENROUTER_API_KEY")
    key = os.environ.get(env_var, "")
except Exception:
    key = os.environ.get("OPENROUTER_API_KEY", "")

if not key:
    print("❌ No OpenRouter API key found"); sys.exit(1)

# Fetch models
req = urllib.request.Request("https://openrouter.ai/api/v1/models", headers={"Authorization": f"Bearer {key}"})
data = json.loads(urllib.request.urlopen(req, timeout=10).read())
free = [m for m in data["data"] if ":free" in m["id"]]
free.sort(key=lambda m: m.get("context_length") or 0, reverse=True)

# Load current catalog
try:
    catalog = json.load(open(models_path))
except Exception:
    catalog = {}
cataloged = {k for k in catalog if "openrouter" in catalog[k].get("transports", [])}

print(f"{'Model':<45} {'Ctx':>8} {'MaxOut':>8} {'Status'}")
print("-" * 80)

from datetime import date
today = date.today().isoformat()

for m in free[:30]:
    mid = m["id"]
    ctx = m.get("context_length") or 0
    out = m.get("top_provider", {}).get("max_completion_tokens") or 0
    short = mid.split("/")[-1].replace(":free", ":cloud") if "/" in mid else mid
    status = "✓ cataloged" if short in cataloged or mid in cataloged else "NEW"

    # Liveness test
    if do_test and status == "NEW":
        try:
            test_req = urllib.request.Request(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                data=json.dumps({"model": mid, "messages": [{"role": "user", "content": "Say OK"}], "max_tokens": 5}).encode()
            )
            resp = json.loads(urllib.request.urlopen(test_req, timeout=15).read())
            content = resp.get("choices", [{}])[0].get("message", {}).get("content", "")
            alive = bool(content.strip())
        except Exception:
            alive = False
        status = f"{'✓ alive' if alive else '✗ dead'}"

        # Write to models.json
        if mid not in catalog:
            catalog[mid] = {
                "contextWindow": ctx, "maxOutput": out, "rank": 2 if ctx >= 200000 else 3,
                "cost": {"input": 0.0, "output": 0.0},
                "transports": ["openrouter"],
                "description": f"Scouted {today}",
                "validatedAt": today, "status": "alive" if alive else "dead"
            }
        else:
            catalog[mid]["validatedAt"] = today
            catalog[mid]["status"] = "alive" if alive else "dead"

    print(f"{mid:<45} {ctx:>8} {out:>8} {status}")

if do_test:
    with open(models_path, "w") as f:
        json.dump(catalog, f, indent=2)
        f.write("\n")
    print(f"\n✓ models.json updated ({len(catalog)} entries)")
