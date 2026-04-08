# stealth-browser-mcp Security Audit

**Project:** https://github.com/vibheksoni/stealth-browser-mcp
**Date:** 2026-03-14
**Verdict:** No intentional backdoors. Serious security design flaws create equivalent risk.

---

## 🔴 CRITICAL — Unrestricted `exec()` via MCP Tool

`server.py:2537` — the `create_python_binding` tool takes a `python_code` string and runs it with bare `exec()`:

```python
exec_globals = {}
exec(python_code, exec_globals)  # NO sandbox, NO restricted builtins
```

Any AI agent connected to this MCP server can execute arbitrary Python on the host. No sandboxing, no restricted `__builtins__`. Functionally equivalent to a backdoor — any prompt injection that reaches the AI can become RCE.

---

## 🟠 HIGH — Dynamic Hook System with Bypassable Sandbox

`dynamic_hook_system.py:84` — `exec(self.function_code, namespace)` with restricted `__builtins__` (only `len`, `str`, `int`, `float`, `bool`, `dict`, `list`, `tuple`, `print`).

Validation in `hook_learning_system.py:536-543` only AST-checks for `eval`, `exec`, `open`, `input`. Does NOT block classic Python sandbox escapes:
- `().__class__.__bases__[0].__subclasses__()` — enumerate all loaded classes
- `__import__('os').system('...')` — not caught (checks `ast.Name`, not `ast.Attribute`)
- `getattr(getattr(...), ...)` chains

`dynamic_hook_system.py:123` — `eval(condition_code, namespace)` for custom hook conditions. Same escape vectors.

---

## 🟡 MEDIUM — Hot Module Reload

`server.py:1683` — `importlib.reload(sys.modules[module_name])` reloads core modules at runtime. If an attacker can write to `src/` (e.g., via the exec vulnerability), they inject persistent code that survives restarts.

---

## 🟡 MEDIUM — Pickle Serialization

`debug_logger.py` uses `pickle.dump()` for log export. Currently write-only (no `pickle.load()`), not directly exploitable. But if anyone later loads these `.pkl` files — deserialization attack vector. Pickle can execute arbitrary code on load.

---

## 🟡 MEDIUM — Git-Pinned Third-Party Dependency

```
py2js @ git+https://github.com/am230/py2js.git@31a83c7c25a51ab0cc3255f484a2279d26278ec3
```

Pinned to specific commit (good), but small third-party repo. If repo owner force-pushes that hash or repo is compromised — supply chain risk.

---

## 🟢 LOW — File Write to Home Directory

`process_cleanup.py:19` writes `~/.stealth_browser_pids.json` — PID tracking only, benign.

---

## ✅ Not Found (Good Signs)

- No `subprocess`, `os.system`, `os.popen`, `Popen` calls
- No reverse shell patterns
- No data exfiltration — `requests.get()` in `element_cloner.py` only downloads (stylesheets/scripts), never uploads
- No hidden network listeners — socket only `127.0.0.1` port allocation for proxy forwarder
- No obfuscated/encoded payloads
- No environment variable harvesting beyond platform detection (`DISPLAY`, `container`, `KUBERNETES_SERVICE_HOST`)
- No credential theft patterns
- `persistent_storage.py` is purely in-memory, no disk persistence of sensitive data

---

## Bottom Line

Not malicious, but the unrestricted `exec()` MCP tool is functionally equivalent to giving every connected AI agent root-level code execution on the host. Combined with the bypassable hook sandbox, any prompt injection through a webpage could escalate to arbitrary code execution. Do not run without removing `create_python_binding` / `execute_python_in_browser` tools or adding proper sandboxing.
