/**
 * Security regression tests — ensures security controls stay intact.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../components/logger.js";
import { isWithinRoot } from "../components/path-guard.js";

/** Absolute path to a repo source file (this file is at src/tests/security.test.ts). */
function repoPath(rel: string): string {
  return join(__dirname, "..", "..", rel);
}

/** All production .ts files (no tests, no generated registry). */
function prodSources(): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const { join: j } = require("node:path") as typeof import("node:path");
  const root = repoPath("src");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = j(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "tests" || entry.name === "e2e" || entry.name === "integration") continue;
        walk(p);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

describe("credential redaction", () => {
  it("redacts OpenAI keys", () => {
    expect(redactSecrets("key is sk-abc123def456ghi789jkl012mno")).toContain("sk-***REDACTED***");
  });

  it("redacts GitHub PATs", () => {
    expect(redactSecrets("token ghp_1234567890abcdefghijklmnopqrstuvwxyz")).toContain("ghp_***REDACTED***");
  });

  it("redacts Telegram bot tokens", () => {
    expect(redactSecrets("bot 123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789a")).toContain("***BOT_TOKEN***");
  });

  it("redacts AWS access key IDs", () => {
    expect(redactSecrets("aws AKIAIOSFODNN7EXAMPLE")).toContain("AKIA***REDACTED***");
  });

  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc")).toContain("Bearer ***REDACTED***");
  });

  it("redacts env assignments", () => {
    expect(redactSecrets("TELEGRAM_BOT_TOKEN=123456:ABCdef_secret_value")).toContain("***REDACTED***");
  });

  it("redacts JSON secret fields", () => {
    expect(redactSecrets('{"apiKey": "sk-very-secret-key-here"}')).toContain("***REDACTED***");
  });

  it("preserves non-secret text", () => {
    const safe = "User said hello at 2026-04-05T12:00:00";
    expect(redactSecrets(safe)).toBe(safe);
  });
});

describe("path traversal protection", () => {
  it("allows paths within root", () => {
    expect(isWithinRoot("memory/test.db", "/home/user/.abtars")).toBe(true);
  });

  it("blocks ../ escape", () => {
    expect(isWithinRoot("../../.ssh/authorized_keys", "/home/user/.abtars")).toBe(false);
  });

  it("blocks absolute path outside root", () => {
    expect(isWithinRoot("/etc/passwd", "/home/user/.abtars")).toBe(false);
  });

  it("allows root itself", () => {
    expect(isWithinRoot(".", "/home/user/.abtars")).toBe(true);
  });
});

// ── #1354: transport.json persistence invariant ─────────────────────────────
// The ONLY production writer of transport.json is the validated boundary in
// transport-config/writer.ts (writeTransportConfig / restorePrevious /
// resetToDefaults, all routing through serializeTransportConfig). A textual
// scan cannot prove runtime safety — it catches bypasses of the boundary;
// behavioral filesystem safety is covered in transport-config-secrets.test.ts.

describe("#1354 — transport.json writer invariant", () => {
  it("no production write targets the transport config outside the boundary", () => {
    const offenders: string[] = [];
    for (const file of prodSources()) {
      const content = readFileSync(file, "utf-8");
      // a write/rename whose target expression references a transport path
      if (/\b(writeFileSync|writeFile|atomicWriteSync|renameSync)\s*\(\s*[^,)]*transport/i.test(content)) {
        offenders.push(file.replace(repoPath("src") + "/", "src/"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the boundary writer routes through the validated serializer", () => {
    // #1558: the writer boundary moved to transport-config/writer.ts (barrel re-exports only).
    const tc = readFileSync(repoPath("src/components/transport-config/writer.ts"), "utf-8");
    // the primary write must serialize via serializeTransportConfig
    expect(tc).toContain("serializeTransportConfig(vr.config)");
    // direct JSON.stringify of the raw candidate must not reach the disk path
    expect(tc).not.toContain('JSON.stringify(vr.config, null, 2)');
    expect(tc).not.toContain('JSON.stringify(config, null, 2)');
  });
});

// ── #1354: credential .env guidance scan ────────────────────────────────────
// User-facing docs, templates, and source must not instruct operators to put
// API/provider credentials into .env or .env.skills. The one documented
// exception is WEB_AUTH (dashboard setup, explicitly exempt by the ticket).

describe("#1354 — no credential-in-.env guidance", () => {
  const scanned: Array<{ file: string; line: string }> = [];

  it("scans docs, templates, and user-facing source", () => {
    const rels = [
      ...["secrets", "voice", "platforms", "artifacts", "add-service", "pi-providers", "install", "transport", "quickstart", "troubleshooting", "mcp-integration"].map(
        n => `docs/wiki/${n}.md`),
      "templates/config/.env.example",
      "templates/config/.env.skills.example",
      "templates/skills/troubleshooting/SKILL.md",
      "templates/prompts/agent_default.md",
      "src/cli/commands/onboard.ts",
      "src/components/config.ts",
      "src/components/transport-config.ts",
      "src/components/secrets.ts",
    ];
    for (const rel of rels) {
      const abs = repoPath(rel);
      if (!existsSync(abs)) continue;
      const lines = readFileSync(abs, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (line.includes("WEB_AUTH") || trimmed.startsWith("#")) continue;
        // prohibitions ("do not put ... in .env") are the desired guidance
        if (/\b(do not|don't|never|must not|avoid)\b/i.test(line)) continue;
        // credential placeholder assignment (e.g. GROQ_API_KEY=<secret>)
        if (/[A-Z_][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_API_ID)=<[^>]+>/.test(line)) {
          scanned.push({ file: rel, line: `${i + 1}: ${trimmed}` });
          continue;
        }
        // instruction to place credentials into a .env file
        if (/\.env/.test(line) &&
            /\b(api[- ]?key|token|secret|password)\b/i.test(line) &&
            /\b(put|add|set|store|place|write|paste|enter)\b.{0,40}\.env/i.test(line)) {
          scanned.push({ file: rel, line: `${i + 1}: ${trimmed}` });
        }
      }
    }
    expect(scanned).toEqual([]);
  });
});

// ── #1354: presence-only credential output ──────────────────────────────────

describe("#1354 — envDump presence-only", () => {
  it("never exposes credential values or fragments, only (set)/(not set)", async () => {
    const SENTINEL = "sk-or-presence-sentinel-1354-abcdef123456";
    const prev = process.env["TELEGRAM_BOT_TOKEN"];
    process.env["TELEGRAM_BOT_TOKEN"] = SENTINEL;
    try {
      const { _resetEnv } = await import("../components/env-schema.js");
      _resetEnv();
      const { getEnv, envDump } = await import("../components/env-schema.js");
      getEnv();
      const dump = JSON.stringify(envDump());
      expect(dump).not.toContain(SENTINEL);
      expect(dump).not.toContain(SENTINEL.slice(0, 8));
      expect(dump).toContain('"telegramBotToken":"(set)"');
    } finally {
      if (prev === undefined) delete process.env["TELEGRAM_BOT_TOKEN"];
      else process.env["TELEGRAM_BOT_TOKEN"] = prev;
      const { _resetEnv } = await import("../components/env-schema.js");
      _resetEnv();
    }
  });
});
