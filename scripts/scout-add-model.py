#!/usr/bin/env python3
"""Add a model to models.json with backup and validation."""
import json, os, shutil, sys

config_dir = os.path.expanduser("~/.agentbridge/config")
models_path = os.path.join(config_dir, "models.json")

if len(sys.argv) < 2:
    print("Usage: scout-add-model.py <model-id> [contextWindow] [maxOutput] [rank] [input_cost] [output_cost] [transports...]")
    print("Example: scout-add-model.py 'qwen/qwen3-coder:free' 131072 8192 3 0.0 0.0 openrouter ollama")
    sys.exit(1)

model_id = sys.argv[1]
ctx = int(sys.argv[2]) if len(sys.argv) > 2 else 131072
max_out = int(sys.argv[3]) if len(sys.argv) > 3 else 8192
rank = int(sys.argv[4]) if len(sys.argv) > 4 else 3
cost_in = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
cost_out = float(sys.argv[6]) if len(sys.argv) > 6 else 0.0
transports = sys.argv[7:] if len(sys.argv) > 7 else ["ollama"]

# Backup
shutil.copy2(models_path, models_path + ".old")
print(f"📦 Backed up to models.json.old")

# Add
models = json.load(open(models_path))
models[model_id] = {
    "contextWindow": ctx,
    "maxOutput": max_out,
    "rank": rank,
    "cost": {"input": cost_in, "output": cost_out},
    "transports": transports,
}
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
