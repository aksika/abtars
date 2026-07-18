import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { currentTestSandbox, assertSandboxPath } from "./runtime-isolation.js";
import { PowerTransitionStore } from "../capabilities/power/power-transition-store.js";
import { abtarsHome } from "../paths.js";

/**
 * Regression guard for the #1417 isolation contract.
 *
 * Builds a decoy "live" home — what ~/.abtars looks like in production —
 * containing sentinel files, then drives production default-path writers
 * (constructors/functions that take no explicit path) and asserts:
 *   1. every write lands INSIDE the per-file sandbox, and
 *   2. every sentinel in the decoy home is byte-for-byte unchanged.
 *
 * If a future change re-introduces module-level path capture or hardcodes a
 * real-home default, one of these assertions fires before live state is touched.
 */

function makeExternalRoot(): { root: string; sentinels: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "abtars-regression-external-"));
  const abtars = join(root, "fake-home", ".abtars");
  mkdirSync(join(abtars, "state"), { recursive: true });
  mkdirSync(join(abtars, "skills", "self", "keep"), { recursive: true });
  const sentinels: Record<string, string> = {
    [join(abtars, "state", "power-transition.json")]: "SENTINEL_POWER_v1",
    [join(abtars, "skills", "self", "keep", "KEEP.md")]: "SENTINEL_SKILL_v1",
  };
  for (const [p, c] of Object.entries(sentinels)) writeFileSync(p, c);
  return { root, sentinels };
}

const sha = (p: string): string =>
  createHash("sha256").update(readFileSync(p)).digest("hex");

describe("isolation regression: default-path writers cannot reach live roots", () => {
  let external: ReturnType<typeof makeExternalRoot> | null = null;

  afterEach(() => {
    if (external) rmSync(external.root, { recursive: true, force: true });
    external = null;
  });

  it("default-path PowerTransitionStore writes inside the sandbox", () => {
    external = makeExternalRoot();
    const before = Object.fromEntries(
      Object.keys(external.sentinels).map((p) => [p, sha(p)]),
    );

    // Default constructor resolves abtarsHome()/state/power-transition.json.
    const store = new PowerTransitionStore();
    store.write({
      state: "suspending",
      taskId: "regression",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      expectedWakeAt: Date.now() + 3600_000,
    });

    const sandbox = currentTestSandbox();
    // 1. The write landed inside the sandbox.
    expect(existsSync(join(sandbox.abtarsHome, "state", "power-transition.json"))).toBe(true);
    expect(store.read()?.taskId).toBe("regression");

    // 2. The production default path is the sandbox home, NOT the decoy home.
    expect(abtarsHome()).toBe(sandbox.abtarsHome);
    expect(abtarsHome()).not.toContain("fake-home");
    expect(abtarsHome()).not.toBe(join(external.root, "fake-home", ".abtars"));

    // 3. Every decoy sentinel is byte-for-byte unchanged.
    for (const [p, h] of Object.entries(before)) {
      expect(existsSync(p)).toBe(true);
      expect(sha(p)).toBe(h);
    }
    expect(
      readFileSync(
        join(external.root, "fake-home", ".abtars", "state", "power-transition.json"),
        "utf-8",
      ),
    ).toBe("SENTINEL_POWER_v1");
  });

  it("a raw homedir()-joined default path also resolves inside the sandbox", () => {
    external = makeExternalRoot();
    const sandbox = currentTestSandbox();

    // The motivating bug captured this path at module import. Even if a caller
    // builds it from homedir() directly, the sandbox's HOME override redirects
    // it into the sandbox rather than the real/decoy home.
    const defaultPath = join(homedir(), ".abtars", "state", "power-transition.json");
    expect(defaultPath).toBe(join(sandbox.home, ".abtars", "state", "power-transition.json"));
    expect(homedir()).toBe(sandbox.home);
    expect(assertSandboxPath(defaultPath)).toBe(resolve(defaultPath));

    // The decoy home is untouched and unreachable via the default path.
    expect(homedir()).not.toContain("fake-home");
  });

  it("attempting to assertSandboxPath on the decoy (live) root is rejected", () => {
    external = makeExternalRoot();
    const liveTarget = join(external.root, "fake-home", ".abtars", "state", "power-transition.json");
    expect(() => assertSandboxPath(liveTarget)).toThrow("outside the test sandbox root");
    // Nothing was written or removed.
    expect(readFileSync(liveTarget, "utf-8")).toBe("SENTINEL_POWER_v1");
  });
});
