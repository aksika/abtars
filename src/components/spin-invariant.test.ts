/**
 * spin-invariant.test.ts — #1271 grep invariant.
 *
 * After #1271, the only place a model-bound LLM call (runtime.complete or
 * *.sendPrompt as a caller turn) lives is `spin.ts` (the chokepoint) and
 * a small allowlist. This test enforces that — it greps src/ and fails if
 * a new caller-turn call site is introduced outside the allowlist.
 *
 * Allowlist:
 *  - spin.ts (the chokepoint itself)
 *  - acp-transport.ts / direct-api-transport.ts / kiro-transport.ts
 *    (transport machinery — sendPrompt is the protocol method, not a model turn
 *    from a caller; it's invoked by spin()'s persistent path)
 *  - subagent-runtime.ts (transports cached here; sendPrompt called by spin()
 *    via the runtime.complete + runtime.session paths)
 *  - idle-save.ts (`/chat save` slash command — a write to the ACP subprocess
 *    session file, not a model turn)
 *  - openai-compat-routes.ts (defensive fallback when sessionManager not wired;
 *    the primary path is sessionManager.spin() above)
 *  - capabilities/sleep/index.ts (just a comment)
 *  - this file (the test itself)
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(process.cwd(), "src");
const ALLOWLIST = new Set([
  // The chokepoint itself
  "src/components/spin.ts",
  // Transport machinery (sendPrompt is the protocol method)
  "src/components/transport/acp-transport.ts",
  "src/components/transport/direct-api-transport.ts",
  "src/components/transport/kiro-transport.ts",
  // SubagentRuntime — transports cached here, called via runtime.complete / runtime.session
  "src/components/subagent-runtime.ts",
  // /chat save slash command — not a model turn
  "src/components/idle-save.ts",
  // Defensive fallback when sessionManager not wired
  "src/components/openai-compat-routes.ts",
  // Capability comments referencing the old pattern (no actual call)
  "src/capabilities/sleep/index.ts",
  // This test file
  "src/components/spin-invariant.test.ts",
]);

/** Walk src/ for .ts files, excluding .test.ts */
function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

describe("spin(spec) is the canonical model-call entry point (#1271)", () => {
  it("no model-bound runtime.complete outside the allowlist", () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(SRC_DIR)) {
      const rel = relative(process.cwd(), file);
      if (ALLOWLIST.has(rel)) continue;
      const content = readFileSync(file, "utf-8");
      // Strip JSDoc block comments and line comments to avoid matching doc text.
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Match: <expr>.complete( — but only the model-call forms
      // (e.g. "runtime.complete(" or "subagent.complete(").
      if (/(?:runtime|subagent|runtimeRef|agentRuntime)\.complete\s*\(/.test(stripped)) {
        violations.push(`${rel}: caller-turn .complete() call must go through spin(spec)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no model-bound .sendPrompt as a caller turn outside the allowlist", () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(SRC_DIR)) {
      const rel = relative(process.cwd(), file);
      if (ALLOWLIST.has(rel)) continue;
      const content = readFileSync(file, "utf-8");
      // Strip JSDoc and line comments, then scan remaining code lines.
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\.sendPrompt\s*\(/.test(line)) {
          violations.push(`${rel}:${i + 1}: caller-turn .sendPrompt() call must go through spin(spec): ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
