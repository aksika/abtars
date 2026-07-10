#!/usr/bin/env python3
"""Scout OpenRouter models and update models.json.

Usage:
  scout-openrouter.py                    # list free models vs catalog
  scout-openrouter.py --test             # list + liveness test + write status
  scout-openrouter.py --leaderboard 20   # fetch top N from leaderboard, add to models.json
  scout-openrouter.py --model tencent/hy3:free  # inspect + test single model, update catalog

Fetches provider details from /endpoints API and stores them in models.json.
"""
import json, os, sys, urllib.request
from datetime import date

config_dir = os.path.expanduser("~/.abtars/config")
tc_path = os.path.join(config_dir, "transport.json")
models_path = os.path.join(config_dir, "models.json")

# Parse args
do_test = "--test" in sys.argv
leaderboard_n = 0
single_model = None
for i, arg in enumerate(sys.argv[1:], 1):
    if arg == "--leaderboard" and i < len(sys.argv) - 1:
        leaderboard_n = int(sys.argv[i + 1])
    if arg == "--model" and i < len(sys.argv) - 1:
        single_model = sys.argv[i + 1]

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
    """Test if a model responds."""
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
            provider = resp.get("provider", "?")
            content = choices[0].get("message", {}).get("content", "")
            return True, provider, bool(content.strip())
        return False, "?", False
    except Exception as e:
        return False, "?", False

def fetch_endpoints(mid):
    """Fetch provider endpoints for a model."""
    try:
        data = api_get(f"/models/{mid}/endpoints")
        endpoints = data.get("data", {}).get("endpoints", [])
        providers = {}
        for ep in endpoints:
            pname = ep.get("provider_name", "?")
            providers[pname] = {
                "status": ep.get("status", -1),
                "uptime_30m": ep.get("uptime_last_30m", 0),
                "uptime_1d": ep.get("uptime_last_1d", 0),
                "latency_p50": ep.get("latency_last_30m", {}).get("p50", 0),
                "throughput_p50": ep.get("throughput_last_30m", {}).get("p50", 0),
                "quant": ep.get("quantization", "?"),
                "max_completion_tokens": ep.get("max_completion_tokens", 0) or 0,
            }
        return providers
    except Exception as e:
        return {}

def make_entry(mid, mdata, providers, alive, provider_name):
    ctx = mdata.get("context_length") or 0
    top_out = mdata.get("top_provider", {}).get("max_completion_tokens") or 0
    pricing = mdata.get("pricing", {})
    inp = float(pricing.get("prompt", 0) or 0)
    out = float(pricing.get("completion", 0) or 0)
    is_free = ":free" in mid
    rank = 1 if ctx >= 500000 else (2 if ctx >= 200000 else 3)

    desc = mdata.get("name", mid)
    if is_free:
        desc = f"{desc} — single provider: {provider_name}" if provider_name != "?" else desc

    return {
        "contextWindow": ctx,
        "maxOutput": top_out,
        "rank": rank,
        "cost": {"input": inp, "output": out},
        "transports": ["openrouter"],
        "description": desc,
        "validatedAt": date.today().isoformat(),
        "status": "alive" if alive else "dead",
        "providers": providers,
    }

# Load catalog
try:
    catalog = json.load(open(models_path))
except Exception:
    catalog = {}

# ── Single model mode ──────────────────────────────────────────────
if single_model:
    print(f"Inspecting {single_model}...")
    mdata = api_get(f"/models/{single_model}")
    providers = fetch_endpoints(single_model)
    alive, provider_name, got_content = test_model(single_model)
    entry = make_entry(single_model, mdata, providers, alive, provider_name)
    catalog[single_model] = entry
    with open(models_path, "w") as f:
        json.dump(catalog, f, indent=2); f.write("\n")
    print(f"  Alive: {alive} (provider: {provider_name}, content: {got_content})")
    print(f"  Providers: {list(providers.keys())}")
    print(f"  ✓ Updated in models.json")
    sys.exit(0)

# ── Leaderboard mode ───────────────────────────────────────────────
if leaderboard_n > 0:
    print(f"Fetching top {leaderboard_n} models from OpenRouter leaderboard...")
    data = api_get(f"/models?sort=most-popular&limit={leaderboard_n}")
    models = data.get("data", [])
    added, updated = 0, 0
    for m in models:
        mid = m["id"]
        providers = fetch_endpoints(mid)
        alive, provider_name, _ = test_model(mid)
        entry = make_entry(mid, m, providers, alive, provider_name)
        if mid not in catalog:
            catalog[mid] = entry
            added += 1
            print(f"  + {mid} (alive={alive})")
        else:
            catalog[mid].update(entry)
            updated += 1
            print(f"  ~ {mid} (alive={alive})")
    with open(models_path, "w") as f:
        json.dump(catalog, f, indent=2); f.write("\n")
    print(f"\n✓ models.json updated: {added} added, {updated} updated ({len(catalog)} total)")
    sys.exit(0)

# ── Free model scan mode (original behavior) ───────────────────────
data = api_get("/models")
free = [m for m in data["data"] if ":free" in m["id"]]
free.sort(key=lambda m: m.get("context_length") or 0, reverse=True)

cataloged = {k for k in catalog if "openrouter" in catalog[k].get("transports", [])}

print(f"{'Model':<45} {'Ctx':>8} {'MaxOut':>8} {'Status'}")
print("-" * 80)

for m in free[:30]:
    mid = m["id"]
    ctx = m.get("context_length") or 0
    out = m.get("top_provider", {}).get("max_completion_tokens") or 0
    status = "✓ cataloged" if mid in catalog else "NEW"

    if do_test and status == "NEW":
        alive, provider_name, _ = test_model(mid)
        status = f"{'✓ alive' if alive else '✗ dead'} ({provider_name})"
        providers = fetch_endpoints(mid)
        catalog[mid] = make_entry(mid, m, providers, alive, provider_name)

    print(f"{mid:<45} {ctx:>8} {out:>8} {status}")

if do_test:
    with open(models_path, "w") as f:
        json.dump(catalog, f, indent=2); f.write("\n")
    print(f"\n✓ models.json updated ({len(catalog)} entries)")
