# Perplexity Comet Browser — Evaluation for AgentBridge

**Date:** 2026-03-14
**Context:** Evaluated as potential replacement for stealth-browser-mcp browsing layer.
**Verdict:** Not suitable for AgentBridge. Worse security posture than what it would replace.

---

## What Is Comet

Perplexity's AI-native Chromium browser. Released July 2025 (Windows/macOS), free since Oct 2025. AI-powered browsing with built-in search, summarization, and agentic task execution.

There's also [comet-mcp](https://github.com/hanzili/comet-mcp) — an MCP server that bridges AI agents (e.g., Claude Code) to Comet for delegated web browsing. The multi-agent delegation model: your AI stays focused on its task, Comet handles browsing as a specialist.

## Security Issue — Hidden MCP API

SquareX disclosed in Nov 2025 that Comet has a hidden MCP API (`chrome.perplexity.mcp.addStdioServer`) allowing embedded extensions to execute arbitrary local commands without user consent.

Key findings:
- Agentic extension triggered by perplexity.ai page = covert channel for local command execution
- Both critical extensions hidden from Comet's extension dashboard — users can't disable them
- A single XSS on perplexity.ai or compromised Perplexity employee = full device control over every Comet user
- SquareX demoed executing WannaCry through this attack chain
- Perplexity did not respond to the disclosure

Source: https://securityonline.info/obscure-mcp-api-in-comet-browser-breaches-user-trust-enabling-full-device-control-via-ai-browsers/

## Comparison: stealth-browser-mcp vs Comet + comet-mcp

| Aspect | stealth-browser-mcp | Comet + comet-mcp |
|---|---|---|
| Control | Self-hosted, open source | Perplexity controls it, closed source |
| exec() risk | AI can exec Python (fixable: remove 2 tools) | Hidden API execs local commands (unfixable) |
| Headless | Yes — fits server/bridge use | GUI browser — needs display |
| Dependency | Self-contained | Depends on Perplexity staying free/stable |
| Data | Stays local | Pages/queries route through Perplexity |

## Why Not for AgentBridge

1. **GUI browser** — AgentBridge runs headless on server/WSL, Comet requires a display
2. **Data trust** — all browsing data routes through Perplexity
3. **Unfixable risk** — hidden MCP API is worse than stealth-browser-mcp's `exec()` because we can't patch it
4. **Vendor dependency** — if Perplexity changes anything, the bridge breaks

## Recommended Alternatives

- **stealth-browser-mcp with hardening** — remove `create_python_binding` and `execute_python_in_browser` (~40 lines), use the rest
- **Playwright/Puppeteer directly** — full control, no hidden APIs, headless-native, well-documented
