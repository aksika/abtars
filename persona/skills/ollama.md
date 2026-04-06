---
name: ollama
description: Manage the local Ollama instance — list models, pull/remove models, check status, show model info.
user-invocable: true
---

# Ollama Management

Manage the local Ollama server and models via `exec`.

## Available commands

```bash
ollama list                    # list installed models
ollama show <model>            # show model details (architecture, params, context, quantization)
ollama ps                      # show currently loaded models and memory usage
ollama pull <model>            # download/update a model
ollama rm <model>              # remove a model
```

## Important notes

- The local model is `qwen3.5:9b-32k` (custom variant with `num_ctx 32768` baked in).
- Cloud models (`*:cloud`) route through Ollama but run remotely — no local memory impact.
- This Mac has 16GB RAM. Max practical local model: ~9-10B Q4. Don't pull larger models.
- After pulling a new model, it needs a Modelfile with `num_ctx` set to be useful — Ollama defaults to 4096 context.
- Never run `ollama serve` — it's managed by the LaunchAgent.
