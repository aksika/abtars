/**
 * soul-bundle.test.ts — #1786: P (peer chat) turns exclude the private
 * skills catalog; other lightweight types keep it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;

vi.doMock("../paths.js", async (importOriginal) => {
  const actual = await (importOriginal() as Promise<Record<string, unknown>>);
  return { ...actual, abtarsHome: () => TEST_HOME };
});

beforeEach(() => {
  TEST_HOME = join(tmpdir(), `soul-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(TEST_HOME, "skills"), { recursive: true });
  writeFileSync(join(TEST_HOME, "skills", "skills_catalog.md"), "# Skills MARKER-1786-PRIVATE\n");
});

describe("buildSoulBundle peer isolation (#1786)", () => {
  it("excludes the skills catalog from P turns", async () => {
    const { buildSoulBundle } = await import("./soul-bundle.js");
    const bundle = buildSoulBundle("P");
    expect(bundle).toContain("peer agent request");
    expect(bundle).not.toContain("MARKER-1786-PRIVATE");
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("keeps the skills catalog for other lightweight types", async () => {
    const { buildSoulBundle } = await import("./soul-bundle.js");
    const bundle = buildSoulBundle("B");
    expect(bundle).toContain("MARKER-1786-PRIVATE");
    rmSync(TEST_HOME, { recursive: true, force: true });
  });
});

describe("Main injection split (#1869)", () => {
  const FULL = {
    soul: "SOUL-MARKER-1869",
    profile: "PROFILE-MARKER-1869",
    notes: "NOTES-MARKER-1869",
    memoryTools: "TOOLS-MARKER-1869",
    coreFacts: "FACTS-MARKER-1869",
  };

  it("boot system prompt keeps soul + memoryTools, never profile/notes/coreFacts", async () => {
    const { buildSoulBundle } = await import("./soul-bundle.js");
    const bundle = buildSoulBundle("A", FULL);
    expect(bundle).toContain("SOUL-MARKER-1869");
    expect(bundle).toContain("TOOLS-MARKER-1869");
    // Mutable sleep-curated parts live in session-start, not here: pushing
    // them here too would inject each file twice per session (stale + fresh).
    expect(bundle).not.toContain("PROFILE-MARKER-1869");
    expect(bundle).not.toContain("NOTES-MARKER-1869");
    expect(bundle).not.toContain("FACTS-MARKER-1869");
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("a present-but-empty (suppressed) bundle does not trigger the minimal fallback", async () => {
    const { buildSoulBundle } = await import("./soul-bundle.js");
    const bundle = buildSoulBundle("A", { soul: "", profile: "", notes: "", memoryTools: "TOOLS-MARKER-1869", coreFacts: "" });
    // An empty part is simply not pushed; !bundle (memory unavailable) is
    // the only path to default-minimal.md.
    expect(bundle).toContain("TOOLS-MARKER-1869");
    expect(bundle).not.toContain("Memory unavailable");
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("old daemons without the parts map keep the full legacy bundle (no part dropped)", async () => {
    const { buildSoulBundle } = await import("./soul-bundle.js");
    const bundle = buildSoulBundle("A", FULL, "system-prompt");
    expect(bundle).toContain("SOUL-MARKER-1869");
    expect(bundle).toContain("PROFILE-MARKER-1869");
    expect(bundle).toContain("NOTES-MARKER-1869");
    expect(bundle).toContain("TOOLS-MARKER-1869");
    expect(bundle).toContain("FACTS-MARKER-1869");
    rmSync(TEST_HOME, { recursive: true, force: true });
  });
});

describe("Main SOUL assembly and refresh (#1932)", () => {
  const FULL = {
    soul: "SOUL-MARKER-1932",
    profile: "PROFILE-MARKER-1932",
    notes: "NOTES-MARKER-1932",
    memoryTools: "TOOLS-MARKER-1932",
    coreFacts: "FACTS-MARKER-1932",
  };

  it("assembles the same current bundle used at boot", async () => {
    const { assembleMainSoulBundleText } = await import("./soul-bundle.js");
    const runtime = {
      state: "ready",
      assembleSessionContext: async () => ({ soulBundle: FULL, parts: FULL }),
    };
    const bundle = await assembleMainSoulBundleText(runtime, "master");

    expect(bundle).toContain("SOUL-MARKER-1932");
    expect(bundle).toContain("TOOLS-MARKER-1932");
    expect(bundle).not.toContain("PROFILE-MARKER-1932");
  });

  it("installs a refreshed bundle without throwing", async () => {
    const { refreshMainSoulPrompt } = await import("./soul-bundle.js");
    let installed: string | null = null;
    const runtime = {
      state: "ready",
      assembleSessionContext: async () => ({ soulBundle: FULL, parts: FULL }),
    };

    const refreshed = await refreshMainSoulPrompt(
      { setSystemPrompt: (prompt: string) => { installed = prompt; } },
      runtime,
      "master",
    );

    expect(refreshed).toBe(true);
    expect(installed).toContain("TOOLS-MARKER-1932");
  });

  it("keeps the previous bundle when assembly is unavailable", async () => {
    const { refreshMainSoulPrompt } = await import("./soul-bundle.js");
    const setSystemPrompt = vi.fn();
    const runtime = {
      state: "unavailable",
      assembleSessionContext: async () => { throw new Error("must not be called"); },
    };

    await expect(refreshMainSoulPrompt({ setSystemPrompt }, runtime, "master")).resolves.toBe(false);
    expect(setSystemPrompt).not.toHaveBeenCalled();
  });
});