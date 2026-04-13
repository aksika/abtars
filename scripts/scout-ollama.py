#!/usr/bin/env python3
"""List Ollama models (installed + running), compare against models.json catalog."""
import json, os, sys, urllib.request

config_dir = os.path.expanduser("~/.agentbridge/config")
models_path = os.path.join(config_dir, "models.json")

# Load current catalog
try:
    catalog = json.load(open(models_path))
except Exception:
    catalog = {}
cataloged = {k for k in catalog if "ollama" in catalog[k].get("transports", [])}

# Installed models
try:
    data = json.loads(urllib.request.urlopen("http://localhost:11434/api/tags", timeout=5).read())
    installed = data.get("models", [])
except Exception:
    print("❌ Ollama not reachable at localhost:11434"); sys.exit(1)

# Running models
try:
    ps = json.loads(urllib.request.urlopen("http://localhost:11434/api/ps", timeout=5).read())
    running = {m["name"] for m in ps.get("models", [])}
except Exception:
    running = set()

print(f"{'Model':<40} {'Size':>8} {'Running':>8} {'Status'}")
print("-" * 70)
for m in installed:
    name = m["name"]
    size_gb = m.get("size", 0) / 1e9
    is_running = "▶" if name in running else ""
    status = "✓ cataloged" if name in cataloged else "NEW"
    print(f"{name:<40} {size_gb:>7.1f}G {is_running:>8} {status}")
