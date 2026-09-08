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
