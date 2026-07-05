import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Suppress the banner output during tests
vi.mock("../banner.js", () => ({ printBanner: vi.fn(async () => {}) }));

const { rollback } = await import("./rollback.js");

/**
 * #1291 regression: rollback must update manifest.json + deploy.state with the
 * target release identity, otherwise the respawned bridge reports the stale
 * pre-rollback version (the rollback mechanism worked but lied about it).
 */
describe("rollback (#1291 — manifest update)", () => {
  let home: string;
  let releases: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeAll(() => {
    envBackup.ABTARS_HOME = process.env["ABTARS_HOME"];
    envBackup.ABTARS_RELEASES = process.env["ABTARS_RELEASES"];
  });

  afterAll(() => {
    if (envBackup.ABTARS_HOME === undefined) delete process.env["ABTARS_HOME"];
    else process.env["ABTARS_HOME"] = envBackup.ABTARS_HOME;
    if (envBackup.ABTARS_RELEASES === undefined) delete process.env["ABTARS_RELEASES"];
    else process.env.ABTARS_RELEASES = envBackup.ABTARS_RELEASES!;
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "rollback-home-"));
    releases = await mkdtemp(join(tmpdir(), "rollback-releases-"));
    process.env["ABTARS_HOME"] = home;
    process.env["ABTARS_RELEASES"] = releases;
  });

  /** Write history.json + release dirs (each with a package.json version). */
  async function seedHistory(entries: Array<{ ref: string; version: string }>): Promise<void> {
    for (const e of entries) {
      const dir = join(releases, e.ref);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module", name: "abtars", version: e.version }));
    }
    await writeFile(join(releases, "history.json"), JSON.stringify(entries.map(e => e.ref)));
  }

  async function readManifest(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(home, "manifest.json"), "utf-8"));
  }

  it("updates manifest with the rolled-back release identity (dev/commit entry)", async () => {
    // history[0]=current (aaaaaaa), history[1]=target (bbbbbbb)
    await seedHistory([
      { ref: "aaaaaaa", version: "0.3.4-alpha.8-aaaaaaa" },
      { ref: "bbbbbbb", version: "0.3.4-alpha.8-bbbbbbb" },
    ]);
    // Pre-existing manifest reflecting the current release
    await writeFile(join(home, "manifest.json"), JSON.stringify({
      package: "abtars", version: "0.3.4-alpha.8-aaaaaaa", commit: "aaaaaaa",
      activatedAt: "2026-07-01T00:00:00.000Z", source: "dev", host: "test",
    }));

    const code = await rollback({ to: 1 });
    expect(code).toBe(0);

    const m = await readManifest();
    expect(m["version"]).toBe("0.3.4-alpha.8-bbbbbbb");
    expect(m["commit"]).toBe("bbbbbbb");
    expect(m["previousVersion"]).toBe("0.3.4-alpha.8-aaaaaaa");
    expect(m["previousCommit"]).toBe("aaaaaaa");
    expect(m["activatedAt"]).not.toBe("2026-07-01T00:00:00.000Z");
  });

  it("sets commit=null for npm version entries (no commit hash)", async () => {
    await seedHistory([
      { ref: "0.3.4-alpha.8", version: "0.3.4-alpha.8" },
      { ref: "0.3.4-alpha.7", version: "0.3.4-alpha.7" },
    ]);
    await writeFile(join(home, "manifest.json"), JSON.stringify({
      package: "abtars", version: "0.3.4-alpha.8", commit: null, source: "alpha", host: "test",
    }));

    const code = await rollback({ to: 1 });
    expect(code).toBe(0);

    const m = await readManifest();
    expect(m["version"]).toBe("0.3.4-alpha.7");
    expect(m["commit"]).toBeNull();
    expect(m["previousVersion"]).toBe("0.3.4-alpha.8");
  });

  it("writes deploy.state with status=rollback and the target version", async () => {
    await seedHistory([
      { ref: "aaaaaaa", version: "0.3.4-alpha.8-aaaaaaa" },
      { ref: "bbbbbbb", version: "0.3.4-alpha.8-bbbbbbb" },
    ]);
    await writeFile(join(home, "deploy.state"), JSON.stringify({ status: "success", version: "old", restartCount: 5 }));

    await rollback({ to: 1 });

    const state = JSON.parse(readFileSync(join(home, "deploy.state"), "utf-8"));
    expect(state["status"]).toBe("rollback");
    expect(state["version"]).toBe("0.3.4-alpha.8-bbbbbbb");
    expect(state["restartCount"]).toBe(0);
  });

  it("repoints both current and app symlinks to the target release", async () => {
    await seedHistory([
      { ref: "aaaaaaa", version: "0.3.4-alpha.8-aaaaaaa" },
      { ref: "bbbbbbb", version: "0.3.4-alpha.8-bbbbbbb" },
    ]);

    await rollback({ to: 1 });

    const { readlinkSync } = await import("node:fs");
    expect(readlinkSync(join(releases, "current"))).toBe(join(releases, "bbbbbbb"));
    expect(readlinkSync(join(home, "app"))).toBe(join(releases, "bbbbbbb"));
  });

  it("writes .start-reason with the rollback target", async () => {
    await seedHistory([
      { ref: "aaaaaaa", version: "0.3.4-alpha.8-aaaaaaa" },
      { ref: "bbbbbbb", version: "0.3.4-alpha.8-bbbbbbb" },
    ]);

    await rollback({ to: 1 });

    const reason = readFileSync(join(home, ".start-reason"), "utf-8").trim();
    expect(reason).toBe("rollback:bbbbbbb");
  });

  it("returns 2 when target slot is beyond history length", async () => {
    await seedHistory([{ ref: "aaaaaaa", version: "0.3.4-alpha.8-aaaaaaa" }]);
    const code = await rollback({ to: 3 });
    expect(code).toBe(2);
  });
});
