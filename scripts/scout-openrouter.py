#!/usr/bin/env python3
"""List free models from OpenRouter, compare against models.json catalog."""
import json, os, sys, urllib.request

config_dir = os.path.expanduser("~/.agentbridge/config")
tc_path = os.path.join(config_dir, "transport.json")
models_path = os.path.join(config_dir, "models.json")

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
free.sort(key=lambda m: m.get("context_length", 0), reverse=True)

# Load current catalog
try:
    catalog = json.load(open(models_path))
except Exception:
    catalog = {}
cataloged = {k for k in catalog if "openrouter" in catalog[k].get("transports", [])}

print(f"{'Model':<45} {'Ctx':>8} {'MaxOut':>8} {'Status'}")
print("-" * 80)
for m in free[:30]:
    mid = m["id"]
    ctx = m.get("context_length", 0)
    out = m.get("top_provider", {}).get("max_completion_tokens", 0)
    # Normalize ID for catalog comparison (openrouter uses vendor/model:free)
    short = mid.split("/")[-1].replace(":free", ":cloud") if "/" in mid else mid
    status = "✓ cataloged" if short in cataloged or mid in cataloged else "NEW"
    print(f"{mid:<45} {ctx:>8} {out:>8} {status}")
