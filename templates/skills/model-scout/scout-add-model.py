#!/usr/bin/env python3
"""scout-add-model.py — Add or update a model in models.json.

Usage:
  scout-add-model.py MODEL_ID CTX_WINDOW MAX_OUTPUT RANK INPUT_COST OUTPUT_COST "DESCRIPTION" TRANSPORT [TRANSPORT...]

Example:
  scout-add-model.py "nemotron-3-super:cloud" 262144 16384 2 0.0 0.0 "Nvidia 120B MoE, free" ollama openrouter
"""
import json, sys, shutil
from pathlib import Path
from datetime import date

MODELS_PATH = Path.home() / ".abtars" / "config" / "models.json"
REQUIRED = {"contextWindow", "maxOutput", "rank", "cost", "transports"}

def main():
    if len(sys.argv) < 8:
        print(__doc__.strip(), file=sys.stderr)
        sys.exit(2)

    model_id = sys.argv[1]
    ctx = int(sys.argv[2])
    max_out = int(sys.argv[3])
    rank = int(sys.argv[4])
    in_cost = float(sys.argv[5])
    out_cost = float(sys.argv[6])
    desc = sys.argv[7]
    transports = sys.argv[8:]

    if not transports:
        print("Error: at least one transport required", file=sys.stderr)
        sys.exit(2)

    backup = MODELS_PATH.with_suffix(".json.old")
    shutil.copy2(MODELS_PATH, backup)

    with open(MODELS_PATH) as f:
        models = json.load(f)

    models[model_id] = {
        "contextWindow": ctx,
        "maxOutput": max_out,
        "rank": rank,
        "cost": {"input": in_cost, "output": out_cost},
        "transports": transports,
        "description": desc,
        "validatedAt": str(date.today()),
    }

    # Validate all entries
    for mid, m in models.items():
        missing = REQUIRED - set(m.keys())
        if missing:
            print(f"Validation failed: {mid} missing {missing}. Restoring backup.", file=sys.stderr)
            shutil.copy2(backup, MODELS_PATH)
            sys.exit(1)

    with open(MODELS_PATH, "w") as f:
        json.dump(models, f, indent=2)
        f.write("\n")

    free = "FREE" if in_cost == 0 and out_cost == 0 else f"${in_cost}/{out_cost}"
    print(f"✓ {model_id} (rank {rank}, ctx {ctx//1024}K, {free}, via {transports})")

if __name__ == "__main__":
    main()
