#!/usr/bin/env python3
"""Add a model to models.json with backup, validation, description, and timestamp."""
import json, os, shutil, sys
from datetime import datetime

config_dir = os.path.expanduser("~/.agentbridge/config")
models_path = os.path.join(config_dir, "models.json")

if len(sys.argv) < 2:
    print("Usage: scout-add-model.py <model-id> [contextWindow] [maxOutput] [rank] [input_cost] [output_cost] [description] [transports...]")
    print('Example: scout-add-model.py "kimi-k2.5:cloud" 262144 16384 2 0.0 0.0 "High IQ free model, top Intelligence Index" ollama openrouter')
    sys.exit(1)

model_id = sys.argv[1]
ctx = int(sys.argv[2]) if len(sys.argv) > 2 else 131072
max_out = int(sys.argv[3]) if len(sys.argv) > 3 else 8192
rank = int(sys.argv[4]) if len(sys.argv) > 4 else 3
cost_in = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
cost_out = float(sys.argv[6]) if len(sys.argv) > 6 else 0.0
description = sys.argv[7] if len(sys.argv) > 7 else ""
transports = sys.argv[8:] if len(sys.argv) > 8 else ["ollama"]

# Backup
shutil.copy2(models_path, models_path + ".old")
print("📦 Backed up to models.json.old")

# Add
models = json.load(open(models_path))
entry = {
    "contextWindow": ctx,
    "maxOutput": max_out,
    "rank": rank,
    "cost": {"input": cost_in, "output": cost_out},
    "transports": transports,
    "addedAt": datetime.now().strftime("%Y-%m-%d"),
}
if description:
    entry["description"] = description
models[model_id] = entry
json.dump(models, open(models_path, "w"), indent=2)

# Validate
models = json.load(open(models_path))
errors = []
for mid, m in models.items():
    for f in ["contextWindow", "maxOutput", "rank", "cost", "transports"]:
        if f not in m:
            errors.append(f"{mid}: missing {f}")
    if "cost" in m:
        for cf in ["input", "output"]:
            if cf not in m["cost"]:
                errors.append(f"{mid}: missing cost.{cf}")
    if not m.get("transports"):
        errors.append(f"{mid}: empty transports (won't appear in /models change)")

if errors:
    print("❌ Validation failed:")
    for e in errors:
        print(f"  {e}")
    shutil.copy2(models_path + ".old", models_path)
    print("🔄 Restored from backup")
    sys.exit(1)
else:
    print(f"✅ Added {model_id} — {len(models)} models total, all valid")
