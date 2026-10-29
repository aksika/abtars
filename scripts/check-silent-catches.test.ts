import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isolatedChildEnv } from "../src/test-support/runtime-isolation.js";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-silent-catches.mjs");

const VIOLATING = `// guard contract fixture — every construct below must be rejected
export async function demo() {
  try { step(); } catch {}
  try { step(); } catch (err) {}
  await p().catch(() => {});
  await p().catch((err) => {});
  await p().catch(
    (err) => {
    },
  );
  await p().catch(async () => {});
}
`;

const ALLOWED = `// guard contract fixture — every construct below must be accepted
export async function demo() {
  try { step(); } catch { /* cache miss is expected; caller continues */ }
  try { step(); } catch (err) { logAndSwallow(TAG, "best-effort step", err); }
  await p().catch(() => { /* best-effort delivery; primary result is authoritative */ });
  await p().catch(logAndSwallow.bind(null, TAG, "fire-and-forget delivery"));
  await p().catch((err) => logAndSwallow(TAG, "cleanup", err));
  await p().then(() => {});
  const obj = { catch: () => {} };
  const lookalike = "string containing } catch {} and .catch(() => {}) text";
  // comment containing } catch {} and .catch((e) => {}) text
  await p().catch(async (err) => { /* expected cancellation; primary path continues */ });
}
`;

function runGuard(root) {
  return spawnSync(process.execPath, [SCRIPT, root], {
    encoding: "utf-8",
    env: isolatedChildEnv(),
    timeout: 30_000,
  });
}

describe("scripts/check-silent-catches.mjs — contract", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects bare, named, multiline, and async undocumented empty handlers", () => {
    dir = mkdtempSync(join(tmpdir(), "abtars-silent-catch-guard-"));
    writeFileSync(join(dir, "fixture.ts"), VIOLATING);

    const result = runGuard(dir);
    expect(result.status).toBe(1);

    const diagnostics = result.stderr.split("\n").filter((l) => l.startsWith("VIOLATION:"));
    // VIOLATING layout: bare catch=3, named catch=4, arrow=5, arrow w/param=6,
    // multiline call=7, async arrow=11.
    const expected = [
      [3, "undocumented empty catch block"],
      [4, "undocumented empty catch block"],
      [5, "undocumented empty Promise catch callback"],
      [6, "undocumented empty Promise catch callback"],
      [7, "undocumented empty Promise catch callback"],
      [11, "undocumented empty Promise catch callback"],
    ];
    const actual = diagnostics.map((d) => {
      const m = d.match(/^VIOLATION: .+:(\d+): (undocumented empty catch block|undocumented empty Promise catch callback)$/);
      expect(m).not.toBeNull();
      return [Number(m![1]), m![2]];
    });
    expect(actual).toEqual(expected);
  });

  it("accepts comment-documented and non-empty handlers, and lookalike text", () => {
    dir = mkdtempSync(join(tmpdir(), "abtars-silent-catch-guard-"));
    writeFileSync(join(dir, "fixture.ts"), ALLOWED);

    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("check-silent-catches: OK");
  });
});