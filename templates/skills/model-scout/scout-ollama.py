#!/usr/bin/env python3
"""List Ollama cloud models (free, no local GPU needed) + local installed.
Fetches from ollama.com library API for cloud models.
Usage:
  scout-ollama.py          # list only
  scout-ollama.py --test   # list + liveness test cloud models + write status
"""
import json, os, sys, urllib.request

config_dir = os.path.expanduser("~/.abtars/config")
models_path = os.path.join(config_dir, "models.json")
do_test = "--test" in sys.argv

# Load current catalog
try:
    catalog = json.load(open(models_path))
except Exception:
    catalog = {}
cataloged = {k for k in catalog if "ollama" in catalog[k].get("transports", [])}

# --- Cloud models from ollama.com ---
print("=== Ollama Cloud Models (free) ===")
print(f"{'Model':<45} {'Status'}")
print("-" * 60)

try:
    req = urllib.request.Request(
        "https://ollama.com/search?c=cloud",
        headers={"User-Agent": "abtars-scout/1.0"}
    )
    import re
    html = urllib.request.urlopen(req, timeout=10).read().decode()
    cloud_names = list(dict.fromkeys(re.findall(r'href="/library/([^"]+)"', html)))
    cloud_models = [{"name": f"{n}:cloud"} for n in cloud_names]
except Exception as e:
    # Fallback: check local tags for :cloud suffix
    cloud_models = []
    print(f"  (ollama.com scrape failed: {e}, falling back to local tags)")

# If API didn't work, check local tags for :cloud suffix
if not cloud_models:
    try:
        local_data = json.loads(urllib.request.urlopen("http://localhost:11434/api/tags", timeout=5).read())
        cloud_models = [{"name": m["name"]} for m in local_data.get("models", []) if ":cloud" in m["name"]]
    except Exception:
        pass

from datetime import date
today = date.today().isoformat()

for m in cloud_models:
    name = m["name"] if isinstance(m, dict) else m
    if not name.endswith(":cloud") and ":cloud" not in name:
        name = f"{name}:cloud"
    status = "✓ cataloged" if name in cataloged else "NEW"

    # Liveness test
    if do_test and status == "NEW":
        try:
            test_data = json.dumps({"model": name, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 5}).encode()
            test_req = urllib.request.Request(
                "http://localhost:11434/v1/chat/completions",
                headers={"Content-Type": "application/json"},
                data=test_data
            )
            resp = json.loads(urllib.request.urlopen(test_req, timeout=15).read())
            content = resp.get("choices", [{}])[0].get("message", {}).get("content", "")
            alive = bool(content.strip())
        except Exception:
            alive = False
        status = f"{'✓ alive' if alive else '✗ dead'}"

        if name not in catalog:
            catalog[name] = {
                "contextWindow": 262144, "maxOutput": 16384, "rank": 3,
                "cost": {"input": 0.0, "output": 0.0},
                "transports": ["ollama"],
                "description": f"Ollama cloud model, scouted {today}",
                "validatedAt": today, "status": "alive" if alive else "dead"
            }
        else:
            catalog[name]["validatedAt"] = today
            catalog[name]["status"] = "alive" if alive else "dead"

    print(f"  {name:<43} {status}")

# --- Local installed models ---
print(f"\n=== Local Installed ===")
print(f"{'Model':<45} {'Size':>8} {'Status'}")
print("-" * 60)

try:
    local_data = json.loads(urllib.request.urlopen("http://localhost:11434/api/tags", timeout=5).read())
    installed = local_data.get("models", [])
except Exception:
    installed = []
    print("  (Ollama not reachable at localhost:11434)")

try:
    ps = json.loads(urllib.request.urlopen("http://localhost:11434/api/ps", timeout=5).read())
    running = {m["name"] for m in ps.get("models", [])}
except Exception:
    running = set()

for m in installed:
    name = m["name"]
    size_gb = m.get("size", 0) / 1e9
    run_mark = " ▶" if name in running else ""
    status = "✓ cataloged" if name in cataloged else "NEW"
    print(f"  {name:<43} {size_gb:>6.1f}G{run_mark} {status}")

if do_test:
    with open(models_path, "w") as f:
        json.dump(catalog, f, indent=2)
        f.write("\n")
    print(f"\n✓ models.json updated ({len(catalog)} entries)")
